import type { FallbackCandidate } from './types.js';

/** Keep the clicked result first, then prefer episode-sized fallbacks. */
export function orderEpisodeStreamingCandidates(
  candidates: FallbackCandidate[],
  clickedIdx: number,
  contentType?: string,
  episode?: string,
): FallbackCandidate[] {
  if (clickedIdx < 0 || clickedIdx >= candidates.length) return [...candidates];

  const clicked = candidates[clickedIdx];
  const rest = [
    ...candidates.slice(clickedIdx + 1),
    ...candidates.slice(0, clickedIdx),
  ];

  if (contentType !== 'series' || episode === undefined || episode === '') {
    return [clicked, ...rest];
  }

  const preferred: FallbackCandidate[] = [];
  const remotePacks: FallbackCandidate[] = [];
  for (const candidate of rest) {
    if (candidate.isSeasonPack && !candidate.libraryVideoPath) remotePacks.push(candidate);
    else preferred.push(candidate);
  }
  return [clicked, ...preferred, ...remotePacks];
}
