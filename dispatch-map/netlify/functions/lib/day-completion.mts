// lib/day-completion.mts — THE END-OF-DAY BOARD: what was planned, what actually closed,
// and what is still open when the day is called.
//
// Chad: "produce a report at the end of every day at six thirty on everything that was
// planned for that day per NuVizz ... and then does not have a completed status at six
// thirty ... I think it is ninety."
//
// He is right about 90, and "everything that is not 90" is still the wrong filter in two
// specific ways — both of which would make the report technically exactly what was asked
// for and operationally misleading on the days it matters:
//
//   • 91 IS ALSO A COMPLETION. 90 is a system/scan completion; 91 is a dispatcher closing
//     the stop by hand in the portal (lib/straggler-report has known this for a while).
//     Filtering on 90 alone reports every hand-closed stop as an open one — and the busiest,
//     messiest days are exactly the days dispatch closes the most by hand, so the report
//     would look worst precisely when the day actually went fine. The 91 RATE is worth
//     watching on its own: it rises when drivers stop scanning, which is a real signal, but
//     it is a scanning signal, not a delivery one, and the two must not be added together.
//
//   • 80 IS TERMINAL BUT IT IS NOT A DELIVERY. "Unable to deliver" is a finished status in
//     NuVizz, so a naive "not completed" filter DROPS IT — and a refused delivery is the
//     single most actionable line on a 6:30pm report. Somebody has to call that customer
//     tomorrow morning. Meanwhile 99 (cancelled) is also terminal and is NOT a failure at
//     all; counting it as an open stop manufactures a problem out of an order nobody was
//     ever going to run.
//
// So "not completed" is not one bucket. It is four, and they go to different people:
//
//   not_attempted  never left 20/planned, no movement  → rolls to tomorrow. Reschedule,
//                                                        tell the customer tonight.
//   in_flight      40/50: the truck touched it and     → call the driver. Either it is
//                  never closed it                       delivered and unscanned, or he is
//                                                        still sitting at the dock.
//   unable         80: explicit failure                → the urgent line. A call tomorrow.
//   cancelled      99: not work, not a failure         → counted, never blamed.
//
// PURE, and network-free by construction: every function here takes stop records and
// returns a value. ZERO NuVizz calls, zero Firestore, no clock of its own — the caller
// supplies the date and the as-of stamp so the same day can be rebuilt identically
// tomorrow, next week, or in a test.

export type Outcome =
  | 'delivered_system'   // 90 — closed by the scan
  | 'delivered_manual'   // 91 — closed by hand in the portal
  | 'unable'             // 80 — explicit failure to deliver
  | 'cancelled'          // 99 — the order was pulled
  | 'in_flight'          // 40 / 50 — out for delivery or arrived, never closed
  | 'not_attempted';     // 20 or anything else still planned

export const OPEN_OUTCOMES: Outcome[] = ['in_flight', 'not_attempted'];
export const DELIVERED_OUTCOMES: Outcome[] = ['delivered_system', 'delivered_manual'];

const str = (v: any) => String(v ?? '').trim();

/**
 * PURE. What actually happened to one stop.
 *
 * The raw code leads, because it is the only field NuVizz sets deliberately. Where it is
 * absent or lagging the derived fields settle it — production's classifyStopStatus already
 * treats a stop carrying a real delivery stamp as delivered even when the code has not
 * caught up, and a report that disagreed with the board about who delivered would be worse
 * than no report. A code-less delivery has no 90/91 provenance, so it is attributed to the
 * system, which is the conservative choice: it can only UNDER-state the manual rate, never
 * inflate it, and an inflated "dispatch is closing everything by hand" is the reading that
 * would send someone after the wrong problem.
 */
