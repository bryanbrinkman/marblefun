'use strict';

const { Tournament } = require('./tournament');

// =========================================================
// Scheduler — drives the tournament on a live timeline
// =========================================================
// For every race:
//   1. ANNOUNCE  — broadcast the (trackSeed, raceSeed) + roster, with a
//                  scheduled start time `announceLeadMs` in the future
//                  (30 s by default). Clients pre-load and count down.
//   2. Meanwhile compute the true result headlessly (the sim finishes in a
//      few seconds), which also tells us exactly how long the visible race
//      will take.
//   3. START     — at the scheduled time, tell clients to begin their local
//                  replay from the broadcast seeds.
//   4. REVEAL    — once the marbles would have finished on screen, broadcast
//                  the finishing order, persist it, and advance the bracket.
//
// The headless result and the client replay come from the identical
// deterministic code, so the recorded winner is exactly what viewers see.

const DEFAULTS = {
  announceLeadMs: 30000, // announce 30 s before the gate opens
  interRaceGapMs: 6000, // pause after a reveal before the next announcement
  revealBufferMs: 2500, // slack after the last marble finishes before reveal
  playbackRate: 1, // client replay speed (1 = real time; the game renders 1x)
  watchOverrideMs: null, // if set, ignore real race duration (tests/demo only)
  maxSimSeconds: 300,
  verbose: true, // per-race console logging
};

class Scheduler {
  constructor({ tournament, db, simulator, broadcast, tournamentId, config = {} }) {
    this.t = tournament || new Tournament(config.masterSeed >>> 0);
    this.db = db;
    this.sim = simulator;
    this.broadcast = broadcast || (() => {});
    this.tournamentId = tournamentId;
    this.cfg = { ...DEFAULTS, ...config };
    this.timers = new Set();
    this.stopped = false;
    this.current = null; // { race, phase, scheduledStart }
    this._persistedRounds = new Set();
  }

