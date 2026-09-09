// test/nuvizz-request.test.mjs — shared NuVizz request wrapper (Phase 4).
// Pure logic + the requester orchestration, exercised with stubbed deps so no
// network or Firestore is touched.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRetryableStatus,
  computeBackoffMs,
  dedupeKey,
  scanIntervalElapsed,
  createNuvizzRequester,
  NuvizzCircuitOpenError,
} from '../netlify/functions/lib/nuvizz-request.mts';

const META = { route: '/load/info', tenant: 'DAVIS' };

// Build a requester with in-memory counter/breaker and a scripted fetch.
function makeHarness({ responses = [], ceiling = 100_000, fetchImpl, breakerMode = 'enforce' } = {}) {
  let dayTotal = 0;
  let tripped = null;
  let calls = 0;
  const logs = [];
  let i = 0;
  const deps = {
    fetchImpl: fetchImpl || (async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return new Response('{}', { status: typeof r === 'number' ? r : 200 });
    }),
    recordCall: async (_m, n) => { dayTotal += n; calls++; return dayTotal; },
    isCircuitOpen: async () => tripped != null,
    tripCircuit: async (reason) => { tripped = reason; },
    log: (e) => logs.push(e),
    now: () => 1_000_000, // frozen clock
    sleep: async () => {}, // no real waiting
  };
  const r = createNuvizzRequester(deps, { dailyCeiling: ceiling, breakerMode, maxRetries: 3, backoffTotalCapMs: 1_000_000 });
  return { r, get dayTotal() { return dayTotal; }, get tripped() { return tripped; }, get calls() { return calls; }, logs };
}

test('isRetryableStatus: 429 and 5xx retry; 200/404 do not', () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(401), false);
});

test('computeBackoffMs: grows by factor and is capped at backoffMaxMs', () => {
  const cfg = { backoffBaseMs: 500, backoffFactor: 2, backoffMaxMs: 8000 };
  const d0 = computeBackoffMs(0, cfg);
  const d1 = computeBackoffMs(1, cfg);
  const d2 = computeBackoffMs(2, cfg);
  assert.ok(d1 > d0, 'attempt 1 waits longer than attempt 0');
  assert.ok(d2 > d1, 'attempt 2 waits longer than attempt 1');
  // attempt 10 would be 500*2^10 = 512000 -> capped near 8000 (+/-10% jitter)
  assert.ok(computeBackoffMs(10, cfg) <= 8000 * 1.1 + 1, 'capped at backoffMaxMs + jitter');
});

test('dedupeKey is method+url', () => {
  assert.equal(dedupeKey('get', 'https://x/load/info/1'), 'GET https://x/load/info/1');
});

test('scanIntervalElapsed: floor honored, null = always scan', () => {
  const now = 1_000_000_000;
  assert.equal(scanIntervalElapsed(null, now, 600_000), true);
  assert.equal(scanIntervalElapsed(new Date(now).toISOString(), now, 600_000), false, 'just scanned -> too soon');
  assert.equal(scanIntervalElapsed(new Date(now - 700_000).toISOString(), now, 600_000), true, 'past floor -> ok');
});

test('counts every round-trip against the shared daily counter', async () => {
  const h = makeHarness({ responses: [200] });
  await h.r.request('https://x/load/info/1/DAVIS', {}, META);
  await h.r.request('https://x/load/info/2/DAVIS', {}, META);
  assert.equal(h.dayTotal, 2, 'two distinct calls counted');
});

test('in-flight dedupe: concurrent identical GETs hit the network once', async () => {
  let fetches = 0;
  const h = makeHarness({
    fetchImpl: async () => { fetches++; await new Promise((r) => setTimeout(r, 5)); return new Response('{}', { status: 200 }); },
  });
  const url = 'https://x/load/info/42/DAVIS';
  const [a, b] = await Promise.all([h.r.request(url, {}, META), h.r.request(url, {}, META)]);
  assert.equal(fetches, 1, 'only one real fetch for two concurrent identical GETs');
  assert.equal(h.dayTotal, 1, 'only one counted');
  // both callers get a usable (cloned) response
  assert.equal(a.status, 200); assert.equal(b.status, 200);
});

