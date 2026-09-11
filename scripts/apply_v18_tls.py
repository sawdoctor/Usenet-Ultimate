from pathlib import Path

# Backend provider type
p = Path('src/types.ts')
s = p.read_text()
old = "  useTLS: boolean;               // Use SSL/TLS for secure connection\n  username: string;"
new = "  useTLS: boolean;               // Use SSL/TLS for secure connection\n  allowSelfSigned?: boolean;     // Advanced override: disable certificate verification for this provider\n  username: string;"
assert old in s, 'backend UsenetProvider marker not found'
p.write_text(s.replace(old, new, 1))

# UI provider type
p = Path('ui/src/types/index.ts')
s = p.read_text()
old = "  useTLS: boolean;\n  username: string;"
new = "  useTLS: boolean;\n  allowSelfSigned?: boolean;\n  username: string;"
assert old in s, 'UI UsenetProvider marker not found'
p.write_text(s.replace(old, new, 1))

# Real health-check NNTP connection
p = Path('src/health/nntpConnection.ts')
s = p.read_text()
old = "export async function connectToUsenet(provider: { host: string; port: number; useTLS: boolean; username: string; password: string }): Promise<net.Socket | tls.TLSSocket> {"
new = "export async function connectToUsenet(provider: { host: string; port: number; useTLS: boolean; allowSelfSigned?: boolean; username: string; password: string }): Promise<net.Socket | tls.TLSSocket> {"
assert old in s, 'connectToUsenet signature marker not found'
s = s.replace(old, new, 1)
old = "      ? tls.connect({ host: provider.host, port: provider.port, rejectUnauthorized: false })"
new = "      ? tls.connect({\n          host: provider.host,\n          port: provider.port,\n          rejectUnauthorized: provider.allowSelfSigned !== true,\n          servername: net.isIP(provider.host) ? undefined : provider.host,\n        })"
assert old in s, 'TLS connect marker not found'
s = s.replace(old, new, 1)
old = "  async acquire(provider: { host: string; port: number; useTLS: boolean; username: string; password: string }): Promise<net.Socket | tls.TLSSocket> {"
new = "  async acquire(provider: { host: string; port: number; useTLS: boolean; allowSelfSigned?: boolean; username: string; password: string }): Promise<net.Socket | tls.TLSSocket> {"
assert old in s, 'pool acquire signature marker not found'
s = s.replace(old, new, 1)
p.write_text(s)

# Provider test route + persistence on create
p = Path('src/routes/healthCheck.ts')
s = p.read_text()
old = "      const { host, port, useTLS, username, password } = req.body;"
new = "      const { host, port, useTLS, allowSelfSigned, username, password } = req.body;"
assert old in s, 'test route body marker not found'
s = s.replace(old, new, 1)
old = "          ? tlsModule.connect({ host, port, rejectUnauthorized: false })"
new = "          ? tlsModule.connect({\n              host,\n              port,\n              rejectUnauthorized: allowSelfSigned !== true,\n              servername: netModule.isIP(host) ? undefined : host,\n            })"
assert old in s, 'test route TLS marker not found'
s = s.replace(old, new, 1)
old = "      const { name, host, port, useTLS, username, password, enabled, type } = req.body;"
new = "      const { name, host, port, useTLS, allowSelfSigned, username, password, enabled, type } = req.body;"
assert old in s, 'provider create body marker not found'
s = s.replace(old, new, 1)
old = "        useTLS: useTLS ?? true,\n        username: username || '',"
new = "        useTLS: useTLS ?? true,\n        allowSelfSigned: allowSelfSigned === true,\n        username: username || '',"
assert old in s, 'provider create object marker not found'
s = s.replace(old, new, 1)
p.write_text(s)

# UI ProviderManager: default secure, pass flag to connection test, and expose advanced override.
p = Path('ui/src/components/shared/ProviderManager.tsx')
s = p.read_text()
s = s.replace(
"    name: '', host: '', port: 563, useTLS: true, username: '', password: '',\n    enabled: true, type: 'pool'",
"    name: '', host: '', port: 563, useTLS: true, allowSelfSigned: false, username: '', password: '',\n    enabled: true, type: 'pool'",
1)
s = s.replace(
"  const testProviderConnection = async (provider: { host: string; port: number; useTLS: boolean; username: string; password: string }, id: string) => {",
"  const testProviderConnection = async (provider: { host: string; port: number; useTLS: boolean; allowSelfSigned?: boolean; username: string; password: string }, id: string) => {",
1)
s = s.replace(
"          useTLS: provider.useTLS,\n          username: provider.username,",
"          useTLS: provider.useTLS,\n          allowSelfSigned: provider.allowSelfSigned === true,\n          username: provider.username,",
1)
s = s.replace(
"        setNewProvider({ name: '', host: '', port: 563, useTLS: true, username: '', password: '', enabled: true, type: 'pool' });",
"        setNewProvider({ name: '', host: '', port: 563, useTLS: true, allowSelfSigned: false, username: '', password: '', enabled: true, type: 'pool' });",
1)

