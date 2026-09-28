'use strict';

// The print builder's separated states (public/print-state.js): what the
// status line and the preview area say, where raw errors go, and when
// downloads are offered — geometry, preview, export and staleness apart.

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
  assert.strictEqual(P.previewStatus(s), null);
});

check('geometry ok + preview ok: the plain success line', () => {
  const s = { geometry: 'ok', preview: 'ok', seed: 1304791718, pieces: 385 };
  assert.deepStrictEqual(P.printStatus(s), { level: 'ok', text: 'Track generated — 385 printable pieces.', detail: '' });
  assert.strictEqual(P.exportReady(s), true);
  assert.strictEqual(P.previewStatus(s), null);
});

check('geometry ok + preview failed: the same success line; the preview explains itself; raw error only as detail', () => {
  const s = { geometry: 'ok', preview: 'failed', seed: 7, pieces: 385, previewError: 'Error creating WebGL context.' };
  assert.deepStrictEqual(P.printStatus(s), { level: 'ok', text: 'Track generated — 385 printable pieces.', detail: '' });
  assert.deepStrictEqual(P.previewStatus(s), { text: '3D preview is unavailable in this browser. Your pieces are ready to download.', detail: 'Error creating WebGL context.' });
  assert.strictEqual(P.exportReady(s), true, 'downloads stay available when only the preview fails');
});

check('geometry failed: an error line, the raw cause as detail, nothing to download regardless of stale counts', () => {
  const s = { geometry: 'failed', preview: 'ok', seed: 7, pieces: 385, error: 'course build threw' };
  const r = P.printStatus(s);
  assert.strictEqual(r.level, 'error');
  assert.ok(r.text.startsWith('Build failed') && r.text.includes('nothing to download') && !r.text.includes('course build threw'));
  assert.strictEqual(r.detail, 'course build threw');
  assert.strictEqual(P.exportReady(s), false);
});

check('a changed seed makes the build stale: rebuild before exporting', () => {
  const s = { geometry: 'ok', preview: 'ok', seed: 7, pieces: 385, stale: true };
  assert.deepStrictEqual(P.printStatus(s), { level: 'stale', text: 'Settings changed — rebuild to update your pieces.', detail: '' });
  assert.strictEqual(P.exportReady(s), false);
});

check('an export failure is its own state: pieces kept, downloads still offered', () => {
  const s = { geometry: 'ok', preview: 'ok', seed: 7, pieces: 385, exportError: 'zip too large' };
  const r = P.printStatus(s);
  assert.strictEqual(r.level, 'error');
  assert.ok(r.text.startsWith('Export failed') && r.detail === 'zip too large');
  assert.strictEqual(P.exportReady(s), true);
});

check('zero pieces is not exportable; one piece is singular', () => {
  assert.strictEqual(P.exportReady({ geometry: 'ok', preview: 'ok', pieces: 0 }), false);
  assert.strictEqual(P.printStatus({ geometry: 'ok', preview: 'ok', seed: 1, pieces: 1 }).text, 'Track generated — 1 printable piece.');
  assert.strictEqual(P.printStatus({ geometry: 'idle', preview: 'idle' }).level, 'idle');
});

console.log(`\n${passed} checks passed`);
