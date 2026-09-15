// address-queue.mts — EVERY STOP ON THE BOARD WHOSE ADDRESS WILL SEND A TRUCK WRONG.
//
// Chad: "list by board day every stop that the system has flagged as a problem address, let us
// correct it there, and push individuals or the group to nuvizz with the correction."
//
// STRICTLY FIRESTORE-ONLY. This file imports NOTHING that can reach NuVizz — that is the point
// of it being a separate function rather than a mode of an existing one. The cost rule is then
// structural instead of a promise in a comment: there is no vendor client in scope to misuse.
// The envelope says `nuvizzCalls: 0` so the screen's claim is a field, not a sentence.
//
//   GET                      today + the next 2 BUSINESS days (what the scan actually writes)
//   GET ?from=&to=           an explicit window, clamped to 3 days
//   GET ?dismissed=1         include waved-off rows, so a dispatcher can un-wave one
//   → { ok, tenant, dates, nuvizzCalls: 0, notesLoaded, days:[{date,stopsRead,rows}], summary }
//
//   POST { date, key, fp, signal, stopNbr, by, byName, why }   wave a row off
//   POST { date, key, undo: true }                             put it back
//
// BUSINESS DAYS, NOT CALENDAR DAYS. scanDatesFrom is what the scanner itself walks, and it
// skips weekends. A calendar horizon would ask for a Sunday document nothing ever wrote and
// render an empty column indistinguishable from a clean day.
//
// WHY THE ROWS ARE RECOMPUTED RATHER THAN READ FROM THE ADDRESS-CHANGE LOG. The log was the
// obvious substrate — already per board day, already free. It would render EMPTY: the repo's
// own scan-over-scan measurement on two real board days produced zero rows
// (lib/firestore.mts:1427-1430). The log answers "did this address CHANGE"; the queue has to
// answer "is this address WRONG". Different question, different source.
//
// MATCHKEY IS DERIVED HERE, NEVER TRUSTED. The stored stop index does not carry one — measured:
// "778 stops, 63 routes judged, and matchKey null on every single row" (lib/customer-key.mts:11).
// Skipping withCustomerKeys means every stop joins to no note, every correction looks unmade,
// and the queue fills with confident wrong rows for addresses fixed weeks ago.

import { isFirestoreEnabled, readStops, listDocs, getDoc, updateDocFields, etDayString, readAddressChanges } from './lib/firestore.mts';
import { QUEUE_STOP_FIELDS, QUEUE_NOTE_FIELDS } from './lib/board-fields.mts';
import { withCustomerKeys } from './lib/customer-key.mts';
import { scanDatesFrom } from './lib/refresh-stops-core.mts';
import { addressQueueEnabled, buildQueueRow, sortQueueRows, isDismissed } from './lib/address-queue.mts';
import { selectAddressChanges } from './lib/address-history.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';
const MAX_DAYS = 3;
const NOTES_COLLECTION = 'customer_notes';
const dismissalPath = (date: string) => `address_queue_dismissals/${date}`;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** How many of a day's fixes the queue hands back. A board day is ~780 stops; a day where
 *  somebody swept the whole queue is tens of rows, not hundreds, and the screen collapses them
 *  behind a disclosure anyway. */
