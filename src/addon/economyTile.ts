import type { Stream } from '../types.js';
import { encodeTileEnvelope } from '../nzbdav/redirectHelpers.js';
import { peekBandwidth, warmBandwidthProbe } from '../nzbdav/bandwidth.js';
import { economyTileDisplay, ECONOMY_STREAM_PATH, ECONOMY_SESSION_SUFFIX } from './ufTile.js';

export interface EconomyTileInput {
  sessionKey: string;
  fallbackGroupId?: string;
  streamBase: string;
  manifestKey?: string;
  bingeGroup?: string;
  speedOverrideMbps?: number;
}

export function buildEconomyTile(input: EconomyTileInput): Stream {
  const bandwidth = peekBandwidth(input.manifestKey, input.speedOverrideMbps);
  if (bandwidth.source === 'default' && !input.manifestKey) void warmBandwidthProbe();
  const t = encodeTileEnvelope({
    sk: `${input.sessionKey}${ECONOMY_SESSION_SUFFIX}`,
    ...(input.fallbackGroupId ? { fbg: input.fallbackGroupId } : {}),
  });
  return {
    ...economyTileDisplay(bandwidth.mbps, bandwidth.source),
    url: `${input.streamBase}/${ECONOMY_STREAM_PATH}?t=${t}`,
    behaviorHints: {
      notWebReady: false,
      bingeGroup: input.bingeGroup ? `${input.bingeGroup}:economy` : undefined,
    },
  };
}
