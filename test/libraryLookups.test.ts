import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { markLibraryHits, pickLibraryLookups } from '../src/addon/libraryMarking.js';
import type { NZBDavConfig } from '../src/nzbdav/types.js';

test('a folder listing started before the search is used instead of listing again', async () => {
  // Arrange
  let webdavRequests = 0;
  const server = http.createServer((_req, res) => { webdavRequests++; res.statusCode = 404; res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const nzbdav: NZBDavConfig = {
    url: `http://127.0.0.1:${port}`, apiKey: '', webdavUrl: `http://127.0.0.1:${port}`, webdavUser: 'u', webdavPassword: 'p',
    moviesCategory: 'movies', tvCategory: 'tv', scanUncategorized: false,
  };
  const results = [{ title: 'Movie.2020.1080p', link: 'https://example.invalid/1.nzb' }];

  try {
    // Act
    const hits = await markLibraryHits(results, new Map(), nzbdav, undefined, 'movie', undefined, undefined, Promise.resolve(new Set<string>()));
    const requestsWithListing = webdavRequests;
    await markLibraryHits(results, new Map(), nzbdav, undefined, 'movie', undefined);

    // Assert
    assert.equal(hits, 0);
    assert.equal(requestsWithListing, 0);
    assert.ok(webdavRequests > 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('only results with a library folder need a lookup', () => {
  // Arrange
  const results = [{ title: 'Show.S01E01' }, { title: 'Show.S01E02' }, { title: 'Other.S01E01' }];
  const folders = new Set(['Show.S01E02']);

  // Act
  const lookups = pickLibraryLookups(results, folders);

  // Assert
  assert.deepEqual(lookups, [{ title: 'Show.S01E02' }]);
});

test('an unknown folder listing keeps every result', () => {
  // Arrange
  const results = [{ title: 'Show.S01E01' }, { title: 'Show.S01E02' }];

  // Act
  const lookups = pickLibraryLookups(results, undefined);

  // Assert
  assert.deepEqual(lookups, results);
});

test('an empty folder listing skips every lookup', () => {
  // Arrange
  const results = [{ title: 'Show.S01E01' }];

  // Act
  const lookups = pickLibraryLookups(results, new Set());

  // Assert
  assert.deepEqual(lookups, []);
});
