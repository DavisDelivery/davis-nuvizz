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

function declarationLine(lines, name) {
  const re = new RegExp(`^(?:export\\s+)?(?:const|let|function)\\s+${name}\\b`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) throw new Error(`app-markers: '${name}' is not a top-level declaration in App.jsx`);
  return i;
}

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

/**
 * THE WHOLE MARKER DECISION, RUN FOR REAL — including stopMarkerIcon itself.
 *
 * The Estes paint shipped with its rule pinned by reading App.jsx for the right words. Every
 * word was there and the colour was still wrong on half the board: the black had been put at
 * the END of the fill chain, after the status colour, so an UNPLANNED stop (which carries its
 * own purple) never reached it while a SCHEDULED stop (whose colour is null) did. Source text
 * cannot show you the ORDER of a `||` chain's answers. Building the marker can.
 *
 * So this lifts stopMarkerIcon and everything it closes over. `google` is the only stub — the
 * two value classes it constructs — and the four real modules it imports are injected, never
 * faked, so a disagreement between the marker and the legend still shows up here.
 *
 * Declarations are emitted in APP.JSX'S OWN ORDER rather than the order this list names them,
 * so a const that reads another const at definition time cannot land in its temporal dead zone
 * because somebody added a name in the wrong place.
 */
const ICON_NEEDED = [
  'stopMarkerIcon', '__stopIconCache',
  'getRestrictionBadgeKeys', 'resolveRestrictionKey', 'classifyStopStatus',
  'execArrivalTs', 'execDeliveredTs', 'hasReceivingHours',
  'STATUS_META', 'FLAG_COLORS', 'PIN_TINTS', 'flagColor',
  'RESTRICTION_TINT', 'UNFLAGGED_TINT', 'DNS_COLOR', 'PLANNED_MUTED_COLOR', 'SEARCH_MATCH_COLOR',
  'TRACTOR_DELIVERED_COLOR', 'ELIG_TRACTOR_COLOR', 'ELIG_BOX_COLOR', 'ADDRESS_OFF_TINT',
  'readableTextColor', 'countBadgeSvg', 'unplannedDotSvg', 'circleMarkerSvg',
  'RESTRICTION_ICONS', 'UNKNOWN_RESTRICTION', 'RESTRICTION_ALIASES',
  'isTimeMarkKey', 'timeMarkOutline', 'renderMarkerGlyph',
  'BLOCKER_GLYPH_INK', 'renderBlockerGlyph', 'restrictionWarnColor', 'blockerDiscMarkup',
  'RESTRICTION_MARKER_SCALE', 'TIME_MARK_MARKER_SCALE', 'RESTRICTION_MARKER_KIND_SCALE',
  'restrictionMarkerScale', 'scaleMarkerSpec', 'iconMarkerSvg',
];

/** The `google.maps` surface stopMarkerIcon touches: two value classes, nothing else. */
export const googleStub = {
  maps: {
    Size: class { constructor(width, height) { this.width = width; this.height = height; } },
    Point: class { constructor(x, y) { this.x = x; this.y = y; } },
  },
};

let cachedIcon = null;
export async function loadStopMarkerIcon() {
  if (cachedIcon) return cachedIcon;
  const mods = await Promise.all([
    import('../../src/lib/map-legend.js'),
    import('../../src/lib/time-marks.js'),
    import('../../src/lib/carrier-mark.js'),
    import('../../src/lib/address-fix.js'),
  ]);
  const injected = {};
  for (const m of mods) for (const [k, v] of Object.entries(m)) if (!ICON_NEEDED.includes(k)) injected[k] = v;
  const lines = readFileSync(APP_PATH, 'utf8').split('\n');
  const body = ICON_NEEDED
    .map((n) => ({ n, at: declarationLine(lines, n), src: declarationSource(lines, n) }))
    .sort((a, b) => a.at - b.at)
    .map((d) => d.src)
    .join('\n\n');
  const names = Object.keys(injected);
  // eslint-disable-next-line no-new-func
  const build = new Function(...names, `${body}\nreturn stopMarkerIcon;`);
  const stopMarkerIcon = build(...names.map((k) => injected[k]));
  // The icon cache is keyed by the visual inputs; a test that changes App.jsx between runs in
  // one process would otherwise read a stale icon. Hand callers a fresh-cache wrapper.
  cachedIcon = (stop, note, opts = {}) => stopMarkerIcon(googleStub, stop, note, opts);
  return cachedIcon;
}

/** The plain-disc builders — what the status pins, the numbered route pins and the unplanned
 * dots are drawn with (no restriction glyphs). Self-contained, so they load without the icon
 * set; the Estes ring tests build real discs through these and read the SVG back. */
const DISC_NEEDED = ['readableTextColor', 'countBadgeSvg', 'unplannedDotSvg', 'circleMarkerSvg'];
let cachedDisc = null;
export async function loadDiscPipeline() {
  if (cachedDisc) return cachedDisc;
  const lines = readFileSync(APP_PATH, 'utf8').split('\n');
  const body = DISC_NEEDED.map((n) => declarationSource(lines, n)).join('\n\n');
  // eslint-disable-next-line no-new-func
  const build = new Function(`${body}\nreturn { ${DISC_NEEDED.join(', ')} };`);
  cachedDisc = build();
  return cachedDisc;
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
