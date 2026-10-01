// lib/routing-build-rules.mts
//
// THE BUILD BUTTON FILLS A TRUCK TO WHAT IT CAN REALLY CARRY, AND "GREEN" MEANS WHAT THE PANEL
// PAINTS. Chad, 2026-09-28, after a Build onto CHE (a 53′) and SCOTT (a 26′ box) put 24 stops and
// 30 skids on the box and one stop on the trailer, with the Selected panel reading "leaves 11 a
// tractor can run": "a 14 skid box truck stops with 14 skids and if not enough green stops to fit
// on a tractor then it stops there too or at 30 skids either one. then lists everything that
// didn't fit."
//
// Read off the code, three things stood between that sentence and the Build:
//   1. SKIDS WERE NOT COUNTED. routing-build-background sent the solver pallets, weight and the
//      line items, never `cartons` — the field NuVizz actually carries the skid count in — so a
//      stop's skids came only from lines itemised in PLT/PALLET/SKID (freight-geometry). Lines in
//      cartons or pieces counted 0, and a 14-skid box filled on WEIGHT alone: 30 skids on SCOTT.
//   2. "GREEN" WAS NARROWER THAN THE PANEL'S GREEN. With "Only green on a 53′" ticked the Build
//      held every stop without a hand-painted green to a box. The panel paints green for the
//      hand mark, the "Tractor trailer friendly" badge AND a tractor having delivered there, so
//      stops it showed as tractor-OK were held off the trailer: CHE got the one hand-painted stop.
//   3. WHAT A LOAD ALREADY CARRIES WAS NOT COUNTED. Step 2 lets a load that already holds stops be
//      picked, the card keeps those stops, and the Build still handed the solver the whole truck.
//
// EACH RULE IS ITS OWN SWITCH, read only here (house shape: default ON, an explicit
// off/0/false/no turns it off, anything malformed leaves it ON):
//   ROUTING_BUILD_COUNT_SKIDS=off          the Build counts skids as before (pallet lines only)
//   ROUTING_BUILD_GREEN_MATCHES_PANEL=off  "only green on a 53′" means the hand mark only again
//   ROUTING_BUILD_COUNTS_EXISTING=off      a picked load is offered its whole profile again
//   ROUTING_BUILD_LEAVE_OFF_ENDS=off       full trucks leave off whatever the old assignment left,
//                                          not the costliest end of their run
//                                          (lib/routing-assign-ends.mts)
//   ROUTING_BUILD_FILL_TRUCKS=off          a truck with room no longer takes a whole group of the
//                                          orders left off (routing-assign-ends step 6) — the
//                                          v1.100 Build. A step of the ends rule: with
//                                          LEAVE_OFF_ENDS off it is off too, and says so.
// The job result carries `buildRules` saying which ran, so the position of each switch can be
// read off any build rather than remembered.
//
// Pure. No I/O.

import { deriveGeometryDeterministic } from './freight-geometry.mts';

