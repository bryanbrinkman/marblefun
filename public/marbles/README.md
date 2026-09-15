# Custom marble skins

Give any of the 100 marbles its own **image texture** or **3D model (GLB)**.
Skins are **cosmetic only** — they never affect race physics or results, so the
tournament stays perfectly deterministic and in sync for everyone.

Marbles with no skin fall back to their default solid color, so you can skin as
many or as few as you like.

## Default: discovered from the artwork folders

In server mode the manifest is **built automatically**: the server lists the
two artwork directories (`MARBLE_IMG_DIR` — 2D images used as circle-cropped
avatars everywhere in the UI — and `MARBLE_GLB_DIR` — the GLB models that race
on the track; both default to the marbles' IPFS folders) and maps each file to
a marble by **name** (`Toad.png`, `get-that-bread.glb`) or by **number**
(`041.png`, `marble_41.glb`; a 0…99 set is treated as 0-based). The result is
served at `/marbles/manifest.json`, re-listed every 6 h and cached on disk so
a gateway hiccup at boot keeps the last good set. A marble with both an image
and a model races as the model and uses the image as its avatar. A hand-written
`manifest.json` here still overrides any field per marble (and carries owner
credits) — see below.

## Turn it on (manual manifest)

1. Drop your assets in this folder (`public/marbles/`).
2. Copy `manifest.example.json` to **`manifest.json`** and list which marble
   number uses which asset.
3. Deploy. That's it — no manifest (or the `.example` name) = default colors.

```json
{
  "1":  { "img": "marbles/001.png" },
  "12": { "glb": "marbles/012.glb" },
  "99": { "img": "https://your-cdn.example/099.png" }
}
```

Keys are the marble number (1–100). Each entry has **either** `img` **or**
`glb`. Paths are relative to `/public` (so `marbles/001.png`) or absolute
`https://` URLs (IPFS/Arweave/CDN all fine — see CORS below).

## Image skins  →  `_template.svg`

- The image wraps the marble sphere **equirectangularly** (like a world map):
  the middle row is the equator (faces the camera), top/bottom rows pinch to the
  poles — keep key art off the very top/bottom edge, and remember the left and
  right edges meet at the back.
- Open `_template.svg` as a guide, paint your art, hide the guides, export a
  **PNG or JPG**. Good sizes: `1024×512`, `2048×1024`, or a square `1024×1024`.
- Transparency (PNG alpha) is supported if you want a see-through marble.
- Save as e.g. `001.png` and point the manifest at it.

## GLB skins  →  `_template.glb`

- `_template.glb` is a plain marble-sized sphere (radius **0.22**, diameter
  **0.44** units, Y-up, centered at origin) with UVs and a neutral material —
  a clean base to replace in Blender/etc.
- Author your model at roughly that size and centered on the origin; the loader
  **normalizes every model to fill the marble sphere exactly** (per-axis, from
  its true vertex bounds), so exact size isn't critical — and a slightly
  squashed export still races as a perfect sphere. Note this means
  deliberately non-spherical art gets stretched to a ball. Keep it **low-poly** and embed textures in the `.glb` (binary glTF).
- Export as **`.glb`** (binary glТF 2.0), save as e.g. `012.glb`, point the
  manifest at it.
- Note: only the marbles in the current and next race load their models
  (preloaded on page load and as soon as a race is drawn, so they're on the
  device before the gate opens), so 100 skins is fine — but keep each `.glb`
  reasonably small; phones download them over the air.

## Hosting off-site (IPFS / Arweave / CDN)

Absolute `https://` URLs work, but the host **must send CORS headers**
(`Access-Control-Allow-Origin: *` or your domain) — WebGL refuses to read
cross-origin textures/models without them. Assets served from this same site
(`marbles/…`) need no special setup.

## Owners (Marble Gallery)

The gallery page at [`/gallery`](/gallery) shows every marble's name, career
stats and **owner**. Ownership is cosmetic metadata in the same manifest —
add `owner` (display name) and optionally `ownerLink` (profile/site URL) to
any entry:

```json
{
  "7": { "img": "marbles/007.jpg", "owner": "Bryan", "ownerLink": "https://example.com" },
  "12": { "owner": "Alice" }
}
```

An entry may have owner info without a skin (like `12` above) — the marble
keeps its default color but shows as claimed in the gallery. Marbles with no
`owner` show as **Unclaimed**.

## Files here

| File | What it is |
|------|-----------|
| `_template.svg` | Equirectangular image-texture guide |
| `_template.glb` | Marble-sized sphere GLB starter |
| `manifest.example.json` | Example manifest — copy to `manifest.json` to activate |
