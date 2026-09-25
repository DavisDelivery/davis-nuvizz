// lib/claude-shadow/backtest-core.mts — A PAST DAY, RE-PLANNED BY CLAUDE, MEASURED AGAINST WHAT RAN.
//
// Chad, 2026-09-25: "take everything that was delivered on the loads that was delivered and then
// seeing how the Claude router would have done it differently ... statistics about it being
// different, like how much more successful it was or the mileage that it reduced, the cost it
// reduced." PURE: no I/O. backtest.mts reads the day; this file turns it into a problem, checks
// every plan Claude proposes, and scores three plans on ONE yardstick.
//
// THE DAY. Exactly the stops that rode out on D, by the SAME rule the capacity learning uses
// (learnDay: delivered or attempted and stamped on D, pickups out, rolled and never-left orders
// out). The loads are the trips that ran — route + driver — so Claude plans the same freight onto
// the same trucks; it may leave a truck empty (fewer trucks is a saving) but cannot invent one.
//
// THE YARDSTICK, the learned engine's own estimator so the numbers line up with the Engine tab's:
// road miles = straight-line miles × road_factor (1.35 by default), drive minutes from the tiered
// speed model, an OPEN tour from the Buford terminal with no return leg ("Davis routes end in the
// field", routing-engine-solver.mts), and NO service time. Three plans, each on that yardstick:
//   dispatch — as driven   the loads that ran, in the order they were delivered (else the planned
//                          Display Seq, else stop number — said per load);
//   dispatch — re-sequenced the same loads, re-ordered by the engine's sequencer: what the router's
//                          assignment would drive with a machine's stop order. The gap between the
//                          first two is SEQUENCING; between the second and Claude it is ASSIGNMENT;
//   Claude                 Claude's assignment, ordered by the same sequencer.
//
// CAPS, with no future data in them. The learned model is rebuilt from learn-day summaries dated
// BEFORE D (the stored one includes D and later days). Per load: your cap for the driver or route,
// else the learned cap, combined by the cap rule (default: the tighter binds), else the truck
// class's profile. If dispatch actually put more on that truck that day than the cap, the cap is
// raised to what ran and the load says so — the truck demonstrably held it, and a cap below it would
// only penalise Claude for a limit the truck did not have.
//
// WHAT IT CANNOT SEE, said on every result: truck class comes from the CURRENT MarginIQ roster, and
// equipment limits (no 53', box only, green/red) from CURRENT customer notes — history stores
// neither as of D. Delivery windows are not a constraint here: about 88% of stored windows are the
// vendor's 08:00–20:00 default (routing-time-windows.mts), so they would test nothing.
import { solveRoute, haversineMiles, travelMinutesForMiles } from '../routing-engine-solver.mts';
import { zoneId } from '../zones.mts';
import { employeeClassMap, CLASS_OVERRIDE } from '../driver-class.mts';
import { learnDay, buildCapacityModel, keyOf, tidy, num, skidSpots, HISTORY_STOP_MASK, LEARN_TENANT } from './learn-core.mts';
import { withOverrides } from './settings-core.mts';
import type { EvalResult, Problem, ToolDef } from './plan-loop.mts';

export const BT_TENANT = LEARN_TENANT;
export const BT_JOBS = 'claude_shadow_jobs';
export const BT_RESULTS = 'claude_shadow_backtests';
export const BT_STOP_MASK = [...HISTORY_STOP_MASK, 'lat', 'lng', 'businessName', 'addr1'];
export const LEARN_DAY_MASK = ['date', 'learnVersion', 'roster', 'stampGate', 'counts', 'trips'];

// The customer_notes restriction keys that forbid a tractor-trailer. A copy of the engine's
// TRAILER_BLOCKER_KEYS (routing-assignment-solver.mts), which the shadow cannot import without that
// module's graph; test/claude-shadow-backtest.test.mjs fails the day the two differ.
export const TRAILER_BLOCKER_KEYS = new Set([
  'no_tractor_trailer', 'box_truck_only', 'straight_truck_only',
  'uline_straight_truck', 'no_53', '26ft_max', 'no_overhead_clearance',
]);
// The default truck profiles' skid counts (truck-profiles.mts DEFAULT_TRUCK_PROFILES: box_26 14,
// tractor_53 28), the last fallback when neither a learned cap nor yours exists. Pinned by test.
export const PROFILE_MAX_SKIDS: Record<string, number> = { box_truck: 14, tractor: 28 };

