# Deploying the marble tournament

There are two ways to run marblerun.fun, and they're different products:

| | **Vercel (static)** | **Fly.io (server)** |
|---|---|---|
| What runs | The tournament runs in each visitor's browser | One authoritative tournament runs on a server 24/7 |
| Shared/live? | No — every visitor gets their own run | Yes — everyone watches the same race at the same time |
| Persistence | Restarts at heat 1 each visit | Keeps running even when nobody's watching |
| Cost | Free | ~$5–6/month (one small always-on VM + a tiny volume) |

The static site needs nothing here. The Fly server is what the files in this
folder (`Dockerfile`, `fly.toml`) are for.

## Deploy the server to Fly.io

You need the [`flyctl` CLI](https://fly.io/docs/flyctl/install/) and a Fly
account (`fly auth login`).

```bash
# From the repo root, on the `main` branch:

# 1. Register the app named in fly.toml (skip if it already exists).
fly apps create marblefun

# 2. Create the persistent volume the SQLite DB lives on (fly.toml mounts it
#    at /data). Pick the SAME region as fly.toml's primary_region.
fly volumes create marble_data --region iad --size 1   # 1 GB is plenty

# 3. Ship it. Fly builds the Dockerfile (installs Chromium — first build is a
#    few minutes) and boots one always-on machine.
fly deploy

# 4. Open it.
fly open
```

The Fly dashboard's "launch from GitHub repo" screen does the same thing —
just make sure the **branch is `main`** and that a volume named `marble_data`
exists (step 2), or the first boot fails with "volume not found."

## Configuration

Everything is env vars (set in `fly.toml`'s `[env]`, or with
`fly secrets set NAME=value`):

| Var | Default | Meaning |
|-----|---------|---------|
| `MASTER_SEED` | `424242` | Seeds the whole tournament. Change for a new bracket. |
| `DB_PATH` | `/data/tournament.db` | SQLite file (on the mounted volume). |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Bind address. |
| `FAST_DEMO` | off | `1` = compressed timings, handy for a quick end-to-end test. |

## Good to know

- **On restart the server starts a fresh tournament from heat 1** — it doesn't
  resume mid-bracket. With `auto_stop_machines = "off"` and
  `min_machines_running = 1`, restarts only happen on a deploy or a crash, so a
  tournament normally runs start-to-champion uninterrupted.
- **After a champion, the server stops scheduling** and holds on the result
  rather than starting a new tournament. (Auto-looping into a fresh tournament
  is an easy follow-up if you want it truly endless.)
- The database records every race's full history even though the live view only
  shows the current tournament.
