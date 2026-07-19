// test/manifest-push-log.test.mjs — PURE helpers of the per-record push log (no network,
// no Firestore): upsert identity, doc-id sanitization, and legacy-array merge semantics.
import test from 'node:test';
import assert from 'node:assert/strict';

import { pushLogKey, recordDocId, mergePushRecords } from '../netlify/functions/manifest-push-log.mts';

test('pushLogKey: orderRef → nuvizzNbr → synthetic anon (nothing is ever key-less)', () => {
  assert.equal(pushLogKey({ orderRef: 'SO45630', nuvizzNbr: 'NV1' }), 'SO45630');
  assert.equal(pushLogKey({ orderRef: null, nuvizzNbr: 'NV1' }), 'NV1');
  const anon = pushLogKey({ orderRef: null, nuvizzNbr: null, name: 'ACME', pushedAt: '2026-07-19T12:00:00Z' });
  assert.ok(anon.startsWith('anon:ACME|2026-07-19'), anon);
  // Two different ref-less orders (different name/time) get DIFFERENT keys — no silent overwrite.
  assert.notEqual(anon, pushLogKey({ name: 'BETA', pushedAt: '2026-07-19T12:00:00Z' }));
});

test('recordDocId: Firestore-safe, bounded, and collision-resistant after sanitizing', () => {
  const id = recordDocId('SO45630');
  assert.match(id, /^[A-Za-z0-9_-]+__[a-z0-9]+$/);
  // Keys that sanitize to the same safe text must still get distinct doc ids (hash suffix).
  assert.notEqual(recordDocId('SO/1'), recordDocId('SO_1'));
  assert.notEqual(recordDocId('anon:ACME|t1'), recordDocId('anon:ACME|t2'));
  // Long keys are capped but stay unique via the hash.
  const long1 = recordDocId('x'.repeat(300) + 'A');
  const long2 = recordDocId('x'.repeat(300) + 'B');
  assert.ok(long1.length < 100 && long2.length < 100);
  assert.notEqual(long1, long2);
  // Deterministic — the same key always lands on the same doc (that's the upsert).
  assert.equal(recordDocId('SO45630'), recordDocId('SO45630'));
});

test('mergePushRecords: per-record store wins over the legacy array on the same key; newest-first', () => {
  const legacy = [
    { orderRef: 'SO1', name: 'OLD NAME', pushedAt: '2026-07-19T10:00:00Z' },
    { orderRef: 'SO2', name: 'LEGACY ONLY', pushedAt: '2026-07-19T09:00:00Z' },
  ];
  const perRecord = [
    { orderRef: 'SO1', name: 'NEW NAME', pushedAt: '2026-07-19T11:00:00Z' },
    { orderRef: 'SO3', name: 'NEW ONLY', pushedAt: '2026-07-19T12:00:00Z' },
  ];
  const merged = mergePushRecords(legacy, perRecord);
  assert.equal(merged.length, 3, 'SO1 deduped across stores');
  assert.deepEqual(merged.map((r) => r.orderRef), ['SO3', 'SO1', 'SO2'], 'sorted newest-first');
  assert.equal(merged.find((r) => r.orderRef === 'SO1').name, 'NEW NAME', 'per-record wins');
  // Degenerate inputs never throw.
  assert.deepEqual(mergePushRecords(null, null), []);
  assert.deepEqual(mergePushRecords([], [{ orderRef: 'A', pushedAt: 't' }]).length, 1);
});
