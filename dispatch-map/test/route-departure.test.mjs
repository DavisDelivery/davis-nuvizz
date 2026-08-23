// WHEN DOES THIS ROUTE ACTUALLY LEAVE?
//
// This replaces a made-up 8:00a with a measured number, and a measured number that is
// wrong is worse than an assumption everyone knows is an assumption. So these tests are
// mostly about what the calibration REFUSES to do: sample a route it cannot read cleanly,
// publish a habit it has only seen once, or let one corrupt stamp move a truck's clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  impliedDeparture, departureTable, departureLookup, medianOf,
  MIN_SAMPLES, MIN_DEPART_MIN, MAX_DEPART_MIN, DEFAULT_SERVICE_MIN, DEPARTURE_VERSION,
  readDepartureTable,
} from '../netlify/functions/lib/route-departure.mts';
import { arrivalAnchor } from '../src/lib/board-flags.js';
import { computeBoardFlags } from '../src/lib/board-flags.js';
import { stopCustomerKey } from '../netlify/functions/lib/customer-key.mts';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
// ~6 miles out, so the depot leg is a real number rather than zero.
const NEAR = { lat: 34.147791 + 0.09, lng: -83.960911 };

test('a departure is backed out of the FIRST stop\'s real stamp', () => {
  const dep = impliedDeparture([
    { seq: 1, pos: NEAR, stampMin: 6 * 60 + 18 },
    { seq: 2, pos: NEAR, stampMin: 7 * 60 },
  ], DEPOT);
  assert.ok(dep != null, 'sampled');
  assert.ok(dep < 6 * 60 + 18, 'departure precedes the first arrival by the depot leg');
  assert.ok(dep > 5 * 60, 'and only by the leg, not by hours');
});

// ── WHICH STAMP IT IS DECIDES WHETHER THE DWELL COMES OUT (bug hunt, Aug 2026) ──
//
// arrivalAnchor draws the line and the board's forward walk honours it: an ARRIVAL means
// the truck is on site with the service still ahead of it, a DELIVERED means the service
// already happened. Going BACKWARDS the correction inverts — and this function was handed
// only the minute, because both callers dropped `source`.

test('a DELIVERED first stamp has the dwell taken back out — the truck arrived before it', () => {
  const at = 6 * 60 + 18;
  const arrival = impliedDeparture([{ seq: 1, pos: NEAR, stampMin: at, stampSource: 'arrival' }], DEPOT);
  const delivered = impliedDeparture([{ seq: 1, pos: NEAR, stampMin: at, stampSource: 'delivered' }], DEPOT);
  assert.equal(arrival - delivered, DEFAULT_SERVICE_MIN,
    'the same clock minute means two different departures, and the gap is exactly one dwell');
  assert.ok(delivered < arrival, 'a delivered stamp implies an EARLIER departure');
});

test('AND IT IS NOT A RARE CASE: arrivalDTTM is on 8 stops in 20,904, so this was every sample', () => {
  // Whatever NuVizz gives us, arrivalAnchor prefers arrivalDTTM and falls through to
  // deliveredDTTM. In this warehouse the first field is essentially never set, so the whole
  // learned table was biased one way — one dwell block LATE on every route.
  const stop = { deliveredDTTM: '2026-08-19T06:18' };
  const a = arrivalAnchor(stop, '2026-08-19');
  assert.equal(a.source, 'delivered', 'this is what a real sample looks like');
  const withSource = impliedDeparture([{ seq: 1, pos: NEAR, stampMin: a.min, stampSource: a.source }], DEPOT);
  const dropped = impliedDeparture([{ seq: 1, pos: NEAR, stampMin: a.min, stampSource: 'arrival' }], DEPOT);
  assert.equal(dropped - withSource, DEFAULT_SERVICE_MIN, 'dropping the source read the departure late');
});

test('an UNKNOWN source is treated as delivered — the failure directions are not symmetrical', () => {
  // Reading a departure EARLY understates risk, which costs a delivery; reading it late
  // costs a glance. Absent provenance falls to the side the data actually is.
  const at = 6 * 60 + 18;
  const unknown = impliedDeparture([{ seq: 1, pos: NEAR, stampMin: at }], DEPOT);
  const delivered = impliedDeparture([{ seq: 1, pos: NEAR, stampMin: at, stampSource: 'delivered' }], DEPOT);
  assert.equal(unknown, delivered);
});

