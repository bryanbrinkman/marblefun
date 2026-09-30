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
  assert.strictEqual(phaseOf(live({ prog: P([1, 0.5, 0.4, 0.3, 0.2], ['RED']) }), RULES), 'results'); // first winner home
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
  assert.strictEqual(d.decide(live({ now: 99999, cam: 'split' })).cut, null);
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

check('finish approach switches to the finish set; the first winner home hands the stage to the podium shot for good', () => {
  const d = new Director();
  d.lastCutAt = -100000;
  assert.strictEqual(d.decide(live({ now: 1000, cam: 'trackside', prog: P([0.9, 0.5, 0.4, 0.3, 0.2]) })).cut, 'action');
  // The first marble crosses: cut to the wide shot at once (the game pushes in
  // on the podium from it), even though the last cut was a moment ago.
  const t1 = 1500;
  assert.strictEqual(d.decide(live({ now: t1, cam: 'action', prog: P([1, 0.95, 0.8, 0.6, 0.4], ['RED']) })).cut, 'overview');
  // The later finishers cross one by one: nothing cuts away from the podium.
  for (const [t, fin] of [[t1 + 2000, ['RED', 'BLUE']], [t1 + 6000, ['RED', 'BLUE', 'GREEN']], [t1 + 20000, ['RED', 'BLUE', 'GREEN', 'YELLOW']]]) {
    assert.strictEqual(d.decide(live({ now: t, cam: 'overview', prog: P([1, 1, 1, 1, 0.7], fin) })).cut, null);
  }
  // Even with the result in and the linger long over — still the podium.
  const t0 = 100000;
  assert.strictEqual(d.decide(live({ now: t0 + RULES.resultsLingerMs + 10, cam: 'overview', resultAt: t0 })).cut, null);
  assert.strictEqual(d.decide(live({ now: t0 + 1000, cam: 'action', resultAt: t0 })).cut, 'overview');
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

check('an occasional close-up: not in the opening, at most every closeEveryMs, held, never near the finish', () => {
  const d = new Director();
  d.lastCutAt = -100000;
  d.lastFollowAt = 1; // the follow guarantee is not due (now - 1 < followEveryMs) in these ticks
  // Opening seconds: no close-up even though it is "due".
  assert.notStrictEqual(d.decide(live({ now: 5000, raceElapsedMs: 5000, cam: 'overview' })).cut, 'close');
  d.lastCutAt = -100000;
  // Settled pack, past closeFirstAfterMs → the close-up.
  const r = d.decide(live({ now: 40000, raceElapsedMs: 40000, cam: 'action' }));
  assert.strictEqual(r.cut, 'close');
  // Held: nothing interrupts it inside closeHoldMs…
  assert.strictEqual(d.decide(live({ now: 42000, raceElapsedMs: 42000, cam: 'close' })).cut, null);
  // …then the director cuts back to the phase's shot.
  const back = d.decide(live({ now: 40000 + RULES.minShotMs + 1, raceElapsedMs: 46000, cam: 'close' }));
  assert.ok(back.cut && back.cut !== 'close', 'leaves the close-up after the hold');
  // Not again before closeEveryMs.
  d.lastCutAt = -100000;
  assert.notStrictEqual(d.decide(live({ now: 50000, raceElapsedMs: 50000, cam: 'action' })).cut, 'close');
  // Never once the leader is on the finish approach.
  d.lastCutAt = -100000; d.lastCloseAt = -100000;
  assert.notStrictEqual(d.decide(live({ now: 90000, raceElapsedMs: 90000, cam: 'action', prog: P([0.85, 0.5, 0.4, 0.3, 0.2]) })).cut, 'close');
  // The viewer's marble is the subject when it is racing.
  d.lastCutAt = -100000; d.lastCloseAt = -100000; d.lastFollowAt = 95000; // follow guarantee not due
  assert.strictEqual(d.decide(live({ now: 100000, raceElapsedMs: 100000, cam: 'action', followLane: 'CREAM' })).cut, 'close');
});

console.log(`\n${passed} checks passed`);
