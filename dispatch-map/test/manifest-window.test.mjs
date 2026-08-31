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
  nextDeliveryDay, expectedDeliveryDate, manifestWindow,
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

// ── SHIP DATE → DELIVERY DAY ─────────────────────────────────────────────────
//
// Chad, asked what Uline's date column means: "Uline date column in manifest is date shipped
// so expectation is we deliver it next business day except for the manifest we get on sundays
// that is for Tuesday." The check had been treating the column as a board date outright, which
// is why a Friday manifest was diffed against Friday's board.

test('shipped is not delivered — every weekday maps to the next business day', () => {
  assert.equal(expectedDeliveryDate('2026-08-17'), '2026-08-18', 'Mon ships, Tue delivers');
  assert.equal(expectedDeliveryDate('2026-08-18'), '2026-08-19');
  assert.equal(expectedDeliveryDate('2026-08-19'), '2026-08-20');
  assert.equal(expectedDeliveryDate('2026-08-20'), '2026-08-21', 'Thu ships, Fri delivers');
});

test('a FRIDAY manifest is for MONDAY — the run Chad was looking at', () => {
  // Shipped 2026-08-21. It was being diffed against the 08-21 board, which held 758 stops and
  // none of these 18, because none of them were ever for Friday.
  assert.equal(expectedDeliveryDate('2026-08-21'), '2026-08-24');
  assert.deepEqual(manifestWindow('2026-08-21', 2).dates, ['2026-08-24', '2026-08-25', '2026-08-26']);
  assert.ok(!manifestWindow('2026-08-21', 2).dates.includes('2026-08-21'), 'Friday is the ship day, not a delivery day for this freight');
});

test('the SUNDAY manifest is for TUESDAY, not Monday — a real exception, not an off-by-one', () => {
  // It moves Sunday night, is received Monday, routed Monday evening, delivered Tuesday.
  // "Next business day" would say Monday and Monday is wrong.
  assert.equal(expectedDeliveryDate('2026-08-23'), '2026-08-25');
  assert.notEqual(expectedDeliveryDate('2026-08-23'), '2026-08-24');
  assert.deepEqual(manifestWindow('2026-08-23', 1).dates, ['2026-08-25', '2026-08-26']);
});

test('a Saturday ship date lands on Monday', () => {
  assert.equal(expectedDeliveryDate('2026-08-22'), '2026-08-24');
  assert.equal(nextDeliveryDay('2026-08-21'), '2026-08-24');
  assert.equal(nextDeliveryDay('2026-08-19'), '2026-08-20');
});

test('a junk ship date yields no window at all rather than one around today', () => {
  for (const bad of ['', null, undefined, 'nope']) {
    assert.equal(expectedDeliveryDate(bad), null, String(bad));
    assert.deepEqual(manifestWindow(bad, 2), { expected: null, required: [], dates: [] });
  }
});

// ── REQUIRED vs EXTRA DAYS ───────────────────────────────────────────────────

test('only the EXPECTED delivery day has to be scanned — the slack days are just extra looks', () => {
  // Requiring the slack days too would make every check inconclusive: the day after tomorrow
  // is never routed yet. The expected day is the board the freight is supposed to be on.
  const w = manifestWindow('2026-08-20', 2);            // Thu ships → Fri delivers
  assert.deepEqual(w.required, ['2026-08-21']);
  const cov = boardCoverage([
    { date: '2026-08-21', stops: 700 }, { date: '2026-08-24', stops: 0 }, { date: '2026-08-25', stops: 0 },
  ], w.required);
  assert.equal(cov.conclusive, true, 'the day that decides was scanned');
  assert.deepEqual(cov.missingRequired, []);
  assert.equal(gradeSuspects([{ pro: '1' }], cov).verdict, 'missing');
});

test('the expected day unbuilt is inconclusive however many other boards exist', () => {
  const w = manifestWindow('2026-08-21', 2);            // Fri ships → Mon delivers
  const cov = boardCoverage([
    { date: '2026-08-24', stops: 0 }, { date: '2026-08-25', stops: 0 }, { date: '2026-08-26', stops: 0 },
  ], w.required);
  assert.equal(cov.conclusive, false);
  assert.deepEqual(cov.missingRequired, ['2026-08-24']);
  const text = gradeText(gradeSuspects(new Array(18).fill({}), cov), cov);
  assert.match(text, /not routed yet/i);
  assert.match(text, /2026-08-24/, 'name the day that decides');
});

test('with no required set recorded, every day must be scanned — the conservative fallback', () => {
  // An older stored run never recorded which day decided. Demanding all of them downgrades a
  // stale verdict to a warning rather than leaving it shouting.
  const cov = boardCoverage([{ date: '2026-08-21', stops: 758 }, { date: '2026-08-22', stops: 0 }]);
  assert.equal(cov.conclusive, false);
  assert.deepEqual(cov.required, []);
});

