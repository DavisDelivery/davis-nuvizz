// The Friday manifest, and the empty board.
//
// Chad, Friday 12:49, on a red banner reading "18 orders on the manifest are NOT in the scan":
// "I don't think that this is accurate… are these orders that have been shipped today that are
// for delivery on Monday?" He was right. Both rules below are the ones that, if they drift,
// put that banner back in front of him every Friday.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isoWeekday, isDeliveryDay, shiftIso, deliveryWindow, boardCoverage, gradeSuspects, gradeText,
} from '../src/lib/manifest-window.js';

// 2026-08-21 is a Friday. 08-22 Sat, 08-23 Sun, 08-24 Mon.
const FRI = '2026-08-21';

// ── THE WINDOW ───────────────────────────────────────────────────────────────

test('a Friday manifest reaches MONDAY — the whole bug, in one assertion', () => {
  // The old window was +2 CALENDAR days: Sat and Sun, neither a delivery day, and Monday —
  // where the freight actually moves — one day outside it.
  assert.deepEqual(deliveryWindow(FRI, 2), ['2026-08-21', '2026-08-24', '2026-08-25']);
  assert.ok(deliveryWindow(FRI, 2).includes('2026-08-24'), 'Monday must be in the window');
  assert.ok(!deliveryWindow(FRI, 2).includes('2026-08-22'), 'Saturday cannot hold a delivery');
});

test('a midweek manifest is unchanged — the fix must not move what already worked', () => {
  assert.deepEqual(deliveryWindow('2026-08-18', 2), ['2026-08-18', '2026-08-19', '2026-08-20']);
  assert.deepEqual(deliveryWindow('2026-08-19', 1), ['2026-08-19', '2026-08-20']);
});

test('a Thursday manifest still crosses the weekend when it needs two days', () => {
  // Thu + 2 delivery days = Fri, Mon. A deferred Thursday order landing Monday is now visible.
  assert.deepEqual(deliveryWindow('2026-08-20', 2), ['2026-08-20', '2026-08-21', '2026-08-24']);
});

test('the base date is kept even when it is a weekend — look before assuming', () => {
  // A Saturday-dated manifest is odd, but if a board exists for it we would rather check it.
  assert.equal(deliveryWindow('2026-08-22', 1)[0], '2026-08-22');
  assert.deepEqual(deliveryWindow('2026-08-22', 1), ['2026-08-22', '2026-08-24']);
});

test('span 0 is just the base day, and a junk span does not walk the calendar', () => {
  assert.deepEqual(deliveryWindow(FRI, 0), [FRI]);
  assert.deepEqual(deliveryWindow(FRI, -3), [FRI]);
  assert.deepEqual(deliveryWindow(FRI, 'abc'), [FRI]);
  assert.equal(deliveryWindow(FRI, 99).length, 8, 'bounded at 7 forward days');
});

test('a junk date yields no window rather than a window around today', () => {
  for (const bad of ['', null, undefined, 'not-a-date', '2026-13-45']) {
    assert.deepEqual(deliveryWindow(bad, 2), [], String(bad));
  }
});

test('weekday helpers read in UTC, so a local timezone cannot shift a delivery day', () => {
  assert.equal(isoWeekday(FRI), 5);
  assert.equal(isDeliveryDay(FRI), true);
  assert.equal(isDeliveryDay('2026-08-22'), false);
  assert.equal(isDeliveryDay('2026-08-23'), false);
  assert.equal(isDeliveryDay('2026-08-24'), true);
  assert.equal(isDeliveryDay('nonsense'), false);
  assert.equal(shiftIso(FRI, 3), '2026-08-24');
  assert.equal(shiftIso('nonsense', 1), null);
});

// ── WHAT AN EMPTY BOARD MAY PROVE ────────────────────────────────────────────

test('a day with no cached stops cannot deny anything — it was never scanned', () => {
  // Chad's actual run: 08-21 had 758 stops, 08-22 and 08-23 had none.
  const cov = boardCoverage([
    { date: '2026-08-21', stops: 758 }, { date: '2026-08-22', stops: 0 }, { date: '2026-08-23', stops: 0 },
  ]);
  assert.deepEqual(cov.checked, ['2026-08-21']);
  assert.deepEqual(cov.empty, ['2026-08-22', '2026-08-23']);
  // NOT conclusive, and this is the correction that made the fix actually work. One real
  // board is not enough: Friday's 758 stops say nothing about freight bound for a day whose
  // board has not been built.
  assert.equal(cov.conclusive, false, 'an unbuilt day in the window is a day the order might be on');
  assert.equal(cov.totalStops, 758);
});

