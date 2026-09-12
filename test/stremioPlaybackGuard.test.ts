import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('pending stream preparation stays single-flight until it settles', () => {
  const source = readFileSync(new URL('../src/nzbdav/streamCache.ts', import.meta.url), 'utf8');
  assert.match(source, /pendingCache\.set\(cacheKey,[\s\S]*?expiresAt: Infinity/);
  assert.doesNotMatch(source, /expiresAt: Date\.now\(\) \+ pendingTTLMs/);
});

test('initial Stremio request always uses the existing client timeout redirect gate', () => {
  const source = readFileSync(new URL('../src/nzbdav/streamHandler.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(stremioRemainingMs > 0 && !req\.socket\.destroyed\) \{/);
  assert.doesNotMatch(source, /attemptBudgetMs > stremioRemainingMs/);
  assert.match(source, /Stremio timeout redirect/);
  assert.match(source, /isExoTimeout: true/);
});
