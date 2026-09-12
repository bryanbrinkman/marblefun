'use strict';

// Fast, browser-free tests for the tournament logic, seed determinism, the
// scheduler timeline and SQLite persistence. A MOCK simulator stands in for
// headless Chromium so the whole 25-race funnel runs in milliseconds.
// (The REAL headless sim + its determinism is exercised by headless_test.js.)

const assert = require('node:assert');
const { Tournament, COLOR_SLOTS } = require('../src/tournament');
const { Scheduler } = require('../src/scheduler');
const { DB } = require('../src/db');
const { deriveSeed, toMasterBuf, trackSeedFor, raceSeedFor, publicContributionFor, makeCommitment, sha256 } = require('../src/seeds');
const { encodeFrame } = require('../src/ws');
const crypto = require('node:crypto');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log('  ✅', name);
    })
    .catch((e) => {
      console.error('  ❌', name, '\n     ', e.message);
      process.exitCode = 1;
    });
}

// A deterministic mock: orders the 5 lanes by a per-lane hash of the race seed.
function mockSimulator() {
  return {
    async setCourse() {},
    async simulate(raceSeed) {
      const ranked = COLOR_SLOTS.map((c, i) => ({
        lane: c.name,
        color: c.color,
        h: deriveSeed(raceSeed, i),
      }))
        .sort((a, b) => a.h - b.h)
        .map((x, idx) => ({ lane: x.lane, color: x.color, timeSec: 30 + idx + (x.h % 1000) / 1000 }));
      return { trackSeed: 0, raceSeed, complete: true, order: ranked };
    },
    async close() {},
  };
}

