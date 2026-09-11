from pathlib import Path

# 1. Replace addonBuilder with UU's tiny internal stream interface.
p = Path('src/addon/index.ts')
s = p.read_text()
s = s.replace("import { addonBuilder } from 'stremio-addon-sdk';\n", "", 1)
s = s.replace("const builder = addonBuilder(manifest);\n", "", 1)
old_open = "builder.defineStreamHandler(async ({ type, id }) => {"
new_open = "const streamHandler = async ({ type, id }: { type: string; id: string }) => {"
assert old_open in s, 'stream handler opening marker not found'
s = s.replace(old_open, new_open, 1)
old_tail = "});\n\nexport { manifest as addonManifest };\nexport default builder.getInterface();"
new_tail = "};\n\nconst addon = {\n  manifest,\n  async get(resource: string, type: string, id: string, _extra: Record<string, unknown> = {}, _config: Record<string, unknown> = {}) {\n    if (resource !== 'stream') {\n      return Promise.reject({ message: `No handler for ${resource}`, noHandler: true });\n    }\n    return streamHandler({ type, id });\n  },\n};\n\nexport { manifest as addonManifest };\nexport default addon;"
assert old_tail in s, 'addon export tail marker not found'
s = s.replace(old_tail, new_tail, 1)
p.write_text(s)

# 2. Add a small Express router that implements the Stremio subset UU actually uses.
router = Path('src/routes/stremio.ts')
assert not router.exists(), 'stremio router already exists'
router.write_text(r'''import { Router, type Request, type Response, type NextFunction } from 'express';
import { parse as parseQueryString } from 'node:querystring';

export interface StremioAddonInterface {
  manifest: Record<string, unknown>;
  get(
    resource: string,
    type: string,
    id: string,
    extra?: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<any>;
}

function parseExtra(req: Request): Record<string, unknown> {
  const pathname = req.url.split('?', 1)[0] || '';
  const lastSegment = pathname.split('/').pop() || '';
  if (!lastSegment.endsWith('.json')) return {};
  const raw = lastSegment.slice(0, -'.json'.length);
  if (!raw || !raw.includes('=')) return {};
  return parseQueryString(raw) as Record<string, unknown>;
}

function applyCacheHeaders(res: Response, payload: any): void {
  const parts: string[] = [];
  const candidates: Array<[string, unknown]> = [
    ['max-age', payload?.cacheMaxAge],
    ['stale-while-revalidate', payload?.staleRevalidate],
    ['stale-if-error', payload?.staleError],
  ];
  for (const [name, value] of candidates) {
    if (Number.isInteger(value)) parts.push(`${name}=${value}`);
  }
  if (parts.length) res.setHeader('Cache-Control', `${parts.join(', ')}, public`);
}

export function createStremioRouter(addon: StremioAddonInterface): Router {
  const router = Router();

  const streamHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = await addon.get('stream', req.params.type, req.params.id, parseExtra(req), {});
      applyCacheHeaders(res, payload);
      if (payload?.redirect) return res.redirect(307, payload.redirect);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(payload));
    } catch (err: any) {
      if (err?.noHandler) return next();
      console.error(err);
      res.status(500).type('application/json').end(JSON.stringify({ err: 'handler error' }));
    }
  };

  // UU declares only the Stremio `stream` resource. Keep the two route shapes
  // explicit rather than using an optional path token, which avoids the old
  // stremio-addon-sdk/router/path-to-regexp dependency chain entirely.
  router.get('/stream/:type/:id.json', streamHandler);
  router.get('/stream/:type/:id/:extra.json', streamHandler);

  return router;
}
''')

# 3. Wire server.ts to the internal router.
p = Path('src/server.ts')
s = p.read_text()
s = s.replace("import addonSDK from 'stremio-addon-sdk';\n", "", 1)
anchor = "import { createNewznabRoutes } from './routes/newznab.js';\n"
assert anchor in s, 'server route import marker not found'
s = s.replace(anchor, anchor + "import { createStremioRouter } from './routes/stremio.js';\n", 1)
s = s.replace("const { getRouter } = addonSDK;\n", "", 1)
old_mount = "stremioRouter.use(getRouter(addon));"
assert old_mount in s, 'SDK router mount marker not found'
s = s.replace(old_mount, "stremioRouter.use(createStremioRouter(addon));", 1)
p.write_text(s)

# 4. Add permanent contract tests for the Stremio subset UU supports.
t = Path('test/stremioRouter.test.ts')
assert not t.exists(), 'Stremio router tests already exist'
t.write_text(r'''import test from 'node:test';
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
  assert.deepEqual(extra, { foo: 'a&b', bar: 'c' });
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
''')
