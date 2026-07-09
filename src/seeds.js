'use strict';

// =========================================================
// Deterministic seed derivation
// =========================================================
// The whole tournament is reproducible from a single 32-bit master seed.
// Every (trackSeed, raceSeed) pair is derived from it with a stable hash,
// so re-running the server with the same master seed replays the exact
// same tournament — same courses, same races, same winners.
//
// The marble game treats seeds as uint32 (`seed >>> 0`), so every value
// here is forced into that range.

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
// Used to derive a unique, stable seed per race from (master, round, index).
function deriveSeed(...coords) {
  let h = 0x9e3779b9 >>> 0; // golden-ratio constant as the initial state
  for (const c of coords) {
    h = (h ^ mix32((c >>> 0) + 0x165667b1)) >>> 0;
    h = mix32(h);
  }
  return h >>> 0;
}

module.exports = { mix32, deriveSeed };
