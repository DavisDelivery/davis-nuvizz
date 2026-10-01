// test/att-fill.test.mjs — v1.104.0: the nightly fill for attempts still without a driver.
//
// Chad, 2026-10-01: "you better triple check there is no way it could make more than 10 calls and if
// it needs more it should throw a flag in the ui on the scorecard." Every way a run could spend an
// eleventh request is pinned here — the plan, the loop, the cap setting, the claim, the schedule
// window, and the requester's own retries — against the real code, with NuVizz faked and counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FILL_MAX_CALLS, fillMaxCalls, attFillEnabled, fillDecision, fillPlan, fillSummary } from '../netlify/functions/lib/att-fill.mts';
import { runAttFill } from '../netlify/functions/lib/att-fill-run.mts';
import { createNuvizzRequester, __resetDailyCeilingCache } from '../netlify/functions/lib/nuvizz-request.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── the cap setting ──────────────────────────────────────────────────────────
test('the cap is 10 and the setting can only LOWER it — higher, zero, negative or junk all leave 10', () => {
  assert.equal(FILL_MAX_CALLS, 10);
  assert.equal(fillMaxCalls({}), 10);
  assert.equal(fillMaxCalls({ NUVIZZ_ATT_TIMELINE_FILL_MAX: '3' }), 3);
  for (const v of ['10', '11', '50', '1000', '0', '-5', '2.5', 'abc', '', ' ']) {
    assert.equal(fillMaxCalls({ NUVIZZ_ATT_TIMELINE_FILL_MAX: v }), 10, `"${v}"`);
  }
});

test('NUVIZZ_ATT_TIMELINE_FILL: on by default, off-words turn it off, a typo leaves it ON', () => {
  assert.equal(attFillEnabled({}), true);
  for (const off of ['off', 'OFF', '0', 'false', 'no']) assert.equal(attFillEnabled({ NUVIZZ_ATT_TIMELINE_FILL: off }), false, off);
  for (const on of ['on', 'ofg', '1']) assert.equal(attFillEnabled({ NUVIZZ_ATT_TIMELINE_FILL: on }), true, on);
});

// ── the schedule window ──────────────────────────────────────────────────────
test('it acts only between midnight and 2 AM ET, on ET-yesterday — both DST seasons', () => {
  // EDT: 04:30 UTC = 00:30 ET (acts), 05:30 UTC = 01:30 ET (in window; the claim stops it spending).
  assert.deepEqual([fillDecision(new Date('2026-10-02T04:30:00Z')).act, fillDecision(new Date('2026-10-02T04:30:00Z')).date], [true, '2026-10-01']);
  assert.equal(fillDecision(new Date('2026-10-02T05:30:00Z')).act, true);
  // EST: 04:30 UTC = 23:30 ET the day before (does not act), 05:30 UTC = 00:30 ET (acts).
  assert.equal(fillDecision(new Date('2026-12-02T04:30:00Z')).act, false);
  assert.deepEqual([fillDecision(new Date('2026-12-02T05:30:00Z')).act, fillDecision(new Date('2026-12-02T05:30:00Z')).date], [true, '2026-12-01']);
  // The middle of the day never acts.
  assert.equal(fillDecision(new Date('2026-10-01T16:00:00Z')).act, false);
});

// ── the plan ─────────────────────────────────────────────────────────────────
const nbrs = (n, from = 7180000) => Array.from({ length: n }, (_, i) => `00${from + i}`);

test('the plan never holds more than 10 lookups, whatever the day holds or the cap asks for', () => {
  const items = nbrs(25).map((stopNbr) => ({ stopNbr, matched: false }));
  const ids = new Map(items.map((it) => [it.stopNbr, `id-${it.stopNbr}`]));
  for (const cap of [10, 11, 50, 1000, Infinity]) {
    const p = fillPlan(items, ids, cap);
    assert.equal(p.lookups.length, 10, `cap ${cap}`);
    assert.equal(p.left.length, 15);
    assert.ok(p.left.every((l) => l.reason === 'over-cap'));
  }
  assert.equal(fillPlan(items, ids, 3).lookups.length, 3);
});