  _t(fn, ms) {
    const h = setTimeout(() => {
      this.timers.delete(h);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(h);
    return h;
  }

  now() {
    return Date.now();
  }

  // Persist any newly-built rounds' races (and assign db ids).
  _persistNewRounds() {
    for (const round of this.t.rounds) {
      if (this._persistedRounds.has(round.key)) continue;
      for (const race of round.races) {
        race.dbId = this.db.insertRace(this.tournamentId, race);
        race.status = 'pending';
      }
      this._persistedRounds.add(round.key);
    }
  }

  start() {
    this._persistNewRounds();
    this.broadcast(this.snapshot());
    this._runNext();
  }

  stop() {
    this.stopped = true;
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
  }

  _runNext() {
    if (this.stopped) return;
    let race = this.t.nextPendingRace();
    if (!race) {
      // Current round done — try to build the next one.
      const next = this.t.advance();
      if (next) {
        this._persistNewRounds();
        this.broadcast({
          type: 'round_built',
          serverNow: this.now(),
          round: {
            key: next.key,
            title: next.title,
            idx: next.idx,
            races: next.races.map((r) => this.raceView(r)),
          },
        });
        race = this.t.nextPendingRace();
      }
    }
    if (!race) {
      // No more races: either the final just completed (champion) or nothing.
      this.t.advance(); // sets champion if final complete
      if (this.t.isComplete()) {
        this.db.setChampion(this.tournamentId, this.t.champion);
        this.broadcast({
          type: 'tournament_complete',
          champion: { id: this.t.champion, name: this.t.marbleName(this.t.champion) },
          serverNow: this.now(),
        });
      }
      return;
    }
    this._announce(race);
  }

  _announce(race) {
    const scheduledStart = this.now() + this.cfg.announceLeadMs;
    race.status = 'announced';
    race.scheduledStart = scheduledStart;
    this.current = { raceKey: race.key, phase: 'announced', scheduledStart };
    this.db.markAnnounced(race.dbId, scheduledStart, this.now());

    if (this.cfg.verbose)
      console.log(
        `[race] ${race.roundKey}:${race.indexInRound} announced  track=${race.trackSeed} race=${race.raceSeed}  start in ${this.cfg.announceLeadMs}ms`
      );
    this.broadcast({
      type: 'race_announced',
      serverNow: this.now(),
      scheduledStart,
      announceLeadMs: this.cfg.announceLeadMs,
      playbackRate: this.cfg.playbackRate,
      race: this.raceView(race),
    });

    // Compute the true result now (runs concurrently with the countdown).
    const resultP = this.sim
      .simulate(race.raceSeed, { forTrackSeed: race.trackSeed })
      .then((sim) => this._toOrder(race, sim))
      .catch((err) => {
        console.error('[scheduler] sim failed for', race.key, err.message);
        return null;
      });

    // Fire the START signal at the scheduled time.
    this._t(() => {
      race.status = 'running';
      this.current = { raceKey: race.key, phase: 'running', scheduledStart };
      this.db.markStarted(race.dbId, this.now());
      this.broadcast({ type: 'race_start', raceKey: race.key, serverNow: this.now() });
    }, Math.max(0, scheduledStart - this.now()));

    // Reveal once the marbles would have finished on screen.
    resultP.then((order) => {
      if (this.stopped || !order) return;
      const finishTimes = order.map((o) => o.timeSec).filter((t) => t != null);
      const maxFinish = finishTimes.length ? Math.max(...finishTimes) : this.cfg.maxSimSeconds;
      const watchMs =
        this.cfg.watchOverrideMs != null
          ? this.cfg.watchOverrideMs
          : Math.ceil((maxFinish * 1000) / this.cfg.playbackRate) + this.cfg.revealBufferMs;
      const revealAt = scheduledStart + watchMs;
      this._t(() => this._reveal(race, order), Math.max(0, revealAt - this.now()));
    });
  }

  // Map the sim's color-lane finishing order back to tournament marbles via
  // the race roster. Any marble that never crossed the line (a stuck marble —
  // a rare but legitimate deterministic outcome) is appended as a DNF
  // (timeSec = null) so every race records all 5 participants.
  _toOrder(race, sim) {
    const byLane = new Map(race.roster.map((s) => [s.lane, s]));
    const order = sim.order.map((o) => {
      const s = byLane.get(o.lane);
      return {
        slot: s.slot,
        marbleId: s.marbleId,
        marbleName: s.marbleName,
        lane: o.lane,
        color: o.color,
        timeSec: o.timeSec,
      };
    });
    const finished = new Set(order.map((o) => o.slot));
    for (const s of race.roster) {
      if (!finished.has(s.slot)) {
        order.push({
          slot: s.slot,
          marbleId: s.marbleId,
          marbleName: s.marbleName,
          lane: s.lane,
          color: s.color,
          timeSec: null, // DNF
        });
      }
    }
    return order;
  }

  _reveal(race, order) {
    this.t.applyResult(race, order);
    race.status = 'done';
    this.db.saveResult(race.dbId, order, this.now());
    this.current = { raceKey: race.key, phase: 'revealed', scheduledStart: race.scheduledStart };
    const w = race.result[0];
    const wt = w.timeSec != null ? w.timeSec.toFixed(2) + 's' : 'DNF';
    if (this.cfg.verbose)
      console.log(`[race] ${race.roundKey}:${race.indexInRound} result  winner=${w.marbleName} (${w.lane}) ${wt}`);

    this.broadcast({
      type: 'race_result',
      serverNow: this.now(),
      raceKey: race.key,
      result: race.result,
      standings: this.standings(),
    });

    // Continue after a short gap.
    this._t(() => this._runNext(), this.cfg.interRaceGapMs);
  }

  // ---- views ------------------------------------------------------------

  raceView(race) {
    return {
      key: race.key,
      roundKey: race.roundKey,
      roundTitle: race.roundTitle,
      indexInRound: race.indexInRound,
      trackSeed: race.trackSeed,
      raceSeed: race.raceSeed,
      status: race.status || 'pending',
      scheduledStart: race.scheduledStart || null,
      roster: race.roster,
      result: race.result || null,
    };
  }

  // Who is still in contention. A marble is 'alive' only while its
  // furthest-reached race is unresolved; once that race is done and it isn't
  // the champion, it's out. (A wildcard's furthest race is the final, so a
  // lost final correctly reads as eliminated.)
  standings() {
    const furthest = new Map(); // marbleId -> its highest-round race
    for (const round of this.t.rounds) {
      for (const race of round.races) {
        for (const s of race.roster) {
          const prev = furthest.get(s.marbleId);
          if (!prev || race.roundIdx > prev.roundIdx) furthest.set(s.marbleId, race);
        }
      }
    }
    return this.t.marbles.map((m) => {
      let status;
      if (this.t.champion === m.id) status = 'champion';
      else {
        const race = furthest.get(m.id);
        status = race && race.result ? 'eliminated' : 'alive';
      }
      return { id: m.id, name: m.name, status };
    });
  }

  snapshot() {
    return {
      type: 'snapshot',
      serverNow: this.now(),
      announceLeadMs: this.cfg.announceLeadMs,
      playbackRate: this.cfg.playbackRate,
      viewerUrl: 'marble_run.html',
      tournament: {
        id: this.tournamentId,
        masterSeed: this.t.masterSeed,
        status: this.t.isComplete() ? 'complete' : 'running',
        champion: this.t.champion
          ? { id: this.t.champion, name: this.t.marbleName(this.t.champion) }
          : null,
      },
      marbles: this.t.marbles,
      rounds: this.t.rounds.map((round) => ({
        key: round.key,
        title: round.title,
        idx: round.idx,
        races: round.races.map((r) => this.raceView(r)),
      })),
      current: this.current,
      standings: this.standings(),
    };
  }
}

module.exports = { Scheduler, DEFAULTS };
