// test/customer-notes-writer-hours-only.test.mjs — the write gate must not require equipment.
//
// The v0.54.57 headline bug: decideWrite early-returned whenever the scan produced no
// EQUIPMENT flag, silently discarding hours-only and closed-day-only detections. The
// receiving-hours scanner could match "HOURS 8AM-2PM" on every order for months and the
// customer_notes doc never learned it — which starved the Board Flags hours-risk check
// (and the closed-day check) of the very data they judge. These tests pin the gate open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWrite } from '../src/lib/customer-notes-writer.ts';

// CI runs with no npm install, so firebase/firestore does not resolve there — decideWrite
// takes its Firestore sentinel factories by injection (and the module's value imports are
// lazy) precisely so this file can load. Stubs stand in for serverTimestamp/deleteField.
const STAMPS = { serverTimestamp: () => ({ __serverTimestamp: true }), deleteField: () => ({ __deleteField: true }) };
const write = (stop, existing) => decideWrite(stop, existing, STAMPS);

const scannedStop = (over = {}) => ({
  matchKey: 'acme|1 main|buford|30518',
  pro: 'PRO123', businessName: 'ACME', addr1: '1 Main', city: 'Buford', state: 'GA', zip: '30518',
  scanResults: [],
  ...over,
});

const HOURS = {
  open: '08:00', close: '14:00',
  matchedSource: 'orderInstructions', matchedText: 'HOURS 8AM-2PM',
};

test('an hours-ONLY detection writes — no equipment flag required', () => {
  const d = write(scannedStop({ hoursResult: HOURS }), undefined);
  assert.ok(d, 'hours-only scan must produce a write decision');
  assert.deepEqual(d.payload.receiving_hours.mon, { open: '08:00', close: '14:00' });
  assert.deepEqual(d.payload.receiving_hours.sun, { open: '08:00', close: '14:00' });
  assert.equal(d.payload.auto_matches.receiving_hours[0].text, 'HOURS 8AM-2PM');
});

test('a closed-day-ONLY detection writes — no equipment flag required', () => {
  const d = write(scannedStop({
    closedDaysResult: [{ day: 'fri', matchedSource: 'orderInstructions', matchedText: 'CLOSED ON FRIDAYS' }],
  }), undefined);
  assert.ok(d, 'closed-day-only scan must produce a write decision');
  assert.deepEqual(d.payload.closed_days, ['fri']);
  assert.equal(d.payload.auto_matches.closed_days[0].pattern, 'closed_fri');
});

test('a dismissed equipment advisory must not drag co-occurring hours down with it', () => {
  // The dispatcher dismissed the straight-truck advisory for this customer; the order text
  // still carries hours. Dismissal silences the FLAG, never the hours payload.
  const d = write(
    scannedStop({
      scanResults: [{ flagValue: 'uline_straight_truck', matchedSource: 'orderInstructions', matchedText: 'STRAIGHT TRUCK ONLY', matchedPattern: 'st_only' }],
      hoursResult: HOURS,
    }),
    { auto_scan_dismissed: ['uline_straight_truck'] },
  );
  assert.ok(d, 'the hours payload must survive the equipment dismissal');
  assert.deepEqual(d.payload.receiving_hours.tue, { open: '08:00', close: '14:00' });
  assert.ok(!(d.payload.equipment_restrictions || []).includes('uline_straight_truck'), 'the dismissed flag itself stays out');
});

test('a locked hours field turns an hours-only detection into a no-op (no churn)', () => {
  // The dispatcher owns the field; rewriting only the audit trail on every scan would
  // mutate the doc (serverTimestamp) forever with nothing to show for it.
  assert.equal(write(scannedStop({ hoursResult: HOURS }), { manual_overrides: { receiving_hours: true } }), null);
});

test('a locked hours field still gets the audit trail when a write happens anyway', () => {
  const d = write(
    scannedStop({
      scanResults: [{ flagValue: 'uline_straight_truck', matchedSource: 'orderInstructions', matchedText: 'ST ONLY', matchedPattern: 'st_only' }],
      hoursResult: HOURS,
    }),
    { manual_overrides: { receiving_hours: true } },
  );
  assert.ok(d, 'the equipment flag drives the write');
  assert.equal(d.payload.receiving_hours, undefined, 'locked field must not be overwritten');
  assert.equal(d.payload.auto_matches.receiving_hours[0].text, 'HOURS 8AM-2PM', 'the disclosure trail rides along');
});

test('identical scanner-written hours are a no-op — the write is idempotent across scans', () => {
  const stored = {};
  for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) stored[d] = { open: '08:00', close: '14:00' };
  const d = write(
    scannedStop({ hoursResult: HOURS }),
    { receiving_hours: stored, auto_sources: { receiving_hours: ['orderInstructions'] } },
  );
  assert.equal(d, null, 'unchanged hours must not rewrite the doc on every scan pass');
});

test('legacy per-day hours the scanner cannot prove it wrote are never flattened', () => {
  // M2.x docs carry per-day strings with no auto_sources.receiving_hours fingerprint —
  // the very data board-flags now reads as real windows. A fresh scanner range must not
  // overwrite Saturday-differs-from-Monday data with one uniform 7-day copy.
  const legacy = { receiving_hours: { mon: '6AM-2PM', sat: '8-12' } };
  assert.equal(write(scannedStop({ hoursResult: HOURS }), legacy), null, 'hours-only: nothing writable');
  const d = write(
    scannedStop({
      scanResults: [{ flagValue: 'uline_straight_truck', matchedSource: 'orderInstructions', matchedText: 'ST ONLY', matchedPattern: 'st_only' }],
      hoursResult: HOURS,
    }),
    legacy,
  );
  assert.ok(d, 'the equipment flag still writes');
  assert.equal(d.payload.receiving_hours, undefined, 'legacy per-day hours must survive');
});

test('already-recorded closed days are a no-op; a NEW day still writes', () => {
  const existing = { closed_days: ['fri'] };
  assert.equal(write(scannedStop({
    closedDaysResult: [{ day: 'fri', matchedSource: 'orderInstructions', matchedText: 'CLOSED ON FRIDAYS' }],
  }), existing), null, 'no new information — no write');
  const d = write(scannedStop({
    closedDaysResult: [{ day: 'mon', matchedSource: 'orderInstructions', matchedText: 'CLOSED MONDAYS' }],
  }), existing);
  assert.ok(d);
  assert.deepEqual([...d.payload.closed_days].sort(), ['fri', 'mon'], 'union keeps the old day');
});

test('no signals at all still writes nothing', () => {
  assert.equal(write(scannedStop(), undefined), null);
});
