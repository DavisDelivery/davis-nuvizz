// lib/handling-flags.js
//
// ORDER-LEVEL freight handling flags, read live from the order's own comments.
//
// WHY THIS IS NOT AN EQUIPMENT RESTRICTION, which is the whole point of the file.
// Everything in `customer_notes.equipment_restrictions` is keyed by LOCATION and holds
// for that address forever — correct for "no tractor trailer", because the dock does not
// change between Tuesday and Friday. "Do not double stack" is a property of THIS
// SHIPMENT'S freight: this week's order is fragile, next week's is bagged goods that
// stack fine. Writing it to the customer note would mark a customer permanently
// un-stackable off one order, and this repo has already paid for that exact mistake once
// (v0.99.3 — a location-keyed vehicle mark quietly pushing freight onto extra box trucks
// until somebody found the brush). So it is derived, never stored, and never written back.
//
// It is modelled on `stopLooksOversize` in App.jsx, which is the same shape: a pure
// order-level freight predicate rendered beside the customer restrictions rather than
// inside them.
//
// WHAT IT IS FOR, in freight terms: cube. A skid that cannot be double stacked occupies
// a floor position and nothing goes on top of it. The router's binding dimension is skid
// POSITIONS (routing-engine-config.mts, Phase 2.8), so a load of stackable skids and a
// load of no-stack skids of the same count are not the same truck.

/** The flag keys this module can produce. One entry per real handling constraint. */
export const NO_DOUBLE_STACK = 'no_double_stack';
export const STACKER = 'stacker';

