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

async function createSimulator({ url, trackSeed, headless = true, readyTimeoutMs = 30000 }) {
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

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(
      () => window.marbleAPI && typeof window.marbleAPI.simulateRace === 'function',
      { timeout: readyTimeoutMs }
    );
  } catch (err) {
    // Dump what the page actually did so a headless failure is diagnosable from
    // the server logs instead of a bare TimeoutError.
    const probe = await page
      .evaluate(() => ({
        marbleAPI: typeof window.marbleAPI,
        simulateRace: window.marbleAPI ? typeof window.marbleAPI.simulateRace : 'n/a',
        THREE: typeof window.THREE,
        headlessNoGL: !!window.__headlessNoGL,
        readyState: document.readyState,
      }))
      .catch((e) => ({ probeError: e.message }));
    console.error('[sim] marbleAPI never became ready. probe:', JSON.stringify(probe));
    console.error('[sim] page errors:', JSON.stringify(consoleErrors));
    console.error('[sim] last page console:', JSON.stringify(consoleLog.slice(-15)));
    throw err;
  }

  // Build the shared course once.
  await page.evaluate((t) => window.marbleAPI.newCourse(t), trackSeed >>> 0);

  let currentTrack = trackSeed >>> 0;

  return {
    consoleErrors,

    // Rebuild the course for a different track seed (each race has its own).
    async setCourse(t) {
      currentTrack = t >>> 0;
      await page.evaluate((tt) => window.marbleAPI.newCourse(tt), currentTrack);
    },

    // Run one race headlessly. Returns:
    //   { trackSeed, raceSeed, complete, order: [{ lane, color, timeSec }, ...] }
    // where `order` is rank 1..5 and `lane` is the color-lane name
    // (RED/BLUE/GREEN/YELLOW/CREAM) the game assigns.
    async simulate(raceSeed, { forTrackSeed } = {}) {
      if (forTrackSeed !== undefined && (forTrackSeed >>> 0) !== currentTrack) {
        await this.setCourse(forTrackSeed);
      }
      const res = await page.evaluate((r) => window.marbleAPI.simulateRace(r), raceSeed >>> 0);
      return {
        trackSeed: res.trackSeed >>> 0,
        raceSeed: res.raceSeed >>> 0,
        complete: res.complete,
        order: res.results.map((x) => ({
          lane: x.name, // RED/BLUE/GREEN/YELLOW/CREAM
          color: x.color,
          timeSec: x.timeSec,
        })),
      };
    },

    async close() {
      await browser.close();
    },
  };
}

module.exports = { createSimulator };
