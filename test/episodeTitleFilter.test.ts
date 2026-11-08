import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEpisodeTitleFilter } from '../src/addon/filters.js';

const SEASON_NAMES = { 3: 'The Jacket', 9: 'The Deal', 12: 'The Busboy' };

test('drops a release whose title names a different episode of the season', () => {
  // Arrange
  const results = [{ title: 'Seinfeld.S02E03.The.Busboy.PROPER.2160p.UHD.BluRay' }];

  // Act
  const kept = applyEpisodeTitleFilter(results, { episode: 3, names: SEASON_NAMES });

  // Assert
  assert.deepEqual(kept, []);
});

test('keeps a release whose title names the requested episode', () => {
  // Arrange
  const results = [{ title: 'Seinfeld.S02E03.The.Jacket.1080p.WEBRip' }];

  // Act
  const kept = applyEpisodeTitleFilter(results, { episode: 3, names: SEASON_NAMES });

  // Assert
  assert.deepEqual(kept, results);
});

test('keeps a release that names no episode title', () => {
  // Arrange
  const results = [{ title: 'Seinfeld.S02E03.1080p.WEBRip.x265-KFL' }];

  // Act
  const kept = applyEpisodeTitleFilter(results, { episode: 3, names: SEASON_NAMES });

  // Assert
  assert.deepEqual(kept, results);
});

test('keeps a multi-episode release that names the requested episode alongside another', () => {
  // Arrange
  const results = [{ title: 'Seinfeld.S02E03E12.The.Jacket.The.Busboy.1080p' }];

  // Act
  const kept = applyEpisodeTitleFilter(results, { episode: 3, names: SEASON_NAMES });

  // Assert
  assert.deepEqual(kept, results);
});

test('matches episode titles only on whole words', () => {
  // Arrange
  const results = [{ title: 'Seinfeld.S02E03.The.Dealership.1080p' }];

  // Act
  const kept = applyEpisodeTitleFilter(results, { episode: 3, names: { 3: 'The Jacket', 12: 'Deal' } });

  // Assert
  assert.deepEqual(kept, results);
});

test('leaves season packs alone even when they name another episode', () => {
  // Arrange
  const results = [{ title: 'Seinfeld.S02E12.The.Busboy.Season.Pack', isSeasonPack: true }];

  // Act
  const kept = applyEpisodeTitleFilter(results, { episode: 3, names: SEASON_NAMES });

  // Assert
  assert.deepEqual(kept, results);
});

test('returns every result unchanged when no episode titles are known', () => {
  // Arrange
  const results = [{ title: 'Seinfeld.S02E03.The.Busboy.1080p' }];

  // Act
  const kept = applyEpisodeTitleFilter(results, undefined);

  // Assert
  assert.deepEqual(kept, results);
});
