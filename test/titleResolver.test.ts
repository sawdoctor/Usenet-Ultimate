import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { config } from '../src/config/index.js';
import { resolveTitle } from '../src/addon/titleResolver.js';

test('series without a TVDB match keeps the Cinemeta title and season episode count', async () => {
  // Arrange
  Object.defineProperty(config, 'searchConfig', { value: { tvdbApiKey: 'test-key' }, configurable: true });
  const originalGet = axios.get;
  const originalPost = axios.post;
  (axios as any).post = async () => ({ data: { data: { token: 'test-token' } } });
  (axios as any).get = async (url: string) => {
    if (url.includes('v3-cinemeta')) {
      return { data: { meta: { name: 'Show Name', releaseInfo: '2020', videos: [{ season: 1 }, { season: 1 }, { season: 2 }] } } };
    }
    if (url.includes('/search/remoteid/')) return { data: { data: [] } };
    return { data: {} };
  };

  try {
    // Act
    const info = await resolveTitle('series', 'tt7000003', 1, 1);

    // Assert
    assert.equal(info.cinemetaTitle, 'Show Name');
    assert.equal(info.title, 'Show Name');
    assert.equal(info.episodesInSeason, 2);
  } finally {
    (axios as any).get = originalGet;
    (axios as any).post = originalPost;
  }
});
