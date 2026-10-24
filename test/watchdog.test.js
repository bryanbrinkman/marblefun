'use strict';

// The stall watchdog (src/watchdog.js) with fakes: no browser, no timers.

const assert = require('node:assert');
const { createWatchdog } = require('../src/watchdog');

let passed = 0;
async function check(name, fn) {
  await fn();
  console.log('  ✅ ' + name);
  passed++;
}

function harness({ launchOk = true, stallMs = 1000 } = {}) {
  let clock = 1_000_000;
  const logs = [];
  const exits = [];
  let sim = { closed: 0, wedged: false, isWedged() { return this.wedged; }, async close() { this.closed++; } };
  const sched = { stopped: false, st: { phase: 'running', raceKey: 'heats:3', sinceProgressMs: 0, paused: false, complete: false }, sims: [], recovered: 0,
    status() { return this.st; }, setSimulator(s) { this.sims.push(s); }, recover() { this.recovered++; } };
  let launches = 0;
  let ok = launchOk;
  const wd = createWatchdog({
    stallMs, launchBackoffMs: 5000, maxLaunchFailures: 2, closeTimeoutMs: 50,
    now: () => clock,
    log: (...a) => logs.push(a.join(' ')),
    exit: (code) => exits.push(code),
    getSimulator: () => sim, setSimulator: (s) => { sim = s; }, getScheduler: () => sched,
    launch: async () => { launches++; if (!ok) throw new Error('browserType.launch: Timeout 180000ms exceeded.\nCall log: ...'); return { fresh: true, closed: 0, isWedged: () => false, async close() { this.closed++; } }; },
  });
  return { wd, logs, exits, sched, get sim() { return sim; }, set sim(v) { sim = v; }, advance: (ms) => { clock += ms; }, launches: () => launches, setLaunchOk: (v) => { ok = v; } };
}

(async () => {
  console.log('watchdog tests\n');

  await check('a healthy, moving pipeline is left alone', async () => {
    const h = harness();
    assert.strictEqual(await h.wd.tick(), null);
    assert.strictEqual(h.launches(), 0);
  });

  await check('a wedged simulator is replaced at once and the scheduler recovered in place', async () => {
    const h = harness();
    const old = h.sim;
    old.wedged = true;
    const why = await h.wd.tick();
    assert.strictEqual(why, 'simulator call timed out');
    assert.strictEqual(old.closed, 1, 'the old browser was closed');
    assert.ok(h.sim && h.sim.fresh, 'a fresh simulator is in place');
    assert.deepStrictEqual(h.sched.sims, [h.sim]);
    assert.strictEqual(h.sched.recovered, 1);
    assert.strictEqual(h.wd.state.relaunches, 1);
  });

  await check('no progress past the stall limit triggers a relaunch; paused or finished tournaments do not', async () => {
    const h = harness({ stallMs: 1000 });
    h.sched.st.sinceProgressMs = 1500;
    assert.match(await h.wd.tick(), /no tournament progress for 2 s \(phase running, race heats:3\)/);
    h.sched.st.sinceProgressMs = 99999;
    h.sched.st.paused = true;
    assert.strictEqual(await h.wd.tick(), null, 'paused: nothing to do');
    h.sched.st.paused = false;
    h.sched.st.complete = true;
    assert.strictEqual(await h.wd.tick(), null, 'complete: nothing to do');
  });

  await check('a failed launch backs off, and a second failure in a row exits the process for a clean restart', async () => {
    const h = harness({ launchOk: false });
    h.sim.wedged = true;
    await h.wd.tick();
    assert.strictEqual(h.launches(), 1);
    assert.strictEqual(h.sim, null, 'no simulator until a launch works');
    assert.strictEqual(h.wd.state.launchFailures, 1);
    assert.deepStrictEqual(h.exits, [], 'one failure: keep going');
    // Inside the back-off window nothing is tried, however bad things look.
    await h.wd.tick();
    assert.strictEqual(h.launches(), 1, 'no launch during back-off');
    h.advance(5001);
    await h.wd.tick();
    assert.strictEqual(h.launches(), 2);
    assert.deepStrictEqual(h.exits, [1], 'second failure in a row: exit(1)');
    assert.ok(h.logs.some((l) => /giving up on this process/.test(l)));
  });

  await check('a launch that works after a failure resets the failure count', async () => {
    const h = harness({ launchOk: false });
    h.sim.wedged = true;
    await h.wd.tick();
    assert.strictEqual(h.wd.state.launchFailures, 1);
    // Now launches work again.
    h.setLaunchOk(true);
    h.advance(5001);
    await h.wd.tick();
    assert.strictEqual(h.wd.state.launchFailures, 0);
    assert.deepStrictEqual(h.exits, []);
  });

  await check('a tick while a relaunch is in flight is a no-op', async () => {
    const h = harness();
    h.sim.wedged = true;
    const p = h.wd.tick();
    assert.strictEqual(await h.wd.tick(), null);
    await p;
    assert.strictEqual(h.launches(), 1);
  });

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error('  ❌', e.message); process.exit(1); });
