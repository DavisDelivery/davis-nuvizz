// test/attempts.test.mjs — delivery-attempts feature: ATT marker detection, the
// DST-safe once-per-day schedule gate, and the pure plan/attempt record builders.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isAttemptShipment } from '../netlify/functions/lib/nuvizz-scan.mts';
import {
  attemptFireDecision, buildPlanRecord, buildAttemptItem,
} from '../netlify/functions/lib/attempts-core.mts';
import { recountManifest } from '../netlify/functions/lib/attempts-store.mts';
import { mergeDay } from '../src/lib/stop-lookup.js';

// ── ATT marker ────────────────────────────────────────────────────────────────
test('isAttemptShipment: ATT prefix (any case) marks an attempt; clean numbers do not', () => {
  assert.equal(isAttemptShipment('ATT007137828'), true);
  assert.equal(isAttemptShipment('att007138005'), true);   // lower-case observed in live data
  assert.equal(isAttemptShipment('  ATT007137745'), true);  // tolerate stray leading space
  assert.equal(isAttemptShipment('007137828'), false);      // normal shipment == stopNbr
  assert.equal(isAttemptShipment('AVRT-1234'), false);      // unrelated alpha prefix
  assert.equal(isAttemptShipment(''), false);
  assert.equal(isAttemptShipment(null), false);
  assert.equal(isAttemptShipment(undefined), false);
});

// ── schedule gate (DST-safe, once/day) ────────────────────────────────────────
// nowET reads America/New_York, so build UTC instants and let the gate convert.
const utc = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo, d, h, mi));
const PLAN = { startHour: 8, endHour: 12 };
const ATT = { startHour: 20, endHour: 24 };

test('plan gate: 8:30am ET fires once across the two UTC candidates (EDT, summer)', () => {
  // 2026-06-17 is EDT (UTC-4): 12:30 UTC = 8:30 ET (acts), 13:30 UTC = 9:30 ET (gated by already-done).
  const first = attemptFireDecision({ ...PLAN, now: utc(2026, 5, 17, 12, 30), alreadyDone: false });
  assert.equal(first.act, true);
  assert.equal(first.etHour, 8);
  const second = attemptFireDecision({ ...PLAN, now: utc(2026, 5, 17, 13, 30), alreadyDone: true });
  assert.equal(second.act, false, 'second candidate must not double-capture once the first succeeded');
});

test('plan gate: 8:30am ET fires once across the two UTC candidates (EST, winter)', () => {
  // 2026-01-15 is EST (UTC-5): 12:30 UTC = 7:30 ET (out of window), 13:30 UTC = 8:30 ET (acts).
  const first = attemptFireDecision({ ...PLAN, now: utc(2026, 0, 15, 12, 30), alreadyDone: false });
  assert.equal(first.act, false);
  assert.equal(first.etHour, 7);
  const second = attemptFireDecision({ ...PLAN, now: utc(2026, 0, 15, 13, 30), alreadyDone: false });
  assert.equal(second.act, true);
  assert.equal(second.etHour, 8);
});

test('plan gate: dropped first candidate is covered by the second (still not done)', () => {
  // Summer 13:30 UTC = 9:30 ET (hour 9, still in [8,12)); if 12:30 never ran, alreadyDone=false → act.
  const d = attemptFireDecision({ ...PLAN, now: utc(2026, 5, 17, 13, 30), alreadyDone: false });
  assert.equal(d.act, true);
  assert.equal(d.etHour, 9);
});

test('attempt gate: 8pm ET fires once across the two UTC candidates (EDT + EST)', () => {
  // Summer: 00:00 UTC on 6/18 = 20:00 ET on 6/17 (acts); 01:00 UTC = 21:00 ET (already-done).
  assert.equal(attemptFireDecision({ ...ATT, now: utc(2026, 5, 18, 0, 0), alreadyDone: false }).act, true);
  assert.equal(attemptFireDecision({ ...ATT, now: utc(2026, 5, 18, 0, 0), alreadyDone: false }).etHour, 20);
  assert.equal(attemptFireDecision({ ...ATT, now: utc(2026, 5, 18, 1, 0), alreadyDone: true }).act, false);
  // Winter: 00:00 UTC on 1/16 = 19:00 ET (out of window); 01:00 UTC = 20:00 ET (acts).
  assert.equal(attemptFireDecision({ ...ATT, now: utc(2026, 0, 16, 0, 0), alreadyDone: false }).act, false);
  assert.equal(attemptFireDecision({ ...ATT, now: utc(2026, 0, 16, 1, 0), alreadyDone: false }).act, true);
});

