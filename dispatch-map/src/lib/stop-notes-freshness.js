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

// ── THE SCAN'S NOTES, USED AS THEY ARRIVE (v1.100.2) ─────────────────────────
//
// Chad, 2026-10-01, on ROBERT BOSCH (PRO 007183226) showing "NuVizz has newer instructions than
// these — tap Refresh": "IF there are new notes picked up in the normal scans not enrichment then
// use them i shouldn't have to refresh to get them you know what they are so if some are added or
// deleted just auto use them".
//
// The list text is refreshed on EVERY scan for free; the rich notes (author, type, time) only come
// from the one /stop/info read. So the card now builds its notes from BOTH, every time it draws:
//   • every note the scan carries is shown. One that matches a stored note shows that note, author
//     and time included. One that does not is NEW ("New — from the latest scan"); the list carries
//     no author or time, and Refresh still pulls them. On a stop with NO stored notes at all (an
//     AVRT order is never enriched, and its only note is its price) there is nothing for a scan
//     note to be newer than, so it is shown plain, "From NuVizz's latest scan" — never "New".
//   • a stored ORDER INSTRUCTION the scan no longer carries is marked `gone` and drawn faded —
//     "Not in NuVizz's latest notes". Never dropped: noteTextChanged above records that the list
//     can hold LESS than the rich notes, so a note missing from it is not proof of a deletion,
//     and a dispatcher who loses a real instruction loses the delivery. Nothing is marked gone
//     when the text was cut short (the active pool cuts it at 400 characters and adds "…"):
//     absence past the cut proves nothing.
//   • any other stored note (pre-visit, general, a dispatcher's own) is shown as it was.
//   • with no scan text, the stored notes are exactly what they were before.
//
// MEASURED, not assumed, on the stored boards of 2026-09-30 (914 stops) and 2026-10-01 (629),
// zero NuVizz calls: 0 notes marked gone; 33 stops with a note the scan had and the card did not,
// every one a real note ("CANCELLED ORDER. STOP & RETURN PER ULINE.", "refused", "**DELIVER BY
// 3:00PM**") — 18 of them below the old banner's noise threshold, so it never asked; and 30 AVRT
// stops whose only note is their price, where the old banner asked for a Refresh.
//
// THE WAY BACK: VITE_SCAN_NOTES_AUTO=off puts back the stored notes and the amber "newer
// instructions" banner (house shape: default on, an off-word turns it off, anything malformed
// leaves it on). Build-time, so a redeploy. Zero NuVizz calls either way.

