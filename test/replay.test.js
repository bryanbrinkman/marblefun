'use strict';

// Replay regression: re-run a fixed set of recorded races (seeds + expected
// results, captured from /api/history on the canonical server) through the
// REAL sim in headless Chromium and require the identical finishing order and
// identical finish times. This is the claim the /api docs make — the fixtures
// are the evidence, and CI runs this on every push.
//
// Re-record fixtures (only after an intentional physics change) with:
//   node test/replay.test.js --record http://localhost:8080
// which pulls the newest 12 completed races from that server's /api/history.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createSimulator } = require('../src/simulator');

const FIXTURE = path.join(__dirname, 'fixtures', 'races.json');
const GAME = 'file://' + path.join(__dirname, '..', 'public', 'marble_run.html');

async function record(base) {
  const res = await fetch(base.replace(/\/$/, '') + '/api/history?limit=12');
  const { races } = await res.json();
  const out = races
    .filter((r) => r.raceSeed && r.results && r.results.length)
    .map((r) => ({
      tournamentId: r.tournamentId,
      raceKey: r.raceKey,
      trackSeed: r.trackSeed,
      raceSeed: r.raceSeed,
      results: r.results.map((x) => ({ rank: x.rank, lane: x.lane, timeSec: x.timeSec })),
    }));
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(
    FIXTURE,
    JSON.stringify({ recordedAt: new Date().toISOString(), node: process.version, source: base, races: out }, null, 2) + '\n'
  );
  console.log(`recorded ${out.length} races to ${path.relative(process.cwd(), FIXTURE)}`);
}

async function replay() {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  console.log(`replay regression — ${fx.races.length} recorded races (recorded ${fx.recordedAt} on ${fx.node})\n`);
  const sim = await createSimulator({ url: GAME, trackSeed: fx.races[0].trackSeed });
  let passed = 0;
  let failed = 0;
  try {
    for (const r of fx.races) {
      const got = await sim.simulate(r.raceSeed, { forTrackSeed: r.trackSeed });
      const expectFinishers = r.results.filter((x) => x.timeSec != null);
      const gotOrder = got.order.map((o) => o.lane).join(',');
      const expOrder = expectFinishers.map((o) => o.lane).join(',');
      try {
        assert.strictEqual(gotOrder, expOrder, `order differs for ${r.raceKey}`);
        got.order.forEach((o, i) => {
          assert.strictEqual(o.timeSec, expectFinishers[i].timeSec, `time differs for ${r.raceKey} rank ${i + 1}: ${o.timeSec} vs ${expectFinishers[i].timeSec}`);
        });
        passed++;
        console.log(`  ✅ T${r.tournamentId} ${r.raceKey}  track=${r.trackSeed} race=${r.raceSeed}  ${gotOrder}`);
      } catch (e) {
        failed++;
        console.log(`  ❌ ${e.message}`);
      }
    }
  } finally {
    await sim.close();
  }
  console.log(`\n${passed} identical, ${failed} diverged`);
  if (failed) process.exitCode = 1;
}

(async () => {
  const i = process.argv.indexOf('--record');
  if (i >= 0) await record(process.argv[i + 1] || 'http://localhost:8080');
  else await replay();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
