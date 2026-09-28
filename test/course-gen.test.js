'use strict';

// Course generations: the course generator's version travels with every race
// (server → DB → API → viewer → game), so a race recorded under an older
// generation replays on exactly the course it ran on. These checks pin the
// plumbing; the replay fixtures (test/replay.test.js) pin the courses.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Tournament, COURSE_GEN } = require('../src/tournament');
const { DB } = require('../src/db');

let passed = 0;
function check(name, fn) {
  fn();
  console.log('  ✅ ' + name);
  passed++;
}

console.log('Course-generation tests\n');

check('the game, the server and the browser-local mode agree on the current generation', () => {
  const game = fs.readFileSync(path.join(__dirname, '..', 'public', 'marble_run.html'), 'utf8');
  const m = game.match(/const COURSE_GEN_LATEST = (\d+);/);
  assert.ok(m, 'the game declares COURSE_GEN_LATEST');
  assert.strictEqual(Number(m[1]), COURSE_GEN, 'src/tournament.js COURSE_GEN matches the game');
  const core = fs.readFileSync(path.join(__dirname, '..', 'public', 'tournament-core.js'), 'utf8');
  const c = core.match(/const courseGen = (\d+);/);
  assert.ok(c && Number(c[1]) === COURSE_GEN, 'public/tournament-core.js builds local races under the same generation');
  // Generation 1 must draw nothing new from the track RNG: the piece is gated.
  assert.ok(/if \(SEEDS\.gen >= 2\) \{\s*splitPending = trackRng\(\)/.test(game), 'the Split & Merge roll only happens for generation 2+');
});

check('every race a tournament creates carries the current generation', () => {
  const t = new Tournament('ab'.repeat(32), 1);
  const races = t.rounds.flatMap((r) => r.races);
  assert.ok(races.length >= 20);
  for (const r of races) assert.strictEqual(r.courseGen, COURSE_GEN, r.key);
});

check('the database stores it, and rows from before generations existed read as generation 1', () => {
  const db = new DB(':memory:');
  const id = db.createTournament({ masterSeed: 1, createdAt: 1 });
  const roster = [0, 1, 2, 3, 4].map((slot) => ({ slot, marbleId: slot + 1, marbleName: 'M' + (slot + 1), lane: 'RED', color: '#000' }));
  const a = db.insertRace(id, { key: 'heats:0', roundKey: 'heats', roundIdx: 0, indexInRound: 0, trackSeed: 7, raceSeed: 9, courseGen: 2, roster });
  const b = db.insertRace(id, { key: 'heats:1', roundKey: 'heats', roundIdx: 0, indexInRound: 1, trackSeed: 8, raceSeed: 9, roster });
  // An old row: recorded before the column existed.
  db.db.prepare('UPDATE races SET course_gen = NULL WHERE id = ?').run(b);
  db.db.prepare('UPDATE races SET revealed_at = 5, status = ? WHERE id IN (?, ?)').run('done', a, b);
  const rows = db.recentRaces(10);
  const byKey = Object.fromEntries(rows.map((r) => [r.raceKey, r]));
  assert.strictEqual(byKey['heats:0'].courseGen, 2, 'stored generation comes back');
  assert.strictEqual(byKey['heats:1'].courseGen, 1, 'a NULL generation is generation 1');
});

console.log(`\n${passed} checks passed`);
