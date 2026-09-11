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
 *   t=get&d=<signed NZB reference>  — proxy the original NZB
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
import { performHealthCheck, getCachedNzbContent, cacheNzbContent, getNzbCacheStats, type HealthCheckResult } from '../health/index.js';
import { parseNzbXml, classifyNzbFiles } from '../health/nzbParser.js';
import { isDeadNzbByUrl, addDeadNzbByUrl, saveCacheToDisk } from '../nzbdav/streamCache.js';
import { getLatestVersions } from '../versionFetcher.js';
import { SingleFlight } from '../utils/singleFlight.js';
import { recordHealthCheck, recordPasswordEvidence, recordGrab, recordDeadCacheEvidence, getReputationData } from '../reputationTracker.js';
import { trackGrab } from '../statsTracker.js';
import { generateNewznabReference, verifyNewznabReference } from '../auth/auth.js';

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

function itemsXml(items: NewznabItem[], baseUrl: string, manifestKey: string, offset = 0, total = items.length): string {
  const lines: string[] = [
    '<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">',
    '<channel>',
    '<title>Usenet Ultimate</title>',
    `<link>${esc(baseUrl)}</link>`,
    '<description>UU curated results</description>',
    `<newznab:response offset="${offset}" total="${total}"/>`,
  ];
  for (const it of items) {
    const reference = generateNewznabReference(it.nzbUrl, manifestKey);
    const dl = `${baseUrl}/api?t=get&amp;d=${encodeURIComponent(reference)}`;
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

/**
 * In-flight upstream NZB downloads, keyed by target URL.
 *
 * The payload cache only helps once a fetch has COMPLETED. An upstream fetch
 * may run for up to 120s, and an arr retrying a failed grab can re-request the
 * same release inside that window — so two requests both miss the cache and
 * both open a download. Coalescing makes any concurrent request await the
 * single fetch already in progress.
 */
const inflightNzbFetches = new SingleFlight<string, { buf: Buffer } | { error: string; status: number }>();

async function fetchNzbCoalesced(target: string): Promise<{ buf: Buffer } | { error: string; status: number }> {
  return inflightNzbFetches.run(target, async (): Promise<{ buf: Buffer } | { error: string; status: number }> => {
    try {
      const upstream = await fetch(target, {
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
        headers: { Accept: 'application/x-nzb, application/xml, text/xml, */*', 'User-Agent': 'uu-newznab/1.0' },
      });
      if (!upstream.ok) return { error: `Upstream returned ${upstream.status}`, status: 502 };
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length === 0 || buf.length > NZB_MAX_BYTES) return { error: 'Upstream NZB empty or too large', status: 502 };
      const head = buf.subarray(0, 512).toString('utf8').toLowerCase();
      if (!head.includes('<nzb') && !head.includes('<?xml')) return { error: 'Upstream did not return an NZB', status: 502 };
      // Cache before returning, so a joiner and every later retry are served
      // from memory. Keyed on `target` — the same key the read above and
      // nzbParser.ts use, so search, grab and retry share one entry.
      try { cacheNzbContent(target, buf.toString('utf8')); } catch { /* noop — caching must never break a grab */ }
      return { buf };
    } catch (err) {
      return { error: `NZB download failed: ${(err as Error)?.message || err}`, status: 502 };
    }
  }, () => {
    console.log(`\u{1F4E6} Newznab t=get: joining in-flight upstream fetch — no second download`);
  });
}

/**
 * Inspect an NZB payload the caller already holds.
 *
 * With search-time health checking off, this is the only place password and
 * disc-image metadata is still discovered — and it runs on the release the
 * client actually selected rather than on N speculative candidates. The
 * payload is already in hand (cache hit or the coalesced fetch), so this adds
 * ZERO upstream requests. Parsing is delegated to the shared nzbParser.
 *
 * Returns a rejection reason, or null when the release is acceptable.
 */
/**
 * on|off|true|false|1|0 env flag. Hoisted to module scope so the t=get
 * inspector and the search-path client profile read the same toggles through
 * the same parser rather than each implementing their own.
 */
function envFlag(name: string, dflt: boolean): boolean {
  const v = (process.env[name] || '').toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return dflt;
}

async function inspectSelectedNzb(
  nzbXml: string,
  target: string,
  identity: { title: string; indexer: string | null } | null,
): Promise<string | null> {
  let parsed;
  try {
    parsed = await parseNzbXml(nzbXml, target);
  } catch (err) {
    // A malformed payload is not grounds for refusing the grab: the download
    // client is a better judge of that than a parse failure here.
    console.warn(`\u{1F50E} Newznab t=get: could not parse NZB for inspection (${(err as Error)?.message || err}) — serving unparsed`);
    return null;
  }

  // Password metadata is deterministic diagnostic metadata, not a rejection
  // condition and not a reputation penalty. InfiniDysk/NzbDAV can successfully
  // handle releases with a known password, so actual Arr/download outcomes
  // remain the authoritative success/failure signal. recordPasswordEvidence is
  // idempotent per release record, so repeats do not double-count metadata.
  if (parsed.password && identity?.title) {
    try {
      recordPasswordEvidence(identity.title, identity.indexer ?? null);
      console.log(`\u{1F510} Newznab t=get: password metadata present — recorded as diagnostic metadata for "${identity.title}"`);
    } catch { /* noop — reputation must never break a grab */ }
  } else if (parsed.password) {
    console.log(`\u{1F510} Newznab t=get: password metadata present but grab is uncorrelated — diagnostic identity not recorded`);
  }

  const { containerType, videoCount, archiveCount, discImageCount } = classifyNzbFiles(parsed.files);
  console.log(`\u{1F50E} Newznab t=get: ${parsed.files.length} files (${videoCount} video, ${archiveCount} archive${discImageCount > 0 ? `, ${discImageCount} disc-image` : ''})${containerType ? ` [${containerType}]` : ''}`);

  // Same policy as the search path: a disc image is only rejected when the
  // title fails to declare it. A release honestly labelled BDMV/ISO is a
  // deliberate choice by whoever configured the profile.
  const allowDiscImages = envFlag('NEWZNAB_ALLOW_DISC_IMAGES', false);
  const discTitleRe = /\b(bdiso|bdmv|br[-._ ]?disk|complete[-._ ]?blu[-._ ]?ray|full[-._ ]?blu[-._ ]?ray|iso)\b/i;
  if (!allowDiscImages && containerType === 'ISO' && !discTitleRe.test(identity?.title || '')) {
    return `payload is a disc image but the title doesn't declare it (set NEWZNAB_ALLOW_DISC_IMAGES=on to keep these)`;
  }

  return null;
}

/**
 * Durable grab correlation: NZB URL -> the identity that was known when the
 * result was generated.
 *
 * The search-results cache cannot serve this purpose. It expires in 10 minutes
 * and is cleared WHOLESALE at 500 entries, but an arr routinely grabs long
 * after the search that produced the result — so recordGrab fell through to
 * `unknown:<url tail>`, a key that can never match a real release and always
 * ages out as lost, silently discarding the import outcome that is the
 * reputation engine's strongest signal.
 *
 * Deliberately separate from searchCache: results go stale in minutes, but a
 * URL's identity never changes. Bounded and TTL'd independently.
 */
const GRAB_IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;
const GRAB_IDENTITY_MAX = 5000;
const grabIdentityCache = new Map<string, { title: string; indexer: string | null; at: number }>();

function rememberGrabIdentity(url: string, title: string, indexer: string | null): void {
  if (!url || !title) return;
  // Re-inserting moves the key to the end of Map iteration order, which is
  // what makes the eviction below least-recently-SEEN rather than oldest.
  grabIdentityCache.delete(url);
  grabIdentityCache.set(url, { title, indexer, at: Date.now() });

  if (grabIdentityCache.size > GRAB_IDENTITY_MAX) {
    const cutoff = Date.now() - GRAB_IDENTITY_TTL_MS;
    for (const [k, v] of grabIdentityCache) {
      if (v.at < cutoff) grabIdentityCache.delete(k);
    }
    // Still over: drop oldest-inserted until under the cap. Never unbounded.
    while (grabIdentityCache.size > GRAB_IDENTITY_MAX) {
      const oldest = grabIdentityCache.keys().next().value;
      if (oldest === undefined) break;
      grabIdentityCache.delete(oldest);
    }
  }
}

function lookupGrabIdentity(url: string): { title: string; indexer: string | null } | null {
  const hit = grabIdentityCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > GRAB_IDENTITY_TTL_MS) {
    grabIdentityCache.delete(url);
    return null;
  }
  return { title: hit.title, indexer: hit.indexer };
}

