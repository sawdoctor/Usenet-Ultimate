import test from 'node:test';
import assert from 'node:assert/strict';
import { titleMatchesEpisode } from '../src/parsers/titleMatching.js';
import { applyEpisodeMatchFilter } from '../src/addon/filters.js';

test('keeps the requested SxxExx in common naming styles', () => {
  for (const t of [
    'The.Simpsons.S18E01.1080p.WEB.h264-GRP.mkv',
    'The Simpsons (1989) - S18E01 - The Mook the Chef the Wife and Her Homer [DSNP][WEBDL-1080p]-HONE.mkv',
    'The Simpsons S18 E01 1080p',
    'the.simpsons.s18.e01.720p',
  ]) assert.equal(titleMatchesEpisode(t, 18, [1]), true, t);
});

test('drops other episodes (issue #5 log)', () => {
  for (const t of [
    'the.simpsons.s17e14.1080p.bluray.x264-taxes.mkv',
    'the.simpsons.s15e01.1080p.bluray.x264-dukes.mkv',
    'The.Simpsons.S32E18.Burger.Kings.1080p.DSNP.WEB-DL.DDP5.1.H.264-ShiNobi.mkv',
    'The Simpsons (1989) S04E18 (1080p DSNP WEB-DL H264 SDR DDP 5.1 English - HONE) [REMASTERED].mkv',
    'The.Simpsons.S18E10.The.Wife.Aquatic.1080p.AMZN.WEB-DL.mkv',
  ]) assert.equal(titleMatchesEpisode(t, 18, [1]), false, t);
});

test('multi-episode chains and ranges', () => {
  assert.equal(titleMatchesEpisode('Show.S17E14E15.1080p', 17, [15]), true);
  assert.equal(titleMatchesEpisode('Show.S17E14-16.1080p', 17, [15]), true);
  assert.equal(titleMatchesEpisode('Show.S17E14-E16.1080p', 17, [16]), true);
  assert.equal(titleMatchesEpisode('Show.S17E14E15.1080p', 17, [16]), false);
});

test('titles without a SxxExx token pass', () => {
  for (const t of [
    'AEW.Dynamite.2026.05.13.1080p.WEB.h264-GRP',
    '[SubsPlease] One Piece - 1100 (1080p).mkv',
    'Show.S2024E05.1080p',
    'Show.S18.1080p.WEB-DL',
  ]) assert.equal(titleMatchesEpisode(t, 18, [1]), true, t);
});

test('absolute episode number in the episode slot', () => {
  assert.equal(titleMatchesEpisode('AEW.Dynamite.S08E345.1080p', 8, [18, 345]), true);
  assert.equal(titleMatchesEpisode('AEW.Dynamite.S07E345.1080p', 8, [18, 345]), false);
});

test('applyEpisodeMatchFilter keeps packs, absolute hits and skips anime', () => {
  const r = (title: string, isSeasonPack = false) => ({ title, isSeasonPack });
  const input = [r('Show.S18E01.1080p'), r('Show.S17E14.1080p'), r('Show.S18.1080p', true), r('Show.S18E400.1080p')];
  const ctx = { season: 18, episode: 1, tvdbPriorSeasonsCount: 399 };
  assert.deepEqual(applyEpisodeMatchFilter(input, ctx).map(x => x.title), ['Show.S18E01.1080p', 'Show.S18.1080p', 'Show.S18E400.1080p']);
  assert.equal(applyEpisodeMatchFilter(input, { ...ctx, isAnime: true }).length, 4);
  assert.equal(applyEpisodeMatchFilter(input, { season: 18 }).length, 4);
  assert.equal(applyEpisodeMatchFilter(input).length, 4);
});
