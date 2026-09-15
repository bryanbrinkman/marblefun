'use strict';

// Marble skin discovery.
//
// The 100 marbles' artwork lives off-site as two flat directories (IPFS via a
// gateway, or any static host): one of 2D images (avatars for the picker,
// gallery, HUD…) and one of GLB models (what races on the track). Rather than
// hand-maintaining public/marbles/manifest.json, the server reads both
// directory listings, works out which file belongs to which marble, and serves
// the result at /marbles/manifest.json (the shape the viewer already consumes —
// see public/marbles/README.md). A hand-written manifest.json still wins for
// any field it sets, so one-off overrides and owner credits keep working.
//
// Matching a file to a marble (in this order):
//   1. by NAME — the filename without extension, lower-cased with everything
//      but letters and digits removed, equals a marble name treated the same
//      way ("Get-That-Bread.png", "toad.glb", "Aerys II.png").
//   2. by NUMBER — the first 1–3 digit run in the filename that is a valid
//      marble number ("042.png", "marble_42.glb", "42 - Toad.webp"). A set
//      numbered 0…99 with no 100 is treated as 0-based (0 → marble 1).
// Files that match nothing are ignored, so templates, previews and READMEs in
// the same folder are harmless.

const fs = require('node:fs');
const path = require('node:path');

const IMG_EXT = /\.(png|jpe?g|webp|gif|avif|svg)$/i;
const GLB_EXT = /\.(glb|gltf)$/i;
const MARBLE_COUNT = 100;

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Turn a directory listing (HTML index page, JSON array/object, or an IPFS
// dag-json node) into [{ name, url }]. Lenient by design: gateways differ.
function parseListing(text, dirUrl) {
  const base = ensureSlash(dirUrl);
  const out = new Map();
  const add = (name, href) => {
    name = decodeSafe(String(name || '')).trim();
    if (!name || name === '.' || name === '..' || name.includes('/')) return;
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) return; // directories, CIDs, "?format=" links
    let url;
    try {
      url = href ? new URL(href, base).toString() : base + encodeURIComponent(name);
    } catch {
      url = base + encodeURIComponent(name);
    }
    if (!out.has(name)) out.set(name, { name, url });
  };

  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let j = null;
    try {
      j = JSON.parse(trimmed);
    } catch {
      j = null;
    }
    if (j) {
      const items = Array.isArray(j)
        ? j
        : j.Links || j.links || j.entries || j.files || j.items || j.Objects?.[0]?.Links || [];
      for (const it of items) {
        if (typeof it === 'string') add(it, null);
        else if (it && typeof it === 'object') add(it.Name || it.name || it.path || it.Path, it.url || it.href || null);
      }
      return [...out.values()];
    }
  }

  // HTML index: every href that resolves to a file inside this directory.
  // `?filename=` (some gateways link CIDs with a filename hint) is honoured.
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(trimmed))) {
    const href = m[1].replace(/&amp;/g, '&');
    let u;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    const hinted = u.searchParams.get('filename');
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    const name = hinted || seg;
    // Only entries of THIS directory (direct children), not parents/site chrome.
    const inDir = hinted ? true : u.origin + u.pathname.replace(/[^/]*$/, '') === base;
    if (!inDir) continue;
    add(name, u.origin + u.pathname + (hinted ? u.search : ''));
  }
  return [...out.values()];
}

function ensureSlash(u) {
  const s = String(u || '').trim();
  return s.endsWith('/') ? s : s + '/';
}
function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function stripExt(name) {
  return name.replace(/\.[a-z0-9]{2,5}$/i, '');
}

// Map listing entries onto marble numbers. `names` = ['World Peace', …] (index
// 0 → marble 1). Returns { byId: Map<id, entry>, unmatched: [names] }.
function assignFiles(entries, names) {
  const bySlug = new Map();
  (names || []).forEach((n, i) => bySlug.set(slug(n), i + 1));
  const byId = new Map();
  const unmatched = [];
  const numbered = []; // [{ n, entry }] — resolved after we know the numbering base

  for (const e of entries) {
    const stem = stripExt(e.name);
    const byName = bySlug.get(slug(stem));
    if (byName) {
      if (!byId.has(byName)) byId.set(byName, e);
      continue;
    }
    const num = firstNumber(stem);
    if (num == null) unmatched.push(e.name);
    else numbered.push({ n: num, entry: e });
  }
  if (numbered.length) {
    const ns = numbered.map((x) => x.n);
    const zeroBased = Math.min(...ns) === 0 && Math.max(...ns) <= MARBLE_COUNT - 1;
    for (const { n, entry } of numbered) {
      const id = zeroBased ? n + 1 : n;
      if (id >= 1 && id <= MARBLE_COUNT && !byId.has(id)) byId.set(id, entry);
      else if (id < 1 || id > MARBLE_COUNT) unmatched.push(entry.name);
    }
  }
  return { byId, unmatched };
}

function firstNumber(stem) {
  const m = /(?:^|[^0-9])(\d{1,3})(?![0-9])/.exec(' ' + stem);
  return m ? parseInt(m[1], 10) : null;
}

// Build the viewer manifest from parsed listings.
function buildManifest({ images = [], models = [], names = [] } = {}) {
  const imgs = assignFiles(images.filter((e) => IMG_EXT.test(e.name)), names);
  const glbs = assignFiles(models.filter((e) => GLB_EXT.test(e.name)), names);
  const manifest = {};
  for (let id = 1; id <= MARBLE_COUNT; id++) {
    const i = imgs.byId.get(id);
    const g = glbs.byId.get(id);
    if (!i && !g) continue;
    const entry = {};
    if (i) entry.img = i.url;
    if (g) entry.glb = g.url;
    manifest[String(id)] = entry;
  }
  return { manifest, stats: { images: imgs.byId.size, models: glbs.byId.size, unmatched: [...imgs.unmatched, ...glbs.unmatched] } };
}

