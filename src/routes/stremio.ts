import { Router, type Request, type Response, type NextFunction } from 'express';
import { parse as parseQueryString } from 'node:querystring';

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

export function createStremioRouter(addon: StremioAddonInterface): Router {
  const router = Router();

  const streamHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = await addon.get('stream', req.params.type, req.params.id, parseExtra(req), {});
      applyCacheHeaders(res, payload);
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
