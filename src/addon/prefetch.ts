import { config } from '../config/index.js';

// Set on the requests we send ourselves, so a prefetch never schedules another prefetch.
export const PREFETCH_HEADER = 'x-uu-prefetch';

const PREFETCH_TIMEOUT_MS = 120_000;
const MAX_TRACKED = 5000;

// Last time each manifest + episode was prefetched; a repeat inside the cache TTL is skipped.
const lastPrefetched = new Map<string, number>();
// One prefetch at a time, so binge-watching never fans out indexer searches.
let queue: Promise<void> = Promise.resolve();

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
