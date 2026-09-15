'use strict';

// Marble skin discovery: directory listings → manifest keyed by marble number.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseListing, buildManifest, mergeManifests, discoverSkins, createSkinRegistry } = require('../src/skins');
const { Tournament } = require('../src/tournament');

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

console.log('marble skin discovery tests\n');

const NAMES = Array.from({ length: 100 }, (_, i) => Tournament.marbleNameFor(i + 1));
const DIR = 'https://gw.example/ipfs/bafyDIR/';

// A go-ipfs / gateway style HTML index: parent link, hash column links, files.
const HTML = `
<html><body><h1>Index of /ipfs/bafyDIR</h1>
<a href="/ipfs/">..</a>
<a href="/ipfs/bafyDIR/001.png">001.png</a> <a href="/ipfs/bafyFILE1?filename=001.png">bafyFILE1</a>
<a href="/ipfs/bafyDIR/002.PNG">002.PNG</a>
<a href="/ipfs/bafyDIR/Get%20That%20Bread.png">Get That Bread.png</a>
<a href="/ipfs/bafyDIR/toad.webp">toad.webp</a>
<a href="/ipfs/bafyDIR/README.md">README.md</a>
<a href="/ipfs/bafyDIR/sub/">sub/</a>
<a href="https://other.example/x.png">x.png</a>
</body></html>`;

