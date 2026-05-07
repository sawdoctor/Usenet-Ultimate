/**
 * EasyNews Search Integration
 *
 * Searches EasyNews's Solr-based API for video files.
 * Results are normalized to NZBSearchResult for compatibility with the
 * existing sorting/filtering pipeline, but use direct download URLs
 * instead of NZB files.
 *
 * API: https://members.easynews.com/2.0/search/solr-search/
 * Auth: HTTP Basic Auth (username:password)
 */

import axios from 'axios';
import type { NZBSearchResult } from '../types.js';
import { DEFAULT_INDEXER_TIMEOUT_SECONDS } from '../types.js';
import { config } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import { isTextSearchMatch, stripDiacritics, tagSeasonPack, runSeriesPackQueries, getSeriesPackAdditionalPages, extractSeasonTokens } from '../parsers/titleMatching.js';
import { slog, withSubBuffer } from '../parsers/searchLogger.js';

const EASYNEWS_SEARCH_URL = 'https://members.easynews.com/2.0/search/solr-search/';

// Non-video extensions to skip
const SKIP_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'txt', 'nfo', 'srt', 'sub', 'idx',
  'rar', 'zip', 'par2', 'exe', 'bat', 'r00', 'r01', 'sfv', 'nzb',
]);

// Video extensions to allow (whitelist approach for extra safety)
const VIDEO_EXTENSIONS = new Set([
  'mkv', 'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mpg', 'mpeg',
  'm4v', 'ts', 'vob', 'divx', 'ogm', 'ogv', '3gp', 'asf', 'rm',
  'rmvb', 'f4v', 'iso', 'img',
]);

// Minimum video duration in seconds (filter out samples)
const MIN_DURATION_SECONDS = 60;

interface EasynewsSearchResponse {
  data: any[];
  results?: number;
  numPages?: number;
  dlFarm?: string;
  dlPort?: string | number;
  downURL?: string;
}

export class EasynewsSearcher {
  private authHeader: string;
  private timedOut = false;

  constructor(
    private username: string,
    private password: string,
    private maxPages: number = 1,
    private timeoutEnabled: boolean = true,
    private timeoutSeconds: number = DEFAULT_INDEXER_TIMEOUT_SECONDS,
  ) {
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  private getTimeoutMs(): number | undefined {
    if (!this.timeoutEnabled) return undefined;
    return this.timeoutSeconds * 1000;
  }

  private timeoutLabel(): string {
    return `[timeout=${this.timeoutEnabled ? `${this.timeoutSeconds}s` : 'disabled'}]`;
  }

  async searchMovie(
    title: string,
    year?: string,
    country?: string,
    additionalTitles?: string[],
    titleYear?: string,
    searchAliases?: string[],
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    // Parallel alt-title mode: when the toggle is on and we have alts, fire
    // primary + each alt query concurrently and union filtered results. Skips
    // the standard zero-result alt-title retry below since alts already ran.
    const parallelAltEnabled = config.searchConfig?.parallelAlternateTitleSearch === true && !!additionalTitles?.length;
    let filtered: (NZBSearchResult & { indexerName: string })[] = [];
    if (parallelAltEnabled) {
      slog(`🔀 EasyNews parallel alt-title search enabled — querying primary + ${additionalTitles!.length} alt(s) concurrently`);
      const titles = [title, ...additionalTitles!];
      const perTitle = await Promise.all(titles.map((t) => {
        const q = year ? `${t} ${year}` : t;
        return withSubBuffer(`Movie text search "${t}"`, async () => {
          slog(`🔍 Query ${this.timeoutLabel()}: "${q}"`);
          const r = await this.search(q);
          const f = r.filter(x => isTextSearchMatch(t, x.title, year, country, undefined, titleYear));
          if (r.length !== f.length) {
            slog(`   🎯 Title filter: ${r.length} → ${f.length}`);
          }
          return f;
        });
      }));
      filtered = perTitle.flat();
    } else {
      const query = year ? `${title} ${year}` : title;
      filtered = await withSubBuffer(`Movie text search "${title}"`, async () => {
        slog(`🔍 Query ${this.timeoutLabel()}: "${query}"`);
        const results = await this.search(query);
        const before = results.length;
        const f = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
        if (before !== f.length) {
          slog(`   🎯 Title filter: ${before} → ${f.length}`);
          results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
            .forEach(r => slog(`      ✂️  ${r.title}`));
        }
        return f;
      });
    }

    // Alternative-title retry: if 0 results and alternative titles exist, retry with each
    if (filtered.length === 0 && additionalTitles?.length && this.timedOut) {
      slog(`   ⏱️  EasyNews: skipping alt-title retry (prior timeout)`);
    }
    if (filtered.length === 0 && additionalTitles?.length && !this.timedOut && !parallelAltEnabled) {
      for (const altTitle of additionalTitles) {
        const altQuery = year ? `${altTitle} ${year}` : altTitle;
        const altFiltered = await withSubBuffer(`Movie alt-title retry: "${altQuery}"`, async () => {
          slog(`🔄 Query: "${altQuery}"`);
          const altResults = await this.search(altQuery);
          const f = altResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear));
          slog(`   🎯 Alt-title filter: ${altResults.length} → ${f.length}`);
          return f;
        });
        if (altFiltered.length > 0) {
          filtered.push(...altFiltered);
          break;
        }
      }
    }