test('POSTs are never deduped', async () => {
  let fetches = 0;
  const h = makeHarness({
    fetchImpl: async () => { fetches++; await new Promise((r) => setTimeout(r, 5)); return new Response('{}', { status: 200 }); },
  });
  const url = 'https://x/load/insertstops';
  await Promise.all([
    h.r.request(url, { method: 'POST', body: '{}' }, META),
    h.r.request(url, { method: 'POST', body: '{}' }, META),
  ]);
  assert.equal(fetches, 2, 'two POSTs => two fetches');
});

test('retries on 503 then succeeds, counting each attempt', async () => {
  let i = 0;
  const h = makeHarness({
    fetchImpl: async () => { i++; return new Response('{}', { status: i < 3 ? 503 : 200 }); },
  });
  const resp = await h.r.request('https://x/load/info/7/DAVIS', {}, META);
  assert.equal(resp.status, 200, 'eventually succeeds');
  assert.equal(i, 3, 'two 503s then a 200');
  assert.equal(h.dayTotal, 3, 'all three round-trips counted');
});

test('gives up after maxRetries and returns the last 5xx', async () => {
  const h = makeHarness({ fetchImpl: async () => new Response('{}', { status: 500 }) });
  const resp = await h.r.request('https://x/load/info/8/DAVIS', {}, META);
  assert.equal(resp.status, 500);
  assert.equal(h.dayTotal, 4, 'attempt + 3 retries = 4 counted round-trips');
});

test('trips the circuit breaker at the daily ceiling and then refuses', async () => {
  const h = makeHarness({ responses: [200], ceiling: 3 });
  await h.r.request('https://x/load/info/1/DAVIS', {}, META);
  await h.r.request('https://x/load/info/2/DAVIS', {}, META);
  assert.equal(h.tripped, null, 'not yet at ceiling');
  await h.r.request('https://x/load/info/3/DAVIS', {}, META); // count hits 3 == ceiling -> trip
  assert.ok(h.tripped && /ceiling/.test(h.tripped), 'breaker tripped at ceiling');
  // next request is refused outright
  await assert.rejects(
    () => h.r.request('https://x/load/info/4/DAVIS', {}, META),
    (e) => e instanceof NuvizzCircuitOpenError,
  );
});

test('monitor mode: crosses the ceiling but never trips or blocks (logs would-trip)', async () => {
  const h = makeHarness({ responses: [200], ceiling: 2, breakerMode: 'monitor' });
  await h.r.request('https://x/load/info/1/DAVIS', {}, META);
  await h.r.request('https://x/load/info/2/DAVIS', {}, META); // hits ceiling=2
  await h.r.request('https://x/load/info/3/DAVIS', {}, META); // over ceiling
  assert.equal(h.tripped, null, 'monitor never opens the breaker');
  assert.equal(h.dayTotal, 3, 'all calls still counted past the ceiling');
  // not refused — the scan keeps running
  const resp = await h.r.request('https://x/load/info/4/DAVIS', {}, META);
  assert.equal(resp.status, 200, 'monitor never blocks a request');
  const wouldTrip = h.logs.filter((e) => e.event === 'circuit-would-trip');
  assert.equal(wouldTrip.length, 1, 'logs a single would-trip warning at the ceiling');
  assert.equal(wouldTrip[0].mode, 'monitor');
});

// ── The daily ceiling: TWO numbers, and only ONE input may raise it ─────────
//
// Jul 29 — Chad: "Also need to set the max calls to 2000 and that needs to be enforced." The
// site was running 20,000 (an env var), the Diagnostics editor could reach 200,000, and the
// breaker defaulted to MONITOR — three separate ways the cap was not a cap.
//
// 2026-09-09 — Chad: "I just changed the settings to allow 3000 calls but still shows only
// 2000 enforce on the dropdown menu on the actual map." The Jul 29 fix used ONE number for
// both "what you get by default" and "the most anyone may ask for", so his own setting could
// not move it: the field took 3,000, the breaker kept 2,000, and nothing said they disagreed.
// The two questions are separate constants now. DEFAULT (2,000) is what the env var and any
// caller fallback are capped at — so a deploy changes nothing until somebody decides. HARD
// (3,000) is reachable ONLY by a deliberate save in the Diagnostics editor.
import {
  clampCeiling, savedCeiling, clampAmbientCeiling, DEFAULT_DAILY_CEILING,
  CEILING_SANITY_MAX, CEILING_ADVISORY,
  effectiveDailyCeiling, reportedDailyCeiling, setDailyCeilingOverride, BREAKER_MODE,
} from '../netlify/functions/lib/nuvizz-request.mts';

