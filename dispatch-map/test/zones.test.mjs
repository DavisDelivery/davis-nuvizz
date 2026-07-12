// Zone layer (geohash) — stable ids, the prefix property, and visit-sequence
// collapsing. Node ≥22 strips .mts types natively.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  geohashEncode, zoneId, superId, topId, superOfZone, topOfZone,
  collapseConsecutive, DEFAULT_ZONE_PRECISIONS,
} from '../netlify/functions/lib/zones.mts';

test('geohashEncode matches known reference values', () => {
  // Canonical geohash example (Wikipedia): 42.605, -5.603 → ezs42
  assert.equal(geohashEncode(42.605, -5.603, 5), 'ezs42');
  // Buford Terminal (the Davis depot) — precision 6, stable forever.
  assert.equal(geohashEncode(34.14838, -83.95948, 6), geohashEncode(34.14838, -83.95948, 6));
  assert.equal(geohashEncode(34.14838, -83.95948, 6).length, 6);
  // Equator/meridian corner case encodes without error.
  assert.equal(geohashEncode(0, 0, 4), 's000');
});

test('same cell → same zone id; nearby different cells differ', () => {
  const a = zoneId(34.0301, -84.1001);
  const b = zoneId(34.03005, -84.10005); // a few meters away — same ~0.7 km cell
  const far = zoneId(34.30, -84.60);
  assert.equal(a, b);
  assert.notEqual(a, far);
});

test('prefix property: zone starts with super starts with top', () => {
  const pts = [
    [34.14838, -83.95948],
    [33.749, -84.388],
    [34.0522, -84.3437],
    [-33.8688, 151.2093],
  ];
  for (const [lat, lng] of pts) {
    const z = zoneId(lat, lng);
    const s = superId(lat, lng);
    const t = topId(lat, lng);
    assert.ok(z.startsWith(s), `${z} startsWith ${s}`);
    assert.ok(s.startsWith(t), `${s} startsWith ${t}`);
    assert.equal(superOfZone(z), s);
    assert.equal(topOfZone(z), t);
  }
});

test('precisions come from config, not hardcoded call sites', () => {
  const p = { zone_precision: 7, super_precision: 4, top_precision: 2 };
  const z = zoneId(34.14838, -83.95948, p);
  assert.equal(z.length, 7);
  assert.equal(superOfZone(z, p).length, 4);
  assert.equal(topOfZone(z, p).length, 2);
  assert.equal(zoneId(34.14838, -83.95948, DEFAULT_ZONE_PRECISIONS).length, 6);
});

test('invalid coordinates encode to empty string (never a fake zone)', () => {
  assert.equal(geohashEncode(NaN, -83.9, 6), '');
  assert.equal(geohashEncode(34.1, undefined, 6), '');
});

test('collapseConsecutive collapses runs but keeps revisits', () => {
  assert.deepEqual(collapseConsecutive(['a', 'a', 'b', 'a', 'c', 'c']), ['a', 'b', 'a', 'c']);
  assert.deepEqual(collapseConsecutive([]), []);
  assert.deepEqual(collapseConsecutive(['x']), ['x']);
});
