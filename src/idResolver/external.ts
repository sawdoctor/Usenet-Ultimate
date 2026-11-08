import axios from 'axios';
import { idCache } from './idCache.js';
import { resolveTmdbId } from './tmdb.js';
import { resolveTvdbId } from './tvdbSearch.js';

/**
 * Resolve an IMDB ID to an external service ID for use as a Newznab search parameter.
 * Returns { idParam, idValue } on success, or null on failure (caller should fall back to IMDB).
 */
export async function resolveExternalId(
  imdbId: string,
  type: 'movie' | 'series',
  targetService: 'tmdb' | 'tvdb' | 'tvmaze'
): Promise<{ idParam: string; idValue: string } | null> {
  const cacheKey = `id:${imdbId}:${targetService}`;
  const cached = idCache.get<{ idParam: string; idValue: string }>(cacheKey);
  if (cached) {
    console.log(`🔗 ID cache hit: ${imdbId} → ${targetService} = ${cached.idValue}`);
    return cached;
  }

  try {
    let result: { idParam: string; idValue: string } | null = null;

    switch (targetService) {
      case 'tmdb':
        result = await resolveTmdbId(imdbId, type);
        break;
      case 'tvdb':
        result = await resolveTvdbId(imdbId, type);
        break;
      case 'tvmaze':
        result = await resolveTvmazeId(imdbId);
        break;
    }

    if (result) {
      idCache.set(cacheKey, result);
      console.log(`🔗 Resolved ${imdbId} → ${targetService} = ${result.idValue}`);
    }

    return result;
  } catch (error) {
    console.warn(`⚠️  Failed to resolve ${targetService} ID for ${imdbId}:`, (error as Error).message);
    return null;
  }
}

/**
 * TVmaze: Lookup by IMDB ID (free, no auth needed)
 * GET https://api.tvmaze.com/lookup/shows?imdb={imdb_id}
 */
async function resolveTvmazeId(
  imdbId: string
): Promise<{ idParam: string; idValue: string } | null> {
  const response = await axios.get('https://api.tvmaze.com/lookup/shows', {
    params: { imdb: imdbId },
    timeout: 5000,
  });

  const tvmazeId = response.data?.id;
  if (tvmazeId) {
    return { idParam: 'tvmazeid', idValue: tvmazeId.toString() };
  }

  console.warn(`⚠️  No TVmaze result found for ${imdbId}`);
  return null;
}
