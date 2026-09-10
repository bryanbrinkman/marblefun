'use strict';

// =========================================================
// Server-side rendering of the crawlable bits
// =========================================================
// The site is static HTML + client JS. Crawlers and no-JS clients used to get
// only empty containers ("Loading the record books…"), so the server fills the
// same containers with the same markup the client renders, at request time:
//
//   server-render useful initial state → the client hydrates over it → live
//
// Each page carries <!--SSR:…--> anchors inside its containers. The client
// scripts keep re-rendering those containers exactly as before (identical
// markup, so no layout shift). Rendering is best-effort: any failure serves
// the untouched static file.

const { Tournament } = require('./tournament');

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const pad = (id) => String(id).padStart(2, '0');
const ordinal = (n) => {
  const t = n % 100;
  return n + (t >= 11 && t <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
};
const nameFor = (id) => Tournament.marbleNameFor(id);

// Same per-id palette as public/gallery.html so the server-rendered cards are
// pixel-identical to the client's.
const HUES = [
  [272, 68, 60], [44, 90, 58], [248, 70, 62], [16, 88, 56], [226, 55, 42],
  [350, 78, 52], [192, 65, 74], [203, 95, 55], [135, 62, 50], [280, 14, 36],
];
function galleryHue(id) {
  const idx = (((id - 1) % 100) + 100) % 100;
  const [h, s, l] = HUES[idx % 10];
  const v = Math.floor(idx / 10);
  const hh = (h + (v - 4.5) * 4 + 360) % 360;
  const ll = Math.max(26, Math.min(82, l + ((v * 7) % 13) - 6));
  return `hsl(${hh.toFixed(1)}, ${s}%, ${ll}%)`;
}
function galleryBall(id, skin) {
  if (skin && skin.img) return `background-image:url('${esc(String(skin.img).replace(/'/g, '%27'))}')`;
  return (
    `background:radial-gradient(circle at 32% 28%, rgba(255,255,255,.92), rgba(255,255,255,0) 34%),` +
    `radial-gradient(circle at 50% 45%, ${galleryHue(id)} 0%, #131a2a 135%)`
  );
}
// champions.html palette (slightly different formula — mirror it exactly).
function champHue(id) {
  const idx = (((id - 1) % 100) + 100) % 100;
  const [h, s, l] = HUES[idx % 10];
  const v = Math.floor(idx / 10);
  return `hsl(${(h + v * 7) % 360} ${s}% ${Math.max(28, Math.min(72, l + (v % 3) * 4 - 4))}%)`;
}
function champBall(id, color, manifest) {
  const sk = manifest && (manifest[id] || manifest[String(id)]);
  if (sk && sk.img) return `background-image:url('${esc(sk.img)}');background-size:cover;background-position:center`;
  const c = color || champHue(id);
  return `--c1:${c};--c2:color-mix(in srgb, ${c} 45%, #000)`;
}

function fill(html, anchor, content) {
  return html.replace(`<!--SSR:${anchor}-->`, content);
}

// ---- /gallery -----------------------------------------------------------------
// careers: [{id, races, wins, podiums, titles}]; manifest: {id: {img, owner, ownerLink}}
function renderGallery(html, { careers = [], manifest = {} } = {}) {
  const car = new Map(careers.map((c) => [c.id, c]));
  const cards = [];
  for (let id = 1; id <= 100; id++) {
    const c = car.get(id) || { races: 0, wins: 0, podiums: 0, titles: 0 };
    const sk = manifest[id] || manifest[String(id)] || null;
    const owner = sk && sk.owner ? String(sk.owner) : null;
    cards.push(
      `<div class="card" role="listitem" tabindex="0" data-id="${id}">` +
        `<div class="ball" style="${galleryBall(id, sk)}"></div>` +
        `<div class="m-num">#${pad(id)}</div>` +
        `<div class="m-name">${esc(nameFor(id))}</div>` +
        `<div class="m-stats">${c.races ? `<b>${c.wins}</b> wins · <b>${c.podiums}</b> podiums · ${c.races} races` : 'No races yet'}</div>` +
        (c.titles ? `<span class="m-titles">🏆 ${c.titles === 1 ? 'Champion' : c.titles + '× Champion'}</span>` : '') +
        `<div class="m-owner${owner ? ' claimed' : ''}">${owner ? '👤 ' + esc(owner) : 'Unclaimed'}</div>` +
        `</div>`
    );
  }
  html = fill(html, 'GRID', cards.join(''));
  html = fill(html, 'COUNT', '100 marbles');
  return html;
}

// ---- /champions ---------------------------------------------------------------
// history: db.championHistory() rows (newest first); hof: db.hallOfFame()
function renderChampions(html, { history = [], hof = null, manifest = {} } = {}) {
  const fmtDate = (ms) =>
    ms ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '';
  const roundLabel = (p) => (p.roundKey === 'final' ? 'FINAL' : p.roundKey === 'semis' ? `SEMI ${p.indexInRound + 1}` : `HEAT ${p.indexInRound + 1}`);

  // Holder
  let holder;
  const cur = hof && hof.currentChampion;
  if (!cur) {
    holder = 'No champion has been crowned yet — the first tournament is still running.';
    html = html.replace('<a class="holder none" id="holder" href="/champions"><!--SSR:HOLDER-->Loading the record books…<!--/SSR:HOLDER--></a>',
      `<a class="holder none" id="holder" href="/">${holder}</a>`);
  } else {
    const row = history.find((t) => t.tournamentId === cur.tournamentId);
    const color = row && row.final && row.final[0] ? row.final[0].color : null;
    const titles = ((hof.mostTitles || []).find((m) => m.id === cur.id) || {}).titles || 1;
    holder =
      `<span class="ball" style="${champBall(cur.id, color, manifest)}"></span>` +
      `<span><span class="hk">🏆 REIGNING CHAMPION</span>` +
      `<div class="hn"><small>#${pad(cur.id)}</small>${esc(cur.name)}</div>` +
      `<div class="hs">Won Tournament ${cur.tournamentId}${row && row.completedAt ? ' · ' + fmtDate(row.completedAt) : ''}${titles > 1 ? ` · ${titles}× champion` : ''}</div></span>`;
    html = html.replace('<a class="holder none" id="holder" href="/champions"><!--SSR:HOLDER-->Loading the record books…<!--/SSR:HOLDER--></a>',
      `<a class="holder" id="holder" href="/gallery#${cur.id}">${holder}</a>`);
  }

  // Tiles
  if (hof) {
    const top = (hof.mostTitles || [])[0];
    const rep = (hof.repeatChampions || []).length;
    const tiles = [
      { b: hof.tournamentsCompleted, i: 'Tournaments', s: `${hof.racesRun} races run` },
      { b: hof.distinctChampions, i: 'Different champions', s: rep ? `${rep} repeat winner${rep > 1 ? 's' : ''}` : 'no repeat winners yet' },
      { b: top ? `${top.titles}×` : '—', i: 'Most titles', s: top ? `#${pad(top.id)} ${esc(top.name)}` : 'nobody yet', gold: true },
      { b: hof.longestStreak ? `${hof.longestStreak.len}` : '1', i: 'Longest streak', s: hof.longestStreak ? `#${pad(hof.longestStreak.id)} ${esc(hof.longestStreak.name)} back-to-back` : 'no back-to-back champions yet' },
    ];
    html = fill(html, 'TILES', tiles.map((x) => `<div class="tile"><b class="${x.gold ? 'gold' : ''}">${x.b}</b><i>${x.i}</i><small>${x.s}</small></div>`).join(''));
  }

  // Title table
  const rows = hof ? hof.mostTitles || [] : [];
  html = fill(
    html,
    'TITLES',
    rows.length
      ? rows
          .map(
            (m, i) =>
              `<a class="trow" href="/gallery#${m.id}"><span class="rk">${i + 1}</span>` +
              `<span class="ball" style="${champBall(m.id, null, manifest)}"></span>` +
              `<span class="nm"><small>#${pad(m.id)}</small>${esc(m.name)}</span>` +
              `<span class="tt"><span class="cups" aria-hidden="true">${'🏆'.repeat(Math.min(m.titles, 5))}</span>${m.titles} title${m.titles > 1 ? 's' : ''}</span></a>`
          )
          .join('')
      : '<div class="empty">The title table fills in as tournaments finish.</div>'
  );

  // Timeline
  if (!history.length) {
    html = fill(html, 'TIMELINE', '<div class="empty">No tournament has finished yet. <a href="/">Watch the one running now →</a></div>');
    return html;
  }
  const nth = new Map();
  const nthOf = new Map();
  history.slice().reverse().forEach((t) => {
    const n = (nth.get(t.champion.id) || 0) + 1;
    nth.set(t.champion.id, n);
    nthOf.set(t.tournamentId, n);
  });
  const cards = history.map((t) => {
    const color = t.final && t.final[0] ? t.final[0].color : null;
    const isWild = t.path.some((p) => p.roundKey === 'semis' && p.rank === 2);
    const road = t.path
      .map((p) => `<span class="step${p.roundKey === 'semis' && p.rank === 2 ? ' wild' : ''}"><i>${roundLabel(p)}</i><b>${p.rank ? ordinal(p.rank) : '—'}</b><small>${p.timeSec == null ? 'DNF' : ''}</small></span>`)
      .join('<span class="arrow" aria-hidden="true">›</span>');
    const finalRows = (t.final || [])
      .map((f) => `<div class="frow${f.rank === 1 ? ' win' : ''}"><span class="pos">${f.rank}</span><span class="sw" style="background:${esc(f.color)}"></span><a href="/gallery#${f.marbleId}">#${pad(f.marbleId)} ${esc(f.marbleName)}</a><span class="t">${f.timeSec == null ? 'DNF' : ''}</span></div>`)
      .join('');
    const n = nthOf.get(t.tournamentId) || 1;
    return (
      `<article class="champ">` +
      `<div class="left"><span class="ball" style="${champBall(t.champion.id, color, manifest)}"></span><div class="tid">TOURNAMENT<b>${t.tournamentId}</b></div></div>` +
      `<div>` +
      `<div class="head"><a class="name" href="/gallery#${t.champion.id}"><small>#${pad(t.champion.id)}</small>${esc(t.champion.name)}</a>` +
      (n > 1 ? `<span class="badge">${ordinal(n).toUpperCase()} TITLE</span>` : '') +
      (isWild ? `<span class="badge">WILDCARD RUN</span>` : '') +
      `<span class="when">${fmtDate(t.completedAt)}</span></div>` +
      `<div class="road">${road || '<span class="step"><i>ROAD</i><b>—</b></span>'}</div>` +
      (finalRows ? `<div class="final"><div class="fh">THE FINAL</div>${finalRows}</div>` : '') +
      `<div class="seed">master seed ${t.masterSeed} · ${t.racesRun} races</div>` +
      `</div></article>`
    );
  });
  return fill(html, 'TIMELINE', cards.join(''));
}

// ---- / (homepage) --------------------------------------------------------------
// snapshot: scheduler.snapshot(). Fills the top-bar race title/progress and
// leaves a crawlable summary in the <noscript> block. Everything else is live.
function renderHome(html, { snapshot = null, hof = null } = {}) {
  if (!snapshot || !snapshot.rounds) return html;
  const races = snapshot.rounds.flatMap((r) => r.races);
  const done = races.filter((r) => r.result).length;
  const cur = snapshot.current && races.find((r) => r.key === snapshot.current.raceKey);
  const race = (cur && !cur.result ? cur : races.find((r) => !r.result)) || null;
  const label = (r) =>
    !r ? '' : r.roundKey === 'final' ? 'Championship Race' : r.roundKey === 'semis' ? `Semifinal ${r.indexInRound + 1} of 4` : `Qualifying · Race ${r.indexInRound + 1} of 20`;
  const champ = snapshot.tournament && snapshot.tournament.champion;
  const title = champ ? 'Tournament Complete' : race ? label(race) : 'Tournament starting';
  const shown = champ ? 25 : Math.min(25, done + (race ? 1 : 0));
  const alive = (snapshot.standings || []).filter((m) => m.status === 'alive').length;

  html = html.replace('<div class="race-title" id="raceTitle">Warming up the track…</div>', `<div class="race-title" id="raceTitle">${esc(title)}</div>`);
  html = html.replace('<span class="rc-count" id="progressCount"></span>', `<span class="rc-count" id="progressCount">${shown > 0 ? `Race ${shown} of 25` : ''}</span>`);
  if (champ) html = html.replace('<div class="champ-name" id="championName"></div>', `<div class="champ-name" id="championName">${esc(champ.name)}</div>`);

  const lines = [];
  lines.push(`<li>Tournament ${snapshot.tournament ? snapshot.tournament.id : ''}: ${esc(title)}${champ ? ` — champion #${pad(champ.id)} ${esc(champ.name)}` : ''}.</li>`);
  if (!champ) lines.push(`<li>${done} of 25 races run · ${alive} marbles still in.</li>`);
  if (race && race.roster) lines.push(`<li>Field: ${race.roster.map((s) => `#${pad(s.marbleId)} ${esc(s.marbleName)}`).join(', ')}.</li>`);
  if (hof && hof.currentChampion) lines.push(`<li>Reigning champion: <a href="/gallery#${hof.currentChampion.id}">#${pad(hof.currentChampion.id)} ${esc(hof.currentChampion.name)}</a> (${hof.tournamentsCompleted} tournaments completed).</li>`);
  html = fill(html, 'HOME-NOSCRIPT', `<ul>${lines.join('')}</ul>`);
  html = fill(html, 'HOME', '');
  return html;
}

module.exports = { renderGallery, renderChampions, renderHome, galleryHue, champHue };
