import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { configData } from '../src/config/index.js';
import { buildStreams } from '../src/addon/streamBuilder.js';
import { buildEconomyTile } from '../src/addon/economyTile.js';
import { decodeTileEnvelope } from '../src/nzbdav/redirectHelpers.js';
import { ECONOMY_SESSION_SUFFIX, ECONOMY_TILE_NAME, UF_TILE_BASE_NAME } from '../src/addon/ufTile.js';
import { resetBandwidthState } from '../src/nzbdav/bandwidth.js';

const saved = { ...configData } as Record<string, unknown>;

beforeEach(() => {
  resetBandwidthState();
  (configData as Record<string, unknown>).streamingMode = 'nzbdav';
});

afterEach(() => {
  for (const key of ['streamingMode', 'ultimateFallback', 'economyFallback']) {
    (configData as Record<string, unknown>)[key] = saved[key];
  }
});

const build = () => buildStreams({
  allResults: [{ title: 'Show.S01E01.1080p.WEB-DL', link: 'https://idx.invalid/a.nzb', size: 2e9, indexerName: 'idx', age: 1, isSeasonPack: false }],
  healthResults: new Map(),
  type: 'series',
  imdbId: 'tt0000001',
  season: 1,
  episode: 1,
  now: Date.now(),
  runtime: 1320,
} as Parameters<typeof buildStreams>[0]).streams.map(s => s.name ?? '');

test('the Economy tile shows when Ultimate Fallback is off', () => {
  // Arrange
  (configData as Record<string, unknown>).ultimateFallback = { enabled: false };
  (configData as Record<string, unknown>).economyFallback = { enabled: true, speedOverrideMbps: 50 };

  // Act
  const names = build();

  // Assert
  assert.ok(names[0].startsWith(ECONOMY_TILE_NAME));
  assert.ok(!names.some(n => n.startsWith(UF_TILE_BASE_NAME)));
});

test('with both enabled the Economy tile sits right under the Ultimate Fallback tile', () => {
  // Arrange
  (configData as Record<string, unknown>).ultimateFallback = { enabled: true };
  (configData as Record<string, unknown>).economyFallback = { enabled: true, speedOverrideMbps: 50 };

  // Act
  const names = build();

  // Assert
  assert.ok(names[0].startsWith(UF_TILE_BASE_NAME));
  assert.ok(names[1].startsWith(ECONOMY_TILE_NAME));
});

test('with Economy off there is no Economy tile', () => {
  // Arrange
  (configData as Record<string, unknown>).ultimateFallback = { enabled: true };
  (configData as Record<string, unknown>).economyFallback = { enabled: false };

  // Act
  const names = build();

  // Assert
  assert.ok(!names.some(n => n.startsWith(ECONOMY_TILE_NAME)));
});

test('the Economy tile URL carries its session key and group in one envelope', () => {
  // Arrange
  const input = { sessionKey: 'm:series:tt1:1:1', fallbackGroupId: 'abc123', streamBase: 'https://x.invalid/k/nzbdav/stream', bingeGroup: 'djstreams', speedOverrideMbps: 40 };

  // Act
  const tile = buildEconomyTile(input);

  // Assert
  const url = new URL(tile.url!);
  assert.equal(url.pathname, '/k/nzbdav/stream/economy-fallback');
  assert.equal(url.search.includes('&'), false);
  assert.deepEqual(decodeTileEnvelope(url.searchParams.get('t')!), { sk: `m:series:tt1:1:1${ECONOMY_SESSION_SUFFIX}`, fbg: 'abc123' });
  assert.equal(tile.behaviorHints?.bingeGroup, 'djstreams:economy');
});
