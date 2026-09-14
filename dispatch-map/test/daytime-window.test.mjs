// The 8am-5pm delivery day, and which reading of a meridiem-less range matches it.
//
// Chad, 2026-09-14: "fix that rh 1-5 is always going to be pm as you have to imagine our
// delivery window for the most part is 8am - 5pm so no one is going to have those receiving
// hours." These pin the RULE — pick the reading that overlaps the delivery day, and change
// nothing on a tie — rather than the arithmetic that happens to implement it today.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDaytimeWindow, resolveDaytimeOpen, deliveryDayOverlap, overlapMinutes,
  daytimeShiftEnabled, DELIVERY_DAY_OPEN_MIN, DELIVERY_DAY_CLOSE_MIN, DOCK_OPEN_EARLIEST_MIN,
} from '../src/lib/daytime-window.js';

const at = (h, m = 0) => h * 60 + m;
const win = (o, c, hadMeridiem = false) => resolveDaytimeWindow(o, c, hadMeridiem);

test('a dock that receives 1 to 5 means the afternoon, not the small hours', () => {
  const r = win(at(1), at(5));
  assert.equal(r.shifted, true);
  assert.equal(r.openMin, at(13));
  assert.equal(r.closeMin, at(17));
});

test('"2-4" is a 2pm-4pm dock, not a 2am-4am one', () => {
  const r = win(at(2), at(4));
  assert.deepEqual([r.openMin, r.closeMin, r.shifted], [at(14), at(16), true]);
});

test('a half hour survives the shift: "1-4 30" is 1:00p-4:30p', () => {
  const r = win(at(1), at(4, 30));
  assert.deepEqual([r.openMin, r.closeMin], [at(13), at(16, 30)]);
});

test('a genuine morning dock is left alone: "8-12" stays 8:00a-12:00p', () => {
  const r = win(at(8), at(12));
  assert.equal(r.shifted, false);
  assert.deepEqual([r.openMin, r.closeMin], [at(8), at(12)]);
});

test('"9-11" is a morning receiving window and does not move', () => {
  assert.equal(win(at(9), at(11)).shifted, false);
});

test('an early dock that reaches into the delivery day keeps its morning: "5-9"', () => {
  // 5:00a-9:00a overlaps the 8-5 day by an hour; 5:00p-9:00p overlaps by nothing.
  assert.equal(win(at(5), at(9)).shifted, false);
});

test('"6-10" is a real early dock, not a 6pm-10pm one', () => {
  assert.equal(win(at(6), at(10)).shifted, false);
});

test('a tie changes nothing: "6-7" fits the delivery day in neither reading', () => {
  // The reason this is a comparison and not a threshold. A rule that shifted anything
  // ending before 8am would fling a 6-7am dock to the evening on no evidence at all.
  const r = win(at(6), at(7));
  assert.equal(r.shifted, false);
  assert.deepEqual([r.openMin, r.closeMin], [at(6), at(7)]);
});

test('a tie changes nothing: "7-8" stays where it was written', () => {
  assert.equal(win(at(7), at(8)).shifted, false);
});

test('a written meridiem is the customer speaking and is never overruled', () => {
  // "1AM-5AM" is nobody's dock, but guessing over an explicit statement is the v0.54.60
  // "CLOSES AT 4" regression, and we do not do it again.
  const r = win(at(1), at(5), true);
  assert.equal(r.shifted, false);
  assert.deepEqual([r.openMin, r.closeMin], [at(1), at(5)]);
});

test('a shift that would cross midnight is refused rather than wrapped', () => {
  const r = win(at(11), at(13));
  assert.equal(r.shifted, false);
});

test('a backwards or equal window is left to the caller’s own rescue', () => {
  assert.equal(win(at(7), at(3)).shifted, false);
  assert.equal(win(at(9), at(9)).shifted, false);
});

