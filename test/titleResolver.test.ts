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

test('the release date comes from the Cinemeta episode, or the movie, when TVDB has none', async () => {
  // Arrange
  Object.defineProperty(config, 'searchConfig', { value: {}, configurable: true });
  const originalGet = axios.get;
  (axios as any).get = async (url: string) => {
    if (url.includes('/meta/series/')) {
      return { data: { meta: { name: 'Dated Show', videos: [
        { season: 1, episode: 1, released: '2020-01-01T00:00:00.000Z' },
        { season: 1, episode: 2, released: '2020-01-08T00:00:00.000Z' },
      ] } } };
    }
    if (url.includes('/meta/movie/')) return { data: { meta: { name: 'Dated Movie', released: '2021-05-05T00:00:00.000Z' } } };
    return { data: {} };
  };

  try {
    // Act
    const episode = await resolveTitle('series', 'tt7000004', 1, 2);
    const movie = await resolveTitle('movie', 'tt7000005');

    // Assert
    assert.equal(episode.releaseDate, '2020-01-08T00:00:00.000Z');
    assert.equal(movie.releaseDate, '2021-05-05T00:00:00.000Z');
  } finally {
    (axios as any).get = originalGet;
  }
});
