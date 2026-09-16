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
import { selectionRowTone, toneIsGreen, toneIsBlocked, ROW_TONE } from '../src/lib/routing-select.js';

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

// ── A STOP MARKED "NO TRACTOR TRAILER" IS RED (Chad, 2026-09-16) ───────────────────────
//
// "i want a stop marked no tractor trailers to have a red row in the selection window."
//
// The defect this closes is a conflation, not a missing colour: before it, a row that was not
// green was white, and white meant BOTH "a person marked this no tractor trailer" and "nobody
// has ever said". On the panel a dispatcher stages a trailer load from, those are opposite
// instructions wearing the same paint.

test('MARKED NO TRACTOR TRAILER IS RED — the fact a dispatcher stages a trailer load on', () => {
  const tone = selectionRowTone({ blocked: 'confirmed' });
  assert.equal(tone, ROW_TONE.blocked);
  assert.ok(toneIsBlocked(tone));
  assert.ok(!toneIsGreen(tone), 'a blocked row must never also read as tractor-friendly');
});

test('the ULINE ADVISORY is amber, not red — a tractor may well still fit', () => {
  // lib/trailer-block.js: painting both the same "either wastes a trailer slot on a stop that
  // would have taken one, or sends a 53-footer somewhere it physically cannot turn around."
  const tone = selectionRowTone({ blocked: 'advisory' });
  assert.equal(tone, ROW_TONE.advisory);
  assert.notEqual(tone, ROW_TONE.blocked);
  assert.ok(toneIsBlocked(tone));
});

test('A CONFIRMED BLOCK OUTRANKS THE GREEN — being wrong that way strands freight', () => {
  // The two should never co-occur, but if a note ever carried both, the safe read is the
  // restriction: a green row invites a dispatcher to send a trailer.
  assert.equal(selectionRowTone({ tractorOk: true, blocked: 'confirmed' }), ROW_TONE.blocked);
});

test('an ADVISORY loses to green — a proven tractor delivery outranks Uline order text', () => {
  assert.equal(selectionRowTone({ tractorOk: true, blocked: 'advisory' }), ROW_TONE.tractor);
});

test('hover DEEPENS the blocked colour, it never washes it out to grey', () => {
  // The rule set when an amber hover ate a green row: the highlight moves within the colour
  // that carries the meaning. A red row that greys on hover would drop the warning under the
  // pointer, which is exactly when somebody is about to act on it.
  assert.equal(selectionRowTone({ blocked: 'confirmed', hot: true }), ROW_TONE.blockedHot);
  assert.equal(selectionRowTone({ blocked: 'advisory', hot: true }), ROW_TONE.advisoryHot);
  for (const t of [ROW_TONE.blockedHot, ROW_TONE.advisoryHot]) assert.ok(toneIsBlocked(t));
});

test('UNKNOWN IS STILL PLAIN — silence is not a restriction, and must not be painted as one', () => {
  assert.equal(selectionRowTone({ blocked: null }), ROW_TONE.plain);
  assert.equal(selectionRowTone({ blocked: null, hot: true }), ROW_TONE.plainHot);
  assert.ok(!toneIsBlocked(selectionRowTone({ blocked: null })));
  assert.ok(!toneIsBlocked(selectionRowTone({ tractorOk: true })));
});

test('every tone is a distinct fill, so no two facts can read as the same row', () => {
  const tones = [
    selectionRowTone({}), selectionRowTone({ hot: true }),
    selectionRowTone({ tractorOk: true }), selectionRowTone({ tractorOk: true, hot: true }),
    selectionRowTone({ blocked: 'confirmed' }), selectionRowTone({ blocked: 'confirmed', hot: true }),
    selectionRowTone({ blocked: 'advisory' }), selectionRowTone({ blocked: 'advisory', hot: true }),
  ];
  assert.equal(new Set(tones).size, tones.length);
});

test('an unrecognised tier is treated as no claim at all, never as a red row', () => {
  for (const junk of ['CONFIRMED', 'blocked', true, 1, {}]) {
    assert.ok(!toneIsBlocked(selectionRowTone({ blocked: junk })), String(junk));
  }
});
