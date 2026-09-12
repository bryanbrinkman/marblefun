'use strict';

const crypto = require('node:crypto');

// =========================================================
// Deterministic seed derivation
// =========================================================
// Two layers:
//
//  1. sha256-based derivation from a 256-bit MASTER SEED (server). Every
//     32-bit seed the sim consumes is the first 4 bytes (big-endian) of a
//     SHA-256 over an explicit byte layout, documented per function below and
//     on the /api page so anyone can re-derive it. Race seeds additionally mix
//     in a PUBLIC CONTRIBUTION revealed only at race_start, so the holder of
//     the master seed cannot know outcomes in advance.
//
//  2. The legacy SplitMix32 fold (mix32 / deriveSeed). Still used by the
//     browser-only local mode (public/tournament-core.js mirrors it) and by
//     tests; NOT used for any server-run race any more.
//
// The marble game treats seeds as uint32 (`seed >>> 0`), so every value here
// is forced into that range.

// SplitMix32 finalizer — a well-mixed uint32 -> uint32 hash. Deterministic
// and dependency-free.
function mix32(x) {
  x = x >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x >>> 0;
}

// Fold an arbitrary list of integer "coordinates" into one uint32 seed.
function deriveSeed(...coords) {
  let h = 0x9e3779b9 >>> 0; // golden-ratio constant as the initial state
  for (const c of coords) {
    h = (h ^ mix32((c >>> 0) + 0x165667b1)) >>> 0;
    h = mix32(h);
  }
  return h >>> 0;
}

// ---- 256-bit master seed ------------------------------------------------------

const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const u32be = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const u8 = (n) => Buffer.from([n & 0xff]);
const utf8 = (s) => Buffer.from(String(s), 'utf8');

// A fresh 256-bit master seed.
function randomMasterSeed() {
  return crypto.randomBytes(32);
}

// Normalize a master seed to a 32-byte Buffer. Accepts a Buffer, a 64-char
// hex string, or a legacy uint32 (expanded via sha256 so old configs keep
// producing a usable, if low-entropy, master seed — see MASTER_SEED docs).
function toMasterBuf(master) {
  if (Buffer.isBuffer(master)) {
    if (master.length !== 32) throw new Error('master seed must be 32 bytes');
    return Buffer.from(master);
  }
  if (typeof master === 'string' && /^[0-9a-fA-F]{64}$/.test(master)) return Buffer.from(master, 'hex');
  if (typeof master === 'number' && Number.isFinite(master)) {
    return sha256(utf8('marblerun-legacy-u32-master:'), u32be(master));
  }
  if (typeof master === 'string' && /^\d+$/.test(master)) return toMasterBuf(Number(master));
  throw new Error('unsupported master seed: ' + String(master));
}

// First 4 bytes (big-endian) of sha256 over the given parts → uint32.
function u32FromHash(...parts) {
  return sha256(...parts).readUInt32BE(0) >>> 0;
}

// Bracket draws (which marbles meet in which heat/semi/final):
//   sha256( masterSeed[32] ‖ tournamentId u32be ‖ "draw:" + roundKey )[0..4]
function drawSeedFor(masterBuf, tournamentId, roundKey) {
  return u32FromHash(masterBuf, u32be(tournamentId), utf8('draw:' + roundKey));
}

// Course for a race (candidate `attempt` — 0 first; a dud course re-rolls):
//   sha256( masterSeed[32] ‖ tournamentId u32be ‖ raceKey utf8 ‖ "track" ‖ attempt u8 )[0..4]
function trackSeedFor(masterBuf, tournamentId, raceKey, attempt = 0) {
  return u32FromHash(masterBuf, u32be(tournamentId), utf8(raceKey), utf8('track'), u8(attempt));
}

// Probe seed — used ONLY to check a candidate course isn't a dud before it is
// announced (never for a real race):
//   sha256( masterSeed[32] ‖ tournamentId u32be ‖ raceKey utf8 ‖ "probe" )[0..4]
function probeSeedFor(masterBuf, tournamentId, raceKey) {
  return u32FromHash(masterBuf, u32be(tournamentId), utf8(raceKey), utf8('probe'));
}

// The outcome seed. Fixed at race_start, when the public contribution exists:
//   raceSeed = sha256( masterSeed[32] ‖ tournamentId u32be ‖ raceKey utf8 ‖ publicContribution[32] )[0..4]
function raceSeedFor(masterBuf, tournamentId, raceKey, publicContribution) {
  const pub = Buffer.isBuffer(publicContribution) ? publicContribution : Buffer.from(publicContribution, 'hex');
  if (pub.length !== 32) throw new Error('publicContribution must be 32 bytes');
  return u32FromHash(masterBuf, u32be(tournamentId), utf8(raceKey), pub);
}

// The public (non-house) half of a race seed:
//   publicContribution = sha256( "marblerun-public-v1" ‖ beaconBytes ‖ seed_1 ‖ seed_2 ‖ … )
//   beaconBytes  = utf8( source + ":" + round + ":" + value )   (empty when no beacon)
//   seed_i       = the 32-byte client seeds, sorted as lowercase hex strings, deduped
// Anyone with the race_start payload can recompute it.
function publicContributionFor({ beacon = null, clientSeeds = [] } = {}) {
  const parts = [utf8('marblerun-public-v1')];
  if (beacon && beacon.value) parts.push(utf8(`${beacon.source}:${beacon.round}:${beacon.value}`));
  const seeds = [...new Set(clientSeeds.map((s) => String(s).toLowerCase()))].filter((s) => /^[0-9a-f]{64}$/.test(s)).sort();
  for (const s of seeds) parts.push(Buffer.from(s, 'hex'));
  return sha256(...parts);
}

// Fairness commitment: commit = sha256( masterSeed[32] ‖ salt[32] ), revealed
// with masterSeed + salt when the tournament completes.
function makeCommitment(masterBuf, salt = crypto.randomBytes(32)) {
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'hex');
  return { salt: saltBuf.toString('hex'), commit: sha256(masterBuf, saltBuf).toString('hex') };
}

module.exports = {
  mix32,
  deriveSeed,
  sha256,
  randomMasterSeed,
  toMasterBuf,
  u32FromHash,
  drawSeedFor,
  trackSeedFor,
  probeSeedFor,
  raceSeedFor,
  publicContributionFor,
  makeCommitment,
};
