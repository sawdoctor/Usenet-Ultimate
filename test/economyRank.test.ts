import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRuntimeSec, economyMaxBytes, rankEconomyCandidates } from '../src/nzbdav/economyRank.js';
import type { FallbackCandidate } from '../src/nzbdav/types.js';

const GB = 1_000_000_000;
const MOVIE_SEC = 110 * 60;

const c = (title: string, sizeGb?: number, extra: Partial<FallbackCandidate> = {}): FallbackCandidate => ({
  nzbUrl: `https://example.invalid/${title}.nzb`,
  title,
  indexerName: 'test',
  ...(sizeGb === undefined ? {} : { size: sizeGb * GB }),
  ...extra,
});

test('economyMaxBytes applies headroom to bandwidth and runtime', () => {
  // Arrange
  const mbps = 40;

  // Act
  const bytes = economyMaxBytes(mbps, 3600);

  // Assert
  assert.equal(bytes, 40 * 0.7 * 1_000_000 / 8 * 3600);
});

test('highest resolution that fits comes first; oversize 4K trails as a last resort', () => {
  // Arrange
  const input = [
    c('Movie.2023.2160p.REMUX', 60),
    c('Movie.2023.1080p.WEB-DL', 8),
    c('Movie.2023.720p.WEB-DL', 3),
  ];

  // Act
  const { ordered, fitCount } = rankEconomyCandidates(input, { mbps: 40, runtimeSec: MOVIE_SEC });

  // Assert
  assert.deepEqual(ordered.map(x => x.title), ['Movie.2023.1080p.WEB-DL', 'Movie.2023.720p.WEB-DL', 'Movie.2023.2160p.REMUX']);
  assert.equal(fitCount, 2);
});

test('a fast connection lets 4K through', () => {
  // Arrange
  const input = [c('Movie.2023.1080p.WEB-DL', 8), c('Movie.2023.2160p.HEVC', 20)];

  // Act
  const { ordered } = rankEconomyCandidates(input, { mbps: 200, runtimeSec: MOVIE_SEC });

  // Assert
  assert.equal(ordered[0].title, 'Movie.2023.2160p.HEVC');
});

test('original order breaks ties within a resolution', () => {
  // Arrange
  const input = [c('A.1080p', 6), c('B.1080p', 4), c('C.1080p', 5)];

  // Act
  const { ordered } = rankEconomyCandidates(input, { mbps: 100, runtimeSec: MOVIE_SEC });

  // Assert
  assert.deepEqual(ordered.map(x => x.title), ['A.1080p', 'B.1080p', 'C.1080p']);
});

test('when nothing fits, the smallest candidates lead', () => {
  // Arrange
  const input = [c('Big.2160p', 70), c('Mid.1080p', 30), c('Small.720p', 15)];

  // Act
  const { ordered, fitCount } = rankEconomyCandidates(input, { mbps: 10, runtimeSec: MOVIE_SEC });

  // Assert
  assert.deepEqual(ordered.map(x => x.title), ['Small.720p', 'Mid.1080p', 'Big.2160p']);
  assert.equal(fitCount, 0);
});

test('unknown size is treated as fitting and unknown resolution ranks below 720p', () => {
  // Arrange
  const input = [c('Movie.DVDRip', 1), c('Movie.720p', 2), c('Movie.1080p')];

  // Act
  const { ordered } = rankEconomyCandidates(input, { mbps: 40, runtimeSec: MOVIE_SEC });

  // Assert
  assert.deepEqual(ordered.map(x => x.title), ['Movie.1080p', 'Movie.720p', 'Movie.DVDRip']);
});

test('remote season packs are sized per episode; library packs keep their file size', () => {
  // Arrange
  const input = [
    c('Show.S01.1080p.pack', 30, { isSeasonPack: true }),
    c('Show.S01E01.720p', 1.5),
    c('Show.S01.1080p.library', 1, { isSeasonPack: true, libraryVideoPath: '/content/tv/x.mkv' }),
  ];

  // Act
  const { ordered, fitCount } = rankEconomyCandidates(input, { mbps: 20, runtimeSec: 45 * 60, episodesInSeason: 10 });

  // Assert
  assert.deepEqual(ordered.map(x => x.title), ['Show.S01.1080p.pack', 'Show.S01.1080p.library', 'Show.S01E01.720p']);
  assert.equal(fitCount, 3);
});

test('defaultRuntimeSec is episode-length for series and movie-length otherwise', () => {
  // Act & Assert
  assert.equal(defaultRuntimeSec('series'), 22 * 60);
  assert.equal(defaultRuntimeSec('movie'), 110 * 60);
  assert.equal(defaultRuntimeSec(undefined), 110 * 60);
});

test('a 10 GB 4K remux of a 22-minute episode is skipped at 70 Mbps when runtime is unknown', () => {
  // Arrange
  const input = [c('Show.S03E03.2160p.REMUX', 10.19), c('Show.S03E03.1080p.WEB-DL', 1.5)];

  // Act
  const { ordered } = rankEconomyCandidates(input, { mbps: 70, runtimeSec: defaultRuntimeSec('series') });

  // Assert
  assert.equal(ordered[0].title, 'Show.S03E03.1080p.WEB-DL');
});

test('a candidate with a known duration is judged by its real bitrate, not the assumed runtime', () => {
  // Arrange
  const input = [
    c('A.2160p.REMUX', 10, { durationSec: 22 * 60 }),
    c('B.1080p.WEB-DL', 6, { durationSec: 22 * 60 }),
  ];

  // Act
  const { ordered, fitCount } = rankEconomyCandidates(input, { mbps: 70, runtimeSec: 7200 });

  // Assert
  assert.deepEqual(ordered.map(x => x.title), ['B.1080p.WEB-DL', 'A.2160p.REMUX']);
  assert.equal(fitCount, 1);
});
