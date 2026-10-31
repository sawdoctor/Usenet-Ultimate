import { AsyncLocalStorage } from 'async_hooks';

export const requestContext = new AsyncLocalStorage<{
  manifestKey: string;
  baseUrl: string;
  pathPrefix: string;
  /** The Stremio client's address, which picks the network whose stream speeds the Adaptive tile shows. */
  clientIp?: string;
  /** Set on the addon's own prefetch and refresh requests: a stale cache entry is searched again instead of served. */
  background?: boolean;
  /** Set by the stream handler when it served a stale cache entry, so the route queues a refresh. */
  servedStale?: boolean;
}>();
