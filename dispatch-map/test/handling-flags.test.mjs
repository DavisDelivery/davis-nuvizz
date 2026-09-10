// DO NOT DOUBLE STACK is a fact about the FREIGHT, not about the address.
//
// Chad, on the 2026-09-10 board (192 unplanned orders, 5 of the 7 on screen carrying it):
// "DO ORDERS THAT HAVE DO NOT DOUBLE STACK IN THE NOTES SHOW UP HERE WITH A DNDS
// RESTRICTION" — they did not, anywhere. Every test below names the board condition it
// protects, and the phrasings are taken off real orders rather than invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectHandlingFlags,
  stopHandlingFlags,
  stopIsNoDoubleStack,
  tallyHandlingFlags,
  HANDLING_FLAGS,
  NO_DOUBLE_STACK,
} from '../src/lib/handling-flags.js';

// ── THE PHRASINGS THAT ARRIVE ────────────────────────────────────────────────

test('the exact string on the 2026-09-10 board flags — "Do NOT Deliver Double Stacked", mixed case', () => {
  // ART & ASSOCIATES / VERISMA / JAY BROKERS / FINDER RELAYS / SPORTOGRAPHY all carried
  // this verbatim. Uline does NOT shout it, so a rule written for the upper-case form
  // would have missed every one of them.
  assert.deepEqual(
    detectHandlingFlags('SPL-INSTR-TEXT: Do NOT Deliver Double Stacked'),
    [NO_DOUBLE_STACK],
  );
});

test('the upper-case form in the existing corpus flags — "DO NOT DELIVER DOUBLE STACKED"', () => {
  assert.deepEqual(
    detectHandlingFlags('TOTAL-AMOUNT : 84.21 DO NOT DELIVER DOUBLE STACKED INSIDE DELIVERY'),
    [NO_DOUBLE_STACK],
  );
});

test('every reasonable way to say it flags, because a miss crushes freight', () => {
  for (const text of [
    'DO NOT DOUBLE STACK',
    'DO NOT DOUBLE-STACK',
    "DON'T DOUBLE STACK",
    'NO DOUBLE STACKING',
    'NO DOUBLE STACKED PALLETS',
    'DO NOT STACK',
    'NO STACKING',
    'NOT STACKABLE',
    'NON-STACKABLE',
    'DOUBLE STACKING IS NOT ALLOWED',
    'DOUBLE STACK PROHIBITED',
    'DNDS',
  ]) {
    assert.deepEqual(detectHandlingFlags(text), [NO_DOUBLE_STACK], `should flag: ${text}`);
  }
});

// ── THE NEGATION IS THE WHOLE RULE ───────────────────────────────────────────

test('an order that says double stacking is FINE does not flag — the bare phrase is not a restriction', () => {
  // A rule that fired on "DOUBLE STACK" alone would invert the meaning of both of these
  // and cost a floor position on every truck that carried one.
  assert.deepEqual(detectHandlingFlags('DOUBLE STACK OK'), []);
  assert.deepEqual(detectHandlingFlags('CAN BE DOUBLE STACKED'), []);
  assert.deepEqual(detectHandlingFlags('PALLETS ARE STACKABLE'), []);
});

test('the other handling instructions on the same orders do NOT flag as no-stack', () => {
  // These ride alongside DNDS on the real board and are different jobs for different
  // people — "do not breakdown" is a dock instruction, not a cube fact. Folding them in
  // would put a DNDS chip on freight that stacks perfectly well.
  assert.deepEqual(detectHandlingFlags('SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID'), []);
  assert.deepEqual(detectHandlingFlags('SPL-INSTR-TEXT: DO NOT LAY PALLETS OF; SPL-INSTR-TEXT: BOXES ON THEIR SIDE'), []);
  assert.deepEqual(detectHandlingFlags('SPL-INSTR-TEXT: ALL FREIGHT DELIVERIES; SPL-INSTR-TEXT: MUST DELIVER AFTER 8AM'), []);
});

