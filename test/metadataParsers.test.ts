import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMetadata, parseYear, buildStreamFilename } from '../src/parsers/metadataParsers.js';
import { buildStreamDisplay, type StreamDisplayData } from '../src/addon/streamDisplay.js';

test('DTS-HD audio on a UHD release is not labelled HDTV', () => {
  // Arrange
  const title = 'Show.Name.S01.2160p.DTS-HD.MA.5.1-GRP';

  // Act
  const { source } = parseMetadata(title);

  // Assert
  assert.equal(source, 'Unknown');
});

test('an explicit HDTV tag is kept', () => {
  // Arrange
  const title = 'Show.Name.S02E05.720p.HDTV.x264-GRP';

  // Act
  const { source } = parseMetadata(title);

  // Assert
  assert.equal(source, 'HDTV');
});

test('season pack spanning several seasons shows the range', () => {
  // Arrange
  const title = 'Show.Name.S01-S03.1080p.BluRay.x264-GRP';

  // Act
  const { cleanTitle } = parseMetadata(title);

  // Assert
  assert.equal(cleanTitle, 'Show Name S01-S03');
});

test('single season pack shows one season', () => {
  // Arrange
  const title = 'Show.Name.S01.1080p.WEB-DL.x264-GRP';

  // Act
  const { cleanTitle } = parseMetadata(title);

  // Assert
  assert.equal(cleanTitle, 'Show Name S01');
});

test('movie year is available from the parsed metadata and parseYear', () => {
  // Arrange
  const title = 'Movie.Name.2020.1080p.BluRay.x264-GRP';

  // Act
  const year = parseYear(title);

  // Assert
  assert.equal(year, '2020');
  assert.equal(parseMetadata(title).year, '2020');
});

test('episode filename carries one season-episode suffix', () => {
  // Arrange
  const title = 'Show.Name.S01E05.1080p.WEB.x264-GRP';

  // Act
  const filename = buildStreamFilename(title, 'series', 1, 5);

  // Assert
  assert.equal(filename, 'Show Name S01E05');
});

test('pack filename drops the season range before adding the episode', () => {
  // Arrange
  const title = 'Show.Name.S01-S03.1080p.WEB.x264-GRP';

  // Act
  const filename = buildStreamFilename(title, 'series', 2, 5);

  // Assert
  assert.equal(filename, 'Show Name S02E05');
});

const display: StreamDisplayData = {
  resolutionDisplay: '1080p', quality: 'WEB-DL', cleanTitle: 'Show Name S01', rawTitle: 'Show.Name.S01',
  encode: 'Unknown', displaySize: '2 GB', visualTag: 'Unknown', audioTag: 'Unknown', releaseGroup: 'Unknown',
  indexer: 'Indexer', statusBadge: '✅', providersLine: '', edition: 'Standard', language: 'Unknown',
  age: '', bitrate: '', isSeasonPack: true,
};

test('legacy card omits an unknown release group', () => {
  // Arrange
  const data = display;

  // Act
  const { title } = buildStreamDisplay(data);

  // Assert
  assert.equal(title.includes('Unknown'), false);
  assert.ok(title.includes('🗂️ Indexer'));
});

test('legacy card shows a known release group', () => {
  // Arrange
  const data = { ...display, releaseGroup: 'GRP' };

  // Act
  const { title } = buildStreamDisplay(data);

  // Assert
  assert.ok(title.includes('🏴‍☠️ GRP'));
});

test('parse cache resets at its size limit and still parses correctly', () => {
  // Arrange
  for (let i = 0; i < 5001; i++) parseMetadata(`Filler.${i}.1080p.WEB.x264-GRP`);

  // Act
  const { resolution } = parseMetadata('Show.Name.S01E05.720p.WEB.x264-GRP');

  // Assert
  assert.equal(resolution, '720p');
});
