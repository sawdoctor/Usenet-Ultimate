import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createStremioRouter, type StremioAddonInterface } from '../src/routes/stremio.js';

async function withServer(addon: StremioAddonInterface, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use(createStremioRouter(addon));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

function fakeAddon(get: StremioAddonInterface['get']): StremioAddonInterface {
  return { manifest: { resources: ['stream'] }, get };
}

test('Stremio movie route preserves type and id', async () => {
  let seen: any;
  await withServer(fakeAddon(async (...args) => {
    seen = args;
    return { streams: [{ name: 'ok' }] };
  }), async base => {
    const res = await fetch(`${base}/stream/movie/tt1234567.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await res.json(), { streams: [{ name: 'ok' }] });
  });
  assert.equal(seen[0], 'stream');
  assert.equal(seen[1], 'movie');
  assert.equal(seen[2], 'tt1234567');
  assert.deepEqual(seen[3], {});
});

test('Stremio series route preserves colon-delimited season and episode id', async () => {
  let id = '';
  await withServer(fakeAddon(async (_resource, _type, value) => {
    id = value;
    return { streams: [] };
  }), async base => {
    const res = await fetch(`${base}/stream/series/tt7654321:2:7.json`);
    assert.equal(res.status, 200);
  });
  assert.equal(id, 'tt7654321:2:7');
});

test('Stremio extra segment preserves encoded ampersands inside values', async () => {
  let extra: Record<string, unknown> = {};
  await withServer(fakeAddon(async (_resource, _type, _id, value) => {
    extra = value || {};
    return { streams: [] };
  }), async base => {
    const res = await fetch(`${base}/stream/movie/tt1/foo=a%26b&bar=c.json`);
    assert.equal(res.status, 200);
  });
  assert.deepEqual({ ...extra }, { foo: 'a&b', bar: 'c' });
});

test('Stremio response carries SDK-compatible cache headers', async () => {
  await withServer(fakeAddon(async () => ({
    streams: [], cacheMaxAge: 60, staleRevalidate: 120, staleError: 300,
  })), async base => {
    const res = await fetch(`${base}/stream/movie/tt1.json`);
    assert.equal(res.headers.get('cache-control'), 'max-age=60, stale-while-revalidate=120, stale-if-error=300, public');
  });
});

test('Stremio redirect response uses HTTP 307', async () => {
  await withServer(fakeAddon(async () => ({ redirect: 'https://example.com/video' })), async base => {
    const res = await fetch(`${base}/stream/movie/tt1.json`, { redirect: 'manual' });
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), 'https://example.com/video');
  });
});

test('Stremio handler failures return JSON 500', async () => {
  await withServer(fakeAddon(async () => { throw new Error('test failure'); }), async base => {
    const res = await fetch(`${base}/stream/movie/tt1.json`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { err: 'handler error' });
  });
});
