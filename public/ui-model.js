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
  //   champion | out | racing | next | finalist | advanced | waiting
  // Input (all plain values, computed by the viewer from its model):
  //   standing     'alive' | 'eliminated' | 'champion' | null (unknown)
  //   racingNow    the marble is in the race on the stage right now
  //   placement    its live position (1-based) when known, else null
  //   finished     it has crossed the line in that live race
  //   upNext       it is in the announced/next race (not started)
  //   nextLabel    label of that race ("Semifinal 2 of 4")
  //   scheduled    { short, roundKey } — its next race with no result yet
  //                (e.g. "Qualifier 15"), when the draw is known, else null
  //   current      { short, roundKey, number } — the race running / announced
  //                now, if any (e.g. "Qualifier 6"), else null
  //   next         { short, roundKey, number } — between races: the race that
  //                comes next but isn't announced yet, else null
  //   lastResult   { roundKey, rank, label, dnf } of the last race it ran, or null
  //   drawnIn      { semis, final } — rounds it has already been drawn into
  //   finalDrawn   the final has been drawn (wildcard resolved)
  function yourMarbleStatus(c) {
    const ord = ordinal;
    if (c.standing === 'champion') return { key: 'champion', tag: 'Champion', line: 'Tournament champion' };
    if (c.standing === 'eliminated') {
      const lr = c.lastResult;
      const how = lr ? `${lr.dnf ? 'Did not finish' : ord(lr.rank)} in ${lr.label}` : 'Eliminated';
      return { key: 'out', tag: 'Out', line: `${how} · back next tournament` };
    }
    if (c.racingNow) {
      let line = 'Racing now';
      if (c.finished && c.placement) line = `Finished ${ord(c.placement)}`;
      else if (c.placement) line = `Racing now · ${ord(c.placement)}`;
      return { key: 'racing', tag: 'Racing now', line };
    }
    if (c.upNext) return { key: 'next', tag: 'Up next', line: c.nextLabel ? `Up next · ${c.nextLabel}` : 'In the next race' };
    // "Current race: 6" (or, between races, "Next race: 7") when it's the same
    // round as the scheduled race, else the other round's short label — never
    // a countdown or an estimate. Same vocabulary as the top bar's
    // "Next: Qualifier 7", so the card and the header agree between races.
    const nowBit = (sched) => {
      const r = c.current || c.next;
      if (!r) return '';
      const same = sched && r.roundKey === sched.roundKey && r.number != null;
      return ` · ${c.current ? 'Current race' : 'Next race'}: ${same ? r.number : r.short}`;
    };
    const lr = c.lastResult;
    if (c.drawnIn && c.drawnIn.final) {
      const r = c.current || c.next;
      return { key: 'finalist', tag: 'Finalist', line: `Races in the Final${r && r.roundKey !== 'final' ? nowBit(null) : ''}` };
    }
    if (c.scheduled && c.scheduled.roundKey === 'semis') {
      return { key: 'advanced', tag: 'Advanced', line: `Races in ${c.scheduled.short}${nowBit(c.scheduled)}` };
    }
    if (lr && lr.rank === 1 && lr.roundKey === 'heats') {
      return { key: 'advanced', tag: 'Advanced', line: `Won ${lr.label} · semifinal draw after all qualifiers${nowBit(null)}` };
    }
    if (lr && lr.rank === 1 && lr.roundKey === 'semis') {
      return { key: 'advanced', tag: 'Advanced', line: `Won ${lr.label} · through to the final` };
    }
    if (lr && lr.roundKey === 'semis' && lr.rank === 2 && !c.finalDrawn) {
      return { key: 'waiting', tag: 'Waiting', line: `2nd in ${lr.label} · wildcard decided after all semifinals` };
    }
    if (c.scheduled) {
      return { key: 'waiting', tag: 'Waiting', line: `Races in ${c.scheduled.short}${nowBit(c.scheduled)}` };
    }
    return { key: 'waiting', tag: 'Waiting', line: 'Waiting for its qualifying race' };
  }

  // ---- race header ------------------------------------------------------------
  // The top bar's heading and its "Race N of 25" counter always describe the
  // SAME race. While a race is announced or running that's the race itself;
  // between races it's the next one ("Next: Qualifier 7" / "Race 7 of 25")
  // and the last result is named separately ("Last result: Qualifier 6"), so
  // the heading and the counter can never point at different races.
  // Each race is { label, short, ordinal, roundKey } — ordinal is its 1-based
  // place in the whole 25-race order. `replay` is the race on stage while a
  // replay runs. Returns { title, count, note }.
  function raceHeader({ current = null, next = null, last = null, replay = null, champion = false, total = 25 } = {}) {
    const count = (r) => (r && r.ordinal ? `Race ${r.ordinal} of ${total}` : '');
    if (replay) return { title: replay.label, count: count(replay), note: 'Replay' };
    if (champion) return { title: 'Tournament complete', count: `Race ${total} of ${total}`, note: '' };
    if (current) return { title: current.label, count: count(current), note: '' };
    const lastNote = last ? `Last result: ${last.short}` : '';
    if (next) return { title: `Next: ${next.short}`, count: count(next), note: lastNote };
    if (last) {
      // The round is complete and the next draw hasn't arrived yet.
      const drawing = last.roundKey === 'heats' ? 'Drawing the semifinals' : last.roundKey === 'semis' ? 'Drawing the final' : 'Deciding the champion';
      return { title: drawing, count: count(last), note: lastNote };
    }
    return { title: 'Tournament starting', count: '', note: '' };
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

  // What pressing "Replay" on a recorded race should do, given the stage:
  //   play            – the 3D stage is ready: run the race from its seeds
  //   play-when-ready – the 3D track is still loading: run it once it is
  //   fallback        – no 3D on this device: show the recorded finishing order
  //   wait            – a live race starts within `msToLive`: keep the stage
  //   unavailable     – nothing to replay (local mode, or no recorded result)
  // Every branch carries the sentence to show the viewer.
  function replayRequest({ mode, rendererState, race, msToLive = Infinity }) {
    if (mode !== 'server') return { action: 'unavailable', reason: 'Replays come from the live server’s records; races running locally in your browser have none.' };
    if (!race || !race.result || race.raceSeed == null || race.trackSeed == null) return { action: 'unavailable', reason: 'That race has no recorded result to replay yet.' };
    // No 3D stage → nothing a live start could steal: the recorded result is
    // always available (the live race takes the panel back when it starts).
    if (rendererState === 'failed') return { action: 'fallback', reason: '3D animation is unavailable on this device, so here is the recorded finishing order.' };
    if (msToLive < 8000) return { action: 'wait', reason: 'The next race starts in a moment — replays resume after it.' };
    if (rendererState !== 'ready') return { action: 'play-when-ready', reason: 'Loading the 3D track for the replay…' };
    return { action: 'play', reason: '' };
  }

  return {
    MARBLE_COUNT,
    STAGES,
    STAGE_RULES,
    stageStrip,
    remainingLine,
    yourMarbleStatus,
    raceHeader,
    ordinal,
    defaultPickerFilter,
    filterMarbles,
    surprisePool,
    rendererNext,
    replayRequest,
  };
});