test('a caller with a calibrated dwell can pass its own', () => {
  const at = 6 * 60 + 18;
  const d14 = impliedDeparture([{ seq: 1, pos: NEAR, stampMin: at, stampSource: 'delivered' }], DEPOT, undefined, 14);
  const d22 = impliedDeparture([{ seq: 1, pos: NEAR, stampMin: at, stampSource: 'delivered' }], DEPOT, undefined, 22);
  assert.equal(d14 - d22, 8);
});

test('a table from an OLDER version is not read — same shape, different meaning', () => {
  // Every value written before the dwell fix is one service block late. Nothing downstream
  // could tell a v1 minute from a v2 one, so the board would have run its clock late all day
  // on numbers that look perfectly reasonable — until the nightly fit happened to rewrite it.
  const table = { WILLIAM: { departMin: 222, n: 5, spreadMin: 20 } };
  assert.equal(readDepartureTable({ version: 1, table }), null, 'the old table is refused');
  assert.deepEqual(readDepartureTable({ version: DEPARTURE_VERSION, table }), table);
  assert.equal(readDepartureTable(null), null);
  assert.equal(readDepartureTable({ version: DEPARTURE_VERSION }), null, 'no table is not a table');
});

test('a refused table is the 8:00a DEFAULT standing, not an error', () => {
  // Same outcome as a route with too few samples: no number beats a known assumption.
  const lookup = departureLookup(readDepartureTable({ version: 1, table: { WILLIAM: { departMin: 222, n: 9 } } }));
  assert.equal(lookup('WILLIAM'), null, 'the caller keeps its own default');
});

test('no sample when the first stop never reported — three guesses to fix one is not a measurement', () => {
  assert.equal(impliedDeparture([
    { seq: 1, pos: NEAR, stampMin: null },
    { seq: 2, pos: NEAR, stampMin: 9 * 60 },   // a later stamp is NOT used
  ], DEPOT), null);
});

test('an implausible departure is refused, not published', () => {
  assert.equal(impliedDeparture([{ seq: 1, pos: NEAR, stampMin: 23 * 60 }], DEPOT), null, '11pm');
  assert.equal(impliedDeparture([{ seq: 1, pos: NEAR, stampMin: 5 }], DEPOT), null, '00:05');
});

test('an unsequenced or position-less route yields nothing', () => {
  assert.equal(impliedDeparture([{ seq: null, pos: NEAR, stampMin: 400 }], DEPOT), null);
  assert.equal(impliedDeparture([{ seq: 1, pos: null, stampMin: 400 }], DEPOT), null);
  assert.equal(impliedDeparture([], DEPOT), null);
});

test('a habit seen fewer than MIN_SAMPLES times is omitted, so the default stands', () => {
  const days = Array.from({ length: MIN_SAMPLES - 1 }, () => ({ byRoute: { WILLIAM: 222 } }));
  assert.equal(departureTable(days).WILLIAM, undefined);
  days.push({ byRoute: { WILLIAM: 222 } });
  assert.equal(departureTable(days).WILLIAM.departMin, 222);
  assert.equal(departureTable(days).WILLIAM.n, MIN_SAMPLES);
});

test('the MEDIAN holds: one afternoon re-dispatch cannot drag an early route\'s clock', () => {
  const days = [
    { byRoute: { WILLIAM: 220 } }, { byRoute: { WILLIAM: 222 } }, { byRoute: { WILLIAM: 225 } },
    { byRoute: { WILLIAM: 224 } }, { byRoute: { WILLIAM: 900 } },   // the outlier day
  ];
  const t = departureTable(days);
  assert.equal(t.WILLIAM.departMin, 224, 'median, not mean (mean would be ~318)');
  assert.ok(t.WILLIAM.spreadMin > 0, 'spread reported so a jumpy route is visible');
});

test('out-of-range samples are dropped before the fit', () => {
  const days = [
    { byRoute: { X: MIN_DEPART_MIN - 1 } }, { byRoute: { X: MAX_DEPART_MIN + 1 } },
    { byRoute: { X: 400 } }, { byRoute: { X: 402 } }, { byRoute: { X: 404 } },
  ];
  assert.equal(departureTable(days).X.n, 3, 'only the three plausible days counted');
});