const searchCache = new Map<string, { at: number; results: any[] }>();
const SEARCH_CACHE_MS = 10 * 60 * 1000;

/**
 * URLs that passed a health check during search, with the time of that check.
 * t=get arrives seconds-to-minutes after the search that produced the result,
 * against the same providers and the same NZB — re-running the full check
 * there costs the arr a grab-time stall and the providers a second round of
 * STAT traffic for an answer we already have. Only positive verdicts are
 * cached (negatives already live in the dead-NZB cache, which t=get consults
 * first) and only for the lifetime of the search results themselves.
 */
const freshVerdictCache = new Map<string, number>();

// Coalesce selected-grab verification just like upstream NZB downloads. Arr
// can retry t=get while the first request is still running; every retry must
// join the same NNTP check instead of opening another one. The NZB payload is
// already cached before this runs, so verification costs zero extra indexer
// downloads.
const inflightSelectedHealthChecks = new SingleFlight<string, HealthCheckResult>();
const recentUnverifiedChecks = new Map<string, { at: number; result: HealthCheckResult }>();
const UNVERIFIED_RETRY_TTL_MS = 60_000;

function recordFreshVerdict(url: string): void {
  freshVerdictCache.set(url, Date.now());
  if (freshVerdictCache.size > 1000) {
    const cutoff = Date.now() - SEARCH_CACHE_MS;
    for (const [u, at] of freshVerdictCache) {
      if (at < cutoff) freshVerdictCache.delete(u);
    }
    // Still oversized after pruning expired entries (a burst of searches):
    // drop everything rather than grow without bound.
    if (freshVerdictCache.size > 1000) freshVerdictCache.clear();
  }
}

