// test/grid-bar-condensed.test.mjs — THE BOTTOM GRID'S BAR IS ONE ROW, AND ITS ROWS SAY WHAT A
// TRACTOR CAN RUN.
//
// Chad (v1.3.0), with a screenshot of the bar wrapped onto two lines: "I want this bottom panel
// to highlight the tractor friendly rows. Remove the all drivers drivers. put the check vs nuvizz
// in the settings gear on this panel. remove the unplanned 100%. i'm trying to condense these 2
// rows down to one to save space."
//
// Two kinds of pin here. gridRowTone is a pure rule and is tested as one. The rest is WIRING in
// App.jsx — which helper the grid rows read, where the check lives, what left the bar — and a
// wiring pin is the only test that can catch a stale-base merge putting a control back (the way
// the last-stop ✕ vanished in v0.54.19). A regex over the source is a blunt instrument; each one
// below is named for the failure it would report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gridRowTone, GRID_ROW_TONE, ROW_TONE, toneIsGreen } from '../src/lib/routing-select.js';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
// Pins that say a thing must NOT be in the source read the CODE — the changelog rows are prose
// about these very removals and would match the words.
const code = src.split('\n').filter((l) => !/^  \['\d+\.\d+\.\d+', /.test(l)).join('\n');

// ── the rule ─────────────────────────────────────────────────────────────────

test('a tractor-friendly row is green — the SAME green the Selected window paints', () => {
  const tone = gridRowTone({ tractorOk: true });
  assert.ok(toneIsGreen(tone), `not green: ${tone}`);
  assert.equal(tone, ROW_TONE.tractor, 'two greens for one fact is how the grid and the panel come to disagree');
});

test('selection outranks the tractor green; the tractor green outranks carry-over', () => {
  // Most recent act wins: the lasso is what the router is doing NOW. Then a fact about the
  // freight (which truck) over a fact about the date (which day) — the router acts on the
  // first and only notes the second, and the Day column already says the day.
  assert.equal(gridRowTone({ selected: true, tractorOk: true, carryover: true }), GRID_ROW_TONE.selected);
  assert.equal(gridRowTone({ tractorOk: true, carryover: true }), GRID_ROW_TONE.tractor);
  assert.equal(gridRowTone({ carryover: true }), GRID_ROW_TONE.carryover);
  assert.ok(!toneIsGreen(GRID_ROW_TONE.selected) && !toneIsGreen(GRID_ROW_TONE.carryover));
});

test('a row nobody has marked is the plain row — never green by default', () => {
  // A row whose flags have not loaded yet must not flash green: that would claim a trailer
  // fits somewhere nobody has said it does, and a router could build on it.
  assert.equal(gridRowTone(), GRID_ROW_TONE.plain);
  assert.equal(gridRowTone({ tractorOk: false }), GRID_ROW_TONE.plain);
  assert.ok(!toneIsGreen(gridRowTone()));
});

test('every tone is distinct — four states, four looks', () => {
  const tones = [gridRowTone(), gridRowTone({ carryover: true }), gridRowTone({ tractorOk: true }), gridRowTone({ selected: true })];
  assert.equal(new Set(tones).size, 4, `collision: ${tones.join(' | ')}`);
});

// ── the wiring ───────────────────────────────────────────────────────────────

test('the grid rows and the Selected window read ONE helper for "can a tractor go here"', () => {
  assert.ok(/^function stopTractorFriendly\(stop, notes, tractorLocs\) \{/m.test(src), 'the shared helper is gone');
  // Both readers, by name. A private copy of the rule in either place is the v0.46.8 / v1.1.1
  // drift rebuilt: a stop green in one panel and plain in the other.
  assert.ok(/tractorOk: stopTractorFriendly\(s, notes, tractorLocs\),/.test(src), 'the Selected window no longer reads the shared helper');
  assert.ok(/for \(const s of rows\) if \(stopTractorFriendly\(s, notes, tractorLocs\)\) out\.add\(String\(s\.stopNbr\)\);/.test(src),
    'the grid no longer reads the shared helper');
  assert.ok(!/tractorSeen: !!\(tractorLocs && tractorLocs\.has\(s\.matchKey\)\)/.test(src),
    'a second, inline copy of the rule is back beside the shared one');
  // And the helper feeds the tested rule, with the confirmed-blocker inputs it needs.
  assert.ok(/return tractorFriendlySelection\(\{\s*eligibility: note\?\.vehicle_eligibility \?\? null,\s*friendlyBadge: keys\.includes\('tractor_trailer_friendly'\),\s*tractorSeen: !!\(tractorLocs && tractorLocs\.has\(stop\.matchKey\)\),\s*drawnKeys: keys, note, resolve: resolveRestrictionKey,/.test(src),
    'the helper dropped one of the rule\'s inputs — a hand-ticked "No tractor trailer" would stop counting');
});

test('the grid row is painted by gridRowTone, and the staged tint still rides as an inline style', () => {
  assert.ok(/className=\{'cursor-pointer ' \+ gridRowTone\(\{ selected: !!highlightIds\?\.has\(String\(s\.stopNbr\)\), tractorOk: tractorOkIds\.has\(String\(s\.stopNbr\)\), carryover: !!s\.carryover \}\)\}/.test(src),
    'the grid row no longer asks gridRowTone — the ranking is back in JSX where it cannot be tested');
  // grid-staged-rows pins the inline style itself; this pins that it sits BETWEEN selection
  // and the class tones (an inline background beats every class), which is the ranking.
  assert.ok(/style=\{\(!highlightIds\?\.has\(String\(s\.stopNbr\)\) && stagedByStop\?\.get\?\.\(String\(s\.stopNbr\)\)\)/.test(src));
  assert.ok(/const tractorLocs = useTractorLocations\(\);\s*\n\s*const tractorOkIds = useMemo/.test(src),
    'the grid must read the SHARED, paint-toggle-aware tractor map — the one the pins use');
});

test('the driver dropdown and the status-percent strip have left the bar', () => {
  assert.ok(!/All drivers/.test(code), 'the driver <select> is back');
  assert.ok(!/DAY_STATUS_PILLS/.test(code) && !/dayStatus\b/.test(code), 'the "Unplanned 100%" strip is back');
});

test('"Check vs NuVizz" is a gear action, not a bar button — and it is never silently absent', () => {
  assert.ok(/key: 'nvCheck',\s*\n\s*label: nvCheckLabel,\s*\n\s*disabled: !!nvCheckBlocked \|\| nvCheck\.running,/.test(src),
    'the gear item is gone, or it can no longer be greyed with a reason');
  assert.ok(/: '⇄ Check vs NuVizz \(1 call\)';/.test(src), 'the item must say what it costs — it is a metered call');
  // The bar button is gone: the only "Check vs NuVizz" strings left are the gear label, the
  // panel's own copy and the source chip's hover text.
  assert.ok(!/<ClipboardList size=\{12\} \/>\}\s*\n\s*\{nvCheck\.running \? 'Checking NuVizz…' : nvCheck\.result \?/.test(src), 'the bar button is back');
  // Greyed, with the reason, rather than missing: an item that is not there is a feature you
  // have to already know about to go looking for.
  for (const reason of ['Switch to Stops', 'Pick a date window first', 'Pick both From and To dates first', 'One check per minute'])
    assert.ok(src.includes(reason), `the gear item lost its "${reason}" reason`);
  assert.ok(/disabled=\{!!a\.disabled\} title=\{a\.title\}/.test(src), 'RoutingSettingsMenu no longer renders a disabled action with its reason');
});

test('the check\'s verdict stays on the bar, and its panel hangs off the bar', () => {
  // Moving the button must not hide the answer: green/amber chip beside the window, click to
  // reopen; the panel anchors to the bar (which must be `relative` for that to hold).
  assert.ok(/\{nvCheck\.result\.matches \? '✓ matches NuVizz' : `\$\{nvCheckDiffCount\} differ`\}/.test(src), 'the verdict chip is gone');
  assert.ok(/<div className="relative flex flex-wrap items-center gap-2 px-3 py-1\.5 border-b border-slate-100">/.test(src), 'the bar lost `relative` — the panel would anchor to the grid instead');
  assert.ok(/\{nvCheckOpen && nvCheck\.result && \(\s*\n\s*<>\s*\n\s*<div className="fixed inset-0 z-10" onClick=\{\(\) => setNvCheckOpen\(false\)\} \/>\s*\n\s*<div className="absolute right-0 bottom-full mb-1 w-\[640px\]/.test(src),
    'the result panel is gone or no longer anchored to the bar\'s right end');
  // Once a check finishes it opens itself — from a menu, a result that only lands in a chip is
  // a result the dispatcher has to notice.
  assert.ok(/setNvCheck\(\{ running: false, result: j, error: null, at: Date\.now\(\) \}\);\s*\n\s*setNvCheckOpen\(true\);/.test(src));
});

test('Routing folds the grid\'s gear items into ITS gear; the Map screen gets the grid\'s own gear', () => {
  assert.ok(/const bottomGridHeaderRight = isMobile \? phoneDateEl : \(grid\) => \(/.test(src), 'Routing no longer hands its gear to the grid as a function');
  assert.ok(/actions=\{\[\.\.\.\(grid\?\.actions \|\| \[\]\), \.\.\.routingSettingsActions\]\} dropUp/.test(src), 'the grid\'s items are not in the Routing gear');
  assert.ok(/const headerRightEl = typeof headerRight === 'function'\s*\n\s*\? headerRight\(gridGear\)/.test(src));
  assert.ok(/<RoutingSettingsMenu actions=\{gridGear\.actions\} dropUp title="Grid settings" \/>/.test(src), 'the Map screen\'s grid has no gear, so no Check vs NuVizz');
  // Desktop only: a phone bar that gains a control gains a collision.
  assert.ok(/<span className="hidden sm:inline-flex">\s*\n\s*<RoutingSettingsMenu actions=\{gridGear\.actions\}/.test(src), 'the fallback gear reached the phone bar');
  // The phone gear is untouched: it still takes the screen's actions only.
  assert.ok(/const phoneGearEl = isMobile \? <RoutingSettingsMenu views=\{routingSettingsViews\} panels=\{phoneGearPanels\} actions=\{routingSettingsActions\} capHeight panelsFirst tone="appbar" \/> : null;/.test(src));
});

test('the source line is a chip: no stop count (the toggle has it), the full accounting on hover', () => {
  assert.ok(!/Board · \{nvTotal\.toLocaleString\(\)\} stops/.test(code), 'the "Board · N stops" sentence is back — that is the line that wrapped the bar');
  assert.ok(/<span title=\{boardSourceTitle\}>Board\{nvRemovedCount > 0 \? ` · \$\{nvRemovedCount\} removed` : ''\}<\/span>/.test(src),
    'the chip lost the removed count (why a count DROPPED) or its hover accounting');
  // A partial pull, an error and the in-flight spinner are still said in full.
  assert.ok(/≥\{nvTotal\.toLocaleString\(\)\} · partial — narrow the range/.test(src), 'a partial pull must never read as a complete one');
  assert.ok(/<RefreshCw size=\{11\} className="animate-spin" \/> pulling…/.test(src));
});
