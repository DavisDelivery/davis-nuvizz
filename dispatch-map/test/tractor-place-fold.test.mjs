// "TRACTOR HAS DELIVERED HERE" — ONE DOCK, TWO SPELLINGS OF ITS DIRECTION (v1.98.3).
//
// Chad, on MYRIAD360 COREWEAVE (PRO 007184400): "Why does this not have my tractor has delivered
// here flag row?" — then "BUILD IT." Read off tractor-paint-explain (Firestore only): three
// deliveries, all by tractor-tagged drivers (Che Roberts 9/3, Victor Fernandez twice 8/28), filed
// under "2788 OLD TILTON ROAD SOUTHEAST"; the new order reads "2788 OLD TILTON RD SE". The flag
// row (exact key) and the lime check (key or street + ZIP) both missed it. The keys below are the
// real ones the app builds for those two spellings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  tractorPlaceKeys, tractorSeenAt, tractorEntryAt, foldPlaceDirections, tractorPlaceFoldEnabled, placeKeyFromMatchKey,
} from '../src/lib/place-mark.js';
import { normalizeMatchKey, normalizePlaceKey } from '../src/lib/matchKey.js';

const FLAGGED = 'myriad360_coreweave__2788_old_tilton_rd_southeast__dalton__30721';
const lime = new Map([[FLAGGED, { first: '2026-08-28', last: '2026-09-03', drivers: ['Che Roberts', 'Victor Fernandez'] }]]);
const order = { businessName: 'MYRIAD360 COREWEAVE', addr1: '2788 OLD TILTON RD SE', city: 'DALTON', zip: '30721' };
order.matchKey = normalizeMatchKey(order.businessName, order.addr1, order.city, order.zip);

test('the case as it stood: two keys, and neither check could see the tractor history', () => {
  assert.equal(order.matchKey, 'myriad360_coreweave__2788_old_tilton_rd_se__dalton__30721');
  assert.equal(normalizeMatchKey('MYRIAD360 COREWEAVE', '2788 OLD TILTON ROAD SOUTHEAST', 'DALTON', '30721'), FLAGGED);
  assert.deepEqual(tractorSeenAt(order, lime, tractorPlaceKeys(lime)), { byKey: false, byPlace: false, any: false });
  assert.equal(tractorEntryAt(order, lime), null);
});

test('folded, the lime check finds it by place — and the panel row gets the entry and its date', () => {
  const places = tractorPlaceKeys(lime, { fold: true });
  assert.deepEqual(tractorSeenAt(order, lime, places, { fold: true }), { byKey: false, byPlace: true, any: true });
  const hit = tractorEntryAt(order, lime, { fold: true });
  assert.equal(hit.via, 'place');
  assert.equal(hit.entry.last, '2026-09-03');
});

