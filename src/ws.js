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

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this._buf = Buffer.alloc(0);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  send(str) {
    if (!this.open) return;
    try {
      this.socket.write(encodeFrame(str, 0x1));
    } catch {
      this._onClose();
    }
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
    // Parse as many complete frames as the buffer holds.
    for (;;) {
      const frame = this._readFrame();
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
      } else if (opcode === 0x1 || opcode === 0x0) {
        this.emit('message', payload.toString('utf8'));
      }
      // 0xA pong / 0x2 binary ignored
    }
  }

  // Try to read one full frame off the front of the buffer. Returns null if a
  // complete frame isn't available yet. Client frames are always masked.
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
      // Ignore high 32 bits.
      len = buf.readUInt32BE(offset + 4);
      offset += 8;
    }
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
  constructor(httpServer, path = '/ws') {
    super();
    this.path = path;
    this.connections = new Set();
    httpServer.on('upgrade', (req, socket) => this._onUpgrade(req, socket));
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
    this.connections.add(conn);
    conn.on('close', () => this.connections.delete(conn));
    this.emit('connection', conn);
  }

  broadcast(obj) {
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
    const frame = encodeFrame(str, 0x1);
    for (const c of this.connections) {
      if (c.open) {
        try {
          c.socket.write(frame);
        } catch {
          /* dropped on next tick */
        }
      }
    }
  }

  get size() {
    return this.connections.size;
  }
}

module.exports = { WSServer, encodeFrame, acceptKey };
