import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { configData } from '../src/config/index.js';
import { noteIndexerResponse, rateLimitBackoffMs, rateLimitedUntil } from '../src/parsers/indexerBackoff.js';
import { UsenetSearcher } from '../src/parsers/usenetSearcher.js';
import { indexManagerSearch } from '../src/addon/searchOrchestrator.js';

const quietConsole = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => { console.log = console.warn = console.error = () => {}; });
afterEach(() => Object.assign(console, quietConsole));

async function withIndexer(status: number, body: string, fn: (url: string, requests: () => number) => Promise<void>) {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.writeHead(status, { 'Content-Type': 'application/xml' }); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}/api`, () => requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

test('a 429 from an indexer search starts its backoff', async () => {
  await withIndexer(429, ALTHUB_429, async url => {
    // Arrange
    const searcher = new UsenetSearcher({ name: 'Searcher-429', url, apiKey: 'k', enabled: true });

    // Act
    const results = await searcher.searchLive('Show S01E01');

    // Assert
    assert.deepEqual(results, []);
    const until = rateLimitedUntil('Searcher-429');
    assert.ok(until && until - Date.now() > 174 * MINUTE);
  });
});

test('a normal search response leaves the indexer searchable', async () => {
  await withIndexer(200, '<rss><channel></channel></rss>', async url => {
    // Arrange
    const searcher = new UsenetSearcher({ name: 'Searcher-200', url, apiKey: 'k', enabled: true });

    // Act
    await searcher.searchLive('Show S01E01');

    // Assert
    assert.equal(rateLimitedUntil('Searcher-200'), undefined);
  });
});

test('fallback queries skip an indexer that just returned 429', async () => {
  await withIndexer(429, ALTHUB_429, async (url, requests) => {
    // Arrange
    configData.indexManager = 'newznab';
    configData.indexers = [{ name: 'Fallback-429', url, apiKey: 'k', enabled: true, tvSearchMethod: ['text'] }];
    configData.searchConfig = { includeSeasonPacks: false, includeMultiSeasonPacks: false } as typeof configData.searchConfig;

    // Act
    const results = await indexManagerSearch({ type: 'series', imdbId: 'tt0000031', title: 'Some Show', season: 2, episode: 3, isAnime: false });

    // Assert
    assert.deepEqual(results, []);
    assert.equal(requests(), 1);
  });
});

test('an alternate title that hits a 429 stops the next alternate from querying that indexer', async () => {
  // Arrange
  const queries: string[] = [];
  const server = http.createServer((req, res) => {
    const q = new URL(req.url!, 'http://x').searchParams.get('q') ?? '';
    queries.push(q);
    const limited = q.startsWith('Alt One');
    res.writeHead(limited ? 429 : 200, { 'Content-Type': 'application/xml' });
    res.end(limited ? ALTHUB_429 : '<rss><channel></channel></rss>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  configData.indexManager = 'newznab';
  configData.indexers = [{ name: 'AltTitle-429', url: `http://127.0.0.1:${port}/api`, apiKey: 'k', enabled: true, tvSearchMethod: ['text'] }];
  configData.searchConfig = { includeSeasonPacks: false, includeMultiSeasonPacks: false, absoluteEpisodeFallback: false } as typeof configData.searchConfig;

  try {
    // Act
    await indexManagerSearch({ type: 'series', imdbId: 'tt0000032', title: 'Main Title', additionalTitles: ['Alt One', 'Alt Two'], season: 1, episode: 2, isAnime: false });

    // Assert
    assert.deepEqual(queries.map(q => q.split(' ').slice(0, 2).join(' ')), ['Main Title', 'Alt One']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('a rate-limited indexer is not queried by the next search', async () => {
  await withIndexer(200, '<rss><channel></channel></rss>', async (url, requests) => {
    // Arrange
    noteIndexerResponse('Orchestrated-429', 429, ALTHUB_429, undefined);
    configData.indexManager = 'newznab';
    configData.indexers = [{ name: 'Orchestrated-429', url, apiKey: 'k', enabled: true, movieSearchMethod: ['text'] }];

    // Act
    const results = await indexManagerSearch({ type: 'movie', imdbId: 'tt0000030', title: 'Some Movie', year: '2020', isAnime: false });

    // Assert
    assert.deepEqual(results, []);
    assert.equal(requests(), 0);
  });
});

const MINUTE = 60 * 1000;
const ALTHUB_429 = '<?xml version="1.0" encoding="UTF-8"?>\n<error code="500" description="Request limit reached. Retry in 175 minutes."/>';

test('a 429 waits as long as the indexer says', () => {
  // Act & Assert
  assert.equal(rateLimitBackoffMs(429, ALTHUB_429, undefined), 175 * MINUTE);
  assert.equal(rateLimitBackoffMs(429, '', '120'), 2 * MINUTE);
  assert.equal(rateLimitBackoffMs(429, '', undefined), 10 * MINUTE);
});

test('a limit error sent with HTTP 200 also counts', () => {
  // Act & Assert
  assert.equal(rateLimitBackoffMs(200, '<error code="429" description="API limit reached. Retry in 2 hours"/>', undefined), 120 * MINUTE);
});

test('other responses and errors do not back off', () => {
  // Act & Assert
  assert.equal(rateLimitBackoffMs(200, '<rss><channel></channel></rss>', undefined), undefined);
  assert.equal(rateLimitBackoffMs(500, '<error code="300" description="Incorrect parameter"/>', undefined), undefined);
  assert.equal(rateLimitBackoffMs(undefined, undefined, undefined), undefined);
});

test('a backoff never exceeds a day', () => {
  // Act & Assert
  assert.equal(rateLimitBackoffMs(429, 'Retry in 90 hours', undefined), 24 * 60 * MINUTE);
});

test('a rate-limited indexer is skipped until its retry time', () => {
  // Arrange
  const now = Date.parse('2026-10-31T20:00:00Z');

  // Act
  noteIndexerResponse('altHUB-test', 429, ALTHUB_429, undefined, now);

  // Assert
  assert.equal(rateLimitedUntil('altHUB-test', now + 174 * MINUTE), now + 175 * MINUTE);
  assert.equal(rateLimitedUntil('altHUB-test', now + 175 * MINUTE), undefined);
  assert.equal(rateLimitedUntil('NZBGeek-test', now), undefined);
});
