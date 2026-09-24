// label-shippers.js — ONE SHIPPER'S ORDERS ON ONE DAY, READY TO LABEL. PURE (no DOM, no network).
//
// Chad, Sep 24 2026: "i want for me to be able to pick a shipper and a day like averitts or estes
// or shp and when all those orders come up for that day be able to print labels one by one for
// their orders or bulk print them"
//
// WHOSE FREIGHT IS THIS IS NOT A FIELD. time-restrictions.js says so (`source` reads the same on
// every row), and the board agrees: the ORDER NUMBER is the shipper. Read off production's own
// board for 2026-09-24 (Firestore only, zero NuVizz calls), 837 orders:
//
//   704  9 digits            007163747     Uline — the 7-digit PRO, zero-padded (load-scan's looksLikeUlineStop)
//     6  9 digits + -N       007157687-1   Uline, a segmented piece row
//    80  ESTES-<10 digits>   ESTES-0538243875   Estes (bulk-orders.js prefixes the Estes manifest push)
//    29  AVRT-<10 digits>    AVRT-0170416694    Averitt (AVRT is Averitt Express's carrier code)
//     5  SHP<digits>         SHP29379      Puremaxx (Chad, Sep 24: "Shp is puremaxx"), created in Bulk add
//     7  RA<digits>          RA5732712     all PICKUPS that day
//     6  MILLER…, PRIMARY…, TRENZ…
//
// So the shipper is the letters an order number starts with, and plain digits are Uline. The
// names below are the only ones the code or Chad can vouch for — SHP is Puremaxx because he said
// so — and every other prefix is shown as itself (MILLER, RA …) rather than given a name nobody
// checked. No bare ten-digit number was on the
// board, so none is called Averitt here — it lands in "Other numbers" where it can be seen.
//
// The label itself is built by order-labels.js (labelOrderFromStop, the SAME function the stop
// card's Label button uses) and drawn by label-html.js. This file only decides which orders.

import { labelOrderFromStop, labelPieces } from './order-labels.js';
import { normalizeMatchKey } from './matchKey.js';
import { resolveStopPhone } from './stop-contact.js';

export const SHIPPER_NAMES = { AVRT: 'Averitt', ESTES: 'Estes', SHP: 'Puremaxx', ULINE: 'Uline', OTHER: 'Other numbers' };

const str = (v) => (v == null ? '' : String(v).trim());

/** PURE: the shipper an order number belongs to — { key, name } — or null for no number. */
export function shipperOf(stopNbr) {
  const s = str(stopNbr).toUpperCase();
  if (!s) return null;
  if (/^\d{7,9}(-\d{1,2})?$/.test(s)) return { key: 'ULINE', name: SHIPPER_NAMES.ULINE };
  const m = /^([A-Z]+)/.exec(s);
  if (m) return { key: m[1], name: SHIPPER_NAMES[m[1]] || m[1] };
  return { key: 'OTHER', name: SHIPPER_NAMES.OTHER };
}

/**
 * A pickup is not freight on our dock: the driver collects it from the shipper that day. A Davis
 * label goes on a piece BEFORE it is loaded out, so pickups are never listed — and are counted,
 * so "why is RA missing?" has an answer on the screen.
 */
export const isPickup = (stop) => str(stop?.stopType).toUpperCase() === 'PU';

/**
 * PURE: who shipped what on this day — deliveries only, one entry per shipper.
 *
 * ORDER: the shippers whose freight arrives WITHOUT a barcode we can scan first, busiest first,
 * because they are why the Davis label exists (load-scan: "anything non-Uline will not have a
 * barcode"). Uline follows — its freight carries Uline's own scannable labels — and numbers no
 * rule recognises come last.
 */
