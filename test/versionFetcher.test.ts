import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('importing the version fetcher does not start network requests', async () => {
  // Arrange
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalExistsSync = fs.existsSync;
  const originalWriteFileSync = fs.writeFileSync;
  const requests: RequestInfo[] = [];
  let timerUnrefed = false;
  let intervalCallback: (() => void) | undefined;
  globalThis.fetch = async (input) => {
    requests.push(input);
    return new Response(null, { status: 503 });
  };
  globalThis.setInterval = ((callback) => {
    intervalCallback = callback as () => void;
    return { unref: () => { timerUnrefed = true; } } as unknown as NodeJS.Timeout;
  }) as typeof setInterval;
  fs.existsSync = () => false;
  fs.writeFileSync = (() => {}) as typeof fs.writeFileSync;

  try {
    // Act
    const { startVersionRefresh } = await import('../src/versionFetcher.js');
    await new Promise<void>(resolve => setImmediate(resolve));

    // Assert
    assert.equal(requests.length, 0);
    startVersionRefresh();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requests.length, 4);
    assert.equal(timerUnrefed, true);
    assert.ok(intervalCallback);
    intervalCallback();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requests.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    fs.existsSync = originalExistsSync;
    fs.writeFileSync = originalWriteFileSync;
  }
});
