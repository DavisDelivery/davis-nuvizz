// test/freight-capacity-capture.test.mjs
//
// Capacity is skids + loose pieces, NOT weight. NuVizz MISLABELS its freight
// fields (documented in freight-geometry.mts): the real skid/pallet-position count
// is NuVizz "cartons", loose pieces is NuVizz "volume", and "pallets" is TOTAL
// pieces. These tests lock in that the history warehouse now captures the REAL
// skid + loose dimensions per trip/day (driver_days) and per load (deriveRoutes),
// so a per-driver skid/loose capacity envelope can be learned later.
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractDriverDays } from '../netlify/functions/lib/routing-driver-days.mts';
import { deriveRoutes } from '../netlify/functions/lib/history-derive.mts';

// A planned stop with the mislabeled NuVizz freight fields populated.
const stop = (over = {}) => ({
  stopNbr: '1', isPlanned: true, loadNbr: 'LOAD_A',
  driverUserName: 'SHART', driverName: 'SHART',
  lat: 34.1, lng: -84.0,
  cartons: 3,   // real SKIDS
  volume: 5,    // real LOOSE pieces
  pallets: 8,   // TOTAL pieces (skids + loose) — mislabeled by NuVizz
  weight: 100,
  ...over,
});

test('extractDriverDays: aggregates real skids (cartons) + loose (volume) per trip and per day', () => {
  const stops = [
    stop({ stopNbr: '1', loadNbr: 'LOAD_A', deliveredDTTM: '2026-07-14T12:00:00Z' }),                 // skids 3, loose 5
    stop({ stopNbr: '2', loadNbr: 'LOAD_A', cartons: 2, volume: 1, deliveredDTTM: '2026-07-14T13:00:00Z' }), // skids 2, loose 1
    stop({ stopNbr: '3', loadNbr: 'LOAD_B', cartons: 4, volume: 0, deliveredDTTM: '2026-07-14T16:00:00Z' }), // second trip: skids 4, loose 0
  ];
  const [day] = extractDriverDays(stops, { tenant: 'davis', date: '2026-07-14' });
  const tripA = day.trips.find((t) => t.load_key.includes('LOAD_A'));
  const tripB = day.trips.find((t) => t.load_key.includes('LOAD_B'));
  assert.equal(tripA.skids, 5, 'LOAD_A skids = 3 + 2');
  assert.equal(tripA.loose, 6, 'LOAD_A loose = 5 + 1');
  assert.equal(tripB.skids, 4);
  assert.equal(tripB.loose, 0);
  // Day totals sum the trips — this is the number a daily skid/loose capacity is learned from.
  assert.equal(day.day_totals.skids, 9, 'day skids = 5 + 4');
  assert.equal(day.day_totals.loose, 6, 'day loose = 6 + 0');
  // Weight still tracked; pallets stays the (mislabeled) total-pieces sum for back-compat.
  assert.equal(day.day_totals.weight, 300);
});

test('extractDriverDays: missing freight fields fold to 0, never NaN', () => {
  const [day] = extractDriverDays(
    [stop({ cartons: undefined, volume: null, deliveredDTTM: '2026-07-14T12:00:00Z' })],
    { tenant: 'davis', date: '2026-07-14' },
  );
  assert.equal(day.day_totals.skids, 0);
  assert.equal(day.day_totals.loose, 0);
  assert.ok(Number.isFinite(day.day_totals.skids) && Number.isFinite(day.day_totals.loose));
});

test('deriveRoutes: load docs carry real skids/loose per stop + route totals', () => {
  const ctx = { tenant: 'davis', date: '2026-07-14', capture: { capture_version: 1, captured_at: '2026-07-15T06:00:00Z' } };
  const stops = [
    stop({ stopNbr: '1', loadNbr: 'DAVIS1', cartons: 3, volume: 5, loadStopSeq: 1 }),
    stop({ stopNbr: '2', loadNbr: 'DAVIS1', cartons: 2, volume: 4, loadStopSeq: 2 }),
  ];
  const [route] = deriveRoutes(stops, ctx);
  assert.equal(route.stops[0].skids, 3);
  assert.equal(route.stops[0].loose, 5);
  assert.equal(route.totalSkids, 5, '3 + 2');
  assert.equal(route.totalLoose, 9, '5 + 4');
  assert.equal(route.totalPallets, 16, 'total pieces still summed from mislabeled pallets (8 + 8)');
});
