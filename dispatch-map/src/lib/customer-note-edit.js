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
//
// THE WAY BACK: VITE_NOTE_SAVE_CHANGED_ONLY=off puts the Stop lookup save back to writing the
// whole draft, exactly as before (house shape — default on, an off-word turns it off, anything
// malformed leaves it on). It changes how a document is WRITTEN, which is the kind of change
// CLAUDE.md wants a named switch for; and the batch lands on main as one squashed commit, so
// "revert that commit" is not a way back for this change alone. A VITE_ flag is build-time, so
// flipping it is a redeploy. The only side is the write payload — the form, the read and the
// read-back are identical in both positions.

/** House shape: default ON, an explicit off/0/false/no turns it off, anything else leaves it ON. */
export function noteSaveChangedOnlyEnabled(env) {
  const v = String(env?.VITE_NOTE_SAVE_CHANGED_ONLY ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

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

/**
 * IS THE CUSTOMER THIS SAVE WAS FOR STILL THE ONE ON SCREEN? (audit 2026-09-27, app-A4-5)
 *
 * The save's read-back repaints the card. A rep can start a new search while the write is in
 * flight, and a repaint applied to whatever answer is on screen when it returns painted the old
 * customer's note onto the new customer's card. The answer holds the dock when:
 *   • customer view — the dock is one of the docks that answer lists (the only place the
 *     per-dock Edit buttons come from);
 *   • an order's page — the order's customer key (the server-derived `matchKey`, or the
 *     dossier's own) is the dock's key, which is the only key that page's Edit can write.
 */
export function answerHoldsDock(answer, key) {
  if (!answer || typeof answer !== 'object' || !key) return false;
  if (answer.view) return (Array.isArray(answer.docks) ? answer.docks : []).some((d) => d && d.key === key);
  if (answer.dossier) return (answer.matchKey || answer.dossier?.identity?.matchKey || null) === key;
  return false;
}
