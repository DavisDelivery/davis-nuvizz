// test/flag-chip-counts.test.mjs
//
// THE TOP CARD WAS SWALLOWING THE ADVISORY COUNT.
//
// Chad, with the flags panel open beside the status card — the panel reading
// "1 red · 4 advisory", the card reading a bare "⚑ 1": "put the advisory flag numbers on
// the top card as well."
//
// The chip published ONE number: the red count when any red existed, otherwise the amber
// count. So one red with four advisories and one red on its own were pixel-identical, and
// the tier a router can still act on was only visible to someone who opened the panel.
//
// That is the tier that matters early. The 49-day replay found 48 receiving-hours misses
// that showed on the screen and never texted, and every one of them was AMBER when it was
// first seen — hours before it hardened into a red anybody would chase.
//
// PURE — no DOM, no React.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flagChipParts } from '../src/lib/board-flags.js';

test('THE BUG: a red board still publishes its advisory count', () => {
  const p = flagChipParts({ redCount: 1, amberCount: 4 });
  assert.equal(p.red, 1);
  assert.equal(p.amber, 4, 'the four advisories must reach the card');
  assert.equal(p.showSep, true, 'two numbers, so a separator');
  assert.equal(p.tone, 'red', 'severity still decides the colour');
  assert.equal(p.quiet, false);
});

test('one red and twelve advisories no longer looks like one red on its own', () => {
  const a = flagChipParts({ redCount: 1, amberCount: 0 });
  const b = flagChipParts({ redCount: 1, amberCount: 12 });
  assert.notDeepEqual(a, b, 'the two boards must not render identically');
  assert.equal(a.showSep, false, 'no dangling separator when there is nothing to separate');
});

test('an advisory-only board reads as advisory, not as calm', () => {
  const p = flagChipParts({ redCount: 0, amberCount: 6 });
  assert.equal(p.tone, 'amber');
  assert.equal(p.red, 0);
  assert.equal(p.amber, 6);
  assert.equal(p.showSep, false, 'a lone amber count shows as one number, as it always did');
  assert.equal(p.quiet, false);
});

test('a genuinely clean board is quiet — the chip still renders, count-less', () => {
  const p = flagChipParts({ redCount: 0, amberCount: 0 });
  assert.equal(p.quiet, true);
  assert.equal(p.tone, 'quiet');
  // Deliberately NOT "render nothing": a detector that could not look must never be
  // pixel-identical to a board with nothing wrong on it.
  assert.equal(p.red, 0);
  assert.equal(p.amber, 0);
});

test('junk counts read as zero rather than painting a colour off NaN', () => {
  for (const bad of [null, undefined, {}, { redCount: null, amberCount: undefined },
    { redCount: 'x', amberCount: NaN }, { redCount: -3, amberCount: -1 }]) {
    const p = flagChipParts(bad);
    assert.equal(p.red, 0, `red from ${JSON.stringify(bad)}`);
    assert.equal(p.amber, 0, `amber from ${JSON.stringify(bad)}`);
    assert.equal(p.quiet, true);
    assert.equal(p.tone, 'quiet');
  }
});

test('counts are whole numbers — a fractional count never reaches the screen', () => {
  const p = flagChipParts({ redCount: 2.7, amberCount: 4.2 });
  assert.equal(p.red, 2);
  assert.equal(p.amber, 4);
});
