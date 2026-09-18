// Match-key normalization for customer_notes lookup.
// Spec: take (businessName, addressLine1, city, zip), normalize suffixes,
// strip punctuation, collapse whitespace to underscores, and join with __ separators.
// The same business at the same street address across different PROs must produce
// the same key, even if NuVizz returns slightly different name casing or trailing "LLC".

const NAME_SUFFIXES = /\b(llc|inc|corp|corporation|company|co|ltd)\b\.?/g;

const STREET_REPLACEMENTS = [
  [/\b(suite|ste|unit|apt)\b\.?\s*#?/g, 'ste_'],
  [/\b(parkway|pkwy)\b\.?/g, 'pkwy'],
  [/\b(boulevard|blvd)\b\.?/g, 'blvd'],
  [/\b(drive|dr)\b\.?/g, 'dr'],
  [/\b(street|st)\b\.?/g, 'st'],
  [/\b(road|rd)\b\.?/g, 'rd'],
  [/\b(avenue|ave)\b\.?/g, 'ave'],
  [/\b(highway|hwy)\b\.?/g, 'hwy'],
  [/\b(north|n)\b\.?/g, 'n'],
  [/\b(south|s)\b\.?/g, 's'],
  [/\b(east|e)\b\.?/g, 'e'],
  [/\b(west|w)\b\.?/g, 'w'],
];

const safe = (v) => (v == null ? '' : String(v));

// Exported (v1.20.0) so the address-change log normalises a street line the SAME way the
// place key does. A second copy of these rules is how the log and the board would come to
// disagree about what "the same address" means — the drift placeKeyOfStop's comment exists
// to prevent, arriving from a new direction.
export function normStreetOf(addressLine1) {
  let normStreet = safe(addressLine1).toLowerCase();
  for (const [re, sub] of STREET_REPLACEMENTS) normStreet = normStreet.replace(re, sub);
  // TRIM BEFORE THE COLLAPSE, NOT AFTER. This ran .replace(/\s+/g,'_') first and .trim()
  // second — and trim() removes whitespace, not underscores, so a padded address line came
  // out as "_1_main_st_" while the same address unpadded came out "1_main_st". Every caller
  // of placeKeyOfStop then read one dock as two: the co-location grouping that decides
  // whether two orders share a pin, the same-address twin guard that exists so a delivery is
  // not left on the floor beside its pickup, and the board-flags trailer rule. NuVizz pads
  // address lines, so this was reachable with live data, and the file's own comment warns
  // about this exact hazard one function down ("a whitespace-only address line normalises
  // to '_'"). Same rule, applied one line earlier.
  return normStreet
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

// See the zip comment in normalizeMatchKey — same rule, shared so the two keys agree.
const zip5Of = (zip) => safe(zip).replace(/[^\w]/g, '').substring(0, 5);

/**
 * WHICH PHYSICAL PLACE IS THIS STOP AT — street + zip, and deliberately nothing else.
 *
 * THE DELIVERY THIS EXISTS FOR (Chad, 2026-09-09): "there was a pick up and delivery going to
 * same place — it did not grab the delivery on the initial pull, so when i assigned the orders
 * to the route the delivery was left unplanned on the map." Both orders were at 3190 REPS
 * MILLER RD STE 200, 30071, their pins 6.5 metres apart. The app already had a guard for
 * exactly this (the same-address twin guard, v0.45.2) and it did not fire, because "same
 * place" was answered by normalizeMatchKey — which begins with the BUSINESS NAME:
 *
 *   delivery 007173389  FEDEX OFFICE 10043FK04301103   NORCROSS   -> fedex_office_10043fk...
 *   pickup   RA59223377 FEDEX OFFICE                   NIORCROSS  -> fedex_office__...
 *
 * Two independent mismatches on one building: NuVizz puts the FedEx reference inside the
 * delivery's NAME, and the pickup's CITY is misspelled in the vendor's own data. A key built
 * to answer "is this the same customer" cannot answer "is this the same dock", and using it
 * for both is what left an order on the floor with no warning.
 *
 * So: no name (it carries order-specific text), and no city (it is free text and was
 * misspelled here) — the street line and the zip, which were byte-identical for both orders.
 * A different suite is a different place and still keys apart, which is the behaviour a
 * dispatcher expects: STE 200 and STE 400 are two stops.
 *
 * Returns '' when there is not enough to identify a place; callers fall back rather than
 * grouping every address-less stop into one bucket.
 */
export function normalizePlaceKey(addressLine1, zip) {
  const street = normStreetOf(addressLine1);
  const z = zip5Of(zip);
  // TRUTHY IS NOT THE SAME AS USABLE. A whitespace-only address line normalises to "_" —
  // the collapse turns the spaces into an underscore and trim() does not remove it — so the
  // naive `if (!street)` let it through and produced "___30071", a key every address-less
  // order in that zip would share. They would then all ride onto the first route touched:
  // the exact opposite failure, and a much more expensive one than the bug being fixed.
  if (!/[a-z0-9]/.test(street) || !/[a-z0-9]/.test(z)) return '';
  return `${street}__${z}`;
}

/**
 * WHICH DOCK IS THIS STOP AT — the place key plus the fallbacks, in ONE place.
 *
 * v0.99.4 fixed three things that each asked "same dock?" and each answered it with the
 * customer match key; they failed together because they were written separately. This exists
 * so a FOURTH consumer cannot re-introduce the drift by copying the fallback chain slightly
 * wrong: the board-flags trailer rule needs the same answer the grab and the twin guard give.
 *
 * The fallbacks are ordered by how much they can be trusted to mean "the same building":
 * street+zip first; then the customer match key (right for a stop with no address line, wrong
 * across a renamed customer); and finally the stop number, which groups a stop only with
 * itself — the correct answer when nothing else can be known.
 */
export function placeKeyOfStop(s) {
  return normalizePlaceKey(s?.addr1, s?.zip) || s?.matchKey || String(s?.stopNbr ?? '');
}

/**
 * THE NAME HALF OF THE KEY, on its own.
 *
 * Exported for the same reason normStreetOf above was: a second copy of these rules is how
 * two readers come to disagree about what "the same customer" means. The Stop lookup screen
 * groups a day's board by CUSTOMER NAME — the board carries no customerMatchKey at all
 * (routing-cleanup-core says so in as many words), so "is this EARTHLY ALTERNATIVE" has to be
 * answered from the name text, and it must be answered the same way the match key answers it
 * or a location would group one way for notes and another way for counting.
 *
 * BYTE-IDENTICAL TO WHAT normalizeMatchKey ALWAYS DID, and that is not a style note. The
 * first cut of this also stripped the leading/trailing underscores a removed suffix leaves
 * behind ("ACME LLC" → "acme_"), which reads like tidying and CHANGES THE MATCH KEY:
 * `acme___100_peachtree...` became `acme__100_peachtree...`. customer_notes is stored under
 * that key, so every receiving-hours note, address override, pin and opt-out for a customer
 * whose name ends in LLC/INC/CORP would have detached from its customer in silence. Three
 * parity tests caught it (match-key-parity, place-key, seal-paint-hardening) — they exist
 * because the client and the server each have to build this key and must never disagree.
 *
 * So the trailing underscore STAYS here. Grouping a screen by customer wants it gone, and
 * that is a different question with a different answer: customerNameKey in
 * src/lib/stop-lookup.js trims it, and never touches this.
 */
export function normNameOf(businessName) {
  return safe(businessName)
    .toLowerCase()
    .replace(NAME_SUFFIXES, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '_')
    .trim();
}

export function normalizeMatchKey(businessName, addressLine1, city, zip) {
  const normName = normNameOf(businessName);

  const normStreet = normStreetOf(addressLine1);

  const normCity = safe(city).toLowerCase().replace(/[^\w]/g, '');
  // Strip non-word chars BEFORE slicing (name/street/city already do this): a zip
  // like "3/456" must not smuggle a '/' into the match key, which would make an
  // illegal Firestore doc path downstream (tractor_locations / history_customers).
  // No-op for normal 5-digit or ZIP+4 values (digits are word chars; the dash in
  // "30301-1234" falls past position 5 anyway), so existing keys are unchanged.
  const zip5 = zip5Of(zip);

  return `${normName}__${normStreet}__${normCity}__${zip5}`;
}
