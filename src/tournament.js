'use strict';

const { deriveSeed, mix32 } = require('./seeds');

// =========================================================
// Tournament model — 100 marbles, brackets of 5
// =========================================================
// Funnel:
//   Heats : 20 races x 5 marbles  -> winner of each advances     (20 qualifiers)
//   Semis :  4 races x 5 marbles  -> winner of each advances (4)
//                                     + fastest runner-up (1 wildcard)  (5 finalists)
//   Final :  1 race  x 5 marbles  -> winner is champion
//
// Every race is exactly 5 marbles because the underlying game always runs 5
// (colors RED, BLUE, GREEN, YELLOW, CREAM). Tournament marbles are assigned to
// those 5 color lanes in participant order; the deterministic sim decides which
// color wins, which maps back to the marble in that lane.

const MARBLE_COUNT = 100;
const LANE = 5;

// Physical color lanes in the game's canonical order (COLORS/NAMES in the HTML).
// participants[i] races in COLOR_SLOTS[i].
const COLOR_SLOTS = [
  { name: 'RED', color: '#d9534f' },
  { name: 'BLUE', color: '#5bc0de' },
  { name: 'GREEN', color: '#5cb85c' },
  { name: 'YELLOW', color: '#f0ad4e' },
  { name: 'CREAM', color: '#ede0c8' },
];

const ROUNDS = [
  { key: 'heats', title: 'Heats', raceCount: 20 },
  { key: 'semis', title: 'Semifinals', raceCount: 4 },
  { key: 'final', title: 'Final', raceCount: 1 },
];

// mulberry32 PRNG — seeded, deterministic, for bracket draws.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, seed) {
  const a = arr.slice();
  const rng = makeRng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

class Tournament {
  // seed: master uint32. All courses/races derive from it, so the entire
  // tournament is reproducible.
  constructor(masterSeed) {
    this.masterSeed = masterSeed >>> 0;
    // One shared course for the whole tournament (every marble races the same
    // track; the race seed varies per race).
    this.trackSeed = deriveSeed(this.masterSeed, 0xABCD);

    // 100 marbles with stable ids and display names.
    this.marbles = [];
    for (let i = 1; i <= MARBLE_COUNT; i++) {
      this.marbles.push({ id: i, name: 'Marble ' + String(i).padStart(3, '0') });
    }

    this.rounds = []; // filled incrementally
    this.champion = null;
    this._buildHeats();
  }

  marbleName(id) {
    const m = this.marbles.find((x) => x.id === id);
    return m ? m.name : 'Marble ' + id;
  }

  // Create a race object for a round given its participant marble ids.
  _makeRace(roundIdx, indexInRound, participantIds) {
    const round = ROUNDS[roundIdx];
    const raceSeed = deriveSeed(this.masterSeed, 0x5A17, roundIdx + 1, indexInRound + 1);
    const roster = participantIds.map((mid, slot) => ({
      slot,
      marbleId: mid,
      marbleName: this.marbleName(mid),
      lane: COLOR_SLOTS[slot].name,
      color: COLOR_SLOTS[slot].color,
    }));
    return {
      key: round.key + ':' + indexInRound,
      roundIdx,
      roundKey: round.key,
      roundTitle: round.title,
      indexInRound,
      trackSeed: this.trackSeed,
      raceSeed,
      roster, // slot -> marble
      result: null, // filled after the race runs
    };
  }

  _buildHeats() {
    // Draw: shuffle all 100 marbles deterministically, then chunk into 20 heats.
    const order = shuffled(
      this.marbles.map((m) => m.id),
      deriveSeed(this.masterSeed, 1, 0xD3A) // heats draw seed
    );
    const groups = chunk(order, LANE);
    const races = groups.map((g, i) => this._makeRace(0, i, g));
    this.rounds.push({ key: 'heats', title: 'Heats', idx: 0, races });
  }

  // ---- results ----------------------------------------------------------

  // Attach a computed result to a race. `order` is an array of
  // { marbleId, lane, color, timeSec } sorted rank 1..5.
  applyResult(race, order) {
    race.result = order.map((o, i) => ({ rank: i + 1, ...o }));
  }

  roundComplete(roundIdx) {
    const r = this.rounds[roundIdx];
    return r && r.races.every((race) => race.result);
  }

  // Winner (rank-1 marbleId) of a race.
  _winner(race) {
    return race.result[0].marbleId;
  }

  // Build the next round from the just-completed round. Returns the new round
  // object, or null if the tournament is over (final done).
  advance() {
    const lastIdx = this.rounds.length - 1;
    if (!this.roundComplete(lastIdx)) return null;
    const last = this.rounds[lastIdx];

    if (last.key === 'heats') {
      // 20 heat winners -> 4 semis of 5 (seeded draw).
      const winners = last.races.map((r) => this._winner(r));
      const drawn = shuffled(winners, deriveSeed(this.masterSeed, 2, 0x5E1));
      const groups = chunk(drawn, LANE);
      const races = groups.map((g, i) => this._makeRace(1, i, g));
      const round = { key: 'semis', title: 'Semifinals', idx: 1, races };
      this.rounds.push(round);
      return round;
    }

    if (last.key === 'semis') {
      // 4 semi winners + fastest runner-up (wildcard) -> final of 5.
      const winners = last.races.map((r) => this._winner(r));
      // Fastest runner-up: compare rank-2 finish times across the 4 semis.
      let wild = null;
      for (const r of last.races) {
        const runnerUp = r.result[1]; // rank 2
        const t = runnerUp.timeSec == null ? Infinity : runnerUp.timeSec; // DNF sorts last
        if (!wild || t < wild.timeSec) {
          wild = { marbleId: runnerUp.marbleId, timeSec: t };
        }
      }
      const finalists = winners.concat([wild.marbleId]);
      // Seed the final's lane order.
      const drawn = shuffled(finalists, deriveSeed(this.masterSeed, 3, 0xF1A));
      const races = [this._makeRace(2, 0, drawn)];
      const round = { key: 'final', title: 'Final', idx: 2, races, wildcard: wild.marbleId };
      this.rounds.push(round);
      return round;
    }

    if (last.key === 'final') {
      this.champion = this._winner(last.races[0]);
      return null;
    }
    return null;
  }

  // Flat, ordered list of every race currently known (past + present rounds).
  allRaces() {
    const out = [];
    for (const round of this.rounds) for (const race of round.races) out.push(race);
    return out;
  }

  // Next race that has no result yet, in run order. null when nothing pending
  // in the currently-built rounds.
  nextPendingRace() {
    for (const round of this.rounds) {
      for (const race of round.races) {
        if (!race.result) return race;
      }
    }
    return null;
  }

  isComplete() {
    return this.champion != null;
  }
}

module.exports = { Tournament, COLOR_SLOTS, ROUNDS, MARBLE_COUNT, LANE };
