const PROBE_BYTES = 25_000_000;
const PROBE_URL = `https://speed.cloudflare.com/__down?bytes=${PROBE_BYTES}`;
const PROBE_MAX_READ_MS = 8_000;
const PROBE_MIN_BYTES = 4_000_000;
const PROBE_TTL_MS = 12 * 60 * 60 * 1000;
const LIVE_TTL_MS = 6 * 60 * 60 * 1000;
const LIVE_SMOOTHING = 0.4;
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

let live: Timed | null = null;
let probe: Timed | null = null;
let probeInFlight: Promise<void> | null = null;

export function recordLiveSample(mbps: number, now = Date.now()): void {
  if (!Number.isFinite(mbps) || mbps <= 0) return;
  const prev = live && now - live.at < LIVE_TTL_MS ? live.mbps : undefined;
  live = { mbps: prev === undefined ? mbps : prev + (mbps - prev) * LIVE_SMOOTHING, at: now };
}

export function resetBandwidthState(): void {
  live = null;
  probe = null;
  probeInFlight = null;
}

/** Synchronous best guess from data already in hand; never starts a probe. */
export function peekBandwidth(overrideMbps?: number, now = Date.now()): BandwidthEstimate {
  if (overrideMbps && overrideMbps > 0) return { mbps: overrideMbps, source: 'override' };
  if (live && now - live.at < LIVE_TTL_MS) return { mbps: live.mbps, source: 'live' };
  if (probe && now - probe.at < PROBE_TTL_MS) return { mbps: probe.mbps, source: 'probe' };
  return { mbps: DEFAULT_MBPS, source: 'default' };
}

/** Like peekBandwidth, but runs the downlink probe first when nothing fresher exists. */
export async function resolveBandwidth(overrideMbps?: number, maxWaitMs = 6_000): Promise<BandwidthEstimate> {
  const known = peekBandwidth(overrideMbps);
  if (known.source !== 'default') return known;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([warmBandwidthProbe(), new Promise<void>(resolve => { timer = setTimeout(resolve, maxWaitMs); })]);
  clearTimeout(timer);
  return peekBandwidth(overrideMbps);
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
