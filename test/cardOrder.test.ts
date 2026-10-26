import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCardOrder } from '../ui/src/utils/cardOrder.js';

test('a saved order without Economy Fallback gets the card right after Ultimate Fallback', () => {
  // Arrange
  const saved = ['streaming', 'indexManager', 'proxy', 'zyclops', 'ultimateFallback', 'healthChecks', 'providerStats', 'nzbDatabase', 'autoPlay', 'streamDisplay', 'cache', 'filters', 'userAgent', 'status', 'stats', 'power'];

  // Act
  const order = normalizeCardOrder(saved);

  // Assert
  assert.equal(order.indexOf('economyFallback'), order.indexOf('ultimateFallback') + 1);
  assert.equal(new Set(order).size, order.length);
});

test('a saved order that already has Economy Fallback keeps its position', () => {
  // Arrange
  const saved = ['economyFallback', 'ultimateFallback', 'streaming'];

  // Act
  const order = normalizeCardOrder(saved);

  // Assert
  assert.equal(order.indexOf('economyFallback'), 0);
  assert.equal(order.filter(c => c === 'economyFallback').length, 1);
});

test('with no saved order every default card is present, and removed cards are stripped', () => {
  // Act
  const fresh = normalizeCardOrder(undefined);
  const stripped = normalizeCardOrder(['fallback', 'streaming']);

  // Assert
  assert.ok(fresh.includes('economyFallback') && fresh.includes('ultimateFallback'));
  assert.ok(!stripped.includes('fallback'));
});
