import assert from 'node:assert/strict';
import test from 'node:test';
import { SingleFlight } from '../src/utils/singleFlight.js';

test('coalesces concurrent Arr retries into one upstream grab', async () => {
  const flight = new SingleFlight<string, string>();
  let upstreamGrabs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const grab = () => flight.run('same-nzb', async () => {
    upstreamGrabs++;
    await gate;
    return 'payload';
  });

  const retries = Array.from({ length: 20 }, grab);
  await Promise.resolve();
  assert.equal(upstreamGrabs, 1);

  release();
  assert.deepEqual(await Promise.all(retries), Array(20).fill('payload'));
  assert.equal(upstreamGrabs, 1);
});

test('does not merge different NZB URLs', async () => {
  const flight = new SingleFlight<string, string>();
  let calls = 0;
  const [a, b] = await Promise.all([
    flight.run('a', async () => { calls++; return 'a'; }),
    flight.run('b', async () => { calls++; return 'b'; }),
  ]);
  assert.deepEqual([a, b], ['a', 'b']);
  assert.equal(calls, 2);
});

test('clears failed work so a later request can retry', async () => {
  const flight = new SingleFlight<string, string>();
  let calls = 0;
  await assert.rejects(flight.run('nzb', async () => {
    calls++;
    throw new Error('temporary failure');
  }));
  assert.equal(await flight.run('nzb', async () => {
    calls++;
    return 'recovered';
  }), 'recovered');
  assert.equal(calls, 2);
});
