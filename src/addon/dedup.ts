/**
 * Result Deduplication
 *
 * Content-only passes that run before any user-preference filtering:
 *  - stripBareArchiveParts: drops non-release entries (par2/rar/nzb/etc.)
 *  - deduplicateByUrl: removes entries that share a download URL
 *  - deduplicateByPriority: keeps the highest-priority indexer's copy when
 *    the same title+size appears from multiple indexers
 */

import { config } from '../config/index.js';
import { formatBytes } from '../parsers/metadataParsers.js';
import { isBareArchivePart, matchedJunkKind, safeLogTitle, JUNK_EMOJI } from './junkFilter.js';

/**
 * Baseline junk filter — strips bare archive parts and NZB containers that
 * leak in from older indexer databases. These are never valid releases.
 * Runs before anything else so they don't reach parsing, dedup, or rules.
 */
export function stripBareArchiveParts(allResults: any[]): any[] {
  if (allResults.length === 0) return allResults;
  const dropped: { title: string; kind: string }[] = [];
  const kept = allResults.filter(r => {
    if (isBareArchivePart(r.title)) {
      dropped.push({ title: r.title, kind: matchedJunkKind(r.title) || 'junk' });
      return false;
    }
    return true;
  });
  if (dropped.length > 0) {
    console.log(`${JUNK_EMOJI} Junk filter: removed ${dropped.length} non-release(s) (${kept.length} remaining)`);
    for (const d of dropped) console.log(`   ✂️  "${safeLogTitle(d.title)}" (${d.kind})`);
  }
  return kept;
}

/**
 * URL deduplication — removes results with identical download URLs.
 * First occurrence wins; subsequent duplicates are dropped.
 */
export function deduplicateByUrl(allResults: any[]): any[] {
  if (config.searchConfig?.urlDedup === false || allResults.length === 0) return allResults;

  const seen = new Map<string, string>(); // link → indexerName of first occurrence
  const duplicates: { title: string; indexer: string }[] = [];
  const deduped = allResults.filter(r => {
    if (!r.link) return true;
    const existing = seen.get(r.link);
    if (existing) {
      duplicates.push({ title: r.title, indexer: existing });
      return false;
    }
    seen.set(r.link, r.indexerName || 'Unknown');
    return true;
  });

  if (duplicates.length > 0) {
    console.log(`🔗 URL dedup: removed ${duplicates.length} duplicate(s) (${deduped.length} remaining)`);
    for (const d of duplicates) console.log(`   ✂️  "${d.title}" (duplicate of ${d.indexer} result)`);
  }

  return deduped;
}

/**
 * Cross-indexer deduplication by indexer priority.
 * Keeps only the copy from the highest-priority indexer when the same
 * title+size combination appears from multiple indexers.
 */
export function deduplicateByPriority(allResults: any[]): any[] {
  if (!config.searchConfig?.indexerPriorityDedup || allResults.length === 0) {
    return allResults;
  }

  // Build priority map: indexer name → priority number (lower = higher priority)
  const priorityMap = new Map<string, number>();
  if (config.indexerPriority && config.indexerPriority.length > 0) {
    // Use explicit priority list
    config.indexerPriority.forEach((name, i) => priorityMap.set(name, i));
  } else {
    // Fall back to indexer array order + EasyNews last
    if (config.indexManager === 'newznab') {
      config.indexers.forEach((idx, i) => { if (idx.enabled) priorityMap.set(idx.name, i); });
    } else {
      (config.syncedIndexers || []).forEach((idx, i) => { if (idx.enabledForSearch) priorityMap.set(idx.name, i); });
    }
    priorityMap.set('EasyNews', 9999);
  }

  console.log(`🔀 Indexer priority order: ${[...priorityMap.entries()].sort((a, b) => a[1] - b[1]).map(([name, p]) => `${name}(#${p + 1})`).join(', ')}`);

  const beforeDedup = allResults.length;
  const seen = new Map<string, { priority: number; index: number; indexerName: string }>();
  const dropped: { title: string; droppedFrom: string; keptFrom: string }[] = [];
  allResults.forEach((result, i) => {
    const key = `${result.title}-${formatBytes(result.size)}`;
    const priority = priorityMap.get(result.indexerName) ?? 9998;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { priority, index: i, indexerName: result.indexerName });
    } else if (priority < existing.priority) {
      // New result has higher priority — drop the old one, keep the new
      dropped.push({ title: result.title, droppedFrom: existing.indexerName, keptFrom: result.indexerName });
      seen.set(key, { priority, index: i, indexerName: result.indexerName });
    } else {
      // Existing has higher priority — drop the new one
      dropped.push({ title: result.title, droppedFrom: result.indexerName, keptFrom: existing.indexerName });
    }
  });
  const keepIndices = new Set([...seen.values()].map(v => v.index));
  const deduped = allResults.filter((_, i) => keepIndices.has(i));
  const removed = beforeDedup - deduped.length;
  if (removed > 0) {
    console.log(`🔀 Indexer priority dedup: removed ${removed} duplicate(s) (${deduped.length} remaining)`);
    for (const d of dropped) {
      console.log(`   ✂️  "${d.title}" — dropped ${d.droppedFrom}, kept ${d.keptFrom}`);
    }
  }
  return deduped;
}
