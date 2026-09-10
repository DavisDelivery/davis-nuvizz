// test/board-write-grace.test.mjs — board write-through (#361).
//
// After a CONFIRMED live Save, patchBoardPlan stamps the day's cache docs with the verified
// plan (board_write_at). applyBoardWriteGrace is the scan-side half: it holds that confirmed
// write over a DISAGREEING fresh list row (NuVizz's list lags async imports by minutes) and
// releases the moment the list agrees or the grace expires.
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyBoardWriteGrace, unplanStampOvertaken, BOARD_WRITE_GRACE_MIN } from '../netlify/functions/lib/nuvizz-list.mts';
import { boardWritePlannedFields, boardWriteUnplannedFields } from '../netlify/functions/lib/firestore.mts';

const NOW = Date.parse('2026-07-02T12:00:00Z');
const mins = (n) => new Date(NOW - n * 60_000).toISOString();

// A fresh list row (what the scan just read) and a prior cache doc (what a Save confirmed).
const freshUnplanned = () => ({ stopNbr: '007141834', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null, routeSeq: null, driverName: null });
const freshPlannedOn = (name, seq = 1) => ({ stopNbr: '007141834', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: name, routeName: name, routeSeq: seq, driverName: null });
const priorWrite = (fields, agoMin) => ({ stopNbr: '007141834', ...fields, board_write_at: mins(agoMin) });

test('planned write HOLDS over a lagging unplanned list row within the grace window', () => {
  const fresh = freshUnplanned();
  const prior = priorWrite(boardWritePlannedFields('SUW 2', 3, null, mins(5)), 5);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), true);
  assert.equal(fresh.isPlanned, true);
  assert.equal(fresh.loadNbr, 'SUW 2');
  assert.equal(fresh.routeSeq, 3);
  assert.equal(fresh.normalizedStatus, 'SCHEDULED');
  assert.ok(fresh.board_write_at);   // stamp carried → keeps holding on the next scan too
});

test('unplanned write (omission-unplan) HOLDS over a list row still showing the OLD load', () => {
  // THE LAG CASE, and it must stay held: we took the order off SUW 2 and NuVizz's index still
  // says SUW 2. The from-route on the stamp is what makes that readable (v1.8.0).
  const fresh = freshPlannedOn('SUW 2', 4);
  const prior = priorWrite(boardWriteUnplannedFields(mins(3), 'SUW 2'), 3);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), true);
  assert.equal(fresh.isPlanned, false);
  assert.equal(fresh.loadNbr, null);
  assert.equal(fresh.normalizedStatus, 'UNPLANNED');
});

test('cross-load move HOLDS: both planned but the list still shows the OLD load', () => {
  const fresh = freshPlannedOn('SUW 2', 2);           // list lagging: still on the old load
  const prior = priorWrite(boardWritePlannedFields('SUW 5', 1, null, mins(2)), 2);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), true);
  assert.equal(fresh.loadNbr, 'SUW 5');
});

test('RELEASES when the list agrees (no disagreement → stamp not carried; list authoritative)', () => {
  const fresh = freshPlannedOn('SUW 2', 7);           // list caught up (its own seq wins)
  const prior = priorWrite(boardWritePlannedFields('SUW 2', 3, null, mins(5)), 5);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), false);
  assert.equal(fresh.routeSeq, 7);                    // untouched — the list's fresher seq stands
  assert.equal(fresh.board_write_at, undefined);      // stamp dropped
});

test('RELEASES after the grace expires — the list wins again even if it still disagrees', () => {
  const fresh = freshUnplanned();
  const prior = priorWrite(boardWritePlannedFields('SUW 2', 3, null, mins(BOARD_WRITE_GRACE_MIN + 1)), BOARD_WRITE_GRACE_MIN + 1);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), false);
  assert.equal(fresh.isPlanned, false);
});

test('no stamp on the prior doc → never interferes', () => {
  const fresh = freshUnplanned();
  assert.equal(applyBoardWriteGrace(fresh, { stopNbr: '007141834', isPlanned: true, loadNbr: 'SUW 2' }, NOW), false);
  assert.equal(fresh.isPlanned, false);
});

test('field builders mirror the board shapes exactly (loadNbr = route NAME; 20/SCHEDULED, 10/UNPLANNED)', () => {
  const p = boardWritePlannedFields('SUW 2', 5, 'Ben Paintsil', '2026-07-02T11:20:00Z');
  assert.equal(p.status, '20');
  assert.equal(p.normalizedStatus, 'SCHEDULED');
  assert.equal(p.loadNbr, 'SUW 2');       // the board's loadNbr IS the route name (list feed shape)
  assert.equal(p.routeName, 'SUW 2');
  assert.equal(p.routeSeq, 5);
  assert.equal(p.driverName, 'Ben Paintsil');
  assert.equal(p.board_write_planned, true);
  const u = boardWriteUnplannedFields('2026-07-02T11:20:00Z');
  assert.equal(u.status, '10');
  assert.equal(u.isUnplanned, true);
  assert.equal(u.loadNbr, null);
  assert.equal(u.board_write_planned, false);
});

