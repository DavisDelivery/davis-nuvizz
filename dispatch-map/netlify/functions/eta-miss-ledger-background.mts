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
import { scoreDay, ledgerPath, ledgerMatchKey, LEDGER_VERSION } from './lib/miss-ledger.mts';
import { scoreRow, summarize, flagHistoryPath, FLAG_HISTORY_VERSION } from './lib/flag-history.mts';
import { arrivalAnchor, isFinishedStop } from '../../src/lib/board-flags.js';

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

/** ET minutes past midnight from a stamp the board engine already knows how to read. */
function stampMin(s: any, date: string): { min: number; at: string } | null {
  const a = arrivalAnchor(s, date);
  if (!a || !Number.isFinite(a.min)) return null;
  return { min: a.min, at: String(s?.deliveredDTTM || s?.arrivalDTTM || '') };
}

/** ISO date + n days, on the digits, so no timezone can roll it. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Attach outcomes to the flags recorded live on `date`.
 *
 * `seenLater` — the evidence for Chad's "rolled to the next day" — comes from the NEXT
 * day's sealed board. If that day is not captured yet we pass null rather than false, so a
 * roll cannot be mislabelled as "never delivered" purely because we scored it too early.
 * Those rows re-score on the next run, which is why re-scoring is allowed to overwrite.
 */
async function scoreFlagOutcomes(date: string, stops: any[]) {
  const path = flagHistoryPath(TENANT, date);
  const doc = await getDoc(path);
  const tracked = doc?.rows;
  if (!tracked || !Object.keys(tracked).length) return null;

  const byStop = new Map<string, any>();
  for (const s of stops) if (s?.stopNbr != null) byStop.set(String(s.stopNbr), s);

  // Did the next day's board carry it? Absent capture => null => "we cannot tell yet".
  let nextDay: Set<string> | null = null;
  try {
    const later = await listStops(TENANT, addDays(date, 1));
    if (later?.length) nextDay = new Set(later.map((s: any) => String(s?.stopNbr)));
  } catch { /* not captured yet */ }

  const scoredAt = new Date().toISOString();
  const out: Record<string, any> = {};
  for (const [stopNbr, row] of Object.entries<any>(tracked)) {
    const s = byStop.get(stopNbr);
    const stamp = s ? stampMin(s, date) : null;
    out[stopNbr] = scoreRow(row, {
      arrivalMin: stamp ? stamp.min : null,
      deliveredAt: stamp ? stamp.at : null,
      finished: s ? isFinishedStop(s) : false,
      seenLater: nextDay ? nextDay.has(stopNbr) : null,
      scoredAt,
    });
  }

  const summary = summarize(out);
  await setDoc(path, {
    ...doc, tenant: TENANT, date, version: FLAG_HISTORY_VERSION,
    rows: out, summary, scored_at: scoredAt,
    next_day_captured: nextDay != null,
  });
  return summary;
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

      const keys = [...new Set(stops.map((s) => ledgerMatchKey(s)).filter(Boolean) as string[])];
      const noteFor = await warmNotes(keys);
      const { rows, summary } = scoreDay(stops, date, noteFor);

      // The per-stop rows are kept alongside the summary: a rollup answers "how often", the
      // rows answer "which customers, and by how long" — which is what actually gets fixed.
      await setDoc(ledgerPath(TENANT, date), { tenant: TENANT, ...summary, rows, scored_at: new Date().toISOString() });

      // ── DID THE FLAGS DO ANY GOOD? ───────────────────────────────────────────
      //
      // Chad: "the time the shipment actually delivered. And if the flag allowed us to fix
      // the problem or not before it didn't deliver on time or at all and rolled to the
      // next day."
      //
      // The flags themselves were recorded live through the day by
      // eta-flag-alert-background. This is the other half: what actually happened to each
      // one, read off the SAME sealed day the miss ledger just scored, so the two can never
      // disagree about an arrival.
      //
      // Best-effort. A day with no flags recorded is the ordinary case for any date before
      // this feature existed, and must not fail the ledger run that is its actual job.
      let flagOutcome: any = null;
      try {
        flagOutcome = await scoreFlagOutcomes(date, stops);
      } catch (e: any) {
        console.error('flag outcome scoring failed (non-fatal):', date, e?.message);
      }
      done.push({
        date, scored: summary.scored, missed: summary.missed, miss_rate_pct: summary.miss_rate_pct,
        ...(flagOutcome ? { flags: flagOutcome } : {}),
      });
    }

    return J({ ok: true, version: LEDGER_VERSION, days: done.length, results: done });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
