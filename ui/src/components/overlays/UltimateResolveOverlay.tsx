// What this does:
//   Ultimate Resolve configuration overlay — combines NZB Fallback with Health Checking
//   for the fastest possible NZB resolution

import { useCallback } from 'react';
import { Crown, X } from 'lucide-react';
import clsx from 'clsx';
import { useHoldRepeat } from '../../hooks/useHoldRepeat';
import type { HealthChecksState, UsenetProvider } from '../../types';
import { ProviderManager } from '../shared/ProviderManager';

interface UltimateResolveOverlayProps {
  onClose: () => void;
  ultimateResolve: {
    enabled: boolean;
    candidateCount: number;
    preferenceMode: 'priority' | 'speed';
    archiveInspection: boolean;
    sampleCount: 3 | 7;
    maxCandidates: number;
    desiredBackups: number;
    backupProcessingLimit: number;
    healthCheckIndexers: Record<string, boolean>;
  };
  setUltimateResolve: React.Dispatch<React.SetStateAction<UltimateResolveOverlayProps['ultimateResolve']>>;
  healthChecks: HealthChecksState;
  setHealthChecks: React.Dispatch<React.SetStateAction<HealthChecksState>>;
  nzbdavProxyEnabled: boolean;
  setNzbdavProxyEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

export function UltimateResolveOverlay({
  onClose,
  ultimateResolve,
  setUltimateResolve,
  healthChecks,
  setHealthChecks,
  nzbdavProxyEnabled,
  setNzbdavProxyEnabled,
  apiFetch,
}: UltimateResolveOverlayProps) {
  const update = useCallback(<K extends keyof typeof ultimateResolve>(key: K, value: (typeof ultimateResolve)[K]) => {
    setUltimateResolve(prev => ({ ...prev, [key]: value }));
  }, [setUltimateResolve]);

  const candidateDec = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, candidateCount: Math.max(2, prev.candidateCount - 1) })), [setUltimateResolve]));
  const candidateInc = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, candidateCount: Math.min(10, prev.candidateCount + 1) })), [setUltimateResolve]));
  const backupsDec = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, desiredBackups: Math.max(0, prev.desiredBackups - 1) })), [setUltimateResolve]));
  const backupsInc = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, desiredBackups: Math.min(10, prev.desiredBackups + 1) })), [setUltimateResolve]));
  const bplDec = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, backupProcessingLimit: Math.max(0, prev.backupProcessingLimit - 1) })), [setUltimateResolve]));
  const bplInc = useHoldRepeat(useCallback(() => setUltimateResolve(prev => ({ ...prev, backupProcessingLimit: Math.min(20, prev.backupProcessingLimit + 1) })), [setUltimateResolve]));

  const enabledPoolProviders = healthChecks.providers.filter(p => p.enabled && p.type === 'pool').length;
  const hasProviders = enabledPoolProviders > 0 || healthChecks.providers.some(p => p.enabled && p.type === 'backup');
  const maxConnections = ultimateResolve.candidateCount * Math.max(1, enabledPoolProviders);

  const handleProvidersChange = useCallback((providers: UsenetProvider[]) => {
    setHealthChecks(prev => ({ ...prev, providers }));
  }, [setHealthChecks]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-yellow-600 flex items-center justify-center shadow-lg shadow-amber-500/25">
                <Crown className="w-4 h-4 text-white" />
              </div>
              <h3 className="text-xl font-bold bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent">
                Ultimate Resolve
              </h3>
            </div>
            <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-4 md:p-6 space-y-4">

          {/* Description */}
          <ul className="text-xs text-slate-400 leading-relaxed list-disc list-inside space-y-1">
            <li>Ultimate Resolve achieves the fastest theoretical resolution of a healthy NZB.</li>
            <li>Ultimate Resolve is a 5 layer parallel process that combines WebDAV, NZBDav, NZB Fallback, Health Checking, and Priority Grab Queueing to resolve a healthy NZB.</li>
          </ul>

          {/* Enable Toggle */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={ultimateResolve.enabled}
                onChange={(e) => update('enabled', e.target.checked)}
                className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-amber-500 focus:ring-amber-500 focus:ring-offset-slate-800"
              />
              <span className="text-sm font-medium text-slate-200">Enable Ultimate Resolve</span>
            </label>
          </div>

          {/* Streaming Method */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <label className="block text-sm font-medium text-slate-300">Streaming Method</label>
            <div className="flex gap-3">
              <button
                onClick={() => setNzbdavProxyEnabled(true)}
                className={clsx(
                  "flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
                  nzbdavProxyEnabled
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                )}
              >
                Proxy
              </button>
              <button
                onClick={() => setNzbdavProxyEnabled(false)}
                className={clsx(
                  "flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
                  !nzbdavProxyEnabled
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                    : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                )}
              >
                Direct
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {nzbdavProxyEnabled
                ? 'Video streams through a local proxy with buffering and automatic reconnection. Recommended for most devices.'
                : 'Player is redirected directly to the WebDAV URL. Only supported on select stremio applications.'}
            </p>
          </div>

          {/* Empty providers warning */}
          {ultimateResolve.enabled && !hasProviders && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
              <p className="text-xs text-amber-400">
                Configure at least one Usenet provider in Health Checks to use Ultimate Resolve.
              </p>
            </div>
          )}

          {/* # of Parallel NZB Candidates */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-2 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-300 whitespace-nowrap"># of Parallel NZB Candidates</span>
              <div className="flex items-center gap-2">
                <button
                  {...candidateDec}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >−</button>
                <span className="text-lg font-bold text-amber-400/90 tabular-nums w-6 text-center">{ultimateResolve.candidateCount}</span>
                <button
                  {...candidateInc}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >+</button>
              </div>
            </div>
            <div className="text-xs text-slate-500">Number of NZBs to process in parallel from the top of the results list.</div>
            <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-1">
              <span className="text-amber-400/70 font-medium tabular-nums">{maxConnections}</span>
              <span>max NNTP connections ({ultimateResolve.candidateCount} candidates × {Math.max(1, enabledPoolProviders)} pool provider{enabledPoolProviders !== 1 ? 's' : ''})</span>
            </div>
            <div className="text-[11px] text-amber-400/50 mt-1">
              These connections are separate from NZBDav's download connections. Ensure your provider allows enough concurrent connections for both.
            </div>
          </div>

          {/* Prefer Priority / Prefer Speed */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">Preference Mode</div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="preferenceMode"
                checked={ultimateResolve.preferenceMode === 'priority'}
                onChange={() => update('preferenceMode', 'priority')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Prefer Priority</div>
                <p className="text-xs text-slate-500">Prefer the highest potential NZB candidate even if others below it resolve first.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="preferenceMode"
                checked={ultimateResolve.preferenceMode === 'speed'}
                onChange={() => update('preferenceMode', 'speed')}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Prefer Speed</div>
                <p className="text-xs text-slate-500">Prefer the fastest resolving NZB, even if there are unresolved candidates with higher priority.</p>
              </div>
            </label>
          </div>

          {/* Max Candidates */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">Max Candidates</div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="maxCandidates"
                checked={ultimateResolve.maxCandidates === 0}
                onChange={() => update('maxCandidates', 0)}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">All Results</div>
                <p className="text-xs text-slate-500">Try every available NZB from the search results before giving up.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="maxCandidates"
                checked={ultimateResolve.maxCandidates > 0}
                onChange={() => { if (ultimateResolve.maxCandidates === 0) update('maxCandidates', 5); }}
                className="mt-1 accent-amber-400"
              />
              <div>
                <div className="text-sm text-slate-200 font-medium">Limit</div>
                <p className="text-xs text-slate-500">Stop after a set number of candidates.</p>
              </div>
            </label>
            {ultimateResolve.maxCandidates > 0 && (
              <div className="flex items-center gap-3 ml-6">
                <input
                  type="range"
                  min={1}
                  max={20}
                  value={ultimateResolve.maxCandidates}
                  onChange={(e) => update('maxCandidates', parseInt(e.target.value, 10))}
                  className="flex-1 accent-amber-400"
                />
                <span className="text-sm text-slate-300 w-8 text-right">{ultimateResolve.maxCandidates}</span>
              </div>
            )}
          </div>

          {/* Desired Backups */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-2 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-300 whitespace-nowrap">Desired Backups</span>
              <div className="flex items-center gap-2">
                <button
                  {...backupsDec}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >−</button>
                <span className="text-lg font-bold text-amber-400/90 tabular-nums w-10 text-center">{ultimateResolve.desiredBackups === 0 ? 'Off' : ultimateResolve.desiredBackups}</span>
                <button
                  {...backupsInc}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >+</button>
              </div>
            </div>
            <div className="text-xs text-slate-500">Container-matched backups to pre-resolve after the primary stream. Backups must match the primary's video container type (MKV, MP4, etc.).</div>
            <div className="text-[11px] text-amber-400/50">0 = no extra work · max 10</div>
          </div>

          {/* Backup Processing Limit */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-2 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-300 whitespace-nowrap">Backup Processing Limit</span>
              <div className="flex items-center gap-2">
                <button
                  {...bplDec}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >−</button>
                <span className="text-lg font-bold text-amber-400/90 tabular-nums w-8 text-center">{ultimateResolve.backupProcessingLimit === 0 ? 'All' : ultimateResolve.backupProcessingLimit}</span>
                <button
                  {...bplInc}
                  className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
                >+</button>
              </div>
            </div>
            <div className="text-xs text-slate-500">Max backup NZBs attempted via NNTP after the primary. Dead and duplicate candidates count against the budget; library hits don't.</div>
            <div className="text-[11px] text-amber-400/50">0 = all results · max 20</div>
          </div>

          {/* Usenet Providers (shared with Health Checks) */}
          <div className={clsx("transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <ProviderManager
              providers={healthChecks.providers}
              onProvidersChange={handleProvidersChange}
              apiFetch={apiFetch}
              accentColor="amber"
            />
          </div>

          {/* Articles to Sample */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 space-y-3 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <div className="text-sm font-medium text-slate-300">Articles to Sample</div>
            <div className="flex gap-3">
              {([3, 7] as const).map(count => (
                <button
                  key={count}
                  onClick={() => update('sampleCount', count)}
                  className={clsx(
                    "px-4 py-1.5 rounded-lg text-sm font-medium transition-all",
                    ultimateResolve.sampleCount === count
                      ? "bg-amber-500/20 border border-amber-500/40 text-amber-300"
                      : "bg-slate-700/40 border border-slate-600/30 text-slate-400 hover:text-slate-200 hover:border-slate-500/50"
                  )}
                >
                  {count} samples
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500">More samples means more accurate health checks but slightly slower.</p>
          </div>

          {/* Archive Inspection */}
          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 transition-opacity", !ultimateResolve.enabled && "opacity-40 pointer-events-none")}>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={ultimateResolve.archiveInspection}
                onChange={(e) => update('archiveInspection', e.target.checked)}
                className="w-5 h-5 rounded border-slate-600 bg-slate-700 text-amber-500 focus:ring-amber-500 focus:ring-offset-slate-800"
              />
              <div>
                <div className="text-sm font-medium text-slate-200">Archive Header Inspection</div>
                <p className="text-xs text-slate-500 mt-0.5">Inspect archive headers for encryption, nested archives, and video content.</p>
              </div>
            </label>
          </div>

          {/* Reset to Default */}
          <div className="pt-2">
            <button
              onClick={() => {
                setUltimateResolve({
                  enabled: false,
                  candidateCount: 3,
                  preferenceMode: 'speed',
                  archiveInspection: true,
                  sampleCount: 3,
                  maxCandidates: 0,
                  desiredBackups: 0,
                  backupProcessingLimit: 0,
                  healthCheckIndexers: {},
                });
                setNzbdavProxyEnabled(true);
              }}
              className="btn-secondary w-full"
            >
              Reset to Default
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
