'use strict';

// =========================================================
// TV director — the auto-camera's shot selection, as a pure module
// =========================================================
// Decides WHICH camera the broadcast should be on, given what is happening in
// the race. It never touches the game or the DOM: the viewer feeds it a small
// context each tick and applies the cut it returns. Everything tunable lives
// in RULES, and the whole thing is unit-tested in node (test/tv-director.test.js)
// via the CommonJS export at the bottom (window.TvDirector in the browser).
//
// Shot vocabulary (the game's camera modes):
//   overview  — wide establishing shot of the whole course
//   action    — tracking cam on the front of the race
//   chase     — behind-the-marble cam; rides the viewer's marble when they have
//               one in the race, otherwise the leader
//   reverse   — planted ahead of the leader looking back at the chasing pack
//   trackside — fixed broadcast camera the pack rolls past
//
// Phases, in race order:
//   idle      — no race on the stage → wide shot
//   gate      — the first moments after the gate opens → hold the wide shot
//   early     — the scramble off the line → action
//   pack      — tight racing → action, with trackside / reverse variety
//   breakaway — one marble clear → ride it, then face it
//   finish    — the leader is closing on the line → finish-oriented shots
//   results   — someone's home → linger on the finish, then go wide

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TvDirector = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const RULES = {
    minShotMs: 5000, // a shot is never shorter than this (no flicker)
    phaseCutMs: 3000, // …except when the phase itself changes (gate → early)
    varietyMs: 9500, // rotate within a phase's shot set after this long
    gateHoldMs: 3800, // establishing wide shot after the gate opens
    earlyUntil: 0.1, // leader progress below which we're "off the line"
    finishFrom: 0.86, // leader progress from which the finish shots take over
    breakawayGap: 0.07, // leader-minus-second progress that counts as a breakaway
    followEveryMs: 20000, // guarantee a cut to the viewer's marble this often…
    followHoldMs: 6500, // …and hold it this long
    followMinPos: 0.06, // …but not in the gate scramble
    resultsLingerMs: 6500, // hold the finish after the last result, then go wide
    idleCutMs: 4000, // between races, wait this long before resetting to wide
    idleShot: 'overview',
    phases: {
      idle: ['overview'],
      gate: ['overview'],
      early: ['action'],
      pack: ['action', 'trackside', 'reverse'],
      breakaway: ['chase', 'reverse', 'action'],
      finish: ['action', 'reverse'],
      results: ['action'],
    },
    // Modes the director must never override — the viewer chose them on purpose.
    handsOff: ['blast', 'split', 'close'],
  };

  // Work out the race phase from the live progress list.
  //   ctx.prog: [{ lane, pos (0..1), finished }]
  function phaseOf(ctx, rules) {
    if (!ctx.live && !ctx.replaying) return 'idle';
    const prog = ctx.prog || [];
    if (ctx.resultAt || (prog.length && prog.every((p) => p.finished))) return 'results';
    if (typeof ctx.raceElapsedMs === 'number' && ctx.raceElapsedMs < rules.gateHoldMs) return 'gate';
    const act = prog.filter((p) => !p.finished).sort((a, b) => b.pos - a.pos);
    if (!act.length) return prog.length ? 'results' : 'gate';
    const leader = act[0];
    if (leader.pos < rules.earlyUntil) return 'early';
    if (leader.pos > rules.finishFrom || prog.some((p) => p.finished)) return 'finish';
    const gap = act.length > 1 ? leader.pos - act[1].pos : 1;
    return gap > rules.breakawayGap ? 'breakaway' : 'pack';
  }

  class Director {
    constructor(rules) {
      this.rules = Object.assign({}, RULES, rules || {});
      this.reset();
    }
    reset() {
      this.lastCutAt = 0;
      this.lastFollowAt = 0;
      this.followHoldUntil = 0;
      this.phase = 'idle';
      this.unsupported = new Set(); // shots the game refused (stale build)
    }
    // Tell the director a requested shot didn't take, so it stops asking.
    markUnsupported(shot) {
      this.unsupported.add(shot);
    }
    // ctx: { now, cam, live, replaying, raceElapsedMs, prog, followLane, resultAt }
    // Returns { cut: shot|null, phase }. `cut` is the camera to switch to, or
    // null to leave the current shot alone.
    decide(ctx) {
      const r = this.rules;
      const now = ctx.now;
      const cam = ctx.cam || 'overview';
      if (r.handsOff.includes(cam)) return { cut: null, phase: this.phase };
      const phase = phaseOf(ctx, r);
      const phaseChanged = phase !== this.phase;
      this.phase = phase;
      const since = now - this.lastCutAt;

      if (phase === 'idle') {
        this.followHoldUntil = 0;
        if (cam !== r.idleShot && since >= r.idleCutMs) return this._cut(r.idleShot, now, phase);
        return { cut: null, phase };
      }

      // Results: linger on the finish, then reset to the wide shot.
      if (phase === 'results') {
        const linger = ctx.resultAt ? now - ctx.resultAt : 0;
        if (cam !== r.idleShot && ctx.resultAt && linger >= r.resultsLingerMs && since >= r.minShotMs) {
          return this._cut(r.idleShot, now, phase);
        }
        if (cam === r.idleShot && !ctx.resultAt && since >= r.phaseCutMs) {
          return this._cut(r.phases.results[0], now, phase); // marbles finishing on a wide shot — go in
        }
        return { cut: null, phase };
      }

      // Holding a "your marble" shot: nothing interrupts it except the finish.
      if (now < this.followHoldUntil && phase !== 'finish') return { cut: null, phase };

      let set = (r.phases[phase] || ['action']).filter((s) => !this.unsupported.has(s));
      if (!set.length) set = ['action'];

      // Guarantee the viewer's marble gets its own shot every so often while
      // the race is on. `chase` rides the follow lane when one is set.
      if (
        ctx.followLane &&
        (phase === 'early' || phase === 'pack' || phase === 'breakaway') &&
        !this.unsupported.has('chase') &&
        now - this.lastFollowAt >= r.followEveryMs &&
        since >= r.minShotMs
      ) {
        const mine = (ctx.prog || []).find((p) => p.lane === ctx.followLane);
        if (mine && !mine.finished && mine.pos >= r.followMinPos) {
          this.lastFollowAt = now;
          this.followHoldUntil = now + r.followHoldMs;
          if (cam !== 'chase') return this._cut('chase', now, phase);
          this.lastCutAt = now; // already on it — just hold
          return { cut: null, phase };
        }
      }

      if (!set.includes(cam)) {
        // Phase change: cut to the phase's lead shot once the current shot has
        // had its minimum time (shorter allowance when the situation changed).
        const need = phaseChanged ? r.phaseCutMs : r.minShotMs;
        if (since >= need) return this._cut(set[0], now, phase);
        return { cut: null, phase };
      }
      // Variety inside a phase: rotate through the set, never before varietyMs.
      if (set.length > 1 && since >= r.varietyMs) {
        return this._cut(set[(set.indexOf(cam) + 1) % set.length], now, phase);
      }
      return { cut: null, phase };
    }
    _cut(shot, now, phase) {
      this.lastCutAt = now;
      return { cut: shot, phase };
    }
  }

  return { RULES, Director, phaseOf };
});
