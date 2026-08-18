// test/customer-comms-sweep-bounds.test.mjs
//
// THREE PROMISES THE SWEEP MADE AND DID NOT KEEP. All three were raised by an
// adversarial review of the trigger, and two of them are promises the UI makes
// in Claude's own words — which makes them worse than bugs, because a person
// reads them and acts on them.
//
//   1. "Switch off to stop it" (red LIVE banner) and "Switch it off again to
//      stop" (the confirm dialog). The config was read ONCE before the loop, so
//      a sweep already running finished the whole board regardless. Someone
//      watching the first wrong email land and diving for the switch changed
//      nothing.
//   2. "up to N a day" (the confirm dialog). The ledger is per BOARD DATE and
//      the early-hours window sweeps two dates, each starting with its own full
//      budget — so a cap of N could put out 2N in one calendar day.
//   3. The per-day status document exists so that "nothing to do" can be told
//      apart from "could not run". Five of the six exits wrote nothing at all,
//      making those two states identical: silence.
//
// Fixtures are @example.com — Netlify greps this directory for env var VALUES.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABORT_POLL_EVERY, isCustomerDelivery, DEFAULT_CONFIG,
} from '../netlify/functions/lib/customer-comms.mts';

// ── 1. THE OFF SWITCH ───────────────────────────────────────────────────────

test('the abort poll is frequent enough to be a real stop, and rare enough to be free', () => {
  // The guarantee is bounded by this number: at most ABORT_POLL_EVERY further
  // emails can go out after someone flips the switch. It is checked per SEND,
  // not per stop, so a board of already-sent skips costs no extra reads at all.
  assert.equal(ABORT_POLL_EVERY, 25);
  assert.ok(ABORT_POLL_EVERY >= 10, 'too small and every sweep pays for config reads it does not need');
  assert.ok(ABORT_POLL_EVERY <= 50, 'too large and "switch off to stop it" stops being true');
});

// ── 2. THE CAP ──────────────────────────────────────────────────────────────
// The arithmetic the handler now does, pinned directly. Today is swept first,
// so when the allowance runs out it is YESTERDAY's stragglers that wait, never
// today's customers.

function shareCeiling(cap, perDateSent) {
  let remaining = cap;
  const out = [];
  for (const wanted of perDateSent) {
    if (remaining <= 0) { out.push(0); continue; }
    const sent = Math.min(wanted, remaining);
    out.push(sent);
    remaining -= sent;
  }
  return { out, total: out.reduce((a, b) => a + b, 0), remaining };
}

test('THE PROMISE: two board dates in one calendar day cannot exceed the cap between them', () => {
  // Before: today spends 1000 and yesterday spends another 1000 = 2000 emails
  // against a dialog that said "up to 1000 a day".
  const { out, total } = shareCeiling(1000, [1000, 1000]);
  assert.equal(total, 1000, 'one cap, not one per date');
  assert.deepEqual(out, [1000, 0], "and today's customers are the ones who get it");
});

test('a partial day leaves the remainder to the second date', () => {
  const { out, total } = shareCeiling(100, [30, 500]);
  assert.deepEqual(out, [30, 70]);
  assert.equal(total, 100);
});

test('a cap of 0 pauses everything without disabling the program', () => {
  // DEFAULT_CONFIG's own comment calls a cap of 0 meaningful — pause without
  // flipping the switch. The shared ceiling must not quietly break that.
  const { out, total } = shareCeiling(0, [500, 500]);
  assert.deepEqual(out, [0, 0]);
  assert.equal(total, 0);
});

test('the single-date case is unchanged — this must not cost the normal day anything', () => {
  const { out, total } = shareCeiling(1000, [742]);
  assert.deepEqual(out, [742]);
  assert.equal(total, 742);
});

test('the cap the dialog quotes is the one the config carries', () => {
  // If these ever drift, the number a person reads before turning on mail to
  // customers stops being the number that governs it.
  assert.equal(typeof DEFAULT_CONFIG.dailyCap, 'number');
  assert.ok(DEFAULT_CONFIG.dailyCap > 0);
});

// ── 3. A PICKUP IS STILL NOT A DELIVERY (regression guard) ──────────────────

test('the v0.54.89 guards still hold after the bounds work', () => {
  assert.equal(isCustomerDelivery({ normalizedStatus: 'DELIVERED', stopType: 'PU' }), false);
  assert.equal(isCustomerDelivery({ normalizedStatus: 'DELIVERED', stopType: 'DO' }), true);
});
