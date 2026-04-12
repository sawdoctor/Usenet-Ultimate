/**
 * Ultimate-Resolve
 *
 * Combines NZB Fallback with Health Checking for the fastest possible
 * NZB resolution. Runs four parallel layers simultaneously:
 *   1. Library pre-check (WebDAV lookup — no NZB download needed)
 *   2. Grab chain (NZB download from indexers)
 *   3. Health checks (NNTP article verification, streams per-candidate as grabs complete)
 *   4. nzbdav submission (one active job at a time, direct API calls for cancellation control)
 */

import { config as globalConfig } from '../config/index.js';
import { getLatestVersions } from '../versionFetcher.js';
import { performHealthCheck } from '../health/healthCheckPipeline.js';
import { NntpConnectionPool } from '../health/nntpConnection.js';
import type { HealthCheckResult } from '../health/types.js';
import { isDeadNzbByUrl, getCacheKey, setReadyCacheEntry, setDeadNzbEntry, addDeadNzbByUrl, saveCacheToDisk, getOrCreateStream } from './streamCache.js';
import { submitNzb, waitForJobCompletion, cancelJob, prefetchNzb } from './nzbdavApi.js';
import { checkNzbLibrary, waitForVideoFile } from './videoDiscovery.js';
import { encodeWebdavPath, nzbdavError } from './utils.js';
import type { FallbackCandidate, NZBDavConfig, StreamData } from './types.js';

// ── Types ────────────────────────────────────────────────────────────

interface CandidateState {
  candidate: FallbackCandidate;
  poolIndex: number;
  healthStatus: 'pending' | 'checking' | 'healthy' | 'dead' | 'error';
  grabStatus: 'pending' | 'grabbing' | 'done' | 'failed';
  healthPromise?: Promise<{ cs: CandidateState; result: HealthCheckResult }>;
  grabPromise?: Promise<{ cs: CandidateState; ok: boolean }>;
  nzbdavStatus: 'idle' | 'submitted' | 'completed' | 'failed';
  nzoId?: string;
  cancelled?: boolean;
}

interface UltimateResolveOptions {
  candidateCount: number;
  preferenceMode: 'priority' | 'speed';
  archiveInspection: boolean;
  sampleCount: 3 | 7;
  maxCandidates: number;
  healthCheckIndexers?: Record<string, boolean>;
}

// ── Active session tracking ─────────────────────────────────────────

const activeSessions = new Map<string, AbortController>();

// Session promises — lobby awaits these to get the resolved stream
interface DeferredStream {
  promise: Promise<StreamData>;
  resolve: (data: StreamData) => void;
  reject: (err: Error) => void;
}
const sessionPromises = new Map<string, DeferredStream>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Get the session promise for a content key (used by stream handler lobby). */
export function getSessionPromise(contentKey: string): Promise<StreamData> | null {
  return sessionPromises.get(contentKey)?.promise ?? null;
}

/** Check if any Ultimate-Resolve sessions are active. */
export function hasAnySessions(): boolean {
  return activeSessions.size > 0;
}

/** Cancel all running Ultimate-Resolve sessions (called on settings change). */
export function cancelAllUltimateResolves(): void {
  for (const [, controller] of activeSessions) {
    controller.abort();
  }
  activeSessions.clear();
  for (const [, timer] of cleanupTimers) {
    clearTimeout(timer);
  }
  cleanupTimers.clear();
  // Reject any pending session promises
  for (const [key, deferred] of sessionPromises) {
    deferred.reject(new Error('Ultimate-Resolve cancelled'));
    sessionPromises.delete(key);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function isHealthy(result: HealthCheckResult): boolean {
  return result.status === 'verified' || result.status === 'verified_stored' || result.status === 'verified_archive';
}

/** Limit concurrency for a batch of async tasks. */
async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  const running = new Set<Promise<void>>();
  for (const task of tasks) {
    const p = task().then(r => { results.push(r); });
    running.add(p);
    p.finally(() => running.delete(p));
    if (running.size >= limit) await Promise.race(running);
  }
  await Promise.all(running);
  return results;
}

/** Probe a video file via WebDAV to verify it's servable. */
async function probeVideo(config: NZBDavConfig, videoPath: string, logPrefix: string): Promise<boolean> {
  const webdavBase = (config.webdavUrl || config.url).replace(/\/+$/, '');
  const probeUrl = `${webdavBase}${encodeWebdavPath(videoPath)}`;
  const probeHeaders: Record<string, string> = { 'Range': 'bytes=0-0' };
  if (config.webdavUser && config.webdavPassword) {
    probeHeaders['Authorization'] = 'Basic ' + Buffer.from(`${config.webdavUser}:${config.webdavPassword}`).toString('base64');
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(probeUrl, { headers: probeHeaders, signal: AbortSignal.timeout(10_000) });
      await resp.body?.cancel().catch(() => {});
      if (resp.status === 206 || resp.status === 200) return true;
      if (resp.status === 404 || resp.status === 410) return false;
    } catch { /* retry */ }
    if (attempt < 1) await new Promise(r => setTimeout(r, 2000));
  }
  console.warn(`${logPrefix}  ⚠️ Probe failed after 2 attempts`);
  return false;
}

