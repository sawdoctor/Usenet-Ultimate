import { createHash, randomUUID } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiskCache } from '../parsers/diskCache.js';

const PROBE_BYTES = 25_000_000;
const PROBE_URL = `https://speed.cloudflare.com/__down?bytes=${PROBE_BYTES}`;
const PROBE_MAX_READ_MS = 8_000;
const PROBE_MIN_BYTES = 4_000_000;
const PROBE_TTL_MS = 12 * 60 * 60 * 1000;
const SAMPLE_WINDOW_MS = 8_000;
const SATURATED_BACKLOG_BYTES = 256 * 1024;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RECENT_MS = 2 * HOUR_MS;
const HISTORY_MAX_AGE_MS = 90 * DAY_MS;
const HISTORY_MAX_STREAMS = 100;
const MIN_STREAMS_PER_WINDOW = 3;
const LOGGED_READINGS = 8;
const PLAYBACK_IDLE_MS = 10 * 60 * 1000;
const HISTORY_WINDOWS: ReadonlyArray<readonly [BandwidthSource, number]> = [['day', DAY_MS], ['week', 7 * DAY_MS], ['month', 30 * DAY_MS]];

export const DEFAULT_MBPS = 25;

export type BandwidthSource = 'override' | 'recent' | 'day' | 'week' | 'month' | 'history' | 'probe' | 'default';

export interface BandwidthEstimate {
  mbps: number;
  source: BandwidthSource;
  /** How many past streams a history estimate is based on. */
  streams?: number;
}

interface StreamSpeed {
  at: number;
  mbps: number;
  /** The playback that wrote it, so a resumed playback updates its entry instead of adding one. */
  id?: string;
}

interface Timed {
  mbps: number;
  at: number;
}

// One entry per playback, so a two-hour movie counts the same as one episode.
const history = new DiskCache<StreamSpeed[]>(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'bandwidth-history.json'),
  { schemaVersion: 1, maxEntries: 1000, saveDelayMs: 30_000 },
);
const activeStreams = new Set<StreamMeasurement>();
const playbacks = new Map<string, StreamMeasurement>();
let probe: Timed | null = null;
let probeInFlight: Promise<void> | null = null;

/** The client's network: an IPv4 /24 or IPv6 /64, so one household's devices share a speed and a phone on cellular gets its own. */
export function clientNetwork(ip: string | undefined): string {
  if (!ip) return '';
  const v4 = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  if (isIPv4(v4)) return v4.split('.').slice(0, 3).join('.');
  const v6 = ip.split('%')[0];
  if (!isIPv6(v6)) return ip;
  const [head, tail] = v6.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups = tail === undefined
    ? headGroups
    : [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];
  return groups.slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':');
}

/** Hashed key for one manifest on one client network; speeds are measured, stored and read per scope. */
export function speedScope(manifestKey: string | undefined, clientIp: string | undefined): string | undefined {
  if (!manifestKey) return undefined;
  return createHash('sha256').update(`${manifestKey}|${clientNetwork(clientIp)}`).digest('hex');
}

/** The measurement for one proxied request: requests for the same file on the same network share a playback until it has been idle ten minutes. */
export function measurePlayback(scope: string | undefined, file: string, now = Date.now()): StreamMeasurement {
  for (const [key, playback] of playbacks) if (playback.idleMs(now) > PLAYBACK_IDLE_MS) playbacks.delete(key);
  const key = `${scope ?? ''}|${file}`;
  const playback = playbacks.get(key);
  if (playback) {
    playback.open(now);
    return playback;
  }
  const created = new StreamMeasurement(scope, file, now);
  playbacks.set(key, created);
  return created;
}

/** Tracks one playback across its range requests: records saturated readings, logs them and stores the playback's speed when its last request ends. */
export class StreamMeasurement {
  readonly id: string = randomUUID();
  private readonly readings: number[] = [];
  private openRequests = 1;
  private lastActivityAt: number;
  lastAt = 0;

  constructor(readonly scope: string | undefined, private readonly label: string, now = Date.now()) {
    this.lastActivityAt = now;
    if (scope) activeStreams.add(this);
  }

  open(now = Date.now()): void {
    this.openRequests++;
    this.lastActivityAt = now;
    if (this.scope) activeStreams.add(this);
  }

  idleMs(now = Date.now()): number {
    return this.openRequests > 0 ? 0 : now - this.lastActivityAt;
  }

