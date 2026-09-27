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
const UIModel = require('../public/ui-model.js');

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
// Artwork as a background, with the larger thumbnail where the server has one
// (mirrors gallery.html's ballStyle). A card shows the artwork at ≤ ~230 css
// px, so the 512px thumbnail is a 2× asset there and the 1024px one is only
// worth fetching on 3×+ screens; the detail box (`dense`) shows it at ~320 css
// px and takes the 1024px one from 2× up.
function artBackground(skin, dense) {
  const u = (s) => `url('${esc(String(s).replace(/'/g, '%27'))}')`;
  let css = `background-image:${u(skin.img)}`;
  if (skin.img2x) {
    const set = dense ? `${u(skin.img)} 1x,${u(skin.img2x)} 2x` : `${u(skin.img)} 2x,${u(skin.img2x)} 4x`;
    css += `;background-image:-webkit-image-set(${set});background-image:image-set(${set})`;
  }
  return css;
}
function galleryBall(id, skin) {
  if (skin && skin.img) return artBackground(skin, false);
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
  if (sk && sk.img) return `background-image:url('${esc(sk.img)}');background-size:calc(100% * var(--skin-zoom, 1));background-position:center`;
  const c = color || champHue(id);
  return `--c1:${c};--c2:color-mix(in srgb, ${c} 45%, #000)`;
}

function fill(html, anchor, content) {
  return html.replace(`<!--SSR:${anchor}-->`, content);
}

// The gallery list view's columns — same markup and rounding as gallery.html's
// careerCols(), so hydration changes nothing.
function careerCols(c) {
  const cell = (cls, v, dim) => `<span class="m-c ${cls}${dim ? ' dim' : ''}">${v}</span>`;
  const rate = c.races ? Math.round((c.wins / c.races) * 100) + '%' : '—';
  return `<span class="m-cols" aria-label="${c.races} races, ${c.wins} wins, win rate ${rate}, ${c.podiums} podiums, ${c.titles} titles">` +
    cell('c-races', c.races, !c.races) + cell('c-wins', c.wins, !c.wins) + cell('c-rate', rate, !c.races) + cell('c-podiums', c.podiums, !c.podiums) + cell('c-titles', c.titles, !c.titles) + `</span>`;
}

// ---- /gallery -----------------------------------------------------------------
// careers: [{id, races, wins, podiums, titles}]; manifest: {id: {img, owner, ownerLink}}
function renderGallery(html, { careers = [], manifest = {}, hof = null } = {}) {
  const car = new Map(careers.map((c) => [c.id, c]));
  const reigning = hof && hof.currentChampion ? Number(hof.currentChampion.id) : null;
  const cards = [];
  for (let id = 1; id <= 100; id++) {
    const c = car.get(id) || { races: 0, wins: 0, podiums: 0, titles: 0 };
    const sk = manifest[id] || manifest[String(id)] || null;
    const owner = sk && sk.owner ? String(sk.owner) : null;
    // Card = the marble on its shelf with a plaque: number, name, wins. Owner
    // and the fuller statistics live in the detail view (client-side). Same
    // markup as gallery.html's render() so hydration changes nothing.
    cards.push(
      `<div class="card${owner ? ' claimed' : ''}${id === reigning ? ' reigning' : ''}" role="listitem" tabindex="0" data-id="${id}">` +
        `<div class="ball-wrap"><div class="ball${sk && sk.img ? ' art' : ''}" style="${galleryBall(id, sk)}"></div></div>` +
        `<div class="floor" aria-hidden="true"></div>` +
        `<div class="plaque"><span class="plaque-l">` +
        `<span class="m-nm"><span class="m-num">#${pad(id)}</span>` +
        `<span class="m-name">${esc(nameFor(id))}</span></span>` +
        `<span class="m-stats">${c.races ? `<b>${c.wins}</b> ${c.wins === 1 ? 'win' : 'wins'}` : 'No races yet'}</span>` +
        (c.titles ? `<span class="m-titles">🏆 ${c.titles} ${c.titles === 1 ? 'title' : 'titles'}</span>` : '') +
        (id === reigning ? '<span class="m-reign" title="Reigning champion"><span class="sr-only">Reigning </span>Champion</span>' : '') +
        `</span></div>` + careerCols(c) + `</div>`
    );
  }
  html = fill(html, 'GRID', cards.join(''));
  html = fill(html, 'COUNT', '100 marbles');
  return html;
}

