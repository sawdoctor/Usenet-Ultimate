import { createHash } from 'node:crypto';
import NodeCache from 'node-cache';
import { config } from '../config/index.js';
import type { NZBSearchResult } from '../types.js';

// Raw indexer results per query. Every episode of a season sends the same season-pack query.
// Proxied and Zyclops searches are never cached: their results carry a per-search exit-IP stamp.
const searchCache = new NodeCache({ stdTTL: 0 });

/** Hashed so the indexer API key in the URL never appears in the key. */
export function searchCacheKey(indexerName: string, indexerUrl: string, query: string, category: string | undefined, pagination: unknown): string {
  return createHash('sha256').update(JSON.stringify([indexerName, indexerUrl, query, category ?? '', pagination ?? null])).digest('hex');
}

/** Runs `search` unless a non-empty result is cached. Empty results are not cached, so an outage is retried. */
export async function cachedSearch(key: string, search: () => Promise<NZBSearchResult[]>): Promise<NZBSearchResult[]> {
  if (!config.cacheEnabled || !(config.cacheTTL > 0)) return search();
  const hit = searchCache.get<NZBSearchResult[]>(key);
  if (hit) return hit;
  const results = await search();
  if (results.length > 0) searchCache.set(key, results, config.cacheTTL);
  return results;
}