// ── "WHATEVER THE SCAN SAYS IS THE TRUTH" (Chad, Sep 10 2026) ────────────────
//
// Order 007174547: a Save took it off TREVARR at 6:18am, somebody re-planned it onto RONALD in
// the NuVizz portal, and the 6:58 AND 7:15 scans both read RONALD off NuVizz's own list and both
// threw that answer away — a confirmed un-plan outranked the list for sixty minutes and nothing
// was allowed to argue. Chad, looking at it in the selection pool while RONALD held it: "Why is
// this order still showing unplanned when it's on Ronald Gates in nuvizz." Then: "whatever the
// scan says is the truth."
//
// The discriminator is the route NAME, and it costs nothing. Lag names the OLD route; a re-plan
// names a different one, and can only do so having seen an event AFTER our Save.

test('THE RONALD CASE: the list names a route we did NOT take it off → the scan wins, at once', () => {
  const fresh = freshPlannedOn('RONALD', 6);
  const prior = priorWrite(boardWriteUnplannedFields(mins(40), 'TREVARR'), 40);   // 40 min in — deep inside the old grace
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), false, 'the stamp is not carried forward');
  assert.equal(fresh.isPlanned, true, 'the board takes NuVizz\'s word');
  assert.equal(fresh.loadNbr, 'RONALD');
  assert.equal(fresh.routeSeq, 6);
  assert.equal(fresh.board_write_at, undefined, 'and the stale stamp is dropped, so it cannot hold the NEXT scan either');
});

test('…and it does not wait out the hour: the same rows one minute after the Save release too', () => {
  const fresh = freshPlannedOn('RONALD', 6);
  assert.equal(applyBoardWriteGrace(fresh, priorWrite(boardWriteUnplannedFields(mins(1), 'TREVARR'), 1), NOW), false);
  assert.equal(fresh.loadNbr, 'RONALD');
});

test('THE LAG CASE IS UNTOUCHED: the list still naming the route we removed it from stays held', () => {
  // This is the cancelled-route un-plan (nuvizz-write-cancel-through) and ordinary index lag.
  // Releasing here would put the order back on a route we just emptied.
  const fresh = freshPlannedOn('TREVARR', 4);
  const prior = priorWrite(boardWriteUnplannedFields(mins(3), 'TREVARR'), 3);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), true);
  assert.equal(fresh.isPlanned, false);
  assert.equal(fresh.loadNbr, null);
});

test('a stamp with NO from-route holds, exactly as before — absence of the baseline is not evidence', () => {
  // Rows stamped before v1.8.0, and any caller that had no route in hand. Never guess an order
  // off a route on a missing field.
  const fresh = freshPlannedOn('RONALD', 2);
  const prior = priorWrite(boardWriteUnplannedFields(mins(10)), 10);
  assert.equal(prior.board_write_from, undefined);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), true, 'held by the clock, the old behaviour');
  assert.equal(fresh.isPlanned, false);
});

test('the PLANNED direction is untouched — SEAAGRI/OWUSU keep their protection', () => {
  // A confirmed PLAN against a list that says un-planned still holds; that direction has its own
  // verify (the load-membership ladder) and nothing here may weaken it.
  const fresh = freshUnplanned();
  const prior = priorWrite(boardWritePlannedFields('OWUSU 1', 3, null, mins(30)), 30);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), true);
  assert.equal(fresh.loadNbr, 'OWUSU 1');
  // …and a confirmed plan is never "overtaken" by this rule, whatever the list says.
  assert.equal(unplanStampOvertaken(prior, freshPlannedOn('SOMEWHERE ELSE')), false);
});

test('unplanStampOvertaken: the rule on its own, including what it refuses to answer', () => {
  const stamp = (from) => ({ board_write_planned: false, ...(from ? { board_write_from: from } : {}) });
  assert.equal(unplanStampOvertaken(stamp('TREVARR'), freshPlannedOn('RONALD')), true, 'different route → moved on');
  assert.equal(unplanStampOvertaken(stamp('TREVARR'), freshPlannedOn('trevarr')), false, 'case is not a difference');
  assert.equal(unplanStampOvertaken(stamp('TREVARR'), freshPlannedOn(' TREVARR ')), false, 'nor is whitespace');
  assert.equal(unplanStampOvertaken(stamp('TREVARR'), freshUnplanned()), false, 'the list agrees it is un-planned — nothing to argue');
  assert.equal(unplanStampOvertaken(stamp(), freshPlannedOn('RONALD')), false, 'no baseline → cannot tell');
  assert.equal(unplanStampOvertaken({ board_write_planned: true, board_write_from: 'X' }, freshPlannedOn('RONALD')), false, 'not an un-plan stamp');
  assert.equal(unplanStampOvertaken(null, freshPlannedOn('RONALD')), false);
  assert.equal(unplanStampOvertaken(stamp('TREVARR'), null), false);
});

test('the un-plan stamp records the route the order came OFF', () => {
  const f = boardWriteUnplannedFields('2026-09-10T10:18:15Z', 'TREVARR');
  assert.equal(f.board_write_from, 'TREVARR');
  assert.equal(f.isUnplanned, true);
  assert.equal(f.routeName, null, 'the ROW is still cleared — only the stamp remembers');
  assert.equal(boardWriteUnplannedFields('t', '   ').board_write_from, undefined, 'a blank route is no baseline');
  assert.equal(boardWriteUnplannedFields('t', null).board_write_from, undefined);
});
