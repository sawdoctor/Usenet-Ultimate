/**
 * Release Reputation Tracker
 *
 * Builds a per-release evidence log from real observations (search-time
 * health checks, Stremio streaming outcomes, and *arr download/import
 * outcomes) and aggregates them into release-group and indexer reputation
 * counters.
 *
 * Grab outcomes are resolved via a small OutcomeProvider architecture (see
 * the Reconciliation section below) so new sources — another Servarr app,
 * a different download client — plug in without touching the reconciler.
 *
 * Phase 2: record evidence and expose confidence-weighted reputation scores.
 * Ranking consumers decide how strongly to apply those scores.
 *
 * Persisted to config/reputation.json alongside stats.json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import { getLatestVersions } from './versionFetcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPUTATION_FILE = path.join(__dirname, '..', 'config', 'reputation.json');

const MAX_RELEASES = 2000;          // prune oldest beyond this
const PENDING_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // grab never seen in history → 'lost'
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type OutcomeBucket = 'missing_articles' | 'repair_failed' | 'passworded' | 'other';

export interface ReleaseRecord {
  title: string;
  releaseGroup: string | null;
  indexer: string | null;
  nzbUrl?: string;
  firstSeen: string;
  lastSeen: string;
  health: { alive: number; dead: number; lastResult: 'alive' | 'dead' | null; lastMessage?: string; lastChecked?: string };
  passworded: boolean;
  grabs: Array<{ timestamp: string; source: 'arr' | 'other'; userAgent?: string }>;
  streams?: { succeeded: number; failed: number; lastMessage?: string; lastAt?: string };
  outcome: {
    status: 'pending' | 'success' | 'failed' | 'lost' | null;
    bucket?: OutcomeBucket;
    failMessage?: string;
    resolvedAt?: string;
    source?: 'arr-history' | 'nzbdav' | 'stremio';
  };
}

interface AggregateStats {
  grabs: number;
  successes: number;
  failures: number;
  streamSuccesses: number;
  streamFailures: number;
  healthAlive: number;
  healthDead: number;
  passworded: number;
  lastActivity: string | null;
}

interface ReputationData {
  releases: { [key: string]: ReleaseRecord };
  groups: { [group: string]: AggregateStats };
  indexers: { [indexer: string]: AggregateStats };
}

let data: ReputationData = { releases: {}, groups: {}, indexers: {} };

// ---------------------------------------------------------------------------
// Persistence (debounced — health checks can fire in bursts)
// ---------------------------------------------------------------------------

function loadFile(): ReputationData {
  try {
    if (fs.existsSync(REPUTATION_FILE)) {
      return JSON.parse(fs.readFileSync(REPUTATION_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('\u{1F4C8} Reputation: error loading file:', err);
  }
  return { releases: {}, groups: {}, indexers: {} };
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(REPUTATION_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('\u{1F4C8} Reputation: error saving file:', err);
    }
  }, 2000);
}

data = loadFile();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string { return new Date().toISOString(); }

/** Normalized key: lowercase, dots/underscores/spaces collapsed. */
export function releaseKey(title: string): string {
  return title.toLowerCase().replace(/[.\s_]+/g, ' ').trim();
}

/** Best-effort scene-style group parse: trailing -GROUP, sans extension/tags. */
export function parseReleaseGroup(title: string): string | null {
  let t = title.trim().replace(/\.(mkv|mp4|avi|nzb|par2|rar)$/i, '');
  const m = t.match(/-([A-Za-z0-9]+)\s*(\[[^\]]*\])?$/);
  if (m && m[1] && m[1].length <= 24 && !/^\d+$/.test(m[1])) return m[1];
  return null;
}

export function classifyFailMessage(msg: string | undefined): OutcomeBucket {
  const s = (msg || '').toLowerCase();
  if (/password|encrypt/.test(s)) return 'passworded';
  if (/repair|par2|not enough.*blocks/.test(s)) return 'repair_failed';
  if (/missing|article|segment|430|not found/.test(s)) return 'missing_articles';
  return 'other';
}

function emptyAggregate(): AggregateStats {
  return { grabs: 0, successes: 0, failures: 0, streamSuccesses: 0, streamFailures: 0, healthAlive: 0, healthDead: 0, passworded: 0, lastActivity: null };
}

