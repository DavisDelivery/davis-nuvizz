// test/restriction-icon-clipping.test.mjs
//
// THE LEGEND DRAWS THE MAP'S MARK, NOT A SECOND COPY OF IT.
//
// Chad, three rounds on the same complaint: "its not showing the full icon in the legend some
// of it is cut off" — then, after a fix that was not the fix, "It's still not right you can't
// see the whole icon."
//
// He was right both times. The Legend's restriction list never drew the map's mark: it drew
// badgeInnerSvg, a SECOND renderer that puts the same glyph art on a 14-unit disc it does not
// fit. Measured RADIALLY from the disc centre — the measurement that matters for a circle, and
// the one I did not make the first time — the coloured fill ends at r=6.25 and all twenty
// glyphs reach past it: most to 7.36, four beyond 7.75 and out of the box entirely. The art ran
// into the white ring and through it, and a disc with its glyph bleeding out of the edge reads
// as an icon with a bite out of it.
//
// The first fix widened the viewBox by the disc's own stroke. That was a real clip and it is
// still fixed below — but it was 0.75 units when the actual overflow was two and a half, so it
// changed nothing anyone could see. The lesson is in the first measurement: it asked "does
// anything leave the viewBox", answered uniformly for all twenty icons, and I believed it. For
// a round disc the question is radial distance, not axis extents — a rect corner sits at r=8.88
// while all four of its edges are inside the box.
//
// iconMarkerSvg has never had the problem; the "How sure is it?" swatches, already built with
// it, looked right two inches above the broken ones in the same panel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadMarkerPipeline } from './helpers/app-markers.mjs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const P = await loadMarkerPipeline();

/** The body of MapLegendBody, where the restriction list lives. */
const legendBody = () => APP.slice(APP.indexOf('function MapLegendBody('), APP.indexOf('function Legend({ expanded'));

test('the restriction list renders the MAP mark — the panel cannot teach an icon the board never draws', () => {
  const body = legendBody();
  assert.match(body, /<LegendRestrictionIcon kind=\{key\}/, 'the icon list must draw through the marker renderer');
  assert.doesNotMatch(body, /<RestrictionIcon\b/,
    'a legend row is back on badgeInnerSvg — that is the renderer whose glyphs do not fit their disc');
});

test('LegendRestrictionIcon actually calls iconMarkerSvg, not something that looks like it', () => {
  const fn = APP.slice(APP.indexOf('function LegendRestrictionIcon('), APP.indexOf('function LegendMarkerExample('));
  assert.match(fn, /iconMarkerSvg\(\[kind\]/, 'it must build the mark the same way the map does');
});

test('every restriction key actually produces a mark — no silent blanks in the list', () => {
  // A legend row that renders nothing is the "wired but invisible" failure this session has
  // already shipped twice. Build every one through the real renderer and check it came back.
  const keys = Object.keys(P.RESTRICTION_ICONS);
  assert.ok(keys.length >= 19, `expected the full icon set, got ${keys.length}`);
  for (const k of keys) {
    const spec = P.iconMarkerSvg([k], null, {});
    assert.ok(spec && spec.url && spec.width > 0 && spec.height > 0, `${k} produced no marker`);
  }
});

// ── the original clip, still guarded ─────────────────────────────────────────
// RestrictionIcon is still used for the small inline chips (stop panel, grid, mobile rows), so
// its box must still fit its own disc. Those chips carry the SAME glyph-overflow defect at
// 12-14px and are NOT fixed by this change — recorded here so the next person finds it.

const iconViewBox = () => {
  const fn = APP.slice(APP.indexOf('function RestrictionIcon('), APP.indexOf('function stopMatchesSearch('));
  const m = /viewBox="([-\d. ]+)"/.exec(fn);
  assert.ok(m, 'RestrictionIcon no longer sets a literal viewBox');
  const [x, y, w, h] = m[1].trim().split(/\s+/).map(Number);
  return { x, y, w, h };
};

const badgeDisc = () => {
  const fn = APP.slice(APP.indexOf('function badgeInnerSvg('));
  const m = /<circle cx="(\d+(?:\.\d+)?)" cy="(\d+(?:\.\d+)?)" r="(\d+(?:\.\d+)?)"[^>]*stroke-width="(\d+(?:\.\d+)?)"/.exec(fn);
  assert.ok(m, 'badgeInnerSvg no longer draws its disc in the shape this guard reads');
  return { cx: +m[1], cy: +m[2], r: +m[3], sw: +m[4] };
};

test("the chip badge's own ring still fits its box", () => {
  const vb = iconViewBox();
  const d = badgeDisc();
  const half = d.r + d.sw / 2;   // a stroke straddles its path — this was the first bug
  assert.ok(d.cx - half >= vb.x && d.cy - half >= vb.y, `disc starts at ${d.cx - half}, box at ${vb.x}`);
  assert.ok(d.cx + half <= vb.x + vb.w, `disc reaches ${d.cx + half}, box ends at ${vb.x + vb.w}`);
});

test('the old box really was too small — the clip guard is not vacuously true', () => {
  const d = badgeDisc();
  const half = d.r + d.sw / 2;
  assert.ok(d.cx + half > 14 && d.cx - half < 0, `against 0..14 the disc spanned ${d.cx - half}..${d.cx + half}`);
});
