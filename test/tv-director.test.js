'use strict';

// Unit tests for the TV director's shot selection (public/tv-director.js):
// phases, minimum shot lengths (no flicker), followed-marble priority, finish
// and results handling, manual-mode hands-off. Fast, node-only.

const assert = require('node:assert');
const { Director, RULES, phaseOf } = require('../public/tv-director.js');

let passed = 0;
function check(name, fn) {
  fn();
  console.log('  ✅ ' + name);
  passed++;
}

console.log('TV-director tests\n');

const P = (positions, finished = []) =>
  ['RED', 'BLUE', 'GREEN', 'YELLOW', 'CREAM'].map((lane, i) => ({
    lane,
    pos: positions[i],
    finished: finished.includes(lane),
  }));
const live = (over) => Object.assign({ now: 0, cam: 'overview', live: true, replaying: false, raceElapsedMs: 60000, prog: P([0.5, 0.49, 0.4, 0.3, 0.2]) }, over);

check('phases classify the race situation', () => {
  assert.strictEqual(phaseOf({ live: false, replaying: false }, RULES), 'idle');
  assert.strictEqual(phaseOf(live({ raceElapsedMs: 500 }), RULES), 'gate');
  assert.strictEqual(phaseOf(live({ prog: P([0.05, 0.04, 0.03, 0.02, 0.01]) }), RULES), 'early');
  assert.strictEqual(phaseOf(live(), RULES), 'pack');
  assert.strictEqual(phaseOf(live({ prog: P([0.6, 0.4, 0.3, 0.2, 0.1]) }), RULES), 'breakaway');
  assert.strictEqual(phaseOf(live({ prog: P([0.9, 0.5, 0.4, 0.3, 0.2]) }), RULES), 'finish');
  assert.strictEqual(phaseOf(live({ prog: P([1, 0.5, 0.4, 0.3, 0.2], ['RED']) }), RULES), 'finish');
  assert.strictEqual(phaseOf(live({ resultAt: 1 }), RULES), 'results');
});

check('gate opens on the wide shot, then cuts to action once the pack is moving', () => {
  const d = new Director();
  // Gate: already wide — no cut.
  assert.strictEqual(d.decide(live({ now: 1000, raceElapsedMs: 1000, prog: P([0.01, 0.01, 0, 0, 0]) })).cut, null);
  // Early phase (phase change) → action, allowed after phaseCutMs.
  const r = d.decide(live({ now: 5000, raceElapsedMs: 5000, prog: P([0.05, 0.04, 0.03, 0.02, 0.01]) }));
  assert.strictEqual(r.cut, 'action');
  assert.strictEqual(r.phase, 'early');
});

check('never flickers: a fresh shot is held for minShotMs even as the phase set rotates', () => {
  const d = new Director();
  d.decide(live({ now: 10000, prog: P([0.05, 0.04, 0.03, 0.02, 0.01]) })); // → action at t=10s
  // 2 s later the race becomes a breakaway (action is still in the set) — no rotation yet.
  assert.strictEqual(d.decide(live({ now: 12000, cam: 'action', prog: P([0.6, 0.4, 0.3, 0.2, 0.1]) })).cut, null);
  // Variety rotation only after varietyMs.
  assert.strictEqual(d.decide(live({ now: 10000 + RULES.varietyMs - 1, cam: 'action' })).cut, null);
  assert.notStrictEqual(d.decide(live({ now: 10000 + RULES.varietyMs + 1, cam: 'action' })).cut, null);
});

check('breakaway leads with the chase cam; a manual hands-off mode is never overridden', () => {
  const d = new Director();
  d.lastCutAt = -100000;
  assert.strictEqual(d.decide(live({ now: 1000, cam: 'overview', prog: P([0.6, 0.4, 0.3, 0.2, 0.1]) })).cut, 'chase');
  assert.strictEqual(d.decide(live({ now: 99999, cam: 'blast' })).cut, null);
  assert.strictEqual(d.decide(live({ now: 99999, cam: 'split' })).cut, null);
});

check('the viewer\'s marble gets a guaranteed chase shot, held for followHoldMs', () => {
  const d = new Director();
  d.lastCutAt = -100000;
  d.lastFollowAt = -100000;
  const ctx = live({ now: 50000, cam: 'action', followLane: 'YELLOW' });
  assert.strictEqual(d.decide(ctx).cut, 'chase');
  // During the hold nothing else cuts, even after varietyMs.
  assert.strictEqual(d.decide(live({ now: 50000 + RULES.followHoldMs - 100, cam: 'chase', followLane: 'YELLOW' })).cut, null);
  // Not re-triggered until followEveryMs has passed.
  const later = d.decide(live({ now: 50000 + RULES.followHoldMs + RULES.varietyMs, cam: 'action', followLane: 'YELLOW' }));
  assert.notStrictEqual(later.cut, 'chase');
});

check('finish approach switches to the finish set; results linger then reset to wide', () => {
  const d = new Director();
  d.lastCutAt = -100000;
  assert.strictEqual(d.decide(live({ now: 1000, cam: 'trackside', prog: P([0.9, 0.5, 0.4, 0.3, 0.2]) })).cut, 'action');
  // Results: linger — no cut before resultsLingerMs.
  const t0 = 100000;
  assert.strictEqual(d.decide(live({ now: t0 + 1000, cam: 'action', resultAt: t0 })).cut, null);
  assert.strictEqual(d.decide(live({ now: t0 + RULES.resultsLingerMs + 10, cam: 'action', resultAt: t0 })).cut, 'overview');
});

check('between races the stage resets to the wide shot; unsupported shots are skipped', () => {
  const d = new Director();
  d.lastCutAt = -100000;
  assert.strictEqual(d.decide({ now: 1000, cam: 'chase', live: false, replaying: false }).cut, 'overview');
  d.markUnsupported('trackside');
  d.markUnsupported('reverse');
  d.lastCutAt = -100000;
  const r = d.decide(live({ now: 5000, cam: 'action' }));
  assert.strictEqual(r.cut, null); // only 'action' left in the pack set → nothing to rotate to
});

console.log(`\n${passed} checks passed`);
