#!/usr/bin/env node
'use strict';

// =========================================================
// headless_test.js — run the deterministic marble sim in Node
// =========================================================
// Demonstrates how the tournament server computes race results without any
// rendering: load the real marble_run.html in headless Chromium (Playwright)
// and drive window.marbleAPI. Same (trackSeed, raceSeed) => identical result,
// which is exactly what the viewer reproduces locally from the broadcast seeds.
//
//   node headless_test.js [trackSeed] [raceSeed]

const path = require('node:path');
const { createSimulator } = require('./src/simulator');

const trackSeed = (parseInt(process.argv[2], 10) || 123456) >>> 0;
const raceSeed = (parseInt(process.argv[3], 10) || 654321) >>> 0;
const fileUrl = 'file://' + path.join(__dirname, 'public', 'marble_run.html');

function fmt(order) {
  return order.map((o, i) => `${i + 1}. ${o.lane.padEnd(6)} ${o.timeSec.toFixed(3)}s`).join('\n   ');
}

(async () => {
  console.log(`Loading ${fileUrl}\n  trackSeed=${trackSeed}  raceSeed=${raceSeed}\n`);
  const sim = await createSimulator({ url: fileUrl, trackSeed });

  const a = await sim.simulate(raceSeed);
  console.log('Race result:\n   ' + fmt(a.order));
  console.log('   complete =', a.complete);

  // Determinism check: same seed twice must be byte-identical.
  const b = await sim.simulate(raceSeed);
  const identical = JSON.stringify(a.order) === JSON.stringify(b.order);
  console.log('\nDeterminism (same seed twice identical):', identical ? 'PASS ✅' : 'FAIL ❌');

  // A different race seed should (almost surely) reorder the field.
  const c = await sim.simulate((raceSeed ^ 0x9e3779b9) >>> 0);
  console.log('Different seed winner:', c.order[0].lane);

  await sim.close();
  process.exit(identical ? 0 : 1);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
