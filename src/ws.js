'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

// =========================================================
// Minimal WebSocket server (RFC 6455) — no external deps
// =========================================================
// Just enough to broadcast JSON messages to browser clients and receive the
// occasional text message back. Attaches to an existing http.Server's
// 'upgrade' event. Handles the handshake, text/close/ping frames, and
// server->client framing for any payload size.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Hard limits so a hostile or broken client can't exhaust server memory.
// Clients only ever send tiny control messages (or nothing), so these are
// generous. A single frame or the unparsed read buffer exceeding the cap, or a
// client whose outbound backlog balloons because it can't keep up, gets the
// connection closed rather than letting either buffer grow without bound.
const MAX_FRAME_BYTES = 4096; // 4 KiB: clients have nothing bigger to say (a seed is 64 bytes)
const MAX_READ_BUFFER = MAX_FRAME_BYTES * 2 + 64; // headroom over one max frame
const MAX_SEND_BACKLOG = 4 << 20; // 4 MiB of unflushed outbound = drop the client
const HEARTBEAT_MS = 30000; // ping cadence; a client silent for two rounds is dead
const MAX_INBOUND_MESSAGES = 120; // text frames per connection before we assume a misbehaving client
const DEFAULT_MAX_PER_IP = 5; // concurrent sockets per client address

function acceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}

// Encode a server->client frame. `opcode` 0x1 text (default), 0x8 close,
// 0xA pong. Server frames are never masked.
function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // High 32 bits assumed 0 (payloads well under 4 GiB).
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  return Buffer.concat([header, data]);
}

// Sentinel returned by _readFrame when a frame declares a length past the cap.
const OVERSIZE = Symbol('oversize-frame');

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this.isAlive = true; // flipped false each heartbeat, back true on pong
    this._buf = Buffer.alloc(0);
    this._inbound = 0; // text frames received — the protocol is server→client; chatter is ignored, floods are cut
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('end', () => this._onClose()); // peer finished — free its per-IP slot right away
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  // A client too slow to drain what we send backs up in the kernel + Node
  // write buffer; past a threshold that's unbounded memory, so cut it loose and
  // let it reconnect and resync. Returns true if the connection was dropped.
  _overBacklog() {
    if (this.socket.writableLength > MAX_SEND_BACKLOG) {
      this.terminate();
      return true;
    }
    return false;
  }

  send(str) {
    if (!this.open) return;
    if (this._overBacklog()) return;
    try {
      this.socket.write(encodeFrame(str, 0x1));
    } catch {
      this._onClose();
    }
  }

  ping() {
    if (!this.open) return;
    try {
      this.socket.write(encodeFrame(Buffer.alloc(0), 0x9));
    } catch {
      this._onClose();
    }
  }

  // Immediate, un-graceful teardown (no close handshake) — for dead or abusive
  // peers where a polite close frame would just add to a backlog we're dropping.
  terminate() {
    if (!this.open) return;
    this.open = false;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.emit('close');
  }

  close(code = 1000) {
    if (!this.open) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    try {
      this.socket.write(encodeFrame(body, 0x8));
      this.socket.end();
    } catch {
      /* ignore */
    }
    this._onClose();
  }

  _onClose() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    // A client that streams bytes without ever completing a parseable frame
    // would otherwise grow _buf forever. Once the unparsed buffer passes the
    // cap (which is larger than the biggest frame we accept), the peer is
    // either hostile or broken — drop it.
    if (this._buf.length > MAX_READ_BUFFER) {
      this.terminate();
      return;
    }
    // Parse as many complete frames as the buffer holds.
    for (;;) {
      const frame = this._readFrame();
      if (frame === OVERSIZE) {
        // Declared frame length exceeds our cap — 1009 "message too big".
        this.close(1009);
        return;
      }
      if (!frame) break;
      const { opcode, payload } = frame;
      if (opcode === 0x8) {
        // close
        this.close(1000);
        return;
      } else if (opcode === 0x9) {
        // ping -> pong
        try {
          this.socket.write(encodeFrame(payload, 0xa));
        } catch {
          /* ignore */
        }
      } else if (opcode === 0xa) {
        // pong -> peer is alive
        this.isAlive = true;
      } else if (opcode === 0x1 || opcode === 0x0) {
        // The wire protocol is one-way (server → client); nothing a client
        // sends is acted on. Surface it for logging only, and drop a client
        // that keeps talking — it's not a viewer.
        if (++this._inbound > MAX_INBOUND_MESSAGES) {
          this.close(1008); // policy violation
          return;
        }
        this.emit('message', payload.toString('utf8'));
      }
      // 0x2 binary ignored
    }
  }

  // Try to read one full frame off the front of the buffer. Returns null if a
  // complete frame isn't available yet, or the OVERSIZE sentinel if the frame
  // declares a length past our cap. Client frames are always masked.
  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      // A frame claiming the high 32 bits are set is > 4 GiB — reject before we
      // ever try to allocate for it.
      if (buf.readUInt32BE(offset) !== 0) return OVERSIZE;
      len = buf.readUInt32BE(offset + 4);
      offset += 8;
    }
    // Reject an oversize frame at declaration time — before allocating for it.
    if (len > MAX_FRAME_BYTES) return OVERSIZE;
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return null;
    let payload;
    if (masked) {
      const mask = buf.slice(offset, offset + 4);
      offset += 4;
      payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    } else {
      payload = buf.slice(offset, offset + len);
    }
    this._buf = buf.slice(offset + len);
    return { opcode, payload };
  }
}