export function scanNotesAutoEnabled(env) {
  const v = String(env?.VITE_SCAN_NOTES_AUTO ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** The switch as this build reads it (Vite injects import.meta.env; in Node it is absent → on). */
export const SCAN_NOTES_AUTO_ON = (() => {
  try { return scanNotesAutoEnabled(import.meta.env); } catch { return true; }
})();

const SPL_PREFIX = /^\s*SPL-INSTR-TEXT\s*:?\s*/i;
/** A note's identity for matching: no SPL prefix, no trailing separators, normalized. */
const noteKey = (t) => norm(String(t ?? '').replace(SPL_PREFIX, '')).replace(/[\s.;,]+$/, '');

/** The scan's one-line note text, split back into its notes (the list joins them with "; "). */
export function scanNoteEntries(text) {
  return String(text ?? '')
    .split(/;\s+|\n+/)
    .map((t) => t.replace(SPL_PREFIX, '').trim().replace(/;$/, '').trim())
    .filter(Boolean);
}

/** Was this stored note an order instruction — the kind the scan's text demonstrably carries? */
const isOrderInstruction = (c) => c?.type === 'ORD_IN' || SPL_PREFIX.test(String(c?.text ?? ''));

/** Does a scan entry name this stored note (exactly, or as its truncated start)? */
function sameNote(scanKey, storedKey) {
  if (!scanKey || !storedKey) return false;
  return scanKey === storedKey || (scanKey.length >= 12 && storedKey.startsWith(scanKey));
}

/** Whole words: is `inner` inside `outer` without splitting a word ("gate 4" is not in "gate 42")? */
const holdsWords = (outer, inner) => !!inner && ` ${outer} `.includes(` ${inner} `);

/**
 * PURE. The notes the card shows — the scan's current notes merged with the stored rich ones (see
 * the section header). New scan notes come first (they are the ones the stored notes lack), then
 * the stored notes in their own order, an order instruction the scan no longer carries marked
 * `gone`. Returns stored-note objects unchanged apart from that flag; a scan-only note is
 * `{ text, fromScan: true }`, plus `isNew: true` when there are stored notes for it to be newer than.
 */
export function mergedNotes(stop) {
  const stored = (Array.isArray(stop?.allComments) ? stop.allComments : []).filter((c) => c && c.text);
  const raw = String(stop?.orderInstructions ?? '');
  const scan = scanNoteEntries(raw);
  if (!scan.length) return stored.map((c) => ({ ...c }));
  const cut = /…\s*$/.test(raw);
  const scanKeys = scan.map(noteKey);
  const joined = scanKeys.join(' ');
  const used = new Set();
  const kept = stored.map((c) => {
    const k = noteKey(c.text);
    const j = scanKeys.findIndex((sk, i) => !used.has(i) && sameNote(sk, k));
    if (j >= 0) { used.add(j); return { ...c }; }
    // A note that itself holds "; " reaches the scan as two entries. Word for word it is still
    // there, so it is not gone, and its pieces are not new notes.
    if (holdsWords(joined, k)) {
      scanKeys.forEach((sk, i) => { if (!used.has(i) && holdsWords(k, sk)) used.add(i); });
      return { ...c };
    }
    return isOrderInstruction(c) && !cut ? { ...c, gone: true } : { ...c };
  });
  const isNew = stored.length > 0;
  const added = scan.filter((_, i) => !used.has(i)).map((text) => (isNew ? { text, fromScan: true, isNew: true } : { text, fromScan: true }));
  return [...added, ...kept];
}

// ── THE PAPER: CURRENT NOTES ONLY (v1.100.3) ────────────────────────────────
//
// Chad, 2026-10-01, on the card's faded "Not in NuVizz's latest notes": "do this in the portal but
// on the print manifest don't put them on there at all." The screen keeps the faded line, because
// a dispatcher can weigh it; a driver holding the ticket cannot, so a note NuVizz no longer lists
// is left off the paper, and a note the latest scan picked up (the card's blue "New") is printed.
// A stop with no stored notes prints what it always printed (see printedNotes). Every printed ticket —
// the route panel's Print Manifest, a Compare card's Print manifest, and a single Delivery Ticket —
// reads its notes through ticketData (App.jsx), which reads them here.
//
// THE WAY BACK: VITE_MANIFEST_SCAN_NOTES=off puts the paper back to the stored notes exactly as it
// printed them before (house shape). VITE_SCAN_NOTES_AUTO=off, which puts back the card, puts back
// the paper too, so the screen and the ticket can never disagree about which notes exist.
// Build-time, so a redeploy. Zero NuVizz calls either way.

export function manifestScanNotesEnabled(env) {
  const v = String(env?.VITE_MANIFEST_SCAN_NOTES ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** The paper's switch as this build reads it — on only while the card's merge is on too. */
export const MANIFEST_SCAN_NOTES_ON = SCAN_NOTES_AUTO_ON && (() => {
  try { return manifestScanNotesEnabled(import.meta.env); } catch { return true; }
})();

/**
 * PURE. The notes a printed ticket carries: what the card shows, without the ones NuVizz no longer
 * lists, and with a scan note only where the card calls it New (there are stored notes for it to be
 * newer than). A stop with NO stored notes prints exactly what it printed before: on the 2026-09-30
 * board all 30 such stops were AVRT orders whose only note is their price, and a delivery ticket is
 * signed by the receiver — a rate is not put on it without Chad saying so. Each comes back as the
 * stored note (author and time kept) or `{ text, fromScan, isNew }` — the list sends no author or
 * time, so the ticket prints none.
 */
export function printedNotes(stop) {
  return mergedNotes(stop).filter((n) => !n.gone && (!n.fromScan || n.isNew));
}

/**
 * PURE (given `on`). The Comments boxes of one printed ticket, as ticketData (App.jsx) prints them:
 * `{ text, by, on }`. With the paper's switch off this is, line for line, what the ticket always
 * printed — the stored notes, or NuVizz's raw comments when there are none. With it on, the same
 * notes go through printedNotes: a note NuVizz no longer lists is left off, and one the card marks
 * New is added, with no author or time (the list sends none).
 */
export function ticketNotes(stop, { on = MANIFEST_SCAN_NOTES_ON } = {}) {
  const raw = (stop && stop.raw && stop.raw.stop) || {};
  const hasStored = Array.isArray(stop?.allComments) && stop.allComments.length > 0;
  if (!on) {
    return hasStored
      ? stop.allComments.map((c) => ({ text: c.text, by: c.addedBy, on: c.addedOn }))
      : (raw.comments || []).map((c) => ({ text: c.commentDescription, by: c.addedByName, on: c.addedOn }));
  }
  const stored = hasStored
    ? stop.allComments
    : (raw.comments || []).map((c) => ({ text: c.commentDescription, addedBy: c.addedByName, addedOn: c.addedOn }));
  return printedNotes({ allComments: stored, orderInstructions: stop?.orderInstructions })
    .map((c) => ({ text: c.text, by: c.addedBy, on: c.addedOn }));
}
