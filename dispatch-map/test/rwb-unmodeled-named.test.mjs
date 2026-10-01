// THE NON-DO REFUSAL NAMES THE STOP (v1.98.4).
//
// Chad: "I WANT THE REAL FIX." MONE (DAVIS000204729) was refused at 10:43 and 10:48 PM on
// 2026-09-28, BRIAN at 8:38 and 8:39 — "load has a non-DO stop in a delivery slot that this card is
// not sequencing — reorder skipped (verify in portal)" — and nothing said WHICH stop. The load read
// the guard had in hand held the stop's number, type, NuVizz position and customer. BRIAN's was the
// LOCKHEED MARTIN pickup RA58610778-1-1 at NuVizz stop 19 (read off the board that night); the load
// below is shaped like load/info, with that stop in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
const { unmodeledDeliveries, describeUnmodeled, unmodeledRefusal } = await import('../netlify/functions/lib/nuvizz-write.mts');
const { normalizeLoad } = await import('../netlify/functions/lib/nuvizz-write-ops.mts');

const ORIGINAL = 'commitBoard(rwb): load has a non-DO stop in a delivery slot that this card is not sequencing — reorder skipped (verify in portal)';
const drop = (nbr, seq, name) => ({ stop: { stopId: `id-${nbr}`, stopNbr: nbr, stopType: 'DO', to: { seq, address: { name } }, from: { address: { name: 'DAVIS DELIVERY' } } } });
const brianLoad = normalizeLoad({ Load: {
  loadHeader: { loadId: '6ab3f1195b97db56e47eb3c6', loadNbr: 'DAVIS000204685', routeName: 'BRIAN' },
  versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
  stops: [
    drop('007183174', 2, 'CUSTOMER A'),
    drop('007183608', 3, 'CUSTOMER B'),
    // The return: picked up AT the customer (from), carried to our warehouse (to).
    { stop: { stopId: 'id-RA', stopNbr: 'RA58610778-1-1', stopType: 'PU', from: { seq: 19, address: { name: 'LOCKHEED MARTIN' } }, to: { address: { name: 'DAVIS DELIVERY' } } } },
  ],
} });

test('BRIAN: the stop the card left off is named — number, kind, customer and NuVizz position', () => {
  const um = unmodeledDeliveries(brianLoad, new Set(['007183174', '007183608']));
  assert.deepEqual(um, [{ stopNbr: 'RA58610778-1-1', stopType: 'PU', stopSeq: 19, name: 'LOCKHEED MARTIN' }]);
  assert.equal(describeUnmodeled(um), 'RA58610778-1-1 (pickup, LOCKHEED MARTIN, NuVizz stop 19)');
});

test('a pickup is named from its pickup side — never our own warehouse on the other end', () => {
  const noFrom = normalizeLoad({ Load: { loadHeader: { loadId: 'x' }, stops: [
    { stop: { stopNbr: 'RA1', stopType: 'PU', from: { seq: 4 }, to: { address: { name: 'DAVIS DELIVERY' } } } },
  ] } });
  assert.equal(unmodeledDeliveries(noFrom)[0].name, null, 'no pickup-side name → no name, not DAVIS DELIVERY');
  assert.equal(describeUnmodeled(unmodeledDeliveries(noFrom)), 'RA1 (pickup, NuVizz stop 4)');
});

test('the SAME predicate as the guard: listed stops, removals, deliveries and the origin slot never appear', () => {
  assert.deepEqual(unmodeledDeliveries(brianLoad, new Set(['RA58610778-1-1'])), [], 'on the card → modeled');
  const origin = normalizeLoad({ Load: { loadHeader: { loadId: 'x' }, stops: [{ stop: { stopNbr: 'P0', stopType: 'PU', from: { seq: 1 } } }] } });
  assert.deepEqual(unmodeledDeliveries(origin), [], 'seq 1 is the origin pickup');
  const blank = normalizeLoad({ Load: { loadHeader: { loadId: 'x' }, stops: [{ stop: { stopNbr: 'B7', to: { seq: 5 } } }] } });
  assert.deepEqual(unmodeledDeliveries(blank), [{ stopNbr: 'B7', stopType: null, stopSeq: 5, name: null }], 'a blank-typed stop is non-DO to the guard, and says so');
  assert.equal(describeUnmodeled(unmodeledDeliveries(blank)), 'B7 (no stop type, NuVizz stop 5)');
});

test('more than three: three named, then a count — a toast is not a report', () => {
  const many = [1, 2, 3, 4, 5].map((i) => ({ stopNbr: `P${i}`, stopType: 'PU', stopSeq: i + 1, name: null }));
  assert.equal(describeUnmodeled(many), 'P1 (pickup, NuVizz stop 2); P2 (pickup, NuVizz stop 3); P3 (pickup, NuVizz stop 4) (+2 more)');
});

test('the refusal: the original sentence first, then which stop and what to do; switch off → the original, exactly', () => {
  const um = unmodeledDeliveries(brianLoad, new Set(['007183174', '007183608']));
  const named = unmodeledRefusal(um, true);
  assert.ok(named.startsWith('commitBoard(rwb): load has a non-DO stop in a delivery slot that this card is not sequencing — RA58610778-1-1 (pickup, LOCKHEED MARTIN, NuVizz stop 19).'));
  assert.match(named, /Nothing was sent: add it to the card if it belongs on this route, or take it off the load in the portal, then Save\.$/);
  assert.ok(named.length <= 400, `fits a toast (${named.length} chars)`);
  assert.equal(unmodeledRefusal(um, false), ORIGINAL);
  assert.equal(unmodeledRefusal([], true), ORIGINAL, 'nothing to name → the original sentence');
  const two = [...um, { stopNbr: 'RA2', stopType: 'PU', stopSeq: 20, name: null }];
  assert.match(unmodeledRefusal(two, true), /add them to the card if they belong on this route, or take them off the load/);
});

test('absent and malformed loads answer an empty list rather than throw', () => {
  for (const bad of [null, undefined, {}, { stops: null }, { stops: [null, {}] }]) assert.deepEqual(unmodeledDeliveries(bad), []);
  assert.equal(describeUnmodeled([]), '');
  assert.equal(describeUnmodeled(null), '');
});
