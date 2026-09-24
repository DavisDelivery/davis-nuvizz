// labels-by-shipper.mts — ONE SHIPPER'S ORDERS ON ONE DELIVERY DAY, READY TO LABEL.
//
// Chad, Sep 24 2026: "i want for me to be able to pick a shipper and a day like averitts or estes
// or shp and when all those orders come up for that day be able to print labels one by one for
// their orders or bulk print them"
//
//   GET ?date=YYYY-MM-DD                 → who shipped what that day: { shippers:[{key,name,orders}], … }
//   GET ?date=YYYY-MM-DD&shipper=ESTES   → the same, plus that shipper's orders, each with its label
//
// THE DAY is the board day — the delivery date the board files an order under, the same day the
// Map shows — and the orders are that day's own board: no carry-over from earlier days, cancelled
// orders off (the board's own rule), pickups never (there is no freight of theirs on our dock).
//
// THE LABEL is the stop card's label (labelOrderFromStop, via lib label-shippers.js): the board's
// current counts, a dispatcher's address fix laid over the ship-to, the phone the card would dial,
// and — for an order created in New Order or Bulk add — the saved label's reference, notes and
// ship-from. The browser draws the pages with the same label-html.js the card uses.
//
// A READ THAT FAILED IS SAID, NOT SWALLOWED. The board alone makes a valid label (the stop card
// prints without a saved record too), so a failed saved-label or customer-note read does not stop
// the print — but a missed address fix would put the old address on the freight, so the answer
// names what could not be read and the screen shows it above the list.
//
// Firestore only. ZERO NuVizz calls, on every path. Viewer: printing a label is a read.

import { isFirestoreEnabled, readStops, getDoc, getDocMasked, etDayString } from './lib/firestore.mts';
import { requireUser, jsonResponse } from './lib/require-user.mts';
import { LABEL_STOP_FIELDS } from './lib/board-fields.mts';
import { labelDocId } from './order-labels.mts';
import { dropCancelledEnabled, dropCancelledStops } from '../../src/lib/stop-cancelled.js';
import { SHIPPER_NAMES, shipperOf, shipperSummary, shipperLabelRows, isPickup, stopMatchKey } from '../../src/lib/label-shippers.js';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BATCH = 25;

async function inBatches<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(...(await Promise.all(items.slice(i, i + BATCH).map(fn))));
  return out;
}

/** The label saved when this order was created, if it was created here. null = none saved; throws = could not read. */
async function readSavedLabel(stopNbr: string): Promise<any | null> {
  const id = labelDocId(stopNbr);
  const ptr = await getDoc(`order_labels_by_stop/${TENANT}__${id}`);
  const day = String(ptr?.date || '');
  if (!DATE_RE.test(day)) return null;
  const rec = await getDoc(`order_labels/${TENANT}__${day}/labels/${id}`);
  if (!rec) return null;
  const { _id, ...rest } = rec;
  return rest;
}

export default async (req: Request): Promise<Response> => {
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return jsonResponse({ ok: false, nuvizzCalls: 0, error: 'Firestore is not configured — there is no board to read' }, 500);

  const url = new URL(req.url);
  const date = String(url.searchParams.get('date') || '').trim() || etDayString();
  if (!DATE_RE.test(date)) return jsonResponse({ ok: false, nuvizzCalls: 0, error: 'date must be YYYY-MM-DD' }, 400);
  const want = String(url.searchParams.get('shipper') || '').trim().toUpperCase();

  let board: any[];
  let boardAt: string | null = null;
  try {
    const r = await readStops(TENANT, date, { mask: LABEL_STOP_FIELDS });
    board = r.stops || [];
    boardAt = (r.meta as any)?.last_scanned_at || null;
  } catch (e: any) {
    return jsonResponse({ ok: false, nuvizzCalls: 0, date, error: `could not read the board for ${date}: ${e?.message || e}` }, 500);
  }
  const { stops, dropped } = dropCancelledStops(board, dropCancelledEnabled(process.env));
  const summary = shipperSummary(stops);
  const base = { ok: true, nuvizzCalls: 0, date, boardAt, cancelledOff: dropped.length, ...summary };
  if (!want) return jsonResponse(base);

  const mine = stops.filter((s: any) => !isPickup(s) && shipperOf(s?.stopNbr)?.key === want);
  // Named from the key, not from an order: a shipper with nothing that day is still Estes, not ESTES.
  const shipper = { key: want, name: (SHIPPER_NAMES as any)[want] || want };
  const errors: Record<string, string> = {};

  // The saved labels, one pointer and one record per order. A missing one is ordinary (orders that
  // arrived on a carrier feed were never created here); a FAILED one is counted and said.
  const saved = new Map<string, any>();
  let savedFailed = 0;
  await inBatches(mine, async (s: any) => {
    const nbr = String(s?.stopNbr || '').trim();
    try { const rec = await readSavedLabel(nbr); if (rec) saved.set(nbr, rec); } catch { savedFailed += 1; }
  });
  if (savedFailed) errors.saved = `${savedFailed} saved label${savedFailed === 1 ? '' : 's'} could not be read — those print from the board alone, without a reference, notes or ship-from`;

  // The customer notes, projected to the two fields a label uses: the dispatcher's address fix and
  // the saved contacts the phone comes from. One read per customer, not per order.
  const keys = [...new Set(mine.map(stopMatchKey))];
  const notes = new Map<string, any>();
  let notesFailed = 0;
  await inBatches(keys, async (k: string) => {
    try { const d = await getDocMasked(`customer_notes/${k}`, ['address_override', 'contacts']); if (d) notes.set(k, d); } catch { notesFailed += 1; }
  });
  if (notesFailed) errors.notes = `${notesFailed} customer note${notesFailed === 1 ? '' : 's'} could not be read — an address a dispatcher fixed may print as NuVizz has it; check those before printing`;

  const rows = shipperLabelRows(mine, want, { saved, notes });
  const pages = rows.reduce((n: number, r: any) => n + r.pages, 0);
  return jsonResponse({
    ...base, shipper, rows, pages,
    reads: { orders: mine.length, savedFound: saved.size, notesRead: notes.size },
    errors,
  });
};
