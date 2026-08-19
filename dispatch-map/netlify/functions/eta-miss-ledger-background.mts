// eta-miss-ledger-background.mts
//
// NIGHTLY: how often did we ACTUALLY miss a receiving close?
//
// Chad, after the back-test: "we need to build a system that records all this data and see
// how often we miss." Until now nothing recorded the outcome of a flag, so no change to the
// model could be shown to have helped. This writes the ground-truth label for every stop
// that had a real deadline and a real arrival stamp.
//
// Data diet: history_days + customer_notes. ZERO NuVizz calls, zero vendor reads. It scores
// SEALED days only — the capture at 06:00 UTC has closed the day long before this runs.
//
//   POST ?date=YYYY-MM-DD    explicit target (default: ET-yesterday)
//   POST ?from=&to=          backfill a range — the whole captured window is fair game,
//                            which is the point: the label exists retroactively.
//   POST ?force=1            rescore a date already scored at this LEDGER_VERSION
//
// ── Schedule: 08:00 UTC nightly ──────────────────────────────────────────────
// The history capture runs at 06:00 UTC and the routing shadow at 07:30. This feeds off the
// same sealed day and is ordered after both, so a capture that runs long cannot race it.
import { isFirestoreEnabled, getDoc, setDoc } from './lib/firestore.mts';
import { etYesterday } from './lib/history-core.mts';
import { listStops } from './lib/history-store.mts';
import { scoreDay, ledgerPath, LEDGER_VERSION } from './lib/miss-ledger.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BACKFILL_DAYS = 60;

export const config = { schedule: '0 8 * * *' };

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
    if (out.length >= MAX_BACKFILL_DAYS) break;
  }
  return out;
}

/** customer_notes reads are memoised across the whole run: one route hits the same
 *  customer repeatedly and a backfill hits it on every day of the window. */
function makeNoteReader() {
  const cache = new Map<string, any>();
  return async (matchKeys: string[]) => {
    for (const k of matchKeys) {
      if (cache.has(k)) continue;
      try { cache.set(k, await getDoc(`customer_notes/${k}`)); } catch { cache.set(k, null); }
    }
    return (k: string) => cache.get(k) ?? null;
  };
}

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const force = url.searchParams.get('force') === '1';
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const one = url.searchParams.get('date');

    let dates: string[];
    if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) dates = datesBetween(from, to);
    else if (one && DATE_RE.test(one)) dates = [one];
    else dates = [etYesterday()];

    const warmNotes = makeNoteReader();
    const done: any[] = [];

    for (const date of dates) {
      if (!force) {
        const prior = await getDoc(ledgerPath(TENANT, date));
        if (prior?.version === LEDGER_VERSION) { done.push({ date, skipped: 'already scored' }); continue; }
      }
      let stops: any[] = [];
      try { stops = await listStops(TENANT, date); } catch { done.push({ date, skipped: 'no capture' }); continue; }
      if (!stops.length) { done.push({ date, skipped: 'no capture' }); continue; }

      const keys = [...new Set(stops.map((s) => String(s?.matchKey || s?.customerMatchKey || '')).filter(Boolean))];
      const noteFor = await warmNotes(keys);
      const { rows, summary } = scoreDay(stops, date, noteFor);

      // The per-stop rows are kept alongside the summary: a rollup answers "how often", the
      // rows answer "which customers, and by how long" — which is what actually gets fixed.
      await setDoc(ledgerPath(TENANT, date), { tenant: TENANT, ...summary, rows, scored_at: new Date().toISOString() });
      done.push({ date, scored: summary.scored, missed: summary.missed, miss_rate_pct: summary.miss_rate_pct });
    }

    return J({ ok: true, version: LEDGER_VERSION, days: done.length, results: done });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
