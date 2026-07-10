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

  // Replay audit: record that this race was started with its broadcast seed,
  // and that the game actually applied it. `want` should always equal `got`.
  window.__replayAudit = window.__replayAudit || [];
  window.__replayAudit.push({ key: race.key, want: race.raceSeed, got: a.getSeeds().race });

  race.status = 'running';
  const cd = el('cd');
  cd.classList.add('live');
  el('countdown').textContent = 'LIVE';
  el('cdArc').style.strokeDashoffset = '0';
  el('liveBadge').hidden = false;
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
  el('liveBadge').hidden = true;
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

function renderCurrent(race) {
  const title = el('raceTitle');
  const isFinal = race.roundKey === 'final';
  title.classList.toggle('final', isFinal);
  const label = isFinal
    ? 'THE FINAL'
    : `${roundName[race.roundKey] || race.roundKey} ${race.indexInRound + 1}`;
  title.innerHTML = `<span class="rnd">${race.roundTitle}</span>${label}`;
  el('seedline').textContent = `track ${race.trackSeed}  ·  race ${race.raceSeed}`;
  renderRoster(race);
  el('liveBadge').hidden = race.status !== 'running';
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
  const roundLabel = model.champion
    ? 'Complete'
    : cur
      ? cur.roundTitle
      : model.rounds.length
        ? model.rounds[model.rounds.length - 1].title
        : 'Starting';
  el('progressRound').textContent = roundLabel;
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
          `<span class="um"><span class="swatch" style="background:${s.color}"></span>${s.marbleName}</span>`
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
    for (const race of round.races) col.appendChild(renderRaceCard(race));
    wrap.appendChild(col);
  }
  // Keep the current race in view.
  const cur = wrap.querySelector('.race-card.current');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
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
  el('liveBadge').hidden = true;
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
      el('liveBadge').hidden = true;
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

// ---- websocket -----------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  const conn = el('conn');
  ws.onopen = () => {
    conn.textContent = '● live';
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
