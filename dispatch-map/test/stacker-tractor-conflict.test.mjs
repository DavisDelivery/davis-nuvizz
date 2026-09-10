// A STACKER ON A BOX TRUCK, AND THE NOTE THAT USED TO SAY THE OPPOSITE.
//
// PRO 007173855 (SHARPS MWS) went out 2026-09-09 carrying a 1,259 lb walk-behind stacker,
// came back undelivered, and was re-cut as 007173855-1 for redelivery on 09-10 with a
// Pre-Visit note reading "REDELIVER STRADDLE STACKER ON TRACTOR TRAILER 9/10".
//
// Chad: "I also want it to throw a flag if i try to put this on a box truck."
//
// TWO FAILURES MEET ON THIS ORDER and the second one caused the first:
//   * A stacker rolls off a dock or a trailer deck on its own castors. A box truck offers a
//     liftgate instead, which is not the same thing and is how one gets tipped.
//   * The order's own text said "NO STRAIGHT TRUCK OR LIFT" — and the scanner read the
//     middle of that as "STRAIGHT TRUCK", raised uline_straight_truck ("straight truck
//     only"), which routing-constraints maps to "must NOT be a tractor". The only
//     non-tractor in the fleet is the 26ft box. The system was requiring the one vehicle
//     the customer had ruled out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags } from '../src/lib/board-flags.js';
import { scanStop } from '../src/lib/signal-scanner.ts';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DATE = '2026-09-10';

const STACKER_ITEMS = [
  { product: 'MISC' }, { product: 'HYDRAULIC STACKER' }, { product: 'PLATFORM TRUCK' },
];

const stop = (over = {}) => ({
  stopNbr: '007173855-1', businessName: 'SHARPS MWS', addr1: '315 BELL PARK DR',
  city: 'WOODSTOCK', lat: 34.10, lng: -84.00, matchKey: 'sharps',
  normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  loadNbr: 'BOX 1', routeName: 'BOX 1', routeSeq: 8, stopType: 'DO',
  stopDetails: STACKER_ITEMS,
  ...over,
});

const run = (stops, routeClasses = { 'BOX 1': 'box', 'TRACTOR 2': 'tractor' }) =>
  computeBoardFlags({
    stops, notes: new Map(), rosterRows: [],
    servedDate: DATE, dayKey: 'thu',
    opts: { depot: DEPOT, departMin: 8 * 60, travel: { legs: {}, ...(routeClasses ? { routeClasses } : {}) } },
  });
const boxRows = (out) => out.rows.filter((r) => r.rule === 'box_truck_conflict');

// ── THE RULE ────────────────────────────────────────────────────────────────

test('a stacker on a BOX route flags RED and names the freight, not the rule', () => {
  const rows = boxRows(run([stop()]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, 'red');
  assert.equal(rows[0].stopNbr, '007173855-1');
  assert.equal(rows[0].routeKey, 'BOX 1');
  assert.equal(rows[0].routeClass, 'box');
  assert.deepEqual(rows[0].handling, ['hydraulic stacker']);
  assert.match(rows[0].detail, /running a box truck/);
  assert.match(rows[0].detail, /hydraulic stacker/);
});

test('the same order on a TRACTOR is exactly what the note asked for — silent', () => {
  const rows = boxRows(run([stop({ loadNbr: 'TRACTOR 2', routeName: 'TRACTOR 2' })]));
  assert.equal(rows.length, 0);
});

test('an ordinary order on a box truck is silent — this fires on the freight, not the truck', () => {
  const rows = boxRows(run([stop({ stopDetails: [{ product: 'VINYL BAGS' }, { product: 'KNIVES' }] })]));
  assert.equal(rows.length, 0);
});

test('"we do not know the truck" is not "it is a box truck" — an unclassed route is not judged', () => {
  // The discipline the trailer rule already keeps: a route with no vehicle typed onto it is
  // reported as unchecked, never as clean, and never guessed into a flag.
  const out = run([stop({ loadNbr: 'MANDI', routeName: 'MANDI' })]);
  assert.equal(boxRows(out).length, 0);
  assert.ok(out.skipped.routesNoTruckClass.some((r) => r.route === 'MANDI'));
});

test('with no route-class map at all the rule says nothing and the board reports it', () => {
  const out = run([stop()], null);
  assert.equal(boxRows(out).length, 0);
  assert.equal(out.skipped.noTruckClasses, true);
});

test('two orders at one dock are one move, and one card', () => {
  const out = run([
    stop({ stopNbr: '007173855-1' }),
    stop({ stopNbr: '007173855-2' }),
  ]);
  const rows = boxRows(out);
  assert.equal(rows.length, 1, 'one dock, one card');
  assert.equal(rows[0].ordersHere, 2);
  assert.deepEqual(rows[0].stopNbrs, ['007173855-1', '007173855-2']);
  assert.match(rows[0].detail, /one dock, so this is one move/);
});

test('the note alone raises it — an un-enriched stop still has its comments', () => {
  // The cheap board pull carries no line items, so an order that has not been enriched has
  // only its notes. That is the source that named the truck in the first place.
  const rows = boxRows(run([stop({
    stopDetails: [],
    signalSources: { orderInstructions: '**REDELIVER STRADDLE STACKER ON TRACTOR TRAILER 9/10**' },
  })]));
  assert.equal(rows.length, 1);
});

// ── THE INVERSION THAT PUT IT THERE ─────────────────────────────────────────

test('"NO STRAIGHT TRUCK OR LIFT" no longer reads as "straight truck only"', () => {
  // Verbatim from the order, including the wrap across two 25-character comment records.
  assert.deepEqual(scanStop({ signalSources: { orderInstructions: 'NO STRAIGHT TRUCK OR LIFT' } }), []);
  assert.deepEqual(
    scanStop({ signalSources: { orderInstructions: 'NO STRAIGHT TRUCK OR LIFT\nGATE! MUST SHIP UPRIGHT.' } }),
    [],
  );
});

test('a negation up to two words away still counts — "DO NOT SEND STRAIGHT TRUCK"', () => {
  assert.deepEqual(scanStop({ signalSources: { orderInstructions: 'DO NOT SEND STRAIGHT TRUCK' } }), []);
  assert.deepEqual(scanStop({ signalSources: { orderInstructions: 'DO NOT USE A BOX TRUCK ONLY' } }), []);
});

test('a real straight-truck instruction still fires — the guard must not silence the rule', () => {
  for (const txt of ['STRAIGHT TRUCK ONLY', 'BOX TRUCK ONLY', '26 FT MAX', 'SMALL TRUCK ONLY']) {
    const r = scanStop({ signalSources: { orderInstructions: txt } });
    assert.equal(r.length, 1, `${txt} must still flag`);
    assert.equal(r[0].flagValue, 'uline_straight_truck');
  }
});

test('a pattern carrying its OWN negation is untouched — "NO TRACTOR TRAILER" still fires', () => {
  // Its NO is inside the match, so nothing precedes it and the guard never sees it.
  const r = scanStop({ signalSources: { orderInstructions: 'NO TRACTOR TRAILER' } });
  assert.equal(r.length, 1);
  assert.equal(r[0].matchedText, 'NO TRACTOR TRAILER');
});

test('a negation cannot reach across a comment boundary into the next record', () => {
  // These arrive as separate NuVizz comments joined with '\n'. "NO DOCK" must not cancel a
  // real instruction filed underneath it.
  const r = scanStop({ signalSources: { orderInstructions: 'NO DOCK\nSTRAIGHT TRUCK ONLY' } });
  assert.equal(r.length, 1);
  assert.equal(r[0].flagValue, 'uline_straight_truck');
});