function aggFor(map: { [k: string]: AggregateStats }, key: string | null): AggregateStats | null {
  if (!key) return null;
  if (!map[key]) map[key] = emptyAggregate();
  map[key].lastActivity = now();
  return map[key];
}

function getOrCreateRelease(title: string, indexer: string | null, nzbUrl?: string): ReleaseRecord {
  const key = releaseKey(title);
  if (!data.releases[key]) {
    data.releases[key] = {
      title,
      releaseGroup: parseReleaseGroup(title),
      indexer,
      nzbUrl,
      firstSeen: now(),
      lastSeen: now(),
      health: { alive: 0, dead: 0, lastResult: null },
      passworded: false,
      grabs: [],
      outcome: { status: null },
    };
    pruneIfNeeded();
  }
  const rec = data.releases[key];
  rec.lastSeen = now();
  if (indexer && !rec.indexer) rec.indexer = indexer;
  if (nzbUrl && !rec.nzbUrl) rec.nzbUrl = nzbUrl;
  return rec;
}

function pruneIfNeeded(): void {
  const keys = Object.keys(data.releases);
  if (keys.length <= MAX_RELEASES) return;
  keys.sort((a, b) => data.releases[a].lastSeen.localeCompare(data.releases[b].lastSeen));
  for (const k of keys.slice(0, keys.length - MAX_RELEASES)) delete data.releases[k];
}

// ---------------------------------------------------------------------------
// Recording — called from routes/newznab.ts
// ---------------------------------------------------------------------------

/** Search-time health verdict for a specific release. */
export function recordHealthCheck(
  title: string,
  indexer: string | null,
  alive: boolean,
  message?: string,
): void {
  const rec = getOrCreateRelease(title, indexer);
  rec.health[alive ? 'alive' : 'dead']++;
  rec.health.lastResult = alive ? 'alive' : 'dead';
  rec.health.lastMessage = message;
  rec.health.lastChecked = now();
  const newlyPassworded = !rec.passworded && /password|encrypt/i.test(message || '');
  if (newlyPassworded) rec.passworded = true;

  const g = aggFor(data.groups, rec.releaseGroup);
  if (g) {
    g[alive ? 'healthAlive' : 'healthDead']++;
    if (newlyPassworded) g.passworded++;
  }
  const i = aggFor(data.indexers, rec.indexer);
  if (i) { i[alive ? 'healthAlive' : 'healthDead']++; }
  scheduleSave();
}

/**
 * A t=get download of an NZB. Only requests from Sonarr/Radarr-family
 * user agents count as real grabs with a pending outcome; anything else
 * (UU's own verification, curl tests) is logged but not awaited.
 */
export function recordGrab(
  nzbUrl: string,
  meta: { title: string; indexer: string | null } | null,
  isArr: boolean,
  userAgent?: string,
): void {
  const title = meta?.title || `unknown:${nzbUrl.slice(-40)}`;
  const rec = getOrCreateRelease(title, meta?.indexer ?? null, nzbUrl);
  rec.grabs.push({ timestamp: now(), source: isArr ? 'arr' : 'other', userAgent: userAgent?.slice(0, 60) });
  if (rec.grabs.length > 20) rec.grabs.shift();

  if (isArr) {
    rec.outcome = { status: 'pending' };
    const g = aggFor(data.groups, rec.releaseGroup);
    if (g) g.grabs++;
    const i = aggFor(data.indexers, rec.indexer);
    if (i) i.grabs++;
    console.log(`\u{1F4C8} Reputation: grab recorded — "${rec.title}" [${rec.releaseGroup || 'no group'}] from ${rec.indexer || 'unknown indexer'}, awaiting nzbdav outcome`);
  }
  scheduleSave();
}

// Placeholder titles written by the newznab route's dead-NZB bookkeeping —
// these are not real release titles and must not create reputation records.
const PLACEHOLDER_TITLES = new Set(['newznab search verification', 'newznab t=get grab']);

/**
 * Immediate outcome from the Stremio streaming path. Unlike *arr grabs there
 * is nothing to reconcile — UU itself streamed (or failed to stream) the NZB,
 * so the outcome is known the moment this is called from streamCache.
 */
