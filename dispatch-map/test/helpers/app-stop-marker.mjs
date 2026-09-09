// test/helpers/app-stop-marker.mjs
//
// RUN stopMarkerIcon, DO NOT GREP IT.
//
// The sibling helper app-markers.mjs lifts the RESTRICTION marker builders by name. This one
// lifts the whole decision — stopMarkerIcon — which is the function that chooses WHICH marker
// a stop draws: the resting dot, the tagged pin, the numbered route pin, the muted ring, the
// do-not-send ✕, the restriction cluster. That choice is where the pickup bug lived, and it
// is invisible to a test that only exercises the builders it dispatches to.
//
// Same lesson as app-markers.mjs, one level up: the words were all in the source. 'PU' was
// named in unplannedDotSvg AND set in stopMarkerIcon, and a grep for either would have gone
// green — while the branch that reached the renderer knowing 'PU' was unreachable for exactly
// the stops that needed it. Only building the marker and reading the SVG can see that.
//
// Dependencies are resolved by ITERATING ON THE ReferenceError the evaluated body throws,
// rather than from a hand-kept list: a curated list is a second place to forget something,
// and the failure mode of forgetting is a helper that quietly tests less than it claims.
// Declarations are re-sorted into App.jsx's own order, because a `const` lifted after the
// function that closes over it is a temporal-dead-zone error, not a missing symbol.
import { readFileSync } from 'node:fs';

const APP_URL = new URL('../../src/App.jsx', import.meta.url);
const DECL = (name) => new RegExp(`^(?:export\\s+)?(?:const|let|function|class)\\s+${name}\\b`);

let cached = null;

export async function loadStopMarkerPipeline() {
  if (cached) return cached;
  const lines = readFileSync(APP_URL, 'utf8').split('\n');

  const declLine = (name) => lines.findIndex((l) => DECL(name).test(l));
  const declSource = (name) => {
    const i = declLine(name);
    if (i < 0) return null;
    const opensBlock = /[{[(]\s*(?:\/\/.*)?$/.test(lines[i]) || !/;\s*(?:\/\/.*)?$/.test(lines[i]);
    if (!opensBlock) return lines[i];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^(?:\}|\};|\]|\];|\)|\);)\s*(?:\/\/.*)?$/.test(lines[j])) return lines.slice(i, j + 1).join('\n');
    }
    return null;
  };

  // What App.jsx imports rather than declares. Injected from the REAL modules, never stubbed —
  // a stub would let a genuine disagreement between the marker and the legend pass unnoticed,
  // which is the exact class of bug these helpers exist for.
  const lib = async (f) => import(new URL(`../../src/lib/${f}`, import.meta.url));
  const injected = {
    ...await lib('time-marks.js'),
    ...await lib('map-legend.js'),
    ...await lib('carrier-mark.js'),
    ...await lib('address-fix.js'),
    ...await lib('time-restrictions.js'),
  };

  // stopMarkerIcon only ever constructs Size and Point off the google namespace.
  const google = {
    maps: {
      Size: function Size(width, height) { this.width = width; this.height = height; },
      Point: function Point(x, y) { this.x = x; this.y = y; },
    },
  };

  // A representative call in every branch, so CALL-time references resolve too — construction
  // alone only finds what the top-level body touches.
  const PU = (o = {}) => ({ stopNbr: '000111222', stopType: 'PU', lat: 34, lng: -84, isPlanned: true, status: '', ...o });
  const CASES = [
    [{ isPlanned: false }, null, {}],
    [{}, null, {}],
    [{ status: '90' }, null, {}],
    [{}, { delivery_window: 'AM' }, {}],
    [{}, { equipment_restrictions: ['no_tractor_trailer'] }, {}],
    [{}, { do_not_send: true }, {}],
    [{}, null, { seq: 3, inRoute: true }],
    [{}, null, { plannedMuted: true }],
    [{}, null, { matched: true }],
  ];
  // BOTH stop types through EVERY branch. Deliveries are not incidental here: a delivery takes
  // renderers a pickup never reaches (the 16px resting dot, the muted ring), and resolving the
  // pipeline against pickups alone left those symbols unlifted — which surfaced as a
  // ReferenceError inside the test asserting deliveries are NOT marked. The helper has to walk
  // everything the tests will walk, or it silently supports only half of them.
  const exercise = (fn) => {
    for (const stopType of ['PU', 'DO']) {
      for (const [over, note, opts] of CASES) fn(google, { ...PU(over), stopType }, note, opts);
    }
  };

  const need = ['stopMarkerIcon'];
  for (let round = 0; round < 500; round++) {
    const names = Object.keys(injected);
    const body = [...need].sort((a, b) => declLine(a) - declLine(b)).map(declSource).filter(Boolean).join('\n\n');
    try {
      // eslint-disable-next-line no-new-func
      const build = new Function(...names, `${body}\nreturn stopMarkerIcon;`);
      const stopMarkerIcon = build(...names.map((n) => injected[n]));
      exercise(stopMarkerIcon);
      cached = { stopMarkerIcon, google };
      return cached;
    } catch (err) {
      const miss = /(\w+) is not defined/.exec(err.message);
      // LOUD on anything it cannot resolve. A helper that silently returned a stub would turn
      // every test above into a test of nothing, which is worse than a red suite.
      if (!miss) throw new Error(`app-stop-marker: evaluating the lifted pipeline failed — ${err.message}`);
      const sym = miss[1];
      if (need.includes(sym)) throw new Error(`app-stop-marker: '${sym}' is already lifted but still unresolved`);
      if (declLine(sym) < 0) throw new Error(`app-stop-marker: '${sym}' is neither a top-level declaration in App.jsx nor injected`);
      need.push(sym);
    }
  }
  throw new Error('app-stop-marker: gave up resolving dependencies after 500 rounds');
}
