#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { DB } = require('./db');
const { WSServer } = require('./ws');
const { Tournament } = require('./tournament');
const { Scheduler } = require('./scheduler');
const { createSimulator } = require('./simulator');
const ssr = require('./ssr');
const { toMasterBuf, makeCommitment, randomMasterSeed } = require('./seeds');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
};

function envInt(name, def) {
  const v = process.env[name];
  return v == null || v === '' ? def : parseInt(v, 10);
}

function buildConfig() {
  const fast = process.env.FAST_DEMO === '1';
  const cfg = {
    port: envInt('PORT', 8080),
    host: process.env.HOST || '0.0.0.0',
    dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tournament.db'),
    // 64 hex chars (256-bit) or a legacy integer — see seeds.toMasterBuf.
    masterSeed: process.env.MASTER_SEED && process.env.MASTER_SEED !== '' ? process.env.MASTER_SEED : 424242,
    // Public randomness beacon folded into every race seed at race_start.
    beaconSource: process.env.PUBLIC_BEACON || 'drand', // drand | nist | none
    beaconUrl: process.env.PUBLIC_BEACON_URL || null,
    headless: process.env.HEADLESS !== '0',
    announceLeadMs: envInt('ANNOUNCE_LEAD_MS', fast ? 6000 : 30000),
    interRaceGapMs: envInt('INTER_RACE_GAP_MS', fast ? 2500 : 6000),
    intermissionMs: envInt('INTERMISSION_MS', 30000), // hold on the champion before the next tournament
    playbackRate: Number(process.env.PLAYBACK_RATE || 1),
    watchOverrideMs: process.env.RACE_WATCH_OVERRIDE_MS
      ? envInt('RACE_WATCH_OVERRIDE_MS', null)
      : fast
        ? 15000
        : null,
    adminToken: process.env.ADMIN_TOKEN || '', // '' = admin API unprotected
  };
  return cfg;
}

// A fresh 256-bit master seed for a new tournament (crypto.randomBytes). A
// 32-bit seed could be brute-forced against the published commit in seconds;
// 256 bits cannot.
function randomSeed() {
  return randomMasterSeed();
}
// Admin-supplied seed: 64 hex chars, or a decimal integer (legacy — expanded
// via sha256, low entropy; fine for reproducing a demo, not for production).
function parseSeedArg(raw) {
  if (raw == null || raw === '') return randomSeed();
  const v = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(v) || /^\d+$/.test(v)) return v;
  throw new Error('seed must be 64 hex chars or a decimal integer');
}

// Serialize an array of flat row objects to CSV (RFC-4180-ish quoting).
function toCSV(rows) {
  if (!rows || rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    // The read API is public so third parties can build on top of the
    // tournament (predictions, overlays, bots). Admin routes still require
    // the token; CORS just lets browsers make the call.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-admin-token',
  });
  res.end(JSON.stringify(obj));
}

// The peer's address as the proxy saw it (Fly sets fly-client-ip; a generic
// proxy sets x-forwarded-for), else the socket's.
function clientIp(req) {
  const h = req.headers || {};
  const fly = h['fly-client-ip'];
  if (fly) return String(fly).trim();
  const xff = h['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Small JSON request body (rejects anything over `limit` bytes).
function readJsonBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let urlPath;
  try {
    // decodeURIComponent throws URIError on a malformed %-sequence (e.g. "/%").
    // Left uncaught, the request never gets a response and the socket dangles
    // until the client times out — a trivial socket-exhaustion DoS.
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    return;
  }
  // A NUL byte makes fs.stat/readFile throw ("path must be … without null
  // bytes"). Reject outright — no legitimate asset path contains one.
  if (urlPath.indexOf('\0') !== -1) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  // Prevent path traversal.
  let filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  // Clean URLs: an extensionless path (e.g. /admin) maps to its .html file.
  if (path.extname(filePath) === '') filePath += '.html';
  fs.stat(filePath, (statErr, stat) => {
    if (statErr) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // Without explicit cache headers browsers cache heuristically — phones
    // especially would keep serving week-old HTML/JS, so a deploy's new viewer
    // could run against a stale cached game (or vice versa) and features would
    // silently misbehave. no-cache = always revalidate; Last-Modified makes
    // that revalidation a cheap 304 instead of a refetch. Heavy immutable-ish
    // assets (models, images, fonts) may cache for an hour.
    const code = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': code ? 'no-cache' : 'public, max-age=3600',
      'Last-Modified': stat.mtime.toUTCString(),
    };
    const ims = req.headers['if-modified-since'];
    if (ims) {
      const since = Date.parse(ims);
      // mtime truncated to seconds — HTTP dates carry no milliseconds.
      if (!Number.isNaN(since) && Math.floor(stat.mtime.getTime() / 1000) * 1000 <= since) {
        res.writeHead(304, headers).end();
        return;
      }
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, headers).end(data);
    });
  });
}

