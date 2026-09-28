'use strict';

// =========================================================
// Headless simulator — runs the REAL game deterministically
// =========================================================
// Loads the actual marble_run.html in a headless Chromium (Playwright) and
// drives window.marbleAPI. Because the server computes results from the exact
// same code the viewer replays, the recorded result is guaranteed to match
// what every client sees on screen.
//
// One browser + page is reused for the whole tournament. Each race builds its
// own course (via setCourse for the race's trackSeed) and then calls
// simulateRace(raceSeed), which fast-forwards the physics with no rendering.

// Playwright is installed globally in this environment; fall back to the
// well-known global path if a local require can't resolve it.
function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return require('/opt/node22/lib/node_modules/playwright');
  }
}

async function createSimulator({ url, trackSeed, courseGen = 1, headless = true, readyTimeoutMs = 30000 }) {
  const { chromium } = loadPlaywright();
  // --no-sandbox / --disable-dev-shm-usage are required to run Chromium as root
  // in a container with a tiny /dev/shm (else it won't start). No WebGL flags
  // needed: the sim is pure physics and the game falls back to a no-op renderer
  // when WebGL is unavailable (see the WebGLRenderer try/catch in marble_run.html).
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  const consoleErrors = [];
  const consoleLog = [];
  page.on('pageerror', (e) => {
    consoleErrors.push(e.message);
    console.error('[sim/page error]', e.message);
  });
  page.on('console', (m) => consoleLog.push(m.type() + ': ' + m.text()));
  page.on('requestfailed', (r) =>
    console.error('[sim/req failed]', r.url(), r.failure() && r.failure().errorText)
  );

  // Force the no-WebGL, physics-only path. Playwright's Chromium enables
  // software WebGL (SwiftShader) by default, which "works" but renders the
  // whole 3D scene on the CPU — on a small VM the course build took minutes
  // and the kernel OOM-killed Chromium. Refusing WebGL contexts makes the game
  // fall back to its no-op renderer: pure physics, identical results, seconds.
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (/webgl/i.test(String(type))) return null;
      return orig.call(this, type, ...rest);
    };
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(
      () => window.marbleAPI && typeof window.marbleAPI.simulateRace === 'function',
      { timeout: readyTimeoutMs }
    );
  } catch (err) {
    // Dump what the page actually did so a headless failure is diagnosable from
    // the server logs instead of a bare TimeoutError.
    // The page may be wedged in long-running script, which would hang
    // page.evaluate (and with it the whole fallback path) — bound the probe.
    const probe = await Promise.race([
      page
        .evaluate(() => ({
          marbleAPI: typeof window.marbleAPI,
          simulateRace: window.marbleAPI ? typeof window.marbleAPI.simulateRace : 'n/a',
          THREE: typeof window.THREE,
          headlessNoGL: !!window.__headlessNoGL,
          readyState: document.readyState,
        }))
        .catch((e) => ({ probeError: e.message })),
      new Promise((resolve) => setTimeout(() => resolve({ probeError: 'probe timed out (page busy)' }), 5000)),
    ]);
    console.error('[sim] marbleAPI never became ready. probe:', JSON.stringify(probe));
    console.error('[sim] page errors:', JSON.stringify(consoleErrors));
    console.error('[sim] last page console:', JSON.stringify(consoleLog.slice(-15)));
    throw err;
  }

  // A course is (trackSeed, courseGen): the generation says which version of
  // the course generator built it, so a race recorded under an older
  // generation replays on exactly the course it ran on. Records from before
  // generations existed are generation 1 — the default whenever a caller
  // doesn't say.
  const normGen = (g) => (g == null || !Number.isFinite(Number(g)) ? 1 : Math.max(1, Math.round(Number(g))));

  // Build the shared course once.
  let currentTrack = trackSeed >>> 0;
  let currentGen = normGen(courseGen);
  await page.evaluate(([t, g]) => window.marbleAPI.newCourse(t, g), [currentTrack, currentGen]);

  const sameCourse = (t, g) => t === undefined || ((t >>> 0) === currentTrack && normGen(g) === currentGen);

  return {
    consoleErrors,

    // Rebuild the course for a different track seed (each race has its own).
    async setCourse(t, gen) {
      currentTrack = t >>> 0;
      currentGen = normGen(gen);
      await page.evaluate(([tt, g]) => window.marbleAPI.newCourse(tt, g), [currentTrack, currentGen]);
    },

    // Facts about a candidate course without racing it — cheap (a course
    // build, no physics). `finishClear` is false when the finish line / podium
    // would sit inside a block column; hosts skip such seeds.
    async courseInfo(forTrackSeed, courseGen) {
      if (!sameCourse(forTrackSeed, courseGen)) await this.setCourse(forTrackSeed, courseGen);
      const info = await page.evaluate(() => (window.marbleAPI.courseInfo ? window.marbleAPI.courseInfo() : null));
      return { trackSeed: currentTrack, courseGen: currentGen, finishClear: !(info && info.finishClear === false), splitMerge: info ? info.splitMerge || null : null };
    },

    // Run one race headlessly. Returns:
    //   { trackSeed, courseGen, raceSeed, complete, order: [{ lane, color, timeSec }, ...] }
    // where `order` is rank 1..5 and `lane` is the color-lane name
    // (RED/BLUE/GREEN/YELLOW/CREAM) the game assigns.
    async simulate(raceSeed, { forTrackSeed, courseGen } = {}) {
      if (!sameCourse(forTrackSeed, courseGen)) await this.setCourse(forTrackSeed, courseGen);
      const res = await page.evaluate((r) => window.marbleAPI.simulateRace(r), raceSeed >>> 0);
      return {
        trackSeed: res.trackSeed >>> 0,
        courseGen: currentGen,
        raceSeed: res.raceSeed >>> 0,
        complete: res.complete,
        // Older game builds don't report it — treat as clear.
        finishClear: res.finishClear !== false,
        order: res.results.map((x) => ({
          lane: x.name, // RED/BLUE/GREEN/YELLOW/CREAM
          color: x.color,
          timeSec: x.timeSec,
        })),
      };
    },

    // A fresh page in the same browser for side jobs (e.g. rendering marble
    // thumbnails). Unlike the sim page it has ordinary canvas/WebGL access.
    async openPage() {
      return browser.newPage();
    },

    async close() {
      await browser.close();
    },
  };
}

module.exports = { createSimulator };
