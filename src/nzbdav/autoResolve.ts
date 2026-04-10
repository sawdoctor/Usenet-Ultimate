/**
 * Auto-Resolve
 *
 * Background NZB resolution for "from top of list" fallback mode.
 * Pre-fetches NZBs from indexers in parallel (grab chain), then submits
 * to NZBDav in strict priority order. Populates the library so user
 * clicks are instant.
 */

import { getOrCreateStream, isDeadNzbByUrl } from './streamCache.js';
import { prefetchNzb } from './nzbdavApi.js';
import { checkNzbLibrary } from './videoDiscovery.js';
import type { FallbackCandidate, NZBDavConfig } from './types.js';

// ── Active resolve tracking ──────────────────────────────────────────
// Keyed by content identity (e.g. "series:tt123:1:1") to prevent
// duplicate resolves across cache hits where fallbackGroupId differs.

const activeResolves = new Map<string, AbortController>();

/**
 * Resolve candidates in strict priority order with parallel pre-fetching.
 * The grab chain downloads NZBs from indexers ahead of time (sliding window),
 * while NZBDav submission happens one at a time in quality order.
 * Stops after `targetCount` healthy NZBs are found.
 */
export async function autoResolveFromCandidates(
  contentKey: string,
  candidates: FallbackCandidate[],
  nzbdavConfig: NZBDavConfig,
  episodePattern?: string,
  contentType?: string,
  episodesInSeason?: number,
  targetCount: number = 1,
): Promise<void> {
  if (activeResolves.has(contentKey)) return;

  const controller = new AbortController();
  activeResolves.set(contentKey, controller);

  const target = Math.min(targetCount, candidates.length);
  const tag = `🔄 Auto-Resolve [${contentKey}]`;

  try {
    console.log(`${tag} Starting — ${candidates.length} candidate(s), ${target} target(s)`);

    // ── Grab chain: sliding window with library check before prefetch ─
    let nextToFetch = 0;
    const fetchPromises = new Map<number, Promise<boolean>>();
    const libraryHits = new Map<number, string>(); // candidateIdx → videoPath
    const resolvedVideoPaths = new Set<string>();

    const grabCandidate = async (candidate: FallbackCandidate, idx: number): Promise<boolean> => {
      const grabPrefix = `[grab #${idx + 1}] `;
      // Check library first (quiet — caller logs the result)
      const libraryResult = await checkNzbLibrary(candidate.title, nzbdavConfig, episodePattern, contentType, episodesInSeason, grabPrefix, true);
      if (libraryResult) {
        libraryHits.set(idx, libraryResult.videoPath);
        console.log(`${grabPrefix}📚 HIT — ${candidate.title}`);
        return true;
      }
      // Library miss — download NZB from indexer for later submission
      console.log(`${grabPrefix}📚 MISS → prefetching`);
      return prefetchNzb(candidate.nzbUrl, grabPrefix, true);
    };

    const startNextPrefetches = () => {
      while (nextToFetch < candidates.length && fetchPromises.size < target) {
        const idx = nextToFetch++;
        if (isDeadNzbByUrl(candidates[idx].nzbUrl)) continue;
        fetchPromises.set(idx, grabCandidate(candidates[idx], idx));
      }
    };

    startNextPrefetches();

    // ── Sequential resolve in priority order ─────────────────────────
    let resolvedCount = 0;
    interface AttemptResult {
      title: string;
      candidateNum: number;
      outcome: 'resolved' | 'failed' | 'skipped';
      reason?: string;
      library?: boolean;
    }
    const attempts: AttemptResult[] = [];

    for (let i = 0; i < candidates.length; i++) {
      if (controller.signal.aborted) break;
      if (resolvedCount >= target) break;

      const candidate = candidates[i];
      const candidateNum = i + 1;

      if (isDeadNzbByUrl(candidate.nzbUrl)) {
        attempts.push({ title: candidate.title, candidateNum, outcome: 'skipped' });
        continue;
      }

      // Wait for this candidate's grab to complete (if one was started)
      const prefetchPromise = fetchPromises.get(i);
      if (prefetchPromise) {
        await prefetchPromise;
        fetchPromises.delete(i);
      }

      // Fill the grab chain window
      startNextPrefetches();

      // Library hit — grab chain already verified the file exists, skip full pipeline
      if (libraryHits.has(i)) {
        const videoPath = libraryHits.get(i)!;
        if (resolvedVideoPaths.has(videoPath)) {
          attempts.push({ title: candidate.title, candidateNum, outcome: 'skipped', reason: 'duplicate' });
          continue;
        }
        resolvedVideoPaths.add(videoPath);
        resolvedCount++;
        attempts.push({ title: candidate.title, candidateNum, outcome: 'resolved', library: true });
        console.log(`${tag} ✅ #${candidateNum} Ready — ${candidate.title} [${candidate.indexerName}] (library)`);
        continue;
      }

      // Library miss — run full pipeline (submit to NZBDav, wait, probe)
      console.log('');
      const logPrefix = `[#${candidateNum}] `;
      try {
        const streamData = await getOrCreateStream(
          candidate.nzbUrl,
          candidate.title,
          nzbdavConfig,
          episodePattern,
          contentType,
          episodesInSeason,
          candidate.indexerName,
          false,
          candidate.isSeasonPack,
          true, // skipReadyCache — rely on library check instead
          logPrefix,
        );
        if (resolvedVideoPaths.has(streamData.videoPath)) {
          attempts.push({ title: candidate.title, candidateNum, outcome: 'skipped', reason: 'duplicate' });
          continue;
        }
        resolvedVideoPaths.add(streamData.videoPath);
        resolvedCount++;
        attempts.push({ title: candidate.title, candidateNum, outcome: 'resolved' });
        console.log(`${tag} ✅ #${candidateNum} Ready — ${candidate.title} [${candidate.indexerName}]`);
      } catch (err) {
        attempts.push({ title: candidate.title, candidateNum, outcome: 'failed', reason: (err as Error).message });
        // Fill grab chain — a slot freed up
        startNextPrefetches();
      }
    }

    // ── Summary ──────────────────────────────────────────────────────
    console.log(`\n${tag} Finished — ${resolvedCount}/${target} NZB(s) resolved`);
    console.log(`${tag} ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`);
    for (const a of attempts) {
      if (a.outcome === 'resolved') {
        console.log(`${tag}   ✅ #${a.candidateNum} ${a.title}${a.library ? ' (library)' : ''}`);
      } else if (a.outcome === 'skipped') {
        console.log(`${tag}   ⏭️ #${a.candidateNum} ${a.title} (${a.reason || 'dead'})`);
      } else {
        console.log(`${tag}   ❌ #${a.candidateNum} ${a.title} — ${a.reason}`);
      }
    }
    if (resolvedCount === 0) {
      console.log(`${tag}   ❌ Exhausted all ${candidates.length} candidates`);
    }
  } finally {
    activeResolves.delete(contentKey);
  }
}

/** Cancel all running auto-resolves (called on settings change). */
export function cancelAllAutoResolves(): void {
  for (const [, controller] of activeResolves) {
    controller.abort();
  }
  activeResolves.clear();
}
