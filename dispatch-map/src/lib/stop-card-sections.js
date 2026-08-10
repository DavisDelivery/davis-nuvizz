// src/lib/stop-card-sections.js
//
// Pure display rules for two sections of the stop card, kept out of App.jsx so
// they can be unit-tested. Both exist because of a defect the dispatcher hit.

// ── ROUTE section: the load number line ──────────────────────────────────────
// The Route box prints the route NAME in bold and the load NUMBER in small grey
// mono underneath. For most loads those are different strings and the second
// line is a real identifier worth showing. But NuVizz often names a route after
// its load — a route called VINCENT on load VINCENT — and then the card printed
// the same word twice, one above the other, which reads as a rendering bug.
//
// Returns the load number to print under the route name, or null when it would
// merely repeat what is already on the line above. Case- and space-insensitive:
// "VINCENT" and " vincent " are the same identifier wearing different clothes.
export function routeLoadLine(stop) {
  const route = norm(stop?.routeName);
  const load = String(stop?.loadNbr ?? '').trim();
  if (!load) return null;
  if (!route) return null;              // no route name ⇒ the bold line IS the load number
  return norm(load) === route ? null : load;
}

function norm(v) {
  return String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

const POD_IMAGE_RE = /^(jpe?g|png|gif|webp)$/i;
export const isPodImageExt = (ext) => POD_IMAGE_RE.test(String(ext || ''));

// ── PROOF OF DELIVERY: when to offer "View delivery photos" ──────────────────
// The driver's capture photos are NOT returned by the cheap scan — NuVizz only
// hands them over on a /stop/info pull — so the card offers a button to fetch
// them on demand.
//
// TWO GATES HAVE NOW HIDDEN THAT BUTTON, and both were the same mistake: making
// a QUESTION the dispatcher wants to ask conditional on something the app
// believes.
//   1. It first lived inside "this stop has NO documents at all", so the moment
//      an order picked up a BOL the button vanished.
//   2. Replacing that with "this stop is DELIVERED" failed too — on an order
//      with a signed BOL at 6:01 PM whose card still read Scheduled. It can: the
//      status the card trusts (normalizedStatus) is refreshed from the cheap
//      saved-search list, and deliveredDTTM is NOT a live list field, so a stop
//      delivered in NuVizz can sit on our board classified SCHEDULED until
//      something re-enriches it. Gating on that means the button disappears
//      precisely when the board is stale — the moment you most want to ask.
//
// So there is no status gate. The button asks NuVizz a question; asking is one
// call on an explicit tap and is always a legitimate thing to want. The only
// condition is the honest one: there are no photos on the card yet. Worst case
// the answer is "none on file", which is a real answer and strictly better than
// hiding the ability to ask.
export function podPhotoFetchOffer(stop, { tried } = {}) {
  const docs = Array.isArray(stop?.podDocs) ? stop.podDocs : [];
  const photos = docs.filter((d) => isPodImageExt(d?.extension));
  const offer = photos.length === 0;
  return {
    photos,
    others: docs.filter((d) => !isPodImageExt(d?.extension)),
    offer,
    // Say "none on file" only after a pull actually came back empty — before
    // that, silence means "not asked yet", which is a different thing.
    exhausted: offer && !!tried,
  };
}

// ── folding a fresh /stop/info pull over the open card ───────────────────────
// The client folded a refresh in with a raw spread, so ANY key the pull returned
// shadowed the card's — including an EMPTY one. normalizeStop always emits a
// podDocs key (an array, possibly []), so tapping "View delivery photos" on a
// stop whose pull came back with no documents would ERASE the BOL already on
// screen: you ask for more and get less.
//
// The server has had exactly this guard for its own fold since mergeEnrich —
// "a missing/empty value must never clobber a good one" — but mergeEnrich is
// server-only and was never mirrored here. Same rule, same reason: an absent
// value in a response is not evidence the value is gone.
export function foldFreshStop(prev, incoming) {
  const out = { ...(prev || {}) };
  for (const [k, v] of Object.entries(incoming || {})) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

// Does this stop's PROOF OF DELIVERY section have anything to render? Documents
// to show, or a photo fetch to offer — which, per above, is now always true for
// a real order. An UNPLANNED order that nobody has scheduled is the one case
// with genuinely nothing to say.
export function podSectionVisible(stop, { unplanned } = {}) {
  const docs = Array.isArray(stop?.podDocs) ? stop.podDocs : [];
  return docs.length > 0 || !unplanned;
}