test('a semicolon between two comments cannot bridge one instruction into the next', () => {
  // NuVizz files each comment separately and the board joins them. "DO NOT BREAKDOWN
  // SKID" followed by a comment mentioning stacking must not read as "DO NOT ... STACK".
  assert.deepEqual(detectHandlingFlags('DO NOT BREAKDOWN SKID; DOUBLE STACK OK'), []);
});

// ── THE ABSENT, THE EMPTY AND THE MALFORMED ──────────────────────────────────

test('no comments at all is not a restriction', () => {
  assert.deepEqual(detectHandlingFlags(''), []);
  assert.deepEqual(detectHandlingFlags(null), []);
  assert.deepEqual(detectHandlingFlags(undefined), []);
  assert.deepEqual(detectHandlingFlags(42), []);
  assert.deepEqual(stopHandlingFlags(null), []);
  assert.deepEqual(stopHandlingFlags({}), []);
});

// ── WHERE IT READS FROM ──────────────────────────────────────────────────────

test('it reads the order-instructions channel, where every real sample has arrived', () => {
  const stop = { signalSources: { orderInstructions: 'SPL-INSTR-TEXT: Do NOT Deliver Double Stacked' } };
  assert.equal(stopIsNoDoubleStack(stop), true);
});

test('it ALSO reads the unfiltered comment list, so a re-filed comment type cannot silence it', () => {
  // orderInstructions is a FILTERED subset (ORD_IN / SPL-INSTR-TEXT only). If NuVizz
  // ever files one of these under another type, reading only that channel would go
  // quiet — and a missing chip looks exactly like freight that stacks fine.
  const stop = {
    signalSources: { orderInstructions: 'TOTAL-AMOUNT : 84.21' },
    allComments: [{ text: 'TOTAL-AMOUNT : 84.21' }, { text: 'DO NOT DOUBLE STACK' }],
  };
  assert.equal(stopIsNoDoubleStack(stop), true);
});

test('a malformed comment list does not throw', () => {
  assert.deepEqual(stopHandlingFlags({ allComments: [null, {}, { text: 5 }, 'x'] }), []);
});

// ── THE NUMBER A LOAD BUILDER ACTS ON ────────────────────────────────────────

test('the tally counts SKIDS, because floor positions are what run out', () => {
  const stops = [
    { cartons: 1, signalSources: { orderInstructions: 'Do NOT Deliver Double Stacked' } }, // ART & ASSOCIATES
    { cartons: 1, signalSources: { orderInstructions: 'Do NOT Deliver Double Stacked' } }, // VERISMA
    { cartons: 4, signalSources: { orderInstructions: 'DO NOT DOUBLE STACK' } },
    { cartons: 6, signalSources: { orderInstructions: 'MUST DELIVER AFTER 8AM' } },        // not a no-stack
  ];
  assert.deepEqual(tallyHandlingFlags(stops), {
    [NO_DOUBLE_STACK]: { orders: 3, skids: 6 },
  });
});

test('an order with no skid count still occupies a position — never zero', () => {
  // Freight that exists has to go somewhere. A zero here would understate a full truck,
  // which is the one direction this number must never be wrong in.
  const t = tallyHandlingFlags([{ signalSources: { orderInstructions: 'DO NOT STACK' } }]);
  assert.deepEqual(t[NO_DOUBLE_STACK], { orders: 1, skids: 1 });
});

test('a board with nothing to say tallies to nothing, not to zeroes', () => {
  assert.deepEqual(tallyHandlingFlags([{ cartons: 3 }, { cartons: 1 }]), {});
  assert.deepEqual(tallyHandlingFlags([]), {});
  assert.deepEqual(tallyHandlingFlags(null), {});
});

// ── IT IS NOT AN EQUIPMENT RESTRICTION ───────────────────────────────────────

test('the flag carries its own label table, separate from the location-keyed restrictions', () => {
  // If this ever lands in RESTRICTION_ICONS it becomes eligible for the map pin and the
  // legend, both of which describe an ADDRESS — and this one describes a shipment.
  assert.equal(HANDLING_FLAGS[NO_DOUBLE_STACK].short, 'DNDS');
  assert.equal(HANDLING_FLAGS[NO_DOUBLE_STACK].label, 'Do not double stack');
});