# Edit form advanced toggle immediately after SSL/TLS checkbox.
old = '''                    <label className="flex items-center gap-2 cursor-pointer">\n                      <input type="checkbox" checked={providerEditForm.useTLS} onChange={(e) => setProviderEditForm({ ...providerEditForm, useTLS: e.target.checked })} className={`w-4 h-4 rounded border-slate-600 bg-slate-700 ${colors.checkbox} focus:ring-offset-slate-800`} />\n                      <span className="text-sm text-slate-300">SSL/TLS</span>\n                    </label>'''
new = old + '''\n                    {providerEditForm.useTLS && (\n                      <label className="flex items-center gap-2 cursor-pointer" title="Advanced: only enable for a provider that intentionally uses a self-signed certificate">\n                        <input type="checkbox" checked={providerEditForm.allowSelfSigned === true} onChange={(e) => setProviderEditForm({ ...providerEditForm, allowSelfSigned: e.target.checked })} className={`w-4 h-4 rounded border-slate-600 bg-slate-700 ${colors.checkbox} focus:ring-offset-slate-800`} />\n                        <span className="text-sm text-amber-300">Allow self-signed certificate (advanced)</span>\n                      </label>\n                    )}'''
assert old in s, 'edit TLS checkbox marker not found'
s = s.replace(old, new, 1)

# Add-provider form has a second SSL/TLS checkbox; replace the next remaining exact block.
old_add = '''                  <label className="flex items-center gap-2 cursor-pointer">\n                    <input type="checkbox" checked={newProvider.useTLS} onChange={(e) => setNewProvider({ ...newProvider, useTLS: e.target.checked })} className={`w-4 h-4 rounded border-slate-600 bg-slate-700 ${colors.checkbox} focus:ring-offset-slate-800`} />\n                    <span className="text-sm text-slate-300">SSL/TLS</span>\n                  </label>'''
new_add = old_add + '''\n                  {newProvider.useTLS && (\n                    <label className="flex items-center gap-2 cursor-pointer" title="Advanced: only enable for a provider that intentionally uses a self-signed certificate">\n                      <input type="checkbox" checked={newProvider.allowSelfSigned === true} onChange={(e) => setNewProvider({ ...newProvider, allowSelfSigned: e.target.checked })} className={`w-4 h-4 rounded border-slate-600 bg-slate-700 ${colors.checkbox} focus:ring-offset-slate-800`} />\n                      <span className="text-sm text-amber-300">Allow self-signed certificate (advanced)</span>\n                    </label>\n                  )}'''
assert old_add in s, 'add TLS checkbox marker not found'
s = s.replace(old_add, new_add, 1)
p.write_text(s)

# Deterministic TLS regression tests using a local self-signed NNTP server.
p = Path('test/nntpTls.test.ts')
p.write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectToUsenet } from '../src/health/nntpConnection.js';

function makeCertificate(): { key: Buffer; cert: Buffer; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'uu-nntp-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost',
  ], { stdio: 'ignore' });
  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function withTlsNntpServer<T>(run: (port: number) => Promise<T>): Promise<T> {
  const material = makeCertificate();
  const peers = new Set<tls.TLSSocket>();
  const server = tls.createServer({ key: material.key, cert: material.cert }, (socket) => {
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    socket.write('200 local test NNTP ready\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  assert(addr && typeof addr === 'object');
  try {
    return await run(addr.port);
  } finally {
    for (const socket of peers) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    material.cleanup();
  }
}

test('TLS health checks reject an untrusted self-signed certificate by default', async () => {
  await withTlsNntpServer(async (port) => {
    await assert.rejects(
      connectToUsenet({ host: 'localhost', port, useTLS: true, username: '', password: '' }),
      /self-signed certificate/i,
    );
  });
});

test('advanced self-signed override permits the same provider deliberately', async () => {
  await withTlsNntpServer(async (port) => {
    const socket = await connectToUsenet({
      host: 'localhost', port, useTLS: true, allowSelfSigned: true, username: '', password: '',
    });
    assert.equal(socket.destroyed, false);
    socket.destroy();
  });
});
''')
