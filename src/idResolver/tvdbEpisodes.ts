import axios from 'axios';
import { config } from '../config/index.js';
import { idCache } from './idCache.js';
import { fetchTvdbTranslation, findOnTvdb, getTvdbToken } from './tvdbSearch.js';

// ── Per-series TVDB episode cache ────────────────────────────────────
// One paginated all-episodes fetch per series populates seasonCounts (used for
// cumulative-episode math) and per-(season,episode) data (runtime, name,
// canonical absoluteNumber). Cache and Promise-dedup are keyed by TVDB numeric
// ID so the imdbId path and the direct-tvdbId path (used by anime requests
// without IMDB mappings) share the same cached data.
interface TvdbSeriesEpisodeData {
  seasonCounts: Record<number, number>;  // excludes S0 specials
  episodes: Record<number, Record<number, { id?: number; runtime?: number; name?: string; absoluteNumber?: number; nameTranslations?: string[]; aired?: string }>>;
}

// In-flight fetch deduplication: concurrent callers for the same TVDB ID
// share a single TVDB call. try/finally guarantees cleanup on every path
// (success, throw, cap hit) so future callers don't await a rejected promise.
const inFlightSeriesFetches = new Map<number, Promise<TvdbSeriesEpisodeData | undefined>>();

const TVDB_PAGINATION_CAP = 50;          // ~25K episodes worst case
const TVDB_PER_PAGE_TIMEOUT_MS = 5000;

interface SeriesEpisodeResult {
  count: number;
  runtime?: number;
  episodeName?: string;
  absoluteNumber?: number;
  priorSeasonsCount?: number;
  /** Air date of the targeted episode in `YYYY-MM-DD` form, when TVDB has it. Used by date-based query fallbacks. */
  episodeAired?: string;
}

/**
 * Fetch an entire series' episode list from TVDB by numeric series ID and
 * shape it into seasonCounts + per-(season,episode) data. Paginated via
 * links.next. On 401 mid-pagination, refreshes the token and retries the
 * failed page once; any other error aborts and returns undefined.
 */
async function fetchTvdbSeriesEpisodesByTvdbId(tvdbId: number, logLabel: string): Promise<TvdbSeriesEpisodeData | undefined> {
  let token = await getTvdbToken();
  if (!token) return undefined;

  const seasonCounts: Record<number, number> = {};
  const episodes: Record<number, Record<number, { runtime?: number; name?: string; absoluteNumber?: number }>> = {};
  let pageCount = 0;

  const baseUrl = `https://api4.thetvdb.com/v4/series/${tvdbId}/episodes/default`;
  let nextUrl: string | null = `${baseUrl}?page=0`;

  while (nextUrl) {
    if (pageCount >= TVDB_PAGINATION_CAP) {
      console.warn(`⚠️  TVDB episode pagination cap reached for ${logLabel} (${TVDB_PAGINATION_CAP} pages), falling through to Cinemeta`);
      return undefined;
    }

    let response: any;
    try {
      response = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: TVDB_PER_PAGE_TIMEOUT_MS,
      });
    } catch (error: any) {
      if (error.response?.status === 401) {
        // Token expired mid-pagination. Refresh and retry this page once.
        console.log('🔗 TVDB token expired mid-pagination, refreshing');
        idCache.del('tvdb:token');
        const fresh = await getTvdbToken();
        if (!fresh) return undefined;
        token = fresh;
        try {
          response = await axios.get(nextUrl, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: TVDB_PER_PAGE_TIMEOUT_MS,
          });
        } catch (retryError) {
          console.warn(`⚠️  TVDB episode fetch retry failed for ${logLabel}:`, (retryError as Error).message);
          return undefined;
        }
      } else {
        console.warn(`⚠️  TVDB episode fetch failed for ${logLabel} on page ${pageCount}:`, error.message);
        return undefined;
      }
    }

    const data = response.data?.data;
    if (!data || !Array.isArray(data.episodes)) {
      // Malformed page — abort rather than return partial data.
      return undefined;
    }

    for (const ep of data.episodes) {
      if (typeof ep.seasonNumber !== 'number' || ep.seasonNumber < 0) continue;
      if (typeof ep.number !== 'number' || ep.number <= 0) continue;
      // Per-episode entry is built for every aired season (including S0 specials)
      // so callers can still look up specials by name. seasonCounts excludes S0
      // because absolute numbering only counts aired episodes.
      const epEntry: { id?: number; runtime?: number; name?: string; absoluteNumber?: number; nameTranslations?: string[]; aired?: string } = {};
      if (typeof ep.id === 'number' && ep.id > 0) epEntry.id = ep.id;
      if (typeof ep.runtime === 'number' && ep.runtime > 0) epEntry.runtime = ep.runtime;
      if (typeof ep.name === 'string' && ep.name.length > 0) epEntry.name = ep.name;
      if (typeof ep.absoluteNumber === 'number' && ep.absoluteNumber > 0) epEntry.absoluteNumber = ep.absoluteNumber;
      if (Array.isArray(ep.nameTranslations)) {
        epEntry.nameTranslations = ep.nameTranslations.filter((s: any) => typeof s === 'string');
      }
      if (typeof ep.aired === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ep.aired)) {
        epEntry.aired = ep.aired.slice(0, 10);
      }
      if (!episodes[ep.seasonNumber]) episodes[ep.seasonNumber] = {};
      episodes[ep.seasonNumber][ep.number] = epEntry;
      if (ep.seasonNumber > 0) {
        seasonCounts[ep.seasonNumber] = (seasonCounts[ep.seasonNumber] ?? 0) + 1;
      }
    }

    pageCount++;
    const linksNext = response.data?.links?.next;
    nextUrl = typeof linksNext === 'string' && linksNext.length > 0 ? linksNext : null;
  }

  if (pageCount === 0 || Object.keys(seasonCounts).length === 0) {
    return undefined;
  }

  return { seasonCounts, episodes };
}

