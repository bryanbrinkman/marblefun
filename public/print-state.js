// The print builder's states, kept apart so one failing step never speaks for
// the others: geometry (the deterministic course build → printable pieces),
// preview (the WebGL view of those pieces), export (writing STL/ZIP bytes)
// and staleness (the seed changed since the build). Pure functions; shared by
// print.html and the node tests (test/print-state.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PrintState = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // s = { geometry: 'idle'|'building'|'ok'|'failed', preview: 'idle'|'ok'|'failed',
  //       exportError, stale, seed, pieces, error, previewError }
  //
  // Pieces can be downloaded when the build produced them and nothing about
  // the requested track has changed since. Size, printer and the piece
  // options recompute the pieces on the spot, so they never make a build
  // stale; a different seed does.
  function exportReady(s) {
    return s.geometry === 'ok' && Number(s.pieces) > 0 && !s.stale;
  }
  // The one status line. `detail` is raw error text for a collapsed
  // technical disclosure — never part of the line itself.
  function printStatus(s) {
    if (s.geometry === 'building') return { level: 'loading', text: 'Building the course (the same deterministic build the game runs)…', detail: '' };
    if (s.geometry === 'failed') return { level: 'error', text: 'Build failed — nothing was generated, so there is nothing to download. Try again or pick another seed.', detail: s.error || '' };
    if (s.geometry === 'ok') {
      if (s.stale) return { level: 'stale', text: 'Settings changed — rebuild to update your pieces.', detail: '' };
      if (s.exportError) return { level: 'error', text: 'Export failed — the pieces are still generated; try the download again.', detail: s.exportError };
      return { level: 'ok', text: `Track generated — ${s.pieces} printable piece${Number(s.pieces) === 1 ? '' : 's'}.`, detail: '' };
    }
    return { level: 'idle', text: '', detail: '' };
  }
  // What the preview area says when it can't draw.
  function previewStatus(s) {
    if (s.geometry !== 'ok' || s.preview !== 'failed') return null;
    return { text: '3D preview is unavailable in this browser. Your pieces are ready to download.', detail: s.previewError || '' };
  }
  return { printStatus, previewStatus, exportReady };
});
