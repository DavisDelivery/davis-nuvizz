// test/manifest-check-days.test.mjs — the drop-zone manifest check and the nightly email
// ingest must diff against the SAME delivery-day span, or a deferred Uline order reads as
// missing on one report and present on the other. `Number(null) ?? 2` never defaulted
// (Number(null) is 0), so the drop-zone check silently checked ONE day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpanDays } from '../netlify/functions/manifest-check.mts';

test('drop-zone check with no ?days= spans the same 2 delivery days the nightly email path uses (manifest-run spanDays ?? 2)', () => {
  assert.equal(parseSpanDays(null), 2);
  assert.equal(parseSpanDays(undefined), 2);
});

test('?days= is honoured and clamped to 0..7; garbage is 0, not NaN', () => {
  assert.equal(parseSpanDays('0'), 0);
  assert.equal(parseSpanDays('3'), 3);
  assert.equal(parseSpanDays('9'), 7);
  assert.equal(parseSpanDays('-1'), 0);
  assert.equal(parseSpanDays('abc'), 0);
  assert.equal(parseSpanDays(''), 0);
});
