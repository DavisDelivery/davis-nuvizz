// PREFLIGHT A ROUTE THE ROUTER IS STILL BUILDING.
//
// Chad: "can we have flags pop in the routing page if we build a route that system
// immediately thinks won't make it on time."
//
// Each test is named for the moment on the routing screen it protects, because the failures
// here are all silent: a preflight that says nothing looks exactly like a route that is fine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routePreflight, earliestArrivalMin, DEFAULT_DEPART_MIN } from '../src/lib/route-preflight.js';

const DEPOT = { lat: 34.147791, lng: -83.960911 };   // the real Buford depot
const DEG = 1 / 69.055;
const DATE = '2026-09-07';   // a Monday

// A stop `miles` due north of the depot, shaped like the board's own stops.
const stop = (id, miles, over = {}) => ({
  stopNbr: id, matchKey: `c${id}`, businessName: `CO ${id}`,
  lat: DEPOT.lat + miles * DEG, lng: DEPOT.lng,
  normalizedStatus: 'PLANNED', status: '10', stopType: 'DL',
  driverName: 'DRV', driverUserName: 'd', ...over,
});
const hours = (close, typed = true) => ({
  ...(typed ? { manual_overrides: { receiving_hours: true } } : {}),
  receiving_hours: { mon: { open: '06:00', close } },
});
const idx = (list) => new Map(list.map((s) => [s.stopNbr, s]));
const run = (order, stops, notes, over = {}) => routePreflight({
  order, stopById: idx(stops), notes, routeKey: 'BEN 2',
  servedDate: DATE, dayKey: 'mon', depot: DEPOT, departMin: 8 * 60, ...over,
});

// The five-stop route every ordering test below uses: closes tighten as you go out, so the
// obvious order works and the reverse does not.
const FIVE = [stop('A', 10), stop('B', 25), stop('C', 45), stop('D', 70), stop('E', 95)];
const FIVE_NOTES = new Map([
  ['cA', hours('11:00')], ['cB', hours('12:00')], ['cC', hours('13:00')],
  ['cD', hours('12:00')], ['cE', hours('16:00')],
]);

test('A ROUTE BUILT IN A SENSIBLE ORDER RAISES NOTHING — the router is not warned about a route that works', () => {
  // The false-alarm side matters more here than on the board: a router told six of his twelve
  // stops are late every time he builds a load stops reading the badge by Wednesday.
  const p = run(['A', 'B', 'C', 'D', 'E'], FIVE, FIVE_NOTES);
  assert.equal(p.lateCount, 0);
  assert.equal(p.worstTier, null);
  assert.equal(p.judged, 5);
  assert.equal(p.stops.every((s) => Number.isInteger(s.etaMin)), true, 'every stop still gets an ETA');
});

test('DRAGGING THE ROUTE INTO THE WRONG ORDER FLAGS TWO STOPS, and dragging one back clears it', () => {
  // This is the feature. If the verdict does not move when the list moves, there is no point
  // to any of it — the board panel already answers the static question.
  const bad = run(['E', 'D', 'C', 'B', 'A'], FIVE, FIVE_NOTES);
  assert.equal(bad.lateCount, 2);
  assert.equal(bad.worstTier, 'red');
  assert.deepEqual(bad.late.map((s) => s.stopNbr), ['B', 'A']);
  assert.ok(bad.late[1].lateBy > bad.late[0].lateBy, 'the last stop is the worst');

  const good = run(['B', 'A', 'C', 'D', 'E'], FIVE, FIVE_NOTES);
  assert.equal(good.lateCount, 0, 'moving the tight stops to the front fixes it');
});

test('THE CARD\'S ORDER WINS OVER THE BOARD\'S — a staged stop is judged where the router put it', () => {
  // The board stops carry NuVizz's routeSeq and a different route name. If those leaked
  // through, the badge would describe the arrangement the router is replacing.
  const boardOrder = FIVE.map((s, i) => ({ ...s, routeName: 'SOMEONE ELSE', loadNbr: 'SOMEONE ELSE', routeSeq: 5 - i }));
  const p = run(['E', 'D', 'C', 'B', 'A'], boardOrder, FIVE_NOTES);
  assert.equal(p.lateCount, 2, 'judged on the draft order, not the board order');
  assert.equal(p.routeKey, 'BEN 2');
  assert.deepEqual(p.stops.map((s) => s.seq), [1, 2, 3, 4, 5]);
});

