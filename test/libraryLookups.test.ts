import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLibraryLookups } from '../src/addon/libraryMarking.js';

test('only results with a library folder need a lookup', () => {
  // Arrange
  const results = [{ title: 'Show.S01E01' }, { title: 'Show.S01E02' }, { title: 'Other.S01E01' }];
  const folders = new Set(['Show.S01E02']);

  // Act
  const lookups = pickLibraryLookups(results, folders);

  // Assert
  assert.deepEqual(lookups, [{ title: 'Show.S01E02' }]);
});

test('an unknown folder listing keeps every result', () => {
  // Arrange
  const results = [{ title: 'Show.S01E01' }, { title: 'Show.S01E02' }];

  // Act
  const lookups = pickLibraryLookups(results, undefined);

  // Assert
  assert.deepEqual(lookups, results);
});

test('an empty folder listing skips every lookup', () => {
  // Arrange
  const results = [{ title: 'Show.S01E01' }];

  // Act
  const lookups = pickLibraryLookups(results, new Set());

  // Assert
  assert.deepEqual(lookups, []);
});
