from pathlib import Path

provider_reputation = r'''/**
 * Local NNTP Provider Reputation
 *
 * Observes the provider checks UU already performs and records provider-local
 * evidence without changing provider order, priority, enablement, or health
 * verdicts. Lifetime counters are retained indefinitely; rolling hourly
 * buckets keep enough history for honest 24h / 7d / 30d views.
 *
 * Persisted to config/provider-reputation.json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { UsenetProvider } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROVIDER_REPUTATION_FILE = process.env.PROVIDER_REPUTATION_FILE
  || path.join(__dirname, '..', 'config', 'provider-reputation.json');

const SCHEMA_VERSION = 2;
const SAVE_DEBOUNCE_MS = 2_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_RETENTION_MS = 31 * DAY_MS;

export type ProviderFailureBucket = 'auth' | 'tls' | 'timeout' | 'connection' | 'other';
export type ProviderReputationWindow = 'lifetime' | '24h' | '7d' | '30d';

export interface ProviderReputationRecord {
  id: string;
  name: string;
  type: 'pool' | 'backup';
  firstSeen: string;
  lastSeen: string;
  successfulChecks: number;
  failedChecks: number;
  articlesChecked: number;
  found: number;
  missing: number;
  unknown: number;
  backupSaves: number;
  authFailures: number;
  tlsFailures: number;
  timeoutFailures: number;
  connectionFailures: number;
  otherFailures: number;
  latencyMsTotal: number;
  latencySamples: number;
  lastLatencyMs: number | null;
  lastError?: string;
  lastErrorAt?: string;
}

export interface ProviderHistoryBucket {
  bucketStart: string;
  firstSeen: string;
  lastSeen: string;
  successfulChecks: number;
  failedChecks: number;
  articlesChecked: number;
  found: number;
  missing: number;
  unknown: number;
  backupSaves: number;
  authFailures: number;
  tlsFailures: number;
  timeoutFailures: number;
  connectionFailures: number;
  otherFailures: number;
  latencyMsTotal: number;
  latencySamples: number;
  lastLatencyMs: number | null;
}

interface ProviderReputationData {
  schemaVersion: number;
  providers: Record<string, ProviderReputationRecord>;
  history: Record<string, ProviderHistoryBucket[]>;
  historyStartedAt: string | null;
}

export interface ProviderDerivedMetrics {
  checkSuccessRate: number | null;
  answerRate: number | null;
  coverageRate: number | null;
  averageLatencyMs: number | null;
  confidence: number;
}

export interface ProviderReputationView {
  id: string;
  name: string;
  type: 'pool' | 'backup';
  enabled: boolean;
  observed: boolean;
  stats: ProviderReputationRecord | null;
  metrics: ProviderDerivedMetrics;
}

export interface ProviderReputationSnapshot {
  summary: {
    configured: number;
    tracked: number;
    totalCheckAttempts: number;
    totalArticlesChecked: number;
    lastActivity: string | null;
    mode: 'observe-only';
    window: ProviderReputationWindow;
    historyAvailableFrom: string | null;
  };
  providers: ProviderReputationView[];
  retired: Array<ProviderReputationRecord & { metrics: ProviderDerivedMetrics }>;
}

function now(): string {
  return new Date().toISOString();
}

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function emptyRecord(provider: Pick<UsenetProvider, 'id' | 'name' | 'type'>, at = now()): ProviderReputationRecord {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    firstSeen: at,
    lastSeen: at,
    successfulChecks: 0,
    failedChecks: 0,
    articlesChecked: 0,
    found: 0,
    missing: 0,
    unknown: 0,
    backupSaves: 0,
    authFailures: 0,
    tlsFailures: 0,
    timeoutFailures: 0,
    connectionFailures: 0,
    otherFailures: 0,
    latencyMsTotal: 0,
    latencySamples: 0,
    lastLatencyMs: null,
  };
}

function emptyHistoryBucket(at: string): ProviderHistoryBucket {
  const bucketMs = Math.floor(Date.parse(at) / HOUR_MS) * HOUR_MS;
  return {
    bucketStart: new Date(bucketMs).toISOString(),
    firstSeen: at,
    lastSeen: at,
    successfulChecks: 0,
    failedChecks: 0,
    articlesChecked: 0,
    found: 0,
    missing: 0,
    unknown: 0,
    backupSaves: 0,
    authFailures: 0,
    tlsFailures: 0,
    timeoutFailures: 0,
    connectionFailures: 0,
    otherFailures: 0,
    latencyMsTotal: 0,
    latencySamples: 0,
    lastLatencyMs: null,
  };
}

function normalizeRecord(raw: Partial<ProviderReputationRecord>, id: string): ProviderReputationRecord {
  const fallbackType = raw.type === 'backup' ? 'backup' : 'pool';
  const firstSeen = typeof raw.firstSeen === 'string' ? raw.firstSeen : now();
  const lastSeen = typeof raw.lastSeen === 'string' ? raw.lastSeen : firstSeen;
  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    type: fallbackType,
    firstSeen,
    lastSeen,
    successfulChecks: finite(raw.successfulChecks),
    failedChecks: finite(raw.failedChecks),
    articlesChecked: finite(raw.articlesChecked),
    found: finite(raw.found),
    missing: finite(raw.missing),
    unknown: finite(raw.unknown),
    backupSaves: finite(raw.backupSaves),
    authFailures: finite(raw.authFailures),
    tlsFailures: finite(raw.tlsFailures),
    timeoutFailures: finite(raw.timeoutFailures),
    connectionFailures: finite(raw.connectionFailures),
    otherFailures: finite(raw.otherFailures),
    latencyMsTotal: finite(raw.latencyMsTotal),
    latencySamples: finite(raw.latencySamples),
    lastLatencyMs: Number.isFinite(Number(raw.lastLatencyMs)) ? Number(raw.lastLatencyMs) : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
    lastErrorAt: typeof raw.lastErrorAt === 'string' ? raw.lastErrorAt : undefined,
  };
}

function normalizeHistoryBucket(raw: Partial<ProviderHistoryBucket>): ProviderHistoryBucket | null {
  const bucketStart = typeof raw.bucketStart === 'string' ? raw.bucketStart : '';
  if (!Number.isFinite(Date.parse(bucketStart))) return null;
  const firstSeen = typeof raw.firstSeen === 'string' ? raw.firstSeen : bucketStart;
  const lastSeen = typeof raw.lastSeen === 'string' ? raw.lastSeen : firstSeen;
  return {
    bucketStart,
    firstSeen,
    lastSeen,
    successfulChecks: finite(raw.successfulChecks),
    failedChecks: finite(raw.failedChecks),
    articlesChecked: finite(raw.articlesChecked),
    found: finite(raw.found),
    missing: finite(raw.missing),
    unknown: finite(raw.unknown),
    backupSaves: finite(raw.backupSaves),
    authFailures: finite(raw.authFailures),
    tlsFailures: finite(raw.tlsFailures),
    timeoutFailures: finite(raw.timeoutFailures),
    connectionFailures: finite(raw.connectionFailures),
    otherFailures: finite(raw.otherFailures),
    latencyMsTotal: finite(raw.latencyMsTotal),
    latencySamples: finite(raw.latencySamples),
    lastLatencyMs: Number.isFinite(Number(raw.lastLatencyMs)) ? Number(raw.lastLatencyMs) : null,
  };
}

function loadData(): ProviderReputationData {
  try {
    if (!fs.existsSync(PROVIDER_REPUTATION_FILE)) {
      return { schemaVersion: SCHEMA_VERSION, providers: {}, history: {}, historyStartedAt: null };
    }
    const parsed = JSON.parse(fs.readFileSync(PROVIDER_REPUTATION_FILE, 'utf-8')) as Partial<ProviderReputationData>;
    const providers: Record<string, ProviderReputationRecord> = {};
    for (const [id, raw] of Object.entries(parsed.providers || {})) {
      providers[id] = normalizeRecord(raw, id);
    }
    const history: Record<string, ProviderHistoryBucket[]> = {};
    for (const [id, rawBuckets] of Object.entries(parsed.history || {})) {
      const buckets = Array.isArray(rawBuckets)
        ? rawBuckets.map(normalizeHistoryBucket).filter((v): v is ProviderHistoryBucket => v !== null)
        : [];
      if (buckets.length > 0) history[id] = buckets.sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      providers,
      history,
      historyStartedAt: typeof parsed.historyStartedAt === 'string' ? parsed.historyStartedAt : null,
    };
  } catch (err) {
    console.error('📡 Provider reputation: error loading file:', err);
    return { schemaVersion: SCHEMA_VERSION, providers: {}, history: {}, historyStartedAt: null };
  }
}

let data = loadData();
let saveTimer: NodeJS.Timeout | null = null;

function pruneHistory(referenceMs = Date.now()): void {
  const cutoff = referenceMs - HISTORY_RETENTION_MS;
  for (const [providerId, buckets] of Object.entries(data.history)) {
    const retained = buckets.filter(bucket => Date.parse(bucket.lastSeen) >= cutoff);
    if (retained.length > 0) data.history[providerId] = retained;
    else delete data.history[providerId];
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      pruneHistory();
      fs.mkdirSync(path.dirname(PROVIDER_REPUTATION_FILE), { recursive: true });
      fs.writeFileSync(PROVIDER_REPUTATION_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('📡 Provider reputation: error saving file:', err);
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

function recordFor(provider: Pick<UsenetProvider, 'id' | 'name' | 'type'>, at: string): ProviderReputationRecord {
  const existing = data.providers[provider.id];
  if (!existing) data.providers[provider.id] = emptyRecord(provider, at);
  const rec = data.providers[provider.id];
  rec.name = provider.name;
  rec.type = provider.type;
  rec.lastSeen = at;
  return rec;
}

function historyBucketFor(providerId: string, at: string): ProviderHistoryBucket {
  const bucketStart = new Date(Math.floor(Date.parse(at) / HOUR_MS) * HOUR_MS).toISOString();
  const buckets = data.history[providerId] || (data.history[providerId] = []);
  let bucket = buckets[buckets.length - 1];
  if (!bucket || bucket.bucketStart !== bucketStart) {
    bucket = emptyHistoryBucket(at);
    buckets.push(bucket);
  }
  bucket.lastSeen = at;
  if (!data.historyStartedAt) data.historyStartedAt = at;
  return bucket;
}

function roundedRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function deriveProviderMetrics(record: ProviderReputationRecord | null | undefined): ProviderDerivedMetrics {
  if (!record) {
    return { checkSuccessRate: null, answerRate: null, coverageRate: null, averageLatencyMs: null, confidence: 0 };
  }
  const attempts = record.successfulChecks + record.failedChecks;
  const definitive = record.found + record.missing;
  const evidence = attempts * 3 + record.articlesChecked;
  return {
    checkSuccessRate: roundedRate(record.successfulChecks, attempts),
    answerRate: roundedRate(definitive, record.articlesChecked),
    coverageRate: roundedRate(record.found, definitive),
    averageLatencyMs: record.latencySamples > 0 ? Math.round(record.latencyMsTotal / record.latencySamples) : null,
    confidence: Math.round(Math.min(1, evidence / 100) * 100) / 100,
  };
}

export function classifyProviderFailure(error: unknown): ProviderFailureBucket {
  const message = String((error as any)?.message || error || '').toLowerCase();
  if (/auth|authentication|username|password|480\b|481\b|482\b|502\b/.test(message)) return 'auth';
  if (/tls|ssl|certificate|self[- ]signed|unable to verify|cert_/.test(message)) return 'tls';
  if (/timeout|timed out|etimedout/.test(message)) return 'timeout';
  if (/connect|connection|socket|econn|enotfound|ehostunreach|network/.test(message)) return 'connection';
  return 'other';
}

export function windowDurationMs(window: ProviderReputationWindow): number | null {
  if (window === '24h') return DAY_MS;
  if (window === '7d') return 7 * DAY_MS;
  if (window === '30d') return 30 * DAY_MS;
  return null;
}

export function aggregateProviderBuckets(
  provider: Pick<UsenetProvider, 'id' | 'name' | 'type'>,
  buckets: ProviderHistoryBucket[],
  window: Exclude<ProviderReputationWindow, 'lifetime'>,
  referenceMs = Date.now(),
): ProviderReputationRecord | null {
  const duration = windowDurationMs(window)!;
  const cutoff = referenceMs - duration;
  const selected = buckets.filter(bucket => Date.parse(bucket.lastSeen) >= cutoff);
  if (selected.length === 0) return null;

  const first = selected[0];
  const last = selected[selected.length - 1];
  const rec = emptyRecord(provider, first.firstSeen);
  rec.lastSeen = last.lastSeen;
  for (const bucket of selected) {
    rec.successfulChecks += bucket.successfulChecks;
    rec.failedChecks += bucket.failedChecks;
    rec.articlesChecked += bucket.articlesChecked;
    rec.found += bucket.found;
    rec.missing += bucket.missing;
    rec.unknown += bucket.unknown;
    rec.backupSaves += bucket.backupSaves;
    rec.authFailures += bucket.authFailures;
    rec.tlsFailures += bucket.tlsFailures;
    rec.timeoutFailures += bucket.timeoutFailures;
    rec.connectionFailures += bucket.connectionFailures;
    rec.otherFailures += bucket.otherFailures;
    rec.latencyMsTotal += bucket.latencyMsTotal;
    rec.latencySamples += bucket.latencySamples;
  }
  rec.lastLatencyMs = last.lastLatencyMs;
  return rec;
}

export function recordProviderCheck(
  provider: Pick<UsenetProvider, 'id' | 'name' | 'type'>,
  observation: { found: number; missing: number; unknown: number; latencyMs: number; backupSaves?: number },
): void {
  const at = now();
  const rec = recordFor(provider, at);
  const bucket = historyBucketFor(provider.id, at);
  const found = Math.max(0, finite(observation.found));
  const missing = Math.max(0, finite(observation.missing));
  const unknown = Math.max(0, finite(observation.unknown));
  const saves = Math.max(0, finite(observation.backupSaves));
  const latency = Math.max(0, finite(observation.latencyMs));

  for (const target of [rec, bucket]) {
    target.successfulChecks++;
    target.found += found;
    target.missing += missing;
    target.unknown += unknown;
    target.articlesChecked += found + missing + unknown;
    target.backupSaves += saves;
    target.latencyMsTotal += latency;
    target.latencySamples++;
    target.lastLatencyMs = Math.round(latency);
  }
  scheduleSave();
}

export function recordProviderFailure(
  provider: Pick<UsenetProvider, 'id' | 'name' | 'type'>,
  error: unknown,
  latencyMs: number,
): void {
  const at = now();
  const rec = recordFor(provider, at);
  const bucket = historyBucketFor(provider.id, at);
  const failure = classifyProviderFailure(error);
  const latency = Math.max(0, finite(latencyMs));

  for (const target of [rec, bucket]) {
    target.failedChecks++;
    if (failure === 'auth') target.authFailures++;
    else if (failure === 'tls') target.tlsFailures++;
    else if (failure === 'timeout') target.timeoutFailures++;
    else if (failure === 'connection') target.connectionFailures++;
    else target.otherFailures++;
    target.latencyMsTotal += latency;
    target.latencySamples++;
    target.lastLatencyMs = Math.round(latency);
  }
  rec.lastError = String((error as any)?.message || error || 'Provider check failed').slice(0, 240);
  rec.lastErrorAt = at;
  scheduleSave();
}

export function getProviderReputationData(
  configuredProviders: UsenetProvider[],
  window: ProviderReputationWindow = 'lifetime',
): ProviderReputationSnapshot {
  const configuredIds = new Set(configuredProviders.map(p => p.id));

  const recordForWindow = (provider: Pick<UsenetProvider, 'id' | 'name' | 'type'>): ProviderReputationRecord | null => {
    if (window === 'lifetime') return data.providers[provider.id] || null;
    return aggregateProviderBuckets(provider, data.history[provider.id] || [], window);
  };

  const providers: ProviderReputationView[] = configuredProviders.map(provider => {
    const rec = recordForWindow(provider);
    return {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      enabled: provider.enabled,
      observed: rec !== null,
      stats: rec,
      metrics: deriveProviderMetrics(rec),
    };
  });

  const retired = Object.values(data.providers)
    .filter(rec => !configuredIds.has(rec.id))
    .map(rec => {
      const selected = window === 'lifetime'
        ? rec
        : aggregateProviderBuckets(rec, data.history[rec.id] || [], window);
      return selected ? { ...selected, metrics: deriveProviderMetrics(selected) } : null;
    })
    .filter((v): v is ProviderReputationRecord & { metrics: ProviderDerivedMetrics } => v !== null)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

  const selectedRecords = [
    ...providers.map(p => p.stats).filter((v): v is ProviderReputationRecord => v !== null),
    ...retired,
  ];

  return {
    summary: {
      configured: configuredProviders.length,
      tracked: selectedRecords.length,
      totalCheckAttempts: selectedRecords.reduce((sum, r) => sum + r.successfulChecks + r.failedChecks, 0),
      totalArticlesChecked: selectedRecords.reduce((sum, r) => sum + r.articlesChecked, 0),
      lastActivity: selectedRecords.length > 0
        ? selectedRecords.reduce((latest, r) => r.lastSeen > latest ? r.lastSeen : latest, selectedRecords[0].lastSeen)
        : null,
      mode: 'observe-only',
      window,
      historyAvailableFrom: data.historyStartedAt,
    },
    providers,
    retired,
  };
}
'''

