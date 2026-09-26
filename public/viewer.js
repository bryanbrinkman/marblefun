'use strict';

// =========================================================
// Tournament viewer — replays each race LOCALLY from broadcast seeds
// =========================================================
// The server never streams video or marble positions. It broadcasts
// (trackSeed, raceSeed) ~30 s ahead of each race plus a scheduled start time.
// This page loads the identical deterministic game in an <iframe> and, at the
// agreed instant, calls marbleAPI.newCourse(trackSeed) + startRace(raceSeed).
// Because the sim is deterministic, every viewer sees the same race — matching
// the result the server independently recorded.
//
// The UI is organised around two things a visitor does: watch the live race,
// and pick a marble to cheer for. Everything else (bracket, results, history)
// lives in one Tournament drawer; settings and tools in one menu.

const TOTAL_RACES = 25; // 20 qualifying + 4 semifinals + 1 final
const RING_C = 2 * Math.PI * 28; // countdown ring circumference

const gameFrame = document.getElementById('game');
const el = (id) => document.getElementById(id);
const UI = window.UIModel;

const model = {
  tournamentId: null, // server tournament id (a local counter in local mode)
  rounds: [],
  marbles: [],
  racesByKey: new Map(),
  standings: [],
  champion: null,
  currentKey: null,
};

let clockOffset = 0; // serverNow - clientNow
let builtTrack = null; // trackSeed currently built in the iframe
let startedRaces = new Set(); // race keys we've already kicked off locally
let startTimer = null;
let countdownTimer = null;
let leadMs = 30000; // announce lead, for the countdown ring
let justRevealed = null; // race key to flash on next render
let raceStartedAt = 0; // local ms when the on-stage race's gate opened (TV director phases)
let resultAtMs = 0; // local ms the on-stage race's result landed (0 = still racing)

// Connection bookkeeping (declared up here so every helper can read it).
let mode = 'connecting'; // 'connecting' | 'server' | 'local'
let serverKnown = false; // /api/state confirmed a live server → never fall back to local
let lastMsgAt = 0; // when the server last spoke (for the stale-feed state)
let replaying = false;
let _replayRace = null; // the race on stage while replaying (board + director)

// ---- iframe game API access ---------------------------------------------

function api() {
  try {
    return gameFrame.contentWindow && gameFrame.contentWindow.marbleAPI;
  } catch {
    return null;
  }
}

function whenApiReady() {
  return new Promise((resolve) => {
    const tick = () => {
      const a = api();
      if (a && typeof a.startRace === 'function') resolve(a);
      else setTimeout(tick, 80);
    };
    tick();
  });
}

async function ensureCourse(trackSeed) {
  const a = await whenApiReady();
  if (builtTrack !== trackSeed) {
    a.newCourse(trackSeed);
    builtTrack = trackSeed;
  }
  return a;
}

async function startReplay(race) {
  if (startedRaces.has(race.key)) return;
  // The server reveals raceSeed only at gate-open (it rides the race_start
  // message), so a race can be on-screen and counting down before its outcome
  // seed exists here. Until it arrives, don't start — the race_start handler
  // (or a reconnect snapshot of the now-running race) supplies it and calls
  // back in. trackSeed arrives earlier, at announce, for course pre-build.
  if (race.raceSeed == null || race.trackSeed == null) return;
  startedRaces.add(race.key);
  // A "watch latest" replay yields the stage to the live race — flash a TV
  // channel-change so the hard cut reads as "we're going live now".
  if (replaying) {
    replaying = false;
    _replayRace = null;
    el('replayChip').hidden = true;
    playTvStatic(`<div class="ts-live">● LIVE</div><div class="ts-sub">${raceLabel(race)}</div>`);
  }
  const a = await ensureCourse(race.trackSeed);
  applyRaceSkins(a, race);
  applyFollow(race);
  // If we're joining a race that already started (a mid-race page load), how far
  // into it we are — the game fast-forwards its deterministic sim by this much
  // so we land at the exact moment everyone else is watching, not at the gate.
  const catchUp = race.scheduledStart ? Math.max(0, (Date.now() - toLocal(race.scheduledStart)) / 1000) : 0;
  raceStartedAt = Date.now() - catchUp * 1000;
  resultAtMs = 0;
  // startRace refuses (returns false) if a previous replay is still on screen.
  // That happens when a client is catching up or running faster than real
  // time — hard-reset the course and start cleanly so no race is skipped.
  const ok = a.startRace(race.raceSeed, catchUp);
  if (ok === false) {
    a.newCourse(race.trackSeed);
    builtTrack = race.trackSeed;
    a.startRace(race.raceSeed, catchUp);
  }

  // Label the game's in-race leaderboard with the competitor names. The
  // camera is left alone: auto broadcast cuts itself, and a manual choice
  // stays whatever the viewer picked.
  try {
    if (a.setDisplayNames)
      a.setDisplayNames(Object.fromEntries(race.roster.map((s) => [s.lane, s.marbleName])));
    if (tvMode && _director) _director.reset();
  } catch {}

  // Replay audit: record that this race was started with its broadcast seed,
  // and that the game actually applied it. `want` should always equal `got`.
  window.__replayAudit = window.__replayAudit || [];
  window.__replayAudit.push({ key: race.key, want: race.raceSeed, got: a.getSeeds().race });

  race.status = 'running';
  const cd = el('cd');
  cd.classList.add('live');
  el('countdown').textContent = 'LIVE';
  el('cdArc').style.strokeDashoffset = '0';
  flashOverlay('GO!');
  announce(`${raceLabel(race)} has started.`);
  el('preRace').hidden = true;
  preRaceMin = false; // a minimized card unfolds again for the next gap
  _myLive = null;
  renderTopBar();
  renderMyMarble();
  renderDrawer();
}