(async () => {
  await test('parseListing: HTML index → direct children only, decoded names, absolute urls', () => {
    const got = parseListing(HTML, DIR);
    const names = got.map((e) => e.name).sort();
    assert.deepStrictEqual(names, ['001.png', '002.PNG', 'Get That Bread.png', 'README.md', 'toad.webp']);
    const bread = got.find((e) => e.name === 'Get That Bread.png');
    assert.strictEqual(bread.url, DIR + 'Get%20That%20Bread.png');
  });

  await test('parseListing: JSON array / dag-json Links', () => {
    const a = parseListing(JSON.stringify(['1.glb', '2.glb', 'notes.txt']), DIR);
    assert.deepStrictEqual(a.map((e) => e.name), ['1.glb', '2.glb', 'notes.txt']);
    assert.strictEqual(a[0].url, DIR + '1.glb');
    const d = parseListing(JSON.stringify({ Links: [{ Name: 'Toad.glb', Hash: 'x' }, { Name: 'sub', Hash: 'y' }] }), DIR);
    assert.deepStrictEqual(d.map((e) => e.name), ['Toad.glb']);
  });

  await test('buildManifest: by name, by number (zero-padded), ignores strays, glb + img combine', () => {
    const images = parseListing(HTML, DIR);
    const models = parseListing(JSON.stringify(['041.glb', 'Get-That-Bread.glb', 'template.glb', 'preview.glb']), DIR);
    const { manifest, stats } = buildManifest({ images, models, names: NAMES });
    assert.strictEqual(manifest['1'].img, DIR + '001.png');
    assert.strictEqual(manifest['2'].img, DIR + '002.PNG');
    assert.strictEqual(manifest['14'].img, DIR + 'Get%20That%20Bread.png'); // #14 Get That Bread
    assert.strictEqual(manifest['14'].glb, DIR + 'Get-That-Bread.glb');
    assert.strictEqual(manifest['41'].img, DIR + 'toad.webp'); // #41 Toad
    assert.strictEqual(manifest['41'].glb, DIR + '041.glb');
    assert.strictEqual(manifest['99'], undefined);
    assert.strictEqual(stats.images, 4);
    assert.strictEqual(stats.models, 2);
    // README.md isn't an image so it never reaches matching; template/preview are unmatched models.
    assert.deepStrictEqual(stats.unmatched.sort(), ['preview.glb', 'template.glb']);
  });

  await test('buildManifest: 0-based numbering (0…99) shifts to marbles 1…100', () => {
    const images = parseListing(JSON.stringify(Array.from({ length: 100 }, (_, i) => `${i}.png`)), DIR);
    const { manifest } = buildManifest({ images, names: NAMES });
    assert.strictEqual(manifest['1'].img, DIR + '0.png');
    assert.strictEqual(manifest['100'].img, DIR + '99.png');
    const oneBased = buildManifest({ images: parseListing(JSON.stringify(['1.png', '100.png']), DIR), names: NAMES }).manifest;
    assert.strictEqual(oneBased['1'].img, DIR + '1.png');
    assert.strictEqual(oneBased['100'].img, DIR + '100.png');
  });

  await test('mergeManifests: static file overrides field-by-field, keeps owner credits, drops _comment', () => {
    const merged = mergeManifests(
      { 1: { img: 'a.png', glb: 'a.glb' }, 2: { img: 'b.png' } },
      { _comment: 'x', 1: { img: 'custom.png', owner: 'Bryan' }, 3: { owner: 'Alice' } }
    );
    assert.deepStrictEqual(merged['1'], { img: 'custom.png', glb: 'a.glb', owner: 'Bryan' });
    assert.deepStrictEqual(merged['2'], { img: 'b.png' });
    assert.deepStrictEqual(merged['3'], { owner: 'Alice' });
    assert.strictEqual(merged._comment, undefined);
  });

  await test('discoverSkins: one directory failing never breaks the other; error is reported', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://img.example/')) return { ok: true, status: 200, text: async () => JSON.stringify(['007.png']) };
      return { ok: false, status: 502, text: async () => '' };
    };
    const r = await discoverSkins({ imgDir: 'https://img.example/', glbDir: 'https://glb.example/', names: NAMES, fetchImpl });
    assert.strictEqual(r.manifest['7'].img, 'https://img.example/007.png');
    assert.strictEqual(r.sources.img.files, 1);
    assert.match(r.sources.glb.error, /HTTP 502/);
  });

  await test('registry: serves merged manifest, caches to disk, survives an outage from cache', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skins-'));
    const cachePath = path.join(tmp, 'sub', 'skins-cache.json');
    const staticPath = path.join(tmp, 'manifest.json');
    fs.writeFileSync(staticPath, JSON.stringify({ 5: { owner: 'Bryan' } }));
    let mode = 'ok';
    const fetchImpl = async (url) => {
      if (mode !== 'ok') throw new Error('network down');
      const list = url.startsWith('https://glb.example/') ? ['005.glb'] : ['005.png'];
      return { ok: true, status: 200, text: async () => JSON.stringify(list) };
    };
    const logs = [];
    const reg = createSkinRegistry({
      imgDir: 'https://img.example/', glbDir: 'https://glb.example/', names: NAMES,
      staticManifestPath: staticPath, cachePath, refreshMs: 0, fetchImpl, log: (m) => logs.push(m),
    });
    assert.deepStrictEqual(reg.manifest(), { 5: { owner: 'Bryan' } }, 'static-only before discovery');
    await reg.refresh();
    assert.deepStrictEqual(reg.manifest(), { 5: { img: 'https://img.example/005.png', glb: 'https://glb.example/005.glb', owner: 'Bryan' } });
    assert.ok(fs.existsSync(cachePath), 'cache written (with parent dir)');
    // Fresh registry while the gateway is down → last good manifest from cache.
    mode = 'down';
    const reg2 = createSkinRegistry({
      imgDir: 'https://img.example/', glbDir: 'https://glb.example/', names: NAMES,
      staticManifestPath: staticPath, cachePath, refreshMs: 0, fetchImpl, log: () => {},
    });
    assert.strictEqual(reg2.manifest()['5'].glb, 'https://glb.example/005.glb');
    assert.strictEqual(reg2.status().fromCache, true);
    await reg2.refresh();
    assert.strictEqual(reg2.manifest()['5'].glb, 'https://glb.example/005.glb', 'outage keeps the previous manifest');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await test('registry: no directories configured → static manifest only, no fetches', async () => {
    const reg = createSkinRegistry({ names: NAMES, fetchImpl: async () => { throw new Error('must not fetch'); } });
    await reg.refresh();
    assert.deepStrictEqual(reg.manifest(), {});
  });

  console.log(`\n${passed} checks passed`);
})();