/**
 * Cache + Promise-dedup wrapper around fetchTvdbSeriesEpisodesByTvdbId.
 * Cache keyed by tvdbId so concurrent calls from the imdbId path and the
 * direct-tvdbId path share a single fetch when they target the same series.
 */
async function getOrFetchSeriesEpisodes(tvdbId: number, logLabel: string): Promise<TvdbSeriesEpisodeData | undefined> {
  const cacheKey = `tvdb:series:${tvdbId}`;
  const cached = idCache.get<TvdbSeriesEpisodeData>(cacheKey);
  if (cached !== undefined) return cached;

  let inflight = inFlightSeriesFetches.get(tvdbId);
  if (!inflight) {
    inflight = (async () => {
      try {
        const data = await fetchTvdbSeriesEpisodesByTvdbId(tvdbId, logLabel);
        if (data) idCache.set(cacheKey, data);
        return data;
      } finally {
        inFlightSeriesFetches.delete(tvdbId);
      }
    })();
    inFlightSeriesFetches.set(tvdbId, inflight);
  }
  return await inflight;
}

/**
 * Build the per-(season,episode) caller-facing result from cached series data.
 * When the targeted episode's name is non-Latin (e.g. anime returned under its
 * Japanese title) and an English translation is advertised, fetches the
 * English name so downstream remake-filter substring matching works against
 * the form release groups actually publish.
 */
async function buildSeasonResult(data: TvdbSeriesEpisodeData, season: number, episode?: number): Promise<SeriesEpisodeResult | undefined> {
  const count = data.seasonCounts[season] ?? 0;
  if (count === 0) return undefined;

  const seasonEps = data.episodes[season] ?? {};
  let runtime: number | undefined;
  let episodeName: string | undefined;
  let absoluteNumber: number | undefined;
  let episodeAired: string | undefined;
  if (episode !== undefined) {
    const targetEp = seasonEps[episode];
    if (targetEp?.runtime) runtime = targetEp.runtime * 60;
    if (targetEp?.name) episodeName = targetEp.name;
    if (targetEp?.absoluteNumber) absoluteNumber = targetEp.absoluteNumber;
    if (targetEp?.aired) episodeAired = targetEp.aired;
    if (
      episodeName
      && targetEp?.id
      && targetEp.nameTranslations?.includes('eng')
      && /[^\x00-\x7F]/.test(episodeName)
    ) {
      const token = await getTvdbToken();
      if (token) {
        const eng = await fetchTvdbTranslation(targetEp.id, 'episode', 'eng', token);
        if (eng) episodeName = eng;
      }
    }
  }
  if (!runtime) {
    const runtimes = Object.values(seasonEps).map(e => e.runtime).filter((r): r is number => typeof r === 'number' && r > 0);
    if (runtimes.length > 0) {
      runtime = Math.round(runtimes.reduce((a, b) => a + b, 0) / runtimes.length) * 60;
    }
  }
  let priorSeasonsCount = 0;
  for (const [s, c] of Object.entries(data.seasonCounts)) {
    const sn = Number(s);
    if (sn > 0 && sn < season) priorSeasonsCount += c;
  }
  return { count, runtime, episodeName, absoluteNumber, priorSeasonsCount, episodeAired };
}