test('gate: manual always acts; disabled never acts; already-done skips', () => {
  const noon = utc(2026, 5, 17, 16, 0); // 12:00 ET — outside both windows
  assert.equal(attemptFireDecision({ ...PLAN, now: noon, isManual: true }).act, true, 'manual bypasses the window');
  assert.equal(attemptFireDecision({ ...PLAN, now: utc(2026, 5, 17, 12, 30), enabled: false }).act, false, 'disabled never acts');
  assert.equal(attemptFireDecision({ ...PLAN, now: utc(2026, 5, 17, 12, 30), alreadyDone: true }).act, false, 'already-done skips');
});

// ── pure record builders ──────────────────────────────────────────────────────
const PLANNED_STOP = {
  stopNbr: '007137828', shipmentNbr: '007137828',
  isPlanned: true, driverUserName: 'TONY', driverName: 'Tony Smith',
  loadNbr: 'DAVIS000196999', routeName: 'TRAILER 1',
  businessName: 'CLAYTON CTY PUBLIC SCHLS', addr1: '218B STOCKBRIDGE RD',
  city: 'JONESBORO', state: 'GA', zip: '30236', status: '20', normalizedStatus: 'SCHEDULED',
};

test('buildPlanRecord: freezes who had the stop, keyed by clean stopNbr', () => {
  const r = buildPlanRecord(PLANNED_STOP, '2026-06-23', '2026-06-23T13:00:00Z');
  assert.equal(r.stopNbr, '007137828');
  assert.equal(r.driverUserName, 'TONY');
  assert.equal(r.driverName, 'Tony Smith');
  assert.equal(r.driverKey, 'TONY');                 // driverKeyFor uppercases the userName
  assert.equal(r.loadNbr, 'DAVIS000196999');
  assert.equal(r.routeName, 'TRAILER 1');
  assert.equal(r.date, '2026-06-23');
  assert.equal(r.shipmentNbr, '007137828');          // morning shipment == stopNbr (no ATT yet)
});

// v1.59.2 — the 8:30 freeze keeps WHERE on the route each stop was, not just which truck.
// v1.60.2 — and only that: no position means NO field (never null, never 0), and the loadId and
// plannedEtaDTTM 1.59.2 also froze are gone (null on every list row / possibly stale).
test('buildPlanRecord: the 8:30 freeze keeps the stop’s position on its route', () => {
  const r = buildPlanRecord({ ...PLANNED_STOP, routeSeq: 14 }, '2026-09-23', '2026-09-23T12:30:00Z');
  assert.equal(r.routeSeq, 14);
});

test('buildPlanRecord: a route read back in stop order is the order the dispatcher planned', () => {
  const route = [
    { ...PLANNED_STOP, stopNbr: 'C', routeSeq: 3 },
    { ...PLANNED_STOP, stopNbr: 'A', routeSeq: 1 },
    { ...PLANNED_STOP, stopNbr: 'B', routeSeq: '2' },   // a string Display Seq still orders as a number
  ].map((s) => buildPlanRecord(s, '2026-09-23', 'now'));
  const order = route.slice().sort((x, y) => x.routeSeq - y.routeSeq).map((x) => x.stopNbr);
  assert.deepEqual(order, ['A', 'B', 'C']);
});

test('buildPlanRecord: a stop with no position carries NO routeSeq field — not null, not 0', () => {
  // 0 would read as "first stop on the route" — a planned position the dispatcher never gave it —
  // and an explicit null is no better: the Stops lookup reads it with Number(), and Number(null) is 0.
  for (const routeSeq of [undefined, null, '', '   ', 'n/a']) {
    const r = buildPlanRecord({ ...PLANNED_STOP, routeSeq }, '2026-09-23', 'now');
    assert.equal('routeSeq' in r, false, `routeSeq ${JSON.stringify(routeSeq)} must freeze as no field`);
  }
});

test('buildPlanRecord: a real position of 0 is kept (a Display Seq of 0 is a value, not an absence)', () => {
  assert.equal(buildPlanRecord({ ...PLANNED_STOP, routeSeq: 0 }, '2026-09-23', 'now').routeSeq, 0);
});

test('buildPlanRecord: 1.59.2’s loadId and plannedEtaDTTM are no longer frozen', () => {
  const r = buildPlanRecord({ ...PLANNED_STOP, routeSeq: 5, loadId: 'y', plannedEtaDTTM: 'x' }, '2026-09-23', 'now');
  assert.equal('loadId' in r, false);
  assert.equal('plannedEtaDTTM' in r, false);
});

test('Stops lookup: a plan-only day whose stop had no position shows no "stop N" (the 1.59.2 "stop 0" regression)', () => {
  // The morning plan is the day's only copy (no sealed row, no board row). Before 1.59.2 the record
  // had no routeSeq and the day read seq null; 1.59.2 froze routeSeq: null and it read 0 ("· stop 0").
  const plan = buildPlanRecord({ ...PLANNED_STOP, routeSeq: null }, '2026-09-23', 'now');
  const day = mergeDay({ date: '2026-09-23', sealed: null, board: null, attempt: null, plan }, { today: '2026-09-24' });
  assert.equal(day.seq, null);
  const placed = buildPlanRecord({ ...PLANNED_STOP, routeSeq: 7 }, '2026-09-23', 'now');
  assert.equal(mergeDay({ date: '2026-09-23', sealed: null, board: null, attempt: null, plan: placed }, { today: '2026-09-24' }).seq, 7);
});

