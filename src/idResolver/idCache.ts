import NodeCache from 'node-cache';

// Cache resolved IDs for 24 hours
export const idCache = new NodeCache({ stdTTL: 86400 });