test('A STOP THAT CANNOT BE REACHED BEFORE IT CLOSES SAYS SO — "move it up" is not advice that can work', () => {
  // A customer 120 miles out closing at 9:00a is not a sequencing problem. Telling a router to
  // re-order a route to fix it costs him the one thing he is short of, and it is still late
  // afterwards. Different fact, different sentence.
  const stops = [stop('NEAR', 8), stop('FAR', 120)];
  const notes = new Map([['cNEAR', hours('17:00')], ['cFAR', hours('09:00')]]);
  for (const order of [['NEAR', 'FAR'], ['FAR', 'NEAR']]) {
    const p = run(order, stops, notes);
    const far = p.stops.find((s) => s.stopNbr === 'FAR');
    assert.equal(far.late, true, order.join('→'));
    assert.equal(far.hopeless, true, 'unreachable in ANY order');
    assert.ok(far.earliestMin > far.closeMin, `earliest ${far.earliestMin} vs close ${far.closeMin}`);
    assert.equal(p.hopelessCount, 1);
  }
  // …and the near stop, which IS reachable, must not be tarred with it.
  const p = run(['FAR', 'NEAR'], stops, notes);
  assert.equal(p.stops.find((s) => s.stopNbr === 'NEAR').hopeless, null,
    'a stop that is not late has no hopeless verdict at all — false would read as "we checked"');
});

test('A LATE STOP THAT IS ONLY LATE WHERE IT SITS IS NOT CALLED HOPELESS', () => {
  // The other side of the line above: if putting it first would make it, the honest advice is
  // to put it first, and the badge must not say the delivery is impossible.
  const p = run(['E', 'D', 'C', 'B', 'A'], FIVE, FIVE_NOTES);
  assert.equal(p.hopelessCount, 0);
  for (const s of p.late) assert.equal(s.hopeless, false, s.stopNbr);
});

test('A STOP WITH NO PIN IS NOT REPORTED AS FINE — it is unexamined, and the count says so', () => {
  // A preflight that returns a clean route while silently skipping four stops is worse than
  // no preflight, because it is believed. The card already learned this for its own rows.
  const stops = [stop('A', 10), { stopNbr: 'NOPIN', matchKey: 'cNOPIN', businessName: 'NO PIN CO' }];
  const p = run(['A', 'NOPIN'], stops, new Map([['cA', hours('17:00')]]));
  assert.equal(p.judged, 1);
  assert.equal(p.unjudged.noCoords, 1);
  assert.equal(p.unjudged.total, 1);
  assert.equal(p.stops.length, 1, 'and it is not rendered as a judged row');
});

test('A STAGED ID THE CARD CANNOT RESOLVE IS COUNTED, not silently dropped', () => {
  const p = run(['A', 'GHOST'], [stop('A', 10)], new Map([['cA', hours('17:00')]]));
  assert.equal(p.unjudged.unresolved, 1);
  assert.equal(p.judged, 1);
});

test('A DELIVERED STOP ON THE CARD IS NOT FLAGGED — it already happened', () => {
  const stops = [stop('DONE', 95, { normalizedStatus: 'DELIVERED', status: '90', deliveredDTTM: `${DATE}T18:30:00` })];
  const p = run(['DONE'], stops, new Map([['cDONE', hours('09:00')]]));
  assert.equal(p.lateCount, 0);
});

test('NO HOURS ON FILE IS JUDGED AGAINST THE 5PM HOUSE CLOSE AND CAPPED AT AMBER', () => {
  // Chad, on the board: "we are only worried about the ones that have receiving hours,
  // everyone else we assume closing at 5". Same rule here, because it is the same engine —
  // and a guess must never read as loud as a recorded deadline.
  const stops = [stop('X', 20), stop('FARAWAY', 460)];
  const p = run(['X', 'FARAWAY'], stops, new Map());
  const far = p.stops.find((s) => s.stopNbr === 'FARAWAY');
  assert.equal(far.late, true);
  assert.equal(far.closeMin, 17 * 60, 'the 5pm assumption');
  assert.equal(far.hoursTier, 'assumed');
  assert.equal(far.tier, 'amber', 'a guess never goes above amber, however late');
});

test('THE DEPARTURE IS REPORTED, because "late" against a departure nobody measured is a different claim', () => {
  const p = run(['A'], FIVE, FIVE_NOTES);
  assert.deepEqual(p.departure, { min: 8 * 60, source: 'assumed' });
  const m = run(['A'], FIVE, FIVE_NOTES, { departMin: 3 * 60 + 42, departureSource: 'measured' });
  assert.deepEqual(m.departure, { min: 222, source: 'measured' });
  // and the earlier departure really moves the clock, rather than only the label
  assert.ok(m.stops[0].etaMin < p.stops[0].etaMin);
});

test('A LATER DEPARTURE MAKES STOPS LATE THAT AN 8AM ONE WOULD NOT — the tails are the whole reason to measure it', () => {
  // The fleet departs at a median 08:23 but p90 is 13:50. A route judged at 8:00 that really
  // rolls at 1:50p is a clean-looking build and a bad afternoon.
  const early = run(['A', 'B', 'C', 'D', 'E'], FIVE, FIVE_NOTES);
  const late = run(['A', 'B', 'C', 'D', 'E'], FIVE, FIVE_NOTES, { departMin: 10 * 60 });
  assert.equal(early.lateCount, 0);
  assert.ok(late.lateCount > 0, 'the same route, two hours later, is not the same route');
});