test('the plan reads only ORIGINAL stops with no driver and no earlier read; one with no stopId is left, not looked up', () => {
  const items = [
    { stopNbr: '007180001', matched: false },
    { stopNbr: '007180001-1', matched: false },            // a duplicate order: never read
    { stopNbr: '007180002', matched: true, originalDriverName: 'X' },
    { stopNbr: '007180003', matched: false, timelineCheckedAt: 't' },
    { stopNbr: '007180004', matched: false },              // no stopId on file
  ];
  const ids = new Map([['007180001', 'a'], ['007180004', null]]);
  const p = fillPlan(items, ids, 10);
  assert.deepEqual(p.lookups, [{ stopNbr: '007180001', stopId: 'a' }]);
  assert.deepEqual(p.left, [{ stopNbr: '007180004', reason: 'no-stopId' }]);
});

test('the summary flags whatever could not be read, and not a timeline that was read and named nobody', () => {
  const s = fillSummary({ date: 'd', at: 'a', maxCalls: 10, requests: 2, results: [{ stopNbr: '1', ok: true, driver: null }, { stopNbr: '2', ok: false }], left: [] });
  assert.equal(s.noDriverOnTimeline, 1);
  assert.equal(s.left, 1);
  assert.deepEqual(s.leftStops, [{ stopNbr: '2', reason: 'not-read' }]);
  assert.equal(s.needsAttention, true);
  const clean = fillSummary({ date: 'd', at: 'a', maxCalls: 10, requests: 1, results: [{ stopNbr: '1', ok: true, driver: null }], left: [] });
  assert.equal(clean.needsAttention, false);
});

// ── the real run loop, NuVizz faked and counted ──────────────────────────────
const IN_WINDOW = new Date('2026-10-02T04:30:00Z');   // 00:30 ET → acts on 2026-10-01
function fakeDeps({ candidates = 25, env = {}, claimed = new Set(), fetchOnce, events } = {}) {
  const log = { requests: 0, order: [], claims: 0, itemWrites: 0, manifest: null };
  const items = nbrs(candidates).map((stopNbr) => ({ stopNbr, matched: false }));
  return {
    log,
    deps: {
      env,
      ready: () => true,
      claim: async (date) => { log.order.push('claim'); if (claimed.has(date)) return false; claimed.add(date); log.claims++; return true; },
      listItems: async () => items,
      stopIdOnFile: async (_d, nbr) => `id-${nbr}`,
      fetchOnce: fetchOnce || (async () => { log.requests++; log.order.push('request'); return { ok: true, events: events || [] }; }),
      writeItem: async () => { log.itemWrites++; },
      writeClaim: async () => {},
      readManifest: async () => ({ counts: { attempts: candidates, matched: 0, unmatched: candidates } }),
      writeManifest: async (_d, m) => { log.manifest = m; },
    },
  };
}

test('25 attempts without a driver: exactly 10 requests, the other 15 flagged on the manifest', async () => {
  const f = fakeDeps({ candidates: 25 });
  const r = await runAttFill(IN_WINDOW, f.deps);
  assert.equal(f.log.requests, 10);
  assert.equal(r.requests, 10);
  assert.equal(r.left, 15);
  assert.equal(r.needsAttention, true);
  assert.equal(f.log.manifest.fill.left, 15, 'the scorecard reads this');
  assert.equal(f.log.manifest.fill.needsAttention, true);
});

test('the date is CLAIMED before the first request — and a second run for it spends nothing', async () => {
  const claimed = new Set();
  const first = fakeDeps({ candidates: 25, claimed });
  await runAttFill(IN_WINDOW, first.deps);
  assert.equal(first.log.order[0], 'claim', 'claim comes first');
  const second = fakeDeps({ candidates: 25, claimed });
  const r = await runAttFill(new Date('2026-10-02T05:30:00Z'), second.deps);  // the second cron fire
  assert.equal(r.acted, false);
  assert.equal(second.log.requests, 0);
});

test('every request failing still stops at 10 — failures are counted, never retried by the run', async () => {
  let sent = 0;
  const f = fakeDeps({ candidates: 25, fetchOnce: async () => { sent++; return { ok: false, reason: 'http_503' }; } });
  const r = await runAttFill(IN_WINDOW, f.deps);
  assert.equal(sent, 10);
  assert.equal(r.requests, 10);
  assert.equal(r.left, 25, '10 not read + 15 over the cap');
});

test('a cap setting of 50 still sends 10; a setting of 3 sends 3', async () => {
  const hi = fakeDeps({ candidates: 25, env: { NUVIZZ_ATT_TIMELINE_FILL_MAX: '50' } });
  await runAttFill(IN_WINDOW, hi.deps);
  assert.equal(hi.log.requests, 10);
  const lo = fakeDeps({ candidates: 25, env: { NUVIZZ_ATT_TIMELINE_FILL_MAX: '3' } });
  await runAttFill(IN_WINDOW, lo.deps);
  assert.equal(lo.log.requests, 3);
});