// v0.98.5 — Chad: "I want the number I set in diagnostics to be the number ... Whatever
// number it's set to is where I want the calls to end." The 3,000 hard cap is gone: it was
// the third occurrence of a constant in this file outranking the person who owns the spend.
test('THE RULE: whatever he saves is what is enforced — no cap he did not choose', () => {
  assert.equal(DEFAULT_DAILY_CEILING, 2000, 'still what you get when nobody has decided');
  for (const n of [1, 100, 500, 2000, 3000, 3001, 5000, 12_000, 20_000, 50_000, 200_000]) {
    assert.equal(savedCeiling(n), n, `saved ${n} must enforce ${n}`);
    setDailyCeilingOverride(n);
    assert.equal(effectiveDailyCeiling(), n, `the breaker binds at ${n}`);
    assert.equal(reportedDailyCeiling(n, {}), n, `and the gauge prints ${n}`);
  }
  setDailyCeilingOverride(null);
});

test('the only bound left on a saved setting is arithmetic sanity, not policy', () => {
  // A "ceiling" of 1e9 is indistinguishable from no ceiling; above the sanity max a value is
  // a typo or a corrupted document, not an intent. Everything a person would type is verbatim.
  assert.equal(CEILING_SANITY_MAX, 1_000_000);
  assert.equal(savedCeiling(1_000_000), 1_000_000);
  assert.equal(savedCeiling(1_000_001), 1_000_000);
  assert.equal(savedCeiling(1e9), 1_000_000);
  assert.equal(savedCeiling(2500.7), 2500, 'floored to a whole call');
  assert.equal(clampCeiling, savedCeiling, 'the old name still means the same thing');
});

test('the advisory threshold is advice, not a gate — it bounds nothing', () => {
  // The editor SAYS something above a cold full scan's cost; it does not refuse.
  assert.equal(CEILING_ADVISORY, 3000);
  assert.ok(CEILING_ADVISORY < CEILING_SANITY_MAX);
  assert.equal(savedCeiling(CEILING_ADVISORY + 1), CEILING_ADVISORY + 1, 'past the advisory is still saved');
  assert.equal(savedCeiling(30_000), 30_000, 'ten times it, still his number');
});

test('ONLY a saved setting may exceed the default — an env var and a caller fallback may not', () => {
  // The site has run NUVIZZ_DAILY_CEILING=20,000. If the env var could reach the hard cap,
  // merely deploying the raise would have lifted production's spend with nobody deciding it.
  assert.equal(clampAmbientCeiling(20_000), 2000, 'the env var may only LOWER');
  assert.equal(clampAmbientCeiling(3000), 2000);
  assert.equal(reportedDailyCeiling(undefined, { NUVIZZ_DAILY_CEILING: '3000' }), 2000);
  setDailyCeilingOverride(null);
  assert.equal(effectiveDailyCeiling(99_999), 2000, 'nor may a caller-supplied fallback');
});

test('a LOWER ceiling is honoured — the cap is a maximum, not a target', () => {
  assert.equal(clampCeiling(500), 500);
  assert.equal(clampCeiling(1), 1);
  assert.equal(clampAmbientCeiling(500), 500);
});

test('junk clamps to the DEFAULT, not to zero and not to the maximum', () => {
  // A ceiling of 0/NaN would compare `total >= 0` true on the first call and trip instantly,
  // or (read the other way) be treated as "no limit". And junk must never buy headroom: a
  // malformed setting is not a decision to spend 3,000.
  for (const junk of [0, -5, NaN, Infinity, null, undefined, '', 'lots', {}]) {
    assert.equal(clampCeiling(junk), 2000, String(junk));
    assert.equal(clampAmbientCeiling(junk), 2000, String(junk));
  }
});