const FIXED_PER_DAY = 200;

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  // ITS OWN SWITCH, and it covers the read and the dismissal write together. Sharing
  // ADDRESS_HISTORY would mean switching off the log silently took the queue with it — a
  // switch that reverts the wrong thing.
  if (!addressQueueEnabled()) {
    return J({ ok: false, disabled: true, error: 'The problem-address queue is switched off (ADDRESS_QUEUE=off).' });
  }
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off — no board to read' });

  if (req.method === 'POST') return dismissOne(req, J);
  if (req.method !== 'GET') return J({ ok: false, error: 'GET or POST only' }, 405);

  // Viewer, matching address-history: these rows name a customer's address, which is what the
  // stop card already shows anyone who opens it. The POST is dispatcher — see dismissOne.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const from = String(url.searchParams.get('from') || '').trim();
  const to = String(url.searchParams.get('to') || '').trim();
  const showDismissed = url.searchParams.get('dismissed') === '1';

  // The default horizon is exactly what the scan still rewrites. Anything older is a frozen
  // snapshot — correcting it is archaeology after the freight moved.
  let dates = scanDatesFrom(etDayString(), MAX_DAYS);
  if (DAY_RE.test(from)) {
    const all = scanDatesFrom(from, MAX_DAYS);
    dates = DAY_RE.test(to) ? all.filter((d) => d <= to) : all;
    if (!dates.length) dates = [from];
  }

  try {
    // ONE notes read for the whole window, not one per day: the collection is per-CUSTOMER and
    // the same dock appears on three days. routing-plan-core.mts:702 already reads it this way.
    const [noteDocs, ...dayReads] = await Promise.all([
      listDocs(NOTES_COLLECTION, { mask: QUEUE_NOTE_FIELDS }),
      ...dates.map((d) => readStops(TENANT, d, { mask: QUEUE_STOP_FIELDS }).then((r) => ({ d, stops: r.stops || [] }))),
      ...dates.map((d) => getDoc(dismissalPath(d)).then((doc) => ({ d, items: (doc as any)?.items || {} }))),
      // WHAT WE ALREADY FIXED ON THIS DAY. Chad: "there should be a dropdown in the days where
      // the previously listed problem addresses were where a 2nd history of the ones we fixed
      // lived." A day that goes from "16 to fix" to "Nothing wrong with this day's addresses"
      // erases the evidence of the work — the screen looks identical to a day nobody touched,
      // which is the one thing a work queue must never do. The rows have been sitting in the
      // address log the whole time, filed against this same board day; they were just on a
      // different screen from the one where the work happened.
      //
      // The same per-day document the log reads, so the two can never disagree, and ZERO NuVizz
      // calls — one Firestore get per day, on a day document that is usually absent and empty.
      ...dates.map((d) => readAddressChanges(TENANT, d).catch(() => []).then((rows) => ({ d, rows: rows || [] }))),
    ]);
    const days = dayReads.slice(0, dates.length) as Array<{ d: string; stops: any[] }>;
    const dismissals = dayReads.slice(dates.length, dates.length * 2) as Array<{ d: string; items: any }>;
    const fixedReads = dayReads.slice(dates.length * 2) as Array<{ d: string; rows: any[] }>;
    const dismissedFor = new Map(dismissals.map((x) => [x.d, x.items]));
    // OURS ONLY, on purpose. `scan` rows are NuVizz changing the address out from under us —
    // real, and they have their own tab ("NuVizz changed it"). This list answers "what did WE
    // fix here", and mixing the vendor's edits into it would make a dispatcher's own work
    // unreadable. `all: true` because the queue's own fix classifies as `formatting`.
    const fixedFor = new Map(fixedReads.map((x) => [x.d, selectAddressChanges(x.rows, { limit: FIXED_PER_DAY })
      .filter((r: any) => r?.source === 'override' || r?.source === 'override-reset')]));

    const notes = new Map<string, any>();
    for (const n of noteDocs || []) {
      const k = String((n as any)?.match_key || (n as any)?._id || '').trim();
      if (k) notes.set(k, n);
    }

    const out: any[] = [];
    const summary = { mis_split: 0, no_pin: 0, corrected_not_pinned: 0, dismissed: 0, fixed: 0 };
    for (const { d, stops } of days) {
      // withCustomerKeys BEFORE anything is judged — see the header. Without it every stop
      // joins to no note and the queue reports a board full of problems that were fixed weeks
      // ago, which a dispatcher would act on.
      const keyed = withCustomerKeys(stops);
      const items = dismissedFor.get(d) || {};
      const rows: any[] = [];
      for (const s of keyed) {
        const row = buildQueueRow(s, notes.get(String(s?.matchKey || '')), d);
        if (!row) continue;
        const waved = isDismissed(row, items);
        if (waved) {
          summary.dismissed += 1;
          if (!showDismissed) continue;
          const rec = items[row.key] || {};
          row.dismissed = true;
          row.dismissedBy = rec.byName || rec.by || null;
          row.dismissedAt = rec.at || null;
          row.dismissedWhy = rec.why || null;
        }
        (summary as any)[row.signal] += 1;
        rows.push(row);
      }
      const fixed = fixedFor.get(d) || [];
      summary.fixed += fixed.length;
      out.push({ date: d, stopsRead: stops.length, rows: sortQueueRows(rows), fixed });
    }

    return J({
      ok: true,
      tenant: TENANT,
      dates,
      // A FIELD, NOT A SENTENCE. The screen tells a dispatcher this costs nothing; a claim the
      // code asserts can be read back, a claim in prose cannot.
      nuvizzCalls: 0,
      // THE FREE DIAGNOSTIC. Zero notes with rows present is the 778-stops-no-notes failure
      // announcing itself instead of rendering a confident wrong list — CLAUDE.md asks for the
      // zero-cost explain BEFORE the guess, and this is it.
      notesLoaded: notes.size,
      days: out,
      summary,
    });
  } catch (e: any) {
    return J({ ok: false, error: `address-queue read failed: ${e?.message || e}` }, 500);
  }
};

