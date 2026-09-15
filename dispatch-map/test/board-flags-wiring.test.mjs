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

test('the chip renders on the Map (desktop + mobile) AND on Routing', () => {
  const n = (src.match(/<BoardFlagsChip /g) || []).length;
  assert.equal(n, 3, `expected the flag chip in the Map's two pills and the Routing overlay, found ${n} render site(s)`);
});

test('the panel renders and can open stops', () => {
  const n = (src.match(/<BoardFlagsPanel /g) || []).length;
  assert.equal(n, 3, `expected the panel in all three layouts, found ${n}`);
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
  assert.equal(n, 3, `all three panels must offer the restore-dismissed path, found ${n}`);
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

// ── v1.32.0 — THE PANEL DROPS DOWN THE MAP'S RIGHT EDGE, AND PUSHES WHAT IS UNDER IT ──
//
// Chad: "i want to take the stops and flag card and move to edge of map so when the flags
// drop down they come down the right side of map and the buttons that are underneath drop
// down below the flags drop down." The buttons only move for a FLOW SIBLING, which is the
// property these pins protect: the geometry itself is measured in a real browser by
// scripts/verify-routing-topbar.mjs, and these catch the wiring mistakes that put the panel
// back into a container of its own long before a browser guard gets to run.

test('the desktop Map panel is a flow sibling of the map controls, not a portal onto the app bar', () => {
  assert.ok(
    !/desktop-appbar-status-slot/.test(src),
    'the Map board-status card must not be portalled onto the app bar — a panel hanging from there cannot push Filters, Routes and the launchers down.',
  );
  const col = src.indexOf('data-testid="map-right-column"');
  assert.ok(col > 0, 'the map right-hand control column lost its test id — the browser guard cannot find it.');
  const card = src.indexOf('data-testid="map-status-card"');
  const panel = src.indexOf('data-testid="map-flags-panel"');
  const filters = src.indexOf('<FilterToolbar', col);
  assert.ok(card > col && panel > card && filters > panel,
    'the column must read card → flags panel → Filters in source order: that ORDER is what makes the controls move when the panel opens.');
});

test('the column is bounded by the map — a flag list can never push a control off the screen', () => {
  // The first cut of v1.32.0 did exactly that: at 1440x900 with Filters open the launchers
  // landed at y 1057. "Below the flags" is the ask; "off the screen" is a new bug.
  const col = src.indexOf('data-testid="map-right-column"');
  const decl = src.slice(Math.max(0, col - 400), col);
  assert.ok(/max-h-\[calc\(100%-1\.5rem\)\][\s\S]*overflow-y-auto/.test(decl),
    'the map right-hand column must cap at the map height and scroll past it.');
  assert.ok(/maxHeightClass="max-h-\[52vh\]"/.test(src),
    'the map flags panel must carry its own shorter cap — at the shared 80vh default an ordinary board needs the scrollbar.');
});

test('"what was checked" is a drawer, shut by default — the claim survives as the row itself', () => {
  assert.ok(/const \[checkedOpen, setCheckedOpen\] = useState\(false\)/.test(src),
    'the checked/skipped accounting must start COLLAPSED — Chad: "where its not always displaying".');
  // The hook has to precede the null guard or an unmounting panel changes hook order.
  // Scoped to BoardFlagsPanel: BoardFlagsChip carries the same early return further up.
  const panelSrc = src.slice(src.indexOf('function BoardFlagsPanel('));
  assert.ok(panelSrc.indexOf('const [checkedOpen, setCheckedOpen]') < panelSrc.indexOf('if (!flags) return null;'),
    'the drawer state must be declared before BoardFlagsPanel\'s early return.');
  assert.ok(/Checked: \{ck\.stops \?\? 0\} stop/.test(src),
    'the SHUT row must still state the tally — a quiet panel is a claim, not an absence.');
  assert.ok(/\{gapLabel \? <span className="text-amber-700 font-medium"> · \{gapLabel\}<\/span> : null\}/.test(src),
    'anything the sweep could not judge must show on the shut row, in amber — a gap hidden behind a collapsed panel is a gap nobody reads.');
});

test('the restore-dismissed path stays OUT of the drawer — it is an action, not reference', () => {
  const drawerEnd = src.indexOf('{skippedBits.length > 0 && <> Not judged:');
  const restore = src.indexOf('Restore dismissed', drawerEnd);
  assert.ok(drawerEnd > 0 && restore > drawerEnd, 'the restore link moved or vanished.');
  const between = src.slice(drawerEnd, restore);
  assert.ok(/<\/div>\s*\n\s*\)\}/.test(between),
    'the restore link must sit after the drawer closes — a way back filed behind a shut panel is one nobody finds on the morning they need it.');
});
