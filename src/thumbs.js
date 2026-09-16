'use strict';

// Marble avatar thumbnails.
//
// The marbles' 2D artwork is 1200×1200 JPEG (~200 KB, ~5.7 MB decoded). The
// viewer shows dozens of them at 10–60 px — and the picker shows all hundred —
// so phones were downloading ~20 MB and holding hundreds of MB of decoded
// bitmaps. The server renders each image once to a small square WebP (via the
// headless browser it already runs for the simulation), caches it on disk and
// serves it at /marbles/thumb/<id>.webp; the manifest points `img` at the
// thumbnail and keeps the original as `imgFull`.
//
// `render(url, size)` is injected (a Playwright page in production, a stub in
// tests) and must resolve to a Buffer of WebP bytes.

const fs = require('node:fs');
const path = require('node:path');

function createThumbnailer({ dir, size = 512, render, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(dir, 'index.json');
  let index = {}; // id -> source url the cached thumb was made from
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) || {};
  } catch {
    index = {};
  }
  const failed = new Map(); // id -> attempts this boot
  let running = null;

  const file = (id) => path.join(dir, `${id}.webp`);
  const has = (id, sourceUrl) => {
    if (!index[id] || (sourceUrl && index[id] !== sourceUrl)) return false;
    try {
      return fs.statSync(file(id)).size > 0;
    } catch {
      return false;
    }
  };
  function saveIndex() {
    try {
      fs.writeFileSync(indexPath, JSON.stringify(index));
    } catch (e) {
      log('thumbs: could not write index — ' + (e && e.message));
    }
  }

  async function ensure(id, sourceUrl) {
    if (has(id, sourceUrl)) return true;
    if ((failed.get(id) || 0) >= 2) return false;
    try {
      const buf = await render(sourceUrl, size);
      if (!buf || !buf.length) throw new Error('empty render');
      fs.writeFileSync(file(id), buf);
      index[id] = sourceUrl;
      saveIndex();
      return true;
    } catch (e) {
      failed.set(id, (failed.get(id) || 0) + 1);
      log(`thumbs: #${id} failed — ${(e && e.message) || e}`);
      return false;
    }
  }

  // Generate every missing/stale thumbnail for a manifest, one at a time
  // (the browser page is shared; this runs in the background at boot).
  function ensureAll(manifest) {
    if (running) return running;
    running = (async () => {
      let made = 0;
      const ids = Object.keys(manifest || {}).filter((id) => manifest[id] && manifest[id].img);
      for (const id of ids) {
        if (has(id, manifest[id].img)) continue;
        if (await ensure(id, manifest[id].img)) made++;
      }
      if (made) log(`thumbs: rendered ${made} new thumbnail${made === 1 ? '' : 's'} (${size}px)`);
      running = null;
      return made;
    })();
    return running;
  }

  // Rewrite a manifest so `img` is the small local thumbnail where one exists
  // (original kept as `imgFull`). Entries without a thumbnail are untouched.
  function apply(manifest, urlFor = (id) => `/marbles/thumb/${id}.webp`) {
    const out = {};
    for (const [id, v] of Object.entries(manifest || {})) {
      if (v && typeof v === 'object' && v.img && has(id, v.img)) out[id] = { ...v, imgFull: v.img, img: urlFor(id) };
      else out[id] = v;
    }
    return out;
  }

  return { has, ensure, ensureAll, apply, file, size, dir };
}

// Production renderer: draw the remote image onto a square canvas in a
// Playwright page and hand back WebP bytes. `openPage` returns a Playwright
// Page; the same page is reused for every thumbnail.
function browserRenderer(openPage, { quality = 0.86, timeoutMs = 20000 } = {}) {
  let pagePromise = null;
  const getPage = () => {
    if (!pagePromise) pagePromise = openPage();
    return pagePromise;
  };
  return async (url, size) => {
    const page = await getPage();
    const dataUrl = await page.evaluate(
      ({ url, size, quality, timeoutMs }) =>
        new Promise((resolve, reject) => {
          const im = new Image();
          im.crossOrigin = 'anonymous';
          const t = setTimeout(() => reject(new Error('image timed out')), timeoutMs);
          im.onload = () => {
            clearTimeout(t);
            try {
              const c = document.createElement('canvas');
              c.width = size;
              c.height = size;
              const g = c.getContext('2d');
              g.imageSmoothingQuality = 'high';
              g.drawImage(im, 0, 0, size, size);
              resolve(c.toDataURL('image/webp', quality));
            } catch (e) {
              reject(e);
            }
          };
          im.onerror = () => {
            clearTimeout(t);
            reject(new Error('image failed to load'));
          };
          im.src = url;
        }),
      { url, size, quality, timeoutMs }
    );
    if (!/^data:image\/webp;base64,/.test(dataUrl)) throw new Error('browser did not produce WebP');
    return Buffer.from(dataUrl.split(',')[1], 'base64');
  };
}

module.exports = { createThumbnailer, browserRenderer };