test('malformed input never throws and never invents a window', () => {
  for (const [o, c] of [[NaN, at(5)], [at(1), NaN], [undefined, undefined], [null, null]]) {
    const r = resolveDaytimeWindow(o, c, false);
    assert.equal(r.shifted, false);
  }
});

test('the delivery day is the 8am-5pm one Chad described', () => {
  assert.equal(DELIVERY_DAY_OPEN_MIN, at(8));
  assert.equal(DELIVERY_DAY_CLOSE_MIN, at(17));
});

test('overlap arithmetic never goes negative for windows that miss each other', () => {
  assert.equal(overlapMinutes(at(1), at(5), at(8), at(17)), 0);
  assert.equal(overlapMinutes(at(20), at(23), at(8), at(17)), 0);
  assert.equal(deliveryDayOverlap(at(13), at(17)), 240);
  assert.equal(deliveryDayOverlap(at(9), at(11)), 120);
});

test('HOURS_PM_SHIFT=off puts the old dawn reading back, one switch for both parsers', () => {
  const off = resolveDaytimeWindow(at(1), at(5), false, { HOURS_PM_SHIFT: 'off' });
  assert.equal(off.shifted, false);
  assert.deepEqual([off.openMin, off.closeMin], [at(1), at(5)]);
});

test('a malformed switch value leaves the rule ON, never silently disabled', () => {
  for (const v of ['', 'yes', 'ON', 'true', 'banana', undefined]) {
    assert.equal(daytimeShiftEnabled({ HOURS_PM_SHIFT: v }), true, `HOURS_PM_SHIFT=${v}`);
  }
  for (const v of ['off', '0', 'false', 'no', 'OFF', ' Off ']) {
    assert.equal(daytimeShiftEnabled({ HOURS_PM_SHIFT: v }), false, `HOURS_PM_SHIFT=${v}`);
  }
});

test('VITE_HOURS_PM_SHIFT=off reverts the browser side too, so the two parsers agree', () => {
  const off = resolveDaytimeWindow(at(1), at(5), false, { VITE_HOURS_PM_SHIFT: 'off' });
  assert.equal(off.shifted, false);
  assert.equal(daytimeShiftEnabled({ VITE_HOURS_PM_SHIFT: 'off' }), false);
  assert.equal(daytimeShiftEnabled({ VITE_HOURS_PM_SHIFT: 'banana' }), true);
});

// ── a lone open has no second number to reason from, so it gets a floor ────────────────

test('"OPENS AT 1" is one in the afternoon — a 1am open is no constraint on the solver', () => {
  const r = resolveDaytimeOpen(at(1), false);
  assert.deepEqual([r.openMin, r.shifted], [at(13), true]);
});

test('a dock that opens at 12 opens at NOON, not midnight', () => {
  // The AM rule maps hour 12 to 0, so "OPENS AT 12" produced a window starting at 00:00.
  assert.deepEqual(resolveDaytimeOpen(0, false).openMin, at(12));
});

test('early docks are ordinary and keep their mornings: 5, 6 and 7 do not move', () => {
  for (const h of [5, 6, 7, 8, 11]) {
    assert.equal(resolveDaytimeOpen(at(h), false).shifted, false, `${h}:00 should not move`);
  }
});

test('1 through 4 in the morning is not a dock opening, so those shift', () => {
  for (const h of [1, 2, 3, 4]) {
    assert.equal(resolveDaytimeOpen(at(h), false).openMin, at(h + 12), `${h}:00`);
  }
});

test('a written meridiem on a lone open is never overruled', () => {
  assert.equal(resolveDaytimeOpen(at(1), true).shifted, false);
});

test('the earliest a dock opens is the 5:00a the bare-pair tier already used', () => {
  assert.equal(DOCK_OPEN_EARLIEST_MIN, at(5));
});

test('the switch reverts the lone-open rule too, not just the range rule', () => {
  assert.equal(resolveDaytimeOpen(at(1), false, { HOURS_PM_SHIFT: 'off' }).shifted, false);
});
