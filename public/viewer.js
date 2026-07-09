'use strict';

// =========================================================
// Tournament viewer — replays each race LOCALLY from broadcast seeds
// =========================================================
// The server never streams video or marble positions. It only broadcasts
// (trackSeed, raceSeed) ~30 s ahead of each race plus a scheduled start time.
// This page loads the identical deterministic game in an <iframe> and, at the
// agreed instant, calls marbleAPI.newCourse(trackSeed) + startRace(raceSeed).
// Because the sim is deterministic, every viewer sees the same race — matching
// the result the server independently recorded.

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
  // Replay audit: record that this race was started with its broadcast seed,
  // and that the game actually applied it. `want` should always equal `got`.
  window.__replayAudit = window.__replayAudit || [];
  window.__replayAudit.push({ key: race.key, want: race.raceSeed, got: a.getSeeds().race });

  const cd = el('countdown');
  cd.textContent = 'LIVE';
  cd.classList.add('live');
  flashOverlay('GO!');
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
  // Pre-build the course during the countdown so the start is instant.
  ensureCourse(race.trackSeed);
  if (delay <= 0) {
    startReplay(race);
  } else {
    startTimer = setTimeout(() => startReplay(race), delay);
  }
  runCountdown(race);
}

function runCountdown(race) {
  clearInterval(countdownTimer);
  const cd = el('countdown');
  cd.classList.remove('live');
  const tick = () => {
    const remaining = toLocal(race.scheduledStart) - Date.now();
    if (remaining <= 0) {
      cd.textContent = startedRaces.has(race.key) ? 'LIVE' : '0.0s';
      if (startedRaces.has(race.key)) cd.classList.add('live');
      clearInterval(countdownTimer);
      return;
    }
    cd.textContent = (remaining / 1000).toFixed(1) + 's';
  };
  tick();
  countdownTimer = setInterval(tick, 100);
}

// ---- rendering -----------------------------------------------------------

const roundName = { heats: 'Heat', semis: 'Semifinal', final: 'Final' };

function renderCurrent(race) {
  const label =
    race.roundKey === 'final'
      ? 'THE FINAL'
      : `${roundName[race.roundKey] || race.roundKey} ${race.indexInRound + 1}`;
  el('raceTitle').innerHTML = `<span class="rnd">${race.roundTitle}</span> — ${label}`;
  el('seedline').textContent = `track=${race.trackSeed}  ·  race=${race.raceSeed}`;
  renderRoster(race);
}

function winnerSlotOf(race) {
  if (!race.result) return null;
  return race.result[0].slot;
}

function renderRoster(race) {
  const wrap = el('roster');
  wrap.innerHTML = '';
  const rankBySlot = {};
  if (race.result) race.result.forEach((r) => (rankBySlot[r.slot] = r.rank));
  for (const s of race.roster) {
    const div = document.createElement('div');
    div.className = 'lane' + (rankBySlot[s.slot] === 1 ? ' win' : '');
    const rank = rankBySlot[s.slot];
    div.innerHTML =
      `<span class="swatch" style="background:${s.color}"></span>` +
      `<span>${s.marbleName}</span>` +
      (rank ? `<span class="rank">#${rank}</span>` : `<span class="rank" style="color:var(--muted)">${s.lane}</span>`);
    wrap.appendChild(div);
  }
}

function renderStandings() {
  const wrap = el('standings');
  wrap.innerHTML = '';
  for (const m of model.standings) {
    const d = document.createElement('div');
    d.className = 'm ' + m.status;
    d.textContent = String(m.id).padStart(3, '0');
    d.title = `${m.name} — ${m.status}`;
    wrap.appendChild(d);
  }
}

function renderBracket() {
  const wrap = el('bracket');
  wrap.innerHTML = '';
  for (const round of model.rounds) {
    const col = document.createElement('div');
    col.className = 'round-col';
    col.innerHTML = `<h3>${round.title} · ${round.races.length}</h3>`;
    for (const race of round.races) {
      col.appendChild(renderRaceCard(race));
    }
    wrap.appendChild(col);
  }
}

