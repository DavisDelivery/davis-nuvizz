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

// ── A truck with a driver ASSIGNED said "(no driver)" (Chad, 2026-09-15) ────────────────
//
// "when trucks are displayed on the map for motive, it's saying no driver assigned, which is
// not factual. A lot of the times there is a driver assigned."
//
// Motive keeps two driver fields on a vehicle. current_driver is who is LOGGED IN on the ELD
// and rides on /v1/vehicle_locations. permanent_driver is the fleet manager's ASSIGNMENT and
// rides on /v1/vehicles only. This layer read the first and never the second, so an assigned
// driver who had not signed in was nobody. These pin the rule, checked against Motive's docs.
import { composeDriverName, permanentDriverEnabled, fetchPermanentDrivers } from '../netlify/functions/motive-driver-positions.mts';

const at = { lat: 34, lon: -84 };

test('CHRIS HEAD IS ASSIGNED TO 7750 AND NOT SIGNED IN — the plate names him, and says so', () => {
  const d = normalizeEntry(
    { vehicle: { id: 42, number: '7750', current_location: at, current_driver: null } },
    new Map([[42, { id: 9, first_name: 'Chris', last_name: 'Head' }]]),
  );
  assert.equal(d.driverName, 'Chris Head');
  assert.equal(d.driverSource, 'permanent', 'assigned, not logged in — the sidebar has to be able to say that');
});

test('a driver LOGGED IN outranks the assignment — the tablet is the truth about who is driving', () => {
  const d = normalizeEntry(
    { vehicle: { id: 42, number: '7750', current_location: at, current_driver: { id: 4, first_name: 'Enock', last_name: 'Akyea' } } },
    new Map([[42, { id: 9, first_name: 'Chris', last_name: 'Head' }]]),
  );
  assert.equal(d.driverName, 'Enock Akyea');
  assert.equal(d.driverSource, 'current');
});

test('nobody logged in AND nobody assigned is still an honest "(no driver)"', () => {
  const d = normalizeEntry({ vehicle: { id: 43, number: '1606', current_location: at } }, new Map());
  assert.equal(d.driverName, null);
  assert.equal(d.driverSource, null);
});

test('a permanent_driver riding on the entry itself is honoured without a lookup', () => {
  const d = normalizeEntry({ vehicle: { id: 44, number: '0805', current_location: at, permanent_driver: { id: 2, first_name: 'Mone', last_name: 'Watkins' } } }, new Map());
  assert.deepEqual([d.driverName, d.driverSource], ['Mone Watkins', 'permanent']);
});

test('ONE NAME ON FILE IS STILL A DRIVER — Motive documents no full_name, and both were required', () => {
  assert.equal(composeDriverName({ first_name: 'Cher', last_name: '' }), 'Cher');
  assert.equal(composeDriverName({ first_name: null, last_name: 'Suljic' }), 'Suljic');
  assert.equal(composeDriverName({ first_name: ' Rasko ', last_name: ' Suljic ' }), 'Rasko Suljic');
  assert.equal(composeDriverName({}), null);
  assert.equal(composeDriverName(null), null);
  const d = normalizeEntry({ vehicle: { id: 45, number: '2618T', current_location: at, current_driver: { id: 1, first_name: 'Rasko' } } }, new Map());
  assert.equal(d.driverName, 'Rasko', 'used to fall through to "(no driver)"');
});

test('the /v1/vehicles walk keys permanent_driver by vehicle id and skips empty ones', async () => {
  const map = await fetchPermanentDrivers(async () => ({
    vehicles: [
      { vehicle: { id: 1, number: '0367', permanent_driver: { id: 7, first_name: 'Allen', last_name: 'Council' } } },
      { vehicle: { id: 2, number: '0424', permanent_driver: null } },
      { vehicle: { id: 3, number: '0186T', permanent_driver: {} } },
    ],
  }));
  assert.deepEqual([...map.keys()], [1]);
  assert.equal(composeDriverName(map.get(1)), 'Allen Council');
});

test('an assigned driver with no name on file never becomes a blank plate', () => {
  const d = normalizeEntry({ vehicle: { id: 46, number: '5042', current_location: at } }, new Map([[46, { id: 3 }]]));
  assert.equal(d.driverName, null);
  assert.equal(d.driverSource, null);
});

test('MOTIVE_PERMANENT_DRIVER: default on, off-words off, a typo leaves it ON', () => {
  for (const v of [undefined, '', 'on', 'true', 'banana']) assert.equal(permanentDriverEnabled({ MOTIVE_PERMANENT_DRIVER: v }), true, String(v));
  for (const v of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(permanentDriverEnabled({ MOTIVE_PERMANENT_DRIVER: v }), false, v);
});
