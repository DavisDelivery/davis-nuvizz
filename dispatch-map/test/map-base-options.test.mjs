// test/map-base-options.test.mjs
//
// Chad: "hiding place labels is not working."
//
// The bug in one line: the app builds its maps with a cloud mapId, and Google ignores
// the JS `styles` array on any map that has one — so the only thing "Hide place labels"
// could ever do was swap hybrid imagery for satellite imagery. With satellite OFF (his
// screenshot) the base is 'roadmap', there is no label-free roadmap type, and the switch
// moved with nothing behind it.
//
// These tests pin the four-way grid (mapId × hideLabels) rather than any one case,
// because the whole failure was one cell of it being unreachable.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapBaseOptions, mapLiveOptions, usesMapId, mapIdKey, keepView, NO_PLACE_LABEL_STYLES,
} from '../src/lib/map-base-options.js';

const MAP_ID = 'db185b9a8f345cbc6ec05f93';
const labelsOff = (o) => Array.isArray(o.styles)
  && o.styles.some((s) => s.featureType === 'poi' && s.elementType === 'labels' && s.stylers?.[0]?.visibility === 'off');

// ── THE REPORTED CASE ────────────────────────────────────────────────────────

test('THE BUG: roadmap + Hide place labels actually strips the labels now', () => {
  const o = mapBaseOptions({ mapId: MAP_ID, hideLabels: true, satellite: false });
  assert.equal(o.mapTypeId, 'roadmap');
  assert.ok(!('mapId' in o), 'the mapId is dropped — a vector map cannot be styled at runtime');
  assert.ok(labelsOff(o), 'and the POI labels are switched off');
});

test('the old behaviour is the thing being fixed: keeping the mapId means no styles at all', () => {
  // Documenting the vendor rule the old code ran into. With a mapId there is nowhere to
  // put the style, and on roadmap there is no second map type to fall back on — which is
  // why the switch did nothing.
  const kept = mapBaseOptions({ mapId: MAP_ID, hideLabels: false, satellite: false });
  assert.equal(kept.mapId, MAP_ID);
  assert.ok(!('styles' in kept), 'no styles are sent alongside a mapId — Google only warns about them');
  assert.equal(kept.mapTypeId, 'roadmap');
});

// ── the four-way grid ────────────────────────────────────────────────────────

test('satellite + hide labels uses the label-free imagery type', () => {
  const o = mapBaseOptions({ mapId: MAP_ID, hideLabels: true, satellite: true });
  assert.equal(o.mapTypeId, 'satellite');
  assert.ok(!('mapId' in o));
  assert.ok(labelsOff(o), 'styles are applied too, so the toggle survives switching back to roadmap');
});

test('satellite without hiding labels stays on hybrid, mapId intact', () => {
  const o = mapBaseOptions({ mapId: MAP_ID, hideLabels: false, satellite: true });
  assert.equal(o.mapTypeId, 'hybrid');
  assert.equal(o.mapId, MAP_ID);
});

test('with NO mapId configured, styles do the work on every base', () => {
  // A dev build with VITE_GOOGLE_MAP_ID unset — this path already worked and must not change.
  const road = mapBaseOptions({ mapId: undefined, hideLabels: true, satellite: false });
  assert.ok(labelsOff(road));
  assert.equal(road.mapTypeId, 'roadmap');
  const off = mapBaseOptions({ mapId: '', hideLabels: false, satellite: false });
  assert.deepEqual(off.styles, [], 'toggling back clears the style rather than leaving it stuck');
});

test('an absent options object does not throw and reads as plain roadmap', () => {
  const o = mapBaseOptions();
  assert.equal(o.mapTypeId, 'roadmap');
  assert.deepEqual(o.styles, []);
});

// ── the re-init trigger ──────────────────────────────────────────────────────

test('mapIdKey changes ONLY when the map genuinely has to be rebuilt', () => {
  // This is what the init effect depends on. A mapId site flips between two values as the
  // toggle moves (one rebuild per toggle); a site with no mapId never moves, so it never
  // pays for a rebuild it does not need.
  assert.equal(mapIdKey(MAP_ID, false), MAP_ID);
  assert.equal(mapIdKey(MAP_ID, true), '');
  assert.equal(mapIdKey(undefined, false), '');
  assert.equal(mapIdKey(undefined, true), '', 'no mapId → the key never changes → no re-init');
  assert.equal(mapIdKey('', true), '');
});

test('usesMapId is the single rule both the options and the key are built from', () => {
  assert.equal(usesMapId(MAP_ID, false), true);
  assert.equal(usesMapId(MAP_ID, true), false);
  assert.equal(usesMapId(null, false), false);
});

// ── live options (a map that already exists) ─────────────────────────────────

test('mapLiveOptions never tries to change mapId — it is immutable after construction', () => {
  const o = mapLiveOptions({ mapId: MAP_ID, hideLabels: false, satellite: true });
  assert.ok(!('mapId' in o), 'that is exactly why the toggle needs a re-init at all');
  assert.equal(o.mapTypeId, 'hybrid');
  assert.equal(o.styles, null, 'null = do not call setOptions(styles) on a mapId map');
});

test('mapLiveOptions hands back a real style once the map is no longer mapId-backed', () => {
  const o = mapLiveOptions({ mapId: MAP_ID, hideLabels: true, satellite: false });
  assert.equal(o.mapTypeId, 'roadmap');
  assert.ok(labelsOff(o));
  assert.equal(o.styles.length, NO_PLACE_LABEL_STYLES.length);
});

// ── the view must survive the rebuild ────────────────────────────────────────

test('keepView carries the dispatcher\'s current center and zoom across a re-init', () => {
  const map = { getCenter: () => ({ lat: () => 34.0515, lng: () => -84.0713 }), getZoom: () => 13 };
  assert.deepEqual(keepView(map, { lat: 1, lng: 2 }, 9), { center: { lat: 34.0515, lng: -84.0713 }, zoom: 13 });
});

test('keepView falls back rather than throwing on a map that cannot answer', () => {
  const fb = { lat: 34.1, lng: -84.0 };
  assert.deepEqual(keepView(null, fb, 9), { center: fb, zoom: 9 });
  assert.deepEqual(keepView({}, fb, 9), { center: fb, zoom: 9 });
  assert.deepEqual(keepView({ getCenter: () => { throw new Error('dead map'); } }, fb, 9), { center: fb, zoom: 9 });
  assert.deepEqual(keepView({ getCenter: () => ({ lat: () => NaN, lng: () => NaN }), getZoom: () => undefined }, fb, 9),
    { center: fb, zoom: 9 }, 'a half-built map must not re-centre the board on NaN');
});
