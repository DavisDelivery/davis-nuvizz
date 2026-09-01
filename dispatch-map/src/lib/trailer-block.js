// src/lib/trailer-block.js — "can a 53' trailer serve this stop, and who said so?"
//
// PURE, AND DELIBERATELY DEPENDENCY-FREE. This module imports nothing. It was carved out of
// map-legend.js (which still re-exports every name here, so nothing that already imported
// them had to change) for one structural reason: the BOARD FLAGS engine has to ask the same
// question the map asks, and map-legend.js sits on the wrong side of a cycle to be asked —
// map-legend → time-marks → board-flags. Copying the rules into board-flags.js instead is
// exactly the failure v0.76.4 was spent undoing: three call sites, one two-line ternary, and
// only two of them written correctly. One definition, every reader.
//
// The vocabulary below answers two different questions and they must not be conflated:
//   isTrailerBlockerKey  — does this mark mean "no 53-footer"?
//   restrictionConfidence — did a HUMAN say it, or did a scanner find it in someone's text?

// Restrictions that mean "a 53' trailer cannot serve this stop". A dispatcher who has marked
// the stop tractor-OK by hand has overruled the auto-detected ones, so they stop drawing.
//
// 'no_53ft' AND 'no_53' ARE BOTH HERE BECAUSE THE APP WRITES ONE AND EVERY RULE READS THE
// OTHER. The dispatcher's Equipment restrictions dropdown offers `{ value: 'no_53ft', label:
// 'No 53ft' }` and RESTRICTION_ICONS defines the glyph under `no_53ft` — so `no_53ft` is what
// actually lands on a note. This set, the routing solver and its constraint switch all spell
// it `no_53`, and nothing translates between them, so the single most literal "a 53-footer
// cannot come here" mark a dispatcher can tick was landing in a set that had never heard of
// it. Run against the real functions, a hand-ticked No 53ft returned confirmedBlockerKeys []
// and tractorPaintAllowed TRUE — the map kept painting the stop lime, "a tractor delivered
// here", which is precisely what the tractor override exists to stop.
//
// Both spellings are kept rather than one renamed: `no_53` is live in stored notes and in the
// routing engine's own types, and dropping it would silently un-restrict whatever carries it.
//
// THE ROUTING ENGINE HAS THE SAME SPLIT AND IT IS NOT FIXED HERE. equipmentReqOk in
// netlify/functions/lib/routing-constraints.mts matches `case 'no_53'` and falls through to
// `default: { ok: true }` — "unknown restriction → don't block" — so an auto-build can still
// put a 53' trailer on a stop marked No 53ft. That is a change to which truck gets which
// stop, so it belongs in its own diff with its own tests rather than riding along inside an
// icon change.
export const TRAILER_BLOCKER_KEYS = new Set([
  'no_tractor_trailer', 'box_truck_only', 'straight_truck_only', 'uline_straight_truck',
  'no_53', 'no_53ft', '26ft_max', 'no_overhead_clearance',
]);

// The words a dispatcher actually TICKED, so a flag card and a text quote the restriction
// back in the language of the dropdown they set it in (App.jsx EQUIPMENT_OPTIONS) rather
// than inventing a synonym. Aliases map to the label of the key they resolve to.
export const TRAILER_BLOCKER_LABEL = {
  no_tractor_trailer: 'No tractor trailer',
  box_truck_only: 'Box truck only',
  straight_truck_only: 'Box truck only',
  uline_straight_truck: 'Uline: straight truck (advisory)',
  no_53: 'No 53ft',
  no_53ft: 'No 53ft',
  '26ft_max': '26ft max',
  no_overhead_clearance: 'Low overhead clearance',
};

/** The ticked labels for a set of blocker keys, deduped and in the order given. An unknown
 *  key falls back to its raw name rather than being dropped — a restriction nobody can name
 *  is still a restriction, and silently losing it would understate the card. */
