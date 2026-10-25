import axios from 'axios';
import { config } from '../config/index.js';
import { cachedRemoteSearch, idCache } from './idCache.js';

/**
 * Detect if a TV show has a remake/reboot by searching TVDB for shows with the same title.
 * Returns true if 2+ results share the same normalized title with different years.
 * Cached for 24 hours since remake status doesn't change.
 * Falls back to false if TVDB key is not configured (year-only filtering still applies).
 */
export async function detectRemake(title: string): Promise<boolean> {
  const cacheKey = `remake:${title.toLowerCase()}`;
  const cached = idCache.get<{ remake: boolean; years?: string[] }>(cacheKey);
  if (cached !== undefined) {
    if (cached.remake) console.log(`🔄 Remake detected for "${title}": ${cached.years?.join(', ') ?? '?'} (cached)`);
    return cached.remake;
  }

  const token = await getTvdbToken();
  if (!token) return false;

  try {
    const response = await axios.get('https://api4.thetvdb.com/v4/search', {
      params: { query: title, type: 'series' },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    });

    const results = response.data?.data;
    if (!Array.isArray(results) || results.length < 2) {
      idCache.set(cacheKey, { remake: false });
      return false;
    }

    // Check if 2+ results share the same normalized title but have different years.
    // Strip parenthetical year suffixes like "(2003)" since TVDB often appends these to remakes.
    // Compare against translations.eng when present so non-English-primary shows
    // (e.g. anime returned under their Japanese name) match the English query title.
    const stripYearSuffix = (s: string) => s.replace(/\s*\(\d{4}\)\s*$/, '');
    const norm = (s: string) => stripYearSuffix(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedTarget = norm(title);
    const matchingShows = results.filter((r: any) => {
      const eng = (r.translations && typeof r.translations.eng === 'string' && r.translations.eng) || r.name || '';
      return norm(eng) === normalizedTarget;
    });

    if (matchingShows.length >= 2) {
      const years = [...new Set(matchingShows.map((r: any) => r.year).filter(Boolean))].sort() as string[];
      if (years.length >= 2) {
        console.log(`🔄 Remake detected for "${title}": ${years.join(', ')}`);
        idCache.set(cacheKey, { remake: true, years });
        return true;
      }
    }

    idCache.set(cacheKey, { remake: false });
    return false;
  } catch (error) {
    console.warn(`⚠️  Remake detection failed for "${title}":`, (error as Error).message);
    return false;
  }
}

/**
 * Shared TVDB /search/remoteid lookup — returns both the numeric ID and the canonical title.
 * Used by resolveTvdbId() (for ID resolution) and resolveTitleFromTvdb() (for title resolution).
 * Requires bearer token auth.
 */
export function findOnTvdb(imdbId: string, type: 'movie' | 'series') {
  return cachedRemoteSearch(`search:tvdb:${type}:${imdbId}`, () => searchTvdb(imdbId, type));
}

async function searchTvdb(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ id: number; title: string; year?: string; aliases?: string[]; nativeTitle?: string } | null> {
  const tvdbType = type === 'movie' ? 'movie' : 'series';

  const doSearch = async (token: string): Promise<{ id: number; title: string; year?: string; aliases?: string[]; nativeTitle?: string } | null> => {
    const response = await axios.get(`https://api4.thetvdb.com/v4/search/remoteid/${imdbId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    });

    const results = response.data?.data;
    if (results?.length > 0) {
      // /search/remoteid returns objects with typed fields: { series, movie, people, episode, company }
      for (const result of results) {
        const record = result[tvdbType];
        if (record?.id) {
          const year = record.year ? String(record.year) : record.firstAired?.match(/^\d{4}/)?.[0];
          let title: string = record.name || '';
          const originalLang: string | undefined = record.originalLanguage;
          const nameTranslations: string[] = Array.isArray(record.nameTranslations) ? record.nameTranslations : [];
          // Substitute the English translation when TVDB's canonical title is in
          // a non-English language and an English translation exists. Release
          // groups publish in English regardless of the show's original locale,
          // so feeding the foreign-language canonical name into Newznab text
          // search produces zero hits. Gated by searchConfig.tvdbPreferEnglishTitle.
          // Translation 401 silently degrades to the original name; the next
          // search refreshes the token via the existing retry path.
          const preferEnglish = config.searchConfig?.tvdbPreferEnglishTitle ?? true;
          // When force-English replaces the canonical title, retain the original
          // (native-language) form so callers can search both translations in
          // parallel via parallelAlternateTitleSearch. Only set when an actual
          // substitution occurred and the two strings differ.
          let nativeTitle: string | undefined;
          if (preferEnglish && title && originalLang && originalLang !== 'eng' && nameTranslations.includes('eng')) {
            const englishTitle = await fetchTvdbTranslation(record.id, tvdbType, 'eng', token);
            if (englishTitle && englishTitle !== title) {
              console.log(`\u{1F310} TVDB translation: ${tvdbType} id=${record.id} "${title}" [${originalLang}] → "${englishTitle}" [eng]`);
              nativeTitle = title;
              title = englishTitle;
            }
          }
          // Collect English aliases for the zero-result alias-fallback path.
          // Filter is intentionally permissive here (any well-formed eng entry
          // not equal to the resolved title); the substring + length-ratio
          // shape filter is applied downstream in titleResolver so this layer
          // keeps the raw candidate list available for callers that may want it.
          const titleNorm = title.toLowerCase().replace(/[^a-z0-9]/g, '');
          const aliasSet = new Set<string>();
          const aliases: string[] = [];
          if (Array.isArray(record.aliases)) {
            for (const entry of record.aliases) {
              if (!entry || typeof entry !== 'object') continue;
              if (typeof entry.language !== 'string' || entry.language !== 'eng') continue;
              if (typeof entry.name !== 'string' || entry.name.length === 0) continue;
              const norm = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (norm.length === 0 || norm === titleNorm || aliasSet.has(norm)) continue;
              aliasSet.add(norm);
              aliases.push(entry.name);
            }
          }
          console.log(`🔗 TVDB remoteid result: ${tvdbType} id=${record.id} name="${title || 'unknown'}"${year ? ` (${year})` : ''}${aliases.length ? ` aliases=${aliases.length}` : ''}`);
          return { id: record.id, title, year, aliases: aliases.length ? aliases : undefined, nativeTitle };
        }
      }
    }
    return null;
  };

  // First attempt with current token
  let token = await getTvdbToken();
  if (!token) return null;

  try {
    const result = await doSearch(token);
    if (result) return result;
  } catch (error: any) {
    // If 401 (expired token), clear cache and retry with fresh token
    if (error.response?.status === 401) {
      console.log('🔗 TVDB token expired, refreshing...');
      idCache.del('tvdb:token');
      const newToken = await getTvdbToken();
      if (newToken) {
        try {
          const result = await doSearch(newToken);
          if (result) return result;
        } catch (retryError) {
          console.warn('⚠️  TVDB retry failed:', (retryError as Error).message);
        }
      }
    } else {
      const body = error.response?.data ? JSON.stringify(error.response.data).substring(0, 200) : '';
      console.warn(`⚠️  TVDB search error: ${error.response?.status || error.message}${body ? ' ' + body : ''}`);
    }
  }

  console.warn(`⚠️  No TVDB ${type} result found for ${imdbId}`);
  return null;
}

/**
 * Fetch a localized title for a TVDB record from `/translations/{lang}`.
 * Caches both successful lookups and known-empty translations (negative cache
 * via empty-string sentinel) so repeated searches don't repeatedly hit a 404
 * for shows whose `nameTranslations` claims a translation exists but the
 * detail endpoint returns nothing.
 */
export async function fetchTvdbTranslation(
  id: number,
  type: 'movie' | 'series' | 'episode',
  lang: string,
  token: string,
): Promise<string | null> {
  const cacheKey = `tvdb:translation:${type}:${id}:${lang}`;
  const cached = idCache.get<string>(cacheKey);
  if (cached !== undefined) return cached || null;

  const pathSegment = type === 'movie' ? 'movies' : type === 'episode' ? 'episodes' : 'series';
  try {
    const response = await axios.get(
      `https://api4.thetvdb.com/v4/${pathSegment}/${id}/translations/${lang}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 },
    );
    const name = response.data?.data?.name;
    if (typeof name === 'string' && name.length > 0) {
      idCache.set(cacheKey, name);
      return name;
    }
  } catch (error: any) {
    if (error.response?.status !== 404) {
      console.warn(`⚠️  TVDB translation lookup failed for ${type} ${id}/${lang}: ${error.response?.status || error.message}`);
    }
  }
  idCache.set(cacheKey, '');
  return null;
}

/**
 * TVDB: Search by remote IMDB ID — returns the numeric TVDB ID for Newznab search params.
 * Also caches the canonical title as a side effect for resolveTitleFromTvdb().
 */
export async function resolveTvdbId(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ idParam: string; idValue: string } | null> {
  const result = await findOnTvdb(imdbId, type);
  if (!result) return null;

  // Cache the canonical title and year as side effects
  if (result.title) {
    idCache.set(`title:${imdbId}`, result.title);
  }
  if (result.year) {
    idCache.set(`year:tvdb:${imdbId}`, result.year);
  }

  return { idParam: 'tvdbid', idValue: result.id.toString() };
}

/**
 * Resolve the canonical title for an IMDB ID via TVDB.
 * Primarily used for TV shows where TVDB titles closely match what release groups use.
 *
 * If resolveTvdbId() was already called (for ID-based search), the title will be
 * in cache and this returns instantly with no extra API call.
 *
 * Returns null if TVDB API key isn't configured or the lookup fails.
 */
export async function resolveTitleFromTvdb(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<{ title: string; year?: string; aliases?: string[]; nativeTitle?: string } | null> {
  const titleCacheKey = `title:${imdbId}`;
  const aliasesCacheKey = `aliases:tvdb:${imdbId}`;
  const nativeTitleCacheKey = `nativeTitle:tvdb:${imdbId}`;
  const cached = idCache.get<string>(titleCacheKey);
  if (cached) {
    const cachedYear = idCache.get<string>(`year:tvdb:${imdbId}`);
    const cachedAliases = idCache.get<string[]>(aliasesCacheKey);
    const cachedNative = idCache.get<string>(nativeTitleCacheKey);
    console.log(`🎯 TVDB title cache hit: ${imdbId} → "${cached}"`);
    return { title: cached, year: cachedYear, aliases: cachedAliases, nativeTitle: cachedNative || undefined };
  }

  const apiKey = config.searchConfig?.tvdbApiKey;
  if (!apiKey) return null;

  try {
    const result = await findOnTvdb(imdbId, type);
    if (!result?.title) return null;

    idCache.set(titleCacheKey, result.title);
    if (result.year) {
      idCache.set(`year:tvdb:${imdbId}`, result.year);
    }
    // Cache aliases (or empty array sentinel so we don't refetch on miss).
    idCache.set(aliasesCacheKey, result.aliases ?? []);
    // Cache native title (empty-string sentinel for known-no-substitution).
    idCache.set(nativeTitleCacheKey, result.nativeTitle ?? '');

    // Also cache the ID as a bonus
    const idCacheKey = `id:${imdbId}:tvdb`;
    if (!idCache.has(idCacheKey)) {
      idCache.set(idCacheKey, { idParam: 'tvdbid', idValue: result.id.toString() });
    }

    console.log(`🎯 TVDB title resolved: ${imdbId} → "${result.title}"`);
    return { title: result.title, year: result.year, aliases: result.aliases, nativeTitle: result.nativeTitle };
  } catch (error) {
    console.warn(`⚠️  Failed to resolve TVDB title for ${imdbId}:`, (error as Error).message);
    return null;
  }
}

/**
 * Synchronous title lookup from the in-process cache. Returns the cached
 * TVDB title for the given IMDB ID, or the TMDB-cached fallback. Returns
 * undefined on cache miss; never makes API calls. Intended for runtime
 * recovery paths that need a title quickly without blocking on network.
 */
export function getCachedTitleByImdb(imdbId: string): string | undefined {
  return idCache.get<string>(`title:${imdbId}`)
    ?? idCache.get<string>(`title:tmdb:${imdbId}`);
}

/**
 * Clear the cached TVDB bearer token. Called when the user changes their TVDB
 * API key so the next request re-authenticates with the new key instead of
 * using the stale token issued for the old key.
 */
export function clearTvdbToken(): void {
  idCache.del('tvdb:token');
}

/**
 * Clear cached TVDB-derived titles and translation lookups. Called when the
 * `tvdbPreferEnglishTitle` toggle flips so the next search re-resolves the
 * canonical title under the new preference instead of returning a stale
 * cache entry from the previous setting. Leaves TMDB title caches alone
 * (different namespace) and the bearer token alone.
 */
export function clearTvdbTitleCache(): void {
  const keys = idCache.keys();
  let count = 0;
  for (const k of keys) {
    if ((k.startsWith('title:') && !k.startsWith('title:tmdb:')) || k.startsWith('tvdb:translation:') || k.startsWith('aliases:tvdb:') || k.startsWith('nativeTitle:tvdb:')) {
      idCache.del(k);
      count++;
    }
  }
  console.log(`🔗 TVDB title cache cleared (${count} entries)`);
}

// Concurrent 401-retry sites all clear and re-fetch the token. Without dedup,
// each fires its own login. One shared promise across callers prevents the
// duplicate-login race.
let inFlightTokenRefresh: Promise<string | null> | null = null;

/**
 * Get a TVDB bearer token, cached for 23 hours. Concurrent callers share a
 * single in-flight login when the cache is empty.
 */
export async function getTvdbToken(): Promise<string | null> {
  const cached = idCache.get<string>('tvdb:token');
  if (cached) {
    console.log('🔗 Using cached TVDB token');
    return cached;
  }

  if (inFlightTokenRefresh) {
    return inFlightTokenRefresh;
  }

  inFlightTokenRefresh = (async (): Promise<string | null> => {
    const apiKey = config.searchConfig?.tvdbApiKey;
    if (!apiKey) {
      console.warn('⚠️  TVDB API key not configured');
      return null;
    }

    try {
      console.log('🔗 Requesting new TVDB token...');
      const response = await axios.post('https://api4.thetvdb.com/v4/login', {
        apikey: apiKey,
      }, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' },
      });

      const token = response.data?.data?.token;
      if (token) {
        idCache.set('tvdb:token', token, 82800); // 23 hours
        console.log('🔗 TVDB token obtained successfully');
        return token;
      }
      console.warn('⚠️  TVDB login response missing token:', JSON.stringify(response.data).substring(0, 200));
    } catch (error: any) {
      const status = error.response?.status;
      const msg = error.response?.data ? JSON.stringify(error.response.data).substring(0, 200) : (error as Error).message;
      console.warn(`⚠️  Failed to authenticate with TVDB (${status || 'network error'}):`, msg);
    }

    return null;
  })().finally(() => {
    inFlightTokenRefresh = null;
  });

  return inFlightTokenRefresh;
}
