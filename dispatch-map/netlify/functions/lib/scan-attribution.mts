// scan-attribution.mts — WHERE THE DAY'S NuVizz CALLS WENT (PURE).
//
// Chad, on a Wednesday: "what caused the spike in nuvizz calls this morning?" The data to
// answer that was already in the run ledger and in the hourly counter, but they were two
// separate lists and joining them was a manual exercise — one that got the field names wrong
// on the first attempt and produced "I cannot prove this from the ledger" about a ledger that
// could prove it. A question this ordinary should be answered by the endpoint, not by whoever
// is reading its output.
//
// WHAT A SCAN ACTUALLY SPENDS. The cheap list path is two saved-search pulls, and then ONE
// /stop/info per NEW order since the last scan (refresh-stops-core: "each PRO is enriched
// ONCE; as orders arrive through the day each scan only enriches the increment"). So a run's
// cost is very nearly a count of new orders, and an hour that looks like a spike is usually an
// hour when freight arrived. That is the sentence this module exists to be able to write.
//
// THE HOURLY COUNTER IS THE AUTHORITY ON TOTALS, not the ledger. It counts every call the app
// makes, including live dispatcher writes (assign driver, dispatch load) that no scan run
// knows about. So the rollup reports both, and names the difference rather than hiding it:
// "runs account for 38 of 60" is the honest form, and the remainder is real activity, not an
// error.

export interface RunLike {
  id?: string;
  startedAt?: string;
  finishedAt?: string;
  etDate?: string;
  etHour?: number;
  etMin?: number;
  trigger?: string;
  path?: string;
  outcome?: string;
  calls?: number;
  callsBefore?: number;
  callsAfter?: number;
  enriched?: number;
  newPros?: number;
  dates?: any[];
}

/** What one run cost. `calls` is recorded at finish; older rows only have the two counters. */
export function runCalls(run: RunLike | null | undefined): number {
  if (!run) return 0;
  if (Number.isFinite(Number(run.calls))) return Math.max(0, Number(run.calls));
  const a = Number(run.callsAfter);
  const b = Number(run.callsBefore);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, a - b);
}

/** Enrichment per board date, which is what makes an expensive run expensive. */
export function enrichedByDate(run: RunLike | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of (run?.dates || [])) {
    const n = Number(d?.enriched) || 0;
    if (n > 0 && d?.date) out[String(d.date)] = (out[String(d.date)] || 0) + n;
  }
  return out;
}

/**
 * One sentence saying why this run cost what it did. Deliberately says "new orders", not
 * "enrichment calls": the reader is a dispatcher asking where his vendor budget went, and the
 * honest translation of an enrichment call is one order he had not seen before.
 */
export function explainRun(run: RunLike): string {
  const calls = runCalls(run);
  if (run.outcome && run.outcome !== 'ok') return `${run.path || 'run'} — ${run.outcome}${run.path === 'roster-only' ? '' : ''}`;
  const byDate = enrichedByDate(run);
  const dates = Object.keys(byDate).sort();
  const total = dates.reduce((a, k) => a + byDate[k], 0);
  if (!total) return `${run.path || 'run'} — ${calls} call${calls === 1 ? '' : 's'}, no new orders to look up`;
  const parts = dates.map((d) => `${byDate[d]} on ${d}`);
  return `${run.path || 'run'} — ${calls} calls: ${total} new order${total === 1 ? '' : 's'} looked up (${parts.join(', ')})`;
}

export interface HourRollup {
  hour: number;
  calls: number;              // from the hourly counter — every call, whatever made it
  runCalls: number;           // the part this hour's scan runs account for
  otherCalls: number;         // the rest: live dispatcher writes, on-demand reads
  runs: number;
  newOrders: number;
  topRun: { at: string; calls: number; why: string } | null;
  /** Set only when the runs claim more calls than the counter saw — a fault worth seeing. */
  overAttributed?: number;
}

/**
 * attributeSpend(runs, byHour) → an hour-by-hour account of the day, biggest first in `busiest`.
 *
 * `byHour` keys arrive from Firestore as strings; hours with no calls are absent rather than
 * zero. Both are normalised here so a caller never has to care.
 */
