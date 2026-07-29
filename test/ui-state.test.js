'use strict';

// Unit tests for the shared UI-state helpers (public/event-state.js):
// countdown display strings and viewer-count visibility. Fast, node-only.

const assert = require('node:assert');
const { fmtClock, getNextRaceDisplay, shouldShowViewerCount } = require('../public/event-state.js');

let passed = 0;
function check(name, fn) {
  fn();
  console.log('  ✅ ' + name);
  passed++;
}

console.log('UI-state tests\n');

const NOW = 1_700_000_000_000;
const disp = (eventState, nextRaceAt, now = NOW) => getNextRaceDisplay({ eventState, nextRaceAt, now });

check('valid future start time → "Next race in MM:SS"', () => {
  assert.strictEqual(disp('COUNTDOWN', NOW + 42_000), 'Next race in 00:42');
  assert.strictEqual(disp('BETWEEN_RACES', NOW + 42_000), 'Next race in 00:42');
});

check('over an hour → H:MM:SS', () => {
  assert.strictEqual(disp('COUNTDOWN', NOW + 3_723_000), 'Next race in 1:02:03');
});

check('five seconds away → "Starting now…"', () => {
  assert.strictEqual(disp('COUNTDOWN', NOW + 5_000), 'Starting now…');
  assert.strictEqual(disp('STARTING', NOW + 3_000), 'Starting now…');
});

check('past timestamp → "Starting now…" (never negative)', () => {
  assert.strictEqual(disp('COUNTDOWN', NOW - 10_000), 'Starting now…');
});

check('null timestamp → "Starting shortly…"', () => {
  assert.strictEqual(disp('BETWEEN_RACES', null), 'Starting shortly…');
});

check('undefined timestamp → "Starting shortly…"', () => {
  assert.strictEqual(disp('BETWEEN_RACES', undefined), 'Starting shortly…');
});

check('invalid date string → "Starting shortly…"', () => {
  assert.strictEqual(disp('COUNTDOWN', 'not-a-date'), 'Starting shortly…');
  assert.strictEqual(disp('COUNTDOWN', NaN), 'Starting shortly…');
});

check('delayed state → "Race delayed"', () => {
  assert.strictEqual(disp('DELAYED', NOW + 42_000), 'Race delayed');
});

check('reconnecting state → "Reconnecting…"', () => {
  assert.strictEqual(disp('RECONNECTING', null), 'Reconnecting…');
});

check('offline state → "Live race unavailable"', () => {
  assert.strictEqual(disp('OFFLINE', null), 'Live race unavailable');
});

check('tournament complete → "Tournament complete"', () => {
  assert.strictEqual(disp('TOURNAMENT_COMPLETE', null), 'Tournament complete');
});

check('never an em dash, empty string, or negative value', () => {
  const states = ['LOADING', 'BETWEEN_RACES', 'COUNTDOWN', 'STARTING', 'LIVE', 'DELAYED', 'RECONNECTING', 'OFFLINE', 'TOURNAMENT_COMPLETE', 'BOGUS'];
  const stamps = [null, undefined, NaN, 'junk', NOW - 99_000, NOW + 1, NOW + 5_000, NOW + 61_000, NOW + 4_000_000];
  for (const st of states)
    for (const at of stamps) {
      const out = getNextRaceDisplay({ eventState: st, nextRaceAt: at, now: NOW });
      assert.ok(typeof out === 'string' && out.length > 0, `${st}/${at} returned ${JSON.stringify(out)}`);
      assert.ok(!out.includes('—'), `${st}/${at} contained an em dash`);
      assert.ok(!/-\d/.test(out), `${st}/${at} contained a negative number`);
    }
});

check('fmtClock clamps and formats', () => {
  assert.strictEqual(fmtClock(-5000), '00:00');
  assert.strictEqual(fmtClock(0), '00:00');
  assert.strictEqual(fmtClock(59_400), '01:00'); // ceil
  assert.strictEqual(fmtClock(600_000), '10:00');
  assert.strictEqual(fmtClock(3_600_000), '1:00:00');
  assert.strictEqual(fmtClock(NaN), '00:00');
});

check('viewer count visibility thresholds', () => {
  assert.strictEqual(shouldShowViewerCount(undefined), false);
  assert.strictEqual(shouldShowViewerCount(null), false);
  assert.strictEqual(shouldShowViewerCount(NaN), false);
  assert.strictEqual(shouldShowViewerCount('12'), false); // strings are invalid
  assert.strictEqual(shouldShowViewerCount(0), false);
  assert.strictEqual(shouldShowViewerCount(1), false);
  assert.strictEqual(shouldShowViewerCount(9), false);
  assert.strictEqual(shouldShowViewerCount(10), true);
  assert.strictEqual(shouldShowViewerCount(100), true);
});

console.log(`\n${passed} checks passed`);