// The phrasings Uline and Davis actually send, taken from the board rather than
// imagined. Both known corpus samples are the same sentence in different casing —
// "DO NOT DELIVER DOUBLE STACKED" (test/stop-notes-freshness.test.mjs) and
// "Do NOT Deliver Double Stacked" (2026-09-10 board) — so every pattern is
// case-insensitive and none of them assume the shouty form.
//
// EVERY PATTERN REQUIRES A NEGATION. "DOUBLE STACK" on its own is not a restriction:
// an order that says "DOUBLE STACK OK" or "CAN BE DOUBLE STACKED" is telling you the
// opposite, and a rule that fired on the bare phrase would invert the meaning of both.
// The negation token is what carries the instruction, so it is what the regex anchors on.
//
// The cost of the two mistakes is not symmetrical, which sets how generous these are:
// a MISS crushes freight and buys a damage claim; a FALSE POSITIVE costs one extra floor
// position on one truck. So the list is broad on phrasing and strict only about negation.
const NO_DOUBLE_STACK_PATTERNS = [
  // "DO NOT DOUBLE STACK", "DO NOT DELIVER DOUBLE STACKED", "DO NOT BE DOUBLE STACKED".
  // Up to two words may sit between the negation and the phrase — that is where DELIVER,
  // SHIP and BE turn up — but they must be plain words, so a ';' or a newline between two
  // separate comments cannot bridge "DO NOT BREAKDOWN SKID" into a following "DOUBLE ...".
  /\bDO\s*N(?:OT|'?T)\s+(?:\w+\s+){0,2}DOUBLE[\s-]*STACK(?:ED|ING|S)?\b/i,
  // "NO DOUBLE STACK", "NO DOUBLE STACKING", "NO DOUBLE-STACKED PALLETS".
  /\bNO\s+DOUBLE[\s-]*STACK(?:ED|ING|S)?\b/i,
  // Bare stacking refusals — "DO NOT STACK", "NO STACKING", "DON'T STACK PALLETS".
  /\bDO\s*N(?:OT|'?T)\s+STACK\b/i,
  /\bNO\s+STACK(?:ING)?\b/i,
  // "NOT STACKABLE", "NON-STACKABLE", "NON STACKABLE".
  /\bNO(?:T|N)[\s-]*STACKABLE\b/i,
  // "DOUBLE STACKING IS NOT ALLOWED", "DOUBLE STACK PROHIBITED".
  /\bDOUBLE[\s-]*STACK\w*\s+(?:IS\s+)?(?:NOT\s+(?:ALLOWED|PERMITTED)|PROHIBITED)\b/i,
  // The abbreviation itself, in case dispatch starts typing it the way Chad says it.
  /\bDNDS\b/i,
];

// A WALK-BEHIND STACKER ON THE ORDER. Chad: "I want to look for the text hydraulic
// stacker in the items on my deliveries."
//
// MATCHED ON THE NOUN, NOT THE FULL PHRASE, and the 2026-09-10 board is why. The item line
// reads "HYDRAULIC STACKER" while the Pre-Visit note on the same order reads "REDELIVER
// STRADDLE STACKER ON TRACTOR TRAILER 9/10" — same machine, two names, one of them written
// by a person in a hurry. A rule anchored on "hydraulic stacker" would read the item and be
// deaf to the note that actually says which truck it needs. \bSTACKERS?\b catches
// hydraulic, straddle, walkie and counterbalance without a vocabulary to maintain.
//
// WHY THIS CANNOT COLLIDE WITH THE RULE ABOVE: every no-double-stack pattern ends on a word
// boundary after STACK or STACKING, and "STACKER" has no boundary there — so "NO STACKERS"
// raises this flag and not that one. Pinned by a test, because the two rules sharing the
// root is exactly the kind of overlap that rots quietly.
const STACKER_PATTERNS = [
  /\bSTACKERS?\b/i,
];

// WHICH TEXT EACH RULE IS ALLOWED TO READ, and it is not the same text.
//
// The stacker is named in the ITEM LIST — that is where Chad reads it — so it scans the
// product names as well as the comments. NO_DOUBLE_STACK deliberately does NOT: Uline sells
// placards and labels, and a carton whose product name is "DO NOT STACK SIGN" is a box of
// signs, not freight that has to sit alone on the floor. Reading item text for that rule
// would flag the sign and cost a floor position on every truck carrying one.
const COMMENTS = 'comments';
const ITEMS = 'items';

const RULES = [
  { key: NO_DOUBLE_STACK, patterns: NO_DOUBLE_STACK_PATTERNS, sources: [COMMENTS] },
  { key: STACKER, patterns: STACKER_PATTERNS, sources: [COMMENTS, ITEMS] },
];

/**
 * How each flag renders. Kept HERE and deliberately NOT in App.jsx's RESTRICTION_ICONS:
 * that table feeds the map-marker pipeline and the legend, both of which describe a
 * LOCATION. A pin that wore this mark would be claiming the address cannot take stacked
 * freight, which is not what the order said. Separate table, separate meaning.
 */
export const HANDLING_FLAGS = {
  [NO_DOUBLE_STACK]: {
    short: 'DNDS',
    label: 'Do not double stack',
    // What it costs the load builder, in the words the tally uses.
    tally: 'no-stack',
    title: 'Do not double stack — this freight needs its own floor position',
  },
  [STACKER]: {
    short: 'STACKER',
    label: 'Hydraulic stacker',
    tally: 'stacker',
    title: 'Hydraulic stacker on this order — needs a tractor trailer, not a box truck',
    // The item-row mark Chad chose: a bright yellow disc with a dark H. Dark rather than
    // white because readableTextColor() (App.jsx) returns #1f2937 for any fill this light,
    // and white washes out on yellow at the 13px row size.
    badge: { fill: '#facc15', ink: '#1f2937', letter: 'H' },
    // A stacker rolls on its own castors off a dock or a tractor's deck. It does not come
    // down on a liftgate, which is what every box truck in this fleet has instead of a
    // dock. That makes this the one handling flag that constrains the TRUCK.
    needsTractor: true,
  },
};

/**
 * Find every handling flag in a blob of free text. Pure, and the only place the
 * phrasing rules live.
 *
 * @param {string|null|undefined} text
 * @returns {string[]} flag keys, stable order, no duplicates
 */
export function detectHandlingFlags(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) out.push(rule.key);
  }
  return out;
}