export function shipperSummary(stops) {
  const counts = new Map();
  let pickups = 0;
  let noNumber = 0;
  let deliveries = 0;
  for (const s of Array.isArray(stops) ? stops : []) {
    if (isPickup(s)) { pickups += 1; continue; }
    const sh = shipperOf(s?.stopNbr);
    if (!sh) { noNumber += 1; continue; }
    deliveries += 1;
    const cur = counts.get(sh.key) || { key: sh.key, name: sh.name, orders: 0 };
    cur.orders += 1;
    counts.set(sh.key, cur);
  }
  const rank = (k) => (k === 'ULINE' ? 1 : k === 'OTHER' ? 2 : 0);
  const shippers = [...counts.values()].sort((a, b) => rank(a.key) - rank(b.key) || b.orders - a.orders || a.key.localeCompare(b.key));
  return { shippers, deliveries, pickups, noNumber };
}

/** Natural order for order numbers: ESTES-0538243875 before ESTES-1000000001, SHP9 before SHP10. */
export function compareStopNbr(a, b) {
  return str(a).localeCompare(str(b), 'en', { numeric: true, sensitivity: 'base' });
}

/** The customer_notes key for a board stop — the Map's own formula (App.jsx decorates every stop with it). */
export const stopMatchKey = (s) => normalizeMatchKey(s?.businessName || '', s?.addr1 || '', s?.city || '', s?.zip || '');

/** One word for where the order stands, for the list — the board's own status, never inferred. */
export function labelRowState(stop) {
  const st = str(stop?.normalizedStatus || stop?.status).toUpperCase();
  if (st === 'DELIVERED') return 'delivered';
  if (st === 'EXCEPTION') return 'exception';
  return 'open';
}

/**
 * PURE: every delivery of one shipper on the day, each with the label it would print.
 *
 * The label is the stop card's label exactly (labelOrderFromStop): the board's CURRENT skid, loose
 * and weight — the counts the load-out app caps at — the ship-to with a dispatcher's address fix
 * laid over it, and the phone the card would dial. A label saved when the order was created in New
 * Order or Bulk add fills in only what the board does not carry (reference, notes, ship-from).
 *
 * @param stops  the day's board rows
 * @param key    a shipper key from shipperOf (ESTES, AVRT, SHP, ULINE, …)
 * @param saved  Map<stopNbr, saved label record>        (order-labels)
 * @param notes  Map<matchKey, customer_notes document>   (address_override, contacts)
 */
export function shipperLabelRows(stops, key, { saved = new Map(), notes = new Map() } = {}) {
  const want = str(key).toUpperCase();
  const rows = [];
  for (const s of Array.isArray(stops) ? stops : []) {
    if (isPickup(s) || shipperOf(s?.stopNbr)?.key !== want) continue;
    const stopNbr = str(s.stopNbr);
    const note = notes.get(stopMatchKey(s)) || null;
    const override = note?.address_override && typeof note.address_override === 'object' ? note.address_override : null;
    const sv = saved.get(stopNbr) || null;
    const label = labelOrderFromStop(s, { saved: sv, addressOverride: override, phone: resolveStopPhone(s, note) });
    if (!label) continue;
    const pieces = labelPieces(label);
    rows.push({
      stopNbr,
      label,
      pages: pieces.length,
      // Counted off the PAGES, so the list and the stack of paper can never disagree.
      skids: pieces.filter((p) => p.kind === 'SKID').length,
      loose: pieces.filter((p) => p.kind === 'LOOSE').length,
      countMissing: !!pieces[0]?.countMissing,
      state: labelRowState(s),
      route: str(s.routeName) || str(s.loadNbr) || null,
      driver: str(s.driverName) || null,
      fromSaved: !!sv,
      addressFixed: !!(override && (str(override.addr1) || str(override.city))),
    });
  }
  return rows.sort((a, b) => compareStopNbr(a.stopNbr, b.stopNbr));
}

/**
 * PURE: the rows a filter box keeps — order number, reference, consignee, street or city, any
 * case, spaces ignored. A dock worker reading "0538243875" off a pallet finds ESTES-0538243875.
 */
export function filterLabelRows(rows, text) {
  const q = str(text).toUpperCase().replace(/\s+/g, '');
  if (!q) return Array.isArray(rows) ? rows : [];
  const flat = (v) => str(v).toUpperCase().replace(/\s+/g, '');
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    const l = r.label || {};
    return [r.stopNbr, l.ref, l.name, l.addr1, l.city].some((v) => flat(v).includes(q));
  });
}