test('effectiveDailyCeiling honours the override outright; a caller fallback still may not', () => {
  setDailyCeilingOverride(50_000);
  assert.equal(effectiveDailyCeiling(), 50_000, 'a saved setting is not capped');
  setDailyCeilingOverride(750);
  assert.equal(effectiveDailyCeiling(), 750, 'and a lower one is honoured just the same');
  setDailyCeilingOverride(null);
  // The asymmetry that survives: only a SAVED setting is a decision. Ambient inputs — the env
  // var, a number some code path passed itself — may still only lower, so nothing moves
  // without somebody deciding it.
  assert.equal(effectiveDailyCeiling(99_999), 2000);
});

test('ENFORCE is the default — a missing env var can no longer disarm the cap', () => {
  // Previously: anything other than the exact string 'enforce' meant monitor (never blocks).
  assert.equal(BREAKER_MODE, 'enforce');
});

test('the breaker BLOCKS at the clamped ceiling, not at the requested one', async () => {
  // Built asking for 20,000 — an ambient proposal, so it must still stop at the DEFAULT.
  let calls = 0;
  const deps = {
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
    recordCall: async () => calls,
    readCircuit: async () => ({ open: false }),
    tripCircuit: async () => {},
    now: () => Date.now(),
    sleep: async () => {},
  };
  setDailyCeilingOverride(null);
  const r = createNuvizzRequester(deps, { dailyCeiling: 20_000, breakerMode: 'enforce', maxRetries: 0, backoffTotalCapMs: 1000 });
  assert.equal(r.getStats().ceiling, 2000, 'the pill reports the ENFORCED number, not the requested one');
});

// ── THE NUMBER ON THE SPEND GAUGE ────────────────────────────────────────────
//
// Chad: "Fix that card to accurately represent what the ceiling is." It read "216 / 20,000"
// while the breaker was tripping at 2,000. A gauge that overstates headroom tenfold is worse
// than no gauge — it is the number somebody consults before turning a scan cadence up.

test('the card cannot print a ceiling the breaker will not honour — the real 20,000 case', () => {
  // The site's actual NUVIZZ_DAILY_CEILING, which the board endpoint used to report raw.
  assert.equal(reportedDailyCeiling(undefined, { NUVIZZ_DAILY_CEILING: '20000' }), 2000);
  assert.equal(reportedDailyCeiling(null, { NUVIZZ_DAILY_CEILING: 20000 }), 2000);
});

test('a stored Diagnostics ceiling is REPORTED as stored — the gauge prints his number', () => {
  // readScanConfig returns the raw document, and whatever is in it is what binds, so the
  // gauge must print exactly that. The old assertion here clamped these to 3,000, which is
  // the display half of the bug he hit twice.
  assert.equal(reportedDailyCeiling(20000, {}), 20000);
  assert.equal(reportedDailyCeiling(200000, {}), 200000);
  assert.equal(reportedDailyCeiling(3001, {}), 3001);
});

test('a genuinely lower ceiling is reported as set — the clamp only ever lowers', () => {
  assert.equal(reportedDailyCeiling(500, { NUVIZZ_DAILY_CEILING: '20000' }), 500);
  assert.equal(reportedDailyCeiling(undefined, { NUVIZZ_DAILY_CEILING: '900' }), 900);
  assert.equal(reportedDailyCeiling(1200, {}), 1200);
});

test('no config and no env is the DEFAULT — not the maximum, and not the old 12,000', () => {
  // The old expression fell back to a literal 12,000 that matched no other number in the
  // system. Nor may "nobody has decided" resolve to the most anyone could ask for.
  assert.equal(reportedDailyCeiling(undefined, {}), DEFAULT_DAILY_CEILING);
  assert.equal(reportedDailyCeiling(undefined, {}), 2000);
  assert.notEqual(reportedDailyCeiling(undefined, {}), 12000);
  assert.notEqual(reportedDailyCeiling(undefined, {}), CEILING_SANITY_MAX);
});

