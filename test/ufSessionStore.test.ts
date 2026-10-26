import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ECONOMY_SESSION_TTL_MS, SESSION_SCHEMA_VERSION, SESSION_TTL_MS, readSessions, sessionTtlMs, writeSessions, type SerializedSession } from '../src/nzbdav/ufSessionStore.js';

const NOW = 1_000_000;

const session = (sessionKey: string, overrides: Partial<SerializedSession> = {}): SerializedSession => ({
  version: SESSION_SCHEMA_VERSION,
  sessionKey,
  streamData: { nzoId: 'n', videoPath: `/content/${sessionKey}.mkv`, videoSize: 1 },
  backupStreams: [],
  backupUrls: [],
  expiresAt: NOW + 60_000,
  ...overrides,
});

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uf-sessions-')), 'uf-sessions.json');

test('economy sessions expire sooner than regular sessions', () => {
  // Act & Assert
  assert.equal(sessionTtlMs('m:series:tt1:1:1'), SESSION_TTL_MS);
  assert.equal(sessionTtlMs('m:series:tt1:1:1:eco'), ECONOMY_SESSION_TTL_MS);
  assert.ok(ECONOMY_SESSION_TTL_MS < SESSION_TTL_MS);
});

test('economy sessions are not written to disk', () => {
  // Arrange
  const file = tempFile();

  // Act
  writeSessions(file, [session('m:series:tt1:1:1'), session('m:series:tt1:1:1:eco')]);

  // Assert
  const written = JSON.parse(fs.readFileSync(file, 'utf-8')) as SerializedSession[];
  assert.deepEqual(written.map(s => s.sessionKey), ['m:series:tt1:1:1']);
});

test('economy sessions left on disk by an older version are not loaded', () => {
  // Arrange
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify([session('m:series:tt1:1:1'), session('m:series:tt1:1:1:eco')]));

  // Act
  const loaded = readSessions(file, NOW);

  // Assert
  assert.deepEqual(loaded.map(s => s.sessionKey), ['m:series:tt1:1:1']);
});

test('expired sessions and sessions with another schema version are dropped', () => {
  // Arrange
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify([
    session('keep'),
    session('expired', { expiresAt: NOW - 1 }),
    session('old-schema', { version: SESSION_SCHEMA_VERSION + 1 }),
  ]));

  // Act
  const loaded = readSessions(file, NOW);

  // Assert
  assert.deepEqual(loaded.map(s => s.sessionKey), ['keep']);
});

test('a missing or corrupt session file loads as empty', () => {
  // Arrange
  const corrupt = tempFile();
  fs.writeFileSync(corrupt, '{not json');

  // Act & Assert
  assert.deepEqual(readSessions(path.join(os.tmpdir(), 'does-not-exist-uf.json'), NOW), []);
  assert.deepEqual(readSessions(corrupt, NOW), []);
});
