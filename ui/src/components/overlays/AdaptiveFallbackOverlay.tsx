// What this does:
//   Adaptive Fallback configuration overlay

import { Gauge, X } from 'lucide-react';
import clsx from 'clsx';
import { DEFAULT_ECONOMY_FALLBACK } from '../../constants';

interface AdaptiveFallbackOverlayProps {
  onClose: () => void;
  economyFallback: typeof DEFAULT_ECONOMY_FALLBACK;
  setEconomyFallback: React.Dispatch<React.SetStateAction<typeof DEFAULT_ECONOMY_FALLBACK>>;
}

export function AdaptiveFallbackOverlay({ onClose, economyFallback, setEconomyFallback }: AdaptiveFallbackOverlayProps) {
  const update = <K extends keyof typeof economyFallback>(key: K, value: (typeof economyFallback)[K]) => {
    setEconomyFallback(prev => ({ ...prev, [key]: value }));
  };
  const numberField = (key: 'candidateCount' | 'maxAttempts' | 'desiredBackups' | 'backupProcessingLimit' | 'priorityMoviesTimeoutSeconds' | 'priorityTvTimeoutSeconds' | 'prioritySeasonPackTimeoutSeconds', label: string, min: number, max: number, help: string) => (
    <label className="block rounded-lg border border-slate-700/30 bg-slate-900/50 p-3">
      <span className="block text-sm font-medium text-slate-200">{label}</span>
      <span className="mt-1 block text-xs text-slate-500">{help}</span>
      <input
        type="number"
        min={min}
        max={max}
        disabled={!economyFallback.enabled}
        value={economyFallback[key]}
        onChange={e => {
          const value = parseInt(e.target.value, 10);
          if (Number.isFinite(value)) update(key, Math.max(min, Math.min(max, value)));
        }}
        className="mt-2 w-full rounded-md border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
      />
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/25">
                <Gauge className="w-4 h-4 text-white" />
              </div>
              <h3 className="text-xl font-bold bg-gradient-to-r from-emerald-300 via-teal-400 to-emerald-400 bg-clip-text text-transparent">
                Adaptive Fallback
              </h3>
            </div>
            <button onClick={() => onClose()} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-4 md:p-6 space-y-4">
          <ul className="text-xs text-slate-400 leading-relaxed list-disc list-inside space-y-1">
            <li>Adds a tile that picks the highest resolution whose file size fits your connection speed, so a stream starts without buffering.</li>
            <li>Speed comes from the override below, then live playback throughput, then a one-off download test from the addon host. The test measures the host's connection, not yours, so set an override when the addon runs on a remote server.</li>
            <li>Works with or without Ultimate Fallback. Candidate count, health checks, retries, backups and wait times are configured here. Your Usenet providers remain shared.</li>
          </ul>

          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-200">Enable Adaptive Fallback</span>
            <button
              aria-label="Enable Adaptive Fallback"
              aria-pressed={economyFallback.enabled}
              onClick={() => setEconomyFallback(prev => ({ ...prev, enabled: !prev.enabled }))}
              className={clsx(
                "relative w-10 h-6 rounded-full transition-colors flex-shrink-0",
                economyFallback.enabled ? "bg-emerald-500" : "bg-slate-600"
              )}
            >
              <div className={clsx(
                "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                economyFallback.enabled ? "left-5" : "left-1"
              )} />
            </button>
          </div>

          <div className={clsx("bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 flex items-center justify-between gap-3 transition-opacity", !economyFallback.enabled && "opacity-40 pointer-events-none")}>
            <label htmlFor="adaptive-speed-override" className="text-sm text-slate-300">
              Connection speed override (Mbps)
              <span className="block text-xs text-slate-500">Leave empty to measure automatically.</span>
            </label>
            <input
              id="adaptive-speed-override"
              type="number"
              min={1}
              disabled={!economyFallback.enabled}
              placeholder="Auto"
              value={economyFallback.speedOverrideMbps ?? ''}
              onChange={e => {
                const v = parseInt(e.target.value, 10);
                setEconomyFallback(prev => ({ ...prev, speedOverrideMbps: Number.isFinite(v) && v > 0 ? v : null }));
              }}
              className="w-24 px-2 py-1 rounded-md bg-slate-800 border border-slate-600 text-sm text-slate-200 text-right"
            />
          </div>

          <section className={clsx("space-y-3 transition-opacity", !economyFallback.enabled && "opacity-40 pointer-events-none")}>
            <div>
              <h4 className="text-sm font-semibold text-slate-200">Resolution pipeline</h4>
              <p className="mt-1 text-xs text-slate-500">These controls only affect Adaptive Fallback.</p>
            </div>

            <div className="rounded-lg border border-slate-700/30 bg-slate-900/50 p-4 flex items-center justify-between gap-3">
              <div>
                <span className="text-sm font-medium text-slate-200">Health checking</span>
                <span className="block text-xs text-slate-500">Verify candidates with your configured Usenet providers before submission.</span>
              </div>
              <button
                type="button"
                disabled={!economyFallback.enabled}
                aria-label="Enable Adaptive Fallback health checking"
                aria-pressed={economyFallback.healthCheckEnabled}
                onClick={() => update('healthCheckEnabled', !economyFallback.healthCheckEnabled)}
                className={clsx("relative h-6 w-10 flex-shrink-0 rounded-full transition-colors", economyFallback.healthCheckEnabled ? "bg-emerald-500" : "bg-slate-600")}
              >
                <span className={clsx("absolute top-1 h-4 w-4 rounded-full bg-white transition-transform", economyFallback.healthCheckEnabled ? "left-5" : "left-1")} />
              </button>
            </div>

            {economyFallback.healthCheckEnabled && (
              <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-700/30 bg-slate-900/50 p-4">
                <span>
                  <span className="block text-sm font-medium text-slate-200">Article samples</span>
                  <span className="block text-xs text-slate-500">More samples take longer but check more of each NZB.</span>
                </span>
                <select
                  disabled={!economyFallback.enabled}
                  value={economyFallback.sampleCount}
                  onChange={e => update('sampleCount', Number(e.target.value) === 7 ? 7 : 3)}
                  className="rounded-md border border-slate-600 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
                >
                  <option value={3}>3 samples</option>
                  <option value={7}>7 samples</option>
                </select>
              </label>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {numberField('candidateCount', 'Parallel candidates', 1, 10, 'How many NZBs can resolve at once.')}
              {numberField('maxAttempts', 'Maximum attempts', 0, 20, '0 tries every candidate; 1–20 caps the number of attempts.')}
              {numberField('desiredBackups', 'Cached backups', 0, 10, 'How many healthy backups to keep ready after the stream starts.')}
              {numberField('backupProcessingLimit', 'Backup candidates checked', 0, 20, '0 checks every candidate; 1–20 sets a limit.')}
            </div>

            <div>
              <h4 className="text-sm font-semibold text-slate-200">Maximum wait time</h4>
              <p className="mt-1 text-xs text-slate-500">Seconds to wait for NzbDAV to finish resolving a candidate. 0 waits without a limit.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {numberField('priorityMoviesTimeoutSeconds', 'Movies', 0, 90, 'Maximum wait in seconds.')}
              {numberField('priorityTvTimeoutSeconds', 'Episodes', 0, 90, 'Maximum wait in seconds.')}
              {numberField('prioritySeasonPackTimeoutSeconds', 'Season packs', 0, 90, 'Maximum wait in seconds.')}
            </div>
          </section>

          <div className="pt-2">
            <button onClick={() => setEconomyFallback({ ...DEFAULT_ECONOMY_FALLBACK })} className="btn-secondary w-full">
              Reset to Default
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