test('switched off, or outside the window: no claim and no request', async () => {
  const off = fakeDeps({ env: { NUVIZZ_ATT_TIMELINE_FILL: 'off' } });
  assert.equal((await runAttFill(IN_WINDOW, off.deps)).acted, false);
  assert.equal(off.log.requests + off.log.claims, 0);
  const noon = fakeDeps();
  assert.equal((await runAttFill(new Date('2026-10-01T16:00:00Z'), noon.deps)).acted, false);
  assert.equal(noon.log.requests + noon.log.claims, 0);
});

test('fewer than 10 to read: it reads them and stops — and a timeline naming the driver is written', async () => {
  const D = 'DAVIS DELIVERY';
  const events = [
    { dttm: '10/1/26 09:00 AM', name: 'Stop Dispatched', user: 'Chris Head', company: D },
    { dttm: '10/1/26 09:00 AM', name: 'Pickup Stop Confirmation', user: 'Chris Head', company: D },
  ];
  const f = fakeDeps({ candidates: 4, events });
  const r = await runAttFill(IN_WINDOW, f.deps);
  assert.equal(f.log.requests, 4);
  assert.equal(r.answered, 4);
  assert.equal(r.needsAttention, false);
  assert.equal(f.log.itemWrites, 4);
});

// ── the one request itself: no retry, no fallback, no /stop/info ─────────────
function harness({ fetchImpl, requestTimeoutMs = 30_000 }) {
  __resetDailyCeilingCache();
  return createNuvizzRequester({
    fetchImpl, recordCall: async () => 1, isCircuitOpen: async () => false, tripCircuit: async () => {},
    log: () => {}, now: () => 1_000_000, sleep: async () => {},
  }, { dailyCeiling: 100_000, breakerMode: 'enforce', requestTimeoutMs });
}
const META = { route: '/event/eventinfo', tenant: 'DAVIS' };

test('maxRetries 0 sends ONE fetch on a 503, a 429, a network error and a timeout (the default would retry)', async () => {
  for (const status of [503, 429]) {
    let sent = 0;
    const r = harness({ fetchImpl: async () => { sent++; return new Response('x', { status }); } });
    await r.request('https://nuvizz.example/e', { headers: {}, maxRetries: 0 }, META);
    assert.equal(sent, 1, `status ${status}`);
  }
  let sentNet = 0;
  const net = harness({ fetchImpl: async () => { sentNet++; throw new Error('ECONNRESET'); } });
  await assert.rejects(net.request('https://nuvizz.example/e', { headers: {}, maxRetries: 0 }, META));
  assert.equal(sentNet, 1, 'network error');
  let sentSlow = 0;
  const slow = harness({ requestTimeoutMs: 5, fetchImpl: (_u, init) => { sentSlow++; return new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))); } });
  await assert.rejects(slow.request('https://nuvizz.example/e', { headers: {}, maxRetries: 0 }, META));
  assert.equal(sentSlow, 1, 'timeout');
  // And the reason this matters: the requester's DEFAULT retries a 503.
  let sentDefault = 0;
  const dflt = harness({ fetchImpl: async () => { sentDefault++; return new Response('x', { status: 503 }); } });
  await dflt.request('https://nuvizz.example/e', { headers: {} }, META);
  assert.ok(sentDefault > 1, 'without maxRetries 0 one lookup would be several calls');
});

test('fetchStopEventsOnce is one /event/eventinfo request with maxRetries 0 — no /stop/info, no fallback', () => {
  const src = readFileSync(join(__dirname, '..', 'netlify', 'functions', 'lib', 'nuvizz-scan.mts'), 'utf8');
  const body = src.slice(src.indexOf('export async function fetchStopEventsOnce'), src.indexOf('/** A counter the unplanned descent'));
  assert.ok(body.length > 200, 'found the function');
  assert.match(body, /maxRetries: 0/);
  assert.equal((body.match(/\.request\(/g) || []).length, 1, 'exactly one request call');
  assert.doesNotMatch(body, /lookupStopByPro|\/stop\/eventinfo|\/stop\/info/);
});

test('the scheduled job is the ONLY way in: it reads no query string and passes no date', () => {
  const src = readFileSync(join(__dirname, '..', 'netlify', 'functions', 'nuvizz-att-fill-background.mts'), 'utf8');
  assert.doesNotMatch(src, /searchParams|req\.url|new URL\(/);
  assert.match(src, /runAttFill\(new Date\(\)\)/);
});