function switchOn(env: Record<string, any> | undefined, name: string): boolean {
  const v = String(env?.[name] ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

export interface BuildRules { countSkids: boolean; greenMatchesPanel: boolean; countsExisting: boolean; leaveOffEnds: boolean; fillTrucks: boolean; windowReach: boolean }

export function buildRules(env: Record<string, any> = process.env): BuildRules {
  const leaveOffEnds = switchOn(env, 'ROUTING_BUILD_LEAVE_OFF_ENDS');
  return {
    countSkids: switchOn(env, 'ROUTING_BUILD_COUNT_SKIDS'),
    greenMatchesPanel: switchOn(env, 'ROUTING_BUILD_GREEN_MATCHES_PANEL'),
    countsExisting: switchOn(env, 'ROUTING_BUILD_COUNTS_EXISTING'),
    leaveOffEnds,
    // a step of the ends rule: with that switched off it cannot run, so it does not say it did
    fillTrucks: leaveOffEnds && switchOn(env, 'ROUTING_BUILD_FILL_TRUCKS'),
    // The window order reads the clock the truck is on: a dock it cannot reach before the close
    // never sets the run, and strict takes it off first, naming the clock (routing-repair
    // windowAwareOrder). Off: the old insertion rule, exactly.
    windowReach: switchOn(env, 'ROUTING_BUILD_WINDOW_REACH'),
  };
}

// The freight fields of a board row as the Build reads them. With skids counted, `cartons` goes
// through and freight-geometry takes it as the skid count; without, it is left out and the old
// pallet-line count applies — exactly what the Build did before this rule existed.
export function buildFreightFields(s: any, rules: Pick<BuildRules, 'countSkids'>) {
  return {
    pallets: s?.pallets, weight: s?.weight, weightUOM: s?.weightUOM,
    stopDetails: Array.isArray(s?.stopDetails) ? s.stopDetails : [],
    ...(rules.countSkids && s?.cartons != null && s?.cartons !== '' ? { cartons: Number(s.cartons) } : {}),
  };
}

// A load with no room left takes no stops — but the solver reads a missing or 0 cap as NO LIMIT
// (routing-constraints capLimited), so "full" is a sliver nothing fits in, never 0.
export const LOAD_FULL_ROOM = 1e-6;

// Does this board row say anything about its freight? Any of the fields the Build reads counts.
function hasFreight(row: any): boolean {
  const n = (v: any) => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0;
  return n(row?.cartons) || n(row?.pallets) || n(row?.weight) || (Array.isArray(row?.stopDetails) && row.stopDetails.length > 0);
}

export interface ExistingLoadFreight { stopNbrs?: string[]; stops?: any[] }

// Each planned load's truck, offered the room it has LEFT: its profile less the freight on the
// stops its card will keep (the open card's order when one is open, else its board stops — the
// browser sends the ids and, for a stop the server's board does not carry, the row it sees).
// Counted with the same freight fields and the same geometry the new stops are counted with, so
// both sides of "room" are in the same units. A stop that is ALSO in this build's selection is
// being re-planned: it is counted once, as a new stop, never as freight already on the truck too.
// Returns the trucks and what each load already carried, for the result.
export function trucksWithRoomLeft(
  trucks: any[], existingByTruck: Record<string, ExistingLoadFreight> | null | undefined,
  boardById: Map<string, any>, rules: Pick<BuildRules, 'countSkids'>, selectedIds?: Iterable<string>,
): { trucks: any[]; existing: Record<string, { stops: number; skids: number; weightLbs: number; unread: number; full: boolean }> } {
  const existing: Record<string, { stops: number; skids: number; weightLbs: number; unread: number; full: boolean }> = {};
  const out = (trucks || []).map((t) => {
    const ex = existingByTruck?.[String(t?.id)];
    const sent = new Map((Array.isArray(ex?.stops) ? ex!.stops : []).map((x: any) => [String(x?.stopNbr ?? ''), x] as const));
    const picked = new Set([...(selectedIds || [])].map(String));
    const ids = (Array.isArray(ex?.stopNbrs) && ex!.stopNbrs.length ? ex!.stopNbrs : [...sent.keys()])
      .map(String).filter((x) => x && !picked.has(x));
    if (!ids.length) return t;
    let skids = 0, weightLbs = 0, unread = 0;
    for (const id of ids) {
      const row = boardById.get(id) || sent.get(id);
      // A stop nobody can read still takes a position. "Nobody can read it" is no row at all OR a
      // row that carries no freight — the browser sends { stopNbr } alone for a stop it cannot
      // see, and that used to count 0 skids, so a full load was offered all its room.
      if (!row || !hasFreight(row)) { unread++; skids += 1; continue; }
      const g = deriveGeometryDeterministic({ stopNbr: id, ...buildFreightFields(row, rules) });
      skids += g.skids;
      weightLbs += g.weightLbs;
    }
    const left = (cap: any, used: number) => {
      if (!(typeof cap === 'number' && Number.isFinite(cap) && cap > 0)) return cap;   // no stated cap stays no cap
      const room = cap - used;
      return room > 0 ? room : LOAD_FULL_ROOM;
    };
    const maxSkids = left(t.maxSkids, skids);
    const maxWeightLbs = left(t.maxWeightLbs, weightLbs);
    existing[String(t.id)] = {
      stops: ids.length, skids, weightLbs: Math.round(weightLbs), unread,
      full: maxSkids === LOAD_FULL_ROOM || maxWeightLbs === LOAD_FULL_ROOM,
    };
    return { ...t, maxSkids, maxWeightLbs, fullMaxSkids: t.maxSkids, fullMaxWeightLbs: t.maxWeightLbs, alreadyFull: existing[String(t.id)].full };
  });
  return { trucks: out, existing };
}

// THE RESULT SAYS WHAT IS ON THE TRUCK, NOT WHAT WAS LEFT OF IT. The solver was handed the room
// left, so its route load and capacity are both "room" numbers — JOHN would read "9 / 9 skids" on
// a 14-skid box already carrying 5. After the solve, each load with freight on it gets that
// freight added back to its load and its whole profile back as its capacity, and the two "tight
// on" flags the pipeline wrote from the room numbers are rewritten from the true totals. Nothing
// the solver decided changes; only what the result reports.
export function withExistingFreight(plan: any, existing: Record<string, { stops: number; skids: number; weightLbs: number }>, trucks: any[]): any {
  if (!plan || !Array.isArray(plan.routes) || !existing || !Object.keys(existing).length) return plan;
  const full = new Map((trucks || []).map((t: any) => [String(t?.id), t] as const));
  const adjusted = new Set<string>();
  const routes = plan.routes.map((r: any) => {
    const ex = existing[String(r?.truckId)];
    const t = full.get(String(r?.truckId));
    if (!ex || !t) return r;
    adjusted.add(String(r.truckId));
    const load = { ...(r.load || {}), skids: (Number(r.load?.skids) || 0) + ex.skids, weightLbs: (Number(r.load?.weightLbs) || 0) + ex.weightLbs };
    const capacity = {
      ...(r.capacity || {}),
      skids: t.fullMaxSkids ?? r.capacity?.skids,
      weightLbs: t.fullMaxWeightLbs ?? r.capacity?.weightLbs,
    };
    return { ...r, load, capacity, existing: ex };
  });
  const tight = /^Truck (.+): tight on (skids|weight) \(/;
  const flags = (Array.isArray(plan.riskFlags) ? plan.riskFlags : []).filter((f: any) => {
    const m = tight.exec(String(f));
    return !(m && adjusted.has(m[1]));
  });
  for (const r of routes) {
    if (!adjusted.has(String(r.truckId))) continue;
    if (r.capacity.skids > 0 && r.load.skids > r.capacity.skids * 0.9) flags.push(`Truck ${r.truckId}: tight on skids (${r.load.skids}/${r.capacity.skids}, ${r.existing.skids} already on it).`);
    if (r.capacity.weightLbs > 0 && r.load.weightLbs > r.capacity.weightLbs * 0.9) flags.push(`Truck ${r.truckId}: tight on weight (${r.load.weightLbs}/${r.capacity.weightLbs} lb, ${r.existing.weightLbs} already on it).`);
  }
  return { ...plan, routes, riskFlags: flags };
}