// ---- /champions ---------------------------------------------------------------
// history: db.championHistory() rows (newest first, each with titleNumber —
// the champion's cumulative count as of that tournament — and lifetimeTitles);
// hof: db.hallOfFame(); coverage: db.archiveCoverage(); gaps: the tournament
// numbers in this page's span that have no champion (cut short, or running).
// Same markup as champions.html's script, which re-renders over it.
function renderChampions(html, { history = [], hof = null, manifest = {}, coverage = null, gaps = [], hasMore = false } = {}) {
  const fmtDate = (ms) =>
    ms ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : '';
  const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
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
      `<span><span class="hk">Reigning champion</span>` +
      `<div class="hn"><small>#${pad(cur.id)}</small>${esc(nameFor(cur.id))}</div>` +
      `<div class="hs">Won Tournament ${cur.tournamentId}${row && row.completedAt ? ' · ' + fmtDate(row.completedAt) : ''} · ${titles === 1 ? 'first title' : `${ordinal(titles)} title`}</div></span>`;
    html = html.replace('<a class="holder none" id="holder" href="/champions"><!--SSR:HOLDER-->Loading the record books…<!--/SSR:HOLDER--></a>',
      `<a class="holder" id="holder" href="/gallery#${cur.id}">${holder}</a>`);
  }

  // Tiles
  if (hof) {
    const top = (hof.mostTitles || [])[0];
    const rep = (hof.repeatChampions || []).length;
    const cut = coverage && coverage.abandoned ? `${fmtN(coverage.abandoned)} cut short` : '';
    const tiles = [
      { b: fmtN(hof.tournamentsCompleted), i: 'Tournaments completed', s: `${fmtN(hof.racesRun)} races run${cut ? ' · ' + cut : ''}` },
      { b: hof.distinctChampions, i: 'Different champions', s: rep ? `${rep} repeat winner${rep > 1 ? 's' : ''}` : 'no repeat winners yet' },
      { b: top ? `${top.titles}` : '—', i: 'Most titles', s: top ? `#${pad(top.id)} ${esc(nameFor(top.id))}` : 'nobody yet', gold: true },
      { b: hof.longestStreak ? `${hof.longestStreak.len}` : '1', i: 'Longest streak', s: hof.longestStreak ? `#${pad(hof.longestStreak.id)} ${esc(nameFor(hof.longestStreak.id))} back-to-back` : 'no back-to-back champions yet' },
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
              `<span class="nm"><small>#${pad(m.id)}</small>${esc(nameFor(m.id))}</span>` +
              `<span class="tt">${m.titles} title${m.titles > 1 ? 's' : ''}</span></a>`
          )
          .join('')
      : '<div class="empty">The title table fills in as tournaments finish.</div>'
  );

  // Count line: what this page shows out of what exists.
  let count = '';
  if (coverage) {
    const cut = coverage.abandoned ? ` · <b>${fmtN(coverage.abandoned)}</b> cut short by restarts (no champion)` : '';
    count = hasMore
      ? `Showing the latest <b>${fmtN(history.length)}</b> of <b>${fmtN(coverage.completed)}</b> completed tournaments${cut}`
      : `All <b>${fmtN(coverage.completed)}</b> completed tournaments${cut}`;
  }
  html = fill(html, 'COUNT', count);

  // Timeline
  if (!history.length && !gaps.length) {
    html = fill(html, 'TIMELINE', '<div class="empty">No tournament has finished yet. <a href="/">Watch the one running now →</a></div>');
    return html;
  }
  // Rows without titleNumber (older callers, tests) fall back to counting
  // within the page, which is only right when the page is the whole archive.
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
      .map((f) => `<div class="frow${f.rank === 1 ? ' win' : ''}"><span class="pos">${f.rank}</span><span class="sw" style="background:${esc(f.color)}"></span><a href="/gallery#${f.marbleId}">#${pad(f.marbleId)} ${esc(nameFor(f.marbleId))}</a><span class="t">${f.timeSec == null ? 'DNF' : ''}</span></div>`)
      .join('');
    const n = t.titleNumber || nthOf.get(t.tournamentId) || 1;
    const lifetime = t.lifetimeTitles && t.lifetimeTitles !== n ? ` <small>(${t.lifetimeTitles} today)</small>` : '';
    return {
      id: t.tournamentId,
      html:
        `<article class="champ" id="t${t.tournamentId}">` +
        `<div class="left"><span class="ball" style="${champBall(t.champion.id, color, manifest)}"></span><div class="tid">Tournament<b>${t.tournamentId}</b></div></div>` +
        `<div>` +
        `<div class="head"><a class="name" href="/gallery#${t.champion.id}"><small>#${pad(t.champion.id)}</small>${esc(nameFor(t.champion.id))}</a>` +
        `<span class="badge" title="${n === 1 ? 'First title' : `Title number ${n} for this marble as of this tournament`}">${n === 1 ? 'First title' : ordinal(n) + ' title'}${lifetime}</span>` +
        (t.champion.nameAtTheTime ? `<span class="badge then" title="The name this marble raced under at the time">then “${esc(t.champion.nameAtTheTime)}”</span>` : '') +
        (isWild ? `<span class="badge wild">Wildcard run</span>` : '') +
        `<span class="when">${fmtDate(t.completedAt)}</span></div>` +
        `<details class="more"><summary>Road to the title</summary>` +
        `<div class="road">${road || '<span class="step"><i>ROAD</i><b>—</b></span>'}</div>` +
        (finalRows ? `<div class="final"><div class="fh">The final</div>${finalRows}</div>` : '') +
        `</details>` +
        `<details class="tech"><summary>Technical details</summary><div class="seed">` +
        `<b>master seed</b> ${esc(t.masterSeed)}${t.masterSeedHex ? `<br><b>256-bit seed</b> ${esc(t.masterSeedHex)}` : ''}${t.commit ? `<br><b>commitment</b> ${esc(t.commit)}` : ''}` +
        `<br><b>races run</b> ${t.racesRun}` +
        `</div></details>` +
        `</div></article>`,
    };
  });
  // Numbers with no champion, folded into runs, in tournament order.
  const runs = [];
  for (const g of gaps.slice().sort((a, b) => b.tournamentId - a.tournamentId)) {
    const last = runs[runs.length - 1];
    if (last && last.status === g.status && last.lo === g.tournamentId + 1) { last.lo = g.tournamentId; last.n++; last.races += g.racesDone || 0; }
    else runs.push({ status: g.status, hi: g.tournamentId, lo: g.tournamentId, n: 1, races: g.racesDone || 0 });
  }
  const gapRows = runs.map((g) => {
    const range = g.n === 1 ? `Tournament ${g.hi}` : `Tournaments ${g.hi}–${g.lo}`;
    const h = g.status === 'running'
      ? `<div class="gap live" data-gap="${g.hi}"><b>${range}</b><span>in progress right now — <a href="/">watch it live</a></span></div>`
      : `<div class="gap" data-gap="${g.hi}"><b>${range}</b><span>${g.n === 1 ? 'was' : `${g.n} tournaments were`} cut short by a server restart — no champion was crowned${g.races ? ` (${fmtN(g.races)} race${g.races === 1 ? '' : 's'} had run)` : ''}</span></div>`;
    return { id: g.hi, html: h };
  });
  const items = cards.concat(gapRows).sort((a, b) => b.id - a.id);
  return fill(html, 'TIMELINE', items.map((x) => x.html).join(''));
}

