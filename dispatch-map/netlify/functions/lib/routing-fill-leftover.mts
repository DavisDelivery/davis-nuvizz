// lib/routing-fill-leftover.mts
//
// WHEN THE TRUCKS CANNOT CARRY EVERYTHING: FILL THEM, AND WHAT IS LEFT OFF IS ONE GROUP — THE RUN
// ONE MORE TRUCK WOULD MAKE.
//
// Chad, 2026-09-30, on a Build onto CHE, SCOTT and TRAILER 1 (v1.100.0): "worked better but still
// left orders off the loads that only one was full and didn't have any logic to how it left them
// off they were orders scattered across 3 towns so i would have sent an additional truck to cover
// this". Before that, 2026-09-28: "a 14 skid box truck stops with 14 skids", and 2026-09-29: "can't
// have the middle of the selection not being routed to where 2 trucks may end up next door … it just
// left a neighbor off … things left off the beginning or end".
//
// What the ends rule (routing-assign-ends) did on that board — reproduced on the real code from the
// screenshot, the same six orders left off and the same loads (CHE 9, SCOTT 9, TRAILER 1 28):
//   • SCOTT, the only box, had 5 skids more box-only freight than it holds. It shed the far end
//     (4 one-skid Dalton orders), then a 0-skid order that freed nothing, then a 6-skid order — and
//     stopped at 9 of 14.
//   • Its "no trip across town for one skid" refill then refused the Dalton orders it had just shed,
//     so 5 skids of room went unused.
//   • Nothing made the left-off orders a group: they were whatever came off plus whatever was
//     refused — Dalton, Calhoun and Cartersville.
//
// So, here, the stops left off are treated as ONE MORE ROUTE — the truck Chad says he would have to
// send — and the plan is settled by local search on one cost, in metres (FILL_RULE says what each
// number is and how it was chosen):
//
//     the driving of every selected truck, dock to dock
//   + what windows and the day do to each truck's run AS THE BUILD WILL SHIP IT (routing-repair's
//     windowCostFor: the extra driving the window order costs, each stop it reaches after the close,
//     each hour past the driver's day) — a straight tour knows nothing about a 1–2 PM appointment
//   + the driving of that one more truck, dock to dock, through everything left off
//   + SKID_KM for every skid left off (a loose-only order a quarter skid), so a truck with room
//     takes what it can carry — but not from a town the extra truck is going to anyway
//   + AREA_PENALTY_KM for every area beyond the first that what is left off spans: one group
//   + HOLE_KM for every stop left off that a truck allowed to carry it drives right past: no
//     neighbour left off
//
// Moves, all under the hard rules (equipment and capacity, exactly as truckCanCarry / capacityFits):
//   relocate   one stop to another truck, or onto or off the left-off group
//   swap       two stops between trucks, or between a truck and the left-off group
//   eject      a stop a full truck hands to another truck with room, so a left-off stop fits
//   area       a whole AREA of what is left off onto a truck, for the truck's stops nearest the rest
//              of what is left off, or a far corner of its own run
//   many-for-1 a left-off order of 2+ skids onto a full truck in place of up to MANY of its stops
//   1-for-many one stop off a truck for up to MANY left-off stops it then has room for
//   make room  a full truck hands stops to the trucks with room — through one more truck if that
//              one is full too, and onto the left-off group as a last resort — so a left-off order
//              it may carry goes on (green on the box while box-only freight is left off and the
//              tractors have room)
// The last three are the expensive moves and run only when nothing simpler improves. Every accepted
// move lowers the cost by at least EPS_M, so the search ends; MAX_EVALS bounds the work
// (deterministically — a count, never a clock) and the result says if it was reached.
//
// Only runs when the ends rule leaves something off; a board it plans without leaving anything off
// is unchanged. Behind ROUTING_BUILD_FILL_TRUCKS (lib/routing-build-rules.mts). Pure. No I/O.
// Deterministic.

import type { SolverStop, SolverTruck, RouteLoad } from './routing-types.mts';
import { truckCanCarry, capacityBreaches, computeLoad } from './routing-constraints.mts';
import type { WindowCost } from './routing-repair.mts';

type Pt = { lat: number; lng: number };
type Dist = (a: Pt, b: Pt) => number;

