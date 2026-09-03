// AMBER IS THE EARLY-WARNING TIER, AND IT REACHED NOBODY.
//
// Replaying 15 sealed weekdays: of 99 real receiving-hours misses, 44 ever reached red (the
// only tier that emails) and 39 more were seen ONLY as amber — median warning 60 minutes,
// median 43 minutes late, and not one of them produced a message. This gate lets an amber
// hours_risk row earn an email when the close is nearly here, and ONLY then.
//
// It ships OFF (AMBER_LEAD_GATE_MIN = 0). Where to set it is a business judgement: 120
// maximises catches, 180 buys no extra catches but 80 more minutes of warning on 11 of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAlertable, AMBER_LEAD_GATE_MIN, ALERT_MIN_TIER } from '../netlify/functions/lib/flag-alert.mts';

const row = (over = {}) => ({
  rule: 'hours_risk', tier: 'amber', stopNbr: 'S1', customer: 'ACME',
  closeMin: 14 * 60, etaMin: 14 * 60 + 20, lateBy: 20, detail: 'x', ...over,
});
// THE GATE ANSWERS TO ITS OWN SWITCH, NOT TO THE TIER FLOOR.
//
// v0.88.0 briefly made the floor outrank this gate so that "we are only emailing on critical"
// would be true however the gate was set. VALVOLINE 0203 on 2026-09-03 showed why that was
// wrong: first seen at 1:40p projected 3:32p against a 3:30p close — two minutes late, amber,
// correctly — and it drifted all afternoon until the urgent email fired at 3:20p, ten minutes
// before the door shut. The tier rule was right; the EARLY message is what was missing, and
// folding it under the floor meant a quieter urgent inbox and an earlier heads-up could not
// both be had. They are separate switches again.
const pick = (rows, nowMin, gate) => selectAlertable(rows, nowMin, gate).map((c) => c.stopNbr);

test('THE FLOOR STILL GOVERNS THE URGENT BAND — a RED cannot email however wide the gate is', () => {
  // The half Chad asked for on 2026-09-02 is unchanged: red does not email. What changed is
  // that an AMBER inside the gate is a different message on a different claim band, and is no
  // longer refused on the floor's behalf.
  assert.equal(ALERT_MIN_TIER, 'critical', 'the shipped floor');
  for (const gate of [0, 120, 180, 600]) {
    assert.deepEqual(selectAlertable([row({ tier: 'red' })], 13 * 60, gate).map((c) => c.stopNbr), [],
      `red must not email with the gate at ${gate}`);
  }
  assert.deepEqual(selectAlertable([row({ tier: 'critical' })], 13 * 60).map((c) => c.stopNbr), ['S1']);
});

test('THE EARLY WARNING IS AVAILABLE AT THE CRITICAL FLOOR — the VALVOLINE case, in numbers', () => {
  // Its real row: close 3:30p, first seen 1:40p, 110 minutes of lead, amber. With the gate at
  // 120 that stop earns an early message at first sighting — 100 minutes before the urgent one
  // actually went out. With the gate OFF (the shipped default) it earns nothing, which is what
  // happened. Both halves are pinned so the trade is legible rather than remembered.
  const valvoline = row({ stopNbr: 'VALVOLINE', closeMin: 15 * 60 + 30, etaMin: 15 * 60 + 32, lateBy: 2 });
  const firstSeen = 13 * 60 + 40;                      // 1:40p, 110 minutes out
  assert.deepEqual(pick([valvoline], firstSeen, 0), [], 'shipped default: the gate is off, nothing sends');
  assert.deepEqual(pick([valvoline], firstSeen, 120), ['VALVOLINE'], 'gate at 120: the heads-up goes at 1:40p');
  assert.deepEqual(pick([valvoline], firstSeen, 60), [], 'gate at 60: 110 minutes out is still too far');
});

test('SHIPPED DEFAULT IS OFF — amber still reaches nobody until somebody flips the switch', () => {
  assert.equal(AMBER_LEAD_GATE_MIN, 0);
  assert.deepEqual(pick([row()], 13 * 60), []);            // 60 min to close, still silent
  assert.deepEqual(pick([row()], 13 * 60, 0), []);
});

test('with the gate on, an amber inside the window earns the email', () => {
  assert.deepEqual(pick([row()], 13 * 60, 120), ['S1']);   // 60 min to close
});

test('and an amber still hours out does NOT — that is the whole point of the gate', () => {
  assert.deepEqual(pick([row()], 8 * 60, 120), []);        // 6 hours to close
  assert.deepEqual(pick([row()], 11 * 60 + 59, 120), []);  // 121 min — just outside
  assert.deepEqual(pick([row()], 12 * 60, 120), ['S1']);   // 120 min — exactly on the line
});

