// What this does:
//   Provider/article-check performance overlay for v1.9 reputation data.
//   Shows raw observations only; it does not influence provider ordering or health verdicts.

import { useEffect, useMemo, useState } from 'react';
import {
  X,
  Activity,
  Database,
  Zap,
  Shield,
  Heart,
  TrendingUp,
  ChevronRight,
} from 'lucide-react';
import clsx from 'clsx';

interface ProviderRecord {
  id: string;
  name: string;
  type: 'pool' | 'backup';
  firstSeen: string;
  lastSeen: string;
  successfulChecks: number;
  failedChecks: number;
  articlesChecked: number;
  found: number;
  missing: number;
  unknown: number;
  backupSaves: number;
  authFailures: number;
  tlsFailures: number;
  timeoutFailures: number;
  connectionFailures: number;
  otherFailures: number;
  latencyMsTotal: number;
  latencySamples: number;
  lastLatencyMs: number | null;
  lastError?: string;
  lastErrorAt?: string;
}

interface ProviderMetrics {
  checkSuccessRate: number | null;
  answerRate: number | null;
  coverageRate: number | null;
  averageLatencyMs: number | null;
  confidence: number;
}

interface ProviderView {
  id: string;
  name: string;
  type: 'pool' | 'backup';
  enabled: boolean;
  observed: boolean;
  stats: ProviderRecord | null;
  metrics: ProviderMetrics;
}

type TimeWindow = 'lifetime' | '24h' | '7d' | '30d';

interface ProviderSnapshot {
  summary: {
    configured: number;
    tracked: number;
    totalCheckAttempts: number;
    totalArticlesChecked: number;
    lastActivity: string | null;
    mode: 'observe-only';
    window: TimeWindow;
    historyAvailableFrom: string | null;
  };
  providers: ProviderView[];
  retired: Array<ProviderRecord & { metrics: ProviderMetrics }>;
}

type SortKey = 'coverage' | 'answer' | 'success' | 'speed' | 'articles' | 'saves';
type RoleFilter = 'all' | 'pool' | 'backup';

