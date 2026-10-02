// Address mis-split detection + auto-fix suggestion.
//
// NuVizz frequently returns the deliverable street in `addr2` while `addr1`
// holds a suite/dock/building token or a contact name (e.g. addr1 "BLDG 200" /
// addr2 "4310 INDUSTRIAL ACCESS RD", or addr1 "PROPERTY MANAGER" / addr2 "2611
// SPRINGDALE RD SW"). Because the client geocoder only ever sends `addr1`, those
// stops land on the wrong spot. These pure helpers (1) flag the pattern and
// (2) propose a corrected addr1/addr2 split so the street line gets geocoded.
//
// Conservative by design: only clear cases (a unit token leading addr1, or a
// numberless addr1 paired with a street-numbered addr2). The suite/contact text
// is always preserved in addr2 — never dropped.

import { normStreetOf } from './matchKey.js';

// Unit / non-street tokens that should never lead a street line.
export const UNIT_LEAD = /^\s*(suite|ste|unit|apt|apartment|#|bldg|building|dock|fl|floor|rm|room|lot|spc|space|gate)\b/i;

// A real street line starts with a house number. Flag when addr1 does NOT begin
// with a digit but addr2 DOES — the deliverable street is in addr2 and addr1 is a
// dock/descriptor/contact (e.g. addr1 "MGE1 NON INVENTORY DOCK DR 178" — note it
// HAS digits but doesn't START with the house number — and addr2 "652 BROADWAY
// AVE"). This is broader than "addr1 has no digit" and catches dock descriptors.
const STARTS_WITH_NUMBER = /^\s*\d/;

// True when a stop's addr1 looks mis-split. Clears automatically once the stop
// has an address_override (i.e. it's already been corrected).
export function addressLooksOff(stop, note) {
  if (!stop) return false;
  if (note && note.address_override) return false;
  const a1 = String(stop.addr1 || '').trim();
  const a2 = String(stop.addr2 || '').trim();
  if (!a1) return false;
  if (UNIT_LEAD.test(a1)) return true;                                  // suite/dock/contact token in front
  if (!STARTS_WITH_NUMBER.test(a1) && STARTS_WITH_NUMBER.test(a2)) return true; // street (house #) is in addr2
  return false;
}

// Propose a corrected { addr1, addr2, reason } split, or null when we can't
// confidently fix it (caller should fall back to a manual edit).
export function suggestAddressFix(stop) {
  if (!stop) return null;
  const a1 = String(stop.addr1 || '').trim();
  const a2 = String(stop.addr2 || '').trim();

  // Case A — addr1 leads with a unit/contact token.
  if (UNIT_LEAD.test(a1)) {
    // A1: the unit and the street share addr1 ("BLDG 200 4310 INDUSTRIAL ACCESS RD").
    // Split at the first run of digits that starts the street portion.
    const m = a1.match(/^\s*((?:suite|ste|unit|apt|apartment|#|bldg|building|dock|fl|floor|rm|room|lot|spc|space|gate)\b\.?\s*#?\s*\S+)\s+(\d.*)$/i);
    if (m) {
      const suite = m[1].trim(), street = m[2].trim();
      return { addr1: street, addr2: a2 ? `${suite}, ${a2}` : suite, reason: 'suite was in front of the street' };
    }
    // A2: addr1 is only the unit/contact ("BLDG 200"); the street is in addr2 → swap.
    if (/\d/.test(a2)) return { addr1: a2, addr2: a1, reason: 'street was in addr2 (swapped)' };
    return null; // can't confidently split
  }

  // Case B — addr1 doesn't start with a house number but addr2 does → swap so the
  // real street (e.g. "652 BROADWAY AVE") leads and the dock/descriptor moves to addr2.
  if (!STARTS_WITH_NUMBER.test(a1) && STARTS_WITH_NUMBER.test(a2)) {
    return { addr1: a2, addr2: a1, reason: 'street was in addr2 (swapped)' };
  }
  return null;
}

// ── DOES NUVIZZ HAVE THE ADDRESS OUR BOARD HAS? ─────────────────────────────
//
// Chad, 2026-10-01, on BRENT SCARBROUGHQTS (007184497): "why was this address not flagged?!?"
// and then: "Why are we not able to correct this one like we are all the others." The customer
// had been corrected ON OUR BOARD on Sep 15 — street first, the laydown yard as the second line
// — and addressLooksOff (above) stops judging the moment a correction exists, because our map,
// pin and routing use it. But a board correction covers the CUSTOMER and a NuVizz correction
// covers ONE ORDER, so every new order still arrived from NuVizz with the dock line first, and
// nothing on the Problem addresses list could see it. This is the comparison that can.

// USPS street-suffix and unit spellings normStreetOf does not fold. Applied HERE, token by token
// and only for this comparison, never inside normStreetOf: that function builds every customer
// key in the app, and widening it would re-key — and detach — every customer note on the board.
const FOLD = {
  lane: 'ln', court: 'ct', circle: 'cir', place: 'pl', terrace: 'ter', trail: 'trl',
  crossing: 'xing', square: 'sq', center: 'ctr', centre: 'ctr', expressway: 'expy',
  freeway: 'fwy', point: 'pt', ridge: 'rdg', landing: 'lndg', heights: 'hts', circuit: 'cir',
  building: 'bldg', floor: 'fl', room: 'rm', department: 'dept', number: 'no',
};
const foldLine = (v) => normStreetOf(v).split('_').map((t) => FOLD[t] || t).join('_');
// The two street lines as ONE run of words, in reading order — see sameDeliveryAddress.
const streetOf = (a) => [foldLine(a?.addr1), foldLine(a?.addr2)].filter(Boolean).join('_');
const cityOf = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const zipOf = (v) => String(v ?? '').replace(/[^0-9]/g, '').slice(0, 5);

/**
 * PURE: would these two addresses send a truck to the same door?
 *
 * THE WORDS ARE COMPARED IN THEIR ORDER, not as a bag: "DOCK 32" / "1200 NORTHBROOK PKWY" and
 * "1200 NORTHBROOK PKWY" / "DOCK 32" are the same words and a different manifest — the first puts
 * the dock where the driver's paperwork and NuVizz's geocode expect the street.
 *
 * BUT NOT BY WHERE THE LINE BREAKS. "1200 MAIN ST, STE 5" on one line and "1200 MAIN ST" / "STE 5"
 * on two read the same, top to bottom, on any manifest. Comparing line by line called that a
 * different address — and since a board correction covers every order and NuVizz's copy is per
 * order, it would have listed that customer on every order, every day, for a 3-call push that
 * moves a line break. (Measured on the real rule before this shipped, and the row could not even
 * be cleared: Correct + NuVizz prices a push by the one-line address, which read the same.)
 *
 * WHAT DOES NOT COUNT AS DIFFERENT, each because NuVizz or a person writes the same address
 * more than one way:
 *   • case, punctuation and spacing, and the suffix and suite spellings normStreetOf already
 *     folds (RD/ROAD, STE/SUITE, PKWY/PARKWAY …) plus the ones in FOLD above;
 *   • where the same words are split between the two lines (above);
 *   • the STATE. NuVizz stores "GEORGIA" for the "GA" we send (nuvizz-write.mts, the note above
 *     addressLanded), and the ZIP — which is compared — already says which state it is;
 *   • the city's spacing ("SUGAR HILL" / "SUGARHILL") and a ZIP+4 against its five digits.
 */
export function sameDeliveryAddress(a, b) {
  return streetOf(a) === streetOf(b)
    && cityOf(a?.city) === cityOf(b?.city)
    && zipOf(a?.zip) === zipOf(b?.zip);
}
