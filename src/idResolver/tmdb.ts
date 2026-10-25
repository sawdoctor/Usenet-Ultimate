import axios from 'axios';
import { config } from '../config/index.js';
import { idCache } from './idCache.js';

/**
 * Shared TMDB /find lookup — returns both the numeric ID and the canonical title.
 * Used by resolveTmdbId() (for ID resolution) and resolveTitleFromTmdb() (for title resolution).
 */
async function findOnTmdb(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ id: number; title: string; year?: string } | null> {
  const apiKey = config.searchConfig?.tmdbApiKey;
  if (!apiKey) {
    console.warn('⚠️  TMDB API key not configured');
    return null;
  }

  // Detect v4 Read Access Token (JWT format, long) vs v3 API key (short hex)
  const isReadAccessToken = apiKey.length > 40 || apiKey.startsWith('eyJ');

  const response = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
    params: {
      external_source: 'imdb_id',
      ...(isReadAccessToken ? {} : { api_key: apiKey }),
    },
    headers: isReadAccessToken ? { Authorization: `Bearer ${apiKey}` } : {},
    timeout: 5000,
  });

  const data = response.data;

  if (type === 'movie' && data.movie_results?.length > 0) {
    const movie = data.movie_results[0];
    const year = movie.release_date?.match(/^\d{4}/)?.[0];
    return { id: movie.id, title: movie.title, year };
  } else if (type === 'series' && data.tv_results?.length > 0) {
    const show = data.tv_results[0];
    const year = show.first_air_date?.match(/^\d{4}/)?.[0];
    return { id: show.id, title: show.name, year };
  }

  console.warn(`⚠️  No TMDB ${type} result found for ${imdbId}`);
  return null;
}

/**
 * TMDB: Find by IMDB ID — returns the numeric TMDB ID for Newznab search params.
 * Also caches the canonical title as a side effect for resolveTitleFromTmdb().
 * Supports both v3 API key (query param) and v4 Read Access Token (Bearer header).
 */
export async function resolveTmdbId(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ idParam: string; idValue: string } | null> {
  const result = await findOnTmdb(imdbId, type);
  if (!result) return null;

  // Cache the canonical title and year as side effects (avoids a second API call in resolveTitleFromTmdb)
  if (result.title) {
    idCache.set(`title:tmdb:${imdbId}`, result.title);
  }
  if (result.year) {
    idCache.set(`year:tmdb:${imdbId}`, result.year);
  }

  return { idParam: 'tmdbid', idValue: result.id.toString() };
}

/**
 * Map a numeric TMDB id to its external ids (IMDB, plus TVDB for series) via
 * /3/{movie|tv}/{id}/external_ids. Drives the tmdb: Stremio prefix, which
 * delegates to the imdb or tvdb pipeline instead of resolving titles itself.
 * No 401-retry: TMDB v3 keys / v4 tokens do not expire mid-session like the
 * TVDB bearer token. v3 api_key vs v4 bearer detection mirrors findOnTmdb.
 */
export async function resolveTmdbExternalIds(
  tmdbId: number,
  type: 'movie' | 'series'
): Promise<{ imdbId?: string; tvdbId?: number } | null> {
  const cacheKey = `tmdb:external:${type}:${tmdbId}`;
  const cached = idCache.get<{ imdbId?: string; tvdbId?: number }>(cacheKey);
  if (cached !== undefined) return cached;

  const apiKey = config.searchConfig?.tmdbApiKey;
  if (!apiKey) return null;
  const isReadAccessToken = apiKey.length > 40 || apiKey.startsWith('eyJ');
  const pathSeg = type === 'movie' ? 'movie' : 'tv';

  try {
    const response = await axios.get(`https://api.themoviedb.org/3/${pathSeg}/${tmdbId}/external_ids`, {
      params: isReadAccessToken ? {} : { api_key: apiKey },
      headers: isReadAccessToken ? { Authorization: `Bearer ${apiKey}` } : {},
      timeout: 5000,
    });
    const data = response.data ?? {};
    const imdbId = typeof data.imdb_id === 'string' && /^tt\d+$/.test(data.imdb_id) ? data.imdb_id : undefined;
    const tvdbId = typeof data.tvdb_id === 'number' && data.tvdb_id > 0 ? data.tvdb_id : undefined;
    const result = { imdbId, tvdbId };
    // Cache only positive results. A record with no external ids is left
    // uncached so it is re-checked next request (TMDB may add an imdb id later).
    if (imdbId || tvdbId) idCache.set(cacheKey, result);
    console.log(`🆔 TMDB external ids: ${pathSeg} id=${tmdbId}${imdbId ? ` imdb=${imdbId}` : ''}${tvdbId ? ` tvdb=${tvdbId}` : ''}`);
    return result;
  } catch (error: any) {
    const status = error.response?.status;
    if (status === 404) {
      console.warn(`⚠️  TMDB record not found: ${pathSeg} id=${tmdbId} (404)`);
      return null;
    }
    console.warn(`⚠️  TMDB external-ids error: ${pathSeg} id=${tmdbId}: ${status || (error as Error).message}`);
    return null;
  }
}

