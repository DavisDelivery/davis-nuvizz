import { flattenForConsumers } from './flag-rows.mts';
// lib/flag-history.mts
//
// A HISTORY OF FLAGS, AND WHETHER THEY DID ANY GOOD.
//
// Chad: "I want to build a history of flags... somewhere that tracks all the flags that
// have presented itself, then the time the shipment actually delivered. And if the flag
// allowed us to fix the problem or not before it didn't deliver on time or at all and
// rolled to the next day."
//
// WHAT DID NOT EXIST. A flag is a live computation: computeBoardFlags runs over the current
// board, paints the screen, and is thrown away. Nothing kept it. The only durable trace was
// eta_flag_alerts, which records a stop ONLY if it earned an email — so ambers, and reds
// that appeared after their window shut, left no record that they ever happened. You could
// not ask "how many flags did we raise last week", let alone "did any of them help".
//
// The miss ledger (lib/miss-ledger.mts) answers the other half — did a stop with a
// receiving close actually miss it — from sealed history. But it knows nothing about flags,
// so it cannot tell a stop we SAW coming from one that blindsided us. That distinction is
// the entire value of the flag, and until now it was unmeasurable.
//
// TWO WRITERS, NO NEW CRONS:
//   • eta-flag-alert-background, every 20 minutes through the working day, folds each sweep
//     into today's row set. It already computes the whole board; this just stops throwing
//     the answer away.
//   • eta-miss-ledger-background, nightly over sealed history, attaches what actually
//     happened to each flagged stop.
//
// WHAT THIS CAN AND CANNOT SAY. It can say a stop was flagged at 9:40 against a 12:00 close
// and delivered at 11:12. It CANNOT say the flag caused that. Nobody instrumented the phone
// call. `actedOn` is the closest honest signal — the stop's route or sequence changed after
// we flagged it, which is evidence a human moved something — and it is reported as exactly
// that, never as attribution. The whole reason this file exists is that the last thing
// built here reported an intent as an outcome, so the temptation to score ourselves
// generously is the one to resist.
//
// PURE except where noted. ZERO NuVizz calls.

export const FLAG_HISTORY_COLLECTION = 'eta_flag_history';
export const FLAG_HISTORY_VERSION = 1;

export function flagHistoryPath(tenant: string, date: string): string {
  return `${FLAG_HISTORY_COLLECTION}/${tenant}__${date}`;
}

export type Outcome = 'made' | 'missed' | 'rolled' | 'undelivered' | 'unknown';

export interface FlagRow {
  stopNbr: string;
  customer: string;
  matchKey: string | null;
  /** Where it was when we FIRST flagged it, and where it ended up. A change is a human. */
  firstRoute: string; lastRoute: string;
  firstSeq: number | null; lastSeq: number | null;
  /** ET minutes past midnight when the first sweep saw this flag. */
  firstSeenMin: number;
  firstSeenAt: string;
  lastSeenMin: number;
  /** How much warning the flag gave: minutes between first sighting and the close. */
  leadMin: number | null;
  closeMin: number | null;
  hoursTier: string | null;
  firstTier: string;
  worstTier: string;
  firstEtaMin: number | null;
  lastEtaMin: number | null;
  worstLateBy: number;
  /** How many 20-minute sweeps saw it. A one-sweep flag that vanished is worth spotting. */
  sweeps: number;
  anchored: boolean;
  emailed: boolean;
  /** Filled in nightly. */
  outcome: Outcome;
  arrivalMin: number | null;
  deliveredAt: string | null;
  actedOn: boolean;
  scoredAt: string | null;
}

// Worst-first, so "the worst tier this flag ever reached" is a max, not a last-write.
const TIER_RANK: Record<string, number> = { critical: 3, red: 2, amber: 1 };
export function worseTier(a: string, b: string): string {
  return (TIER_RANK[b] || 0) > (TIER_RANK[a] || 0) ? b : a;
}

const num = (v: any): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * PURE. Fold one sweep of board rows into the day's accumulated flag rows.
 *
 * Only `hours_risk` rows are kept. The other rules (no map location, duplicate number, closed
 * today) are real flags but they are not PREDICTIONS about arriving late, so "did it deliver
 * on time" is not a question they have an answer to. Mixing them in would put rows in this
 * table whose outcome column could only ever read "unknown".
 *
 * FIRST SIGHTING IS NEVER OVERWRITTEN. The point of the table is how much warning we got, so
 * firstSeenMin, firstTier and firstEtaMin are write-once. Everything else tracks the latest
 * or the worst.
 */
