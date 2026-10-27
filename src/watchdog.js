'use strict';

// Stall watchdog for the tournament pipeline.
//
// The results are computed in a headless Chromium tab. That tab can stop
// answering (the live server sat on one race for a week), the browser can be
// OOM-killed, and — the failure after that — a machine so short of memory
// that a replacement browser can't even start. Each tick decides one thing:
// is the simulator healthy and the scheduler moving? If not, replace the
// simulator and recover the scheduler in place (or, when the simulator never
// came up at boot, start the tournament once it does — `onReady`). Replacing is what costs
// memory, so it backs off after a failed launch, and after a few failures in
// a row it gives up on this process entirely: exiting lets the platform
// restart the machine with a clean slate, which is the one recovery that
// always works. Pure logic — the host passes in how to launch, close, log
// and exit — so it is unit-testable without a browser.

const DEFAULTS = {
  stallMs: 10 * 60 * 1000, // no scheduler progress for this long → stalled
  launchBackoffMs: 5 * 60 * 1000, // wait this long after a failed launch
  maxLaunchFailures: 2, // consecutive failures before exiting the process
  closeTimeoutMs: 15000,
};

function createWatchdog(opts) {
  const cfg = { ...DEFAULTS, ...opts };
  const { getSimulator, setSimulator, getScheduler, launch } = cfg;
  const now = cfg.now || Date.now;
  const log = cfg.log || ((...a) => console.error('[watchdog]', ...a));
  const exit = cfg.exit || ((code) => process.exit(code));
  const state = { relaunches: 0, lastStallAt: null, lastError: null, busy: false, launchFailures: 0, nextLaunchAt: 0 };

  // Why the pipeline needs a kick right now, or null.
  function diagnose() {
    const sim = getSimulator();
    if (!sim) return 'no simulator';
    if (sim.isWedged && sim.isWedged()) return 'simulator call timed out';
    const sched = getScheduler();
    if (!sched || sched.stopped) return null;
    const st = sched.status();
    if (st.paused || st.complete) return null;
    if (st.sinceProgressMs > cfg.stallMs)
      return `no tournament progress for ${Math.round(st.sinceProgressMs / 1000)} s (phase ${st.phase}, race ${st.raceKey || '-'})`;
    return null;
  }

  async function relaunch(why) {
    state.busy = true;
    state.lastStallAt = now();
    log(`${why} — replacing the simulator and recovering the scheduler`);
    const old = getSimulator();
    setSimulator(null);
    if (old) {
      try {
        await Promise.race([old.close(), new Promise((r) => setTimeout(r, cfg.closeTimeoutMs))]);
      } catch (e) {
        log('closing the old simulator failed:', (e && e.message) || e);
      }
    }
    try {
      const sim = await launch();
      setSimulator(sim);
      state.relaunches++;
      state.launchFailures = 0;
      state.lastError = null;
      const sched = getScheduler();
      if (sched && !sched.stopped) {
        sched.setSimulator(sim);
        sched.recover();
        log('simulator replaced; scheduler resumed');
      } else if (cfg.onReady) {
        // No scheduler yet: the simulator never came up at boot, so this is
        // the first one — the host starts the tournament from it.
        log('simulator started; starting the tournament');
        cfg.onReady(sim);
      } else {
        log('simulator replaced');
      }
    } catch (e) {
      state.launchFailures++;
      state.lastError = (e && e.message) || String(e);
      state.nextLaunchAt = now() + cfg.launchBackoffMs;
      log(`could not start a new simulator (${state.launchFailures} in a row): ${state.lastError.split('\n')[0]}`);
      if (state.launchFailures >= cfg.maxLaunchFailures) {
        // The machine itself is the problem (out of memory, most likely): a
        // process that keeps trying only digs deeper. Exit and let the
        // platform's restart policy bring the machine back clean.
        log('giving up on this process so the machine is restarted clean');
        state.busy = false;
        exit(1);
        return;
      }
    } finally {
      state.busy = false;
    }
  }

  async function tick() {
    if (state.busy) return null;
    if (now() < state.nextLaunchAt) return null;
    const why = diagnose();
    if (!why) return null;
    await relaunch(why);
    return why;
  }

  return { tick, diagnose, state, cfg };
}

module.exports = { createWatchdog };
