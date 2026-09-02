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
// THE GATE ONLY EXISTS BELOW THE FLOOR, SO THESE TESTS RUN AT THE FLOOR THAT HAS ONE.
//
// Chad narrowed the email floor to critical on 2026-09-02 ("We are only emailing on
// critical"), and the floor deliberately outranks this gate — see the first test below. The
// gate's own arithmetic did not change, so every rule it already pinned is still pinned; it
// is exercised at ALERT_MIN_TIER=red, which is where a gated amber can reach an inbox at all.
const pick = (rows, nowMin, gate) => selectAlertable(rows, nowMin, gate, 'red').map((c) => c.stopNbr);

test('THE FLOOR OUTRANKS THE GATE — at the shipped floor no amber emails, however wide the gate', () => {
  // Chad: "We are only emailing on critical." That sentence has to be true unconditionally,
  // or the day somebody sets AMBER_LEAD_GATE_MIN for the early-warning experiment the inbox
  // quietly starts contradicting the instruction with nobody having decided anything.
  assert.equal(ALERT_MIN_TIER, 'critical', 'the shipped floor');
  for (const gate of [0, 120, 180, 600]) {
    assert.deepEqual(selectAlertable([row()], 13 * 60, gate).map((c) => c.stopNbr), [],
      `an amber 60 minutes from its close must not email with the gate at ${gate}`);
  }
  // and a RED is below the floor too, gate or no gate
  assert.deepEqual(selectAlertable([row({ tier: 'red' })], 13 * 60, 180).map((c) => c.stopNbr), []);
  // while the tier Chad kept still emails
  assert.deepEqual(selectAlertable([row({ tier: 'critical' })], 13 * 60).map((c) => c.stopNbr), ['S1']);
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

test('red and critical are untouched by the gate at any hour', () => {
  for (const tier of ['red', 'critical']) {
    assert.deepEqual(pick([row({ tier })], 6 * 60), ['S1'], `${tier} must alert with the gate off`);
    assert.deepEqual(pick([row({ tier })], 6 * 60, 120), ['S1'], `${tier} must alert far from the close`);
  }
});

test('a shut door still sends nothing, gate or no gate', () => {
  assert.deepEqual(pick([row()], 14 * 60, 120), []);       // exactly at the close
  assert.deepEqual(pick([row()], 15 * 60, 120), []);       // past it
});

test('an amber no_driver_hours card is NOT emailable — its tier means scanner-guessed hours, not a small overrun', () => {
  assert.deepEqual(pick([row({ rule: 'no_driver_hours' })], 13 * 60, 120), []);
  // but a RED no-driver card still alerts, exactly as before
  assert.deepEqual(pick([row({ rule: 'no_driver_hours', tier: 'red' })], 13 * 60, 120), ['S1']);
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
  ], 13 * 60, 120, 'red').map((c) => c.stopNbr);
  assert.deepEqual(got, ['Y', 'Z', 'X'], 'worst first, unusable last');
});
