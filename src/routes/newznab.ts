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

function itemsXml(items: NewznabItem[], baseUrl: string, offset = 0): string {
  const lines: string[] = [
    '<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">',
    '<channel>',
    '<title>Usenet Ultimate</title>',
    `<link>${esc(baseUrl)}</link>`,
    '<description>UU curated results</description>',
    `<newznab:response offset="${offset}" total="${items.length}"/>`,
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

async function pipelineSearch(
  type: 'movie' | 'series',
  imdbId: string,
  tvdbId: string | undefined,
  season: number | undefined,
  episode: number | undefined,
): Promise<any[]> {
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
  return applyUserFilters(
    preFiltered, type, Date.now(), titleInfo.runtime, deprioritizedPacks, { quiet: true },
  );
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

export function createNewznabRoutes(): Router {
  const router = Router({ mergeParams: true });

  router.get('/api', async (req: Request, res: Response) => {
    const t = String(req.query.t ?? '').toLowerCase();
    const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;

    try {
      if (t === 'caps') return xml(res, capsXml());

      if (t === 'get') {
        const encoded = String(req.query.d ?? '');
        let target = '';
        try { target = Buffer.from(encoded, 'base64url').toString('utf8'); } catch { /* noop */ }
        if (!/^https?:\/\//i.test(target)) return errorXml(res, 300, 'Bad or missing NZB reference');
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

        // Identifier-free request = Sonarr RSS poll → Prowlarr recent passthrough
        if ((!imdbId && !tvdbId) || season === undefined) {
          const items = await prowlarrRecent([5000]);
          return xml(res, itemsXml(items, baseUrl));
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
          return xml(res, itemsXml(items, baseUrl));
        }

        const results = await pipelineSearch('movie', imdbId, undefined, undefined, undefined);
        const items = mapPipelineResults(results, 'movie', { imdbId });
        return xml(res, itemsXml(items, baseUrl));
      }

      if (t === 'search') {
        // Free-text search isn't ID-addressable; serve recent from both categories
        const items = await prowlarrRecent([2000, 5000]);
        return xml(res, itemsXml(items, baseUrl));
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
