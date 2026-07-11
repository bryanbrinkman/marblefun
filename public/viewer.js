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
  const a = await ensureCourse(race.trackSeed);
  // startRace refuses (returns false) if a previous replay is still on screen.
  // That happens when a client is catching up or running faster than real
  // time — hard-reset the course and start cleanly so no race is skipped.
  const ok = a.startRace(race.raceSeed);
  if (ok === false) {
    a.newCourse(race.trackSeed);
    builtTrack = race.trackSeed;
    a.startRace(race.raceSeed);
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
  ensureCourse(race.trackSeed); // pre-build during the countdown
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

const roundName = { heats: 'Heat', semis: 'Semifinal', final: 'Final' };
const orderedRaces = () => model.rounds.flatMap((r) => r.races);
const shortName = (n) => (n || '').replace(/^Marble\s*/i, ''); // "Marble 083" -> "083"

function renderCurrent(race) {
  const title = el('raceTitle');
  const isFinal = race.roundKey === 'final';
  title.classList.toggle('final', isFinal);
  const label = isFinal
    ? 'The Final'
    : `${roundName[race.roundKey] || race.roundKey} ${race.indexInRound + 1}`;
  title.textContent = label;
  el('seedline').textContent = `track ${race.trackSeed} · race ${race.raceSeed}`;
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
  el('progressCount').textContent = `Race ${shown} / ${TOTAL_RACES}`;
  el('progressFill').style.width = (100 * done) / TOTAL_RACES + '%';
}

function renderFunnel() {
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  const order = ['heats', 'semis', 'final', 'champion'];
  const activeKey = model.champion ? 'champion' : cur ? cur.roundKey : 'heats';
  const activeIdx = order.indexOf(activeKey);
  document.querySelectorAll('.funnel-stage').forEach((node) => {
    const idx = order.indexOf(node.dataset.stage);
    node.classList.toggle('active', idx === activeIdx);
    node.classList.toggle('done', idx < activeIdx);
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
  const isFinal = next.roundKey === 'final';
  const label = isFinal ? 'The Final' : `${roundName[next.roundKey]} ${next.indexInRound + 1}`;
  el('upnextBody').innerHTML =
    `<div class="upnext-round">${next.roundTitle} · ${label}</div>` +
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
      const label = r.roundKey === 'final' ? 'Final' : `${roundName[r.roundKey]} ${r.indexInRound + 1}`;
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

function renderBracket() {
  const wrap = el('bracket');
  wrap.innerHTML = '';
  for (const round of model.rounds) {
    const col = document.createElement('div');
    col.className = 'round-col' + (round.key === 'final' ? ' final-col' : '');
    col.innerHTML = `<h3>${round.title}<span class="rc-n">${round.races.length}</span></h3>`;
    const races = document.createElement('div');
    races.className = 'round-races';
    for (const race of round.races) races.appendChild(renderRaceCard(race));
    col.appendChild(races);
    wrap.appendChild(col);
  }
  // Keep the current race in view (only matters when the Bracket window is open).
  const cur = wrap.querySelector('.race-card.current');
  if (cur && el('bracketCard').classList.contains('open')) {
    cur.scrollIntoView({ block: 'nearest' });
  }
}

function renderRaceCard(race) {
  const card = document.createElement('div');
  const status = race.result ? 'done' : race.status || 'pending';
  card.className = 'race-card ' + status + (race.key === model.currentKey ? ' current' : '');
  if (race.key === justRevealed) card.classList.add('just-in');
  const idxLabel = race.roundKey === 'final' ? 'Final' : `#${race.indexInRound + 1}`;
  card.innerHTML = `<div class="rc-head"><span>${idxLabel}</span><span class="rc-status ${status}">${status}</span></div>`;

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

  for (const s of rows) {
    const rank = rankBySlot[s.slot];
    const slotDiv = document.createElement('div');
    slotDiv.className = 'slot' + (rank === 1 ? ' win' : '');
    const done = rank != null;
    const t = done
      ? `<span class="t">${timeBySlot[s.slot] != null ? timeBySlot[s.slot].toFixed(1) + 's' : 'DNF'}</span>`
      : '';
    slotDiv.innerHTML =
      `<span class="pos">${done ? rank + '.' : ''}</span>` +
      `<span class="swatch" style="background:${s.color}"></span>` +
      `<span class="nm">${shortName(s.marbleName)}</span>` +
      t;
    card.appendChild(slotDiv);
  }
  return card;
}

function renderChampion() {
  if (!model.champion) return;
  el('championCard').hidden = false;
  el('championName').textContent = model.champion.name;
  el('cd').classList.remove('live');
  el('countdown').textContent = '🏁';
  flashOverlay('🏆 ' + model.champion.name);
}

function renderAll() {
  renderProgress();
  renderFunnel();
  renderUpNext();
  renderRecent();
  renderBracket();
  renderStandings();
  renderChampion();
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  if (cur) renderCurrent(cur);
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

  const cur = msg.current;
  model.currentKey = cur ? cur.raceKey : null;
  renderAll();

  if (cur && (cur.phase === 'announced' || cur.phase === 'running')) {
    const race = model.racesByKey.get(cur.raceKey);
    if (race && !race.result) scheduleStart(race);
  }
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
      break;
    }
    case 'tournament_complete':
      model.champion = msg.champion;
      model.currentKey = null;
      renderAll();
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
const LOCAL_LEAD_MS = LOCAL_FAST ? 800 : 6000;
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
}
function broadcastStatus() {
  if (!adminChannel) return;
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  adminChannel.postMessage({
    type: 'status',
    paused: localPaused,
    mode,
    current: cur
      ? cur.roundKey === 'final'
        ? 'The Final'
        : `${cur.roundTitle} · ${roundName[cur.roundKey]} ${cur.indexInRound + 1}`
      : null,
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
  const conn = el('conn');
  conn.textContent = '● local';
  conn.classList.add('live');
  conn.title = 'Running standalone in your browser (no server)';
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
  model.champion = null;
  el('championCard').hidden = true;
  startedRaces = new Set();
  builtTrack = null;
  syncRounds(T);
  model.standings = window.TournamentCore.standings(T);
  model.currentKey = null;
  renderAll();
  broadcastStatus();
  await ensureCourse(T.trackSeed);

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
  // world to a clean pre-race view so the just-simulated podium isn't shown.
  const order = await computeResult(race);
  const a = await whenApiReady();
  a.newCourse(race.trackSeed);
  builtTrack = race.trackSeed;
  await sleep(Math.max(0, race.scheduledStart - Date.now()));
  await startReplay(race); // play the visible race for viewers to watch
  await waitForVisualFinish(race, order, aborted);
  if (aborted && aborted()) return; // a reset fired mid-race; abandon this result
  T.applyResult(race, order);
  race.status = 'done';
  model.standings = window.TournamentCore.standings(T);
  justRevealed = race.key;
  renderAll();
  justRevealed = null;
  await sleep(LOCAL_GAP_MS);
}

// ---- websocket -----------------------------------------------------------
// Try a server first; if none answers (static hosting), fall back to local mode.

let mode = 'connecting'; // 'connecting' | 'server' | 'local'

function goLocal() {
  if (mode === 'local') return;
  mode = 'local';
  startLocalTournament();
}

function connect() {
  if (mode === 'local') return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const conn = el('conn');
  let ws;
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch {
    goLocal();
    return;
  }
  const fallback = setTimeout(() => {
    if (mode === 'connecting') {
      try {
        ws.close();
      } catch {}
      goLocal();
    }
  }, 3000);
  ws.onopen = () => {
    mode = 'server';
    clearTimeout(fallback);
    conn.textContent = '● live';
    conn.classList.add('live');
  };
  ws.onclose = () => {
    clearTimeout(fallback);
    if (mode === 'server') {
      conn.textContent = 'reconnecting…';
      conn.classList.remove('live');
      setTimeout(connect, 1500);
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
    if (mode !== 'server') mode = 'server';
    try {
      onMessage(JSON.parse(ev.data));
    } catch (e) {
      console.error('bad message', e);
    }
  };
}

connect();

// Toggle the stat overlays for an unobstructed, bigger race view.
{
  const statsToggle = el('statsToggle');
  if (statsToggle) statsToggle.addEventListener('click', () => document.body.classList.toggle('stats-hidden'));
}

// Collapsible stat windows (closed by default; click a header to expand).
document.querySelectorAll('.card.collapsible .card-head').forEach((head) => {
  head.addEventListener('click', () => head.closest('.card').classList.toggle('open'));
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
        num.textContent = d.count;
        badge.hidden = d.count < 1;
      }
    } catch {
      dead = true;
      if (badge) badge.hidden = true;
    }
  }
  beat();
  setInterval(beat, 8000);
})();