export function recordStreamOutcome(
  title: string,
  indexer: string | null,
  success: boolean,
  message?: string,
): void {
  if (!title || PLACEHOLDER_TITLES.has(title)) return;
  const rec = getOrCreateRelease(title, indexer);
  if (!rec.streams) rec.streams = { succeeded: 0, failed: 0 };
  rec.streams[success ? 'succeeded' : 'failed']++;
  rec.streams.lastMessage = message;
  rec.streams.lastAt = now();
  if (/password|encrypt/i.test(message || '')) rec.passworded = true;
  // A stream outcome resolves the release unless an *arr grab is mid-flight.
  if (rec.outcome.status !== 'pending') {
    rec.outcome = {
      status: success ? 'success' : 'failed',
      bucket: success ? undefined : classifyFailMessage(message),
      failMessage: message || undefined,
      resolvedAt: now(),
      source: 'stremio',
    };
  }
  const g = aggFor(data.groups, rec.releaseGroup);
  if (g) g[success ? 'streamSuccesses' : 'streamFailures']++;
  const i = aggFor(data.indexers, rec.indexer);
  if (i) i[success ? 'streamSuccesses' : 'streamFailures']++;
  scheduleSave();
}



// ---------------------------------------------------------------------------
// Reconciliation — provider architecture
//
// The reconciler doesn't know or care where an outcome comes from. Each
// OutcomeProvider polls one source, returns a Map of normalized release
// title → resolved outcome for whichever pending releases it recognizes.
// Adding support for another *arr app (Readarr, Lidarr, Whisparr — all
// share the same Servarr /api/v3/history shape) is one new provider
// registration, not a change to the reconciler itself.
//
// Stremio outcomes are NOT polled here — recordStreamOutcome() (above)
// resolves them the instant UU observes a stream succeed or die, since UU
// is a first-party witness on that path and has nothing to reconcile.
// ---------------------------------------------------------------------------

export interface ResolvedOutcome { ok: boolean; message?: string }

export interface OutcomeProvider {
  /** Short label used in outcome.source and log lines, e.g. 'sonarr', 'radarr-1'. */
  name: string;
  /**
   * Return resolved outcomes for as many of the given normalized titles as
   * this source recognizes. Return null (not an empty Map) to mean
   * "unreachable/unconfigured this tick" — that's what triggers the
   * throttled failure log, distinct from "reachable, nothing matched".
   */
  fetchOutcomes(pendingTitleKeys: Set<string>): Promise<Map<string, ResolvedOutcome> | null>;
}

// --- Servarr-family providers (Sonarr, Radarr, and future Readarr/Lidarr/Whisparr) ---

interface ArrHistoryRecord {
  sourceTitle?: string;
  eventType?: string;
  date?: string;
  downloadId?: string;
  data?: { indexer?: string; message?: string; reason?: string; [k: string]: unknown };
}

/** success=imported, failure=downloadFailed/downloadIgnored; 'grabbed' alone is not an outcome. */
function arrOutcomeOf(rec: ArrHistoryRecord): ResolvedOutcome | null {
  const ev = (rec.eventType || '').toLowerCase();
  if (ev.includes('imported')) return { ok: true };
  if (ev === 'downloadfailed' || ev === 'downloadignored') {
    return { ok: false, message: rec.data?.message || rec.data?.reason || rec.eventType };
  }
  return null;
}

/** Builds an OutcomeProvider for any Servarr-family app's /api/v3/history. */
function makeArrHistoryProvider(name: string, baseUrl: string, apiKey: string): OutcomeProvider {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    name,
    async fetchOutcomes(pendingTitleKeys) {
      try {
        const res = await fetch(
          `${base}/api/v3/history?page=1&pageSize=150&sortKey=date&sortDirection=descending`,
          { headers: { 'X-Api-Key': apiKey }, signal: AbortSignal.timeout(15_000) },
        );
        if (!res.ok) {
          logFetchFailure(`${name} returned HTTP ${res.status} for history request`);
          return null;
        }
        const body = await res.json() as { records?: ArrHistoryRecord[] };
        const records = body.records || [];
        const byTitle = new Map<string, ResolvedOutcome>();
        for (const r of records) {
          if (!r.sourceTitle) continue;
          const key = releaseKey(r.sourceTitle);
          if (!pendingTitleKeys.has(key) || byTitle.has(key)) continue; // newest-first: keep first match
          const outcome = arrOutcomeOf(r);
          if (outcome) byTitle.set(key, outcome);
        }
        return byTitle;
      } catch (err: any) {
        logFetchFailure(`cannot reach ${name} at ${base} — ${err?.message || err}`);
        return null;
      }
    },
  };
}

