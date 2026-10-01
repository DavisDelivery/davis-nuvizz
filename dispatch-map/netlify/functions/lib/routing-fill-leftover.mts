// lib/routing-fill-leftover.mts
//
// WHEN THE TRUCKS CANNOT CARRY EVERYTHING: FILL THEM, AND WHAT IS LEFT OFF IS ONE GROUP — THE RUN
// ONE MORE TRUCK WOULD MAKE.
//
// Chad, 2026-09-30, on a Build onto CHE, SCOTT and TRAILER 1 (v1.100.0): "worked better but still
// left orders off the loads that only one was full and didn't have any logic to how it left them
// off they were orders scattered across 3 towns so i would have sent an additional truck to cover
// this". Before that, 2026-09-28: "a 14 skid box truck stops with 14 skids", and 2026-09-29: "can't
// just take random stops till it's full has to be route of some kind … things left off the
// beginning or end".
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
// send — and the plan is settled by local search on one cost, in metres:
//
//     the driving of every selected truck, dock to dock
//   + the driving of that one more truck, dock to dock, through everything left off
//     (three towns cost far more than one, so what is left off pulls together into one area)
//   + VALUE_KM_PER_SKID for every skid left off (a loose-only order counts as one skid; weight is a
//     tie-break, LBS_PER_SKID_VALUE pounds ≈ one skid), so a truck with room takes what it can
//     carry before anything is left off
//
// Moves, all under the hard rules (equipment and capacity, exactly as truckCanCarry / capacityFits):
//   relocate   one stop to another truck, or onto or off the left-off group
//   swap       two stops between trucks, or between a truck and the left-off group
//   eject      a stop a full truck hands to another truck with room, so a left-off stop fits
//   many-for-1 a left-off order of 2+ skids onto a full truck in place of up to MANY of its stops
//              (skids are whole: a 6-skid order for five 1-skid ones, so the truck ends at 14, not 13)
//   1-for-many one stop off a truck for up to MANY left-off stops it then has room for
//   area       a whole AREA of what is left off onto a truck, for the truck's stops nearest the rest
//              of what is left off — the move that turns "Dalton and one in White" into "five in
//              Cartersville": no single-stop move gets there, because one Dalton stop alone is worth
//              less than the drive, and the drive is only saved when the whole area moves
// Every accepted move lowers the cost by at least EPS_M, so the search ends; MAX_EVALS bounds the
// work (deterministically — a count, never a clock) and the result says if it was reached.
//
// Only runs when something is left off; a board that fits is planned exactly as before. Behind
// ROUTING_BUILD_FILL_TRUCKS (lib/routing-build-rules.mts). Pure. No I/O. Deterministic.

import type { SolverStop, SolverTruck, RouteLoad } from './routing-types.mts';
import { truckCanCarry, capacityBreaches, computeLoad } from './routing-constraints.mts';

type Pt = { lat: number; lng: number };
type Dist = (a: Pt, b: Pt) => number;

function hav(a: Pt, b: Pt): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const FILL_RULE = Object.freeze({
  /** What one skid left off is worth, in km of driving. Large on purpose: a truck with room takes
   *  what it can carry ("a 14 skid box truck stops with 14 skids"). */
  VALUE_KM_PER_SKID: 250,
  /** Weight is a LIMIT first (capacityFits) and only a tie-break in value: this many pounds is
   *  worth one skid. Measured: at 2,000 lb a skid, 642 lb outweighed a 53 km saving on Chad's board
   *  and kept what was left off in two towns; Davis plans by skids. */
  LBS_PER_SKID_VALUE: 20000,
  /** Largest group exchanged in one move (many-for-1, 1-for-many). */
  MANY: 5,
  /** Candidates considered for a group exchange. */
  CANDIDATES: 8,
  /** Swap partners considered per stop (nearest first). */
  SWAP_NEAREST: 12,
  /** Left-off stops chained within this many km of each other are one AREA. */
  AREA_KM: 15,
  /** A group move is straightened (2-opt) before it is judged only when it is within this many km
   *  of winning as inserted. */
  POLISH_KM: 40,
  /** Work bound: candidate moves scored. Measured on 150-stop boards at twice what the trucks hold. */
  MAX_EVALS: 200000,
  EPS_M: 1,
});