    // Alias-title fallback: TVDB substring shortcuts on zero-result.
    if (filtered.length === 0 && !this.timedOut && config.searchConfig?.aliasTitleFallback !== false && searchAliases?.length) {
      const aliasPromises = searchAliases.map((alias) => {
        const q = year ? `${alias} ${year}` : alias;
        return withSubBuffer(`Alias fallback: "${q}"`, async () => {
          slog(`🔍 Query: "${q}"`);
          const r = await this.search(q);
          const f = r.filter(x => isTextSearchMatch(alias, x.title, year, country, undefined, titleYear));
          if (r.length !== f.length) slog(`   🎯 Alias "${alias}" filter: ${r.length} → ${f.length}`);
          return f;
        });
      });
      const aliasResults = (await Promise.all(aliasPromises)).flat();
      filtered.push(...aliasResults);
    }

    return filtered;
  }

  async searchTVShow(
    title: string,
    season: number,
    episode: number,
    episodesInSeason?: number,
    year?: string,
    country?: string,
    additionalTitles?: string[],
    titleYear?: string,
    priorSeasonsEpisodeCount?: number,
    absoluteEpisodeNumber?: number,
    tvdbPriorSeasonsCount?: number,
    searchAliases?: string[],
    episodeAired?: string,
  ): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const s = season.toString().padStart(2, '0');
    const e = episode.toString().padStart(2, '0');

    // Parallel alt-title mode: when toggle is on AND alt titles exist, fire
    // primary SxxExx + each alt SxxExx + (when packs enabled) primary S{nn} +
    // each alt S{nn} all concurrently. Filters per-title-set, then unions.
    // Pack hashes dedup against the union of all episode hashes. The standard
    // zero-result alt-title retry block below is skipped in this mode.
    const parallelAltEnabled = config.searchConfig?.parallelAlternateTitleSearch === true && !!additionalTitles?.length;
    let filtered: (NZBSearchResult & { indexerName: string })[];

    if (parallelAltEnabled) {
      slog(`🔀 EasyNews parallel alt-title search enabled — querying primary + ${additionalTitles!.length} alt(s) concurrently`);
      const titles = [title, ...additionalTitles!];
      const includeSeasonPacks = config.searchConfig?.includeSeasonPacks ?? config.includeSeasonPacks;
      const spPaginationEnabled = config.searchConfig?.seasonPackPagination !== false;
      const spAdditionalPages = spPaginationEnabled ? config.searchConfig?.seasonPackAdditionalPages : undefined;

      type Job = { title: string; query: string; kind: 'episode' | 'pack'; results: (NZBSearchResult & { indexerName: string })[] };
      const jobs: { title: string; query: string; kind: 'episode' | 'pack' }[] = [];
      for (const t of titles) jobs.push({ title: t, query: `${t} S${s}E${e}`, kind: 'episode' });
      if (includeSeasonPacks && episodesInSeason) {
        for (const t of titles) jobs.push({ title: t, query: `${t} S${s}`, kind: 'pack' });
      }

      const jobResults: Job[] = await Promise.all(jobs.map(job =>
        withSubBuffer(`${job.kind === 'pack' ? 'Season pack' : 'TV text search'} "${job.query}"`, async () => {
          slog(`🔍 Query ${this.timeoutLabel()}: "${job.query}"`);
          const r = await this.search(job.query, job.kind === 'pack' ? spAdditionalPages : undefined);
          return { ...job, results: r };
        })
      ));

      const episodes = jobResults
        .filter(j => j.kind === 'episode')
        .flatMap(j => {
          const f = j.results.filter(x => isTextSearchMatch(j.title, x.title, year, country, undefined, titleYear));
          if (j.results.length !== f.length) {
            slog(`   🎯 "${j.title}" episode filter: ${j.results.length} → ${f.length}`);
          }
          return f;
        });

      const episodeHashes = new Set(episodes.map(r => r.easynewsMeta!.hash));
      const packs = jobResults
        .filter(j => j.kind === 'pack')
        .flatMap(j => {
          const titleMatched = j.results
            .filter(x => isTextSearchMatch(j.title, x.title, year, country, undefined, titleYear))
            .filter(x => !episodeHashes.has(x.easynewsMeta!.hash));
          const f = tagSeasonPack(titleMatched, season, episodesInSeason);
          if (f.length > 0) {
            slog(`   📦 "${j.title}" packs: ${f.length}`);
          }
          return f;
        });

      filtered = [...episodes, ...packs];
      await this.addEasynewsSeriesPacks(filtered, title, season, episodesInSeason, year, country, additionalTitles, titleYear);
    } else {
      const query = `${title} S${s}E${e}`;
      filtered = await withSubBuffer(`TV text search "${title}"`, async () => {
        slog(`🔍 Query ${this.timeoutLabel()}: "${query}"`);
        const results = await this.search(query);
        const f = results.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
        if (results.length !== f.length) {
          slog(`   🎯 Title filter: ${results.length} → ${f.length}`);
          results.filter(r => !isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
            .forEach(r => slog(`      ✂️  ${r.title}`));
        }
        return f;
      });

      // Season pack search if enabled.
      const includeSeasonPacks = config.searchConfig?.includeSeasonPacks ?? config.includeSeasonPacks;
      if (includeSeasonPacks && episodesInSeason) {
        const spPaginationEnabled = config.searchConfig?.seasonPackPagination !== false;
        const spAdditionalPages = spPaginationEnabled ? config.searchConfig?.seasonPackAdditionalPages : undefined;
        const packQuery = `${title} S${s}`;
        const packs = await withSubBuffer(`Season pack: ${packQuery}`, async () => {
          slog(`🔍 Query: "${packQuery}"`);
          const packResults = await this.search(packQuery, spAdditionalPages);
          const existingHashes = new Set(filtered.map(r => r.easynewsMeta!.hash));
          const titleMatched = packResults
            .filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear))
            .filter(r => !existingHashes.has(r.easynewsMeta!.hash));
          const tagged = tagSeasonPack(titleMatched, season, episodesInSeason);
          if (packResults.length !== tagged.length) {
            slog(`   📦 Season pack filter: ${packResults.length} → ${tagged.length}`);
          }
          if (tagged.length > 0) slog(`   📦 Found ${tagged.length} season pack(s)`);
          return tagged;
        });
        filtered.push(...packs);
      }

      await this.addEasynewsSeriesPacks(filtered, title, season, episodesInSeason, year, country, additionalTitles, titleYear);

      // Sequential alt-title retry: skipped when parallel mode active.
      if (filtered.length === 0 && additionalTitles?.length && this.timedOut) {
        slog(`   ⏱️  EasyNews: skipping alt-title retry (prior timeout)`);
      }
      if (filtered.length === 0 && additionalTitles?.length && !this.timedOut) {
        for (const altTitle of additionalTitles) {
          const altQuery = `${altTitle} S${s}E${e}`;
          const altFiltered = await withSubBuffer(`Alt-title retry: "${altQuery}"`, async () => {
            slog(`🔄 Query: "${altQuery}"`);
            const altResults = await this.search(altQuery);
            const f = altResults.filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear));
            slog(`   🎯 Alt-title filter: ${altResults.length} → ${f.length}`);
            return f;
          });
          if (altFiltered.length > 0) {
            if (includeSeasonPacks && episodesInSeason) {
              const spPaginationEnabled = config.searchConfig?.seasonPackPagination !== false;
              const spAdditionalPages = spPaginationEnabled ? config.searchConfig?.seasonPackAdditionalPages : undefined;
              const altPackQuery = `${altTitle} S${s}`;
              const altPacks = await withSubBuffer(`Alt-title season pack: ${altPackQuery}`, async () => {
                slog(`🔍 Query: "${altPackQuery}"`);
                const altPackResults = await this.search(altPackQuery, spAdditionalPages);
                const existingHashes = new Set(altFiltered.map(r => r.easynewsMeta!.hash));
                const titleMatched = altPackResults
                  .filter(r => isTextSearchMatch(altTitle, r.title, year, country, undefined, titleYear))
                  .filter(r => !existingHashes.has(r.easynewsMeta!.hash));
                const tagged = tagSeasonPack(titleMatched, season, episodesInSeason);
                if (altPackResults.length !== tagged.length) {
                  slog(`   📦 Alt-title pack filter: ${altPackResults.length} → ${tagged.length}`);
                }
                if (tagged.length > 0) slog(`   📦 Found ${tagged.length} season pack(s) (alt-title)`);
                return tagged;
              });
              altFiltered.push(...altPacks);
            }
            filtered.push(...altFiltered);
            break;
          }
        }
      }
    }

    // Absolute-episode fallback. Three-tier chain (TVDB canonical → TVDB
    // cumulative → Cinemeta cumulative → per-season). In parallel mode, retry
    // all titles concurrently; otherwise sequentially break-on-first-hit.
    if (filtered.length === 0 && !this.timedOut && config.searchConfig?.absoluteEpisodeFallback !== false) {
      let absoluteEp: number;
      if (typeof absoluteEpisodeNumber === 'number') {
        absoluteEp = absoluteEpisodeNumber;
      } else if (typeof tvdbPriorSeasonsCount === 'number') {
        absoluteEp = tvdbPriorSeasonsCount + episode;
      } else if (priorSeasonsEpisodeCount !== undefined) {
        absoluteEp = priorSeasonsEpisodeCount + episode;
      } else {
        slog(`⚠️  EasyNews absolute fallback: no prior-season count available, using per-season E${episode}`);
        absoluteEp = episode;
      }
      const stripAbsEp = (str: string) => str.replace(/\bE\d{1,3}\b/i, ' ').replace(/\s+/g, ' ');
      const seasonOk = (resultTitle: string): boolean => {
        const seasonTokens = extractSeasonTokens(resultTitle);
        return seasonTokens.length === 0 || seasonTokens.includes(season);
      };

      if (parallelAltEnabled && additionalTitles?.length) {
        const titles = [title, ...additionalTitles];
        const absPerTitle = await Promise.all(titles.map(t => {
          if (this.timedOut) return Promise.resolve([] as (NZBSearchResult & { indexerName: string })[]);
          const absQuery = `${t} E${absoluteEp.toString().padStart(2, '0')}`;
          return withSubBuffer(`Absolute fallback: "${absQuery}"`, async () => {
            slog(`🔢 Query: "${absQuery}"`);
            const r = await this.search(absQuery);
            const f = r.filter(x => isTextSearchMatch(t, stripAbsEp(x.title), year, country, undefined, titleYear) && seasonOk(x.title));
            if (r.length !== f.length) slog(`   🔢 Absolute filter: ${r.length} → ${f.length}`);
            return f;
          });
        }));
        filtered.push(...absPerTitle.flat());
      } else {
        const candidates = [title, ...(additionalTitles ?? [])];
        for (const candTitle of candidates) {
          if (this.timedOut) break;
          const absQuery = `${candTitle} E${absoluteEp.toString().padStart(2, '0')}`;
          const absFiltered = await withSubBuffer(`Absolute fallback: "${absQuery}"`, async () => {
            slog(`🔢 Query: "${absQuery}"`);
            const absResults = await this.search(absQuery);
            const f = absResults.filter(r => isTextSearchMatch(candTitle, stripAbsEp(r.title), year, country, undefined, titleYear) && seasonOk(r.title));
            if (absResults.length !== f.length) slog(`   🔢 Absolute filter: ${absResults.length} → ${f.length}`);
            return f;
          });
          if (absFiltered.length > 0) {
            filtered.push(...absFiltered);
            break;
          }
        }
      }
    }

    // Alias-title fallback: TVDB substring shortcuts on zero-result.
    // Date-numbered variant when episodeAired is set (daily/talk shows).
    if (filtered.length === 0 && !this.timedOut && config.searchConfig?.aliasTitleFallback !== false && searchAliases?.length) {
      const useDateScheme = typeof episodeAired === 'string' && /^\d{4}-\d{2}-\d{2}/.test(episodeAired);
      const aliasPromises = searchAliases.map((alias) => {
        const q = useDateScheme
          ? `${alias} ${episodeAired!.slice(0, 10).replace(/-/g, '.')}`
          : `${alias} S${s}E${e}`;
        return withSubBuffer(`Alias fallback: "${q}"`, async () => {
          slog(`🔍 Query: "${q}"`);
          const r = await this.search(q);
          const f = r.filter(x => isTextSearchMatch(alias, x.title, year, country, undefined, titleYear));
          if (r.length !== f.length) slog(`   🎯 Alias "${alias}" filter: ${r.length} → ${f.length}`);
          return f;
        });
      });
      const aliasResults = (await Promise.all(aliasPromises)).flat();
      filtered.push(...aliasResults);
    }

    return filtered;
  }

  /**
   * Append multi-season fanout + series-pack keyword query results to
   * `filtered`. Used by both the parallel-alt and sequential primary paths so
   * Easynews users get the same Series Packs coverage as indexer searches.
   * Mutates `filtered` directly. Uses primary title only to avoid multiplying
   * alt-title queries; tagSeasonPack's range-cover check keeps only ranges
   * that actually cover the requested season. Hash-dedups against the latest
   * `filtered` so re-fetched releases collapse before tagging.
   */
  private async addEasynewsSeriesPacks(
    filtered: (NZBSearchResult & { indexerName: string })[],
    title: string,
    season: number,
    episodesInSeason: number | undefined,
    year: string | undefined,
    country: string | undefined,
    additionalTitles: string[] | undefined,
    titleYear: string | undefined,
  ): Promise<void> {
    const pages = getSeriesPackAdditionalPages(config.searchConfig);
    const baselineHashes = new Set(filtered.map(r => r.easynewsMeta!.hash));

    const tasks: Promise<(NZBSearchResult & { indexerName: string })[]>[] = [];

    const includeMultiSeasonPacks = config.searchConfig?.includeMultiSeasonPacks ?? true;
    if (season > 1 && includeMultiSeasonPacks) {
      const fanoutQuery = `${title} S01`;
      tasks.push(withSubBuffer(`Multi-season fanout: ${fanoutQuery}`, async () => {
        slog(`🔍 Query: "${fanoutQuery}"`);
        const fanoutResults = await this.search(fanoutQuery, pages);
        const deduped = fanoutResults.filter(r => !baselineHashes.has(r.easynewsMeta!.hash));
        const titleMatched = deduped.filter(r => isTextSearchMatch(title, r.title, year, country, additionalTitles, titleYear));
        const fanoutPacks = tagSeasonPack(titleMatched, season, episodesInSeason);
        if (fanoutResults.length !== fanoutPacks.length) {
          slog(`   📦 Multi-season fanout filter: ${fanoutResults.length} → ${fanoutPacks.length}`);
        }
        if (fanoutPacks.length > 0) {
          slog(`   📦 Found ${fanoutPacks.length} multi-season pack(s) covering S${season}`);
        }
        return fanoutPacks;
      }));
    }

    tasks.push(withSubBuffer(`Series-pack keyword queries (${title})`, () => runSeriesPackQueries({
      searchFn: async (q) => {
        const r = await this.search(q, pages);
        return r.filter(x => !baselineHashes.has(x.easynewsMeta!.hash));
      },
      title, season, episodesInSeason,
      isTitleMatch: (rt) => isTextSearchMatch(title, rt, year, country, additionalTitles, titleYear),
      searchConfig: config.searchConfig,
      logPrefix: 'EasyNews',
    })));

    const arrays = await Promise.all(tasks);
    const seen = new Set(baselineHashes);
    for (const arr of arrays) {
      for (const r of arr) {
        const h = r.easynewsMeta!.hash;
        if (!seen.has(h)) {
          seen.add(h);
          filtered.push(r);
        }
      }
    }
  }

  private async search(query: string, maxPagesOverride?: number): Promise<(NZBSearchResult & { indexerName: string })[]> {
    const allResults: (NZBSearchResult & { indexerName: string })[] = [];
    const seenHashes = new Set<string>();
    const effectiveMaxPages = maxPagesOverride ?? this.maxPages;
    const userAgent = config.userAgents?.general || getLatestVersions().chrome;

    for (let page = 1; page <= effectiveMaxPages; page++) {
      const params = new URLSearchParams({
        fly: '2',
        sb: '1',
        pno: page.toString(),
        pby: '250',
        u: '1',
        chxu: '1',
        chxgx: '1',
        st: 'basic',
        gps: stripDiacritics(query),
        vv: '1',
        safeO: '0',
        s1: 'relevance',
        s1d: '-',
      });
      params.append('fty[]', 'VIDEO');

      slog(`   📄 EasyNews page ${page}/${effectiveMaxPages}...`);

      try {
        const response = await axios.get(EASYNEWS_SEARCH_URL, {
          params,
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json, text/javascript, */*; q=0.9',
            'User-Agent': userAgent,
          },
          timeout: this.getTimeoutMs(),
        });

        const data = (typeof response.data === 'object' ? response.data : (() => { try { return JSON.parse(response.data); } catch { return {}; } })()) as EasynewsSearchResponse;
        if (!data.data || data.data.length === 0) break;

        const dlFarm = data.dlFarm || '';
        const dlPort = String(data.dlPort || '');
        const downURL = data.downURL || '';

        let pageCount = 0;
        const rejectReasons: Record<string, number> = {};
        for (const item of data.data) {
          const parsed = this.parseItem(item, dlFarm, dlPort, downURL, rejectReasons);
          if (!parsed) continue;
          if (seenHashes.has(parsed.easynewsMeta!.hash)) continue;
          seenHashes.add(parsed.easynewsMeta!.hash);
          allResults.push({ ...parsed, indexerName: 'EasyNews' });
          pageCount++;
        }

        if (pageCount === 0 && data.data.length > 0) {
          // Log rejection breakdown when all items are filtered — helps diagnose parsing issues
          const sample = data.data[0];
          const sampleExt = Array.isArray(sample) ? sample[11] : (sample?.extension || sample?.ext || '');
          const sampleFn = Array.isArray(sample) ? sample[10] : (sample?.fn || sample?.filename || '');
          slog(`   ⚠️  EasyNews page ${page}: all ${data.data.length} items rejected — ${JSON.stringify(rejectReasons)} (sample: fn="${sampleFn}" ext="${sampleExt}")`);
        } else {
          slog(`   📄 EasyNews page ${page}: ${pageCount} results (${allResults.length} total)`);
        }

        // Stop if we've fetched all pages
        const numPages = data.numPages || 1;
        if (page >= numPages) break;
      } catch (error: any) {
        if (error.code === 'ECONNABORTED') {
          this.timedOut = true;
          slog(`⏱️  EasyNews timed out after ${this.timeoutSeconds}s`);
        } else if (error.response?.status === 401) {
          console.error('❌ EasyNews authentication failed');
        } else {
          console.error(`❌ EasyNews search error (page ${page}):`, error.message);
        }
        break;
      }
    }

    slog(`   📦 EasyNews total: ${allResults.length} results`);
    return allResults;
  }

  private parseItem(
    item: any,
    dlFarm: string,
    dlPort: string,
    downURL: string,
    rejectReasons?: Record<string, number>,
  ): NZBSearchResult | null {
    const reject = (reason: string) => { if (rejectReasons) rejectReasons[reason] = (rejectReasons[reason] || 0) + 1; return null; };

    let hash: string, subject: string, filename: string, ext: string;
    let size: number | string, duration: string | number | null;
    let posted: string | number | null = null;
    let sig: string | null = null;

    if (Array.isArray(item)) {
      hash = item[0] || '';
      size = item[4] || 0;
      subject = item[6] || '';
      posted = item[8] ?? null;
      filename = item[10] || '';
      ext = item[11] || '';
      duration = item[14] || null;
      sig = (item as any).sig || null;
    } else if (item && typeof item === 'object') {
      hash = String(item.hash || item['0'] || item.id || '');
      subject = String(item.subject || item['6'] || '');
      filename = String(item.fn || item.filename || item['10'] || '');
      ext = String(item.extension || item.ext || item['11'] || '');
      size = item.size || item.rawSize || item.Length || item['4'] || 0;
      duration = item.runtime || item.duration || item['14'] || null;
      posted = (item.ts ?? item.timestamp ?? item['5'] ?? item['8'] ?? null) as string | number | null;
      sig = item.sig ? String(item.sig) : null;
    } else {
      return reject('bad-format');
    }

    // Filter: must have hash
    if (!hash) return reject('no-hash');

    // Normalize extension: strip leading dot if present
    ext = ext.replace(/^\./, '');

    // Filter: skip non-video extensions
    const extLower = ext.toLowerCase();
    if (SKIP_EXTENSIONS.has(extLower)) return reject('skip-ext');
    if (ext && !VIDEO_EXTENSIONS.has(extLower)) return reject('not-video-ext');

    // Filter: skip samples (check second half of filename to avoid false positives)
    const filenameLower = filename.toLowerCase();
    const halfLen = Math.floor(filenameLower.length / 2);
    if (filenameLower.substring(halfLen).includes('sample')) return reject('sample');

    // Filter: skip short videos (samples)
    const durationSec = this.parseDuration(duration);
    if (durationSec > 0 && durationSec < MIN_DURATION_SECONDS) return reject('short-duration');

    // Parse size
    const sizeBytes = typeof size === 'string' ? this.parseSize(size) : (size || 0);

    // Use filename.ext as the title — EasyNews filenames are clean release names
    // (e.g. "Show.Name.S05E08.1080p.WEBRip.DD5.1.x264-GRP.mkv")
    // Subject lines contain noisy Usenet headers (yEnc, part numbers, etc.) that
    // break both title matching and quality parsing
    const title = filename ? `${filename}.${ext}` : subject;

    // Parse posted date for age display
    let pubDate = '';
    if (posted != null) {
      const date = typeof posted === 'number' ? new Date(posted * 1000) : new Date(String(posted));
      if (!isNaN(date.getTime()) && date.getTime() <= Date.now()) {
        pubDate = date.toISOString();
      }
    }

    return {
      title,
      link: `easynews://${hash}`,
      size: sizeBytes,
      pubDate,
      duration: durationSec > 0 ? durationSec : undefined,
      category: 'EasyNews',
      attributes: {},
      easynewsMeta: { hash, filename, ext, dlFarm, dlPort, downURL, sig: sig || undefined },
    };
  }

  private parseDuration(d: string | number | null): number {
    if (d === null || d === undefined) return 0;
    if (typeof d === 'number') return d;
    if (!d) return 0;
    // "HH:MM:SS" or "MM:SS"
    const parts = d.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parseInt(d, 10) || 0;
  }

  private parseSize(s: string): number {
    if (!s) return 0;
    // Handle numeric strings directly
    const num = parseInt(s, 10);
    if (!isNaN(num) && String(num) === s.trim()) return num;
    // Handle "1.5 GB" style strings
    const match = s.match(/([\d.]+)\s*(KB|MB|GB|TB)/i);
    if (!match) return num || 0;
    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const multipliers: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    return Math.round(value * (multipliers[unit] || 1));
  }
}
