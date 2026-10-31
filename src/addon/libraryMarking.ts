import type { HealthCheckResult } from '../health/index.js';
import { checkNzbLibrary, listLibraryFolderNames } from '../nzbdav/videoDiscovery.js';
import { buildDateEpisodePattern } from '../nzbdav/utils.js';
import type { NZBDavConfig } from '../nzbdav/types.js';

/** Keeps the results whose title has a library folder. An unknown listing keeps every result. */
export function pickLibraryLookups<T extends { title: string }>(results: T[], folders: Set<string> | undefined): T[] {
  return folders ? results.filter(r => folders.has(r.title)) : results;
}

/**
 * Mark candidates that already exist in the NZBDav library by calling
 * checkNzbLibrary in parallel. Skips entries already in healthResults so
 * concurrent callers (libraryPreCheck + displayLibraryInResults) don't
 * double-probe the same URL. Library hits are tagged
 * `{status:'verified', message:'Library', playable:true}` so the existing
 * streamBuilder maps them to the 📚 status badge. Returns the hit count.
 */
export async function markLibraryHits(
  candidates: any[],
  healthResults: Map<string, HealthCheckResult>,
  nzbdavConfig: NZBDavConfig,
  episodePattern: string | undefined,
  contentType: 'movie' | 'series',
  episodesInSeason: number | undefined,
  episodeAired?: string,
  folderListing?: Promise<Set<string> | undefined>,
): Promise<number> {
  // Re-check entries whose existing health entry is a Library tag — the file
  // may have been deleted from WebDAV since the cached search ran, so trusting
  // the prior `Library` verdict on cache hit leaves a stale 📚 icon on tiles
  // pointing at files that no longer exist. Non-library health results
  // (NNTP/Zyclops verdicts) are stable; skip those.
  const unchecked = candidates.filter(r => {
    const h = healthResults.get(r.link);
    return !h || h.message === 'Library';
  });
  if (unchecked.length === 0) return 0;
  // One folder listing replaces a WebDAV lookup per result. A result without a
  // matching folder cannot be a library hit, so it never needs the lookup.
  const lookups = pickLibraryLookups(unchecked, await (folderListing ?? listLibraryFolderNames(nzbdavConfig, contentType)));
  // Pass 2 fallback: daily/talk-show files in the library are date-named, so
  // SxxExx-only matching misses them. When the search context carries an
  // aired date, fall back to a date-pattern check after Pass 1 returns null.
  // Mirrors the search-side alias-fallback gate.
  const datePattern = buildDateEpisodePattern(episodeAired);
  let hits = 0;
  await Promise.all(lookups.map(async (r) => {
    try {
      let result = await checkNzbLibrary(
        r.title, nzbdavConfig, episodePattern, contentType, episodesInSeason, '', true,
      );
      if (!result && datePattern) {
        result = await checkNzbLibrary(
          r.title, nzbdavConfig, datePattern, contentType, episodesInSeason, '', true,
        );
      }
      if (result) {
        healthResults.set(r.link, { status: 'verified', message: 'Library', playable: true });
        // Local flag consumed by sortResults' preferLibraryResults tier-zero
        // comparator. Mutating the result here keeps the sort phase from needing
        // to thread the healthResults Map through its signature.
        r.inLibrary = true;
        hits++;
      } else if (r.inLibrary) {
        // Was in the library on the prior run but isn't now (file deleted via
        // the delete tile, manually removed from WebDAV, etc). Clear the stale
        // flag and drop the cached Library health entry so downstream sort and
        // streamBuilder stop painting the 📚 badge.
        r.inLibrary = false;
        if (healthResults.get(r.link)?.message === 'Library') {
          healthResults.delete(r.link);
        }
      }
    } catch {
      // Non-fatal — checkNzbLibrary only re-throws errors flagged isNzbdavFailure;
      // transient WebDAV blips don't break the search response.
    }
  }));
  return hits;
}
