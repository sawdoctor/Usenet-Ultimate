import axios from 'axios';
import { config } from '../config/index.js';
import { idCache } from './idCache.js';
import { fetchTvdbTranslation, getTvdbToken } from './tvdbSearch.js';

// Slim TVDB record fetched by numeric ID. Used by the tvdb: Stremio prefix path
// where there's no IMDB id to drive the /search/remoteid lookup that findOnTvdb
// performs. Only the fields downstream callers actually use are included.
interface TvdbRecord {
  title: string;
  year?: string;
  aliases?: string[];
  nativeTitle?: string;
  runtime?: number; // movies only; series runtime comes via episode data
}

// Dedup concurrent fetches for the same TVDB record. TVDB id namespaces are
// disjoint between movies and series, so keying by numeric id alone is safe.
const inFlightExtendedFetches = new Map<number, Promise<TvdbRecord | null>>();

/**
 * Fetch a TVDB record by numeric ID via /v4/{type}/{id}/extended. Distinct
 * from findOnTvdb(), which searches by IMDB remoteid. Drives the tvdb:
 * Stremio prefix path that arrives without an IMDB id.
 *
 * Cached for 24h (idCache default). Concurrent fetches for the same id share
 * a single in-flight promise.
 */
export async function fetchTvdbRecordById(
  tvdbId: number,
  type: 'movie' | 'series'
): Promise<TvdbRecord | null> {
  const cacheKey = `tvdb:record:${type}:${tvdbId}`;
  const cached = idCache.get<TvdbRecord>(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const apiKey = config.searchConfig?.tvdbApiKey;
  if (!apiKey) return null;

  const existing = inFlightExtendedFetches.get(tvdbId);
  if (existing) return existing;

  const promise = (async (): Promise<TvdbRecord | null> => {
    const pathSegment = type === 'movie' ? 'movies' : 'series';
    const url = `https://api4.thetvdb.com/v4/${pathSegment}/${tvdbId}/extended`;

    const doFetch = async (token: string): Promise<TvdbRecord | null> => {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      });

      const data = response.data?.data;
      if (!data || typeof data !== 'object') return null;

      const rawTitle: string | undefined = typeof data.name === 'string' ? data.name : undefined;
      if (!rawTitle) {
        console.warn(`⚠️  TVDB record has no name: ${type} id=${tvdbId}`);
        return null;
      }

      const year: string | undefined = data.year
        ? String(data.year)
        : (typeof data.firstAired === 'string' ? data.firstAired.match(/^\d{4}/)?.[0] : undefined);

      // Scan remoteIds for an IMDB mapping. Log inline only; nothing depends
      // on it. Strict regex ensures we don't accept malformed strings.
      let foundImdb: string | undefined;
      const remoteIds = Array.isArray(data.remoteIds) ? data.remoteIds : [];
      for (const entry of remoteIds) {
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.sourceName !== 'string' || entry.sourceName !== 'IMDB') continue;
        if (typeof entry.id !== 'string' || !/^tt\d+$/.test(entry.id)) continue;
        foundImdb = entry.id;
        break;
      }

      // English-translation substitution. Mirrors the logic in findOnTvdb so
      // a non-English canonical title is replaced with the English form when
      // available, and the original is retained as nativeTitle.
      let title = rawTitle;
      let nativeTitle: string | undefined;
      const originalLang: string | undefined = typeof data.originalLanguage === 'string' ? data.originalLanguage : undefined;
      const nameTranslations: string[] = Array.isArray(data.nameTranslations) ? data.nameTranslations : [];
      const preferEnglish = config.searchConfig?.tvdbPreferEnglishTitle ?? true;
      if (preferEnglish && originalLang && originalLang !== 'eng' && nameTranslations.includes('eng')) {
        const englishTitle = await fetchTvdbTranslation(tvdbId, type, 'eng', token);
        if (englishTitle && englishTitle !== title) {
          console.log(`\u{1F310} TVDB translation: ${type} id=${tvdbId} "${title}" [${originalLang}] → "${englishTitle}" [eng]`);
          nativeTitle = title;
          title = englishTitle;
        }
      }

      // English aliases. Same dedup + normalize approach as findOnTvdb.
      const titleNorm = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const aliasSet = new Set<string>();
      const aliases: string[] = [];
      if (Array.isArray(data.aliases)) {
        for (const entry of data.aliases) {
          if (!entry || typeof entry !== 'object') continue;
          if (typeof entry.language !== 'string' || entry.language !== 'eng') continue;
          if (typeof entry.name !== 'string' || entry.name.length === 0) continue;
          const norm = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (norm.length === 0 || norm === titleNorm || aliasSet.has(norm)) continue;
          aliasSet.add(norm);
          aliases.push(entry.name);
        }
      }

      let runtime: number | undefined;
      if (type === 'movie' && typeof data.runtime === 'number' && data.runtime > 0) {
        runtime = data.runtime * 60; // minutes → seconds
      }

      const record: TvdbRecord = {
        title,
        year,
        aliases: aliases.length ? aliases : undefined,
        nativeTitle,
        runtime,
      };

      console.log(`🆔  TVDB record: ${type} id=${tvdbId} name="${title}"${year ? ` (${year})` : ''}${foundImdb ? ` [imdb=${foundImdb}]` : ''}${aliases.length ? ` aliases=${aliases.length}` : ''}`);
      return record;
    };

    // First attempt; refresh token on 401 and retry once.
    let token = await getTvdbToken();
    if (!token) return null;

    let result: TvdbRecord | null = null;
    try {
      result = await doFetch(token);
    } catch (error: any) {
      const status = error.response?.status;
      if (status === 404) {
        console.warn(`⚠️  TVDB record not found: ${type} id=${tvdbId} (404)`);
        return null;
      }
      if (status === 401) {
        console.log('🔗 TVDB token expired, refreshing...');
        idCache.del('tvdb:token');
        const newToken = await getTvdbToken();
        if (newToken) {
          try {
            result = await doFetch(newToken);
          } catch (retryError: any) {
            const retryStatus = retryError.response?.status;
            if (retryStatus === 404) {
              console.warn(`⚠️  TVDB record not found: ${type} id=${tvdbId} (404)`);
              return null;
            }
            const body = retryError.response?.data ? JSON.stringify(retryError.response.data).substring(0, 200) : '';
            console.warn(`⚠️  TVDB record error: ${retryStatus || (retryError as Error).message}${body ? ' ' + body : ''}`);
            return null;
          }
        } else {
          return null;
        }
      } else {
        const body = error.response?.data ? JSON.stringify(error.response.data).substring(0, 200) : '';
        console.warn(`⚠️  TVDB record error: ${status || (error as Error).message}${body ? ' ' + body : ''}`);
        return null;
      }
    }

    // Cache then signal to other in-flight joiners via the finally below. Order
    // matters: setting the cache before clearing the in-flight slot ensures any
    // late joiner that misses the in-flight Map can still hit the cache.
    if (result) idCache.set(cacheKey, result);
    return result;
  })().finally(() => {
    inFlightExtendedFetches.delete(tvdbId);
  });

  inFlightExtendedFetches.set(tvdbId, promise);
  return promise;
}
