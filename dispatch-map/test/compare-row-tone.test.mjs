// test/compare-row-tone.test.mjs — A COMPARE CARD SAYS WHAT TRUCK EACH STOP CAN TAKE.
//
// Chad, 2026-09-27, with BRIAN open in Compare: "I want the compare panel to have a faint green
// or red highlight if they are tractor friendly or not."
//
// The Selected window has painted a stop green (a 53-footer can go here) since v0.46.5 and red
// (somebody here said it cannot) since v1.37.1. Once the stop was sent to a card, the card said
// neither — and the card is where the router decides what truck the load needs. These pin that
// the card now says both, with the SAME answer the Selected window gives for the same stop.
//
// Unit + source pins rather than a browser test, for the reason selection-row-tone.test.mjs
// records: the facts come from customer_notes and tractor_locations, Firestore subscriptions a
// headless run cannot stub, so the coloured cases are unreachable there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compareRowTone, selectionRowTone, toneIsGreen, toneIsRed, COMPARE_ROW_TONE } from '../src/lib/routing-select.js';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('a stop a tractor trailer can serve reads green on its Compare card', () => {
  const tone = compareRowTone({ tractorOk: true });
  assert.ok(toneIsGreen(tone), `not green: ${tone}`);
  assert.ok(!toneIsRed(tone));
});

test('a stop somebody marked "No tractor trailer" or Box-only reads red on its Compare card', () => {
  const tone = compareRowTone({ blocked: true });
  assert.ok(toneIsRed(tone), `not red: ${tone}`);
  assert.ok(!toneIsGreen(tone));
});

test('a stop nobody has checked stays uncoloured — red is the stated no, not the unknown', () => {
  // Most stops on an ordinary morning are neither. A red on "no data" would be on most rows of
  // every card and a dispatcher would learn to read past it — the v1.37.1 decision, kept here.
  assert.equal(compareRowTone({ tractorOk: false, blocked: false }), COMPARE_ROW_TONE.plain);
  assert.equal(compareRowTone(), '');
  // The card spreads an absent Map entry into the call: undefined must land on plain too.
  assert.equal(compareRowTone({ ...undefined, dragOver: false }), '');
});

test('the card and the Selected window give one stop the same colour', () => {
  // A stop green in the selection and plain on the card it was just sent to would make one of
  // the two surfaces a liar about the same freight.
  for (const tractorOk of [false, true]) {
    for (const blocked of [false, true]) {
      const card = compareRowTone({ tractorOk, blocked });
      const sel = selectionRowTone({ tractorOk, blocked, hot: false });
      assert.equal(toneIsGreen(card), toneIsGreen(sel), `green disagrees at ok=${tractorOk} blocked=${blocked}`);
      assert.equal(toneIsRed(card), toneIsRed(sel), `red disagrees at ok=${tractorOk} blocked=${blocked}`);
    }
  }
});

test('a contradiction resolves to RED, never to green', () => {
  // Unreachable through the helpers (they are exclusive by construction), but if a caller ever
  // passed both, telling a dispatcher a 53-footer fits at a dock somebody wrote off is the costly
  // mistake — a driver's morning and the customer's delivery, against one trailer slot.
  const tone = compareRowTone({ tractorOk: true, blocked: true });
  assert.ok(toneIsRed(tone) && !toneIsGreen(tone), tone);
});

test('dragging a stop across a green or red row keeps the colour and still shows the drop line', () => {
  // Two background classes on one element resolve by stylesheet order, not intent — so the old
  // blue drag fill must not ride along on a coloured row, or a drag passing over could make a
  // no-tractor stop read as an ordinary one.
  for (const fact of [{ tractorOk: true }, { blocked: true }]) {
    const tone = compareRowTone({ ...fact, dragOver: true });
    assert.ok(tone.includes(COMPARE_ROW_TONE.dropLine), `drop line missing: ${tone}`);
    assert.ok(!tone.includes(COMPARE_ROW_TONE.dropFill), `drag fill covers the fact: ${tone}`);
    assert.equal(toneIsGreen(tone), !!fact.tractorOk);
    assert.equal(toneIsRed(tone), !!fact.blocked);
  }
});

test('an uncoloured row still shows exactly the drop cue it always had', () => {
  // Behaviour on a plain row is unchanged: blue line on top, faint blue fill.
  assert.equal(compareRowTone({ dragOver: true }), 'border-t-2 border-t-blue-500 bg-blue-50/60');
});

test('faint: a red row does not swallow the card\'s red "30M LATE" preflight badge', () => {
  // Measured on the rendered card: at the Selected window's 100 shade the badge (rose-100) is
  // the same colour as a red row and stops reading as a chip. The card's tones are the 50 shade.
  assert.match(COMPARE_ROW_TONE.tractor, /^bg-green-50$/);
  assert.match(COMPARE_ROW_TONE.blocked, /^bg-red-50$/);
});

// ── THE WIRING, on both views ────────────────────────────────────────────────
// The card renders inside App.jsx with no DOM rig, so these pin the source. They exist because
// the failure is silent: drop tractorLocs from ONE RoutingWorkbench call site and the proven
// "a tractor has delivered here" green disappears on that view only — the phone, most likely —
// and nothing on screen says it is missing.

test('the card asks the same two helpers the Selected window asks', () => {
  const card = src.slice(src.indexOf('function RoutingWorkbenchCard('), src.indexOf('function RoutingWorkbench('));
  assert.ok(card.length > 1000, 'could not find RoutingWorkbenchCard in App.jsx');
  assert.match(card, /stopTractorBlocked\(s, notes\)/);
  assert.match(card, /stopTractorFriendly\(s, notes, tractorLocs\)/);
  assert.match(card, /compareRowTone\(\{ \.\.\.tt, dragOver: dragOverId === id \}\)/);
});

test('phone and desktop Compare both receive tractorLocs, and the workbench hands it to every card', () => {
  const sites = src.match(/<RoutingWorkbench [^\n]*/g) || [];
  assert.equal(sites.length, 2, `expected the phone and the desktop call site, found ${sites.length}`);
  for (const s of sites) assert.match(s, /tractorLocs=\{tractorLocs\}/, `a RoutingWorkbench call site is missing tractorLocs: ${s.slice(0, 120)}`);
  const wb = src.slice(src.indexOf('function RoutingWorkbench('));
  const cardCall = wb.slice(wb.indexOf('<RoutingWorkbenchCard'), wb.indexOf('/>', wb.indexOf('<RoutingWorkbenchCard')));
  assert.match(cardCall, /tractorLocs=\{tractorLocs\}/);
});
