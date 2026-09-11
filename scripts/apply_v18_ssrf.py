from pathlib import Path
import re

auth = Path('src/auth/auth.ts')
s = auth.read_text()
marker = "// ── Manifest CRUD ────────────────────────────────────────────────────\n"
assert marker in s, 'auth.ts insertion marker not found'
block = '''// ── Signed Newznab NZB references ─────────────────────────────────────
//
// Newznab download links are reachable with a manifest key, so the raw
// upstream NZB URL must never be accepted from the caller. Search results
// receive a short-lived server-signed reference instead. The reference is
// bound to the manifest that issued it, preventing cross-manifest replay.
const NEWZNAB_REFERENCE_TTL = '24h';

interface NewznabReferencePayload {
  purpose: 'newznab-nzb';
  target: string;
  manifestKey: string;
}

export function generateNewznabReference(target: string, manifestKey: string): string {
  if (!/^https?:\\/\\//i.test(target)) {
    throw new Error('Newznab reference target must be HTTP(S)');
  }
  return jwt.sign(
    { purpose: 'newznab-nzb', target, manifestKey } satisfies NewznabReferencePayload,
    usersData.jwtSecret,
    { algorithm: 'HS256', expiresIn: NEWZNAB_REFERENCE_TTL },
  );
}

export function verifyNewznabReference(reference: string, manifestKey: string): string | null {
  if (!reference || !manifestKey) return null;
  try {
    const payload = jwt.verify(reference, usersData.jwtSecret, { algorithms: ['HS256'] }) as Partial<NewznabReferencePayload>;
    if (payload.purpose !== 'newznab-nzb') return null;
    if (payload.manifestKey !== manifestKey) return null;
    if (typeof payload.target !== 'string' || !/^https?:\\/\\//i.test(payload.target)) return null;
    return payload.target;
  } catch {
    return null;
  }
}

'''
s = s.replace(marker, block + marker, 1)
auth.write_text(s)

nz = Path('src/routes/newznab.ts')
s = nz.read_text()

old = "import { trackGrab } from '../statsTracker.js';\n"
new = old + "import { generateNewznabReference, verifyNewznabReference } from '../auth/auth.js';\n"
assert old in s, 'newznab import marker not found'
s = s.replace(old, new, 1)

s = s.replace(
    ' *   t=get&d=<base64url NZB URL>   — proxy the original NZB\n',
    ' *   t=get&d=<signed NZB reference>  — proxy the original NZB\n',
    1,
)

old = "function itemsXml(items: NewznabItem[], baseUrl: string, offset = 0, total = items.length): string {"
new = "function itemsXml(items: NewznabItem[], baseUrl: string, manifestKey: string, offset = 0, total = items.length): string {"
assert old in s, 'itemsXml signature not found'
s = s.replace(old, new, 1)

old = "    const dl = `${baseUrl}/api?t=get&amp;d=${encodeURIComponent(Buffer.from(it.nzbUrl, 'utf8').toString('base64url'))}`;"
new = "    const reference = generateNewznabReference(it.nzbUrl, manifestKey);\n    const dl = `${baseUrl}/api?t=get&amp;d=${encodeURIComponent(reference)}`;"
assert old in s, 'legacy download-link encoder not found'
s = s.replace(old, new, 1)

old = "    const t = String(req.query.t ?? '').toLowerCase();\n    const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;"
new = "    const t = String(req.query.t ?? '').toLowerCase();\n    const baseUrl = `${req.protocol}://${req.get('host')}${req.baseUrl}`;\n    const manifestKey = String(req.params.manifestKey ?? '');"
assert old in s, 'route header marker not found'
s = s.replace(old, new, 1)

old = "        const encoded = String(req.query.d ?? '');\n        let target = '';\n        try { target = Buffer.from(encoded, 'base64url').toString('utf8'); } catch { /* noop */ }\n        if (!/^https?:\\/\\//i.test(target)) return errorXml(res, 300, 'Bad or missing NZB reference');"
new = "        const reference = String(req.query.d ?? '');\n        const target = verifyNewznabReference(reference, manifestKey);\n        if (!target) return errorXml(res, 300, 'Bad, expired, or unsigned NZB reference');"
assert old in s, 'legacy t=get decoder not found'
s = s.replace(old, new, 1)

replacements = {
    'itemsXml(page, baseUrl, offset, items.length)': 'itemsXml(page, baseUrl, manifestKey, offset, items.length)',
    'itemsXml([], baseUrl)': 'itemsXml([], baseUrl, manifestKey)',
    'itemsXml(items, baseUrl)': 'itemsXml(items, baseUrl, manifestKey)',
}
for old, new in replacements.items():
    s = s.replace(old, new)

leftovers = [
    m.group(0)
    for m in re.finditer(r'itemsXml\([^\n;]+\)', s)
    if 'function itemsXml' not in s[max(0, m.start() - 20):m.start() + 20]
    and 'manifestKey' not in m.group(0)
]
assert not leftovers, f'itemsXml calls missing manifestKey: {leftovers}'

nz.write_text(s)

Path('test/newznabReference.test.ts').write_text('''import test from 'node:test';
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
    /must be HTTP\\(S\\)/,
  );
});
''')
