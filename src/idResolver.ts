/**
 * External ID Resolver
 *
 * Resolves IMDB IDs (from Stremio) to external service IDs (TMDB, TVDB, TVmaze)
 * for use with Newznab indexer search parameters.
 *
 * Caches resolved IDs for 24 hours since these mappings are essentially permanent.
 */

export { resolveTmdbExternalIds, resolveTitleFromTmdb, resolveRuntimeFromTmdb, getCachedPremiereYear } from './idResolver/tmdb.js';
export { detectRemake, resolveTitleFromTvdb, getCachedTitleByImdb, clearTvdbToken, clearTvdbTitleCache } from './idResolver/tvdbSearch.js';
export { fetchTvdbRecordById } from './idResolver/tvdbRecord.js';
export { resolveEpisodeCountFromTvdb, resolveEpisodeCountFromTvdbId } from './idResolver/tvdbEpisodes.js';
export { resolveExternalId } from './idResolver/external.js';