function hasFreshVerdict(url: string): boolean {
  const at = freshVerdictCache.get(url);
  if (at === undefined) return false;
  if (Date.now() - at >= SEARCH_CACHE_MS) {
    freshVerdictCache.delete(url);
    return false;
  }
  return true;
}

async function verifySelectedGrab(
  target: string,
  providers: any[],
  identity: { title: string; indexer: string | null } | null,
): Promise<HealthCheckResult> {
  if (hasFreshVerdict(target)) {
    return { status: 'verified', message: 'Recent selected-grab verification', playable: true };
  }

  const recentUnverified = recentUnverifiedChecks.get(target);
  if (recentUnverified) {
    if (Date.now() - recentUnverified.at < UNVERIFIED_RETRY_TTL_MS) {
      console.log(`\u{1FA7A} Newznab t=get: reusing recent unverified verdict — no repeated NNTP check`);
      return recentUnverified.result;
    }
    recentUnverifiedChecks.delete(target);
  }

  const hc = (config as any).healthChecks;
  const ua = (config as any).userAgents?.nzbDownload || getLatestVersions().chrome;
  return inflightSelectedHealthChecks.run(target, async () => {
    const result = await performHealthCheck(
      target,
      providers,
      ua,
      {
        archiveInspection: hc?.archiveInspection ?? true,
        sampleCount: hc?.sampleCount === 7 ? 7 : 3,
        segmentChecks: true,
      },
      undefined,
      identity?.indexer || undefined,
    );
    const blocked = result.status === 'blocked';

    if (result.playable === true) {
      recordFreshVerdict(target);
    } else if (result.status === 'error') {
      // Fail open on provider trouble, but suppress immediate retry storms.
      recentUnverifiedChecks.set(target, { at: Date.now(), result });
    }

    if (result.status !== 'error' && identity?.title) {
      try {
        recordHealthCheck(identity.title, identity.indexer, !blocked, result.message);
      } catch { /* reputation must never break a grab */ }
    }

    if (blocked) {
      addDeadNzbByUrl(
        target,
        identity?.title || 'Newznab selected-grab verification',
        identity?.indexer || undefined,
      );
      saveCacheToDisk();
    }

    return result;
  }, () => {
    console.log(`\u{1FA7A} Newznab t=get: joining in-flight selected-grab health check`);
  });
}

