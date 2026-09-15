// test/nuvizz-retry-policy.test.mjs — which NuVizz writes may be re-sent by the transport.
//
// THE REAL-WORLD EVENT THIS PINS. On 2026-09-15 Chad reported "＋ New route still not
// working". The route create was failing with a NuVizz 500, and because `createRoute` had
// been added to SINGLE_OPS long after fireSingle's inline denylist was written, it inherited
// the default retry policy: maxRetries 4, and isRetryableStatus() calls every 5xx retryable.
// So each failed route create fired FIVE identical POSTs at NuVizz — on a repo whose first
// rule is call cost — and fireSingle keeps only the LAST response, so the forensics of the
// first attempt were thrown away while we were trying to diagnose exactly that.
//
// The worse half is what happens the day a create half-lands: a first attempt that APPLIED
// but answered 5xx double-fires, and the dispatcher gets two routes for one card.
//
// These tests pin the RULE — a mutation is not retried unless it is declaratively safe —
// not the membership of a list. A new write op added tomorrow is non-retryable by default
// and stays that way until someone deliberately classifies it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SINGLE_OPS, MUTATING_OPS, RETRY_SAFE_MUTATIONS, isTransportRetryable,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { isRetryableStatus } from '../netlify/functions/lib/nuvizz-request.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRITE = fs.readFileSync(path.join(HERE, '..', 'netlify', 'functions', 'lib', 'nuvizz-write.mts'), 'utf8');

test('A ROUTE CREATE IS NEVER TRANSPORT-RETRIED — the Sep 15 bug: one Save fired five POSTs', () => {
  assert.equal(isTransportRetryable('createRoute'), false,
    'createRoute creates a route; a 5xx that actually applied would make a second one on retry');
  // And the thing that made it retry: a 500 is retryable transport-wise, so the ONLY thing
  // standing between a failed create and four more POSTs is this classification.
  assert.equal(isRetryableStatus(500), true, 'a 500 is retryable at the transport layer');
  assert.equal(isRetryableStatus(429), true);
});

test('every IMPERATIVE mutation is non-retryable — create/insert/remove/assign/dispatch', () => {
  for (const op of ['createStop', 'createRoute', 'insertStops', 'removeStops', 'assignDriver', 'dispatchLoad']) {
    assert.equal(isTransportRetryable(op), false, `${op} must never be re-sent by the transport`);
  }
});

test('the DECLARATIVE writes keep the retry they were deliberately given', () => {
  // Re-sending these sets the same end state, so a retry is safe and useful. Changing any of
  // these to non-retryable is a real behaviour change, not a tidy-up — this test says so.
  for (const op of ['importLoad', 'partialUpdateStop', 'cancelStop']) {
    assert.equal(isTransportRetryable(op), true, `${op} is declarative/idempotent — retry is safe`);
  }
});

test('READS are always retryable', () => {
  for (const op of ['getStop', 'getLoad', 'getLoadByRouteId', 'roster']) {
    assert.equal(isTransportRetryable(op), true, `${op} is a read`);
  }
});

test('THE RULE FAILS CLOSED: a new mutation is non-retryable until someone says otherwise', () => {
  // The whole bug was a denylist that did not know about an op added after it was written.
  // An op nobody has classified must come back non-retryable.
  assert.equal(isTransportRetryable('someOpInventedTomorrow'), false,
    'an unrecognised op is treated as a mutation — the safe answer');
  // Every mutating single op is either explicitly retry-safe or not retried. No third state.
  const mutatingSingles = SINGLE_OPS.filter((op) => MUTATING_OPS.has(op));
  assert.ok(mutatingSingles.length >= 9, `expected the mutating single ops, got ${mutatingSingles.length}`);
  for (const op of mutatingSingles) {
    assert.equal(isTransportRetryable(op), RETRY_SAFE_MUTATIONS.has(op), `${op} classification`);
  }
  // Nothing that is not a mutating single op may sit in the allowlist (a typo there would
  // silently grant retry to nothing, or worse, shadow a real op name).
  for (const op of RETRY_SAFE_MUTATIONS) {
    assert.ok(mutatingSingles.includes(op), `${op} in RETRY_SAFE_MUTATIONS is not a mutating single op`);
  }
});

test('fireSingle asks the shared predicate — the denylist expression is gone for good', () => {
  // The inline `op === 'assignDriver' || op === 'dispatchLoad' || ...` is what drifted. If it
  // ever comes back, this fails: the classification belongs in one place both sides can test.
  assert.match(WRITE, /const noRetry = !isTransportRetryable\(op\);/);
  assert.doesNotMatch(WRITE, /const noRetry = op === /,
    'the inline denylist drifted once; it does not come back');
  assert.match(WRITE, /maxRetries: 0/, 'and noRetry still actually suppresses the retries');
});
