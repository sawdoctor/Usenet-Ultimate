/**
 * Local NNTP Provider Reputation
 *
 * Observes the provider checks UU already performs and records provider-local
 * evidence without changing provider order, priority, enablement, or health
 * verdicts.  This deliberately lives separately from release/indexer
 * reputation so v1.9 can learn from real traffic before any ranking policy is
 * introduced.
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

const SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 2_000;

export type ProviderFailureBucket = 'auth' | 'tls' | 'timeout' | 'connection' | 'other';

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

interface ProviderReputationData {
  schemaVersion: number;
  providers: Record<string, ProviderReputationRecord>;
}

export interface ProviderDerivedMetrics {
  /** Provider checks that completed / all provider check attempts. */
  checkSuccessRate: number | null;
  /** Articles that received a definitive 223/430 answer / all sampled articles. */
  answerRate: number | null;
  /** 223 answers / definitive 223+430 answers. This is coverage, not a quality score. */
  coverageRate: number | null;
  averageLatencyMs: number | null;
  /** 0..1 indication of how much evidence has accumulated. Not a reputation score. */
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

function emptyRecord(provider: Pick<UsenetProvider, 'id' | 'name' | 'type'>): ProviderReputationRecord {
  const at = now();
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

function loadData(): ProviderReputationData {
  try {
    if (!fs.existsSync(PROVIDER_REPUTATION_FILE)) {
      return { schemaVersion: SCHEMA_VERSION, providers: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(PROVIDER_REPUTATION_FILE, 'utf-8')) as Partial<ProviderReputationData>;
    const providers: Record<string, ProviderReputationRecord> = {};
    for (const [id, raw] of Object.entries(parsed.providers || {})) {
      providers[id] = normalizeRecord(raw, id);
    }
    return { schemaVersion: SCHEMA_VERSION, providers };
  } catch (err) {
    console.error('📡 Provider reputation: error loading file:', err);
    return { schemaVersion: SCHEMA_VERSION, providers: {} };
  }
}

let data = loadData();
let saveTimer: NodeJS.Timeout | null = null;

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(PROVIDER_REPUTATION_FILE), { recursive: true });
      fs.writeFileSync(PROVIDER_REPUTATION_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('📡 Provider reputation: error saving file:', err);
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

function recordFor(provider: Pick<UsenetProvider, 'id' | 'name' | 'type'>): ProviderReputationRecord {
  const existing = data.providers[provider.id];
  if (!existing) {
    data.providers[provider.id] = emptyRecord(provider);
  }
  const rec = data.providers[provider.id];
  // Provider UUID is stable, but name/type are editable. Keep display metadata current.
  rec.name = provider.name;
  rec.type = provider.type;
  rec.lastSeen = now();
  return rec;
}

function roundedRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/**
 * Derived metrics intentionally avoid one magic provider score in phase 1.
 * Pool and backup providers see different difficulty mixes, so a single score
 * before observing real distributions would imply precision we do not have.
 */
export function deriveProviderMetrics(record: ProviderReputationRecord | null | undefined): ProviderDerivedMetrics {
  if (!record) {
    return {
      checkSuccessRate: null,
      answerRate: null,
      coverageRate: null,
      averageLatencyMs: null,
      confidence: 0,
    };
  }
  const attempts = record.successfulChecks + record.failedChecks;
  const definitive = record.found + record.missing;
  // Confidence rises with both completed checks and sampled articles, capped at 1.
  // It is deliberately descriptive only; it does not change runtime behaviour.
  const evidence = attempts * 3 + record.articlesChecked;
  return {
    checkSuccessRate: roundedRate(record.successfulChecks, attempts),
    answerRate: roundedRate(definitive, record.articlesChecked),
    coverageRate: roundedRate(record.found, definitive),
    averageLatencyMs: record.latencySamples > 0
      ? Math.round(record.latencyMsTotal / record.latencySamples)
      : null,
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

export function recordProviderCheck(
  provider: Pick<UsenetProvider, 'id' | 'name' | 'type'>,
  observation: {
    found: number;
    missing: number;
    unknown: number;
    latencyMs: number;
    backupSaves?: number;
  },
): void {
  const rec = recordFor(provider);
  rec.successfulChecks++;
  rec.found += Math.max(0, finite(observation.found));
  rec.missing += Math.max(0, finite(observation.missing));
  rec.unknown += Math.max(0, finite(observation.unknown));
  rec.articlesChecked += Math.max(0, finite(observation.found) + finite(observation.missing) + finite(observation.unknown));
  rec.backupSaves += Math.max(0, finite(observation.backupSaves));
  const latency = Math.max(0, finite(observation.latencyMs));
  rec.latencyMsTotal += latency;
  rec.latencySamples++;
  rec.lastLatencyMs = Math.round(latency);
  scheduleSave();
}

export function recordProviderFailure(
  provider: Pick<UsenetProvider, 'id' | 'name' | 'type'>,
  error: unknown,
  latencyMs: number,
): void {
  const rec = recordFor(provider);
  rec.failedChecks++;
  const bucket = classifyProviderFailure(error);
  if (bucket === 'auth') rec.authFailures++;
  else if (bucket === 'tls') rec.tlsFailures++;
  else if (bucket === 'timeout') rec.timeoutFailures++;
  else if (bucket === 'connection') rec.connectionFailures++;
  else rec.otherFailures++;
  const latency = Math.max(0, finite(latencyMs));
  rec.latencyMsTotal += latency;
  rec.latencySamples++;
  rec.lastLatencyMs = Math.round(latency);
  rec.lastError = String((error as any)?.message || error || 'Provider check failed').slice(0, 240);
  rec.lastErrorAt = now();
  scheduleSave();
}

export function getProviderReputationData(configuredProviders: UsenetProvider[]): ProviderReputationSnapshot {
  const configuredIds = new Set(configuredProviders.map(p => p.id));
  const providers: ProviderReputationView[] = configuredProviders.map(provider => {
    const rec = data.providers[provider.id] || null;
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
    .map(rec => ({ ...rec, metrics: deriveProviderMetrics(rec) }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

  const records = Object.values(data.providers);
  return {
    summary: {
      configured: configuredProviders.length,
      tracked: records.length,
      totalCheckAttempts: records.reduce((sum, r) => sum + r.successfulChecks + r.failedChecks, 0),
      totalArticlesChecked: records.reduce((sum, r) => sum + r.articlesChecked, 0),
      lastActivity: records.length > 0
        ? records.reduce((latest, r) => r.lastSeen > latest ? r.lastSeen : latest, records[0].lastSeen)
        : null,
      mode: 'observe-only',
    },
    providers,
    retired,
  };
}
