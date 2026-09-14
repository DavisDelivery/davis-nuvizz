// src/lib/hours-provenance.js — WHO PUT THESE RECEIVING HOURS HERE? (PURE)
//
// Chad, 2026-09-14, on a WEAVER DISTRIBUTORS stop card showing MON–SUN 8:00a–12:00p:
// "we are flagging this stop incorrectly as having shortened hours when they just close for
// lunch ... as well as i think that our system auto updated the hours at the bottom."
//
// HE HAD TO GUESS, AND HE WAS RIGHT. The hours grid on the stop card renders seven days and
// says nothing about where they came from — so a window the parser read off one order's text
// looks exactly like a window a colleague typed after phoning the dock. Those two call for
// opposite actions: one is a guess to check, the other is knowledge to trust. The board FLAG
// has disclosed this for months ("Hours auto-detected — verify", board-flags.js), and the PRO
// report has a whole column for it (HOURS_SOURCE_LABEL, time-restrictions.js). The card a
// dispatcher actually opens was the one surface that never said.
//
// EVERYTHING THIS NEEDS IS ALREADY ON THE DOC — no schema change, no migration:
//   manual_overrides.receiving_hours  — the latch the stop card's own editor stamps, and the
//                                       only thing in the repo that sets it (v0.76.7). True
//                                       means a human owns the field and the scanner will not
//                                       touch it.
//   auto_sources.receiving_hours      — the scanner's fingerprint: which signal source it read.
//   auto_matches.receiving_hours[].text — THE EXACT TEXT IT MATCHED.
//
// That last one earns its place twice over. The schema holds ONE window per day, so a customer
// who breaks for lunch is stored as the envelope (8:00a–5:00p) and the break itself has nowhere
// to live — see envelopeClose in signal-scanner.ts for why that is the right call for flagging.
// But the matched text is the raw evidence, lunch line and all: showing it puts
// "RH 8 00AM-12 00PM LUNCH 12 00-1 30PM RH 1 30PM-5 00PM" under the grid, so the dispatcher who
// is sequencing the route can see the dock is shut over lunch even though the stored window
// cannot say so. The envelope is what the rules compare against; the text is what a person reads.
//
// PURE. No clock, no network, no Firestore.

/** Does this doc actually carry receiving hours, or only the blank seven-day skeleton? */
export function hasStoredHours(note) {
  const hrs = note?.receiving_hours;
  if (!hrs || typeof hrs !== 'object') return false;
  // The SAME emptiness test decideWrite uses (customer-notes-writer.ts). emptyNote() seeds all
  // seven days as { open: '', close: '' } to keep the <input type="time"> controls controlled,
  // and every note save persists that skeleton — so "seven keys exist" has never meant "this
  // customer has hours". Counting keys instead of values is the bug that once made the scanner
  // treat an un-owned doc as locked; it must not come back here as a phantom Hours section.
  return Object.values(hrs).some((v) => (
    typeof v === 'string'
      ? v.trim() !== ''
      : !!v && (String(v?.open ?? '').trim() !== '' || String(v?.close ?? '').trim() !== '')
  ));
}

/**
 * hoursProvenance(note) → { kind, label, detail, matchedText, matchedSource } | null
 *
 *   kind 'dispatcher' — somebody typed these and latched the field. The parser cannot move them.
 *   kind 'auto'       — the scanner read them off an order's instructions. A guess to verify.
 *   kind 'unrecorded' — hours are on file with no trail either way (a legacy M2.x doc, or a
 *                       hand-shaped map saved before the latch existed). Saying "we do not know
 *                       who set these" is honest; guessing 'dispatcher' would launder a parse.
 *
 * null when the doc carries no hours at all — there is nothing to attribute, and a provenance
 * line under an absent grid would be furniture.
 */
export function hoursProvenance(note) {
  if (!hasStoredHours(note)) return null;
  if (note?.manual_overrides?.receiving_hours === true) {
    return {
      kind: 'dispatcher',
      label: 'Set by a dispatcher',
      detail: 'Typed here for this customer. The order-text parser will not change them.',
      matchedText: '',
      matchedSource: '',
    };
  }
  const sources = note?.auto_sources?.receiving_hours;
  const match = note?.auto_matches?.receiving_hours?.[0] || null;
  if (Array.isArray(sources) ? sources.length > 0 : !!match) {
    const src = (Array.isArray(sources) && sources[0]) || match?.source || '';
    return {
      kind: 'auto',
      label: 'Auto-detected — verify',
      // WHICH source, because the two are not equally trustworthy and the repo has said so
      // since the scanner shipped: addressLine2 is curated by Davis dispatchers, while
      // orderInstructions is whatever Uline sent on this order.
      detail: src === 'addressLine2'
        ? 'Read from the address line Davis curates. Check it if it looks wrong.'
        : 'Read from this order’s instructions, not typed by anyone. Check it if it looks wrong.',
      matchedText: String(match?.text ?? '').trim(),
      matchedSource: src,
    };
  }
  return {
    kind: 'unrecorded',
    label: 'Source not recorded',
    detail: 'On file from before the app tracked who set hours.',
    matchedText: '',
    matchedSource: '',
  };
}
