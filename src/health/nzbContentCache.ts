/**
 * NZB Content Cache
 *
 * Caches raw NZB XML downloaded during health checks, Stremio auto-queue and
 * Newznab t=get so the same payload is never fetched from an indexer twice.
 * Indexers count NZB downloads and will flag an account for repeated fetches
 * of the same release — NZBFinder did exactly that (170 downloads across 73
 * unique IDs in 12 hours).
 *
 * Retention notes:
 *  - An NZB for a given URL is immutable, so a long TTL is safe. Search
 *    RESULTS go stale quickly, but they have their own separate 10-minute
 *    cache in routes/newznab.ts — the two lifetimes are deliberately
 *    decoupled. The old shared 10-minute TTL meant a candidate verified
 *    during search was usually gone before the arr's grab arrived.
 *  - Capacity is byte-budgeted, not entry-counted. NZB size scales with
 *    segment count: a single-file MKV NZB is tens of KB, while a 237-part
 *    RAR release is several MB, and NZB_MAX_BYTES admits up to 50MB. A flat
 *    entry cap therefore bounds nothing useful — 50 entries could be 2.5GB.
 *  - Eviction prefers expired entries, then least-recently-USED. The old
 *    policy evicted by insertion time, so a payload verified seconds earlier
 *    could be dropped while an untouched older one survived.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;        // 24h
// Payload budget, not an RSS figure: V8 may hold these strings as UTF-16, so
// worst-case resident size can approach double. Raise via NZB_CACHE_MAX_BYTES
// if evictions get noisy; typical NZBs are well under 1MB, so the budget holds
// hundreds of them and only pathological multi-hundred-part releases approach
// the per-entry ceiling.
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;       // 256MB total
// Matches NZB_MAX_BYTES in routes/newznab.ts. A per-entry ceiling BELOW what
// t=get will accept is worse than no ceiling: a payload over the limit is
// refused by the cache and therefore re-downloaded from the indexer on every
// single request — exactly the behaviour that got the account flagged.
// Evicting something to make room is always better than never caching.
const DEFAULT_MAX_ENTRY_BYTES = 50 * 1024 * 1024;  // 50MB per payload

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ttlMs = (): number => envNum('NZB_CACHE_TTL_MS', DEFAULT_TTL_MS);
const maxBytes = (): number => envNum('NZB_CACHE_MAX_BYTES', DEFAULT_MAX_BYTES);
/**
 * Per-payload ceiling, clamped to the total budget: a per-entry limit larger
 * than the whole cache would admit an entry that immediately evicts everything
 * else and then sits alone over budget.
 */
const maxEntryBytes = (): number =>
  Math.min(envNum('NZB_CACHE_MAX_ENTRY_BYTES', DEFAULT_MAX_ENTRY_BYTES), maxBytes());

interface CacheEntry {
  content: string;
  createdAt: number;   // for TTL — never refreshed, so entries do expire
  lastUsed: number;    // for LRU eviction
  bytes: number;
}

const cache = new Map<string, CacheEntry>();
let totalBytes = 0;

const stats = {
  hits: 0,
  misses: 0,
  expiredOnRead: 0,
  evictedExpired: 0,
  evictedBudget: 0,
  skippedTooLarge: 0,
  stored: 0,
};

function drop(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  totalBytes -= entry.bytes;
  cache.delete(key);
}

/** Store raw NZB XML content keyed by the URL it was requested from. */
export function cacheNzbContent(url: string, content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  const perEntry = maxEntryBytes();
  if (bytes > perEntry) {
    stats.skippedTooLarge++;
    console.warn(`📦 NZB cache: payload too large to cache (${(bytes / 1048576).toFixed(1)}MB > ${(perEntry / 1048576).toFixed(0)}MB) — THIS URL WILL BE RE-FETCHED FROM THE INDEXER ON EVERY REQUEST; raise NZB_CACHE_MAX_BYTES`);
    return;
  }

  const now = Date.now();
  drop(url); // replacing an existing entry must not double-count bytes

  cache.set(url, { content, createdAt: now, lastUsed: now, bytes });
  totalBytes += bytes;
  stats.stored++;

  // Sweep expired entries on every write, not only under budget pressure.
  // Expired payloads are free to lose, and holding them until the cache is
  // full means a quiet period leaves stale bytes resident indefinitely.
  const ttl = ttlMs();
  let expired = 0;
  for (const [key, entry] of cache) {
    if (key !== url && now - entry.createdAt > ttl) { drop(key); expired++; }
  }
  if (expired > 0) {
    stats.evictedExpired += expired;
    console.log(`📦 NZB cache: swept ${expired} expired entry(ies)`);
  }

  // Still over budget: least-recently-used, so a payload that was just
  // verified or just served is the last thing to go.
  if (totalBytes > maxBytes()) {
    const byLru = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let evicted = 0;
    for (const [key] of byLru) {
      if (totalBytes <= maxBytes()) break;
      if (key === url) continue; // never evict what we just stored
      drop(key);
      evicted++;
    }
    if (evicted > 0) {
      stats.evictedBudget += evicted;
      console.log(`📦 NZB cache: evicted ${evicted} entry(ies) to stay under ${(maxBytes() / 1048576).toFixed(0)}MB (${cache.size} cached, ${(totalBytes / 1048576).toFixed(1)}MB)`);
    }
  }
}

/** Retrieve cached NZB content, or undefined if expired/missing. */
export function getCachedNzbContent(url: string): string | undefined {
  const entry = cache.get(url);
  if (!entry) {
    stats.misses++;
    return undefined;
  }
  if (Date.now() - entry.createdAt > ttlMs()) {
    drop(url);
    stats.misses++;
    stats.expiredOnRead++;
    return undefined;
  }
  entry.lastUsed = Date.now();
  stats.hits++;
  return entry.content;
}

/**
 * Cache counters for diagnostics. Hit rate is the number that matters: a low
 * rate alongside repeated indexer fetches means retention is still too short
 * or a write path is missing.
 */
export function getNzbCacheStats(): {
  entries: number;
  bytes: number;
  megabytes: number;
  ttlHours: number;
  budgetMegabytes: number;
  hits: number;
  misses: number;
  hitRate: number;
  expiredOnRead: number;
  evictedExpired: number;
  evictedBudget: number;
  skippedTooLarge: number;
  stored: number;
} {
  const reads = stats.hits + stats.misses;
  return {
    entries: cache.size,
    bytes: totalBytes,
    megabytes: Number((totalBytes / 1048576).toFixed(2)),
    ttlHours: Number((ttlMs() / 3600000).toFixed(2)),
    budgetMegabytes: Number((maxBytes() / 1048576).toFixed(0)),
    hits: stats.hits,
    misses: stats.misses,
    hitRate: reads > 0 ? Number((stats.hits / reads).toFixed(3)) : 0,
    expiredOnRead: stats.expiredOnRead,
    evictedExpired: stats.evictedExpired,
    evictedBudget: stats.evictedBudget,
    skippedTooLarge: stats.skippedTooLarge,
    stored: stats.stored,
  };
}

/** Drop everything. Exposed for diagnostics/manual reset only. */
export function clearNzbContentCache(): number {
  const n = cache.size;
  cache.clear();
  totalBytes = 0;
  return n;
}
