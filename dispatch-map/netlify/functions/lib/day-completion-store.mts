// lib/day-completion-store.mts — where the end-of-day board is kept.
//
// One immutable document per board day. The 6:30 snapshot is written ONCE and never
// rewritten, because the whole value of the reconciliation is that it grades a claim made
// at a fixed hour; a snapshot that drifted as the evening went on would grade itself.
// The reconciliation lands in its own field the next day, so both halves of the story sit
// in one place: what we said at 6:30, and what turned out to be true.
//
// ZERO NuVizz calls.
import { getDoc, updateDocFields, listDocs, createDocIfAbsent } from './firestore.mts';

export const DAY_COMPLETION_COLLECTION = 'day_completion';
export const dayCompletionPath = (tenant: string, date: string) => `${DAY_COMPLETION_COLLECTION}/${tenant}__${date}`;

/** How many days of snapshots the trend view reads. A quarter is enough to see a season
 *  without turning the chart into a smear. */
export const HISTORY_DAYS = 90;

/** STRICT. Throws when Firestore could not be read — required before any write here. */
export async function readDayCompletionStrict(tenant: string, date: string): Promise<any | null> {
  return getDoc(dayCompletionPath(tenant, date));
}

/** Lenient: absent AND unreadable both read as "nothing recorded". Display only. */
export async function readDayCompletion(tenant: string, date: string): Promise<any | null> {
  try { return await readDayCompletionStrict(tenant, date); } catch { return null; }
}

/** Write the snapshot. REFUSES to overwrite an existing one — see the note above. Returns
 *  what it did so a re-run can report "already recorded" instead of pretending it wrote. */
export async function writeDaySnapshot(tenant: string, date: string, snapshot: any): Promise<'written' | 'exists' | 'unreadable' | 'failed'> {
  // THE "ALREADY EXISTS" GUARD WAS ONLY AS GOOD AS THE READ BEHIND IT. The lenient reader
  // returned null for BOTH "no snapshot yet" and "Firestore did not answer", so a blip let
  // the guard pass and the maskless setDoc below overwrite the immutable 6:30 record — and
  // drop the `reconciliation` field with it, since setDoc REPLACES. The evening email then
  // sends a second time for the same day, because a written snapshot is what claims it.
  let existing: any = null;
  try {
    existing = await readDayCompletionStrict(tenant, date);
  } catch (e: any) {
    console.error(`[day-completion] refusing to write ${date}: could not read the existing record (${e?.message})`);
    return 'unreadable';
  }
  if (existing?.snapshot) return 'exists';
  // createDocIfAbsent is an atomic create (currentDocument.exists=false). Two runs racing
  // the same evening cannot both win, which the read-then-write above could not guarantee
  // on its own. Only used when nothing is on file; a same-date reconciliation is preserved
  // by the field-masked path below.
  if (!existing) {
    const created = await createDocIfAbsent(dayCompletionPath(tenant, date), { tenant, date, snapshot });
    return created ? 'written' : 'exists';
  }
  // A record exists but carries no snapshot (reconciliation landed first). Field-masked so
  // the write adds the snapshot WITHOUT taking the reconciliation with it.
  const ok = await updateDocFields(dayCompletionPath(tenant, date), { tenant, date, snapshot });
  return ok ? 'written' : 'failed';
}

/**
 * THE HEARTBEAT: proof the job ran, written before it does anything that can fail.
 *
 * The 2026-09-02 report never arrived and a 67-agent investigation could not determine why —
 * because this job leaves NO trace of having run. Its only durable outputs are the snapshot
 * and the email, which are precisely the two things missing when it fails, and Netlify
 * discards a *-background* function's HTTP response, so the run's own status report goes
 * nowhere. "Never invoked" and "invoked and died" are pixel-identical from outside.
 *
 * One row, written first, separates them for ever. Heartbeat but no snapshot: the platform
 * delivered the invocation and the code failed. Neither: the invocation never arrived.
 *
 * ITS OWN COLLECTION, DELIBERATELY. Not a field on the day_completion document — creating
 * that document early would make writeDaySnapshot see an existing record and take its
 * field-masked path instead of the ATOMIC create-if-absent, losing the only thing that stops
 * two racing firings both claiming the evening and both mailing. A diagnostic must not
 * weaken the guard it exists to explain.
 *
 * Best-effort by construction: a heartbeat that could fail the run would be a diagnostic
 * that causes outages.
 */
export const DAY_REPORT_RUN_COLLECTION = 'day_report_runs';
export const dayReportRunPath = (tenant: string, date: string) => `${DAY_REPORT_RUN_COLLECTION}/${tenant}__${date}`;

/** PURE. One field per firing, so three firings on one ET day cannot overwrite each other.
 *  Digits only — a field path with a colon would need escaping, and this is the key an
 *  incident gets read by. */