class WSServer extends EventEmitter {
  // httpServer: a node http.Server. path: only upgrade requests to this path
  // are accepted as websockets.
  constructor(httpServer, path = '/ws', { maxPerIp = DEFAULT_MAX_PER_IP, clientIp = null } = {}) {
    super();
    this.path = path;
    this.maxPerIp = maxPerIp;
    this._clientIp = clientIp || ((req) => (req.socket && req.socket.remoteAddress) || 'unknown');
    this.perIp = new Map(); // ip -> open connection count
    this.connections = new Set();
    httpServer.on('upgrade', (req, socket) => this._onUpgrade(req, socket));
    // Heartbeat: each round, reap any connection that didn't pong since the
    // last round (a dead/half-open socket that TCP hasn't noticed), then ping
    // the rest. Without this, silently-dropped clients linger in the set
    // forever and every broadcast keeps trying to write to them. unref() so it
    // never holds the process open on its own.
    this._heartbeat = setInterval(() => {
      for (const c of this.connections) {
        if (!c.isAlive) {
          c.terminate();
          continue;
        }
        c.isAlive = false;
        c.ping();
      }
    }, HEARTBEAT_MS);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  close() {
    clearInterval(this._heartbeat);
    for (const c of this.connections) c.terminate();
    this.connections.clear();
  }

  _onUpgrade(req, socket) {
    const url = req.url.split('?')[0];
    if (url !== this.path || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    // Per-IP concurrency cap: a handful of tabs is fine, a socket flood is not.
    const ip = this._clientIp(req);
    const open = this.perIp.get(ip) || 0;
    if (this.maxPerIp > 0 && open >= this.maxPerIp) {
      try {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\ntoo many websocket connections from this address\n');
      } catch {}
      socket.destroy();
      return;
    }
    this.perIp.set(ip, open + 1);
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + acceptKey(key),
      '\r\n',
    ];
    socket.write(headers.join('\r\n'));
    socket.setNoDelay(true);

    const conn = new WSConnection(socket);
    conn.ip = ip;
    this.connections.add(conn);
    conn.on('close', () => {
      this.connections.delete(conn);
      const n = (this.perIp.get(ip) || 1) - 1;
      if (n <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, n);
    });
    this.emit('connection', conn);
  }

  broadcast(obj) {
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
    const frame = encodeFrame(str, 0x1); // encode once, reuse across clients
    for (const c of this.connections) {
      if (!c.open) continue;
      // Drop any client that has fallen too far behind rather than piling more
      // onto an unbounded backlog.
      if (c._overBacklog()) continue;
      try {
        c.socket.write(frame);
      } catch {
        /* dropped on next tick */
      }
    }
  }

  get size() {
    return this.connections.size;
  }
}

module.exports = { WSServer, encodeFrame, acceptKey, MAX_FRAME_BYTES, DEFAULT_MAX_PER_IP };
