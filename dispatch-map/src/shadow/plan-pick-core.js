// plan-pick-core.js — THE PLANNING AREA'S LOAD PICKS: the rules, pure.
//
// A roster load is ticked in PlanPanel's LoadPicker and sent with the plan as { kind, route, driver,
// cls, loadNbr }. The server plans that truck with the driver and class the pick carries. So a pick
// must say what the roster row on screen says — not what the row said when it was ticked. No React,
// no fetch: tested on their own.

/** A pick's identity in the picker: a roster load by its load number (else its name), a driver, a truck. */
export const pickKey = (p) => (p.kind === 'roster' ? `r:${p.loadNbr || p.route}` : p.kind === 'driver' ? `d:${p.driver}` : `t:${p.route}`);

/** A roster row as a pick: its driver, or — with no driver yet — a truck class (box truck unless the row says otherwise). */
export const asPick = (l) => ({ kind: 'roster', route: l.route, driver: l.driver, cls: l.driver ? null : (l.cls || 'box_truck'), loadNbr: l.loadNbr, cap: l.cap, capSource: l.source, onBoard: l.onBoard, shownCls: l.cls });

const nameKey = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * THE PICKS AFTER A NEW READ OF THE DAY'S ROSTER (the Refresh button, a late roster, a new day).
 * - A roster pick the new roster no longer has comes off: picks belong to their day.
 * - A roster pick the new roster still has is REBUILT FROM THE NEW ROW, so the plan is sent with the
 *   driver, class and cap now on screen (audit 2026-09-27: after Refresh the row read JOE SMITH ·
 *   tractor while the plan still went out as a driverless box truck). A truck class the dispatcher
 *   chose is kept only while the row still has no driver — once it has one, the driver's class rules.
 * - An added driver who now has a load of their own on the roster comes off (one driver, one truck).
 * - Added trucks are kept.
 */
export function rebasePicks(cur, rosterLoads) {
  const rows = new Map();
  for (const l of rosterLoads || []) { const p = asPick(l); const k = pickKey(p); if (!rows.has(k)) rows.set(k, p); }
  const onRoster = new Set((rosterLoads || []).map((l) => nameKey(l.driver)).filter(Boolean));
  const next = new Map();
  for (const [k, p] of cur) {
    if (k.startsWith('r:')) {
      const fresh = rows.get(k);
      if (!fresh) continue;
      next.set(k, !fresh.driver && p.cls ? { ...fresh, cls: p.cls } : fresh);
    } else if (!(p.kind === 'driver' && onRoster.has(nameKey(p.driver)))) next.set(k, p);
  }
  return next;
}