/**
 * Resolve the canonical movie title for an IMDB ID via TMDB.
 * Stremio's Cinemeta sometimes returns truncated or incorrect titles
 * (e.g. truncated or missing subtitle portions of full titles).
 * TMDB titles match what release groups actually use, improving text search accuracy.
 * For TV shows, use resolveTitleFromTvdb() instead.
 *
 * If resolveTmdbId() was already called (for ID-based search), the title will be
 * in cache and this returns instantly with no extra API call.
 *
 * Returns null if TMDB API key isn't configured or the lookup fails.
 */
export async function resolveTitleFromTmdb(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ title: string; year?: string } | null> {
  const titleCacheKey = `title:tmdb:${imdbId}`;
  const cachedTitle = idCache.get<string>(titleCacheKey);
  if (cachedTitle) {
    const cachedYear = idCache.get<string>(`year:tmdb:${imdbId}`);
    console.log(`🎯 TMDB title cache hit: ${imdbId} → "${cachedTitle}"`);
    return { title: cachedTitle, year: cachedYear };
  }

  try {
    const result = await findOnTmdb(imdbId, type);
    if (!result?.title) return null;

    idCache.set(titleCacheKey, result.title);
    if (result.year) {
      idCache.set(`year:tmdb:${imdbId}`, result.year);
    }

    // Also cache the ID as a bonus (avoids a duplicate API call if ID resolution happens later)
    const idCacheKey = `id:${imdbId}:tmdb`;
    if (!idCache.has(idCacheKey)) {
      idCache.set(idCacheKey, { idParam: 'tmdbid', idValue: result.id.toString() });
    }

    console.log(`🎯 TMDB title resolved: ${imdbId} → "${result.title}"`);
    return { title: result.title, year: result.year };
  } catch (error) {
    console.warn(`⚠️  Failed to resolve TMDB title for ${imdbId}:`, (error as Error).message);
    return null;
  }
}

/**
 * Resolve movie runtime in seconds from TMDB detail endpoint.
 * Requires an extra API call to /3/movie/{id} since /find doesn't include runtime.
 * The same request also pulls release_dates (append_to_response), so it records the
 * premiere year (earliest release, when earlier than the theatrical date) under
 * `premiereYear:tmdb:{imdbId}` for getCachedPremiereYear to read.
 */
export async function resolveRuntimeFromTmdb(imdbId: string): Promise<number | undefined> {
  const cacheKey = `runtime:tmdb:${imdbId}`;
  const cached = idCache.get<number>(cacheKey);
  if (cached !== undefined) return cached;

  const apiKey = config.searchConfig?.tmdbApiKey;
  if (!apiKey) return undefined;

  try {
    // Get TMDB ID (likely already cached from title resolution)
    const tmdbResult = await findOnTmdb(imdbId, 'movie');
    if (!tmdbResult) return undefined;

    const isReadAccessToken = apiKey.length > 40 || apiKey.startsWith('eyJ');
    const response = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbResult.id}`, {
      params: {
        append_to_response: 'release_dates',
        ...(isReadAccessToken ? {} : { api_key: apiKey }),
      },
      headers: isReadAccessToken ? { Authorization: `Bearer ${apiKey}` } : {},
      timeout: 5000,
    });

    // Derive the premiere year:
    // The earliest release when it falls before the primary (theatrical) date.
    // The movie search-year resolver prefers it, since that is the year IMDB shows
    // and release groups tag. Stored under its own key for getCachedPremiereYear.
    const primaryYear = response.data?.release_date?.match(/^\d{4}/)?.[0];
    const regions = response.data?.release_dates?.results;
    if (primaryYear && Array.isArray(regions)) {
      let earliest: string | undefined;
      for (const region of regions) {
        if (!Array.isArray(region?.release_dates)) continue;
        for (const d of region.release_dates) {
          const rd = d?.release_date;
          if (typeof rd === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rd) && (!earliest || rd < earliest)) earliest = rd;
        }
      }
      const earliestYear = earliest?.slice(0, 4);
      if (earliestYear && earliestYear < primaryYear) {
        idCache.set(`premiereYear:tmdb:${imdbId}`, earliestYear);
      }
    }

    const runtime = response.data?.runtime;
    if (typeof runtime === 'number' && runtime > 0) {
      const seconds = runtime * 60;
      idCache.set(cacheKey, seconds);
      console.log(`🎯 TMDB runtime: ${imdbId} → ${runtime}min`);
      return seconds;
    }
  } catch (error) {
    console.warn(`⚠️  Failed to resolve TMDB runtime for ${imdbId}:`, (error as Error).message);
  }
  return undefined;
}

/**
 * Earliest-release ("premiere") year recorded by resolveRuntimeFromTmdb, set only
 * when it predates the primary/theatrical date. Used by the movie search-year
 * resolver to prefer the year IMDB shows. Returns undefined when there is no earlier release.
 */
export function getCachedPremiereYear(imdbId: string): string | undefined {
  return idCache.get<string>(`premiereYear:tmdb:${imdbId}`);
}
