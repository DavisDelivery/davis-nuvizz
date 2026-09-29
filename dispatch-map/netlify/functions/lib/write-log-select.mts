// lib/write-log-select.mts
//
// PURE selection for the write-op ledger, split out of nuvizz-write-log.mts so it
// can be unit tested. Why it earned its own file: the 2026-08-17 address-corruption
// incident (setStopDate rewriting a consignee address to our own terminal) could
// NOT be sized from the ledger, because the endpoint returned "the last 25 rows of
// everything" — and 23 of those 25 were an unrelated bulk createStop push from the
// same afternoon. The two damaged orders were visible only by luck.
//
// A forensics tool that can be crowded out by routine traffic is not a forensics
// tool. Filtering happens BEFORE the cut, so "show me every failed setStopDate"
// answers the question that actually gets asked during an incident: how many
// orders did this touch?

import { sentNamesStop, rowIsForLoad } from './save-sent.mts';

export interface WriteLogQuery {
  /** Exact op name, e.g. 'setStopDate'. Case-insensitive. Omit for all ops. */
  op?: string | null;
  /** Exact status, e.g. 'failed'. Case-insensitive. Omit for all statuses. */
  status?: string | null;
  /** ISO instant; keep rows at or after it. Omit for no lower bound. */
  since?: string | null;
  /** A stop number: rows whose `sent` carried it (ordered or struck off), or that name it
   *  anywhere in the row. Case-insensitive. */
  stop?: string | null;
  /** A load: route name, load number or load id. Every Save OF that load — the ones that did
   *  not carry a given stop are the point (BRIAN, 2026-09-28: 8:37 carried the pickup, 8:38 did
   *  not). Case-insensitive. */
  load?: string | null;
  /** Rows to return after filtering. */
  limit: number;
}

const eq = (a: any, b: any) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** The row names this stop as a whole value somewhere — a result's missingNbrs, an error that
 *  quotes it, a single-stop op's own stopNbr. How rows written before `sent` existed are found. */
function rowNamesStop(rec: any, stop: string): boolean {
  if (sentNamesStop(rec, [stop])) return true;
  let json = '';
  try { json = JSON.stringify(rec ?? {}).toUpperCase(); } catch { return false; }
  const s = stop.toUpperCase();
  return json.includes(`"${s}"`) || new RegExp(`[^A-Z0-9]${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^A-Z0-9]`).test(json);
}

/**
 * Newest-first, filtered, then cut. Rows without a timestamp are dropped — they
 * cannot be ordered, and an un-orderable row in a forensic listing is worse than
 * an absent one.
 */
export function selectWriteOps(all: any[], q: WriteLogQuery): any[] {
  const rows = (Array.isArray(all) ? all : []).filter((o) => o && o.at);
  const filtered = rows.filter((o) => {
    if (q.op && !eq(o.op, q.op)) return false;
    if (q.status && !eq(o.status, q.status)) return false;
    if (q.since && String(o.at) < String(q.since)) return false;
    const stop = String(q.stop ?? '').trim();
    if (stop && !rowNamesStop(o, stop)) return false;
    const load = String(q.load ?? '').trim();
    if (load && !rowIsForLoad(o, load)) return false;
    return true;
  });
  filtered.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return filtered.slice(0, Math.max(1, q.limit));
}

/** How many rows MATCHED before the limit cut — so a caller can tell "5 of 5"
 *  from "5 of 60" and know whether to widen. */
export function countWriteOps(all: any[], q: Omit<WriteLogQuery, 'limit'>): number {
  return selectWriteOps(all, { ...q, limit: Number.MAX_SAFE_INTEGER }).length;
}
