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
// One prefetch at a time, so binge-watching never fans out indexer searches.
let queue: Promise<void> = Promise.resolve();

// Last time each manifest + season was warmed; a repeat inside the cache TTL is skipped.
const warmedSeasons = new Map<string, number>();

const SERIES_EPISODE_ID = /^(tt\d+):(\d+):(\d+)$/;

/** Stream URL for the episode after `id`, or undefined for ids that are not IMDb series episodes. */
export function nextEpisodeUrl(baseUrl: string, pathPrefix: string, manifestKey: string, id: string): string | undefined {
  const match = SERIES_EPISODE_ID.exec(id);
  if (!match) return undefined;
  const [, imdbId, season, episode] = match;
  return `${baseUrl}${pathPrefix}/${manifestKey}/stream/series/${imdbId}:${season}:${Number(episode) + 1}.json`;
}

/** Queue a search for `url` in the background. Results land in the normal search cache. */
export function schedulePrefetch(url: string): void {
  if (!config.cacheEnabled || !(config.cacheTTL > 0)) return;
  const now = Date.now();
  const last = lastPrefetched.get(url);
  if (last !== undefined && now - last < config.cacheTTL * 1000) return;
  if (lastPrefetched.size >= MAX_TRACKED) lastPrefetched.clear();
  lastPrefetched.set(url, now);
  queue = queue.then(() => runPrefetch(url));
}

async function runPrefetch(url: string): Promise<void> {
  try {
    const res = await fetch(url, {
      headers: { [PREFETCH_HEADER]: '1' },
      signal: AbortSignal.timeout(PREFETCH_TIMEOUT_MS),
    });
    await res.arrayBuffer();
    console.log(`⏭️  Prefetched next episode (${res.status})`);
  } catch (err) {
    console.warn(`⏭️  Prefetch failed: ${(err as Error).message}`);
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
  return numbers.map(n => `${baseUrl}${pathPrefix}/${manifestKey}/stream/series/${imdbId}:${season}:${n}.json`);
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
