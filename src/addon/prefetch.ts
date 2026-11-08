import { config } from '../config/index.js';
import { cache } from './searchResultCache.js';
import { buildSearchCacheKey } from './index.js';

// Set on the requests we send ourselves, so a prefetch never schedules another prefetch.
export const PREFETCH_HEADER = 'x-uu-prefetch';

const PREFETCH_TIMEOUT_MS = 120_000;
const MAX_TRACKED = 5000;
const MAX_WARMED_EPISODES = 60;

// Last time each manifest + episode was prefetched; a repeat inside the cache TTL is skipped.
const lastPrefetched = new Map<string, number>();
// One background search at a time, so binge-watching never fans out indexer searches; refreshes go before prefetches.
const refreshes: string[] = [];
const prefetches: string[] = [];
let draining = false;
// Refreshes waiting or running; a stale entry opened twice is searched once.
const queuedRefreshes = new Set<string>();

// Last time each manifest + season was warmed; a repeat inside the cache TTL is skipped.
const warmedSeasons = new Map<string, number>();

const SERIES_EPISODE_ID = /^(tt\d+):(\d+):(\d+)$/;

export function streamUrl(baseUrl: string, pathPrefix: string, manifestKey: string, type: string, id: string): string {
  return `${baseUrl}${pathPrefix}/${manifestKey}/stream/${type}/${id}.json`;
}

/** Stream URL for the episode after `id`, or undefined for ids that are not IMDb series episodes. */
export function nextEpisodeUrl(baseUrl: string, pathPrefix: string, manifestKey: string, id: string): string | undefined {
  const match = SERIES_EPISODE_ID.exec(id);
  if (!match) return undefined;
  const [, imdbId, season, episode] = match;
  return streamUrl(baseUrl, pathPrefix, manifestKey, 'series', `${imdbId}:${season}:${Number(episode) + 1}`);
}

/** Queue a search for `url` in the background. Results land in the normal search cache. */
export function schedulePrefetch(url: string): void {
  if (!config.cacheEnabled || !(config.cacheTTL > 0)) return;
  const now = Date.now();
  const last = lastPrefetched.get(url);
  if (last !== undefined && now - last < config.cacheTTL * 1000) return;
  if (lastPrefetched.size >= MAX_TRACKED) lastPrefetched.clear();
  lastPrefetched.set(url, now);
  prefetches.push(url);
  void drain();
}

/** Queue a fresh search for `url`, whose stale cached results were just served. */
export function scheduleRefresh(url: string): void {
  if (queuedRefreshes.has(url)) return;
  queuedRefreshes.add(url);
  refreshes.push(url);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  for (;;) {
    const refresh = refreshes.shift();
    const url = refresh ?? prefetches.shift();
    if (!url) break;
    await runPrefetch(url, refresh ? 'Refreshed stale results' : 'Prefetched next episode');
    if (refresh) queuedRefreshes.delete(refresh);
  }
  draining = false;
}

async function runPrefetch(url: string, label: string): Promise<void> {
  try {
    const res = await fetch(url, {
      headers: { [PREFETCH_HEADER]: '1' },
      signal: AbortSignal.timeout(PREFETCH_TIMEOUT_MS),
    });
    await res.arrayBuffer();
    console.log(`⏭️  ${label} (${res.status})`);
  } catch (err) {
    console.warn(`⏭️  ${label} failed: ${(err as Error).message}`);
  }
}

/** Stream URLs for every other episode of `id`'s season, in watch order: later episodes first, then earlier ones. */
export function seasonWarmUrls(baseUrl: string, pathPrefix: string, manifestKey: string, id: string, episodesInSeason: number): string[] {
  const match = SERIES_EPISODE_ID.exec(id);
  if (!match || !(episodesInSeason > 1)) return [];
  const [, imdbId, season, episode] = match;
  const current = Number(episode);
  const total = Math.min(episodesInSeason, MAX_WARMED_EPISODES);
  const numbers: number[] = [];
  for (let n = current + 1; n <= total; n++) numbers.push(n);
  for (let n = 1; n < current && n <= total; n++) numbers.push(n);
  return numbers.map(n => streamUrl(baseUrl, pathPrefix, manifestKey, 'series', `${imdbId}:${season}:${n}`));
}

/** After a series episode is searched, queue background searches for the rest of its season so later episodes open from the cache. */
export function warmSeason(baseUrl: string, pathPrefix: string, manifestKey: string, type: string, id: string): void {
  if (!config.cacheEnabled || !(config.cacheTTL > 0)) return;
  const episodesInSeason = cache.get(buildSearchCacheKey(manifestKey, type, id, config))?._meta.episodesInSeason;
  if (!episodesInSeason) return;
  const seasonKey = `${manifestKey}:${id.split(':').slice(0, 2).join(':')}`;
  const now = Date.now();
  const last = warmedSeasons.get(seasonKey);
  if (last !== undefined && now - last < config.cacheTTL * 1000) return;
  if (warmedSeasons.size >= MAX_TRACKED) warmedSeasons.clear();
  warmedSeasons.set(seasonKey, now);
  for (const url of seasonWarmUrls(baseUrl, pathPrefix, manifestKey, id, episodesInSeason)) schedulePrefetch(url);
}