// TV-static channel change: a short burst of full-screen noise with a "LIVE"
// label, used when the stage hard-cuts from a replay to the live race. Purely
// cosmetic (~0.9s); reduced-motion viewers get the label without the noise.
let _tvStaticTimer = 0;
let _tvStaticRaf = 0;
function playTvStatic(labelHtml) {
  const wrap = el('tvStatic');
  const cv = el('tvStaticCv');
  if (!wrap || !cv) return;
  const label = el('tvStaticLabel');
  if (label) label.innerHTML = labelHtml || '● LIVE';
  wrap.hidden = false;
  clearTimeout(_tvStaticTimer);
  cancelAnimationFrame(_tvStaticRaf);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DUR = reduce ? 650 : 900;
  if (!reduce) {
    const w = 160, h = 90;
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    const px = img.data;
    const start = performance.now();
    const frame = () => {
      for (let i = 0; i < px.length; i += 4) {
        px[i] = px[i + 1] = px[i + 2] = (Math.random() * 256) | 0;
        px[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      if (performance.now() - start < DUR) _tvStaticRaf = requestAnimationFrame(frame);
    };
    _tvStaticRaf = requestAnimationFrame(frame);
  } else {
    const ctx = cv.getContext('2d');
    if (ctx) { cv.width = 4; cv.height = 4; ctx.clearRect(0, 0, 4, 4); }
  }
  _tvStaticTimer = setTimeout(() => {
    cancelAnimationFrame(_tvStaticRaf);
    wrap.hidden = true;
  }, DUR);
}

function flashOverlay(text) {
  const o = el('stageOverlay');
  o.textContent = text;
  o.style.opacity = '1';
  setTimeout(() => (o.style.opacity = '0'), 900);
}

// ---- timing --------------------------------------------------------------

function toLocal(serverEpoch) {
  return serverEpoch - clockOffset;
}

function scheduleStart(race) {
  clearTimeout(startTimer);
  const localStart = toLocal(race.scheduledStart);
  const delay = localStart - Date.now();
  // Pre-build during the countdown — unless a "watch latest" replay is playing
  // on the stage; then the build waits for the actual start (the mid-race
  // catch-up in startRace absorbs the extra build time deterministically).
  if (!replaying) {
    ensureCourse(race.trackSeed).then((a) => applyRaceSkins(a, race));
    applyFollow(race); // marker on your marble while it waits at the gate
  }
  if (delay <= 0) {
    startReplay(race);
  } else {
    startTimer = setTimeout(() => startReplay(race), delay);
  }
  runCountdown(race);
}

function runCountdown(race) {
  clearInterval(countdownTimer);
  const cd = el('cd');
  const num = el('countdown');
  const arc = el('cdArc');
  cd.classList.remove('live');
  const tick = () => {
    if (startedRaces.has(race.key)) {
      clearInterval(countdownTimer);
      return;
    }
    const remaining = toLocal(race.scheduledStart) - Date.now();
    if (remaining <= 0) {
      num.textContent = '0';
      arc.style.strokeDashoffset = String(RING_C);
      clearInterval(countdownTimer);
      return;
    }
    num.textContent = remaining >= 10000 ? String(Math.ceil(remaining / 1000)) : (remaining / 1000).toFixed(1);
    const frac = Math.max(0, Math.min(1, remaining / leadMs));
    arc.style.strokeDashoffset = String(RING_C * (1 - frac));
  };
  tick();
  countdownTimer = setInterval(tick, 100);
}

// ---- labels ----------------------------------------------------------------

const orderedRaces = () => model.rounds.flatMap((r) => r.races);
const numOf = (id) => String(id).padStart(2, '0');
const ordinal = UI.ordinal;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// Meaningful race labels: spectators shouldn't need to decode "Heat 4 · 7/25".
function raceLabel(race) {
  if (!race) return '';
  if (race.roundKey === 'final') return 'The Final';
  if (race.roundKey === 'semis') return `Semifinal ${race.indexInRound + 1} of 4`;
  return `Qualifying · Race ${race.indexInRound + 1} of 20`;
}
// What it takes to get through this race — the real rule, not a guess.
function advanceRule(race) {
  if (!race) return '';
  if (race.roundKey === 'final') return 'Winner takes the title';
  if (race.roundKey === 'semis') return 'Winner reaches the final · fastest runner-up of the four semifinals goes too';
  return 'Winner advances to the semifinals';
}
// Human name of the round a winner of `race` moves on to.
function nextRoundName(race) {
  if (!race) return '';
  if (race.roundKey === 'heats') return 'the semifinals';
  if (race.roundKey === 'semis') return 'the final';
  return '';
}
// Compact labels for the card and schedule lines ("Qualifier 15").
function raceShort(race) {
  if (!race) return '';
  if (race.roundKey === 'final') return 'The Final';
  if (race.roundKey === 'semis') return `Semifinal ${race.indexInRound + 1}`;
  return `Qualifier ${race.indexInRound + 1}`;
}
function roundTitle(key) {
  return key === 'heats' ? 'Qualifying' : key === 'semis' ? 'Semifinals' : key === 'final' ? 'Final' : 'Champion';
}

// A race's 1-based place in the 25-race order (0 when unknown).
function raceOrdinal(race) {
  return race ? orderedRaces().findIndex((r) => r.key === race.key) + 1 : 0;
}
// Plain description of a race for the tested header rule.
function raceDesc(race) {
  return race ? { label: raceLabel(race), short: raceShort(race), ordinal: raceOrdinal(race), roundKey: race.roundKey } : null;
}
// The race the top bar talks about between races: the first one without a
// result (its draw is known), or null when the next round isn't drawn yet.
function nextDrawnRace() {
  return orderedRaces().find((r) => !r.result) || null;
}
// The top-bar heading, counter and note — one rule (UIModel.raceHeader) so
// the heading and "Race N of 25" always describe the same race, between
// races included ("Next: Qualifier 7" / "Race 7 of 25" / "Last result:
// Qualifier 6"). The stage strip's phase (activeRound) feeds the same model.
function topHeader() {
  const cur = currentRace();
  const round = activeRound();
  return UI.raceHeader({
    current: cur && !cur.result ? raceDesc(cur) : null,
    next: cur && !cur.result ? null : raceDesc(nextDrawnRace()),
    // Before race 1 nothing has been run or announced: "Tournament starting".
    last: round === null ? null : raceDesc(lastDoneRace()),
    replay: replaying && _replayRace ? raceDesc(_replayRace) : null,
    champion: !!model.champion,
    total: TOTAL_RACES,
  });
}
function topLabel() {
  return topHeader().title;
}

// The round currently being competed: the current race's round, else the first
// round with an unfinished race, else (all done) the champion.
function activeRound() {
  if (model.champion) return 'champion';
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  if (cur && !cur.result) return cur.roundKey;
  const anyDone = orderedRaces().some((r) => r.result);
  if (!anyDone && !cur) return null; // before race 1: nothing announced or run
  const nxt = orderedRaces().find((r) => !r.result);
  return nxt ? nxt.roundKey : 'champion';
}

// The race the countdown points at: the announced current race, else the
// first race without a result yet.
function nextUpcomingRace() {
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  if (cur && !cur.result) return cur;
  return orderedRaces().find((r) => !r.result) || null;
}
function currentRace() {
  return (model.currentKey && model.racesByKey.get(model.currentKey)) || null;
}
function isLiveNow() {
  const cur = currentRace();
  return !!(cur && !cur.result && startedRaces.has(cur.key));
}
function lastDoneRace() {
  const done = orderedRaces().filter((r) => r.result);
  return done[done.length - 1] || null;
}

// ---- top bar ---------------------------------------------------------------

function renderTopBar() {
  const title = el('raceTitle');
  const round = activeRound();
  title.classList.toggle('final', round === 'final');
  const h = topHeader();
  title.textContent = h.title;
  el('progressCount').textContent = h.count;
  const note = el('rcNote');
  note.textContent = document.body.classList.contains('paused') ? 'Paused' : h.note;
  const cur = currentRace();
  const cd = el('cd');
  cd.classList.toggle('live', isLiveNow());
  if (cur && !cur.result) renderSeedline(cur);
  updatePrintLink();
}

// Technical details: seeds are disclosed progressively (trackSeed at announce,
// raceSeed at the gate), so show only what's been revealed.
function renderSeedline(race) {
  const mine = _mySeeds[race.key];
  const included = mine && race.clientSeeds && race.clientSeeds.includes(mine);
  el('seedline').textContent =
    `${raceLabel(race)} · track seed ${race.trackSeed != null ? race.trackSeed : 'not yet disclosed'}` +
    (race.raceSeed != null
      ? ` · race seed ${race.raceSeed}` +
        (race.publicContribution ? ` · public randomness ${race.publicContribution.slice(0, 12)}… (${race.publicSource || 'n/a'}${race.clientSeeds ? `, ${race.clientSeeds.length} viewer seeds` : ''})` : '') +
        (mine ? (included ? ' · your seed was included' : ' · your seed was not included') : '')
      : ' · race seed is fixed at the gate from the house seed + public randomness' +
        (mine ? ' · your seed is in' : ''));
}
// The print link always exports the course on screen: the current race's
// track from announce onward, else the last race's.
function updatePrintLink() {
  const pl = el('printLink');
  if (!pl) return;
  const cur = currentRace();
  const last = lastDoneRace();
  const seed = cur && cur.trackSeed != null ? cur.trackSeed : last && last.trackSeed != null ? last.trackSeed : null;
  pl.href = seed != null ? '/print?seed=' + seed : '/print';
}

// ---- live positions -------------------------------------------------------------
// Cheap per-frame poll of the game's live positions. Feeds the standings
// board, the your-marble card, lead-change toasts, and the drawer's live rows
// (each throttles its own DOM work).
function liveOrder(prog) {
  return prog
    .slice()
    .sort((a, b) => (b.finished - a.finished) || (a.finished ? a.rank - b.rank : b.pos - a.pos));
}
let _lastProg = null;
function trackTick() {
  const a = api();
  const cur = currentRace();
  const onStage = replaying ? _replayRace : cur && !cur.result && startedRaces.has(cur.key) ? cur : null;
  if (a && a.getProgress && onStage) {
    let prog = null;
    try {
      prog = a.getProgress();
    } catch {}
    if (prog) {
      _lastProg = prog;
      updateMyLive(onStage, prog);
      watchLeadChanges(prog);
      // One standings view at a time: with no 3D the stage's own list shows
      // the race, so the top-left board stays off until the renderer is back.
      if (rendererState === 'failed') hideRaceBoard();
      else renderRaceBoard(onStage, prog);
      renderDrawerLive(onStage, prog);
    }
  } else {
    _lastProg = null;
    hideRaceBoard();
  }
  requestAnimationFrame(trackTick);
}
requestAnimationFrame(trackTick);

// ---- standings board (top-left during a race) ----------------------------------
let _boardAt = 0;
let _boardKey = null;
function renderRaceBoard(race, prog) {
  const board = el('raceBoard');
  if (!board || !race || !prog) return;
  const now = Date.now();
  if (now - _boardAt < 160) return;
  _boardAt = now;
  if (_boardKey !== race.key + (replaying ? ':r' : '')) {
    _boardKey = race.key + (replaying ? ':r' : '');
    el('rbStage').textContent = raceLabel(race) + (replaying ? ' · Replay' : '');
    el('rbRule').textContent = advanceRule(race);
  }
  board.hidden = false;
  const order = liveOrder(prog);
  el('rbRows').innerHTML = order
    .map((p, i) => {
      const s = race.roster.find((x) => x.lane === p.lane);
      if (!s) return '';
      const mine = s.marbleId === followId;
      return (
        `<div class="rb-row${mine ? ' mine' : ''}${p.finished ? ' done' : ''}${i === 0 ? ' lead' : ''}">` +
        // Lane colour, not artwork: during a race the marble is identified by
        // the cone over it in the 3D view — the board matches.
        `<span class="rb-pos">${i + 1}</span><span class="sw" style="background:${s.color}"></span>` +
        `<span class="rb-num">${numOf(s.marbleId)}</span><span class="rb-name">${esc(s.marbleName)}${mine ? ' (you)' : ''}</span>` +
        `<span class="rb-fin">${p.finished ? 'Finished' : ''}</span></div>`
      );
    })
    .join('');
}
function hideRaceBoard() {
  const board = el('raceBoard');
  if (board && !board.hidden) board.hidden = true;
  _boardKey = null;
}

// ---- marble careers --------------------------------------------------------
// Lifetime stats per marble id from /api/careers (server mode only). Fetched
// once at boot and refreshed when a tournament completes. Rendered ONLY once
// loaded — an unloaded record never reads as "no races".
let _careers = null; // Map(id -> {races, wins, podiums, titles})
let _careersState = 'idle'; // idle | loading | ok | error
async function loadCareers() {
  _careersState = 'loading';
  try {
    const r = await fetch('/api/careers', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d && Array.isArray(d.careers)) {
      _careers = new Map(d.careers.map((c) => [c.id, c]));
      _careersState = 'ok';
    } else _careersState = 'error';
  } catch {
    _careersState = 'error';
  }
  renderMyMarble();
}
function careerLine(id) {
  if (_careersState !== 'ok' || !_careers || id == null) return '';
  const c = _careers.get(id);
  if (!c || !c.races) return 'No races on record yet';
  const bits = [];
  if (c.titles) bits.push(`🏆 ${c.titles} ${c.titles > 1 ? 'titles' : 'title'}`);
  bits.push(`${c.wins} ${c.wins === 1 ? 'win' : 'wins'}`);
  bits.push(`${c.races} races`);
  return bits.join(' · ');
}

// ---- lead-change callouts --------------------------------------------------
let _leadLane = null;
let _leadToastAt = 0;
let _toastTimer = null;
function watchLeadChanges(prog) {
  const cur = currentRace();
  if (!cur || cur.result || !startedRaces.has(cur.key)) {
    _leadLane = null;
    return;
  }
  let lead = null;
  for (const p of prog) {
    if (p.finished) { _leadLane = null; return; } // someone's home — race is deciding itself
    if (!lead || p.pos > lead.pos) lead = p;
  }
  if (!lead || lead.pos < 0.06) return; // ignore the scramble right off the gate
  if (_leadLane === null) { _leadLane = lead.lane; return; } // baseline, no toast
  if (lead.lane === _leadLane) return;
  _leadLane = lead.lane;
  const now = Date.now();
  if (now - _leadToastAt < 3000) return; // debounce dueling leaders
  _leadToastAt = now;
  const s = cur.roster.find((x) => x.lane === lead.lane);
  if (!s) return;
  showToast(`${s.marbleName} takes the lead`, s.color, s.marbleId);
  announce(`${s.marbleName} takes the lead.`);
}
function showToast(text, color, marbleId = null, holdMs = 2600) {
  const t = el('raceToast');
  if (!t) return;
  t.innerHTML = (color || marbleId != null ? swatchHtml(marbleId, color) : '') + esc(text);
  t.hidden = false;
  t.classList.remove('show');
  void t.offsetWidth; // restart the pop animation
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, holdMs);
}

// ---- screen-reader narration ---------------------------------------------
function announce(text) {
  const n = el('srLive');
  if (n) n.textContent = text;
}

// ---- connection state ------------------------------------------------------
// Explicit, human states — never an indefinite "connecting". State is written
// as text+glyph (data-state only adds color).
function setConn(state, text, title) {
  const c = el('conn');
  if (!c) return;
  c.dataset.state = state;
  c.textContent = text;
  c.title = title || '';
}

// ---- your marble ---------------------------------------------------------------
// One of the 100 marbles is *yours*: persisted locally, marked in the game,
// and given one persistent card at the bottom of the screen.
let followId = null;
try {
  const v = localStorage.getItem('marbleFollow');
  if (v != null && v !== '') followId = JSON.parse(v);
} catch {}
function saveFollow() {
  try {
    if (followId == null) localStorage.removeItem('marbleFollow');
    else localStorage.setItem('marbleFollow', JSON.stringify(followId));
  } catch {}
}
function followedStanding() {
  return followId == null ? null : model.standings.find((m) => m.id === followId) || null;
}
// Tell the game which lane (if any) to chase & mark for the given race.
function applyFollow(race) {
  const a = api();
  if (!a || !a.setFollowLane) return;
  const s = race && followId != null ? race.roster.find((x) => x.marbleId === followId) : null;
  try { a.setFollowLane(s ? s.lane : null); } catch {}
}
function marbleNameOf(id) {
  const st = model.standings.find((m) => m.id === id);
  return st ? st.name : window.TournamentCore.Tournament.marbleNameFor(id);
}

// Choosing a favorite never moves the camera: following is a separate,
// explicit camera choice ("Camera: follow my marble").
function setFollow(id, opts = {}) {
  const changed = id !== followId;
  followId = id;
  saveFollow();
  const cur = currentRace();
  applyFollow(cur && !cur.result ? cur : null);
  if (id == null) followCamSet(false, { quiet: true });
  buildPickerGrid();
  renderHero();
  renderMyMarble();
  renderPreRace();
  renderDrawer();
  if (id != null && changed && !opts.quiet) confirmPick(id);
}

// A brief, unobtrusive confirmation: one toast line, gone by itself.
function confirmPick(id) {
  const st = model.standings.find((m) => m.id === id);
  const name = marbleNameOf(id);
  const cur = currentRace();
  const racingNow = cur && !cur.result && startedRaces.has(cur.key) && cur.roster.some((s) => s.marbleId === id);
  const nxt = nextUpcomingRace();
  const upNext = nxt && nxt.roster && nxt.roster.some((s) => s.marbleId === id);
  const tail = racingNow ? 'racing right now' : upNext ? 'in the next race' : st && st.status === 'eliminated' ? 'out this tournament, back in the next one' : st && st.status === 'champion' ? 'the champion' : 'your marble across every tournament';
  showToast(`Cheering for #${numOf(id)} ${name} · ${tail}`, marbleColor(id), id, 3200);
  announce(`You're cheering for #${numOf(id)} ${name}.`);
}

// Live placement while your marble races (fed from the getProgress poll,
// throttled to 2 Hz).
let _myLive = null; // { placement, finished }
let _myLiveAt = 0;
function updateMyLive(race, prog) {
  if (followId == null || !prog) return;
  const now = Date.now();
  if (now - _myLiveAt < 500) return;
  _myLiveAt = now;
  const slot = race && race.roster.find((x) => x.marbleId === followId);
  if (!slot) { if (_myLive) { _myLive = null; renderMyMarble(); } return; }
  const order = liveOrder(prog);
  const idx = order.findIndex((p) => p.lane === slot.lane);
  if (idx < 0) return;
  const next = { placement: idx + 1, finished: !!order[idx].finished };
  if (!_myLive || _myLive.placement !== next.placement || _myLive.finished !== next.finished) {
    _myLive = next;
    renderMyMarble();
  }
}

// Everything the status needs, from the model — the rule itself lives in
// the unit-tested UIModel.yourMarbleStatus.
function myStatus() {
  const id = followId;
  const st = followedStanding();
  const cur = currentRace();
  const live = cur && !cur.result && startedRaces.has(cur.key);
  const onStage = replaying ? null : cur;
  const racingNow = !!(live && onStage && onStage.roster.some((s) => s.marbleId === id));
  const nxt = nextUpcomingRace();
  const upNext = !!(nxt && !startedRaces.has(nxt.key) && nxt.roster && nxt.roster.some((s) => s.marbleId === id));
  const road = roadFor(id);
  const last = road[road.length - 1] || null;
  const inRound = (key) => model.rounds.some((r) => r.key === key && r.races.some((x) => x.roster && x.roster.some((s) => s.marbleId === id)));
  // Its next race with no result yet (the draw is known for every race in a
  // built round), and the race running / announced right now.
  const sched = orderedRaces().find((r) => !r.result && r.roster && r.roster.some((s) => s.marbleId === id)) || null;
  const curInfo = (r) => (r ? { short: raceShort(r), roundKey: r.roundKey, number: r.indexInRound + 1 } : null);
  const announced = cur && !cur.result ? cur : null;
  return UI.yourMarbleStatus({
    standing: st ? st.status : null,
    racingNow,
    placement: racingNow && _myLive ? _myLive.placement : null,
    finished: racingNow && _myLive ? _myLive.finished : false,
    upNext,
    nextLabel: nxt ? raceShort(nxt) : '',
    scheduled: curInfo(sched),
    current: curInfo(announced),
    // Between races: the same "next" race the top bar names.
    next: announced ? null : curInfo(nextDrawnRace()),
    lastResult: last ? { roundKey: last.race.roundKey, rank: last.rank, label: raceShort(last.race), dnf: last.timeSec == null } : null,
    drawnIn: { semis: inRound('semis'), final: inRound('final') },
    finalDrawn: model.rounds.some((r) => r.key === 'final'),
  });
}

function renderMyMarble() {
  const wrap = el('myMarble');
  if (!wrap) return;
  if (followId == null) {
    if (wrap.dataset.key === 'none') return;
    wrap.dataset.key = 'none';
    wrap.innerHTML =
      `<div class="mm cta"><span class="mm-info"><span class="mm-k">Your marble</span>` +
      `<span class="mm-line muted">Pick one to cheer for — it stays yours across tournaments.</span></span>` +
      `<span class="mm-actions"><button class="btn primary" id="mmPick">Pick a marble</button></span></div>`;
    return;
  }
  const st = followedStanding();
  const s = model.standings.length ? myStatus() : { key: 'waiting', tag: 'Loading', line: 'Loading its status…' };
  const tagCls = s.key === 'racing' ? 'live' : s.key === 'out' ? 'out' : s.key === 'champion' || s.key === 'advanced' || s.key === 'finalist' ? 'gold' : s.key === 'next' ? 'info' : '';
  const career = careerLine(followId);
  const no3d = rendererState === 'failed';
  // Only the words change while a race runs (placement, tag): patch them in
  // place so the card's buttons never vanish under a finger or a focus ring.
  const key = [followId, s.key, no3d, st ? st.name : '', skinImgUrl(followId) || ''].join('|');
  if (wrap.dataset.key === key && wrap.querySelector('.mm-line')) {
    const line = wrap.querySelector('.mm-line');
    if (line.textContent !== s.line) { line.textContent = s.line; line.title = career; }
    const tag = wrap.querySelector('.mm-k .tag');
    if (tag && tag.textContent !== s.tag) tag.textContent = s.tag;
    const cam = wrap.querySelector('#mmCam');
    if (cam) cam.setAttribute('aria-pressed', followCamOn ? 'true' : 'false');
    return;
  }
  wrap.dataset.key = key;
  wrap.innerHTML =
    `<div class="mm${s.key === 'out' ? ' out' : ''}">` +
    `<button class="mm-ballbtn" id="mmBall" aria-label="Change marble" title="Change marble">${swatchHtml(followId, marbleColor(followId), 'sw lg mm-ball')}</button>` +
    `<span class="mm-info"><span class="mm-k"><span class="mm-kt">Your marble</span><span class="tag ${tagCls}">${esc(s.tag)}</span></span>` +
    `<span class="mm-name"><small>#${numOf(followId)}</small>${esc(st ? st.name : marbleNameOf(followId))}</span>` +
    `<span class="mm-line" title="${esc(career)}">${esc(s.line)}</span></span>` +
    `<span class="mm-acts">` +
    (no3d ? '' : `<button class="mm-cam" id="mmCam" aria-pressed="${followCamOn ? 'true' : 'false'}" aria-label="Camera: follow my marble" title="Camera follows your marble while it races"><span class="dot" aria-hidden="true"></span><span class="lg-only">Camera: follow my marble</span><span class="sm-only">Follow camera</span></button>`) +
    `<button class="btn quiet sm mm-change" id="mmChange" aria-label="Change marble" title="Change marble">Change</button>` +
    `</span></div>`;
}
{
  const wrap = el('myMarble');
  if (wrap)
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('#mmPick') || e.target.closest('#mmChange') || e.target.closest('#mmBall')) { openPicker(); return; }
      if (e.target.closest('#mmCam')) followCamSet(!followCamOn);
    });
}

