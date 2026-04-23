/**
 * Result Filters
 *
 * Filtering passes applied to search results:
 *  - applyRemakeFilter: content-dependent — drops results from the wrong
 *    version of a remade/rebooted show; deprioritizes yearless packs
 *  - applyMultiEpisodeFilter: user-preference — drops multi-episode files
 *    for TV when the "allow multi-episode" setting is off
 *  - applyQualityFilters: user-preference — drops results whose parsed
 *    attributes are explicitly disabled (resolution, codec, source, etc.)
 *    and enforces configurable size bounds
 */

import { parseQuality, parseCodec, parseSource, parseVisualTag, parseAudioTag, parseLanguage, parseEdition, parseYear } from '../parsers/metadataParsers.js';
import { isRemakeFiltered } from '../parsers/titleMatching.js';
import type { FilterConfig } from '../types.js';

/**
 * Filter out results from the wrong version of a remade/rebooted show.
 * For season packs: correct year → kept; wrong year → removed; no year → deprioritized to end.
 * For episodes: yearless releases must contain the episode name; year-present releases must
 * match the expected year within ±1. Episode filtering is skipped when episodeName is unavailable.
 * Returns two arrays: results kept in their normal position, and packs deprioritized to the end.
 */
export function applyRemakeFilter(allResults: any[], hasRemake?: boolean, episodeName?: string, year?: string, titleYear?: string): { results: any[]; deprioritizedPacks: any[] } {
  if (!hasRemake || !year) return { results: allResults, deprioritizedPacks: [] };

  const yearMatchesAny = (parsed: string) => {
    const p = parseInt(parsed, 10);
    if (Math.abs(p - parseInt(year, 10)) <= 1) return true;
    if (titleYear && Math.abs(p - parseInt(titleYear, 10)) <= 1) return true;
    return false;
  };

  const removed: string[] = [];
  const deprioritizedTitles: string[] = [];
  const deprioritizedPacks: any[] = [];

  const results = allResults.filter(r => {
    if (r.isSeasonPack) {
      const parsedYear = parseYear(r.title);
      if (!parsedYear) {
        deprioritizedPacks.push(r);
        deprioritizedTitles.push(r.title);
        return false;
      }
      if (!yearMatchesAny(parsedYear)) {
        removed.push(r.title);
        return false;
      }
      return true;
    }
    // Regular episode — skip if episodeName unavailable (e.g. TVDB lookup failed)
    if (episodeName && isRemakeFiltered(r.title, episodeName, year, titleYear)) {
      removed.push(r.title);
      return false;
    }
    return true;
  });

  if (removed.length > 0) {
    console.log(`🎯 Remake filter: removed ${removed.length} result(s) from wrong version (${results.length} remaining)`);
    for (const title of removed) console.log(`   ✂️  "${title}"`);
  }
  if (deprioritizedTitles.length > 0) {
    console.log(`🎯 Remake filter: deprioritized ${deprioritizedTitles.length} yearless season pack(s) to end of results`);
    for (const title of deprioritizedTitles) console.log(`   ⬇️  "${title}"`);
  }

  return { results, deprioritizedPacks };
}

/**
 * Drop multi-episode files when the TV config disallows them.
 * Matches titles with S01E01E02, S01E01-02, etc. Skipped for movies and when allowed.
 */
export function applyMultiEpisodeFilter(allResults: any[]): any[] {
  const multiEpRegex = /S\d+[. _-]?E\d+(?:[. _-]?E\d+|-\d{1,2}(?!\d))/i;
  const filtered: string[] = [];
  const kept = allResults.filter(r => {
    if (multiEpRegex.test(r.title)) { filtered.push(r.title); return false; }
    return true;
  });
  if (filtered.length > 0) {
    console.log(`🎯 Filtered ${filtered.length} multi-episode result(s) (${kept.length} remaining)`);
    for (const title of filtered) console.log(`   ✂️  "${title}"`);
  }
  return kept;
}

/**
 * Apply enabled-priority filters: remove results whose parsed attribute
 * is explicitly disabled in the filter config.
 */
export function applyQualityFilters(allResults: any[], filterConfig?: FilterConfig): any[] {
  if (!filterConfig) return allResults;

  let results = allResults;

  // File size filters — individual files only (season packs have separate filters)
  if (filterConfig.minFileSize != null) {
    const before = results.length;
    results = results.filter(r => r.isSeasonPack || r.size >= (filterConfig.minFileSize ?? 0));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by min file size (${results.length} remaining)`);
  }
  if (filterConfig.maxFileSize != null) {
    const before = results.length;
    results = results.filter(r => r.isSeasonPack || r.size <= (filterConfig.maxFileSize ?? Infinity));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by max file size (${results.length} remaining)`);
  }
  // Season pack size filters — total pack size
  if (filterConfig.minSeasonPackSize != null) {
    const before = results.length;
    results = results.filter(r => !r.isSeasonPack || r.size >= (filterConfig.minSeasonPackSize ?? 0));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by min season pack size (${results.length} remaining)`);
  }
  if (filterConfig.maxSeasonPackSize != null) {
    const before = results.length;
    results = results.filter(r => !r.isSeasonPack || r.size <= (filterConfig.maxSeasonPackSize ?? Infinity));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by max season pack size (${results.length} remaining)`);
  }
  // Season pack per-episode size filters — estimated per-episode size
  if (filterConfig.minSeasonPackEpisodeSize != null) {
    const before = results.length;
    results = results.filter(r => !r.isSeasonPack || (r.estimatedEpisodeSize ?? r.size) >= (filterConfig.minSeasonPackEpisodeSize ?? 0));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by min season pack per-episode size (${results.length} remaining)`);
  }
  if (filterConfig.maxSeasonPackEpisodeSize != null) {
    const before = results.length;
    results = results.filter(r => !r.isSeasonPack || (r.estimatedEpisodeSize ?? r.size) <= (filterConfig.maxSeasonPackEpisodeSize ?? Infinity));
    if (before - results.length > 0) console.log(`🎯 Filtered ${before - results.length} by max season pack per-episode size (${results.length} remaining)`);
  }

  // Filter out results with disabled priorities
  const ep = filterConfig.enabledPriorities || {};
  const hasDisabled = (obj: Record<string, boolean> | undefined) => obj && Object.values(obj).some(v => v === false);

  if (hasDisabled(ep.resolution)) {
    const before = results.length;
    results = results.filter(r => ep.resolution?.[parseQuality(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled resolutions`);
  }
  if (hasDisabled(ep.video)) {
    const before = results.length;
    results = results.filter(r => ep.video?.[parseSource(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled video sources`);
  }
  if (hasDisabled(ep.encode)) {
    const before = results.length;
    results = results.filter(r => ep.encode?.[parseCodec(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled encodes`);
  }
  if (hasDisabled(ep.visualTag)) {
    const before = results.length;
    results = results.filter(r => ep.visualTag?.[parseVisualTag(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled visual tags`);
  }
  if (hasDisabled(ep.audioTag)) {
    const before = results.length;
    results = results.filter(r => ep.audioTag?.[parseAudioTag(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled audio tags`);
  }
  if (hasDisabled(ep.language)) {
    const before = results.length;
    results = results.filter(r => ep.language?.[parseLanguage(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled languages`);
  }
  if (hasDisabled(ep.edition)) {
    const before = results.length;
    results = results.filter(r => ep.edition?.[parseEdition(r.title)] !== false);
    if (results.length < before) console.log(`🎯 Filtered ${before - results.length} by disabled editions`);
  }

  return results;
}
