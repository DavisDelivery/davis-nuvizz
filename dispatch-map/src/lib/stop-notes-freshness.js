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
//     absence past the cut proves nothing. Nor on a stop whose notes a Refresh has read
//     (notes_refreshed_at, v1.100.3): the stored notes may be NEWER than the scan text, and a
//     note added in between would read as removed — the newest note, the one most likely to
//     matter. Such a stop keeps every stored note, as before.
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

/** The labels NuVizz's list puts in front of a note, as noteKey reads them — a cut can stop inside one. */
const CUT_LABELS = ['spl-instr-text', 'total-amount'];

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
  // A Refresh can read the stored notes AFTER the scan last read the list: a note added between
  // the two is in the stored notes and not yet in the scan text, and judging it removed would fade
  // the newest note on the card and drop it off the ticket. The two reads cannot be put in time
  // order from what a row carries (the board read strips the row's scan time, and a scan that read
  // the list before a Refresh can write after it), so on a stop whose notes a Refresh has read,
  // nothing is judged removed — for good, since the scan carries the stamp forward (mergeEnrich).
  // The safe side: such a stop shows and prints every stored note, exactly as before v1.100.2.
  const storedNewer = !!stop?.notes_refreshed_at;
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
    return isOrderInstruction(c) && !cut && !storedNewer ? { ...c, gone: true } : { ...c };
  });
  const isNew = stored.length > 0;
  // A cut text's last entry may be the leftover of a note: the start of a stored note too short
  // to have matched it, or a label cut mid-word ("TOTAL-AMOU…", "SPL-INSTR-TE…") — not a note of
  // its own. Anything else is kept: it may be the start of a NEW note ("CANCELLED O…"), and its
  // "…" already says it was cut. An entry with nothing left in it is never a note.
  const storedKeys = stored.map((c) => noteKey(c.text)).filter(Boolean);
  const fragment = (i) => {
    const k = scanKeys[i];
    if (!k) return true;
    if (!cut || i !== scan.length - 1) return false;
    const label = k.replace(/\s*:$/, '');   // "TOTAL-AMOUNT :…" is the label and its colon, cut
    return storedKeys.some((sk) => sk.startsWith(k)) || CUT_LABELS.some((l) => l.startsWith(label));
  };
  const added = scan.filter((_, i) => !used.has(i) && !fragment(i)).map((text) => (isNew ? { text, fromScan: true, isNew: true } : { text, fromScan: true }));
  return [...added, ...kept];
}

// ── THE PAPER: CURRENT NOTES ONLY (v1.100.3) ────────────────────────────────
//
// Chad, 2026-10-01, on the card's faded "Not in NuVizz's latest notes": "do this in the portal but
// on the print manifest don't put them on there at all." The screen keeps the faded line, because
// a dispatcher can weigh it; a driver holding the ticket cannot, so a note NuVizz no longer lists
// is left off the paper, and a note the latest scan picked up is printed, its by-line reading
// "From NuVizz's latest scan" (the list sends no author or time). A bare amount on a stop with no
// stored notes (an AVRT price) stays off (see printedNotes). Every printed ticket —
// the route panel's Print Manifest, a Compare card's Print manifest, and a single Delivery Ticket —
// reads its notes through ticketData (App.jsx), which reads them here.
//
// THE WAY BACK, in two halves (house shape each; build-time, so a redeploy; zero NuVizz calls):
//   VITE_MANIFEST_SCAN_NOTES=off  the paper prints the stored notes exactly as it did before —
//                                 removed notes back on, scan notes off.
//   VITE_MANIFEST_NEW_NOTES=off   the paper stops printing the scan's notes but still leaves the
//                                 removed ones off — the half Chad asked for, alone.
// VITE_SCAN_NOTES_AUTO=off (the card's switch) turns both off, so the paper never uses the scan's
// notes while the card does not.

export function manifestScanNotesEnabled(env) {
  const v = String(env?.VITE_MANIFEST_SCAN_NOTES ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** The paper's switch as this build reads it — on only while the card's merge is on too. */
export const MANIFEST_SCAN_NOTES_ON = SCAN_NOTES_AUTO_ON && (() => {
  try { return manifestScanNotesEnabled(import.meta.env); } catch { return true; }
})();

export function manifestNewNotesEnabled(env) {
  const v = String(env?.VITE_MANIFEST_NEW_NOTES ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** Does the paper print the scan's notes? Only inside the paper's own switch. */
export const MANIFEST_NEW_NOTES_ON = MANIFEST_SCAN_NOTES_ON && (() => {
  try { return manifestNewNotesEnabled(import.meta.env); } catch { return true; }
})();

/** A note that is nothing but an amount in dollars and cents — "56.06", "**166.32**", "$59.99" —
 *  the shape of every AVRT price on the 2026-09-30 board. A bare whole number ("4471", a gate code)
 *  is not an amount, and prints. */
const PRICE_ONLY = /^[*\s$]*\d{1,7}[.,]\d{2}[*\s]*$/;

/**
 * PURE. The notes a printed ticket carries: what the card shows, less the ones NuVizz no longer
 * lists. The scan's notes are printed when `addNew` (VITE_MANIFEST_NEW_NOTES), except a bare
 * amount on a stop with NO stored notes: on the 2026-09-30 board all 30 such stops were AVRT orders
 * whose only note is their price, and those tickets have never printed one. Any other scan note on
 * such a stop (a "CANCELLED ORDER" on a New Order sent with no notes) is printed. Each comes back
 * as the stored note (author and time kept) or `{ text, fromScan, isNew }`.
 */
export function printedNotes(stop, { addNew = MANIFEST_NEW_NOTES_ON } = {}) {
  return mergedNotes(stop).filter((n) => !n.gone && (!n.fromScan || (addNew && (n.isNew || !PRICE_ONLY.test(String(n.text))))));
}

/**
 * PURE (given `on`). The Comments boxes of one printed ticket, as ticketData (App.jsx) prints them:
 * `{ text, by, on }`. With the paper's switch off this is, line for line, what the ticket always
 * printed — the stored notes, or NuVizz's raw comments when there are none. With it on, the same
 * notes go through printedNotes: a note NuVizz no longer lists is left off, and a scan note is
 * added, marked `fromScan` so the ticket's by-line can say where it came from.
 */
export function ticketNotes(stop, { on = MANIFEST_SCAN_NOTES_ON, addNew = MANIFEST_NEW_NOTES_ON } = {}) {
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
  return printedNotes({ ...stop, allComments: stored }, { addNew })
    .map((c) => (c.fromScan ? { text: c.text, by: undefined, on: undefined, fromScan: true } : { text: c.text, by: c.addedBy, on: c.addedOn }));
}

/**
 * PURE. A fresh /stop/info read about to be folded onto a card (useLiveStop, App.jsx): when it
 * carries notes, stamp when they were read — the field the server stamps when a Refresh saves
 * them to the board (notesRefreshDoc, firestore.mts). A stamp the read already carries wins.
 */
export function stampNotesRead(fresh, atISO) {
  if (!fresh || typeof fresh !== 'object') return fresh;
  if (!Array.isArray(fresh.allComments) || !fresh.allComments.length || fresh.notes_refreshed_at) return fresh;
  return { ...fresh, notes_refreshed_at: atISO };
}
