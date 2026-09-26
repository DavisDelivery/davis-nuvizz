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

// ── AUTO-DETECTED HOURS SHOW TOO, MARKED (Chad, 2026-09-25) ──────────────────────────────────
// "why are titan electrics hours not displayed in the compare panel" → "yes i want the proposed
// fix". TITAN ELECTRIC's 7:00a–3:30p came from Uline's order text ("RH 7AM-3 30PM"), so the row
// said "11M LATE" with no window beside it.
import { compareAutoHoursEnabled } from '../src/lib/time-marks.js';

const TITAN = { receiving_hours: { fri: { open: '07:00', close: '15:30' } } };                 // auto
const WINSTED = { receiving_hours: { fri: { open: '06:00', close: '15:00' } } };               // auto, classified
const TITAN_TYPED = { ...TITAN, manual_overrides: { receiving_hours: true } };

test('TITAN ELECTRIC: auto hours get a chip on the Compare row, marked auto', () => {
  const chip = timeMarkChip(TITAN, 'fri', { autoHours: true });
  assert.ok(chip, 'the row must show the window it says the stop is late against');
  assert.equal(chip.text, '7:00a–3:30p');
  assert.equal(chip.auto, true);
  assert.match(chip.title, /read from the order text/);
});

test('an auto window the map already marks keeps its mark, and now says it is auto', () => {
  const chip = timeMarkChip(WINSTED, 'fri', { autoHours: true });
  assert.equal(chip.kind, 'hours_runs_early');
  assert.equal(chip.text, '6:00a–3:00p');
  assert.equal(chip.auto, true);
});

test('typed hours never say auto', () => {
  const chip = timeMarkChip(TITAN_TYPED, 'fri', { autoHours: true });
  assert.equal(chip.text, '7:00a–3:30p');
  assert.equal(chip.auto, undefined);
  assert.match(chip.title, /set by a dispatcher/);
});

test('switch off: exactly the typed-only row it was before', () => {
  assert.equal(timeMarkChip(TITAN, 'fri'), null);
  assert.equal(timeMarkChip(TITAN, 'fri', { autoHours: false }), null);
  const winsted = timeMarkChip(WINSTED, 'fri');
  assert.equal(winsted.kind, 'hours_runs_early');
  assert.equal(winsted.auto, undefined, 'no marker at all with the switch off');
  assert.doesNotMatch(winsted.title, /order text/);
});

test('the map pin rule is untouched by any of this', () => {
  assert.equal(timeMarkForDay(TITAN, 'fri'), null);
});

test('VITE_COMPARE_AUTO_HOURS: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(compareAutoHoursEnabled({}), true);
  assert.equal(compareAutoHoursEnabled(undefined), true);
  for (const v of ['off', 'OFF', '0', 'false', 'no']) assert.equal(compareAutoHoursEnabled({ VITE_COMPARE_AUTO_HOURS: v }), false, v);
  for (const v of ['offf', 'on', '1', '', 'nope']) assert.equal(compareAutoHoursEnabled({ VITE_COMPARE_AUTO_HOURS: v }), true, v);
});

test('the Compare row passes the switch, and draws the auto marker', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /timeMarkChip\(notes\.get\(s\.matchKey\), dayKey, \{ autoHours: COMPARE_AUTO_HOURS_ON \}\)/);
  assert.match(src, /\{mark\.auto && <span className="font-normal text-slate-400">&nbsp;· auto<\/span>\}/);
});
