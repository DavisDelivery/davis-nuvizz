// test/motive-positions.test.mjs — the live-driver layer's Motive fetch.
// Imports the SAME functions the endpoint ships (no copies).
//
// Regression origin (Chad, Jul 29, side-by-side with Motive Fleet View: "not matching what
// motive"): /vehicle_locations was fetched ONCE with no paging params, and Motive pages it
// (~25 default). Every truck past page 1 did not exist on our map — 2618T·Rasko Suljic,
// 5042·Enock Akyea, 7521·Mone Watkins, 7750·Chris Head — while every truck we did show was
// numerically below all four. Verified live before fixing: 22 vehicles served, all ≤ 2195.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchAllVehiclePages, normalizeEntry } from '../netlify/functions/motive-driver-positions.mts';

const vehicle = (id, number) => ({ vehicle: { id, number, current_location: { lat: 34, lon: -84 } } });
const page = (vehicles, total) => ({ vehicles, ...(total != null ? { pagination: { total } } : {}) });

test('THE FLEET: pages are walked until pagination.total is reached — nobody past page 1 vanishes', async () => {
  const pages = {
    1: page(Array.from({ length: 100 }, (_, i) => vehicle(i + 1, String(i + 1))), 122),
    2: page(Array.from({ length: 22 }, (_, i) => vehicle(101 + i, String(101 + i))), 122),
  };
  const calls = [];
  const all = await fetchAllVehiclePages(async (p) => { calls.push(p); return pages[p]; });
  assert.equal(all.length, 122);
  assert.deepEqual(calls, [1, 2], 'stops the moment the total is in hand');
});

test('a single short page is the whole fleet — one call, exactly as before the fix', async () => {
  const calls = [];
  const all = await fetchAllVehiclePages(async (p) => { calls.push(p); return page([vehicle(1, '0367'), vehicle(2, '0424')]); });
  assert.equal(all.length, 2);
  assert.deepEqual(calls, [1]);
});

test('an unpaginated reply (no pagination block) still terminates on the short page', async () => {
  const all = await fetchAllVehiclePages(async () => ({ data: [vehicle(1, 'A')] }));
  assert.equal(all.length, 1);
});

test('an API that ignores page_no can never loop or double-pin a truck', async () => {
  // Same full page returned forever: dedupe by vehicle id, and a page that adds nothing ends
  // the walk. Without this, a misbehaving API would draw every truck maxPages times.
  const same = page(Array.from({ length: 5 }, (_, i) => vehicle(i, String(i))));
  const calls = [];
  const all = await fetchAllVehiclePages(async (p) => { calls.push(p); return same; }, { perPage: 5, maxPages: 10 });
  assert.equal(all.length, 5, 'each truck once');
  assert.deepEqual(calls, [1, 2], 'second page contributed nothing → stop');
});

test('the page cap is a runaway bound, not a working limit', async () => {
  let n = 0;
  const all = await fetchAllVehiclePages(async (p) => page(Array.from({ length: 2 }, (_, i) => vehicle(`${p}-${i}`, `${p}-${i}`))), { perPage: 2, maxPages: 3 });
  assert.equal(all.length, 6, '3 pages × 2, then the cap ends it');
});

test('vehicle numbers arrive verbatim but TRIMMED — the live feed really sends "0186T "', () => {
  const norm = (num) => normalizeEntry({ vehicle: { id: 1, number: num, current_location: { lat: 34, lon: -84 } } }, new Map());
  assert.equal(norm('0186T ').vehicleNumber, '0186T');
  assert.equal(norm('0878').vehicleNumber, '0878', 'leading zeros are never stripped');
  assert.equal(norm('').vehicleNumber, null);
});

test('driver attribution: embedded current_driver first, assignment fallback second, honest null third', () => {
  const withDriver = normalizeEntry({ vehicle: { id: 7, number: '0424', current_location: { lat: 34, lon: -84 }, current_driver: { id: 9, first_name: 'Allen', last_name: 'Council' } } }, new Map());
  assert.equal(withDriver.driverName, 'Allen Council');
  const viaAssignment = normalizeEntry({ vehicle: { id: 8, number: '0805', current_location: { lat: 34, lon: -84 } } }, new Map([[8, { id: 4, full_name: 'Enock Akyea' }]]));
  assert.equal(viaAssignment.driverName, 'Enock Akyea');
  const none = normalizeEntry({ vehicle: { id: 9, number: '1606', current_location: { lat: 34, lon: -84 } } }, new Map());
  assert.equal(none.driverName, null, '"(no driver)" is the honest label when Motive names nobody');
});
