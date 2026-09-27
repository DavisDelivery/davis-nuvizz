// test/routing-maps-error-banner.test.mjs — a Maps load failure on Routing is readable (Sep 27 audit, F-02).
//
// The Routing map's error used to be an 11px box centred at top-2 with no z-index; on a phone it was
// painted UNDER the "0 selected" pill (it read "LE_MAPS_API_KEY is not set") and on desktop it sat
// beside the tools row. Both map areas now carry a readable banner in the CENTRE of the failed
// map — the one place nothing else lives on either view. Not the bottom: the grid's collapsed
// Stops / Loads bar sits there on a phone, and a banner over it blocked the bar (the phone
// guard's "Grid open on Stops" probe could not tap it). pointer-events-none so a text-only
// alert can never block a control whatever sits under it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('both Routing map areas carry the readable centred banner and the old unanchored box is gone', () => {
  // 60% down, not 50%: on a phone the tools column ends just past the middle of the map area and
  // a dead-centre banner clipped the bottom of its last button (measured on the built bundle).
  const banner = /\{mapsError && <div role="alert" className="absolute inset-x-4 top-\[60%\] -translate-y-1\/2 z-40 pointer-events-none mx-auto max-w-md bg-red-50 border border-red-300 text-red-800 text-\[13px\] rounded-lg shadow px-3 py-2"><b>Google Maps failed to load<\/b> — \{mapsError\}<\/div>\}/g;
  assert.equal((APP.match(banner) || []).length, 2, 'phone map area and desktop map area both carry the banner');
  assert.doesNotMatch(APP, /mapsError && <div role="alert" className="absolute inset-x-2 bottom-3/, 'never bottom-anchored: the grid bar lives there on a phone');
  assert.doesNotMatch(APP, /mapsError && <div className="absolute top-2 left-1\/2 -translate-x-1\/2 bg-red-50/, 'the old unanchored 11px box is gone');
});
