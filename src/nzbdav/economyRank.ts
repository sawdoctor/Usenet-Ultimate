import { parseQuality } from '../parsers/metadataParsers.js';
import type { FallbackCandidate } from './types.js';

export const BANDWIDTH_HEADROOM = 0.7;
export const DEFAULT_MOVIE_RUNTIME_SEC = 110 * 60;
export const DEFAULT_EPISODE_RUNTIME_SEC = 45 * 60;

const RESOLUTION_RANK: Record<string, number> = {
  '4k': 5,
  '1440p': 4,
  '1080p': 3,
  '720p': 2,
};

export interface EconomyBudget {
  mbps: number;
  runtimeSec: number;
  episodesInSeason?: number;
}

export interface EconomyRanking {
  ordered: FallbackCandidate[];
  fitCount: number;
  maxBytes: number;
}

export function economyMaxBytes(mbps: number, runtimeSec: number): number {
  return (mbps * BANDWIDTH_HEADROOM * 1_000_000 / 8) * runtimeSec;
}

export function defaultRuntimeSec(contentType: string | undefined): number {
  return contentType === 'series' ? DEFAULT_EPISODE_RUNTIME_SEC : DEFAULT_MOVIE_RUNTIME_SEC;
}

function perFileBytes(c: FallbackCandidate, episodesInSeason?: number): number | undefined {
  if (!c.size || c.size <= 0) return undefined;
  const isRemotePack = c.isSeasonPack && !c.libraryVideoPath;
  return isRemotePack && episodesInSeason && episodesInSeason > 0 ? c.size / episodesInSeason : c.size;
}

/** Candidates that fit the bandwidth budget come first, highest resolution first
 *  (original order breaks ties); oversize ones follow, smallest first, as a last resort. */
export function rankEconomyCandidates(candidates: FallbackCandidate[], budget: EconomyBudget): EconomyRanking {
  const maxBytes = economyMaxBytes(budget.mbps, budget.runtimeSec);
  const entries = candidates.map((c, i) => ({
    c,
    i,
    resolution: RESOLUTION_RANK[parseQuality(c.title).toLowerCase()] ?? 1,
    bytes: perFileBytes(c, budget.episodesInSeason),
  }));
  const fits = entries
    .filter(e => e.bytes === undefined || e.bytes <= maxBytes)
    .sort((a, b) => b.resolution - a.resolution || a.i - b.i);
  const oversize = entries
    .filter(e => e.bytes !== undefined && e.bytes > maxBytes)
    .sort((a, b) => a.bytes! - b.bytes! || a.i - b.i);
  return {
    ordered: [...fits, ...oversize].map(e => e.c),
    fitCount: fits.length,
    maxBytes,
  };
}