function hav(a: Pt, b: Pt): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Every number below was chosen by measurement, on Chad's 09-30 board (120 placements of its 42
// stops) and on 600 random overloaded boards (1–5 trucks, "only green on a 53′" on and off), against
// the v1.92 Build and against each other. What each one does is said beside it.
export const FILL_RULE = Object.freeze({
  /** What each skid left off is worth, in km of driving: a truck with room goes this far out of its
   *  way for one more skid. At 120, SCOTT ends at 14 on all 120 placements of Chad's board. At 250
   *  (the first version) a box drove 222 km into Dalton for one skid the extra truck was going there
   *  to deliver anyway. */
  SKID_KM: 120,
  /** What each ORDER left off is worth on top of its skids, in km. 0: the plan counts skids, and on
   *  Chad's board leaves four or five small Cartersville/White orders off with Sunday c/o Encore's 6
   *  on the box. At 60 it leaves Sunday alone off instead (120 of 120 placements; at 40, 88), and on
   *  the random boards trucks then drive 3% more to leave 16% fewer orders off. Chad's call. */
  STOP_KM: 0,
  /** A loose-only order (cartons, no skid) counts as a quarter skid: it takes no skid room, so a
   *  full skid's worth sent a 53′ 169 km for one carton. */
  LOOSE_SKIDS: 0.25,
  /** Advisory windows: each stop the shipped order reaches after its close, in km — a missed close
   *  weighs what a skid left off weighs. Measured with Dalton orders due by noon: at 25 the box took
   *  them and reached them late (13 flags in 120 placements); at 120, 3. It is still a cost, not a
   *  rule: an advisory Build keeps a stop nobody can reach in time on a truck, flagged, as before. */
  ADVISORY_LATE_KM: 120,
  /** Strict windows: a stop the Build would take off for its window costs what leaving it off costs
   *  PLUS this, so it is never kept on a truck it will only be taken off again. */
  STRICT_LATE_KM: 1000,
  /** Each hour a truck's last delivery ends past the driver's day (DAY_HOURS from departure), in
   *  km. Measured with Dalton orders due by noon on Chad's board: without it the box finished after
   *  6 PM on 26 of 120 placements; at 250, on none (the Build without this step: 4, by leaving
   *  Dalton off). */
  OVER_DAY_KM_PER_HOUR: 250,
  /** The driver's day, in hours — the dispatch engine's typical_shift_hours default
   *  (routing-engine-config). */
  DAY_HOURS: 10,
  /** Largest group exchanged in one move (many-for-1, 1-for-many). */
  MANY: 5,
  /** Candidates considered for a group exchange. */
  CANDIDATES: 8,
  /** Swap partners considered per stop (nearest first). */
  SWAP_NEAREST: 12,
  /** Left-off stops chained within this many km of each other are one AREA. */
  AREA_KM: 15,
  /** Each AREA beyond the first that what is left off spans, in km ("orders scattered across 3
   *  towns"). 150: Chad's board is one area on all 120 placements, and on the random boards what is
   *  left off spans 2+ areas on 331 of 600 runs (v1.92: 576) — many of those leave more off than one
   *  truck could carry. */
  AREA_PENALTY_KM: 150,
  /** Each stop left off that a truck allowed to carry it DRIVES PAST — it sits between two of that
   *  truck's stops less than ON_THE_WAY_KM out of the way — in km (Chad, 09-29: "left a neighbor
   *  off"). 20: such stops 1,428 → 555 on the random boards; 50 and up began splitting what is left
   *  off into two areas again. */
  HOLE_KM: 20,
  ON_THE_WAY_KM: 2,
  /** A group move is straightened (2-opt) before it is judged only when it is within this many km
   *  of winning as inserted... */
  POLISH_KM: 40,
  /** ...except a left-off run longer than this many stops, which is scored as inserted. */
  POLISH_LEFT_MAX: 40,
  /** Work bound: candidate moves scored. Measured on 150-stop boards at twice what the trucks hold. */
  MAX_EVALS: 200000,
  EPS_M: 1,
});