test('all four compound directions, both ways round, and the two-word forms', () => {
  const pairs = [
    ['100 MAIN ST SE', '100 MAIN STREET SOUTHEAST'], ['100 MAIN ST NE', '100 MAIN ST NORTHEAST'],
    ['100 MAIN ST NW', '100 MAIN ST NORTHWEST'], ['100 MAIN ST SW', '100 MAIN ST SOUTHWEST'],
    ['100 MAIN ST SE', '100 MAIN ST SOUTH EAST'], ['100 MAIN ST NW', '100 MAIN ST NORTH WEST'],
    ['2788 SE OLD TILTON RD', '2788 SOUTHEAST OLD TILTON RD'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(foldPlaceDirections(normalizePlaceKey(a, '30721')), foldPlaceDirections(normalizePlaceKey(b, '30721')), `${a} ≡ ${b}`);
  }
});

test('nothing else is loosened: a different number, street or ZIP is still a different dock', () => {
  const places = tractorPlaceKeys(lime, { fold: true });
  for (const other of [
    { ...order, addr1: '2790 OLD TILTON RD SE' },   // next door
    { ...order, addr1: '2788 OLD TILTON RD NE' },   // the other side of town
    { ...order, addr1: '2788 NEW TILTON RD SE' },
    { ...order, zip: '30720' },
  ]) {
    assert.equal(tractorSeenAt(other, lime, places, { fold: true }).any, false, JSON.stringify(other));
    assert.equal(tractorEntryAt(other, lime, { fold: true }), null);
  }
  // A word that merely CONTAINS a direction is not a direction.
  assert.equal(foldPlaceDirections('100_southeastern_blvd__30301'), '100_southeastern_blvd__30301');
  assert.equal(foldPlaceDirections('100_seneca_st__30301'), '100_seneca_st__30301');
});

test('the stored match key is never changed — customer notes stay filed where they are', () => {
  // The fold is applied to the tractor COMPARISON only. normalizeMatchKey is what customer_notes
  // are keyed by; if it folded, every note under a "SOUTHEAST" key would detach from its customer.
  assert.match(FLAGGED, /_southeast__/);
  assert.equal(normalizeMatchKey('MYRIAD360 COREWEAVE', '2788 OLD TILTON ROAD SOUTHEAST', 'DALTON', '30721'), FLAGGED);
  assert.equal(placeKeyFromMatchKey(FLAGGED), '2788_old_tilton_rd_southeast__30721', 'the split itself is unchanged');
});

test('by key first; among several places the most recent tractor wins', () => {
  const own = { ...order, matchKey: FLAGGED };
  assert.equal(tractorEntryAt(own, lime, { fold: true }).via, 'key');
  const two = new Map([
    ['other_name__2788_old_tilton_rd_se__dalton__30721', { last: '2026-07-01' }],
    [FLAGGED, { last: '2026-09-03' }],
  ]);
  assert.equal(tractorEntryAt(order, two, { fold: true }).entry.last, '2026-09-03');
});

test('fold defaults OFF in the library — only the app opts in, through its switch', () => {
  assert.equal(tractorSeenAt(order, lime, tractorPlaceKeys(lime)).any, false);
  assert.equal(tractorEntryAt(order, lime), null);
});

test('absent and malformed inputs answer null / unchanged rather than throw', () => {
  assert.equal(tractorEntryAt(null, lime, { fold: true }), null);
  assert.equal(tractorEntryAt(order, null, { fold: true }), null);
  assert.equal(tractorEntryAt({}, lime, { fold: true }), null);
  assert.equal(foldPlaceDirections(''), '');
  assert.equal(foldPlaceDirections(null), '');
  assert.equal(foldPlaceDirections('no_separator'), 'no_separator');
});

test('VITE_TRACTOR_PLACE_FOLD: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(tractorPlaceFoldEnabled({}), true);
  assert.equal(tractorPlaceFoldEnabled(undefined), true);
  for (const v of ['off', 'OFF', '0', 'false', ' no ']) assert.equal(tractorPlaceFoldEnabled({ VITE_TRACTOR_PLACE_FOLD: v }), false, v);
  for (const v of ['offf', 'on', '1', '', 'nope']) assert.equal(tractorPlaceFoldEnabled({ VITE_TRACTOR_PLACE_FOLD: v }), true, v);
});

// ── the wiring: one switch covers the map, the flags and the panel row ─────────────────────
const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const PM = readFileSync(new URL('../src/lib/place-mark.js', import.meta.url), 'utf8');

test('the lime places and the seen check are built with the same fold, from the switch', () => {
  // Read in the lib, like FORKLIFT_RED_RING_ON: App.jsx code the suite lifts must carry no import.meta.
  assert.match(PM, /export const TRACTOR_PLACE_FOLD_ON = \(\(\) => \{\n  try \{ return tractorPlaceFoldEnabled\(import\.meta\.env\); \} catch \{ return true; \}\n\}\)\(\);/);
  assert.match(APP, /tractorEntryAt, TRACTOR_PLACE_FOLD_ON, limeAsOf,[^;]*\} from '\.\/lib\/place-mark\.js';/);
  assert.doesNotMatch(APP, /TRACTOR_PLACE_FOLD_ON = /, 'App.jsx does not read the switch itself');
  assert.match(APP, /tractorPlaceKeys\(map, \{ fold: TRACTOR_PLACE_FOLD_ON \}\)/);
  assert.match(APP, /tractorSeenAt\(s, facts\.map, facts\.places, \{ fold: TRACTOR_PLACE_FOLD_ON \}\)\.any/);
});

test('the stop panel row asks the map\'s question when on, and the exact key alone when off', () => {
  const panel = APP.slice(APP.indexOf('function StopDataSections('));
  const body = panel.slice(0, panel.indexOf('const tractorOverruled'));
  assert.match(body, /TRACTOR_PLACE_FOLD_ON\s*\?\s*\(tractorEntryAt\(\{ matchKey: panelMatchKey, addr1: stop\.addr1, zip: stop\.zip \}, tractorLocs, \{ fold: true \}\)\?\.entry \|\| null\)/);
  assert.match(body, /:\s*\(tractorLocs\.get\(panelMatchKey\) \|\| null\)/);
});