route = r'''import { Router } from 'express';
import type { UsenetProvider } from '../types.js';
import {
  getProviderReputationData,
  type ProviderReputationWindow,
} from '../providerReputation.js';

interface ReputationRouteDeps {
  getProviders: () => UsenetProvider[];
}

const WINDOWS = new Set<ProviderReputationWindow>(['lifetime', '24h', '7d', '30d']);

export function createReputationRoutes(deps: ReputationRouteDeps): Router {
  const router = Router();

  router.get('/providers', (req, res) => {
    const requested = String(req.query.window || 'lifetime') as ProviderReputationWindow;
    const window: ProviderReputationWindow = WINDOWS.has(requested) ? requested : 'lifetime';
    res.json(getProviderReputationData(deps.getProviders(), window));
  });

  return router;
}
'''

test_file = r'''import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateProviderBuckets,
  classifyProviderFailure,
  deriveProviderMetrics,
  windowDurationMs,
  type ProviderHistoryBucket,
  type ProviderReputationRecord,
} from '../src/providerReputation.js';

const record = (overrides: Partial<ProviderReputationRecord> = {}): ProviderReputationRecord => ({
  id: 'provider-1',
  name: 'Test Provider',
  type: 'pool',
  firstSeen: '2026-09-13T00:00:00.000Z',
  lastSeen: '2026-09-13T00:01:00.000Z',
  successfulChecks: 4,
  failedChecks: 1,
  articlesChecked: 12,
  found: 8,
  missing: 2,
  unknown: 2,
  backupSaves: 0,
  authFailures: 0,
  tlsFailures: 0,
  timeoutFailures: 1,
  connectionFailures: 0,
  otherFailures: 0,
  latencyMsTotal: 500,
  latencySamples: 5,
  lastLatencyMs: 100,
  ...overrides,
});

const bucket = (bucketStart: string, overrides: Partial<ProviderHistoryBucket> = {}): ProviderHistoryBucket => ({
  bucketStart,
  firstSeen: bucketStart,
  lastSeen: bucketStart,
  successfulChecks: 1,
  failedChecks: 0,
  articlesChecked: 3,
  found: 3,
  missing: 0,
  unknown: 0,
  backupSaves: 0,
  authFailures: 0,
  tlsFailures: 0,
  timeoutFailures: 0,
  connectionFailures: 0,
  otherFailures: 0,
  latencyMsTotal: 300,
  latencySamples: 1,
  lastLatencyMs: 300,
  ...overrides,
});

test('provider metrics expose raw reliability without inventing a magic score', () => {
  const metrics = deriveProviderMetrics(record());
  assert.equal(metrics.checkSuccessRate, 0.8);
  assert.equal(metrics.answerRate, 0.8333);
  assert.equal(metrics.coverageRate, 0.8);
  assert.equal(metrics.averageLatencyMs, 100);
  assert.equal(metrics.confidence, 0.27);
});

test('unobserved providers remain explicitly unknown', () => {
  assert.deepEqual(deriveProviderMetrics(null), {
    checkSuccessRate: null,
    answerRate: null,
    coverageRate: null,
    averageLatencyMs: null,
    confidence: 0,
  });
});

test('provider failure classification separates operational failure types', () => {
  assert.equal(classifyProviderFailure(new Error('480 Authentication required')), 'auth');
  assert.equal(classifyProviderFailure(new Error('self-signed certificate in certificate chain')), 'tls');
  assert.equal(classifyProviderFailure(new Error('Article check timeout after 30000ms')), 'timeout');
  assert.equal(classifyProviderFailure(new Error('ECONNREFUSED 127.0.0.1:563')), 'connection');
  assert.equal(classifyProviderFailure(new Error('unexpected provider response')), 'other');
});

test('window durations are explicit and lifetime is unbounded', () => {
  assert.equal(windowDurationMs('24h'), 24 * 60 * 60 * 1000);
  assert.equal(windowDurationMs('7d'), 7 * 24 * 60 * 60 * 1000);
  assert.equal(windowDurationMs('30d'), 30 * 24 * 60 * 60 * 1000);
  assert.equal(windowDurationMs('lifetime'), null);
});

test('24h provider history excludes older buckets and aggregates recent evidence', () => {
  const reference = Date.parse('2026-09-13T12:00:00.000Z');
  const result = aggregateProviderBuckets(
    { id: 'provider-1', name: 'Test Provider', type: 'pool' },
    [
      bucket('2026-09-11T12:00:00.000Z', { found: 0, missing: 3 }),
      bucket('2026-09-13T01:00:00.000Z', { found: 2, missing: 1, latencyMsTotal: 400, lastLatencyMs: 400 }),
      bucket('2026-09-13T11:00:00.000Z', { found: 3, missing: 0, latencyMsTotal: 200, lastLatencyMs: 200 }),
    ],
    '24h',
    reference,
  );
  assert.ok(result);
  assert.equal(result.successfulChecks, 2);
  assert.equal(result.articlesChecked, 6);
  assert.equal(result.found, 5);
  assert.equal(result.missing, 1);
  assert.equal(result.latencyMsTotal, 600);
  assert.equal(result.latencySamples, 2);
  assert.equal(result.lastLatencyMs, 200);
});

test('window aggregation returns null when there is no evidence in range', () => {
  const result = aggregateProviderBuckets(
    { id: 'provider-1', name: 'Test Provider', type: 'pool' },
    [bucket('2026-08-01T00:00:00.000Z')],
    '7d',
    Date.parse('2026-09-13T12:00:00.000Z'),
  );
  assert.equal(result, null);
});
'''

