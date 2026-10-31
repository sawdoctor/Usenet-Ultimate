import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheFreshness, cacheRetentionSeconds } from '../src/addon/cacheFreshness.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-31T20:00:00Z');
const TTL = 4 * 60 * 60;
const OLD_RELEASE = '1992-08-19';

test('a search inside the TTL is fresh', () => {
  // Act & Assert
  assert.equal(cacheFreshness(NOW - 3 * HOUR, OLD_RELEASE, TTL, NOW), 'fresh');
  assert.equal(cacheFreshness(NOW - 4 * HOUR, OLD_RELEASE, TTL, NOW), 'fresh');
});

test('an old release past the TTL is stale until a day has passed', () => {
  // Act & Assert
  assert.equal(cacheFreshness(NOW - 5 * HOUR, OLD_RELEASE, TTL, NOW), 'stale');
  assert.equal(cacheFreshness(NOW - 24 * HOUR, OLD_RELEASE, TTL, NOW), 'stale');
  assert.equal(cacheFreshness(NOW - 25 * HOUR, OLD_RELEASE, TTL, NOW), 'expired');
});

test('a release from the last week expires at the TTL', () => {
  // Arrange
  const sixDaysAgo = new Date(NOW - 6 * DAY).toISOString();
  const eightDaysAgo = new Date(NOW - 8 * DAY).toISOString();

  // Act & Assert
  assert.equal(cacheFreshness(NOW - 5 * HOUR, sixDaysAgo, TTL, NOW), 'expired');
  assert.equal(cacheFreshness(NOW - 5 * HOUR, eightDaysAgo, TTL, NOW), 'stale');
});

test('an unreleased or undated title expires at the TTL', () => {
  // Arrange
  const nextWeek = new Date(NOW + 7 * DAY).toISOString();

  // Act & Assert
  assert.equal(cacheFreshness(NOW - 5 * HOUR, nextWeek, TTL, NOW), 'expired');
  assert.equal(cacheFreshness(NOW - 5 * HOUR, undefined, TTL, NOW), 'expired');
  assert.equal(cacheFreshness(NOW - 5 * HOUR, 'not a date', TTL, NOW), 'expired');
});

test('an entry saved before searches were timestamped counts as fresh', () => {
  // Act & Assert
  assert.equal(cacheFreshness(undefined, undefined, TTL, NOW), 'fresh');
});

test('a TTL longer than a day leaves no stale window', () => {
  // Arrange
  const threeDays = 3 * 24 * 60 * 60;

  // Act & Assert
  assert.equal(cacheRetentionSeconds(threeDays), threeDays);
  assert.equal(cacheRetentionSeconds(TTL), 24 * 60 * 60);
  assert.equal(cacheFreshness(NOW - 2 * DAY, OLD_RELEASE, threeDays, NOW), 'fresh');
  assert.equal(cacheFreshness(NOW - 4 * DAY, OLD_RELEASE, threeDays, NOW), 'expired');
});
