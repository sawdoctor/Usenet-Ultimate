import type { FallbackCandidate } from './types.js';

export const BANDWIDTH_HEADROOM = 0.7;
export const DEFAULT_MOVIE_RUNTIME_SEC = 110 * 60;
export const DEFAULT_EPISODE_RUNTIME_SEC = 22 * 60;

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
  const isRemotePack = c.isSeasonPack && !c.libraryVideoPath;
  const estimatedEpisodeSize = c.estimatedEpisodeSize;
  if (isRemotePack && typeof estimatedEpisodeSize === 'number' && Number.isFinite(estimatedEpisodeSize) && estimatedEpisodeSize > 0) return estimatedEpisodeSize;
  const size = c.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return undefined;
  return isRemotePack && episodesInSeason && episodesInSeason > 0 ? size / episodesInSeason : size;
}

/** Fitting candidates keep the order chosen by the user's filters and sort settings. */
export function rankEconomyCandidates(candidates: FallbackCandidate[], budget: EconomyBudget): EconomyRanking {
  const maxBytes = economyMaxBytes(budget.mbps, budget.runtimeSec);
  const entries = candidates.map((c, i) => {
    const bytes = perFileBytes(c, budget.episodesInSeason);
    const durationSec = c.durationSec && c.durationSec > 0 ? c.durationSec : budget.runtimeSec;
    const bitrateMbps = bytes !== undefined && Number.isFinite(durationSec) && durationSec > 0
      ? (bytes * 8) / durationSec / 1_000_000
      : undefined;
    return { c, i, bitrateMbps };
  });
  const fits = entries
    .filter(e => e.bitrateMbps !== undefined && e.bitrateMbps <= budget.mbps * BANDWIDTH_HEADROOM)
    .sort((a, b) => a.i - b.i);
  const oversize = entries
    .filter(e => e.bitrateMbps !== undefined && e.bitrateMbps > budget.mbps * BANDWIDTH_HEADROOM)
    .sort((a, b) => (a.bitrateMbps as number) - (b.bitrateMbps as number) || a.i - b.i);
  const unknown = entries.filter(e => e.bitrateMbps === undefined).sort((a, b) => a.i - b.i);
  return {
    ordered: [...fits, ...oversize, ...unknown].map(e => e.c),
    fitCount: fits.length,
    maxBytes,
  };
}
