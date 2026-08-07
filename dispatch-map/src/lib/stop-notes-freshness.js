// src/lib/stop-notes-freshness.js
//
// Are the notes on this card current?
//
// Two different things carry notes and they refresh on very different schedules:
//   • orderInstructions — the saved-search list's plain note TEXT. Free, and now
//     refreshed on EVERY scan (planned, unplanned and completed searches alike).
//   • allComments — the rich notes the card actually renders, with author, type
//     and timestamp. These exist only in /stop/info, and an order is enriched
//     ONCE, when its PRO first appears on the board. For a repeat customer that
//     can be weeks before the note you care about was written.
//
// So the list text is the tripwire: when it says something the stored rich notes
// do not, the notes on screen are behind and the card should say so instead of
// presenting stale text as current.

const norm = (v) => String(v ?? '')
  .replace(/\s+/g, ' ')
  .replace(/[^\w\s:.,%$&/#-]/g, '')
  .trim()
  .toLowerCase();

/** The note text the card is currently showing, from the rich notes. */
export function storedNoteText(stop) {
  const parts = [];
  for (const c of (stop?.allComments || [])) if (c?.text) parts.push(c.text);
  const sig = stop?.signalSources?.orderInstructions;
  if (sig) parts.push(sig);
  return parts.join(' ');
}

/**
 * Has the list seen note text the stored rich notes do not contain?
 *
 * Deliberately one-directional. The list collapses every comment on an order
 * into ONE unattributed string, so it routinely holds LESS than allComments —
 * treating "the list is missing something" as a change would flag almost every
 * stop and the signal would be worthless. Only text the list has and we do not
 * counts.
 */
export function noteTextChanged(stop) {
  const live = norm(stop?.orderInstructions);
  if (!live) return false;
  const stored = norm(storedNoteText(stop));
  if (!stored) return true;              // list has text, we have none
  if (stored.includes(live)) return false;
  // Compare on words so re-ordering or punctuation drift is not a "change".
  const have = new Set(stored.split(' ').filter(Boolean));
  const words = live.split(' ').filter((w) => w.length > 2);
  if (!words.length) return false;
  const unseen = words.filter((w) => !have.has(w));
  // A single stray token is noise (a truncation artifact, a stray code); a real
  // new instruction brings several words with it.
  return unseen.length >= 2 && unseen.length / words.length >= 0.34;
}

/** What the card should say about note freshness, if anything. */
export function noteFreshness(stop) {
  if (!stop) return { stale: false, liveText: null, refreshedAt: null };
  return {
    stale: noteTextChanged(stop),
    liveText: stop.orderInstructions || null,
    refreshedAt: stop.notes_refreshed_at || null,
  };
}
