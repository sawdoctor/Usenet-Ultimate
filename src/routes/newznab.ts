/**
 * Newznab routes — /stremio/:manifestKey/newznab/api
 *
 * Presents UU's curated search pipeline as a Newznab indexer for
 * Sonarr / Radarr. Mounted behind validateManifestKey, so the manifest
 * key in the URL is the authentication; the Newznab apikey query param
 * is accepted but not checked.
 *
 *   t=caps                        — capabilities
 *   t=tvsearch  (imdbid|tvdbid, season[, ep])  — TV via full UU pipeline
 *   t=tvsearch  (no ids)          — RSS: recent TV via Prowlarr passthrough
 *   t=movie     (imdbid)          — movies via full UU pipeline
 *   t=movie     (no ids)          — RSS: recent movies via Prowlarr passthrough
 *   t=search    (no ids)          — RSS: recent (both categories)
 *   t=get&d=<base64url NZB URL>   — proxy the original NZB
 *
 * Pipeline reuse: resolveTitle → SearchContext → indexManagerSearch +
 * easynewsSearch → deduplicateAndPreFilter → applyUserFilters. Results
 * are serialised pre-streamBuilder, so titles, sizes, pub dates and
 * indexer names are the real values from the indexers.
 */

import { Router, type Request, type Response } from 'express';
import { config } from '../config/index.js';
import { resolveTitle } from '../addon/titleResolver.js';
import { indexManagerSearch, easynewsSearch, type SearchContext } from '../addon/searchOrchestrator.js';
import { deduplicateAndPreFilter, applyUserFilters } from '../addon/resultProcessor.js';
import { performHealthCheck, performBatchHealthChecks, getCachedNzbContent } from '../health/index.js';
import { isDeadNzbByUrl, addDeadNzbByUrl, saveCacheToDisk } from '../nzbdav/streamCache.js';
import { getLatestVersions } from '../versionFetcher.js';
import { recordHealthCheck, recordGrab, recordDeadCacheEvidence, getReputationData, explainReputationRank, getReputationWeightMultiplier } from '../reputationTracker.js';
import { trackGrab } from '../statsTracker.js';

const MAX_RESULTS = 100;
const RSS_LIMIT = 100;
const NZB_MAX_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// XML helpers (no external deps — keep the patch surface tiny)
// ---------------------------------------------------------------------------

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xml(res: Response, body: string, status = 200): Response {
  return res.status(status).type('application/xml; charset=utf-8')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
}

function errorXml(res: Response, code: number, description: string, status = 400): Response {
  return xml(res, `<error code="${code}" description="${esc(description)}"/>`, status);
}

interface NewznabItem {
  title: string;
  guid: string;
  nzbUrl: string;      // original upstream NZB URL (proxied through t=get)
  size: number;
  pubDate: Date;
  category: number;    // 5040 etc.
  indexer?: string;
  imdbId?: string;     // without tt prefix
  tvdbId?: string;
  season?: number;
  episode?: number;
}

function capsXml(): string {
  return [
    '<caps>',
    '  <server version="1.0" title="Usenet Ultimate" strapline="UU curated Newznab endpoint"/>',
    `  <limits max="${MAX_RESULTS}" default="${MAX_RESULTS}"/>`,
    '  <searching>',
    '    <search available="yes" supportedParams="q"/>',
    '    <tv-search available="yes" supportedParams="q,imdbid,tvdbid,season,ep"/>',
    '    <movie-search available="yes" supportedParams="q,imdbid"/>',
    '  </searching>',
    '  <categories>',
    '    <category id="2000" name="Movies">',
    '      <subcat id="2040" name="Movies/HD"/><subcat id="2045" name="Movies/UHD"/>',
    '    </category>',
    '    <category id="5000" name="TV">',
    '      <subcat id="5040" name="TV/HD"/><subcat id="5045" name="TV/UHD"/>',
    '    </category>',
    '  </categories>',
    '</caps>',
  ].join('\n');
}

