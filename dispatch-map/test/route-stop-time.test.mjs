// test/route-stop-time.test.mjs
//
// WHOSE CLOCK THE ROUTE CARD SHOWS.
//
// Chad, on a 12-stop BRIAN route where every row read "appt 8:00 AM": "i think the route
// should show our eta's instead of the appt time as that is not really helpful here."
//
// Twelve independent consignees do not book the same slot. That clock is the saved search's
// generic per-LOAD window, and printing it twelve times tells a dispatcher nothing about
// when any truck arrives anywhere — which is the only question the card is there to answer.
//
// PURE — no React, no network, no NuVizz.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeStopTime, loadDefaultWindow, routeStopEta } from '../src/lib/route-stop-line.js';
import { computeBoardFlags } from '../src/lib/board-flags.js';

const WIN = '2026-08-20T08:00';
const load = (n, over = {}) => Array.from({ length: n }, (_, i) => ({
  stopNbr: `S${i}`, businessName: `CUST ${i}`, scheduledFrom: WIN, ...over,
}));

// ── THE SHARED WINDOW IS NOT AN APPOINTMENT ─────────────────────────────────

test("THE BUG: a load-wide window is detected, not printed twelve times", () => {
  assert.equal(loadDefaultWindow(load(12)), WIN);
  for (const s of load(12)) {
    assert.equal(routeStopTime(s, { defaultWindowTs: WIN }), null,
      'the shared window must print NOTHING rather than a fake appointment');
  }
});

test('a genuine per-stop appointment still shows, and is still labelled', () => {
  const stops = load(12);
  stops[3] = { ...stops[3], scheduledFrom: '2026-08-20T14:30' };   // one real booking
  const dflt = loadDefaultWindow(stops);
  assert.equal(dflt, WIN, 'the majority window is still the default');
  const line = routeStopTime(stops[3], { defaultWindowTs: dflt });
  assert.equal(line.source, 'appt');
  assert.equal(line.label, 'appt', 'a schedule read as an arrival is the original bug');
  assert.match(line.title, /not an arrival estimate/i);
});

test('a small or varied route has no default — nothing is suppressed', () => {
  assert.equal(loadDefaultWindow(load(2)), null, 'two stops cannot establish a default');
  const varied = load(12).map((s, i) => ({ ...s, scheduledFrom: `2026-08-20T${String(8 + i).padStart(2, '0')}:00` }));
  assert.equal(loadDefaultWindow(varied), null, 'twelve different windows are twelve appointments');
  assert.equal(loadDefaultWindow([]), null);
  assert.equal(loadDefaultWindow(null), null);
});

test('stops with no window at all never invent a default', () => {
  assert.equal(loadDefaultWindow(load(12, { scheduledFrom: null })), null);
});

// ── PRECEDENCE ──────────────────────────────────────────────────────────────

const ours = { etaMin: 642, errorMin: 25, anchored: true };
const withVendor = (s) => ({ ...s, raw: { stopExecutionInfo: { to: { plannedEtaDTTM: '2026-08-20T11:05' } } } });

test('OUR ETA outranks NuVizz\'s own — measured, not assumed', () => {
  // eta-backtest: NuVizz's per-stop ETA exists on ~0.7% of stops and lands a median 79 min
  // off; the anchored walk lands 13-14 min off. Ours leads where both exist.
  const line = routeStopTime(withVendor(load(1)[0]), { ours, defaultWindowTs: WIN });
  assert.equal(line.source, 'ours');
  assert.equal(line.etaMin, 642);
});

test("NuVizz's ETA is the fallback, not discarded, when we cannot compute one", () => {
  const line = routeStopTime(withVendor(load(1)[0]), { ours: null, defaultWindowTs: WIN });
  assert.equal(line.source, 'vendor');
  assert.equal(line.label, 'ETA');
});

test('a delivered stop shows what actually happened, never a prediction', () => {
  const s = { ...load(1)[0], deliveredDTTM: '2026-08-20T10:12' };
  const line = routeStopTime(s, { kind: 'DELIVERED', ours, defaultWindowTs: WIN });
  assert.equal(line.source, 'actual');
  assert.equal(line.ts, '2026-08-20T10:12');
  const arr = routeStopTime({ ...load(1)[0], arrivalDTTM: '2026-08-20T10:02' }, { kind: 'ARRIVED', ours });
  assert.equal(arr.source, 'actual');
  assert.equal(arr.ts, '2026-08-20T10:02');
});

