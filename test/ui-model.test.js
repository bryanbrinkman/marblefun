'use strict';

// Unit tests for the pure spectator-UI rules (public/ui-model.js): the
// persistent "your marble" status, picker filtering, the stage strip and the
// 3D-renderer state machine. Fast, node-only.

const assert = require('node:assert');
const M = require('../public/ui-model.js');

let passed = 0;
function check(name, fn) {
  fn();
  console.log('  ✅ ' + name);
  passed++;
}

console.log('UI-model tests\n');

// ---- stage strip + remaining count ----------------------------------------
check('stage strip: fixed stages, one active, earlier ones done', () => {
  const s = M.stageStrip('semis');
  assert.deepStrictEqual(s.map((x) => x.key), ['heats', 'semis', 'final', 'champion']);
  assert.deepStrictEqual(s.map((x) => x.state), ['done', 'active', 'todo', 'todo']);
  assert.strictEqual(M.stageStrip(null)[0].state, 'active'); // nothing run yet → qualifying
  assert.strictEqual(M.stageStrip('champion')[3].state, 'active');
  assert.ok(M.STAGE_RULES.semis.includes('fastest runner-up'), 'the wildcard rule is spelled out');
});

check('remaining line separates the live count from the fixed sizes', () => {
  const field = (alive) => Array.from({ length: 100 }, (_, i) => ({ id: i + 1, status: i < alive ? 'alive' : 'eliminated' }));
  assert.strictEqual(M.remainingLine({ standings: field(100), champion: null, activeRound: null }), '100 marbles enter');
  assert.strictEqual(M.remainingLine({ standings: field(14), champion: null, activeRound: 'heats' }), '14 marbles remaining');
  assert.strictEqual(M.remainingLine({ standings: field(1), champion: null, activeRound: 'final' }), '1 marble remaining');
  assert.strictEqual(M.remainingLine({ standings: field(1), champion: { id: 1 }, activeRound: 'champion' }), 'Champion crowned');
  assert.strictEqual(M.remainingLine({ standings: [], champion: null, activeRound: 'heats' }), 'Field loading…');
});

// ---- your marble ------------------------------------------------------------
const base = { standing: 'alive', racingNow: false, placement: null, finished: false, upNext: false, nextLabel: '', scheduled: null, current: null, next: null, lastResult: null, drawnIn: {}, finalDrawn: false };
const st = (over) => M.yourMarbleStatus(Object.assign({}, base, over));
const Q = (n) => ({ short: `Qualifier ${n}`, roundKey: 'heats', number: n });
const SF = (n) => ({ short: `Semifinal ${n}`, roundKey: 'semis', number: n });

check('your marble: champion / out', () => {
  assert.deepStrictEqual(st({ standing: 'champion' }), { key: 'champion', tag: 'Champion', line: 'Tournament champion' });
  const out = st({ standing: 'eliminated', lastResult: { roundKey: 'heats', rank: 4, label: 'Qualifier 3', dnf: false } });
  assert.strictEqual(out.key, 'out');
  assert.strictEqual(out.tag, 'Out');
  assert.ok(out.line.startsWith('4th in Qualifier 3'));
  assert.ok(out.line.includes('back next tournament'));
  const dnf = st({ standing: 'eliminated', lastResult: { roundKey: 'semis', rank: 5, label: 'Semifinal 1', dnf: true } });
  assert.ok(dnf.line.startsWith('Did not finish in Semifinal 1'));
});

check('your marble: racing now, with and without a live placement', () => {
  assert.deepStrictEqual(st({ racingNow: true }), { key: 'racing', tag: 'Racing now', line: 'Racing now' });
  assert.strictEqual(st({ racingNow: true, placement: 2 }).line, 'Racing now · 2nd');
  assert.strictEqual(st({ racingNow: true, placement: 1, finished: true }).line, 'Finished 1st');
});

check('your marble: up next beats waiting', () => {
  const s = st({ upNext: true, nextLabel: 'Semifinal 2 of 4', scheduled: SF(2), current: SF(2) });
  assert.strictEqual(s.key, 'next');
  assert.strictEqual(s.line, 'Up next · Semifinal 2 of 4');
});

check('your marble: waiting shows the scheduled race and the current race', () => {
  assert.strictEqual(st({ scheduled: Q(15), current: Q(6) }).line, 'Races in Qualifier 15 · Current race: 6');
  assert.strictEqual(st({ scheduled: Q(15) }).line, 'Races in Qualifier 15'); // nothing running yet — no invented timing
  assert.strictEqual(st({}).line, 'Waiting for its qualifying race'); // schedule unknown
});

check('your marble: between races the card names the next race, like the header', () => {
  assert.strictEqual(st({ scheduled: Q(15), next: Q(7) }).line, 'Races in Qualifier 15 · Next race: 7');
  assert.strictEqual(st({ lastResult: { roundKey: 'heats', rank: 1, label: 'Qualifier 3' }, next: Q(7) }).line, 'Won Qualifier 3 · semifinal draw after all qualifiers · Next race: Qualifier 7');
  assert.strictEqual(st({ drawnIn: { semis: true, final: true }, scheduled: { short: 'The Final', roundKey: 'final', number: 1 }, next: SF(4) }).line, 'Races in the Final · Next race: Semifinal 4');
  assert.strictEqual(st({ scheduled: Q(15), current: Q(6), next: Q(7) }).line, 'Races in Qualifier 15 · Current race: 6', 'a running race wins over the next one');
});

