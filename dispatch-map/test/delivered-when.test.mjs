// WHICH DAY DID IT ACTUALLY DELIVER?
//
// Chad, on the Flag history table for 2026-08-26: "Want this to show date it actually
// delivered." The column rendered minutes past midnight, which has no day in it.
//
// The rows marked "verbatim" are real, pulled from eta_flag_history through the read
// endpoint. The rows marked "constructed" are the shapes the scorer will write from
// v0.81.2 onward and could not write before it — a roll had no delivery date recorded at
// all, so there is no historical example to quote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveredWhen, stampParts, dayLabel, dayGap } from '../src/lib/delivered-when.js';

const BOARD = '2026-08-25';

// Verbatim from eta_flag_history/davis__2026-08-25.
const MADE = {
  stopNbr: '007166784', customer: 'SHOPY SERVICES LLC',
  closeMin: 690, arrivalMin: 642, deliveredAt: '2026-08-25T10:42:00', outcome: 'made',
};
const MISSED = {
  stopNbr: '007167152', customer: 'CHATTAHOOCHEE NATURE CENTER',
  closeMin: 1020, arrivalMin: 1028, deliveredAt: '2026-08-25T17:08:00', outcome: 'missed',
};
// Verbatim, and this is the defect: rolled, and not one field on it says when or where.
const ROLLED_AS_STORED = {
  stopNbr: 'ESTES-1171127388', customer: 'CARSON WEST',
  closeMin: 1020, arrivalMin: null, deliveredAt: null, outcome: 'rolled',
};
const UNDELIVERED = {
  stopNbr: 'AVRT-0928116742', customer: 'DC5/ HEADRICK INSULATION',
  closeMin: 1020, arrivalMin: null, deliveredAt: null, outcome: 'undelivered',
};

test('a stop that delivered on the board’s own day says so, and the time is unchanged', () => {
  const w = deliveredWhen(MADE, { boardDate: BOARD });
  assert.equal(w.minutes, 642);          // exactly what the column showed before
  assert.equal(w.minutes, MADE.arrivalMin);
  assert.equal(w.tone, 'same');
  assert.equal(w.note, 'Aug 25');
});

test('a missed stop is dated too — the column is not only about rolls', () => {
  const w = deliveredWhen(MISSED, { boardDate: BOARD });
  assert.equal(w.minutes, 1028);
  assert.equal(w.note, 'Aug 25');
  assert.equal(w.tone, 'same');
});

test('THE DEFECT: a rolled row as stored today has no date, and we do not invent one', () => {
  // 11 of 11 rolled rows across the six scored days look exactly like this.
  const w = deliveredWhen(ROLLED_AS_STORED, { boardDate: BOARD });
  assert.equal(w.minutes, null);
  assert.equal(w.tone, 'missing');
  assert.equal(w.note, 'roll date not recorded');
  assert.doesNotMatch(w.note, /Aug 25/);   // never the day being looked at
});

test('THE FIX: a rolled row the scorer has dated shows the day it actually landed', () => {
  // Constructed — the shape scoreRow writes once the later board's stamp survives.
  const w = deliveredWhen(
    { ...ROLLED_AS_STORED, rolledDeliveredAt: '2026-08-26T09:12:00', rolledOnDate: '2026-08-26' },
    { boardDate: BOARD },
  );
  assert.equal(w.minutes, 9 * 60 + 12);
  assert.equal(w.tone, 'later');
  assert.equal(w.note, 'Aug 26 (next day)');
});

test('rolled onto a later board but not delivered there is NOT a delivery', () => {
  // Present on a board is not delivered off it. This is freight still sitting there.
  const w = deliveredWhen(
    { ...ROLLED_AS_STORED, rolledDeliveredAt: null, rolledOnDate: '2026-08-26' },
    { boardDate: BOARD },
  );
  assert.equal(w.minutes, null);
  assert.equal(w.tone, 'open');
  assert.equal(w.note, 'still open Aug 26');
});

test('a Friday roll that landed Monday says three days, not "next day"', () => {
  // Davis does not run Saturday, so the settling board for a Friday flag is Monday. Calling
  // that "next day" would understate a three-day hold to whoever has to phone the customer.
  const w = deliveredWhen(
    { ...ROLLED_AS_STORED, outcome: 'rolled', rolledDeliveredAt: '2026-08-24T11:05:00', rolledOnDate: '2026-08-24' },
    { boardDate: '2026-08-21' },
  );
  assert.equal(w.tone, 'later');
  assert.equal(w.note, 'Aug 24 (3 days later)');
});

test('never delivered shows nothing at all — the Outcome column is where that is said', () => {
  assert.equal(deliveredWhen(UNDELIVERED, { boardDate: BOARD }), null);
});

test('a graded time with no stamp behind it says the DATE is not recorded', () => {
  // Rows scored before deliveredAt was kept. Captioning that time with the board's date
  // would be presenting a guess as an observation.
  const w = deliveredWhen({ outcome: 'made', arrivalMin: 672, deliveredAt: null }, { boardDate: BOARD });
  assert.equal(w.minutes, 672);
  assert.equal(w.tone, 'missing');
  assert.equal(w.note, 'date not recorded');
});

