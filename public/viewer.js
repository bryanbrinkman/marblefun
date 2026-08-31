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

const TOTAL_RACES = 25; // 20 heats + 4 semis + 1 final
const RING_C = 2 * Math.PI * 28; // countdown ring circumference

const gameFrame = document.getElementById('game');
const el = (id) => document.getElementById(id);

const model = {
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
  startedRaces.add(race.key);
  // A "watch latest" replay yields the stage to the live race.
  if (replaying) {
    replaying = false;
    el('replayChip').hidden = true;
    clearLanes();
  }
  const a = await ensureCourse(race.trackSeed);
  applyRaceSkins(a, race);
  applyFollow(race);
  // If we're joining a race that already started (a mid-race page load), how far
  // into it we are — the game fast-forwards its deterministic sim by this much
  // so we land at the exact moment everyone else is watching, not at the gate.
  const catchUp = race.scheduledStart ? Math.max(0, (Date.now() - toLocal(race.scheduledStart)) / 1000) : 0;
  // startRace refuses (returns false) if a previous replay is still on screen.
  // That happens when a client is catching up or running faster than real
  // time — hard-reset the course and start cleanly so no race is skipped.
  const ok = a.startRace(race.raceSeed, catchUp);
  if (ok === false) {
    a.newCourse(race.trackSeed);
    builtTrack = race.trackSeed;
    a.startRace(race.raceSeed, catchUp);
  }

  // Label the game's in-race leaderboard with the competitor names, and cut to
  // the tracking (action) camera now that the race is live.
  try {
    if (a.setDisplayNames)
      a.setDisplayNames(Object.fromEntries(race.roster.map((s) => [s.lane, s.marbleName])));
    if (a.setCamera) a.setCamera('action');
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
  // The visitor has now seen a race start — future between-races cards are
  // compact for the rest of this browser session.
  markOnboarded();
  showFullOnce = false;
  if (race.key === model.currentKey) renderCurrent(race);
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
    ensureCourse(race.trackSeed);
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
      num.textContent = '0.0';
      arc.style.strokeDashoffset = String(RING_C);
      clearInterval(countdownTimer);
      return;
    }
    num.textContent = (remaining / 1000).toFixed(1);
    const frac = Math.max(0, Math.min(1, remaining / leadMs));
    arc.style.strokeDashoffset = String(RING_C * (1 - frac));
  };
  tick();
  countdownTimer = setInterval(tick, 100);
}

// ---- rendering -----------------------------------------------------------

const orderedRaces = () => model.rounds.flatMap((r) => r.races);
const shortName = (n) => n || ''; // marbles have real names now ("Purple Orbit")
const numOf = (id) => String(id).padStart(3, '0'); // compact numeric badge

// Meaningful race labels: spectators shouldn't need to decode "Heat 4 · 7/25".
function raceLabel(race) {
  if (!race) return '';
  if (race.roundKey === 'final') return 'Championship Race';
  if (race.roundKey === 'semis') return `Finals · Race ${race.indexInRound + 1} of 4`;
  return `Qualifying · Race ${race.indexInRound + 1} of 20`;
}