export function stopOutcome(stop: any): Outcome {
  const code = str(stop?.status ?? stop?.executed?.stopStatus);
  if (code === '90') return 'delivered_system';
  if (code === '91') return 'delivered_manual';
  if (code === '80') return 'unable';
  if (code === '99') return 'cancelled';
  if (code === '40' || code === '50') return 'in_flight';

  // No usable code — fall back to what the board derived.
  const norm = str(stop?.normalizedStatus);
  if (stop?.deliveredDTTM || stop?.executed?.deliveredDTTM || norm === 'DELIVERED') return 'delivered_system';
  if (norm === 'EXCEPTION') return 'unable';   // 80/99 both land here; 99 was caught by code above
  if (norm === 'OUT_FOR_DEL' || norm === 'ARRIVED') return 'in_flight';
  if (stop?.arrivalDTTM || stop?.executed?.arrivalDTTM) return 'in_flight';
  return 'not_attempted';
}

export const isOpenOutcome = (o: Outcome) => o === 'in_flight' || o === 'not_attempted';
export const isDeliveredOutcome = (o: Outcome) => o === 'delivered_system' || o === 'delivered_manual';

export interface OpenStop {
  stopNbr: string; customer: string | null; route: string | null; driver: string | null;
  seq: number | null; outcome: Outcome; addr: string | null;
}
export interface RouteRoll {
  route: string; driver: string | null;
  planned: number; delivered: number; open: number;
  notAttempted: number; inFlight: number; unable: number; cancelled: number;
  completionRate: number | null;
}
export interface DayCompletion {
  date: string; asOf: string | null;
  planned: number;          // planned stops on the board, cancellations included
  gradable: number;         // planned minus cancelled — the honest denominator
  delivered: number;
  open: number;
  counts: Record<Outcome, number>;
  completionRate: number | null;   // delivered / gradable
  manualRate: number | null;       // 91 / delivered
  byRoute: RouteRoll[];
  openStops: OpenStop[];
  unableStops: OpenStop[];
}

const numOr = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function rowOf(s: any, outcome: Outcome): OpenStop {
  return {
    stopNbr: str(s?.stopNbr) || str(s?.pro) || '',
    customer: s?.businessName ?? null,
    route: str(s?.loadNbr || s?.routeName) || null,
    driver: str(s?.driverName || s?.driverUserName) || null,
    seq: numOr(s?.routeSeq ?? s?.raw?.stop?.to?.seq),
    outcome,
    addr: [s?.addr1, s?.city].filter(Boolean).join(', ') || null,
  };
}

/**
 * PURE. The whole day in one value.
 *
 * PLANNED ONLY. An unplanned stop was never on the day's board, so counting it as an
 * uncompleted plan would blame the day for work nobody scheduled. `isPlanned === false`
 * is respected where the record carries it; otherwise a stop with a route is planned.
 *
 * DUPLICATE BOARD ROWS COLLAPSE. A multi-order customer arrives as one row per order under
 * one physical visit. For counting DELIVERIES that is correct — three orders is three
 * completions. For the OPEN LIST it is not: three identical lines for one dock is how a
 * ten-line report becomes a thirty-line one nobody reads. So counts stay per order and the
 * open list collapses per stop number.
 */
