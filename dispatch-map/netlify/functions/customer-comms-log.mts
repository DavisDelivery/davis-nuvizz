// customer-comms-log.mts
//
// The send log behind the Customer Communications tab: who was emailed, when, for
// which stop, and whether it landed — plus the per-day status snapshot, which is the
// only thing that can tell "nobody was emailed today" apart from "the sweep never ran".
//
//   GET /.netlify/functions/customer-comms-log?date=YYYY-MM-DD   (default: ET today)
//   GET /.netlify/functions/customer-comms-log?days=7            (roll up N days back)
//
// Reads only our own ledger docs. ZERO NuVizz calls.

import { isFirestoreEnabled, etDayString } from './lib/firestore.mts';
import { readLedger, readSweepStatus, DATE_RE } from './lib/customer-comms.mts';

function backDates(days: number): string[] {
  const out: string[] = [];
  const now = Date.parse(etDayString() + 'T00:00:00Z');
  for (let i = 0; i < days; i++) out.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  return out;
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const dateParam = String(url.searchParams.get('date') || '');
    const daysParam = Number(url.searchParams.get('days') || 0);

    // Bounded at 30: each day is its own subcollection, so an unbounded ?days= would turn
    // one page load into hundreds of reads.
    const dates = DATE_RE.test(dateParam)
      ? [dateParam]
      : backDates(Math.min(Math.max(daysParam || 1, 1), 30));

    const entries: any[] = [];
    const status: Record<string, any> = {};
    for (const d of dates) {
      // Lenient HERE and only here: a log page that 500s because one day's read failed is
      // worse than a log page missing a day. The send path reads the ledger strictly.
      const ledger = await readLedger(d).catch(() => ({}));
      for (const [key, e] of Object.entries(ledger)) entries.push({ date: d, key, ...(e as any) });
      const s = await readSweepStatus(d);
      if (s) status[d] = s;
    }
    entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

    // "claimed && !ok" is a send that was claimed but never confirmed — an instance that
    // died mid-send, or a network failure where Resend may still have accepted. Counted
    // separately so it can't masquerade as a clean failure: it is NOT safe to retry.
    const sent = entries.filter((e) => e.ok).length;
    const failed = entries.filter((e) => !e.ok && !e.claimed).length;
    const inflight = entries.filter((e) => !e.ok && e.claimed).length;

    return J({
      ok: true,
      dates,
      totals: { total: entries.length, sent, failed, inflight },
      // Per-day sweep snapshot: considered/sent/failed/skipped. A day with an entry here
      // and nothing in `entries` ran and found nobody to email — which is the answer you
      // need before deciding this feature is broken.
      status,
      entries,
    });
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'failed' }, 500);
  }
};