interface ProviderStatsOverlayProps {
  onClose: () => void;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

const pct = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`;

function barWidth(value: number | null): string {
  if (value === null) return '0%';
  return `${Math.max(0, Math.min(100, value * 100))}%`;
}

function metricValue(provider: ProviderView, key: SortKey): number {
  if (key === 'coverage') return provider.metrics.coverageRate ?? -1;
  if (key === 'answer') return provider.metrics.answerRate ?? -1;
  if (key === 'success') return provider.metrics.checkSuccessRate ?? -1;
  if (key === 'speed') return provider.metrics.averageLatencyMs ?? Number.POSITIVE_INFINITY;
  if (key === 'articles') return provider.stats?.articlesChecked ?? 0;
  return provider.stats?.backupSaves ?? 0;
}

export function ProviderStatsOverlay({ onClose, apiFetch }: ProviderStatsOverlayProps) {
  const [data, setData] = useState<ProviderSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('articles');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('lifetime');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/reputation/providers?window=${timeWindow}`)
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(snapshot => {
        if (!cancelled) {
          setData(snapshot);
          setError('');
        }
      })
      .catch(err => {
        if (!cancelled) setError(`Failed to load provider metrics: ${err.message || err}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [apiFetch, timeWindow]);

  const observed = useMemo(() => (data?.providers || []).filter(p => p.observed && p.stats), [data]);

  const visibleProviders = useMemo(() => {
    const roleFiltered = observed.filter(p => roleFilter === 'all' || p.type === roleFilter);
    return [...roleFiltered].sort((a, b) => {
      const av = metricValue(a, sortBy);
      const bv = metricValue(b, sortBy);
      if (av === bv) return a.name.localeCompare(b.name);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  }, [observed, roleFilter, sortBy, sortDir]);

  const backupSaves = observed.reduce((sum, p) => sum + (p.stats?.backupSaves || 0), 0);
  const maxLatency = Math.max(1, ...observed.map(p => p.metrics.averageLatencyMs || 0));

  const fastest = observed
    .filter(p => p.metrics.averageLatencyMs !== null)
    .sort((a, b) => (a.metrics.averageLatencyMs || Infinity) - (b.metrics.averageLatencyMs || Infinity))[0];
  const bestAnswer = observed
    .filter(p => p.metrics.answerRate !== null)
    .sort((a, b) => (b.metrics.answerRate || 0) - (a.metrics.answerRate || 0))[0];
  const bestCoverage = observed
    .filter(p => p.metrics.coverageRate !== null)
    .sort((a, b) => (b.metrics.coverageRate || 0) - (a.metrics.coverageRate || 0))[0];
  const bestBackup = observed
    .filter(p => p.type === 'backup')
    .sort((a, b) => (b.stats?.backupSaves || 0) - (a.stats?.backupSaves || 0))[0];

  const setSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
      return;
    }
    setSortBy(key);
    setSortDir(key === 'speed' ? 'asc' : 'desc');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl border border-slate-700/50 shadow-2xl max-w-6xl w-full max-h-[90vh] flex flex-col animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex-shrink-0 bg-slate-900/95 backdrop-blur-sm p-4 md:p-6 border-b border-slate-700/50 rounded-t-xl">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Shield className="w-6 h-6 text-emerald-400 flex-shrink-0" />
              <div className="min-w-0">
                <h3 className="text-xl font-semibold text-slate-200">Provider Performance Metrics</h3>
                <div className="text-xs text-slate-500 mt-0.5">Observed NNTP article checks — 223 found, 430 missing, anything else unknown</div>
              </div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-200 transition-colors flex-shrink-0">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">History</span>
            {([
              ['lifetime', 'Lifetime'],
              ['24h', '24h'],
              ['7d', '7d'],
              ['30d', '30d'],
            ] as Array<[TimeWindow, string]>).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTimeWindow(key)}
                className={clsx(
                  "text-[10px] px-2.5 py-1 rounded-full border transition-colors",
                  timeWindow === key
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                    : "text-slate-500 border-slate-700 hover:text-slate-300"
                )}
              >
                {label}
              </button>
            ))}
            {timeWindow !== 'lifetime' && data?.summary.historyAvailableFrom && (
              <span className="text-[10px] text-slate-600">rolling history since {new Date(data.summary.historyAvailableFrom).toLocaleString()}</span>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-400 border-t-transparent" />
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>
          ) : !data || observed.length === 0 ? (
            <div className="rounded-lg border border-slate-700/40 bg-slate-800/40 p-6 text-center">
              <Shield className="w-8 h-8 text-slate-500 mx-auto mb-3" />
              <div className="text-slate-300 font-medium">{timeWindow === 'lifetime' ? 'No provider observations yet' : `No provider observations in the last ${timeWindow}`}</div>
              <div className="text-xs text-slate-500 mt-2">Leave Health Checks enabled and use UU normally. Lifetime includes existing beta.2 totals; rolling 24h/7d/30d history starts when beta.3 begins recording hourly buckets.</div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/30">
                  <div className="flex items-center gap-2 mb-1"><Shield className="w-3.5 h-3.5 text-emerald-400" /><span className="text-xs text-slate-500">Tracked Providers</span></div>
                  <div className="text-xl font-bold text-slate-200">{data.summary.tracked}</div>
                  <div className="text-[10px] text-slate-600">{data.summary.configured} configured</div>
                </div>
                <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/30">
                  <div className="flex items-center gap-2 mb-1"><Activity className="w-3.5 h-3.5 text-blue-400" /><span className="text-xs text-slate-500">Provider Checks</span></div>
                  <div className="text-xl font-bold text-slate-200">{data.summary.totalCheckAttempts}</div>
                </div>
                <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/30">
                  <div className="flex items-center gap-2 mb-1"><Database className="w-3.5 h-3.5 text-purple-400" /><span className="text-xs text-slate-500">Article Checks</span></div>
                  <div className="text-xl font-bold text-slate-200">{data.summary.totalArticlesChecked}</div>
                </div>
                <div className="bg-slate-800/60 rounded-lg p-3 border border-slate-700/30">
                  <div className="flex items-center gap-2 mb-1"><Heart className="w-3.5 h-3.5 text-pink-400" /><span className="text-xs text-slate-500">Backup Saves</span></div>
                  <div className="text-xl font-bold text-slate-200">{backupSaves}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div className="bg-slate-800/40 rounded-lg p-2.5 border border-cyan-500/20 flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-cyan-500/10 flex items-center justify-center flex-shrink-0"><Zap className="w-3.5 h-3.5 text-cyan-400" /></div>
                  <div className="min-w-0"><div className="text-[10px] text-cyan-400 font-medium">Fastest</div><div className="text-xs text-slate-300 truncate">{fastest?.name || '—'}</div><div className="text-[10px] text-slate-500">{fastest?.metrics.averageLatencyMs ?? '—'}ms avg</div></div>
                </div>
                <div className="bg-slate-800/40 rounded-lg p-2.5 border border-green-500/20 flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-green-500/10 flex items-center justify-center flex-shrink-0"><Shield className="w-3.5 h-3.5 text-green-400" /></div>
                  <div className="min-w-0"><div className="text-[10px] text-green-400 font-medium">Best Answer Rate</div><div className="text-xs text-slate-300 truncate">{bestAnswer?.name || '—'}</div><div className="text-[10px] text-slate-500">{bestAnswer ? pct(bestAnswer.metrics.answerRate) : '—'}</div></div>
                </div>
                <div className="bg-slate-800/40 rounded-lg p-2.5 border border-purple-500/20 flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-purple-500/10 flex items-center justify-center flex-shrink-0"><Database className="w-3.5 h-3.5 text-purple-400" /></div>
                  <div className="min-w-0"><div className="text-[10px] text-purple-400 font-medium">Highest Coverage</div><div className="text-xs text-slate-300 truncate">{bestCoverage?.name || '—'}</div><div className="text-[10px] text-slate-500">{bestCoverage ? pct(bestCoverage.metrics.coverageRate) : '—'}</div></div>
                </div>
                <div className="bg-slate-800/40 rounded-lg p-2.5 border border-pink-500/20 flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-pink-500/10 flex items-center justify-center flex-shrink-0"><Heart className="w-3.5 h-3.5 text-pink-400" /></div>
                  <div className="min-w-0"><div className="text-[10px] text-pink-400 font-medium">Most Backup Saves</div><div className="text-xs text-slate-300 truncate">{bestBackup?.name || '—'}</div><div className="text-[10px] text-slate-500">{bestBackup?.stats?.backupSaves ?? 0} articles</div></div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-slate-300 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-400" />Provider observations <span className="text-[10px] font-normal text-slate-500">({timeWindow === 'lifetime' ? 'lifetime' : `last ${timeWindow}`})</span></h4>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {(['all', 'pool', 'backup'] as RoleFilter[]).map(role => (
                      <button key={role} onClick={() => setRoleFilter(role)} className={clsx("text-[10px] px-2 py-0.5 rounded-full border transition-colors", roleFilter === role ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" : "text-slate-500 border-slate-700 hover:text-slate-300")}>{role === 'all' ? 'All' : role === 'pool' ? 'Pool' : 'Backup'}</button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] text-slate-500">Sort:</span>
                  {([
                    ['articles', 'Articles'],
                    ['coverage', 'Coverage'],
                    ['answer', 'Answer rate'],
                    ['success', 'Check success'],
                    ['speed', 'Speed'],
                    ['saves', 'Backup saves'],
                  ] as Array<[SortKey, string]>).map(([key, label]) => (
                    <button key={key} onClick={() => setSort(key)} className={clsx("text-[10px] px-2 py-0.5 rounded-full transition-colors border", sortBy === key ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/30" : "text-slate-500 border-transparent hover:text-slate-300")}>{label}{sortBy === key && <span className="ml-0.5">{sortDir === 'desc' ? '↓' : '↑'}</span>}</button>
                  ))}
                </div>

                <div className="space-y-1">
                  {visibleProviders.map(provider => {
                    const stats = provider.stats!;
                    const isExpanded = expanded === provider.id;
                    return (
                      <div key={provider.id} className="rounded-lg border border-slate-700/40 bg-slate-800/35 overflow-hidden">
                        <button onClick={() => setExpanded(isExpanded ? null : provider.id)} className="w-full p-3 text-left hover:bg-slate-700/20 transition-colors">
                          <div className="flex items-center gap-3">
                            <div className={clsx("text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border flex-shrink-0", provider.type === 'pool' ? "text-blue-300 border-blue-500/30 bg-blue-500/10" : "text-amber-300 border-amber-500/30 bg-amber-500/10")}>{provider.type}</div>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-slate-200 truncate">{provider.name}</div>
                              <div className="grid grid-cols-2 md:grid-cols-5 gap-x-3 gap-y-1 mt-1 text-[10px] text-slate-500">
                                <span>Articles: <b className="text-slate-300 font-medium">{stats.articlesChecked}</b></span>
                                <span>Coverage: <b className="text-green-400 font-medium">{pct(provider.metrics.coverageRate)}</b></span>
                                <span>Answer: <b className="text-cyan-400 font-medium">{pct(provider.metrics.answerRate)}</b></span>
                                <span>Checks: <b className="text-slate-300 font-medium">{pct(provider.metrics.checkSuccessRate)}</b></span>
                                <span>Speed: <b className="text-slate-300 font-medium">{provider.metrics.averageLatencyMs ?? '—'}ms</b></span>
                              </div>
                            </div>
                            <ChevronRight className={clsx("w-4 h-4 text-slate-500 transition-transform flex-shrink-0", isExpanded && "rotate-90")} />
                          </div>
                        </button>

                        {isExpanded && (
                          <div className="px-3 pb-3 border-t border-slate-700/30 bg-slate-900/30">
                            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 py-3">
                              {[
                                ['Found (223)', stats.found],
                                ['Missing (430)', stats.missing],
                                ['Unknown', stats.unknown],
                                ['Check failures', stats.failedChecks],
                                ['Backup saves', stats.backupSaves],
                                ['Confidence', pct(provider.metrics.confidence)],
                              ].map(([label, value]) => <div key={String(label)} className="rounded bg-slate-800/60 p-2"><div className="text-[9px] text-slate-500">{label}</div><div className="text-sm font-semibold text-slate-200 mt-0.5">{value}</div></div>)}
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[10px] text-slate-500">
                              <span>Auth failures: <b className="text-slate-300">{stats.authFailures}</b></span>
                              <span>TLS failures: <b className="text-slate-300">{stats.tlsFailures}</b></span>
                              <span>Timeouts: <b className="text-slate-300">{stats.timeoutFailures}</b></span>
                              <span>Connections: <b className="text-slate-300">{stats.connectionFailures}</b></span>
                              <span>Other: <b className="text-slate-300">{stats.otherFailures}</b></span>
                            </div>
                            {stats.lastError && <div className="mt-2 rounded border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-[10px] text-red-300 break-words">Last error: {stats.lastError}</div>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-slate-300">Response Time Comparison</h4>
                {observed.filter(p => p.metrics.averageLatencyMs !== null).sort((a, b) => (a.metrics.averageLatencyMs || 0) - (b.metrics.averageLatencyMs || 0)).map(provider => (
                  <div key={provider.id} className="grid grid-cols-[110px_1fr_64px] md:grid-cols-[170px_1fr_80px] gap-2 items-center text-xs">
                    <div className="text-slate-400 truncate text-right">{provider.name}</div>
                    <div className="h-5 rounded bg-slate-800 overflow-hidden"><div className="h-full rounded bg-cyan-400/80" style={{ width: `${Math.max(4, ((provider.metrics.averageLatencyMs || 0) / maxLatency) * 100)}%` }} /></div>
                    <div className="text-slate-400 text-right">{provider.metrics.averageLatencyMs}ms</div>
                  </div>
                ))}
              </div>

              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-slate-300">Article Answer Rate Comparison</h4>
                {observed.filter(p => p.metrics.answerRate !== null).sort((a, b) => (b.metrics.answerRate || 0) - (a.metrics.answerRate || 0)).map(provider => (
                  <div key={provider.id} className="grid grid-cols-[110px_1fr_48px] md:grid-cols-[170px_1fr_60px] gap-2 items-center text-xs">
                    <div className="text-slate-400 truncate text-right">{provider.name}</div>
                    <div className="h-5 rounded bg-slate-800 overflow-hidden"><div className="h-full rounded bg-green-400/80" style={{ width: barWidth(provider.metrics.answerRate) }} /></div>
                    <div className="text-slate-400 text-right">{pct(provider.metrics.answerRate)}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-3">
                <div>
                  <h4 className="text-sm font-semibold text-slate-300">Article Outcome Distribution</h4>
                  <div className="text-[10px] text-slate-500 mt-1">Green = found (223), red = explicit missing (430), amber = unknown/unverified.</div>
                </div>
                {observed.filter(p => (p.stats?.articlesChecked || 0) > 0).sort((a, b) => (b.stats?.articlesChecked || 0) - (a.stats?.articlesChecked || 0)).map(provider => {
                  const stats = provider.stats!;
                  const total = Math.max(1, stats.articlesChecked);
                  return (
                    <div key={provider.id} className="grid grid-cols-[110px_1fr_52px] md:grid-cols-[170px_1fr_70px] gap-2 items-center text-xs">
                      <div className="text-slate-400 truncate text-right">{provider.name}</div>
                      <div className="h-5 rounded bg-slate-800 overflow-hidden flex">
                        <div className="h-full bg-green-400/80" style={{ width: `${(stats.found / total) * 100}%` }} title={`Found: ${stats.found}`} />
                        <div className="h-full bg-red-400/80" style={{ width: `${(stats.missing / total) * 100}%` }} title={`Missing: ${stats.missing}`} />
                        <div className="h-full bg-amber-400/80" style={{ width: `${(stats.unknown / total) * 100}%` }} title={`Unknown: ${stats.unknown}`} />
                      </div>
                      <div className="text-slate-500 text-right">{stats.articlesChecked}</div>
                    </div>
                  );
                })}
              </div>

              <div className="rounded-lg border border-slate-700/30 bg-slate-900/30 p-3 text-[10px] text-slate-500 leading-relaxed">
                <b className="text-slate-400">Observe-only:</b> these metrics do not reorder, disable, prioritise, or otherwise control providers. Coverage is simply the share of definitive article answers that were found; it is not a provider score. Pool and backup providers can see different difficulty mixes, so compare role and sample size as well as percentages. Rolling windows use hourly buckets retained for 31 days.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