// ---- skins helpers ---------------------------------------------------------
// The marble's 2D artwork (from marbles/manifest.json), or null for a plain
// colored ball.
function skinImgUrl(id) {
  if (id == null || !marbleManifest) return null;
  const sk = marbleManifest[id] || marbleManifest[String(id)];
  return sk && sk.img ? String(sk.img) : null;
}
// A round swatch: the lane color, with the marble's artwork circle-cropped on
// top when it has some (the color stays underneath as the loading/fallback).
function swatchHtml(id, color, cls = 'sw') {
  const bg = `style="background:${color || 'var(--gold)'}"`;
  const url = skinImgUrl(id);
  if (!url) return `<span class="${cls}" ${bg}></span>`;
  return `<span class="${cls}" ${bg}><img src="${esc(url)}" alt="" loading="lazy" decoding="async" onerror="this.remove()"></span>`;
}
// The 2D artwork has a margin around the sphere; zooming by --skin-zoom (set
// in viewer.css) makes the marble's own edge meet the circle's edge.
const SKIN_BG_SIZE = 'calc(100% * var(--skin-zoom, 1))';
// Best-known lane color for a marble (its most recent race), else gold.
function marbleColor(id) {
  const races = orderedRaces();
  for (let i = races.length - 1; i >= 0; i--) {
    const s = races[i].roster && races[i].roster.find((x) => x.marbleId === id);
    if (s) return s.color;
  }
  return '#ffcf5c';
}
// Darken a #rrggbb color for the ball's shaded side.
function shadeColor(hex, k) {
  const n = parseInt((hex || '#ffcf5c').replace('#', ''), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

// ---- onboarding ------------------------------------------------------------------
// First visit: one card that says what this is and offers the two things to
// do. Dismissed by either action and remembered on this device.
const INTRO_KEY = 'mrIntroDone';
function introDone() {
  if (followId != null) return true;
  try { return localStorage.getItem(INTRO_KEY) === '1'; } catch { return false; }
}
function markIntroDone() {
  try { localStorage.setItem(INTRO_KEY, '1'); } catch {}
  renderHero();
  renderPreRace();
}
function renderHero() {
  const hero = el('pickHero');
  if (!hero) return;
  const show = !introDone() && !replaying && el('pickerModal').hidden && el('howModal').hidden;
  if (hero.hidden === !show) return;
  hero.hidden = !show;
  document.body.classList.toggle('hero-open', show);
}
{
  if (el('heroPick')) el('heroPick').addEventListener('click', () => { markIntroDone(); openPicker(); });
  if (el('heroSkip')) el('heroSkip').addEventListener('click', () => { markIntroDone(); try { gameFrame.focus(); } catch {} });
}

// "How it works": the same explanation, on demand from the menu.
let _howOpener = null;
function openHow() {
  const m = el('howModal');
  if (!m) return;
  closeMenu();
  const active = activeRound();
  const strip = UI.stageStrip(active);
  el('howStages').innerHTML = UI.STAGES.map((s, i) => {
    const st = strip[i];
    const count = s.key === 'champion' ? '' : `${s.count} marbles · ${s.races} race${s.races === 1 ? '' : 's'} of 5`;
    return `<li class="${st.state === 'active' ? 'now' : ''}"><i>${i + 1}</i><span><b>${esc(s.label)}${count ? ` <small>· ${count}</small>` : ''}</b><span>${esc(UI.STAGE_RULES[s.key])}</span></span></li>`;
  }).join('');
  _howOpener = document.activeElement;
  m.hidden = false;
  renderHero();
  el('howClose').focus();
}
function closeHow() {
  const m = el('howModal');
  if (!m || m.hidden) return;
  m.hidden = true;
  if (_howOpener && document.contains(_howOpener)) { try { _howOpener.focus(); } catch {} }
  _howOpener = null;
  renderHero();
}
{
  if (el('howClose')) el('howClose').addEventListener('click', closeHow);
  if (el('howDone')) el('howDone').addEventListener('click', () => { markIntroDone(); closeHow(); });
  if (el('howPick')) el('howPick').addEventListener('click', () => { markIntroDone(); closeHow(); openPicker(); });
  const m = el('howModal');
  if (m) m.addEventListener('click', (e) => { if (e.target === m) closeHow(); });
}

// ---- picker --------------------------------------------------------------------
const picker = { filter: 'alive', query: '', userFilter: false };
let _pickerOpener = null;
function pickerVisible() {
  const list = model.standings.length ? model.standings : Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: marbleNameOf(i + 1), status: null }));
  return UI.filterMarbles(list, { filter: picker.filter, query: picker.query });
}
function buildPickerGrid() {
  const grid = el('pickerGrid');
  if (!grid || el('pickerModal').hidden) return;
  const loaded = model.standings.length > 0;
  const q = picker.query;
  const list = pickerVisible();
  const alive = loaded ? model.standings.filter((m) => m.status === 'alive').length : null;
  el('pkAlive').setAttribute('aria-pressed', picker.filter === 'alive' ? 'true' : 'false');
  el('pkAll').setAttribute('aria-pressed', picker.filter === 'all' ? 'true' : 'false');
  el('pkAlive').disabled = !loaded;
  el('pkAlive').textContent = loaded && alive != null ? `Still competing (${model.champion ? 1 : alive})` : 'Still competing';
  // Note line: what the list is, and what an "out" marble means.
  const note = el('pickerNote');
  if (!loaded) note.textContent = 'Loading the field — names are ready, tournament status is on its way.';
  else if (model.champion) note.textContent = `Tournament complete — #${numOf(model.champion.id)} ${model.champion.name} is champion. Everyone races again next tournament.`;
  else if (picker.filter === 'alive') note.textContent = alive === 100 ? 'All 100 marbles are still in.' : `${alive} still competing. Marbles marked "out" return next tournament — you can still choose one as a long-term favorite.`;
  else note.textContent = 'Marbles marked "Out this tournament" return next tournament. You can still choose one as a long-term favorite.';
  const empty = el('pickerEmpty');
  if (!list.length) {
    grid.innerHTML = '';
    empty.hidden = false;
    empty.textContent = q
      ? `No marble matches "${q}".${picker.filter === 'alive' ? ' Try "All 100" to include marbles that are out.' : ''}`
      : picker.filter === 'alive' ? 'No marbles are still competing right now.' : 'No marbles to show.';
  } else {
    empty.hidden = true;
    grid.innerHTML = list
      .map((m) => {
        const cls = (m.status === 'eliminated' ? ' out' : m.status === 'champion' ? ' champ' : '') + (m.id === followId ? ' followed' : '');
        const status = m.status === 'eliminated' ? 'Out this tournament' : m.status === 'champion' ? 'Champion' : m.status === 'alive' ? 'Still in' : '';
        return (
          `<button class="pk${cls}" role="listitem" data-id="${m.id}" aria-pressed="${m.id === followId ? 'true' : 'false'}" aria-label="#${numOf(m.id)} ${esc(m.name)}${status ? ' — ' + status : ''}"><span class="pk-in">` +
          swatchHtml(m.id, marbleColor(m.id)) +
          `<span class="pk-num">#${numOf(m.id)}</span><span class="pk-name">${esc(m.name)}</span>` +
          `<span class="pk-status">${status}</span></span></button>`
        );
      })
      .join('');
  }
  el('pickerClear').hidden = followId == null;
  el('pickerRandom').disabled = !list.length;
  el('pickerFootNote').textContent = followId != null
    ? `Cheering for #${numOf(followId)} ${marbleNameOf(followId)} — remembered on this device.`
    : 'Your pick is remembered on this device.';
}
function openPicker() {
  const ov = el('pickerModal');
  if (!ov) return;
  closeMenu();
  closeCamPop();
  closeDrawer();
  closeHow();
  _pickerOpener = document.activeElement;
  if (!picker.userFilter) picker.filter = UI.defaultPickerFilter({ standings: model.standings, champion: model.champion });
  picker.query = '';
  const s = el('pickerSearch');
  if (s) s.value = '';
  ov.hidden = false;
  buildPickerGrid();
  renderHero();
  if (s && !matchMedia('(pointer: coarse)').matches) s.focus();
  else el('pickerClose').focus();
}
function closePicker() {
  const ov = el('pickerModal');
  if (!ov || ov.hidden) return;
  ov.hidden = true;
  if (_pickerOpener && document.contains(_pickerOpener)) { try { _pickerOpener.focus(); } catch {} }
  _pickerOpener = null;
  renderHero();
}
function surpriseMe() {
  const pool = UI.surprisePool(pickerVisible(), followId);
  if (!pool.length) return false;
  setFollow(pool[(Math.random() * pool.length) | 0].id);
  return true;
}
{
  const modal = el('pickerModal');
  if (el('pickerClose')) el('pickerClose').addEventListener('click', closePicker);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closePicker(); });
  if (el('pickerSearch')) el('pickerSearch').addEventListener('input', (e) => { picker.query = e.target.value; buildPickerGrid(); });
  for (const id of ['pkAlive', 'pkAll'])
    if (el(id)) el(id).addEventListener('click', () => { picker.filter = el(id).dataset.filter; picker.userFilter = true; buildPickerGrid(); });
  if (el('pickerGrid'))
    el('pickerGrid').addEventListener('click', (e) => {
      const b = e.target.closest('.pk');
      if (!b) return;
      setFollow(Number(b.dataset.id));
      closePicker();
    });
  if (el('pickerRandom')) el('pickerRandom').addEventListener('click', () => { if (surpriseMe()) closePicker(); });
  if (el('pickerClear'))
    el('pickerClear').addEventListener('click', () => {
      setFollow(null);
      markIntroDone(); // clearing is a choice, not a fresh visit
      showToast('Favorite cleared', null, null);
      closePicker();
    });
}

// ---- "watch latest race" replay -------------------------------------------
// Between races, re-run a previous race from its seeds (it's deterministic —
// the replay IS the race). Cancelled automatically the moment the next live
// race needs the stage.
async function startLatestReplay() {
  return startReplayOf(lastDoneRace());
}
async function startReplayOf(last) {
  if (replaying || mode !== 'server') return;
  if (!last || !last.result || last.raceSeed == null || last.trackSeed == null) return;
  const cur = currentRace();
  // Too close to a live start? Don't steal the stage for a replay.
  if (cur && !cur.result && cur.scheduledStart && toLocal(cur.scheduledStart) - Date.now() < 8000) {
    showToast('The next race starts in a moment — replays resume after it', null, null);
    return;
  }
  replaying = true;
  _replayRace = last;
  el('replayChipText').textContent = `▶ Replay · ${raceLabel(last)}`;
  el('replayChip').hidden = false;
  el('preRace').hidden = true;
  hideMoment();
  closeDrawer();
  renderHero();
  renderTopBar();
  const a = await whenApiReady();
  a.newCourse(last.trackSeed); // hard reset even on the same track: clean gate start
  builtTrack = last.trackSeed;
  applyRaceSkins(a, last);
  try {
    if (a.setDisplayNames)
      a.setDisplayNames(Object.fromEntries(last.roster.map((s) => [s.lane, s.marbleName])));
  } catch {}
  applyFollow(last);
  a.startRace(last.raceSeed, 0);
  raceStartedAt = Date.now();
  resultAtMs = 0;
  if (tvMode && _director) _director.reset();
  _boardKey = null;
}
function stopReplay(restoreStage) {
  if (!replaying) return;
  replaying = false;
  _replayRace = null;
  el('replayChip').hidden = true;
  hideRaceBoard();
  renderHero();
  if (restoreStage) {
    const a = api();
    const cur = currentRace();
    if (a && cur && !cur.result) {
      a.newCourse(cur.trackSeed);
      builtTrack = cur.trackSeed;
      applyFollow(cur);
    }
    renderAll();
  }
  renderTopBar();
  renderPreRace();
}

// ---- between-races card ------------------------------------------------------
// Clock/countdown formatting + display strings live in the shared, unit-tested
// module (public/event-state.js) so browser UI and node tests agree exactly.
const fmtClock = window.UIState.fmtClock;

// The last race the marble actually ran (for the eliminated story).
function eliminationInfo(id) {
  const raced = orderedRaces().filter((r) => r.result && r.roster && r.roster.some((s) => s.marbleId === id));
  const last = raced[raced.length - 1];
  if (!last) return null;
  const i = last.result.findIndex((x) => x.marbleId === id);
  const row = i >= 0 ? last.result[i] : null;
  return { label: raceLabel(last), rank: row ? row.rank || i + 1 : null, race: last };
}
// A marble's road through THIS tournament: one entry per race it ran.
function roadFor(id) {
  return orderedRaces()
    .filter((r) => r.result && r.roster && r.roster.some((s) => s.marbleId === id))
    .map((r) => {
      const row = r.result.find((x) => x.marbleId === id);
      return { race: r, rank: row ? row.rank : null, timeSec: row ? row.timeSec : null };
    });
}

// ONE source of truth for "what is happening right now". The top bar, the
// between-races card and the countdown all read this.
// States: LOADING | BETWEEN_RACES | COUNTDOWN | STARTING | LIVE | DELAYED |
//         STALE | RECONNECTING | OFFLINE | TOURNAMENT_COMPLETE
const STALE_MS = 180000;
let _betweenSince = 0;
function eventState() {
  const connSt = (el('conn') && el('conn').dataset.state) || 'connecting';
  if (connSt === 'reconnecting') return 'RECONNECTING';
  if (model.champion) return 'TOURNAMENT_COMPLETE';
  if (connSt === 'offline' && !model.rounds.length) return 'OFFLINE';
  if (isLiveNow()) return 'LIVE';
  if (mode === 'server' && lastMsgAt && Date.now() - lastMsgAt > STALE_MS) return 'STALE';
  if (!model.rounds.length) return 'LOADING';
  const nxt = nextUpcomingRace();
  if (nxt && nxt.scheduledStart) {
    const rem = toLocal(nxt.scheduledStart) - Date.now();
    if (rem <= -8000) return 'DELAYED'; // start well past due, race never began
    if (rem <= 5000) return 'STARTING';
    return 'COUNTDOWN';
  }
  return 'BETWEEN_RACES';
}

// Presentation per state: eyebrow, primary (from the tested formatter),
// secondary copy, and the top-bar ring's text when no countdown is running.
function stateView() {
  const st = eventState();
  const nxt = nextUpcomingRace();
  const at = nxt && nxt.scheduledStart ? toLocal(nxt.scheduledStart) : null;
  const primary = window.UIState.getNextRaceDisplay({ eventState: st, nextRaceAt: at, now: Date.now() });
  const quietMin = lastMsgAt ? Math.max(1, Math.round((Date.now() - lastMsgAt) / 60000)) : 0;
  switch (st) {
    case 'LOADING':
      return { st, eyebrow: 'Connecting', primary: 'Loading the tournament…', secondary: '', cd: '…' };
    case 'COUNTDOWN':
    case 'STARTING':
      return { st, eyebrow: 'Next up', primary, secondary: nxt ? raceLabel(nxt) : '', cd: null };
    case 'LIVE':
      return { st, eyebrow: '', primary, secondary: '', cd: null }; // card hidden; ring says LIVE
    case 'DELAYED':
      return { st, eyebrow: 'Delayed', primary, secondary: 'The start is overdue — waiting for the server', cd: '…' };
    case 'STALE':
      return { st, eyebrow: 'Live feed quiet', primary, secondary: `No update from the server for ${quietMin} min — still connected, still trying`, cd: '…' };
    case 'RECONNECTING':
      return { st, eyebrow: 'Reconnecting', primary, secondary: 'The tournament keeps running on the server', cd: '…' };
    case 'OFFLINE':
      return { st, eyebrow: 'Offline', primary, secondary: 'No live data right now', cd: '…' };
    case 'TOURNAMENT_COMPLETE':
      return {
        st,
        eyebrow: 'Tournament complete',
        primary: model.champion ? `🏆 ${model.champion.name} is champion` : primary,
        secondary: 'A new tournament starts soon — all 100 marbles return',
        cd: '🏁',
      };
    default: {
      // Result in, next race not yet announced: the server is drawing and
      // probing the next course. If that takes unusually long, say so rather
      // than promising "shortly" forever.
      if (!_betweenSince) _betweenSince = Date.now();
      const waited = Date.now() - _betweenSince;
      if (mode === 'server' && waited > 60000) {
        return { st: 'BETWEEN_RACES', eyebrow: 'Between races', primary: 'Waiting for the next race…', secondary: `The server hasn't announced it yet (${Math.round(waited / 60000)} min)`, cd: '…' };
      }
      // Name the next race the way the top bar does, so the two agree.
      const up = nextDrawnRace();
      return { st: 'BETWEEN_RACES', eyebrow: 'Between races', primary, secondary: up ? `Next: ${raceShort(up)} · Preparing the course` : 'Preparing the next course', cd: '…' };
    }
  }
}

