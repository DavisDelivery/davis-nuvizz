// test/time-mark-glyph.test.mjs — the clock marks on the map.
//
// Chad, pointing at a teal clock sitting on a road: "the middle of icon shouldn't be
// transparent should be white."
//
// The dial was drawn fill="none", so the satellite base — a road, a roof, a field — ran
// straight through the clock face. On a 20px mark that is not a cosmetic complaint: the
// hands are 1.55-1.9 units wide on a 22-unit grid, and a yellow road crossing behind them
// is the same width and the same contrast as the hands themselves. The mark stops reading
// as a clock and starts reading as scribble, which is exactly when a dispatcher's eye
// skips the one stop that has a deadline on it.
//
// These read the SHIPPED source rather than a copy of the glyph, because the thing that
// regresses is the attribute in App.jsx, not a fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TIME_MARK_KEYS } from '../src/lib/time-marks.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

/** The markerGlyph template for one restriction key, straight out of App.jsx. */
function markerGlyph(key) {
  const i = APP.indexOf(`  ${key}: {`);
  assert.ok(i > 0, `found the ${key} icon definition`);
  const m = APP.slice(i, i + 2000).match(/markerGlyph: `([\s\S]*?)`/);
  assert.ok(m, `${key} has a markerGlyph`);
  return m[1];
}

test('EVERY clock dial is opaque — the map may not show through the face', () => {
  // The dial is the only <circle> stroked in currentColor at 1.9 on these marks; the hands
  // are <line> and the arrows are <path>.
  for (const key of TIME_MARK_KEYS) {
    const g = markerGlyph(key);
    const dial = g.match(/<circle[^>]*stroke="currentColor"[^>]*stroke-width="1\.9"[^>]*\/>/);
    assert.ok(dial, `${key}: found the dial circle`);
    assert.match(dial[0], /fill="#ffffff"/, `${key}: the dial must be filled white, not transparent`);
    assert.ok(!/fill="none"/.test(dial[0]), `${key}: dial is still transparent`);
  }
});

test('the HANDS and ARROWS stay unfilled — filling them turns them into blobs', () => {
  // The obvious way to "make the middle white" is a blanket fill swap, and it would wreck
  // these: an arrow path with a fill is a solid wedge, not an arrow.
  for (const key of TIME_MARK_KEYS) {
    for (const path of markerGlyph(key).match(/<path[^>]*\/>/g) || []) {
      assert.match(path, /fill="none"/, `${key}: a <path> lost fill="none" — it will render as a filled shape`);
    }
  }
});

test('the dial is drawn BEFORE the hands, so the fill cannot cover them', () => {
  // Painter's order: a white disc emitted after the hands would erase them. This is the
  // failure that would look fine in the diff and wrong on the map.
  for (const key of TIME_MARK_KEYS) {
    const g = markerGlyph(key);
    const dialAt = g.search(/<circle[^>]*stroke="currentColor"[^>]*stroke-width="1\.9"/);
    const firstHandAt = g.search(/<line[^>]*stroke="currentColor"/);
    assert.ok(dialAt >= 0 && firstHandAt >= 0, `${key}: has a dial and hands`);
    assert.ok(dialAt < firstHandAt, `${key}: the dial must be painted before the hands`);
  }
});

test('the white outline pass keeps the dial white rather than knocking it out', () => {
  // timeMarkOutline() forces every non-none fill to white and widens strokes, producing the
  // halo that separates the mark from the base. A dial filled white must survive that as
  // white — if the regex ever stops matching it, the halo gets a hole in it.
  const fn = APP.slice(APP.indexOf('function timeMarkOutline('), APP.indexOf('const isTimeMarkKey'));
  const timeMarkOutline = (g) => g
    .replace(/stroke="[^"]*"/g, 'stroke="#ffffff"')
    .replace(/fill="(?!none)[^"]*"/g, 'fill="#ffffff"')
    .replace(/stroke-width="([\d.]+)"/g, (_m, w) => `stroke-width="${(Number(w) + 1.5).toFixed(2)}"`);
  // The local copy must match the shipped one, or this test is grading the wrong function.
  assert.match(fn, /fill="\(\?!none\)\[\^"\]\*"/, 'the shipped outline still skips fill="none"');
  assert.match(fn, /Number\(w\) \+ 1\.5/, 'the shipped outline still widens strokes by 1.5');

  const out = timeMarkOutline(markerGlyph('hours_opens_late'));
  assert.match(out, /fill="#ffffff"/, 'the outline copy keeps a filled dial');
  assert.ok(!/fill="none" stroke="#ffffff" stroke-width="3\.40"/.test(out.match(/<circle[^>]*\/>/)[0]),
    'the dial in the outline pass is not transparent');
});
