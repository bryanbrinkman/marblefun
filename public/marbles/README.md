# Custom marble skins

Give any of the 100 marbles its own **image texture** or **3D model (GLB)**.
Skins are **cosmetic only** — they never affect race physics or results, so the
tournament stays perfectly deterministic and in sync for everyone.

Marbles with no skin fall back to their default solid color, so you can skin as
many or as few as you like.

## Turn it on

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
  also **auto-scales** any model to fit the marble, so exact size isn't
  critical. Keep it **low-poly** and embed textures in the `.glb` (binary glTF).
- Export as **`.glb`** (binary glТF 2.0), save as e.g. `012.glb`, point the
  manifest at it.
- Note: only the 5 marbles in the current race load their assets (lazy per
  race), so 100 skins is fine — but keep each `.glb` reasonably small.

## Hosting off-site (IPFS / Arweave / CDN)

Absolute `https://` URLs work, but the host **must send CORS headers**
(`Access-Control-Allow-Origin: *` or your domain) — WebGL refuses to read
cross-origin textures/models without them. Assets served from this same site
(`marbles/…`) need no special setup.

## Files here

| File | What it is |
|------|-----------|
| `_template.svg` | Equirectangular image-texture guide |
| `_template.glb` | Marble-sized sphere GLB starter |
| `manifest.example.json` | Example manifest — copy to `manifest.json` to activate |
