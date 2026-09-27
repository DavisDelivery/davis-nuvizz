// "NO TT STRAIGHT TRUCK ONLY" IS TWO INSTRUCTIONS, NOT ONE NEGATED ONE.
//
// The negation guard added for PRO 007173855 ("NO STRAIGHT TRUCK OR LIFT") lets up to two
// words sit between the NO and the phrase, so that "DO NOT SEND STRAIGHT TRUCK" still reads
// as a refusal. It accepted ANY word there, so a comment that lists two instructions with no
// punctuation between them — "NO TT" then "STRAIGHT TRUCK ONLY" — had the first instruction's
// NO cancel the second one. Nothing else catches it (ORDER_INSTR_PATTERNS has no NO TT or NO
// SEMI pattern), so the stop got no straight-truck flag at all, and that flag is what keeps
// it off a 53ft trailer (routing-constraints / TRAILER_BLOCKER_KEYS). Every one of these
// flagged before the guard shipped (#886).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanStop } from '../src/lib/signal-scanner.ts';

const order = (txt) => scanStop({ signalSources: { orderInstructions: txt } });
const addr2 = (txt) => scanStop({ signalSources: { addressLine2: txt } });

test('a Uline order reading "NO TT STRAIGHT TRUCK ONLY" still flags the stop straight-truck', () => {
  for (const txt of [
    'SPL-INSTR-TEXT: NO TT STRAIGHT TRUCK ONLY',
    'SPL-INSTR-TEXT: NO SEMI STRAIGHT TRUCK',
    'SPL-INSTR-TEXT: NO LG STRAIGHT TRUCK ONLY',
    'SPL-INSTR-TEXT: NO SEMIS STRAIGHT TRUCK ONLY',
    'SPL-INSTR-TEXT: NO DOCK STRAIGHT TRUCK ONLY',
    'SPL-INSTR-TEXT: NO LIFTGATE STRAIGHT TRUCK ONLY',
  ]) {
    const r = order(txt);
    assert.equal(r.length, 1, `${txt} must flag`);
    assert.equal(r[0].flagValue, 'uline_straight_truck');
  }
});

test('a dispatcher address line reading "NO SEMI STRAIGHT TRUCK ONLY" still blocks the tractor', () => {
  for (const txt of ['NO SEMI STRAIGHT TRUCK ONLY', 'NO DOCK BOX TRUCK ONLY']) {
    const r = addr2(txt);
    assert.equal(r.length, 1, `${txt} must flag`);
    assert.equal(r[0].flagValue, 'no_tractor_trailer');
  }
});

test('the refusals the guard was built for are still refusals', () => {
  // The words that may sit between the NO and the phrase are the ones that make it one
  // sentence — a verb (SEND, USE, DELIVER, SHIP, BRING) and the function words around it.
  for (const txt of [
    'NO STRAIGHT TRUCK OR LIFT',
    'NO STRAIGHT TRUCK OR LIFT\nGATE! MUST SHIP UPRIGHT.',
    'DO NOT SEND STRAIGHT TRUCK',
    'DO NOT USE A BOX TRUCK ONLY',
    'DO NOT SEND A STRAIGHT TRUCK',
    'DO NOT SEND ANY STRAIGHT TRUCK',
    'NEVER USE STRAIGHT TRUCK',
    "DON'T DELIVER ON STRAIGHT TRUCK",
    'DO NOT SHIP VIA STRAIGHT TRUCK',
    'SHOULD NOT BE ON STRAIGHT TRUCK',
    'CANNOT BE STRAIGHT TRUCK',
  ]) {
    assert.deepEqual(order(txt), [], `${txt} is a refusal and must not flag`);
  }
});

test('a dock that refuses the straight truck in its own words is still refusing — "WILL NOT ACCEPT STRAIGHT TRUCK"', () => {
  // Closing the bridge to nouns must not close it to the RECEIVING verbs. Every one of these
  // read as a refusal before the bridge became a closed list, and reading one as "straight
  // truck only" is the #886 inversion: the flag forces the 26ft box onto the stop that said no.
  for (const txt of [
    'WILL NOT ACCEPT STRAIGHT TRUCK',
    'CANNOT ACCEPT A STRAIGHT TRUCK',
    'CANNOT TAKE STRAIGHT TRUCK',
    'CAN NOT RECEIVE STRAIGHT TRUCK',
    'DOES NOT ALLOW STRAIGHT TRUCK',
    'NO DELIVERY BY STRAIGHT TRUCK',
    'NO DELIVERIES ON STRAIGHT TRUCK',
    'DO NOT DISPATCH STRAIGHT TRUCK',
    'DO NOT LOAD ON STRAIGHT TRUCK',
    'DO NOT PUT ON STRAIGHT TRUCK',
  ]) {
    assert.deepEqual(order(txt), [], `${txt} is a refusal and must not flag`);
  }
  // ...while a noun in the same slot is still the first of two instructions.
  assert.equal(order('NO LOADING DOCK STRAIGHT TRUCK ONLY')[0]?.flagValue, 'uline_straight_truck');
});