export function attributeSpend(
  runs: RunLike[] | null | undefined,
  byHour: Record<string | number, any> | null | undefined,
  opts: { etDate?: string } = {},
): { hours: HourRollup[]; busiest: HourRollup[]; totals: { calls: number; runCalls: number; otherCalls: number; newOrders: number }; skippedUndated: number; consistent: boolean } {
  // AN UNDATED ROW CANNOT BE ATTRIBUTED TO A DAY, so when a day is asked for it is left out.
  //
  // The first version kept undated rows ("do not drop the legacy ones") and the result was
  // arithmetic that could not be true: runCalls came back 2,070 against a day total of 1,209,
  // because the ledger now holds ~3 days and every row written before etDate was stamped got
  // counted into today. The endpoint returns only the last 40 rows but hands this function the
  // WHOLE ledger, so the inflation was invisible in the response beside it.
  //
  // Being generous with a row whose day is unknown is not generosity, it is a wrong number
  // wearing a helpful face. They are skipped and COUNTED, so a partial answer says it is one.
  const day = opts.etDate;
  const all = (runs || []).filter(Boolean);
  const rows = day ? all.filter((r) => r.etDate === day) : all;
  const skippedUndated = day ? all.filter((r) => !r.etDate).length : 0;

  const hours = new Map<number, HourRollup>();
  const bucket = (h: number): HourRollup => {
    if (!hours.has(h)) hours.set(h, { hour: h, calls: 0, runCalls: 0, otherCalls: 0, runs: 0, newOrders: 0, topRun: null });
    return hours.get(h)!;
  };

  // MATCHED AS DIGITS, not coerced. Number('') is 0 and 0 is a perfectly valid hour, so an
  // empty or blank key would silently invent a midnight bucket and put the day's calls in it.
  // Caught by the malformed-input test, which is the only reason this is a regex.
  const asHour = (k: unknown): number | null => {
    const str = typeof k === 'number' ? String(k) : String(k ?? '');
    if (!/^\d{1,2}$/.test(str)) return null;
    const h = Number(str);
    return h >= 0 && h <= 23 ? h : null;
  };

  for (const [k, v] of Object.entries(byHour || {})) {
    const h = asHour(k);
    if (h === null) continue;
    bucket(h).calls += Number(v) || 0;
  }

  for (const r of rows) {
    // Same trap on the other side: a row with etHour null coerces to 0 and would file a run
    // under midnight. Only an actual number counts as an hour.
    const h = typeof r.etHour === 'number' ? asHour(r.etHour) : null;
    if (h === null) continue;
    const b = bucket(h);
    const calls = runCalls(r);
    b.runs += 1;
    b.runCalls += calls;
    b.newOrders += Object.values(enrichedByDate(r)).reduce((a, n) => a + n, 0);
    if (!b.topRun || calls > b.topRun.calls) {
      b.topRun = { at: `${String(h).padStart(2, '0')}:${String(Number(r.etMin) || 0).padStart(2, '0')}`, calls, why: explainRun(r) };
    }
  }

  const list = [...hours.values()].sort((a, b) => a.hour - b.hour);
  // A clamp at zero hides the one thing worth surfacing: runs claiming MORE calls than the
  // counter saw means the ledger and the counter disagree, and that is a fault to report, not
  // a negative to round away. It is flagged per hour and the clamp stays so the totals add up.
  for (const h of list) {
    h.otherCalls = Math.max(0, h.calls - h.runCalls);
    if (h.runCalls > h.calls) h.overAttributed = h.runCalls - h.calls;
  }

  const totals = list.reduce((a, h) => ({
    calls: a.calls + h.calls, runCalls: a.runCalls + h.runCalls,
    otherCalls: a.otherCalls + h.otherCalls, newOrders: a.newOrders + h.newOrders,
  }), { calls: 0, runCalls: 0, otherCalls: 0, newOrders: 0 });

  return {
    hours: list,
    busiest: [...list].sort((a, b) => b.calls - a.calls).slice(0, 3),
    totals,
    // Named, so "the runs only account for some of it" is never mistaken for the whole story.
    skippedUndated,
    consistent: list.every((h) => !h.overAttributed),
  };
}