function renderRaceCard(race) {
  const card = document.createElement('div');
  card.className = 'race-card' + (race.key === model.currentKey ? ' current' : '');
  const idxLabel =
    race.roundKey === 'final' ? 'Final' : `#${race.indexInRound + 1}`;
  const status = race.result ? 'done' : race.status || 'pending';
  card.innerHTML = `<div class="rc-head"><span>${idxLabel}</span><span class="rc-status">${status}</span></div>`;

  const rankBySlot = {};
  const timeBySlot = {};
  if (race.result)
    race.result.forEach((r) => {
      rankBySlot[r.slot] = r.rank;
      timeBySlot[r.slot] = r.timeSec;
    });

  // Show in finish order when known, else roster order.
  const rows = race.result
    ? race.result.map((r) => race.roster.find((s) => s.slot === r.slot))
    : race.roster;

  for (const s of rows) {
    const slotDiv = document.createElement('div');
    slotDiv.className = 'slot' + (rankBySlot[s.slot] === 1 ? ' win' : '');
    const done = rankBySlot[s.slot] != null;
    const t = done
      ? `<span class="t">${timeBySlot[s.slot] != null ? timeBySlot[s.slot].toFixed(1) + 's' : 'DNF'}</span>`
      : '';
    slotDiv.innerHTML =
      `<span class="swatch" style="background:${s.color}"></span>` +
      `<span class="nm">${s.marbleName}</span>` +
      t;
    card.appendChild(slotDiv);
  }
  return card;
}

function renderChampion() {
  if (!model.champion) return;
  el('championCard').hidden = false;
  el('championName').textContent = model.champion.name;
  flashOverlay('🏆 ' + model.champion.name);
}

function renderAll() {
  renderBracket();
  renderStandings();
  renderChampion();
  const cur = model.currentKey && model.racesByKey.get(model.currentKey);
  if (cur) renderCurrent(cur);
}

// ---- message handling ----------------------------------------------------

function ingestSnapshot(msg) {
  clockOffset = msg.serverNow - Date.now();
  model.rounds = msg.rounds;
  model.marbles = msg.marbles;
  model.standings = msg.standings;
  model.champion = msg.tournament.champion;
  model.racesByKey.clear();
  for (const round of msg.rounds)
    for (const race of round.races) model.racesByKey.set(race.key, race);
  // Which races have already run this session — don't re-kick them.
  for (const race of model.racesByKey.values())
    if (race.result) startedRaces.add(race.key);

  const cur = msg.current;
  model.currentKey = cur ? cur.raceKey : null;
  renderAll();

  // Resync an in-flight race for late joiners.
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
      // Fill the bracket with the whole new round at once.
      if (msg.round) {
        for (const race of msg.round.races) upsertRace(race);
        renderAll();
      }
      break;
    case 'race_announced': {
      clockOffset = msg.serverNow - Date.now();
      const race = msg.race;
      // Insert/replace in the model (covers races from rounds built after
      // our initial snapshot).
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
      if (race) startReplay(race); // guarded against double-start
      break;
    }
    case 'race_result': {
      const race = model.racesByKey.get(msg.raceKey);
      if (race) race.result = msg.result;
      model.standings = msg.standings;
      renderAll();
      break;
    }
    case 'tournament_complete':
      model.champion = msg.champion;
      renderChampion();
      break;
  }
}

// Insert a race into the model, creating its round bucket if needed.
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

// ---- websocket -----------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  const conn = el('conn');
  ws.onopen = () => {
    conn.textContent = 'live';
    conn.classList.add('live');
  };
  ws.onclose = () => {
    conn.textContent = 'reconnecting…';
    conn.classList.remove('live');
    setTimeout(connect, 1500);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(ev.data));
    } catch (e) {
      console.error('bad message', e);
    }
  };
}

connect();
