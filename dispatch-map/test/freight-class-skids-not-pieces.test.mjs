// test/freight-class-skids-not-pieces.test.mjs
//
// NuVizz mislabels its freight fields (lib/nuvizz-scan.mts normalizeStop, confirmed by Davis
// dispatch): the normalized `cartons` (NuVizz totalCartons) is the real SKID count and
// `pallets` (NuVizz totalPallets) is the TOTAL piece count, pallets + loose. The freight-class
// report used `pallets` as the skid count, so a 2-skid shipment with 8 loose cartons was cubed
// as ten pallets — five times the cube, a third of the density, and a class far too high.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveShipmentFreight, densityToClass } from '../netlify/functions/lib/freight-class.mts';

test('a 2-skid shipment with 10 total pieces is classed on the 2 skids, not the 10 pieces', () => {
  // As the history warehouse stores it: cartons = skids, pallets = total pieces.
  const stop = { cartons: 2, pallets: 10, weight: 2000, weightUOM: 'LB', stopDetails: [] };
  const f = deriveShipmentFreight(stop, { stackHeightIn: 60 });
  assert.equal(f.pallets, 2, 'the pallet count is the skid count');
  assert.equal(f.pieces, 10, 'total pieces are still reported, under their real name');
  assert.equal(f.lbPerPallet, 1000, '2000 lb over 2 skids');
  // 2 × (48 × 40 × 60) / 1728 = 133.33 ft³ → 15 pcf → class 70.
  assert.ok(Math.abs(f.cubeFt3PalletEst - 133.33) < 0.01, `cube ${f.cubeFt3PalletEst}`);
  assert.equal(f.cubeSource, 'pallet_est');
  assert.ok(Math.abs(f.densityPcf - 15) < 0.01, `density ${f.densityPcf}`);
  assert.equal(f.freightClass, 70);
  assert.equal(f.freightClass, densityToClass(2000 / 133.33));
});

test('an all-loose shipment (no skids, only pieces) gets no pallet-footprint estimate', () => {
  // Zero skids: there is no pallet footprint to multiply, so the fallback cube must not
  // invent one out of the loose-piece count.
  const stop = { cartons: 0, pallets: 6, weight: 300, stopDetails: [] };
  const f = deriveShipmentFreight(stop);
  assert.equal(f.pallets, 0);
  assert.equal(f.pieces, 6);
  assert.equal(f.lbPerPallet, null);
  assert.equal(f.cubeFt3PalletEst, null);
  assert.equal(f.cubeSource, 'none');
  assert.equal(f.freightClass, null);
});

test('a stop with no skid count at all reports no pallets rather than borrowing the piece count', () => {
  const stop = { cartons: null, pallets: 4, weight: 800, stopDetails: [] };
  const f = deriveShipmentFreight(stop);
  assert.equal(f.pallets, null);
  assert.equal(f.pieces, 4);
  assert.equal(f.cubeFt3PalletEst, null);
});

test('the freight-class CSV carries the piece count in its own column', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../netlify/functions/freight-class-report.mts', import.meta.url), 'utf8');
  const cols = src.match(/const COLUMNS = \[([\s\S]*?)\];/)[1];
  assert.match(cols, /'pieces'/, 'COLUMNS lists pieces');
  // Appended last, so a reader that takes the CSV by position still finds weight_lb, the cube
  // and the class in the columns they were in before pieces existed.
  const names = [...cols.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  assert.equal(names[names.length - 1], 'pieces', 'pieces is the last column');
  assert.deepEqual(names.slice(15, 19), ['pallets', 'cartons', 'weight_lb', 'lb_per_pallet'],
    'the existing freight columns keep their positions');
  assert.match(src, /pieces:\s*f\.pieces/, 'the row fills pieces from the derived freight');
});
