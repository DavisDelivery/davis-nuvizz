// test/board-flags-wiring.test.mjs — Board Flags must stay WIRED, not just implemented.
// The rules themselves are tested by executing board-flags.js directly; these pins cover the
// one-line connections in App.jsx that a stale-base merge can silently lose (exactly how the
// last-stop ✕ vanished in v0.54.19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('the detector is computed from the live board with the roster riding along', () => {
  assert.ok(
    /computeBoardFlags\(\{\s*\n?\s*stops, notes, rosterRows: rosterRawRows, servedDate: selectedDate/.test(src),
    'MapScreen no longer computes board flags from stops+notes+roster — the chip has no data source.',
  );
});

test("the hours model knows what time it is — today's board passes nowMin", () => {
  assert.ok(
    /nowMin: now\.getHours\(\) \* 60 \+ now\.getMinutes\(\)/.test(src),
    'the call site must pass nowMin for the today board — without it a route that never left still simulates an 8:00a departure and nothing ever flags.',
  );
  assert.ok(
    /selectedDate === todayLocalYMD\(\)\s*\?\s*\{ nowMin/.test(src),
    'nowMin must be gated to the TODAY board — clamping a tomorrow board to now would be a lie.',
  );
});

test('the chip renders in BOTH pills (desktop and mobile)', () => {
  const n = (src.match(/<BoardFlagsChip /g) || []).length;
  assert.equal(n, 2, `expected the flag chip in the desktop and mobile status pills, found ${n} render site(s)`);
});

test('the panel renders and can open stops', () => {
  const n = (src.match(/<BoardFlagsPanel /g) || []).length;
  assert.equal(n, 2, `expected the panel in both layouts, found ${n}`);
  assert.ok(src.includes('onOpenStop={openFlaggedStop}'), 'panel rows must click through to the stop card');
});

test('a quiet board renders a NEUTRAL chip — silence must stay distinguishable from broken', () => {
  // v0.54.54 hid the chip entirely at zero ("never become furniture"). Chad read the silence
  // as the feature not working — and he was half right: four detector gates were silently
  // zeroing it. The quiet chip opens the panel, whose footer now proves what was checked.
  assert.ok(
    /if \(!flags\) return null;/.test(src) && !/flags\.redCount === 0 && flags\.amberCount === 0\)\) return null;/.test(src),
    'BoardFlagsChip must render at zero counts (gray outline state), not unrender.',
  );
  assert.ok(
    /No flags right now — click to see what was checked/.test(src),
    'the quiet chip must invite the click that reveals the checked/skipped accounting.',
  );
});

test('the panel proves what it looked at and can restore dismissals', () => {
  assert.ok(
    /Watched \{ck\.stops \?\? 0\} open stop/.test(src),
    'the panel footer must state the checked tally — a quiet panel is a claim, not an absence.',
  );
  const n = (src.match(/onRestoreAll=\{restoreDismissedFlags\}/g) || []).length;
  assert.equal(n, 2, `both panels must offer the restore-dismissed path, found ${n}`);
});

test('the mobile panel escapes the backdrop-blur containing block', () => {
  // backdrop-filter creates a containing block: a `fixed` panel nested in the blurred pill
  // anchors to the pill's clipped box, not the viewport, and can render invisible on phones.
  assert.ok(
    /The open panel lives OUTSIDE the backdrop-blur pill/.test(src),
    'the mobile BoardFlagsPanel must stay a sibling of the status pill, never its descendant.',
  );
});

test('the detector never fetches the roster itself (metered on cache miss)', () => {
  // rosterRawRows must only be set inside the routesPanelOn-gated effect that already exists.
  // Anchor on the populate CALL, not the useState declaration (which precedes the gate).
  const idx = src.indexOf('setRosterRawRows(j');
  assert.ok(idx > 0, 'the roster-populate call is gone');
  const before = src.slice(0, idx);
  const gate = before.lastIndexOf('if (!routesPanelOn || !selectedDate) return;');
  assert.ok(gate > 0 && idx - gate < 1500,
    'rosterRawRows must be populated ONLY by the Routes-panel-gated fetch — the flags detector must never initiate a roster fetch of its own.');
});
