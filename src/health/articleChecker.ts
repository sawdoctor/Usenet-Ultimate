/**
 * Article Checker
 *
 * Verifies article existence on Usenet providers using NNTP STAT commands.
 * Supports pipelined checks, per-provider verification, and multi-provider
 * fallback (pool providers checked in parallel, then backup providers for missing).
 */

import * as net from 'net';
import * as tls from 'tls';
import type { UsenetProvider } from '../types.js';
import { connectToUsenet, NntpConnectionPool } from './nntpConnection.js';

/**
 * Per-provider article check outcome.
 *
 * `missing` means the server explicitly answered 430 (no such article) — that
 * is the ONLY positive evidence of absence NNTP gives us. `unknown` means the
 * check produced no usable answer for that article: an unexpected response
 * code (480 auth-required on a stale pooled socket, 452, 502...), or a socket
 * that closed before the article's response arrived. Unknown is NOT absence,
 * and callers must never treat it as such — a wrong "missing" verdict writes
 * the release to the dead-NZB cache, which is effectively permanent.
 */
export interface ArticleCheckOutcome {
  existing: string[];
  missing: string[];
  unknown: string[];
}

/**
 * Check which articles exist on a Usenet connection
 * Returns lists of existing, missing (explicit 430) and unknown message IDs
 */
