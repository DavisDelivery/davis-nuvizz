// test/driver-label.test.mjs — the name plate under a truck on the dispatch map.
//
// Chad, on a photograph of the live board: "Truck icons are too big. Too much text showing
// covering the stops up. Want to take all the stale and in route text off and lower the font
// size of the drivers name."
import test from 'node:test';
import assert from 'node:assert/strict';
import { driverLabelLines, driverPlateName, driverFixStale, DRIVER_STALE_MIN } from '../src/lib/driver-label.js';

const T0 = 1_700_000_000_000;
const moving = { vehicleNumber: '7792', driverName: 'Brent Davis', speedMph: 54, locatedAt: new Date(T0).toISOString() };

test('THE STATUS WORDS ARE GONE — no plate says "en route", "stopped" or "stale"', () => {
  // The words that covered the freight. "en route" was on nearly every moving truck at once,
  // which makes it weather rather than information, and it cost a whole second line of white
  // box over the stops underneath.
  const cases = [
    moving,
    { ...moving, speedMph: 0, stoppedMinutes: 45 },
    { ...moving, locatedAt: new Date(T0 - 120 * 60000).toISOString() },  // long stale
    { ...moving, routeAssigned: true, routeProgress: { completed: 3, total: 12 } },
  ];
  for (const d of cases) {
    const { line1, line2 } = driverLabelLines(d, T0);
    const all = `${line1} ${line2}`;
    assert.doesNotMatch(all, /en route/i, all);
    assert.doesNotMatch(all, /stopped/i, all);
    assert.doesNotMatch(all, /\bstale\b/i, all);
  }
});

test('a moving truck with no route is ONE line — which is the whole point', () => {
  const { line1, line2 } = driverLabelLines(moving, T0);
  assert.equal(line1, '7792 · Brent D.');
  assert.equal(line2, '', 'no second line means no second row of white box over the pins');
});

test('route progress SURVIVES, because it is different for every truck and acted on', () => {
  const { line2 } = driverLabelLines({ ...moving, routeAssigned: true, routeProgress: { completed: 3, total: 12 } }, T0);
  assert.equal(line2, 'Stop 3 of 12');
});

test('a route with no progress yet still names the route and its size', () => {
  const { line2 } = driverLabelLines({ ...moving, routeAssigned: true, routeId: 'R-14', routeTotalStops: 22 }, T0);
  assert.equal(line2, 'Route R-14 · 22 stops');
});

test('STALENESS STILL TRAVELS — as the flag that dims the truck, not as a word', () => {
  // The signal is not lost with the text: the caller drops the marker to 55% and the plate to
  // 60% on this flag, which reads across a room in a way 9px type never did.
  const fresh = driverLabelLines(moving, T0 + 5 * 60_000);
  const old = driverLabelLines(moving, T0 + 90 * 60_000);
  assert.equal(fresh.stale, false);
  assert.equal(old.stale, true);
  assert.doesNotMatch(`${old.line1} ${old.line2}`, /stale/i, 'dimmed, not captioned');
});

test('the staleness boundary is the documented one, either side of it', () => {
  const at = new Date(T0).toISOString();
  assert.equal(driverFixStale(at, T0 + (DRIVER_STALE_MIN - 1) * 60_000), false);
  assert.equal(driverFixStale(at, T0 + (DRIVER_STALE_MIN + 1) * 60_000), true);
});

test('NO TIMESTAMP IS NOT STALE — a feed that omits the field must not dim the whole fleet', () => {
  assert.equal(driverFixStale(null, T0), false);
  assert.equal(driverFixStale(undefined, T0), false);
  assert.equal(driverFixStale('not a date', T0), false);
  assert.equal(driverLabelLines({ vehicleNumber: '1', driverName: 'A B' }, T0).stale, false);
});

test('the two shapes the feed sends produce the SAME plate', () => {
  // Two spellings of one driver on two boards is how a dispatcher comes to believe in two.
  const split = driverLabelLines({ vehicleNumber: '7792', driverFirstName: 'Brent', driverLastInitial: 'D' }, T0);
  const whole = driverLabelLines({ vehicleNumber: '7792', driverName: 'Brent Davis' }, T0);
  assert.equal(split.line1, whole.line1);
  assert.equal(split.line1, '7792 · Brent D.');
});

test('"(no driver)" IS SAID — an empty plate would read as a rendering fault, not a fact', () => {
  // A truck nobody is signed into is the thing you look for when a route is not moving.
  assert.equal(driverPlateName({}), '(no driver)');
  assert.equal(driverPlateName({ driverName: '   ' }), '(no driver)');
  assert.equal(driverLabelLines({ vehicleNumber: '7750' }, T0).line1, '7750 · (no driver)');
});

test('a one-word name does not grow a stray initial, and a missing truck number says so', () => {
  assert.equal(driverPlateName({ driverName: 'Cher' }), 'Cher');
  assert.equal(driverLabelLines({ driverName: 'Cher' }, T0).line1, '? · Cher');
});

test('a three-part name takes the LAST part as the initial, not the middle one', () => {
  assert.equal(driverPlateName({ driverName: 'Jean de Vries' }), 'Jean V.');
});
