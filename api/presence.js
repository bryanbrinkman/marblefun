'use strict';

// =========================================================
// Live viewer presence — Vercel serverless function
// =========================================================
// Counts how many people are currently watching, backed by Vercel KV
// (Upstash Redis) over its REST API. No npm dependency — just fetch().
//
// Each viewer POSTs a heartbeat with a stable id every few seconds. We keep a
// sorted set scored by timestamp, drop entries older than WINDOW_MS, add/refresh
// the caller, and return the live count.
//
// If no KV store is configured (env vars absent) or the store errors, we reply
// { enabled: false } so the client just hides the badge — nothing breaks.
//
// Setup (one time): Vercel dashboard → Storage → create a KV database and
// connect it to this project. That injects KV_REST_API_URL + KV_REST_API_TOKEN.
// Redeploy and the badge lights up.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'presence:live';
const WINDOW_MS = 25000; // a viewer counts for ~25s after their last heartbeat

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!KV_URL || !KV_TOKEN) {
    res.status(200).json({ enabled: false, count: 0 });
    return;
  }

  // Resolve a stable client id (sent by the viewer); fall back to a random one.
  let id = '';
  try {
    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
      id = String(body.id || '');
    }
  } catch {
    /* ignore malformed body */
  }
  if (!id && req.query) id = String(req.query.id || '');
  id = id.slice(0, 64) || 'anon-' + Math.random().toString(36).slice(2);

  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const pipeline = [
    ['ZREMRANGEBYSCORE', KEY, '-inf', cutoff], // evict stale viewers
    ['ZADD', KEY, now, id], // add / refresh this viewer
    ['EXPIRE', KEY, 120], // self-clean if traffic stops
    ['ZCARD', KEY], // current live count
  ];

  try {
    const r = await fetch(KV_URL.replace(/\/$/, '') + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline),
    });
    const data = await r.json();
    const last = Array.isArray(data) ? data[data.length - 1] : null;
    const count = last && typeof last.result === 'number' ? last.result : 0;
    res.status(200).json({ enabled: true, count });
  } catch (e) {
    res.status(200).json({ enabled: false, count: 0, error: 'kv' });
  }
};