export function buildDayCompletion(
  stops: any[], { date, asOf = null }: { date: string; asOf?: string | null },
): DayCompletion {
  const counts: Record<Outcome, number> = {
    delivered_system: 0, delivered_manual: 0, unable: 0, cancelled: 0, in_flight: 0, not_attempted: 0,
  };
  const routes = new Map<string, RouteRoll>();
  const openStops: OpenStop[] = [];
  const unableStops: OpenStop[] = [];
  const openSeen = new Set<string>();
  const unableSeen = new Set<string>();
  let planned = 0;

  for (const s of stops || []) {
    // Planned only — see the note above.
    const isPlanned = s?.isPlanned === false ? false : (s?.isPlanned === true || !!str(s?.loadNbr || s?.routeName));
    if (!isPlanned) continue;
    planned += 1;

    const outcome = stopOutcome(s);
    counts[outcome] += 1;

    const routeKey = str(s?.loadNbr || s?.routeName) || '(unrouted)';
    let r = routes.get(routeKey);
    if (!r) {
      r = {
        route: routeKey, driver: str(s?.driverName || s?.driverUserName) || null,
        planned: 0, delivered: 0, open: 0, notAttempted: 0, inFlight: 0, unable: 0, cancelled: 0,
        completionRate: null,
      };
      routes.set(routeKey, r);
    }
    // A route's driver can be blank on some rows and set on others; keep the first real one.
    if (!r.driver) r.driver = str(s?.driverName || s?.driverUserName) || null;
    r.planned += 1;
    if (isDeliveredOutcome(outcome)) r.delivered += 1;
    if (outcome === 'not_attempted') { r.notAttempted += 1; r.open += 1; }
    if (outcome === 'in_flight') { r.inFlight += 1; r.open += 1; }
    if (outcome === 'unable') r.unable += 1;
    if (outcome === 'cancelled') r.cancelled += 1;

    const row = rowOf(s, outcome);
    if (isOpenOutcome(outcome) && row.stopNbr && !openSeen.has(row.stopNbr)) {
      openSeen.add(row.stopNbr);
      openStops.push(row);
    }
    if (outcome === 'unable' && row.stopNbr && !unableSeen.has(row.stopNbr)) {
      unableSeen.add(row.stopNbr);
      unableStops.push(row);
    }
  }

  const delivered = counts.delivered_system + counts.delivered_manual;
  const open = counts.in_flight + counts.not_attempted;
  // THE DENOMINATOR IS A JUDGEMENT AND IT BELONGS IN ONE PLACE. A cancelled order is not a
  // delivery the day failed to make — leaving it in the denominator quietly penalises a day
  // for orders that were pulled, and on a day with a big cancellation it moves the number
  // enough to matter. `unable` STAYS IN: the freight did not get there, and a report that
  // scored a refused delivery as "not our problem" would be marking its own homework.
  const gradable = planned - counts.cancelled;

  const byRoute = [...routes.values()]
    .map((r) => ({ ...r, completionRate: (r.planned - r.cancelled) > 0 ? r.delivered / (r.planned - r.cancelled) : null }))
    .sort((a, b) => (b.open - a.open) || (b.unable - a.unable) || a.route.localeCompare(b.route));

  const bySeq = (a: OpenStop, b: OpenStop) =>
    String(a.route).localeCompare(String(b.route)) || ((a.seq ?? 1e9) - (b.seq ?? 1e9));

  return {
    date, asOf,
    planned, gradable, delivered, open, counts,
    completionRate: gradable > 0 ? delivered / gradable : null,
    manualRate: delivered > 0 ? counts.delivered_manual / delivered : null,
    byRoute,
    openStops: openStops.sort(bySeq),
    unableStops: unableStops.sort(bySeq),
  };
}

export interface Reconciliation {
  date: string;
  openAtSnapshot: number;
  closedAfter: number;        // open at 6:30, finished by the time we looked again
  stillOpen: number;          // never closed — the real carryover
  closedAfterStops: string[];
  stillOpenStops: string[];
  lateCloseRate: number | null;
}

/**
 * PURE. WHAT THE 6:30 SNAPSHOT ACTUALLY MEANT, judged the next morning.
 *
 * This is the part that decides whether the trend chart is worth anything. A stop open at
 * 6:30pm and closed at 7:15pm was never a service failure — it was a POD that had not been
 * scanned yet. Without this reconciliation the daily "open at 6:30" line measures SCANNING
 * BEHAVIOUR and reads as delivery performance, and the two move for completely different
 * reasons: a driver who scans at the truck all day and one who scans everything at the yard
 * at 7pm produce the same freight outcome and wildly different charts.
 *
 * So the snapshot is kept immutable and graded later. `closedAfter` is POD lag — worth
 * watching, and a driver-coaching number, not a customer one. `stillOpen` is the carryover
 * that actually rolled to another day, and that is the line a logistics operation lives on.
 */
