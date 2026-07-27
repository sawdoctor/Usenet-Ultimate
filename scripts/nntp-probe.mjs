#!/usr/bin/env node
/**
 * NNTP probe — isolates why a provider answers 480 during article checks.
 *
 * Standalone: no UU imports, no dependencies, touches nothing in the app.
 *
 *   NNTP_HOST=news.example.com NNTP_PORT=563 NNTP_TLS=1 \
 *   NNTP_USER=xxx NNTP_PASS=yyy node nntp-probe.mjs
 *
 * Optional:
 *   NNTP_IDLE=120     seconds to idle before test 3 (default 120)
 *   NNTP_CONNS=4      parallel connections for test 4 (default 4)
 *
 * Uses deliberately nonexistent message-ids, so a healthy server answers 430
 * to every STAT. We only care about the response CODES, never the articles.
 *
 * Reading the output:
 *   test 1 pipelined 430/430/430 + test 2 sequential 430/430/430
 *       -> pipelining is fine on this provider; look elsewhere
 *   test 1 480s but test 2 clean
 *       -> pipelining really is the trigger; serialise STAT for this provider
 *   test 1 returns 3 responses that don't line up / wrong count
 *       -> response desync (the RFC 3977 3.5 hazard), not auth at all
 *   tests 1+2 clean but test 3 (after idle) 480s
 *       -> server-side session expiry; the pool is handing out stale sockets
 *   tests 1-3 clean but test 4 480s on the later connections
 *       -> connection-limit rejection; lower maxConnections
 */
import net from 'node:net';
import tls from 'node:tls';

const HOST = process.env.NNTP_HOST;
const PORT = Number(process.env.NNTP_PORT || 563);
const USE_TLS = process.env.NNTP_TLS !== '0';
const USER = process.env.NNTP_USER;
const PASS = process.env.NNTP_PASS;
const IDLE = Number(process.env.NNTP_IDLE || 120);
const CONNS = Number(process.env.NNTP_CONNS || 4);

if (!HOST || !USER || !PASS) {
  console.error('Set NNTP_HOST, NNTP_USER, NNTP_PASS (and NNTP_PORT/NNTP_TLS as needed)');
  process.exit(2);
}

const IDS = [
  'probe-aaaaaaaaaaaa@invalid.probe',
  'probe-bbbbbbbbbbbb@invalid.probe',
  'probe-cccccccccccc@invalid.probe',
];

