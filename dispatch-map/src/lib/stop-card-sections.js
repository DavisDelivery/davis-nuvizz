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
// them on demand. That button used to live inside an "if this stop has NO
// documents at all" branch, which meant the moment a stop carried ANY document
// (typically a signed BOL, a PDF) the button vanished and there was no way left
// to ask for the photos. A delivered order showing a BOL and nothing else was
// exactly the case where the photos were most likely to exist and least likely
// to be reachable.
//
// The rule is about PHOTOS, not documents: offer the fetch whenever a delivered
// stop has no image on file yet, however many PDFs it may have.
export function podPhotoFetchOffer(stop, { delivered, tried } = {}) {
  const docs = Array.isArray(stop?.podDocs) ? stop.podDocs : [];
  const photos = docs.filter((d) => isPodImageExt(d?.extension));
  const offer = !!delivered && photos.length === 0;
  return {
    photos,
    others: docs.filter((d) => !isPodImageExt(d?.extension)),
    offer,
    // Say "none on file" only after a pull actually came back empty — before
    // that, silence means "not asked yet", which is a different thing.
    exhausted: offer && !!tried,
  };
}

// Does this stop's PROOF OF DELIVERY section have anything at all to render?
// A not-yet-delivered stop with no documents has nothing to say and the whole
// section stays hidden, exactly as before.
export function podSectionVisible(stop, { delivered } = {}) {
  const docs = Array.isArray(stop?.podDocs) ? stop.podDocs : [];
  return docs.length > 0 || !!delivered;
}