// The top-bar race label — SAME phase logic as the journey highlight
// (activeRound feeds both), so the bar and the card can never disagree.
function topLabel() {
  const round = activeRound();
  if (round === null) return 'Tournament starting';
  if (round === 'champion') return 'Tournament Complete';
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  const race = cur && !cur.result ? cur : orderedRaces().find((r) => !r.result);
  return race ? raceLabel(race) : 'Tournament starting';
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

// Which journey/funnel box to light up: the stage the field is racing FOR.
// Before race 1 → "100 started"; qualifying → "20 advance"; semis →
// "5 finalists"; the final (and a finished tournament) → "1 champion".
function journeyStage() {
  const round = activeRound();
  if (round === null) return 'heats';
  if (round === 'heats') return 'semis';
  if (round === 'semis') return 'final';
  return 'champion'; // 'final' or 'champion'
}
// Compact variant for tight rows (recent results, admin status).
function raceLabelShort(race) {
  if (!race) return '';
  if (race.roundKey === 'final') return 'Champ.';
  if (race.roundKey === 'semis') return `Finals ${race.indexInRound + 1}`;
  return `Qual ${race.indexInRound + 1}`;
}

function renderCurrent(race) {
  const title = el('raceTitle');
  const isFinal = race.roundKey === 'final';
  title.classList.toggle('final', isFinal);
  title.textContent = raceLabel(race);
  el('seedline').textContent = `track ${race.trackSeed} · race ${race.raceSeed}`;
  // The corner print link always exports the course on screen.
  const pl = el('printLink');
  if (pl) pl.href = '/print?seed=' + race.trackSeed;
  renderLanes(race);
  renderRoster(race);
}

function renderRoster(race) {
  const wrap = el('roster');
  wrap.className = 'roster' + (race.status === 'running' ? ' racing' : '');
  wrap.innerHTML = '';
  const rankBySlot = {};
  if (race.result) race.result.forEach((r) => (rankBySlot[r.slot] = r.rank));
  const rows = race.result
    ? race.result.map((r) => race.roster.find((s) => s.slot === r.slot))
    : race.roster;
  for (const s of rows) {
    const rank = rankBySlot[s.slot];
    const div = document.createElement('div');
    div.className = 'lane' + (rank === 1 ? ' win' : '');
    div.innerHTML =
      `<span class="swatch" style="background:${s.color}"></span>` +
      `<span class="lane-name">${s.marbleName}</span>` +
      (rank ? `<span class="rank">#${rank}</span>` : '');
    wrap.appendChild(div);
  }
}

function renderProgress() {
  const done = orderedRaces().filter((r) => r.result).length;
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  const shown = model.champion ? TOTAL_RACES : Math.min(TOTAL_RACES, done + (cur && !cur.result ? 1 : 0));
  const pc = el('progressCount');
  if (pc) pc.textContent = shown > 0 ? `Race ${shown} of ${TOTAL_RACES}` : '';
}

// ---- top-bar live race tracker -------------------------------------------
// One thin lane per marble (number on the left, a colored marble sliding
// toward a checkered finish on the right). The lanes come from the current
// race's roster; positions are polled live from the game each frame.
let _laneDots = {}; // laneName -> dot element
let _lanesKey = null; // which race the lanes were built for
function renderLanes(race) {
  const wrap = el('rcLanes');
  if (!wrap) return;
  if (_lanesKey === race.key && wrap.children.length > 1) return; // already built
  _lanesKey = race.key;
  _laneDots = {};
  wrap.innerHTML =
    '<div class="rc-checker"></div>' +
    race.roster
      .map(
        (s) =>
          `<div class="rc-lane"><span class="rc-num">${numOf(s.marbleId)}</span>` +
          `<div class="rc-rail"><span class="rc-dot" data-lane="${s.lane}" style="background:${s.color}"></span></div></div>`
      )
      .join('');
  for (const s of race.roster) _laneDots[s.lane] = wrap.querySelector(`.rc-dot[data-lane="${s.lane}"]`);
}
function clearLanes() {
  const wrap = el('rcLanes');
  if (wrap) wrap.innerHTML = '<div class="rc-checker"></div>';
  _laneDots = {};
  _lanesKey = null;
}
// Cheap per-frame poll of the game's live positions.
function trackTick() {
  const a = api();
  if (a && a.getProgress && _laneDots && Object.keys(_laneDots).length) {
    let prog = null;
    try {
      prog = a.getProgress();
    } catch {}
    if (prog) {
      for (const p of prog) {
        const dot = _laneDots[p.lane];
        if (dot) {
          dot.style.left = (p.pos * 100).toFixed(1) + '%';
          dot.classList.toggle('done', p.finished);
        }
      }
      updateFollowLive(prog);
      watchLeadChanges(prog);
    }
  }
  requestAnimationFrame(trackTick);
}
requestAnimationFrame(trackTick);

// ---- marble careers --------------------------------------------------------
// Lifetime stats per marble id from /api/careers (server mode only). Fetched
// once at boot and refreshed when a tournament completes; renders a one-line
// career summary in the Your Marble card and the follow pill's tooltip.
let _careers = null; // Map(id -> {races, wins, podiums, titles})
async function loadCareers() {
  try {
    const r = await fetch('/api/careers', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (d && Array.isArray(d.careers)) {
      _careers = new Map(d.careers.map((c) => [c.id, c]));
      renderPrMarble();
      renderFollowPill();
    }
  } catch {}
}
function careerLine(id) {
  if (!_careers || id == null) return '';
  const c = _careers.get(id);
  if (!c || !c.races) return 'Rookie — no races on record yet';
  const bits = [];
  if (c.titles) bits.push(`🏆 ${c.titles} ${c.titles > 1 ? 'championships' : 'championship'}`);
  bits.push(`${c.wins} race ${c.wins === 1 ? 'win' : 'wins'}`);
  bits.push(`${c.podiums} ${c.podiums === 1 ? 'podium' : 'podiums'}`);
  bits.push(`${c.races} races`);
  return bits.join(' · ');
}

// ---- lead-change callouts --------------------------------------------------
// The middle of a 60-120s race deserves a pulse: when the front of the pack
// changes hands, flash a small toast (and tell screen readers). Debounced so a
// tight duel doesn't machine-gun toasts, and quiet in the scrappy first
// moments off the gate.
let _leadLane = null;
let _leadToastAt = 0;
let _toastTimer = null;
function watchLeadChanges(prog) {
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
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
  showToast(`⚡ ${s.marbleName} takes the lead!`, s.color);
  announce(`${s.marbleName} takes the lead.`);
}
function showToast(text, color) {
  const t = el('raceToast');
  if (!t) return;
  t.innerHTML = `<span class="swatch" style="background:${color || 'var(--accent)'}"></span>${text}`;
  t.hidden = false;
  t.classList.remove('show');
  void t.offsetWidth; // restart the pop animation
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, 2600);
}

function renderFunnel() {
  const order = ['heats', 'semis', 'final', 'champion'];
  const activeIdx = order.indexOf(journeyStage());
  // Both phase strips (bracket funnel + pre-race journey) highlight together:
  // gold = the stage being raced for, ✓ = earned, muted = still to come.
  document.querySelectorAll('.funnel-stage, .j-stage').forEach((node) => {
    const idx = order.indexOf(node.dataset.stage);
    node.classList.toggle('active', idx === activeIdx);
    node.classList.toggle('done', idx < activeIdx);
  });
  // The "100 started" box drains as marbles bow out — progress you can feel.
  const alive = model.standings.length ? model.standings.filter((m) => m.status === 'alive').length : 100;
  const draining = model.standings.length > 0 && alive < 100 && !model.champion;
  document.querySelectorAll('.funnel-stage[data-stage="heats"], .j-stage[data-stage="heats"]').forEach((node) => {
    const b = node.querySelector('b');
    const lbl = node.querySelector('i, span');
    if (b) b.textContent = draining ? String(alive) : '100';
    if (lbl) lbl.textContent = draining ? 'still in' : lbl.tagName === 'I' ? 'started' : 'marbles';
  });
}

function renderUpNext() {
  const card = el('upnextCard');
  const order = orderedRaces();
  const curIdx = model.currentKey ? order.findIndex((r) => r.key === model.currentKey) : -1;
  const next = order.slice(curIdx + 1).find((r) => !r.result);
  if (!next || model.champion) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  el('upnextBody').innerHTML =
    `<div class="upnext-round">${raceLabel(next)}</div>` +
    `<div class="upnext-marbles">` +
    next.roster
      .map(
        (s) =>
          `<span class="um"><span class="swatch" style="background:${s.color}"></span>${shortName(s.marbleName)}</span>`
      )
      .join('') +
    `</div>`;
}

function renderRecent() {
  const done = orderedRaces().filter((r) => r.result);
  const card = el('recentCard');
  if (!done.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  el('recent').innerHTML = done
    .slice(-6)
    .reverse()
    .map((r) => {
      const w = r.result[0];
      const label = raceLabelShort(r);
      const t = w.timeSec != null ? w.timeSec.toFixed(1) + 's' : 'DNF';
      return (
        `<div class="recent-item"><span class="swatch" style="background:${w.color}"></span>` +
        `<span class="ri-label">${label}</span>` +
        `<span class="ri-win">${w.marbleName}</span>` +
        `<span class="ri-t">${t}</span></div>`
      );
    })
    .join('');
}

function renderStandings() {
  const wrap = el('standings');
  wrap.innerHTML = '';
  let alive = 0;
  for (const m of model.standings) {
    if (m.status === 'alive') alive++;
    const d = document.createElement('div');
    d.className = 'm ' + m.status;
    d.textContent = String(m.id).padStart(3, '0');
    d.title = `${m.name} — ${m.status}`;
    wrap.appendChild(d);
  }
  el('aliveCount').textContent = model.champion ? '' : alive + ' left';
}

// Two-sided "Road to the Final" bracket (Final-Four style): the four
// semifinals sit at the wings, converging through connectors to the Final and
// Champion in the centre, with a live Heats progress rail beneath. Rendered
// into the lower-third dock.
function bracketSlotRows(race) {
  if (!race) return '<div class="bd-tbd">— to be decided —</div>';
  const rankBySlot = {};
  const timeBySlot = {};
  if (race.result)
    race.result.forEach((r) => {
      rankBySlot[r.slot] = r.rank;
      timeBySlot[r.slot] = r.timeSec;
    });
  const rows = race.result
    ? race.result.map((r) => race.roster.find((s) => s.slot === r.slot))
    : race.roster;
  return rows
    .map((s) => {
      const rank = rankBySlot[s.slot];
      const done = rank != null;
      const t = done ? (timeBySlot[s.slot] != null ? timeBySlot[s.slot].toFixed(1) + 's' : 'DNF') : '';
      return (
        `<div class="bd-slot${rank === 1 ? ' win' : ''}">` +
        `<span class="pos">${done ? rank : ''}</span>` +
        `<span class="swatch" style="background:${s.color}"></span>` +
        `<span class="nm">${shortName(s.marbleName)}</span>` +
        `<span class="t">${t}</span></div>`
      );
    })
    .join('');
}

function bracketBox(race, label, cls) {
  const status = race ? (race.result ? 'done' : race.status || 'pending') : 'tbd';
  const current = race && race.key === model.currentKey ? ' current' : '';
  const justIn = race && race.key === justRevealed ? ' just-in' : '';
  return (
    `<div class="bd-box ${cls} ${status}${current}${justIn}">` +
    `<div class="bd-box-h">${label}</div>` +
    bracketSlotRows(race) +
    `</div>`
  );
}

function renderBracketDock() {
  const body = el('bracketBody');
  if (!body) return;
  const byKey = (k) => model.rounds.find((r) => r.key === k);
  const semis = byKey('semis');
  const final = byKey('final');
  const heats = byKey('heats');
  const semi = (i) => (semis && semis.races[i]) || null;
  const finalRace = final ? final.races[0] : null;

  const champ = model.champion
    ? `<div class="bd-champ has"><div class="bd-champ-t">🏆</div><div class="bd-champ-n">${model.champion.name}</div></div>`
    : `<div class="bd-champ"><div class="bd-champ-t">🏁</div><div class="bd-champ-n">Winner</div></div>`;

  const hraces = heats ? heats.races : [];
  const heatCol = (arr, offset) =>
    `<div class="bd-heatcol">` +
    arr.map((r, i) => bracketBox(r || null, 'Qualifier ' + (offset + i + 1), 'bd-heat')).join('') +
    `</div>`;

  // Preserve scroll position across the frequent re-renders (the full bracket is
  // wider AND taller than the dock, so it pans both ways); on the very first
  // render, centre on the Final.
  const prev = body.querySelector('.bd-scroll');
  const prevLeft = prev ? prev.scrollLeft : null;
  const prevTop = prev ? prev.scrollTop : null;

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
  if (sc) {
    sc.scrollLeft = prevLeft != null ? prevLeft : Math.max(0, (sc.scrollWidth - sc.clientWidth) / 2);
    sc.scrollTop = prevTop != null ? prevTop : Math.max(0, (sc.scrollHeight - sc.clientHeight) / 2);
  }
}

function renderChampion() {
  if (!model.champion) {
    // A fresh tournament (server auto-loop or local restart) clears the champion.
    el('championCard').hidden = true;
    return;
  }
  el('championCard').hidden = false;
  el('championName').textContent = model.champion.name;
  el('cd').classList.remove('live');
  el('countdown').textContent = '🏁';
  flashOverlay('🏆 ' + model.champion.name);
}

// ---- screen-reader narration ---------------------------------------------
function announce(text) {
  const n = el('srLive');
  if (n) n.textContent = text;
}

// ---- first-visit live intro ------------------------------------------------
// Shown once per session when someone lands in the middle of a live race —
// one line of context, dismissible, gone in 14s either way.
function maybeShowLiveIntro() {
  try { if (sessionStorage.getItem('mrLiveIntro') === '1') return; } catch {}
  const chip = el('liveIntro');
  if (!chip) return;
  try { sessionStorage.setItem('mrLiveIntro', '1'); } catch {}
  el('liveIntroText').textContent = `Live: ${topLabel()} — 100 marbles enter, one becomes champion`;
  chip.hidden = false;
  const hide = () => { chip.hidden = true; };
  el('liveIntroClose').addEventListener('click', hide, { once: true });
  setTimeout(hide, 14000);
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

// ---- follow-marble ("pick a marble") --------------------------------------
// One of the 100 marbles is *yours*: persisted locally, chased by the camera
// whenever it races, marked in the game, tracked in the pill up top.
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

function renderFollowPill() {
  const pill = el('followPill');
  if (!pill) return;
  const sw = el('fpSwatch');
  const tx = el('fpText');
  const st = followedStanding();
  if (!st) {
    pill.classList.remove('has');
    sw.hidden = true;
    tx.textContent = 'Pick a marble';
    return;
  }
  pill.classList.add('has');
  pill.title = careerLine(followId) || 'Your marble';
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  const slot = cur && cur.roster.find((x) => x.marbleId === followId);
  sw.hidden = !slot;
  if (slot) sw.style.background = slot.color;
  const status =
    st.status === 'champion' ? '🏆 champion' : st.status === 'eliminated' ? 'out' : slot ? 'racing' : 'alive';
  tx.textContent = `${shortName(st.name)} · ${status}`;
}

// Live position while your marble is racing (fed from the same getProgress
// poll that drives the top-bar lanes; throttled to 2 Hz).
let _fpLiveAt = 0;
function updateFollowLive(prog) {
  if (followId == null || !prog) return;
  const now = Date.now();
  if (now - _fpLiveAt < 500) return;
  _fpLiveAt = now;
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  if (!cur || cur.result) return;
  const slot = cur.roster.find((x) => x.marbleId === followId);
  if (!slot) return;
  const order = prog
    .slice()
    .sort((a, b) => (b.finished - a.finished) || (a.finished ? a.rank - b.rank : b.pos - a.pos));
  const idx = order.findIndex((p) => p.lane === slot.lane);
  if (idx < 0) return;
  const tx = el('fpText');
  if (tx) tx.textContent = `${shortName(slot.marbleName)} · P${idx + 1}`;
}

// The picker modal: all 100 marbles, searchable, with a lucky-dip button.
function buildPickerGrid() {
  const grid = el('pickerGrid');
  if (!grid) return;
  const q = (el('pickerSearch').value || '').trim().toLowerCase();
  if (!model.standings.length) {
    grid.innerHTML = '<div class="picker-note">The field is still loading — try again in a moment.</div>';
    return;
  }
  grid.innerHTML = model.standings
    .filter((m) => !q || String(m.id).padStart(3, '0').includes(q) || (m.name || '').toLowerCase().includes(q))
    .map((m) => {
      const cls =
        (m.status === 'eliminated' ? ' out' : m.status === 'champion' ? ' champ' : '') +
        (m.id === followId ? ' followed' : '');
      const label = (m.status === 'champion' ? '🏆' : '') + String(m.id).padStart(3, '0');
      return `<button class="pk${cls}" data-id="${m.id}" title="${m.name} — ${m.status}">${label}</button>`;
    })
    .join('');
}
function setFollow(id) {
  followId = id;
  saveFollow();
  renderFollowPill();
  buildPickerGrid();
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  applyFollow(cur && !cur.result ? cur : null);
  // Close the loop on picking: if your marble is racing RIGHT NOW, cut the
  // camera to it immediately — the pick should visibly do something.
  if (id != null && cur && !cur.result && startedRaces.has(cur.key) && cur.roster.some((s) => s.marbleId === id)) {
    const a = api();
    if (a && a.setCamera) a.setCamera('chase');
    if (typeof syncCamButtons === 'function') syncCamButtons();
  }
  renderPreRace();
}
const PICKER_NOTE_DEFAULT = 'Your pick is remembered on this device. The camera follows it whenever it races.';
let _pkConfirm = null; // eliminated-marble id awaiting a confirming second tap
let _pickerOpener = null; // element to give focus back to on close
function openPicker() {
  const ov = el('pickerModal');
  _pkConfirm = null;
  _pickerOpener = document.activeElement;
  const note = el('pickerNote');
  if (note) note.textContent = PICKER_NOTE_DEFAULT;
  buildPickerGrid();
  ov.hidden = false;
  const s = el('pickerSearch');
  if (s) { s.value = ''; buildPickerGrid(); s.focus(); }
}
function closePicker() {
  el('pickerModal').hidden = true;
  if (_pickerOpener && document.contains(_pickerOpener)) {
    try { _pickerOpener.focus(); } catch {}
  }
  _pickerOpener = null;
}

// ---- "watch latest race" replay -------------------------------------------
// Between races, re-run the previous race from its seeds (it's deterministic —
// the replay IS the race). Cancelled automatically the moment the next live
// race needs the stage.
let replaying = false;
async function startLatestReplay() {
  const done = orderedRaces().filter((r) => r.result);
  return startReplayOf(done[done.length - 1]);
}
async function startReplayOf(last) {
  if (replaying || mode !== 'server') return;
  if (!last || !last.result) return;
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  // Too close to a live start? Don't steal the stage for a replay.
  if (cur && !cur.result && cur.scheduledStart && toLocal(cur.scheduledStart) - Date.now() < 8000) return;
  replaying = true;
  el('replayChip').hidden = false;
  el('preRace').hidden = true;
  const a = await whenApiReady();
  a.newCourse(last.trackSeed); // hard reset even on the same track: clean gate start
  builtTrack = last.trackSeed;
  applyRaceSkins(a, last);
  try {
    if (a.setDisplayNames)
      a.setDisplayNames(Object.fromEntries(last.roster.map((s) => [s.lane, s.marbleName])));
  } catch {}
  applyFollow(last);
  renderLanes(last); // the top tracker follows the replay too
  a.startRace(last.raceSeed, 0);
  if (a.setCamera) a.setCamera('action');
}
function stopReplay(restoreStage) {
  if (!replaying) return;
  replaying = false;
  el('replayChip').hidden = true;
  clearLanes();
  if (restoreStage) {
    const a = api();
    const cur = model.currentKey && model.racesByKey.get(model.currentKey);
    if (a) {
      if (cur && !cur.result) {
        a.newCourse(cur.trackSeed);
        builtTrack = cur.trackSeed;
        applyFollow(cur);
      }
      if (a.setCamera) a.setCamera('overview');
    }
    renderAll();
  }
  renderPreRace();
}

// ---- pre-race experience ---------------------------------------------------
// Between races the screen shouldn't feel dead: the idle 3D stage keeps
// playing underneath while this card counts down exactly to the next start
// and offers something to do (replay the last race, pick a marble).
//
// The FULL explainer (tagline, journey strip, starters) shows until the
// visitor has watched a race start this browser session; after that a compact
// card keeps the 3D stage visible. "How it works" reopens the full version.
const ONBOARD_KEY = 'mrOnboarded'; // sessionStorage: '1' once a race has started
let showFullOnce = false; // "How it works" re-expands until the next race
function isOnboarded() {
  try { return sessionStorage.getItem(ONBOARD_KEY) === '1'; } catch { return false; }
}
function markOnboarded() {
  try { sessionStorage.setItem(ONBOARD_KEY, '1'); } catch {}
}

// Clock/countdown formatting + display strings live in the shared, unit-tested
// module (public/event-state.js) so browser UI and node tests agree exactly.
const fmtClock = window.UIState.fmtClock;
const ordinal = (n) => {
  const t = n % 100;
  return n + (t >= 11 && t <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
};

// The race the countdown points at: the announced current race, else the
// first race without a result yet.
function nextUpcomingRace() {
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  if (cur && !cur.result) return cur;
  return orderedRaces().find((r) => !r.result) || null;
}

// The last race the marble actually ran (for the eliminated story).
function eliminationInfo(id) {
  const raced = orderedRaces().filter((r) => r.result && r.roster && r.roster.some((s) => s.marbleId === id));
  const last = raced[raced.length - 1];
  if (!last) return null;
  const i = last.result.findIndex((x) => x.marbleId === id);
  const row = i >= 0 ? last.result[i] : null;
  return { label: raceLabel(last), rank: row ? row.rank || i + 1 : null, race: last };
}

// Best-known lane color for a marble (its most recent race), else gold.
function marbleColor(id) {
  const races = orderedRaces();
  for (let i = races.length - 1; i >= 0; i--) {
    const s = races[i].roster && races[i].roster.find((x) => x.marbleId === id);
    if (s) return s.color;
  }
  return '#ffcf5c';
}

// The "your marble" block: a pick button before choosing, a status card after.
function renderPrMarble() {
  const wrap = el('prMarble');
  if (!wrap) return;
  if (followId == null) {
    wrap.innerHTML = `<button class="pr-btn primary" id="prPickBtn">🔮 Pick a marble</button>`;
    return;
  }
  const st = followedStanding();
  const num = String(followId).padStart(3, '0');
  const skin = marbleManifest && (marbleManifest[followId] || marbleManifest[String(followId)]);
  const ballStyle = skin && skin.img
    ? `background-image:url('${skin.img}');background-size:cover;background-position:center`
    : `background:radial-gradient(circle at 32% 28%, rgba(255,255,255,.92), rgba(255,255,255,0) 34%),` +
      `radial-gradient(circle at 50% 45%, ${marbleColor(followId)} 0%, #131a2a 135%)`;
  // In-roster check for a round: has this marble earned a spot there?
  const inRound = (key) => {
    const round = model.rounds.find((r) => r.key === key);
    return !!(round && round.races.some((r) => r.roster && r.roster.some((s) => s.marbleId === followId)));
  };
  let status;
  let mainAction = `<button class="prm-follow" id="prFollowBtn">📍 Follow</button>`;
  if (!st) {
    // Friendly fallback; the selection is retained for when data returns.
    status = 'Marble status temporarily unavailable';
    mainAction = '';
  } else if (st.status === 'champion') {
    status = '🏆 Tournament champion!';
    mainAction = `<button class="prm-follow" id="prWatchFinishBtn">🏆 Watch finish</button>`;
  } else if (st.status === 'eliminated') {
    const e = eliminationInfo(followId);
    status = e ? `Eliminated in ${e.label}${e.rank ? ` · finished ${ordinal(e.rank)}` : ''}` : 'Eliminated';
    // An eliminated marble isn't racing — offer its final race instead of a
    // follow camera (replays are a server-mode feature).
    mainAction = mode === 'server' && e ? `<button class="prm-follow" id="prViewRaceBtn">▶ View race</button>` : '';
  } else {
    const nxt = nextUpcomingRace();
    if (nxt && nxt.roster && nxt.roster.some((s) => s.marbleId === followId)) status = '✨ In the next race!';
    else if (inRound('final')) status = '👑 Racing in the Championship!';
    else if (inRound('semis')) status = '🎉 Qualified for the finals';
    else status = 'Still racing';
  }
  wrap.innerHTML =
    `<div class="prm${st && st.status === 'eliminated' ? ' out' : ''}">` +
    `<span class="prm-ball" style="${ballStyle}" aria-hidden="true"></span>` +
    `<span class="prm-info"><i class="prm-k">Your marble</i>` +
    `<b>${st ? st.name : 'Marble ' + num} <span class="prm-id">#${num}</span></b>` +
    `<span class="prm-status">${status}</span>` +
    `<span class="prm-career" id="prCareer"></span></span>` +
    `<span class="prm-actions">${mainAction}` +
    `<button class="prm-change" id="prChangeBtn">Change</button></span>` +
    `</div>`;
  const cl = el('prCareer');
  if (cl) {
    const line = careerLine(followId);
    cl.textContent = line;
    cl.hidden = !line;
  }
}

// ---- shared event-state model ----------------------------------------------
// ONE source of truth for "what is happening right now". The top bar, the
// between-races card, the countdown and the badge all read this — no component
// re-derives event status on its own.
// States: LOADING | BETWEEN_RACES | COUNTDOWN | STARTING | LIVE | DELAYED |
//         RECONNECTING | OFFLINE | TOURNAMENT_COMPLETE
function eventState() {
  const connSt = (el('conn') && el('conn').dataset.state) || 'connecting';
  if (connSt === 'reconnecting') return 'RECONNECTING';
  if (model.champion) return 'TOURNAMENT_COMPLETE';
  if (connSt === 'offline' && !model.rounds.length) return 'OFFLINE';
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  if (cur && !cur.result && startedRaces.has(cur.key)) return 'LIVE';
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

// The presentation mapping for each state: eyebrow, primary (from the shared,
// tested formatter — never blank, never an em dash), secondary copy, and the
// top-bar ring's fallback text when no live countdown ring is running.
function stateView() {
  const st = eventState();
  const nxt = nextUpcomingRace();
  const at = nxt && nxt.scheduledStart ? toLocal(nxt.scheduledStart) : null;
  const primary = window.UIState.getNextRaceDisplay({ eventState: st, nextRaceAt: at, now: Date.now() });
  switch (st) {
    case 'LOADING':
      return { st, eyebrow: 'Warming up', primary, secondary: 'Setting up the tournament', cd: '…' };
    case 'COUNTDOWN':
      return { st, eyebrow: 'Between races', primary, secondary: nxt ? raceLabel(nxt) : 'Warming up the track…', cd: null };
    case 'STARTING':
      return { st, eyebrow: 'Between races', primary, secondary: nxt ? raceLabel(nxt) : '', cd: null };
    case 'LIVE':
      return { st, eyebrow: '', primary, secondary: '', cd: null }; // card hidden; ring says LIVE
    case 'DELAYED':
      return { st, eyebrow: 'Race delayed', primary, secondary: 'Resetting the course…', cd: '…' };
    case 'RECONNECTING':
      return { st, eyebrow: 'Connection', primary, secondary: 'The tournament is still running.', cd: '…' };
    case 'OFFLINE':
      return { st, eyebrow: 'Offline', primary, secondary: 'Results and the latest replay are still available.', cd: '…' };
    case 'TOURNAMENT_COMPLETE':
      return {
        st,
        eyebrow: 'Tournament complete',
        primary: model.champion ? `🏆 ${model.champion.name} takes the crown` : primary,
        secondary: 'A fresh tournament starts soon',
        cd: '🏁',
      };
    default:
      return { st: 'BETWEEN_RACES', eyebrow: 'Between races', primary, secondary: 'Warming up the track…', cd: '…' };
  }
}

// Per-second update of the countdown sentence + the top-bar ring fallback.
// Always recomputed from the scheduled timestamp (server-clock adjusted), so a
// suspended tab that wakes up shows the right value immediately.
//
// Screen-reader policy: the ticking text is NOT a live region. Only meaningful
// milestones are announced, once each per race: one minute out, ten seconds
// out, and the start itself (announced from startReplay).
let _announced = { key: null, min: false, ten: false };
function tickPreRaceCountdown() {
  const v = stateView();
  // Top-bar ring text for states where the 100 ms countdown ring isn't running.
  if (v.cd !== null && !startedRacesHasCurrent()) {
    const num = el('countdown');
    if (num) num.textContent = v.cd;
  }
  // Countdown milestone announcements.
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
  if (!panel || panel.hidden) return;
  if (document.body.classList.contains('paused')) return;
  if (v.st === 'TOURNAMENT_COMPLETE') return; // static copy set by renderPreRace
  el('prTitle').textContent = v.primary;
  el('prFlavor').textContent = v.secondary;
}
function startedRacesHasCurrent() {
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  return !!(cur && startedRaces.has(cur.key) && !cur.result);
}
setInterval(tickPreRaceCountdown, 1000);

function renderPreRace() {
  const panel = el('preRace');
  if (!panel) return;
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  const live = cur && !cur.result && startedRaces.has(cur.key);
  const celebrating = !el('champOverlay').hidden;
  if (live || replaying || celebrating) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  // Compact after onboarding (this session), except for the champion moment.
  const compact = isOnboarded() && !showFullOnce && !model.champion;
  el('prCard').classList.toggle('compact', compact);
  el('prHow').hidden = !compact;

  const state = el('prState');
  const title = el('prTitle');
  const flavor = el('prFlavor');
  const starters = el('prStarters');
  // Local mode drives the stage itself (fast-forward computations between
  // races), so the replay button is a server-mode feature only.
  const latest = orderedRaces().some((r) => r.result) && mode === 'server';
  el('watchLatestBtn').hidden = !latest;
  renderPrMarble();

  if (model.champion) {
    state.textContent = 'Tournament complete';
    title.textContent = `🏆 ${model.champion.name} takes the crown`;
    flavor.textContent = 'A fresh tournament starts soon';
    starters.innerHTML = '';
    return;
  }
  if (document.body.classList.contains('paused')) {
    state.textContent = 'Short break';
    title.textContent = 'Racing resumes soon';
    flavor.textContent = 'The marbles are catching their breath';
    starters.innerHTML = '';
    return;
  }

  const v = stateView();
  state.textContent = v.eyebrow;
  title.textContent = v.primary;
  flavor.textContent = v.secondary;
  // Replays don't make sense seconds before a live start or with no results.
  if (v.st === 'STARTING') el('watchLatestBtn').hidden = true;
  // Call-the-winner: the five starters are tappable — backing one makes it
  // your followed marble (same persistence as the picker). Shown in the
  // compact card too; guessing is the between-races game.
  const nxt = nextUpcomingRace();
  const showStarters = nxt && nxt.roster && (v.st === 'COUNTDOWN' || v.st === 'STARTING');
  el('prGuessLabel').hidden = !showStarters;
  starters.innerHTML = showStarters
    ? nxt.roster
        .map((s) => {
          const mine = s.marbleId === followId;
          return (
            `<button class="um${mine ? ' followed' : ''}" data-guess="${s.marbleId}"` +
            ` aria-pressed="${mine ? 'true' : 'false'}" title="Back ${s.marbleName} to win">` +
            `<span class="swatch" style="background:${s.color}"></span>${shortName(s.marbleName)}` +
            (mine ? ' 🎯' : '') +
            `</button>`
          );
        })
        .join('')
    : '';
}

// ---- call-the-winner bookkeeping -------------------------------------------
// Backing a starter follows it AND records the guess for that race, so we can
// celebrate a correct call when the result lands.
function recordGuess(raceKey, marbleId) {
  try { localStorage.setItem('marbleGuess', JSON.stringify({ raceKey, marbleId })); } catch {}
}
function checkGuess(race) {
  let g = null;
  try { g = JSON.parse(localStorage.getItem('marbleGuess') || 'null'); } catch {}
  if (!g || !race || g.raceKey !== race.key || !race.result || !race.result[0]) return;
  try { localStorage.removeItem('marbleGuess'); } catch {}
  if (race.result[0].marbleId === g.marbleId) {
    flashOverlay('🎯 CALLED IT!');
    announce(`You called it — ${race.result[0].marbleName} wins!`);
  }
}

function renderAll() {
  renderProgress();
  renderFunnel();
  renderUpNext();
  renderRecent();
  renderBracketDock();
  renderStandings();
  renderChampion();
  renderFollowPill();
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  if (cur) renderCurrent(cur);
  else {
    // No current race: the top label still reflects the shared phase mapping
    // ("Tournament starting" / next race / "Tournament Complete").
    const title = el('raceTitle');
    title.classList.remove('final');
    title.textContent = topLabel();
    if (!replaying) clearLanes();
  }
  renderPreRace();
}

// ---- message handling ----------------------------------------------------

function ingestSnapshot(msg) {
  clockOffset = msg.serverNow - Date.now();
  leadMs = msg.announceLeadMs || leadMs;
  model.rounds = msg.rounds;
  model.marbles = msg.marbles;
  model.standings = msg.standings;
  model.champion = msg.tournament.champion;
  model.racesByKey.clear();
  for (const round of msg.rounds)
    for (const race of round.races) model.racesByKey.set(race.key, race);
  for (const race of model.racesByKey.values()) if (race.result) startedRaces.add(race.key);

  if (typeof msg.paused === 'boolean') reflectServerPaused(msg.paused);
  // A snapshot without a champion is a fresh tournament — end the party.
  if (!msg.tournament || !msg.tournament.champion) hideChampionCelebration();

  const cur = msg.current;
  model.currentKey = cur ? cur.raceKey : null;
  renderAll();
  // Landing mid-race is the coldest entry — one dismissible line of context.
  if (cur && cur.phase === 'running') maybeShowLiveIntro();

  if (cur && (cur.phase === 'announced' || cur.phase === 'running')) {
    const race = model.racesByKey.get(cur.raceKey);
    if (race && !race.result) scheduleStart(race);
  }
}

// Past champions (hall of fame) — server-recorded history, newest first.
// Server-only: on a static host there's no cross-visitor history to show.
async function loadChampions() {
  const card = el('champsCard');
  if (!card) return;
  try {
    const r = await fetch('/api/champions', { cache: 'no-store' });
    if (!r.ok) return;
    const rows = ((await r.json()) || {}).champions || [];
    if (!rows.length) return; // keep hidden until there's at least one winner
    card.hidden = false;
    const n = el('champsCount');
    if (n) n.textContent = rows.length;
    el('champsBody').innerHTML = rows
      .map((c) => {
        const when = c.created_at
          ? new Date(c.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : '';
        return (
          `<div class="champ-row"><span class="ct">🏆</span>` +
          `<b>${c.champion_name}</b>` +
          `<span class="cwhen">${when}</span><span class="cid">#${c.tournament_id}</span></div>`
        );
      })
      .join('');
  } catch {}
}

// ---- tournament-champion celebration --------------------------------------
// Full-screen moment when a champion is crowned: the winning marble huge and
// glossy (using its lane color, or its custom image skin if one is installed),
// name in lights, and a canvas fireworks show. Dismissed by click/✕, or
// automatically when the next tournament starts.

let _fwRaf = 0;
let _fwTimer = 0;
function startFireworks(baseColor) {
  // Respect reduced-motion: the celebration still shows, just without the show.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = el('fwCanvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const fit = () => {
    cv.width = cv.clientWidth * dpr;
    cv.height = cv.clientHeight * dpr;
  };
  fit();
  const palette = ['#ffcf5c', '#ffffff', '#ff9d3c', baseColor || '#5bc0de'];
  const rockets = [];
  const sparks = [];
  const launch = () => {
    rockets.push({
      x: cv.width * (0.15 + Math.random() * 0.7),
      y: cv.height + 10,
      vy: -(cv.height * (0.011 + Math.random() * 0.005)),
      burstY: cv.height * (0.18 + Math.random() * 0.3),
      color: palette[(Math.random() * palette.length) | 0],
    });
  };
  const burst = (r) => {
    const n = 70 + ((Math.random() * 40) | 0);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
      const sp = (2 + Math.random() * 4.2) * dpr;
      sparks.push({
        x: r.x, y: r.y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, decay: 0.009 + Math.random() * 0.011,
        color: Math.random() < 0.75 ? r.color : '#ffffff',
      });
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
      if (r.y <= r.burstY) {
        burst(r);
        rockets.splice(i, 1);
      }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.045 * dpr; // gravity
      s.vx *= 0.985;
      s.life -= s.decay;
      if (s.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
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
  if (cv) {
    const ctx = cv.getContext('2d');
    ctx && ctx.clearRect(0, 0, cv.width, cv.height);
  }
}

// Darken a #rrggbb color for the ball's shaded side.
function shadeColor(hex, k) {
  const n = parseInt((hex || '#ffcf5c').replace('#', ''), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function showChampionCelebration(champion) {
  const ov = el('champOverlay');
  if (!ov || !champion) return;
  // The champion's look: lane color from the final's result, or its custom
  // image skin when a manifest provides one.
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
  el('coName').textContent = champion.name;
  ov.hidden = false;
  requestAnimationFrame(() => ov.classList.add('show'));
  stopFireworks();
  startFireworks(color);
  renderPreRace(); // the pre-race card stays out of the party's way
}
function hideChampionCelebration() {
  const ov = el('champOverlay');
  if (!ov || ov.hidden) return;
  stopFireworks();
  ov.classList.remove('show');
  setTimeout(() => {
    ov.hidden = true;
    renderPreRace(); // …and returns once the party is dismissed
  }, 500);
}
{
  const ov = el('champOverlay');
  const close = el('coClose');
  if (close) close.addEventListener('click', hideChampionCelebration);
  // Share the champion moment: native share sheet where available, else
  // copy-to-clipboard with visible confirmation.
  const share = el('coShare');
  if (share)
    share.addEventListener('click', async () => {
      const name = model.champion ? model.champion.name : 'A marble';
      const text = `🏆 ${name} just won the 100-marble tournament on marblerun.fun!`;
      const url = 'https://marblefun.fly.dev/';
      try {
        if (navigator.share) {
          await navigator.share({ title: 'marblerun.fun', text, url });
          return;
        }
      } catch { return; } // user cancelled the sheet — done
      try {
        await navigator.clipboard.writeText(`${text} ${url}`);
        share.textContent = '✓ Copied to clipboard';
      } catch {
        share.textContent = url;
      }
      setTimeout(() => (share.textContent = '📣 Share the moment'), 2500);
    });
  if (ov) ov.addEventListener('click', (e) => { if (e.target === ov) hideChampionCelebration(); });
}

// Reflect the SERVER's paused state (admin-driven) in the viewer UI, reusing
// the same badge/dimming the local-mode pause uses.
function reflectServerPaused(paused) {
  document.body.classList.toggle('paused', paused);
  const badge = el('pausedBadge');
  if (badge) badge.hidden = !paused;
  renderPreRace(); // the pre-race card softens into "short break" while paused
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
      break;
    }
    case 'race_start': {
      clockOffset = msg.serverNow - Date.now();
      const race = model.racesByKey.get(msg.raceKey);
      if (race) startReplay(race);
      break;
    }
    case 'race_result': {
      const race = model.racesByKey.get(msg.raceKey);
      if (race) race.result = msg.result;
      model.standings = msg.standings;
      justRevealed = msg.raceKey;
      renderAll();
      justRevealed = null;
      if (race && race.result && race.result[0])
        announce(`${race.result[0].marbleName} wins ${raceLabel(race)}.`);
      checkGuess(race);
      break;
    }
    case 'paused':
      reflectServerPaused(!!msg.paused);
      break;
    case 'no_tournament':
      // Server is reachable but has no live tournament (e.g. its headless
      // simulator couldn't start). Run the whole tournament in-browser instead
      // of waiting forever on a server that will never announce a race.
      goLocal();
      break;
    case 'tournament_complete':
      model.champion = msg.champion;
      model.currentKey = null;
      renderAll();
      loadChampions(); // the hall of fame just gained a row
      loadCareers(); // career stats just changed too
      showChampionCelebration(msg.champion);
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
// When there's no WebSocket server (e.g. a static host like Vercel), the
// browser runs the whole tournament itself: it builds the bracket, announces
// each race, drives the real race in the iframe, reads the finishing order
// back out of the game, records it, and advances — looping forever with a
// fresh tournament after each champion. Fully deterministic, no backend.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// `?fast=1` shortens the between-race countdown/gap for demos and impatient
// viewers (the races themselves still run at real time).
const LOCAL_FAST = new URLSearchParams(location.search).has('fast');
const LOCAL_LEAD_MS = LOCAL_FAST ? 800 : 10000;
const LOCAL_GAP_MS = LOCAL_FAST ? 500 : 3000;

function syncRounds(T) {
  model.rounds = T.rounds.map((r) => ({ key: r.key, title: r.title, idx: r.idx, races: r.races }));
  model.marbles = T.marbles;
  model.racesByKey.clear();
  for (const round of T.rounds) for (const race of round.races) model.racesByKey.set(race.key, race);
}

// ---- admin control (pause / reset) — driven by /admin.html ----------------
// Local mode runs entirely in the browser, so admin commands are delivered over
// a same-origin BroadcastChannel and the paused flag is persisted in
// localStorage. They control the tournament running in THIS browser (each
// visitor runs their own independent tournament).
const adminChannel = 'BroadcastChannel' in window ? new BroadcastChannel('marble-admin') : null;
let localPaused = false;
let localResetToken = 0;
let localForcedSeed = null;

function loadAdminState() {
  try {
    localPaused = !!JSON.parse(localStorage.getItem('marble-admin') || '{}').paused;
  } catch {}
}
function persistPaused() {
  try {
    localStorage.setItem('marble-admin', JSON.stringify({ paused: localPaused }));
  } catch {}
}
function reflectPaused() {
  document.body.classList.toggle('paused', localPaused);
  const badge = el('pausedBadge');
  if (badge) badge.hidden = !localPaused;
  renderPreRace();
}
function broadcastStatus() {
  if (!adminChannel) return;
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  adminChannel.postMessage({
    type: 'status',
    paused: localPaused,
    mode,
    current: cur ? raceLabel(cur) : null,
    champion: model.champion ? model.champion.name : null,
    done: orderedRaces().filter((r) => r.result).length,
    total: TOTAL_RACES,
  });
}
function handleAdminCommand(cmd) {
  if (!cmd || !cmd.type) return;
  if (cmd.type === 'pause') localPaused = true;
  else if (cmd.type === 'resume') localPaused = false;
  else if (cmd.type === 'reset') {
    localForcedSeed = cmd.seed != null ? cmd.seed >>> 0 : null;
    localResetToken++;
    localPaused = false;
  } else if (cmd.type === 'request-status') {
    broadcastStatus();
    return;
  } else return;
  persistPaused();
  reflectPaused();
  broadcastStatus();
}
if (adminChannel) adminChannel.onmessage = (e) => handleAdminCommand(e.data);

// Hold here while paused (checked between races).
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
  let n = 0;
  for (;;) {
    const myToken = localResetToken;
    const seed =
      localForcedSeed != null
        ? localForcedSeed
        : (Date.now() ^ (n++ * 0x9e3779b1) ^ (Math.floor(performance.now()) * 0x2545f4914f)) >>> 0;
    localForcedSeed = null;
    const completed = await runLocalTournament(seed, () => localResetToken !== myToken);
    // Only pause on the champion if the run finished naturally (not reset).
    if (localResetToken === myToken && completed) await sleep(14000);
  }
}

async function runLocalTournament(seed, aborted) {
  const T = new window.TournamentCore.Tournament(seed);
  hideChampionCelebration(); // fresh tournament — end the previous party
  model.champion = null;
  el('championCard').hidden = true;
  startedRaces = new Set();
  builtTrack = null;
  syncRounds(T);
  model.standings = window.TournamentCore.standings(T);
  model.currentKey = null;
  renderAll();
  broadcastStatus();
  // (No shared course to pre-build — every race builds its own track.)

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
        continue;
      }
      T.advance(); // sets champion once the final is done
      break;
    }
    await runLocalRace(T, race, aborted);
    broadcastStatus();
  }

  model.champion = T.champion ? { id: T.champion, name: T.marbleName(T.champion) } : null;
  model.currentKey = null;
  renderAll();
  renderChampion();
  if (model.champion) showChampionCelebration(model.champion);
  broadcastStatus();
  return true;
}

// Map the game's color-lane results back to this race's tournament marbles.
// Any marble missing from the results (never finished) is recorded as a DNF.
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

// The authoritative finishing order, computed via the game's deterministic
// fast-forward. This never depends on the *visible* (rAF-driven) race actually
// completing, so results are always correct — no false DNFs even if the tab is
// throttled or the device is slow.
async function computeResult(race) {
  const a = await whenApiReady();
  let sim = null;
  try {
    sim = a.simulateRace(race.raceSeed);
  } catch (e) {
    console.error('simulateRace failed', e);
  }
  return _mapOrder(race, sim && sim.results);
}

// Hold the reveal until the on-screen race would have finished: either the
// visible marbles actually reach the line, or a cap based on the known finish
// time elapses (covers throttled rendering). The result is already known.
async function waitForVisualFinish(race, order, aborted) {
  const a = await whenApiReady();
  // How many marbles actually finish (a stuck marble never crosses the line).
  const finishers = order.filter((o) => o.timeSec != null).length || race.roster.length;
  const maxFin = order.reduce((mx, o) => Math.max(mx, o.timeSec || 0), 0);
  // Fast/demo mode reveals quickly. Otherwise hold the reveal until those
  // marbles have actually crossed the line on screen — so the next race never
  // starts before this one visibly finishes — with a generous safety cap so a
  // throttled or backgrounded tab still advances eventually.
  const cap = LOCAL_FAST ? 1500 : (maxFin * 2 + 30) * 1000;
  const start = Date.now();
  for (;;) {
    let n = 0;
    try {
      n = (a.getResults() || []).length;
    } catch {}
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
  // Compute the true result first (deterministic fast-forward), then reset the
  // marbles to the gate for a clean pre-race view (no course rebuild).
  let order = await computeResult(race);
  // A rare track seed builds a poor course where marbles jam at the start and
  // most never finish. Require a MAJORITY of the field to finish (ceil(roster/2),
  // i.e. 3 of 5); otherwise skip to the next candidate seed — the EXACT rule and
  // threshold the server scheduler uses (scheduler._computeOrder), so both modes
  // agree on every race's course.
  const minFinishers = Math.max(1, Math.ceil(race.roster.length / 2));
  const finisherCount = (o) => o.filter((x) => x.timeSec != null).length;
  for (let attempt = 1; attempt <= 4 && finisherCount(order) < minFinishers; attempt++) {
    race.trackSeed = window.TournamentCore.deriveSeed(
      T.masterSeed, 0x7a2c, race.roundIdx + 1, race.indexInRound + 1, attempt
    );
    console.warn('[viewer] dud track for ' + race.key + ' — retrying with candidate ' + attempt);
    await ensureCourse(race.trackSeed);
    order = await computeResult(race);
  }
  const a = await whenApiReady();
  applyRaceSkins(a, race);
  if (a.resetForNextRace) a.resetForNextRace(race.raceSeed);
  else a.newCourse(race.trackSeed);
  // Show the far overview of the whole course during the countdown; the
  // tracking camera then eases in and follows the leader when the race starts.
  if (a.setCamera) a.setCamera('overview');
  await sleep(Math.max(0, race.scheduledStart - Date.now()));
  await startReplay(race); // play the visible race for viewers to watch (cuts to the tracking cam)
  await waitForVisualFinish(race, order, aborted);
  if (aborted && aborted()) return; // a reset fired mid-race; abandon this result
  T.applyResult(race, order);
  race.status = 'done';
  model.standings = window.TournamentCore.standings(T);
  justRevealed = race.key;
  renderAll();
  justRevealed = null;
  if (order && order[0]) announce(`${order[0].marbleName} wins ${raceLabel(race)}.`);
  checkGuess(race);
  await sleep(LOCAL_GAP_MS);
}

// ---- websocket -----------------------------------------------------------
// Try a server first; if none answers (static hosting), fall back to local mode.

let mode = 'connecting'; // 'connecting' | 'server' | 'local'
let serverKnown = false; // /api/state confirmed a live server → never fall back to local
let lastMsgAt = 0; // when the server last spoke (for the "delayed" state)

// Local mode's connection label: honest about WHY we're local. With no network
// it's "offline"; on a static host it's simply running in-browser. Either way
// the visitor still gets full races (the sim is deterministic and local).
function reflectLocalConn() {
  if (navigator.onLine === false)
    setConn('offline', '⚡ offline', 'No connection — a full tournament runs locally in your browser');
  else
    setConn('local', '▶ local races', 'No live server — a full tournament runs locally in your browser');
}
window.addEventListener('online', () => { if (mode === 'local') reflectLocalConn(); });
window.addEventListener('offline', () => { if (mode === 'local') reflectLocalConn(); });

// "Delayed": connected, but the server has gone quiet for far longer than the
// longest normal between-message gap. Distinct from reconnecting/offline.
setInterval(() => {
  if (mode !== 'server' || !lastMsgAt) return;
  const c = el('conn');
  if (Date.now() - lastMsgAt > 180000 && c.dataset.state === 'live')
    setConn('delayed', '⏱ delayed…', 'Connected, but no update from the server in a while');
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
  // Only fall back to a local (in-browser) tournament when we DON'T know a
  // server exists. If /api/state already confirmed one, keep trying the socket
  // instead — otherwise a slow handshake on refresh would flash a divergent
  // random tournament before snapping back to the live one.
  const fallback = serverKnown
    ? null
    : setTimeout(() => {
        if (mode === 'connecting') {
          try {
            ws.close();
          } catch {}
          goLocal();
        }
      }, 3000);
  ws.onopen = () => {
    if (mode === 'local') {
      try {
        ws.close();
      } catch {}
      return; // already fell back; don't run two tournaments at once
    }
    mode = 'server';
    if (fallback) clearTimeout(fallback);
    lastMsgAt = Date.now();
    setConn('live', '● LIVE', 'Connected — races broadcast in real time');
  };
  ws.onclose = () => {
    if (fallback) clearTimeout(fallback);
    if (mode === 'server' || serverKnown) {
      setConn('reconnecting', '⟳ retrying…', 'Lost the live feed — retrying automatically');
      if (mode !== 'local') setTimeout(connect, 1500);
    } else if (mode === 'connecting') {
      goLocal();
    }
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
  ws.onmessage = (ev) => {
    if (mode === 'local') return; // already fell back; ignore late server msgs
    if (mode !== 'server') mode = 'server';
    lastMsgAt = Date.now();
    const c = el('conn');
    if (c.dataset.state !== 'live') setConn('live', '● LIVE', 'Connected — races broadcast in real time');
    try {
      onMessage(JSON.parse(ev.data));
    } catch (e) {
      console.error('bad message', e);
    }
  };
}

// Probe for a live server before connecting. If one is running, commit to it
// (no local fallback); if /api/state 404s (static host) or reports no
// tournament, run the tournament in-browser. This makes a refresh on the live
// site reconnect cleanly instead of briefly showing a different local track.
(async function boot() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (r.ok) {
      const s = await r.json().catch(() => null);
      if (s && s.type === 'no_tournament') {
        goLocal();
        return;
      }
      if (s && (s.type === 'snapshot' || s.type === 'starting')) {
        serverKnown = true;
        if (s.type === 'snapshot') onMessage(s); // paint the current race immediately
        loadChampions();
        loadCareers();
      }
    }
  } catch {}
  connect();
})();

// Toggle the stat overlays for an unobstructed, bigger race view.
{
  const statsToggle = el('statsToggle');
  if (statsToggle)
    statsToggle.addEventListener('click', () => {
      const hidden = document.body.classList.toggle('stats-hidden');
      statsToggle.setAttribute('aria-pressed', hidden ? 'false' : 'true');
    });
}

// Collapsible stat windows (closed by default; click a header to expand).
document.querySelectorAll('.card.collapsible .card-head').forEach((head) => {
  head.addEventListener('click', () => {
    const open = head.closest('.card').classList.toggle('open');
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
});

// Bracket dock: slides up from the bottom; collapses to the corner button.
{
  const btn = el('bracketBtn');
  const dock = el('bracketDock');
  const closeBtn = el('bracketClose');
  const setOpen = (open) => {
    dock.classList.toggle('open', open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    dock.setAttribute('aria-hidden', open ? 'false' : 'true');
  };
  if (btn) btn.addEventListener('click', () => setOpen(!dock.classList.contains('open')));
  if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
}

// ---- follow-marble picker wiring ------------------------------------------
{
  const modal = el('pickerModal');
  if (el('followPill')) el('followPill').addEventListener('click', openPicker);
  if (el('pickerClose')) el('pickerClose').addEventListener('click', closePicker);
  if (modal)
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closePicker();
    });
  if (el('pickerSearch')) el('pickerSearch').addEventListener('input', buildPickerGrid);
  if (el('pickerGrid'))
    el('pickerGrid').addEventListener('click', (e) => {
      const b = e.target.closest('.pk');
      if (!b) return;
      const id = Number(b.dataset.id);
      // Eliminated marbles need a deliberate second tap — you'd only be
      // choosing them to follow their story, not to cheer them on.
      if (b.classList.contains('out') && _pkConfirm !== id) {
        _pkConfirm = id;
        const st = model.standings.find((m) => m.id === id);
        const note = el('pickerNote');
        if (note)
          note.textContent = `${st ? st.name : 'That marble'} is already out of the tournament — tap it again to pick it anyway and view its story.`;
        return;
      }
      _pkConfirm = null;
      const note = el('pickerNote');
      if (note) note.textContent = PICKER_NOTE_DEFAULT;
      setFollow(id);
      closePicker();
    });
  if (el('pickerRandom'))
    el('pickerRandom').addEventListener('click', () => {
      const alive = model.standings.filter((m) => m.status === 'alive');
      const pool = alive.length ? alive : model.standings;
      if (!pool.length) return;
      setFollow(pool[(Math.random() * pool.length) | 0].id);
      closePicker();
    });
  if (el('pickerClear'))
    el('pickerClear').addEventListener('click', () => {
      setFollow(null);
      closePicker();
    });
}

// ---- pre-race actions ------------------------------------------------------
if (el('watchLatestBtn')) el('watchLatestBtn').addEventListener('click', startLatestReplay);
if (el('replayExit')) el('replayExit').addEventListener('click', () => stopReplay(true));
if (el('prHow'))
  el('prHow').addEventListener('click', () => {
    showFullOnce = true; // re-expand until the next race starts
    renderPreRace();
  });
// Call-the-winner: tapping a starter backs it (follow + recorded guess).
if (el('prStarters'))
  el('prStarters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-guess]');
    if (!b) return;
    const id = Number(b.dataset.guess);
    const nxt = nextUpcomingRace();
    if (nxt) recordGuess(nxt.key, id);
    setFollow(id); // becomes your marble by default (persisted, camera, marker)
  });
// The "your marble" block is re-rendered per state — delegate its buttons.
if (el('prMarble'))
  el('prMarble').addEventListener('click', (e) => {
    if (e.target.closest('#prPickBtn') || e.target.closest('#prChangeBtn')) {
      openPicker();
      return;
    }
    if (e.target.closest('#prFollowBtn')) {
      const cur = model.currentKey && model.racesByKey.get(model.currentKey);
      applyFollow(cur && !cur.result ? cur : null);
      const a = api();
      if (a && a.setCamera) a.setCamera('action');
      return;
    }
    if (e.target.closest('#prViewRaceBtn')) {
      // Replay the eliminated marble's final race.
      const e2 = eliminationInfo(followId);
      if (e2 && e2.race) startReplayOf(e2.race);
      return;
    }
    if (e.target.closest('#prWatchFinishBtn')) {
      // Re-run the champion celebration for your marble's big moment.
      if (model.champion) showChampionCelebration(model.champion);
    }
  });

// ---- controls popover (THE unified camera bar) ------------------------------
// One control system: Overview · Action · Follow · Top · Split view · Marble
// Blast. The game's own camera button is hidden in embed mode, so nothing is
// duplicated. The active camera is marked visually AND via aria-pressed.
// ---- TV mode: auto-director ------------------------------------------------
// Ambient viewing: the camera cuts itself. Breakaway leader → chase; tight
// pack → action (with an occasional variety cut); finish approach → action;
// between races → overview. Any manual camera choice switches it off.
let tvMode = false;
let _tvTimer = null;
let _tvLastCut = 0;
function setTvMode(on) {
  tvMode = !!on;
  try { sessionStorage.setItem('mrTv', tvMode ? '1' : '0'); } catch {}
  clearInterval(_tvTimer);
  _tvTimer = null;
  if (tvMode) {
    _tvTimer = setInterval(tvDirector, 1000);
    tvDirector();
  }
  syncCamButtons();
}
function tvDirector() {
  const a = api();
  if (!a || !a.getCamera || !a.setCamera) return;
  const now = Date.now();
  const since = now - _tvLastCut;
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  const live = cur && !cur.result && startedRaces.has(cur.key);
  let cam = 'overview';
  try { cam = a.getCamera() || 'overview'; } catch {}
  if (cam === 'blast' || cam === 'split') return; // never fight those modes
  if (!live || replaying) {
    if (cam !== 'overview' && since > 4000) { a.setCamera('overview'); _tvLastCut = now; syncCamButtons(); }
    return;
  }
  let prog = null;
  try { prog = a.getProgress(); } catch {}
  if (!prog || !prog.length) return;
  const act = prog.filter((p) => !p.finished).sort((x, y) => y.pos - x.pos);
  if (!act.length) return;
  const leader = act[0];
  const gap = act.length > 1 ? leader.pos - act[1].pos : 1;
  let want;
  if (leader.pos > 0.88) want = 'action'; // finish approach: the wide dramatic angle
  else if (gap > 0.07) want = 'chase'; // breakaway: ride the leader
  else want = since > 9000 && cam === 'action' ? 'chase' : 'action'; // tight pack + variety
  if (want !== cam && since > 5000) {
    a.setCamera(want);
    _tvLastCut = now;
    syncCamButtons();
  }
}

function syncCamButtons() {
  const pop = el('controlsPop');
  if (!pop) return;
  const a = api();
  let cam = 'overview';
  try { if (a && a.getCamera) cam = a.getCamera() || 'overview'; } catch {}
  pop.querySelectorAll('[data-cam]').forEach((b) => {
    const on = b.dataset.cam === cam;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const split = el('cpSplit');
  if (split) {
    split.classList.toggle('active', cam === 'split');
    split.setAttribute('aria-pressed', cam === 'split' ? 'true' : 'false');
  }
  // "Chase Cam" rides behind your marble (or the leader if none is picked).
  const follow = el('cpFollow');
  if (follow) {
    const on = cam === 'chase';
    follow.classList.toggle('active', on);
    follow.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const tv = el('cpTv');
  if (tv) {
    tv.classList.toggle('active', tvMode);
    tv.setAttribute('aria-pressed', tvMode ? 'true' : 'false');
  }
}
{
  const btn = el('controlsBtn');
  const pop = el('controlsPop');
  const setOpen = (open) => {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) syncCamButtons();
    else btn.focus(); // focus back on the trigger when the panel closes
  };
  if (btn && pop) {
    btn.addEventListener('click', () => setOpen(pop.hidden));
    document.addEventListener('click', (e) => {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      }
    });
    pop.querySelectorAll('[data-cam]').forEach((b) =>
      b.addEventListener('click', () => {
        setTvMode(false); // a manual choice takes the director's chair back
        const a = api();
        if (a && a.setCamera) a.setCamera(b.dataset.cam);
        if (a && a.setSplit) a.setSplit(false); // leaving split when picking a single cam
        syncCamButtons();
      })
    );
    const splitBtn = el('cpSplit');
    if (splitBtn)
      splitBtn.addEventListener('click', () => {
        setTvMode(false);
        const a = api();
        if (a && a.setSplit) a.setSplit();
        syncCamButtons();
      });
    const tvBtn = el('cpTv');
    if (tvBtn) tvBtn.addEventListener('click', () => setTvMode(!tvMode));
    // Restore the director across a refresh within the same session.
    try { if (sessionStorage.getItem('mrTv') === '1') setTvMode(true); } catch {}
    // (Marble Blast has no menu entry on purpose — it's an easter egg on M.)
    const followBtn = el('cpFollow');
    if (followBtn)
      followBtn.addEventListener('click', () => {
        setTvMode(false);
        // Behind-the-marble chase cam. It rides YOUR marble when one is picked
        // and racing (via the game's follow-lane), otherwise the leader.
        const cur = model.currentKey && model.racesByKey.get(model.currentKey);
        applyFollow(cur && !cur.result ? cur : null);
        const a = api();
        if (a && a.setCamera) a.setCamera('chase');
        syncCamButtons();
      });
  }
}

// Escape closes whichever layer is open (picker → controls → bracket).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el('pickerModal').hidden) closePicker();
  else if (!el('controlsPop').hidden) {
    el('controlsPop').hidden = true;
    el('controlsBtn').setAttribute('aria-expanded', 'false');
  } else if (el('bracketDock').classList.contains('open')) el('bracketClose').click();
});

// ---- WebGL fallback notice -------------------------------------------------
// The game degrades to a physics-only no-op renderer when WebGL is missing;
// spectators should be told the data is still live even though the 3D isn't.
whenApiReady().then(() => {
  try {
    if (gameFrame.contentWindow.__headlessNoGL) el('glFallback').hidden = false;
  } catch {}
});

// (The embedded game hides its own control bar via ?embed=1 — see marble_run.html.)

// ---- live viewer presence -------------------------------------------------
// Heartbeats /api/presence and shows a "👁 N watching" badge. If presence isn't
// configured (no KV store), the endpoint replies { enabled:false } and we hide
// the badge and stop — nothing else is affected.
(function presence() {
  let id = '';
  try {
    id = sessionStorage.getItem('mt-presence') || '';
  } catch {}
  if (!id) {
    id = 'v-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      sessionStorage.setItem('mt-presence', id);
    } catch {}
  }
  const badge = el('watching');
  const num = el('watchingN');
  let dead = false;
  async function beat() {
    if (dead) return;
    try {
      const r = await fetch('/api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const d = await r.json();
      if (!d || !d.enabled) {
        dead = true;
        if (badge) badge.hidden = true;
        return;
      }
      if (badge && num) {
        // A small or zero audience reads worse than no number at all — only
        // show the real count once it's ≥ 10 (shared shouldShowViewerCount:
        // invalid/missing/low all hide the element entirely, never a fake).
        num.textContent = d.count;
        badge.hidden = !window.UIState.shouldShowViewerCount(d.count);
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
// Loads marbles/manifest.json if present. Absent/invalid manifest = default
// colored marbles, no effect. Applied per race (only the 5 competitors' assets
// are ever loaded) just before that race's marbles are (re)created.
let marbleManifest = null;
fetch('marbles/manifest.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((m) => {
    if (m && typeof m === 'object') marbleManifest = m;
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