const now = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${now()}]`, ...a);

/** Read lines from a socket, resolving once `want` response lines have arrived. */
function readLines(socket, want, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let buf = '';
    const done = (err) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('close', onClose);
      err ? reject(err) : resolve(lines);
    };
    const timer = setTimeout(() => done(new Error(`timeout after ${timeoutMs}ms (got ${lines.length}/${want}: ${JSON.stringify(lines)})`)), timeoutMs);
    const onData = (d) => {
      buf += d.toString('utf8');
      const parts = buf.split('\r\n');
      buf = parts.pop() || '';
      for (const p of parts) {
        if (!p.trim()) continue;
        lines.push(p);
        if (lines.length >= want) return done();
      }
    };
    const onErr = (e) => done(e);
    const onClose = () => done(new Error(`socket closed after ${lines.length}/${want} line(s): ${JSON.stringify(lines)}`));
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
  });
}

async function connectAuth(tag) {
  const t0 = Date.now();
  const socket = await new Promise((resolve, reject) => {
    const s = USE_TLS
      ? tls.connect({ host: HOST, port: PORT, servername: HOST }, () => resolve(s))
      : net.connect({ host: HOST, port: PORT }, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(30000, () => reject(new Error('connect timeout')));
  });
  socket.setTimeout(0);
  const [greeting] = await readLines(socket, 1);
  log(`${tag} greeting: ${greeting}`);

  socket.write(`AUTHINFO USER ${USER}\r\n`);
  const [r1] = await readLines(socket, 1);
  log(`${tag} AUTHINFO USER -> ${r1}`);
  if (!r1.startsWith('381') && !r1.startsWith('281')) throw new Error(`unexpected: ${r1}`);

  if (r1.startsWith('381')) {
    socket.write(`AUTHINFO PASS ${PASS}\r\n`);
    const [r2] = await readLines(socket, 1);
    log(`${tag} AUTHINFO PASS -> ${r2}`);
    if (!r2.startsWith('281')) throw new Error(`auth failed: ${r2}`);
  }
  log(`${tag} authenticated in ${Date.now() - t0}ms`);
  return socket;
}

const codes = (lines) => lines.map(l => l.slice(0, 3)).join('/');

async function main() {
  console.log(`\n=== ${HOST}:${PORT} tls=${USE_TLS} ===\n`);

  // --- Test 1: pipelined STAT (exactly what articleChecker does today) ---
  log('TEST 1: pipelined STAT x3');
  let s = await connectAuth('  t1');
  try {
    s.write(IDS.map(id => `STAT <${id}>`).join('\r\n') + '\r\n');
    const lines = await readLines(s, 3);
    lines.forEach(l => log(`  t1 <- ${l}`));
    log(`  t1 RESULT: ${codes(lines)}  ${codes(lines) === '430/430/430' ? '(clean)' : '*** ANOMALY ***'}`);
  } catch (e) {
    log(`  t1 FAILED: ${e.message}`);
  }
  s.destroy();

  // --- Test 2: sequential STAT, one response read before the next command ---
  log('\nTEST 2: sequential STAT x3');
  s = await connectAuth('  t2');
  try {
    const got = [];
    for (const id of IDS) {
      s.write(`STAT <${id}>\r\n`);
      const [line] = await readLines(s, 1);
      log(`  t2 <- ${line}`);
      got.push(line);
    }
    log(`  t2 RESULT: ${codes(got)}  ${codes(got) === '430/430/430' ? '(clean)' : '*** ANOMALY ***'}`);
  } catch (e) {
    log(`  t2 FAILED: ${e.message}`);
  }
  s.destroy();

  // --- Test 3: idle, then STAT (does the server keep the session?) ---
  log(`\nTEST 3: authenticate, idle ${IDLE}s, then STAT (pool-reuse simulation)`);
  s = await connectAuth('  t3');
  try {
    await new Promise(r => setTimeout(r, IDLE * 1000));
    log(`  t3 idled ${IDLE}s; socket destroyed=${s.destroyed} readable=${s.readable} writable=${s.writable}`);
    s.write(`STAT <${IDS[0]}>\r\n`);
    const [line] = await readLines(s, 1);
    log(`  t3 <- ${line}`);
    log(`  t3 RESULT: ${line.slice(0, 3)}  ${line.startsWith('430') ? '(session survived)' : '*** SESSION LOST ***'}`);
  } catch (e) {
    log(`  t3 FAILED: ${e.message}  <- socket died silently while idle`);
  }
  s.destroy();

  // --- Test 4: N parallel authenticated connections (limit probe) ---
  log(`\nTEST 4: ${CONNS} parallel connections`);
  const sockets = [];
  const outcomes = await Promise.allSettled(
    Array.from({ length: CONNS }, async (_, i) => {
      const sock = await connectAuth(`  t4[${i}]`);
      sockets.push(sock);
      sock.write(`STAT <${IDS[0]}>\r\n`);
      const [line] = await readLines(sock, 1);
      return `conn ${i}: ${line}`;
    })
  );
  outcomes.forEach((o, i) => log(o.status === 'fulfilled' ? `  t4 ${o.value}` : `  t4 conn ${i} FAILED: ${o.reason?.message}`));
  const ok = outcomes.filter(o => o.status === 'fulfilled' && /430/.test(o.value)).length;
  log(`  t4 RESULT: ${ok}/${CONNS} usable  ${ok === CONNS ? '(no limit hit)' : '*** LIMIT OR REJECTION ***'}`);
  sockets.forEach(x => x.destroy());

  console.log('\ndone\n');
  process.exit(0);
}

main().catch(e => { console.error('probe error:', e); process.exit(1); });