Path('src/providerReputation.ts').write_text(provider_reputation)
Path('src/routes/reputation.ts').write_text(route)
Path('test/providerReputation.test.ts').write_text(test_file)

ui_path = Path('ui/src/components/overlays/ProviderStatsOverlay.tsx')
ui = ui_path.read_text()

def replace_once(old: str, new: str):
    global ui
    count = ui.count(old)
    if count != 1:
        raise SystemExit(f'UI patch expected 1 match, found {count}: {old[:100]!r}')
    ui = ui.replace(old, new, 1)

replace_once(
"""interface ProviderSnapshot {
  summary: {
    configured: number;
    tracked: number;
    totalCheckAttempts: number;
    totalArticlesChecked: number;
    lastActivity: string | null;
    mode: 'observe-only';
  };""",
"""type TimeWindow = 'lifetime' | '24h' | '7d' | '30d';

interface ProviderSnapshot {
  summary: {
    configured: number;
    tracked: number;
    totalCheckAttempts: number;
    totalArticlesChecked: number;
    lastActivity: string | null;
    mode: 'observe-only';
    window: TimeWindow;
    historyAvailableFrom: string | null;
  };""",
)

replace_once(
"""  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);""",
"""  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('lifetime');
  const [expanded, setExpanded] = useState<string | null>(null);""",
)

