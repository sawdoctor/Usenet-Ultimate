import { createHash } from 'node:crypto';

const PROBE_BYTES = 25_000_000;
const PROBE_URL = `https://speed.cloudflare.com/__down?bytes=${PROBE_BYTES}`;
const PROBE_MAX_READ_MS = 8_000;
const PROBE_MIN_BYTES = 4_000_000;
const PROBE_TTL_MS = 12 * 60 * 60 * 1000;
const LIVE_TTL_MS = 10 * 60 * 1000;
const LIVE_RECOVERY = 0.2;
const MAX_LIVE_MANIFESTS = 1_000;
const SAMPLE_WINDOW_MS = 8_000;
const SATURATED_BACKLOG_BYTES = 256 * 1024;

export const DEFAULT_MBPS = 25;

export type BandwidthSource = 'override' | 'live' | 'probe' | 'default';

export interface BandwidthEstimate {
  mbps: number;
  source: BandwidthSource;
}

interface Timed {
  mbps: number;
  at: number;
}

const liveByManifest = new Map<string, Timed>();
let probe: Timed | null = null;
let probeInFlight: Promise<void> | null = null;

function manifestId(manifestKey?: string): string | undefined {
  if (!manifestKey) return undefined;
  return createHash('sha256').update(manifestKey).digest('hex');
}

export function recordLiveSample(manifestKey: string | undefined, mbps: number, now = Date.now()): void {
  const key = manifestId(manifestKey);
  if (!key || !Number.isFinite(mbps) || mbps <= 0) return;
  const prev = liveByManifest.get(key);
  const estimate = prev && now - prev.at < LIVE_TTL_MS
    ? mbps < prev.mbps ? mbps : prev.mbps + (mbps - prev.mbps) * LIVE_RECOVERY
    : mbps;
  if (!prev && liveByManifest.size >= MAX_LIVE_MANIFESTS) {
    let oldest: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [candidate, value] of liveByManifest) {
      if (value.at < oldestAt) {
        oldest = candidate;
        oldestAt = value.at;
      }
    }
    if (oldest) liveByManifest.delete(oldest);
  }
  liveByManifest.set(key, { mbps: estimate, at: now });
}

export function resetBandwidthState(): void {
  liveByManifest.clear();
  probe = null;
  probeInFlight = null;
}

/** Synchronous best guess from data already in hand; never starts a probe. */
export function peekBandwidth(manifestKey?: string, overrideMbps?: number, now = Date.now()): BandwidthEstimate {
  if (overrideMbps && overrideMbps > 0) return { mbps: overrideMbps, source: 'override' };
  const key = manifestId(manifestKey);
  if (key) {
    const live = liveByManifest.get(key);
    if (live && now - live.at < LIVE_TTL_MS) return { mbps: live.mbps, source: 'live' };
    if (live) liveByManifest.delete(key);
    return { mbps: DEFAULT_MBPS, source: 'default' };
  }
  if (probe && now - probe.at < PROBE_TTL_MS) return { mbps: Math.min(probe.mbps, DEFAULT_MBPS), source: 'probe' };
  return { mbps: DEFAULT_MBPS, source: 'default' };
}

/** Uses manifest-scoped samples; probes only when no manifest scope is available. */
export async function resolveBandwidth(manifestKey?: string, overrideMbps?: number, maxWaitMs = 6_000): Promise<BandwidthEstimate> {
  const known = peekBandwidth(manifestKey, overrideMbps);
  if (known.source !== 'default') return known;
  if (manifestKey) return known;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([warmBandwidthProbe(), new Promise<void>(resolve => { timer = setTimeout(resolve, maxWaitMs); })]);
  clearTimeout(timer);
  return peekBandwidth(manifestKey, overrideMbps);
}

export function warmBandwidthProbe(): Promise<void> {
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return Promise.resolve();
  probeInFlight ??= runProbe().finally(() => { probeInFlight = null; });
  return probeInFlight;
}

async function runProbe(): Promise<void> {
  try {
    const resp = await fetch(PROBE_URL, { signal: AbortSignal.timeout(20_000) });
    if (!resp.ok || !resp.body) return;
    const reader = resp.body.getReader();
    let bytes = 0;
    let firstByteAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstByteAt) firstByteAt = Date.now();
      bytes += value.length;
      if (Date.now() - firstByteAt >= PROBE_MAX_READ_MS) break;
    }
    await reader.cancel().catch(() => {});
    const elapsedMs = Date.now() - firstByteAt;
    if (!firstByteAt || bytes < PROBE_MIN_BYTES || elapsedMs <= 0) return;
    const mbps = (bytes * 8) / (elapsedMs / 1000) / 1_000_000;
    probe = { mbps, at: Date.now() };
    console.log(`🪙 Bandwidth probe: ${mbps.toFixed(1)} Mbps (${(bytes / 1e6).toFixed(1)} MB in ${(elapsedMs / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.warn(`🪙 Bandwidth probe failed: ${(err as Error).message}`);
  }
}

/** Turns periodic socket readings into link-capacity samples; only windows with a queued write backlog count. */
export class ThroughputSampler {
  private windowStartMs: number | null = null;
  private windowStartBytes = 0;
  private saturated = true;

  constructor(private readonly onSample: (mbps: number) => void) {}

  tick(nowMs: number, bytesWritten: number, backlogBytes: number): void {
    if (this.windowStartMs === null) {
      this.windowStartMs = nowMs;
      this.windowStartBytes = bytesWritten;
    }
    if (backlogBytes < SATURATED_BACKLOG_BYTES) this.saturated = false;
    const elapsedMs = nowMs - this.windowStartMs;
    if (elapsedMs < SAMPLE_WINDOW_MS) return;
    if (this.saturated) {
      this.onSample(((bytesWritten - this.windowStartBytes) * 8) / (elapsedMs / 1000) / 1_000_000);
    }
    this.windowStartMs = nowMs;
    this.windowStartBytes = bytesWritten;
    this.saturated = backlogBytes >= SATURATED_BACKLOG_BYTES;
  }
}
