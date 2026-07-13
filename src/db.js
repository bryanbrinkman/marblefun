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

  setChampion(tournamentId, marbleId) {
    this.db
      .prepare(`UPDATE tournaments SET status='complete', champion_marble_id=? WHERE id=?`)
      .run(marbleId, tournamentId);
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

  close() {
    this.db.close();
  }
}

module.exports = { DB };
