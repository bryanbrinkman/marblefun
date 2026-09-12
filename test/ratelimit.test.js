'use strict';

// Abuse limits: per-IP REST rate limiter, WebSocket per-IP concurrency cap,
// inbound frame size cap, and that client chatter is ignored (then cut).

const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { RateLimiter } = require('../src/ratelimit');
const { WSServer, encodeFrame, MAX_FRAME_BYTES } = require('../src/ws');

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (e) {
    console.error('  ❌ ' + name + '\n     ' + e.message);
    process.exitCode = 1;
  }
};

console.log('rate-limit + websocket abuse tests\n');

// Open a raw WebSocket upgrade to `port`; resolves with the socket and the
// first bytes the server answered with.
function rawUpgrade(port, extraHeaders = '') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' + extraHeaders + '\r\n'
      );
    });
    sock.once('data', (d) => resolve({ sock, head: d.toString('utf8').split('\r\n')[0] }));
    sock.once('error', reject);
    setTimeout(() => reject(new Error('no upgrade response')), 3000).unref();
  });
}
// A masked client text frame (clients must mask).
function clientFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2);
  }
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

(async () => {
  await test('RateLimiter: 30/min per IP, 429 semantics with Retry-After, per-IP isolation, window reset', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
    const t0 = 1_000_000;
    assert.strictEqual(rl.hit('a', t0).ok, true);
    assert.strictEqual(rl.hit('a', t0 + 10).ok, true);
    assert.strictEqual(rl.hit('a', t0 + 20).remaining, 0);
    const over = rl.hit('a', t0 + 30);
    assert.strictEqual(over.ok, false);
    assert.ok(over.retryAfterSec >= 1);
    assert.strictEqual(rl.hit('b', t0 + 30).ok, true); // another IP is unaffected
    assert.strictEqual(rl.hit('a', t0 + 1000).ok, true); // window rolled over
    rl.close();
  });

  const server = http.createServer((req, res) => res.end('x'));
  const wss = new WSServer(server, '/ws', { maxPerIp: 2, clientIp: (req) => req.headers['x-forwarded-for'] || 'local' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await test('WebSocket: a 3rd concurrent socket from one IP is refused with 429, other IPs unaffected', async () => {
    const a = await rawUpgrade(port, 'X-Forwarded-For: 10.0.0.1\r\n');
    const b = await rawUpgrade(port, 'X-Forwarded-For: 10.0.0.1\r\n');
    assert.ok(a.head.includes('101') && b.head.includes('101'), 'first two upgrade');
    const c = await rawUpgrade(port, 'X-Forwarded-For: 10.0.0.1\r\n');
    assert.ok(c.head.includes('429'), 'third refused: ' + c.head);
    const d = await rawUpgrade(port, 'X-Forwarded-For: 10.0.0.2\r\n');
    assert.ok(d.head.includes('101'), 'other IP fine');
    assert.strictEqual(wss.size, 3);
    // Closing one frees the slot.
    a.sock.destroy();
    await new Promise((r) => setTimeout(r, 250));
    const e = await rawUpgrade(port, 'X-Forwarded-For: 10.0.0.1\r\n');
    assert.ok(e.head.includes('101'), 'slot freed after close');
    for (const s of [b, d, e]) s.sock.destroy();
    await new Promise((r) => setTimeout(r, 50));
  });

  await test('WebSocket: inbound frames are capped at 4 KiB (1009) and client chatter is ignored', async () => {
    const seen = [];
    wss.once('connection', (conn) => conn.on('message', (m) => seen.push(m)));
    const { sock } = await rawUpgrade(port, 'X-Forwarded-For: 10.0.0.3\r\n');
    sock.write(clientFrame('hello'));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(seen, ['hello']); // surfaced for logging only; nothing happens
    assert.strictEqual(MAX_FRAME_BYTES, 4096);
    const closed = new Promise((r) => sock.once('close', r));
    sock.write(clientFrame('x'.repeat(5000))); // over the cap → close frame 1009, socket ends
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('oversize frame did not close the socket')), 2000))]);
  });

  await test('WebSocket: server frames still encode correctly after the cap change', () => {
    assert.strictEqual(encodeFrame('x'.repeat(70000))[1], 127); // outbound is unaffected by the inbound cap
  });

  wss.close();
  server.close();
  console.log(`\n${passed} checks passed`);
})();