test('the 180 setting reaches further out, which is the lead-time trade', () => {
  assert.deepEqual(pick([row()], 11 * 60, 120), []);
  assert.deepEqual(pick([row()], 11 * 60, 180), ['S1']);
});

test('the gate does not touch the tier that emails — critical alerts at any hour, gate or no gate', () => {
  // The gate is a door for AMBER only. It must neither open anything above the floor early
  // nor hold anything above the floor back.
  assert.deepEqual(pick([row({ tier: 'critical' })], 6 * 60), ['S1'], 'critical alerts with the gate off');
  assert.deepEqual(pick([row({ tier: 'critical' })], 6 * 60, 120), ['S1'], 'and far from the close');
  // Red is refused by the FLOOR, not by the gate — pinned in the first test in this file.
  assert.deepEqual(pick([row({ tier: 'red' })], 6 * 60, 120), [], 'red is below the floor, gate or no gate');
});

test('a shut door still sends nothing, gate or no gate', () => {
  assert.deepEqual(pick([row()], 14 * 60, 120), []);       // exactly at the close
  assert.deepEqual(pick([row()], 15 * 60, 120), []);       // past it
});

test('an amber no_driver_hours card is NOT emailable — its tier means scanner-guessed hours, not a small overrun', () => {
  assert.deepEqual(pick([row({ rule: 'no_driver_hours' })], 13 * 60, 120), []);
  // A no-driver card ABOVE the floor still alerts, exactly as before. It was written against a
  // RED one; red stopped emailing when Chad set the floor to critical on 2026-09-02, so the
  // case is pinned on the tier that can still send rather than quietly passing for the wrong
  // reason — the gate is not what refuses it.
  assert.deepEqual(pick([row({ rule: 'no_driver_hours', tier: 'critical' })], 13 * 60, 120), ['S1']);
  assert.deepEqual(pick([row({ rule: 'no_driver_hours', tier: 'red' })], 13 * 60, 120), [], 'red: below the floor');
});

test('a stop with NO deadline never earns an amber email — Number(null) is 0 and 0 is finite', () => {
  assert.deepEqual(pick([row({ closeMin: null })], 13 * 60, 120), []);
  assert.deepEqual(pick([row({ closeMin: undefined })], 13 * 60, 120), []);
});

test('no clock means no measurable lead, so the gate refuses rather than guesses', () => {
  assert.deepEqual(pick([row()], null, 120), []);
});

test('a malformed gate value cannot silently open the floodgates', () => {
  for (const bad of [NaN, -60, Infinity, undefined]) {
    assert.deepEqual(pick([row()], 13 * 60, bad), [], `gate ${bad} must not alert`);
  }
});

test('collapsed summary rows and stop-less rows still send nothing', () => {
  assert.deepEqual(pick([row({ collapsed: 5 })], 13 * 60, 120), []);
  assert.deepEqual(pick([row({ stopNbr: null })], 13 * 60, 120), []);
});

// ── A BROKEN CLOCK IS NOT "NO CLOCK" ──────────────────────────────────────────
//
// Found by an adversarial probe, not by reasoning: with Number('abc') as nowMin, the old
// guards let EVERY amber row through — including one whose close was ten hours out and one
// whose close had already passed — because NaN passes `!= null` and then fails every
// comparison it is used in. A pre-day board legitimately has no clock and must keep working.
test('a NaN clock does not open the gate — it is treated as no clock at all', () => {
  const far = row({ stopNbr: 'FAR', closeMin: 23 * 60 });   // ten hours out
  const past = row({ stopNbr: 'PAST', closeMin: 6 * 60 });  // already shut
  const near = row({ stopNbr: 'NEAR', closeMin: 14 * 60 });
  assert.deepEqual(pick([far, past, near], Number('abc'), 120), []);
  assert.deepEqual(pick([far, past, near], NaN, 180), []);
  // and the real clock still behaves
  assert.deepEqual(pick([far, past, near], 13 * 60, 120), ['NEAR']);
});

test('a NaN clock also cannot defeat the past-close refusal for red rows', () => {
  const shut = row({ tier: 'red', stopNbr: 'SHUT', closeMin: 6 * 60 });
  assert.deepEqual(pick([shut], Number('abc')), [], 'a shut door stays shut on a broken clock');
  assert.deepEqual(pick([shut], 13 * 60), [], 'and on a real one');
});

test('a row with no usable lateBy sorts last instead of scrambling the order at the cap', () => {
  const got = selectAlertable([
    row({ stopNbr: 'X', lateBy: undefined }),
    row({ stopNbr: 'Y', lateBy: 60 }),
    row({ stopNbr: 'Z', lateBy: 5 }),
  ], 13 * 60, 120).map((c) => c.stopNbr);
  assert.deepEqual(got, ['Y', 'Z', 'X'], 'worst first, unusable last');
});
