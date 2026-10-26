// What this does:
//   Dashboard cards for Ultimate Fallback and Economy Fallback

import clsx from 'clsx';
import { Crown, Coins, GripVertical } from 'lucide-react';
import type { OverlayType } from '../types';

export interface CardDndProps {
  isDragging: boolean;
  isOver: boolean;
  draggedCard: string | null;
  streamingMode: string;
  setActiveOverlay: (overlay: OverlayType) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

export function UltimateFallbackCard({ ultimateFallback, isDragging, isOver, draggedCard, streamingMode, setActiveOverlay, onDragStart, onDragOver, onDrop, onDragEnd }: CardDndProps & {
  ultimateFallback: { enabled: boolean; candidateCount: number; preferenceMode: 'priority' | 'speed'; desiredBackups: number };
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={clsx(
        "card p-4 group transition-all relative overflow-hidden",
        streamingMode !== 'nzbdav'
          ? "opacity-50 cursor-not-allowed"
          : "cursor-move hover:!border-amber-400/50 hover:!shadow-amber-500/30 active:!border-amber-400/50 active:!shadow-amber-500/30",
        isDragging && "opacity-50 scale-95",
        isOver && "ring-2 ring-amber-400 scale-105",
        ultimateFallback.enabled && streamingMode === 'nzbdav' && "!border-amber-500/30"
      )}
      onClick={() => {
        if (!draggedCard && streamingMode === 'nzbdav') setActiveOverlay('ultimateFallback');
      }}
    >
      {ultimateFallback.enabled && (
        <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 via-transparent to-yellow-500/5" />
      )}
      <div className="relative flex items-center gap-3 mb-2">
        <GripVertical className="w-4 h-4 text-slate-600" />
        <div className={clsx(
          "w-6 h-6 rounded-lg flex items-center justify-center",
          ultimateFallback.enabled
            ? "bg-gradient-to-br from-amber-500 to-yellow-600 shadow-lg shadow-amber-500/25"
            : "bg-slate-700"
        )}>
          <Crown className="w-3.5 h-3.5 text-white" />
        </div>
        <span className={clsx(
          "text-sm font-medium",
          ultimateFallback.enabled
            ? "bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent"
            : "text-slate-400"
        )}>Ultimate Fallback</span>
      </div>
      <div className={clsx(
        "relative text-3xl font-bold transition-colors",
        ultimateFallback.enabled
          ? "bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-400 bg-clip-text text-transparent"
          : "group-hover:text-amber-400 group-active:text-amber-400"
      )}>
        {ultimateFallback.enabled
          ? <>Enabled{ultimateFallback.desiredBackups > 0 && <span className="text-lg font-normal text-amber-400 ml-2">+ {ultimateFallback.desiredBackups} NZB Backup{ultimateFallback.desiredBackups === 1 ? '' : 's'}</span>}</>
          : 'Disabled'}
      </div>
      <div className="relative text-xs text-slate-500 mt-1">
        {ultimateFallback.enabled
          ? `${ultimateFallback.candidateCount} candidate${ultimateFallback.candidateCount !== 1 ? 's' : ''} · ${ultimateFallback.preferenceMode === 'priority' ? 'Priority' : 'Speed'} mode`
          : 'Click to configure \u2192'}
      </div>
    </div>
  );
}

export function EconomyFallbackCard({ economyFallback, isDragging, isOver, draggedCard, streamingMode, setActiveOverlay, onDragStart, onDragOver, onDrop, onDragEnd }: CardDndProps & {
  economyFallback: { enabled: boolean; speedOverrideMbps: number | null };
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={clsx(
        "card p-4 group transition-all relative overflow-hidden",
        streamingMode !== 'nzbdav'
          ? "opacity-50 cursor-not-allowed"
          : "cursor-move hover:!border-emerald-400/50 hover:!shadow-emerald-500/30 active:!border-emerald-400/50 active:!shadow-emerald-500/30",
        isDragging && "opacity-50 scale-95",
        isOver && "ring-2 ring-emerald-400 scale-105",
        economyFallback.enabled && streamingMode === 'nzbdav' && "!border-emerald-500/30"
      )}
      onClick={() => {
        if (!draggedCard && streamingMode === 'nzbdav') setActiveOverlay('economyFallback');
      }}
    >
      {economyFallback.enabled && (
        <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/5 via-transparent to-teal-500/5" />
      )}
      <div className="relative flex items-center gap-3 mb-2">
        <GripVertical className="w-4 h-4 text-slate-600" />
        <div className={clsx(
          "w-6 h-6 rounded-lg flex items-center justify-center",
          economyFallback.enabled
            ? "bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/25"
            : "bg-slate-700"
        )}>
          <Coins className="w-3.5 h-3.5 text-white" />
        </div>
        <span className={clsx(
          "text-sm font-medium",
          economyFallback.enabled
            ? "bg-gradient-to-r from-emerald-300 via-teal-400 to-emerald-400 bg-clip-text text-transparent"
            : "text-slate-400"
        )}>Economy Fallback</span>
      </div>
      <div className={clsx(
        "relative text-3xl font-bold transition-colors",
        economyFallback.enabled
          ? "bg-gradient-to-r from-emerald-300 via-teal-400 to-emerald-400 bg-clip-text text-transparent"
          : "group-hover:text-emerald-400 group-active:text-emerald-400"
      )}>
        {economyFallback.enabled ? 'Enabled' : 'Disabled'}
      </div>
      <div className="relative text-xs text-slate-500 mt-1">
        {economyFallback.enabled
          ? (economyFallback.speedOverrideMbps ? `Sized for ${economyFallback.speedOverrideMbps} Mbps` : 'Speed measured automatically')
          : 'Click to configure \u2192'}
      </div>
    </div>
  );
}
