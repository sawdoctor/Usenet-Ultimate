import NodeCache from 'node-cache';

// Cache resolved IDs for 24 hours
export const idCache = new NodeCache({ stdTTL: 86400 });

const inFlight = new Map<string, Promise<unknown>>();

// Only non-null results are cached, so failed lookups retry. Concurrent callers share one pending search.
export async function cachedRemoteSearch<T>(key: string, search: () => Promise<T | null>): Promise<T | null> {
  const cached = idCache.get<T>(key);
  if (cached) return cached;
  const pending = inFlight.get(key) as Promise<T | null> | undefined;
  if (pending) return pending;
  const run = search()
    .then(result => {
      if (result) idCache.set(key, result);
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}
