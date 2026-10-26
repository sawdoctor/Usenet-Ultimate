import { DEFAULT_CARD_ORDER } from '../constants';

export function normalizeCardOrder(saved: string[] | undefined): string[] {
  // Ensure all cards are in cardOrder (backward compat)
  let order: string[] = saved || [...DEFAULT_CARD_ORDER];
  // Strip removed cards from saved orders so the dashboard doesn't render phantom slots
  order = order.filter((c: string) => c !== 'fallback');
  if (!order.includes('userAgent')) {
    const cacheIndex = order.indexOf('cache');
    if (cacheIndex !== -1) {
      order = [...order.slice(0, cacheIndex + 1), 'userAgent', ...order.slice(cacheIndex + 1)];
    } else {
      order = [...order, 'userAgent'];
    }
  }
  if (!order.includes('filters')) {
    const userAgentIndex = order.indexOf('userAgent');
    if (userAgentIndex !== -1) {
      order = [...order.slice(0, userAgentIndex), 'filters', ...order.slice(userAgentIndex)];
    } else {
      order = [...order, 'filters'];
    }
  }
  if (!order.includes('healthChecks')) {
    const streamingIndex = order.indexOf('streaming');
    if (streamingIndex !== -1) {
      order = [...order.slice(0, streamingIndex + 1), 'healthChecks', ...order.slice(streamingIndex + 1)];
    } else {
      order = [...order, 'healthChecks'];
    }
  }
  if (!order.includes('proxy')) {
    const streamingIndex = order.indexOf('streaming');
    if (streamingIndex !== -1) {
      order = [...order.slice(0, streamingIndex + 1), 'proxy', ...order.slice(streamingIndex + 1)];
    } else {
      order = [...order, 'proxy'];
    }
  }
  if (!order.includes('power')) {
    order = [...order, 'power'];
  }
  if (!order.includes('autoPlay')) {
    const healthChecksIndex = order.indexOf('healthChecks');
    if (healthChecksIndex !== -1) {
      order = [...order.slice(0, healthChecksIndex + 1), 'autoPlay', ...order.slice(healthChecksIndex + 1)];
    } else {
      order = [...order, 'autoPlay'];
    }
  }
  if (!order.includes('streamDisplay')) {
    const autoPlayIndex = order.indexOf('autoPlay');
    if (autoPlayIndex !== -1) {
      order = [...order.slice(0, autoPlayIndex + 1), 'streamDisplay', ...order.slice(autoPlayIndex + 1)];
    } else {
      order = [...order, 'streamDisplay'];
    }
  }
  if (!order.includes('zyclops')) {
    const proxyIndex = order.indexOf('proxy');
    if (proxyIndex !== -1) {
      order = [...order.slice(0, proxyIndex + 1), 'zyclops', ...order.slice(proxyIndex + 1)];
    } else {
      order = [...order, 'zyclops'];
    }
  }
  if (!order.includes('nzbDatabase')) {
    const healthIdx = order.indexOf('healthChecks');
    order = healthIdx !== -1
      ? [...order.slice(0, healthIdx + 1), 'nzbDatabase', ...order.slice(healthIdx + 1)]
      : [...order, 'nzbDatabase'];
  }
  if (!order.includes('ultimateFallback')) {
    const zyclopsIdx = order.indexOf('zyclops');
    order = zyclopsIdx !== -1
      ? [...order.slice(0, zyclopsIdx + 1), 'ultimateFallback', ...order.slice(zyclopsIdx + 1)]
      : [...order, 'ultimateFallback'];
  }
  if (!order.includes('economyFallback')) {
    const ufIdx = order.indexOf('ultimateFallback');
    order = ufIdx !== -1
      ? [...order.slice(0, ufIdx + 1), 'economyFallback', ...order.slice(ufIdx + 1)]
      : [...order, 'economyFallback'];
  }
  if (!order.includes('providerStats')) {
    const healthIdx = order.indexOf('healthChecks');
    order = healthIdx !== -1
      ? [...order.slice(0, healthIdx + 1), 'providerStats', ...order.slice(healthIdx + 1)]
      : [...order, 'providerStats'];
  }
  return order;
}
