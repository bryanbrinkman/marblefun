# Marble Tournament Server

A tournament server for the **deterministic marble racing game** (`public/marble_run.html`).
A race is fully defined by a `(trackSeed, raceSeed)` pair, so the server never
streams video or positions — it broadcasts the two seeds ~30 seconds before each
race and every client **replays the race locally** from those seeds, arriving at
the exact same finish the server independently recorded.

```
 100 marbles
   │  20 heats × 5      → winner of each advances        (20 qualifiers)
   ▼
   4 semifinals × 5     → winner of each (4) + fastest    (5 finalists)
   │                      runner-up wildcard (1)
   ▼
   1 final × 5          → 🏆 champion
```

25 races total. The whole tournament is reproducible from a single master seed.

## How it works

| Piece | File | Role |
|-------|------|------|
| **Scheduler** | `src/scheduler.js` | Runs the timeline: announce → start → reveal → advance the bracket |
| **Headless simulator** | `src/simulator.js` | Loads the *real* game in headless Chromium (Playwright) and calls `marbleAPI.simulateRace` — the server computes results from the identical code the viewer replays |
| **Bracket logic** | `src/tournament.js` | 100 marbles, seed derivation, 20→4→1 funnel, advancement, standings |
| **WebSocket** | `src/ws.js` | Dependency-free RFC 6455 server; broadcasts announcements & results |
| **Persistence** | `src/db.js` | SQLite (`node:sqlite`) record of tournaments, races, rosters, results |
| **HTTP + wiring** | `src/server.js` | Serves the viewer, exposes `/api/state`, boots everything |
| **Viewer** | `public/index.html`, `public/viewer.js` | Bracket UI + embeds the game in an `<iframe>` and drives the local replay from broadcast seeds |

### The broadcast → replay contract

1. **`race_announced`** (30 s before start): `{ trackSeed, raceSeed, roster, scheduledStart }`.
   The viewer pre-builds the course (`marbleAPI.newCourse(trackSeed)`) and counts down.
2. **`race_start`** (at `scheduledStart`): every client calls `marbleAPI.startRace(raceSeed)`
   at the same wall-clock instant (synced via the server clock), so all viewers see the same race.
3. **`race_result`** (once the marbles would have finished on screen): the finishing
   order, persisted to SQLite and used to build the next round.

Because the sim is deterministic, the result the server recorded headlessly == what
every viewer saw. `getResults()` / `simulateRace()` prove it: same seed ⇒ identical order.

### Mapping 100 marbles onto 5 lanes

The game always races exactly 5 marbles in fixed color lanes
(RED, BLUE, GREEN, YELLOW, CREAM). Each race assigns its 5 tournament marbles to
those lanes in roster order; the deterministic sim decides which *color* wins, which
maps back to the marble in that lane. The roster (lane → marble) is part of every
broadcast so viewers can label the marbles.

## Two ways to run

The viewer works **with or without a server**:

- **Server mode** — `node src/server.js` runs the authoritative tournament,
  broadcasts seeds over WebSocket, and records everything in SQLite. Every
  connected client stays in sync (all watching the same race at the same time)
  and results are persisted. This is the full experience.
- **Local / serverless mode** — if the viewer can't reach a WebSocket server
  (e.g. it's served as **static files on Vercel/Netlify/GitHub Pages**), it
  falls back to running the whole tournament **in the browser**: it builds the
  bracket, announces each race, drives the real race in the iframe, reads the
  finishing order back out of the game, records it, and advances — looping
  forever with a fresh tournament after each champion. No backend required.
  `public/tournament-core.js` is a browser copy of the bracket logic (with its
  own 32-bit seed derivation — there is no house to commit to in local mode), so
  a local tournament is just as deterministic.

Because the whole `public/` folder is self-sufficient in local mode, deploying
to a static host is just "serve `public/`". Server mode additionally needs a
host that can run a long-lived Node process + headless Chromium (Render,
Railway, Fly.io, a VM) — that part does **not** run on Vercel's serverless
platform.

## Requirements

- **Node ≥ 22.5** (uses the built-in `node:sqlite`)
- **Playwright** with a Chromium build (used headlessly for the authoritative sim)
- `public/vendor/three.min.js` — THREE r128, vendored so the game runs offline
  (both in the headless sim and in the browser). No npm dependencies otherwise.

## Run

```bash
node src/server.js
# open http://localhost:8080
```

Environment knobs:

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8080` | HTTP + WebSocket port |
| `MASTER_SEED` | `424242` | Seeds the FIRST tournament of a fresh database only; 64 hex chars (256-bit) preferred, a decimal integer is accepted for demos (expanded via sha256 — low entropy, don't use in production). Every later tournament draws 32 random bytes from `crypto.randomBytes` |
| `PUBLIC_BEACON` | `drand` | Public randomness source folded into every race seed at race_start: `drand`, `nist`, or `none` (client seeds only) |
| `PUBLIC_BEACON_URL` | – | Override the beacon endpoint URL |
| `ANNOUNCE_LEAD_MS` | `30000` | How far ahead races are announced |
| `INTER_RACE_GAP_MS` | `6000` | Pause between a reveal and the next announcement |
| `INTERMISSION_MS` | `30000` | How long the champion is celebrated before the next tournament starts |
| `DB_PATH` | `data/tournament.db` | SQLite file |
| `FAST_DEMO=1` | – | Short lead / gap for demos |
| `RACE_WATCH_OVERRIDE_MS` | – | Reveal after a fixed delay instead of the real race length (testing) |

Public read API (documented in full at `/api`):

| Endpoint | Returns |
|----------|---------|
| `GET /api/state` | the full live snapshot (same shape as the WebSocket `snapshot`) |
| `GET /api/next` | the upcoming/current race with roster, disclosed seeds and start time |
| `GET /api/history?limit=50` | recent completed races with seeds + results |
| `GET /api/careers` | lifetime per-marble stats (races, wins, podiums, titles) |
| `GET /api/champions?limit=50` | tournament winners; `history[]` adds each champion's road + the final's order |
| `GET /api/hall-of-fame` | all-time aggregates: title table, repeat champions, longest streak, current holder |

Pages: `/` (watch), `/gallery` (the 100 marbles), `/champions` (history), `/api` (docs),
`/print` (3D-print a course), `/admin` (token-protected controls).

The viewer's auto-camera lives in `public/tv-director.js` — a pure, unit-tested
module whose `RULES` (minimum shot length, phase thresholds, how often the
viewer's own marble gets a shot) can be tuned without touching the viewer.

## Test

```bash
npm test          # fast, browser-free: bracket funnel, seeds, scheduler, DB, WS framing, SSR, TV director
npm run test:replay                            # REAL sim in headless Chromium: recorded races must reproduce identically (CI)
npm run record:replay -- http://localhost:8080 # re-record test/fixtures/races.json after an intentional physics change
node headless_test.js [trackSeed] [raceSeed]   # runs the REAL sim headlessly, proves determinism
```
