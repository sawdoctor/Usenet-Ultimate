import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiskCache } from '../parsers/diskCache.js';
import { clearRawSearchCache } from '../parsers/searchCache.js';
import { clearFallbackGroups, clearTimeoutEntries, clearResolvedSessions } from '../nzbdav/index.js';

// Create cache for search results
// Use stdTTL: 0 (no expiry) and manage TTL per-entry via cache.set() so runtime changes take effect
export interface CachedSearch {
  rawResults: any[];
  deprioritizedPacks: any[];
  healthMap: Record<string, any>;
  _meta: { type: string; season?: number; episode?: number; episodesInSeason?: number; episodeAired?: string; runtime?: number; cachedAt?: number; releasedAt?: string };
}

export const cache = new DiskCache<CachedSearch>(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'result-cache.json'),
  { schemaVersion: 1, maxEntries: 500, saveDelayMs: 30_000 },
);

export function clearSearchCache(): void {
  cache.flushAll();
  clearRawSearchCache();
  clearFallbackGroups();
  clearTimeoutEntries();
  clearResolvedSessions();
}


/**
 * Build the manifest-scoped search cache key. Single source of truth for the
 * key composition used by the search-time write (this file) and the bypass-
 * time delete (routes/nzbdav.ts library-bypass endpoint). Manifest-scoping
 * prevents cross-manifest cache collisions in multi-tenant deployments.
 */
/** Drop a search cache entry by its full key. Used by the library-bypass
 *  endpoint to clear stale results before the user re-searches. */
export function deleteSearchCacheEntry(cacheKey: string): boolean {
  return cache.del(cacheKey) > 0;
}