// ---- / (homepage) --------------------------------------------------------------
// snapshot: scheduler.snapshot(). Fills the top-bar race title/progress and
// leaves a crawlable summary in the <noscript> block. Everything else is live.
function renderHome(html, { snapshot = null, hof = null } = {}) {
  if (!snapshot || !snapshot.rounds) return html;
  const races = snapshot.rounds.flatMap((r) => r.races);
  const done = races.filter((r) => r.result).length;
  const cur = snapshot.current && races.find((r) => r.key === snapshot.current.raceKey);
  const announced = cur && !cur.result ? cur : null;
  const race = announced || races.find((r) => !r.result) || null;
  const label = (r) =>
    r.roundKey === 'final' ? 'The Final' : r.roundKey === 'semis' ? `Semifinal ${r.indexInRound + 1} of 4` : `Qualifying · Race ${r.indexInRound + 1} of 20`;
  const short = (r) => (r.roundKey === 'final' ? 'The Final' : r.roundKey === 'semis' ? `Semifinal ${r.indexInRound + 1}` : `Qualifier ${r.indexInRound + 1}`);
  const desc = (r) => (r ? { label: label(r), short: short(r), ordinal: races.indexOf(r) + 1, roundKey: r.roundKey } : null);
  const lastDone = races.filter((r) => r.result).pop() || null;
  const champ = snapshot.tournament && snapshot.tournament.champion;
  // The same rule the viewer applies (UIModel.raceHeader), so the server-
  // rendered header never disagrees with what the script paints over it.
  const h = UIModel.raceHeader({
    current: desc(announced),
    next: announced ? null : desc(race),
    last: done || cur ? desc(lastDone) : null,
    champion: !!champ,
    total: 25,
  });
  const title = h.title;
  const alive = (snapshot.standings || []).filter((m) => m.status === 'alive').length;

  html = html.replace('<div class="race-title" id="raceTitle">Loading the tournament…</div>', `<div class="race-title" id="raceTitle">${esc(title)}</div>`);
  html = html.replace('<span class="rc-count" id="progressCount"></span>', `<span class="rc-count" id="progressCount">${esc(h.count)}</span>`);
  html = html.replace('<span class="rc-note" id="rcNote"></span>', `<span class="rc-note" id="rcNote">${esc(h.note)}</span>`);

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