// Per-second update of the countdown sentence + the top-bar ring fallback.
// Screen-reader policy: the ticking text is NOT a live region. Only meaningful
// milestones are announced, once each per race.
let _announced = { key: null, min: false, ten: false };
function tickPreRaceCountdown() {
  const v = stateView();
  if (v.st !== 'BETWEEN_RACES') _betweenSince = 0;
  if (v.cd !== null && !isLiveNow()) {
    const num = el('countdown');
    if (num) num.textContent = v.cd;
  }
  if (v.st === 'COUNTDOWN' || v.st === 'STARTING') {
    const nxt = nextUpcomingRace();
    if (nxt && nxt.scheduledStart) {
      if (_announced.key !== nxt.key) _announced = { key: nxt.key, min: false, ten: false };
      const rem = toLocal(nxt.scheduledStart) - Date.now();
      if (!_announced.min && rem <= 60000 && rem > 55000) {
        _announced.min = true;
        announce(`One minute to ${raceLabel(nxt)}.`);
      }
      if (!_announced.ten && rem <= 10000 && rem > 5000) {
        _announced.ten = true;
        announce('Ten seconds to the next race.');
      }
    }
  }
  const panel = el('preRace');
  if (!panel) return;
  if (panel.hidden) {
    // Re-evaluate as soon as the course's construction show is over.
    if (v.st !== 'LIVE' && !courseAssembling()) renderPreRace();
    if (panel.hidden) return;
  }
  if (document.body.classList.contains('paused')) return;
  if (v.st === 'TOURNAMENT_COMPLETE') return; // static copy set by renderPreRace
  el('prState').textContent = v.eyebrow;
  el('prTitle').textContent = v.primary;
  el('prFlavor').textContent = v.secondary;
  syncPrMini();
  if (drawerOpen && drawerTab === 'race' && (v.st === 'COUNTDOWN' || v.st === 'STARTING')) renderDrawerCountdown();
}

// ---- minimize (✕) --------------------------------------------------------------
let preRaceMin = false;
function setPreRaceMin(on) {
  preRaceMin = !!on;
  renderPreRace();
  const target = el(preRaceMin ? 'prMini' : 'prClose');
  if (target && !el('preRace').hidden && !target.hidden) target.focus({ preventScroll: true });
}
function syncPrMini() {
  const t = el('prMiniText');
  if (t) t.textContent = el('prTitle').textContent || 'Race info';
}
setInterval(tickPreRaceCountdown, 1000);

// True while the game is still building a course or popping its pieces into
// place — the info card waits so the construction show plays unobstructed.
function courseAssembling() {
  try {
    const a = api();
    return !!(a && a.isConstructing && a.isConstructing());
  } catch {
    return false;
  }
}

function stagesHtml(compact) {
  const strip = UI.stageStrip(activeRound());
  return strip
    .map((s) => `<span class="stg ${s.state}">${esc(compact ? s.short : s.label)}</span>`)
    .join('<span class="stg-arrow" aria-hidden="true">›</span>');
}

function renderPreRace() {
  const panel = el('preRace');
  if (!panel) return;
  const celebrating = !el('champOverlay').hidden;
  const heroUp = !el('pickHero').hidden;
  const momentUp = !el('moment').hidden;
  if (isLiveNow() || replaying || celebrating || heroUp || momentUp || rendererState === 'failed') {
    panel.hidden = true;
    return;
  }
  if (courseAssembling()) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  if (model.champion) preRaceMin = false; // the champion card always unfolds
  el('prCard').hidden = preRaceMin;
  el('prMini').hidden = !preRaceMin;

  const state = el('prState');
  const title = el('prTitle');
  const flavor = el('prFlavor');
  const starters = el('prStarters');
  el('prStages').innerHTML = stagesHtml(true);
  el('prRemaining').textContent = UI.remainingLine({ standings: model.standings, champion: model.champion, activeRound: activeRound() });
  const latest = !!lastDoneRace() && mode === 'server';
  el('watchLatestBtn').hidden = !latest;

  if (model.champion) {
    state.textContent = 'Tournament complete';
    title.textContent = `🏆 ${model.champion.name} is champion`;
    flavor.textContent = 'A new tournament starts soon — all 100 marbles return';
    starters.innerHTML = '';
    el('prGuessLabel').hidden = true;
    syncPrMini();
    return;
  }
  if (document.body.classList.contains('paused')) {
    state.textContent = 'Short break';
    title.textContent = 'Racing resumes soon';
    flavor.textContent = 'The tournament is paused by the organiser';
    starters.innerHTML = '';
    el('prGuessLabel').hidden = true;
    syncPrMini();
    return;
  }

  const v = stateView();
  state.textContent = v.eyebrow;
  title.textContent = v.primary;
  flavor.textContent = v.secondary;
  syncPrMini();
  if (v.st === 'STARTING') el('watchLatestBtn').hidden = true;
  // Call the winner: the five starters are tappable — backing one makes it
  // your marble (same persistence as the picker).
  const nxt = nextUpcomingRace();
  const showStarters = nxt && nxt.roster && (v.st === 'COUNTDOWN' || v.st === 'STARTING');
  el('prGuessLabel').hidden = !showStarters;
  starters.innerHTML = showStarters
    ? nxt.roster
        .map((s) => {
          const mine = s.marbleId === followId;
          return (
            `<button class="um" data-guess="${s.marbleId}" aria-pressed="${mine ? 'true' : 'false'}" title="Cheer for ${esc(s.marbleName)}">` +
            swatchHtml(s.marbleId, s.color) + `<span>${esc(s.marbleName)}</span></button>`
          );
        })
        .join('')
    : '';
}

// ---- call-the-winner bookkeeping -------------------------------------------
function recordGuess(raceKey, marbleId) {
  try { localStorage.setItem('marbleGuess', JSON.stringify({ raceKey, marbleId })); } catch {}
}
function checkGuess(race) {
  let g = null;
  try { g = JSON.parse(localStorage.getItem('marbleGuess') || 'null'); } catch {}
  if (!g || !race || g.raceKey !== race.key || !race.result || !race.result[0]) return;
  try { localStorage.removeItem('marbleGuess'); } catch {}
  if (race.result[0].marbleId === g.marbleId) {
    flashOverlay('Called it!');
    announce(`You called it — ${race.result[0].marbleName} wins!`);
  }
}

function renderAll() {
  renderTopBar();
  renderHero();
  renderMyMarble();
  const mpReplay = el('mpReplay');
  if (mpReplay) mpReplay.hidden = !(mode === 'server' && lastDoneRace());
  renderPreRace();
  renderDrawer();
  renderStageFallback();
  buildPickerGrid();
  preloadRaceSkins();
}

// Warm the game's model cache ahead of time: the race in progress or up next,
// plus the one after it. Called on every model update — the game dedupes.
let _preloadedKey = '';
function preloadRaceSkins() {
  if (!marbleManifest) return;
  const a = api();
  if (!a || typeof a.preloadSkins !== 'function') return;
  const cur = currentRace();
  const upcoming = orderedRaces().filter((r) => !r.result && r.roster);
  const races = cur && !cur.result && cur.roster ? [cur, ...upcoming.filter((r) => r !== cur)] : upcoming;
  const ahead = window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 1 : 2;
  const urls = [];
  for (const r of races.slice(0, ahead)) {
    for (const s of r.roster) {
      const sk = marbleManifest[s.marbleId] || marbleManifest[String(s.marbleId)];
      if (sk && sk.glb && !urls.includes(sk.glb)) urls.push(sk.glb);
    }
  }
  const key = urls.join('|');
  if (!urls.length || key === _preloadedKey) return;
  _preloadedKey = key;
  try { a.preloadSkins(urls); } catch {}
}

// ---- public contribution -------------------------------------------------------
// Every viewer quietly contributes 32 random bytes to the next race seed during
// the announce window (one per IP; the server folds them all in at the gate).
let _mySeeds = {}; // raceKey -> hex
async function submitClientSeed(race, win) {
  if (mode !== 'server' || !race || !win || !win.endpoint || !window.crypto) return;
  try {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const seed = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    const r = await fetch(win.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed }) });
    const d = await r.json().catch(() => null);
    if (d && d.ok && d.accepted) _mySeeds[race.key] = seed;
  } catch {}
}

// ---- message handling ----------------------------------------------------

function ingestSnapshot(msg) {
  clockOffset = msg.serverNow - Date.now();
  leadMs = msg.announceLeadMs || leadMs;
  const prevTid = model.tournamentId;
  model.tournamentId = msg.tournament ? msg.tournament.id : null;
  model.rounds = msg.rounds;
  model.marbles = msg.marbles;
  model.standings = msg.standings;
  model.champion = msg.tournament.champion;
  model.racesByKey.clear();
  for (const round of msg.rounds)
    for (const race of round.races) model.racesByKey.set(race.key, race);
  for (const race of model.racesByKey.values()) if (race.result) startedRaces.add(race.key);

  if (typeof msg.paused === 'boolean') reflectServerPaused(msg.paused);
  if (!msg.tournament || !msg.tournament.champion) hideChampionCelebration(false);
  hideMoment();

  const cur = msg.current;
  model.currentKey = cur ? cur.raceKey : null;
  renderAll();
  if (prevTid != null && model.tournamentId != null && prevTid !== model.tournamentId) onNewTournament();
  if (model.champion && !championSeen()) showChampionCelebration(model.champion);
  if (cur && (cur.phase === 'announced' || cur.phase === 'running')) {
    const race = model.racesByKey.get(cur.raceKey);
    if (race && !race.result) scheduleStart(race);
  }
}

// Past champions — server-recorded history, newest first. Shown in the
// drawer's History tab with honest loading / error / empty states.
let _champs = { state: 'idle', rows: [] }; // idle | loading | ok | error
async function loadChampions() {
  if (mode === 'local') { _champs = { state: 'unavailable', rows: [] }; renderDrawer(); return; }
  _champs = { state: 'loading', rows: _champs.rows };
  renderDrawer();
  try {
    const r = await fetch('/api/champions?limit=8', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = (await r.json()) || {};
    _champs = { state: 'ok', rows: d.champions || [] };
  } catch {
    _champs = { state: 'error', rows: _champs.rows };
  }
  renderDrawer();
}

// ---- tournament-champion celebration --------------------------------------
let _fwRaf = 0;
let _fwTimer = 0;
function startFireworks(baseColor) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = el('fwCanvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = cv.clientWidth * dpr;
  cv.height = cv.clientHeight * dpr;
  const palette = ['#ffcf5c', '#ffffff', '#ff9d3c', baseColor || '#5bc0de'];
  const rockets = [];
  const sparks = [];
  const launch = () => {
    rockets.push({ x: cv.width * (0.15 + Math.random() * 0.7), y: cv.height + 10, vy: -(cv.height * (0.011 + Math.random() * 0.005)), burstY: cv.height * (0.18 + Math.random() * 0.3), color: palette[(Math.random() * palette.length) | 0] });
  };
  const burst = (r) => {
    const n = 70 + ((Math.random() * 40) | 0);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
      const sp = (2 + Math.random() * 4.2) * dpr;
      sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: 0.009 + Math.random() * 0.011, color: Math.random() < 0.75 ? r.color : '#ffffff' });
    }
  };
  launch(); launch(); launch();
  _fwTimer = setInterval(launch, 650);
  const tick = () => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.y += r.vy;
      ctx.fillStyle = r.color;
      ctx.fillRect(r.x - dpr, r.y, dpr * 2, dpr * 7);
      if (r.y <= r.burstY) { burst(r); rockets.splice(i, 1); }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += s.vx; s.y += s.vy; s.vy += 0.045 * dpr; s.vx *= 0.985; s.life -= s.decay;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, s.life);
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x, s.y, dpr * 3, dpr * 3);
    }
    ctx.globalAlpha = 1;
    _fwRaf = requestAnimationFrame(tick);
  };
  _fwRaf = requestAnimationFrame(tick);
}
function stopFireworks() {
  if (_fwRaf) cancelAnimationFrame(_fwRaf);
  if (_fwTimer) clearInterval(_fwTimer);
  _fwRaf = 0;
  _fwTimer = 0;
  const cv = el('fwCanvas');
  if (cv) { const ctx = cv.getContext('2d'); ctx && ctx.clearRect(0, 0, cv.width, cv.height); }
}
function roundShort(race) {
  if (race.roundKey === 'final') return 'Final';
  if (race.roundKey === 'semis') return `Semi ${race.indexInRound + 1}`;
  return `Race ${race.indexInRound + 1}`;
}
let _champShownFor = null;
function championSeenKey(tid) {
  return 'mrChampSeen:' + (tid != null ? tid : 'local');
}
function championSeen() {
  try { return sessionStorage.getItem(championSeenKey(model.tournamentId)) === '1'; } catch { return false; }
}
function markChampionSeen() {
  try { sessionStorage.setItem(championSeenKey(_champShownFor), '1'); } catch {}
}
function showChampionCelebration(champion) {
  const ov = el('champOverlay');
  if (!ov || !champion) return;
  hideMoment();
  let color = '#ffcf5c';
  const fin = model.racesByKey.get('final:0');
  if (fin && fin.result && fin.result[0] && fin.result[0].color) color = fin.result[0].color;
  const ball = el('coBall');
  const skin = marbleManifest && (marbleManifest[champion.id] || marbleManifest[String(champion.id)]);
  if (skin && skin.img) {
    ball.style.backgroundImage = `url("${skin.img}")`;
  } else {
    ball.style.removeProperty('background-image');
    ball.style.setProperty('--c1', color);
    ball.style.setProperty('--c2', shadeColor(color, 0.45));
  }
  const mine = followId === champion.id;
  el('coKicker').textContent = mine ? 'Your marble did it' : 'Tournament champion';
  el('coNum').textContent = '#' + numOf(champion.id);
  el('coName').textContent = champion.name;
  const road = roadFor(champion.id);
  el('coPath').innerHTML = road
    .map((p) => `<span class="co-step"><i>${roundShort(p.race)}</i><b>${p.rank ? ordinal(p.rank) : '—'}</b><small>${p.timeSec == null ? 'DNF' : ''}</small></span>`)
    .join('<span class="co-arrow" aria-hidden="true">›</span>');
  const bits = [];
  if (model.tournamentId != null) bits.push(`Tournament ${model.tournamentId}`);
  bits.push('100 marbles entered');
  const c = _careersState === 'ok' && _careers && _careers.get(champion.id);
  if (c && c.titles > 1) bits.push(`🏆 ${c.titles} titles`);
  el('coMeta').textContent = bits.join(' · ');
  const you = el('coYou');
  if (followId != null && !mine) {
    const st = followedStanding();
    const e = eliminationInfo(followId);
    you.textContent = st
      ? e
        ? `Your #${numOf(followId)} ${st.name} went out in ${e.label}${e.rank ? ` (${ordinal(e.rank)})` : ''} — it's back next tournament`
        : `Your #${numOf(followId)} ${st.name} didn't get a race this time — it's back next tournament`
      : '';
    you.hidden = !you.textContent;
  } else you.hidden = true;
  ov.classList.toggle('mine', mine);
  _champShownFor = model.tournamentId;
  ov.hidden = false;
  requestAnimationFrame(() => ov.classList.add('show'));
  stopFireworks();
  startFireworks(color);
  renderPreRace();
}
function hideChampionCelebration(dismissed = true) {
  const ov = el('champOverlay');
  if (!ov || ov.hidden) return;
  if (dismissed) markChampionSeen();
  stopFireworks();
  ov.classList.remove('show');
  setTimeout(() => { ov.hidden = true; renderPreRace(); }, 500);
}

