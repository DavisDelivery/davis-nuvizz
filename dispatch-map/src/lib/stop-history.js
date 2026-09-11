// stop-history.js — ONE delivery history per stop card, from two sources that
// were never the same thing.
//
// Chad, on a WINTERS INDUSTRIES card showing PRO 007142362 three times: "why are
// we showing the same pro 3 different ways and why is the one pro missing the
// drivers name". Both halves have the same cause, and it is not a display bug —
// the card was printing two different records side by side as if they were one.
//
//   • history_customers (the warehouse rollup) is a DELIVERY. It carries the day
//     the freight was delivered and the driver who ran it, and it is already
//     de-duped one row per PRO.
//
//   • customer_notes.pro_history is NOT a delivery, and never was. bumpProHistory
//     appends a row every time a dispatcher presses SAVE on the customer note,
//     stamped with the day of the SAVE, de-duped only against the row immediately
//     before it. So one order whose note was saved on two days is two rows; the
//     dates are edit dates wearing a delivery date's clothes; and the row shape is
//     {pro, date} — it has NEVER carried a driver, which is the whole of the second
//     question. The chip's driver came from a separate name-search lookup, so on a
//     customer whose saved name does not tokenise to its warehouse name the driver
//     silently vanished on those rows while the warehouse row below kept its own.
//
// THE OPERATIONAL COST of printing them together: "007142362 · 07/07/26" sat one
// line above "007142362 · Enock Akyea · 07/06/26", so the card contradicted itself
// about when we delivered an order, and nothing on screen said which line to
// believe. A dispatcher answering "when were you last here?" on the phone reads
// whichever is nearer the top.
//
// mergeStopHistory keeps every PRO exactly ONCE:
//   - the warehouse row wins wherever one exists — it is the delivered fact,
//   - a PRO the warehouse has no record of rides as delivered:false so the card can
//     say "seen on the board" rather than imply a delivery that is not on file,
//   - the stop's OWN PROs are dropped: they are already in the header and in the
//     PROs list two inches up, and today's open order is not this customer's history.
//
// PURE — no Firestore, no fetch, no React. The card stays dumb.

// A numeric PRO is stored zero-padded to 9 in some places and bare in others (see
// stopDocIdCandidates in netlify/functions/lib/history-store.mts, which pads for the
// same reason). Compare on the padded form so 7142362 and 007142362 are ONE order;
// display whatever form the row actually arrived in.
function proKey(pro) {
  const s = String(pro ?? '').trim();
  return /^[0-9]+$/.test(s) ? s.padStart(9, '0') : s;
}

function byDateDesc(a, b) {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}

/**
 * @param deliveredRows  history_customers rollup rows: [{pro, date, driver}]
 * @param proHistory     customer_notes.pro_history: [{pro, date}] — note SAVES, oldest first
 * @param currentPros    the PROs on the stop being viewed (dropped from both lists)
 * @returns { delivered: [{pro,date,driver}], seen: [{pro,date}] }
 */
export function mergeStopHistory(deliveredRows, proHistory, currentPros = []) {
  const mine = new Set((currentPros || []).map(proKey).filter(Boolean));

  const delivered = [];
  const deliveredKeys = new Set();
  for (const r of deliveredRows || []) {
    const pro = String(r?.pro ?? '').trim();
    if (!pro) continue;
    const k = proKey(pro);
    // The rollup is already one row per PRO, but it is data written by another
    // process — de-dupe here too rather than trust that and print a twin.
    if (deliveredKeys.has(k)) continue;
    deliveredKeys.add(k);
    delivered.push({ pro, date: String(r?.date ?? '').trim(), driver: String(r?.driver ?? '').trim() });
  }
  delivered.sort(byDateDesc);

  // pro_history is append-ordered, so the LAST row for a PRO is its most recent
  // save — keep that one, and only for PROs with no delivery on file.
  const seenByPro = new Map();
  for (const h of proHistory || []) {
    const pro = String(h?.pro ?? '').trim();
    if (!pro) continue;
    const k = proKey(pro);
    if (deliveredKeys.has(k) || mine.has(k)) continue;
    const date = String(h?.date ?? '').trim();
    const prev = seenByPro.get(k);
    if (!prev || date > prev.date) seenByPro.set(k, { pro, date });
  }
  const seen = [...seenByPro.values()].sort(byDateDesc);

  return { delivered, seen };
}
