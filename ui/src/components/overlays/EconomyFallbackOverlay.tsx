// What this does:
//   Economy Fallback configuration overlay: toggle the tile and optionally pin the connection speed

import { Coins, X } from 'lucide-react';
import clsx from 'clsx';
import { DEFAULT_ECONOMY_FALLBACK } from '../../constants';

interface EconomyFallbackOverlayProps {
  onClose: () => void;
  economyFallback: typeof DEFAULT_ECONOMY_FALLBACK;
  setEconomyFallback: React.Dispatch<React.SetStateAction<typeof DEFAULT_ECONOMY_FALLBACK>>;
}

export function EconomyFallbackOverlay({ onClose, economyFallback, setEconomyFallback }: EconomyFallbackOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onClose()}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/25">
                <Coins className="w-4 h-4 text-white" />
              </div>
              <h3 className="text-xl font-bold bg-gradient-to-r from-emerald-300 via-teal-400 to-emerald-400 bg-clip-text text-transparent">
                Economy Fallback
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
            <li>Works with or without Ultimate Fallback. It uses the candidate pool, backup and timeout settings saved in Ultimate Fallback.</li>
          </ul>

          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-200">Enable Economy Fallback</span>
            <button
              aria-label="Enable Economy Fallback"
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
            <label htmlFor="eco-speed-override" className="text-sm text-slate-300">
              Connection speed override (Mbps)
              <span className="block text-xs text-slate-500">Leave empty to measure automatically.</span>
            </label>
            <input
              id="eco-speed-override"
              type="number"
              min={1}
              placeholder="Auto"
              value={economyFallback.speedOverrideMbps ?? ''}
              onChange={e => {
                const v = parseInt(e.target.value, 10);
                setEconomyFallback(prev => ({ ...prev, speedOverrideMbps: Number.isFinite(v) && v > 0 ? v : null }));
              }}
              className="w-24 px-2 py-1 rounded-md bg-slate-800 border border-slate-600 text-sm text-slate-200 text-right"
            />
          </div>

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
