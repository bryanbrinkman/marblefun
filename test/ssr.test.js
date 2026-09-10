'use strict';

// Server-side rendering of the crawlable pages (src/ssr.js): the static files'
// SSR anchors get filled with the same markup the client renders, and the
// output degrades gracefully with no data.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderGallery, renderChampions, renderHome } = require('../src/ssr');

let passed = 0;
function check(name, fn) {
  fn();
  console.log('  ✅ ' + name);
  passed++;
}
const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

console.log('SSR tests\n');

check('gallery: 100 marble cards with names + careers in the initial HTML', () => {
  const html = renderGallery(read('gallery.html'), {
    careers: [{ id: 42, races: 30, wins: 9, podiums: 15, titles: 2 }],
    manifest: { 7: { owner: 'Bryan' } },
  });
  assert.strictEqual((html.match(/class="card" role="listitem"/g) || []).length, 100);
  assert.ok(html.includes('Royal Flush')); // #42's permanent name
  assert.ok(html.includes('<b>9</b> wins · <b>15</b> podiums · 30 races'));
  assert.ok(html.includes('2× Champion'));
  assert.ok(html.includes('👤 Bryan'));
  assert.ok(html.includes('id="count">100 marbles<'));
  assert.ok(!html.includes('<!--SSR:'), 'no anchors left behind');
});

check('champions: empty history renders honest empty states, not "Loading"', () => {
  const html = renderChampions(read('champions.html'), { history: [], hof: { tournamentsCompleted: 0, racesRun: 0, distinctChampions: 0, currentChampion: null, mostTitles: [], repeatChampions: [], longestStreak: null } });
  assert.ok(!html.includes('Loading the record books'));
  assert.ok(html.includes('No champion has been crowned yet'));
  assert.ok(html.includes('No tournament has finished yet'));
});

check('champions: history renders holder, tiles, title table and timeline', () => {
  const history = [{
    tournamentId: 3, masterSeed: 424242, createdAt: 1, completedAt: 1700000000000,
    champion: { id: 73, name: 'Molder' },
    path: [
      { raceKey: 'heats:5', roundKey: 'heats', indexInRound: 5, rank: 1, timeSec: 41.2 },
      { raceKey: 'semis:1', roundKey: 'semis', indexInRound: 1, rank: 2, timeSec: 37.5 },
      { raceKey: 'final:0', roundKey: 'final', indexInRound: 0, rank: 1, timeSec: 30.6 },
    ],
    final: [{ rank: 1, marbleId: 73, marbleName: 'Molder', lane: 'RED', color: '#d9534f', timeSec: 30.6 }],
    racesRun: 25,
  }];
  const hof = { tournamentsCompleted: 1, racesRun: 25, distinctChampions: 1, currentChampion: { id: 73, name: 'Molder', tournamentId: 3 }, mostTitles: [{ id: 73, name: 'Molder', titles: 1, lastTournamentId: 3 }], repeatChampions: [], longestStreak: null };
  const html = renderChampions(read('champions.html'), { history, hof });
  assert.ok(html.includes('REIGNING CHAMPION'));
  assert.ok(html.includes('href="/gallery#73"'));
  assert.ok(html.includes('WILDCARD RUN'));
  assert.ok(html.includes('HEAT 6') && html.includes('SEMI 2') && html.includes('FINAL'));
  assert.ok(html.includes('1 title'));
  assert.ok(!html.includes('30.6s'), 'no finish times in results views');
  assert.ok(!html.includes('<!--SSR:'), 'no anchors left behind');
});

check('home: race title, progress and a noscript summary; untouched with no snapshot', () => {
  const src = read('index.html');
  assert.strictEqual(renderHome(src, { snapshot: null }), src);
  const roster = [1, 2, 3, 4, 5].map((id, slot) => ({ slot, marbleId: id, marbleName: 'M' + id, lane: 'L', color: '#fff' }));
  const snapshot = {
    tournament: { id: 9, champion: null },
    current: { raceKey: 'heats:3', phase: 'running' },
    rounds: [{ key: 'heats', races: [0, 1, 2, 3].map((i) => ({ key: 'heats:' + i, roundKey: 'heats', indexInRound: i, roster, result: i < 3 ? [{}] : null })) }],
    standings: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, status: i < 12 ? 'eliminated' : 'alive' })),
  };
  const html = renderHome(src, { snapshot, hof: null });
  assert.ok(html.includes('id="raceTitle">Qualifying · Race 4 of 20<'));
  assert.ok(html.includes('Race 4 of 25'));
  assert.ok(html.includes('3 of 25 races run · 88 marbles still in'));
  assert.ok(html.includes('#01 M1'));
  assert.ok(!html.includes('<!--SSR:'), 'no anchors left behind');
});

console.log(`\n${passed} checks passed`);
