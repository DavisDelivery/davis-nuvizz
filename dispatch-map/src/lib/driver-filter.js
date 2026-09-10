// lib/driver-filter.js
//
// TYPING A DRIVER'S NAME INSTEAD OF SCROLLING FOR IT.
//
// Chad, on the route card's driver control: "i want this to be a search bar as well as a drop
// down." Davis runs ~59 drivers, so the native <select> was a 59-item scroll to reach FRYE —
// on a phone, an OS wheel with no way to type at all.
//
// The rule lives here rather than in the component for the usual reason: a filter written
// inside a React component is only testable by rendering it, and this one has to be right
// about how a dispatcher actually types — half a first name, a last name first, or the
// NuVizz user code off a manifest.
//
// WHAT IT MATCHES, and why each one is here rather than a plain substring test:
//   • ANY ORDER  — "frye michael" and "michael frye" both find him. A dispatcher reading off a
//                  manifest types the last name first as often as not.
//   • ANY FIELD  — each typed word may land in the name OR the user code, so "frye" finds
//                  Michael Frye by his code and "michael" by his name, and "mic fry" by both.
//   • PREFIXES   — "mic" finds Michael before he is finished being typed, which is the whole
//                  point of a search bar over a list.
//   • EVERY WORD MUST HIT (AND, not OR). "mike f" narrows; it must not widen to every driver
//                  with an F anywhere. An OR here turns the box into a no-op at two words.
//
// Deliberately NOT fuzzy — no edit distance, no subsequence matching. A dispatcher assigning
// freight to a human being needs the list to be obviously right, and "MRYE" quietly offering
// FRYE is how the wrong driver gets a truck.

/** One driver → the strings a dispatcher might type at them. */
function haystack(d) {
  return [d?.name, d?.userName, d?.driverId]
    .filter((v) => v != null && v !== '')
    .map((v) => String(v).toLowerCase());
}

/** Split a typed query into words, dropping punctuation a name never carries meaning in. */
export function queryWords(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

/** Does this driver match every word typed? */
export function driverMatches(driver, query) {
  const words = queryWords(query);
  if (!words.length) return true;                 // an empty box hides nobody
  const fields = haystack(driver);
  if (!fields.length) return false;
  // AND across words, OR across fields, PREFIX within a field's own words.
  return words.every((w) => fields.some((f) => f.split(/[^a-z0-9]+/).some((t) => t.startsWith(w)) || f.startsWith(w)));
}

/**
 * The roster, filtered and left in the order it arrived — the roster source already sorts
 * A→Z (v0.32.9) and re-ranking by match score would move a driver under the cursor between
 * keystrokes, which is how the wrong name gets picked with the Enter key.
 */
export function filterDrivers(roster, query) {
  const list = Array.isArray(roster) ? roster : [];
  const words = queryWords(query);
  if (!words.length) return list;
  return list.filter((d) => driverMatches(d, query));
}

/** How a driver reads in the box and in the list — one place, so the two always agree. */
export function driverLabel(d) {
  if (!d) return '';
  const name = d.name ? String(d.name) : String(d.driverId ?? '');
  return d.userName ? `${name} (${d.userName})` : name;
}

/** The driver a stored id refers to, or null. Ids are compared as STRINGS: the roster carries
 *  them as numbers and every <select>/dataset round-trip turns them into text, and a `===`
 *  across that boundary silently finds nobody. */
export function driverById(roster, id) {
  if (id == null || id === '') return null;
  const want = String(id);
  return (Array.isArray(roster) ? roster : []).find((d) => String(d?.driverId) === want) || null;
}

/**
 * Where the highlight lands after a key press. Kept pure because an off-by-one here assigns
 * a truck to the driver ABOVE the one a dispatcher is looking at.
 *
 * Wraps at both ends (a 59-driver list is faster to reach backwards from the top), and
 * answers -1 for an empty list so the caller has nothing to select.
 */
export function nextHighlight(current, delta, count) {
  if (!Number.isFinite(count) || count <= 0) return -1;
  const start = Number.isInteger(current) && current >= 0 && current < count ? current : (delta > 0 ? -1 : 0);
  return ((start + delta) % count + count) % count;
}
