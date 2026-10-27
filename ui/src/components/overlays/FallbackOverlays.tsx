// What this does:
//   Mounts the Ultimate Fallback and Adaptive Fallback overlays

import type { useAppConfig } from '../../hooks/useAppConfig';
import { UltimateFallbackOverlay } from './UltimateFallbackOverlay';
import { AdaptiveFallbackOverlay } from './AdaptiveFallbackOverlay';

export function FallbackOverlays({ ac, apiFetch }: {
  ac: ReturnType<typeof useAppConfig>;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}) {
  return (
    <>
      {/* Adaptive Fallback Overlay */}
      {ac.activeOverlay === 'economyFallback' && (
        <AdaptiveFallbackOverlay
          onClose={() => ac.setActiveOverlay(null)}
          economyFallback={ac.economyFallback}
          setEconomyFallback={ac.setEconomyFallback}
        />
      )}

      {/* Ultimate-Fallback Overlay */}
      {ac.activeOverlay === 'ultimateFallback' && (
        <UltimateFallbackOverlay
          onClose={() => {
            ac.setDirectModeWarning({ show: false });
            ac.setActiveOverlay(null);
          }}
          ultimateFallback={ac.ultimateFallback}
          setUltimateFallback={ac.setUltimateFallback}
          healthChecks={ac.healthChecks}
          setHealthChecks={ac.setHealthChecks}
          nzbdavStreamingMethod={ac.nzbdavStreamingMethod}
          setNzbdavStreamingMethod={ac.setNzbdavStreamingMethod}
          setDirectModeWarning={ac.setDirectModeWarning}
          nzbdavStreamBufferMB={ac.nzbdavStreamBufferMB}
          setNzbdavStreamBufferMB={ac.setNzbdavStreamBufferMB}
          nzbdavPipeBufferMB={ac.nzbdavPipeBufferMB}
          setNzbdavPipeBufferMB={ac.setNzbdavPipeBufferMB}
          apiFetch={apiFetch}
        />
      )}
    </>
  );
}
