'use strict';

// =========================================================
// UI model helpers — pure display rules for the spectator UI
// =========================================================
// Everything here is DOM-free and deterministic so it can be unit-tested in
// node (test/ui-model.test.js) and shared by the viewer (window.UIModel).
// The tournament format these rules describe is the one implemented in
// src/tournament.js / public/tournament-core.js — nothing is invented here:
//   • Qualifying: 20 races of 5 → the winner of each advances (20 marbles)
//   • Semifinals: 4 races of 5 → each winner reaches the final (4) plus the
//     fastest runner-up across the four semifinals as a wildcard (5 finalists)
//   • Final: 1 race of 5 → the winner is champion, then a new tournament
//     starts with all 100 marbles back in.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UIModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const MARBLE_COUNT = 100;

  // The fixed format, in order. `count` is how many marbles enter the stage.
  const STAGES = [
    { key: 'heats', label: 'Qualifying', short: 'Qualifying', races: 20, count: 100 },
    { key: 'semis', label: 'Semifinals', short: 'Semis', races: 4, count: 20 },
    { key: 'final', label: 'Final', short: 'Final', races: 1, count: 5 },
    { key: 'champion', label: 'Champion', short: 'Champion', races: 0, count: 1 },
  ];

  // How each stage is decided — the rule from the bracket logic, in words.
  const STAGE_RULES = {
    heats: 'Twenty races of five. The winner of each race advances.',
    semis: 'Four races of five. Each winner reaches the final, and the fastest runner-up across the four semifinals takes the last place as a wildcard.',
    final: 'One race of five. The winner is the tournament champion.',
    champion: 'Then a new tournament starts, with all 100 marbles back in.',
  };

  // The stage strip: which of the fixed stages is being raced right now.
  // `activeRound` is 'heats' | 'semis' | 'final' | 'champion' | null (nothing
  // has run or been announced yet). Returns one entry per stage with a state
  // of 'done' | 'active' | 'todo' so every strip in the UI agrees.
  function stageStrip(activeRound) {
    const idx = activeRound == null ? 0 : Math.max(0, STAGES.findIndex((s) => s.key === activeRound));
    return STAGES.map((s, i) => ({
      key: s.key,
      label: s.label,
      short: s.short,
      state: i < idx ? 'done' : i === idx ? 'active' : 'todo',
    }));
  }

  // The changing participation count, kept apart from the fixed stage sizes.
  // Returns a short sentence built only from real numbers.
  function remainingLine({ standings, champion, activeRound }) {
    if (champion) return 'Champion crowned';
    if (!standings || !standings.length) return activeRound ? 'Field loading…' : `${MARBLE_COUNT} marbles enter`;
    const alive = standings.filter((m) => m.status === 'alive').length;
    if (activeRound == null || alive === MARBLE_COUNT) return `${MARBLE_COUNT} marbles enter`;
    return `${alive} marble${alive === 1 ? '' : 's'} remaining`;
  }

  // ---- your marble ----------------------------------------------------------
  // One status for the persistent card, chosen from states the data can back:
  //   champion | out | racing | next | advanced | waiting
  // Input (all plain values, computed by the viewer from its model):
  //   standing     'alive' | 'eliminated' | 'champion' | null (unknown)
  //   racingNow    the marble is in the race on the stage right now
  //   placement    its live position (1-based) when known, else null
  //   finished     it has crossed the line in that live race
  //   upNext       it is in the announced/next race (not started)
  //   nextLabel    label of that race ("Semifinal 2 of 4")
  //   lastResult   { roundKey, rank, label, dnf } of the last race it ran, or null
  //   drawnIn      { semis, final } — rounds it has already been drawn into
  //   finalDrawn   the final has been drawn (wildcard resolved)
  //   remaining    marbles still in (number) or null
  function yourMarbleStatus(c) {
    const ord = ordinal;
    if (c.standing === 'champion') return { key: 'champion', tag: 'Champion', line: 'Tournament champion' };
    if (c.standing === 'eliminated') {
      const lr = c.lastResult;
      const how = lr ? `${lr.dnf ? 'Did not finish' : ord(lr.rank)} in ${lr.label}` : 'Eliminated';
      return { key: 'out', tag: 'Out this tournament', line: `${how} · back next tournament` };
    }
    if (c.racingNow) {
      let line = 'Racing now';
      if (c.finished && c.placement) line = `Finished ${ord(c.placement)}`;
      else if (c.placement) line = `Racing now · ${ord(c.placement)}`;
      return { key: 'racing', tag: 'Racing now', line };
    }
    if (c.upNext) return { key: 'next', tag: 'Up next', line: c.nextLabel ? `Up next · ${c.nextLabel}` : 'In the next race' };
    const lr = c.lastResult;
    if (lr && lr.rank === 1) {
      const to = lr.roundKey === 'heats' ? 'the semifinals' : lr.roundKey === 'semis' ? 'the final' : null;
      if (to) return { key: 'advanced', tag: 'Advanced', line: `Won ${lr.label} · through to ${to}` };
    }
    if (lr && lr.roundKey === 'semis' && lr.rank === 2 && !c.finalDrawn) {
      return { key: 'waiting', tag: 'Waiting', line: `2nd in ${lr.label} · wildcard decided after all semifinals` };
    }
    let where = 'its qualifying race';
    if (c.drawnIn && c.drawnIn.final) where = 'the final';
    else if (c.drawnIn && c.drawnIn.semis) where = 'its semifinal';
    return { key: 'waiting', tag: 'Waiting', line: `Waiting for ${where}` };
  }

  function ordinal(n) {
    n = Number(n) || 0;
    const t = n % 100;
    return n + (t >= 11 && t <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  }

  // ---- picker ----------------------------------------------------------------
  // "Still competing" is the default while a tournament is running and the
  // field is known; otherwise (no data yet, tournament complete) "All 100".
  function defaultPickerFilter({ standings, champion }) {
    if (champion || !standings || !standings.length) return 'all';
    return standings.some((m) => m.status === 'alive') ? 'alive' : 'all';
  }

  // Filter + search. `filter` is 'alive' (still competing, including a
  // crowned champion) or 'all'. Matches number (with or without the leading
  // zero) or a case-insensitive substring of the name.
  function filterMarbles(marbles, { filter = 'all', query = '' } = {}) {
    const q = String(query || '').trim().toLowerCase();
    return (marbles || []).filter((m) => {
      if (filter === 'alive' && m.status !== 'alive' && m.status !== 'champion') return false;
      if (!q) return true;
      const id = String(m.id);
      return id === q || id.padStart(2, '0') === q || (m.name || '').toLowerCase().includes(q);
    });
  }

  // "Surprise me" draws from what the visitor is looking at, never their
  // current pick (unless it's the only option).
  function surprisePool(visible, currentId) {
    const pool = (visible || []).filter((m) => m.id !== currentId);
    return pool.length ? pool : (visible || []).slice();
  }

  // ---- 3D renderer state -------------------------------------------------------
  // loading → ready | failed; failed → loading (retry); ready → failed (a
  // later context loss); a late api_ready after a timeout recovers to ready
  // (the viewer reports gl_missing, not api_ready, when the frame has no
  // WebGL). Unknown events leave the state alone.
  function rendererNext(state, event) {
    switch (event) {
      case 'api_ready':
        return 'ready';
      case 'gl_missing':
      case 'timeout':
      case 'error':
        return 'failed';
      case 'retry':
        return 'loading';
      default:
        return state;
    }
  }

  return {
    MARBLE_COUNT,
    STAGES,
    STAGE_RULES,
    stageStrip,
    remainingLine,
    yourMarbleStatus,
    ordinal,
    defaultPickerFilter,
    filterMarbles,
    surprisePool,
    rendererNext,
  };
});
