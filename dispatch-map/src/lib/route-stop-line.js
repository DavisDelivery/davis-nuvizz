// lib/route-stop-line.js
//
// The two things a dispatcher reads off a route-detail stop card before the truck moves:
// what's on it, and when it's getting there. Both were wrong.
//
// ── The time ────────────────────────────────────────────────────────────────
// Chad, Jul 29, on a six-stop TRAILER 7: "that time should be reflecting what Nuvizz is
// showing as an eta." Every row read 8:00 AM — the same clock six times, which no route
// ever runs. RouteDetailBody rendered `s.plannedEtaDTTM || exec.to?.plannedEtaDTTM`, and
// that precedence is backwards, because `plannedEtaDTTM` means two different things
// depending on which path filled it:
//
//   • enrichment (/stop/info, nuvizz-scan) → exec.to.plannedEtaDTTM — NuVizz's REAL route ETA
//   • the list scan (nuvizz-list)          → vizzonInfo.destination.earliestSchTime — the
//                                            saved search's Estimated Arrival, i.e. the generic
//                                            window every stop on the load shares
//
// It is a non-LIVE field, so the list value survives on any stop enrichment hasn't reached
// (one capped /stop/info per NEW pro — most stops never catch up). compareByPlannedEta already
// knows this: "the live LIST feed carries NEITHER a route sequence NOR distinct per-stop ETAs
// (only a generic arrival window)" — it just wasn't known at the point the card printed a clock.
//
// So the ETA is read from `stopExecutionInfo` ONLY. That's exact rather than heuristic: the
// enrichment path DERIVES its plannedEtaDTTM from exec, so a stop with a real ETA always has it
// there, and anything else is the window. When there's no ETA the window still shows — a
// dispatcher needs the appointment — but LABELLED, so it can never be read as an ETA again.
//
// ── The freight ─────────────────────────────────────────────────────────────
// "these stop cards should have skid and loose counts on them." NuVizz's field names mislead
// (see nuvizz-scan): `cartons` is the SKID count, `volume` is the LOOSE-piece count, and
// `pallets` is TOTAL pieces. Same mapping the Compare panel and the manifest use.

/**
 * NuVizz's own route ETA for a stop, or the scheduled window when NuVizz has no ETA yet.
 *
 * @param stop a board stop (needs raw.stopExecutionInfo — kept in the lean map feed).
 * @returns {{ts: string, label: 'ETA'|'appt'}|null} — null when NuVizz gives us no time at all,
 *   which prints nothing rather than a placeholder clock.
 */
export function routeStopEta(stop) {
  const exec = stop?.raw?.stopExecutionInfo || {};
  // Delivery side first, pickup side as the fallback — mirrors nuvizz-scan's own derivation.
  const eta = exec.to?.plannedEtaDTTM || exec.from?.plannedEtaDTTM || null;
  if (typeof eta === 'string' && eta) return { ts: eta, label: 'ETA' };
  // No ETA. `scheduledFrom` is the delivery window on an enriched stop and the Estimated
  // Arrival on a list-only one; either way it is a SCHEDULE, not an arrival prediction.
  const sched = stop?.scheduledFrom || stop?.plannedEtaDTTM || null;
  return typeof sched === 'string' && sched ? { ts: sched, label: 'appt' } : null;
}

/**
 * Skids and loose pieces as the dispatcher counts them.
 *
 * A stop with no freight numbers at all returns an EMPTY text rather than "0 sk · 0 loose" —
 * an un-enriched row genuinely doesn't know yet, and printing zeros would state that it's empty.
 * When both are zero but a piece count exists, that count shows instead, so a stop is never
 * silently blank while carrying freight.
 *
 * @returns {{skids: number, loose: number, pieces: number, text: string}}
 */
export function routeStopFreight(stop) {
  const n = (v) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x > 0 ? x : 0; };
  const skids = n(stop?.cartons);
  const loose = n(stop?.volume);
  const pieces = n(stop?.pallets);
  const parts = [];
  if (skids) parts.push(`${skids} sk`);
  if (loose) parts.push(`${loose} loose`);
  if (!parts.length && pieces) parts.push(`${pieces} pcs`);
  return { skids, loose, pieces, text: parts.join(' · ') };
}

// ── The stop-number on a route card / framed-route pin ──────────────────────
//
// Chad, RASHEED 07-29: "we are showing two stop 16's in ours" — while NuVizz's workbench ran
// those two stops at 4 and 13. They are PICKUPS, and the sequence field our feed carries is
// NuVizz's ShipTo-Display-Seq: it sequences the DESTINATION side. For a delivery, ShipTo is
// the customer, so the number is the stop's true run position. For a pickup, ShipTo is where
// the freight is GOING — the terminal — so every pickup on a load inherits the TERMINAL
// RETURN's slot: one shared number, one past the last delivery (15, then 16 as the route
// grew). The proof is in the deliveries themselves: their numbers skip exactly the slots
// (4 and 13) the workbench gives the pickups.
//
// The pickup's own run position exists only inside NuVizz's route record — it is not in the
// saved-search feed at all — so it cannot be recovered here. What CAN be fixed is the lie:
// a pickup must never wear its destination's number as if it were a position. It shows as a
// pickup, unnumbered, and the card says why.
export function routeStopSeq(stop) {
  const pickup = String(stop?.stopType || '').toUpperCase() === 'PU';
  if (pickup) return { seq: null, pickup: true };
  if (typeof stop?.routeSeq === 'number') return { seq: stop.routeSeq, pickup: false };
  const t = stop?.raw?.stop?.to?.seq;
  const f = stop?.raw?.stop?.from?.seq;
  return { seq: typeof t === 'number' ? t : typeof f === 'number' ? f : null, pickup: false };
}
