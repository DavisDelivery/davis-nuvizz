// lib/customer-history-backfill.mts — the customer-history backfill's PROGRESS RECORD, and
// the two rules around it.
//
// WHY THIS EXISTS. nuvizz-rebuild-customer-history-background is a *-background* function:
// Netlify answers the caller 202 the instant the request lands and THROWS THE HANDLER'S
// RESPONSE AWAY. Until this file, the job had no document a screen could poll and no ledger
// it wrote to — so "did the backfill run, and did it finish?" was answerable only by opening
// the Firebase console and eyeballing a customer document. Chad, 2026-09-19: "I want you to
// backfill everything in firestore." CLAUDE.md, on reporting that: "never report an intent
// as an outcome — if the system did not observe it, the system may not claim it." A job that
// runs for up to fifteen minutes and leaves no trace of whether it finished cannot be claimed
// finished. This is the trace.
//
// TWO RULES, BOTH PURE, BOTH TESTED.
//
// 1. ONE RUN AT A TIME. updateCustomerRollupsForDay is read-merge-setDoc per customer
//    document. Two invocations running side by side — say September and August, kicked off
//    together to save time — both read the same customer, both merge their own month, and
//    the second write erases the first: a month of counts gone, silently, on the very run
//    meant to fill it in. So a run that finds another run live REFUSES, and says so in this
//    same document (last_refused), because a refusal nobody can read is a job that "did not
//    happen" for no visible reason.
//
// 2. A STALLED RUN DOES NOT HOLD THE LOCK FOR EVER. The platform kills the function at its
//    budget with no callback; a run killed mid-loop leaves running:true behind. The lock is
//    therefore judged off the HEARTBEAT (updated_at, stamped after every day), not off the
//    start: a run that has not moved in BACKFILL_STALE_MS is stalled, reported as such, and
//    a new run may start over it. Every write in the backfill is idempotent (months are keyed
//    by day-set, pointers merge), so re-running the stalled range costs time and nothing else.

export const BACKFILL_PROGRESS_PATH = 'nuvizz_ops/customer_history_backfill';
/** The background budget is 15 minutes; a heartbeat older than this is a run that died. */
export const BACKFILL_STALE_MS = 20 * 60_000;

export interface BackfillDayResult {
  date: string;
  ok: boolean;
  stops?: number;
  customers?: number;
  written?: number;
  pro_index?: any;
  error?: string;
  ms: number;
}

export interface BackfillProgress {
  running: boolean;
  from: string | null;
  to: string | null;
  total: number;
  done: number;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  /** who ran it (the gate's principal; 'legacy' before login is enforced) */
  by: string | null;
  error: string | null;
  results: BackfillDayResult[];
  /** the most recent run that was turned away because this one was live */
  last_refused: { at: string; from: string | null; to: string | null; reason: string; by: string | null } | null;
}

const stamp = (v: any): number => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : NaN;
};

/**
 * PURE: is a run live right now?
 *
 * Off the heartbeat, not the start (rule 2). A running doc whose stamps do not parse is NOT
 * treated as busy: the alternative is a lock nobody can release without editing Firestore by
 * hand, and the cost of being wrong this way is one idempotent re-run — the cheaper mistake.
 */
export function backfillBusy(doc: any, nowMs: number = Date.now()): boolean {
  if (!doc || doc.running !== true) return false;
  const last = stamp(doc.updated_at) || stamp(doc.started_at);
  if (!Number.isFinite(last)) return false;
  return nowMs - last < BACKFILL_STALE_MS;
}

/** PURE: the record a run writes before it touches a single day. */
export function planBackfill(dates: string[], nowIso: string, by: string | null = null): BackfillProgress {
  const sorted = [...(dates || [])].filter(Boolean).sort();
  return {
    running: true,
    from: sorted[0] ?? null,
    to: sorted[sorted.length - 1] ?? null,
    total: sorted.length,
    done: 0,
    started_at: nowIso,
    updated_at: nowIso,
    finished_at: null,
    by,
    error: null,
    results: [],
    last_refused: null,
  };
}

/** PURE: one day landed (or failed) — the heartbeat. */
export function stepBackfill(doc: BackfillProgress, result: BackfillDayResult, nowIso: string): BackfillProgress {
  return { ...doc, done: (doc.done || 0) + 1, updated_at: nowIso, results: [...(doc.results || []), result] };
}

/** PURE: the run is over, cleanly or not. */
export function finishBackfill(doc: BackfillProgress, nowIso: string, error: string | null = null): BackfillProgress {
  return { ...doc, running: false, updated_at: nowIso, finished_at: nowIso, error: error ?? null };
}

/** PURE: the field-masked patch a refused run leaves on the LIVE run's document. */
export function refusalPatch(
  attempt: { from: string | null; to: string | null; by: string | null }, nowIso: string, reason: string,
): Pick<BackfillProgress, 'last_refused'> {
  return { last_refused: { at: nowIso, from: attempt.from, to: attempt.to, reason, by: attempt.by } };
}

/**
 * PURE: the shape a screen reads. Adds the two judgements the raw document cannot make
 * about itself — `stalled` (rule 2) and the totals a person actually wants — and never
 * throws on a malformed or absent document, because this rides on the capture-health
 * endpoint and must not take the seal strip down with it.
 */
export function shapeBackfill(doc: any, nowMs: number = Date.now()): any {
  if (!doc || typeof doc !== 'object') return null;
  const results: any[] = Array.isArray(doc.results) ? doc.results : [];
  const running = doc.running === true;
  const stops = results.reduce((n, r) => n + (Number.isFinite(Number(r?.stops)) ? Number(r.stops) : 0), 0);
  const customers = results.reduce((n, r) => n + (Number.isFinite(Number(r?.written)) ? Number(r.written) : 0), 0);
  const ms = results.reduce((n, r) => n + (Number.isFinite(Number(r?.ms)) ? Number(r.ms) : 0), 0);
  return {
    running,
    stalled: running && !backfillBusy(doc, nowMs),
    from: doc.from ?? null,
    to: doc.to ?? null,
    total: Number(doc.total) || 0,
    done: Number(doc.done) || 0,
    started_at: doc.started_at ?? null,
    updated_at: doc.updated_at ?? null,
    finished_at: doc.finished_at ?? null,
    by: doc.by ?? null,
    error: doc.error ?? null,
    stops,
    customers,
    ms,
    failed_days: results.filter((r) => r && r.ok === false).map((r) => String(r.date)),
    last_refused: doc.last_refused ?? null,
  };
}