replace_once(
"""    apiFetch('/api/reputation/providers')""",
"""    apiFetch(`/api/reputation/providers?window=${timeWindow}`)""",
)

replace_once(
"""  }, [apiFetch]);""",
"""  }, [apiFetch, timeWindow]);""",
)

replace_once(
"""        <div className=\"flex-1 overflow-y-auto p-4 md:p-6 space-y-6\">
          {loading ? (""",
"""        <div className=\"flex-1 overflow-y-auto p-4 md:p-6 space-y-6\">
          <div className=\"flex flex-wrap items-center gap-2\">
            <span className=\"text-[10px] uppercase tracking-wide text-slate-500\">History</span>
            {([
              ['lifetime', 'Lifetime'],
              ['24h', '24h'],
              ['7d', '7d'],
              ['30d', '30d'],
            ] as Array<[TimeWindow, string]>).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTimeWindow(key)}
                className={clsx(
                  \"text-[10px] px-2.5 py-1 rounded-full border transition-colors\",
                  timeWindow === key
                    ? \"bg-emerald-500/20 text-emerald-300 border-emerald-500/30\"
                    : \"text-slate-500 border-slate-700 hover:text-slate-300\"
                )}
              >
                {label}
              </button>
            ))}
            {timeWindow !== 'lifetime' && data?.summary.historyAvailableFrom && (
              <span className=\"text-[10px] text-slate-600\">rolling history since {new Date(data.summary.historyAvailableFrom).toLocaleString()}</span>
            )}
          </div>

          {loading ? (""",
)