// ── Main pipeline ────────────────────────────────────────────────────

export async function ultimateResolveFromCandidates(
  contentKey: string,
  candidates: FallbackCandidate[],
  nzbdavConfig: NZBDavConfig,
  options: UltimateResolveOptions,
  episodePattern?: string,
  contentType?: string,
  episodesInSeason?: number,
): Promise<void> {
  if (activeSessions.has(contentKey)) return;

  const controller = new AbortController();
  activeSessions.set(contentKey, controller);

  // Create deferred promise — lobby awaits this to get the resolved stream
  let sessionResolve!: (data: StreamData) => void;
  let sessionReject!: (err: Error) => void;
  const sessionPromise = new Promise<StreamData>((res, rej) => { sessionResolve = res; sessionReject = rej; });
  sessionPromises.set(contentKey, { promise: sessionPromise, resolve: sessionResolve, reject: sessionReject });

  const tag = `👑 Ultimate-Resolve [${contentKey}]`;
  const providers = (globalConfig.healthChecks?.providers ?? []).filter(p => p.enabled);
  const userAgent = globalConfig.userAgents?.nzbDownload || getLatestVersions().chrome;
  const hasProviders = providers.length > 0;
  const pool = hasProviders ? new NntpConnectionPool() : undefined;

  try {
    // Filter out opted-out indexers
    let eligible = candidates;
    if (options.healthCheckIndexers) {
      const indexerMap = options.healthCheckIndexers;
      eligible = candidates.filter(c => indexerMap[c.indexerName] !== false);
    }

    // Apply max candidates limit
    const maxTotal = options.maxCandidates > 0 ? options.maxCandidates : eligible.length;
    const allCandidates = eligible.slice(0, maxTotal);

    if (allCandidates.length === 0) {
      console.log(`${tag} No eligible candidates`);
      return;
    }

    const pipelineStart = Date.now();
    console.log(`${tag} Starting — ${allCandidates.length} candidate(s), pool size ${options.candidateCount}, mode: ${options.preferenceMode}`);

    // ── Stage 1: Library pre-check on ALL candidates ────────────
    const libraryTasks = allCandidates
      .filter(c => !isDeadNzbByUrl(c.nzbUrl))
      .map((candidate, i) => () =>
        checkNzbLibrary(candidate.title, nzbdavConfig, episodePattern, contentType, episodesInSeason, `${tag} [lib #${i + 1}] `, true)
          .then(data => ({ candidate, index: i, data }))
          .catch(() => ({ candidate, index: i, data: null as StreamData | null }))
      );

    const libraryResults = await runWithConcurrency(libraryTasks, 4);

    if (controller.signal.aborted) return;
    const hits = libraryResults.filter(r => r.data !== null).sort((a, b) => a.index - b.index);
    if (hits.length > 0) {
      const best = hits[0];
      const libElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
      console.log(`${tag} 📚 Library hit — ${best.candidate.title} [${best.candidate.indexerName}]`);
      const cacheKey = getCacheKey(best.candidate.nzbUrl, best.candidate.title) + (episodePattern ? `:${episodePattern}` : '');
      setReadyCacheEntry(cacheKey, best.data!, best.candidate.indexerName);
      sessionResolve(best.data!);
      console.log(`${tag} ✅ Resolved via library in ${libElapsed}s`);
      return;
    }

    console.log(`${tag} No library hits — launching grab chain + health checks + nzbdav`);

    // ── Stage 2: Stream processing pipeline ─────────────────────
    const poolSize = Math.min(options.candidateCount, allCandidates.length);
    const activePool: CandidateState[] = [];
    let nextCandidateIdx = 0;

    const addToPool = (candidate: FallbackCandidate, idx: number): CandidateState => {
      const cs: CandidateState = {
        candidate,
        poolIndex: idx,
        healthStatus: 'pending',
        grabStatus: 'pending',
        nzbdavStatus: 'idle',
      };
      activePool.push(cs);
      return cs;
    };

    for (let i = 0; i < poolSize && nextCandidateIdx < allCandidates.length; i++) {
      const c = allCandidates[nextCandidateIdx];
      if (isDeadNzbByUrl(c.nzbUrl)) { nextCandidateIdx++; i--; continue; }
      addToPool(c, nextCandidateIdx);
      nextCandidateIdx++;
    }

    if (activePool.length === 0) {
      console.log(`${tag} All candidates are dead NZBs`);
      return;
    }

    const startGrab = (cs: CandidateState) => {
      cs.grabStatus = 'grabbing';
      cs.grabPromise = prefetchNzb(cs.candidate.nzbUrl, `${tag} [grab #${cs.poolIndex + 1}] `, true)
        .then(ok => { cs.grabStatus = ok ? 'done' : 'failed'; return { cs, ok }; })
        .catch(() => { cs.grabStatus = 'failed'; return { cs, ok: false }; });
    };

    const startHealthCheck = (cs: CandidateState) => {
      if (!hasProviders) { cs.healthStatus = 'healthy'; return; }
      cs.healthStatus = 'checking';
      cs.healthPromise = performHealthCheck(
        cs.candidate.nzbUrl, providers, userAgent,
        { archiveInspection: options.archiveInspection, sampleCount: options.sampleCount },
        pool,
      ).then(result => {
        cs.healthStatus = isHealthy(result) ? 'healthy' : 'dead';
        return { cs, result };
      }).catch(err => {
        cs.healthStatus = 'error';
        return { cs, result: { status: 'error' as const, message: (err as Error).message, playable: false } };
      });
    };

    // Direct nzbdav pipeline — we own the lifecycle for cancellation control
    const startNzbdav = async (cs: CandidateState): Promise<StreamData | null> => {
      cs.nzbdavStatus = 'submitted';
      const logPrefix = `${tag} [nzbdav #${cs.poolIndex + 1}] `;
      try {
        // Cancel checkpoint: before HTTP starts
        if (cs.cancelled) { cs.nzbdavStatus = 'failed'; return null; }

        // Step 1: Submit NZB (uses cached XML from grab chain)
        const nzoId = await submitNzb(cs.candidate.nzbUrl, cs.candidate.title, nzbdavConfig, contentType, undefined, logPrefix);
        cs.nzoId = nzoId;

        // Cancel checkpoint: health check may have failed while submitNzb was in-flight
        if (cs.cancelled) {
          cancelJob(nzoId, nzbdavConfig, 'health check failed (late cancel)').catch(() => {});
          cs.nzbdavStatus = 'failed';
          return null;
        }

        // Step 2: Wait for job completion
        await waitForJobCompletion(nzoId, nzbdavConfig, 120_000, 250, contentType, logPrefix);

        // Cancel checkpoint: health check may have failed during polling
        if (cs.cancelled) { cs.nzbdavStatus = 'failed'; return null; }

        // Step 3: Find video file (waitForVideoFile logs the result)
        const video = await waitForVideoFile(nzoId, cs.candidate.title, nzbdavConfig, episodePattern, contentType, episodesInSeason, logPrefix);

        // Cancel checkpoint: health check may have failed during video discovery
        if (cs.cancelled) { cs.nzbdavStatus = 'failed'; return null; }

        // Step 4: Probe video is servable
        const servable = await probeVideo(nzbdavConfig, video.path, logPrefix);
        if (!servable) {
          throw nzbdavError(`Video file not servable (probe failed): ${video.path}`);
        }

        // Step 5: Write to readyCache so stream handler can deliver
        const cacheKey = getCacheKey(cs.candidate.nzbUrl, cs.candidate.title) + (episodePattern ? `:${episodePattern}` : '');
        const streamData: StreamData = { nzoId, videoPath: video.path, videoSize: video.size };
        setReadyCacheEntry(cacheKey, streamData, cs.candidate.indexerName);

        cs.nzbdavStatus = 'completed';
        console.log(`${logPrefix}✅ Stream ready: ${cs.candidate.title}`);
        return streamData;
      } catch (err) {
        // Skip logging/cancelling if the event loop already cancelled this candidate
        if (cs.cancelled) return null;
        if (cs.nzoId) cancelJob(cs.nzoId, nzbdavConfig, 'pipeline failure').catch(() => {});
        if ((err as any)?.isNzbdavFailure) {
          setDeadNzbEntry(cs.candidate.nzbUrl, cs.candidate.title, err as Error, episodePattern);
        }
        cs.nzbdavStatus = 'failed';
        console.log(`${logPrefix}❌ Failed: ${(err as Error).message}`);
        return null;
      }
    };

    const pullReplacement = (): CandidateState | null => {
      while (nextCandidateIdx < allCandidates.length) {
        const c = allCandidates[nextCandidateIdx];
        nextCandidateIdx++;
        if (isDeadNzbByUrl(c.nzbUrl)) continue;
        const cs = addToPool(c, nextCandidateIdx - 1);
        startGrab(cs);
        return cs;
      }
      return null;
    };

    const selectNext = (): CandidateState | null => {
      if (options.preferenceMode === 'speed') {
        // Speed: prefer first healthy; if none, first with grab done
        const healthy = activePool.find(cs => cs.healthStatus === 'healthy' && cs.nzbdavStatus === 'idle');
        if (healthy) return healthy;
        return activePool.find(cs => cs.grabStatus === 'done' && cs.healthStatus !== 'dead' && cs.healthStatus !== 'error' && cs.nzbdavStatus === 'idle') ?? null;
      }
      // Priority: iterate in order — if a higher-priority candidate is still grabbing, wait for it
      for (const cs of activePool) {
        if (cs.nzbdavStatus !== 'idle') continue;
        if (cs.healthStatus === 'dead' || cs.healthStatus === 'error') continue;
        if (cs.grabStatus === 'grabbing') return null; // higher-priority candidate still grabbing — wait
        if (cs.grabStatus === 'done') return cs;
      }
      return null;
    };

    for (const cs of activePool) startGrab(cs);

    // ── Event loop ──────────────────────────────────────────────
    let resolved = false;
    let resolvedStreamData: StreamData | null = null;
    let activeNzbdavCs: CandidateState | null = null;
    let nzbdavPromise: Promise<StreamData | null> | null = null;

    while (!resolved && !controller.signal.aborted) {
      const pending: Promise<unknown>[] = [];
      for (const cs of activePool) {
        if (cs.grabPromise && cs.grabStatus === 'grabbing') pending.push(cs.grabPromise);
        if (cs.healthPromise && cs.healthStatus === 'checking') pending.push(cs.healthPromise);
      }
      if (nzbdavPromise) pending.push(nzbdavPromise);
      if (pending.length === 0) break;

      await Promise.race(pending);
      if (controller.signal.aborted) break;

      // Process grab completions → start health checks
      for (const cs of activePool) {
        if (cs.grabStatus === 'done' && cs.healthStatus === 'pending') startHealthCheck(cs);
        if (cs.grabStatus === 'failed' && cs.healthStatus === 'pending') {
          cs.healthStatus = 'dead';
          console.log(`${tag} ❌ Grab failed for #${cs.poolIndex + 1} ${cs.candidate.title}`);
          pullReplacement();
        }
      }

      // Process health check completions — cancel active nzbdav job if its candidate is dead
      for (const cs of activePool) {
        if ((cs.healthStatus === 'dead' || cs.healthStatus === 'error') && cs === activeNzbdavCs && cs.nzbdavStatus === 'submitted') {
          console.log(`${tag} 🗑️ Health check failed for active nzbdav candidate #${cs.poolIndex + 1} — cancelling job`);
          cs.cancelled = true;
          if (cs.nzoId) cancelJob(cs.nzoId, nzbdavConfig, 'health check failed').catch(() => {});
          nzbdavPromise?.catch(() => {});
          activeNzbdavCs = null;
          nzbdavPromise = null;
          pullReplacement();
        }
      }

      // Check nzbdav completion BEFORE submitting next
      if (activeNzbdavCs?.nzbdavStatus === 'completed' && resolvedStreamData) {
        const elapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
        console.log(`${tag} ✅ Resolved in ${elapsed}s — ${activeNzbdavCs.candidate.title} [${activeNzbdavCs.candidate.indexerName}]`);
        sessionResolve(resolvedStreamData);
        resolved = true;
        break;
      }
      if (activeNzbdavCs?.nzbdavStatus === 'failed') {
        console.log(`${tag} ❌ nzbdav failed for #${activeNzbdavCs.poolIndex + 1} ${activeNzbdavCs.candidate.title}`);
        activeNzbdavCs.healthStatus = 'dead';
        pullReplacement();
        activeNzbdavCs = null;
        nzbdavPromise = null;
      }

      // Submit to nzbdav if no active job
      if (!activeNzbdavCs || activeNzbdavCs.nzbdavStatus !== 'submitted') {
        const next = selectNext();
        if (next) {
          console.log(`${tag} 🚀 Submitting #${next.poolIndex + 1} ${next.candidate.title} [${next.candidate.indexerName}] to nzbdav`);
          activeNzbdavCs = next;
          nzbdavPromise = startNzbdav(next).then(data => { resolvedStreamData = data; return data; });
        }
      }

      // Check if all candidates are exhausted
      const allDead = activePool.every(cs => cs.healthStatus === 'dead' || cs.healthStatus === 'error' || cs.nzbdavStatus === 'failed');
      if (allDead && nextCandidateIdx >= allCandidates.length) {
        console.log(`${tag} ❌ Exhausted all ${allCandidates.length} candidates`);
        break;
      }
    }

    // ── Summary ──────────────────────────────────────────────────
    const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
    if (!resolved) {
      console.log(`${tag} Pipeline ended without resolution (${totalElapsed}s)`);
      sessionReject(new Error('All candidates exhausted'));
    }
    const healthy = activePool.filter(cs => cs.healthStatus === 'healthy').length;
    const dead = activePool.filter(cs => cs.healthStatus === 'dead' || cs.healthStatus === 'error').length;
    console.log(`${tag} ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`);
    console.log(`${tag}   ${activePool.length} checked · ${healthy} healthy · ${dead} dead · ${totalElapsed}s`);
    for (const cs of activePool) {
      const icon = cs.nzbdavStatus === 'completed' ? '✅' : cs.healthStatus === 'healthy' ? '💚' : cs.healthStatus === 'dead' ? '❌' : '⏳';
      const status = cs.nzbdavStatus === 'completed' ? 'resolved' : cs.nzbdavStatus === 'submitted' ? 'cancelled' : cs.healthStatus === 'dead' ? 'dead' : 'standby';
      console.log(`${tag}   ${icon} #${cs.poolIndex + 1} ${cs.candidate.title.substring(0, 60)} [${cs.candidate.indexerName}] → ${status}`);
    }

    // Write dead candidates to dead NZB database so fallback loop skips them
    let deadWrites = 0;
    for (const cs of activePool) {
      if (cs.healthStatus === 'dead') {
        addDeadNzbByUrl(cs.candidate.nzbUrl, cs.candidate.title);
        deadWrites++;
      }
    }
    if (deadWrites > 0) saveCacheToDisk();

    // Background: submit remaining healthy candidates to nzbdav for library pre-caching
    if (resolved) {
      const remaining = activePool.filter(cs =>
        cs.healthStatus === 'healthy' && cs.nzbdavStatus === 'idle'
      );
      if (remaining.length > 0) {
        console.log(`${tag} 📦 Background: submitting ${remaining.length} healthy backup(s) to nzbdav`);
        (async () => {
          for (const cs of remaining) {
            if (controller.signal.aborted) break;
            try {
              await getOrCreateStream(
                cs.candidate.nzbUrl, cs.candidate.title, nzbdavConfig,
                episodePattern, contentType, episodesInSeason,
                cs.candidate.indexerName, false, cs.candidate.isSeasonPack,
                true, `${tag} [bg #${cs.poolIndex + 1}] `,
              );
            } catch { /* best effort */ }
          }
        })().catch(() => {});
      }
    }

  } catch (err) {
    if (!controller.signal.aborted) console.error(`${tag} Error:`, err);
    sessionReject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    pool?.destroyAll();
    activeSessions.delete(contentKey);
    // Keep session promise available for 2h30s so auto-play / binge watching can find it after episodes finish
    const timer = setTimeout(() => {
      sessionPromises.delete(contentKey);
      cleanupTimers.delete(contentKey);
    }, 2 * 60 * 60 * 1000 + 30_000);
    cleanupTimers.set(contentKey, timer);
  }
}