test('a stamp dated to another day is called out, not quietly captioned with the board day', () => {
  // stampMin picks `at` from whichever of arrivalDTTM/deliveredDTTM anchored the minutes, and
  // before v0.81.2 it could hand back the other one — which can carry a different date. If
  // that ever lands in the store, the cell must say so rather than print the board's date.
  const w = deliveredWhen(
    { outcome: 'made', arrivalMin: 642, deliveredAt: '2026-08-24T10:42:00' },
    { boardDate: BOARD },
  );
  assert.equal(w.tone, 'later');
  assert.match(w.note, /^Aug 24/);
});

// ── THE NAIVE-STAMP TRAP ─────────────────────────────────────────────────────
// deliveredDTTM has no offset. Netlify runs UTC, so `new Date(stamp)` formatted in Eastern
// shifts it back 4-5 hours and anything before ~5am lands on the PREVIOUS DAY. That bug has
// already shipped once in this repo (customer-comms). A column whose whole job is the right
// date must not be where it ships again.
test('a 12:30am delivery stays on its own day', () => {
  const w = deliveredWhen(
    { outcome: 'made', arrivalMin: 30, deliveredAt: '2026-08-25T00:30:00' },
    { boardDate: BOARD },
  );
  assert.equal(w.note, 'Aug 25');
  assert.equal(w.tone, 'same');
  assert.equal(w.minutes, 30);
});

test('a 4:15am delivery keeps its own day AND its own clock', () => {
  // The date survives a UTC misread at 4:15am in August (04:15Z is still the 25th in ET), so
  // this one is here for the TIME: parsing the naive stamp would render it as 12:15a.
  const w = deliveredWhen(
    { outcome: 'made', arrivalMin: 255, deliveredAt: '2026-08-25T04:15:00' },
    { boardDate: BOARD },
  );
  assert.equal(w.note, 'Aug 25');
  assert.equal(w.tone, 'same');
  assert.equal(w.minutes, 4 * 60 + 15);
});

test('a roll across New Year carries the year, so "Jan 2" cannot read as ten months ago', () => {
  const w = deliveredWhen(
    { outcome: 'rolled', rolledDeliveredAt: '2027-01-02T08:00:00', rolledOnDate: '2027-01-02' },
    { boardDate: '2026-12-31' },
  );
  assert.equal(w.note, 'Jan 2, 2027 (2 days later)');
});

// ── EMPTY, ABSENT, MALFORMED ─────────────────────────────────────────────────
test('junk in gets nothing out, never a crash and never a date', () => {
  assert.equal(deliveredWhen(null, { boardDate: BOARD }), null);
  assert.equal(deliveredWhen(undefined, { boardDate: BOARD }), null);
  assert.equal(deliveredWhen('nope', { boardDate: BOARD }), null);
  assert.equal(deliveredWhen({ outcome: 'made' }, { boardDate: BOARD }), null);
  // A stamp that is not a stamp falls through to the minutes, not to a fabricated day.
  const w = deliveredWhen({ outcome: 'made', arrivalMin: 600, deliveredAt: 'sometime tuesday' }, { boardDate: BOARD });
  assert.equal(w.note, 'date not recorded');
});

test('an out-of-range clock is refused rather than wrapped', () => {
  assert.equal(stampParts('2026-08-25T25:00'), null);
  assert.equal(stampParts('2026-08-25T10:75'), null);
  assert.equal(stampParts(''), null);
  assert.equal(stampParts(null), null);
  assert.deepEqual(stampParts('2026-08-25 10:42'), { date: '2026-08-25', hh: 10, mm: 42, minutes: 642 });
});

test('midnight is a real time, not a falsy one', () => {
  // 0 minutes past midnight is finite and valid; a truthiness test would drop it.
  const w = deliveredWhen({ outcome: 'made', arrivalMin: 0, deliveredAt: null }, { boardDate: BOARD });
  assert.equal(w.minutes, 0);
  assert.equal(w.tone, 'missing');
});

test('with no board date to compare against, nothing is claimed about difference', () => {
  const w = deliveredWhen(MADE, {});
  assert.equal(w.tone, 'same');
  assert.equal(w.note, 'Aug 25');
});

test('day arithmetic is on the digits, so no timezone can roll it', () => {
  assert.equal(dayGap('2026-08-25', '2026-08-26'), 1);
  assert.equal(dayGap('2026-03-07', '2026-03-09'), 2);   // spans the US DST change
  assert.equal(dayGap('2026-12-31', '2027-01-02'), 2);
  assert.equal(dayGap('2026-08-25', 'nope'), null);
  assert.equal(dayLabel('2026-08-25', '2026-08-25'), 'Aug 25');
  assert.equal(dayLabel('2026-13-01', '2026-08-25'), null);
  assert.equal(dayLabel('', '2026-08-25'), null);
});
