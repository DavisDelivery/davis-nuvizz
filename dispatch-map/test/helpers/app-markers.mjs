// test/helpers/app-markers.mjs
//
// RUN THE SHIPPED MARKER PIPELINE, DO NOT GREP IT.
//
// The marker rules that matter here — which restriction fills its disc, which half is the
// restriction's own colour, whether the stop's tint is allowed to speak — live inside
// src/App.jsx, a 25,000-line React module that node:test cannot import. So the tests that
// guarded them were written as regexes over the source text, and a regex over source text
// pins the SHAPE of the code rather than the picture it draws: it goes green on a refactor
// that renders something completely different, and red on a rename that renders exactly the
// same thing. Both directions have bitten.
//
// This lifts the marker functions OUT of App.jsx by name and evaluates them, so a test can
// build a real marker and assert on the SVG the app would actually hand Google Maps.
//
// It is deliberately loud when it cannot find a symbol: a helper that silently returned an
// empty module would turn every test below into a test of nothing.
import { readFileSync } from 'node:fs';

const APP_PATH = new URL('../../src/App.jsx', import.meta.url);

/** The top-level declarations the marker pipeline needs, in dependency order. */
const NEEDED = [
  'ELIG_TRACTOR_COLOR', 'TRACTOR_DELIVERED_COLOR',
  'RESTRICTION_ICONS', 'UNKNOWN_RESTRICTION', 'RESTRICTION_ALIASES',
  'resolveRestrictionKey', 'isTimeMarkKey', 'timeMarkOutline',
  'renderMarkerGlyph', 'BLOCKER_GLYPH_INK', 'renderBlockerGlyph',
  'RESTRICTION_MARKER_SCALE', 'TIME_MARK_MARKER_SCALE', 'RESTRICTION_MARKER_KIND_SCALE',
  'restrictionMarkerScale', 'scaleMarkerSpec',
  'restrictionWarnColor', 'blockerDiscMarkup', 'iconMarkerSvg',
];

function declarationSource(lines, name) {
  const re = new RegExp(`^(?:export\\s+)?(?:const|let|function)\\s+${name}\\b`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) throw new Error(`app-markers: '${name}' is not a top-level declaration in App.jsx`);
  const opensBlock = /[{[(]\s*(?:\/\/.*)?$/.test(lines[i]) || !/;\s*(?:\/\/.*)?$/.test(lines[i]);
  if (!opensBlock) return lines[i];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^(?:\}|\};|\]|\];|\)|\);)\s*(?:\/\/.*)?$/.test(lines[j])) return lines.slice(i, j + 1).join('\n');
  }
  throw new Error(`app-markers: could not find the end of '${name}'`);
}

let cached = null;

/**
 * The marker pipeline as App.jsx defines it. `TIME_MARK_KEYS` and `visibleIconKeys` are the
 * two things it imports from elsewhere, so they are injected from their real modules rather
 * than stubbed — a stub here would let a real disagreement between the marker and the legend
 * pass unnoticed, which is the exact class of bug these tests exist for.
 */
export async function loadMarkerPipeline() {
  if (cached) return cached;
  const { TIME_MARK_KEYS } = await import('../../src/lib/time-marks.js');
  const { visibleIconKeys } = await import('../../src/lib/map-legend.js');
  const lines = readFileSync(APP_PATH, 'utf8').split('\n');
  const body = NEEDED.map((n) => declarationSource(lines, n)).join('\n\n');
  // eslint-disable-next-line no-new-func
  const build = new Function('TIME_MARK_KEYS', 'visibleIconKeys', `${body}\nreturn { ${NEEDED.join(', ')} };`);
  cached = build(TIME_MARK_KEYS, visibleIconKeys);
  return cached;
}

/** The decoded SVG source of a marker, as the browser would parse it out of the data URI. */
export function markerSvg(spec) {
  if (!spec || !spec.url) throw new Error('app-markers: no marker spec to decode');
  return decodeURIComponent(String(spec.url).replace(/^data:image\/svg\+xml;charset=UTF-8,/, ''));
}

/** Every `fill="…"` colour in a marker, lowercased, in document order. */
export function fills(svg) {
  return [...svg.matchAll(/fill="(#[0-9a-fA-F]{3,8}|white|none)"/g)].map((m) => m[1].toLowerCase());
}
