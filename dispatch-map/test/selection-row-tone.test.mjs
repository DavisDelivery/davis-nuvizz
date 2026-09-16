// test/selection-row-tone.test.mjs — A HOVER MAY NOT EAT A FACT ABOUT THE FREIGHT.
//
// Chad: "I don't want it to wash out a tractor friendly row so for those make the highlight a
// form of green."
//
// The selection row carries two things at once. GREEN says a tractor trailer can be sent to this
// stop — a fact about the freight, the same rule the "Drop N non-tractor" button beside it reads.
// HOVER says the pointer, or the MAP through the shared hoverId, is on this row right now — and
// says nothing about the stop. The first version painted every hovered row one fill, so the green
// disappeared for as long as the pointer sat on it.
//
// This is a unit test rather than a browser one for a reason worth recording: `tractorOk` is
// computed from customer_notes, a Firestore subscription, and the headless guard cannot stub it —
// so the green case is unreachable there no matter how the guard is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionRowTone, toneIsGreen, toneIsRed, ROW_TONE } from '../src/lib/routing-select.js';

test('a tractor-friendly row stays green while it is hovered', () => {
  const resting = selectionRowTone({ tractorOk: true, hot: false });
  const hovered = selectionRowTone({ tractorOk: true, hot: true });
  assert.ok(toneIsGreen(resting), `resting tone is not green: ${resting}`);
  assert.ok(toneIsGreen(hovered), `HOVER WASHED OUT THE GREEN: ${hovered}`);
  assert.notEqual(hovered, resting, 'and the hover is still visible — it moves within the greens');
});

test('the hover on a green row is never the neutral tone', () => {
  // The exact failure Chad reported: one highlight colour for every row, whatever the row meant.
  const hovered = selectionRowTone({ tractorOk: true, hot: true });
  assert.notEqual(hovered, ROW_TONE.plainHot);
  assert.ok(!/slate|amber|yellow/.test(hovered), `a tractor row must not hover to ${hovered}`);
});

test('an ordinary row hovers to the neutral tone, and carries no green', () => {
  const hovered = selectionRowTone({ tractorOk: false, hot: true });
  assert.equal(hovered, ROW_TONE.plainHot);
  assert.ok(!toneIsGreen(hovered), 'a plain row must never look tractor-friendly');
  assert.ok(!toneIsGreen(selectionRowTone({ tractorOk: false, hot: false })));
});

test('every combination is distinct — six states, six looks', () => {
  // If two of these collide the row is lying about one of them.
  const tones = [
    selectionRowTone({ tractorOk: false, hot: false }),
    selectionRowTone({ tractorOk: false, hot: true }),
    selectionRowTone({ tractorOk: true, hot: false }),
    selectionRowTone({ tractorOk: true, hot: true }),
    selectionRowTone({ blocked: true, hot: false }),
    selectionRowTone({ blocked: true, hot: true }),
  ];
  assert.equal(new Set(tones).size, 6, `collision: ${tones.join(' | ')}`);
});

test('called with nothing, it is the resting ordinary row', () => {
  // A row whose flags have not loaded yet must not flash green — that would claim a trailer
  // fits somewhere nobody has said it does.
  assert.equal(selectionRowTone(), ROW_TONE.plain);
  assert.ok(!toneIsGreen(selectionRowTone()));
});

// ── AND THE OTHER DIRECTION: SOMEBODY SAID NO ───────────────────────────────
//
// Chad, 2026-09-16: "i want a no tractor trailer stop to highlight red in selection panel."
// The rule behind `blocked` is executed in map-legend.test.mjs; these pin what the row LOOKS
// like, which is the half a dispatcher actually reads.

test('a stop somebody marked no-tractor-trailer is red, and stays red while it is hovered', () => {
  const resting = selectionRowTone({ blocked: true, hot: false });
  const hovered = selectionRowTone({ blocked: true, hot: true });
  assert.ok(toneIsRed(resting), `resting tone is not red: ${resting}`);
  assert.ok(toneIsRed(hovered), `HOVER WASHED OUT THE RED: ${hovered}`);
  assert.notEqual(hovered, resting, 'and the hover is still visible — it moves within the reds');
  assert.notEqual(hovered, ROW_TONE.plainHot, 'a blocked row must never hover to the neutral fill');
});

test('RED IS THE STATED NO, NOT THE UNKNOWN — a row nobody has marked stays neutral', () => {
  // The design decision, pinned: the green rule counts unknown as not-friendly, so most rows on
  // an ordinary morning are not green. If red meant "not green" it would be on nearly every row
  // and a dispatcher would learn to read past it in a week — and the one dock a person has
  // written off would wear the same fill as the 600 nobody has looked at.
  const resting = selectionRowTone({ tractorOk: false, blocked: false, hot: false });
  const hovered = selectionRowTone({ tractorOk: false, blocked: false, hot: true });
  assert.equal(resting, ROW_TONE.plain);
  assert.equal(hovered, ROW_TONE.plainHot);
  assert.ok(!toneIsRed(resting) && !toneIsRed(hovered), 'unknown is not a warning');
});

test('red and green never appear on the same row, and a contradiction resolves to RED', () => {
  // tractorBlockedSelection is the complement of two of tractorFriendlySelection's own refusal
  // branches, so both-true is unreachable through the panel. If a future caller ever did pass
  // it, the safe row is the one that says a trailer cannot come here: sending a 53-footer to a
  // dock somebody wrote off costs a driver his morning, and the other mistake costs a slot.
  for (const hot of [false, true]) {
    const tone = selectionRowTone({ tractorOk: true, blocked: true, hot });
    assert.ok(toneIsRed(tone), `a contradiction must read as the refusal: ${tone}`);
    assert.ok(!toneIsGreen(tone), 'it must never also claim a trailer fits');
  }
});

test('a row whose flags have not loaded yet is neither green NOR red', () => {
  // Flashing red would accuse a customer of a restriction nobody has set, and the dispatcher
  // would route around a dock that is perfectly fine.
  assert.ok(!toneIsRed(selectionRowTone()));
  assert.ok(!toneIsRed(selectionRowTone({ tractorOk: false, blocked: false })));
});
