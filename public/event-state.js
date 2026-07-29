'use strict';

// =========================================================
// Shared UI-state helpers — the ONE place display rules live
// =========================================================
// Loaded by the viewer (window.UIState) and unit-tested in node
// (test/ui-state.test.js) via the CommonJS export at the bottom.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UIState = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // The authoritative event states. Every component reads these — nothing
  // infers "what is happening" on its own.
  const EVENT_STATES = [
    'LOADING',
    'BETWEEN_RACES',
    'COUNTDOWN',
    'STARTING',
    'LIVE',
    'DELAYED',
    'RECONNECTING',
    'OFFLINE',
    'TOURNAMENT_COMPLETE',
  ];

  // MM:SS below an hour, H:MM:SS above. Clamped — never negative.
  function fmtClock(ms) {
    const n = Number(ms);
    const s = Math.max(0, Math.ceil((Number.isFinite(n) ? n : 0) / 1000));
    const two = (v) => String(v).padStart(2, '0');
    if (s >= 3600) return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
    return `${two(Math.floor(s / 60))}:${two(s % 60)}`;
  }

  // The countdown's primary line. ALWAYS returns a non-empty user-facing
  // string — no empty strings, nulls, dashes or negative times, whatever the
  // inputs. `nextRaceAt` is an epoch-ms timestamp in the viewer's local clock
  // (already server-offset adjusted); anything unparseable counts as unknown.
  function getNextRaceDisplay({ eventState, nextRaceAt, now }) {
    switch (eventState) {
      case 'TOURNAMENT_COMPLETE':
        return 'Tournament complete';
      case 'RECONNECTING':
        return 'Reconnecting…';
      case 'OFFLINE':
        return 'Live race unavailable';
      case 'DELAYED':
        return 'Race delayed';
      case 'LIVE':
        return 'Race in progress';
      case 'STARTING':
        return 'Starting now…';
    }
    // LOADING / BETWEEN_RACES / COUNTDOWN (and anything unexpected): show a
    // real countdown when we have a valid future timestamp, else a friendly
    // fallback.
    // Strict: only a real finite number counts as a timestamp (Number(null)
    // would coerce to 0 and read as a long-past date).
    const at = typeof nextRaceAt === 'number' && Number.isFinite(nextRaceAt) ? nextRaceAt : NaN;
    const t = typeof now === 'number' && Number.isFinite(now) ? now : NaN;
    if (!Number.isFinite(at) || !Number.isFinite(t)) return 'Starting shortly…';
    const rem = at - t;
    if (rem <= 0) return 'Starting now…';
    if (rem <= 5000) return 'Starting now…';
    return `Next race in ${fmtClock(rem)}`;
  }

  // Viewer count: show only a real, double-digit audience. A tiny or unknown
  // count is hidden entirely (never faked, never placeholder).
  function shouldShowViewerCount(viewerCount) {
    return Number.isFinite(viewerCount) && viewerCount >= 10;
  }

  return { EVENT_STATES, fmtClock, getNextRaceDisplay, shouldShowViewerCount };
});