export function reconcileDay(
  snapshot: { date: string; openStops: { stopNbr: string }[] }, laterStops: any[],
): Reconciliation {
  const finalBy = new Map<string, Outcome>();
  for (const s of laterStops || []) {
    const n = str(s?.stopNbr);
    if (!n) continue;
    const o = stopOutcome(s);
    // A customer with several orders under one number: any finished order settles it, and
    // an open one keeps it open — the stop is not done while something on it is not done.
    const prev = finalBy.get(n);
    if (prev == null || (isOpenOutcome(prev) === false && isOpenOutcome(o))) finalBy.set(n, o);
  }
  const closedAfterStops: string[] = [];
  const stillOpenStops: string[] = [];
  for (const { stopNbr } of snapshot?.openStops || []) {
    const n = str(stopNbr);
    if (!n) continue;
    const o = finalBy.get(n);
    // A stop that vanished from the later board is NOT assumed closed. It may have rolled
    // to another date under the same PRO, which is this operation's normal miss path — and
    // guessing "closed" there would silently erase the carryover the report exists to show.
    if (o != null && !isOpenOutcome(o)) closedAfterStops.push(n);
    else stillOpenStops.push(n);
  }
  const openAtSnapshot = closedAfterStops.length + stillOpenStops.length;
  return {
    date: snapshot?.date,
    openAtSnapshot,
    closedAfter: closedAfterStops.length,
    stillOpen: stillOpenStops.length,
    closedAfterStops, stillOpenStops,
    lateCloseRate: openAtSnapshot > 0 ? closedAfterStops.length / openAtSnapshot : null,
  };
}

