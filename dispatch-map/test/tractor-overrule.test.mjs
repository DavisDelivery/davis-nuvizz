// test/tractor-overrule.test.mjs
//
// ONE FACT, THREE READERS, AND THEY HAVE TO AGREE.
//
// Chad, on the Selected list with a stop's panel open beside it: "this stop has had a tractor
// delivery to it but the row is not highlighted green why?"
//
// The row was RIGHT. tractor_locations is sticky and automatic — "a tractor delivered here
// once, ever" — so a dispatcher's Box-only mark deliberately outranks it. The PANEL was
// wrong: it printed the green "Tractor has delivered here" banner with no hint it had been
// overruled, while the "Box truck only" mark sat further down in a different block. The loud
// one was the one that had lost.
//
// And sweeping for that turned up the mirror defect, which is the dangerous direction: a
// hand-ticked "No tractor trailer" stopped the MAP painting lime but did NOT stop this row
// going green or the "Drop N non-tractor" button keeping the stop. Burning a trailer slot on
// a stop that would have taken one costs a slot; sending a 53-footer to a dock a person
// already said no about costs a driver his morning and the customer his delivery.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tractorFriendlySelection, tractorPaintAllowed } from '../src/lib/map-legend.js';

test("Chad's stop: proven history, but Box-only wins — the row is correctly not green", () => {
  assert.equal(tractorFriendlySelection({ eligibility: 'box_only', tractorSeen: true }), false);
  // And it is the ONLY way a stop with proven history comes back unfriendly on eligibility
  // alone — which is what let the cause be named from the code rather than guessed at.
  assert.equal(tractorFriendlySelection({ eligibility: null, tractorSeen: true }), true);
  assert.equal(tractorFriendlySelection({ eligibility: 'tractor', tractorSeen: true }), true);
});

test('a CONFIRMED "no tractor trailer" now stops the row too, not just the map paint', () => {
  const note = { equipment_restrictions: ['no_tractor_trailer'] };
  const keys = ['no_tractor_trailer'];
  // The map has refused to paint this lime since v0.76.4 …
  assert.equal(tractorPaintAllowed(null, keys, note), false);
  // … and the Selected row now agrees, where it used to come back green off the history.
  assert.equal(tractorFriendlySelection({ tractorSeen: true, drawnKeys: keys, note }), false);
  assert.equal(tractorFriendlySelection({ friendlyBadge: true, drawnKeys: keys, note }), false);
});

test('an ADVISORY blocker does NOT overrule proven history — same as the paint rule', () => {
  // A scanner-found "no" nobody has checked is a question, not an answer, and "a 53-footer has
  // actually been here" is the best evidence against it. The two rules must not diverge.
  const note = {
    equipment_restrictions: ['no_tractor_trailer'],
    restriction_provenance: { no_tractor_trailer: { source: 'scan' } },
  };
  const keys = ['no_tractor_trailer'];
  const paint = tractorPaintAllowed(null, keys, note);
  const row = tractorFriendlySelection({ tractorSeen: true, drawnKeys: keys, note });
  assert.equal(row, paint, 'the row and the paint must answer an advisory blocker the same way');
});

test('the old three-argument call is unchanged — no silent tightening of existing callers', () => {
  assert.equal(tractorFriendlySelection({ tractorSeen: true }), true);
  assert.equal(tractorFriendlySelection({ eligibility: 'box_only', tractorSeen: true }), false);
  assert.equal(tractorFriendlySelection({}), false);
  assert.equal(tractorFriendlySelection(), false);
});

test('THE PANEL: the banner is overruled by exactly what the paint is overruled by', () => {
  // The banner's gate is `!tractorPaintAllowed(...)`, so this pins the pairing rather than the
  // wording: anything that stops the lime must also mark the banner overruled, or the panel is
  // back to reporting a fact that has already lost.
  const cases = [
    ['box-only', 'box_only', [], null],
    ['confirmed no-trailer', null, ['no_tractor_trailer'], { equipment_restrictions: ['no_tractor_trailer'] }],
  ];
  for (const [what, elig, keys, note] of cases) {
    assert.equal(tractorPaintAllowed(elig, keys, note), false, `${what} must stop the paint`);
  }
  assert.equal(tractorPaintAllowed(null, [], null), true, 'nothing against it → the history stands');
});