// ---- moments: survive / eliminated / wildcard ------------------------------------
let _moTimer = 0;
function momentKey(tag) {
  return 'mrMoment:' + (model.tournamentId != null ? model.tournamentId : 'local') + ':' + tag;
}
function momentSeen(tag) {
  try { return sessionStorage.getItem(momentKey(tag)) === '1'; } catch { return false; }
}
function markMomentSeen(tag) {
  try { sessionStorage.setItem(momentKey(tag), '1'); } catch {}
}
function showMoment({ kicker, title, sub, actions, tone, holdMs }) {
  const box = el('moment');
  if (!box) return;
  clearTimeout(_moTimer);
  el('moKicker').textContent = kicker || '';
  el('moTitle').textContent = title || '';
  el('moSub').innerHTML = sub || '';
  el('moActions').innerHTML = (actions || [])
    .map((a) => `<button class="btn${a.primary ? ' primary' : ''}" data-act="${a.act}">${a.label}</button>`)
    .join('');
  box.className = 'moment ' + (tone || '');
  box.hidden = false;
  requestAnimationFrame(() => box.classList.add('show'));
  renderPreRace();
  announce(`${title}. ${(sub || '').replace(/<[^>]+>/g, '')}`);
  if (holdMs) _moTimer = setTimeout(hideMoment, holdMs);
}
function hideMoment() {
  const box = el('moment');
  if (!box || box.hidden) return;
  clearTimeout(_moTimer);
  box.classList.remove('show');
  setTimeout(() => { box.hidden = true; renderPreRace(); }, 300);
}
{
  const box = el('moment');
  if (box)
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) {
        const act = b.dataset.act;
        hideMoment();
        if (act === 'survivor') { picker.filter = 'alive'; picker.userFilter = true; openPicker(); }
        else if (act === 'replay') {
          const e2 = eliminationInfo(followId);
          if (e2 && e2.race) startReplayOf(e2.race);
        }
        return;
      }
      if (e.target === box) hideMoment();
    });
}
function aliveCount() {
  return model.standings.filter((m) => m.status === 'alive').length;
}

// ---- result reveal, in step with the local replay ---------------------------
function applyRaceResult(race, msg) {
  if (race) race.result = msg.result;
  model.standings = msg.standings;
  justRevealed = msg.raceKey;
  renderAll();
  justRevealed = null;
  if (race && race.result && race.result[0]) announce(`${race.result[0].marbleName} wins ${raceLabel(race)}.`);
  checkGuess(race);
  onRaceResult(race);
}
// True while this race is playing on the stage here and a marble the server
// saw finish hasn't crossed the line locally yet (DNFs are never waited for).
function localReplayStillRunning(race, result) {
  if (!race || replaying || race.key !== model.currentKey || !startedRaces.has(race.key)) return false;
  const a = api();
  if (!a || !a.getProgress || !race.roster) return false;
  let prog;
  try { prog = a.getProgress(); } catch { return false; }
  if (!prog || !prog.length) return false;
  const finishedLanes = new Set(prog.filter((p) => p.finished).map((p) => p.lane));
  for (const r of result || []) {
    if (r.timeSec == null) continue;
    const slot = race.roster.find((s) => s.slot === r.slot);
    if (slot && !finishedLanes.has(slot.lane)) return true;
  }
  return false;
}
let _pendingResult = null;
function deferRaceResult(race, msg) {
  if (_pendingResult) clearInterval(_pendingResult.timer);
  const deadline = Date.now() + 20000;
  const timer = setInterval(() => {
    const p = _pendingResult;
    if (!p || p.race !== race) return clearInterval(timer);
    const stillRunning = localReplayStillRunning(race, msg.result);
    if (stillRunning && Date.now() < deadline && race.key === model.currentKey) return;
    clearInterval(timer);
    _pendingResult = null;
    applyRaceResult(race, msg);
  }, 200);
  _pendingResult = { race, msg, timer };
}

function onRaceResult(race) {
  if (!race || !race.result) return;
  if (race.key === model.currentKey || (_replayRace && _replayRace.key === race.key)) resultAtMs = Date.now();
  if (followId == null) return;
  const row = race.result.find((x) => x.marbleId === followId);
  if (!row) return; // not our race
  const tag = 'result:' + race.key;
  if (momentSeen(tag)) return;
  markMomentSeen(tag);
  const rank = row.rank || race.result.indexOf(row) + 1;
  const name = `#${numOf(followId)} ${marbleNameOf(followId)}`;
  const remain = aliveCount();
  const delay = 1800; // let the finish breathe (the podium is on screen)
  if (race.roundKey === 'final') return; // the champion moment handles the final
  if (rank === 1) {
    setTimeout(() => showMoment({
      tone: 'good',
      kicker: `${raceLabel(race)} · won it`,
      title: `${name} advances`,
      sub: `Through to ${nextRoundName(race)}<span class="mo-count">${remain} marbles remain</span>`,
      actions: [{ label: 'Keep watching', act: 'close', primary: true }],
      holdMs: 7000,
    }), delay);
    return;
  }
  if (race.roundKey === 'semis' && rank === 2) {
    setTimeout(() => showMoment({
      tone: 'wait',
      kicker: `${raceLabel(race)} · runner-up`,
      title: `${name} finished 2nd`,
      sub: `The fastest runner-up of the four semifinals takes the last place in the final<span class="mo-count">${row.timeSec != null ? row.timeSec.toFixed(2) + ' s' : 'Did not finish'} · decided when the other semifinals are done</span>`,
      actions: [{ label: 'Keep watching', act: 'close', primary: true }],
      holdMs: 7000,
    }), delay);
    return;
  }
  setTimeout(() => showMoment({
    tone: 'bad',
    kicker: raceLabel(race),
    title: `${name} is out`,
    sub: `Finished ${ordinal(rank)}${row.timeSec == null ? ' · did not finish' : ''} — it's back next tournament<span class="mo-count">${remain} marbles remain</span>`,
    actions: [
      { label: 'Pick a marble still racing', act: 'survivor', primary: true },
      { label: 'Keep cheering', act: 'close' },
    ],
    holdMs: 12000,
  }), delay);
}
// A new round was drawn: resolve the wildcard story.
function onRoundBuilt(round) {
  if (!round || followId == null) return;
  if (round.key !== 'final') return;
  const inFinal = round.races.some((r) => r.roster && r.roster.some((s) => s.marbleId === followId));
  const road = roadFor(followId);
  const lastSemi = road.filter((p) => p.race.roundKey === 'semis').pop();
  if (!lastSemi || lastSemi.rank !== 2) return;
  const tag = 'wildcard';
  if (momentSeen(tag)) return;
  markMomentSeen(tag);
  const name = `#${numOf(followId)} ${marbleNameOf(followId)}`;
  if (inFinal) {
    showMoment({ tone: 'good', kicker: 'Wildcard', title: `${name} reaches the final`, sub: `Fastest runner-up of the semifinals<span class="mo-count">5 marbles remain</span>`, actions: [{ label: 'Keep watching', act: 'close', primary: true }], holdMs: 7000 });
  } else {
    showMoment({ tone: 'bad', kicker: 'Wildcard missed', title: `${name} is out`, sub: `A faster runner-up took the last place in the final — it's back next tournament<span class="mo-count">5 marbles remain</span>`, actions: [{ label: 'Pick a marble still racing', act: 'survivor', primary: true }, { label: 'Keep cheering', act: 'close' }], holdMs: 12000 });
  }
}
// A fresh tournament began: everyone's back in, including your marble.
function onNewTournament() {
  hideMoment();
  hideChampionCelebration(false);
  picker.userFilter = false;
  if (followId != null) {
    const st = followedStanding();
    if (st) showToast(`New tournament — #${numOf(followId)} ${st.name} is back in the field`, marbleColor(followId), followId, 4000);
  }
}
{
  const ov = el('champOverlay');
  const close = el('coClose');
  if (close) close.addEventListener('click', hideChampionCelebration);
  const share = el('coShare');
  if (share)
    share.addEventListener('click', async () => {
      const c = model.champion;
      const name = c ? `#${numOf(c.id)} ${c.name}` : 'A marble';
      const text = `🏆 ${name} just won the 100-marble tournament on marblerun.fun!`;
      const url = c ? `${location.origin}/gallery#${c.id}` : `${location.origin}/`;
      try {
        if (navigator.share) { await navigator.share({ title: 'marblerun.fun', text, url }); return; }
      } catch { return; }
      try {
        await navigator.clipboard.writeText(`${text} ${url}`);
        share.textContent = 'Copied to clipboard';
      } catch {
        share.textContent = url;
      }
      setTimeout(() => (share.textContent = 'Share the moment'), 2500);
    });
  if (ov) ov.addEventListener('click', (e) => { if (e.target === ov) hideChampionCelebration(); });
}

// Reflect the SERVER's paused state (admin-driven) in the viewer UI.
function reflectServerPaused(paused) {
  document.body.classList.toggle('paused', paused);
  renderTopBar();
  renderPreRace();
}

function onMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      ingestSnapshot(msg);
      break;
    case 'round_built':
      if (msg.round) {
        for (const race of msg.round.races) upsertRace(race);
        renderAll();
        onRoundBuilt(model.rounds.find((r) => r.key === msg.round.key));
      }
      break;
    case 'race_announced': {
      clockOffset = msg.serverNow - Date.now();
      leadMs = msg.announceLeadMs || leadMs;
      const race = msg.race;
      upsertRace(race);
      model.currentKey = race.key;
      startedRaces.delete(race.key);
      renderAll();
      scheduleStart(race);
      submitClientSeed(race, msg.clientSeedWindow);
      break;
    }
    case 'race_start': {
      clockOffset = msg.serverNow - Date.now();
      const race = model.racesByKey.get(msg.raceKey);
      if (race) {
        if (msg.trackSeed != null) race.trackSeed = msg.trackSeed;
        if (msg.raceSeed != null) race.raceSeed = msg.raceSeed;
        if (msg.publicContribution) {
          race.publicContribution = msg.publicContribution;
          race.publicSource = msg.publicSource;
          race.clientSeeds = msg.clientSeeds || [];
          race.beacon = msg.beacon || null;
        }
        startReplay(race);
      }
      break;
    }
    case 'race_result': {
      const race = model.racesByKey.get(msg.raceKey);
      if (race && localReplayStillRunning(race, msg.result)) {
        deferRaceResult(race, msg);
        break;
      }
      applyRaceResult(race, msg);
      break;
    }
    case 'paused':
      reflectServerPaused(!!msg.paused);
      break;
    case 'no_tournament':
      goLocal();
      break;
    case 'tournament_complete':
      model.champion = msg.champion;
      model.currentKey = null;
      resultAtMs = resultAtMs || Date.now();
      renderAll();
      loadChampions();
      loadCareers();
      setTimeout(() => { if (model.champion) showChampionCelebration(model.champion); }, 2200);
      if (msg.champion) announce(`${msg.champion.name} is the tournament champion!`);
      break;
  }
}

function upsertRace(race) {
  model.racesByKey.set(race.key, race);
  let round = model.rounds.find((r) => r.key === race.roundKey);
  if (!round) {
    round = { key: race.roundKey, title: race.roundTitle, races: [] };
    model.rounds.push(round);
  }
  const i = round.races.findIndex((r) => r.key === race.key);
  if (i >= 0) round.races[i] = race;
  else {
    round.races.push(race);
    round.races.sort((a, b) => a.indexInRound - b.indexInRound);
  }
}

// ---- local (serverless) mode --------------------------------------------
// When there's no WebSocket server (e.g. a static host), the browser runs the
// whole tournament itself: builds the bracket, announces each race, drives the
// real race in the iframe, reads the finishing order back out of the game,
// records it, and advances — looping forever. Fully deterministic, no backend.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL_FAST = new URLSearchParams(location.search).has('fast');
const LOCAL_LEAD_MS = LOCAL_FAST ? 800 : 10000;
const LOCAL_GAP_MS = LOCAL_FAST ? 500 : 3000;

function syncRounds(T) {
  model.rounds = T.rounds.map((r) => ({ key: r.key, title: r.title, idx: r.idx, races: r.races }));
  model.marbles = T.marbles;
  model.racesByKey.clear();
  for (const round of T.rounds) for (const race of round.races) model.racesByKey.set(race.key, race);
}

const adminChannel = 'BroadcastChannel' in window ? new BroadcastChannel('marble-admin') : null;
let localPaused = false;
let localResetToken = 0;
let localForcedSeed = null;

function loadAdminState() {
  try { localPaused = !!JSON.parse(localStorage.getItem('marble-admin') || '{}').paused; } catch {}
}
function persistPaused() {
  try { localStorage.setItem('marble-admin', JSON.stringify({ paused: localPaused })); } catch {}
}
function reflectPaused() {
  document.body.classList.toggle('paused', localPaused);
  renderTopBar();
  renderPreRace();
}
function broadcastStatus() {
  if (!adminChannel) return;
  const cur = currentRace();
  adminChannel.postMessage({ type: 'status', paused: localPaused, mode, current: cur ? raceLabel(cur) : null, champion: model.champion ? model.champion.name : null, done: orderedRaces().filter((r) => r.result).length, total: TOTAL_RACES });
}
function handleAdminCommand(cmd) {
  if (!cmd || !cmd.type) return;
  if (cmd.type === 'pause') localPaused = true;
  else if (cmd.type === 'resume') localPaused = false;
  else if (cmd.type === 'reset') {
    localForcedSeed = cmd.seed != null ? cmd.seed >>> 0 : null;
    localResetToken++;
    localPaused = false;
  } else if (cmd.type === 'request-status') { broadcastStatus(); return; }
  else return;
  persistPaused();
  reflectPaused();
  broadcastStatus();
}
if (adminChannel) adminChannel.onmessage = (e) => handleAdminCommand(e.data);

async function gatePause(aborted) {
  if (!localPaused) return;
  broadcastStatus();
  while (localPaused && !(aborted && aborted())) await sleep(300);
}

async function startLocalTournament() {
  document.body.classList.add('local-mode');
  reflectLocalConn();
  leadMs = LOCAL_LEAD_MS;
  loadAdminState();
  reflectPaused();
  broadcastStatus();
  _champs = { state: 'unavailable', rows: [] };
  let n = 0;
  for (;;) {
    const myToken = localResetToken;
    const seed = localForcedSeed != null ? localForcedSeed : (Date.now() ^ (n++ * 0x9e3779b1) ^ (Math.floor(performance.now()) * 0x2545f4914f)) >>> 0;
    localForcedSeed = null;
    const completed = await runLocalTournament(seed, () => localResetToken !== myToken);
    if (localResetToken === myToken && completed) await sleep(14000);
  }
}

async function runLocalTournament(seed, aborted) {
  const T = new window.TournamentCore.Tournament(seed);
  const myTokenAtStart = localResetToken;
  const first = model.tournamentId == null;
  model.tournamentId = (model.tournamentId || 0) + 1;
  if (!first) onNewTournament();
  else hideChampionCelebration(false);
  model.champion = null;
  startedRaces = new Set();
  builtTrack = null;
  syncRounds(T);
  model.standings = window.TournamentCore.standings(T);
  model.currentKey = null;
  renderAll();
  broadcastStatus();

  for (;;) {
    if (aborted && aborted()) return false;
    await gatePause(aborted);
    if (aborted && aborted()) return false;
    const race = T.nextPendingRace();
    if (!race) {
      const nxt = T.advance();
      if (nxt) {
        syncRounds(T);
        model.standings = window.TournamentCore.standings(T);
        renderAll();
        onRoundBuilt(model.rounds.find((r) => r.key === nxt.key));
        continue;
      }
      T.advance();
      break;
    }
    await runLocalRace(T, race, aborted);
    broadcastStatus();
  }

  model.champion = T.champion ? { id: T.champion, name: T.marbleName(T.champion) } : null;
  model.currentKey = null;
  renderAll();
  if (model.champion) {
    flashOverlay('🏆 ' + model.champion.name);
    await sleep(2200);
    if (localResetToken === myTokenAtStart) showChampionCelebration(model.champion);
  }
  broadcastStatus();
  return true;
}