async function main() {
  // Last-resort guards: an async throw (e.g. a scheduler timer or a DB write on
  // a flaky volume) must never take the whole site down. Log and keep serving.
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException (staying up):', (err && err.stack) || err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection (staying up):', (reason && reason.stack) || reason);
  });

  const cfg = buildConfig();
  console.log('[server] config:', {
    port: cfg.port,
    beacon: cfg.beaconSource,
    announceLeadMs: cfg.announceLeadMs,
    interRaceGapMs: cfg.interRaceGapMs,
    fastDemo: process.env.FAST_DEMO === '1',
  });

  // State the HTTP/WS handlers close over. Everything heavy (DB, simulator,
  // scheduler) is set up AFTER the server is already listening, so a failure in
  // any of it can never stop the site from serving the page.
  let db = null;
  let tournament = null;
  let simulator = null;
  let scheduler = null;
  let simFailed = false;
  let startTournament = null; // assigned once setup succeeds

  // ---- admin API ---------------------------------------------------------
  // All /api/admin/* routes require the ADMIN_TOKEN via the x-admin-token
  // header when one is configured. (Header only — a token in the query string
  // would leak into access logs, proxy logs, and browser history.)
  // Fail CLOSED: with no ADMIN_TOKEN configured, the admin API is disabled
  // entirely rather than open to the world. (Read-only /status still answers so
  // the page can explain why controls are off.) A configured token is compared
  // in constant time so the status endpoint can't be used as a timing oracle.
  const adminConfigured = () => !!cfg.adminToken;
  const adminAuthed = () => {
    if (!cfg.adminToken) return false;
    const tok = currentReqHeaders['x-admin-token'] || '';
    const a = Buffer.from(String(tok));
    const b = Buffer.from(cfg.adminToken);
    return a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
  };
  let currentReqHeaders = {};

  const csvExports = {
    results: { fn: () => db.exportResults(), file: 'marble-results.csv' },
    champions: { fn: () => db.exportChampions(), file: 'marble-champions.csv' },
    marbles: { fn: () => db.exportMarbleStats(), file: 'marble-stats.csv' },
  };

  function handleAdmin(req, res, url) {
    currentReqHeaders = req.headers || {};
    const route = url.pathname.replace(/^\/api\/admin\/?/, '');

    // Status is always readable (so the page can prompt for a token), but it
    // never exposes the token itself.
    if (route === 'status' || route === '') {
      return sendJSON(res, 200, {
        ok: true,
        mode: 'server',
        protected: !!cfg.adminToken,
        configured: adminConfigured(),
        authed: adminAuthed(),
        paused: scheduler ? scheduler.isPaused() : false,
        running: !!scheduler,
        simFailed,
        current: scheduler ? scheduler.current : null,
        tournament: scheduler ? scheduler.snapshot().tournament : null,
        stats: db ? db.statsSummary() : null,
      });
    }

    if (!adminAuthed()) {
      return adminConfigured()
        ? sendJSON(res, 401, { ok: false, error: 'bad or missing admin token' })
        : sendJSON(res, 403, { ok: false, error: 'admin API disabled: set ADMIN_TOKEN on the server to enable controls' });
    }

    // CSV downloads (GET).
    if (route.startsWith('export')) {
      const type = url.searchParams.get('type') || 'results';
      const spec = csvExports[type];
      if (!spec) return sendJSON(res, 400, { ok: false, error: 'unknown export type' });
      const csv = toCSV(spec.fn());
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${spec.file}"`,
      });
      res.end(csv);
      return;
    }

    // Mutations (POST).
    if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'use POST' });
    if (!scheduler && route !== 'reset-stats' && route !== 'restart')
      return sendJSON(res, 409, { ok: false, error: 'no tournament running (simulator unavailable)' });

    switch (route) {
      case 'pause':
        scheduler && scheduler.pause();
        return sendJSON(res, 200, { ok: true, paused: true });
      case 'resume':
        scheduler && scheduler.resume();
        return sendJSON(res, 200, { ok: true, paused: false });
      case 'restart': {
        let seed;
        try {
          seed = parseSeedArg(url.searchParams.get('seed'));
        } catch (e) {
          return sendJSON(res, 400, { ok: false, error: e.message });
        }
        if (!startTournament) return sendJSON(res, 503, { ok: false, error: 'simulator not ready' });
        if (scheduler) scheduler.stop();
        startTournament(seed);
        return sendJSON(res, 200, { ok: true, restarted: true, seed: toMasterBuf(seed).toString('hex') });
      }
      case 'reset-stats': {
        if (!startTournament || !db) return sendJSON(res, 503, { ok: false, error: 'not ready' });
        if (scheduler) scheduler.stop();
        db.resetAllHistory();
        startTournament(randomSeed());
        return sendJSON(res, 200, { ok: true, reset: true });
      }
      default:
        return sendJSON(res, 404, { ok: false, error: 'unknown admin route' });
    }
  }

  // ---- server-rendered pages -------------------------------------------------
  const SSR_PAGES = { '/': 'index.html', '/index.html': 'index.html', '/gallery': 'gallery.html', '/champions': 'champions.html' };
  function readManifest() {
    try {
      return JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'marbles', 'manifest.json'), 'utf8')) || {};
    } catch {
      return {};
    }
  }
  function renderPage(file) {
    try {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
      if (file === 'gallery.html') {
        return ssr.renderGallery(html, { careers: db ? db.marbleCareers() : [], manifest: readManifest() });
      }
      if (file === 'champions.html') {
        return ssr.renderChampions(html, {
          history: db ? db.championHistory(200) : [],
          hof: db ? db.hallOfFame() : null,
          manifest: readManifest(),
        });
      }
      return ssr.renderHome(html, { snapshot: scheduler ? scheduler.snapshot() : null, hof: db ? db.hallOfFame() : null });
    } catch (e) {
      console.error('[ssr] render failed for', file, '-', e && e.message, '(serving static)');
      return null;
    }
  }

  const httpServer = http.createServer((req, res) => {
   try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, x-admin-token',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    if (url.pathname === '/api/state') {
      return sendJSON(res, 200, scheduler ? scheduler.snapshot() : { type: simFailed ? 'no_tournament' : 'starting' });
    }
    if (url.pathname === '/api/next') {
      // Convenience for builders: just the upcoming/current race with its
      // seeds, roster and scheduled start — the betting-window essentials.
      if (!scheduler) return sendJSON(res, 200, { type: simFailed ? 'no_tournament' : 'starting' });
      const snap = scheduler.snapshot();
      const races = snap.rounds.flatMap((r) => r.races);
      const cur = snap.current && races.find((x) => x.key === snap.current.raceKey);
      const race = (cur && !cur.result ? cur : races.find((x) => !x.result)) || null;
      return sendJSON(res, 200, {
        type: 'next_race',
        serverNow: snap.serverNow,
        announceLeadMs: snap.announceLeadMs,
        phase: snap.current ? snap.current.phase : null,
        tournamentId: snap.tournament.id,
        champion: snap.tournament.champion,
        race,
      });
    }
    if (url.pathname === '/api/careers') {
      // Lifetime stats per marble id (races, wins, podiums, championships).
      let careers = [];
      try {
        if (db) careers = db.marbleCareers();
      } catch (e) {
        console.error('[api] careers failed:', e && e.message);
      }
      return sendJSON(res, 200, { careers });
    }
    if (url.pathname === '/api/history') {
      // Recent completed races (seeds + full results), newest first.
      let races = [];
      try {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
        if (db) races = db.recentRaces(limit);
      } catch (e) {
        console.error('[api] history failed:', e && e.message);
      }
      return sendJSON(res, 200, { races });
    }
    if (url.pathname === '/api/champions') {
      // Public hall of fame: recent tournament winners, newest first. The flat
      // `champions` rows are the long-standing shape (kept for existing
      // consumers); `history` adds each champion's road through the bracket
      // and the final's finishing order, for the /champions page.
      let champions = [];
      let history = [];
      try {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
        if (db) {
          champions = db.exportChampions().slice(-limit).reverse();
          history = db.championHistory(limit);
        }
      } catch (e) {
        console.error('[api] champions failed:', e && e.message);
      }
      return sendJSON(res, 200, { champions, history });
    }
    if (url.pathname === '/api/hall-of-fame') {
      // Aggregates across all completed tournaments: title counts, repeat
      // champions, the longest title streak, the current holder.
      let hof = null;
      try {
        if (db) hof = db.hallOfFame();
      } catch (e) {
        console.error('[api] hall-of-fame failed:', e && e.message);
      }
      return sendJSON(res, 200, hof || { tournamentsCompleted: 0, racesRun: 0, distinctChampions: 0, currentChampion: null, mostTitles: [], repeatChampions: [], longestStreak: null });
    }
    // Public contribution to the next race seed: POST /api/race/:key/client-seed
    // with {"seed": "<64 hex chars>"} while the race is announced (T-30s → gate).
    // One seed per IP per race; folded into the race seed at race_start.
    const csm = url.pathname.match(/^\/api\/race\/([a-z]+:\d+)\/client-seed$/);
    if (csm) {
      if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: 'use POST' });
      if (!scheduler) return sendJSON(res, 503, { ok: false, error: 'no tournament running' });
      const raceKey = csm[1];
      readJsonBody(req, 2048)
        .then((body) => {
          const r = scheduler.addClientSeed(raceKey, clientIp(req), body && body.seed);
          if (!r.ok) return sendJSON(res, r.reason === 'window closed' ? 409 : 400, { ok: false, error: r.reason, count: r.count });
          return sendJSON(res, 200, { ok: true, accepted: !!r.accepted, count: r.count, closesAt: r.closesAt || null, note: r.reason || null });
        })
        .catch((e) => sendJSON(res, 400, { ok: false, error: e.message || 'bad request' }));
      return;
    }
    if (url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/')) {
      try {
        return handleAdmin(req, res, url);
      } catch (e) {
        console.error('[admin] error:', e && e.message);
        return sendJSON(res, 500, { ok: false, error: 'admin action failed' });
      }
    }
    // Any other /api/* path is an unknown endpoint — answer JSON, not the
    // static handler's HTML "Not found" (API clients expect JSON). NOTE: the
    // bare "/api" is the docs PAGE (clean-URL → api.html), so it must fall
    // through to the static handler — only "/api/…" subpaths are endpoints.
    if (url.pathname.startsWith('/api/')) {
      return sendJSON(res, 404, { ok: false, error: 'unknown endpoint' });
    }
    // Crawlable pages: fill the client containers server-side (see src/ssr.js)
    // so no-JS clients and crawlers get real content; the client hydrates over
    // identical markup. Any failure falls back to the plain static file.
    const ssrPage = SSR_PAGES[url.pathname];
    if (ssrPage && req.method === 'GET') {
      const rendered = renderPage(ssrPage);
      if (rendered != null) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Vary': 'Accept-Encoding',
        });
        return res.end(rendered);
      }
    }
    serveStatic(req, res);
   } catch (e) {
    // No request may ever escape without a response — an unanswered socket
    // leaks until the client times out. Any synchronous throw (a malformed
    // URL that trips `new URL`, an unexpected state error) becomes a 400/500
    // here instead of a hung connection.
    console.error('[server] request handler error:', e && e.message);
    try {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
    } catch {}
   }
  });

  const wss = new WSServer(httpServer, '/ws');
  wss.on('connection', (conn) => {
    // Bring the new client fully up to date. If there's no live tournament
    // (simulator/DB unavailable), tell the client so it falls back to running
    // the tournament in-browser instead of waiting forever on a live server.
    if (scheduler) conn.send(JSON.stringify(scheduler.snapshot()));
    else if (simFailed) conn.send(JSON.stringify({ type: 'no_tournament' }));
  });

  // Serve FIRST — the page must always load even if the pieces below fail.
  await new Promise((resolve) => httpServer.listen(cfg.port, cfg.host, resolve));
  const localUrl = `http://127.0.0.1:${cfg.port}`;
  console.log(`[server] listening on http://${cfg.host}:${cfg.port}  (viewer at /)`);

  // Now bring up the authoritative tournament: DB → headless simulator →
  // scheduler. If ANY step fails (corrupt volume, headless issues, …), keep the
  // server up and let clients fall back to running the tournament in-browser.
  try {
    db = new DB(cfg.dbPath);

    console.log('[server] launching headless simulator…');
    simulator = await createSimulator({
      url: `${localUrl}/marble_run.html`,
      // Any valid seed; every race rebuilds the course for its own trackSeed.
      trackSeed: 1,
      headless: cfg.headless,
    });
    console.log('[server] simulator ready (course built)');

    // Endless mode: run a tournament to its champion, hold on the podium for
    // the intermission, then start the next one with a fresh seed — forever.
    // The first tournament uses the configured masterSeed. Assigned to the
    // outer `startTournament` so the admin API can restart/reset.
    startTournament = (masterSeed) => {
      // The tournament id is mixed into every seed derivation, so the DB row
      // (which assigns the id) comes first; the commitment is persisted with it
      // so a finished tournament stays verifiable across restarts.
      const masterBuf = toMasterBuf(masterSeed);
      const commitment = makeCommitment(masterBuf);
      const tournamentId = db.createTournament({
        masterSeed: masterBuf.readUInt32BE(0) >>> 0, // legacy uint32 view
        masterSeedHex: masterBuf.toString('hex'),
        commit: commitment.commit,
        commitSalt: commitment.salt,
        createdAt: Date.now(),
      });
      tournament = new Tournament(masterBuf, tournamentId);
      db.insertMarbles(tournamentId, tournament.marbles);
      scheduler = new Scheduler({
        tournament,
        db,
        simulator,
        tournamentId,
        broadcast: (msg) => wss.broadcast(msg),
        config: {
          commit: commitment,
          beaconSource: cfg.beaconSource,
          beaconUrl: cfg.beaconUrl,
          announceLeadMs: cfg.announceLeadMs,
          interRaceGapMs: cfg.interRaceGapMs,
          intermissionMs: cfg.intermissionMs,
          playbackRate: cfg.playbackRate,
          watchOverrideMs: cfg.watchOverrideMs,
          onTournamentComplete: () => {
            const next = randomSeed();
            console.log(`[server] tournament ${tournamentId} complete — starting next (fresh 256-bit seed)`);
            startTournament(next);
          },
        },
      });
      // start() broadcasts a fresh snapshot, so connected viewers reset to the
      // new bracket automatically.
      scheduler.start();
    };
    // MASTER_SEED seeds the very first tournament of a fresh database. After
    // that every tournament — including the one started by a restart or a
    // deploy — gets a fresh random seed. Without this, each deploy replayed the
    // identical 424242 tournament: same bracket, same champion, and the
    // history page filled with duplicate "titles".
    const priorTournaments = db.statsSummary().tournaments;
    const firstSeed = priorTournaments > 0 ? randomSeed() : cfg.masterSeed;
    if (priorTournaments > 0)
      console.log(`[server] ${priorTournaments} tournament(s) on record — starting a fresh one with a random 256-bit seed`);
    startTournament(firstSeed);
  } catch (err) {
    simFailed = true;
    console.error('[server] no live tournament (serving page in local-fallback mode):', err && err.stack || err);
    try {
      wss.broadcast({ type: 'no_tournament' });
    } catch {}
  }

  const shutdown = async () => {
    console.log('\n[server] shutting down…');
    try {
      scheduler && scheduler.stop();
    } catch {}
    try {
      wss && wss.close();
    } catch {}
    try {
      if (simulator) await simulator.close();
    } catch {}
    try {
      if (db) db.close();
    } catch {}
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
