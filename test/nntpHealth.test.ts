import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { checkArticlesDetailed } from '../src/health/articleChecker.js';

const IDS = [
  'one@example.invalid',
  'two@example.invalid',
  'three@example.invalid',
];

type ServerHandler = (socket: net.Socket) => void;

async function withNntpServer<T>(handler: ServerHandler, run: (socket: net.Socket) => Promise<T>): Promise<T> {
  const server = net.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  assert(address && typeof address === 'object');

  const socket = net.connect({ host: '127.0.0.1', port: address.port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  try {
    return await run(socket);
  } finally {
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function replyPerStat(codes: number[]): ServerHandler {
  return (socket) => {
    let buffer = '';
    let index = 0;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('STAT ')) continue;
        const code = codes[index++] ?? codes[codes.length - 1];
        socket.write(`${code} test response\r\n`);
      }
    });
  };
}

test('223 responses are classified as existing', async () => {
  await withNntpServer(replyPerStat([223, 223, 223]), async (socket) => {
    const result = await checkArticlesDetailed(socket, IDS, 500);
    assert.deepEqual(result.existing, IDS);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unknown, []);
  });
});

test('430 responses are the only explicit missing evidence', async () => {
  await withNntpServer(replyPerStat([430, 430, 430]), async (socket) => {
    const result = await checkArticlesDetailed(socket, IDS, 500);
    assert.deepEqual(result.existing, []);
    assert.deepEqual(result.missing, IDS);
    assert.deepEqual(result.unknown, []);
  });
});

test('480 authentication-required responses remain unverified', async () => {
  await withNntpServer(replyPerStat([480, 480, 480]), async (socket) => {
    const result = await checkArticlesDetailed(socket, IDS, 500);
    assert.deepEqual(result.existing, []);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unknown, IDS);
  });
});

test('451 transient responses remain unverified', async () => {
  await withNntpServer(replyPerStat([451, 451, 451]), async (socket) => {
    const result = await checkArticlesDetailed(socket, IDS, 500);
    assert.deepEqual(result.existing, []);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unknown, IDS);
  });
});

test('mid-check disconnect preserves answered results and marks the rest unverified', async () => {
  await withNntpServer((socket) => {
    let buffer = '';
    let seen = 0;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('STAT ')) continue;
        seen++;
        if (seen === 1) {
          socket.write('223 first exists\r\n', () => socket.end());
          break;
        }
      }
    });
  }, async (socket) => {
    const result = await checkArticlesDetailed(socket, IDS, 500);
    assert.deepEqual(result.existing, [IDS[0]]);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unknown, [IDS[1], IDS[2]]);
  });
});

test('article-check timeout rejects without inventing missing articles', async () => {
  await withNntpServer(() => {
    // Intentionally accept the connection and never answer STAT.
  }, async (socket) => {
    await assert.rejects(
      checkArticlesDetailed(socket, IDS, 50),
      /Article check timeout after 50ms/,
    );
  });
});
