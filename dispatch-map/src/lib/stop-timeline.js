// src/lib/stop-timeline.js — the stop card's status TIMELINE (PURE).
//
// Enhancement 6 (Chad, Jul 31: "I like enhancement 6 do it"). The card answered "where is
// this order right now?" with a lone status chip, the route five sections down, and times
// behind a toggle. The timeline puts the journey on one line: Scheduled → Out for delivery →
// Delivered, with the times the app actually has.
//
// HONESTY RULES, each learned the hard way in this app:
//   • Times are never invented. There is no reliable "went out for delivery at" timestamp on
//     a stop, so that step shows NO time rather than a guess.
//   • The third step's ETA renders ONLY from NuVizz's real per-stop ETA (routeStopEta's
//     label === 'ETA'). A schedule window shown as an arrival prediction is the exact v0.54.4
//     bug ("six stops all reading 8:00 AM"), so an 'appt' value never rides the timeline.
//   • Kinds outside the six the card knows (UNPLANNED / SCHEDULED / OUT_FOR_DEL / ARRIVED /
//     DELIVERED / EXCEPTION) fall back to the existing status badge — render what is known,
//     never force an unknown state into a delivery story.

/**
 * stopTimelineModel({ kind, arrivedAt, deliveredAt, eta }) → one of
 *   { variant:'flow', steps:[{ key, label, state:'done'|'active'|'pending', time|null }] }
 *   { variant:'terminal', label, tone:'red' }        (EXCEPTION)
 *   { variant:'badge' }                              (fall back to the current chip)
 *
 * `kind` is classifyStopStatus()'s answer; arrivedAt/deliveredAt are ALREADY-FORMATTED clock
 * strings (the caller owns formatting, exactly like the badge bar it replaces); `eta` is
 * routeStopEta()'s result — only its label==='ETA' form may show, as `etaClock`.
 */
export function stopTimelineModel({ kind, arrivedAt = null, deliveredAt = null, etaClock = null, etaIsReal = false } = {}) {
  const k = String(kind ?? '');
  const step = (key, label, state, time = null) => ({ key, label, state, time });
  const realEta = etaIsReal && etaClock ? `ETA ${etaClock}` : null;
  switch (k) {
    case 'SCHEDULED':
      return { variant: 'flow', steps: [
        step('sched', 'Scheduled', 'done'),
        step('out', 'Out for delivery', 'pending'),
        step('end', 'Delivered', 'pending', realEta),
      ] };
    case 'OUT_FOR_DEL':
      return { variant: 'flow', steps: [
        step('sched', 'Scheduled', 'done'),
        step('out', 'Out for delivery', 'active'),
        step('end', 'Delivered', 'pending', realEta),
      ] };
    case 'ARRIVED':
      return { variant: 'flow', steps: [
        step('sched', 'Scheduled', 'done'),
        step('out', 'Out for delivery', 'done'),
        step('end', 'Arrived', 'active', arrivedAt),
      ] };
    case 'DELIVERED':
      return { variant: 'flow', steps: [
        step('sched', 'Scheduled', 'done'),
        step('out', 'Out for delivery', 'done'),
        step('end', 'Delivered', 'done', deliveredAt),
      ] };
    case 'EXCEPTION':
      // A terminal state, not a journey — forcing it into three steps would read as
      // "delivery in progress" on an order that needs attention instead.
      return { variant: 'terminal', label: 'Exception', tone: 'red' };
    default:
      // UNPLANNED (no journey yet), CANCELLED/UNABLE (v0.54.17's finished-outcome states,
      // which classify outside the six), and anything the future adds.
      return { variant: 'badge' };
  }
}
