'use strict';

// =========================================================
// Tournament core — browser build (no server required)
// =========================================================
// A self-contained copy of the bracket + seed logic so the viewer can run an
// entire tournament client-side when there's no WebSocket server (e.g. on a
// static host like Vercel). Mirrors src/seeds.js + src/tournament.js so a
// local tournament is just as deterministic as a server-run one.
(function () {
  // ---- seeds ----
  function mix32(x) {
    x = x >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x = (x ^ (x >>> 15)) >>> 0;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    return x >>> 0;
  }
  function deriveSeed() {
    let h = 0x9e3779b9 >>> 0;
    for (let i = 0; i < arguments.length; i++) {
      h = (h ^ mix32((arguments[i] >>> 0) + 0x165667b1)) >>> 0;
      h = mix32(h);
    }
    return h >>> 0;
  }
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
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  const MARBLE_COUNT = 100;
  const LANE = 5;
  const COLOR_SLOTS = [
    { name: 'RED', color: '#d9534f' },
    { name: 'BLUE', color: '#5bc0de' },
    { name: 'GREEN', color: '#5cb85c' },
    { name: 'YELLOW', color: '#f0ad4e' },
    { name: 'CREAM', color: '#ede0c8' },
  ];
  const ROUNDS = [
    { key: 'heats', title: 'Heats' },
    { key: 'semis', title: 'Semifinals' },
    { key: 'final', title: 'Final' },
  ];

  class Tournament {
    constructor(masterSeed) {
      this.masterSeed = masterSeed >>> 0;
      this.marbles = [];
      for (let i = 1; i <= MARBLE_COUNT; i++) {
        this.marbles.push({ id: i, name: 'Marble ' + String(i).padStart(3, '0') });
      }
      this.rounds = [];
      this.champion = null;
      this._buildHeats();
    }
    marbleName(id) {
      const m = this.marbles.find((x) => x.id === id);
      return m ? m.name : 'Marble ' + id;
    }
    _makeRace(roundIdx, indexInRound, participantIds) {
      const round = ROUNDS[roundIdx];
      const raceSeed = deriveSeed(this.masterSeed, 0x5a17, roundIdx + 1, indexInRound + 1);
      // Each race runs on its own course.
      const trackSeed = deriveSeed(this.masterSeed, 0x7a2c, roundIdx + 1, indexInRound + 1);
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
        trackSeed,
        raceSeed,
        roster,
        result: null,
        status: 'pending',
        scheduledStart: null,
      };
    }
    _buildHeats() {
      const order = shuffled(
        this.marbles.map((m) => m.id),
        deriveSeed(this.masterSeed, 1, 0xd3a)
      );
      const races = chunk(order, LANE).map((g, i) => this._makeRace(0, i, g));
      this.rounds.push({ key: 'heats', title: 'Heats', idx: 0, races });
    }
    applyResult(race, order) {
      race.result = order.map((o, i) => Object.assign({ rank: i + 1 }, o));
    }
    roundComplete(roundIdx) {
      const r = this.rounds[roundIdx];
      return r && r.races.every((race) => race.result);
    }
    _winner(race) {
      return race.result[0].marbleId;
    }
    advance() {
      const lastIdx = this.rounds.length - 1;
      if (!this.roundComplete(lastIdx)) return null;
      const last = this.rounds[lastIdx];
      if (last.key === 'heats') {
        const winners = last.races.map((r) => this._winner(r));
        const drawn = shuffled(winners, deriveSeed(this.masterSeed, 2, 0x5e1));
        const races = chunk(drawn, LANE).map((g, i) => this._makeRace(1, i, g));
        const round = { key: 'semis', title: 'Semifinals', idx: 1, races };
        this.rounds.push(round);
        return round;
      }
      if (last.key === 'semis') {
        const winners = last.races.map((r) => this._winner(r));
        let wild = null;
        for (const r of last.races) {
          const runnerUp = r.result[1];
          const t = runnerUp.timeSec == null ? Infinity : runnerUp.timeSec;
          if (!wild || t < wild.timeSec) wild = { marbleId: runnerUp.marbleId, timeSec: t };
        }
        const finalists = winners.concat([wild.marbleId]);
        const drawn = shuffled(finalists, deriveSeed(this.masterSeed, 3, 0xf1a));
        const round = { key: 'final', title: 'Final', idx: 2, races: [this._makeRace(2, 0, drawn)], wildcard: wild.marbleId };
        this.rounds.push(round);
        return round;
      }
      if (last.key === 'final') {
        this.champion = this._winner(last.races[0]);
        return null;
      }
      return null;
    }
    nextPendingRace() {
      for (const round of this.rounds)
        for (const race of round.races) if (!race.result) return race;
      return null;
    }
    isComplete() {
      return this.champion != null;
    }
  }

  // Who is still in contention (mirrors scheduler.standings()).
  function standings(t) {
    const furthest = new Map();
    for (const round of t.rounds)
      for (const race of round.races)
        for (const s of race.roster) {
          const prev = furthest.get(s.marbleId);
          if (!prev || race.roundIdx > prev.roundIdx) furthest.set(s.marbleId, race);
        }
    return t.marbles.map((m) => {
      let status;
      if (t.champion === m.id) status = 'champion';
      else {
        const race = furthest.get(m.id);
        status = race && race.result ? 'eliminated' : 'alive';
      }
      return { id: m.id, name: m.name, status };
    });
  }

  window.TournamentCore = { Tournament, standings, deriveSeed, COLOR_SLOTS };
})();
