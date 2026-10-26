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

export const ECONOMY_TILE_NAME = '🪙 Economy Fallback';
export const ECONOMY_STREAM_PATH = 'economy-fallback';
export const ECONOMY_SESSION_SUFFIX = ':eco';

export function economyTileDisplay(mbps: number, source: 'override' | 'live' | 'probe' | 'default'): { name: string; title: string } {
  const speed = source === 'default' ? 'Measuring your connection' : `Sized for ~${Math.round(mbps)} Mbps`;
  return { name: ECONOMY_TILE_NAME, title: `⚬ ${speed}\n⚬ Auto-select highest-resolution stream that fits` };
}

export function isEconomySessionKey(sessionKey: string): boolean {
  return sessionKey.endsWith(ECONOMY_SESSION_SUFFIX);
}
