import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { config } from '../src/config/index.js';
import { resolveEpisodeCountFromTvdb, resolveTitleFromTvdb } from '../src/idResolver.js';

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
