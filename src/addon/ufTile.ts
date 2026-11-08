import type { BandwidthEstimate, BandwidthSource } from '../nzbdav/bandwidth.js';

// Ultimate Fallback tile name + path
export const UF_TILE_BASE_NAME = '👑 Ultimate Fallback';
export const UF_STREAM_PATH = 'ultimate-fallback';

/** Build the UF tile's display name + title based on the active preference mode.
 *  Brand goes in the `name` chip (left), mode + description in `title` (right detail). */
export function ufTileDisplay(mode: 'speed' | 'priority' | undefined): { name: string; title: string } {
  if (mode === 'priority') {
    return { name: UF_TILE_BASE_NAME, title: '⚬ Priority Mode\n⚬ Auto-select highest-quality healthy stream' };
  }
  return { name: UF_TILE_BASE_NAME, title: '⚬ Speed Mode\n⚬ Auto-select fastest healthy stream' };
}

export const ECONOMY_TILE_NAME = '📶 Adaptive Fallback';
export const ECONOMY_STREAM_PATH = 'economy-fallback';
export const ECONOMY_SESSION_SUFFIX = ':eco';

const ECONOMY_SPEED_LABELS: Record<BandwidthSource, string> = {
  override: 'Using speed override',
  recent: 'Recent stream throughput',
  day: 'Typical over the past day',
  week: 'Typical over the past week',
  month: 'Typical over the past month',
  history: 'Typical from past streams',
  probe: 'Initial estimate',
  default: 'Conservative start',
};

export function economyTileDisplay(estimate: BandwidthEstimate): { name: string; title: string } {
  const basis = estimate.streams ? ` (${estimate.streams} streams)` : '';
  const speed = `${ECONOMY_SPEED_LABELS[estimate.source]}: ~${Math.round(estimate.mbps)} Mbps${basis}`;
  return { name: ECONOMY_TILE_NAME, title: `⚬ ${speed}\n⚬ Auto-select your best-ranked stream within this speed` };
}

export function isEconomySessionKey(sessionKey: string): boolean {
  return sessionKey.endsWith(ECONOMY_SESSION_SUFFIX);
}
