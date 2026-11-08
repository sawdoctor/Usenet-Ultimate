const STALE_SERVE_SECONDS = 24 * 60 * 60;
const RECENT_RELEASE_MS = 7 * 24 * 60 * 60 * 1000;

export type CacheFreshness = 'fresh' | 'stale' | 'expired';

/** How long a cached search is kept: the TTL, or the one-day stale window when that is longer. */
export function cacheRetentionSeconds(ttlSeconds: number): number {
  return Math.max(ttlSeconds, STALE_SERVE_SECONDS);
}

/**
 * Fresh inside the TTL. Past it, a search for something released over a week ago is
 * stale (serve it, then search again in the background) until the retention ends.
 * A recent or undated release is expired instead, so new uploads show on the first open.
 */
export function cacheFreshness(cachedAt: number | undefined, releasedAt: string | undefined, ttlSeconds: number, now: number): CacheFreshness {
  if (cachedAt === undefined) return 'fresh';
  const ageMs = now - cachedAt;
  if (ageMs <= ttlSeconds * 1000) return 'fresh';
  if (ageMs > cacheRetentionSeconds(ttlSeconds) * 1000) return 'expired';
  const releasedMs = releasedAt ? Date.parse(releasedAt) : NaN;
  if (!Number.isFinite(releasedMs) || now - releasedMs < RECENT_RELEASE_MS) return 'expired';
  return 'stale';
}
