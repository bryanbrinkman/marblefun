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
  };
  return cfg;
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // Prevent path traversal.
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
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
  const cfg = buildConfig();
  console.log('[server] config:', {
    port: cfg.port,
    masterSeed: cfg.masterSeed,
    announceLeadMs: cfg.announceLeadMs,
    interRaceGapMs: cfg.interRaceGapMs,
    fastDemo: process.env.FAST_DEMO === '1',
  });

  const db = new DB(cfg.dbPath);
  const tournament = new Tournament(cfg.masterSeed);
  const tournamentId = db.createTournament({
    masterSeed: tournament.masterSeed,
    createdAt: Date.now(),
  });
  db.insertMarbles(tournamentId, tournament.marbles);

  let scheduler = null;

  const httpServer = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(scheduler ? scheduler.snapshot() : { type: 'starting' }));
      return;
    }
    serveStatic(req, res);
  });

  const wss = new WSServer(httpServer, '/ws');
  wss.on('connection', (conn) => {
    // Bring the new client fully up to date.
    if (scheduler) conn.send(JSON.stringify(scheduler.snapshot()));
  });

  await new Promise((resolve) => httpServer.listen(cfg.port, cfg.host, resolve));
  const localUrl = `http://127.0.0.1:${cfg.port}`;
  console.log(`[server] listening on http://${cfg.host}:${cfg.port}  (viewer at /)`);

  // Headless simulator loads the very page clients replay.
  console.log('[server] launching headless simulator…');
  const simulator = await createSimulator({
    url: `${localUrl}/marble_run.html`,
    // Any valid seed; each race rebuilds the course for its own trackSeed.
    trackSeed: tournament.nextPendingRace().trackSeed,
    headless: cfg.headless,
  });
  console.log('[server] simulator ready (course built)');

  scheduler = new Scheduler({
    tournament,
    db,
    simulator,
    tournamentId,
    broadcast: (msg) => wss.broadcast(msg),
    config: {
      masterSeed: cfg.masterSeed,
      announceLeadMs: cfg.announceLeadMs,
      interRaceGapMs: cfg.interRaceGapMs,
      playbackRate: cfg.playbackRate,
      watchOverrideMs: cfg.watchOverrideMs,
    },
  });
  scheduler.start();

  const shutdown = async () => {
    console.log('\n[server] shutting down…');
    try {
      scheduler && scheduler.stop();
    } catch {}
    try {
      await simulator.close();
    } catch {}
    try {
      db.close();
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
