import { Router } from 'express';
import type { UsenetProvider } from '../types.js';
import {
  getProviderReputationData,
  type ProviderReputationWindow,
} from '../providerReputation.js';

interface ReputationRouteDeps {
  getProviders: () => UsenetProvider[];
}

const WINDOWS = new Set<ProviderReputationWindow>(['lifetime', '24h', '7d', '30d']);

export function createReputationRoutes(deps: ReputationRouteDeps): Router {
  const router = Router();

  router.get('/providers', (req, res) => {
    const requested = String(req.query.window || 'lifetime') as ProviderReputationWindow;
    const window: ProviderReputationWindow = WINDOWS.has(requested) ? requested : 'lifetime';
    res.json(getProviderReputationData(deps.getProviders(), window));
  });

  return router;
}
