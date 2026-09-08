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
    /const chip = timeMarkChip\(notes\.get\(s\.matchKey\), dayKey\);/.test(src),
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
  assert.ok(/<RestrictionIcon kind=\{mark\.kind\} size=\{isMobile \? 13 : 12\} \/>\{mark\.text\}/.test(src),
    'TimeMarkChip must render mark.text beside the glyph, at both view sizes.');
});

test('the mark is the MAP\'s mark — one rule, not a second one', () => {
  assert.ok(src.includes("import { timeMarkForDay, timeMarkChip, TIME_MARK_KEYS } from './lib/time-marks.js';"),
    'the chip must come from time-marks.js; a locally-derived clock is a second rule that can drift.');
});

test('a hopeless verdict does not get its own close read back to it', () => {
  // "can't make 11:00a" beside "closes 11:00a" is one fact printed twice, and on a phone it
  // wraps the marks line — on exactly the rows whose message matters most.
  assert.ok(
    /const tm = \(tmRaw && pf\?\.late && pf\.hopeless && pf\.closeMin === tmRaw\.closeMin\) \? null : tmRaw;/.test(src),
    'the clock must be suppressed only when the badge already names the SAME minute; '
    + '"30m late" beside "closes 2:00p" is complementary and must survive.',
  );
});
