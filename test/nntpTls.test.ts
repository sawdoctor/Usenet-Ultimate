import test from 'node:test';
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