/**
 * Instances come from env vars (comma-separated lists support multiple
 * instances of the same app, keys matched by position):
 *   SONARR_URL=http://sonarr-test:8989   SONARR_API_KEY=xxxx
 *   RADARR_URL=http://radarr-test:7878   RADARR_API_KEY=yyyy
 * Adding Readarr/Lidarr/Whisparr later is just another addServarrApp() call —
 * they speak the identical /api/v3/history API.
 */
function buildProviders(): OutcomeProvider[] {
  const providers: OutcomeProvider[] = [];
  const addServarrApp = (label: string, urls?: string, keys?: string) => {
    const u = (urls || '').split(',').map(s => s.trim()).filter(Boolean);
    const k = (keys || '').split(',').map(s => s.trim()).filter(Boolean);
    u.forEach((url, idx) => {
      if (k[idx]) providers.push(makeArrHistoryProvider(u.length > 1 ? `${label}-${idx + 1}` : label, url, k[idx]));
    });
  };
  addServarrApp('sonarr', process.env.SONARR_URL, process.env.SONARR_API_KEY);
  addServarrApp('radarr', process.env.RADARR_URL, process.env.RADARR_API_KEY);
  // Future: addServarrApp('readarr', process.env.READARR_URL, process.env.READARR_API_KEY);
  // Future: addServarrApp('lidarr', process.env.LIDARR_URL, process.env.LIDARR_API_KEY);
  providers.push(nzbdavHistoryProvider);
  return providers;
}

// --- nzbdav SABnzbd-compatible history: transient secondary source. The
// *arr apps delete completed entries from it right after import, so it
// only helps for items nothing has cleaned up yet (or non-*arr grabs). ---

interface SabHistorySlot { nzo_id?: string; nzoId?: string; status?: string; Status?: string; fail_message?: string; failMessage?: string; name?: string }