export type CapRule = 'tighter' | 'driver' | 'route';
export const CAP_RULES: CapRule[] = ['tighter', 'driver', 'route'];

/** Same test as the engine's hasUsableCoords (routing-plan-core.mts): finite, in range, not 0,0. */
export function usableCoords(lat: any, lng: any): boolean {
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return false;
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === 0 && b === 0) return false;
  return Math.abs(a) <= 90 && Math.abs(b) <= 180;
}

/** A location a 53' cannot serve: red-marked, or a blocking restriction not cleared by green. */
export function blocksTractor(note: any): boolean {
  if (!note || typeof note !== 'object') return false;
  if (note.vehicle_eligibility === 'box_only') return true;
  if (note.vehicle_eligibility === 'tractor') return false;
  const arr = Array.isArray(note.equipment_restrictions) ? note.equipment_restrictions : [];
  return arr.some((r: any) => TRAILER_BLOCKER_KEYS.has(String(r)));
}

const fold = (s: any) => String(s || '').trim().toUpperCase().replace(/\s+/g, '_');
const r1 = (v: number) => Math.round(v * 10) / 10;

export interface BtStop {
  id: number; n: string; lat: number; lng: number; zone: string;
  skids: number; loose: number; spots: number; weight: number;
  zip: string | null; city: string | null; name: string | null; k: string | null;
  blocksTractor: boolean;
}
export interface BtLoad {
  id: string; route: string; driver: string;
  cls: 'tractor' | 'box_truck'; clsSource: 'roster' | 'pin' | 'default';
  cap: number; capSource: string; capNote: string | null;
  dispatch: number[];                 // stop ids, in the order they were driven (see orderSource)
  orderSource: 'driven' | 'planned' | 'stop number';
}
export interface BtProblem {
  date: string; loosePerSkid: number; capRule: CapRule;
  depot: { lat: number; lng: number };
  loads: BtLoad[]; stops: BtStop[];
  excluded: { noCoords: { n: string; route: string }[]; duplicate: string[] };
  counts: any;                        // learnDay's census for the day
  capModel: { days: number; first: string | null; last: string | null };
  approximations: string[];
}

export interface BtInput {
  date: string;
  rows: any[];                        // history_days/{D}/stops, BT_STOP_MASK
  roster: any | null;                 // nuvizz_load_roster/{D}
  stamp: string;
  learnDaysBefore: any[];             // claude_shadow_learn_days with date < D
  caps: { drivers: Record<string, any>; routes: Record<string, any> } | null;
  loosePerSkid: number;
  capRule: CapRule;
  employees: any[];
  notes: Map<string, any>;            // customer_notes by match key (current state)
  depot: { lat: number; lng: number };
  at: string;
}

/** Your cap / the learned cap for this driver and route, combined by the rule; else the profile. */
export function capFor(driverRow: any, routeRow: any, rule: CapRule, cls: string): { cap: number; source: string } {
  const d = typeof driverRow?.capUsed === 'number' ? driverRow.capUsed : null;
  const r = typeof routeRow?.capUsed === 'number' ? routeRow.capUsed : null;
  const dSrc = driverRow?.capSource === 'yours' ? 'your driver cap' : 'learned driver cap';
  const rSrc = routeRow?.capSource === 'yours' ? 'your route cap' : 'learned route cap';
  if (d != null && r != null) {
    if (rule === 'driver') return { cap: d, source: dSrc };
    if (rule === 'route') return { cap: r, source: rSrc };
    return d <= r ? { cap: d, source: `${dSrc} (tighter than the route's ${r})` } : { cap: r, source: `${rSrc} (tighter than the driver's ${d})` };
  }
  if (d != null) return { cap: d, source: dSrc };
  if (r != null) return { cap: r, source: rSrc };
  return { cap: PROFILE_MAX_SKIDS[cls] ?? PROFILE_MAX_SKIDS.box_truck, source: `${cls === 'tractor' ? 'tractor' : 'box truck'} profile (no learned cap)` };
}

