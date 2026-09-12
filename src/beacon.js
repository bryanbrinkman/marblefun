'use strict';

// =========================================================
// Public randomness beacon — the fallback public contribution
// =========================================================
// When no client submitted a seed during a race's announce window, the race
// seed still needs an input the house does not control. A public randomness
// beacon is fetched at race_start and included verbatim in the race_start
// payload so anyone can check it against the beacon's own archive.
//
// Sources (PUBLIC_BEACON env):
//   drand — League of Entropy, https://api.drand.sh/public/latest
//           (30 s rounds; `randomness` is 32 bytes hex, `round` is the index)
//   nist  — NIST Randomness Beacon 2.0, https://beacon.nist.gov/beacon/2.0/pulse/last
//           (60 s pulses; `outputValue` is 64 bytes hex, `pulseIndex` the index)
//   none  — disable (tests; a deployment that accepts client seeds only)
//
// Returns { source, round, value, time, url } or throws. The scheduler
// retries and, as a last resort, falls back to the last pulse it saw — and
// says so in the payload (`publicSource`), never silently.

const SOURCES = {
  drand: {
    url: 'https://api.drand.sh/public/latest',
    parse: (j) => ({ round: Number(j.round), value: String(j.randomness).toLowerCase(), time: null }),
  },
  nist: {
    url: 'https://beacon.nist.gov/beacon/2.0/pulse/last',
    parse: (j) => ({ round: Number(j.pulse.pulseIndex), value: String(j.pulse.outputValue).toLowerCase(), time: j.pulse.timeStamp || null }),
  },
};

async function fetchBeacon({ source = 'drand', url = null, timeoutMs = 2500 } = {}) {
  if (source === 'none') return null;
  const spec = SOURCES[source];
  if (!spec) throw new Error('unknown beacon source: ' + source);
  const target = url || spec.url;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(target, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`beacon ${source} HTTP ${res.status}`);
    const json = await res.json();
    const parsed = spec.parse(json);
    if (!parsed.value || !/^[0-9a-f]{32,128}$/.test(parsed.value)) throw new Error('beacon value malformed');
    return { source, url: target, round: parsed.round, value: parsed.value, time: parsed.time, fetchedAt: Date.now() };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fetchBeacon, SOURCES };
