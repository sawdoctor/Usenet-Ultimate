import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { config } from '../src/config/index.js';
import { resolveEpisodeCountFromTvdb } from '../src/idResolver.js';

test('season episode names cover every episode in the season, keyed by episode number', async () => {
  // Arrange
  Object.defineProperty(config, 'searchConfig', { value: { tvdbApiKey: 'test-key' }, configurable: true });
  const originalGet = axios.get;
  const originalPost = axios.post;
  (axios as any).post = async () => ({ data: { data: { token: 'test-token' } } });
  (axios as any).get = async (url: string) => {
    if (url.includes('/search/remoteid/')) {
      return { data: { data: [{ series: { id: 77, name: 'Show Name' } }] } };
    }
    if (url.includes('/episodes/default')) {
      return {
        data: {
          data: {
            episodes: [
              { id: 1, seasonNumber: 2, number: 3, name: 'The Jacket', runtime: 22 },
              { id: 2, seasonNumber: 2, number: 12, name: 'The Busboy', runtime: 22 },
              { id: 3, seasonNumber: 3, number: 3, name: 'The Other Season', runtime: 22 },
            ],
          },
          links: {},
        },
      };
    }
    return { data: { data: [] } };
  };

  try {
    // Act
    const result = await resolveEpisodeCountFromTvdb('tt7000002', 2, 3);

    // Assert
    assert.deepEqual(result?.seasonEpisodeNames, { 3: 'The Jacket', 12: 'The Busboy' });
  } finally {
    (axios as any).get = originalGet;
    (axios as any).post = originalPost;
  }
});
