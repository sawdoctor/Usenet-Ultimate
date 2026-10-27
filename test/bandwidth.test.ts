import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MBPS, ThroughputSampler, peekBandwidth, recordLiveSample, resetBandwidthState, resolveBandwidth, warmBandwidthProbe } from '../src/nzbdav/bandwidth.js';

const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  resetBandwidthState();
  fetchCalls = 0;
});
afterEach(() => { globalThis.fetch = realFetch; });

const stubFetch = (impl: () => Promise<Response>) => {
  globalThis.fetch = (async () => { fetchCalls++; return impl(); }) as typeof fetch;
};

const slowBody = (chunks: number, chunkBytes: number) => new ReadableStream<Uint8Array>({
  async pull(controller) {
    await new Promise(r => setTimeout(r, 20));
    if (chunks-- <= 0) return controller.close();
    controller.enqueue(new Uint8Array(chunkBytes));
  },
});

test('with no data the estimate is the default', () => {
  // Act & Assert
  assert.deepEqual(peekBandwidth(), { mbps: DEFAULT_MBPS, source: 'default' });
});

test('an override beats live data for a manifest', () => {
  // Arrange
  recordLiveSample('manifest-a', 80);

  // Act & Assert
  assert.deepEqual(peekBandwidth('manifest-a', 30), { mbps: 30, source: 'override' });
});

test('live estimates are isolated by manifest', () => {
  // Arrange
  recordLiveSample('manifest-a', 80);
  recordLiveSample('manifest-b', 35);

  // Act & Assert
  assert.deepEqual(peekBandwidth('manifest-a'), { mbps: 80, source: 'live' });
  assert.deepEqual(peekBandwidth('manifest-b'), { mbps: 35, source: 'live' });
  assert.equal(peekBandwidth('manifest-c').source, 'default');
});

test('a slower live sample lowers the estimate immediately', () => {
  // Arrange
  recordLiveSample('manifest-a', 100, 1_000);

  // Act
  recordLiveSample('manifest-a', 50, 2_000);

  // Assert
  assert.deepEqual(peekBandwidth('manifest-a', undefined, 2_000), { mbps: 50, source: 'live' });
});

test('a faster live sample recovers by only a fifth of the gap', () => {
  // Arrange
  recordLiveSample('manifest-a', 50, 1_000);

  // Act
  recordLiveSample('manifest-a', 100, 2_000);

  // Assert
  assert.deepEqual(peekBandwidth('manifest-a', undefined, 2_000), { mbps: 60, source: 'live' });
});

test('live data expires after ten minutes without a fresh saturated window', () => {
  // Arrange
  recordLiveSample('manifest-a', 80, 1_000);

  // Act
  const est = peekBandwidth('manifest-a', undefined, 1_000 + 10 * 60 * 1000);

  // Assert
  assert.equal(est.source, 'default');
});

test('live estimates evict the oldest manifest when the cache is full', () => {
  // Arrange
  for (let i = 0; i <= 1_000; i++) recordLiveSample(`manifest-${i}`, 20 + i, i);

  // Act
  const evicted = peekBandwidth('manifest-0', undefined, 1_000);
  const newest = peekBandwidth('manifest-1000', undefined, 1_000);

  // Assert
  assert.equal(evicted.source, 'default');
  assert.deepEqual(newest, { mbps: 1020, source: 'live' });
});

test('samples without a manifest or with an invalid speed are ignored', () => {
  // Act
  recordLiveSample(undefined, 100);
  recordLiveSample('manifest-a', 0);
  recordLiveSample('manifest-a', -5);
  recordLiveSample('manifest-a', Number.NaN);

  // Assert
  assert.equal(peekBandwidth('manifest-a').source, 'default');
});

test('sampler reports a saturated window as megabits per second', () => {
  // Arrange
  const samples: number[] = [];
  const sampler = new ThroughputSampler(m => samples.push(m));

  // Act
  sampler.tick(0, 0, 1_000_000);
  sampler.tick(4_000, 5_000_000, 1_000_000);
  sampler.tick(8_000, 10_000_000, 1_000_000);

  // Assert
  assert.equal(samples.length, 1);
  assert.equal(samples[0], 10);
});

