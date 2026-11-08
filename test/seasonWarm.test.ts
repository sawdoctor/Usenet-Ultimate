import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configData, config } from '../src/config/index.js';
import { cache } from '../src/addon/searchResultCache.js';
import { buildSearchCacheKey } from '../src/addon/index.js';
import { PREFETCH_HEADER, seasonWarmUrls, warmSeason } from '../src/addon/prefetch.js';

const BASE = 'http://127.0.0.1:1337';
const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

const episodeOf = (url: string) => Number(url.match(/:(\d+)\.json$/)![1]);

test('every other episode is queued, later ones first', () => {
  // Act
  const urls = seasonWarmUrls(BASE, '/stremio', 'k', 'tt0000001:3:4', 6);

  // Assert
  assert.deepEqual(urls.map(episodeOf), [5, 6, 1, 2, 3]);
  assert.equal(urls[0], `${BASE}/stremio/k/stream/series/tt0000001:3:5.json`);
});

test('the first and last episodes of a season queue the rest in order', () => {
  // Act & Assert
  assert.deepEqual(seasonWarmUrls(BASE, '', 'k', 'tt0000001:1:1', 4).map(episodeOf), [2, 3, 4]);
  assert.deepEqual(seasonWarmUrls(BASE, '', 'k', 'tt0000001:1:4', 4).map(episodeOf), [1, 2, 3]);
});

test('ids that are not series episodes, and one-episode seasons, queue nothing', () => {
  // Act & Assert
  assert.deepEqual(seasonWarmUrls(BASE, '', 'k', 'tt0000001', 10), []);
  assert.deepEqual(seasonWarmUrls(BASE, '', 'k', 'tt0000001:1:1', 1), []);
});

test('very long seasons are capped', () => {
  // Act
  const urls = seasonWarmUrls(BASE, '', 'k', 'tt0000001:1:1', 500);

  // Assert
  assert.equal(urls.length, 59);
});

const seed = (id: string, episodesInSeason: number | undefined) => {
  configData.cacheEnabled = true;
  configData.cacheTTL = 9000;
  cache.set(buildSearchCacheKey('k', 'series', id, config), {
    rawResults: [], deprioritizedPacks: [], healthMap: {},
    _meta: { type: 'series', season: 1, episode: 1, episodesInSeason },
  }, 9000);
};

const captureFetches = () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>)[PREFETCH_HEADER], '1');
    urls.push(url);
    return new Response('{}');
  }) as typeof fetch;
  return urls;
};

const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise(r => setTimeout(r, 10));
};

test('warming a season searches its other episodes in the background, once', async () => {
  // Arrange
  seed('tt0000010:1:2', 4);
  const urls = captureFetches();

  // Act
  warmSeason(BASE, '', 'k', 'series', 'tt0000010:1:2');
  warmSeason(BASE, '', 'k', 'series', 'tt0000010:1:3');
  await until(() => urls.length >= 3);
  await new Promise(r => setTimeout(r, 50));

  // Assert
  assert.deepEqual(urls.map(episodeOf), [3, 4, 1]);
});

test('nothing is warmed when the season size is unknown or the cache is off', async () => {
  // Arrange
  seed('tt0000011:1:1', undefined);
  const urls = captureFetches();

  // Act
  warmSeason(BASE, '', 'k', 'series', 'tt0000011:1:1');
  seed('tt0000012:1:1', 3);
  configData.cacheEnabled = false;
  warmSeason(BASE, '', 'k', 'series', 'tt0000012:1:1');
  await new Promise(r => setTimeout(r, 50));

  // Assert
  assert.deepEqual(urls, []);
});
