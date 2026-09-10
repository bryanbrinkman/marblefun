'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// =========================================================
// SQLite persistence (node:sqlite, built into Node >= 22.5)
// =========================================================
// Durable record of every tournament, race, roster and result. The scheduler
// writes here as races are announced / started / revealed; a fresh viewer can
// be brought fully up to date from this data after a server restart.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tournaments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  master_seed        INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'running',   -- running | complete
  champion_marble_id INTEGER
);

CREATE TABLE IF NOT EXISTS marbles (
  tournament_id INTEGER NOT NULL,
  marble_id     INTEGER NOT NULL,
  name          TEXT NOT NULL,
  PRIMARY KEY (tournament_id, marble_id)
);

CREATE TABLE IF NOT EXISTS races (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id  INTEGER NOT NULL,
  race_key       TEXT NOT NULL,       -- e.g. "heats:3"
  round_key      TEXT NOT NULL,       -- heats | semis | final
  round_idx      INTEGER NOT NULL,
  index_in_round INTEGER NOT NULL,
  track_seed     INTEGER NOT NULL,
  race_seed      INTEGER NOT NULL,
  scheduled_start INTEGER,            -- epoch ms the race is set to start
  announced_at   INTEGER,
  started_at     INTEGER,
  revealed_at    INTEGER,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|announced|running|done
  UNIQUE (tournament_id, race_key)
);

CREATE TABLE IF NOT EXISTS race_slots (
  race_id     INTEGER NOT NULL,
  slot        INTEGER NOT NULL,
  marble_id   INTEGER NOT NULL,
  marble_name TEXT NOT NULL,
  lane        TEXT NOT NULL,   -- color lane name (RED/BLUE/...)
  color       TEXT NOT NULL,
  PRIMARY KEY (race_id, slot)
);

