// The print builder's states, kept apart so one failing step never speaks for
// the others: geometry (the deterministic course build → printable pieces),
// preview (the WebGL view of those pieces) and export readiness (whether the
// pieces exist to download). Pure functions; shared by print.html and the
// node tests (test/print-state.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PrintState = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // s = { geometry: 'idle'|'building'|'ok'|'failed', preview: 'idle'|'ok'|'failed',
  //       seed, pieces, error, previewError }
  function exportReady(s) {
    return s.geometry === 'ok' && Number(s.pieces) > 0;
  }
  function printStatus(s) {
    if (s.geometry === 'building') return { level: 'loading', text: 'Building the course (the same deterministic build the game runs)…' };
    if (s.geometry === 'failed') return { level: 'error', text: `Build failed${s.error ? ': ' + s.error : ''}. Nothing was generated, so there is nothing to download — try again or pick another seed.` };
    if (s.geometry === 'ok') {
      const base = `Track ${s.seed} generated — ${s.pieces} printable piece${Number(s.pieces) === 1 ? '' : 's'}.`;
      if (s.preview === 'failed') return { level: 'partial', text: `${base} 3D preview unavailable${s.previewError ? ` (${s.previewError})` : ''} — the pieces are still ready to download.` };
      if (s.preview === 'ok') return { level: 'ok', text: base };
      return { level: 'ok', text: `${base} Drawing the preview…` };
    }
    return { level: 'idle', text: '' };
  }
  return { printStatus, exportReady };
});