export async function checkArticlesDetailed(
  socket: net.Socket | tls.TLSSocket,
  messageIds: string[],
  timeoutMs: number = 30000
): Promise<ArticleCheckOutcome> {
  return new Promise((resolve, reject) => {
    if (messageIds.length === 0) {
      resolve({ existing: [], missing: [], unknown: [] });
      return;
    }

    const existing: string[] = [];
    const missing: string[] = [];
    const unknown: string[] = [];
    let checked = 0;
    let buffer = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`Article check timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeListener('data', dataHandler);
      socket.removeListener('error', errorHandler);
      socket.removeListener('close', closeHandler);
      socket.removeListener('end', endHandler);
    };

    const dataHandler = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        if (checked >= messageIds.length) break;
        const currentId = messageIds[checked];
        // Article exists (223)
        if (line.startsWith('223')) {
          existing.push(currentId);
          checked++;
        }
        // Article not found (430)
        else if (line.startsWith('430')) {
          missing.push(currentId);
          checked++;
        }
        // Any other NNTP response code is an UNKNOWN result, never a missing
        // one. 480 (auth required, e.g. after a pooled socket went stale), 452,
        // 502 and friends say nothing about whether the article exists — the
        // server simply didn't answer the question we asked.
        else if (/^\d{3}\s/.test(line)) {
          console.warn(`⚠️  Unexpected NNTP response during article check (treated as unverified): ${line}`);
          unknown.push(currentId);
          checked++;
        }

        // All pipelined responses received
        if (checked >= messageIds.length && !resolved) {
          resolved = true;
          cleanup();
          resolve({ existing, missing, unknown });
          return;
        }
      }
    };

    const errorHandler = (error: Error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(error);
      }
    };

    // Handle server-side disconnects — without these, a dropped connection
    // would hang until the 30s timeout fires (common when all articles are
    // missing and the server drops the client after repeated 430s)
    const closeHandler = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        // Articles whose response never arrived are UNVERIFIED, not missing.
        // The server dropping the connection is a statement about the
        // connection, not about the articles — the previous behaviour turned
        // one mid-check disconnect into a permanent dead-cache entry for a
        // release that may be perfectly healthy.
        if (checked < messageIds.length) {
          console.warn(`⚠️  Connection closed after ${checked}/${messageIds.length} article checks — remaining treated as unverified`);
        }
        for (let i = checked; i < messageIds.length; i++) {
          unknown.push(messageIds[i]);
        }
        resolve({ existing, missing, unknown });
      }
    };

    const endHandler = () => {
      // 'end' fires before 'close' — treat identically
      closeHandler();
    };

    socket.on('data', dataHandler);
    socket.on('error', errorHandler);
    socket.on('close', closeHandler);
    socket.on('end', endHandler);

    // Pipeline all STAT commands in a single write instead of one-at-a-time.
    // NNTP responses arrive in order, so we match them by index.
    const pipeline = messageIds.map(id => `STAT <${id}>`).join('\r\n') + '\r\n';
    socket.write(pipeline);
  });
}

/**
 * Check articles on a single provider
 * Uses pool if available, otherwise connects and disconnects
 */
export async function checkArticlesOnProvider(
  provider: UsenetProvider,
  messageIds: string[],
  pool?: NntpConnectionPool
): Promise<ArticleCheckOutcome> {
  if (pool) {
    const socket = await pool.acquire(provider);
    try {
      const result = await checkArticlesDetailed(socket, messageIds);
      pool.release(provider, socket);
      return result;
    } catch (err) {
      try { socket.destroy(); } catch {}
      throw err;
    }
  }
  const socket = await connectToUsenet(provider);
  try {
    return await checkArticlesDetailed(socket, messageIds);
  } finally {
    socket.destroy();
  }
}

export interface MultiProviderCheckResult {
  totalExists: number;
  /** Articles every reachable provider explicitly answered 430 for. */
  totalMissing: number;
  /** Articles no provider gave a usable answer for — absence NOT established. */
  totalUnknown: number;
  missingIds: string[];
  unknownIds: string[];
  providersUsed: Array<{ id: string; name: string; type: 'pool' | 'backup'; found: number; total: number }>;
  /** Enabled providers that could not be checked at all (connect/auth failure). */
  providersFailed: number;
}

/**
 * When an enabled provider can't be reached at all, a "missing" verdict from
 * the providers that DID answer is not trustworthy: the unreachable provider
 * is exactly the one that might have carried the article. Default is to
 * downgrade every unfound article to unknown in that case (fail open).
 *
 * Set HEALTH_REQUIRE_ALL_PROVIDERS=off to revert to "verdict stands on
 * whichever providers answered" — faster to reach blocked verdicts, at the
 * cost of dead-cache writes whenever a provider is flaky.
 */
function requireAllProviders(): boolean {
  const v = (process.env.HEALTH_REQUIRE_ALL_PROVIDERS || '').toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return false;
  return true;
}

/**
 * Check articles across multiple providers with fallback.
 * Pool providers are checked first, then backup providers for articles the
 * pool didn't confirm.
 *
 * Aggregation rule — an article is only `missing` when the evidence is
 * positive and complete:
 *   - found on any provider                      → exists
 *   - not found, at least one explicit 430,
 *     no provider left it unanswered             → missing
 *   - anything else (unexpected codes, mid-check
 *     disconnects, unreachable providers)        → unknown
 */
export async function checkArticlesMultiProvider(
  providers: UsenetProvider[],
  messageIds: string[],
  pool?: NntpConnectionPool
): Promise<MultiProviderCheckResult> {
  const poolProviders = providers.filter(p => p.enabled && p.type === 'pool');
  const backupProviders = providers.filter(p => p.enabled && p.type === 'backup');

  if (poolProviders.length === 0 && backupProviders.length === 0) {
    throw new Error('No enabled providers configured');
  }

  const foundIds = new Set<string>();
  /** Ids some provider explicitly answered 430 for. */
  const deniedIds = new Set<string>();
  /** Ids some provider failed to answer for. */
  const unansweredIds = new Set<string>();
  const providersUsed: Array<{ id: string; name: string; type: 'pool' | 'backup'; found: number; total: number }> = [];
  let providersChecked = 0;
  let providersFailed = 0;

  const absorb = (result: ArticleCheckOutcome) => {
    for (const id of result.existing) foundIds.add(id);
    for (const id of result.missing) deniedIds.add(id);
    for (const id of result.unknown) unansweredIds.add(id);
  };

  // Check ALL pool providers in PARALLEL with the same full set of IDs
  if (poolProviders.length > 0) {
    const poolResults = await Promise.allSettled(
      poolProviders.map(async (provider) => {
        const result = await checkArticlesOnProvider(provider, messageIds, pool);
        return { provider, result };
      })
    );

    for (const outcome of poolResults) {
      if (outcome.status === 'fulfilled') {
        const { provider, result } = outcome.value;
        providersChecked++;
        if (result.existing.length > 0) {
          providersUsed.push({ id: provider.id, name: provider.name, type: provider.type, found: result.existing.length, total: messageIds.length });
        }
        if (result.unknown.length > 0) {
          console.warn(`  [provider] ${provider.name}: ${result.unknown.length}/${messageIds.length} article(s) unverified`);
        }
        absorb(result);
      } else {
        providersFailed++;
        console.warn(`  [provider] Pool check failed: ${outcome.reason}`);
      }
    }
  }

  // Compute remaining IDs not found by any pool provider
  let remainingIds = messageIds.filter(id => !foundIds.has(id));

  // If articles are still unconfirmed, check ALL backup providers in PARALLEL
  if (remainingIds.length > 0 && backupProviders.length > 0) {
    const backupResults = await Promise.allSettled(
      backupProviders.map(async (provider) => {
        const result = await checkArticlesOnProvider(provider, remainingIds, pool);
        return { provider, result };
      })
    );

    for (const outcome of backupResults) {
      if (outcome.status === 'fulfilled') {
        const { provider, result } = outcome.value;
        providersChecked++;
        if (result.existing.length > 0) {
          providersUsed.push({ id: provider.id, name: provider.name, type: provider.type, found: result.existing.length, total: remainingIds.length });
        }
        if (result.unknown.length > 0) {
          console.warn(`  [provider] ${provider.name}: ${result.unknown.length}/${remainingIds.length} article(s) unverified`);
        }
        absorb(result);
      } else {
        providersFailed++;
        console.warn(`  [provider] Backup check failed: ${outcome.reason}`);
      }
    }

    remainingIds = messageIds.filter(id => !foundIds.has(id));
  }

  // If no providers were successfully checked, we can't determine availability
  if (providersChecked === 0) {
    throw new Error('All providers failed to connect');
  }

  // An unreachable provider makes every negative verdict unsafe.
  const strictQuorum = providersFailed > 0 && requireAllProviders();
  if (strictQuorum) {
    console.warn(`  [provider] ${providersFailed} enabled provider(s) unreachable — negative verdicts downgraded to unverified (HEALTH_REQUIRE_ALL_PROVIDERS=off to disable)`);
  }

  const missingIds: string[] = [];
  const unknownIds: string[] = [];
  for (const id of remainingIds) {
    if (strictQuorum || unansweredIds.has(id) || !deniedIds.has(id)) {
      unknownIds.push(id);
    } else {
      missingIds.push(id);
    }
  }

  return {
    totalExists: foundIds.size,
    totalMissing: missingIds.length,
    totalUnknown: unknownIds.length,
    missingIds,
    unknownIds,
    providersUsed,
    providersFailed
  };
}
