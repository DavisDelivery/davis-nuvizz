// test/tv-rolls-to-new-day.test.mjs
//
// THE WALL DISPLAY STAYED ON YESTERDAY'S BOARD, AND NOTHING ON IT SAID SO (audit 2026-09-27,
// app-A1-4).
//
// MapScreen picks its board day once, from todayInET(), when the page loads. The wall display
// has no date control and nothing else ever moved that day, so a TV left up Monday night was
// still polling Monday at 6am Tuesday: "updated just now" (the poll succeeds), Monday's
// percent-complete and verdict, and no trucks (live drivers only show for today). The status
// bar printed no date, so the room had no way to tell it was looking at yesterday. Only a
// deploy — which reloads the page — ever put it right.
//
// What happens now: the wall's 30-second clock tick also moves the board to today (ET) when the
// day has turned — the same day a fresh load of /tv would pick — and the status bar prints the
// board date beside the clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tvRollDate } from '../src/lib/tv-mode.js';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('a wall display left up overnight moves to the new board day once midnight ET passes', () => {
  assert.equal(tvRollDate('2026-09-28', '2026-09-29'), '2026-09-29');
  // A TV left up over a long weekend lands on today, not on "the next day".
  assert.equal(tvRollDate('2026-09-25', '2026-09-28'), '2026-09-28');
});

test('a wall display already on today stays put, so the 30s tick does not refetch the board', () => {
  assert.equal(tvRollDate('2026-09-28', '2026-09-28'), null);
});

test('a malformed "today" never moves the wall off the board it is showing', () => {
  for (const bad of [null, undefined, '', 'Invalid Date', '2026-9-28', 20260928]) {
    assert.equal(tvRollDate('2026-09-28', bad), null, `today=${String(bad)}`);
  }
});

test('the wall clock tick rolls the board day, and the status bar says which day it is showing', () => {
  // The 30s tvClock interval is the one timer the wall runs; the roll rides on it.
  const at = APP.indexOf('const [tvClock, setTvClock] = useState(');
  assert.ok(at > 0, 'tvClock state not found');
  const block = APP.slice(at, APP.indexOf('}, [tvMode]);', at));
  assert.match(block, /setInterval\(\(\) => \{[^}]*setTvClock\(Date\.now\(\)\);[^}]*setSelectedDate\(\(d\) => tvRollDate\(d, todayInET\(\)\) \?\? d\)/,
    'the TV clock tick must move selectedDate to today when the day has turned');
  // The TV branch prints the board date in its status bar.
  const tv = APP.slice(APP.indexOf('if (tvMode) {\n    const rail = tvRailRows('), APP.indexOf('{/* ── THE MAP ──'));
  assert.match(tv, /formatDateLong\(selectedDate\)/, 'the TV status bar must print the board date');
});