/** One sealed day → the problem Claude plans, and the answer key it is measured against. */
export function buildBacktestProblem(input: BtInput): BtProblem {
  const day = learnDay(input.rows, input.date, input.stamp, input.roster, input.at);
  const byNbr = new Map<string, any>();
  for (const r of input.rows || []) { const n = String(r?.stopNbr ?? ''); if (n && !byNbr.has(n)) byNbr.set(n, r); }

  // As-of-D capacity: the learned model rebuilt from days BEFORE D, with your caps on top.
  const before = (input.learnDaysBefore || []).filter((d: any) => String(d?.date || '') < input.date);
  const model = withOverrides(buildCapacityModel(before, { loosePerSkid: input.loosePerSkid }, input.at), input.caps || { drivers: {}, routes: {} });
  const dRows = new Map((model?.drivers || []).map((r: any) => [r.key, r]));
  const rRows = new Map((model?.routes || []).map((r: any) => [r.key, r]));
  const empClass = employeeClassMap(input.employees || []);

  const stops: BtStop[] = [];
  const idOf = new Map<string, number>();
  const noCoords: { n: string; route: string }[] = [];
  const duplicate: string[] = [];
  const loads: BtLoad[] = [];
  day.trips.forEach((trip: any, i: number) => {
    const ord = day.orders[i];
    const seq = ord.driven ?? ord.stops.map((s: any) => s.n);
    const orderSource: BtLoad['orderSource'] = ord.driven ? 'driven' : ord.planned ? 'planned' : 'stop number';
    const ids: number[] = [];
    let spotsRan = 0;
    for (const n of seq) {
      if (idOf.has(n)) { duplicate.push(n); continue; }
      const r = byNbr.get(n);
      if (!r || !usableCoords(r.lat, r.lng)) { noCoords.push({ n, route: trip.route }); continue; }
      const skids = num(r.cartons) ?? 0, loose = num(r.volume) ?? 0;
      const lat = Number(r.lat), lng = Number(r.lng);
      const note = r.customerMatchKey ? input.notes.get(String(r.customerMatchKey)) : null;
      const s: BtStop = {
        id: stops.length + 1, n, lat, lng, zone: zoneId(lat, lng),
        skids, loose, spots: r1(skidSpots(skids, loose, input.loosePerSkid)), weight: Math.round(num(r.weight) ?? 0),
        zip: r.zip ? String(r.zip) : null, city: r.city ? tidy(r.city) : null,
        name: r.businessName ? tidy(r.businessName) : null, k: r.customerMatchKey ? String(r.customerMatchKey) : null,
        blocksTractor: blocksTractor(note),
      };
      stops.push(s);
      idOf.set(n, s.id);
      ids.push(s.id);
      spotsRan += s.spots;
    }
    const dk = fold(trip.driver);
    const fromRoster = empClass.get(dk);
    const pinned = CLASS_OVERRIDE.get(dk);
    const cls = (fromRoster || pinned || 'box_truck') as BtLoad['cls'];
    const clsSource: BtLoad['clsSource'] = fromRoster ? 'roster' : pinned ? 'pin' : 'default';
    const base = capFor(dRows.get(keyOf(trip.driver)), rRows.get(keyOf(trip.route)), input.capRule, cls);
    let cap = r1(base.cap), capNote: string | null = null;
    if (spotsRan > cap + 1e-9) { capNote = `raised from ${cap} to ${r1(spotsRan)} — dispatch put that much on this truck on ${input.date}`; cap = r1(spotsRan); }
    loads.push({ id: `L${loads.length + 1}`, route: trip.route, driver: trip.driver, cls, clsSource, cap, capSource: base.source, capNote, dispatch: ids, orderSource });
  });

  return {
    date: input.date, loosePerSkid: input.loosePerSkid, capRule: input.capRule, depot: input.depot,
    loads, stops, excluded: { noCoords, duplicate }, counts: day.counts,
    capModel: { days: model?.days?.count ?? 0, first: model?.days?.first ?? null, last: model?.days?.last ?? null },
    approximations: [
      'Truck class is each driver’s CURRENT MarginIQ vehicle type; history does not record the truck that ran.',
      'Equipment limits (no 53′, box only, green/red marks) are the CURRENT customer notes, applied to both sides.',
      'Delivery windows are not a constraint: most stored windows are the vendor’s 08:00–20:00 default.',
      'Miles and minutes are the learned engine’s estimate (straight line × road factor, tiered speeds), open tour from Buford, no service time — the same for every column.',
    ],
  };
}

// ── measuring a plan ─────────────────────────────────────────────────────────