export function mergeSweep(
  existing: Record<string, FlagRow> | null | undefined,
  rows: any[],
  ctx: { nowMin: number; atISO: string; emailedStops?: Set<string> },
): { rows: Record<string, FlagRow>; added: number; updated: number } {
  const out: Record<string, FlagRow> = { ...(existing || {}) };
  const emailed = ctx.emailedStops || new Set<string>();
  let added = 0; let updated = 0;

  // The SAME un-collapse the inbox uses, from the same helper. Before this, a day whose caps
  // bit sent the emails and recorded NOTHING — so the one day the board was at its worst was
  // invisible to the audit, and to any corpus built from it.
  for (const r of flattenForConsumers(rows)) {
    if (r?.rule !== 'hours_risk') continue;
    if (!r?.stopNbr) continue;      // a summary with no constituents is still not a stop
    if (r?.collapsed) continue;     // ...and neither is one that carried none to expand
    const stopNbr = String(r.stopNbr);
    const tier = String(r.tier || 'amber');
    const closeMin = num(r.closeMin);
    const etaMin = num(r.etaMin);
    const lateBy = num(r.lateBy) ?? 0;
    const route = String(r.routeName || '');
    const seq = num(r.seq);
    const prev = out[stopNbr];

    if (!prev) {
      out[stopNbr] = {
        stopNbr,
        customer: String(r.customer || r.businessName || ''),
        matchKey: r.matchKey ? String(r.matchKey) : null,
        firstRoute: route, lastRoute: route,
        firstSeq: seq, lastSeq: seq,
        firstSeenMin: ctx.nowMin,
        firstSeenAt: ctx.atISO,
        lastSeenMin: ctx.nowMin,
        // Negative lead is meaningful and kept: it says the flag appeared AFTER the window
        // had already shut, which is a flag nobody could have acted on.
        leadMin: closeMin == null ? null : closeMin - ctx.nowMin,
        closeMin,
        hoursTier: r.hoursTier ? String(r.hoursTier) : null,
        firstTier: tier, worstTier: tier,
        firstEtaMin: etaMin, lastEtaMin: etaMin,
        worstLateBy: lateBy,
        sweeps: 1,
        anchored: !!r.anchored,
        emailed: emailed.has(stopNbr),
        outcome: 'unknown',
        arrivalMin: null,
        deliveredAt: null,
        actedOn: false,
        scoredAt: null,
      };
      added++;
      continue;
    }

    out[stopNbr] = {
      ...prev,
      lastRoute: route || prev.lastRoute,
      lastSeq: seq ?? prev.lastSeq,
      lastSeenMin: ctx.nowMin,
      lastEtaMin: etaMin ?? prev.lastEtaMin,
      worstTier: worseTier(prev.worstTier, tier),
      worstLateBy: Math.max(prev.worstLateBy, lateBy),
      sweeps: prev.sweeps + 1,
      anchored: prev.anchored || !!r.anchored,
      emailed: prev.emailed || emailed.has(stopNbr),
      // A stop whose route or position changed after we flagged it is one somebody MOVED.
      // Evidence of a human acting, not proof the flag caused them to.
      actedOn: prev.actedOn || movedSince(prev, route, seq),
    };
    updated++;
  }
  return { rows: out, added, updated };
}

function movedSince(prev: FlagRow, route: string, seq: number | null): boolean {
  if (route && prev.firstRoute && route !== prev.firstRoute) return true;
  if (seq != null && prev.firstSeq != null && seq !== prev.firstSeq) return true;
  return false;
}

/**
 * PURE. What actually happened to a stop we flagged.
 *
 * `rolled` is the case Chad named specifically — "didn't deliver on time or at all and
 * rolled to the next day" — and it is the one that needs evidence from OUTSIDE the day, so
 * the caller passes `seenLater`. Without that evidence a stop with no stamp is
 * `undelivered`, which is a different and honest answer: we know it did not deliver, we do
 * not know that it came back.
 */
