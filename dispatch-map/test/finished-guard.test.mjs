// test/finished-guard.test.mjs — FINISHED FREIGHT NEVER TAKES A PLAN STAMP: the rule and its switch.
//
// The rule lives in lib/finished-guard.mts so the three doors that need it — patchBoardPlan, the
// scan's write grace, and the RWB refusal path — read ONE definition and cannot drift from each
// other. These pin the definition; the doors themselves are pinned, incident and all, in
// board-write-finished-guard.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finishedGuardEnabled, isFinishedBoardRow } from '../netlify/functions/lib/finished-guard.mts';

test('the switch is ON by default — no env var, an empty one, an undefined one, no env at all', () => {
  assert.equal(finishedGuardEnabled({}), true);
  assert.equal(finishedGuardEnabled({ BOARD_WRITE_FINISHED_GUARD: '' }), true);
  assert.equal(finishedGuardEnabled({ BOARD_WRITE_FINISHED_GUARD: undefined }), true);
  assert.equal(finishedGuardEnabled(undefined), true);
  assert.equal(finishedGuardEnabled(null), true);
});

test('only an explicit off-word turns it off — any case, stray whitespace tolerated', () => {
  for (const off of ['off', 'OFF', 'Off', '0', 'false', 'FALSE', 'False', 'no', 'NO', ' no ', '\toff\n']) {
    assert.equal(finishedGuardEnabled({ BOARD_WRITE_FINISHED_GUARD: off }), false, JSON.stringify(off));
  }
});

test('a malformed value leaves it ON — a typo in an env var must never silently disable a rule', () => {
  for (const v of ['of', 'disabled', 'nope', 'flase', 'n', 'none', 'off;', 'no!', '1', 'on', 'true', 'yes', 'OFF-please']) {
    assert.equal(finishedGuardEnabled({ BOARD_WRITE_FINISHED_GUARD: v }), true, JSON.stringify(v));
  }
});

test('a delivered, unable-to-deliver or cancelled row is finished, by its normalized status', () => {
  for (const s of ['DELIVERED', 'EXCEPTION', 'CANCELLED', 'delivered', ' Delivered ', 'exception']) {
    assert.equal(isFinishedBoardRow({ stopNbr: '007174583', normalizedStatus: s }), true, s);
  }
});

test('a row whose normalized status was blanked but whose code still says 90/91/80/99 is still finished', () => {
  for (const code of ['90', '91', '80', '99', 90, ' 90 ']) {
    assert.equal(isFinishedBoardRow({ stopNbr: '007174583', status: code, normalizedStatus: null }), true, String(code));
    assert.equal(isFinishedBoardRow({ stopNbr: '007174583', status: code, normalizedStatus: '' }), true, String(code));
    assert.equal(isFinishedBoardRow({ stopNbr: '007174583', status: code }), true, String(code));
  }
});

test('open rows are not finished — un-planned, scheduled, out for delivery, arrived — by status, by code, by either alone', () => {
  for (const [status, norm] of [['10', 'UNPLANNED'], ['20', 'SCHEDULED'], ['30', 'SCHEDULED'], ['40', 'OUT_FOR_DEL'], ['50', 'ARRIVED']]) {
    assert.equal(isFinishedBoardRow({ status, normalizedStatus: norm }), false, `${status}/${norm}`);
    assert.equal(isFinishedBoardRow({ status }), false, status);
    assert.equal(isFinishedBoardRow({ normalizedStatus: norm }), false, norm);
  }
});

test('the un-planned mask itself is never mistaken for finished (the exact shape a strike-off writes)', () => {
  assert.equal(isFinishedBoardRow({
    status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true,
    loadNbr: null, routeName: null, routeSeq: null, driverName: null, driverUserName: null,
    board_write_at: '2026-09-11T09:59:32.983Z', board_write_planned: false, board_write_from: 'AB',
  }), false);
});

test('nothing, null, a bare string, a number and an empty row are not finished', () => {
  for (const v of [undefined, null, '', 'DELIVERED', 90, {}, { stopNbr: 'X' }, { status: '', normalizedStatus: '' }, []]) {
    assert.equal(isFinishedBoardRow(v), false, JSON.stringify(v));
  }
});