// Overlay: discovered entries first, then the hand-written manifest's fields
// win wherever it says something (img/glb/owner/ownerLink…).
function mergeManifests(discovered, override) {
  const out = {};
  for (const [k, v] of Object.entries(discovered || {})) out[k] = { ...v };
  for (const [k, v] of Object.entries(override || {})) {
    if (k.startsWith('_') || !v || typeof v !== 'object') continue;
    out[k] = { ...(out[k] || {}), ...v };
  }
  return out;
}

async function fetchListing(dirUrl, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const base = ensureSlash(dirUrl);
  // Plain index first (HTML or JSON, whatever the host serves), then the IPFS
  // gateway spec's dag-json form of a UnixFS directory as a fallback.
  const attempts = [
    { url: base, headers: { accept: 'text/html, application/json;q=0.9, */*;q=0.5' } },
    { url: base + '?format=dag-json', headers: { accept: 'application/vnd.ipld.dag-json, application/json' } },
  ];
  let lastErr = null;
  for (const a of attempts) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(a.url, { signal: ctl.signal, headers: a.headers, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const entries = parseListing(text, base);
      if (entries.length) return entries;
      lastErr = new Error('listing had no files');
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error('listing unavailable');
}

// Discover both directories. Never throws: a failed directory yields zero
// entries and an `error` string in `sources` so the operator can see why.
async function discoverSkins({ imgDir, glbDir, names, fetchImpl, timeoutMs } = {}) {
  const sources = {};
  const get = async (key, dir) => {
    if (!dir) return [];
    try {
      const entries = await fetchListing(dir, { fetchImpl, timeoutMs });
      sources[key] = { url: ensureSlash(dir), files: entries.length };
      return entries;
    } catch (e) {
      sources[key] = { url: ensureSlash(dir), files: 0, error: e && e.message ? e.message : String(e) };
      return [];
    }
  };
  const [images, models] = await Promise.all([get('img', imgDir), get('glb', glbDir)]);
  const { manifest, stats } = buildManifest({ images, models, names });
  return { manifest, stats, sources };
}

// Long-lived registry the server hands the merged manifest from. Discovery
// runs at start and every `refreshMs`; the last good result is cached on disk
// so a gateway outage at boot doesn't strip every marble back to plain colors.
function createSkinRegistry({
  imgDir = null,
  glbDir = null,
  names = [],
  staticManifestPath = null,
  cachePath = null,
  refreshMs = 6 * 3600 * 1000,
  fetchImpl = undefined,
  timeoutMs = 15000,
  log = () => {},
} = {}) {
  let discovered = {};
  let info = { at: null, sources: {}, stats: null, fromCache: false };
  let timer = null;

  if (cachePath) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (c && c.manifest && typeof c.manifest === 'object') {
        discovered = c.manifest;
        info = { at: c.at || null, sources: c.sources || {}, stats: c.stats || null, fromCache: true };
      }
    } catch {
      /* no cache yet */
    }
  }

  function readStatic() {
    if (!staticManifestPath) return {};
    try {
      const j = JSON.parse(fs.readFileSync(staticManifestPath, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }

  async function refresh() {
    if (!imgDir && !glbDir) return manifest();
    const r = await discoverSkins({ imgDir, glbDir, names, fetchImpl, timeoutMs });
    const got = Object.keys(r.manifest).length;
    const failed = Object.values(r.sources).filter((s) => s.error);
    if (got > 0) {
      discovered = r.manifest;
      info = { at: Date.now(), sources: r.sources, stats: r.stats, fromCache: false };
      if (cachePath) {
        try {
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, JSON.stringify({ at: info.at, sources: r.sources, stats: r.stats, manifest: r.manifest }));
        } catch (e) {
          log('skins: could not write cache — ' + (e && e.message));
        }
      }
      log(`skins: ${r.stats.images} images, ${r.stats.models} models matched` + (r.stats.unmatched.length ? `, ${r.stats.unmatched.length} files ignored` : ''));
    } else {
      log('skins: discovery found nothing' + (failed.length ? ' — ' + failed.map((s) => `${s.url}: ${s.error}`).join('; ') : '') + (Object.keys(discovered).length ? ' (keeping previous manifest)' : ''));
    }
    for (const s of failed) if (got > 0) log(`skins: ${s.url} unavailable — ${s.error}`);
    return manifest();
  }

  function manifest() {
    return mergeManifests(discovered, readStatic());
  }

  function start() {
    refresh().catch((e) => log('skins: refresh failed — ' + (e && e.message)));
    if (refreshMs > 0 && (imgDir || glbDir)) {
      timer = setInterval(() => refresh().catch((e) => log('skins: refresh failed — ' + (e && e.message))), refreshMs);
      if (timer.unref) timer.unref();
    }
    return registry;
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  const registry = { manifest, refresh, start, stop, status: () => ({ ...info, imgDir, glbDir, entries: Object.keys(discovered).length }) };
  return registry;
}

module.exports = {
  parseListing,
  assignFiles,
  buildManifest,
  mergeManifests,
  fetchListing,
  discoverSkins,
  createSkinRegistry,
  IMG_EXT,
  GLB_EXT,
};
