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

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
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
    masterSeed: (envInt('MASTER_SEED', 424242) >>> 0) >>> 0,
    headless: process.env.HEADLESS !== '0',
    announceLeadMs: envInt('ANNOUNCE_LEAD_MS', fast ? 6000 : 30000),
    interRaceGapMs: envInt('INTER_RACE_GAP_MS', fast ? 2500 : 6000),
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

// A fresh, well-distributed 32-bit seed for a new tournament.
function randomSeed() {
  return (Date.now() ^ ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
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
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // Prevent path traversal.
  let filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  // Clean URLs: an extensionless path (e.g. /admin) maps to its .html file.
  if (path.extname(filePath) === '') filePath += '.html';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
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
    masterSeed: cfg.masterSeed,
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
  // All /api/admin/* routes require the ADMIN_TOKEN (header x-admin-token or
  // ?token=) when one is configured. If none is set, the API is open and the
  // status response flags it as unprotected.
  const adminAuthed = (url) => {
    if (!cfg.adminToken) return true;
    const tok = req_token_from(url);
    return tok === cfg.adminToken;
  };
  function req_token_from(urlObj) {
    return urlObj.searchParams.get('token') || currentReqHeaders['x-admin-token'] || '';
  }
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
        authed: adminAuthed(url),
        paused: scheduler ? scheduler.isPaused() : false,
        running: !!scheduler,
        simFailed,
        current: scheduler ? scheduler.current : null,
        tournament: scheduler ? scheduler.snapshot().tournament : null,
        stats: db ? db.statsSummary() : null,
      });
    }

    if (!adminAuthed(url)) return sendJSON(res, 401, { ok: false, error: 'bad or missing admin token' });

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
        const raw = url.searchParams.get('seed');
        const seed = raw != null && raw !== '' ? parseInt(raw, 10) >>> 0 : randomSeed();
        if (!startTournament) return sendJSON(res, 503, { ok: false, error: 'simulator not ready' });
        if (scheduler) scheduler.stop();
        startTournament(seed);
        return sendJSON(res, 200, { ok: true, restarted: true, seed });
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

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/state') {
      return sendJSON(res, 200, scheduler ? scheduler.snapshot() : { type: simFailed ? 'no_tournament' : 'starting' });
    }
    if (url.pathname === '/api/champions') {
      // Public hall of fame: recent tournament winners, newest first.
      let champions = [];
      try {
        if (db) champions = db.exportChampions().slice(-50).reverse();
      } catch (e) {
        console.error('[api] champions failed:', e && e.message);
      }
      return sendJSON(res, 200, { champions });
    }
    if (url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/')) {
      try {
        return handleAdmin(req, res, url);
      } catch (e) {
        console.error('[admin] error:', e && e.message);
        return sendJSON(res, 500, { ok: false, error: 'admin action failed' });
      }
    }
    serveStatic(req, res);
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
      trackSeed: cfg.masterSeed,
      headless: cfg.headless,
    });
    console.log('[server] simulator ready (course built)');

    // Endless mode: run a tournament to its champion, hold on the podium for
    // the intermission, then start the next one with a fresh seed — forever.
    // The first tournament uses the configured masterSeed. Assigned to the
    // outer `startTournament` so the admin API can restart/reset.
    startTournament = (masterSeed) => {
      tournament = new Tournament(masterSeed >>> 0);
      const tournamentId = db.createTournament({
        masterSeed: tournament.masterSeed,
        createdAt: Date.now(),
      });
      db.insertMarbles(tournamentId, tournament.marbles);
      scheduler = new Scheduler({
        tournament,
        db,
        simulator,
        tournamentId,
        broadcast: (msg) => wss.broadcast(msg),
        config: {
          masterSeed: tournament.masterSeed,
          announceLeadMs: cfg.announceLeadMs,
          interRaceGapMs: cfg.interRaceGapMs,
          playbackRate: cfg.playbackRate,
          watchOverrideMs: cfg.watchOverrideMs,
          onTournamentComplete: () => {
            const next = randomSeed();
            console.log(`[server] tournament ${tournamentId} complete — starting next (seed ${next})`);
            startTournament(next);
          },
        },
      });
      // start() broadcasts a fresh snapshot, so connected viewers reset to the
      // new bracket automatically.
      scheduler.start();
    };
    startTournament(cfg.masterSeed);
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
