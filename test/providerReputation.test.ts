import test from 'node:test';
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
