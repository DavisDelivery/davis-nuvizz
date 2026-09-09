// The clock on a Compare row — timeMarkChip.
//
// Chad, looking at a Compare card: "i think there is enough space there to fit our clock
// icons if one applies to a given stop."
//
// The rule these tests protect is the one the map already lives by: a mark has to change
// what the router DOES. A dock open a full working day says nothing here either, and the
// mark that DOES appear has to name the edge that binds and the time it binds at — an icon
// alone is unreadable on a phone, where there is no hover to reveal a title=.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timeMarkChip } from '../src/lib/time-marks.js';

const typed = (open, close) => ({
  receiving_hours: { fri: { open, close } },
  manual_overrides: { receiving_hours: true },
});

// ── the silence ──────────────────────────────────────────────────────────────

test('an ordinary 7a-4p dock gets NO chip — the row stays clean', () => {
  assert.equal(timeMarkChip(typed('7:00', '16:00'), 'fri'), null);
});

test('no note, no day, and free-text hours all yield nothing rather than a guess', () => {
  assert.equal(timeMarkChip(null, 'fri'), null);
  assert.equal(timeMarkChip(typed('7:00', '16:00'), null), null);
  // "call ahead" is not a clock and must never be regexed into one.
  assert.equal(timeMarkChip({ receiving_hours: { fri: 'call ahead' } }, 'fri'), null);
});

test('a stop with hours on ANOTHER day is silent on this one', () => {
  assert.equal(timeMarkChip(typed('6:00', '11:00'), 'wed'), null,
    'the chip reads the BOARD day; a Friday-only close must not ride Wednesday rows');
});

// ── the four marks, and the clock each one prints ────────────────────────────

test('a dock that shuts by noon prints its CLOSE — that is the deadline', () => {
  const c = timeMarkChip(typed('6:00', '11:00'), 'fri');
  assert.equal(c.kind, 'hours_shuts_early');
  assert.equal(c.text, 'closes 11:00a');
  assert.equal(c.title, 'Receiving 6:00a–11:00a');
});

test('an early close prints the close, not the open', () => {
  const c = timeMarkChip(typed('8:00', '14:00'), 'fri');
  assert.equal(c.kind, 'hours_early_close');
  assert.equal(c.text, 'closes 2:00p');
});

test('a dock that opens at nine prints its OPEN — it cannot lead the route', () => {
  const c = timeMarkChip(typed('9:00', '17:00'), 'fri');
  assert.equal(c.kind, 'hours_opens_late');
  assert.equal(c.text, 'opens 9:00a');
});

test('a dawn dock reports the good news at the end it is good at', () => {
  const c = timeMarkChip(typed('6:00', '17:00'), 'fri');
  assert.equal(c.kind, 'hours_extra_room');
  assert.equal(c.text, 'opens 6:00a');
});

test('a dock still taking freight at six reports the LATE edge', () => {
  const c = timeMarkChip(typed('8:00', '19:00'), 'fri');
  assert.equal(c.kind, 'hours_extra_room');
  assert.equal(c.text, 'open to 7:00p', 'the open is ordinary here — the close is the room');
});

// ── the legacy string form, which is most of the real docs ───────────────────

test('the legacy "6AM-2PM" range string still produces a chip', () => {
  const c = timeMarkChip({ receiving_hours: { fri: '6AM-2PM' } }, 'fri');
  assert.equal(c.kind, 'hours_early_close');
  assert.equal(c.text, 'closes 2:00p');
});

// ── the half-stated window ───────────────────────────────────────────────────

test('an open with no close states only the half on file', () => {
  // "RECEIVING AFTER 10AM" — a real constraint with no closing time behind it. The tooltip
  // may not invent the other edge; "10:00a–" would be a window we made up.
  const c = timeMarkChip({ receiving_hours: { fri: { open: '10:00' } } }, 'fri');
  assert.equal(c.kind, 'hours_opens_late');
  assert.equal(c.text, 'opens 10:00a');
  assert.equal(c.title, 'Receiving opens 10:00a');
});

test('every chip names a real clock — no branch can print "closes null"', () => {
  const cases = [
    typed('6:00', '11:00'), typed('8:00', '14:00'), typed('9:00', '17:00'),
    typed('6:00', '17:00'), typed('8:00', '19:00'),
    { receiving_hours: { fri: { open: '10:00' } } },
    { receiving_hours: { fri: '6AM-2PM' } },
  ];
  for (const note of cases) {
    const c = timeMarkChip(note, 'fri');
    assert.ok(c, 'expected a chip');
    assert.doesNotMatch(c.text, /null|NaN|undefined/, `bad clock in "${c.text}"`);
    assert.doesNotMatch(c.title, /null|NaN|undefined/, `bad window in "${c.title}"`);
  }
});