export interface LoadMetrics {
  id: string; stops: number; spots: number; cap: number; util: number | null; weight: number;
  miles: number; driveMin: number; over: boolean; blocked: number; order: number[];
}
export interface PlanMetrics {
  loads: LoadMetrics[];
  totals: { trucks: number; stops: number; spots: number; capUsedTrucks: number; util: number | null; miles: number; driveMin: number; overCap: number; blocked: number; unplanned: number };
}

export interface Sequencer { order(loadId: string, ids: number[]): number[] }

/** The engine's sequencer over one load's stops, unguided (no learned route order), memoised. */
export function makeSequencer(problem: BtProblem, cfg: any): Sequencer {
  const byId = new Map(problem.stops.map((s) => [s.id, s]));
  const memo = new Map<string, number[]>();
  return {
    order(loadId: string, ids: number[]): number[] {
      if (ids.length <= 1) return ids.slice();
      const key = ids.slice().sort((a, b) => a - b).join(',');
      const hit = memo.get(key);
      if (hit) return hit.slice();
      const res = solveRoute({
        loadKey: `${problem.date}:${key}`,
        stops: ids.map((id) => { const s = byId.get(id)!; return { id: String(id), lat: s.lat, lng: s.lng, zone: s.zone }; }),
        depot: problem.depot, referenceZoneSeq: null, cfg,
      });
      const out = res.order.map((s: any) => Number(s.id));
      memo.set(key, out);
      void loadId;
      return out.slice();
    },
  };
}

/** Road miles and drive minutes of an ordered stop list: open tour from the terminal. */
export function tourCost(problem: BtProblem, order: number[], cfg: any): { miles: number; driveMin: number } {
  const byId = new Map(problem.stops.map((s) => [s.id, s]));
  let lat = problem.depot.lat, lng = problem.depot.lng, crow = 0, min = 0;
  for (const id of order) {
    const s = byId.get(id);
    if (!s) continue;
    const leg = haversineMiles(lat, lng, s.lat, s.lng);
    crow += leg;
    min += travelMinutesForMiles(leg, cfg);
    lat = s.lat; lng = s.lng;
  }
  return { miles: r1(crow * cfg.road_factor), driveMin: Math.round(min) };
}

/** Measure a plan (load id → stop ids). `sequence`: 'as-given' keeps the order, 'solver' re-orders. */
export function measurePlan(problem: BtProblem, assign: Map<string, number[]>, cfg: any, seq: Sequencer | null, unplanned = 0): PlanMetrics {
  const byId = new Map(problem.stops.map((s) => [s.id, s]));
  const loads: LoadMetrics[] = [];
  for (const load of problem.loads) {
    const ids = assign.get(load.id) || [];
    if (!ids.length) continue;
    const order = seq ? seq.order(load.id, ids) : ids.slice();
    let spots = 0, weight = 0, blocked = 0;
    for (const id of ids) { const s = byId.get(id)!; spots += s.spots; weight += s.weight; if (s.blocksTractor && load.cls === 'tractor') blocked++; }
    const { miles, driveMin } = tourCost(problem, order, cfg);
    loads.push({
      id: load.id, stops: ids.length, spots: r1(spots), cap: load.cap, util: load.cap > 0 ? Math.round((spots / load.cap) * 1000) / 10 : null,
      weight, miles, driveMin, over: spots > load.cap + 1e-9, blocked, order,
    });
  }
  const sum = (f: (l: LoadMetrics) => number) => loads.reduce((a, l) => a + f(l), 0);
  const capUsedTrucks = r1(sum((l) => l.cap));
  const spots = r1(sum((l) => l.spots));
  return {
    loads,
    totals: {
      trucks: loads.length, stops: sum((l) => l.stops), spots, capUsedTrucks,
      util: capUsedTrucks > 0 ? Math.round((spots / capUsedTrucks) * 1000) / 10 : null,
      miles: r1(sum((l) => l.miles)), driveMin: Math.round(sum((l) => l.driveMin)),
      overCap: loads.filter((l) => l.over).length, blocked: sum((l) => l.blocked), unplanned,
    },
  };
}

