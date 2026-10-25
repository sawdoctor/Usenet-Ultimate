import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { config } from '../src/config/index.js';
import { resolveEpisodeCountFromTvdb, resolveTitleFromTvdb, resolveTitleFromTmdb, resolveRuntimeFromTmdb } from '../src/idResolver.js';

test('episode and title lookups for one series share a single TVDB search', async () => {
  // Arrange
  Object.defineProperty(config, 'searchConfig', { value: { tvdbApiKey: 'test-key' }, configurable: true });
  const originalGet = axios.get;
  const originalPost = axios.post;
  let remoteIdCalls = 0;
  (axios as any).post = async () => ({ data: { data: { token: 'test-token' } } });
  (axios as any).get = async (url: string) => {
    if (url.includes('/search/remoteid/')) {
      remoteIdCalls++;
      return { data: { data: [{ series: { id: 42, name: 'Show Name' } }] } };
    }
    return { data: { data: [] } };
  };

  try {
    // Act
    await resolveEpisodeCountFromTvdb('tt7000001', 1, 1);
    const title = await resolveTitleFromTvdb('tt7000001', 'series');

    // Assert
    assert.equal(remoteIdCalls, 1);
    assert.equal(title?.title, 'Show Name');
  } finally {
    (axios as any).get = originalGet;
    (axios as any).post = originalPost;
  }
});

test('title and runtime lookups for one movie share a single TMDB search', async () => {
  // Arrange
  Object.defineProperty(config, 'searchConfig', { value: { tmdbApiKey: 'test-key' }, configurable: true });
  const originalGet = axios.get;
  let findCalls = 0;
  (axios as any).get = async (url: string) => {
    if (url.includes('/find/')) {
      findCalls++;
      return { data: { movie_results: [{ id: 7, title: 'Movie Name', release_date: '2020-01-01' }] } };
    }
    return { data: { runtime: 120 } };
  };

  try {
    // Act
    const title = await resolveTitleFromTmdb('tt7000002', 'movie');
    const runtime = await resolveRuntimeFromTmdb('tt7000002');

    // Assert
    assert.equal(findCalls, 1);
    assert.equal(title?.title, 'Movie Name');
    assert.equal(runtime, 7200);
  } finally {
    (axios as any).get = originalGet;
  }
});
