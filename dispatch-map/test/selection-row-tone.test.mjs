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
import { selectionRowTone, toneIsGreen, ROW_TONE } from '../src/lib/routing-select.js';

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

test('every combination is distinct — four states, four looks', () => {
  // If two of these collide the row is lying about one of them.
  const tones = [
    selectionRowTone({ tractorOk: false, hot: false }),
    selectionRowTone({ tractorOk: false, hot: true }),
    selectionRowTone({ tractorOk: true, hot: false }),
    selectionRowTone({ tractorOk: true, hot: true }),
  ];
  assert.equal(new Set(tones).size, 4, `collision: ${tones.join(' | ')}`);
});

test('called with nothing, it is the resting ordinary row', () => {
  // A row whose flags have not loaded yet must not flash green — that would claim a trailer
  // fits somewhere nobody has said it does.
  assert.equal(selectionRowTone(), ROW_TONE.plain);
  assert.ok(!toneIsGreen(selectionRowTone()));
});