export function firingKey(etHour: number, etMinute: number): string {
  const h = String(Math.max(0, Math.min(23, Math.trunc(etHour) || 0))).padStart(2, '0');
  const m = String(Math.max(0, Math.min(59, Math.trunc(etMinute) || 0))).padStart(2, '0');
  return `et${h}${m}`;
}

export async function recordRun(
  tenant: string, date: string,
  run: { etHour: number; etMinute: number; firing: string; at: string },
): Promise<boolean> {
  try {
    return await updateDocFields(dayReportRunPath(tenant, date), {
      tenant, date,
      [firingKey(run.etHour, run.etMinute)]: {
        at: run.at, firing: run.firing, etHour: run.etHour, etMinute: run.etMinute,
      },
    });
  } catch (e: any) {
    console.error(`[day-completion] heartbeat failed for ${date}: ${e?.message}`);
    return false;
  }
}

/**
 * DID ANYONE ACTUALLY GET TOLD? Stamped only after a send the mailer confirmed.
 *
 * THE HOLE THIS CLOSES WAS WORSE THAN THE OUTAGE IT WAS FOUND CHASING. The evening job
 * claims a day by WRITING THE SNAPSHOT and sends afterwards, gated on that write — so the
 * day is marked done before anybody has been told. Run with Resend returning 429: the
 * snapshot lands, the failure is recorded in a response Netlify discards, the handler
 * returns HTTP 200 ok:true, and the spare an hour later sees a snapshot, concludes the
 * evening reported, and stands down. That report is then unsendable by anything in this
 * codebase, for ever, while every status field says success. Briefly unsetting
 * DAY_REPORT_TO does the same.
 *
 * A snapshot is a claim that the board was READ. It was being used as a claim that the owner
 * was TOLD. Those are different facts; this is the second one.
 *
 * Field-masked: this document also carries the immutable 6:30 snapshot and the next day's
 * reconciliation, and setDoc REPLACES in this codebase.
 */
export async function markDayReportSent(tenant: string, date: string, to: string, at: string): Promise<boolean> {
  return updateDocFields(dayCompletionPath(tenant, date), { sent: { at, to } });
}

/** PURE. Does this stored day still owe somebody an email? Absent document and a document
 *  with no `sent` stamp both mean nobody was mailed — the second is the case that used to be
 *  invisible. Deliberately NOT keyed on the snapshot: that was the bug. */
export function needsSending(doc: any): boolean {
  return !doc?.sent?.at;
}

/** Field-masked, because this document is not ours alone — the snapshot half must survive.
 *  setDoc REPLACES in this codebase, and using it here would take the 6:30 record with it. */
export async function writeDayReconciliation(tenant: string, date: string, reconciliation: any): Promise<boolean> {
  return updateDocFields(dayCompletionPath(tenant, date), { reconciliation });
}

/** Every stored day, newest first, trimmed to what a chart needs. The full open-stop lists
 *  stay in the per-day documents: a 90-day trend does not need 90 days of stop rows, and
 *  shipping them would make the history payload enormous for no chart that reads them. */
export async function listDayCompletions(tenant: string, limitDays = HISTORY_DAYS): Promise<any[]> {
  let docs: any[] = [];
  try { docs = await listDocs(DAY_COMPLETION_COLLECTION); } catch { return []; }
  return (docs || [])
    .filter((d: any) => d?.tenant === tenant && d?.snapshot)
    .map((d: any) => ({
      date: d.date,
      asOf: d.snapshot.asOf ?? null,
      planned: d.snapshot.planned ?? 0,
      gradable: d.snapshot.gradable ?? 0,
      delivered: d.snapshot.delivered ?? 0,
      open: d.snapshot.open ?? 0,
      counts: d.snapshot.counts ?? null,
      completionRate: d.snapshot.completionRate ?? null,
      manualRate: d.snapshot.manualRate ?? null,
      // Present only once the day has been graded. A chart must be able to tell "nothing
      // rolled" from "not graded yet" — they are the same shape and opposite meanings.
      reconciled: d.reconciliation
        ? {
            openAtSnapshot: d.reconciliation.openAtSnapshot ?? 0,
            closedAfter: d.reconciliation.closedAfter ?? 0,
            // Days graded before these buckets existed have no value here, and 0 is the
            // honest reading: the old grader put refusals in closedAfter, so it is not that
            // there were none, it is that they were never separated. The chart draws what
            // was recorded rather than inventing a split it cannot know.
            failedAfter: d.reconciliation.failedAfter ?? 0,
            cancelledAfter: d.reconciliation.cancelledAfter ?? 0,
            stillOpen: d.reconciliation.stillOpen ?? 0,
            lateCloseRate: d.reconciliation.lateCloseRate ?? null,
          }
        : null,
    }))
    .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
    .slice(0, limitDays);
}
