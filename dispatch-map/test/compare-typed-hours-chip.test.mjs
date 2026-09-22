// TYPED HOURS SHOW ON A COMPARE ROW, HOWEVER ORDINARY THE WINDOW LOOKS.
//
// Chad, 2026-09-22, with AMERICAS VALUE CHANNEL wearing a chip on NOR 2 and INTUITIVE
// SURGICAL — "Set by a dispatcher", 8:00a-3:30p — wearing nothing:
//   "if we have put the hours in they should be flagging in the compare panel like
//    americas value channel"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  timeMarkChip, classifyTimeMark, timeMarkForDay, hoursTypedByDispatcher,
  HOURS_ON_FILE_KEY, TIME_MARK_KEYS,
} from '../src/lib/time-marks.js';

const win = (open, close, typed) => ({
  receiving_hours: { mon: { open, close } },
  ...(typed ? { manual_overrides: { receiving_hours: true } } : {}),
});

// The two real stops off Chad's screenshot, by their real windows.
const AVC = win('11:00', '16:00', true);            // AMERICAS VALUE CHANNEL
const INTUITIVE = win('08:00', '15:30', true);      // INTUITIVE SURGICAL, typed
const INTUITIVE_PARSED = win('08:00', '15:30', false);

test('THE BUG: an 8:00a-3:30p dock a dispatcher typed used to show nothing', () => {
  // The classifier is right and unchanged — 3:30p is later than the 3:00p early-close dial
  // and 8:00a is earlier than the 9:00a opens-late one, so no MAP mark applies.
  assert.equal(classifyTimeMark(8 * 60, 15 * 60 + 30), null);
  assert.equal(timeMarkForDay(INTUITIVE, 'mon'), null);
  // ...and the Compare row now says it anyway.
  const chip = timeMarkChip(INTUITIVE, 'mon');
  assert.ok(chip, 'a dispatcher-typed window must reach the Compare row');
  assert.equal(chip.kind, HOURS_ON_FILE_KEY);
  assert.equal(chip.text, '8:00a–3:30p');
  assert.match(chip.title, /set by a dispatcher/);
});

test('AMERICAS VALUE CHANNEL is untouched — it keeps the mark it already had', () => {
  const chip = timeMarkChip(AVC, 'mon');
  assert.equal(chip.kind, 'hours_narrow_window');
  assert.equal(chip.text, '11:00a–4:00p');
});

test('PARSED hours stay quiet — this is about hours WE put in', () => {
  // A much larger population and a different confidence. Widening to it is Chad's call.
  assert.equal(timeMarkChip(INTUITIVE_PARSED, 'mon'), null);
});

test('THE MAP IS NOT TOUCHED — no pin can wear this kind', () => {
  assert.equal(timeMarkForDay(INTUITIVE, 'mon'), null, 'the pin rule must still say nothing');
  assert.ok(!TIME_MARK_KEYS.includes(HOURS_ON_FILE_KEY), 'the chip key must stay out of the pin vocabulary');
});

test('and it is out of the map Legend, which only describes paint', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /LEGEND_EXCLUDED = new Set\(\[[^\]]*'hours_on_file'/);
});

test('but it HAS an icon, or the row would render the unknown glyph', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /^ {2}hours_on_file: \{/m, 'RESTRICTION_ICONS needs the key the chip returns');
});

test('a typed note with only one edge on file states that edge and invents nothing', () => {
  const closeOnly = { receiving_hours: { mon: { close: '15:30' } }, manual_overrides: { receiving_hours: true } };
  const chip = timeMarkChip(closeOnly, 'mon');
  assert.ok(chip);
  assert.equal(chip.text, 'closes 3:30p');
  assert.equal(chip.openMin, null);
});

test('a typed note with NO hours at all is still nothing — the flag is not the window', () => {
  assert.equal(timeMarkChip({ manual_overrides: { receiving_hours: true } }, 'mon'), null);
  assert.equal(timeMarkChip({ manual_overrides: { receiving_hours: true }, receiving_hours: {} }, 'mon'), null);
});

test('the day asked for is the BOARD\'s day, not whatever day has hours', () => {
  assert.ok(timeMarkChip(INTUITIVE, 'mon'));
  assert.equal(timeMarkChip(INTUITIVE, 'sat'), null, 'Saturday has no window on this note');
});

test('absent, empty and malformed notes never throw and never invent a chip', () => {
  for (const n of [null, undefined, {}, { manual_overrides: null }, { receiving_hours: null }, 'nonsense', 7]) {
    assert.equal(timeMarkChip(n, 'mon'), null, String(n));
  }
  assert.equal(timeMarkChip(INTUITIVE, null), null);
});

test('hoursTypedByDispatcher reads ownership, not the presence of hours', () => {
  assert.equal(hoursTypedByDispatcher(INTUITIVE), true);
  assert.equal(hoursTypedByDispatcher(INTUITIVE_PARSED), false);
  // Only the literal true counts — the same test board-flags uses for its 'typed' tier.
  assert.equal(hoursTypedByDispatcher({ manual_overrides: { receiving_hours: 'yes' } }), false);
  assert.equal(hoursTypedByDispatcher({ manual_overrides: { receiving_hours: 1 } }), false);
  assert.equal(hoursTypedByDispatcher(null), false);
});
