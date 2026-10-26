import { Router, type Request, type Response, type NextFunction } from 'express';
import { parse as parseQueryString } from 'node:querystring';
import { requestContext } from '../requestContext.js';
import { PREFETCH_HEADER, nextEpisodeUrl, schedulePrefetch, warmSeason } from '../addon/prefetch.js';

export interface StremioAddonInterface {
  manifest: Record<string, unknown>;
  get(
    resource: string,
    type: string,
    id: string,
    extra?: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<any>;
}

function parseExtra(req: Request): Record<string, unknown> {
  const pathname = req.url.split('?', 1)[0] || '';
  const lastSegment = pathname.split('/').pop() || '';
  if (!lastSegment.endsWith('.json')) return {};
  const raw = lastSegment.slice(0, -'.json'.length);
  if (!raw || !raw.includes('=')) return {};
  return parseQueryString(raw) as Record<string, unknown>;
}

function applyCacheHeaders(res: Response, payload: any): void {
  const parts: string[] = [];
  const candidates: Array<[string, unknown]> = [
    ['max-age', payload?.cacheMaxAge],
    ['stale-while-revalidate', payload?.staleRevalidate],
    ['stale-if-error', payload?.staleError],
  ];
  for (const [name, value] of candidates) {
    if (Number.isInteger(value)) parts.push(`${name}=${value}`);
  }
  if (parts.length) res.setHeader('Cache-Control', `${parts.join(', ')}, public`);
}

function nextEpisodeFor(req: Request): string | undefined {
  const store = requestContext.getStore();
  if (!store?.manifestKey) return undefined;
  return nextEpisodeUrl(`http://127.0.0.1:${process.env.PORT || 1337}`, store.pathPrefix || '', store.manifestKey, req.params.id);
}

export function createStremioRouter(addon: StremioAddonInterface): Router {
  const router = Router();

  const streamHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = await addon.get('stream', req.params.type, req.params.id, parseExtra(req), {});
      applyCacheHeaders(res, payload);
      const nextUrl = req.params.type === 'series' && !req.headers[PREFETCH_HEADER] ? nextEpisodeFor(req) : undefined;
      if (nextUrl) res.on('finish', () => schedulePrefetch(nextUrl));
      const store = requestContext.getStore();
      if (nextUrl && store?.manifestKey) {
        res.on('finish', () => warmSeason(`http://127.0.0.1:${process.env.PORT || 1337}`, store.pathPrefix || '', store.manifestKey, req.params.type, req.params.id));
      }
      if (payload?.redirect) return res.redirect(307, payload.redirect);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(payload));
    } catch (err: any) {
      if (err?.noHandler) return next();
      console.error(err);
      res.status(500).type('application/json').end(JSON.stringify({ err: 'handler error' }));
    }
  };

  // UU declares only the Stremio `stream` resource. Keep the two route shapes
  // explicit rather than using an optional path token, which avoids the old
  // stremio-addon-sdk/router/path-to-regexp dependency chain entirely.
  router.get('/stream/:type/:id.json', streamHandler);
  router.get('/stream/:type/:id/:extra.json', streamHandler);

  return router;
}