function itemsXml(items: NewznabItem[], baseUrl: string, offset = 0, total = items.length): string {
  const lines: string[] = [
    '<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">',
    '<channel>',
    '<title>Usenet Ultimate</title>',
    `<link>${esc(baseUrl)}</link>`,
    '<description>UU curated results</description>',
    `<newznab:response offset="${offset}" total="${total}"/>`,
  ];
  for (const it of items) {
    const dl = `${baseUrl}/api?t=get&amp;d=${encodeURIComponent(Buffer.from(it.nzbUrl, 'utf8').toString('base64url'))}`;
    lines.push('<item>');
    lines.push(`<title>${esc(it.title)}</title>`);
    lines.push(`<guid isPermaLink="false">${esc(it.guid)}</guid>`);
    lines.push(`<link>${dl}</link>`);
    if (it.indexer) lines.push(`<comments>${esc(it.indexer)}</comments>`);
    lines.push(`<pubDate>${it.pubDate.toUTCString()}</pubDate>`);
    lines.push(`<category>${it.category}</category>`);
    lines.push(`<enclosure url="${dl}" length="${it.size || 0}" type="application/x-nzb"/>`);
    lines.push(`<newznab:attr name="category" value="${it.category}"/>`);
    lines.push(`<newznab:attr name="size" value="${it.size || 0}"/>`);
    lines.push(`<newznab:attr name="guid" value="${esc(it.guid)}"/>`);
    if (it.imdbId) lines.push(`<newznab:attr name="imdb" value="${esc(it.imdbId)}"/>`);
    if (it.tvdbId) lines.push(`<newznab:attr name="tvdbid" value="${esc(it.tvdbId)}"/>`);
    if (it.season !== undefined) lines.push(`<newznab:attr name="season" value="${it.season}"/>`);
    if (it.episode !== undefined) lines.push(`<newznab:attr name="episode" value="${it.episode}"/>`);
    lines.push('</item>');
  }
  lines.push('</channel>', '</rss>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mapping UU pipeline results → Newznab items
// ---------------------------------------------------------------------------

function categoryFor(type: 'movie' | 'series', title: string): number {
  const uhd = /\b(2160p|uhd|4k)\b/i.test(title);
  return type === 'movie' ? (uhd ? 2045 : 2040) : (uhd ? 5045 : 5040);
}

function parsePubDate(raw: unknown): Date {
  const d = raw ? new Date(String(raw)) : new Date();
  return isNaN(d.getTime()) ? new Date() : d;
}

function mapPipelineResults(
  results: any[],
  type: 'movie' | 'series',
  ctx: { imdbId?: string; tvdbId?: string; season?: number; episode?: number },
): NewznabItem[] {
  const items: NewznabItem[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const link: string | undefined = r?.link;
    if (!link || !/^https?:\/\//i.test(link)) continue; // EasyNews DDL-only entries lack an NZB link
    const title: string = r?.title || 'Unknown release';
    const guid = Buffer.from(`${title}\n${link}`).toString('base64url').slice(0, 40);
    if (seen.has(guid)) continue;
    seen.add(guid);
    items.push({
      title,
      guid,
      nzbUrl: link,
      size: Number(r?.size) || 0,
      pubDate: parsePubDate(r?.pubDate),
      category: categoryFor(type, title),
      indexer: r?.indexer || r?.indexerName || undefined,
      imdbId: ctx.imdbId ? ctx.imdbId.replace(/^tt/, '') : undefined,
      tvdbId: ctx.tvdbId,
      season: r?.isSeasonPack ? ctx.season : ctx.season,
      episode: r?.isSeasonPack ? undefined : ctx.episode,
    });
  }
  return items.slice(0, MAX_RESULTS);
}

// ---------------------------------------------------------------------------
// Search via the full UU pipeline (title resolution → orchestrator → filters)
// ---------------------------------------------------------------------------

const searchCache = new Map<string, { at: number; results: any[] }>();
const SEARCH_CACHE_MS = 10 * 60 * 1000;

async function pipelineSearch(
  type: 'movie' | 'series',
  imdbId: string,
  tvdbId: string | undefined,
  season: number | undefined,
  episode: number | undefined,
): Promise<any[]> {
  const cacheKey = `${type}|${imdbId}|${tvdbId ?? ''}|${season ?? ''}|${episode ?? ''}`;
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) return hit.results;
  const tvdbIdFromRequest = tvdbId ? parseInt(tvdbId, 10) : undefined;
  const titleInfo = await resolveTitle(type, imdbId, season, episode, tvdbIdFromRequest);

  const searchCtx: SearchContext = {
    type,
    imdbId,
    title: titleInfo.title,
    year: titleInfo.year,
    country: titleInfo.country,
    season,
    episode,
    episodesInSeason: titleInfo.episodesInSeason,
    priorSeasonsEpisodeCount: titleInfo.priorSeasonsEpisodeCount,
    absoluteEpisodeNumber: titleInfo.absoluteEpisodeNumber,
    tvdbPriorSeasonsCount: titleInfo.tvdbPriorSeasonsCount,
    additionalTitles: titleInfo.additionalTitles,
    isAnime: titleInfo.isAnime ?? false,
    titleYear: titleInfo.titleYear,
    searchAliases: titleInfo.searchAliases,
    episodeAired: titleInfo.episodeAired,
    tvdbIdFromRequest,
  };

  const [indexerResults, easynewsResults] = await Promise.all([
    indexManagerSearch(searchCtx).catch(() => []),
    easynewsSearch(searchCtx).catch(() => []),
  ]);

  const allRaw = [...(indexerResults || []), ...(easynewsResults || [])];
  const { results: preFiltered, deprioritizedPacks } = deduplicateAndPreFilter(
    allRaw, titleInfo.hasRemake, titleInfo.episodeName, titleInfo.year, titleInfo.titleYear,
  );
  // Option C hybrid: per-category control over which UU preferences apply to
  // Newznab responses. Defaults: resolution filters ON (a "never 480p
  // anywhere" preference is genuinely global), source filters OFF and stream
  // limits OFF (arr custom formats / profiles own those decisions — a global
  // source preference is what starved Radarr HD while Radarr4K thrived).
  // Env overrides: NEWZNAB_RESOLUTION_FILTERS / NEWZNAB_SOURCE_FILTERS /
  // NEWZNAB_STREAM_LIMITS = on|off.
  const flag = (name: string, dflt: boolean): boolean => {
    const v = (process.env[name] || '').toLowerCase();
    if (v === 'on' || v === 'true' || v === '1') return true;
    if (v === 'off' || v === 'false' || v === '0') return false;
    return dflt;
  };
  const clientProfile = {
    resolutionFilters: flag('NEWZNAB_RESOLUTION_FILTERS', true),
    sourceFilters: flag('NEWZNAB_SOURCE_FILTERS', false),
    streamLimits: flag('NEWZNAB_STREAM_LIMITS', false),
  };
  let finalResults = applyUserFilters(
    preFiltered, type, Date.now(), titleInfo.runtime, deprioritizedPacks, { quiet: true, clientProfile },
  );
  console.log(`\u{1F4F0} Newznab: client-profile mode (resolution=${clientProfile.resolutionFilters ? 'on' : 'off'}, source=${clientProfile.sourceFilters ? 'on' : 'off'}, limits=${clientProfile.streamLimits ? 'on' : 'off'}) — returning ${finalResults.length} result(s) for the client's own profile to rank`);
  // Keep the existing quality/profile ordering intact. Reputation is applied
  // below when selecting the limited health-check budget, where UU's ordering
  // has a direct operational effect. Arr applications perform their own final
  // quality ranking, so globally replacing quality order here would be unsafe.
  // Search-side health verification: remove dead NZBs before Sonarr/Radarr
  // ever sees them. Reuses UU's batch health engine and dead-NZB database.
  const hc = (config as any).healthChecks;
  const hcSearchProviders = hc?.providers?.filter((p: any) => p.enabled) || [];
  let healthyResults = finalResults;
  if (hc?.enabled && hcSearchProviders.length > 0 && finalResults.length > 0) {
    // Filter known-dead NZBs, recording each as reputation evidence on first
    // sight. Without this, a release in the dead cache is never health-checked
    // again and so never counts against its group — the groups producing the
    // most dead NZBs stay invisible. recordDeadCacheEvidence dedupes per
    // release, so repeat searches don't compound one dead NZB into many.
    healthyResults = finalResults.filter((r: any) => {
      if (!r?.link || !isDeadNzbByUrl(r.link)) return true;
      try {
        recordDeadCacheEvidence(r.title || '', r.indexer || r.indexerName || null, r.link);
      } catch { /* noop — reputation must never break search */ }
      return false;
    });
    const inspectCount = Math.min(Number(hc.nzbsToInspect) || 6, healthyResults.length);

    // Reputation chooses which releases receive the scarce verification slots,
    // without discarding the existing quality/profile order. Limit selection to
    // a nearby candidate window so a highly reputed low-quality release cannot
    // leapfrog the entire result set. Unknown releases remain neutral.
    const candidateWindowSize = Math.min(
      healthyResults.length,
      Math.max(inspectCount, inspectCount * 3),
    );
    const candidateWindow = healthyResults.slice(0, candidateWindowSize);
    const repMult = getReputationWeightMultiplier();

    let topCandidates: any[];
    if (repMult > 0) {
      const scored = candidateWindow.map((r: any, i: number) => ({
        r,
        i,
        ex: explainReputationRank(r?.title || '', r?.indexer || r?.indexerName),
      }));

      // Diversity guard against exposure bias.
      //
      // Health evidence only accrues to candidates that get verified, so
      // reputation-driven selection feeds itself: an indexer that ranks well
      // early wins more slots, gathers more evidence, and keeps winning, while
      // a poorly-ranked one may never get another slot to prove otherwise.
      // Dead-cache backfill records negatives outside selection but offers no
      // equivalent route for positives, so it doesn't break the loop on its own.
      //
      // Cap any one indexer at ceil(slots / 2), then fill any shortfall in a
      // second uncapped pass — a search where only one indexer returned usable
      // results must not end up verifying fewer NZBs than it otherwise would.
      // Reputation scores are untouched; this only affects which candidates
      // occupy the slots.
      const perIndexerCap = Math.ceil(inspectCount / 2);
      const byBoost = scored
        .slice()
        .sort((a: any, b: any) => (b.ex.boost - a.ex.boost) || (a.i - b.i));

      const indexerOf = (x: any): string =>
        String(x.r?.indexer || x.r?.indexerName || 'unknown').toLowerCase();

      const perIndexerCount = new Map<string, number>();
      const picked: any[] = [];
      for (const x of byBoost) {
        if (picked.length >= inspectCount) break;
        const key = indexerOf(x);
        const used = perIndexerCount.get(key) || 0;
        if (used >= perIndexerCap) continue;
        perIndexerCount.set(key, used + 1);
        picked.push(x);
      }
      const cappedOut = picked.length < inspectCount;
      if (cappedOut) {
        const already = new Set(picked.map((x: any) => x.i));
        for (const x of byBoost) {
          if (picked.length >= inspectCount) break;
          if (already.has(x.i)) continue;
          picked.push(x);
        }
      }
      const selected = picked.sort((a: any, b: any) => a.i - b.i);

      // Visibility: without this, "reputation has no data yet" and
      // "reputation is silently broken" produce identical logs.
      const withEvidence = scored.filter((x: any) => !x.ex.unknown);
      const baselineIdx = candidateWindow.slice(0, inspectCount).map((_: any, i: number) => i);
      const selectedIdx = selected.map((x: any) => x.i);
      const changed = selectedIdx.join(',') !== baselineIdx.join(',');

      if (process.env.REPUTATION_DEBUG === '1' || process.env.REPUTATION_DEBUG === 'true') {
        console.log(`\u{1F4C8} Reputation: health-check candidate scores (weight=${(process.env.REPUTATION_WEIGHT || 'low').toLowerCase()}, window=${candidateWindow.length}, slots=${inspectCount})`);
        for (const x of scored) {
          const chosen = selectedIdx.includes(x.i) ? '✔' : ' ';
          const grp = (x.ex.group || 'no-group').padEnd(16).slice(0, 16);
          const bst = (x.ex.boost >= 0 ? `+${x.ex.boost}` : `${x.ex.boost}`).padStart(4);
          const detail = x.ex.unknown
            ? 'no evidence yet'
            : `group=${x.ex.groupScore >= 0 ? '+' : ''}${x.ex.groupScore} indexer=${x.ex.indexerScore >= 0 ? '+' : ''}${x.ex.indexerScore} samples=${x.ex.samples} conf=${x.ex.confidence}`;
          console.log(`   ${chosen} #${String(x.i).padStart(2)} ${grp} boost=${bst}  ${detail}`);
        }
      }

      // Report the two evidence dimensions separately. Indexer history fills
      // up within a few searches (there are only a handful of indexers), while
      // group history needs one grab per group across thousands of groups — so
      // a combined count reads as though the engine knows far more than it does.
      const groupHistory = scored.filter((x: any) => x.ex.hasGroupHistory).length;
      const indexerHistory = scored.filter((x: any) => x.ex.hasIndexerHistory).length;
      const evidence = `${groupHistory}/${candidateWindow.length} with group history, ${indexerHistory}/${candidateWindow.length} with indexer history`;

      // Show the indexer spread of the chosen slots — the whole point of the
      // cap is that this shouldn't collapse to one source.
      const spread = new Map<string, number>();
      for (const x of selected) spread.set(indexerOf(x), (spread.get(indexerOf(x)) || 0) + 1);
      const spreadStr = [...spread.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
      console.log(`\u{1F4C8} Reputation: verification slots by indexer — ${spreadStr} (cap ${perIndexerCap}/indexer${cappedOut ? ', relaxed to fill remaining slots' : ''})`);

      if (withEvidence.length === 0) {
        console.log(`\u{1F4C8} Reputation: ${candidateWindow.length} candidate(s), none with recorded history yet — health-check selection unchanged (neutral)`);
      } else if (changed) {
        const promoted = selectedIdx.filter((i: number) => !baselineIdx.includes(i));
        console.log(`\u{1F4C8} Reputation: influenced health-check selection — promoted ${promoted.length} candidate(s) [${promoted.map((i: number) => `#${i} ${scored[i]?.ex.group || 'no-group'}`).join(', ')}] over default order (${evidence})`);
      } else {
        console.log(`\u{1F4C8} Reputation: ${evidence}; selection matches default order`);
      }

      topCandidates = selected.map((x: any) => x.r);
    } else {
      console.log('\u{1F4C8} Reputation: health-check selection disabled (weight=off)');
      topCandidates = candidateWindow.slice(0, inspectCount);
    }
    topCandidates = topCandidates.filter((r: any) => /^https?:\/\//i.test(r?.link));
    if (topCandidates.length > 0) {
      const hcUa = (config as any).userAgents?.nzbDownload || getLatestVersions().chrome;
      try {
        console.log(`\u{1FA7A} Newznab: verifying top ${topCandidates.length} result(s) before responding...`);
        const { results: verdicts } = await performBatchHealthChecks(
          topCandidates.map((r: any) => r.link),
          hcSearchProviders,
          hcUa,
          Math.min(Number(hc.maxConnections) || 3, topCandidates.length),
          { archiveInspection: false, sampleCount: hc.sampleCount === 7 ? 7 : 3 },
        );
        const deadUrls = new Set<string>();
        const candidateByUrl = new Map<string, any>(topCandidates.map((r: any) => [r.link, r] as [string, any]));
        for (const [url, v] of verdicts.entries()) {
          // Reputation: log every verdict as a release-level observation
          const cand = candidateByUrl.get(url);
          if (cand) {
            try {
              recordHealthCheck(
                cand.title || 'Unknown release',
                cand.indexer || cand.indexerName || null,
                !(v && v.playable === false),
                v?.message,
              );
            } catch { /* noop — reputation must never break search */ }
          }
          if (v && v.playable === false) {
            deadUrls.add(url);
            try { addDeadNzbByUrl(url, 'newznab search verification'); } catch { /* noop */ }
          }
        }
        if (deadUrls.size > 0) {
          saveCacheToDisk();
          console.log(`\u{1FA7A} Newznab: removed ${deadUrls.size} dead NZB(s) from results`);
          healthyResults = healthyResults.filter((r: any) => !deadUrls.has(r?.link));
        } else {
          console.log(`\u{1FA7A} Newznab: all verified candidates healthy`);
        }
      } catch (e) {
        console.warn('\u{1FA7A} Newznab: verification skipped:', e instanceof Error ? e.message : e);
      }
    }
  }
  searchCache.set(cacheKey, { at: Date.now(), results: healthyResults });
  if (searchCache.size > 500) searchCache.clear();
  return healthyResults;
}

/** Map a grabbed NZB URL back to its title + indexer via the search cache. */
function findCachedResultByUrl(url: string): { title: string; indexer: string | null } | null {
  for (const { results } of searchCache.values()) {
    for (const r of results) {
      if (r?.link === url) {
        return { title: r.title || 'Unknown release', indexer: r.indexer || r.indexerName || null };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// RSS passthrough via Prowlarr (recent releases — the piece Stremio can't do)
// ---------------------------------------------------------------------------

async function prowlarrRecent(categories: number[]): Promise<NewznabItem[]> {
  if (config.indexManager !== 'prowlarr' || !config.prowlarrUrl || !config.prowlarrApiKey) return [];
  const base = String(config.prowlarrUrl).replace(/\/+$/, '');
  const params = new URLSearchParams({ query: '', type: 'search', limit: String(RSS_LIMIT), offset: '0' });
  for (const c of categories) params.append('categories', String(c));
  const resp = await fetch(`${base}/api/v1/search?${params.toString()}`, {
    headers: { 'X-Api-Key': String(config.prowlarrApiKey), Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Prowlarr responded ${resp.status}`);
  const data = await resp.json() as any[];
  if (!Array.isArray(data)) return [];

  const items: NewznabItem[] = [];
  for (const r of data) {
    const link: string | undefined = r?.downloadUrl || r?.magnetUrl;
    if (!link || !/^https?:\/\//i.test(link)) continue;
    if (r?.protocol && String(r.protocol).toLowerCase() !== 'usenet') continue;
    const title: string = r?.title || 'Unknown release';
    const catIds: number[] = (r?.categories || []).map((c: any) => Number(c?.id)).filter(Number.isFinite);
    const isMovie = catIds.some((c) => c >= 2000 && c < 3000);
    items.push({
      title,
      guid: Buffer.from(`${title}\n${link}`).toString('base64url').slice(0, 40),
      nzbUrl: link,
      size: Number(r?.size) || 0,
      pubDate: parsePubDate(r?.publishDate),
      category: categoryFor(isMovie ? 'movie' : 'series', title),
      indexer: r?.indexer || undefined,
    });
  }
  items.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  return items.slice(0, RSS_LIMIT);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function intParam(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * prowlarrRecent() only ever fetches one fixed batch (up to RSS_LIMIT items) —
 * there's no real "next page" to fetch from Prowlarr. What was broken before:
 * every page request got served that same batch starting at offset 0, with
 * `total` always equal to the batch size, regardless of what the client
 * actually asked for. A client that respects the Newznab pagination contract
 * (stop once offset >= total) had no way to know it had already seen
 * everything, so it kept incrementing offset and re-fetching identical data.
 *
 * This slices the already-fetched batch honestly: `total` is the true size
 * of what UU has to offer (the full batch), and the returned items are the
 * real slice at the requested offset — empty once offset runs past the end,
 * which is the client's actual stop signal.
 */
function pageItems(items: NewznabItem[], req: Request): { page: NewznabItem[]; offset: number } {
  const offset = intParam(req.query.offset) ?? 0;
  const limit = intParam(req.query.limit) ?? items.length;
  return { page: items.slice(offset, offset + limit), offset };
}

export function createNewznabRoutes(): Router {
  const router = Router({ mergeParams: true });

  router.get('/api', async (req: Request, res: Response) => {
    const t = String(req.query.t ?? '').toLowerCase();
    const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;

    try {
      if (t === 'caps') return xml(res, capsXml());

      if (t === 'get') {
        console.log(`\u{1F4E5} Newznab t=get request received`);
        const encoded = String(req.query.d ?? '');
        let target = '';
        try { target = Buffer.from(encoded, 'base64url').toString('utf8'); } catch { /* noop */ }
        if (!/^https?:\/\//i.test(target)) return errorXml(res, 300, 'Bad or missing NZB reference');
        // Reputation: record the grab. Only *arr user agents count as real
        // grabs with a pending outcome; anything else is logged but not awaited.
        const grabUa = req.get('user-agent') || '';
        const isArrGrab = /sonarr|radarr|lidarr|whisparr|prowlarr/i.test(grabUa);
        try {
          const cached = findCachedResultByUrl(target);
          recordGrab(target, cached, isArrGrab, grabUa);
          if (isArrGrab && cached) {
            trackGrab(cached.indexer || 'Unknown', cached.title); // stats.json parity with Stremio path
          }
        } catch { /* noop — reputation must never block a grab */ }
        // Verify NZB health with UU's engine before handing to the download client.
        // Governed by the existing Health Checks toggle; disabled = passthrough.
        const hcProviders = (config as any).healthChecks?.providers?.filter((p: any) => p.enabled) || [];
        if ((config as any).healthChecks?.enabled && hcProviders.length > 0) {
          if (isDeadNzbByUrl(target)) {
            return errorXml(res, 410, 'NZB previously verified dead by health checks', 404);
          }
          const ua = (config as any).userAgents?.nzbDownload || getLatestVersions().chrome;
          try {
            const verdict = await Promise.race([
              performHealthCheck(target, hcProviders, ua, { archiveInspection: false, sampleCount: 3 }),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
            ]);
            if (verdict && verdict.playable === false) {
              addDeadNzbByUrl(target, 'newznab t=get grab');
              saveCacheToDisk();
              return errorXml(res, 410, `NZB failed health check: ${verdict.message}`, 404);
            }
          } catch { /* best-effort: verification errors never block serving */ }
          const cachedNzb = getCachedNzbContent(target);
          if (typeof cachedNzb === 'string' && cachedNzb.length > 0) {
            res.status(200).setHeader('Content-Type', 'application/x-nzb');
            res.setHeader('Content-Disposition', 'attachment; filename="release.nzb"');
            res.setHeader('Cache-Control', 'no-store');
            return res.send(Buffer.from(cachedNzb, 'utf8'));
          }
        }
        const upstream = await fetch(target, {
          redirect: 'follow',
          signal: AbortSignal.timeout(120_000),
          headers: { Accept: 'application/x-nzb, application/xml, text/xml, */*', 'User-Agent': 'uu-newznab/1.0' },
        });
        if (!upstream.ok) return errorXml(res, 300, `Upstream returned ${upstream.status}`, 502);
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length === 0 || buf.length > NZB_MAX_BYTES) return errorXml(res, 300, 'Upstream NZB empty or too large', 502);
        const head = buf.subarray(0, 512).toString('utf8').toLowerCase();
        if (!head.includes('<nzb') && !head.includes('<?xml')) return errorXml(res, 300, 'Upstream did not return an NZB', 502);
        res.status(200)
          .setHeader('Content-Type', 'application/x-nzb');
        res.setHeader('Content-Disposition', 'attachment; filename="release.nzb"');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(buf);
      }

      if (t === 'tvsearch') {
        const imdb = String(req.query.imdbid ?? '').trim();
        const imdbId = imdb ? (imdb.startsWith('tt') ? imdb : `tt${imdb}`) : '';
        const tvdbId = String(req.query.tvdbid ?? '').trim() || undefined;
        const season = intParam(req.query.season);
        const episode = intParam(req.query.ep);
        const qParam = String(req.query.q ?? '').trim();

        // True RSS poll: no ids, no season, no text query — Sonarr's periodic feed sync.
        if (!imdbId && !tvdbId && season === undefined && !qParam) {
          const items = await prowlarrRecent([5000]);
          const { page, offset } = pageItems(items, req);
          return xml(res, itemsXml(page, baseUrl, offset, items.length));
        }

        // Title-text fallback search (q + season, no ids): UU has no text→ID
        // resolution today, so pipelineSearch cannot run. Returning the
        // RSS-recent list here would silently hand Sonarr unrelated
        // releases that happen to share a category — worse than no
        // results, since they look like real matches. Return an accurate
        // empty set instead; total=0 also stops Sonarr's pagination loop
        // (it was previously re-requesting offset 0..2900+ against the
        // same recent-list content every time).
        if (!imdbId && !tvdbId) {
          return xml(res, itemsXml([], baseUrl));
        }

        const results = await pipelineSearch('series', imdbId, tvdbId, season, episode);
        const items = mapPipelineResults(results, 'series', { imdbId: imdbId || undefined, tvdbId, season, episode });
        return xml(res, itemsXml(items, baseUrl));
      }

      if (t === 'movie') {
        const imdb = String(req.query.imdbid ?? '').trim();
        const imdbId = imdb ? (imdb.startsWith('tt') ? imdb : `tt${imdb}`) : '';

        if (!imdbId) {
          const items = await prowlarrRecent([2000]);
          const { page, offset } = pageItems(items, req);
          return xml(res, itemsXml(page, baseUrl, offset, items.length));
        }

        const results = await pipelineSearch('movie', imdbId, undefined, undefined, undefined);
        const items = mapPipelineResults(results, 'movie', { imdbId });
        return xml(res, itemsXml(items, baseUrl));
      }

      if (t === 'search') {
        // Free-text search isn't ID-addressable; serve recent from both categories
        const items = await prowlarrRecent([2000, 5000]);
        const { page, offset } = pageItems(items, req);
        return xml(res, itemsXml(page, baseUrl, offset, items.length));
      }

      if (t === 'uu-reputation') {
        // Inspection endpoint (not part of Newznab spec — behind manifest-key auth)
        return res.status(200).json(getReputationData());
      }

      return errorXml(res, 202, `Unsupported function: ${t || '(none)'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`❌ Newznab route error (t=${t}): ${message}`);
      return errorXml(res, 900, message, 500);
    }
  });

  return router;
}
