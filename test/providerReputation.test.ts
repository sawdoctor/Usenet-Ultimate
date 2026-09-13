import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProviderFailure,
  deriveProviderMetrics,
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

test('provider metrics expose raw reliability without inventing a magic score', () => {
  const metrics = deriveProviderMetrics(record());
  assert.equal(metrics.checkSuccessRate, 0.8);
  assert.equal(metrics.answerRate, 10 / 12);
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
