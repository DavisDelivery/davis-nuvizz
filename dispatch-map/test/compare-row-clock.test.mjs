// The Compare row's clock must stay WIRED, not just implemented.
//
// The rule itself is executed in time-mark-chip.test.mjs; these pins cover the one-line
// connections in App.jsx that a stale-base merge silently loses — exactly how the last-stop
// ✕ vanished in v0.54.19, and why board-flags-wiring.test.mjs exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('the chip has a data source: notes + the BOARD day reach both workbench views', () => {
  const n = (src.match(/notes=\{notes\} dayKey=\{weekdayKeyFromDate\(selectedDate\)\}/g) || []).length;
  assert.equal(n, 2, `expected the mobile AND desktop RoutingWorkbench to pass notes+dayKey, found ${n}`);
  assert.ok(
    // v1.68.3 (Chad approved auto hours on the row) added the switch argument; the data source is unchanged.
    /const chip = timeMarkChip\(notes\.get\(s\.matchKey\), dayKey, \{ autoHours: COMPARE_AUTO_HOURS_ON \}\);/.test(src),
    'the card must resolve each row\'s note by matchKey — the same key the map draws from.',
  );
});

test('the clock renders on the marks line AND in the expanded detail', () => {
  assert.ok(/<TimeMarkChip mark=\{tm\} isMobile=\{isMobile\} \/>/.test(src),
    'the row lost its clock.');
  // The clock shares the badge's line and must NOT be folded into the city line: measured on a
  // 320px card, a chip there cut "CARTERSVILLE · 6 sk · 8 loose" to "CARTERSVILLE · 6 …".
  assert.ok(/\{\(pf\?\.late \|\| tm\) && \(/.test(src),
    'the marks line must render when EITHER a verdict or a constraint exists.');
  assert.ok(/\{!isExp && <div className="truncate text-slate-500">\{\[s\.city, `\$\{Number\(s\.cartons\)/.test(src),
    'the city/skids/loose line must keep the whole row width — the clock lives above it.');
  assert.ok(/\{tmRaw && \(\s*\n\s*<div className="flex items-center gap-1 text-slate-600">/.test(src),
    'expanding a stop hides the city line, so the window must restate itself in the detail — '
    + 'and from the UNSUPPRESSED mark, so the hours are still there to read.');
});

test('the row prints the TIME, never the icon alone', () => {
  // v0.54.83 found four values reachable only through a title= tooltip, which a touch
  // device never shows. A clock face with no clock on it is the fifth.
  // v1.68.3: the icon's hover title is now the chip's own (typed vs read from the order); the text still sits beside it.
  assert.ok(/<RestrictionIcon kind=\{mark\.kind\} size=\{isMobile \? 13 : 12\} title=\{mark\.title\} \/>\{mark\.text\}/.test(src),
    'TimeMarkChip must render mark.text beside the glyph, at both view sizes.');
});

test('the mark is the MAP\'s mark — one rule, not a second one', () => {
  // v1.85.1 added the can't-make hours line's helper and switch to the same import.
  assert.ok(src.includes("import { timeMarkForDay, timeMarkChip, TIME_MARK_KEYS, compareAutoHoursEnabled, unreachableHoursMark, compareUnreachableHoursEnabled } from './lib/time-marks.js';"),
    'the chip must come from time-marks.js; a locally-derived clock is a second rule that can drift.');
});

// REWRITTEN 2026-09-28 on Chad's call, recorded rather than quietly absorbed. This used to pin
// that a hopeless row DROPS its clock when the verdict names the same close ("the same clock
// twice is noise"). Chad, with MCKESSON and GENESIS reading "CAN'T MAKE" and no hours anywhere:
// "the hours are not listed on the card why?" — then "make it 2 rows on the card one with the
// hours and 2 with can't make 12 or whatever". The hours now keep their own line, as the WHOLE
// window (lib/time-marks.js unreachableHoursMark, executed in time-marks-unreachable-hours.test.mjs),
// and VITE_COMPARE_UNREACHABLE_HOURS=off puts back exactly the old suppression.
test('a hopeless verdict gets the hours on their own line above it; switch off → the old suppression', () => {
  assert.ok(
    /const hoursLine = \(COMPARE_UNREACHABLE_HOURS_ON && tmRaw && pf\?\.late && pf\.hopeless\) \? unreachableHoursMark\(tmRaw\) : null;/.test(src),
    'a can\'t-make row with hours on file must get its hours line — from the UNSUPPRESSED mark.',
  );
  assert.ok(
    /const tm = hoursLine \? null : \(tmRaw && pf\?\.late && pf\.hopeless && pf\.closeMin === tmRaw\.closeMin\) \? null : tmRaw;/.test(src),
    'with the hours on their own line the marks line carries the verdict alone; with the switch off, the clock is '
    + 'still suppressed only when the badge names the SAME minute — "30m late" beside "closes 2:00p" must survive.',
  );
  const hours = src.indexOf('<TimeMarkChip mark={hoursLine} isMobile={isMobile} />');
  const badge = src.indexOf('<PreflightStopBadge v={pf} isMobile={isMobile} />');
  assert.ok(hours > 0 && badge > hours, 'two lines, in Chad\'s order: the hours first, then "can\'t make".');
});
