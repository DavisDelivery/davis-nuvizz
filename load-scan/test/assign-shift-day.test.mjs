// assign-shift-day.test.mjs — the trucks on the Assign tab are the trucks of the
// shift its taps are saved to.
//
// AssignScreen kept its OWN shift day (shiftDayString(), rolling at 8pm) and
// saved every tap under it, but listed the trucks of the Activity panel's board,
// which was read for a different date — the ET calendar day by default, or
// whatever the date box said. Between 8pm and midnight, or after one tap on the
// ‹ › arrows, a dispatcher handed out one day's trucks into another day's
// assignment doc, and the loader's phone (which reads the shift day) never saw
// them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { assignView } from '../src/lib/assign-day.js';

const board = (date, loadNbrs) => ({ date, loads: loadNbrs.map((loadNbr) => ({ loadNbr })) });

test('at 9pm the Assign tab lists the trucks of the shift its taps are saved to', () => {
  const v = assignView(board('2026-09-15', ['TUE-1', 'TUE-2']), '2026-09-15');
  assert.equal(v.shiftDay, '2026-09-15');
  assert.deepEqual(v.loads.map((l) => l.loadNbr), ['TUE-1', 'TUE-2']);
});

test('stepping to the next shift never offers the previous shift\'s trucks while its board loads', () => {
  // The ‹ › arrows moved the day; the board in hand is still Tuesday's.
  const v = assignView(board('2026-09-15', ['TUE-1']), '2026-09-16');
  assert.equal(v.shiftDay, '2026-09-16', 'taps would be saved to Wednesday');
  assert.equal(v.loads, null, 'so Tuesday\'s trucks must not be tappable — nothing is, until Wednesday\'s arrive');
});

test('a cleared date box falls back to the day the board actually answered for', () => {
  const v = assignView(board('2026-09-15', ['TUE-1']), '');
  assert.equal(v.shiftDay, '2026-09-15');
  assert.equal(v.loads.length, 1);
});

test('no board yet: no day to save to and no trucks', () => {
  assert.deepEqual(assignView(null, ''), { shiftDay: '', loads: null });
  assert.deepEqual(assignView(null, '2026-09-15'), { shiftDay: '2026-09-15', loads: null });
});

test('the Assign tab has ONE day, and it is the Activity panel\'s', async () => {
  const assign = await readFile(new URL('../src/AssignScreen.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(assign, /useState\(shiftDayString\(\)\)/, 'no private shift day of its own');
  assert.match(assign, /onShiftDay\(addDays\(shiftDay, -1\)\)/, '‹ moves the shared day');
  assert.match(assign, /onShiftDay\(addDays\(shiftDay, 1\)\)/, '› moves the shared day');

  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const panel = app.slice(app.indexOf('function DayPanel'));
  const tag = panel.slice(panel.indexOf('<AssignScreen'), panel.indexOf('/>', panel.indexOf('<AssignScreen')));
  assert.match(tag, /onShiftDay=\{onDate\}/, 'the arrows move the board read too');
  assert.match(tag, /shiftDay=\{assign\.shiftDay\}/);
  assert.match(tag, /loads=\{assign\.loads\}/);
});
