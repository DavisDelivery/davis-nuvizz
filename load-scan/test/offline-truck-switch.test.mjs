// offline-truck-switch.test.mjs — a loader with no signal can still switch trucks,
// and is never dropped into a truck the phone has no stops for.
//
// The manifest cache had ONE slot per driver per day. A loader's pick list went
// in it, then the truck they opened overwrote it. With no signal on the dock:
//   - "Different truck" fell back to that slot, found one truck, and opened it
//     again — the loader could not get back to the pick list at all;
//   - picking a truck from a cached pick list fell back to the pick list (no
//     stops) or to the other truck's manifest, and opened the pick anyway: a
//     scan screen reading 0/0 where every label would come up NOT ON THIS LOAD.
// Reproduced on the built bundle before the fix; see the finding A6-S32-10.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { cacheKey, manifestFromCache } from '../src/lib/offline.js';

const summary = (loadNbr) => ({ loadNbr, stopCount: 1, expectedPieces: 1 });
const truck = (loadNbr) => ({ loadNbr, stopCount: 1, expectedPieces: 1, stops: [{ stopNbr: '1', pros: ['7000001'] }] });
const pickList = { date: '2026-09-15', role: 'loader', summariesOnly: true, loads: [summary('TRUCKA'), summary('TRUCKB')] };
const truckA = { date: '2026-09-15', role: 'loader', resolvedBy: 'manual_load_number', loads: [truck('TRUCKA')] };

test('opening a truck never overwrites the saved pick list', () => {
  const list = cacheKey('2026-09-15', '8801');
  const a = cacheKey('2026-09-15', '8801', 'TRUCKA');
  const b = cacheKey('2026-09-15', '8801', 'TRUCKB');
  assert.equal(list, 'manifest::2026-09-15::8801', 'the day\'s list keeps the slot it always had');
  assert.notEqual(a, list);
  assert.notEqual(a, b);
  assert.notEqual(cacheKey('2026-09-16', '8801', 'TRUCKA'), a, 'and a truck number is still scoped to its day');
});

test('"Different truck" with no signal brings back the pick list, and opens nothing by itself', () => {
  assert.deepEqual(manifestFromCache(pickList, ''), { manifest: pickList, open: null });
});

test('picking a truck already opened with signal opens it from the saved copy', () => {
  assert.deepEqual(manifestFromCache(truckA, 'TRUCKA'), { manifest: truckA, open: 'TRUCKA' });
});

test('picking a truck never opened with signal is refused — no 0/0 scan screen', () => {
  assert.deepEqual(manifestFromCache(pickList, 'TRUCKB'), { manifest: null, open: null }, 'a summary row has no stops');
  assert.deepEqual(manifestFromCache(truckA, 'TRUCKB'), { manifest: null, open: null }, 'another truck\'s manifest is not this one');
  assert.deepEqual(manifestFromCache(null, 'TRUCKB'), { manifest: null, open: null });
});

test('a driver\'s own saved manifest still opens their lone load with no signal', () => {
  const mine = { date: '2026-09-15', role: 'driver', resolvedBy: 'alias', loads: [truck('STEVEN')] };
  assert.deepEqual(manifestFromCache(mine, ''), { manifest: mine, open: 'STEVEN' });
  assert.deepEqual(manifestFromCache(mine, 'STEVEN'), { manifest: mine, open: 'STEVEN' }, 'and by number from the day slot');
});

test('the pick list only opens the truck getManifest says it can serve', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const root = app.slice(app.indexOf('export default function App()'));
  assert.match(root, /store\.cacheKey\(date, session\.driverNumber, want\)/, 'a truck is cached under its own slot');
  assert.match(root, /store\.manifestFromCache\(/, 'the offline copy is judged, not assumed');
  assert.match(root, /if \(manifest\.summariesOnly && !\(await getManifest\(\{ loadNbr \}\)\)\) return;/, 'a pick that cannot be served keeps the picker up');
  assert.match(root, /if \(!\(await getManifest\(\{ loadNbr \}\)\)\) return;/, 'so does a typed load number');
});