// Tour arithmetic over a distance function: haversine for the exported helpers, a table inside
// settleLeftOff (built once per Build, so the search does lookups, not trigonometry). With `fast`,
// 2-opt — the hot loop — runs on the table's row numbers directly.
type Fast = { ix: Map<Pt, number>; table: Float64Array; n: number; pts: Pt[] };
function geometry(d: Dist, depot: Pt, fast?: Fast) {
  const tourLen = (t: SolverStop[]): number => {
    if (!t.length) return 0;
    let m = d(depot, t[0]);
    for (let i = 0; i + 1 < t.length; i++) m += d(t[i], t[i + 1]);
    return m + d(t[t.length - 1], depot);
  };
  const bestInsert = (t: SolverStop[], s: SolverStop): { cost: number; pos: number } => {
    if (!t.length) return { cost: 2 * d(depot, s), pos: 0 };
    let best = Infinity, pos = 0;
    for (let i = 0; i <= t.length; i++) {
      const prev = i === 0 ? depot : t[i - 1], next = i === t.length ? depot : t[i];
      const c = d(prev, s) + d(s, next) - d(prev, next);
      if (c < best - 1e-9) { best = c; pos = i; }
    }
    return { cost: best, pos };
  };
  const inserted = (t: SolverStop[], s: SolverStop): SolverStop[] => {
    const { pos } = bestInsert(t, s);
    return [...t.slice(0, pos), s, ...t.slice(pos)];
  };
  const twoOptFast = (t: SolverStop[], maxPasses: number, f: Fast): SolverStop[] | null => {
    const { table, n } = f;
    const id = new Int32Array(t.length + 2);
    for (let k = 0; k < t.length; k++) { const j = f.ix.get(t[k]); if (j === undefined) return null; id[k + 1] = j; }
    const m = id.length;
    for (let pass = 0; pass < maxPasses; pass++) {
      let improved = false;
      for (let i = 1; i < m - 2; i++) {
        for (let k = i + 1; k < m - 1; k++) {
          const a = id[i - 1], b = id[i], c = id[k], e = id[k + 1];
          const delta = table[a * n + c] + table[b * n + e] - table[a * n + b] - table[c * n + e];
          if (delta < -1e-6) {
            for (let x = i, y = k; x < y; x++, y--) { const tmp = id[x]; id[x] = id[y]; id[y] = tmp; }
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    const out: SolverStop[] = [];
    for (let k = 1; k < m - 1; k++) out.push(f.pts[id[k]] as SolverStop);
    return out;
  };
  const twoOpt = (t: SolverStop[], maxPasses = 60): SolverStop[] => {
    if (t.length < 3) return t;
    const quick = fast ? twoOptFast(t, maxPasses, fast) : null;
    if (quick) return quick;
    const pts: Pt[] = [depot, ...t, depot];
    for (let pass = 0; pass < maxPasses; pass++) {
      let improved = false;
      for (let i = 1; i < pts.length - 2; i++) {
        for (let k = i + 1; k < pts.length - 1; k++) {
          const delta = d(pts[i - 1], pts[k]) + d(pts[i], pts[k + 1]) - d(pts[i - 1], pts[i]) - d(pts[k], pts[k + 1]);
          if (delta < -1e-6) {
            for (let a = i, b = k; a < b; a++, b--) [pts[a], pts[b]] = [pts[b], pts[a]];
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    return pts.slice(1, -1) as SolverStop[];
  };
  const tourThrough = (stops: SolverStop[]): SolverStop[] => {
    const order = [...stops].sort((a, b) => (d(depot, b) - d(depot, a)) || (a.id < b.id ? -1 : 1));
    let t: SolverStop[] = [];
    for (const s of order) t = inserted(t, s);
    return twoOpt(t);
  };
  return { tourLen, bestInsert, inserted, twoOpt, tourThrough };
}

/** A dock-to-dock tour through `stops`: cheapest insertion, farthest from the dock first, then 2-opt. */
export function tourThrough(stops: SolverStop[], depot: Pt): SolverStop[] {
  return geometry(hav, depot).tourThrough(stops);
}

/** The driving one more truck would do through `stops`, dock to dock, in metres. */
export function extraTruckM(stops: SolverStop[], depot: Pt): number {
  const g = geometry(hav, depot);
  return g.tourLen(g.tourThrough(stops));
}

interface Route { truck: SolverTruck | null; tour: SolverStop[]; load: RouteLoad }

export interface SettleResult {
  byTruck: Map<string, SolverStop[]>;
  leftOff: SolverStop[];
  /** moves accepted, and candidate moves scored */
  moves: number;
  evals: number;
  /** true when MAX_EVALS stopped the search before it settled */
  capped: boolean;
  /** the cost (metres) before and after, and the one-more-truck run through what is left off */
  costBeforeM: number;
  costAfterM: number;
  leftOffTourM: number;
  /** AREAS (stops chained within AREA_KM) what is left off spans, pinned stops included */
  leftOffAreas: number;
}

/**
 * Settle a plan whose trucks could not carry everything. `byTruck` and `leftOff` are the ends
 * rule's answer; `pinned` are stops no selected truck can ever carry (they ride the one-more-truck
 * run too, so what else is left off groups with them, but they never move).
 */
export function settleLeftOff(
  byTruck: Map<string, SolverStop[]>, leftOff: SolverStop[], trucks: SolverTruck[], depot: Pt,
  pinned: SolverStop[] = [],
  opts: { windowCost?: (stops: SolverStop[]) => WindowCost | null; strict?: boolean } = {},
): SettleResult {
  const { SKID_KM, STOP_KM, LOOSE_SKIDS, ADVISORY_LATE_KM, STRICT_LATE_KM, OVER_DAY_KM_PER_HOUR, MANY, CANDIDATES, SWAP_NEAREST, AREA_KM, AREA_PENALTY_KM, HOLE_KM, ON_THE_WAY_KM, POLISH_KM, POLISH_LEFT_MAX, MAX_EVALS, EPS_M } = FILL_RULE;
  const all = [...[...byTruck.values()].flat(), ...leftOff, ...pinned];

  // the distance table: index 0 is the dock
  const ix = new Map<Pt, number>([[depot, 0]]);
  all.forEach((s, i) => ix.set(s, i + 1));
  const n = all.length + 1;
  const table = new Float64Array(n * n);
  const pts: Pt[] = [depot, ...all];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const m = hav(pts[i], pts[j]); table[i * n + j] = m; table[j * n + i] = m; }
  const dist: Dist = (a, b) => {
    const i = ix.get(a), j = ix.get(b);
    return i !== undefined && j !== undefined ? table[i * n + j] : hav(a, b);
  };
  const G = geometry(dist, depot, { ix, table, n, pts });

  const value = (s: SolverStop) => 1000 * (STOP_KM + SKID_KM * ((s.skids || 0) > 0 ? s.skids : LOOSE_SKIDS));
  const valueOf = (xs: SolverStop[]) => xs.reduce((a, x) => a + value(x), 0);
  const pinnedIds = new Set(pinned.map((s) => s.id));
  const movable = (s: SolverStop) => !pinnedIds.has(s.id);
  const capable = new Map<string, Set<string>>();
  for (const s of all) capable.set(s.id, new Set(trucks.filter((t) => truckCanCarry(s, t).ok).map((t) => t.id)));

  const R: Route[] = trucks.map((t) => ({ truck: t, tour: G.tourThrough(byTruck.get(t.id) || []), load: computeLoad(byTruck.get(t.id) || []) }));
  const L = R.length;   // the left-off group
  R.push({ truck: null, tour: G.tourThrough([...leftOff, ...pinned]), load: computeLoad([]) });

  // WINDOWS: a truck's run is scored as the Build will ship it — the extra driving its window order
  // costs, and each stop it still reaches after the close (strict: that stop comes off, so it costs
  // what leaving it off costs; advisory: ADVISORY_LATE_KM). Depends only on WHICH stops ride, so it
  // is cached by the set. Never negative, so a move that cannot win without it is refused unpriced.
  const winCache = new Map<string, number>();
  const winCost = (i: number, tour: SolverStop[]): number => {
    if (i === L || !opts.windowCost || !tour.length) return 0;
    const key = tour.map((x) => x.id).sort().join('\u0001');
    let c = winCache.get(key);
    if (c === undefined) {
      const w = opts.windowCost(tour);
      c = w ? w.excessM + w.late.reduce((a, x) => a + (opts.strict ? value(x) + STRICT_LATE_KM * 1000 : ADVISORY_LATE_KM * 1000), 0) + (w.overDaySec / 3600) * OVER_DAY_KM_PER_HOUR * 1000 : 0;
      winCache.set(key, c);
    }
    return c;
  };
  // AREAS: what is left off is the run one more truck makes, and three towns are three runs to a
  // dispatcher however the miles add up ("orders scattered across 3 towns"). Neighbours within
  // AREA_KM are found once; an area count is then a walk over them.
  const nbrs = new Map<SolverStop, SolverStop[]>();
  for (const x of all) nbrs.set(x, all.filter((y) => y !== x && dist(x, y) < AREA_KM * 1000));
  const areaCount = (tour: SolverStop[]): number => {
    const left = new Set(tour);
    let count = 0;
    for (const s0 of tour) {
      if (!left.has(s0)) continue;
      count++;
      left.delete(s0);
      const q = [s0];
      // stop as soon as every stop is placed: in one dense town that is the first stop's neighbours
      while (q.length && left.size) { const x = q.pop()!; for (const y of nbrs.get(x)!) if (left.has(y)) { left.delete(y); q.push(y); } }
      if (!left.size) break;
    }
    return count;
  };
  // the part of a route's cost that is cheap to work out, and the area term, which is not
  const plainCost = (i: number, tour: SolverStop[]) => G.tourLen(tour) + (i === L ? valueOf(tour) : 0);
  const areaCost = (i: number, tour: SolverStop[]) => (i === L ? Math.max(0, areaCount(tour) - 1) * AREA_PENALTY_KM * 1000 : 0);
  const baseCost = (i: number, tour: SolverStop[]) => plainCost(i, tour) + areaCost(i, tour);
  const routeCost = (i: number, tour: SolverStop[]) => baseCost(i, tour) + winCost(i, tour);
  // what each route costs as it stands, kept as moves are committed
  const cur: number[] = [];
  const cost = () => cur.reduce((a, c) => a + c, 0) + holesNow() * HOLE_KM * 1000;
  const may = (s: SolverStop, i: number) => !R[i].truck || capable.get(s.id)!.has(R[i].truck!.id);
  const fitsLoad = (i: number, ld: RouteLoad) => !R[i].truck || capacityBreaches(ld, R[i].truck!).length === 0;
  // May route i hold exactly these stops?
  const ok = (i: number, stops: SolverStop[]) => {
    if (!R[i].truck) return true;
    for (const s of stops) if (!may(s, i)) return false;
    return fitsLoad(i, computeLoad(stops));
  };
  // Load arithmetic, so a move that cannot fit is refused before any tour is built.
  const plus = (ld: RouteLoad, add: SolverStop[], gone: SolverStop[] = []): RouteLoad => {
    let { skids, weightLbs, linearFeetIn } = ld;
    for (const x of add) { skids += x.skids || 0; weightLbs += x.weightLbs || 0; linearFeetIn += x.linearFeetIn || 0; }
    for (const x of gone) { skids -= x.skids || 0; weightLbs -= x.weightLbs || 0; linearFeetIn -= x.linearFeetIn || 0; }
    return { skids, weightLbs, linearFeetIn };
  };
  const without = (tour: SolverStop[], gone: SolverStop[]) => { const g = new Set(gone); return tour.filter((s) => !g.has(s)); };
  const withAll = (tour: SolverStop[], add: SolverStop[]) => { let t = tour; for (const s of add) t = G.inserted(t, s); return t; };
  // DRIVEN PAST (Chad, 2026-09-29: "can't have … 2 trucks may end up next door because the system
  // thought the one was full so it just left a neighbor off"): a left-off stop is a hole for truck i
  // when i may carry it and it sits between two of i's stops less than ON_THE_WAY_KM out of the way.
  // holeOf caches, for each stop left off now, the trucks it is a hole for; a candidate recomputes
  // only the trucks it changes.
  const drivesPast = (l: SolverStop, tour: SolverStop[]) => {
    for (let k = 0; k + 1 < tour.length; k++) if (dist(tour[k], l) + dist(l, tour[k + 1]) - dist(tour[k], tour[k + 1]) < ON_THE_WAY_KM * 1000) return true;
    return false;
  };
  const holeTrucks = (l: SolverStop, tourOf: (i: number) => SolverStop[], only?: (i: number) => boolean) => {
    const out = new Set<number>();
    if (!movable(l)) return out;
    for (let i = 0; i < L; i++) if ((!only || only(i)) && may(l, i) && drivesPast(l, tourOf(i))) out.add(i);
    return out;
  };
  let holeOf = new Map<SolverStop, Set<number>>();
  const refreshHoles = () => { if (HOLE_KM > 0) holeOf = new Map(R[L].tour.map((l) => [l, holeTrucks(l, (i) => R[i].tour)] as const)); };
  const holesNow = () => { let c = 0; for (const v of holeOf.values()) if (v.size) c++; return c; };
  const holesAfter = (changes: Array<[number, SolverStop[]]>) => {
    const changed = new Map(changes);
    const tourOf = (i: number) => changed.get(i) ?? R[i].tour;
    const touched = (i: number) => i !== L && changed.has(i);
    let c = 0;
    for (const l of tourOf(L)) {
      const cached = holeOf.get(l);
      let hole = false;
      if (cached) { for (const i of cached) if (!touched(i)) { hole = true; break; } }
      else hole = holeTrucks(l, tourOf, (i) => !touched(i)).size > 0;
      if (!hole) hole = holeTrucks(l, tourOf, touched).size > 0;
      if (hole) c++;
    }
    return c;
  };
  const holeDelta = (changes: Array<[number, SolverStop[]]>) => (HOLE_KM > 0 ? (holesAfter(changes) - holesNow()) * HOLE_KM * 1000 : 0);
  // The most a change can give back in holes: the ones it takes off the left-off run, and the ones
  // every truck they are a hole for is a truck the change rebuilds.
  const holeBound = (changes: Array<[number, SolverStop[]]>) => {
    if (!(HOLE_KM > 0)) return 0;
    const changed = new Map(changes);
    const newL = changed.has(L) ? new Set(changed.get(L)!) : null;
    let c = 0;
    for (const [l, trucksOf] of holeOf) {
      if (!trucksOf.size) continue;
      if (newL && !newL.has(l)) { c++; continue; }
      let all = true;
      for (const i of trucksOf) if (!changed.has(i)) { all = false; break; }
      if (all) c++;
    }
    return -c * HOLE_KM * 1000;
  };

  const commit = (changes: Array<[number, SolverStop[]]>) => {
    for (const [i, tour] of changes) { R[i].tour = G.twoOpt(tour); R[i].load = computeLoad(R[i].tour); cur[i] = routeCost(i, R[i].tour); }
    refreshHoles();
  };
  R.forEach((r, i) => { cur[i] = routeCost(i, r.tour); });
  refreshHoles();

  let moves = 0, evals = 0;
  const spent = () => evals >= MAX_EVALS;
  // Score a change to some routes; commit it when it lowers the cost by more than EPS_M. A group
  // move inserts several stops one after another, which leaves a rough tour; with `polish`, a
  // candidate within POLISH_KM of winning is straightened (a few 2-opt passes) and scored again, so a
  // good group move is not refused for the order its stops happened to be inserted in.
  const tryChange = (changes: Array<[number, SolverStop[]]>, polish = false): boolean => {
    evals++;
    let raw = 0;
    for (const [i, tour] of changes) {
      if (!ok(i, tour)) return false;
      raw += plainCost(i, tour) - cur[i];
    }
    // the area and window terms are never negative, and closing every hole is the most holes can
    // give back: a change that cannot win even so is refused before they are worked out
    const bar = polish ? POLISH_KM * 1000 : -EPS_M;
    const holesBack = holeBound(changes);
    if (raw + holesBack > bar) return false;
    for (const [i, tour] of changes) raw += areaCost(i, tour);
    if (raw + holesBack > bar) return false;
    for (const [i, tour] of changes) raw += winCost(i, tour);
    if (raw + holeDelta(changes) < -EPS_M) { commit(changes); moves++; return true; }
    if (!polish || raw + holesBack > POLISH_KM * 1000) return false;
    let delta = 0;
    const final: Array<[number, SolverStop[]]> = [];
    for (const [i, tour0] of changes) {
      // a long left-off run is scored as inserted: straightening 100 stops for every candidate was
      // most of the time on a dense board, and changed nothing that was left off
      const tour = i === L && tour0.length > POLISH_LEFT_MAX ? tour0 : G.twoOpt(tour0, 3);
      final.push([i, tour]);
      delta += routeCost(i, tour) - cur[i];
    }
    if (delta + holeDelta(final) < -EPS_M) { commit(final); moves++; return true; }
    return false;
  };
  const routeOf = () => { const m = new Map<SolverStop, number>(); R.forEach((r, i) => r.tour.forEach((s) => m.set(s, i))); return m; };

  const pool = all.filter(movable);
  const nearest = new Map<SolverStop, SolverStop[]>();
  for (const s of pool) nearest.set(s, pool.filter((x) => x !== s).sort((a, b) => (dist(s, a) - dist(s, b)) || (a.id < b.id ? -1 : 1)).slice(0, SWAP_NEAREST));

  const costBeforeM = cost();

  const relocatePass = (): boolean => {
    let any = false;
    for (let x = 0; x < R.length && !spent(); x++) {
      for (const s of [...R[x].tour]) {
        if (!movable(s) || !R[x].tour.includes(s)) continue;
        for (let y = 0; y < R.length; y++) {
          if (y === x || !may(s, y) || !fitsLoad(y, plus(R[y].load, [s]))) continue;
          if (tryChange([[x, without(R[x].tour, [s])], [y, G.inserted(R[y].tour, s)]])) { any = true; break; }
        }
      }
    }
    return any;
  };

  const swapPass = (): boolean => {
    let any = false;
    for (let x = 0; x < R.length && !spent(); x++) {
      for (const s of [...R[x].tour]) {
        if (!movable(s) || !R[x].tour.includes(s)) continue;
        const where = routeOf();
        for (const t of nearest.get(s) || []) {
          const y = where.get(t);
          if (y === undefined || y === x) continue;
          if (!may(t, x) || !may(s, y) || !fitsLoad(x, plus(R[x].load, [t], [s])) || !fitsLoad(y, plus(R[y].load, [s], [t]))) continue;
          if (tryChange([[x, G.inserted(without(R[x].tour, [s]), t)], [y, G.inserted(without(R[y].tour, [t]), s)]])) { any = true; break; }
        }
      }
    }
    return any;
  };

  // A left-off stop a full truck A could take if A handed one of its stops to truck B with room.
  const ejectPass = (): boolean => {
    let any = false;
    for (const l of [...R[L].tour]) {
      if (spent()) break;
      if (!movable(l) || !R[L].tour.includes(l)) continue;
      let done = false;
      for (let a = 0; a < L && !done; a++) {
        if (!may(l, a) || fitsLoad(a, plus(R[a].load, [l]))) continue;
        for (const e of [...R[a].tour]) {
          if (done) break;
          if (!movable(e) || !fitsLoad(a, plus(R[a].load, [l], [e]))) continue;
          for (let b = 0; b < L; b++) {
            if (b === a || !may(e, b) || !fitsLoad(b, plus(R[b].load, [e]))) continue;
            if (tryChange([[a, G.inserted(without(R[a].tour, [e]), l)], [b, G.inserted(R[b].tour, e)], [L, without(R[L].tour, [l])]])) { any = true; done = true; break; }
          }
        }
      }
    }
    return any;
  };

  const subsets = <T,>(xs: T[], maxK: number): T[][] => {
    const out: T[][] = [];
    const rec = (start: number, cur: T[]) => {
      if (cur.length) out.push([...cur]);
      if (cur.length === maxK) return;
      for (let i = start; i < xs.length; i++) { cur.push(xs[i]); rec(i + 1, cur); cur.pop(); }
    };
    rec(0, []);
    return out;
  };

  // A left-off order of 2+ skids onto full truck A, in place of up to MANY of A's stops — the ones
  // cheapest to move onto the left-off group. (A 1-skid order for one stop out is a swap.)
  const manyForOnePass = (): boolean => {
    let any = false;
    for (const l of [...R[L].tour]) {
      if (spent()) break;
      if (!movable(l) || !R[L].tour.includes(l) || (l.skids || 0) < 2) continue;
      let done = false;
      for (let a = 0; a < L && !done; a++) {
        if (!may(l, a) || fitsLoad(a, plus(R[a].load, [l]))) continue;
        const restL = without(R[L].tour, [l]);
        const tourA = R[a].tour;
        const cand = tourA.filter(movable).map((e) => {
          const i = tourA.indexOf(e);
          const prev = i === 0 ? depot : tourA[i - 1], next = i === tourA.length - 1 ? depot : tourA[i + 1];
          const saving = dist(prev, e) + dist(e, next) - dist(prev, next);
          return { e, score: G.bestInsert(restL, e).cost - saving };
        }).sort((p, q) => (p.score - q.score) || (p.e.id < q.e.id ? -1 : 1)).slice(0, CANDIDATES).map((c) => c.e);
        for (const out of subsets(cand, MANY)) {
          // leaving off more than comes on is never worth it
          if (valueOf(out) > value(l) + 1e-9 || !fitsLoad(a, plus(R[a].load, [l], out))) continue;
          if (tryChange([[a, G.inserted(without(tourA, out), l)], [L, withAll(restL, out)]], true)) { any = true; done = true; break; }
          if (spent()) break;
        }
      }
    }
    return any;
  };

  // One stop off truck A onto the left-off group, for up to MANY left-off stops A then has room for.
  const oneForManyPass = (): boolean => {
    let any = false;
    for (let a = 0; a < L && !spent(); a++) {
      for (const e of [...R[a].tour]) {
        if (!movable(e) || !R[a].tour.includes(e)) continue;
        const na = without(R[a].tour, [e]);
        const cand = R[L].tour.filter((l) => movable(l) && may(l, a))
          .map((l) => ({ l, c: G.bestInsert(na, l).cost }))
          .sort((p, q) => (p.c - q.c) || (p.l.id < q.l.id ? -1 : 1)).slice(0, CANDIDATES).map((p) => p.l);
        let done = false;
        for (const ins of subsets(cand, MANY)) {
          if (ins.length < 2) continue;   // one-for-one is a swap
          if (valueOf(ins) + 1e-9 < value(e) || !fitsLoad(a, plus(R[a].load, ins, [e]))) continue;   // less on than off: never worth it
          if (tryChange([[a, withAll(na, ins)], [L, G.inserted(without(R[L].tour, ins), e)]], true)) { any = true; done = true; break; }
          if (spent()) break;
        }
        if (done || spent()) break;   // A's tour changed: start A over on the next pass
      }
    }
    return any;
  };

  // The areas of what is left off: stops chained within AREA_KM of each other.
  const areasOf = (stops: SolverStop[]): SolverStop[][] => {
    const seen = new Set<SolverStop>(), out: SolverStop[][] = [];
    for (const s0 of stops) {
      if (seen.has(s0)) continue;
      const comp: SolverStop[] = [], q = [s0];
      seen.add(s0);
      while (q.length) {
        const x = q.pop()!;
        comp.push(x);
        for (const y of stops) if (!seen.has(y) && dist(x, y) < AREA_KM * 1000) { seen.add(y); q.push(y); }
      }
      out.push(comp);
    }
    return out;
  };

  // A whole area of what is left off onto truck A; out of A, the stops nearest a seed, taken until
  // the area fits — a stop bigger than what is still needed is passed over while smaller ones remain
  // (giving up a 6-skid order to make room for 4 skids throws 2 away). Seeds: the rest of what is
  // left off nearest A's run, and A's stops nearest the rest of it — so what A gives up lands next
  // to what is already left off.
  const areaPass = (): boolean => {
    let any = false;
    // Areas are formed over everything left off, pinned stops too (what is left off gathers round
    // what no truck can carry), but only movable stops move.
    const comps = areasOf(R[L].tour);
    for (const comp of comps) {
      if (spent()) break;
      for (let a = 0; a < L; a++) {
        const ta = R[a].truck!;
        const takes = comp.filter((l) => movable(l) && may(l, a));
        if (!takes.length) continue;
        const rest = R[L].tour.filter((x) => !comp.includes(x));
        const mine = R[a].tour.filter(movable);
        const near = (from: SolverStop[], to: SolverStop[], k: number) => (to.length ? from
          .map((x) => ({ x, d: Math.min(...to.map((y) => dist(x, y))) }))
          .sort((p, q) => (p.d - q.d) || (p.x.id < q.x.id ? -1 : 1)).slice(0, k).map((p) => p.x) : []);
        // ...and A's stops FARTHEST from this area: with one area left off, A can take the whole of
        // it and hand over a far corner of its own run instead — one truck in each town, not two.
        const far = (from: SolverStop[], to: SolverStop[], k: number) => from
          .map((x) => ({ x, d: Math.min(...to.map((y) => dist(x, y))) }))
          .sort((p, q) => (q.d - p.d) || (p.x.id < q.x.id ? -1 : 1)).slice(0, k).map((p) => p.x);
        const seeds = [...new Set([...near(rest, mine, 5), ...near(mine, rest.length ? rest : comp, 5), ...far(mine, comp, 3)])];
        let done = false;
        for (const q of seeds) {
          const byNear = [...mine].sort((x, y) => (dist(q, x) - dist(q, y)) || (x.id < y.id ? -1 : 1));
          let out: SolverStop[] = [];
          const fitsNow = () => fitsLoad(a, plus(R[a].load, takes, out));
          for (const e of byNear) {
            if (fitsNow()) break;
            const need = plus(R[a].load, takes, out).skids - (ta.maxSkids || Infinity);
            if ((e.skids || 0) > need + 1e-9) continue;
            out = [...out, e];
          }
          for (const e of byNear) { if (fitsNow()) break; if (!out.includes(e)) out = [...out, e]; }
          if (!fitsNow() || valueOf(out) > valueOf(takes) + 1e-9) continue;   // never leave off more than comes on
          if (tryChange([[a, withAll(without(R[a].tour, out), takes)], [L, withAll(without(R[L].tour, takes), out)]], true)) { any = true; done = true; break; }
          if (spent()) break;
        }
        if (done) break;
      }
    }
    return any;
  };

  // MAKE ROOM: a left-off stop that a full truck A may carry, when A could hand stops someone else
  // may carry to the trucks with room — through one more truck if that one is full too. Green
  // freight on the box while box-only freight is left off and the tractors have room is exactly this
  // (Chad, 09-30: "still left orders off the loads that only one was full"); one stop moved at a
  // time never gets there, because the first move alone gains nothing. The whole chain is scored
  // as one change.
  const tourIn = (w: Map<number, SolverStop[]>, i: number) => w.get(i) ?? R[i].tour;
  const fitsIn = (w: Map<number, SolverStop[]>, i: number) => fitsLoad(i, computeLoad(tourIn(w, i)));
  // Put `add` on truck a in plan w, then hand a's other stops to trucks outside `chain` until a
  // fits; a stop that fits nowhere outright may make room the same way `depth` trucks further on.
  // `spill`, on the first truck only: a stop that fits nowhere else may go on the left-off run instead
  // (six box-only skids on the box for six green ones, when the tractors have room for five).
  const makeRoom = (w: Map<number, SolverStop[]>, a: number, add: SolverStop[], depth: number, chain: Set<number>, fixed: Set<SolverStop>, byBig: boolean, spill: SolverStop[] | null): boolean => {
    w.set(a, withAll(tourIn(w, a), add));
    for (const x of add) fixed.add(x);
    if (fitsIn(w, a)) return true;
    const ta = tourIn(w, a);
    const cands = ta.filter((e) => movable(e) && !fixed.has(e)).map((e) => {
      const i = ta.indexOf(e);
      const prev = i === 0 ? depot : ta[i - 1], next = i === ta.length - 1 ? depot : ta[i + 1];
      const saving = dist(prev, e) + dist(e, next) - dist(prev, next);
      let best = Infinity;
      for (let b = 0; b < L; b++) if (!chain.has(b) && may(e, b)) best = Math.min(best, G.bestInsert(tourIn(w, b), e).cost);
      return { e, score: best - saving };
    }).filter((c) => c.score < Infinity)
      .sort((p, q) => (byBig ? (q.e.skids || 0) - (p.e.skids || 0) : 0) || (p.score - q.score) || (p.e.id < q.e.id ? -1 : 1))
      .slice(0, CANDIDATES);
    for (const { e } of cands) {
      if (fitsIn(w, a)) break;
      const targets = [];
      for (let b = 0; b < L; b++) if (!chain.has(b) && may(e, b)) targets.push({ b, c: G.bestInsert(tourIn(w, b), e).cost });
      targets.sort((p, q) => (p.c - q.c) || (p.b - q.b));
      let placed = false;
      for (const { b } of targets) {
        if (!fitsLoad(b, plus(computeLoad(tourIn(w, b)), [e]))) continue;
        w.set(b, G.inserted(tourIn(w, b), e));
        placed = true;
        break;
      }
      if (!placed && depth > 0) {
        for (const { b } of targets) {
          const w2 = new Map(w), f2 = new Set(fixed);
          w2.set(a, without(tourIn(w2, a), [e]));
          if (makeRoom(w2, b, [e], depth - 1, new Set([...chain, b]), f2, byBig, null)) {
            for (const [k, v] of w2) w.set(k, v);
            for (const x of f2) fixed.add(x);
            placed = true;
            break;
          }
        }
      }
      if (!placed && spill) { spill.push(e); placed = true; }
      if (placed) { w.set(a, without(tourIn(w, a), [e])); fixed.add(e); }
    }
    return fitsIn(w, a);
  };
  const makeRoomPass = (): boolean => {
    let any = false;
    const order = [...R[L].tour].filter(movable).sort((x, y) => ((y.skids || 0) - (x.skids || 0)) || (x.id < y.id ? -1 : 1));
    for (const l of order) {
      if (spent()) break;
      if (!R[L].tour.includes(l)) continue;
      let done = false;
      for (let a = 0; a < L && !done; a++) {
        if (!may(l, a) || fitsLoad(a, plus(R[a].load, [l]))) continue;
        for (const byBig of [false, true]) {
          const w = new Map<number, SolverStop[]>(), spill: SolverStop[] = [];
          if (!makeRoom(w, a, [l], 1, new Set([a]), new Set(), byBig, spill)) continue;
          if (valueOf(spill) >= value(l)) continue;   // never leave off as much as comes on
          const changes: Array<[number, SolverStop[]]> = [...w.entries()];
          changes.push([L, withAll(without(R[L].tour, [l]), spill)]);
          if (tryChange(changes, true)) { any = true; done = true; break; }
          if (spent()) break;
        }
      }
    }
    return any;
  };

  for (let pass = 0; pass < 200 && !spent(); pass++) {
    let improved = false;
    improved = relocatePass() || improved;
    improved = swapPass() || improved;
    improved = ejectPass() || improved;
    improved = areaPass() || improved;
    // the group exchanges and the chains are the expensive moves: only when nothing simpler is left
    // (the search still ends only when no move of any kind improves)
    if (!improved) improved = manyForOnePass() || improved;
    if (!improved) improved = oneForManyPass() || improved;
    if (!improved) improved = makeRoomPass();
    if (!improved) break;
  }

  const outMap = new Map<string, SolverStop[]>();
  for (let i = 0; i < L; i++) outMap.set(R[i].truck!.id, R[i].tour);
  return {
    byTruck: outMap,
    leftOff: R[L].tour.filter(movable),
    moves,
    evals,
    capped: spent(),
    costBeforeM,
    costAfterM: cost(),
    leftOffTourM: G.tourLen(R[L].tour),
    leftOffAreas: areaCount(R[L].tour),
  };
}
