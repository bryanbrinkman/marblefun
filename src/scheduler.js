'use strict';

const { Tournament } = require('./tournament');
const {
  makeCommitment,
  probeSeedFor,
  raceSeedFor,
  publicContributionFor,
} = require('./seeds');
const { fetchBeacon } = require('./beacon');

// =========================================================
// Scheduler — drives the tournament on a live timeline
// =========================================================
// For every race:
//   1. ANNOUNCE  — pick a course (re-rolling dud candidates with a PROBE seed
//                  that is never used for a real race), broadcast the roster +
//                  trackSeed with a scheduled start `announceLeadMs` ahead, and
//                  open the CLIENT SEED WINDOW: anyone may POST a 32-byte seed
//                  to /api/race/:key/client-seed until the gate opens.
//   2. START     — at the scheduled time, close the window, fetch a public
//                  randomness beacon, fold beacon + client seeds into the
//                  PUBLIC CONTRIBUTION, derive
//                    raceSeed = sha256(masterSeed ‖ tournamentId ‖ raceKey ‖ publicContribution)[0..4]
//                  and broadcast race_start with everything needed to
//                  re-derive it. Only now is the outcome determined — the
//                  house, holding the master seed, could not compute it before
//                  this instant because the public contribution did not exist.
//   3. Compute the true result headlessly (a few seconds).
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
  trackAttempts: 5, // candidate track seeds to try before accepting a poor-start race
  intermissionMs: 30000, // pause on the champion before onTournamentComplete fires
  onTournamentComplete: null, // hook: start the next tournament (endless mode)
  // Public randomness: beacon source ('drand' | 'nist' | 'none') and how hard
  // to try for it at race_start before falling back.
  beaconSource: 'drand',
  beaconUrl: null,
  beaconAttempts: 3,
  beaconTimeoutMs: 2500,
  fetchBeacon, // injectable (tests)
  maxClientSeeds: 256, // per race; one per IP
  commit: null, // pre-made { commit, salt } (server persists it); else generated
};

class Scheduler {
  constructor({ tournament, db, simulator, broadcast, tournamentId, config = {} }) {
    this.t = tournament || new Tournament(config.masterSeed, tournamentId);
    this.db = db;
    this.sim = simulator;
    this.broadcast = broadcast || (() => {});
    this.tournamentId = tournamentId;
    this.cfg = { ...DEFAULTS, ...config };
    this.timers = new Set();
    this.stopped = false;
    this.paused = false;
    this._idle = false; // true when paused and waiting between races
    this.current = null; // { raceKey, phase, scheduledStart }
    this._persistedRounds = new Set();
    // Fairness commitment for THIS tournament's master seed.
    const c = this.cfg.commit || makeCommitment(this.t.masterSeedBuf);
    this.commit = c.commit;
    this.commitSalt = c.salt;
    // Client seed window: raceKey -> Map(ip -> seedHex). Only the currently
    // announced race accepts seeds.
    this._clientSeeds = new Map();
    this._lastBeacon = null; // last successfully fetched pulse (stale fallback)
  }

  // The master seed and its salt are revealed ONLY once the tournament is over,
  // so a finished tournament is fully verifiable (re-run every derivation) while
  // a running one gives up nothing. masterSeed (uint32) is the legacy view;
  // masterSeedHex is the real 256-bit value.
  seedReveal() {
    return this.t.isComplete()
      ? { masterSeed: this.t.masterSeed, masterSeedHex: this.t.masterSeedHex, commitSalt: this.commitSalt }
      : {};
  }

  isPaused() {
    return this.paused;
  }

  // Pause takes effect between races: the current race (if any) finishes, then
  // the scheduler idles until resume().
  pause() {
    if (this.paused || this.stopped) return;
    this.paused = true;
    this.broadcast({ type: 'paused', paused: true, serverNow: this.now() });
  }