export function trailerBlockerLabels(keys) {
  const out = [];
  for (const k of keys || []) {
    const label = TRAILER_BLOCKER_LABEL[k] || String(k);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

// HOW SURE ARE WE THAT A 53-FOOTER CAN'T SERVE THIS STOP?
//
// Chad: "unless we have manually came in and marked it not tractor trailer with the
// override ... for the uline advisory and auto find no tractor trl tags ... make the icon
// half red or yellow then the other half green."
//
// Three different things render as one flat "no tractor trailer" mark, and they carry very
// different weight:
//
//   CONFIRMED — a dispatcher opened the stop and ticked the box. A human looked at this
//               customer and said no. Treat as fact.
//   ADVISORY  — a scanner found it. Either the Uline flag (uline_straight_truck, which
//               customer-notes-writer itself labels "Uline-supplied, advisory"), or a
//               no_tractor_trailer the scanner read out of an address line. Nobody has
//               confirmed it, and the scanner reads free text written by other people.
//
// The distinction is not cosmetic: on an advisory mark a tractor may well be fine, and a
// dispatcher who cannot tell the two apart either wastes a trailer slot on a stop that
// would have taken one, or sends a 53-footer somewhere it physically cannot turn around.
// Painting both the same colour throws away information the database already has.
//
// PROVENANCE, NOT GUESSWORK. auto_sources[flag] is written by the scanner every time it
// detects a flag, and manual_overrides.equipment_restrictions is set the moment a
// dispatcher edits the restriction list. So "did a person put this here" is answerable
// from the note itself — no heuristics.
//
// UNKNOWN COUNTS AS CONFIRMED. A flag with no auto_sources trail was not put there by the
// scanner, so a person put it there — and on the one that decides whether a truck can
// physically make a delivery, the unknown case belongs on the CAUTIOUS side.
export const ADVISORY_ONLY_KEYS = new Set(['uline_straight_truck']);

export function restrictionConfidence(note, key) {
  // The Uline flag is advisory BY DEFINITION — it is another company's free text about
  // their own shipment, not a statement about this dock. It never hardens on its own; a
  // dispatcher ticking the restriction list is what promotes it.
  const manual = note?.manual_overrides?.equipment_restrictions === true;
  if (manual) return 'confirmed';
  if (ADVISORY_ONLY_KEYS.has(key)) return 'advisory';
  const autoSources = note?.auto_sources?.[key];
  const scannerPutItThere = Array.isArray(autoSources) ? autoSources.length > 0 : !!autoSources;
  return scannerPutItThere ? 'advisory' : 'confirmed';
}

/**
 * Is this key a trailer blocker, ALIASES INCLUDED?
 *
 * The marker resolves aliases before it asks (straight_truck_only is box_truck_only under
 * another name), so these helpers have to as well or one stop gets two answers from the pair
 * of functions v0.76.4 merged specifically so that could not happen — a badge on the pin the
 * paint rule has never heard of.
 *
 * `resolve` is injected rather than imported because the alias table lives in App.jsx and this
 * module is the pure one. Absent, the raw key is used, which is the behaviour every existing
 * two-argument caller already had — and it is safe for the server-side callers because BOTH
 * spellings of every aliased blocker (straight_truck_only / box_truck_only, no_53 / no_53ft)
 * are already members of TRAILER_BLOCKER_KEYS.
 */
export function isTrailerBlockerKey(key, resolve) {
  if (TRAILER_BLOCKER_KEYS.has(key)) return true;
  const r = typeof resolve === 'function' ? resolve(key) : null;
  return !!r && TRAILER_BLOCKER_KEYS.has(r);
}

/** The trailer-blockers on this note that a HUMAN has confirmed. Advisory ones excluded.
 *  NOTE the asymmetry, and it is deliberate: membership is tested on the RESOLVED key, but
 *  confidence is read with the key AS WRITTEN — auto_sources is stamped by the scanner under
 *  the raw key, so resolving it there would look up a field that does not exist and turn every
 *  aliased advisory into a confirmed one. */
export function confirmedBlockerKeys(note, drawnKeys, resolve) {
  return (drawnKeys || []).filter(
    (k) => isTrailerBlockerKey(k, resolve) && restrictionConfidence(note, k) === 'confirmed',
  );
}

/**
 * HAS A DISPATCHER HARD-CODED THIS LOCATION AS "NO TRACTOR TRAILER"?
 *
 * Chad, asking for the overnight text to carry these: "stops we have put on a tractor that
 * have been hardcoded as no tractor trailer by a dispatcher. Not the Uline advisory ones that
 * we pick up automatically just the dispatcher hardcoded ones."
 *
 * So this is deliberately the CONFIRMED half of restrictionConfidence and nothing else — the
 * amber Uline advisory a scanner lifted out of somebody else's order text is exactly what he
 * excluded, and it stays excluded here even though it IS a trailer blocker for map-drawing
 * purposes. Two ways a human says no, and both count:
 *
 *   • the Routing paint — vehicle_eligibility 'box_only', a dropdown only a dispatcher
 *     can reach, so it is confirmed by construction (this is what tractorPaintAllowed
 *     already treats as unarguable);
 *   • a confirmed trailer-blocker in the Equipment restrictions list.
 *
 * AND THE SAME OVERRIDE THE MAP HONOURS. vehicle_eligibility 'tractor' is a dispatcher
 * standing at the same dropdown saying a 53-footer DOES fit, and drawnRestrictionKeys already
 * drops every trailer blocker behind it. A flag that fired anyway would be telling the
 * dispatcher off for answering the question this rule is asking.
 *
 * `tractor_trailer_friendly` in the restriction list does NOT override, and that asymmetry
 * is the map's, not a new decision: getRestrictionBadgeKeys suppresses the positive kind when
 * a real "no tractor trailer" sits beside it — the restriction wins.
 *
 * Returns { blocked, keys, via } — `via` is 'eligibility' | 'restriction' | null, so a
 * message can say WHICH statement it is quoting rather than asserting a generic one.
 */
export function dispatcherTrailerBlock(note, resolve = null) {
  const none = { blocked: false, keys: [], via: null };
  if (!note) return none;
  if (note.vehicle_eligibility === 'tractor') return none;   // the dispatcher's own "it fits"
  const keys = confirmedBlockerKeys(note, note.equipment_restrictions || [], resolve);
  if (note.vehicle_eligibility === 'box_only') return { blocked: true, keys, via: 'eligibility' };
  return keys.length ? { blocked: true, keys, via: 'restriction' } : none;
}