test('buildPlanRecord: the position field leaves every field the attempts join reads unchanged', () => {
  const before = buildPlanRecord(PLANNED_STOP, '2026-06-23', 'now');
  const after = buildPlanRecord({ ...PLANNED_STOP, routeSeq: 5 }, '2026-06-23', 'now');
  for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], `field ${k} changed`);
  assert.deepEqual(Object.keys(after).filter((k) => !(k in before)), ['routeSeq']);
  assert.deepEqual(
    buildAttemptItem(after, { shipmentNbr: 'ATT007137828' }, '2026-06-23', 'now'),
    buildAttemptItem(before, { shipmentNbr: 'ATT007137828' }, '2026-06-23', 'now'),
  );
});

test('buildAttemptItem: joins the ATT stop back to its morning driver', () => {
  const plan = buildPlanRecord(PLANNED_STOP, '2026-06-23', '2026-06-23T13:00:00Z');
  // Evening re-probe: same stopNbr, shipment now ATT-prefixed, unplanned.
  const current = { shipmentNbr: 'ATT007137828', normalizedStatus: 'UNPLANNED', isUnplanned: true };
  const item = buildAttemptItem(plan, current, '2026-06-23', '2026-06-23T20:05:00Z');
  assert.equal(item.stopNbr, '007137828');
  assert.equal(item.shipmentNbr, 'ATT007137828');
  assert.equal(item.originalDriverUserName, 'TONY');
  assert.equal(item.originalDriverName, 'Tony Smith');
  assert.equal(item.originalLoadNbr, 'DAVIS000196999');
  assert.equal(item.currentlyUnplanned, true);
  assert.equal(item.matched, true);
  assert.equal(item.businessName, 'CLAYTON CTY PUBLIC SCHLS');
});

test('buildAttemptItem: matched=false when the morning plan had no driver', () => {
  const planNoDriver = { stopNbr: '007140000', driverUserName: null, driverName: null };
  const item = buildAttemptItem(planNoDriver, { shipmentNbr: 'ATT007140000' }, '2026-06-23', 'now');
  assert.equal(item.matched, false);
  assert.equal(item.originalDriverName, null);
});

test('buildAttemptItem: attribution is the morning driver, not the current re-delivery driver', () => {
  const plan = buildPlanRecord(PLANNED_STOP, '2026-06-23', '2026-06-23T13:00:00Z'); // Tony Smith @ 8am
  // By evening the stop has been re-planned onto a DIFFERENT driver for re-delivery.
  const current = {
    stopNbr: '007137828', shipmentNbr: 'ATT007137828',
    driverName: 'Jean Delsoin', driverUserName: 'JEAN', isUnplanned: false, normalizedStatus: 'SCHEDULED',
  };
  const item = buildAttemptItem(plan, current, '2026-06-23', 'now');
  // ORIGINAL must be the 8am driver…
  assert.equal(item.originalDriverName, 'Tony Smith');
  assert.equal(item.originalDriverUserName, 'TONY');
  // …and the current re-delivery driver is surfaced only as info, never attribution.
  assert.equal(item.currentDriverName, 'Jean Delsoin');
  assert.equal(item.currentDriverUserName, 'JEAN');
});

// ── delete: manifest recount ──────────────────────────────────────────────────
test('recountManifest: recomputes attempts/matched/unmatched, preserves scan-only counts', () => {
  const prev = {
    date: '2026-06-23', ok: true,
    counts: { candidates: 680, probed: 680, unprobed: 0, attempts: 3, matched: 2, unmatched: 1 },
  };
  const survivors = [
    { stopNbr: '1', matched: true },
    { stopNbr: '2', matched: false },
  ]; // one matched row was deleted
  const next = recountManifest(prev, survivors);
  assert.equal(next.counts.attempts, 2);
  assert.equal(next.counts.matched, 1);
  assert.equal(next.counts.unmatched, 1);
  // scan-only fields the read can't re-derive are preserved
  assert.equal(next.counts.candidates, 680);
  assert.equal(next.counts.probed, 680);
  assert.equal(next.date, '2026-06-23');
});

test('recountManifest: empty survivors zeroes the attempt counts', () => {
  const next = recountManifest({ counts: { candidates: 5, attempts: 1, matched: 1, unmatched: 0 } }, []);
  assert.equal(next.counts.attempts, 0);
  assert.equal(next.counts.matched, 0);
  assert.equal(next.counts.unmatched, 0);
  assert.equal(next.counts.candidates, 5);
});