function _mapOrder(race, results) {
  const byLane = new Map(race.roster.map((s) => [s.lane, s]));
  const order = (results || []).map((o) => {
    const s = byLane.get(o.name);
    return { slot: s.slot, marbleId: s.marbleId, marbleName: s.marbleName, lane: o.name, color: o.color, timeSec: o.timeSec };
  });
  const finished = new Set(order.map((o) => o.slot));
  for (const s of race.roster)
    if (!finished.has(s.slot))
      order.push({ slot: s.slot, marbleId: s.marbleId, marbleName: s.marbleName, lane: s.lane, color: s.color, timeSec: null });
  return order;
}

async function computeResult(race) {
  const a = await whenApiReady();
  let sim = null;
  try { sim = a.simulateRace(race.raceSeed); } catch (e) { console.error('simulateRace failed', e); }
  const order = _mapOrder(race, sim && sim.results);
  // False when the finish line / podium would sit inside a block column.
  order.finishClear = !(sim && sim.finishClear === false);
  return order;
}

async function waitForVisualFinish(race, order, aborted) {
  const a = await whenApiReady();
  const finishers = order.filter((o) => o.timeSec != null).length || race.roster.length;
  const maxFin = order.reduce((mx, o) => Math.max(mx, o.timeSec || 0), 0);
  const cap = LOCAL_FAST ? 1500 : (maxFin * 2 + 30) * 1000;
  const start = Date.now();
  for (;;) {
    let n = 0;
    try { n = (a.getResults() || []).length; } catch {}
    if (n >= finishers || Date.now() - start > cap || (aborted && aborted())) return;
    await sleep(300);
  }
}

async function runLocalRace(T, race, aborted) {
  race.status = 'announced';
  race.scheduledStart = Date.now() + leadMs;
  model.currentKey = race.key;
  model.standings = window.TournamentCore.standings(T);
  renderAll();
  runCountdown(race);
  await ensureCourse(race.trackSeed);
  let order = await computeResult(race);
  // A course is a dud when fewer than a majority of the field finishes
  // (ceil(roster/2), i.e. 3 of 5) OR its finish line / podium would sit
  // inside a block column — the same rules as the server (scheduler._pickTrack),
  // so both modes agree on every race's course.
  const minFinishers = Math.max(1, Math.ceil(race.roster.length / 2));
  const finisherCount = (o) => o.filter((x) => x.timeSec != null).length;
  const isDud = (o) => finisherCount(o) < minFinishers || o.finishClear === false;
  const LOCAL_TRACK_ATTEMPTS = 14; // same budget as the server (scheduler cfg.trackAttempts)
  for (let attempt = 1; attempt < LOCAL_TRACK_ATTEMPTS && isDud(order); attempt++) {
    race.trackSeed = window.TournamentCore.deriveSeed(T.masterSeed, 0x7a2c, race.roundIdx + 1, race.indexInRound + 1, attempt);
    console.warn('[viewer] dud track for ' + race.key + ' — retrying with candidate ' + attempt);
    const b = await ensureCourse(race.trackSeed);
    // Cheap first, like the server: a tunnelled finish needs no physics probe.
    if (attempt < LOCAL_TRACK_ATTEMPTS - 1 && b.courseInfo && b.courseInfo().finishClear === false) {
      order = Object.assign([], { finishClear: false });
      continue;
    }
    order = await computeResult(race);
  }
  const a = await whenApiReady();
  applyRaceSkins(a, race);
  if (a.resetForNextRace) a.resetForNextRace(race.raceSeed);
  else a.newCourse(race.trackSeed);
  // The director shows the wide shot between races; a manual camera choice is
  // left alone.
  if (tvMode && a.setCamera) a.setCamera('overview');
  await sleep(Math.max(0, race.scheduledStart - Date.now()));
  await startReplay(race);
  await waitForVisualFinish(race, order, aborted);
  if (aborted && aborted()) return;
  T.applyResult(race, order);
  race.status = 'done';
  model.standings = window.TournamentCore.standings(T);
  justRevealed = race.key;
  renderAll();
  justRevealed = null;
  if (order && order[0]) announce(`${order[0].marbleName} wins ${raceLabel(race)}.`);
  checkGuess(race);
  onRaceResult(race);
  await sleep(LOCAL_GAP_MS);
}

// ---- websocket -----------------------------------------------------------

function reflectLocalConn() {
  if (navigator.onLine === false)
    setConn('offline', '⚡ Offline', 'No connection — a full tournament runs locally in your browser');
  else
    setConn('local', '▶ Local races', 'No live server — a full tournament runs locally in your browser');
  renderTopBar();
}
window.addEventListener('online', () => { if (mode === 'local') reflectLocalConn(); });
window.addEventListener('offline', () => { if (mode === 'local') reflectLocalConn(); });

// "Delayed": connected, but the server has gone quiet for far longer than the
// longest normal between-message gap. Distinct from reconnecting/offline.
setInterval(() => {
  if (mode !== 'server' || !lastMsgAt) return;
  const c = el('conn');
  if (Date.now() - lastMsgAt > STALE_MS && c.dataset.state === 'live' && !isLiveNow())
    setConn('delayed', '⏱ No updates', 'Connected, but no update from the server in a while');
}, 10000);

function goLocal() {
  if (mode === 'local') return;
  mode = 'local';
  startLocalTournament();
}

function connect() {
  if (mode === 'local') return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch {
    if (serverKnown) setTimeout(connect, 1500);
    else goLocal();
    return;
  }
  const fallback = serverKnown
    ? null
    : setTimeout(() => {
        if (mode === 'connecting') {
          try { ws.close(); } catch {}
          goLocal();
        }
      }, 3000);
  ws.onopen = () => {
    if (mode === 'local') { try { ws.close(); } catch {} return; }
    mode = 'server';
    if (fallback) clearTimeout(fallback);
    lastMsgAt = Date.now();
    setConn('live', '● Live', 'Connected — races broadcast in real time');
  };
  ws.onclose = () => {
    if (fallback) clearTimeout(fallback);
    if (mode === 'server' || serverKnown) {
      setConn('reconnecting', '⟳ Reconnecting', 'Lost the live feed — retrying automatically');
      renderPreRace();
      if (mode !== 'local') setTimeout(connect, 1500);
    } else if (mode === 'connecting') goLocal();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (ev) => {
    if (mode === 'local') return;
    if (mode !== 'server') mode = 'server';
    lastMsgAt = Date.now();
    const c = el('conn');
    if (c.dataset.state !== 'live') { setConn('live', '● Live', 'Connected — races broadcast in real time'); renderPreRace(); }
    try { onMessage(JSON.parse(ev.data)); } catch (e) { console.error('bad message', e); }
  };
}

(async function boot() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (r.ok) {
      const s = await r.json().catch(() => null);
      if (s && s.type === 'no_tournament') { goLocal(); return; }
      if (s && (s.type === 'snapshot' || s.type === 'starting')) {
        serverKnown = true;
        mode = 'server';
        if (s.type === 'snapshot') onMessage(s);
        loadChampions();
        loadCareers();
      }
    }
  } catch {}
  connect();
})();

// ---- Tournament drawer -------------------------------------------------------------
let drawerOpen = false;
let drawerTab = 'race';
let _drawerOpener = null;
let bracketRound = null; // null → follow the active round
function openDrawer(tab) {
  closeMenu();
  closeCamPop();
  closePicker();
  closeHow();
  const d = el('tourDrawer');
  if (!d) return;
  if (tab) drawerTab = tab;
  if (!drawerOpen) { _drawerOpener = document.activeElement; _bracketFocused = false; }
  drawerOpen = true;
  d.hidden = false;
  document.body.classList.add('drawer-open');
  el('tourBtn').setAttribute('aria-expanded', 'true');
  renderDrawer();
  const t = d.querySelector(`.dr-tab[data-tab="${drawerTab}"]`);
  if (t) t.focus();
}
function closeDrawer() {
  const d = el('tourDrawer');
  if (!d || !drawerOpen) return;
  drawerOpen = false;
  d.hidden = true;
  document.body.classList.remove('drawer-open');
  el('tourBtn').setAttribute('aria-expanded', 'false');
  if (_drawerOpener && document.contains(_drawerOpener)) { try { _drawerOpener.focus(); } catch {} }
  _drawerOpener = null;
}
function setDrawerTab(tab) {
  drawerTab = tab;
  renderDrawer();
}
function renderDrawer() {
  if (!drawerOpen) return;
  const d = el('tourDrawer');
  el('drawerSub').textContent = (model.tournamentId != null && mode === 'server' ? `Tournament ${model.tournamentId} · ` : '') + topLabel();
  for (const b of document.querySelectorAll('.dr-tab')) {
    const on = b.dataset.tab === drawerTab;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    el('panel' + b.dataset.tab.charAt(0).toUpperCase() + b.dataset.tab.slice(1)).hidden = !on;
  }
  // Live updates re-render the panel; the reader's scroll position and any
  // open disclosures survive it.
  const body = d && d.querySelector('.dr-body');
  const keepTop = body ? body.scrollTop : 0;
  if (drawerTab === 'race') renderRacePanel();
  else if (drawerTab === 'bracket') renderBracketPanel();
  else renderHistoryPanel();
  if (body) body.scrollTop = keepTop;
  if (drawerTab === 'bracket') focusCurrentRaceOnce();
}

// A competitor row: position | avatar | number + name | status.
function competitorRow(s, { pos = '', status = '', statusCls = '', win = false, lead = false } = {}) {
  const mine = s.marbleId === followId;
  return (
    `<div class="mrow${mine ? ' mine' : ''}${win ? ' win' : ''}${lead ? ' lead' : ''}">` +
    `<span class="mrow-pos">${pos}</span>${swatchHtml(s.marbleId, s.color, 'sw lg')}` +
    `<span class="mrow-name"><small>#${numOf(s.marbleId)}</small>${esc(s.marbleName)}${mine ? '<span class="you">you</span>' : ''}</span>` +
    `<span class="mrow-status ${statusCls}">${status}</span></div>`
  );
}
// Rows for a race: live order while it runs, results once in, roster before.
function raceRows(race, prog) {
  if (!race || !race.roster) return '';
  if (race.result) {
    return race.result
      .map((r) => {
        const s = race.roster.find((x) => x.slot === r.slot) || r;
        const adv = r.rank === 1 ? (race.roundKey === 'final' ? 'Champion' : 'Advances') : race.roundKey === 'semis' && r.rank === 2 ? 'Wildcard?' : 'Out';
        const tagCls = r.rank === 1 ? 'gold' : r.rank === 2 && race.roundKey === 'semis' ? 'info' : 'out';
        return competitorRow(s, { pos: r.rank, status: `${r.timeSec == null ? 'Did not finish' : ordinal(r.rank)} <span class="tag ${tagCls}">${adv}</span>`, win: r.rank === 1 });
      })
      .join('');
  }
  if (prog && prog.length) {
    const order = liveOrder(prog);
    return order
      .map((p, i) => {
        const s = race.roster.find((x) => x.lane === p.lane);
        if (!s) return '';
        return competitorRow(s, { pos: i + 1, status: p.finished ? `Finished ${ordinal(p.rank || i + 1)}` : ordinal(i + 1), statusCls: p.finished ? 'live' : '', lead: i === 0 && !p.finished });
      })
      .join('');
  }
  return race.roster.map((s) => competitorRow(s, { pos: '', status: race.status === 'announced' ? 'At the gate' : '' })).join('');
}
function renderRacePanel() {
  const p = el('panelRace');
  if (!p) return;
  const cur = currentRace();
  const live = isLiveNow();
  const order = orderedRaces();
  const focus = cur && !cur.result ? cur : lastDoneRace();
  const v = stateView();
  let html = '';
  if (focus) {
    // Same vocabulary as the top bar: the announced/running race by its full
    // label; between races "Last result: Qualifier 6" then "Next: Qualifier 7".
    const announced = !!(cur && !cur.result);
    const status = announced
      ? live ? '<span class="tag live">Live</span>' : `<span class="tag" id="drCountdown">${esc(v.primary)}</span>`
      : '<span class="tag">Finished</span>';
    html += `<section class="dr-sec"><h3 class="dr-h"><b>${esc(announced ? raceLabel(focus) : `Last result: ${raceShort(focus)}`)}</b>${status}</h3>` +
      `<div class="row-list" id="drRows">${raceRows(focus, live && !replaying ? _lastProg : null)}</div>` +
      `<p class="dr-empty">${esc(advanceRule(focus))}</p></section>`;
    if (!announced) {
      const nxt = order.find((r) => !r.result);
      html += nxt
        ? `<section class="dr-sec"><h3 class="dr-h"><b>Next: ${esc(raceShort(nxt))}</b><small>Waiting to start</small></h3><div class="chips">${nxt.roster.map((s) => `<span class="chip${s.marbleId === followId ? ' mine' : ''}">${swatchHtml(s.marbleId, s.color)}#${numOf(s.marbleId)} ${esc(s.marbleName)}</span>`).join('')}</div></section>`
        : model.champion ? '' : `<section class="dr-sec"><h3 class="dr-h"><b>Next race</b><small>${esc(topHeader().title)}</small></h3><p class="dr-empty">The draw is announced when this round is complete.</p></section>`;
    }
  } else {
    html += `<section class="dr-sec"><p class="dr-empty">${model.rounds.length ? 'The first race will be announced shortly.' : 'Loading the tournament…'}</p></section>`;
  }
  // The race after the current one, when known.
  if (cur && !cur.result) {
    const idx = order.findIndex((r) => r.key === cur.key);
    const nxt = order.slice(idx + 1).find((r) => !r.result);
    if (nxt)
      html += `<section class="dr-sec"><h3 class="dr-h"><b>After this: ${esc(raceShort(nxt))}</b></h3><div class="chips">${nxt.roster.map((s) => `<span class="chip${s.marbleId === followId ? ' mine' : ''}">${swatchHtml(s.marbleId, s.color)}#${numOf(s.marbleId)} ${esc(s.marbleName)}</span>`).join('')}</div></section>`;
  }
  // Still competing: a compact disclosure, collapsed by default — names and
  // artwork when opened, with an "All competitors" filter for the ones out.
  if (model.standings.length) {
    const alive = model.standings.filter((m) => m.status === 'alive' || m.status === 'champion');
    const list = _fieldFilter === 'all' ? model.standings : alive;
    const rows = list
      .map((m) => {
        const out = m.status === 'eliminated';
        const status = out ? 'Out this tournament' : m.status === 'champion' ? 'Champion' : '';
        return `<div class="mrow compact${m.id === followId ? ' mine' : ''}${out ? ' out' : ''}"><span></span>${swatchHtml(m.id, marbleColor(m.id), 'sw lg')}` +
          `<span class="mrow-name"><small>#${numOf(m.id)}</small>${esc(m.name)}${m.id === followId ? '<span class="you">you</span>' : ''}</span>` +
          `<span class="mrow-status${out ? ' out' : m.status === 'champion' ? ' gold' : ''}">${status}</span></div>`;
      })
      .join('');
    const n = model.champion ? 1 : alive.length;
    html += `<section class="dr-sec"><details class="dr-details field" id="fieldAll"${_fieldOpen ? ' open' : ''}>` +
      `<summary><b>${n} still competing</b><span class="sr-only"> — </span><span class="dr-link">View competitors</span></summary>` +
      `<div class="seg" role="group" aria-label="Show"><button class="seg-btn" data-field="alive" aria-pressed="${_fieldFilter === 'alive' ? 'true' : 'false'}">Still competing</button><button class="seg-btn" data-field="all" aria-pressed="${_fieldFilter === 'all' ? 'true' : 'false'}">All competitors</button></div>` +
      `<div class="row-list">${rows || '<p class="dr-empty">Nobody is left in.</p>'}</div>` +
      `<p class="dr-empty">Marbles marked out return next tournament.</p></details></section>`;
  }
  p.innerHTML = html;
  const fa = el('fieldAll');
  if (fa) {
    fa.addEventListener('toggle', () => { _fieldOpen = fa.open; });
    fa.querySelectorAll('[data-field]').forEach((b) => b.addEventListener('click', () => { _fieldFilter = b.dataset.field; renderDrawer(); }));
  }
}
let _fieldFilter = 'alive';
function renderDrawerCountdown() {
  const c = el('drCountdown');
  if (c) c.textContent = stateView().primary;
}
// Live rows update at 2 Hz while the drawer shows the running race.
let _drawerLiveAt = 0;
function renderDrawerLive(race, prog) {
  if (!drawerOpen || drawerTab !== 'race' || replaying) return;
  const now = Date.now();
  if (now - _drawerLiveAt < 500) return;
  _drawerLiveAt = now;
  const rows = el('drRows');
  if (rows) rows.innerHTML = raceRows(race, prog);
  renderStageFallback(prog);
}