test('the empty and the malformed return a shape, never a throw — Number(null) is 0 and 0 is a real departure', () => {
  for (const bad of [undefined, null, [], 'nope', {}]) {
    const p = routePreflight({ order: bad, stopById: idx(FIVE), notes: FIVE_NOTES, depot: DEPOT });
    assert.equal(p.lateCount, 0, String(bad));
    assert.deepEqual(p.stops, []);
  }
  assert.deepEqual(routePreflight().stops, [], 'no arguments at all');
  // A missing depot cannot be walked from, and guessing one would put every ETA somewhere
  // invented — so it judges nothing and says nothing.
  assert.deepEqual(routePreflight({ order: ['A'], stopById: idx(FIVE), notes: FIVE_NOTES }).stops, []);
  // A departure that is not a number falls back to the house 8:00 rather than to midnight,
  // which is what Number(null) would have handed the walk.
  for (const bad of [null, undefined, '', 'noon', NaN, [], true]) {
    assert.equal(run(['A'], FIVE, FIVE_NOTES, { departMin: bad }).departure.min, DEFAULT_DEPART_MIN, String(bad));
  }
});

test('A DRIVERLESS DRAFT ON TODAY\'S BOARD STILL REPORTS ITS LATE STOPS — the clock must never reach the engine', () => {
  // THE FAILURE THIS PINS, measured rather than argued. A Compare card has no driver until the
  // router assigns one, which is the normal state while he is building. Hand the engine the
  // board clock and past 7:00a it correctly reads that as a driverless load: it restarts the
  // walk from NOON and R6 supersedes every receiving-hours row with one "no driver" card. This
  // module reads hours_risk rows, so a route with two stops going to miss came back with ZERO
  // flags — a clean-looking build, which is the exact failure the whole feature exists to
  // prevent. routePreflight therefore takes no clock at all, and passing one cannot change it.
  const stops = [stop('A', 10, { driverName: undefined, driverUserName: undefined }),
    stop('B', 25, { driverName: undefined, driverUserName: undefined }),
    stop('C', 45, { driverName: undefined, driverUserName: undefined })];
  // A 9:00a close against a walk that reaches stop two at 9:01a and stop three at 9:47a.
  const notes = new Map(stops.map((s) => [s.matchKey, hours('09:00')]));
  const p = run(['A', 'B', 'C'], stops, notes);
  assert.ok(p.lateCount >= 2, `a driverless draft must still be judged, got ${p.lateCount}`);
  assert.ok(p.stops.every((v) => v.etaMin < 12 * 60), 'the walk runs from the departure, never from noon');
  // And an accidental clock cannot get in: the option does not exist.
  const withClock = routePreflight({
    order: ['A', 'B', 'C'], stopById: idx(stops), notes, routeKey: 'BEN 2',
    servedDate: DATE, dayKey: 'mon', depot: DEPOT, departMin: 8 * 60, nowMin: 14 * 60,
  });
  assert.deepEqual(withClock.stops.map((v) => v.etaMin), p.stops.map((v) => v.etaMin),
    'a clock passed by mistake changes nothing');
});

test('THE BOARD\'S OWN STOP OBJECTS ARE NEVER MUTATED — the engine stamps __visitKey on what it walks', () => {
  // computeBoardFlags is pure in its output but not in its input: it writes __visitKey onto
  // every stop it walks, and throws on a frozen one. The card's stops are the live board's
  // objects, shared with the map and the panels, so the draft is walked over COPIES.
  const frozen = FIVE.map((s) => Object.freeze({ ...s }));
  const p = run(['A', 'B', 'C', 'D', 'E'], frozen, FIVE_NOTES);
  assert.equal(p.judged, 5, 'frozen board stops must not throw');
  for (const s of frozen) assert.equal('__visitKey' in s, false, `${s.stopNbr} was written to`);
});

test('earliestArrivalMin refuses what it cannot measure rather than returning a flattering zero', () => {
  assert.equal(earliestArrivalMin(null, { depot: DEPOT }), null);
  assert.equal(earliestArrivalMin({ stopNbr: 'X' }, { depot: DEPOT }), null, 'no coordinates');
  assert.equal(earliestArrivalMin(stop('X', 10), { depot: null }), null, 'no depot');
  assert.equal(earliestArrivalMin(stop('X', 10), { depot: DEPOT, departMin: 'soon' }), null);
  const m = earliestArrivalMin(stop('X', 10), { depot: DEPOT });
  assert.ok(m > DEFAULT_DEPART_MIN && m < DEFAULT_DEPART_MIN + 120, `10 miles took ${m - DEFAULT_DEPART_MIN} min`);
});
