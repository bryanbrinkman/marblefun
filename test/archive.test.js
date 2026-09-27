'use strict';

// The champions archive's counting rules (src/db.js), on an in-memory
// database: cumulative title ordinals ("as of that tournament") versus
// lifetime totals, tournaments cut short by a restart, archive coverage and
// the gaps a page has to explain, and the history filters the archive page
// browses with.

const assert = require('node:assert');
const { DB } = require('../src/db');

let passed = 0;
function check(name, fn) {
  fn();
  console.log('  ✅ ' + name);
  passed++;
}

console.log('Archive tests\n');

const db = new DB(':memory:');
let t = 0;
// A tournament with one recorded final (so the road/final queries have rows).
function tournament({ champion, completedAt, finish = true }) {
  t += 1;
  const id = db.createTournament({ masterSeed: 1000 + t, createdAt: completedAt - 3600e3 });
  db.insertMarbles(id, [{ id: champion, name: 'M' + champion }]);
  const roster = [champion, 50, 51, 52, 53].map((m, slot) => ({ slot, marbleId: m, marbleName: 'M' + m, lane: 'L' + slot, color: '#fff' }));
  const raceId = db.insertRace(id, { key: 'final:0', roundKey: 'final', roundIdx: 2, indexInRound: 0, trackSeed: 7, raceSeed: 9, roster });
  db.saveResult(raceId, roster.map((s, i) => ({ ...s, timeSec: 30 + i })), completedAt - 60e3);
  if (finish) db.setChampion(id, champion, completedAt);
  return id;
}

const T0 = Date.UTC(2026, 0, 1);
const day = 86400e3;
// #2 wins tournaments 1, 2, 4, 7; #9 wins 3, 5; #2 again in 8. Tournament 6
// is cut short (no champion). 9 is running now.
tournament({ champion: 2, completedAt: T0 + 1 * day });
tournament({ champion: 2, completedAt: T0 + 2 * day });
tournament({ champion: 9, completedAt: T0 + 3 * day });
tournament({ champion: 2, completedAt: T0 + 4 * day });
tournament({ champion: 9, completedAt: T0 + 5 * day });
tournament({ champion: 2, completedAt: T0 + 6 * day, finish: false }); // 6: left running by a crash
tournament({ champion: 2, completedAt: T0 + 7 * day });
tournament({ champion: 2, completedAt: T0 + 8 * day });
const running = tournament({ champion: 9, completedAt: T0 + 9 * day, finish: false }); // 9: in progress

check('a restart marks unfinished tournaments as cut short — never as complete', () => {
  assert.strictEqual(db.abandonStale(T0 + 9 * day), 2, 'both unfinished tournaments get marked');
  assert.strictEqual(db.getTournament(6).status, 'abandoned');
  assert.strictEqual(db.getTournament(6).champion_marble_id, null, 'no champion is invented');
  assert.strictEqual(db.abandonStale(T0 + 9 * day), 0, 'idempotent');
  // The one the new process starts afterwards is running again.
  db.db.prepare(`UPDATE tournaments SET status='running' WHERE id=?`).run(running);
});

check('title ordinals are cumulative over the whole table, not the page', () => {
  const page = db.championHistory({ limit: 2 }); // newest two only: 8 and 7
  assert.deepStrictEqual(page.map((r) => r.tournamentId), [8, 7]);
  assert.deepStrictEqual(page.map((r) => r.titleNumber), [5, 4], '#2 has 4 titles as of T7 and 5 as of T8 (T6 never counted)');
  assert.deepStrictEqual(page.map((r) => r.lifetimeTitles), [5, 5]);
  const hof = db.hallOfFame();
  assert.strictEqual(hof.mostTitles.find((m) => m.id === 2).titles, 5, 'the title table agrees with lifetimeTitles');
  assert.strictEqual(db.marbleCareers().find((c) => c.id === 2).titles, 5, 'so does the gallery career');
  assert.strictEqual(hof.tournamentsCompleted, 7);
  assert.deepStrictEqual(hof.currentChampion, { id: 2, name: hof.currentChampion.name, tournamentId: 8 }, 'reigning = latest completed, not the running one');
});

check('coverage counts completed, cut-short and running tournaments from one table', () => {
  assert.deepStrictEqual(db.archiveCoverage(), { completed: 7, abandoned: 1, running: 1, oldestId: 1, newestId: 9 });
});

check('gaps name the numbers a page skips, and why', () => {
  const gaps = db.tournamentGaps(1, 9);
  assert.deepStrictEqual(gaps.map((g) => [g.tournamentId, g.status, g.racesDone]), [[9, 'running', 1], [6, 'abandoned', 1]]);
  assert.deepStrictEqual(db.tournamentGaps(7, 8), [], 'a span with no gaps has none');
});

check('history filters: cursor, one tournament, by marble, by date', () => {
  assert.deepStrictEqual(db.championHistory({ limit: 10, before: 5 }).map((r) => r.tournamentId), [4, 3, 2, 1]);
  assert.deepStrictEqual(db.championHistory({ id: 3 }).map((r) => [r.tournamentId, r.champion.id, r.titleNumber]), [[3, 9, 1]]);
  assert.deepStrictEqual(db.championHistory({ marbleIds: [9] }).map((r) => [r.tournamentId, r.titleNumber]), [[5, 2], [3, 1]]);
  assert.deepStrictEqual(db.championHistory({ since: T0 + 4 * day, until: T0 + 7 * day }).map((r) => r.tournamentId), [7, 5, 4]);
  assert.deepStrictEqual(db.championHistory(3).map((r) => r.tournamentId), [8, 7, 5], 'a bare number is still the page size');
});

db.close();
console.log(`\n${passed} checks passed`);
