// src/lib/note-save.js
//
// THE CUSTOMER-NOTE SAVE PATH on the two stop panels (the desktop StopSidebar and the phone
// MobileStopDetailDrawer). Pure, so the rules can be unit-tested without a browser.

/**
 * A stable signature of a stored customer_notes document's CONTENT.
 *
 * The panels copy the note into a draft and their Save writes the whole draft back. They used
 * to re-read the note only when `note.id` changed — but a customer_notes id IS the match key,
 * so another dispatcher's save, the auto-scanner, or a pin correction on the SAME customer
 * never changed it, and the next Save wrote the stale draft back over the newer fields.
 *
 * Keys are sorted at every level so a snapshot that lists the same fields in another order is
 * not an "update". Firestore Timestamps serialise through their own toJSON / own
 * seconds+nanoseconds, so a moved last_updated is a change. No note → '' (stable, so a
 * customer with no doc does not re-adopt on every render).
 */
export function noteContentKey(note) {
  if (!note) return '';
  const seen = new WeakSet();
  try {
    return JSON.stringify(note, (k, v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
      if (seen.has(v)) return '[seen]';
      seen.add(v);
      return Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]]));
    });
  } catch {
    // Something unserialisable (a BigInt): fall back to the id, which is what the panels
    // keyed on before — never throw from a render.
    return `id:${note.id ?? ''}`;
  }
}

/**
 * PRESS SAVE on a stop panel's notes editor: run the save and say whether it LANDED.
 *
 * The Save bar used to run `onSave(D); setEditing(false);` — closing the editor on the click,
 * which also unmounted the only place saveError is printed. A refused or failed write then
 * looked exactly like a saved one. The saves (the Map's handleSave, the Routing screen's
 * saveStopNote) resolve `true` once the write has landed; ONLY that counts. A refusal
 * (resolves undefined), a failure, a throw, or any other answer is "not saved", and the
 * caller keeps the editor open with the typed values and the reason.
 */
export async function commitNoteDraft(save, draft) {
  try {
    return (await save(draft)) === true;
  } catch {
    return false;
  }
}
