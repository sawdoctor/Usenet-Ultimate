import { createRequire } from 'node:module';
import { addonIdentity } from './identity.js';

const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require('../../package.json');

// Define addon manifest - tells Stremio what we support
export const manifest = {
  id: addonIdentity.id,
  version: APP_VERSION,
  name: addonIdentity.name,
  description: 'Search Usenet indexers and EasyNews for media content. Supports Newznab, Prowlarr, and NZBHydra with NZB health checking, quality-based sorting, and direct streaming via NZBDav or EasyNews.',
  logo: '/pwa-512x512.png',
  resources: ['stream'],           // We only provide streams
  types: ['movie', 'series'],      // Support movies and TV shows
  catalogs: [],                    // No catalogs (don't show in discover)
  idPrefixes: ['tt', 'kitsu:', 'mal:', 'anilist:', 'anidb:', 'tvdb:', 'tmdb:'],
  behaviorHints: {
    configurable: true,            // We have a config UI
    configurationRequired: false,  // But it's optional
  },
};
