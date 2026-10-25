import test from 'node:test';
import assert from 'node:assert/strict';
import { configData } from '../src/config/index.js';
import { cachedSearch, searchCacheKey } from '../src/parsers/searchCache.js';
import type { NZBSearchResult } from '../src/types.js';

const result = (title: string) => ({ title, link: `https://example.invalid/${title}.nzb` }) as NZBSearchResult;

test('the same season-pack search is served from the cache for later episodes', async () => {
  // Arrange
  configData.cacheEnabled = true;
  configData.cacheTTL = 9000;
  let calls = 0;
  const search = async () => { calls++; return [result('Show.S01.1080p')]; };
  const key = searchCacheKey('idx', 'https://idx.example', 'Show S01', '5000', 3);

  // Act
  await cachedSearch(key, search);
  const again = await cachedSearch(key, search);

  // Assert
  assert.equal(calls, 1);
  assert.equal(again[0].title, 'Show.S01.1080p');
});

test('an empty search is not cached, so the next call retries it', async () => {
  // Arrange
  configData.cacheEnabled = true;
  configData.cacheTTL = 9000;
  let calls = 0;
  const search = async () => { calls++; return []; };
  const key = searchCacheKey('idx', 'https://idx.example', 'Empty S01', '5000', 3);

  // Act
  await cachedSearch(key, search);
  await cachedSearch(key, search);

  // Assert
  assert.equal(calls, 2);
});

test('the cache key hides the indexer API key', () => {
  // Arrange
  const url = 'https://idx.example/api?apikey=SECRET-VALUE';

  // Act
  const key = searchCacheKey('idx', url, 'Show S01', '5000', 3);

  // Assert
  assert.equal(key.includes('SECRET-VALUE'), false);
});

test('different pagination gives a different cache key', () => {
  // Arrange
  const url = 'https://idx.example/api';

  // Act
  const short = searchCacheKey('idx', url, 'Show S01', '5000', 1);
  const deep = searchCacheKey('idx', url, 'Show S01', '5000', 5);

  // Assert
  assert.notEqual(short, deep);
});