/**
 * The text on a stop that can carry a handling instruction.
 *
 * BOTH comment channels, because they are populated by different filters upstream:
 * `signalSources.orderInstructions` is the ORD_IN / SPL-INSTR-TEXT subset
 * (nuvizz-scan.mts:357) and is where every sample so far has arrived, while
 * `allComments` is the unfiltered list. Reading only the first would go silent the day
 * NuVizz files one of these under another comment type, and that failure would be
 * invisible — the chip would simply not be there, which looks exactly like freight that
 * stacks fine.
 */
function handlingTextForStop(stop) {
  const parts = [stop?.signalSources?.orderInstructions, stop?.orderInstructions];
  if (Array.isArray(stop?.allComments)) {
    for (const c of stop.allComments) if (c && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * The PRODUCT NAMES on a stop's line items, as one blob.
 *
 * stopDetails rides on the normalized stop already (nuvizz-scan.mts StopLineItem) — but
 * only on stops that have been ENRICHED. The cheap saved-search pull that builds the board
 * carries no line items at all, so an un-enriched stop yields '' here and its item-sourced
 * flags are silently absent. That is a real limit and it is why `stopHandlingFlags` still
 * reads the comments for the same rule: the note is on the cheap pull, the item list is not.
 */
function itemTextForStop(stop) {
  const lines = Array.isArray(stop?.stopDetails) ? stop.stopDetails : [];
  const parts = [];
  for (const d of lines) {
    if (d && typeof d.product === 'string') parts.push(d.product);
  }
  return parts.join('\n');
}

/** Flags from one rule set against one blob of text. */
function flagsFrom(text, source) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  for (const rule of RULES) {
    if (!rule.sources.includes(source)) continue;
    if (rule.patterns.some((p) => p.test(text))) out.push(rule.key);
  }
  return out;
}

/**
 * Handling flags for one normalized stop. Reads what is already on the row — no fetch,
 * no NuVizz call, no Firestore read.
 *
 * Each rule is tested only against the text it is allowed to read (see RULES.sources), so
 * a product called "DO NOT STACK SIGN" cannot raise the no-double-stack flag.
 *
 * @returns {string[]} flag keys, stable order, no duplicates
 */
export function stopHandlingFlags(stop) {
  const seen = new Set();
  const out = [];
  for (const k of [
    ...flagsFrom(handlingTextForStop(stop), COMMENTS),
    ...flagsFrom(itemTextForStop(stop), ITEMS),
  ]) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  // RULES order, so two surfaces listing the same stop never disagree about chip order.
  return RULES.map((r) => r.key).filter((k) => out.includes(k));
}

/** Does THIS one line item carry a handling flag? Used to mark the row it is on. */
export function itemHandlingFlags(item) {
  return flagsFrom(typeof item?.product === 'string' ? item.product : '', ITEMS);
}

/**
 * Does this stop's freight require a tractor trailer rather than a box truck?
 *
 * Derived from the handling flags rather than stored, so it can never outlive the order
 * that produced it — the whole reason this module exists.
 */
export function stopNeedsTractor(stop) {
  return stopHandlingFlags(stop).some((k) => HANDLING_FLAGS[k]?.needsTractor === true);
}

/** Convenience for the common single question. */
export function stopIsNoDoubleStack(stop) {
  return stopHandlingFlags(stop).includes(NO_DOUBLE_STACK);
}

/**
 * Count each flag across a set of stops — the number a load builder actually acts on.
 * "18 of 24 skids cannot be stacked" is a decision; one chip on one row is an input.
 *
 * Counts SKIDS, not orders, because floor positions are what run out. A stop with no
 * skid count still counts as one position rather than zero — freight that exists has to
 * go somewhere, and a zero here would understate a full truck.
 *
 * @returns {Record<string, {orders: number, skids: number}>}
 */
export function tallyHandlingFlags(stops) {
  const out = {};
  for (const s of stops || []) {
    const skids = Math.max(1, Math.round(Number(s?.cartons) || 0) || 1);
    for (const k of stopHandlingFlags(s)) {
      if (!out[k]) out[k] = { orders: 0, skids: 0 };
      out[k].orders += 1;
      out[k].skids += skids;
    }
  }
  return out;
}
