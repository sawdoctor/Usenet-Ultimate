import test from 'node:test';
import assert from 'node:assert/strict';
import { orderEpisodeStreamingCandidates } from '../src/nzbdav/candidateOrder.js';
import type { FallbackCandidate } from '../src/nzbdav/types.js';

const c = (title: string, isSeasonPack = false, libraryVideoPath?: string): FallbackCandidate => ({
  nzbUrl: `https://example.invalid/${title}.nzb`, title, indexerName: 'test', isSeasonPack,
  ...(libraryVideoPath ? { libraryVideoPath } : {}),
});

test('clicked result stays first; singles and library packs beat remote packs', () => {
  const input = [c('clicked-pack', true), c('other-pack', true), c('single-a'), c('library-pack', true, '/content/tv/library-pack/E05.mkv'), c('single-b')];
  const ordered = orderEpisodeStreamingCandidates(input, 0, 'series', '5');
  assert.deepEqual(ordered.map(x => x.title), ['clicked-pack', 'single-a', 'library-pack', 'single-b', 'other-pack']);
});

test('clicked single stays first and rotated remote-pack order remains stable', () => {
  const input = [c('pack-before', true), c('clicked-single'), c('pack-after', true), c('single-after')];
  const ordered = orderEpisodeStreamingCandidates(input, 1, 'series', '5');
  assert.deepEqual(ordered.map(x => x.title), ['clicked-single', 'single-after', 'pack-after', 'pack-before']);
});

test('movies retain clicked-then-wrap order', () => {
  const input = [c('a', true), c('b'), c('c', true)];
  assert.deepEqual(orderEpisodeStreamingCandidates(input, 1, 'movie').map(x => x.title), ['b', 'c', 'a']);
});

test('series without an episode retain clicked-then-wrap order', () => {
  const input = [c('a', true), c('b'), c('c', true)];
  assert.deepEqual(orderEpisodeStreamingCandidates(input, 1, 'series').map(x => x.title), ['b', 'c', 'a']);
});
