// lib/miss-ledger.mts
//
// DID WE ACTUALLY MISS? — the ground-truth label this system has never had.
//
// Every flag the board raises is a prediction that a stop will arrive after its receiving
// close. Nothing anywhere recorded whether it then DID. Without that label, "is the flag
// any good" is unanswerable: precision and recall cannot be computed, and no change to the
// model can be shown to have helped. This derives the label from sealed history, so it
// backfills over every day already captured instead of starting from zero today.
//
// A stop is scored ONLY when both halves are real:
//   - a receiving close on file for that weekday (typed by a dispatcher, or auto-detected
//     from the order text — the tier is carried through so the two can be told apart), and
//   - a real arrival stamp for that stop on that day.
// Anything else is counted as unscorable and reported, never silently treated as "made it".
//
// Read-only over history_days + customer_notes. ZERO NuVizz calls.
//
// THE ENGINE IS IMPORTED, NOT COPIED. dayReceivingWindow and arrivalAnchor come from the
// SAME src/lib/board-flags.js the board runs. An earlier back-test re-implemented the
// model's accessors and silently diverged in three places — sequence fallback, pin
// override, appointment matching — which changed which routes were scored. A scorer that
// grades a copy of the model grades the wrong thing.
import { dayReceivingWindow, arrivalAnchor, isFinishedStop } from '../../../src/lib/board-flags.js';

export const MISS_LEDGER_COLLECTION = 'eta_miss_ledger';
export const LEDGER_VERSION = 1;

export function ledgerPath(tenant: string, date: string): string {
  return `${MISS_LEDGER_COLLECTION}/${tenant}__${date}`;
}

// Noon-anchored so a DST boundary cannot roll the weekday, and built from the date digits
// rather than a parsed instant. Mirrors weekdayKeyFromDate in App.jsx.
export function weekdayKey(date: string): string | null {
  const [y, m, d] = String(date || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dt.getDay()];
}

export interface MissRow {
  stopNbr: string; customer: string; route: string; matchKey: string;
  closeMin: number; arrivalMin: number; lateBy: number; missed: boolean;
  tier: 'typed' | 'auto'; stampSource: 'arrival' | 'delivered';
}

/** PURE. Score one sealed day. `noteFor` supplies the customer_notes doc for a matchKey. */
export function scoreDay(
  stops: any[], date: string, noteFor: (matchKey: string) => any | null,
): { rows: MissRow[]; summary: any } {
  const day = weekdayKey(date);
  const unscorable: Record<string, number> = {};
  const bump = (k: string) => { unscorable[k] = (unscorable[k] || 0) + 1; };
  const rows: MissRow[] = [];

  for (const s of stops) {
    const matchKey = String(s?.matchKey || s?.customerMatchKey || '');
    const note = matchKey ? noteFor(matchKey) : null;
    const w = day ? dayReceivingWindow(note, day) : null;
    if (!w || w.closeMin == null) { bump('no_receiving_hours_on_file'); continue; }
    const anchor = arrivalAnchor(s, date);
    if (!anchor) {
      // A stop with a deadline and no stamp is the one case worth naming separately: it is
      // not "made it", it is "we cannot tell", and lumping it in would flatter every number.
      bump(isFinishedStop(s) ? 'finished_but_no_stamp' : 'never_stamped');
      continue;
    }
    const lateBy = Math.round(anchor.min - w.closeMin);
    rows.push({
      stopNbr: String(s?.stopNbr ?? ''), customer: String(s?.businessName || ''),
      route: String(s?.loadNbr || s?.routeName || ''), matchKey,
      closeMin: w.closeMin, arrivalMin: anchor.min, lateBy, missed: lateBy > 0,
      tier: w.tier, stampSource: anchor.source,
    });
  }

  const missed = rows.filter((r) => r.missed);
  const late = missed.map((r) => r.lateBy).sort((a, b) => a - b);
  const q = (p: number) => (late.length ? late[Math.min(late.length - 1, Math.floor((p / 100) * late.length))] : null);
  return {
    rows,
    summary: {
      version: LEDGER_VERSION, date, weekday: day,
      stops_seen: stops.length,
      scored: rows.length,
      missed: missed.length,
      miss_rate_pct: rows.length ? Math.round((missed.length / rows.length) * 1000) / 10 : null,
      // Split by how the hours were learned: a miss against dispatcher-typed hours is a
      // harder fact than one against hours parsed out of order text.
      scored_typed: rows.filter((r) => r.tier === 'typed').length,
      missed_typed: missed.filter((r) => r.tier === 'typed').length,
      late_median_min: q(50), late_p90_min: q(90),
      worst: missed.sort((a, b) => b.lateBy - a.lateBy).slice(0, 10)
        .map((r) => ({ customer: r.customer, route: r.route, stopNbr: r.stopNbr, late_min: r.lateBy })),
      unscorable,
    },
  };
}
