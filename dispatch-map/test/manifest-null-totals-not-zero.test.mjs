// test/manifest-null-totals-not-zero.test.mjs
//
// An UNREAD number is not a zero. The manifest reader returns null for a header total or a
// Units cell it could not see, and normalizeManifestRows coerced it with Number(v) — and
// Number(null) is 0, and 0 is finite. So a manifest whose footer was cut off the scan came
// back claiming "header says 0 PROs", raised false checksum warnings against totals nobody
// read, and put a 0 in the review grid's Units cell where the dispatcher should have seen a
// blank to fill in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManifestRows } from '../netlify/functions/lib/manifest-extract.mts';

const ROW = (over = {}) => ({
  name: 'JASMINE LEWIS', addr1: '306 GWINNETT SQUARE CIR', addr2: null,
  city: 'DULUTH', state: 'GA', zip: '30096',
  units: 1, weight: 4, description: '1 BX',
  proPrinted: '028-8347656', proDigits: '0288347656',
  ...over,
});

test('a manifest whose header totals were not read raises no "header says 0" warnings', () => {
  const { manifest, warnings, integrity } = normalizeManifestRows({
    totalPros: null, totalUnits: null, totalWeight: null, rows: [ROW()],
  });
  assert.equal(manifest.totalPros, null);
  assert.equal(manifest.totalUnits, null);
  assert.equal(manifest.totalWeight, null);
  assert.deepEqual(warnings, [], `no checksum warnings against totals nobody read: ${JSON.stringify(warnings)}`);
  assert.equal(integrity.expectedPros, null);
  assert.equal(integrity.shortBy, 0);
  assert.equal(integrity.unitsOk, true);
  assert.equal(integrity.weightOk, true);
});

test('a blank or empty-string header total is unread too, not zero', () => {
  const { manifest, warnings } = normalizeManifestRows({
    totalPros: '', totalUnits: '  ', totalWeight: undefined, rows: [ROW()],
  });
  assert.equal(manifest.totalPros, null);
  assert.equal(manifest.totalUnits, null);
  assert.equal(manifest.totalWeight, null);
  assert.deepEqual(warnings, []);
});

test('an unread Units or Wgt cell stays blank in the review grid instead of reading 0', () => {
  const { rows } = normalizeManifestRows({ rows: [ROW({ units: null, weight: '' })] });
  assert.equal(rows[0].units, null);
  assert.equal(rows[0].weight, null);
});

test('a real zero on the paper is still a zero', () => {
  const { manifest, rows } = normalizeManifestRows({ totalPros: 1, totalUnits: 0, totalWeight: '0', rows: [ROW({ units: 0, weight: 0 })] });
  assert.equal(manifest.totalUnits, 0);
  assert.equal(manifest.totalWeight, 0);
  assert.equal(rows[0].units, 0);
  assert.equal(rows[0].weight, 0);
});