// Tour arithmetic over a distance function: haversine for the exported helpers, a table inside
// settleLeftOff (built once per Build, so the search does lookups, not trigonometry).
function geometry(d: Dist, depot: Pt) {
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
  const twoOpt = (t: SolverStop[], maxPasses = 60): SolverStop[] => {
    if (t.length < 3) return t;
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
}

/**
 * Settle a plan whose trucks could not carry everything. `byTruck` and `leftOff` are the ends
 * rule's answer; `pinned` are stops no selected truck can ever carry (they ride the one-more-truck
 * run too, so what else is left off groups with them, but they never move).
 */
export function settleLeftOff(
  byTruck: Map<string, SolverStop[]>, leftOff: SolverStop[], trucks: SolverTruck[], depot: Pt,
  pinned: SolverStop[] = [],
): SettleResult {
  const { VALUE_KM_PER_SKID, LBS_PER_SKID_VALUE, MANY, CANDIDATES, SWAP_NEAREST, AREA_KM, POLISH_KM, MAX_EVALS, EPS_M } = FILL_RULE;
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
  const G = geometry(dist, depot);

  const value = (s: SolverStop) => VALUE_KM_PER_SKID * 1000 * (Math.max(s.skids || 0, 1) + (s.weightLbs || 0) / LBS_PER_SKID_VALUE);
  const pinnedIds = new Set(pinned.map((s) => s.id));
  const movable = (s: SolverStop) => !pinnedIds.has(s.id);
  const sk = (xs: SolverStop[]) => xs.reduce((a, x) => a + (x.skids || 0), 0);
  const capable = new Map<string, Set<string>>();
  for (const s of all) capable.set(s.id, new Set(trucks.filter((t) => truckCanCarry(s, t).ok).map((t) => t.id)));

  const R: Route[] = trucks.map((t) => ({ truck: t, tour: G.tourThrough(byTruck.get(t.id) || []), load: computeLoad(byTruck.get(t.id) || []) }));
  const L = R.length;   // the left-off group
  R.push({ truck: null, tour: G.tourThrough([...leftOff, ...pinned]), load: computeLoad([]) });

  const routeCost = (i: number, tour: SolverStop[]) =>
    G.tourLen(tour) + (i === L ? tour.reduce((a, s) => a + value(s), 0) : 0);
  const cost = () => R.reduce((a, r, i) => a + routeCost(i, r.tour), 0);
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
  const commit = (changes: Array<[number, SolverStop[]]>) => {
    for (const [i, tour] of changes) { R[i].tour = G.twoOpt(tour); R[i].load = computeLoad(R[i].tour); }
  };

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
      raw += routeCost(i, tour) - routeCost(i, R[i].tour);
    }
    if (raw < -EPS_M) { commit(changes); moves++; return true; }
    if (!polish || raw > POLISH_KM * 1000) return false;
    let delta = 0;
    const final: Array<[number, SolverStop[]]> = [];
    for (const [i, tour0] of changes) {
      const tour = G.twoOpt(tour0, 3);
      final.push([i, tour]);
      delta += routeCost(i, tour) - routeCost(i, R[i].tour);
    }
    if (delta < -EPS_M) { commit(final); moves++; return true; }
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
          // giving up more skids than come on loses VALUE_KM_PER_SKID a skid — never worth it
          if (sk(out) > sk([l]) + 1e-9 || !fitsLoad(a, plus(R[a].load, [l], out))) continue;
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
          if (sk(ins) + 1e-9 < sk([e]) || !fitsLoad(a, plus(R[a].load, ins, [e]))) continue;   // fewer skids on than off: never worth it
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
    const comps = areasOf(R[L].tour.filter(movable));
    if (comps.length < 2) return false;
    for (const comp of comps) {
      if (spent()) break;
      for (let a = 0; a < L; a++) {
        const ta = R[a].truck!;
        const takes = comp.filter((l) => may(l, a));
        if (!takes.length) continue;
        const rest = R[L].tour.filter((x) => !comp.includes(x));
        const mine = R[a].tour.filter(movable);
        const near = (from: SolverStop[], to: SolverStop[], k: number) => (to.length ? from
          .map((x) => ({ x, d: Math.min(...to.map((y) => dist(x, y))) }))
          .sort((p, q) => (p.d - q.d) || (p.x.id < q.x.id ? -1 : 1)).slice(0, k).map((p) => p.x) : []);
        const seeds = [...near(rest, mine, 5), ...near(mine, rest.length ? rest : comp, 5)];
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
          if (!fitsNow() || sk(out) > sk(takes) + 1e-9) continue;   // never give up more skids than come on
          if (tryChange([[a, withAll(without(R[a].tour, out), takes)], [L, withAll(without(R[L].tour, takes), out)]], true)) { any = true; done = true; break; }
          if (spent()) break;
        }
        if (done) break;
      }
    }
    return any;
  };

  for (let pass = 0; pass < 200 && !spent(); pass++) {
    let improved = false;
    improved = relocatePass() || improved;
    improved = swapPass() || improved;
    improved = ejectPass() || improved;
    improved = manyForOnePass() || improved;
    improved = oneForManyPass() || improved;
    improved = areaPass() || improved;
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
  };
}
