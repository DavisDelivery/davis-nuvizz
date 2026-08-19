// customer-comms-log.mts
//
// The send log behind the Customer Communications tab: who was emailed, when, for
// which stop, and whether it landed — plus the per-day status snapshot, which is the
// only thing that can tell "nobody was emailed today" apart from "the sweep never ran".
//
//   GET ?date=YYYY-MM-DD          one day
//   GET ?month=YYYY-MM            a calendar month (clipped at today for the current one)
//   GET ?from=YYYY-MM-DD&to=…     an explicit range (either end may be omitted)
//   GET ?days=7                   back N days from ET today          (default: 1)
//
// The ledger has always been stored one subcollection per day; this used to flatten the
// lot into a single time-sorted list. It now returns that list ALONGSIDE per-day and
// per-month rollups, so the history can be read by day, by month, or as a range.
//
// Reads only our own ledger docs. ZERO NuVizz calls.

import { isFirestoreEnabled, etDayString } from './lib/firestore.mts';
import {
  readLedger, readSweepStatus,
  resolveLogRange, rollupByDay, rollupByMonth, tallyEntries, recentMonths,
  MAX_LOG_DAYS,
} from './lib/customer-comms.mts';

// A quarter of sends at the current pace is comfortably under this; it exists so one
// page load cannot try to serialise an unbounded list. Truncation is REPORTED, never
// silent — a clipped list that says nothing reads as the whole history.
const MAX_ENTRIES = 2000;

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const q = new URL(req.url).searchParams;
    const today = etDayString();
    const range = resolveLogRange({
      date: q.get('date') || '', month: q.get('month') || '',
      from: q.get('from') || '', to: q.get('to') || '',
      days: q.get('days') || 0,
    }, today);

    const entries: any[] = [];
    const status: Record<string, any> = {};
    // Days that could not be read at all. Without this a Firestore blip on one day is
    // indistinguishable from a quiet day, and the per-day row would claim a confident zero.
    const unreadable: string[] = [];

    for (const d of range.dates) {
      // Lenient HERE and only here: a log page that 500s because one day's read failed is
      // worse than a log page missing a day. The send path reads the ledger strictly.
      let ok = true;
      const ledger = await readLedger(d).catch(() => { ok = false; return {}; });
      if (!ok) unreadable.push(d);
      for (const [key, e] of Object.entries(ledger)) entries.push({ date: d, key, ...(e as any) });
      const s = await readSweepStatus(d);
      if (s) status[d] = s;
    }

    entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

    // Rolled up from EVERY entry read, before any truncation — the counts describe the
    // range, not the page. Truncating the list must not quietly shrink the totals.
    const byDay = rollupByDay(range.dates, entries);
    const byMonth = rollupByMonth(byDay);
    const totals = tallyEntries(entries);

    const shown = entries.slice(0, MAX_ENTRIES);

    return J({
      ok: true,
      today,
      // What was actually read, and whether the ask had to be cut down to get there.
      range: {
        mode: range.mode, from: range.from, to: range.to,
        days: range.dates.length, requestedDays: range.requested,
        clipped: range.clipped, maxDays: MAX_LOG_DAYS,
      },
      dates: range.dates,          // kept for callers that read this before rollups existed
      unreadable,
      months: recentMonths(today),
      totals,
      byDay,
      byMonth,
      // Per-day sweep snapshot: considered/sent/failed/skipped. A day with an entry here
      // and nothing in `entries` ran and found nobody to email — which is the answer you
      // need before deciding this feature is broken.
      status,
      entries: shown,
      entriesShown: shown.length,
      entriesTotal: entries.length,
      entriesTruncated: entries.length > shown.length,
    });
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'failed' }, 500);
  }
};