function renderBracketPanel() {
  const p = el('panelBracket');
  if (!p) return;
  const active = activeRound();
  const sel = bracketRound || (active === 'champion' || active == null ? (active == null ? 'heats' : 'final') : active);
  const byKey = (k) => model.rounds.find((r) => r.key === k);
  // Completed races stay compact (winner artwork + name); upcoming races
  // expand to the five competitors with artwork; the live / next race is
  // marked, and the favorite's race is highlighted.
  const row = (race, label) => {
    if (!race) return `<div class="rr tbd"><span class="rr-l">${label}</span><span class="rr-w muted">To be decided</span><span></span></div>`;
    const cur = race.key === model.currentKey && !race.result;
    const w = race.result && race.result[0];
    const mine = followId != null && race.roster && race.roster.some((s) => s.marbleId === followId);
    const you = mine ? '<span class="tag gold">you</span>' : '<span></span>';
    if (w) {
      return `<div class="rr done${mine ? ' mine' : ''}" data-race="${race.key}"><span class="rr-l">${label}</span>` +
        `<span class="rr-w">${swatchHtml(w.marbleId, w.color)}<span>#${numOf(w.marbleId)} ${esc(w.marbleName)}</span><small>won</small></span>${you}</div>`;
    }
    const state = cur ? (startedRaces.has(race.key) ? '<span class="tag live">Live now</span>' : '<span class="tag info">Up next</span>') : '';
    const open = _openRaces.has(race.key);
    return `<details class="rr-x${cur ? ' current' : ''}${mine ? ' mine' : ''}" data-race="${race.key}"${open ? ' open' : ''}>` +
      `<summary class="rr"><span class="rr-l">${label}</span><span class="rr-w muted"><span>${state || `${race.roster.length} marbles`}</span></span>${you}</summary>` +
      `<div class="rr-body">${race.roster.map((s) => `<span class="chip${s.marbleId === followId ? ' mine' : ''}">${swatchHtml(s.marbleId, s.color)}#${numOf(s.marbleId)} ${esc(s.marbleName)}</span>`).join('')}</div></details>`;
  };
  // One round navigator: the selected view (pressed) is distinct from the
  // round being raced right now (the "now" mark).
  let html = `<div class="round-sel" role="group" aria-label="Round">` +
    ['heats', 'semis', 'final'].map((k) => `<button data-round="${k}" aria-pressed="${sel === k ? 'true' : 'false'}"${active === k ? ' class="now"' : ''}>${roundTitle(k)}${active === k ? '<i>now</i>' : ''}</button>`).join('') + `</div>`;
  if (sel === 'final') {
    html += `<div class="race-rows">` +
      `<div class="rr${model.champion ? ' champ' : ' tbd'}"><span class="rr-l">Champion</span><span class="rr-w">${model.champion ? `${swatchHtml(model.champion.id, marbleColor(model.champion.id))}<span>#${numOf(model.champion.id)} ${esc(model.champion.name)}</span>` : '<span class="muted">To be decided</span>'}</span><span>${model.champion ? '<span class="tag gold">🏆</span>' : ''}</span></div>` +
      row(byKey('final') ? byKey('final').races[0] : null, 'Final') + `</div>` +
      `<p class="dr-empty">${esc(UI.STAGE_RULES.final)} The five finalists are the four semifinal winners plus the fastest runner-up across the four semifinals (the wildcard).</p>`;
    const fr = byKey('final');
    if (fr && fr.wildcard != null) html += `<p class="dr-empty">Wildcard this tournament: #${numOf(fr.wildcard)} ${esc(marbleNameOf(fr.wildcard))}.</p>`;
  } else if (sel === 'semis') {
    const semis = byKey('semis');
    html += `<div class="race-rows">${[0, 1, 2, 3].map((i) => row(semis ? semis.races[i] : null, 'Semi ' + (i + 1))).join('')}</div>` +
      `<p class="dr-empty">${esc(UI.STAGE_RULES.semis)}</p>`;
  } else {
    const heats = byKey('heats');
    html += `<div class="race-rows">${(heats ? heats.races : []).map((r, i) => row(r, 'Race ' + (i + 1))).join('')}</div>` +
      `<p class="dr-empty">${esc(UI.STAGE_RULES.heats)}</p>`;
  }
  html += `<details class="dr-details" id="fullBracket"><summary>Full bracket</summary><div id="bracketTree"></div></details>`;
  p.innerHTML = html;
  p.querySelectorAll('.rr-x').forEach((d) => d.addEventListener('toggle', () => { if (d.open) _openRaces.add(d.dataset.race); else _openRaces.delete(d.dataset.race); }));
  const det = el('fullBracket');
  if (det) {
    det.addEventListener('toggle', () => { _fullBracketOpen = det.open; if (det.open) renderBracketTree(); });
    if (_fullBracketOpen) { det.open = true; renderBracketTree(); }
  }
}
const _openRaces = new Set();
// Bring the current race into view the first time the bracket is shown for
// this opening of the drawer — and never again while it stays open, so live
// updates don't yank the reader's scroll position.
let _bracketFocused = false;
function focusCurrentRaceOnce() {
  if (_bracketFocused) return;
  const cur = currentRace();
  if (!cur) return;
  const rowEl = el('panelBracket') && el('panelBracket').querySelector(`[data-race="${cur.key}"]`);
  if (!rowEl) return;
  _bracketFocused = true;
  try { rowEl.scrollIntoView({ block: 'center' }); } catch {}
}
let _fullBracketOpen = false;
let _fieldOpen = false;

// The classic two-sided tree: semifinals at the wings, the final and champion
// in the centre, the 20 qualifying races in the outer columns.
function bracketSlotRows(race) {
  if (!race) return '<div class="bd-tbd">to be decided</div>';
  const rankBySlot = {};
  const timeBySlot = {};
  if (race.result) race.result.forEach((r) => { rankBySlot[r.slot] = r.rank; timeBySlot[r.slot] = r.timeSec; });
  const rows = race.result ? race.result.map((r) => race.roster.find((s) => s.slot === r.slot)) : race.roster;
  return rows
    .map((s) => {
      const rank = rankBySlot[s.slot];
      const done = rank != null;
      const t = done && timeBySlot[s.slot] == null ? 'DNF' : '';
      return `<div class="bd-slot${rank === 1 ? ' win' : ''}"><span class="pos">${done ? rank : ''}</span>${swatchHtml(s.marbleId, s.color)}<span class="nm">${esc(s.marbleName)}</span><span class="t">${t}</span></div>`;
    })
    .join('');
}
function bracketBox(race, label, cls) {
  const status = race ? (race.result ? 'done' : race.status || 'pending') : 'tbd';
  const current = race && race.key === model.currentKey && !race.result ? ' current' : '';
  return `<div class="bd-box ${cls} ${status}${current}"><div class="bd-box-h">${label}</div>${bracketSlotRows(race)}</div>`;
}
function renderBracketTree() {
  const body = el('bracketTree');
  if (!body) return;
  const byKey = (k) => model.rounds.find((r) => r.key === k);
  const semis = byKey('semis');
  const final = byKey('final');
  const heats = byKey('heats');
  const semi = (i) => (semis && semis.races[i]) || null;
  const finalRace = final ? final.races[0] : null;
  const champ = model.champion
    ? `<div class="bd-champ has">🏆 ${esc(model.champion.name)}</div>`
    : `<div class="bd-champ">Champion</div>`;
  const hraces = heats ? heats.races : [];
  const heatCol = (arr, offset) => `<div class="bd-heatcol">${arr.map((r, i) => bracketBox(r || null, 'Race ' + (offset + i + 1), 'bd-heat')).join('')}</div>`;
  body.innerHTML =
    `<div class="bd-scroll"><div class="bd-main">` +
    heatCol(hraces.slice(0, 10), 0) +
    `<div class="bd-core">` +
    `<div class="bd-wing left">${bracketBox(semi(0), 'Semifinal 1', 'bd-semi')}${bracketBox(semi(1), 'Semifinal 2', 'bd-semi')}</div>` +
    `<div class="bd-join left"></div>` +
    `<div class="bd-center">${bracketBox(finalRace, 'The Final', 'bd-final')}${champ}</div>` +
    `<div class="bd-join right"></div>` +
    `<div class="bd-wing right">${bracketBox(semi(2), 'Semifinal 3', 'bd-semi')}${bracketBox(semi(3), 'Semifinal 4', 'bd-semi')}</div>` +
    `</div>` +
    heatCol(hraces.slice(10, 20), 10) +
    `</div></div>`;
  const sc = body.querySelector('.bd-scroll');
  if (sc) sc.scrollLeft = Math.max(0, (sc.scrollWidth - sc.clientWidth) / 2);
}

function renderHistoryPanel() {
  const p = el('panelHistory');
  if (!p) return;
  const done = orderedRaces().filter((r) => r.result).slice().reverse();
  const canReplay = mode === 'server';
  let html = `<section class="dr-sec"><h3 class="dr-h"><b>Recent results</b><small>this tournament</small></h3>`;
  if (!done.length) html += `<p class="dr-empty">${model.rounds.length ? 'No race has finished yet in this tournament.' : 'Loading…'}</p>`;
  else {
    html += `<div class="row-list">` + done.slice(0, _historyAll ? done.length : 8).map((r) => {
      const w = r.result[0];
      return `<div class="mrow${r.roster.some((s) => s.marbleId === followId) ? ' mine' : ''}"><span class="mrow-pos">🏁</span>${swatchHtml(w.marbleId, w.color, 'sw lg')}` +
        `<span class="mrow-name"><small>#${numOf(w.marbleId)}</small>${esc(w.marbleName)}<br><span class="mrow-status">won ${esc(raceLabel(r))}</span></span>` +
        (canReplay && r.raceSeed != null ? `<button class="btn sm" data-replay="${r.key}">Replay</button>` : '<span></span>') + `</div>`;
    }).join('') + `</div>`;
    if (done.length > 8) html += `<button class="btn quiet sm" id="histMore" style="margin-top:6px">${_historyAll ? 'Show fewer' : `Show all ${done.length}`}</button>`;
  }
  html += `</section>`;
  html += `<section class="dr-sec"><h3 class="dr-h"><b>Recent champions</b><small>past tournaments</small></h3>`;
  const c = _champs;
  if (c.state === 'unavailable') html += `<p class="dr-empty">Champion history is kept by the live server and isn't available while races run locally in your browser.</p>`;
  else if (c.state === 'loading' && !c.rows.length) html += `<div class="row-list">${[1, 2, 3].map(() => `<div class="mrow"><span class="mrow-pos"></span><span class="sw lg" style="background:var(--panel-3)"></span><span class="mrow-name"><span class="skeleton"></span></span><span></span></div>`).join('')}</div>`;
  else if (c.state === 'error' && !c.rows.length) html += `<p class="dr-empty err">Couldn't load the champions list.</p><button class="btn sm" id="champRetry">Try again</button>`;
  else if (c.state === 'idle') html += `<p class="dr-empty">Loading…</p>`;
  else if (!c.rows.length) html += `<p class="dr-empty">No tournament has finished yet. The first champion is crowned after the final.</p>`;
  else {
    html += `<div class="row-list">` + c.rows.slice(0, 6).map((row) => {
      const when = row.completed_at || row.created_at ? new Date(row.completed_at || row.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      return `<a class="mrow" href="/gallery#${row.champion_marble_id}"><span class="mrow-pos">🏆</span>${swatchHtml(row.champion_marble_id, marbleColor(row.champion_marble_id), 'sw lg')}` +
        `<span class="mrow-name"><small>#${numOf(row.champion_marble_id)}</small>${esc(marbleNameOf(row.champion_marble_id))}</span><span class="mrow-status">T${row.tournament_id}${when ? ' · ' + when : ''}</span></a>`;
    }).join('') + `</div>`;
    if (c.state === 'error') html += `<p class="dr-empty err">Couldn't refresh — showing the last list loaded.</p>`;
  }
  html += `<p style="margin:10px 0 0"><a class="btn" href="/champions">Complete champions archive</a></p></section>`;
  p.innerHTML = html;
}
let _historyAll = false;
{
  const d = el('tourDrawer');
  if (d) {
    d.addEventListener('click', (e) => {
      const tab = e.target.closest('.dr-tab');
      if (tab) { setDrawerTab(tab.dataset.tab); return; }
      const rb = e.target.closest('[data-round]');
      if (rb) { bracketRound = rb.dataset.round; _bracketFocused = true; renderDrawer(); return; }
      const rp = e.target.closest('[data-replay]');
      if (rp) { const r = model.racesByKey.get(rp.dataset.replay); if (r) startReplayOf(r); return; }
      if (e.target.closest('#histMore')) { _historyAll = !_historyAll; renderHistoryPanel(); return; }
      if (e.target.closest('#champRetry')) { loadChampions(); }
    });
    d.addEventListener('keydown', (e) => {
      // Arrow keys move between tabs.
      if (!e.target.classList.contains('dr-tab')) return;
      const tabs = ['race', 'bracket', 'history'];
      const i = tabs.indexOf(drawerTab);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        setDrawerTab(n);
        d.querySelector(`.dr-tab[data-tab="${n}"]`).focus();
      }
    });
  }
  if (el('tourBtn')) el('tourBtn').addEventListener('click', () => (drawerOpen ? closeDrawer() : openDrawer()));
  if (el('drawerClose')) el('drawerClose').addEventListener('click', closeDrawer);
}