async function selectedGrabBlockReason(
  target: string,
  providers: any[],
  identity: { title: string; indexer: string | null } | null,
): Promise<string | null> {
  if (!(config as any).healthChecks?.enabled || providers.length === 0) return null;
  try {
    const result = await verifySelectedGrab(target, providers, identity);
    if (result.status === 'blocked') return result.message;
    if (result.status === 'error') {
      console.warn(`\u{1FA7A} Newznab t=get: health check inconclusive — serving selected NZB (${result.message})`);
    } else {
      console.log(`\u{1FA7A} Newznab t=get: selected NZB ${result.status} — ${result.message}`);
    }
  } catch (err) {
    console.warn(`\u{1FA7A} Newznab t=get: health check failed unexpectedly — serving selected NZB (${(err as Error)?.message || err})`);
  }
  return null;
}

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
  const flag = envFlag;
  const clientProfile = {
    resolutionFilters: flag('NEWZNAB_RESOLUTION_FILTERS', true),
    sourceFilters: flag('NEWZNAB_SOURCE_FILTERS', false),
    streamLimits: flag('NEWZNAB_STREAM_LIMITS', false),
  };
  let finalResults = applyUserFilters(
    preFiltered, type, Date.now(), titleInfo.runtime, deprioritizedPacks, { quiet: true, clientProfile },
  );
  console.log(`\u{1F4F0} Newznab: client-profile mode (resolution=${clientProfile.resolutionFilters ? 'on' : 'off'}, source=${clientProfile.sourceFilters ? 'on' : 'off'}, limits=${clientProfile.streamLimits ? 'on' : 'off'}) — returning ${finalResults.length} result(s) for the client's own profile to rank`);
  // Keep the existing quality/profile ordering intact. Arr applications
  // perform their own final quality ranking, so globally replacing quality
  // order here would be unsafe. Search responses only filter the persistent
  // known-dead cache; live checks run after the arr selects one result.
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
    console.log(`\u{1FA7A} Newznab: selected-grab health mode — candidate NZB prefetch disabled`);
  }
  // Record identity for every result we hand out — including ones served from
  // the search cache path — so a grab arriving hours later still resolves.
  for (const r of healthyResults) {
    if (r?.link) rememberGrabIdentity(r.link, r.title || '', r.indexer || r.indexerName || null);
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
    const manifestKey = String(req.params.manifestKey ?? '');

    try {
      if (t === 'caps') return xml(res, capsXml());

      if (t === 'get') {
        console.log(`\u{1F4E5} Newznab t=get request received`);
        const reference = String(req.query.d ?? '');
        const target = verifyNewznabReference(reference, manifestKey);
        if (!target) return errorXml(res, 300, 'Bad, expired, or unsigned NZB reference');
        // Reputation: record the grab. Only *arr user agents count as real
        // grabs with a pending outcome; anything else is logged but not awaited.
        const grabUa = req.get('user-agent') || '';
        const isArrGrab = /sonarr|radarr|lidarr|whisparr|prowlarr/i.test(grabUa);
        // Durable identity first; the 10-minute search cache is only a fallback.
        const grabIdentity = lookupGrabIdentity(target) || findCachedResultByUrl(target);
        // NOTE: grab bookkeeping deliberately does NOT happen here. A release
        // UU itself refuses — known-dead, or rejected on inspection — never
        // reaches the download client, so recording it as a grab would leave a
        // pending arr outcome for something nothing ever received. See
        // recordDeliveredGrab(), called only on the delivery paths below.
        let grabRecorded = false;
        const recordDeliveredGrab = (): void => {
          if (grabRecorded) return;
          grabRecorded = true;
          try {
            recordGrab(target, grabIdentity, isArrGrab, grabUa);
            if (isArrGrab && grabIdentity) {
              trackGrab(grabIdentity.indexer || 'Unknown', grabIdentity.title); // stats.json parity with Stremio path
            }
          } catch { /* noop — reputation must never block a grab */ }
        };
        // Verify NZB health with UU's engine before handing to the download client.
        // Governed by the existing Health Checks toggle; disabled = passthrough.
        const hcProviders = (config as any).healthChecks?.providers?.filter((p: any) => p.enabled) || [];
        // Dead check FIRST. A cached payload proves only that UU downloaded
        // this XML before — never that the release is still healthy — so the
        // cache must not serve something verification already rejected.
        if ((config as any).healthChecks?.enabled && hcProviders.length > 0) {
          if (isDeadNzbByUrl(target)) {
            return errorXml(res, 410, 'NZB previously verified dead by health checks', 404);
          }
        }
        // Payload cache, read unconditionally and exactly once. Nothing
        // between here and the fetch can populate it, so a second read would
        // be a guaranteed second miss and would double-count the stats.
        const cachedNzb = getCachedNzbContent(target);
        if (typeof cachedNzb === 'string' && cachedNzb.length > 0) {
          console.log(`\u{1F4E6} Newznab t=get: payload cache HIT (${cachedNzb.length} bytes) — no upstream fetch`);
          const reject = await inspectSelectedNzb(cachedNzb, target, grabIdentity);
          if (reject) {
            console.log(`\u{1F6AB} Newznab t=get: refusing "${grabIdentity?.title || target.slice(0, 60)}" — ${reject}`);
            return errorXml(res, 300, `Release rejected on inspection: ${reject}`, 404);
          }
          const healthReject = await selectedGrabBlockReason(target, hcProviders, grabIdentity);
          if (healthReject) {
            console.log(`\u{1F6AB} Newznab t=get: refusing "${grabIdentity?.title || target.slice(0, 60)}" — ${healthReject}`);
            return errorXml(res, 300, `Release rejected by health checks: ${healthReject}`, 404);
          }
          recordDeliveredGrab();
          res.status(200).setHeader('Content-Type', 'application/x-nzb');
          res.setHeader('Content-Disposition', 'attachment; filename="release.nzb"');
          res.setHeader('Cache-Control', 'no-store');
          return res.send(Buffer.from(cachedNzb, 'utf8'));
        }
        console.log(`\u{1F4E6} Newznab t=get: payload cache MISS — fetching upstream`);
        const fetched = await fetchNzbCoalesced(target);
        if ('error' in fetched) return errorXml(res, 300, fetched.error, fetched.status);
        const buf = fetched.buf;
        // Inspect the payload we just fetched. Coalesced joiners each inspect
        // the shared buffer — parsing is local, so this costs no extra request.
        const rejectFresh = await inspectSelectedNzb(buf.toString('utf8'), target, grabIdentity);
        if (rejectFresh) {
          console.log(`\u{1F6AB} Newznab t=get: refusing "${grabIdentity?.title || target.slice(0, 60)}" — ${rejectFresh}`);
          return errorXml(res, 300, `Release rejected on inspection: ${rejectFresh}`, 404);
        }
        const healthReject = await selectedGrabBlockReason(target, hcProviders, grabIdentity);
        if (healthReject) {
          console.log(`\u{1F6AB} Newznab t=get: refusing "${grabIdentity?.title || target.slice(0, 60)}" — ${healthReject}`);
          return errorXml(res, 300, `Release rejected by health checks: ${healthReject}`, 404);
        }
        recordDeliveredGrab();
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
          return xml(res, itemsXml(page, baseUrl, manifestKey, offset, items.length));
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
          return xml(res, itemsXml([], baseUrl, manifestKey));
        }

        const results = await pipelineSearch('series', imdbId, tvdbId, season, episode);
        const items = mapPipelineResults(results, 'series', { imdbId: imdbId || undefined, tvdbId, season, episode });
        return xml(res, itemsXml(items, baseUrl, manifestKey));
      }

      if (t === 'movie') {
        const imdb = String(req.query.imdbid ?? '').trim();
        const imdbId = imdb ? (imdb.startsWith('tt') ? imdb : `tt${imdb}`) : '';

        if (!imdbId) {
          const items = await prowlarrRecent([2000]);
          const { page, offset } = pageItems(items, req);
          return xml(res, itemsXml(page, baseUrl, manifestKey, offset, items.length));
        }

        const results = await pipelineSearch('movie', imdbId, undefined, undefined, undefined);
        const items = mapPipelineResults(results, 'movie', { imdbId });
        return xml(res, itemsXml(items, baseUrl, manifestKey));
      }

      if (t === 'search') {
        // Free-text search isn't ID-addressable; serve recent releases —
        // but honour the client's cat= parameter. Previously this branch
        // always returned BOTH movies (2000) and TV (5000) regardless of
        // what the client asked for, so e.g. a Radarr falling back to
        // t=search with cat=2000 received TV releases mixed into movie
        // results. Newznab cat values are comma-separated subcategory ids
        // (2040, 5030...); map them to their top-level Prowlarr category.
        // No cat= means the client genuinely wants everything — keep both.
        const requestedCats = String(req.query.cat ?? '')
          .split(',')
          .map((c) => parseInt(c.trim(), 10))
          .filter(Number.isFinite);
        const wantsMovies = requestedCats.some((c) => c >= 2000 && c < 3000);
        const wantsTv = requestedCats.some((c) => c >= 5000 && c < 6000);
        const cats = wantsMovies || wantsTv
          ? [...(wantsMovies ? [2000] : []), ...(wantsTv ? [5000] : [])]
          : [2000, 5000];
        const items = await prowlarrRecent(cats);
        const { page, offset } = pageItems(items, req);
        return xml(res, itemsXml(page, baseUrl, manifestKey, offset, items.length));
      }

      if (t === 'uu-reputation') {
        // Inspection endpoint (not part of Newznab spec — behind manifest-key auth)
        return res.status(200).json({ ...getReputationData(), nzbCache: getNzbCacheStats() });
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
