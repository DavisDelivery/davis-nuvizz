// test/firestore-ops.test.mjs — regression guards for the two I/O behaviors the
// audit flagged as untested: the call-counter merge SHAPE (the runaway "stuck at 1"
// bug) and the day-scoped circuit-breaker expiry. Both are exercised via the pure
// helpers buildCounterCommitBody / routeFieldKey / circuitFromDoc.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCounterCommitBody, routeFieldKey, circuitFromDoc } from '../netlify/functions/lib/firestore.mts';

const DOC = 'projects/p/databases/(default)/documents/nuvizz_ops/calls__2026-06-18';

test('counter body MERGES via updateMask:[date] and never overwrites count (the stuck-at-1 fix)', () => {
  const body = buildCounterCommitBody(DOC, '2026-06-18', 1);
  const w = body.writes[0];
  // The update must carry ONLY `date` and an updateMask scoped to it — otherwise the
  // commit replaces the whole doc and wipes the accumulated count.
  assert.deepEqual(w.updateMask, { fieldPaths: ['date'] });
  assert.deepEqual(Object.keys(w.update.fields), ['date']);
  assert.equal(w.update.fields.date.stringValue, '2026-06-18');
  // count must NOT be a plain field (that would overwrite); it rides as a transform.
  assert.ok(!('count' in w.update.fields));
});

test('counter body: count is transform[0] and increments by n', () => {
  const body = buildCounterCommitBody(DOC, '2026-06-18', 5);
  const t = body.writes[0].updateTransforms;
  assert.equal(t[0].fieldPath, 'count');
  assert.equal(t[0].increment.integerValue, '5');
  assert.equal(t.length, 1, 'no per-route transform when route omitted');
});

test('counter body: a route adds a count__<route> transform without disturbing count', () => {
  const body = buildCounterCommitBody(DOC, '2026-06-18', 1, '/load/info');
  const t = body.writes[0].updateTransforms;
  assert.equal(t[0].fieldPath, 'count', 'total stays transform[0] (authoritative readback)');
  assert.equal(t[1].fieldPath, 'count__load_info');
  assert.equal(t[1].increment.integerValue, '1');
});

test('routeFieldKey: never aliases onto count, never injects a field path', () => {
  // A route literally named "count" cannot collide with the authoritative total.
  assert.equal(routeFieldKey('count'), 'count__count');
  // Slashes / dots / spaces collapse to _ so no nested-path injection is possible.
  assert.equal(routeFieldKey('/stop/info'), 'count__stop_info');
  assert.equal(routeFieldKey('a.b c'), 'count__a_b_c');
  assert.equal(routeFieldKey(''), null);
  assert.equal(routeFieldKey(null), null);
});

test('circuitFromDoc: a flag tripped YESTERDAY reads CLOSED today (day-scoped expiry)', () => {
  const doc = { open: true, reason: 'ceiling', at: '2026-06-17T23:59:00Z', day: '2026-06-17' };
  assert.equal(circuitFromDoc(doc, '2026-06-18').open, false, 'stale prior-day trip must not halt today');
  // metadata is still surfaced for visibility.
  assert.equal(circuitFromDoc(doc, '2026-06-18').reason, 'ceiling');
});

test("circuitFromDoc: today's trip stays OPEN; missing/closed docs read CLOSED", () => {
  assert.equal(circuitFromDoc({ open: true, day: '2026-06-18' }, '2026-06-18').open, true);
  assert.equal(circuitFromDoc({ open: false, day: '2026-06-18' }, '2026-06-18').open, false);
  assert.equal(circuitFromDoc(null, '2026-06-18').open, false);
  assert.equal(circuitFromDoc({ open: true }, '2026-06-18').open, false, 'no day stamp → not today → closed');
});