test('sampler drops a window where the backlog ran dry', () => {
  // Arrange
  const samples: number[] = [];
  const sampler = new ThroughputSampler(m => samples.push(m));

  // Act
  sampler.tick(0, 0, 1_000_000);
  sampler.tick(4_000, 1_000_000, 0);
  sampler.tick(8_000, 2_000_000, 1_000_000);

  // Assert
  assert.deepEqual(samples, []);
});

test('sampler starts a fresh window after each report', () => {
  // Arrange
  const samples: number[] = [];
  const sampler = new ThroughputSampler(m => samples.push(m));

  // Act
  sampler.tick(1_000, 0, 1_000_000);
  sampler.tick(9_000, 10_000_000, 1_000_000);
  sampler.tick(17_000, 30_000_000, 1_000_000);

  // Assert
  assert.deepEqual(samples, [10, 20]);
});

test('a successful probe becomes the estimate', async () => {
  // Arrange
  stubFetch(async () => new Response(slowBody(2, 3_000_000)));

  // Act
  await warmBandwidthProbe();

  // Assert
  const est = peekBandwidth();
  assert.equal(est.source, 'probe');
  assert.equal(est.mbps, DEFAULT_MBPS);
});

test('an unscoped server probe is not used as a manifest stream measurement', async () => {
  // Arrange
  stubFetch(async () => new Response(slowBody(2, 3_000_000)));
  await warmBandwidthProbe();

  // Act & Assert
  assert.deepEqual(peekBandwidth('manifest-a'), { mbps: DEFAULT_MBPS, source: 'default' });
});

test('a fresh probe is not repeated and concurrent warms share one request', async () => {
  // Arrange
  stubFetch(async () => new Response(slowBody(2, 3_000_000)));

  // Act
  await Promise.all([warmBandwidthProbe(), warmBandwidthProbe()]);
  await warmBandwidthProbe();

  // Assert
  assert.equal(fetchCalls, 1);
});

test('a failed, short or errored probe leaves the default in place', async () => {
  // Arrange
  const cases: Array<() => Promise<Response>> = [
    async () => new Response('nope', { status: 503 }),
    async () => new Response(slowBody(1, 1_000_000)),
    async () => { throw new Error('offline'); },
  ];

  for (const impl of cases) {
    stubFetch(impl);

    // Act
    await warmBandwidthProbe();

    // Assert
    assert.equal(peekBandwidth().source, 'default');
    resetBandwidthState();
  }
});

test('resolveBandwidth skips the probe when it already has data', async () => {
  // Arrange
  stubFetch(async () => new Response(slowBody(2, 3_000_000)));
  recordLiveSample('manifest-a', 60);

  // Act
  const est = await resolveBandwidth('manifest-a');

  // Assert
  assert.deepEqual(est, { mbps: 60, source: 'live' });
  assert.equal(fetchCalls, 0);
});

test('resolveBandwidth does not wait for a server probe to guess a manifest speed', async () => {
  // Arrange
  stubFetch(() => new Promise<Response>(() => {}));

  // Act
  const est = await resolveBandwidth('manifest-a', undefined, 25);

  // Assert
  assert.deepEqual(est, { mbps: DEFAULT_MBPS, source: 'default' });
  assert.equal(fetchCalls, 0);
});

test('resolveBandwidth probes when nothing is known', async () => {
  // Arrange
  stubFetch(async () => new Response(slowBody(2, 3_000_000)));

  // Act
  const est = await resolveBandwidth();

  // Assert
  assert.equal(est.source, 'probe');
});

test('resolveBandwidth gives up waiting on a slow probe and returns the default', async () => {
  // Arrange
  stubFetch(() => new Promise<Response>(() => {}));

  // Act
  const est = await resolveBandwidth(undefined, undefined, 30);

  // Assert
  assert.deepEqual(est, { mbps: DEFAULT_MBPS, source: 'default' });
});
