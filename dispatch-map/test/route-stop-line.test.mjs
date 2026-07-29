// test/route-stop-line.test.mjs — what a route-detail stop card says about a stop.
// Imports the SAME functions App.jsx ships (no copy), so these prove the real behaviour.
//
// Regression origin (Chad, Jul 29, a six-stop TRAILER 7): every row read "8:00 AM" — one clock
// six times — and no row said how many skids or loose pieces were on the stop.
import test from 'node:test';
import assert from 'node:assert/strict';

import { routeStopEta, routeStopFreight } from '../src/lib/route-stop-line.js';

// A stop as the LIST scan files it: nuvizz-list sets plannedEtaDTTM AND scheduledFrom to the
// same Estimated Arrival, and there is no stopExecutionInfo until enrichment runs.
const listStop = (over = {}) => ({
  stopNbr: '007153373', businessName: 'APRIA HEALTHCARE LLC',
  plannedEtaDTTM: '2026-07-29T08:00:00', scheduledFrom: '2026-07-29T08:00:00',
  cartons: 3, volume: 2, pallets: 5, ...over,
});
// The same stop after /stop/info: plannedEtaDTTM is DERIVED from exec, and raw carries exec.
const enrichedStop = (eta = '2026-07-29T14:35:00', over = {}) => ({
  ...listStop(), enriched: true, scheduledFrom: '2026-07-29T08:00:00',
  plannedEtaDTTM: eta, raw: { stopExecutionInfo: { to: { plannedEtaDTTM: eta } } }, ...over,
});

// ── the time ────────────────────────────────────────────────────────────────

test('a real NuVizz ETA is reported as an ETA', () => {
  assert.deepEqual(routeStopEta(enrichedStop()), { ts: '2026-07-29T14:35:00', label: 'ETA' });
});

test('TRAILER 7: the list feed carries no ETA, so its window is NEVER labelled one', () => {
  // This is the whole bug — six stops sharing 08:00 because the saved search's Estimated
  // Arrival was rendered as though NuVizz had predicted an arrival for each of them.
  const stops = ['007153373', '007153374', '007153375'].map((n) => listStop({ stopNbr: n }));
  for (const s of stops) {
    const t = routeStopEta(s);
    assert.equal(t.label, 'appt', 'a shared window must not read as an ETA');
    assert.equal(t.ts, '2026-07-29T08:00:00');
  }
});

test('exec WINS over a top-level plannedEtaDTTM the list left behind', () => {
  // mergeEnrich carries plannedEtaDTTM forward as a non-live field, so a stop can hold the
  // list's window at the top level while exec holds the true ETA. The ETA has to win.
  const s = enrichedStop('2026-07-29T14:35:00', { plannedEtaDTTM: '2026-07-29T08:00:00' });
  assert.deepEqual(routeStopEta(s), { ts: '2026-07-29T14:35:00', label: 'ETA' });
});

test('a pickup-side ETA counts — mirrors nuvizz-scan\'s own derivation', () => {
  const s = { raw: { stopExecutionInfo: { from: { plannedEtaDTTM: '2026-07-29T09:15:00' } } } };
  assert.deepEqual(routeStopEta(s), { ts: '2026-07-29T09:15:00', label: 'ETA' });
});

test('an enriched stop with NO ETA yet falls back to its delivery window, labelled', () => {
  // Un-dispatched loads have no plannedEtaDTTM at all. The appointment still shows — the
  // dispatcher needs it — but it says what it is.
  const s = { scheduledFrom: '2026-07-30T12:00:00', raw: { stopExecutionInfo: { to: {} } } };
  assert.deepEqual(routeStopEta(s), { ts: '2026-07-30T12:00:00', label: 'appt' });
});

test('plannedEtaDTTM is the last resort when the row has no window either', () => {
  assert.deepEqual(routeStopEta({ plannedEtaDTTM: '2026-07-29T08:00:00' }), { ts: '2026-07-29T08:00:00', label: 'appt' });
});

test('no time from NuVizz prints NO time — never a placeholder clock', () => {
  assert.equal(routeStopEta({ stopNbr: '007153373' }), null);
  assert.equal(routeStopEta({ raw: { stopExecutionInfo: {} }, scheduledFrom: null }), null);
  assert.equal(routeStopEta(null), null);
  assert.equal(routeStopEta({ scheduledFrom: '' }), null);
});

test('a date change moves the window but NOT the Estimated Arrival — still not an ETA', () => {
  // After setStopDate + shiftBoardStopWindow the row's window is on the new day while
  // plannedEtaDTTM (Estimated Arrival) stays on the old one. Reading exec-only means the
  // card can't start calling that mismatch an ETA.
  const s = listStop({ scheduledFrom: '2026-07-30T08:00:00', plannedEtaDTTM: '2026-07-29T08:00:00' });
  assert.deepEqual(routeStopEta(s), { ts: '2026-07-30T08:00:00', label: 'appt' });
});

// ── the freight ─────────────────────────────────────────────────────────────

test('skids and loose, under the names NuVizz hides them behind', () => {
  // cartons = SKIDS, volume = LOOSE, pallets = TOTAL pieces (nuvizz-scan).
  const f = routeStopFreight(listStop());
  assert.equal(f.skids, 3);
  assert.equal(f.loose, 2);
  assert.equal(f.text, '3 sk · 2 loose');
});

test('zero loose drops the word rather than printing "0 loose"', () => {
  assert.equal(routeStopFreight(listStop({ volume: 0 })).text, '3 sk');
  assert.equal(routeStopFreight(listStop({ cartons: 0 })).text, '2 loose');
});

test('no freight numbers at all says NOTHING — an un-enriched row is unknown, not empty', () => {
  assert.equal(routeStopFreight({ stopNbr: '007153373' }).text, '');
  assert.equal(routeStopFreight({ cartons: null, volume: null, pallets: null }).text, '');
  assert.equal(routeStopFreight(null).text, '');
});

test('a stop with only a piece count still shows something', () => {
  assert.equal(routeStopFreight({ cartons: 0, volume: 0, pallets: 6 }).text, '6 pcs');
});

test('junk and negatives never reach the card', () => {
  assert.equal(routeStopFreight({ cartons: 'four', volume: -2, pallets: NaN }).text, '');
  assert.equal(routeStopFreight({ cartons: '3', volume: '2.4' }).text, '3 sk · 2 loose');
});