/** Pairs of stops that share a load, both sides — name-free, so swapped load names still agree. */
export function coLoad(a: Map<string, number[]>, b: Map<string, number[]>): { recall: number | null; precision: number | null; shared: number } {
  const pairs = (m: Map<string, number[]>) => {
    const out = new Set<string>();
    for (const ids of m.values()) { const s = ids.slice().sort((x, y) => x - y); for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) out.add(`${s[i]}-${s[j]}`); }
    return out;
  };
  const pa = pairs(a), pb = pairs(b);
  let shared = 0;
  for (const p of pb) if (pa.has(p)) shared++;
  return {
    recall: pa.size ? Math.round((shared / pa.size) * 1000) / 10 : null,
    precision: pb.size ? Math.round((shared / pb.size) * 1000) / 10 : null,
    shared,
  };
}

// ── what Claude sees and does ────────────────────────────────────────────────

export const BT_SYSTEM = [
  'You are the route planner for Davis Delivery Service, a freight carrier running box trucks and 53-foot tractor-trailers out of its Buford, Georgia terminal.',
  'You are given one day of delivery stops and the trucks (loads) available that day. Assign every stop to exactly one load so the day is delivered with as few road miles and drive minutes as possible, using as few trucks as sensibly possible.',
  'HARD RULES (a plan that breaks one is rejected): every stop on exactly one load, or listed as unplanned with a reason; a load’s skid spots never exceed its cap (skid spots = skids + loose pieces ÷ the loose-per-spot ratio, already computed per stop as "spots"); a stop flagged no-tractor never rides on a tractor load.',
  'SOFT GOALS: keep a customer’s orders (same customer and address) on one load; make each load a compact, contiguous area so the truck is not criss-crossing; balance the work sensibly; route names hint at the area a load usually serves, but you may use any truck anywhere.',
  'Leaving a stop unplanned is a failure on a day like this: every stop was delivered. Only do it when no load can take it within its cap.',
  'Each load’s stop order is set for you by a sequencing engine, and miles and minutes are measured as an open tour from the terminal with no return leg. You decide which stops ride on which load.',
  'Work method: call evaluate_plan with a COMPLETE assignment (all loads, all stops). It returns each load’s stops, skid spots against its cap, estimated miles and drive minutes, and every hard-rule violation. Revise and evaluate again until there are no violations and you cannot reduce miles further without breaking a rule. Then call submit_plan with that assignment and a short reason per load. Keep prose short; the tools carry the plan.',
].join('\n\n');

export function btBriefing(p: BtProblem): string {
  const lines: string[] = [];
  lines.push(`DAY ${p.date}. Terminal (start of every load): ${p.depot.lat.toFixed(5)}, ${p.depot.lng.toFixed(5)}. Loose pieces per skid spot: ${p.loosePerSkid}.`);
  lines.push(`${p.loads.length} loads available, ${p.stops.length} stops.`);
  lines.push('');
  lines.push('LOADS: id | route name | driver | truck | cap (skid spots)');
  for (const l of p.loads) lines.push(`${l.id} | ${l.route} | ${l.driver} | ${l.cls === 'tractor' ? 'tractor 53ft' : 'box truck'} | ${l.cap}`);
  lines.push('');
  lines.push('STOPS: id | lat,lng | zip | city | customer | skids | loose | spots | lbs | flags');
  for (const s of p.stops) {
    lines.push(`${s.id} | ${s.lat.toFixed(5)},${s.lng.toFixed(5)} | ${s.zip ?? ''} | ${s.city ?? ''} | ${s.name ?? ''} | ${s.skids} | ${s.loose} | ${s.spots} | ${s.weight} | ${s.blocksTractor ? 'no-tractor' : ''}`);
  }
  return lines.join('\n');
}

const PLAN_LOADS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { load: { type: 'string' }, stops: { type: 'array', items: { type: 'integer' } } },
    required: ['load', 'stops'],
    additionalProperties: false,
  },
};
const UNPLANNED_SCHEMA = {
  type: 'array',
  items: { type: 'object', properties: { stop: { type: 'integer' }, reason: { type: 'string' } }, required: ['stop', 'reason'], additionalProperties: false },
};
export const BT_TOOLS: ToolDef[] = [
  {
    name: 'evaluate_plan',
    description: 'Check a COMPLETE assignment of every stop to a load. Returns per-load stops, skid spots vs cap, estimated miles and drive minutes (the engine sequences each load), totals, and every hard-rule violation. Nothing is recorded.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { loads: PLAN_LOADS_SCHEMA, unplanned: UNPLANNED_SCHEMA },
      required: ['loads', 'unplanned'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_plan',
    description: 'Submit the final assignment. It is checked again; a plan that breaks a hard rule is refused and not recorded. Give a one-line reason per load.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        loads: {
          type: 'array',
          items: {
            type: 'object',
            properties: { load: { type: 'string' }, stops: { type: 'array', items: { type: 'integer' } }, why: { type: 'string' } },
            required: ['load', 'stops', 'why'],
            additionalProperties: false,
          },
        },
        unplanned: UNPLANNED_SCHEMA,
        summary: { type: 'string' },
      },
      required: ['loads', 'unplanned', 'summary'],
      additionalProperties: false,
    },
  },
];

