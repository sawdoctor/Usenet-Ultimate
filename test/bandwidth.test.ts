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

test('an override beats live data', () => {
  // Arrange
  recordLiveSample(80);

  // Act & Assert
  assert.deepEqual(peekBandwidth(30), { mbps: 30, source: 'override' });
});

test('live samples are smoothed toward new readings', () => {
  // Arrange
  recordLiveSample(100);

  // Act
  recordLiveSample(50);

  // Assert
  const est = peekBandwidth();
  assert.equal(est.source, 'live');
  assert.equal(est.mbps, 100 + (50 - 100) * 0.4);
});

test('live data goes stale after its TTL', () => {
  // Arrange
  recordLiveSample(80, 1_000);

  // Act
  const est = peekBandwidth(undefined, 1_000 + 7 * 60 * 60 * 1000);

  // Assert
  assert.equal(est.source, 'default');
});

test('non-positive and non-finite samples are ignored', () => {
  // Act
  recordLiveSample(0);
  recordLiveSample(-5);
  recordLiveSample(Number.NaN);

  // Assert
  assert.equal(peekBandwidth().source, 'default');
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
  assert.ok(est.mbps > 0);
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
  recordLiveSample(60);

  // Act
  const est = await resolveBandwidth();

  // Assert
  assert.deepEqual(est, { mbps: 60, source: 'live' });
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
  const est = await resolveBandwidth(undefined, 30);

  // Assert
  assert.deepEqual(est, { mbps: DEFAULT_MBPS, source: 'default' });
});
