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

// ── THE STACKER, PRO 007173855 (SHARPS MWS, redelivered 2026-09-10) ──────────
//
// The order that produced this rule. A 1,259 lb walk-behind stacker went out on 09-09,
// came back undelivered, and its Pre-Visit note for the redelivery read "REDELIVER
// STRADDLE STACKER ON TRACTOR TRAILER 9/10". Chad: "I want to look for the text hydraulic
// stacker in the items on my deliveries" and "throw a flag if i try to put this on a box
// truck."

import { itemHandlingFlags, stopNeedsTractor, STACKER } from '../src/lib/handling-flags.js';

const SHARPS = {
  signalSources: {
    orderInstructions: [
      '**REDELIVER STRADDLE STACKER ON TRACTOR TRAILER 9/10**',
      'NO STRAIGHT TRUCK OR LIFT',
      'GATE! MUST SHIP UPRIGHT.',
      'TOTAL-AMOUNT : 203.62',
    ].join('\n'),
  },
  stopDetails: [
    { product: 'VINYL BAGS' }, { product: 'PLASTIC WATER COOLERS' }, { product: 'KNIVES' },
    { product: 'PALLET STRETCH WRAP 15PCF' }, { product: 'MISC' },
    { product: 'HYDRAULIC STACKER' }, { product: 'PLATFORM TRUCK' },
  ],
};

test('the real order flags — the ITEM says HYDRAULIC, the NOTE says STRADDLE, one machine', () => {
  assert.deepEqual(stopHandlingFlags(SHARPS), [STACKER]);
  assert.equal(stopNeedsTractor(SHARPS), true);
});

test('matching the noun, not the phrase — a rule anchored on "hydraulic stacker" is deaf to the note that names the truck', () => {
  // The note carries the operational instruction and never says "hydraulic".
  assert.deepEqual(
    detectHandlingFlags('REDELIVER STRADDLE STACKER ON TRACTOR TRAILER 9/10'),
    [STACKER],
  );
  assert.deepEqual(detectHandlingFlags('WALKIE STACKER'), [STACKER]);
});

test('the mark lands on the ONE line that named it, not on all seven', () => {
  const marked = SHARPS.stopDetails.filter((d) => itemHandlingFlags(d).includes(STACKER));
  assert.deepEqual(marked.map((d) => d.product), ['HYDRAULIC STACKER']);
  // PLATFORM TRUCK is Uline material handling too, and it is a 174 lb one-man tilt-and-roll.
  assert.deepEqual(itemHandlingFlags({ product: 'PLATFORM TRUCK' }), []);
});

test('a box of placards cannot cost a floor position — item text is NOT read for no-double-stack', () => {
  // Uline sells "DO NOT STACK" signs. Reading product names for that rule would flag the
  // carton of signs as un-stackable freight on every truck that ever carries one.
  const signs = { stopDetails: [{ product: 'DO NOT STACK SIGN' }] };
  assert.deepEqual(stopHandlingFlags(signs), []);
  // …while the same words in the ORDER'S NOTES still mean what they say.
  assert.deepEqual(
    stopHandlingFlags({ signalSources: { orderInstructions: 'DO NOT STACK' } }),
    [NO_DOUBLE_STACK],
  );
});

test('the two rules share a root and must not bleed — "NO STACKERS" is a stacker, not a stacking refusal', () => {
  // Every no-double-stack pattern ends on a word boundary after STACK/STACKING; "STACKER"
  // has none there. This is the guard for that overlap.
  assert.deepEqual(detectHandlingFlags('NO STACKERS'), [STACKER]);
  assert.deepEqual(detectHandlingFlags('NOT STACKABLE'), [NO_DOUBLE_STACK]);
});

test('an un-enriched stop has no item list, and says nothing rather than saying clean', () => {
  // The cheap saved-search pull that builds the board carries no stopDetails at all. The
  // note is still read, which is why the same flag has two sources.
  assert.deepEqual(stopHandlingFlags({ stopDetails: [] }), []);
  assert.deepEqual(
    stopHandlingFlags({ stopDetails: [], signalSources: { orderInstructions: 'STRADDLE STACKER' } }),
    [STACKER],
  );
});

test('only a flag that declares needsTractor moves the truck — DNDS does not', () => {
  assert.equal(HANDLING_FLAGS[STACKER].needsTractor, true);
  assert.equal(stopNeedsTractor({ signalSources: { orderInstructions: 'Do NOT Deliver Double Stacked' } }), false);
});

test('the item badge is specified once, so the row and any other surface cannot drift', () => {
  const b = HANDLING_FLAGS[STACKER].badge;
  assert.equal(b.letter, 'H');
  assert.equal(b.fill, '#facc15');
  // Dark, not white: readableTextColor() returns #1f2937 for any fill this light, and a
  // white H on bright yellow is unreadable at the 13px item-row size.
  assert.equal(b.ink, '#1f2937');
});