// ---- menu ------------------------------------------------------------------------
function closeMenu() {
  const pop = el('menuPop');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  el('menuBtn').setAttribute('aria-expanded', 'false');
}
{
  const btn = el('menuBtn');
  const pop = el('menuPop');
  const setOpen = (open) => {
    if (!pop) return;
    if (open) { closeCamPop(); closeDrawer(); }
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { syncSettings(); pop.querySelector('.mp-item').focus(); }
  };
  if (btn && pop) {
    btn.addEventListener('click', () => setOpen(pop.hidden));
    document.addEventListener('click', (e) => {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) setOpen(false);
    });
    pop.querySelectorAll('a.mp-item').forEach((a) => a.addEventListener('click', () => setOpen(false)));
    el('mpHow').addEventListener('click', () => { setOpen(false); openHow(); });
    el('mpReplay').addEventListener('click', () => { setOpen(false); startLatestReplay(); });
    el('mpSound').addEventListener('click', toggleSound);
    el('mpLowQ').addEventListener('click', () => { const a = api(); if (a && a.pressControl) a.pressControl('lqBtn'); setTimeout(syncSettings, 50); });
    el('mpBlur').addEventListener('click', () => {
      const a = api();
      if (a && a.setTiltShift && a.getSettings) a.setTiltShift(!a.getSettings().tiltShift);
      setTimeout(syncSettings, 50);
    });
    el('mpFullscreen').addEventListener('click', () => { setOpen(false); toggleFullscreen(); });
  }
}
function toggleSound() {
  const a = api();
  if (a && a.pressControl) a.pressControl('soundBtn');
  setTimeout(syncSettings, 50);
}
function toggleFullscreen() {
  const d = document;
  const fs = d.fullscreenElement || d.webkitFullscreenElement;
  try {
    if (fs) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else (d.documentElement.requestFullscreen || d.documentElement.webkitRequestFullscreen).call(d.documentElement);
  } catch {}
}
function syncSettings() {
  const a = api();
  let s = null;
  try { s = a && a.getSettings ? a.getSettings() : null; } catch {}
  const setTog = (id, on) => {
    const b = el(id);
    if (!b) return;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.classList.toggle('on', !!on);
    const st = b.querySelector('.mp-state');
    if (st) st.textContent = on ? 'On' : 'Off';
  };
  setTog('mpSound', s && s.sound);
  setTog('mpLowQ', s && s.lowQ);
  setTog('mpBlur', s ? s.tiltShift : true);
  const sb = el('soundBtn');
  if (sb) {
    const on = !!(s && s.sound);
    sb.setAttribute('aria-pressed', on ? 'true' : 'false');
    sb.textContent = on ? '🔊' : '🔇';
    sb.title = on ? 'Sound on' : 'Sound off';
  }
}
{
  if (el('soundBtn')) el('soundBtn').addEventListener('click', toggleSound);
  if (el('fsBtn')) el('fsBtn').addEventListener('click', toggleFullscreen);
  whenApiReady().then(() => setTimeout(syncSettings, 100));
}

// ---- camera ------------------------------------------------------------------------
// Three primary choices — Auto broadcast (the director), Follow my marble,
// Overview — plus the specialist angles under "More". The director's shot
// selection lives in public/tv-director.js; this is the glue.
let tvMode = false;
let _tvTimer = null;
const _director = window.TvDirector ? new window.TvDirector.Director() : null;
let followCamOn = false;
let camChoice = 'auto'; // auto | follow | overview | action | top | split
function setTvMode(on) {
  tvMode = !!on;
  try { sessionStorage.setItem('mrTv', tvMode ? '1' : '0'); } catch {}
  clearInterval(_tvTimer);
  _tvTimer = null;
  if (tvMode && _director) {
    _director.reset();
    _tvTimer = setInterval(tvDirector, 500);
    tvDirector();
  }
  document.body.classList.toggle('tv-on', tvMode);
  syncCamUI();
}
function tvDirector() {
  const a = api();
  if (!a || !a.getCamera || !a.setCamera || !_director) return;
  const cur = currentRace();
  const live = !!(cur && !cur.result && startedRaces.has(cur.key));
  let cam = 'overview';
  try { cam = a.getCamera() || 'overview'; } catch {}
  let prog = null;
  if (live || replaying) { try { prog = a.getProgress(); } catch {} }
  const onStage = replaying ? _replayRace : cur;
  const mine = followId != null && onStage && onStage.roster ? onStage.roster.find((s) => s.marbleId === followId) : null;
  const now = Date.now();
  const { cut } = _director.decide({
    now, cam, live, replaying,
    raceElapsedMs: raceStartedAt ? now - raceStartedAt : 0,
    prog: prog || [],
    followLane: mine ? mine.lane : null,
    resultAt: resultAtMs || (live || replaying ? 0 : now),
  });
  if (!cut || cut === cam) return;
  a.setCamera(cut);
  let took = cut;
  try { took = a.getCamera() || took; } catch {}
  if (took !== cut) _director.markUnsupported(cut);
  syncCamUI();
}
// Apply a camera choice. `follow` is the chase cam riding your marble's lane
// (the leader when it isn't racing); anything but `auto` turns the director off.
function setCameraChoice(choice, opts = {}) {
  camChoice = choice;
  followCamOn = choice === 'follow';
  try { sessionStorage.setItem('mrCam', choice); sessionStorage.setItem('mrFollowCam', followCamOn ? '1' : '0'); } catch {}
  const a = api();
  if (choice === 'auto') {
    if (a && a.setSplit) a.setSplit(false);
    setTvMode(true);
  } else {
    setTvMode(false);
    if (a) {
      if (choice === 'split') { if (a.setSplit) a.setSplit(true); }
      else {
        if (a.setSplit) a.setSplit(false);
        if (choice === 'follow') {
          const cur = currentRace();
          applyFollow(cur && !cur.result ? cur : replaying ? _replayRace : null);
          if (a.setCamera) a.setCamera('chase');
        } else if (a.setCamera) a.setCamera(choice);
      }
    }
  }
  if (!opts.quiet) closeCamPop();
  syncCamUI();
  renderMyMarble();
}
function followCamSet(on, opts = {}) {
  if (on && followId == null) return;
  if (on === followCamOn) { if (!opts.quiet) syncCamUI(); return; }
  setCameraChoice(on ? 'follow' : 'auto', { quiet: true });
}
const CAM_WORDS = { auto: 'Auto', follow: 'Following', overview: 'Overview', action: 'Action', top: 'Top', split: 'Split' };
function syncCamUI() {
  const a = api();
  let cam = 'overview';
  try { if (a && a.getCamera) cam = a.getCamera() || 'overview'; } catch {}
  // A keyboard shortcut inside the game is a manual choice too: reflect it.
  if (!tvMode) {
    const map = { chase: 'follow', overview: 'overview', action: 'action', top: 'top', split: 'split' };
    if (map[cam] && map[cam] !== camChoice && !(cam === 'chase' && camChoice === 'follow')) { camChoice = map[cam]; followCamOn = camChoice === 'follow'; }
  }
  const pop = el('camPop');
  if (pop)
    pop.querySelectorAll('.cp-mode').forEach((b) => {
      const on = tvMode ? b.dataset.mode === 'auto' : b.dataset.mode === camChoice;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (b.dataset.mode === 'follow') {
        b.disabled = followId == null;
        el('cpFollowHint').textContent = followId == null ? 'Pick a marble first' : 'Rides behind your marble while it races; follows the leader when it isn\'t racing';
      }
    });
  const word = el('camWord');
  if (word) word.textContent = tvMode ? 'Auto' : CAM_WORDS[camChoice] || 'Camera';
  const now = el('cpNow');
  if (now) now.textContent = tvMode ? `Auto is choosing the shots · now: ${cam}` : cam === 'blast' ? 'Marble Blast (press M to exit)' : '';
  const mc = el('mmCam');
  if (mc) mc.setAttribute('aria-pressed', followCamOn && !tvMode ? 'true' : 'false');
}
function closeCamPop() {
  const pop = el('camPop');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  el('camBtn').setAttribute('aria-expanded', 'false');
}
{
  const btn = el('camBtn');
  const pop = el('camPop');
  const setOpen = (open) => {
    if (open) { closeMenu(); }
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { syncCamUI(); const first = pop.querySelector('.cp-mode[aria-pressed="true"]') || pop.querySelector('.cp-mode'); if (first) first.focus(); }
    else btn.focus();
  };
  if (btn && pop) {
    btn.addEventListener('click', () => setOpen(pop.hidden));
    document.addEventListener('click', (e) => {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    });
    pop.querySelectorAll('.cp-mode').forEach((b) => b.addEventListener('click', () => setCameraChoice(b.dataset.mode)));
  }
  // The director is the DEFAULT; the session remembers a manual choice.
  let pref = 'auto';
  try { pref = sessionStorage.getItem('mrCam') || (sessionStorage.getItem('mrTv') === '0' ? 'overview' : 'auto'); } catch {}
  whenApiReady().then(() => setCameraChoice(pref === 'follow' && followId == null ? 'auto' : pref, { quiet: true }));
  setInterval(syncCamUI, 1000);
}

// ---- 3D renderer state -------------------------------------------------------------
// loading → ready | failed, with a retry that reloads the game frame in place
// (the parent's listeners and the live connection are untouched).
let rendererState = 'loading';
let _rendererWatch = 0;
let _retryN = 0;
function setRendererState(next) {
  if (next === rendererState) return;
  rendererState = next;
  el('stage').dataset.renderer = next;
  el('ssLoading').hidden = next !== 'loading';
  el('ssFailed').hidden = next !== 'failed';
  document.body.classList.toggle('no3d', next === 'failed');
  if (next === 'failed') { announce('The 3D race could not load. Standings and results are still live.'); hideRaceBoard(); }
  renderMyMarble();
  renderPreRace();
  renderStageFallback();
  syncCamUI();
}
function rendererEvent(ev) {
  setRendererState(UI.rendererNext(rendererState, ev));
}
function watchRenderer(isRetry) {
  clearInterval(_rendererWatch);
  const started = Date.now();
  let timedOut = false;
  _rendererWatch = setInterval(() => {
    const a = api();
    if (a && typeof a.startRace === 'function') {
      clearInterval(_rendererWatch);
      let noGl = false;
      try { noGl = !!gameFrame.contentWindow.__headlessNoGL; } catch {}
      rendererEvent(noGl ? 'gl_missing' : 'api_ready');
      // Only a RETRY needs to rejoin the race: on first load the normal
      // announce/start path is already waiting on the API.
      if (!noGl && isRetry) onRendererReady();
      return;
    }
    if (!timedOut && Date.now() - started > 30000) { timedOut = true; rendererEvent('timeout'); }
  }, 250);
}
function onRendererReady() {
  // After a retry the frame is fresh: rebuild the course on screen and
  // rejoin the race in progress from the server's clock.
  builtTrack = null;
  _preloadedKey = '';
  const cur = currentRace();
  if (cur && !cur.result && cur.scheduledStart) {
    startedRaces.delete(cur.key);
    scheduleStart(cur);
  }
  setTimeout(syncSettings, 200);
  renderAll();
}
function retryRenderer() {
  rendererEvent('retry');
  _retryN++;
  builtTrack = null;
  try { gameFrame.src = 'marble_run.html?embed=1&retry=' + _retryN; } catch {}
  watchRenderer(true);
}
// With no 3D view, the stage shows the current race as a list instead.
function renderStageFallback(prog) {
  if (rendererState !== 'failed') return;
  const box = el('ssFallback');
  if (!box) return;
  const cur = currentRace();
  const focus = cur && !cur.result ? cur : lastDoneRace();
  if (!focus) { box.innerHTML = model.rounds.length ? '<p class="dr-empty">The first race will be announced shortly.</p>' : ''; return; }
  const v = stateView();
  const announced = !!(cur && !cur.result);
  const status = announced ? (isLiveNow() ? 'Live' : v.primary) : 'Finished';
  const nxt = announced ? null : nextDrawnRace();
  box.innerHTML = `<h3 class="dr-h"><b>${esc(announced ? raceLabel(focus) : `Last result: ${raceShort(focus)}`)}</b><small>${esc(status)}</small></h3>` +
    `<div class="row-list">${raceRows(focus, isLiveNow() ? prog || _lastProg : null)}</div>` +
    (nxt ? `<p class="dr-empty">Next: ${esc(raceShort(nxt))} · Waiting to start</p>` : '');
}
{
  if (el('ssRetry')) el('ssRetry').addEventListener('click', retryRenderer);
  if (el('ssOpenTournament')) el('ssOpenTournament').addEventListener('click', () => openDrawer('race'));
  watchRenderer();
}

// ---- pre-race actions ------------------------------------------------------
if (el('watchLatestBtn')) el('watchLatestBtn').addEventListener('click', startLatestReplay);
if (el('replayExit')) el('replayExit').addEventListener('click', () => stopReplay(true));
if (el('prClose')) el('prClose').addEventListener('click', () => setPreRaceMin(true));
if (el('prMini')) el('prMini').addEventListener('click', () => setPreRaceMin(false));
if (el('prStarters'))
  el('prStarters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-guess]');
    if (!b) return;
    const id = Number(b.dataset.guess);
    const nxt = nextUpcomingRace();
    if (nxt) recordGuess(nxt.key, id);
    setFollow(id);
  });

// Escape closes whichever layer is open, innermost first.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el('pickerModal').hidden) closePicker();
  else if (!el('howModal').hidden) closeHow();
  else if (!el('moment').hidden) hideMoment();
  else if (!el('champOverlay').hidden) hideChampionCelebration();
  else if (!el('camPop').hidden) closeCamPop();
  else if (!el('menuPop').hidden) closeMenu();
  else if (drawerOpen) closeDrawer();
  else if (!el('preRace').hidden && !preRaceMin && !model.champion) setPreRaceMin(true);
});

// ---- iOS viewport pinning ---------------------------------------------------
{
  const snap = () => { if (window.scrollX || window.scrollY) window.scrollTo(0, 0); };
  window.addEventListener('scroll', snap, { passive: true });
  document.addEventListener('focusout', () => setTimeout(snap, 50));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => setTimeout(snap, 50));
  window.addEventListener('orientationchange', () => setTimeout(snap, 300));
}

// ---- live viewer presence -------------------------------------------------
(function presence() {
  let id = '';
  try { id = sessionStorage.getItem('mt-presence') || ''; } catch {}
  if (!id) {
    id = 'v-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('mt-presence', id); } catch {}
  }
  const badge = el('watching');
  const num = el('watchingN');
  let dead = false;
  async function beat() {
    if (dead) return;
    try {
      const r = await fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const d = await r.json();
      if (!d || !d.enabled) { dead = true; if (badge) badge.hidden = true; return; }
      if (badge && num) {
        num.textContent = d.count;
        const wrap = el('watchingWrap');
        if (wrap) wrap.hidden = !window.UIState.shouldShowViewerCount(d.count);
        badge.hidden = mode !== 'server';
      }
    } catch {
      dead = true;
      if (badge) badge.hidden = true;
    }
  }
  beat();
  setInterval(beat, 8000);
})();

// ---- optional custom marble skins (see public/marbles/README.md) -----------
let marbleManifest = null;
fetch('marbles/manifest.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((m) => {
    if (!m || typeof m !== 'object') return;
    marbleManifest = m;
    try { renderAll(); } catch {}
    whenApiReady().then(() => preloadRaceSkins());
  })
  .catch(() => {});

function applyRaceSkins(a, race) {
  if (!a || !a.setMarbleSkins || !marbleManifest || !race) return;
  const skins = {};
  for (const s of race.roster) {
    const sk = marbleManifest[s.marbleId] || marbleManifest[String(s.marbleId)];
    if (sk && (sk.img || sk.glb)) skins[s.lane] = sk;
  }
  a.setMarbleSkins(skins);
}

// First paint: the hero and the card render from whatever we know.
renderHero();
renderMyMarble();
renderTopBar();
