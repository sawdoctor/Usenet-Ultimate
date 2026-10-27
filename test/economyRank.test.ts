import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRuntimeSec, economyMaxBytes, rankEconomyCandidates } from '../src/nzbdav/economyRank.js';
import { applyQualityFilters } from '../src/addon/filters.js';
import type { FilterConfig } from '../src/types.js';
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

test('a fast connection lets the user-ranked 4K candidate fit', () => {
  // Arrange
  const input = [c('Movie.2023.2160p.HEVC', 20), c('Movie.2023.1080p.WEB-DL', 8)];

  // Act
  const { ordered } = rankEconomyCandidates(input, { mbps: 200, runtimeSec: MOVIE_SEC });

  // Assert
  assert.equal(ordered[0].title, 'Movie.2023.2160p.HEVC');
});

test('fitting candidates preserve the configured user preference order', () => {
  // Arrange
  const input = [c('A.1080p', 6), c('B.2160p', 4), c('C.1080p', 5)];

  // Act
  const { ordered } = rankEconomyCandidates(input, { mbps: 100, runtimeSec: MOVIE_SEC });

  // Assert
  assert.deepEqual(ordered.map(x => x.title), ['A.1080p', 'B.2160p', 'C.1080p']);
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

test('unknown size trails known candidates and is not counted as fitting', () => {
  // Arrange
  const input = [c('Movie.DVDRip', 1), c('Movie.720p', 2), c('Movie.1080p')];

  // Act
  const { ordered, fitCount } = rankEconomyCandidates(input, { mbps: 40, runtimeSec: MOVIE_SEC });

  // Assert
  assert.deepEqual(ordered.map(x => x.title), ['Movie.DVDRip', 'Movie.720p', 'Movie.1080p']);
  assert.equal(fitCount, 2);
});

test('Adaptive ranking only receives candidates allowed by the existing user filters', () => {
  // Arrange
  const filtered = applyQualityFilters([
    { title: 'Movie.2160p.WEB-DL', size: 2 * GB },
    { title: 'Movie.1080p.WEB-DL', size: 6 * GB },
    { title: 'Movie.720p.WEB-DL', size: 1 * GB },
  ], {
    sortOrder: ['quality'],
    maxFileSize: 4 * GB,
    enabledPriorities: { resolution: { '4k': false } },
  } as FilterConfig);
  const candidates = filtered.map(result => c(result.title, result.size / GB));

  // Act
  const { ordered } = rankEconomyCandidates(candidates, { mbps: 100, runtimeSec: MOVIE_SEC });

  // Assert
  assert.deepEqual(ordered.map(candidate => candidate.title), ['Movie.720p.WEB-DL']);
});

test('over-budget candidates sort by estimated bitrate rather than total size', () => {
  // Arrange
  const input = [
    c('Long.2160p', 10, { durationSec: 2 * 60 * 60 }),
    c('Short.1080p', 8, { durationSec: 60 * 60 }),
  ];

  // Act
  const { ordered, fitCount } = rankEconomyCandidates(input, { mbps: 10, runtimeSec: MOVIE_SEC });

  // Assert
  assert.deepEqual(ordered.map(x => x.title), ['Long.2160p', 'Short.1080p']);
  assert.equal(fitCount, 0);
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
  assert.deepEqual(ordered.map(x => x.title), ['Show.S01.1080p.pack', 'Show.S01E01.720p', 'Show.S01.1080p.library']);
  assert.equal(fitCount, 3);
});

test('estimated episode size takes precedence over dividing a remote season pack', () => {
  // Arrange
  const input = [
    c('Show.S01.1080p.pack', 30, { isSeasonPack: true, estimatedEpisodeSize: 1 * GB }),
    c('Show.S01.720p.pack', undefined, { isSeasonPack: true, estimatedEpisodeSize: 0.5 * GB }),
    c('Show.S01E01.720p', 1.5),
  ];

  // Act
  const { ordered, fitCount } = rankEconomyCandidates(input, { mbps: 10, runtimeSec: 45 * 60, episodesInSeason: 10 });

  // Assert
  assert.equal(ordered[0].title, 'Show.S01.1080p.pack');
  assert.equal(ordered[1].title, 'Show.S01.720p.pack');
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