const MAX_LISTED = 40;

/** Check one proposed assignment against every HARD rule and measure it. */
export function evaluateAssignment(p: BtProblem, input: any, cfg: any, seq: Sequencer): EvalResult {
  const loadIds = new Set(p.loads.map((l) => l.id));
  const byId = new Map(p.stops.map((s) => [s.id, s]));
  const hard: string[] = [];
  const assign = new Map<string, number[]>();
  const whereIs = new Map<number, string>();
  const why = new Map<string, string>();
  for (const e of Array.isArray(input?.loads) ? input.loads : []) {
    const load = String(e?.load ?? '');
    if (!loadIds.has(load)) { hard.push(`unknown load ${JSON.stringify(load)}`); continue; }
    if (assign.has(load)) { hard.push(`load ${load} listed twice`); continue; }
    const ids: number[] = [];
    for (const raw of Array.isArray(e?.stops) ? e.stops : []) {
      const id = Number(raw);
      if (!byId.has(id)) { hard.push(`unknown stop ${JSON.stringify(raw)} on ${load}`); continue; }
      if (whereIs.has(id)) { hard.push(`stop ${id} is on ${whereIs.get(id)} and ${load}`); continue; }
      whereIs.set(id, load);
      ids.push(id);
    }
    assign.set(load, ids);
    if (typeof e?.why === 'string') why.set(load, e.why.slice(0, 300));
  }
  const unplanned: { stop: number; reason: string }[] = [];
  for (const u of Array.isArray(input?.unplanned) ? input.unplanned : []) {
    const id = Number(u?.stop);
    if (!byId.has(id)) { hard.push(`unknown unplanned stop ${JSON.stringify(u?.stop)}`); continue; }
    if (whereIs.has(id)) { hard.push(`stop ${id} is on ${whereIs.get(id)} and also listed unplanned`); continue; }
    whereIs.set(id, 'unplanned');
    unplanned.push({ stop: id, reason: String(u?.reason ?? '').slice(0, 200) });
  }
  const missing = p.stops.filter((s) => !whereIs.has(s.id)).map((s) => s.id);
  if (missing.length) hard.push(`${missing.length} stop(s) on no load and not listed unplanned: ${missing.slice(0, MAX_LISTED).join(', ')}${missing.length > MAX_LISTED ? ', …' : ''}`);

  const m = measurePlan(p, assign, cfg, seq, unplanned.length);
  for (const l of m.loads) {
    if (l.over) hard.push(`${l.id} is over its cap: ${l.spots} of ${l.cap} skid spots`);
    if (l.blocked) hard.push(`${l.id} is a tractor carrying ${l.blocked} no-tractor stop(s)`);
  }
  // SOFT: a customer's orders split across loads.
  const custLoads = new Map<string, Set<string>>();
  for (const [id, load] of whereIs) { const k = byId.get(id)?.k; if (k && load !== 'unplanned') (custLoads.get(k) ?? custLoads.set(k, new Set()).get(k)!).add(load); }
  const splits = [...custLoads.entries()].filter(([, s]) => s.size > 1).map(([k, s]) => `${k.slice(0, 40)} on ${[...s].join('+')}`);

  const ok = hard.length === 0;
  const summary = {
    ok,
    hardViolations: hard.slice(0, MAX_LISTED),
    hardViolationCount: hard.length,
    totals: { loadsUsed: m.totals.trucks, loadsAvailable: p.loads.length, stopsPlanned: m.totals.stops, unplanned: unplanned.length, miles: m.totals.miles, driveMin: m.totals.driveMin, spots: m.totals.spots },
    loads: m.loads.map((l) => [l.id, l.stops, l.spots, l.cap, l.miles, l.driveMin]),
    loadColumns: ['load', 'stops', 'spots', 'cap', 'miles', 'driveMin'],
    customerSplits: splits.slice(0, 20),
    customerSplitCount: splits.length,
  };
  const plan = {
    loads: [...assign.entries()].filter(([, ids]) => ids.length).map(([load, ids]) => ({ load, stops: ids, why: why.get(load) ?? null })),
    unplanned,
  };
  return { ok, summary, plan };
}