// ── the email ────────────────────────────────────────────────────────────────
//
// PURE string building, so the message that reaches a real inbox every evening is something
// a test can read. Chad opens this on a phone at the end of a day, so it leads with the
// number of things needing a decision and puts the refusals ABOVE the merely-open, because
// a refused delivery needs a call and an unscanned one usually needs nothing.

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const esc = (v: any) => String(v ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export function dayCompletionSubject(d: DayCompletion): string {
  const bits = [`${d.open} open`];
  if (d.counts.unable) bits.push(`${d.counts.unable} unable`);
  bits.push(`${pct(d.completionRate)} complete`);
  return `Day board ${d.date} — ${bits.join(', ')}`;
}

export function dayCompletionText(d: DayCompletion): string {
  const L: string[] = [];
  L.push(`DAY BOARD ${d.date}${d.asOf ? ` — as of ${d.asOf} ET` : ''}`);
  L.push('');
  L.push(`${d.delivered} of ${d.gradable} planned stops completed (${pct(d.completionRate)}).`);
  L.push(`${d.open} still open: ${d.counts.not_attempted} never attempted, ${d.counts.in_flight} out for delivery or arrived but not closed.`);
  if (d.counts.unable) L.push(`${d.counts.unable} UNABLE TO DELIVER — these need a call.`);
  if (d.counts.cancelled) L.push(`${d.counts.cancelled} cancelled (not counted against the day).`);
  L.push(`Closed by hand in the portal: ${d.counts.delivered_manual} of ${d.delivered} (${pct(d.manualRate)}).`);

  if (d.unableStops.length) {
    L.push('', 'UNABLE TO DELIVER');
    for (const s of d.unableStops) L.push(`  ${s.stopNbr}  ${s.customer ?? ''} — ${s.route ?? ''}${s.driver ? ` (${s.driver})` : ''}`);
  }
  const openRoutes = d.byRoute.filter((r) => r.open > 0);
  if (openRoutes.length) {
    L.push('', 'OPEN BY ROUTE');
    for (const r of openRoutes) {
      L.push(`  ${r.route}${r.driver ? ` (${r.driver})` : ''} — ${r.open} open of ${r.planned}${r.inFlight ? `, ${r.inFlight} out for delivery` : ''}`);
    }
  }
  if (d.openStops.length) {
    L.push('', 'OPEN STOPS');
    for (const s of d.openStops) {
      const what = s.outcome === 'in_flight' ? 'out for delivery, not closed' : 'never attempted';
      L.push(`  ${s.stopNbr}  ${s.customer ?? ''} — ${s.route ?? ''}${s.seq != null ? ` #${s.seq}` : ''} — ${what}`);
    }
  }
  L.push('', 'A stop open at 6:30 is not always a missed delivery — some are PODs not scanned yet.');
  L.push('Tomorrow morning this day is re-graded and the report records which of these actually rolled.');
  return L.join('\n');
}

export function dayCompletionHtml(d: DayCompletion): string {
  const H: string[] = [];
  const row = (label: string, value: string, strong = false) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#475569">${esc(label)}</td><td style="padding:4px 0;${strong ? 'font-weight:700;' : ''}color:#0f172a">${esc(value)}</td></tr>`;
  H.push(`<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#0f172a;max-width:640px">`);
  H.push(`<h2 style="margin:0 0 2px;font-size:18px">Day board ${esc(d.date)}</h2>`);
  H.push(`<div style="color:#64748b;font-size:12px;margin-bottom:14px">${d.asOf ? `as of ${esc(d.asOf)} ET` : ''}</div>`);
  H.push('<table style="border-collapse:collapse;margin-bottom:16px">');
  H.push(row('Completed', `${d.delivered} of ${d.gradable} planned (${pct(d.completionRate)})`, true));
  H.push(row('Still open', `${d.open} — ${d.counts.not_attempted} never attempted, ${d.counts.in_flight} out for delivery`, d.open > 0));
  if (d.counts.unable) H.push(row('Unable to deliver', `${d.counts.unable} — these need a call`, true));
  if (d.counts.cancelled) H.push(row('Cancelled', `${d.counts.cancelled} (not counted against the day)`));
  H.push(row('Closed by hand', `${d.counts.delivered_manual} of ${d.delivered} (${pct(d.manualRate)})`));
  H.push('</table>');

  const table = (title: string, rows: OpenStop[], note?: string) => {
    if (!rows.length) return;
    H.push(`<h3 style="margin:18px 0 6px;font-size:14px">${esc(title)}</h3>`);
    if (note) H.push(`<div style="color:#64748b;font-size:12px;margin-bottom:6px">${esc(note)}</div>`);
    H.push('<table style="border-collapse:collapse;width:100%;font-size:13px">');
    for (const s of rows) {
      const what = s.outcome === 'in_flight' ? 'out for delivery, not closed'
        : s.outcome === 'unable' ? 'unable to deliver' : 'never attempted';
      H.push(`<tr style="border-top:1px solid #e2e8f0">`
        + `<td style="padding:6px 10px 6px 0;color:#64748b;white-space:nowrap">${esc(s.stopNbr)}</td>`
        + `<td style="padding:6px 10px 6px 0">${esc(s.customer ?? '')}</td>`
        + `<td style="padding:6px 10px 6px 0;color:#475569;white-space:nowrap">${esc(s.route ?? '')}${s.seq != null ? ` #${s.seq}` : ''}</td>`
        + `<td style="padding:6px 0;color:#64748b">${esc(what)}</td></tr>`);
    }
    H.push('</table>');
  };
  table('Unable to deliver', d.unableStops, 'Finished, but the freight did not get there.');

  const openRoutes = d.byRoute.filter((r) => r.open > 0);
  if (openRoutes.length) {
    H.push('<h3 style="margin:18px 0 6px;font-size:14px">Open by route</h3>');
    H.push('<table style="border-collapse:collapse;width:100%;font-size:13px">');
    for (const r of openRoutes) {
      H.push(`<tr style="border-top:1px solid #e2e8f0">`
        + `<td style="padding:6px 10px 6px 0;font-weight:600">${esc(r.route)}</td>`
        + `<td style="padding:6px 10px 6px 0;color:#475569">${esc(r.driver ?? '')}</td>`
        + `<td style="padding:6px 0;color:#0f172a">${r.open} open of ${r.planned}</td></tr>`);
    }
    H.push('</table>');
  }
  table('Open stops', d.openStops);

  H.push('<div style="margin-top:18px;color:#64748b;font-size:12px;line-height:1.5">'
    + 'A stop open at 6:30 is not always a missed delivery — some are PODs that have not been scanned yet. '
    + 'Tomorrow morning this day is re-graded and the report records which of these actually rolled to another day.'
    + '</div></div>');
  return H.join('');
}