// ── A BOARD FOR A DAY THAT HAS NOT ARRIVED CANNOT DISPROVE ANYTHING ──────────
//
// Chad, on 83 orders reported off the 08-28 manifest: "i don't think that is true."
//
// He was right, and the tell is that ONLY FRIDAYS ever reported missing orders. Nine nights
// on file at the time: 0 missing on every Sun/Mon/Tue/Wed/Thu, 30 on Fri 08-21 and 83 on
// Fri 08-28. Freight does not go astray only on Fridays.
//
// A Friday manifest is expected to deliver MONDAY, and the nightly check runs early SATURDAY
// — while scheduled scans are dark for the weekend. So it opened a Monday board that was
// still filling. The proof is in the archive: Monday 08-24 read 477 stops when Friday's
// manifest was checked, and 618 by the time Monday's own manifest was reconciled. The 30
// "missing" orders had simply not been written yet.
//
// The old rule could not see it, because the Monday board EXISTED (451 > 0) and existing was
// taken for finished.

const FRI_08_28 = [{ date: '2026-08-31', stops: 451 }, { date: '2026-09-01', stops: 2 }, { date: '2026-09-02', stops: 0 }];
const FRI_08_21 = [{ date: '2026-08-24', stops: 477 }, { date: '2026-08-25', stops: 2 }, { date: '2026-08-26', stops: 0 }];
const THU_08_27 = [{ date: '2026-08-28', stops: 649 }, { date: '2026-08-31', stops: 0 }, { date: '2026-09-01', stops: 1 }];
const suspects = (n) => Array.from({ length: n }, (_, i) => ({ pro: String(100000 + i) }));

test('THE 83 OFF THE 08-28 MANIFEST IS NOT A MISSING-FREIGHT FINDING', () => {
  const cov = boardCoverage(FRI_08_28, ['2026-08-31'], '2026-08-29');
  assert.equal(cov.conclusive, false, 'Monday had not come round on Saturday');
  assert.deepEqual(cov.pending, ['2026-08-31']);
  assert.equal(gradeSuspects(suspects(83), cov).verdict, 'unrouted');
});

test('and neither was the 30 off 08-21 — the same Friday shape, a week earlier', () => {
  const cov = boardCoverage(FRI_08_21, ['2026-08-24'], '2026-08-22');
  assert.equal(cov.conclusive, false);
  assert.equal(gradeSuspects(suspects(30), cov).verdict, 'unrouted');
});

test('THE REAL ALERT STILL FIRES — a finished board still says missing', () => {
  // The cost of getting this wrong in the other direction is silence about freight that
  // genuinely never reached NuVizz. A Thursday manifest expects FRIDAY and is checked on
  // Friday morning against a finished 649-stop board: that verdict is chase-able and must
  // survive. Note the later days (Mon 0, Tue 1) are unbuilt and MUST NOT suppress it — the
  // expected day is what decides.
  const cov = boardCoverage(THU_08_27, ['2026-08-28'], '2026-08-28');
  assert.equal(cov.conclusive, true, 'the expected day has arrived and has a board');
  assert.deepEqual(cov.pending, []);
  assert.equal(gradeSuspects(suspects(5), cov).verdict, 'missing');
});

test('the same Friday manifest re-checked ON Monday reports for real', () => {
  // Not a permanent excuse: once the day arrives the board is finished and the count means
  // what it says. This is what makes the downgrade honest rather than a way to stay quiet.
  const cov = boardCoverage(FRI_08_28, ['2026-08-31'], '2026-08-31');
  assert.equal(cov.conclusive, true);
  assert.equal(gradeSuspects(suspects(83), cov).verdict, 'missing');
});

test('the message names the day that has not come round, not an empty Wednesday', () => {
  // gradeText fell through to coverage.empty and said "no board has been built for
  // 2026-09-02" — true, and the wrong day. Monday is the one that decides.
  const cov = boardCoverage(FRI_08_28, ['2026-08-31'], '2026-08-29');
  const text = gradeText(gradeSuspects(suspects(83), cov), cov);
  assert.match(text, /2026-08-31/);
  assert.ok(!/2026-09-02/.test(text), 'the empty Wednesday is not the reason');
  assert.match(text, /not come round/);
});

test('no asOf leaves the old behaviour alone — a stored run without one is not re-graded blind', () => {
  const cov = boardCoverage(FRI_08_28, ['2026-08-31']);
  assert.deepEqual(cov.pending, []);
  assert.equal(cov.asOf, null);
});

test('a malformed asOf is ignored rather than being compared as a string', () => {
  // 'today' > '2026-08-31' is true in JS string order, which would quietly mark every day
  // pending and silence the check entirely.
  for (const bad of ['today', '', null, undefined, '2026-8-31', 42]) {
    assert.deepEqual(boardCoverage(FRI_08_28, ['2026-08-31'], bad).pending, [], `asOf=${String(bad)}`);
  }
});
