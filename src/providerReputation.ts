/**
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
