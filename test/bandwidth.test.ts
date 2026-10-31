import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MBPS, StreamMeasurement, ThroughputSampler, clientNetwork, measurePlayback, peekBandwidth, resetBandwidthState, resolveBandwidth, speedScope, warmBandwidthProbe } from '../src/nzbdav/bandwidth.js';

const realFetch = globalThis.fetch;
const realLog = console.log;
let fetchCalls = 0;
let logged: string[] = [];

beforeEach(() => {
  resetBandwidthState();
  fetchCalls = 0;
  logged = [];
  console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-31T20:00:00Z');
const HOME = speedScope('manifest-a', '203.0.113.5');

const recordStream = (scope: string | undefined, mbps: number, at: number) => {
  const stream = new StreamMeasurement(scope, 'Show.S01E01.mkv');
  stream.sample(mbps * 1.5, at - 8_000);
  stream.sample(mbps, at);
  stream.finish(1_000_000_000);
};

test('an override beats measured speeds', () => {
  // Arrange
  recordStream(HOME, 80, T0);

  // Act & Assert
  assert.deepEqual(peekBandwidth(HOME, 30, T0), { mbps: 30, source: 'override' });
});

test('devices on one network share a scope; other networks and manifests get their own', () => {
  // Act & Assert
  assert.equal(speedScope('manifest-a', '203.0.113.200'), HOME);
  assert.equal(speedScope('manifest-a', '::ffff:203.0.113.9'), HOME);
  assert.notEqual(speedScope('manifest-a', '198.51.100.5'), HOME);
  assert.notEqual(speedScope('manifest-b', '203.0.113.5'), HOME);
  assert.equal(speedScope(undefined, '203.0.113.5'), undefined);
});

test('IPv6 clients are grouped by their /64 prefix', () => {
  // Act & Assert
  assert.equal(clientNetwork('2001:db8:aa:1::5'), '2001:db8:aa:1');
  assert.equal(clientNetwork('2001:0db8:00aa:0001:abcd::1%eth0'), '2001:db8:aa:1');
  assert.equal(clientNetwork('2001:db8::1'), '2001:db8:0:0');
  assert.equal(clientNetwork(undefined), '');
});

test('a stream peak is used as-is for two hours', () => {
  // Arrange
  recordStream(HOME, 80, T0);

  // Act & Assert
  assert.deepEqual(peekBandwidth(HOME, undefined, T0 + 2 * HOUR), { mbps: 80, source: 'recent' });
  assert.deepEqual(peekBandwidth(HOME, undefined, T0 + 3 * HOUR), { mbps: 80, source: 'history', streams: 1 });
});

test('a stream still playing counts as recent before it ends', () => {
  // Arrange
  const stream = new StreamMeasurement(HOME, 'Movie.mkv');

  // Act
  stream.sample(64, T0);

  // Assert
  assert.deepEqual(peekBandwidth(HOME, undefined, T0 + 1_000), { mbps: 64, source: 'recent' });
  stream.finish();
});

test('past the recent window, the lower quartile of the past day is used', () => {
  // Arrange
  for (const [mbps, hoursAgo] of [[90, 20], [40, 12], [70, 6], [60, 4], [80, 3]] as const) recordStream(HOME, mbps, T0 - hoursAgo * HOUR);

  // Act & Assert
  assert.deepEqual(peekBandwidth(HOME, undefined, T0), { mbps: 60, source: 'day', streams: 5 });
});

test('a window needs three streams before it is used, else the next longer one is tried', () => {
  // Arrange
  recordStream(HOME, 50, T0 - 5 * HOUR);
  recordStream(HOME, 70, T0 - 3 * DAY);
  recordStream(HOME, 90, T0 - 4 * DAY);
  recordStream(HOME, 20, T0 - 60 * DAY);

  // Act & Assert
  assert.deepEqual(peekBandwidth(HOME, undefined, T0), { mbps: 50, source: 'week', streams: 3 });
});

test('streams older than ninety days are forgotten', () => {
  // Arrange
  recordStream(HOME, 70, T0 - 91 * DAY);

  // Act & Assert
  assert.deepEqual(peekBandwidth(HOME, undefined, T0), { mbps: DEFAULT_MBPS, source: 'default' });
});

test('speeds are kept apart by scope', () => {
  // Arrange
  const mobile = speedScope('manifest-a', '198.51.100.5');
  recordStream(HOME, 80, T0);
  recordStream(mobile, 12, T0);

  // Act & Assert
  assert.equal(peekBandwidth(HOME, undefined, T0).mbps, 80);
  assert.equal(peekBandwidth(mobile, undefined, T0).mbps, 12);
  assert.equal(peekBandwidth(speedScope('manifest-c', '203.0.113.5'), undefined, T0).source, 'default');
});

test('a stream is worth its second-fastest window, since the first fills socket buffers', () => {
  // Arrange
  const stream = new StreamMeasurement(HOME, 'Seinfeld.S04E02.mkv');
  for (const mbps of [67, 51, 50, 49]) stream.sample(mbps, T0);

  // Act
  stream.finish(4_100_000_000);

  // Assert
  assert.deepEqual(logged, ['📶 Stream speed: Seinfeld.S04E02.mkv — 4 reading(s) [67, 51, 50, 49] Mbps → 51 Mbps, file 4.1 GB']);
  assert.deepEqual(peekBandwidth(HOME, undefined, T0), { mbps: 51, source: 'recent' });
});

test('a stream with one reading is worth that reading', () => {
  // Arrange
  const stream = new StreamMeasurement(HOME, 'Short.mkv');

  // Act
  stream.sample(12, T0);
  stream.finish();

  // Assert
  assert.deepEqual(peekBandwidth(HOME, undefined, T0), { mbps: 12, source: 'recent' });
});

test('the log shows the first eight readings of a long stream', () => {
  // Arrange
  const stream = new StreamMeasurement(HOME, 'Movie.mkv');
  for (let i = 1; i <= 10; i++) stream.sample(i * 10, T0);

  // Act
  stream.finish();

  // Assert
  assert.deepEqual(logged, ['📶 Stream speed: Movie.mkv — 10 reading(s) [10, 20, 30, 40, 50, 60, 70, 80, …] Mbps → 90 Mbps']);
});

test('range requests for one file make one playback, stored when the last one ends', () => {
  // Arrange
  const first = measurePlayback(HOME, 'Movie.mkv', T0);
  const seek = measurePlayback(HOME, 'Movie.mkv', T0 + 60_000);

  // Act
  first.sample(90, T0 + 8_000);
  seek.sample(60, T0 + 68_000);
  seek.sample(55, T0 + 76_000);
  first.finish(undefined, T0 + 80_000);
  const whileOpen = logged.length;
  seek.finish(undefined, T0 + 90_000);

  // Assert
  assert.equal(first, seek);
  assert.equal(whileOpen, 0);
  assert.deepEqual(peekBandwidth(HOME, undefined, T0 + 3 * HOUR), { mbps: 60, source: 'history', streams: 1 });
});

test('a playback resumed within ten minutes updates its entry instead of adding one', () => {
  // Arrange
  const before = measurePlayback(HOME, 'Show.S01E02.mkv', T0);
  before.sample(40, T0);
  before.finish(undefined, T0 + 1_000);

  // Act
  const resumed = measurePlayback(HOME, 'Show.S01E02.mkv', T0 + 5 * 60_000);
  resumed.sample(70, T0 + 5 * 60_000);
  resumed.finish(undefined, T0 + 6 * 60_000);
  const later = measurePlayback(HOME, 'Show.S01E02.mkv', T0 + 30 * 60_000);

  // Assert
  assert.equal(resumed, before);
  assert.notEqual(later, before);
  assert.deepEqual(peekBandwidth(HOME, undefined, T0 + 3 * HOUR), { mbps: 40, source: 'history', streams: 1 });
  later.finish();
});

test('a stream with no valid reading is not remembered', () => {
  // Arrange
  const stream = new StreamMeasurement(HOME, 'Short.mkv');

  // Act
  stream.sample(0, T0);
  stream.sample(-5, T0);
  stream.sample(Number.NaN, T0);
  stream.finish();

  // Assert
  assert.equal(peekBandwidth(HOME, undefined, T0).source, 'default');
  assert.deepEqual(logged, []);
});

test('only the latest hundred streams are kept per scope', () => {
  // Arrange
  for (let i = 0; i < 101; i++) recordStream(HOME, i === 0 ? 1 : 100, T0 - (101 - i) * 60_000 - 3 * HOUR);

  // Act
  const est = peekBandwidth(HOME, undefined, T0);

  // Assert
  assert.deepEqual(est, { mbps: 100, source: 'day', streams: 100 });
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
  assert.deepEqual(peekBandwidth(HOME), { mbps: DEFAULT_MBPS, source: 'default' });
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
  recordStream(HOME, 60, Date.now());

  // Act
  const est = await resolveBandwidth(HOME);

  // Assert
  assert.deepEqual(est, { mbps: 60, source: 'recent' });
  assert.equal(fetchCalls, 0);
});

test('resolveBandwidth does not wait for a server probe to guess a manifest speed', async () => {
  // Arrange
  stubFetch(() => new Promise<Response>(() => {}));

  // Act
  const est = await resolveBandwidth(HOME, undefined, 25);

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