CREATE TABLE IF NOT EXISTS results (
  race_id     INTEGER NOT NULL,
  rank        INTEGER NOT NULL,
  slot        INTEGER NOT NULL,
  marble_id   INTEGER NOT NULL,
  marble_name TEXT NOT NULL,
  lane        TEXT NOT NULL,
  color       TEXT NOT NULL,
  time_sec    REAL,             -- NULL = did not finish (stuck marble)
  PRIMARY KEY (race_id, rank)
);
`;

class DB {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this._open(file);
    } catch (err) {
      // A hard-killed machine can leave a half-written SQLite file that throws
      // on open. The DB is just a record of history, so recover by deleting the
      // corrupt files and starting fresh rather than crashing the server.
      if (file === ':memory:') throw err;
      console.error('[db] could not open', file, '-', err && err.message, '— resetting it.');
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try {
          fs.rmSync(file + suffix, { force: true });
        } catch {}
      }
      this._open(file);
    }
  }

  _open(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this._migrate();
  }

  // Additive, backward-compatible schema changes for databases created by
  // earlier builds. Each is idempotent: check the column list, add if missing.
  _migrate() {
    const cols = this.db.prepare(`PRAGMA table_info(tournaments)`).all().map((c) => c.name);
    // completed_at: when the champion was crowned. Older rows keep NULL; the
    // history views fall back to the final race's revealed_at for those.
    if (!cols.includes('completed_at')) {
      this.db.exec(`ALTER TABLE tournaments ADD COLUMN completed_at INTEGER`);
    }
  }

  createTournament({ masterSeed, createdAt }) {
    const info = this.db
      .prepare(
        `INSERT INTO tournaments (master_seed, created_at, status)
         VALUES (?, ?, 'running')`
      )
      .run(masterSeed, createdAt);
    return Number(info.lastInsertRowid);
  }

  // A race's track can be re-derived if the original seed built an unwinnable
  // course (see scheduler._computeOrder); keep the stored record accurate.
  updateRaceTrackSeed(raceId, trackSeed) {
    this.db.prepare(`UPDATE races SET track_seed = ? WHERE id = ?`).run(trackSeed, raceId);
  }

  insertMarbles(tournamentId, marbles) {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO marbles (tournament_id, marble_id, name) VALUES (?, ?, ?)`
    );
    for (const m of marbles) stmt.run(tournamentId, m.id, m.name);
  }

  // Insert a race + its roster. Returns the db race id.
  insertRace(tournamentId, race) {
    const info = this.db
      .prepare(
        `INSERT INTO races
          (tournament_id, race_key, round_key, round_idx, index_in_round,
           track_seed, race_seed, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        tournamentId,
        race.key,
        race.roundKey,
        race.roundIdx,
        race.indexInRound,
        race.trackSeed,
        race.raceSeed
      );
    const raceId = Number(info.lastInsertRowid);
    const slotStmt = this.db.prepare(
      `INSERT INTO race_slots (race_id, slot, marble_id, marble_name, lane, color)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const s of race.roster) {
      slotStmt.run(raceId, s.slot, s.marbleId, s.marbleName, s.lane, s.color);
    }
    return raceId;
  }

  markAnnounced(raceId, scheduledStart, announcedAt) {
    this.db
      .prepare(
        `UPDATE races SET status='announced', scheduled_start=?, announced_at=? WHERE id=?`
      )
      .run(scheduledStart, announcedAt, raceId);
  }

  markStarted(raceId, startedAt) {
    this.db
      .prepare(`UPDATE races SET status='running', started_at=? WHERE id=?`)
      .run(startedAt, raceId);
  }

  saveResult(raceId, order, revealedAt) {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO results
        (race_id, rank, slot, marble_id, marble_name, lane, color, time_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < order.length; i++) {
      const o = order[i];
      stmt.run(raceId, i + 1, o.slot, o.marbleId, o.marbleName, o.lane, o.color, o.timeSec);
    }
    this.db
      .prepare(`UPDATE races SET status='done', revealed_at=? WHERE id=?`)
      .run(revealedAt, raceId);
  }

  setChampion(tournamentId, marbleId, completedAt = Date.now()) {
    this.db
      .prepare(`UPDATE tournaments SET status='complete', champion_marble_id=?, completed_at=? WHERE id=?`)
      .run(marbleId, completedAt, tournamentId);
  }

  // ---- reads (for snapshots / debugging) --------------------------------

  getTournament(id) {
    return this.db.prepare(`SELECT * FROM tournaments WHERE id=?`).get(id);
  }

  getRaces(tournamentId) {
    const races = this.db
      .prepare(`SELECT * FROM races WHERE tournament_id=? ORDER BY round_idx, index_in_round`)
      .all(tournamentId);
    const slotStmt = this.db.prepare(`SELECT * FROM race_slots WHERE race_id=? ORDER BY slot`);
    const resStmt = this.db.prepare(`SELECT * FROM results WHERE race_id=? ORDER BY rank`);
    for (const r of races) {
      r.roster = slotStmt.all(r.id);
      r.result = resStmt.all(r.id);
    }
    return races;
  }

  // ---- admin: stats + export + reset ------------------------------------

  // Headline counts for the admin dashboard.
  statsSummary() {
    const one = (sql) => this.db.prepare(sql).get().c;
    return {
      tournaments: one(`SELECT COUNT(*) c FROM tournaments`),
      completed: one(`SELECT COUNT(*) c FROM tournaments WHERE status='complete'`),
      racesRun: one(`SELECT COUNT(*) c FROM races WHERE status='done'`),
      resultRows: one(`SELECT COUNT(*) c FROM results`),
    };
  }

  // Per-tournament champion history (one row per finished tournament). The
  // champion's name comes from that tournament's own marbles table, so a later
  // rename never rewrites history.
  exportChampions() {
    return this.db
      .prepare(
        `SELECT t.id AS tournament_id, t.master_seed, t.created_at, t.completed_at,
                t.champion_marble_id,
                COALESCE(m.name, 'Marble ' || substr('00' || t.champion_marble_id, -2)) AS champion_name
         FROM tournaments t
         LEFT JOIN marbles m ON m.tournament_id = t.id AND m.marble_id = t.champion_marble_id
         WHERE t.status='complete' AND t.champion_marble_id IS NOT NULL
         ORDER BY t.id`
      )
      .all();
  }

  // Rich champion history for the /champions page: every completed tournament
  // with the champion's road through the bracket (heat → semi → final, with
  // rank and time in each) and the final's full finishing order. Newest first.
  championHistory(limit = 100) {
    const tours = this.db
      .prepare(
        `SELECT t.id, t.master_seed, t.created_at, t.completed_at, t.champion_marble_id,
                COALESCE(m.name, 'Marble ' || substr('00' || t.champion_marble_id, -2)) AS champion_name
           FROM tournaments t
           LEFT JOIN marbles m ON m.tournament_id = t.id AND m.marble_id = t.champion_marble_id
          WHERE t.status='complete' AND t.champion_marble_id IS NOT NULL
          ORDER BY t.id DESC
          LIMIT ?`
      )
      .all(limit);
    const pathStmt = this.db.prepare(
      `SELECT r.race_key, r.round_key, r.round_idx, r.index_in_round, r.track_seed, r.race_seed,
              r.revealed_at, res.rank, res.time_sec
         FROM results res JOIN races r ON r.id = res.race_id
        WHERE r.tournament_id = ? AND res.marble_id = ?
        ORDER BY r.round_idx, r.index_in_round`
    );
    const finalStmt = this.db.prepare(
      `SELECT res.rank, res.marble_id, res.marble_name, res.lane, res.color, res.time_sec
         FROM results res JOIN races r ON r.id = res.race_id
        WHERE r.tournament_id = ? AND r.round_key = 'final'
        ORDER BY res.rank`
    );
    const countStmt = this.db.prepare(
      `SELECT COUNT(*) AS c FROM races WHERE tournament_id = ? AND status = 'done'`
    );
    return tours.map((t) => {
      const path = pathStmt.all(t.id, t.champion_marble_id).map((p) => ({
        raceKey: p.race_key,
        roundKey: p.round_key,
        indexInRound: p.index_in_round,
        trackSeed: p.track_seed,
        raceSeed: p.race_seed,
        rank: p.rank,
        timeSec: p.time_sec,
        revealedAt: p.revealed_at,
      }));
      const finalRow = path.find((p) => p.roundKey === 'final');
      return {
        tournamentId: t.id,
        masterSeed: t.master_seed,
        createdAt: t.created_at,
        // Older rows predate completed_at — the final's reveal is the crowning.
        completedAt: t.completed_at || (finalRow && finalRow.revealedAt) || null,
        champion: { id: t.champion_marble_id, name: t.champion_name },
        path,
        final: finalStmt.all(t.id).map((x) => ({
          rank: x.rank,
          marbleId: x.marble_id,
          marbleName: x.marble_name,
          lane: x.lane,
          color: x.color,
          timeSec: x.time_sec,
        })),
        racesRun: countStmt.get(t.id).c,
      };
    });
  }

  // Aggregate hall-of-fame numbers across every completed tournament.
  hallOfFame() {
    const champs = this.db
      .prepare(
        `SELECT t.id, t.champion_marble_id AS id_m, t.completed_at, t.created_at,
                COALESCE(m.name, 'Marble ' || substr('00' || t.champion_marble_id, -2)) AS name
           FROM tournaments t
           LEFT JOIN marbles m ON m.tournament_id = t.id AND m.marble_id = t.champion_marble_id
          WHERE t.status='complete' AND t.champion_marble_id IS NOT NULL
          ORDER BY t.id`
      )
      .all();
    const titles = new Map(); // marble id -> { id, name, titles, last }
    let streak = null; // longest run of consecutive tournaments by one marble
    let run = null;
    for (const c of champs) {
      const e = titles.get(c.id_m) || { id: c.id_m, name: c.name, titles: 0, lastTournamentId: null };
      e.titles++;
      e.name = c.name; // most recent name
      e.lastTournamentId = c.id;
      titles.set(c.id_m, e);
      if (run && run.id === c.id_m) run.len++;
      else run = { id: c.id_m, name: c.name, len: 1, fromTournamentId: c.id };
      if (!streak || run.len > streak.len) streak = { ...run };
    }
    const leaders = [...titles.values()].sort((a, b) => b.titles - a.titles || b.lastTournamentId - a.lastTournamentId);
    const last = champs[champs.length - 1] || null;
    return {
      tournamentsCompleted: champs.length,
      racesRun: this.db.prepare(`SELECT COUNT(*) c FROM races WHERE status='done'`).get().c,
      distinctChampions: titles.size,
      currentChampion: last ? { id: last.id_m, name: last.name, tournamentId: last.id } : null,
      mostTitles: leaders.slice(0, 10),
      repeatChampions: leaders.filter((l) => l.titles > 1),
      longestStreak: streak && streak.len > 1 ? streak : null,
    };
  }

  // Every finishing position of every race ever run (the raw record).
  exportResults() {
    return this.db
      .prepare(
        `SELECT r.tournament_id, r.race_key, r.round_key, r.index_in_round + 1 AS heat_number,
                r.track_seed, r.race_seed,
                res.rank, res.marble_id, res.marble_name, res.lane, res.time_sec
         FROM results res
         JOIN races r ON r.id = res.race_id
         ORDER BY r.tournament_id, r.round_idx, r.index_in_round, res.rank`
      )
      .all();
  }

  // Aggregate per-marble leaderboard across all history.
  exportMarbleStats() {
    return this.db
      .prepare(
        `SELECT res.marble_id, res.marble_name,
                COUNT(*) AS races,
                SUM(CASE WHEN res.rank = 1 THEN 1 ELSE 0 END) AS heat_wins,
                SUM(CASE WHEN res.rank <= 3 THEN 1 ELSE 0 END) AS podiums,
                SUM(CASE WHEN res.time_sec IS NULL THEN 1 ELSE 0 END) AS dnfs,
                (SELECT COUNT(*) FROM tournaments t
                   WHERE t.status='complete' AND t.champion_marble_id = res.marble_id) AS titles
         FROM results res
         GROUP BY res.marble_id, res.marble_name
         ORDER BY titles DESC, heat_wins DESC, podiums DESC, races DESC`
      )
      .all();
  }

  // Wipe ALL history. Order respects the implicit result->race->tournament
  // relationships. The caller is expected to immediately start a fresh
  // tournament so the DB isn't left empty.
  // Public API: lifetime career stats per marble id across ALL tournaments.
  // Grouped by id only — display names changed over time, ids are forever.
  marbleCareers() {
    return this.db
      .prepare(
        `SELECT res.marble_id AS id,
                COUNT(*) AS races,
                SUM(CASE WHEN res.rank = 1 THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN res.rank <= 3 THEN 1 ELSE 0 END) AS podiums,
                (SELECT COUNT(*) FROM tournaments t
                   WHERE t.status='complete' AND t.champion_marble_id = res.marble_id) AS titles
         FROM results res
         GROUP BY res.marble_id
         ORDER BY res.marble_id`
      )
      .all();
  }

  // Public API: recent completed races (newest first) with seeds + results —
  // everything a third-party site needs to settle predictions and verify
  // outcomes against the deterministic sim.
  recentRaces(limit = 50) {
    const races = this.db
      .prepare(
        `SELECT id, tournament_id, race_key, round_key, index_in_round,
                track_seed, race_seed, scheduled_start, started_at, revealed_at
           FROM races
          WHERE revealed_at IS NOT NULL
          ORDER BY revealed_at DESC, id DESC
          LIMIT ?`
      )
      .all(limit);
    const resStmt = this.db.prepare(
      `SELECT rank, slot, marble_id, marble_name, lane, color, time_sec
         FROM results WHERE race_id = ? ORDER BY rank`
    );
    return races.map((r) => ({
      tournamentId: r.tournament_id,
      raceKey: r.race_key,
      roundKey: r.round_key,
      indexInRound: r.index_in_round,
      trackSeed: r.track_seed,
      raceSeed: r.race_seed,
      scheduledStart: r.scheduled_start,
      startedAt: r.started_at,
      revealedAt: r.revealed_at,
      results: resStmt.all(r.id).map((x) => ({
        rank: x.rank,
        marbleId: x.marble_id,
        marbleName: x.marble_name,
        lane: x.lane,
        color: x.color,
        timeSec: x.time_sec,
      })),
    }));
  }

  resetAllHistory() {
    this.db.exec('BEGIN');
    try {
      for (const table of ['results', 'race_slots', 'races', 'marbles', 'tournaments']) {
        this.db.exec(`DELETE FROM ${table};`);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = { DB };
