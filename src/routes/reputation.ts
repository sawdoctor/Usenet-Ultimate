import { Router } from 'express';
import type { UsenetProvider } from '../types.js';
import { getProviderReputationData } from '../providerReputation.js';

interface ReputationRouteDeps {
  getProviders: () => UsenetProvider[];
}

/**
 * Protected reputation endpoints.
 *
 * Mounted beneath /api after requireAuth in server.ts.  Provider credentials,
 * hostnames and ports are intentionally not returned: the dashboard only needs
 * stable id/name/type/enabled metadata plus locally observed reputation data.
 */
export function createReputationRoutes(deps: ReputationRouteDeps): Router {
  const router = Router();

  router.get('/providers', (_req, res) => {
    res.json(getProviderReputationData(deps.getProviders()));
  });

  return router;
}