async function main() {
  console.log('determinism + tournament tests\n');

  await test('seed derivation is reproducible & 32-bit', () => {
    const a = deriveSeed(42, 1, 2, 3);
    const b = deriveSeed(42, 1, 2, 3);
    assert.strictEqual(a, b);
    assert.ok(a >= 0 && a <= 0xffffffff && Number.isInteger(a));
    assert.notStrictEqual(deriveSeed(42, 1, 2, 3), deriveSeed(42, 1, 2, 4));
  });

  await test('two tournaments from the same master seed draw identical brackets + courses', () => {
    const t1 = new Tournament(777, 5);
    const t2 = new Tournament(777, 5);
    assert.strictEqual(t1.masterSeedHex, t2.masterSeedHex);
    const s1 = t1.rounds[0].races.map((r) => r.trackSeed + ':' + r.roster.map((x) => x.marbleId).join('.')).join(',');
    const s2 = t2.rounds[0].races.map((r) => r.trackSeed + ':' + r.roster.map((x) => x.marbleId).join('.')).join(',');
    assert.strictEqual(s1, s2);
    // Race seeds are NOT known at construction — they need the public contribution.
    assert.strictEqual(t1.rounds[0].races[0].raceSeed, null);
    // A different tournament id changes every derivation even with the same master seed.
    const t3 = new Tournament(777, 6);
    assert.notStrictEqual(t3.rounds[0].races[0].trackSeed, t1.rounds[0].races[0].trackSeed);
  });

  await test('sha256 seed layout: race seed = sha256(master ‖ tid ‖ raceKey ‖ public)[0..4], re-derivable by hand', () => {
    const master = toMasterBuf('ab'.repeat(32));
    assert.strictEqual(master.length, 32);
    const pub = publicContributionFor({
      beacon: { source: 'drand', round: 42, value: 'cd'.repeat(32) },
      clientSeeds: ['FF'.repeat(32), '00'.repeat(32), '00'.repeat(32)], // dedupe + sort + lowercase
    });
    // Hand-rolled: prefix ‖ "drand:42:<value>" ‖ 00.. ‖ ff..
    const byHand = crypto.createHash('sha256')
      .update('marblerun-public-v1').update(`drand:42:${'cd'.repeat(32)}`)
      .update(Buffer.from('00'.repeat(32), 'hex')).update(Buffer.from('ff'.repeat(32), 'hex')).digest();
    assert.strictEqual(pub.toString('hex'), byHand.toString('hex'));
    const tid = Buffer.alloc(4); tid.writeUInt32BE(9);
    const expect = crypto.createHash('sha256').update(master).update(tid).update('heats:3').update(pub).digest().readUInt32BE(0);
    assert.strictEqual(raceSeedFor(master, 9, 'heats:3', pub), expect);
    // Track seed layout.
    const tExpect = crypto.createHash('sha256').update(master).update(tid).update('heats:3').update('track').update(Buffer.from([2])).digest().readUInt32BE(0);
    assert.strictEqual(trackSeedFor(master, 9, 'heats:3', 2), tExpect);
    // Commitment layout.
    const c = makeCommitment(master, '11'.repeat(32));
    assert.strictEqual(c.commit, sha256(master, Buffer.from('11'.repeat(32), 'hex')).toString('hex'));
  });

  await test('heats round: 20 races of exactly 5 marbles, all 100 present once', () => {
    const t = new Tournament(1);
    assert.strictEqual(t.marbles.length, 100);
    assert.strictEqual(t.rounds[0].races.length, 20);
    const seen = new Set();
    for (const race of t.rounds[0].races) {
      assert.strictEqual(race.roster.length, 5);
      race.roster.forEach((s, i) => {
        assert.strictEqual(s.lane, COLOR_SLOTS[i].name); // participant i -> color slot i
        seen.add(s.marbleId);
      });
    }
    assert.strictEqual(seen.size, 100);
  });

  await test('funnel builds 20 heats -> 4 semis -> 1 final -> champion', () => {
    const t = new Tournament(2025);
    const sim = mockSimulator();
    // Manually run each round with the mock, then advance.
    const runRound = async (roundIdx) => {
      for (const race of t.rounds[roundIdx].races) {
        const s = await sim.simulate(race.trackSeed); // any deterministic per-race number will do here
        const byLane = new Map(race.roster.map((r) => [r.lane, r]));
        t.applyResult(
          race,
          s.order.map((o) => {
            const r = byLane.get(o.lane);
            return { slot: r.slot, marbleId: r.marbleId, marbleName: r.marbleName, lane: o.lane, color: o.color, timeSec: o.timeSec };
          })
        );
      }
    };
    return (async () => {
      await runRound(0);
      const semis = t.advance();
      assert.strictEqual(semis.key, 'semis');
      assert.strictEqual(semis.races.length, 4);
      semis.races.forEach((r) => assert.strictEqual(r.roster.length, 5));
      await runRound(1);
      const final = t.advance();
      assert.strictEqual(final.key, 'final');
      assert.strictEqual(final.races.length, 1);
      assert.strictEqual(final.races[0].roster.length, 5);
      // final = 4 semi winners + 1 wildcard
      assert.ok(final.wildcard);
      await runRound(2);
      const done = t.advance();
      assert.strictEqual(done, null);
      assert.ok(t.isComplete());
      assert.ok(t.champion >= 1 && t.champion <= 100);
    })();
  });

  await test('scheduler drives the full tournament & persists to SQLite', async () => {
    const db = new DB(':memory:');
    const t = new Tournament(31337);
    const tid = db.createTournament({ masterSeed: t.masterSeed, masterSeedHex: t.masterSeedHex, createdAt: 1 });
    db.insertMarbles(tid, t.marbles);

    const events = [];
    const fakeBeacon = async () => ({ source: 'test', round: 7, value: 'ee'.repeat(32), fetchedAt: 0 });
    const scheduler = new Scheduler({
      tournament: t,
      db,
      simulator: mockSimulator(),
      tournamentId: tid,
      broadcast: (m) => events.push(m),
      config: { announceLeadMs: 2, interRaceGapMs: 1, watchOverrideMs: 1, verbose: false, beaconSource: 'test', fetchBeacon: fakeBeacon },
    });
    // A "viewer" contributes a seed to the first race as soon as it's announced.
    const origB = scheduler.broadcast;
    scheduler.broadcast = (m) => {
      origB(m);
      if (m.type === 'race_announced' && m.race.key === 'heats:0') {
        const r = scheduler.addClientSeed('heats:0', '1.2.3.4', 'aa'.repeat(32));
        assert.strictEqual(r.accepted, true);
        assert.strictEqual(scheduler.addClientSeed('heats:0', '1.2.3.4', 'bb'.repeat(32)).accepted, false); // one per IP
        assert.strictEqual(scheduler.addClientSeed('heats:0', '5.6.7.8', 'nothex').ok, false);
      }
    };

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('tournament did not complete in time')), 15000);
      const orig = scheduler.broadcast;
      scheduler.broadcast = (m) => {
        orig(m);
        if (m.type === 'tournament_complete') {
          clearTimeout(timeout);
          resolve();
        }
      };
      scheduler.start();
    });

    // 25 races announced, started, revealed.
    const announced = events.filter((e) => e.type === 'race_announced').length;
    const starts = events.filter((e) => e.type === 'race_start');
    const results = events.filter((e) => e.type === 'race_result').length;
    assert.strictEqual(announced, 25);
    assert.strictEqual(starts.length, 25);
    assert.strictEqual(results, 25);
    // race_start carries everything needed to re-derive the race seed.
    const s0 = starts.find((e) => e.raceKey === 'heats:0');
    assert.deepStrictEqual(s0.clientSeeds, ['aa'.repeat(32)]);
    assert.strictEqual(s0.publicSource, 'beacon+clients');
    const pub = publicContributionFor({ beacon: s0.beacon, clientSeeds: s0.clientSeeds });
    assert.strictEqual(pub.toString('hex'), s0.publicContribution);
    assert.strictEqual(raceSeedFor(t.masterSeedBuf, tid, 'heats:0', pub), s0.raceSeed);
    // The window is closed once the race has started.
    assert.strictEqual(scheduler.addClientSeed('heats:0', '9.9.9.9', 'cc'.repeat(32)).ok, false);
    // Persisted too: /api/history rows carry the inputs.
    const hist = db.recentRaces(30).find((r) => r.raceKey === 'heats:0');
    assert.strictEqual(hist.publicContribution, s0.publicContribution);
    assert.deepStrictEqual(hist.clientSeeds, ['aa'.repeat(32)]);
    assert.strictEqual(hist.raceSeed, s0.raceSeed);

    // DB: 25 races, all done, 125 result rows, champion set.
    const races = db.getRaces(tid);
    assert.strictEqual(races.length, 25);
    assert.ok(races.every((r) => r.status === 'done'));
    const resultRows = races.reduce((n, r) => n + r.result.length, 0);
    assert.strictEqual(resultRows, 125);
    const tour = db.getTournament(tid);
    assert.strictEqual(tour.status, 'complete');
    assert.ok(tour.champion_marble_id >= 1 && tour.champion_marble_id <= 100);

    // Standings at the end: exactly one champion, rest eliminated, none alive.
    const finalStand = scheduler.standings();
    assert.strictEqual(finalStand.filter((m) => m.status === 'champion').length, 1);
    assert.strictEqual(finalStand.filter((m) => m.status === 'alive').length, 0);
    db.close();
  });

  await test('a non-finishing (stuck) marble is recorded as a DNF, still 5 rows', () => {
    const t = new Tournament(9);
    const race = t.rounds[0].races[0];
    const scheduler = new Scheduler({
      tournament: t,
      db: null,
      simulator: mockSimulator(),
      tournamentId: 1,
      broadcast: () => {},
    });
    // Sim that only reports 4 finishers (one lane never crosses).
    const finishers = race.roster.slice(0, 4).map((s, i) => ({
      lane: s.lane,
      color: s.color,
      timeSec: 40 + i,
    }));
    const order = scheduler._toOrder(race, { order: finishers });
    assert.strictEqual(order.length, 5);
    const dnf = order.filter((o) => o.timeSec === null);
    assert.strictEqual(dnf.length, 1);
    // The DNF marble is the roster slot missing from the finishers.
    assert.strictEqual(dnf[0].slot, race.roster[4].slot);
  });

  await test('websocket frame encoding: header sizes for small/medium payloads', () => {
    assert.strictEqual(encodeFrame('hi')[1], 2); // 7-bit length
    const mid = encodeFrame('x'.repeat(200));
    assert.strictEqual(mid[1], 126); // 16-bit length marker
    assert.strictEqual(mid.readUInt16BE(2), 200);
  });

  console.log(`\n${passed} checks passed`);
}

main();
