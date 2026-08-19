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
import { scoreRow, summarize, flagHistoryPath, FLAG_HISTORY_VERSION, needsOutcomeRescore } from './lib/flag-history.mts';
import { arrivalAnchor, isFinishedStop } from '../../src/lib/board-flags.js';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BACKFILL_DAYS = 60;
// How far back a scheduled run reaches to finish scoring days it could not finish at the
// time. Only needs to cover the one-day lag between scoring D and D+1 being sealed, but a
// week absorbs a capture that failed or a couple of days of the site being down without
// leaving those days stuck on "unknown" for ever.
const OUTCOME_RESCORE_DAYS = 7;

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

/** `date` and the n-1 days before it, newest first — the scheduled run's catch-up window. */
function recentDates(date: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(addDays(date, -i));
  return out;
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
 *
 * ── WHY THIS RE-RUNS, AND WHY THAT USED TO BE IMPOSSIBLE ─────────────────────
 *
 * That deferral only works if something comes back later. It could not. This job runs at
 * 08:00 UTC and scores ET-yesterday (day D), but D+1 is not sealed until 06:00 UTC the
 * FOLLOWING morning — so `nextDay` was ALWAYS null on the scheduled path, and
 * classifyOutcome's `seenLater == null` branch filed every genuine roll as "unknown".
 * The next run then hit `prior?.version === LEDGER_VERSION` and `continue`d before ever
 * reaching this function, so nothing was re-scored and "unknown" was permanent.
 *
 * That made `rolled` and `undelivered` unreachable outcomes — i.e. the exact question the
 * feature was built to answer ("or at all and rolled to the next day") could never come back
 * anything but "we cannot tell". Every check stayed green the whole time, which is the
 * failure mode worth naming: a history that records nothing but shrugs looks identical to a
 * week when nothing went wrong.
 *
 * The fix is two-part and both halves are needed: this step now runs independently of the
 * miss ledger's own already-scored guard, and the scheduled run sweeps back over recent days
 * whose outcomes are still pending. Cheap by construction — a day that already resolved is
 * one getDoc and no further reads.
 */
/** One getDoc: does this day still have flag outcomes that could change? See
 *  needsOutcomeRescore — a resolved day costs exactly this read and nothing more. */
async function outcomesPending(date: string): Promise<boolean> {
  try { return needsOutcomeRescore(await getDoc(flagHistoryPath(TENANT, date))); } catch { return false; }
}

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
    // THE SCHEDULED RUN LOOKS BACK, not just at last night. Scoring ET-yesterday alone can
    // never resolve a roll, because the day a rolled stop would reappear on is not sealed
    // yet at 08:00 UTC. The older days in this window are visited for their flag outcomes
    // only — each costs one getDoc unless it actually has something left to settle.
    else dates = recentDates(etYesterday(), OUTCOME_RESCORE_DAYS);

    const warmNotes = makeNoteReader();
    const done: any[] = [];

    for (const date of dates) {
      // THE LEDGER'S GUARD MUST NOT GATE THE FLAG STEP. These are two different jobs behind
      // one version number: the miss ledger is finished with a day as soon as that day is
      // sealed, while flag outcomes are not finished until the day AFTER it is sealed too.
      // Sharing the guard meant the second job could never run a second time, which is
      // precisely why every roll was filed as "unknown" for ever. `ledgerDone` now skips
      // only the ledger's own work.
      const priorLedger = force ? null : await getDoc(ledgerPath(TENANT, date));
      const ledgerDone = priorLedger?.version === LEDGER_VERSION;
      if (ledgerDone && !(await outcomesPending(date))) {
        done.push({ date, skipped: 'already scored' });
        continue;
      }
      let stops: any[] = [];
      try { stops = await listStops(TENANT, date); } catch { done.push({ date, skipped: 'no capture' }); continue; }
      if (!stops.length) { done.push({ date, skipped: 'no capture' }); continue; }

      let summary: any = priorLedger || null;
      if (!ledgerDone) {
        const keys = [...new Set(stops.map((s) => ledgerMatchKey(s)).filter(Boolean) as string[])];
        const noteFor = await warmNotes(keys);
        const scored = scoreDay(stops, date, noteFor);
        summary = scored.summary;

        // The per-stop rows are kept alongside the summary: a rollup answers "how often", the
        // rows answer "which customers, and by how long" — which is what actually gets fixed.
        await setDoc(ledgerPath(TENANT, date), { tenant: TENANT, ...scored.summary, rows: scored.rows, scored_at: new Date().toISOString() });
      }

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
        date, scored: summary?.scored, missed: summary?.missed, miss_rate_pct: summary?.miss_rate_pct,
        ...(ledgerDone ? { ledger: 'already scored' } : {}),
        ...(flagOutcome ? { flags: flagOutcome } : {}),
      });
    }

    return J({ ok: true, version: LEDGER_VERSION, days: done.length, results: done });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
