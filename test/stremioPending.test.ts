import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrCreateStream, getStreamCache, setPrepareFn } from '../src/nzbdav/streamCache.js';
import type { StreamData } from '../src/nzbdav/types.js';

test('in-flight Stremio preparation remains single-flight beyond the old pending TTL', async () => {
  getStreamCache().clear();

  let calls = 0;
  let resolvePreparation!: (value: StreamData) => void;
  const preparation = new Promise<StreamData>((resolve) => { resolvePreparation = resolve; });

  setPrepareFn(async () => {
    calls++;
    return preparation;
  });

  const realNow = Date.now;
  const startedAt = realNow();
  const config = {} as any;
  const url = `https://example.invalid/stremio-single-flight-${startedAt}.nzb`;
  const title = `stremio-single-flight-${startedAt}`;

  try {
    Date.now = () => startedAt;
    const first = getOrCreateStream(url, title, config, undefined, undefined, 'series', undefined, 'test', undefined, false);

    Date.now = () => startedAt + 10 * 60_000;
    const second = getOrCreateStream(url, title, config, undefined, undefined, 'series', undefined, 'test', undefined, false);

    assert.equal(calls, 1, 'second request must join the existing preparation');

    const expected: StreamData = { nzoId: 'test-job', videoPath: '/content/test/video.mkv', videoSize: 123 };
    resolvePreparation(expected);
    assert.deepEqual(await first, expected);
    assert.deepEqual(await second, expected);
  } finally {
    Date.now = realNow;
    getStreamCache().clear();
  }
});