function logEpisodeResult(label: string, season: number, result: SeriesEpisodeResult): void {
  const seasonStr = season.toString().padStart(2, '0');
  const runtimeStr = result.runtime ? ` (${Math.round(result.runtime / 60)}min)` : '';
  const nameStr = result.episodeName ? ` [${result.episodeName}]` : '';
  const absStr = result.absoluteNumber ? ` [abs E${result.absoluteNumber}]` : '';
  const airedStr = result.episodeAired ? ` [aired ${result.episodeAired}]` : '';
  console.log(`🔗 TVDB episode count: ${label} S${seasonStr} → ${result.count} episodes${runtimeStr}${nameStr}${absStr}${airedStr}`);
}

/**
 * Resolve series-level TVDB episode data via IMDB ID. Returns:
 *   - count: episodes in the requested season
 *   - runtime: requested episode's runtime in seconds, else season average
 *   - episodeName: requested episode's title (used by remake/version detection)
 *   - absoluteNumber: canonical absolute episode number when TVDB has it set
 *   - priorSeasonsCount: cumulative episodes across seasons before the requested one
 *
 * One paginated TVDB call per series populates the cache for all season
 * queries against that series, so multi-season searches make one TVDB call
 * instead of N.
 */
export async function resolveEpisodeCountFromTvdb(
  imdbId: string,
  season: number,
  episode?: number
): Promise<SeriesEpisodeResult | undefined> {
  const apiKey = config.searchConfig?.tvdbApiKey;
  if (!apiKey) return undefined;

  const tvdbResult = await findOnTvdb(imdbId, 'series');
  if (!tvdbResult) return undefined;

  let data: TvdbSeriesEpisodeData | undefined;
  try {
    data = await getOrFetchSeriesEpisodes(tvdbResult.id, imdbId);
  } catch (error) {
    console.warn(`⚠️  TVDB episode count lookup failed for ${imdbId} S${season}:`, (error as Error).message);
    return undefined;
  }
  if (!data) return undefined;

  const result = await buildSeasonResult(data, season, episode);
  if (!result) return undefined;

  logEpisodeResult(imdbId, season, result);
  return result;
}

/**
 * Resolve series-level TVDB episode data via a direct TVDB numeric ID. Used
 * by the anime synthetic-title path, where requests come in via a Kitsu/MAL/
 * AniList/AniDB prefix that resolves to a TVDB ID without an IMDB mapping.
 * Skips the IMDB → TVDB lookup that resolveEpisodeCountFromTvdb does.
 *
 * Cache and Promise-dedup are shared with the imdbId path via the TVDB ID,
 * so the same series is never fetched twice if hit from both paths.
 */
export async function resolveEpisodeCountFromTvdbId(
  tvdbId: number,
  season: number,
  episode?: number
): Promise<SeriesEpisodeResult | undefined> {
  const apiKey = config.searchConfig?.tvdbApiKey;
  if (!apiKey) return undefined;
  if (!Number.isFinite(tvdbId) || tvdbId <= 0) return undefined;

  const logLabel = `tvdb:${tvdbId}`;
  let data: TvdbSeriesEpisodeData | undefined;
  try {
    data = await getOrFetchSeriesEpisodes(tvdbId, logLabel);
  } catch (error) {
    console.warn(`⚠️  TVDB episode count lookup failed for ${logLabel} S${season}:`, (error as Error).message);
    return undefined;
  }
  if (!data) return undefined;

  const result = await buildSeasonResult(data, season, episode);
  if (!result) return undefined;

  logEpisodeResult(logLabel, season, result);
  return result;
}
