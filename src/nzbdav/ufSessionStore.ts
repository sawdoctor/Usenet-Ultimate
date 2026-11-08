import * as fs from 'fs';
import { isEconomySessionKey } from '../addon/ufTile.js';
import type { StreamData } from './types.js';
import type { UfBackupStream } from './ultimateFallback.js';

export const SESSION_TTL_MS = 2 * 60 * 60 * 1000 + 30_000;
export const ECONOMY_SESSION_TTL_MS = 15 * 60 * 1000;
export const SESSION_SCHEMA_VERSION = 1;

export interface SerializedSession {
  version: number;
  sessionKey: string;
  streamData: StreamData;
  backupStreams: UfBackupStream[];
  backupUrls: string[];
  lastVettedUrl?: string;
  expiresAt: number;
}

export function sessionTtlMs(sessionKey: string): number {
  return isEconomySessionKey(sessionKey) ? ECONOMY_SESSION_TTL_MS : SESSION_TTL_MS;
}

/** Unexpired sessions from disk. Economy sessions never load, so a restart re-ranks them. */
export function readSessions(file: string, now: number): SerializedSession[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as SerializedSession[];
    return raw.filter(entry => {
      if (entry.version !== SESSION_SCHEMA_VERSION) {
        console.warn(`⚠️  Discarding UF session (schema v${entry.version} != v${SESSION_SCHEMA_VERSION})`);
        return false;
      }
      return entry.expiresAt > now && !isEconomySessionKey(entry.sessionKey);
    });
  } catch {
    return [];
  }
}

export function writeSessions(file: string, sessions: SerializedSession[]): void {
  const persistable = sessions.filter(s => !isEconomySessionKey(s.sessionKey));
  try { fs.writeFileSync(file, JSON.stringify(persistable, null, 2)); } catch {}
}
