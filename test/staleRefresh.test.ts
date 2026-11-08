import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createStremioRouter } from '../src/routes/stremio.js';
import { requestContext } from '../src/requestContext.js';
import { PREFETCH_HEADER, schedulePrefetch, scheduleRefresh } from '../src/addon/prefetch.js';
import { config, configData } from '../src/config/index.js';
import { cache } from '../src/addon/searchResultCache.js';
import addon, { buildSearchCacheKey } from '../src/addon/index.js';

const quietConsole = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => { console.log = console.warn = console.error = () => {}; });
afterEach(() => Object.assign(console, quietConsole));

const realFetch = globalThis.fetch;
const realPort = process.env.PORT;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realPort === undefined) delete process.env.PORT;
  else process.env.PORT = realPort;
});

const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise(r => setTimeout(r, 10));
};

test('a stale answer is followed by one background search of the same stream', async () => {
  // Arrange
  const calls: Array<{ id: string; background: boolean | undefined }> = [];
  const app = express();
  app.use('/:manifestKey', (req, _res, next) => requestContext.run({
    manifestKey: req.params.manifestKey, baseUrl: '', pathPrefix: '', background: req.headers[PREFETCH_HEADER] !== undefined,
  }, () => next()), createStremioRouter({
    manifest: {},
    async get(_resource, _type, id) {
      const store = requestContext.getStore()!;
      calls.push({ id, background: store.background });
      if (!store.background) store.servedStale = true;
      return { streams: [] };
    },
  }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  process.env.PORT = String(port);

  try {
    // Act
    const res = await fetch(`http://127.0.0.1:${port}/KEY/stream/movie/tt0000020.json`);
    await res.arrayBuffer();
    await until(() => calls.length >= 2);

    // Assert
    assert.deepEqual(calls, [
      { id: 'tt0000020', background: false },
      { id: 'tt0000020', background: true },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('a stream opened twice while stale is refreshed once', async () => {
  // Arrange
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => { urls.push(url); return new Response('{}'); }) as typeof fetch;
  const url = 'http://127.0.0.1:1337/k/stream/movie/tt0000021.json';

  // Act
  scheduleRefresh(url);
  scheduleRefresh(url);
  await until(() => urls.length >= 1);
  await new Promise(r => setTimeout(r, 50));

  // Assert
  assert.deepEqual(urls, [url]);
});

test('a refresh runs before prefetches that were queued earlier', async () => {
  // Arrange
  configData.cacheEnabled = true;
  configData.cacheTTL = 9000;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    await new Promise(r => setTimeout(r, 10));
    return new Response('{}');
  }) as typeof fetch;
  const at = (n: number) => `http://127.0.0.1:1337/k/stream/series/tt0000022:1:${n}.json`;

  // Act
  schedulePrefetch(at(1));
  schedulePrefetch(at(2));
  schedulePrefetch(at(3));
  scheduleRefresh(at(9));
  await until(() => urls.length >= 4);

  // Assert
  assert.deepEqual(urls, [at(1), at(9), at(2), at(3)]);
});

test('the handler marks a stale cache hit for a refresh and serves a fresh one as is', async () => {
  // Arrange
  configData.cacheEnabled = true;
  configData.cacheTTL = 4 * 60 * 60;
  configData.indexManager = 'newznab';
  configData.indexers = [];
  const seed = (id: string, ageHours: number) => cache.set(buildSearchCacheKey('k', 'series', id, config), {
    rawResults: [], deprioritizedPacks: [], healthMap: {},
    _meta: { type: 'series', season: 1, episode: 1, cachedAt: Date.now() - ageHours * 60 * 60 * 1000, releasedAt: '1992-08-19' },
  }, 24 * 60 * 60);
  seed('tt0000041:1:1', 5);
  seed('tt0000042:1:1', 1);
  const open = async (id: string) => {
    const store = { manifestKey: 'k', baseUrl: '', pathPrefix: '' } as { manifestKey: string; baseUrl: string; pathPrefix: string; servedStale?: boolean };
    const payload = await requestContext.run(store, () => addon.get('stream', 'series', id));
    return { payload, servedStale: store.servedStale };
  };

  // Act
  const stale = await open('tt0000041:1:1');
  const fresh = await open('tt0000042:1:1');

  // Assert
  assert.deepEqual(stale, { payload: { streams: [] }, servedStale: true });
  assert.deepEqual(fresh, { payload: { streams: [] }, servedStale: undefined });
});