test('an unanchored estimate says so — the tooltip is the honesty', () => {
  const cold = routeStopTime(load(1)[0], { ours: { ...ours, anchored: false } });
  assert.match(cold.title, /no stop on this route has reported in/i);
  const warm = routeStopTime(load(1)[0], { ours });
  assert.match(warm.title, /last real arrival stamp/i);
});

test('nothing to say prints nothing — a placeholder clock is the whole complaint', () => {
  assert.equal(routeStopTime({ stopNbr: 'X' }, {}), null);
  assert.equal(routeStopTime(null, {}), null);
});

// ── THE ETA COMES FROM THE FLAG ENGINE'S OWN WALK ───────────────────────────

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const routeStops = () => [
  { stopNbr: '1', matchKey: 'c1', businessName: 'NEAR', loadNbr: 'T', routeSeq: 1, stopType: 'DL',
    lat: 34.10, lng: -84.00, normalizedStatus: 'PLANNED', status: '10', driverName: 'D', driverUserName: 'd' },
  { stopNbr: '2', matchKey: 'c2', businessName: 'FAR', loadNbr: 'T', routeSeq: 2, stopType: 'DL',
    lat: 33.60, lng: -84.60, normalizedStatus: 'PLANNED', status: '10', driverName: 'D', driverUserName: 'd' },
];

test('THE POINT: the card reads the SAME walk the flags are judged on', () => {
  const out = computeBoardFlags({
    stops: routeStops(), notes: new Map(), servedDate: '2026-08-10', dayKey: 'mon',
    rosterRows: [], opts: { depot: DEPOT, departMin: 8 * 60 },
  });
  const a = out.etaByStop.get('1');
  const b = out.etaByStop.get('2');
  assert.ok(a && b, 'every walked stop carries a predicted arrival');
  assert.ok(b.etaMin > a.etaMin, 'the second stop arrives after the first');
  assert.ok(a.etaMin >= 8 * 60, 'and not before the truck leaves');
  assert.equal(a.routeKey, 'T');
  assert.ok(Number.isFinite(a.errorMin) && a.errorMin > 0, 'the estimate carries its own error band');
  assert.equal(a.anchored, false, 'nothing has reported in on this board');
});

test('every row of one multi-order visit shares that visit\'s arrival', () => {
  // A customer with three orders is ONE physical arrival on three board rows. The walk
  // prices it once; without sharing, two of the three rows would show no ETA at all.
  const stops = [
    ...routeStops(),
    { stopNbr: '2b', matchKey: 'c2', businessName: 'FAR', loadNbr: 'T', routeSeq: 2, stopType: 'DL',
      lat: 33.60, lng: -84.60, normalizedStatus: 'PLANNED', status: '10', driverName: 'D', driverUserName: 'd' },
  ];
  const out = computeBoardFlags({
    stops, notes: new Map(), servedDate: '2026-08-10', dayKey: 'mon',
    rosterRows: [], opts: { depot: DEPOT, departMin: 8 * 60 },
  });
  assert.ok(out.etaByStop.has('2b'), 'the duplicate row must not be left blank');
  assert.equal(out.etaByStop.get('2b').etaMin, out.etaByStop.get('2').etaMin,
    'one visit, one arrival — the rows cannot disagree');
});

test('a route the engine refuses to judge yields no ETA rather than a guess', () => {
  // No sequence => an invented order would produce confident wrong answers, and that
  // refusal must reach the card too: blank, not a fabricated clock.
  const noSeq = routeStops().map((s) => ({ ...s, routeSeq: null }));
  const out = computeBoardFlags({
    stops: noSeq, notes: new Map(), servedDate: '2026-08-10', dayKey: 'mon',
    rosterRows: [], opts: { depot: DEPOT, departMin: 8 * 60 },
  });
  assert.equal(out.etaByStop.size, 0);
  assert.equal(routeStopTime(noSeq[0], { ours: out.etaByStop.get('1') || null }), null);
});

// ── THE OLD READER IS UNCHANGED FOR ITS OTHER CALLER ────────────────────────

test('routeStopEta still behaves as the stop sidebar expects', () => {
  assert.equal(routeStopEta(withVendor({})).label, 'ETA');
  assert.equal(routeStopEta({ scheduledFrom: WIN }).label, 'appt');
  assert.equal(routeStopEta({}), null);
});