check('your marble: the "out" tag is short enough for one line; the reason wraps in the copy', () => {
  const out = st({ standing: 'eliminated', lastResult: { roundKey: 'heats', rank: 4, label: 'Qualifier 3', dnf: false } });
  assert.strictEqual(out.tag, 'Out');
  assert.strictEqual(out.line, '4th in Qualifier 3 · back next tournament');
});

// ---- race header ------------------------------------------------------------------
const R = (roundKey, i, ordinal) => ({
  roundKey,
  ordinal,
  label: roundKey === 'final' ? 'The Final' : roundKey === 'semis' ? `Semifinal ${i} of 4` : `Qualifying · Race ${i} of 20`,
  short: roundKey === 'final' ? 'The Final' : roundKey === 'semis' ? `Semifinal ${i}` : `Qualifier ${i}`,
});
check('race header: heading and counter always describe the same race', () => {
  // A race is announced / running: that race, its ordinal.
  assert.deepStrictEqual(M.raceHeader({ current: R('heats', 7, 7), last: R('heats', 6, 6) }), { title: 'Qualifying · Race 7 of 20', count: 'Race 7 of 25', note: '' });
  // Between races: the next race in both, and the last result named apart.
  assert.deepStrictEqual(M.raceHeader({ next: R('heats', 7, 7), last: R('heats', 6, 6) }), { title: 'Next: Qualifier 7', count: 'Race 7 of 25', note: 'Last result: Qualifier 6' });
  assert.deepStrictEqual(M.raceHeader({ next: R('semis', 1, 21), last: R('heats', 20, 20) }), { title: 'Next: Semifinal 1', count: 'Race 21 of 25', note: 'Last result: Qualifier 20' });
  assert.deepStrictEqual(M.raceHeader({ next: R('final', 1, 25), last: R('semis', 4, 24) }), { title: 'Next: The Final', count: 'Race 25 of 25', note: 'Last result: Semifinal 4' });
  // Round complete, next round not drawn yet: say what's being drawn.
  assert.deepStrictEqual(M.raceHeader({ last: R('heats', 20, 20) }), { title: 'Drawing the semifinals', count: 'Race 20 of 25', note: 'Last result: Qualifier 20' });
  // Nothing run or announced; tournament over; a replay on stage.
  assert.deepStrictEqual(M.raceHeader({ next: R('heats', 1, 1) }), { title: 'Next: Qualifier 1', count: 'Race 1 of 25', note: '' });
  assert.deepStrictEqual(M.raceHeader({}), { title: 'Tournament starting', count: '', note: '' });
  assert.deepStrictEqual(M.raceHeader({ champion: true, last: R('final', 1, 25) }), { title: 'Tournament complete', count: 'Race 25 of 25', note: '' });
  assert.deepStrictEqual(M.raceHeader({ replay: R('heats', 6, 6), next: R('heats', 7, 7), last: R('heats', 6, 6) }), { title: 'Qualifying · Race 6 of 20', count: 'Race 6 of 25', note: 'Replay' });
});

check('your marble: advanced → drawn into a semifinal → finalist', () => {
  const a = st({ lastResult: { roundKey: 'heats', rank: 1, label: 'Qualifier 7' }, current: Q(12) });
  assert.strictEqual(a.key, 'advanced');
  assert.strictEqual(a.line, 'Won Qualifier 7 · semifinal draw after all qualifiers · Current race: Qualifier 12');
  const b = st({ lastResult: { roundKey: 'heats', rank: 1, label: 'Qualifier 7' }, drawnIn: { semis: true }, scheduled: SF(2), current: SF(1) });
  assert.strictEqual(b.key, 'advanced');
  assert.strictEqual(b.line, 'Races in Semifinal 2 · Current race: 1');
  const c = st({ lastResult: { roundKey: 'semis', rank: 1, label: 'Semifinal 3' }, drawnIn: { semis: true, final: true }, scheduled: { short: 'The Final', roundKey: 'final', number: 1 } });
  assert.strictEqual(c.key, 'finalist');
  assert.strictEqual(c.tag, 'Finalist');
  assert.strictEqual(c.line, 'Races in the Final');
  const d = st({ lastResult: { roundKey: 'semis', rank: 1, label: 'Semifinal 3' }, drawnIn: { semis: true }, finalDrawn: false });
  assert.strictEqual(d.line, 'Won Semifinal 3 · through to the final');
});

