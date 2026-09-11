// THE COLLAPSE BUTTON MUST SURVIVE THE SQUEEZE.
//
// Chad, with the Routing rail dragged to its narrowest: "When i squeeze the right panel down
// to the minimum i lose my collapse button, the other 2 buttons don't shrink like they should."
//
// Measured before anything was changed: at the 280px minimum the header had 255px of content
// box and wanted 291px, so the chevron ended up 56px past the panel's edge — off the screen.
// A router squeezes this rail because he wants map, so the control the squeeze destroyed was
// the control that UNDOES the squeeze.
//
// These pin the RULE. The structural half — the chevron in its own shrink-0 slot — is pinned
// by scripts/verify-rail-header.mjs, which measures real boxes in a real browser, because a
// flex container's behaviour is not something node:test can observe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { railHeaderLayout, RAIL_MIN_W, RAIL_DEFAULT_W } from '../src/lib/right-panel.js';

// ── THE TWO WIDTHS THAT ACTUALLY EXIST ───────────────────────────────────────

test('at the rail minimum the header sheds enough to fit — this is the reported bug', () => {
  const l = railHeaderLayout(RAIL_MIN_W);
  assert.equal(l.newRouteLabel, false);
  assert.equal(l.tabCounts, false);
});

test('at the default width nothing is taken away', () => {
  // The fix must not cost the ordinary dispatcher anything. 380px is what the screen opens at.
  const l = railHeaderLayout(RAIL_DEFAULT_W);
  assert.equal(l.newRouteLabel, true);
  assert.equal(l.tabCounts, true);
});

test('a wide rail is still the full header', () => {
  const l = railHeaderLayout(900);
  assert.equal(l.newRouteLabel, true);
  assert.equal(l.tabCounts, true);
});

// ── THE ORDER THINGS GIVE WAY IN ─────────────────────────────────────────────

test('the ＋ New route LABEL goes before the tab counts, never the other way round', () => {
  // "Loads (87)" is a dispatch fact — how much of the day is still unbuilt. Creating a route
  // is an occasional act you go looking for. If this order ever inverts, the rail gives up
  // the number a dispatcher reads all morning to keep a button he presses twice a day.
  for (let w = 240; w <= 500; w += 1) {
    const l = railHeaderLayout(w);
    if (l.tabCounts === false) {
      assert.equal(l.newRouteLabel, false, `at ${w}px the counts were dropped while the New route label was kept`);
    }
  }
});

test('there is a band where the counts survive and only the label is gone', () => {
  // Otherwise the two thresholds are one threshold and the staging is decorative.
  const band = [];
  for (let w = RAIL_MIN_W; w <= RAIL_DEFAULT_W; w += 1) {
    const l = railHeaderLayout(w);
    if (l.tabCounts && !l.newRouteLabel) band.push(w);
  }
  assert.ok(band.length >= 40, `expected a real middle band, got ${band.length}px of one`);
});

test('each stage is monotonic — widening the rail never takes something away', () => {
  let prevLabel = false, prevCounts = false;
  for (let w = 200; w <= 900; w += 1) {
    const l = railHeaderLayout(w);
    assert.ok(!(prevLabel && !l.newRouteLabel), `the New route label reappeared then vanished by ${w}px`);
    assert.ok(!(prevCounts && !l.tabCounts), `the tab counts reappeared then vanished by ${w}px`);
    prevLabel = l.newRouteLabel; prevCounts = l.tabCounts;
  }
});

// ── A WIDTH THAT CANNOT BE READ MUST NOT STRIP THE HEADER ────────────────────

test('a malformed width leaves the header FULL, never reduced', () => {
  // CLAUDE.md's house rule, arriving here from the layout side: a value that cannot be read
  // must not silently remove a dispatcher's controls. That failure is invisible — a quietly
  // reduced header looks exactly like a working one.
  for (const bad of [undefined, null, NaN, 0, -40, '', 'wide', {}, [], Infinity]) {
    const l = railHeaderLayout(bad);
    assert.equal(l.newRouteLabel, true, `width ${String(bad)} reduced the header`);
    assert.equal(l.tabCounts, true, `width ${String(bad)} dropped the counts`);
  }
});

test('a numeric string width is still a width', () => {
  // localStorage hands this back as text more often than not.
  assert.deepEqual(railHeaderLayout('280'), railHeaderLayout(280));
  assert.deepEqual(railHeaderLayout('380'), railHeaderLayout(380));
});

// ── THE BUDGET THE THRESHOLDS WERE CHOSEN FROM ───────────────────────────────

test('the thresholds leave room for the three-digit counts an ordinary Davis day produces', () => {
  // Measured in the real bundle at 280px: content box 255px, toggle 162px with one count,
  // ＋ New route 98px full and 26px compact, chevron 15px, two 8px gaps. 102 loads is an
  // ordinary day here, so "Loads (106)" — one character wider than the measured "Loads (87)"
  // — has to fit too. ~7px per extra digit, two tabs.
  const CHEV = 15, GAPS = 16, PAD = 24, TOGGLE_2DIGIT = 188, NR_FULL = 98, NR_COMPACT = 26;
  const EXTRA_DIGIT = 14;                       // one more digit on each of the two counts
  const fits = (w) => {
    const l = railHeaderLayout(w);
    const toggle = (l.tabCounts ? TOGGLE_2DIGIT + EXTRA_DIGIT : 136);
    return toggle + (l.newRouteLabel ? NR_FULL : NR_COMPACT) + CHEV + GAPS + PAD <= w;
  };
  for (let w = RAIL_MIN_W; w <= 1000; w += 1) {
    assert.ok(fits(w), `at ${w}px the header the rule allows does not fit in the rail`);
  }
});
