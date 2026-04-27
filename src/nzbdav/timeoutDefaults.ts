/**
 * Ultimate Resolve Timeout Defaults & Shared Selector
 *
 * Default per-content wait times for Ultimate Resolve's nzbdav job-completion
 * step, plus the helper that selects the right timeout based on content type
 * and season-pack status.
 */

export interface TimeoutSet {
  movies: number;
  tv: number;
  seasonPack: number;
}

export const UR_TIMEOUT_DEFAULTS = {
  priority: { movies: 30, tv: 15, seasonPack: 30 },
  speed:    { movies: 20, tv: 10, seasonPack: 20 },
} satisfies Record<'priority' | 'speed', TimeoutSet>;

export function selectTimeoutMs(
  set: TimeoutSet,
  contentType: string | undefined,
  isSeasonPack: boolean,
): number {
  const seconds = contentType === 'series'
    ? (isSeasonPack ? set.seasonPack : set.tv)
    : set.movies;
  return seconds * 1000;
}