  sample(mbps: number, now = Date.now()): void {
    if (!Number.isFinite(mbps) || mbps <= 0) return;
    this.readings.push(mbps);
    this.lastAt = now;
  }

  // The second-fastest window: the fastest is usually inflated by the socket buffers filling at the start.
  speedMbps(): number {
    const fastestFirst = [...this.readings].sort((a, b) => b - a);
    return fastestFirst[Math.min(1, fastestFirst.length - 1)] ?? 0;
  }

  finish(fileBytes?: number | null, now = Date.now()): void {
    this.openRequests = Math.max(0, this.openRequests - 1);
    this.lastActivityAt = now;
    if (this.openRequests > 0) return;
    activeStreams.delete(this);
    if (this.readings.length === 0) return;
    const shown = this.readings.slice(0, LOGGED_READINGS).map(Math.round).join(', ');
    const more = this.readings.length > LOGGED_READINGS ? ', …' : '';
    const size = fileBytes ? `, file ${(fileBytes / 1e9).toFixed(1)} GB` : '';
    console.log(`📶 Stream speed: ${this.label} — ${this.readings.length} reading(s) [${shown}${more}] Mbps → ${Math.round(this.speedMbps())} Mbps${size}`);
    if (this.scope) saveHistory(this.scope, { at: this.lastAt, mbps: this.speedMbps(), id: this.id });
  }
}

function saveHistory(scope: string, entry: StreamSpeed): void {
  const kept = (history.get(scope) ?? []).filter(s => s.id !== entry.id && entry.at - s.at <= HISTORY_MAX_AGE_MS);
  history.set(scope, [...kept, entry].slice(-HISTORY_MAX_STREAMS), HISTORY_MAX_AGE_MS / 1000);
}

function scopeStreams(scope: string, now: number): StreamSpeed[] {
  const live = [...activeStreams].filter(m => m.scope === scope && m.speedMbps() > 0);
  const liveIds = new Set<string>(live.map(m => m.id));
  const stored = (history.get(scope) ?? []).filter(s => !s.id || !liveIds.has(s.id));
  return [...stored, ...live.map(m => ({ at: m.lastAt, mbps: m.speedMbps() }))].filter(s => now - s.at <= HISTORY_MAX_AGE_MS);
}

// The lower quartile: overestimating stalls the stream, while underestimating only costs some quality.
function lowerQuartile(streams: StreamSpeed[]): number {
  const sorted = streams.map(s => s.mbps).sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 4)];
}

export function resetBandwidthState(): void {
  history.flushAll();
  activeStreams.clear();
  playbacks.clear();
  probe = null;
  probeInFlight = null;
}

/** Synchronous best guess from data already in hand; never starts a probe. */
export function peekBandwidth(scope?: string, overrideMbps?: number, now = Date.now()): BandwidthEstimate {
  if (overrideMbps && overrideMbps > 0) return { mbps: overrideMbps, source: 'override' };
  if (scope) {
    const streams = scopeStreams(scope, now);
    const latest = streams.reduce<StreamSpeed | undefined>((a, s) => (!a || s.at > a.at ? s : a), undefined);
    if (latest && now - latest.at <= RECENT_MS) return { mbps: latest.mbps, source: 'recent' };
    for (const [source, windowMs] of HISTORY_WINDOWS) {
      const inWindow = streams.filter(s => now - s.at <= windowMs);
      if (inWindow.length >= MIN_STREAMS_PER_WINDOW) return { mbps: lowerQuartile(inWindow), source, streams: inWindow.length };
    }
    if (streams.length > 0) return { mbps: lowerQuartile(streams), source: 'history', streams: streams.length };
    return { mbps: DEFAULT_MBPS, source: 'default' };
  }
  if (probe && now - probe.at < PROBE_TTL_MS) return { mbps: Math.min(probe.mbps, DEFAULT_MBPS), source: 'probe' };
  return { mbps: DEFAULT_MBPS, source: 'default' };
}

/** Uses the scope's stream speeds; probes only when no scope is available. */
export async function resolveBandwidth(scope?: string, overrideMbps?: number, maxWaitMs = 6_000): Promise<BandwidthEstimate> {
  const known = peekBandwidth(scope, overrideMbps);
  if (known.source !== 'default') return known;
  if (scope) return known;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([warmBandwidthProbe(), new Promise<void>(resolve => { timer = setTimeout(resolve, maxWaitMs); })]);
  clearTimeout(timer);
  return peekBandwidth(scope, overrideMbps);
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
