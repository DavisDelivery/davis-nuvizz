// test/question-flag-pin.test.mjs — THE "?" FLAG MARKS A PIN, IT DOES NOT COLOUR ONE.
//
// Chad, 2026-09-15, on the question flag: "get rid of this flag it doesn't do anything and
// its also the color of the unplanned orders so is confusing for dispatcher — i want the
// flag replaced with a question mark and color stays whatever the icon is from the order."
//
// The collision is in the constants, not in his eyes: FLAG_COLORS.question is #6366f1 and
// STATUS_META.UNPLANNED.color is #6d28d9. Two violets, on a 16px dot, on a 700-stop board —
// so a flagged SCHEDULED stop read as unplanned work that still needed routing.
//
// These build REAL markers through the shipped stopMarkerIcon and read the colour back out
// of the SVG, rather than grepping App.jsx for the right words. That matters here for the
// exact reason the Estes tests give: the question tint is reachable by TWO routes — the
// `flagHue` term and `flagColor()`'s PIN_TINTS lookup at the end of the same `||` chain —
// and source text cannot show which one a stop actually lands on.
//
// SCOPE (Chad's own call): the map pin only. The Filters chip, the stop-card picker, the
// legend row and the stops-table dot keep the indigo swatch, so the flag still has a colour
// everywhere a dispatcher SETS or FILTERS by it. The last test here pins that boundary.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadStopMarkerIcon, markerSvg, fills } from './helpers/app-markers.mjs';

const QUESTION_INDIGO = '#6366f1';
const UNPLANNED_VIOLET = '#6d28d9';
const RESTRICTED_PURPLE = '#7c3aed';

const stop = (over = {}) => ({ stopNbr: '007175119', isPlanned: false, status: null, ...over });
const hasQuestionMark = (svg) => />\?</.test(svg);

async function pin(stopOver, note, opts = {}) {
  const icon = await loadStopMarkerIcon();
  return markerSvg(icon(stop(stopOver), note, opts));
}

// ── the reported bug ─────────────────────────────────────────────────────────
test('an UNPLANNED stop flagged "?" keeps the unplanned violet and gains a question mark', async () => {
  const svg = await pin({}, { priority_flag: 'question' });
  assert.ok(fills(svg).includes(UNPLANNED_VIOLET), 'the pin wears the colour its own order earned');
  assert.ok(!fills(svg).includes(QUESTION_INDIGO), 'and not the flag indigo that reads as a second violet');
  assert.ok(hasQuestionMark(svg), 'the flag is on the pin as a "?"');
});

test('a SCHEDULED stop flagged "?" does not reach the indigo through flagColor()’s back door', async () => {
  // STATUS_META.SCHEDULED.color is null, so this stop falls all the way through the `||`
  // chain to flagColor() — the SECOND place the flag is read. Dropping only the flagHue term
  // would land it back on the same indigo, and a source-text test would never have seen it.
  const svg = await pin({ isPlanned: true, status: 'SCHEDULED' }, { priority_flag: 'question' });
  assert.ok(!fills(svg).includes(QUESTION_INDIGO), 'no indigo by either route');
});

test('a RESTRICTION-icon pin keeps the tint too — those discs have no centre to put a "?" in', async () => {
  // Same rule as the delivered ✓ below: the replacement is exactly as wide as the glyph. A
  // stop with receiving restrictions draws the restriction icon, not a status disc, so the
  // tint is the flag's only channel there and it stays. It is also not the pin Chad was
  // complaining about — that collision is between two VIOLET DOTS, and this is a white disc.
  const svg = await pin({}, { priority_flag: 'question', appointment_required: true });
  assert.ok(fills(svg).includes(QUESTION_INDIGO), 'the flag still speaks on a restriction pin');
  assert.ok(!fills(svg).includes(UNPLANNED_VIOLET), 'and it is not the unplanned violet either way');
});

test('a plain flagged stop falls through to its own tint, not to the restricted purple', async () => {
  // Dropping the flag must not hand the pin a colour that MEANS something else: with no
  // restrictions on the note, flagColor() has to land on the ordinary unflagged pin.
  const svg = await pin({}, { priority_flag: 'question' });
  assert.ok(!fills(svg).includes(RESTRICTED_PURPLE), 'no borrowed "has restrictions" purple');
  assert.ok(fills(svg).includes(UNPLANNED_VIOLET));
});

// ── the replacement is exactly as wide as the glyph ──────────────────────────
test('where the STATUS owns the glyph slot the flag KEEPS its tint — never nothing at all', async () => {
  // A delivered stop draws a ✓ in the centre, so there is nowhere to put the "?". Dropping the
  // tint there too would make the flag invisible, which is worse than a confusable colour: an
  // invisible flag is indistinguishable from an unflagged stop.
  const svg = await pin({ isPlanned: true, status: 'DELIVERED', deliveredDTTM: '2026-09-15T14:00:00Z' }, { priority_flag: 'question' });
  assert.ok(!hasQuestionMark(svg), 'the ✓ owns the centre');
  assert.ok(fills(svg).includes(QUESTION_INDIGO), 'so the tint stays as the flag’s only channel');
});

test('a highlighted (selected) stop is unchanged — it was never showing the "?" or the tint', async () => {
  const svg = await pin({}, { priority_flag: 'question' }, { matched: true });
  assert.ok(fills(svg).includes('#f59e0b'), 'selection amber still wins outright');
  assert.ok(!fills(svg).includes(QUESTION_INDIGO));
});

// ── the other flags are untouched ────────────────────────────────────────────
test('red / yellow / green still COLOUR the pin — only "?" changed', async () => {
  for (const [flag, hex] of [['red', '#dc2626'], ['yellow', '#eab308'], ['green', '#16a34a']]) {
    const svg = await pin({}, { priority_flag: flag });
    assert.ok(fills(svg).includes(hex), `${flag} still paints the pin`);
    assert.ok(!hasQuestionMark(svg), `${flag} draws no question mark`);
  }
});

test('an unflagged stop is byte-identical to one flagged "?" apart from the question mark', async () => {
  const plain = await pin({}, null);
  const flagged = await pin({}, { priority_flag: 'question' });
  assert.equal(flagged.replace(/<text[^<]*<\/text>/g, ''), plain.replace(/<text[^<]*<\/text>/g, ''),
    'the flag adds a mark and changes nothing else about the disc');
});

// ── the boundary Chad chose: map pin only ────────────────────────────────────
test('the flag KEEPS its colour everywhere a dispatcher sets or filters by it', async () => {
  // Scope was Chad's call: the pin only. If someone later deletes FLAG_COLORS.question the
  // Filters chip, the picker swatch, the legend row and the stops-table dot all lose their
  // swatch silently — this is the line that says that was not what was asked for.
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /question:\s*'#6366f1'/, 'FLAG_COLORS still carries the question hue');
  assert.match(app, /const FLAG_OPTIONS = \['red', 'yellow', 'green', 'question'\]/, 'still offered in the pickers');
});
