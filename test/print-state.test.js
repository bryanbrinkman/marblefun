'use strict';

// The print builder's separated states (public/print-state.js): what the
// status line says and when downloads are offered, for every combination of
// geometry and preview outcomes.

const assert = require('node:assert');
const P = require('../public/print-state.js');

let passed = 0;
function check(name, fn) {
  fn();
  console.log('  ✅ ' + name);
  passed++;
}

console.log('Print-state tests\n');

check('building: a loading line, no downloads', () => {
  const s = { geometry: 'building', preview: 'idle', seed: 7, pieces: 0 };
  assert.strictEqual(P.printStatus(s).level, 'loading');
  assert.strictEqual(P.exportReady(s), false);
});

check('geometry ok + preview ok: success with the piece count', () => {
  const s = { geometry: 'ok', preview: 'ok', seed: 1304791718, pieces: 385 };
  assert.deepStrictEqual(P.printStatus(s), { level: 'ok', text: 'Track 1304791718 generated — 385 printable pieces.' });
  assert.strictEqual(P.exportReady(s), true);
});

check('geometry ok + preview failed: partial success, downloads still offered', () => {
  const s = { geometry: 'ok', preview: 'failed', seed: 7, pieces: 385, previewError: 'Error creating WebGL context' };
  const r = P.printStatus(s);
  assert.strictEqual(r.level, 'partial');
  assert.ok(r.text.startsWith('Track 7 generated — 385 printable pieces. 3D preview unavailable (Error creating WebGL context)'), r.text);
  assert.ok(!/failed/i.test(r.text), 'a working build is never reported as a failed build');
  assert.strictEqual(P.exportReady(s), true);
});

check('geometry failed: an error, and nothing to download regardless of stale counts', () => {
  const s = { geometry: 'failed', preview: 'ok', seed: 7, pieces: 385, error: 'course build threw' };
  const r = P.printStatus(s);
  assert.strictEqual(r.level, 'error');
  assert.ok(r.text.includes('Build failed: course build threw') && r.text.includes('nothing to download'));
  assert.strictEqual(P.exportReady(s), false);
});

check('zero pieces is not exportable; one piece is singular', () => {
  assert.strictEqual(P.exportReady({ geometry: 'ok', preview: 'ok', pieces: 0 }), false);
  assert.strictEqual(P.printStatus({ geometry: 'ok', preview: 'ok', seed: 1, pieces: 1 }).text, 'Track 1 generated — 1 printable piece.');
  assert.strictEqual(P.printStatus({ geometry: 'idle', preview: 'idle' }).level, 'idle');
});

console.log(`\n${passed} checks passed`);
