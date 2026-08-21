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

// ── The HARD daily ceiling (Jul 29) ─────────────────────────────────────────
//
// Chad: "Also need to set the max calls to 2000 and that needs to be enforced." The site was
// running at 20,000 (an env var), the Diagnostics editor could reach 200,000, and the breaker
// defaulted to MONITOR — count and warn, never block. Three separate ways the spend cap could
// be higher than intended, or not a cap at all.
import { clampCeiling, HARD_DAILY_CEILING, effectiveDailyCeiling, reportedDailyCeiling, setDailyCeilingOverride, BREAKER_MODE } from '../netlify/functions/lib/nuvizz-request.mts';

test('the hard cap is 2,000 and nothing may raise it', () => {
  assert.equal(HARD_DAILY_CEILING, 2000);
  assert.equal(clampCeiling(20_000), 2000, 'the 20,000 the site was running');
  assert.equal(clampCeiling(200_000), 2000, 'the old editable maximum');
  assert.equal(clampCeiling(2001), 2000);
});

test('a LOWER ceiling is honoured — the cap is a maximum, not a target', () => {
  assert.equal(clampCeiling(500), 500);
  assert.equal(clampCeiling(1), 1);
});

test('junk clamps to the cap rather than to zero — never a self-disabling breaker', () => {
  // A ceiling of 0/NaN would compare `total >= 0` true on the first call and trip instantly,
  // or (worse, read the other way) be treated as "no limit". Both are wrong; the cap is safe.
  for (const junk of [0, -5, NaN, Infinity, null, undefined, '', 'lots', {}]) {
    assert.equal(clampCeiling(junk), 2000, String(junk));
  }
});

test('effectiveDailyCeiling clamps the override AND the caller fallback', () => {
  setDailyCeilingOverride(50_000);
  assert.equal(effectiveDailyCeiling(), 2000, 'a runtime override cannot lift the cap');
  setDailyCeilingOverride(750);
  assert.equal(effectiveDailyCeiling(), 750);
  setDailyCeilingOverride(null);
  assert.equal(effectiveDailyCeiling(99_999), 2000, 'nor can a caller-supplied fallback');
});

test('ENFORCE is the default — a missing env var can no longer disarm the cap', () => {
  // Previously: anything other than the exact string 'enforce' meant monitor (never blocks).
  assert.equal(BREAKER_MODE, 'enforce');
});

test('the breaker BLOCKS at the clamped ceiling, not at the requested one', async () => {
  // Built asking for 20,000; the requester must still stop at 2,000.
  let calls = 0;
  const deps = {
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
    recordCall: async () => calls,
    readCircuit: async () => ({ open: false }),
    tripCircuit: async () => {},
    now: () => Date.now(),
    sleep: async () => {},
  };
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

test('a stored Diagnostics ceiling is clamped too — readScanConfig returns the raw document', () => {
  // The editor bounds dailyCeiling to 2,000 on WRITE, but a value saved before that bound
  // existed comes back unclamped, and would print just as dishonestly as the env one.
  assert.equal(reportedDailyCeiling(20000, {}), 2000);
  assert.equal(reportedDailyCeiling(200000, {}), 2000);
  assert.equal(reportedDailyCeiling(2001, {}), 2000);
});

test('a genuinely lower ceiling is reported as set — the clamp only ever lowers', () => {
  assert.equal(reportedDailyCeiling(500, { NUVIZZ_DAILY_CEILING: '20000' }), 500);
  assert.equal(reportedDailyCeiling(undefined, { NUVIZZ_DAILY_CEILING: '900' }), 900);
  assert.equal(reportedDailyCeiling(1200, {}), 1200);
});

test('no config and no env is the hard cap, not the 12,000 that appeared nowhere else', () => {
  // The old expression fell back to a literal 12,000 that matched no other number in the
  // system — neither the hard cap, nor the env, nor the editor bound.
  assert.equal(reportedDailyCeiling(undefined, {}), HARD_DAILY_CEILING);
  assert.equal(reportedDailyCeiling(undefined, {}), 2000);
  assert.notEqual(reportedDailyCeiling(undefined, {}), 12000);
});

test('junk in the config or the env falls back rather than printing junk', () => {
  // true coerces to 1 and [1500] coerces to 1500, so a bare Number() here would have the
  // gauge reporting a ceiling of ONE call, or trusting an array. Both must fall through.
  for (const junk of [0, -1, NaN, 'abc', '', {}, [], [1500], true, false, null, undefined]) {
    assert.equal(reportedDailyCeiling(junk, { NUVIZZ_DAILY_CEILING: '1500' }), 1500, JSON.stringify(junk) ?? String(junk));
  }
  assert.equal(reportedDailyCeiling(true, {}), HARD_DAILY_CEILING, 'true is not a ceiling of 1');
  assert.equal(reportedDailyCeiling(undefined, { NUVIZZ_DAILY_CEILING: 'abc' }), 2000);
  assert.equal(reportedDailyCeiling(undefined, null), 2000);
  assert.equal(reportedDailyCeiling(), clampCeiling(Number(process.env.NUVIZZ_DAILY_CEILING) || 2000));
});

test('the reported ceiling never exceeds what effectiveDailyCeiling enforces', () => {
  // The property that matters, stated directly: the gauge and the breaker read one number.
  setDailyCeilingOverride(null);
  for (const proposal of [1, 500, 1999, 2000, 2001, 20000, 200000]) {
    assert.ok(reportedDailyCeiling(proposal, {}) <= HARD_DAILY_CEILING, String(proposal));
    assert.equal(reportedDailyCeiling(proposal, {}), effectiveDailyCeiling(proposal));
  }
});
