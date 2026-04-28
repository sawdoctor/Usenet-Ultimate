/**
 * NZBDav Module
 * Re-exports all public symbols from the nzbdav submodules.
 */

// Types
export type { NZBDavConfig, FallbackCandidate } from './types.js';

// Fallback management
export { createFallbackGroup, getFallbackGroup, clearFallbackGroups } from './fallbackManager.js';

// Stream cache
export { getOrCreateStream, getCacheKey, getDeadCacheKey, isStreamCached, isDeadNzbByUrl, addDeadNzbByUrl, evictReadyByVideoPath, clearTimeoutEntries, setReadyCacheEntry, setDeadNzbEntry } from './streamCache.js';

// Cache utilities
export { getCacheStats, clearStreamCache, clearReadyCache, clearFailedCache, deleteCacheEntry, getCacheEntries, saveCacheToDisk } from './cacheUtils.js';

// Ultimate-Fallback (combined retry-on-failure + health checking pipeline)
export { ultimateFallbackFromCandidates, cancelAllUltimateFallbacks, getSessionPromise, hasAnySessions } from './ultimateFallback.js';

// Shared utilities
export { buildEpisodePattern, buildNzbdavConfig, isNzbdavLibraryConfigured } from './utils.js';

// Stream handler (Express endpoint)
export { handleStream } from './streamHandler.js';