/** The plan-loop Problem for one backtest day. */
export function btLoopProblem(p: BtProblem, cfg: any): Problem {
  const seq = makeSequencer(p, cfg);
  return {
    system: BT_SYSTEM,
    briefing: btBriefing(p),
    tools: BT_TOOLS,
    evaluate: (input: any) => evaluateAssignment(p, input, cfg, seq),
  };
}

// ── the comparison ───────────────────────────────────────────────────────────

export interface CostRates { perMile: number | null; perDriveHour: number | null }

export function planCost(t: PlanMetrics['totals'], rates: CostRates): number | null {
  if (rates.perMile == null && rates.perDriveHour == null) return null;
  return Math.round(((rates.perMile ?? 0) * t.miles + (rates.perDriveHour ?? 0) * (t.driveMin / 60)) * 100) / 100;
}

export function pct(a: number, b: number): number | null {
  return b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null;
}

/** Score Claude's final plan against dispatch, all three columns on one yardstick. */
export function compareBacktest(p: BtProblem, claudePlan: any, cfg: any, rates: CostRates) {
  const seq = makeSequencer(p, cfg);
  const dispatchAssign = new Map(p.loads.map((l) => [l.id, l.dispatch]));
  const claudeAssign = new Map<string, number[]>();
  for (const e of claudePlan?.loads || []) claudeAssign.set(String(e.load), (e.stops || []).map(Number));
  const unplanned = (claudePlan?.unplanned || []).length;

  const driven = measurePlan(p, dispatchAssign, cfg, null);
  const reseq = measurePlan(p, dispatchAssign, cfg, seq);
  const claude = measurePlan(p, claudeAssign, cfg, seq, unplanned);

  const whereDispatch = new Map<number, string>();
  for (const [load, ids] of dispatchAssign) for (const id of ids) whereDispatch.set(id, load);
  let moved = 0;
  for (const [load, ids] of claudeAssign) for (const id of ids) if (whereDispatch.get(id) !== load) moved++;
  const co = coLoad(dispatchAssign, claudeAssign);

  const costs = { driven: planCost(driven.totals, rates), reseq: planCost(reseq.totals, rates), claude: planCost(claude.totals, rates) };
  const delta = (a: number, b: number) => ({ abs: Math.round((a - b) * 10) / 10, pct: pct(a, b) });
  return {
    columns: { driven: driven.totals, reseq: reseq.totals, claude: claude.totals },
    costs,
    vsDriven: {
      miles: delta(claude.totals.miles, driven.totals.miles),
      driveMin: delta(claude.totals.driveMin, driven.totals.driveMin),
      trucks: claude.totals.trucks - driven.totals.trucks,
      cost: costs.claude != null && costs.driven != null ? delta(costs.claude, costs.driven) : null,
    },
    sequencingOnly: { miles: delta(reseq.totals.miles, driven.totals.miles), driveMin: delta(reseq.totals.driveMin, driven.totals.driveMin) },
    assignmentOnly: { miles: delta(claude.totals.miles, reseq.totals.miles), driveMin: delta(claude.totals.driveMin, reseq.totals.driveMin), trucks: claude.totals.trucks - reseq.totals.trucks },
    agreement: { stopsMoved: moved, stopsSameLoad: p.stops.length - moved - unplanned, coLoadRecall: co.recall, coLoadPrecision: co.precision },
    loads: p.loads.map((l) => ({
      id: l.id, route: l.route, driver: l.driver, cls: l.cls, clsSource: l.clsSource, cap: l.cap, capSource: l.capSource, capNote: l.capNote, orderSource: l.orderSource,
      driven: driven.loads.find((x) => x.id === l.id) || null,
      reseq: reseq.loads.find((x) => x.id === l.id) || null,
      claude: claude.loads.find((x) => x.id === l.id) || null,
      why: (claudePlan?.loads || []).find((e: any) => e.load === l.id)?.why ?? null,
    })),
    unplanned: claudePlan?.unplanned || [],
  };
}