replace_once(
"""              <div className=\"text-slate-300 font-medium\">No provider observations yet</div>
              <div className=\"text-xs text-slate-500 mt-2\">Leave Health Checks enabled and use UU normally. This panel fills from the article checks UU already performs.</div>""",
"""              <div className=\"text-slate-300 font-medium\">{timeWindow === 'lifetime' ? 'No provider observations yet' : `No provider observations in the last ${timeWindow}`}</div>
              <div className=\"text-xs text-slate-500 mt-2\">Leave Health Checks enabled and use UU normally. Lifetime includes existing beta.2 totals; rolling 24h/7d/30d history starts when beta.3 begins recording hourly buckets.</div>""",
)

replace_once(
"""                  <h4 className=\"text-sm font-semibold text-slate-300 flex items-center gap-2\"><TrendingUp className=\"w-4 h-4 text-emerald-400\" />Provider observations</h4>""",
"""                  <h4 className=\"text-sm font-semibold text-slate-300 flex items-center gap-2\"><TrendingUp className=\"w-4 h-4 text-emerald-400\" />Provider observations <span className=\"text-[10px] font-normal text-slate-500\">({timeWindow === 'lifetime' ? 'lifetime' : `last ${timeWindow}`})</span></h4>""",
)

replace_once(
"""                <b className=\"text-slate-400\">Observe-only:</b> these metrics do not reorder, disable, prioritise, or otherwise control providers. Coverage is simply the share of definitive article answers that were found; it is not a provider score. Pool and backup providers can see different difficulty mixes, so compare role and sample size as well as percentages.""",
"""                <b className=\"text-slate-400\">Observe-only:</b> these metrics do not reorder, disable, prioritise, or otherwise control providers. Coverage is simply the share of definitive article answers that were found; it is not a provider score. Pool and backup providers can see different difficulty mixes, so compare role and sample size as well as percentages. Rolling windows use hourly buckets retained for 31 days.""",
)

ui_path.write_text(ui)
print('provider history beta.3 patch applied')
