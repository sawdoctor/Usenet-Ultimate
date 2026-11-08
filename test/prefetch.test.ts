import test from 'node:test';
import assert from 'node:assert/strict';
import { nextEpisodeUrl } from '../src/addon/prefetch.js';

test('next episode URL keeps the manifest key and path prefix', () => {
  // Arrange
  const id = 'tt0903747:1:2';

  // Act
  const url = nextEpisodeUrl('http://127.0.0.1:1338', '/stremio', 'KEY', id);

  // Assert
  assert.equal(url, 'http://127.0.0.1:1338/stremio/KEY/stream/series/tt0903747:1:3.json');
});

test('legacy root routes get a URL without a prefix', () => {
  // Arrange
  const id = 'tt0903747:2:9';

  // Act
  const url = nextEpisodeUrl('http://127.0.0.1:1337', '', 'KEY', id);

  // Assert
  assert.equal(url, 'http://127.0.0.1:1337/KEY/stream/series/tt0903747:2:10.json');
});

test('non-IMDb ids get no prefetch', () => {
  // Arrange
  const id = 'kitsu:123:4';

  // Act
  const url = nextEpisodeUrl('http://127.0.0.1:1337', '', 'KEY', id);

  // Assert
  assert.equal(url, undefined);
});

test('movie ids get no prefetch', () => {
  // Arrange
  const id = 'tt0111161';

  // Act
  const url = nextEpisodeUrl('http://127.0.0.1:1337', '', 'KEY', id);

  // Assert
  assert.equal(url, undefined);
});