  resume() {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    this.broadcast({ type: 'paused', paused: false, serverNow: this.now() });
    if (this._idle) {
      this._idle = false;
      this._runNext();
    }
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
    if (this.paused) {
      // Idle until resume() calls _runNext again.
      this._idle = true;
      if (this.current) this.current = { ...this.current, phase: 'paused' };
      return;
    }
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
          // Reveal: sha256(masterSeed ‖ commitSalt) must equal the `commit`
          // published in every prior snapshot — proof the master seed was
          // fixed from the start. Re-derive every course and race seed from
          // masterSeedHex + the per-race public contributions to verify results.
          commit: this.commit,
          masterSeed: this.t.masterSeed,
          masterSeedHex: this.t.masterSeedHex,
          commitSalt: this.commitSalt,
          serverNow: this.now(),
        });
        // Endless mode: hold on the champion for the intermission, then hand
        // off so a fresh tournament (new seed) can start.
        if (this.cfg.onTournamentComplete) {
          this._t(() => this.cfg.onTournamentComplete(), this.cfg.intermissionMs);
        }
      }
      return;
    }
    this._announce(race);
  }

  // ---- 1. announce -----------------------------------------------------------

  _announce(race) {
    // Pick the course first: the announced trackSeed must be final (clients
    // pre-build the course during the countdown), and validating a candidate
    // requires simulating — with the PROBE seed, never a real race seed.
    this._pickTrack(race).then((ok) => {
      if (this.stopped) return;
      if (!ok) {
        // Simulator hiccup — try this race again shortly instead of stalling.
        this._t(() => this._announce(race), 15000);
        return;
      }

      const scheduledStart = this.now() + this.cfg.announceLeadMs;
      race.status = 'announced';
      race.scheduledStart = scheduledStart;
      this.current = { raceKey: race.key, phase: 'announced', scheduledStart };
      this.db.markAnnounced(race.dbId, scheduledStart, this.now());
      this._clientSeeds.clear(); // only the announced race accepts seeds
      this._clientSeeds.set(race.key, new Map());

      if (this.cfg.verbose)
        console.log(
          `[race] ${race.key} announced  track=${race.trackSeed} (candidate ${race.trackAttempt})  start in ${this.cfg.announceLeadMs}ms`
        );
      this.broadcast({
        type: 'race_announced',
        serverNow: this.now(),
        scheduledStart,
        announceLeadMs: this.cfg.announceLeadMs,
        playbackRate: this.cfg.playbackRate,
        race: this.raceView(race),
        // The public-contribution window: seeds accepted until the gate opens.
        clientSeedWindow: { closesAt: scheduledStart, maxSeeds: this.cfg.maxClientSeeds, endpoint: `/api/race/${race.key}/client-seed` },
      });

      // Fire the START at the scheduled time.
      this._t(() => this._start(race), Math.max(0, scheduledStart - this.now()));
    });
  }

  // Deterministically skip "dud" course seeds. A rare seed builds a poor course
  // where marbles jam at the start and most never finish. We require a MAJORITY
  // of the field to finish (ceil(roster/2), i.e. 3 of 5) in a probe run;
  // anything less re-rolls to the next candidate seed. Resolves true when the
  // race's trackSeed is settled, false on simulator failure.
  async _pickTrack(race) {
    const minFinishers = Math.max(1, Math.ceil(race.roster.length / 2));
    const probe = probeSeedFor(this.t.masterSeedBuf, this.tournamentId, race.key);
    try {
      for (let attempt = 0; ; attempt++) {
        const candidate = attempt === 0 ? race.trackSeed : this.t.trackSeedCandidate(race, attempt);
        const sim = await this.sim.simulate(probe, { forTrackSeed: candidate });
        if (sim.order.length >= minFinishers || attempt >= this.cfg.trackAttempts - 1) {
          if (candidate !== race.trackSeed) {
            race.trackSeed = candidate;
            if (race.dbId != null) this.db.updateRaceTrackSeed(race.dbId, candidate, attempt);
          }
          race.trackAttempt = attempt;
          return true;
        }
        console.warn(
          `[race] ${race.key} track ${candidate} is a dud (${sim.order.length}/${race.roster.length} finishers in the probe) — trying next candidate`
        );
      }
    } catch (err) {
      console.error('[scheduler] probe sim failed for', race.key, err.message);
      return false;
    }
  }

  // ---- client seeds ------------------------------------------------------------
  // One 32-byte hex seed per IP for the currently announced race, until its
  // gate opens. Returns { ok, accepted, count, reason }.
  addClientSeed(raceKey, ip, seedHex) {
    const map = this._clientSeeds.get(raceKey);
    const race = this.t.allRaces().find((r) => r.key === raceKey);
    if (!map || !race || race.status !== 'announced') return { ok: false, reason: 'window closed', count: map ? map.size : 0 };
    if (race.scheduledStart && this.now() >= race.scheduledStart) return { ok: false, reason: 'window closed', count: map.size };
    const seed = String(seedHex || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(seed)) return { ok: false, reason: 'seed must be 32 bytes as 64 hex chars', count: map.size };
    if (map.has(ip)) return { ok: true, accepted: false, reason: 'one seed per IP per race', count: map.size };
    if (map.size >= this.cfg.maxClientSeeds) return { ok: false, reason: 'window full', count: map.size };
    map.set(ip, seed);
    return { ok: true, accepted: true, count: map.size, closesAt: race.scheduledStart };
  }

  clientSeedsFor(raceKey) {
    const map = this._clientSeeds.get(raceKey);
    return map ? [...map.values()].sort() : [];
  }

  // ---- 2. start ------------------------------------------------------------------

  async _start(race) {
    if (this.stopped) return;
    // Close the window: anything arriving from here on is refused.
    const clientSeeds = this.clientSeedsFor(race.key);
    race.status = 'starting';

    // The public half. Beacon first (retried); the window's client seeds are
    // folded in either way. If the beacon can't be reached the race still runs
    // — with the last pulse we saw, honestly labelled — rather than stalling
    // the tournament. See publicSource in the payload.
    let beacon = null;
    let publicSource = 'none';
    if (this.cfg.beaconSource !== 'none') {
      for (let i = 0; i < this.cfg.beaconAttempts && !beacon; i++) {
        try {
          beacon = await this.cfg.fetchBeacon({ source: this.cfg.beaconSource, url: this.cfg.beaconUrl, timeoutMs: this.cfg.beaconTimeoutMs });
        } catch (e) {
          console.warn(`[race] ${race.key} beacon fetch ${i + 1}/${this.cfg.beaconAttempts} failed: ${e.message}`);
        }
      }
      if (beacon) {
        this._lastBeacon = beacon;
        publicSource = clientSeeds.length ? 'beacon+clients' : 'beacon';
      } else if (this._lastBeacon) {
        beacon = { ...this._lastBeacon, stale: true };
        publicSource = clientSeeds.length ? 'stale-beacon+clients' : 'stale-beacon';
      } else if (clientSeeds.length) {
        publicSource = 'clients';
      } else {
        publicSource = 'degraded'; // nothing public available — flagged for verifiers
      }
    } else {
      publicSource = clientSeeds.length ? 'clients' : 'degraded';
    }
    if (this.stopped) return;

    const pub = publicContributionFor({ beacon, clientSeeds });
    const publicContribution = pub.toString('hex');
    race.raceSeed = raceSeedFor(this.t.masterSeedBuf, this.tournamentId, race.key, pub);
    race.publicContribution = publicContribution;
    race.publicSource = publicSource;
    race.clientSeeds = clientSeeds;
    race.beacon = beacon;
    race.status = 'running';
    race.startedAt = this.now();
    this.current = { raceKey: race.key, phase: 'running', scheduledStart: race.scheduledStart };
    this.db.markStarted(race.dbId, race.startedAt, {
      raceSeed: race.raceSeed,
      publicContribution,
      publicSource,
      clientSeeds,
      beacon,
    });
    if (this.cfg.verbose)
      console.log(`[race] ${race.key} start  race=${race.raceSeed}  public=${publicContribution.slice(0, 12)}… (${publicSource}, ${clientSeeds.length} client seeds)`);

    // Broadcast first — clients begin their replay (fast-forwarding any delay
    // the beacon fetch introduced), then compute the result headlessly.
    this.broadcast({
      type: 'race_start',
      raceKey: race.key,
      trackSeed: race.trackSeed,
      raceSeed: race.raceSeed,
      publicContribution,
      publicSource,
      clientSeeds,
      beacon,
      scheduledStart: race.scheduledStart,
      startedAt: race.startedAt,
      serverNow: this.now(),
    });

    let order = null;
    try {
      const sim = await this.sim.simulate(race.raceSeed, { forTrackSeed: race.trackSeed });
      order = this._toOrder(race, sim);
    } catch (err) {
      console.error('[scheduler] sim failed for', race.key, err.message);
    }
    if (this.stopped) return;
    if (!order) {
      // Retry the sim a few times; the race is already running on clients.
      this._t(() => this._computeAndReveal(race, 1), 3000);
      return;
    }
    this._scheduleReveal(race, order);
  }

  async _computeAndReveal(race, attempt) {
    try {
      const sim = await this.sim.simulate(race.raceSeed, { forTrackSeed: race.trackSeed });
      this._scheduleReveal(race, this._toOrder(race, sim));
    } catch (err) {
      console.error('[scheduler] sim retry failed for', race.key, err.message);
      if (attempt < 5) this._t(() => this._computeAndReveal(race, attempt + 1), 5000);
    }
  }

  // Reveal once the marbles would have finished on screen (relative to the
  // scheduled start, so a slow sim never delays the reveal past the finish).
  _scheduleReveal(race, order) {
    const finishTimes = order.map((o) => o.timeSec).filter((t) => t != null);
    const maxFinish = finishTimes.length ? Math.max(...finishTimes) : this.cfg.maxSimSeconds;
    const watchMs =
      this.cfg.watchOverrideMs != null
        ? this.cfg.watchOverrideMs
        : Math.ceil((maxFinish * 1000) / this.cfg.playbackRate) + this.cfg.revealBufferMs;
    const revealAt = (race.startedAt || race.scheduledStart) + watchMs;
    this._t(() => this._reveal(race, order), Math.max(0, revealAt - this.now()));
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

  // ---- 4. reveal ---------------------------------------------------------------------

  _reveal(race, order) {
    this.t.applyResult(race, order);
    race.status = 'done';
    this.db.saveResult(race.dbId, order, this.now());
    this.current = { raceKey: race.key, phase: 'revealed', scheduledStart: race.scheduledStart };
    const w = race.result[0];
    if (this.cfg.verbose) console.log(`[race] ${race.key} result  winner=${w.marbleName} (${w.lane})`);

    this.broadcast({
      type: 'race_result',
      serverNow: this.now(),
      raceKey: race.key,
      result: race.result,
      // Everything needed to re-derive raceSeed and replay the race.
      trackSeed: race.trackSeed,
      raceSeed: race.raceSeed,
      publicContribution: race.publicContribution,
      publicSource: race.publicSource,
      clientSeeds: race.clientSeeds || [],
      beacon: race.beacon || null,
      standings: this.standings(),
    });

    // Continue after a short gap.
    this._t(() => this._runNext(), this.cfg.interRaceGapMs);
  }

  // ---- views ------------------------------------------------------------

  raceView(race) {
    const status = race.status || 'pending';
    const done = !!race.result;
    // Seed disclosure ladder — a race's seeds go public only as late as the
    // clients actually need them:
    //   • pending   → neither seed (nothing to reveal yet).
    //   • announced → trackSeed only, so clients pre-build the course during
    //                 the countdown. The course alone doesn't decide a winner.
    //   • running/done → raceSeed + the public contribution it was derived
    //                 from: the gate has opened, so the outcome is now
    //                 determined and replayable/verifiable.
    const view = {
      key: race.key,
      roundKey: race.roundKey,
      roundTitle: race.roundTitle,
      indexInRound: race.indexInRound,
      status,
      scheduledStart: race.scheduledStart || null,
      roster: race.roster,
      result: race.result || null,
    };
    if (status === 'announced' || status === 'starting' || status === 'running' || status === 'done' || done) {
      view.trackSeed = race.trackSeed;
      view.trackAttempt = race.trackAttempt || 0;
    }
    if (status === 'running' || status === 'done' || done) {
      view.raceSeed = race.raceSeed;
      view.publicContribution = race.publicContribution || null;
      view.publicSource = race.publicSource || null;
      view.clientSeeds = race.clientSeeds || [];
      view.beacon = race.beacon || null;
    }
    return view;
  }

  // Who is still in contention. A marble is 'alive' while its furthest-reached
  // race is unresolved, or when it WON that race (it advances — the next round
  // just hasn't been drawn yet), or as a semifinal runner-up until the final is
  // drawn (the fastest runner-up takes the wildcard). Anything else that has
  // finished its furthest race and isn't the champion is out. Mirrored in
  // public/tournament-core.js — keep the two in sync.
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
    const finalDrawn = this.t.rounds.some((r) => r.key === 'final');
    return this.t.marbles.map((m) => {
      let status;
      if (this.t.champion === m.id) status = 'champion';
      else {
        const race = furthest.get(m.id);
        if (!race || !race.result) status = 'alive';
        else if (race.roundKey === 'final') status = 'eliminated';
        else {
          const row = race.result.find((r) => r.marbleId === m.id);
          const rank = row ? row.rank : 99;
          if (rank === 1) status = 'alive'; // won → advances
          else if (race.roundKey === 'semis' && rank === 2 && !finalDrawn) status = 'alive'; // wildcard pending
          else status = 'eliminated';
        }
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
      paused: this.paused,
      tournament: {
        id: this.tournamentId,
        // masterSeed stays sealed behind `commit` until the tournament ends
        // (seedReveal() adds masterSeed/masterSeedHex + commitSalt only when complete).
        commit: this.commit,
        ...this.seedReveal(),
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

module.exports = { Scheduler, DEFAULTS, makeCommitment };