/**
 * Wave a row off, for EVERYBODY.
 *
 * Dispatcher-gated, not viewer: this hides a problem from every other dispatcher's screen, and
 * a list anybody passing by can silence is not a work queue.
 *
 * FIELD-MASKED, NEVER setDoc. updateDocFields patches the named paths server-side, so two
 * dispatchers clearing two different rows on the same day both land. A blind setDoc here would
 * erase the rest of the day's dismissals on every click — the exact trap lib/firestore.mts:245
 * warns about, and the reason these cannot live on the address-change day document, which is
 * itself rewritten whole by the scan.
 *
 * THE FINGERPRINT IS THE POINT. A dismissal only counts while the address and pin it was
 * recorded against are unchanged (see queueRowFingerprint). Store it with the record, or
 * waving off a mis-split would silently swallow the carrier re-addressing that order tonight.
 */
async function dismissOne(req: Request, J: (o: any, s?: number) => Response): Promise<Response> {
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  let body: any = {};
  try { body = await req.json(); } catch { return J({ ok: false, error: 'bad JSON body' }, 400); }

  const date = DAY_RE.test(String(body?.date)) ? String(body.date) : etDayString();
  const key = String(body?.key || '').trim();
  if (!key || !/^[a-z_]+__[a-z0-9-]+$/.test(key)) {
    return J({ ok: false, error: 'a dismissal key is required, and it must be one the queue minted' }, 400);
  }

  try {
    if (body?.undo === true) {
      // null, not a delete sentinel: the reader treats a null record as absent, and a key that
      // half-survived a delete while still matching its fingerprint would hide a row for ever.
      await updateDocFields(dismissalPath(date), { date, [`items.${key}`]: null });
      return J({ ok: true, undone: true, key, date });
    }
    const fp = String(body?.fp || '').trim();
    if (!fp) return J({ ok: false, error: 'a fingerprint is required — without it the row could never come back' }, 400);
    await updateDocFields(dismissalPath(date), {
      date,
      [`items.${key}`]: {
        fp,
        signal: String(body?.signal || '').trim() || null,
        stopNbr: String(body?.stopNbr || '').trim() || null,
        // THE DEVICE, NEVER A VERIFIED PERSON. Every request from the production site today
        // arrives with request.auth == null, so naming a human here would be a claim the
        // system cannot read back — an intent reported as an outcome in a new costume. The
        // screen labels these "Dispatcher 9F2A".
        by: String(body?.by || '').trim() || null,
        byName: String(body?.byName || '').trim() || null,
        why: String(body?.why || '').trim().slice(0, 200) || null,
        at: new Date().toISOString(),
      },
    });
    return J({ ok: true, dismissed: true, key, date });
  } catch (e: any) {
    return J({ ok: false, error: `could not record the dismissal: ${e?.message || e}` }, 500);
  }
}
