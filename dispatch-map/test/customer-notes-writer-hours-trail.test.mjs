// THE AUDIT TRAIL MUST NOT BECOME AN OWNERSHIP CLAIM ON HOURS THE SCANNER DID NOT WRITE.
//
// decideWrite protects hand-typed hours with a provenance guard: the scanner may only
// overwrite hours it wrote itself, and its fingerprint for "I wrote these" is
// auto_sources.receiving_hours. But the audit block stamped that same fingerprint on EVERY
// write that carried an hours detection — including the write that had just REFUSED to touch
// the hours. So the first scan left the typed hours alone and signed them as the scanner's;
// the second scan saw its own signature and overwrote them. Two scans, and a customer's
// hand-entered 7a-3p became whatever one Uline order said. The card then labelled them
// "Auto-detected — verify" as well (hours-provenance.js reads the same fingerprint).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWrite } from '../src/lib/customer-notes-writer.ts';
import { hoursProvenance } from '../src/lib/hours-provenance.js';

const STAMPS = { serverTimestamp: () => ({ __serverTimestamp: true }), deleteField: () => ({ __deleteField: true }) };
const write = (stop, existing) => decideWrite(stop, existing, STAMPS);

const ST_HIT = { flagValue: 'uline_straight_truck', matchedSource: 'orderInstructions', matchedText: 'STRAIGHT TRUCK ONLY', matchedPattern: 'st_only' };
const HOURS_8_12 = { open: '08:00', close: '12:00', matchedSource: 'orderInstructions', matchedText: 'HOURS 8-12' };
const scanned = (over = {}) => ({
  matchKey: 'acme|1 main|buford|30518',
  pro: 'PRO123', businessName: 'ACME', addr1: '1 Main', city: 'Buford', state: 'GA', zip: '30518',
  scanResults: [ST_HIT], hoursResult: HOURS_8_12,
  ...over,
});

// setDoc(..., { merge: true }) merges nested maps field by field. Enough of that to carry one
// scan's write into the doc the next scan reads.
const mergeInto = (doc, payload) => {
  const out = { ...doc };
  for (const [k, v] of Object.entries(payload)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && doc[k] && typeof doc[k] === 'object' && !Array.isArray(doc[k])
      ? { ...doc[k], ...v }
      : v;
  }
  return out;
};

const HAND_TYPED = {
  receiving_hours: {
    mon: { open: '07:00', close: '15:00' }, tue: { open: '07:00', close: '15:00' },
    wed: { open: '07:00', close: '15:00' }, thu: { open: '07:00', close: '15:00' },
    fri: { open: '07:00', close: '15:00' },
  },
};

test('hand-typed hours survive a second scan of an order that reads different hours', () => {
  const scan1 = write(scanned(), HAND_TYPED);
  assert.ok(scan1, 'the straight-truck flag drives a write');
  assert.equal(scan1.payload.receiving_hours, undefined, 'scan 1 leaves the typed hours alone');
  const afterScan1 = mergeInto(HAND_TYPED, scan1.payload);

  const scan2 = write(scanned(), afterScan1);
  const afterScan2 = scan2 ? mergeInto(afterScan1, scan2.payload) : afterScan1;
  assert.deepEqual(afterScan2.receiving_hours.mon, { open: '07:00', close: '15:00' },
    'the typed 7a-3p was overwritten by the order text on the second scan');
});

test('the scanner does not sign hours it refused to write', () => {
  const d = write(scanned(), HAND_TYPED);
  assert.equal(d.payload.auto_sources?.receiving_hours, undefined);
  assert.equal(d.payload.auto_matches?.receiving_hours, undefined);
  // So the stop card keeps saying what it honestly knows about who set them.
  assert.notEqual(hoursProvenance(mergeInto(HAND_TYPED, d.payload)).kind, 'auto');
});

test('hours the scanner DID write still carry its trail, and it may still correct them', () => {
  const first = write(scanned({ scanResults: [] }), undefined);
  assert.deepEqual(first.payload.auto_sources.receiving_hours, ['orderInstructions']);
  assert.equal(first.payload.auto_matches.receiving_hours[0].text, 'HOURS 8-12');
  const doc = mergeInto({}, first.payload);
  const next = write(scanned({ scanResults: [], hoursResult: { ...HOURS_8_12, close: '14:00', matchedText: 'HOURS 8-2' } }), doc);
  assert.deepEqual(next.payload.receiving_hours.mon, { open: '08:00', close: '14:00' });
});