export function classifyOutcome(o: {
  closeMin: number | null;
  arrivalMin: number | null;
  finished?: boolean;
  /** true = it turned up on a later board. false = it did not. null/undefined = the later
   *  day is not captured yet, so we CANNOT TELL — which is not the same as "it vanished". */
  seenLater?: boolean | null;
}): Outcome {
  if (o.arrivalMin != null && o.closeMin != null) {
    return o.arrivalMin <= o.closeMin ? 'made' : 'missed';
  }
  // A stamp with no close on file cannot be graded against anything.
  if (o.arrivalMin != null) return 'unknown';
  if (o.seenLater === true) return 'rolled';
  if (o.finished) return 'unknown';   // finished with no usable stamp — cancelled, exception
  // Only claim it never came back once we have actually looked at the day it would have
  // come back on. Scoring last night's flags before tonight's capture exists would
  // otherwise label every genuine roll as "never delivered", which is the harsher answer
  // and the wrong one.
  if (o.seenLater == null) return 'unknown';
  return 'undelivered';
}

/**
 * PURE. Does this day's recorded flag set still have outcomes that could change?
 *
 * A day is PENDING while it has rows but was scored without the next day's sealed board —
 * `next_day_captured: false`. Until that capture exists, `rolled` and `undelivered` are
 * indistinguishable from each other and both read as `unknown` (see classifyOutcome), so the
 * day is not finished being scored no matter how green the run looked.
 *
 * This is the guard that keeps the re-score sweep cheap: a day that has already resolved
 * answers false after one getDoc and costs nothing further.
 */
export function needsOutcomeRescore(doc: any): boolean {
  const rows = doc?.rows;
  if (!rows || !Object.keys(rows).length) return false;
  if (doc.next_day_captured === true) return false;
  // Never scored at all is also pending — the nightly run may simply not have reached it.
  return true;
}

/** PURE. How many rows are still waiting on evidence that has not existed yet. */
export function pendingOutcomeCount(doc: any): number {
  const rows: any[] = Object.values(doc?.rows || {});
  return rows.filter((r) => r?.outcome == null || r.outcome === 'unknown').length;
}

/** PURE. Attach the nightly outcome to one accumulated flag row. */
export function scoreRow(
  row: FlagRow,
  o: { arrivalMin: number | null; deliveredAt: string | null; finished?: boolean; seenLater?: boolean | null; scoredAt: string },
): FlagRow {
  return {
    ...row,
    arrivalMin: o.arrivalMin,
    deliveredAt: o.deliveredAt,
    outcome: classifyOutcome({ closeMin: row.closeMin, arrivalMin: o.arrivalMin, finished: o.finished, seenLater: o.seenLater }),
    scoredAt: o.scoredAt,
  };
}

/**
 * PURE. The day in one line, for the top of the screen.
 *
 * `warned` counts flags that arrived with usable lead time — a flag raised after the window
 * shut is not a warning, and averaging it in would flatter the number. That distinction is
 * the whole reason the column exists.
 */
export function summarize(rows: FlagRow[] | Record<string, FlagRow>) {
  const list: FlagRow[] = Array.isArray(rows) ? rows : Object.values(rows || {});
  const by = (o: Outcome) => list.filter((r) => r.outcome === o).length;
  const withLead = list.filter((r) => r.leadMin != null && (r.leadMin as number) > 0);
  const leads = withLead.map((r) => r.leadMin as number).sort((a, b) => a - b);
  const graded = list.filter((r) => r.outcome === 'made' || r.outcome === 'missed');
  return {
    flags: list.length,
    made: by('made'),
    missed: by('missed'),
    rolled: by('rolled'),
    undelivered: by('undelivered'),
    unknown: by('unknown'),
    emailed: list.filter((r) => r.emailed).length,
    actedOn: list.filter((r) => r.actedOn).length,
    warned: withLead.length,
    tooLateToAct: list.filter((r) => r.leadMin != null && (r.leadMin as number) <= 0).length,
    medianLeadMin: leads.length ? leads[Math.floor((leads.length - 1) / 2)] : null,
    // Of the flags we could grade, how many still missed. NOT "the flag's accuracy" and
    // NOT "how often the flag saved us" — both of those would need a control group we do
    // not have. It is: when we saw it coming, how often did it happen anyway.
    missedAfterWarning: graded.length ? Math.round((by('missed') / graded.length) * 100) : null,
    gradable: graded.length,
  };
}
