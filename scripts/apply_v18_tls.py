from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    s = p.read_text()
    assert old in s, f'{label} marker not found'
    p.write_text(s.replace(old, new, 1))

# Backend + UI provider types: self-signed is an explicit opt-in only.
replace_once(
    'src/types.ts',
    "  useTLS: boolean;               // Use SSL/TLS for secure connection\n  username: string;",
    "  useTLS: boolean;               // Use SSL/TLS for secure connection\n  allowSelfSigned?: boolean;     // Advanced override: disable certificate verification for this provider\n  username: string;",
    'backend UsenetProvider',
)
replace_once(
    'ui/src/types/index.ts',
    "  useTLS: boolean;\n  username: string;",
    "  useTLS: boolean;\n  allowSelfSigned?: boolean;\n  username: string;",
    'UI UsenetProvider',
)

# Real health-check connection: verify certificates by default and send SNI for DNS hosts.
replace_once(
    'src/health/nntpConnection.ts',
    "export async function connectToUsenet(provider: { host: string; port: number; useTLS: boolean; username: string; password: string }): Promise<net.Socket | tls.TLSSocket> {",
    "export async function connectToUsenet(provider: { host: string; port: number; useTLS: boolean; allowSelfSigned?: boolean; username: string; password: string }): Promise<net.Socket | tls.TLSSocket> {",
    'connectToUsenet signature',
)
replace_once(
    'src/health/nntpConnection.ts',
    "      ? tls.connect({ host: provider.host, port: provider.port, rejectUnauthorized: false })",
    "      ? tls.connect({\n          host: provider.host,\n          port: provider.port,\n          rejectUnauthorized: provider.allowSelfSigned !== true,\n          servername: net.isIP(provider.host) ? undefined : provider.host,\n        })",
    'health-check TLS connect',
)
replace_once(
    'src/health/nntpConnection.ts',
    "  async acquire(provider: { host: string; port: number; useTLS: boolean; username: string; password: string }): Promise<net.Socket | tls.TLSSocket> {",
    "  async acquire(provider: { host: string; port: number; useTLS: boolean; allowSelfSigned?: boolean; username: string; password: string }): Promise<net.Socket | tls.TLSSocket> {",
    'pool acquire signature',
)

# UI Test Connection route must enforce the same policy as real health checks.
replace_once(
    'src/routes/healthCheck.ts',
    "      const { host, port, useTLS, username, password } = req.body;",
    "      const { host, port, useTLS, allowSelfSigned, username, password } = req.body;",
    'test route body',
)
replace_once(
    'src/routes/healthCheck.ts',
    "          ? tlsModule.connect({ host, port, rejectUnauthorized: false })",
    "          ? tlsModule.connect({\n              host,\n              port,\n              rejectUnauthorized: allowSelfSigned !== true,\n              servername: netModule.isIP(host) ? undefined : host,\n            })",
    'test route TLS connect',
)
replace_once(
    'src/routes/healthCheck.ts',
    "      const { name, host, port, useTLS, username, password, enabled, type } = req.body;",
    "      const { name, host, port, useTLS, allowSelfSigned, username, password, enabled, type } = req.body;",
    'provider create body',
)
replace_once(
    'src/routes/healthCheck.ts',
    "        useTLS: useTLS ?? true,\n        username: username || '',",
    "        useTLS: useTLS ?? true,\n        allowSelfSigned: allowSelfSigned === true,\n        username: username || '',",
    'provider create object',
)

