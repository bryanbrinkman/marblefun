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
| `MASTER_SEED` | `424242` | Reproduces an entire tournament |
| `ANNOUNCE_LEAD_MS` | `30000` | How far ahead races are announced |
| `INTER_RACE_GAP_MS` | `6000` | Pause between a reveal and the next announcement |
| `DB_PATH` | `data/tournament.db` | SQLite file |
| `FAST_DEMO=1` | – | Short lead / gap for demos |
| `RACE_WATCH_OVERRIDE_MS` | – | Reveal after a fixed delay instead of the real race length (testing) |

`GET /api/state` returns the full live snapshot as JSON.

## Test

```bash
npm test          # fast, browser-free: bracket funnel, seeds, scheduler, DB, WS framing
node headless_test.js [trackSeed] [raceSeed]   # runs the REAL sim headlessly, proves determinism
```
