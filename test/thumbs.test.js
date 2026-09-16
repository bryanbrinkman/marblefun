'use strict';

// Marble avatar thumbnails: disk cache, staleness by source URL, manifest rewrite.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createThumbnailer } = require('../src/thumbs');

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (e) {
    console.error('  ❌ ' + name + '\n     ' + e.message);
    process.exitCode = 1;
  }
};

console.log('thumbnail tests\n');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-'));
  const renders = [];
  const render = async (url) => {
    renders.push(url);
    if (url.includes('broken')) throw new Error('boom');
    return Buffer.from('WEBP:' + url);
  };
  const manifest = {
    1: { img: 'https://gw/001.jpg', glb: 'https://gw/001.glb' },
    2: { img: 'https://gw/002.jpg' },
    3: { img: 'https://gw/broken.jpg' },
    4: { glb: 'https://gw/004.glb' },
  };

  await test('ensureAll renders every image once, skips entries without images, tolerates failures', async () => {
    const t = createThumbnailer({ dir, size: 64, render, log: () => {} });
    const made = await t.ensureAll(manifest);
    assert.strictEqual(made, 2);
    assert.deepStrictEqual(renders.sort(), ['https://gw/001.jpg', 'https://gw/002.jpg', 'https://gw/broken.jpg']);
    assert.ok(t.has('1', 'https://gw/001.jpg') && t.has('2', 'https://gw/002.jpg') && !t.has('3', 'https://gw/broken.jpg'));
    assert.strictEqual(fs.readFileSync(t.file('1'), 'utf8'), 'WEBP:https://gw/001.jpg');
  });

  await test('apply: img → local thumb, original kept as imgFull; untouched where no thumb', async () => {
    const t = createThumbnailer({ dir, size: 64, render, log: () => {} });
    const out = t.apply(manifest);
    assert.deepStrictEqual(out['1'], { img: '/marbles/thumb/1.webp', imgFull: 'https://gw/001.jpg', glb: 'https://gw/001.glb' });
    assert.deepStrictEqual(out['3'], { img: 'https://gw/broken.jpg' });
    assert.deepStrictEqual(out['4'], { glb: 'https://gw/004.glb' });
  });

  await test('second boot reuses the disk cache (no re-render); a changed source URL re-renders', async () => {
    renders.length = 0;
    const t = createThumbnailer({ dir, size: 64, render, log: () => {} });
    await t.ensureAll({ 1: manifest[1], 2: { img: 'https://gw/002-v2.jpg' } });
    assert.deepStrictEqual(renders, ['https://gw/002-v2.jpg']);
    assert.ok(t.has('2', 'https://gw/002-v2.jpg'));
    assert.ok(!t.has('2', 'https://gw/002.jpg'), 'stale for the old URL');
  });

  await test('a failing render is retried at most twice per boot', async () => {
    renders.length = 0;
    const t = createThumbnailer({ dir, size: 64, render, log: () => {} });
    for (let i = 0; i < 4; i++) await t.ensure('3', 'https://gw/broken.jpg');
    assert.strictEqual(renders.length, 2);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
})();