test('junk in the config or the env falls back rather than printing junk', () => {
  // true coerces to 1 and [1500] coerces to 1500, so a bare Number() here would have the
  // gauge reporting a ceiling of ONE call, or trusting an array. Both must fall through.
  for (const junk of [0, -1, NaN, 'abc', '', {}, [], [1500], true, false, null, undefined]) {
    assert.equal(reportedDailyCeiling(junk, { NUVIZZ_DAILY_CEILING: '1500' }), 1500, JSON.stringify(junk) ?? String(junk));
  }
  assert.equal(reportedDailyCeiling(true, {}), DEFAULT_DAILY_CEILING, 'true is not a ceiling of 1');
  assert.equal(reportedDailyCeiling(undefined, { NUVIZZ_DAILY_CEILING: 'abc' }), 2000);
  assert.equal(reportedDailyCeiling(undefined, null), 2000);
  assert.equal(reportedDailyCeiling(), clampAmbientCeiling(process.env.NUVIZZ_DAILY_CEILING));
});

test('THE PROPERTY: the number the gauge prints is the number the breaker enforces', () => {
  // Stated on the path production actually uses — both the Map card (reportedDailyCeiling)
  // and the scanner (setDailyCeilingOverride → effectiveDailyCeiling) are handed the SAME
  // stored scan_config.dailyCeiling. v0.70.2 shipped a gauge reading 20,000 against a breaker
  // tripping at 2,000 precisely because one path rebuilt the expression instead of sharing it.
  for (const stored of [1, 500, 1999, 2000, 2001, 3000, 3001, 20000, 200000, undefined, null, 'junk']) {
    setDailyCeilingOverride(typeof stored === 'number' ? stored : null);
    const printed = reportedDailyCeiling(stored, {});
    assert.ok(printed <= CEILING_SANITY_MAX, String(stored));
    assert.equal(printed, effectiveDailyCeiling(), `stored=${String(stored)}`);
  }
  setDailyCeilingOverride(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// v0.98.4 — "I have it set at 3000 as you can see but stopping me at 2000."
//
// The constants above were right and the SAVED number still did not reach the code that
// spends. setDailyCeilingOverride is a MODULE-LEVEL variable and Netlify functions are
// separate processes; refresh-stops-core was the only caller that ever set it, so every
// entrypoint outside a scan run held null and fell through to the 2,000 ambient default.
// One screen, one setting, two numbers: the card read "2,000 / 3,000" (display paths read
// the stored config) and the banner under it read "(2000/2000) — write refused".
//
// These tests state the rule the wrong way round from the fix, on purpose: nobody has to
// call a setter for the saved ceiling to be enforced.
// ─────────────────────────────────────────────────────────────────────────────
import {
  hydrateDailyCeiling, circuitStillBinding, __resetDailyCeilingCache, CEILING_TTL_MS, CEILING_RETRY_MS,
} from '../netlify/functions/lib/nuvizz-request.mts';

test('a process that never calls the setter still enforces the SAVED 3,000 — Chad, 2026-09-09', async () => {
  __resetDailyCeilingCache();
  // Exactly the nuvizz-write case: fresh process, nothing has set the override, stored = 3000.
  assert.equal(effectiveDailyCeiling(), 2000, 'the bug: before hydration it is the ambient default');
  const got = await hydrateDailyCeiling(async () => 3000);
  assert.equal(got, 3000, 'the write endpoint refuses at 3,000, not 2,000');
  assert.equal(effectiveDailyCeiling(), 3000);
  // And the refusal banner would now print the same number the Map card prints.
  assert.equal(effectiveDailyCeiling(), reportedDailyCeiling(3000, {}));
  __resetDailyCeilingCache();
});

test('hydration honours the save verbatim; junk and absence resolve to DEFAULT', async () => {
  for (const [stored, want] of [[3000, 3000], [20_000, 20_000], [200_000, 200_000], [500, 500], ['2500', 2500],
    [undefined, 2000], [null, 2000], ['abc', 2000], [0, 2000], [-5, 2000], [true, 2000], [[1500], 2000], [{}, 2000]]) {
    __resetDailyCeilingCache();
    assert.equal(await hydrateDailyCeiling(async () => stored), want, JSON.stringify(stored) ?? String(stored));
  }
  __resetDailyCeilingCache();
});

test('a config read that throws KEEPS the ceiling — a blip must not silently cut the budget', async () => {
  __resetDailyCeilingCache();
  await hydrateDailyCeiling(async () => 3000);
  assert.equal(effectiveDailyCeiling(), 3000);
  // Firestore hiccups on the next resolve. Falling back to the default here would drop Chad
  // from 3,000 to 2,000 mid-day — the exact failure this whole change exists to end.
  const after = await hydrateDailyCeiling(async () => { throw new Error('firestore 503'); }, { force: true });
  assert.equal(after, 3000, 'the last known good ceiling survives the error');
  __resetDailyCeilingCache();
});

test('hydration re-reads at most once per TTL, and a save takes effect on the next window', async () => {
  __resetDailyCeilingCache();
  let reads = 0;
  let stored = 3000;
  let t = 1_000_000;
  const load = async () => { reads++; return stored; };
  const now = () => t;

  assert.equal(await hydrateDailyCeiling(load, { now }), 3000);
  assert.equal(reads, 1, 'a cold process reads once');
  await hydrateDailyCeiling(load, { now });
  await hydrateDailyCeiling(load, { now });
  assert.equal(reads, 1, 'and not again inside the window — one read per minute, not per call');

  stored = 1200; // Chad lowers it in Diagnostics
  t += CEILING_TTL_MS;
  assert.equal(await hydrateDailyCeiling(load, { now }), 1200, 'the new setting lands within the minute');
  assert.equal(reads, 2);
  __resetDailyCeilingCache();
});

test('setDailyCeilingOverride counts as a fresh load — the scanner pays for no extra read', async () => {
  __resetDailyCeilingCache();
  let reads = 0;
  setDailyCeilingOverride(3000); // refresh-stops-core, which already read scan_config itself
  assert.equal(await hydrateDailyCeiling(async () => { reads++; return 3000; }), 3000);
  assert.equal(reads, 0, 'the hydrator does not re-read a document the caller just read');
  __resetDailyCeilingCache();
});

test('raising the ceiling RELEASES a breaker that tripped at the old number', () => {
  // The trip is a latch in Firestore and circuitFromDoc only expires it at ET midnight. A
  // board halted at 2,000 would otherwise have stayed halted all day against a 3,000 ceiling,
  // for a reason that no longer existed — the setting would appear to do nothing until
  // tomorrow, which from the dispatcher's chair is indistinguishable from not working at all.
  assert.equal(circuitStillBinding(true, 2000, 3000), false, 'count 2,000 under a 3,000 ceiling: released');
  assert.equal(circuitStillBinding(true, 2999, 3000), false);
  assert.equal(circuitStillBinding(true, 3000, 3000), true, 'at the ceiling it still binds');
  assert.equal(circuitStillBinding(true, 3400, 3000), true, 'over it, plainly');
  // Lowering it does the opposite, and must: a trip at 2,000 against a ceiling since dropped
  // to 1,000 is MORE binding, not less.
  assert.equal(circuitStillBinding(true, 2000, 1000), true);
  assert.equal(circuitStillBinding(false, 9999, 100), false, 'a closed breaker is closed');
});

test('an unreadable count or ceiling leaves the breaker OPEN — the mistakes are not symmetrical', () => {
  // Releasing on a Firestore blip means uncapped spend against the vendor; staying halted
  // means a late board and a phone call. Only one of those is recoverable in the afternoon.
  for (const bad of [NaN, Infinity, undefined, null]) {
    assert.equal(circuitStillBinding(true, bad, 3000), true, `count=${String(bad)}`);
    assert.equal(circuitStillBinding(true, 10, bad), true, `ceiling=${String(bad)}`);
  }
  assert.equal(circuitStillBinding(true, 10, 0), true, 'a zero ceiling is not "no limit"');
  assert.equal(circuitStillBinding(true, 10, -1), true);
});

test('END TO END: the requester trips at the SAVED ceiling, not the ambient default', async () => {
  __resetDailyCeilingCache();
  // A requester built exactly as a non-scanner entrypoint builds one: dailyCeiling comes from
  // DEFAULT_CONFIG (the 2,000 ambient default) and nothing calls the setter. With the stored
  // config wired in, the 2,001st call must go through and the breaker must not trip.
  let dayTotal = 1_998;
  let tripped = null;
  const r = createNuvizzRequester({
    fetchImpl: async () => new Response('{}', { status: 200 }),
    recordCall: async (_m, n) => { dayTotal += n; return dayTotal; },
    isCircuitOpen: async () => tripped != null,
    tripCircuit: async (reason) => { tripped = reason; },
    readConfiguredCeiling: async () => 3000,
    log: () => {},
    sleep: async () => {},
  }, { dailyCeiling: DEFAULT_DAILY_CEILING, breakerMode: 'enforce' });

  await r.request('https://nuvizz.test/a', {}, META);   // 1,999
  await r.request('https://nuvizz.test/b', {}, META);   // 2,000 — where he was stopped
  assert.equal(tripped, null, 'the old code tripped here, on a ceiling he had raised');
  await r.request('https://nuvizz.test/c', {}, META);   // 2,001
  assert.equal(dayTotal, 2_001);
  assert.equal(tripped, null);
  assert.equal(r.getStats().ceiling, 3000, 'and it reports the number it is enforcing');

  // It is still a cap: it trips at the saved number.
  dayTotal = 2_998;
  await r.request('https://nuvizz.test/d', {}, META);   // 2,999
  assert.equal(tripped, null);
  await r.request('https://nuvizz.test/e', {}, META);   // 3,000
  assert.match(String(tripped), /3000/, 'the breaker trips at the saved ceiling');
  __resetDailyCeilingCache();
});

test('with no stored setting the requester still enforces 2,000 — nothing moves on its own', async () => {
  __resetDailyCeilingCache();
  let dayTotal = 1_998;
  let tripped = null;
  const r = createNuvizzRequester({
    fetchImpl: async () => new Response('{}', { status: 200 }),
    recordCall: async (_m, n) => { dayTotal += n; return dayTotal; },
    isCircuitOpen: async () => tripped != null,
    tripCircuit: async (reason) => { tripped = reason; },
    readConfiguredCeiling: async () => undefined, // nobody has decided
    log: () => {},
    sleep: async () => {},
  }, { dailyCeiling: DEFAULT_DAILY_CEILING, breakerMode: 'enforce' });

  await r.request('https://nuvizz.test/a', {}, META);   // 1,999
  assert.equal(tripped, null);
  await r.request('https://nuvizz.test/b', {}, META);   // 2,000
  assert.match(String(tripped), /2000/, 'the default is untouched by this change');
  __resetDailyCeilingCache();
});

test('a Firestore outage does not become one extra failing read per NuVizz call', async () => {
  __resetDailyCeilingCache();
  let t = 1_000_000;
  const now = () => t;
  let reads = 0;
  await hydrateDailyCeiling(async () => { reads++; return 3000; }, { now });
  assert.equal(reads, 1);

  // Firestore goes down. The first attempt after the TTL fails; the ceiling survives, and the
  // retries are spaced — an unstamped failure re-asked on EVERY request, which is the worst
  // moment to add load and the one where the last known good value matters most.
  t += CEILING_TTL_MS;
  const down = async () => { reads++; throw new Error('firestore 503'); };
  assert.equal(await hydrateDailyCeiling(down, { now }), 3000);
  assert.equal(reads, 2, 'it tried');
  await hydrateDailyCeiling(down, { now });
  await hydrateDailyCeiling(down, { now });
  assert.equal(reads, 2, 'and did not try again on the very next call');
  assert.equal(effectiveDailyCeiling(), 3000, 'still enforcing what he saved');

  // But it does retry, sooner than a healthy refresh would — and recovers.
  t += CEILING_RETRY_MS;
  assert.ok(CEILING_RETRY_MS < CEILING_TTL_MS, 'a failure is retried sooner than a good value is refreshed');
  assert.equal(await hydrateDailyCeiling(async () => { reads++; return 3000; }, { now }), 3000);
  assert.equal(reads, 3, 'it retried after the shorter window');
  __resetDailyCeilingCache();
});