test('every board empty is inconclusive — the routing evening has not run yet', () => {
  // Midday Friday, looking at Monday: the board does not exist, thin or otherwise.
  const cov = boardCoverage([{ date: '2026-08-24', stops: 0 }, { date: '2026-08-25', stops: 0 }]);
  assert.equal(cov.conclusive, false);
  assert.equal(cov.totalStops, 0);
});

test('malformed board rows do not turn into evidence', () => {
  assert.equal(boardCoverage(null).conclusive, false);
  assert.equal(boardCoverage([null, 'x', 7]).days, 0);
  assert.equal(boardCoverage([{ date: 'd', stops: 'many' }]).conclusive, false, 'not a number is not a board');
  assert.equal(boardCoverage([{ date: 'd', stops: -3 }]).conclusive, false);
});

// ── THE VERDICT A DISPATCHER READS ───────────────────────────────────────────

test('off-board against a real board is MISSING — this is the alert worth keeping', () => {
  const cov = boardCoverage([{ date: '2026-08-19', stops: 700 }]);
  const g = gradeSuspects([{ pro: '1' }, { pro: '2' }], cov);
  assert.equal(g.verdict, 'missing');
  assert.equal(g.count, 2);
  assert.match(gradeText(g, cov), /not in the scan/i);
});

test('off-board against nothing but empty boards is NOT ROUTED YET, not missing', () => {
  // The false alarm, downgraded. There is nothing for a dispatcher to chase here.
  const cov = boardCoverage([{ date: '2026-08-24', stops: 0 }]);
  const g = gradeSuspects(new Array(18).fill({ pro: 'x' }), cov);
  assert.equal(g.verdict, 'unrouted');
  assert.equal(g.count, 18);
  const text = gradeText(g, cov);
  assert.match(text, /not routed yet/i);
  assert.match(text, /2026-08-24/, 'name the day, so it can be checked again after routing');
  assert.doesNotMatch(text, /NOT in the scan/i, 'must not read as the alert it replaced');
});

test('a run that says nothing about its boards keeps the ALERT — unknown is not empty', () => {
  // Old stored runs predate the coverage field. Not knowing must not silently soften a real
  // finding; for a safety flag the unknown case belongs on the loud side.
  assert.equal(gradeSuspects([{ pro: '1' }], boardCoverage(undefined)).verdict, 'missing');
  assert.equal(gradeSuspects([{ pro: '1' }], boardCoverage([])).verdict, 'missing');
  assert.equal(gradeSuspects([{ pro: '1' }], null).verdict, 'missing');
  assert.equal(boardCoverage([]).known, false);
  assert.equal(boardCoverage([{ date: 'd', stops: 0 }]).known, true, 'we looked and it was empty');
});

test('no suspects is no verdict at all', () => {
  const cov = boardCoverage([{ date: '2026-08-19', stops: 700 }]);
  assert.equal(gradeSuspects([], cov).verdict, 'none');
  assert.equal(gradeSuspects(null, cov).verdict, 'none');
  assert.equal(gradeText(gradeSuspects([], cov), cov), '');
});

test('ONE unbuilt day in the window is enough to withhold the alert', () => {
  // The rule that made the difference. "At least one real board" called Chad's Friday run
  // conclusive on the strength of a board that could not have held the freight in question.
  const partial = boardCoverage([
    { date: '2026-08-21', stops: 758 }, { date: '2026-08-24', stops: 0 }, { date: '2026-08-25', stops: 0 },
  ]);
  assert.equal(gradeSuspects([{ pro: '1' }], partial).verdict, 'unrouted');
});

test('EVERY day scanned and still off the board is the alert worth waking somebody for', () => {
  // The nightly check, after the routing evening: the boards exist, the order is on none of
  // them. This is the finding the whole feature is for, and it must survive the downgrade.
  const full = boardCoverage([
    { date: '2026-08-21', stops: 758 }, { date: '2026-08-24', stops: 640 }, { date: '2026-08-25', stops: 611 },
  ]);
  assert.equal(full.conclusive, true);
  assert.equal(gradeSuspects([{ pro: '1' }], full).verdict, 'missing');
  assert.match(gradeText(gradeSuspects([{ pro: '1' }], full), full), /not in the scan/i);
});

test('the unrouted sentence names the DELIVERY day, not the weekend', () => {
  // Saying "no board has been built for Saturday" is noise — we never build one.
  const cov = boardCoverage([
    { date: '2026-08-21', stops: 758 }, { date: '2026-08-22', stops: 0 },
    { date: '2026-08-23', stops: 0 }, { date: '2026-08-24', stops: 0 },
  ]);
  const text = gradeText(gradeSuspects([{ pro: '1' }], cov), cov);
  assert.match(text, /2026-08-24/);
  assert.doesNotMatch(text, /2026-08-22|2026-08-23/, 'a weekend day has no board by design');
});