const nzbdavHistoryProvider: OutcomeProvider = {
  name: 'nzbdav',
  async fetchOutcomes(pendingTitleKeys) {
    const url = (config as any).nzbdavUrl as string | undefined;
    const apiKey = (config as any).nzbdavApiKey as string | undefined;
    if (!url || !apiKey) return null; // optional secondary source — not configuring it is fine
    const base = url.replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/api?mode=history&apikey=${apiKey}&output=json`, {
        headers: { 'User-Agent': (config as any).userAgents?.nzbdavOperations || getLatestVersions().chrome },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        logFetchFailure(`nzbdav returned HTTP ${res.status} for history request`);
        return null;
      }
      const body = await res.json() as { history?: { slots?: SabHistorySlot[] } };
      const slots = body.history?.slots || [];
      const byTitle = new Map<string, ResolvedOutcome>();
      for (const s of slots) {
        if (!s.name) continue;
        const key = releaseKey(s.name);
        if (!pendingTitleKeys.has(key)) continue;
        const status = s.status || s.Status || '';
        if (/completed/i.test(status)) byTitle.set(key, { ok: true });
        else if (/failed/i.test(status)) byTitle.set(key, { ok: false, message: s.fail_message || s.failMessage });
        // otherwise still downloading/queued — no verdict yet
      }
      return byTitle;
    } catch (err: any) {
      logFetchFailure(`cannot reach nzbdav at ${base} — ${err?.message || err}`);
      return null;
    }
  },
};

let lastFetchFailureLoggedAt = 0;
const FAILURE_LOG_THROTTLE_MS = 30 * 60 * 1000; // don't spam — once per 30 min while broken
function logFetchFailure(msg: string): void {
  const nowMs = Date.now();
  if (nowMs - lastFetchFailureLoggedAt < FAILURE_LOG_THROTTLE_MS) return;
  lastFetchFailureLoggedAt = nowMs;
  console.error(`\u{1F4C8} Reputation: ${msg} (this message is throttled to once per 30 min while the condition persists)`);
}

function resolveOutcome(rec: ReleaseRecord, ok: boolean, message: string | undefined, source: 'arr-history' | 'nzbdav'): void {
  rec.outcome = {
    status: ok ? 'success' : 'failed',
    bucket: ok ? undefined : classifyFailMessage(message),
    failMessage: message || undefined,
    resolvedAt: now(),
    source,
  };
  const g = aggFor(data.groups, rec.releaseGroup);
  if (g) g[ok ? 'successes' : 'failures']++;
  const i = aggFor(data.indexers, rec.indexer);
  if (i) i[ok ? 'successes' : 'failures']++;
  console.log(`\u{1F4C8} Reputation: outcome for "${rec.title}" → ${rec.outcome.status}${rec.outcome.bucket ? ` (${rec.outcome.bucket})` : ''} [${source}]`);
}

let providers: OutcomeProvider[] | null = null;
let reconciling = false;

export async function reconcileWithNzbdav(): Promise<void> {
  if (reconciling) return;
  const pending = Object.values(data.releases).filter(r => r.outcome.status === 'pending');
  if (pending.length === 0) return;
  reconciling = true;
  try {
    if (!providers) providers = buildProviders();
    const servarrProviders = providers.filter(p => p !== nzbdavHistoryProvider);
    if (servarrProviders.length === 0) {
      logFetchFailure('no Sonarr/Radarr instances configured (set SONARR_URL/SONARR_API_KEY and/or RADARR_URL/RADARR_API_KEY) — grab outcomes cannot be resolved from *arr history');
    }

    let remaining = pending;
    for (const provider of providers) {
      if (remaining.length === 0) break;
      const keys = new Set(remaining.map(r => releaseKey(r.title)));
      const outcomes = await provider.fetchOutcomes(keys);
      if (outcomes === null) continue; // this provider had nothing to say this tick

      if (lastFetchFailureLoggedAt > 0) {
        console.log(`\u{1F4C8} Reputation: ${provider.name} reachable — reconciler resumed`);
        lastFetchFailureLoggedAt = 0;
      }

      const source: 'arr-history' | 'nzbdav' = provider === nzbdavHistoryProvider ? 'nzbdav' : 'arr-history';
      for (const rec of remaining) {
        const outcome = outcomes.get(releaseKey(rec.title));
        if (outcome) resolveOutcome(rec, outcome.ok, outcome.message, source);
      }
      remaining = remaining.filter(r => r.outcome.status === 'pending');
    }

    // Never appeared anywhere and grab is old → mark lost, don't count against anyone.
    for (const rec of remaining) {
      const lastGrab = rec.grabs[rec.grabs.length - 1];
      if (lastGrab && Date.now() - new Date(lastGrab.timestamp).getTime() > PENDING_EXPIRY_MS) {
        rec.outcome = { status: 'lost', resolvedAt: now() };
        console.log(`\u{1F4C8} Reputation: "${rec.title}" never appeared in any outcome source — marked lost`);
      }
    }
    scheduleSave();
  } finally {
    reconciling = false;
  }
}

let reconcilerStarted = false;
export function startReputationReconciler(): void {
  if (reconcilerStarted) return;
  reconcilerStarted = true;
  setInterval(() => {
    reconcileWithNzbdav().catch(err => {
      console.error('\u{1F4C8} Reputation: unexpected reconciler error:', err);
    });
  }, RECONCILE_INTERVAL_MS);
  console.log('\u{1F4C8} Reputation tracker active (Stremio outcomes: live; grab outcomes: provider-based reconciler every 5 min)');
}


// ---------------------------------------------------------------------------
// Scoring (v1.7) — turns raw evidence into a ranking signal
//
// Model: Bayesian shrinkage toward a neutral prior. Every subject starts as
// "probably fine" (PRIOR_RATE) backed by PRIOR_WEIGHT phantom observations;
// real evidence gradually overrides the prior as it accumulates. This is the
// confidence weighting: 1 failure out of 2 grabs barely moves the score,
// 12 failures out of 400 moves it decisively.
//
// Evidence weights (failures deliberately outweigh successes — a bad
// download costs the user more than a good one saves):
//   import success +1.0   import failure   -2.0
//   stream success +1.0   stream failure   -1.5
//   passworded     -3.0
//   health alive   +0.1   health dead      -0.25   (weak evidence: pre-download)
// ---------------------------------------------------------------------------

export interface ReputationScore {
  /** Ranking modifier, ~-100..+60. 0 = unknown/neutral. */
  score: number;
  /** Raw observed outcome success rate (imports + streams), null if no outcomes yet. */
  successRate: number | null;
  /** Weighted evidence backing the score. */
  samples: number;
  /** 0..1 — how much real evidence vs prior. */
  confidence: number;
  /** 1..5 display rating; 3 = neutral/unknown. */
  stars: number;
}

const PRIOR_RATE = 0.85;
const PRIOR_WEIGHT = 8;
const SCORE_SCALE = 200;
const SCORE_MIN = -100;
const SCORE_MAX = 60;

function scoreAggregate(a: AggregateStats | undefined): ReputationScore {
  if (!a) return { score: 0, successRate: null, samples: 0, confidence: 0, stars: 3 };
  const S = a.successes + a.streamSuccesses + a.healthAlive * 0.1;
  const F = a.failures * 2 + a.streamFailures * 1.5 + a.passworded * 3 + a.healthDead * 0.25;
  const samples = S + F;
  const outcomes = a.successes + a.failures + a.streamSuccesses + a.streamFailures;
  const successRate = outcomes > 0
    ? (a.successes + a.streamSuccesses) / outcomes
    : null;
  const shrunkRate = (S + PRIOR_RATE * PRIOR_WEIGHT) / (samples + PRIOR_WEIGHT);
  const confidence = samples / (samples + PRIOR_WEIGHT);
  const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round((shrunkRate - PRIOR_RATE) * SCORE_SCALE)));
  const stars = shrunkRate >= 0.95 ? 5 : shrunkRate >= 0.85 ? 4 : shrunkRate >= 0.7 ? 3 : shrunkRate >= 0.5 ? 2 : 1;
  return { score, successRate, samples: Math.round(samples * 10) / 10, confidence: Math.round(confidence * 100) / 100, stars };
}

export function getGroupReputation(group: string | null | undefined): ReputationScore {
  return scoreAggregate(group ? data.groups[group] : undefined);
}

export function getIndexerReputation(name: string | null | undefined): ReputationScore {
  return scoreAggregate(name ? data.indexers[name] : undefined);
}

/**
 * REPUTATION_WEIGHT env var: off | low | medium | high → 0 / 0.5 / 1 / 2.
 * Defaults to medium. Controls how strongly reputation reorders results.
 */
export function getReputationWeightMultiplier(): number {
  const w = (process.env.REPUTATION_WEIGHT || 'medium').toLowerCase();
  if (w === 'off' || w === '0') return 0;
  if (w === 'low') return 0.5;
  if (w === 'high') return 2;
  return 1;
}

/**
 * Single ranking modifier for a release: group reputation dominates,
 * indexer reputation contributes a quarter (an indexer serving many bad
 * releases is a real but weaker signal than the release group itself).
 */
export function reputationRankBoost(title: string, indexer?: string | null): number {
  const mult = getReputationWeightMultiplier();
  if (mult === 0) return 0;
  const group = parseReleaseGroup(title);
  const g = getGroupReputation(group);
  const i = getIndexerReputation(indexer);
  return Math.round((g.score + i.score * 0.25) * mult);
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export function getReputationData(): {
  summary: { releases: number; pendingOutcomes: number; groups: number; indexers: number; weighting: string };
  groups: { [g: string]: AggregateStats & { reputation: ReputationScore } };
  indexers: { [i: string]: AggregateStats & { reputation: ReputationScore } };
  recentReleases: ReleaseRecord[];
} {
  const releases = Object.values(data.releases);
  const scored = <T extends { [k: string]: AggregateStats }>(map: T) =>
    Object.fromEntries(
      Object.entries(map)
        .map(([k, a]) => [k, { ...a, reputation: scoreAggregate(a) }] as const)
        .sort((x, y) => y[1].reputation.score - x[1].reputation.score),
    ) as { [k: string]: AggregateStats & { reputation: ReputationScore } };
  return {
    summary: {
      releases: releases.length,
      pendingOutcomes: releases.filter(r => r.outcome.status === 'pending').length,
      groups: Object.keys(data.groups).length,
      indexers: Object.keys(data.indexers).length,
      weighting: (process.env.REPUTATION_WEIGHT || 'medium').toLowerCase(),
    },
    groups: scored(data.groups),
    indexers: scored(data.indexers),
    recentReleases: releases
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, 50),
  };
}