# Shared provider UI: secure default, pass override to Test Connection, expose it as advanced.
p = Path('ui/src/components/shared/ProviderManager.tsx')
s = p.read_text()
old = "    name: '', host: '', port: 563, useTLS: true, username: '', password: '',\n    enabled: true, type: 'pool'"
assert old in s, 'new provider default marker not found'
s = s.replace(old, "    name: '', host: '', port: 563, useTLS: true, allowSelfSigned: false, username: '', password: '',\n    enabled: true, type: 'pool'", 1)
old = "  const testProviderConnection = async (provider: { host: string; port: number; useTLS: boolean; username: string; password: string }, id: string) => {"
assert old in s, 'testProviderConnection signature marker not found'
s = s.replace(old, "  const testProviderConnection = async (provider: { host: string; port: number; useTLS: boolean; allowSelfSigned?: boolean; username: string; password: string }, id: string) => {", 1)
old = "          useTLS: provider.useTLS,\n          username: provider.username,"
assert old in s, 'test request marker not found'
s = s.replace(old, "          useTLS: provider.useTLS,\n          allowSelfSigned: provider.allowSelfSigned === true,\n          username: provider.username,", 1)
old = "        setNewProvider({ name: '', host: '', port: 563, useTLS: true, username: '', password: '', enabled: true, type: 'pool' });"
assert old in s, 'new provider reset marker not found'
s = s.replace(old, "        setNewProvider({ name: '', host: '', port: 563, useTLS: true, allowSelfSigned: false, username: '', password: '', enabled: true, type: 'pool' });", 1)

edit_label = '''                    <label className="flex items-center gap-2 cursor-pointer">\n                      <input type="checkbox" checked={providerEditForm.useTLS} onChange={(e) => setProviderEditForm({ ...providerEditForm, useTLS: e.target.checked })} className={`w-4 h-4 rounded border-slate-600 bg-slate-700 ${colors.checkbox} focus:ring-offset-slate-800`} />\n                      <span className="text-sm text-slate-300">SSL/TLS</span>\n                    </label>'''
assert edit_label in s, 'edit TLS checkbox marker not found'
s = s.replace(edit_label, edit_label + '''\n                    {providerEditForm.useTLS && (\n                      <label className="flex items-center gap-2 cursor-pointer" title="Advanced: only enable for a provider that intentionally uses a self-signed certificate">\n                        <input type="checkbox" checked={providerEditForm.allowSelfSigned === true} onChange={(e) => setProviderEditForm({ ...providerEditForm, allowSelfSigned: e.target.checked })} className={`w-4 h-4 rounded border-slate-600 bg-slate-700 ${colors.checkbox} focus:ring-offset-slate-800`} />\n                        <span className="text-sm text-amber-300">Allow self-signed certificate (advanced)</span>\n                      </label>\n                    )}''', 1)

add_label = '''              <label className="flex items-center gap-2 cursor-pointer">\n                <input type="checkbox" checked={newProvider.useTLS} onChange={(e) => setNewProvider({ ...newProvider, useTLS: e.target.checked })} className={`w-4 h-4 rounded border-slate-600 bg-slate-700 ${colors.checkbox} focus:ring-offset-slate-800`} />\n                <span className="text-sm text-slate-300">SSL/TLS</span>\n              </label>'''
assert add_label in s, 'add TLS checkbox marker not found'
s = s.replace(add_label, add_label + '''\n              {newProvider.useTLS && (\n                <label className="flex items-center gap-2 cursor-pointer" title="Advanced: only enable for a provider that intentionally uses a self-signed certificate">\n                  <input type="checkbox" checked={newProvider.allowSelfSigned === true} onChange={(e) => setNewProvider({ ...newProvider, allowSelfSigned: e.target.checked })} className={`w-4 h-4 rounded border-slate-600 bg-slate-700 ${colors.checkbox} focus:ring-offset-slate-800`} />\n                  <span className="text-sm text-amber-300">Allow self-signed certificate (advanced)</span>\n                </label>\n              )}''', 1)
p.write_text(s)

# Regression tests: a self-signed NNTP endpoint must fail securely by default,
# while the explicit advanced override must allow the exact same endpoint.
Path('test/nntpTls.test.ts').write_text(r'''import test from 'node:test';
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
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
  ], { stdio: 'ignore' });
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
  try { return await run(addr.port); }
  finally {
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
    const socket = await connectToUsenet({ host: 'localhost', port, useTLS: true, allowSelfSigned: true, username: '', password: '' });
    assert.equal(socket.destroyed, false);
    socket.destroy();
  });
});
''')
