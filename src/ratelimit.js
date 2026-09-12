'use strict';

// =========================================================
// Per-IP rate limiting (fixed window, in memory)
// =========================================================
// Tiny, dependency-free: a Map of ip -> { count, windowStart }. Good enough
// for one small box; the point is to stop a runaway script or a hostile client
// from monopolising the API, not to be a billing meter. Entries are pruned
// every window so the map can't grow without bound.

class RateLimiter {
  constructor({ limit = 30, windowMs = 60000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
    this._prune = setInterval(() => this.prune(), windowMs);
    if (this._prune.unref) this._prune.unref();
  }

  // Register one request from `ip`. Returns { ok, remaining, retryAfterSec }.
  hit(ip, now = Date.now()) {
    let e = this.hits.get(ip);
    if (!e || now - e.windowStart >= this.windowMs) {
      e = { count: 0, windowStart: now };
      this.hits.set(ip, e);
    }
    e.count++;
    if (e.count > this.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((e.windowStart + this.windowMs - now) / 1000));
      return { ok: false, remaining: 0, retryAfterSec };
    }
    return { ok: true, remaining: this.limit - e.count, retryAfterSec: 0 };
  }

  prune(now = Date.now()) {
    for (const [ip, e] of this.hits) if (now - e.windowStart >= this.windowMs) this.hits.delete(ip);
  }

  close() {
    clearInterval(this._prune);
  }
}

// The peer's address as the proxy saw it (Fly sets fly-client-ip; a generic
// proxy sets x-forwarded-for), else the socket's.
function clientIp(req) {
  const h = (req && req.headers) || {};
  const fly = h['fly-client-ip'];
  if (fly) return String(fly).trim();
  const xff = h['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { RateLimiter, clientIp };
