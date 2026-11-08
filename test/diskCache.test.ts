import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiskCache, saveAllDiskCaches } from '../src/parsers/diskCache.js';

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'disk-cache-')), 'cache.json');
const options = { schemaVersion: 1, maxEntries: 10, saveDelayMs: 60_000 };

test('entries saved by one instance load into the next with their remaining lifetime', () => {
  // Arrange
  const file = tempFile();
  const first = new DiskCache<{ n: number }>(file, options);
  first.set('a', { n: 1 }, 3600);
  first.saveNow();

  // Act
  const second = new DiskCache<{ n: number }>(file, options);

  // Assert
  assert.deepEqual(second.get('a'), { n: 1 });
});

test('expired entries are not loaded', () => {
  // Arrange
  const file = tempFile();
  const first = new DiskCache<string>(file, options);
  first.set('old', 'x', 60);
  first.saveNow();

  // Act
  const later = new DiskCache<string>(file, options, Date.now() + 120_000);

  // Assert
  assert.equal(later.get('old'), undefined);
});

test('a snapshot with another schema version is ignored', () => {
  // Arrange
  const file = tempFile();
  const first = new DiskCache<string>(file, options);
  first.set('a', 'x', 3600);
  first.saveNow();

  // Act
  const upgraded = new DiskCache<string>(file, { ...options, schemaVersion: 2 });

  // Assert
  assert.equal(upgraded.get('a'), undefined);
});

test('only the entries that live longest are kept when the limit is exceeded', () => {
  // Arrange
  const file = tempFile();
  const cache = new DiskCache<number>(file, { ...options, maxEntries: 2 });
  cache.set('short', 1, 100);
  cache.set('long', 2, 3000);
  cache.set('medium', 3, 1000);
  cache.saveNow();

  // Act
  const loaded = new DiskCache<number>(file, options);

  // Assert
  assert.equal(loaded.get('short'), undefined);
  assert.equal(loaded.get('long'), 2);
  assert.equal(loaded.get('medium'), 3);
});

test('deleting and flushing are saved too', () => {
  // Arrange
  const file = tempFile();
  const cache = new DiskCache<string>(file, options);
  cache.set('a', 'x', 3600);
  cache.set('b', 'y', 3600);
  cache.del('a');
  cache.saveNow();
  const afterDelete = new DiskCache<string>(file, options);
  cache.flushAll();
  cache.saveNow();

  // Act
  const afterFlush = new DiskCache<string>(file, options);

  // Assert
  assert.equal(afterDelete.get('a'), undefined);
  assert.equal(afterDelete.get('b'), 'y');
  assert.equal(afterFlush.get('b'), undefined);
});

test('a missing or corrupt file starts empty', () => {
  // Arrange
  const corrupt = tempFile();
  fs.writeFileSync(corrupt, '{nope');

  // Act
  const fromCorrupt = new DiskCache<string>(corrupt, options);
  const fromMissing = new DiskCache<string>(path.join(os.tmpdir(), 'no-such-dir-xyz', 'c.json'), options);

  // Assert
  assert.equal(fromCorrupt.get('a'), undefined);
  assert.equal(fromMissing.get('a'), undefined);
});

test('saveAllDiskCaches writes every live cache', () => {
  // Arrange
  const file = tempFile();
  const cache = new DiskCache<string>(file, options);
  cache.set('a', 'x', 3600);

  // Act
  saveAllDiskCaches();

  // Assert
  assert.ok(fs.existsSync(file));
});