check('your marble: semifinal runner-up waits on the wildcard until the final is drawn', () => {
  const w = st({ lastResult: { roundKey: 'semis', rank: 2, label: 'Semifinal 1' }, drawnIn: { semis: true }, finalDrawn: false });
  assert.strictEqual(w.key, 'waiting');
  assert.ok(w.line.includes('wildcard'));
  const o = st({ standing: 'eliminated', lastResult: { roundKey: 'semis', rank: 2, label: 'Semifinal 1' }, finalDrawn: true });
  assert.strictEqual(o.key, 'out');
});

// ---- picker ------------------------------------------------------------------
const field = [
  { id: 1, name: 'World Peace', status: 'alive' },
  { id: 2, name: 'ETH Saver', status: 'eliminated' },
  { id: 42, name: 'Royal Flush', status: 'alive' },
  { id: 73, name: 'Molder', status: 'champion' },
];
check('picker default filter: still competing while running, all otherwise', () => {
  assert.strictEqual(M.defaultPickerFilter({ standings: field, champion: null }), 'alive');
  assert.strictEqual(M.defaultPickerFilter({ standings: field, champion: { id: 73 } }), 'all');
  assert.strictEqual(M.defaultPickerFilter({ standings: [], champion: null }), 'all');
  assert.strictEqual(M.defaultPickerFilter({ standings: field.map((m) => ({ ...m, status: 'eliminated' })), champion: null }), 'all');
});

check('picker filter + search by number or name', () => {
  assert.deepStrictEqual(M.filterMarbles(field, { filter: 'alive' }).map((m) => m.id), [1, 42, 73]);
  assert.deepStrictEqual(M.filterMarbles(field, { filter: 'all', query: '02' }).map((m) => m.id), [2]);
  assert.deepStrictEqual(M.filterMarbles(field, { filter: 'all', query: '2' }).map((m) => m.id), [2]); // exact number, not #42
  assert.deepStrictEqual(M.filterMarbles(field, { filter: 'all', query: 'royal' }).map((m) => m.id), [42]);
  assert.deepStrictEqual(M.filterMarbles(field, { filter: 'alive', query: 'eth' }), []); // out marbles hidden in the alive filter
  assert.deepStrictEqual(M.filterMarbles(field, { filter: 'all', query: 'zzz' }), []);
});

check('surprise me draws from the visible set, never the current pick', () => {
  const vis = M.filterMarbles(field, { filter: 'alive' });
  assert.ok(!M.surprisePool(vis, 42).some((m) => m.id === 42));
  assert.deepStrictEqual(M.surprisePool([{ id: 5 }], 5).map((m) => m.id), [5]); // only option → allowed
  assert.deepStrictEqual(M.surprisePool([], 1), []);
});

// ---- renderer state machine ---------------------------------------------------
check('renderer: loading → ready / failed, retry → loading, late ready recovers', () => {
  assert.strictEqual(M.rendererNext('loading', 'api_ready'), 'ready');
  assert.strictEqual(M.rendererNext('loading', 'gl_missing'), 'failed');
  assert.strictEqual(M.rendererNext('loading', 'timeout'), 'failed');
  assert.strictEqual(M.rendererNext('failed', 'retry'), 'loading');
  assert.strictEqual(M.rendererNext('failed', 'api_ready'), 'ready');
  assert.strictEqual(M.rendererNext('ready', 'error'), 'failed');
  assert.strictEqual(M.rendererNext('ready', 'bogus'), 'ready');
});

// ---- replay requests -------------------------------------------------------
check('replay request: plays on a ready stage, waits for a loading one, falls back without 3D', () => {
  const race = { result: [{ rank: 1 }], raceSeed: 5, trackSeed: 9 };
  assert.strictEqual(M.replayRequest({ mode: 'server', rendererState: 'ready', race }).action, 'play');
  assert.strictEqual(M.replayRequest({ mode: 'server', rendererState: 'loading', race }).action, 'play-when-ready');
  const fb = M.replayRequest({ mode: 'server', rendererState: 'failed', race });
  assert.strictEqual(fb.action, 'fallback');
  assert.ok(/recorded finishing order/.test(fb.reason), 'the fallback explains itself');
});
check('replay request: never steals the stage from an imminent live race; nothing to replay locally or without a result', () => {
  const race = { result: [{ rank: 1 }], raceSeed: 5, trackSeed: 9 };
  assert.strictEqual(M.replayRequest({ mode: 'server', rendererState: 'ready', race, msToLive: 3000 }).action, 'wait');
  assert.strictEqual(M.replayRequest({ mode: 'server', rendererState: 'failed', race, msToLive: 3000 }).action, 'fallback', 'no 3D stage to protect: the recorded result is always available');
  assert.strictEqual(M.replayRequest({ mode: 'server', rendererState: 'ready', race, msToLive: 9000 }).action, 'play');
  assert.strictEqual(M.replayRequest({ mode: 'local', rendererState: 'ready', race }).action, 'unavailable');
  assert.strictEqual(M.replayRequest({ mode: 'server', rendererState: 'ready', race: { result: null, raceSeed: 5, trackSeed: 9 } }).action, 'unavailable');
  assert.strictEqual(M.replayRequest({ mode: 'server', rendererState: 'ready', race: null }).action, 'unavailable');
});

console.log(`\n${passed} checks passed`);
