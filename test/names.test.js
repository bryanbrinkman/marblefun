'use strict';

// Display names come from ONE canonical id → name lookup, even for rows that
// were written under an earlier naming scheme. The stored text is kept and
// reported separately as the name at the time.

const assert = require('node:assert');
const { DB } = require('../src/db');
const { Tournament, COLOR_SLOTS } = require('../src/tournament');

let passed = 0;
function check(name, fn) {
  fn();
  console.log('  ✅ ' + name);
  passed++;
}
console.log('Display-name tests\n');

const db = new DB(':memory:');
const OLD = 'Frosty Drifter'; // what marble #77 was called when the row was written
const finish = (tid, race, ids, oldNames) => {
  const rid = db.insertRace(tid, race);
  db.markAnnounced(rid, 1, 1);
  db.markStarted(rid, 2);
  db.saveResult(rid, ids.map((id, i) => ({ slot: i, marbleId: id, marbleName: oldNames[id] || Tournament.marbleNameFor(id), lane: COLOR_SLOTS[i].name, color: COLOR_SLOTS[i].color, timeSec: 30 + i })), 3);
};
// Two completed tournaments won by #77: the first recorded under the old name.
for (const [n, names] of [[1, { 77: OLD }], [2, {}]]) {
  const t = new Tournament(1000 + n, n);
  const tid = db.createTournament({ masterSeed: t.masterSeed, masterSeedHex: t.masterSeedHex, createdAt: n });
  db.insertMarbles(tid, t.marbles.map((m) => ({ id: m.id, name: names[m.id] || m.name })));
  const heat = t.rounds[0].races[0];
  finish(tid, { ...heat, roster: heat.roster.map((s, i) => ({ ...s, marbleId: [77, 2, 3, 4, 5][i] })) }, [77, 2, 3, 4, 5], names);
  finish(tid, { ...heat, key: 'final:0', roundKey: 'final', roundIdx: 2, indexInRound: 0, roster: heat.roster.map((s, i) => ({ ...s, marbleId: [77, 6, 7, 8, 9][i] })) }, [77, 6, 7, 8, 9], names);
  db.setChampion(tid, 77, 10 + n);
}

check('hall of fame: one name per marble across title table, streak and current champion', () => {
  const hof = db.hallOfFame();
  const canonical = Tournament.marbleNameFor(77);
  assert.strictEqual(hof.mostTitles[0].name, canonical);
  assert.strictEqual(hof.longestStreak.name, canonical);
  assert.strictEqual(hof.currentChampion.name, canonical);
  assert.ok(!JSON.stringify(hof).includes(OLD));
});

check('champion history + exports: canonical name, with the name at the time kept separately', () => {
  const h = db.championHistory();
  const old = h.find((t) => t.tournamentId === 1);
  const cur = h.find((t) => t.tournamentId === 2);
  assert.strictEqual(old.champion.name, Tournament.marbleNameFor(77));
  assert.strictEqual(old.champion.nameAtTheTime, OLD);
  assert.strictEqual(cur.champion.nameAtTheTime, null);
  assert.strictEqual(old.final[0].marbleName, Tournament.marbleNameFor(77));
  assert.strictEqual(old.final[0].marbleNameAtTheTime, OLD);
  const ex = db.exportChampions();
  assert.ok(ex.every((r) => r.champion_name === Tournament.marbleNameFor(77)));
  assert.strictEqual(ex[0].champion_name_at_the_time, OLD);
});

check('recent races + marble stats: grouped by id, canonical names', () => {
  const rr = db.recentRaces(10);
  assert.ok(rr.every((r) => r.results.every((x) => x.marbleName === Tournament.marbleNameFor(x.marbleId))));
  const stats = db.exportMarbleStats();
  const rows77 = stats.filter((r) => r.marble_id === 77);
  assert.strictEqual(rows77.length, 1, 'one row per id, not one per historical name');
  assert.strictEqual(rows77[0].races, 4);
  assert.strictEqual(rows77[0].marble_name, Tournament.marbleNameFor(77));
});

console.log(`\n${passed} checks passed`);
