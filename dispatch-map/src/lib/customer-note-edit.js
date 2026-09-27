// src/lib/customer-note-edit.js — WHAT A STOP LOOKUP NOTE SAVE MAY WRITE.
//
// PURE, and imports nothing.
//
// customer_notes/{key} has many writers besides the rep's form: unsubscribe.mts patches
// comms_opt_out, the pin tools patch location_override, the scanner patches restrictions and
// hours, the Map's editor saves the same fields. The Stop lookup editor opens on a fresh read,
// but a rep can hold it open for the length of a phone call — and a save that writes the WHOLE
// draft hands every field back with the value it had when Edit was pressed. { merge: true }
// protects only the keys ABSENT from the payload, so it protected nothing (audit 2026-09-27,
// app-A4-3): an unsubscribe inside that window was undone by a rep saving Friday's hours, and a
// pin moved to the right door went back to the wrong building.
//
// So the save sends the fields the rep actually CHANGED against what the form opened on, and
// nothing else. A key the rep toggled and toggled back is not a change. A stored value the
// form never touched (a Timestamp, a GeoPoint, a map) compares equal to itself and stays out.

const isPlainObject = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** Structural equality for a customer_notes value: primitives, arrays, plain maps, and the
 *  Firestore SDK's Timestamp / GeoPoint (both carry isEqual). Anything else is equal only to
 *  itself — the cautious side, because "unequal" means "written", which is today's behaviour. */
export function sameNoteValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (typeof a.isEqual === 'function') {
    try { return a.isEqual(b) === true; } catch { return false; }
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameNoteValue(x, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameNoteValue(a[k], b[k]));
}

/**
 * The top-level fields of `draft` that differ from `seed` — the document the form opened on,
 * emptyNote's defaults included. Returns a new object; {} when nothing changed or there is no
 * draft. Never returns a key the draft does not hold.
 */
export function changedNoteFields(draft, seed) {
  const out = {};
  if (!draft || typeof draft !== 'object') return out;
  const was = seed && typeof seed === 'object' ? seed : {};
  for (const [k, v] of Object.entries(draft)) {
    if (!Object.prototype.hasOwnProperty.call(was, k) || !sameNoteValue(v, was[k])) out[k] = v;
  }
  return out;
}
