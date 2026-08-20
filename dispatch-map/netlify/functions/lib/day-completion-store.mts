// lib/day-completion-store.mts — where the end-of-day board is kept.
//
// One immutable document per board day. The 6:30 snapshot is written ONCE and never
// rewritten, because the whole value of the reconciliation is that it grades a claim made
// at a fixed hour; a snapshot that drifted as the evening went on would grade itself.
// The reconciliation lands in its own field the next day, so both halves of the story sit
// in one place: what we said at 6:30, and what turned out to be true.
//
// ZERO NuVizz calls.
import { getDoc, setDoc, updateDocFields, listDocs } from './firestore.mts';

export const DAY_COMPLETION_COLLECTION = 'day_completion';
export const dayCompletionPath = (tenant: string, date: string) => `${DAY_COMPLETION_COLLECTION}/${tenant}__${date}`;

/** How many days of snapshots the trend view reads. A quarter is enough to see a season
 *  without turning the chart into a smear. */
export const HISTORY_DAYS = 90;

export async function readDayCompletion(tenant: string, date: string): Promise<any | null> {
  try { return await getDoc(dayCompletionPath(tenant, date)); } catch { return null; }
}

/** Write the snapshot. REFUSES to overwrite an existing one — see the note above. Returns
 *  what it did so a re-run can report "already recorded" instead of pretending it wrote. */
export async function writeDaySnapshot(tenant: string, date: string, snapshot: any): Promise<'written' | 'exists' | 'failed'> {
  const existing = await readDayCompletion(tenant, date);
  if (existing?.snapshot) return 'exists';
  const ok = await setDoc(dayCompletionPath(tenant, date), { tenant, date, snapshot, ...(existing?.reconciliation ? { reconciliation: existing.reconciliation } : {}) });
  return ok ? 'written' : 'failed';
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
        ? { closedAfter: d.reconciliation.closedAfter, stillOpen: d.reconciliation.stillOpen, lateCloseRate: d.reconciliation.lateCloseRate }
        : null,
    }))
    .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
    .slice(0, limitDays);
}