test('lookup is case- and whitespace-insensitive, and refuses junk', () => {
  const find = departureLookup({ WILLIAM: { departMin: 222 }, jean: 345, BAD: { departMin: 9999 } });
  assert.equal(find('william'), 222);
  assert.equal(find(' JEAN '), 345);
  assert.equal(find('BAD'), null, 'out-of-range entry not served');
  assert.equal(find('NOBODY'), null);
  assert.equal(departureLookup(null)('x'), null);
});

test('medianOf is the lower median and never invents a between-value', () => {
  assert.equal(medianOf([1, 2, 3, 4]), 2);
  assert.equal(medianOf([5]), 5);
  assert.equal(medianOf([]), null);
});

// ── the engine actually uses it ───────────────────────────────────────────────

const DATE = '2026-08-20', DAYKEY = 'thu';
function mkStop(n, over = {}) {
  return {
    stopNbr: `7000${n}`, stopType: 'DO', loadNbr: 'WILLIAM', routeName: 'WILLIAM',
    businessName: `CUST ${n}`, addr1: `${n} MAIN ST`, city: 'BUFORD', zip: '30518',
    routeSeq: n, driverName: 'W', lat: 34.147791 + n * 0.05, lng: -83.960911, ...over,
  };
}
const keyed = (a) => a.map((s) => ({ ...s, matchKey: stopCustomerKey(s) }));

test('THE BHW CASE: an early-rolling route stops crying wolf overnight', () => {
  // A stop late in a long route with a 1:30p close — flagged from an assumed 8:00a start,
  // silent once the route's measured 3:42a departure is used. This is the shape that texted
  // at 1:00a on 2026-08-20 and was delivered at 5:04a.
  const stops = keyed(Array.from({ length: 12 }, (_, i) => mkStop(i + 1)));
  const target = stops[10];
  const notes = new Map([[target.matchKey, {
    receiving_hours: { [DAYKEY]: { close: '11:00a' } }, manual_overrides: { receiving_hours: true },
  }]]);
  const run = (opts) => computeBoardFlags({
    stops, notes, servedDate: DATE, dayKey: DAYKEY, opts: { depot: DEPOT, ...opts },
  }).rows.filter((r) => r.rule === 'hours_risk');

  const assumed = run({});
  assert.ok(assumed.length >= 1, 'assumed 8:00a departure flags it');

  const measured = run({ departByRoute: { WILLIAM: 3 * 60 + 42 } });
  assert.equal(measured.length, 0, 'measured 3:42a departure clears it');
});

test('an unknown route keeps the shipped default — learning one truck cannot silence another', () => {
  const stops = keyed(Array.from({ length: 12 }, (_, i) => mkStop(i + 1)));
  const target = stops[10];
  const notes = new Map([[target.matchKey, {
    receiving_hours: { [DAYKEY]: { close: '11:00a' } }, manual_overrides: { receiving_hours: true },
  }]]);
  const rows = computeBoardFlags({
    stops, notes, servedDate: DATE, dayKey: DAYKEY,
    opts: { depot: DEPOT, departByRoute: { SOMEONE_ELSE: 3 * 60 } },
  }).rows.filter((r) => r.rule === 'hours_risk');
  assert.ok(rows.length >= 1, 'WILLIAM still judged from 8:00a');
});

test('the row says whether the departure was measured or assumed', () => {
  const stops = keyed(Array.from({ length: 12 }, (_, i) => mkStop(i + 1)));
  const target = stops[10];
  const notes = new Map([[target.matchKey, {
    receiving_hours: { [DAYKEY]: { close: '9:00a' } }, manual_overrides: { receiving_hours: true },
  }]]);
  const assumed = computeBoardFlags({ stops, notes, servedDate: DATE, dayKey: DAYKEY, opts: { depot: DEPOT } })
    .rows.find((r) => r.rule === 'hours_risk');
  assert.match(assumed.detail, /assumed/, 'an assumption is labelled as one');

  const measured = computeBoardFlags({
    stops, notes, servedDate: DATE, dayKey: DAYKEY,
    opts: { depot: DEPOT, departByRoute: { WILLIAM: 5 * 60 } },
  }).rows.find((r) => r.rule === 'hours_risk');
  assert.match(measured.detail, /measured/, 'a measurement is labelled as one');
});
