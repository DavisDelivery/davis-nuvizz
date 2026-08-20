// time-restricted-pros.mts
//
// "GIVE ME EVERY PRO WITH A TIME RESTRICTION ON IT." A board's clock-constrained stops,
// as JSON or as a spreadsheet, for any date we have already scanned.
//
// Read-only. Firestore only. ZERO NuVizz calls — it reads the same pre-scanned stop index
// the map serves from, plus one customer_notes document per distinct customer. Asking for
// this report can never cost a vendor call, which is the whole reason it reads the cache
// rather than the vendor.
//
//   GET ?date=YYYY-MM-DD        JSON  { ok, date, summary, rows, coverage }
//   GET ?date=…&format=csv      the same rows as a downloadable CSV
//   GET ?include=deliveries|all|pickups   default 'deliveries'
//   GET ?appointmentOnly=1      keep stops whose ONLY flag is "appointment required"
//   GET ?carryDays=N            also fold in still-unplanned stops from the prior N days
//
// carryDays defaults to 0, matching the map's own default so the report and the screen
// agree unless you ask otherwise. It is worth asking for: on 2026-08-19 three of the four
// carried-over stops were time-restricted, including a GXO stop undelivered since the
// 17th that nobody can deliver without booking it first. Those are the most actionable
// rows on the sheet, and they are invisible on a today-only read. Folding them costs no
// extra vendor traffic — mergeCarryover reads per-day indexes that were already scanned.
//
// WHY THIS IS A FUNCTION AND NOT A SCREEN. The join it needs — a full day's stop index
// against every customer's notes — is a server-side read. The browser holds customer_notes
// already, but not for stops outside the board it has loaded, and this report has to be
// runnable for a past date to answer "what did we have on last Friday".
//
// THE HONESTY REQUIREMENT. An empty notes map and a notes map that failed to load look
// identical downstream, and the second one silently turns every customer into "no hours on
// file" — the same silent-zero this repo has been bitten by before. So notes failures are
// COUNTED and reported in `coverage`, and the caller is told how many customers we
// actually read. A report that cannot say how much it saw is not a report.

import { isFirestoreEnabled, readStops, getDoc, etDayString } from './lib/firestore.mts';
import { withCustomerKeys, stopCustomerKey } from './lib/customer-key.mts';
import { mergeCarryover } from './nuvizz-pull-today-stops.mts';
import { buildTimeRestrictionRows, summarizeRows, toCsv, INCLUDE_MODES } from '../../src/lib/time-restrictions.js';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const json = (b: any, s = 200) => new Response(JSON.stringify(b, null, 1), {
    status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

  if (!isFirestoreEnabled()) return json({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date') || etDayString();
    if (!DATE_RE.test(date)) return json({ ok: false, error: `bad date "${date}" — expected YYYY-MM-DD` }, 400);
    const wantCsv = (url.searchParams.get('format') || '').toLowerCase() === 'csv';
    const carryDays = Math.max(0, Math.min(14, parseInt(url.searchParams.get('carryDays') || '0', 10) || 0));
    // DELIVERIES BY DEFAULT. A receiving window is a statement about freight arriving, and
    // a dispatcher reading this sheet is planning deliveries — on a real board the pickups
    // were 17 rows of our own terminal inheriting its own hours, which is noise here.
    // ?include=all restores them; whichever is in force is reported in coverage, so the
    // scope of the sheet is never something you have to infer from its length.
    const includeParam = (url.searchParams.get('include') || 'deliveries').toLowerCase();
    const include = INCLUDE_MODES.includes(includeParam) ? includeParam : 'deliveries';
    // An appointment requirement is a booking obligation, not a clock constraint: it says
    // call first, not deliver by. Dropped unless asked for. A stop that pairs an
    // appointment with real receiving hours is a HARD WINDOW and is never touched by this.
    const dropAppointmentOnly = url.searchParams.get('appointmentOnly') !== '1';

    const { meta, stops: rawStops } = await readStops(TENANT, date);
    // The stored stop index carries no matchKey; customer_notes are keyed by it. Without
    // this every stop reads as "no hours on file" and the whole board comes back clean —
    // the exact silent-zero eta-flag-check documents.
    const base = rawStops || [];
    let carryoverAdded = 0;
    if (carryDays > 0 && base.length) {
      // Best-effort: a carry-over fold that fails must not cost the caller the day's own
      // board, which is the part they actually asked for.
      try { carryoverAdded = await mergeCarryover(base, date, carryDays, undefined, undefined, meta?.lastUnplannedScanAt ?? null); } catch { /* keep base stops */ }
    }
    const stops = withCustomerKeys(base);
    if (!stops.length) {
      return json({ ok: true, date, note: 'no board scanned for this date', summary: null, rows: [] });
    }

    const keys = [...new Set(stops.map(stopCustomerKey).filter(Boolean) as string[])];
    const notes = new Map<string, any>();
    let noteReadFailures = 0;
    for (let i = 0; i < keys.length; i += 25) {
      await Promise.all(keys.slice(i, i + 25).map(async (k) => {
        try {
          const d = await getDoc(`customer_notes/${k}`);
          if (d) notes.set(k, d);
        } catch {
          // A customer with no notes document is ordinary; a read that THREW is not, and
          // collapsing the two would quietly downgrade a customer's typed hours to none.
          noteReadFailures += 1;
        }
      }));
    }

    const rows = buildTimeRestrictionRows(stops, notes, date, { include, dropAppointmentOnly });
    const summary = summarizeRows(rows);

    if (wantCsv) {
      return new Response(toCsv(rows), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="davis-time-restricted-pros-${date}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return json({
      ok: true,
      date,
      generated: new Date().toISOString(),
      summary,
      // PROVE IT LOOKED. Counts a reader can use to tell a genuinely clean board from a
      // join that quietly read nothing.
      coverage: {
        stopsOnBoard: stops.length,
        distinctCustomers: keys.length,
        notesLoaded: notes.size,
        noteReadFailures,
        include,
        appointmentOnlyDropped: dropAppointmentOnly,
        carryDays,
        carryoverAdded,
        lastScannedAt: meta?.last_scanned_at ?? null,
      },
      rows,
    });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
};
