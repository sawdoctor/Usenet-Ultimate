import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateNewznabReference,
  verifyNewznabReference,
} from '../src/auth/auth.js';

const MANIFEST_A = 'manifest-a';
const MANIFEST_B = 'manifest-b';
const TARGET = 'https://indexer.example.test/api?t=get&id=123&apikey=secret';

test('signed Newznab reference resolves to the exact upstream URL', () => {
  const ref = generateNewznabReference(TARGET, MANIFEST_A);
  assert.equal(verifyNewznabReference(ref, MANIFEST_A), TARGET);
});

test('signed Newznab reference is bound to the issuing manifest', () => {
  const ref = generateNewznabReference(TARGET, MANIFEST_A);
  assert.equal(verifyNewznabReference(ref, MANIFEST_B), null);
});

test('tampered Newznab reference is rejected', () => {
  const ref = generateNewznabReference(TARGET, MANIFEST_A);
  const last = ref.at(-1);
  assert(last);
  const tampered = ref.slice(0, -1) + (last === 'a' ? 'b' : 'a');
  assert.equal(verifyNewznabReference(tampered, MANIFEST_A), null);
});

test('legacy base64url URL is rejected as unsigned', () => {
  const legacy = Buffer.from(TARGET, 'utf8').toString('base64url');
  assert.equal(verifyNewznabReference(legacy, MANIFEST_A), null);
});

test('non-HTTP targets cannot be signed', () => {
  assert.throws(
    () => generateNewznabReference('file:///etc/passwd', MANIFEST_A),
    /must be HTTP\(S\)/,
  );
});
