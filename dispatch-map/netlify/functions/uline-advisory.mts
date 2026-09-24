// uline-advisory.mts — the Uline straight-truck review, in Address history.
//
//   GET /.netlify/functions/uline-advisory
//   → { ok, tenant, dates, nuvizzCalls: 0, notesLoaded, rows, summary }
//
// Every stop on the board (today + the next two business days — the horizon the scan still
// rewrites, and the same one the problem-address queue works) whose customer carries Uline's
// `uline_straight_truck` advisory, ONE ROW PER LOCATION, with the pin, the address, what Uline
// actually wrote, and whether one of our tractors has delivered there before.
//
// NO WRITE PATH HERE. The decision is customer_notes.vehicle_eligibility, written from the
// browser with a merge — exactly as the Routing brush and the stop card's vehicle picker already
// write it (see eligibilityPayload in src/lib/uline-review.js). A second, server-side writer for
// the same field is how two screens come to disagree about what a mark means.
//
// ZERO NuVizz CALLS, STRUCTURALLY: nothing below imports a vendor client. Firestore reads only —
// the notes collection masked to ULINE_NOTE_FIELDS, one stop-index read per board day, and one
// tractor_locations get per FLAGGED location (a handful), not the whole collection.
//
// BOARD-SCOPED, AND THAT IS A FACT ABOUT THE DATA RATHER THAN A PREFERENCE. A customer note does
// not carry an address or a pin of its own — only overrides (board-fields.mts). The street and
// the coordinates come from the STOP, so a flagged customer with no stop on the board has no
// building to show a close-up of. Each decision is keyed by location, so it holds for every
// future order there, and the backlog clears as each customer comes up.

import { isFirestoreEnabled, readStops, listDocs, getDoc, etDayString } from './lib/firestore.mts';
import { QUEUE_STOP_FIELDS, ULINE_NOTE_FIELDS } from './lib/board-fields.mts';
import { withCustomerKeys } from './lib/customer-key.mts';
import { scanDatesFrom } from './lib/refresh-stops-core.mts';
import { tractorLocPath } from './lib/tractor-flags.mts';
import { stopPosition } from '../../src/lib/board-flags.js';
import { shownAddress } from '../../src/lib/address-log.js';
import { buildUlineRows, hasUlineAdvisory, ulineDecision } from '../../src/lib/uline-review.js';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';
const MAX_DAYS = 3;
const NOTES_COLLECTION = 'customer_notes';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'GET') return J({ ok: false, error: 'GET only' }, 405);

  // Viewer, matching address-queue: these rows name a customer's address and restriction, which
  // the stop card already shows anyone who opens it. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no board to read' });

  const dates = scanDatesFrom(etDayString(), MAX_DAYS);
  try {
    const [noteDocs, ...dayReads] = await Promise.all([
      listDocs(NOTES_COLLECTION, { mask: ULINE_NOTE_FIELDS }),
      ...dates.map((d) => readStops(TENANT, d, { mask: QUEUE_STOP_FIELDS }).then((r) => ({ date: d, stops: r.stops || [] }))),
    ]);
    const notes = new Map<string, any>();
    for (const n of noteDocs || []) {
      const k = String((n as any)?.match_key || (n as any)?._id || '').trim();
      if (k) notes.set(k, n);
    }
    // withCustomerKeys BEFORE anything is judged — the stored stop index carries no matchKey
    // (customer-key.mts: "matchKey null on every single row"), and without it every stop joins
    // to no note, so the tab would render EMPTY on a board full of flags.
    const days = (dayReads as Array<{ date: string; stops: any[] }>).map((d) => ({ date: d.date, stops: withCustomerKeys(d.stops) }));

    // Build once without tractor facts to learn WHICH locations are flagged, then read tractor
    // history for those alone — a handful of gets instead of the whole collection.
    const draft = buildUlineRows(days, notes, { positionOf: stopPosition, addressOf: shownAddress });
    const tractorFacts = new Map<string, any>();
    await Promise.all(draft.map(async (r) => {
      try {
        const doc: any = await getDoc(tractorLocPath(TENANT, r.key));
        if (doc) tractorFacts.set(r.key, { last: doc.last_tractor_date || null, count: Number(doc.delivery_count) || 0 });
      } catch { /* history is evidence, never the reason the review fails to load */ }
    }));
    const rows = buildUlineRows(days, notes, {
      positionOf: stopPosition, addressOf: shownAddress, tractorOf: (mk: string) => tractorFacts.get(mk) || null,
    });

    const summary = { undecided: 0, confirmed: 0, box_only: 0, tractor: 0, locations: rows.length, stops: 0 };
    for (const r of rows) { (summary as any)[r.decision] += 1; summary.stops += r.stops.length; }
    // THE WHOLE BACKLOG, from notes already in hand — zero extra reads. Two jobs: it answers
    // "how many of these are there", and it is the tell for a broken join. A board showing
    // nothing while forty customers carry an undecided flag is not a quiet day; without this
    // count the two would render as the same empty screen.
    const backlog = { flagged: 0, undecided: 0 };
    for (const nt of notes.values()) {
      if (!hasUlineAdvisory(nt)) continue;
      backlog.flagged += 1;
      if (ulineDecision(nt) === 'undecided') backlog.undecided += 1;
    }
    return J({
      ok: true, tenant: TENANT, dates,
      // A FIELD, NOT A SENTENCE — the screen quotes it, so the claim is one the code asserts.
      nuvizzCalls: 0,
      // THE FREE DIAGNOSTIC, same as the queue's: zero notes with stops present is the
      // no-notes failure announcing itself rather than rendering a board with no Uline flags.
      notesLoaded: notes.size,
      rows, summary, backlog,
    });
  } catch (e: any) {
    return J({ ok: false, error: `uline-advisory read failed: ${e?.message || e}` }, 500);
  }
};
