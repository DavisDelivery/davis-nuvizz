// lib/routing-assign-ends.mts
//
// WHEN THE TRUCKS ARE FULL, WHAT COMES OFF IS THE END OF A ROUTE — NEVER A HOLE IN THE MIDDLE.
//
// Chad, 2026-09-29, after v1.86.0 made a truck stop at what it can carry: "has to be logic to both
// tractor and box truck being full can't just take random stops till it's full has to be route of
// some kind. Can't have the middle of the selection not being routed to where 2 trucks may end up
// next door because the system thought the one was full so it just left a neighbor off. Basically
// the routes need to be optimized and things left off the beginning or end".
//
// What routing-solver's assign did, measured on the real pipeline before this existed:
//   • Any stop with an equipment rule — with "only green on a 53′" ticked, EVERY stop that is not
//     green — was placed first, BIGGEST first, on whichever capable truck had the most room, with
//     no regard to where it was. So a 14-skid box filled with the 2- and 3-skid stops and the
//     1-skid stops it drove straight past were the ones left off: on the CHE/SCOTT board every
//     one of the six stops left off cost SCOTT 0.1–2.7 km to add. Two boxes both ran both towns.
//   • The rest grew each truck's ground outward from a far seed until capacity said stop, and
//     whatever had not been reached by then was left off — the stops between the trucks' ground,
//     or at the dock end of one while another truck reached back past it.
//
// So, here:
//   1. Every stop is placed by WHERE IT IS — onto the truck whose ground it is nearest (with the
//      same balance term the solver uses, so one truck is not filled while another sits empty).
//      Stops only SOME trucks can take are placed before stops any truck can take — a preference,
//      not a promise: it routes a little more freight (measured), but when a full truck has to give
//      stops up, the rule below decides, even if a green stop it drives past stays on and a
//      box-only stop at the end of its run comes off. Equipment and capacity stay hard, exactly as
//      before (truckCanCarry / capacityFits).
//   2. A stop that did not fit belongs to the truck whose ground it is nearest. That truck first
//      hands any stop another truck can carry to a truck with room; then, if it still has more
//      than it holds, stops come off the BEGINNING or the END of its run — never one in between —
//      one at a time, and of the two ends the one that costs it more driving goes first (a far
//      outlier before a dense run it passes through).
//   3. Where two trucks' ground meets, they swap stops that sit nearer the other's middle, so one
//      does not reach back past the other's stops.
//   4. Room left on a truck is filled with stops that came off, but only ones that cost it no more
//      driving than its average stop — never a trip across town for one skid. And a stop left off
//      that a truck able to carry it drives past goes on that truck — straight on if it has room,
//      else in exchange for stops off the beginning or end of its run, never for fewer skids.
//   5. What is left is listed with the reason, as before ("over skid capacity").
//
// Measured (scratch harness, the real pipeline, 400 random overloaded boards of 1–4 trucks, green
// rule on and off, both routing strategies): stops left off in the middle of a truck's run fell
// from 2,380 to the figure in the PR; skids routed never fell on any board; miles fell overall.
//
// Behind ROUTING_BUILD_LEAVE_OFF_ENDS (lib/routing-build-rules.mts): off puts the old assignment
// back exactly. Pure. No I/O.

import type { SolverStop, SolverTruck, UnassignedStop } from './routing-types.mts';
import {
  truckCanCarry, capacityFits, capacityBreaches, loadFraction, emptyLoad, addLoad, computeLoad, REASON,
} from './routing-constraints.mts';

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export interface EndsAssignment {
  byTruck: Map<string, SolverStop[]>;
  unassigned: UnassignedStop[];
  /** Stops a full truck gave up (the costliest to serve) that no other truck had room for. */
  leftOffAtEnds: string[];
  /** Stops moved off a full truck onto another truck that could carry them and had room. */
  movedToRoom: Array<{ stopId: string; from: string; to: string }>;
}

// `runOrder` puts one truck's stops in the order that truck will drive them (routing-solver passes
// its own sequencing, per strategy, on the real matrix). Absent → farthest from the dock first.
export function assignLeavingOffEnds(
  stops: SolverStop[], trucks: SolverTruck[], depot: { lat: number; lng: number },
  runOrder?: (stops: SolverStop[]) => SolverStop[],
): EndsAssignment {
  const byTruck = new Map<string, SolverStop[]>();
  const loadOf = new Map<string, ReturnType<typeof emptyLoad>>();
  for (const t of trucks) { byTruck.set(t.id, []); loadOf.set(t.id, emptyLoad()); }
  const unassigned: UnassignedStop[] = [];
  const movedToRoom: EndsAssignment['movedToRoom'] = [];
  const truckOrder = new Map(trucks.map((t, i) => [t.id, i] as const));

  const place = (s: SolverStop, t: SolverTruck) => {
    byTruck.get(t.id)!.push(s);
    loadOf.set(t.id, addLoad(loadOf.get(t.id)!, s));
  };
  const setStops = (t: SolverTruck, list: SolverStop[]) => {
    byTruck.set(t.id, list);
    loadOf.set(t.id, computeLoad(list));
  };
  const fromDock = new Map(stops.map((s) => [s.id, haversineM(s, depot)] as const));
  const farthestFirst = (a: SolverStop, b: SolverStop) => (fromDock.get(b.id)! - fromDock.get(a.id)!) || (a.id < b.id ? -1 : 1);
  const order = runOrder || ((list: SolverStop[]) => [...list].sort(farthestFirst));
  const capableOf = new Map(stops.map((s) => [s.id, trucks.filter((t) => truckCanCarry(s, t).ok)] as const));
  const fits = (s: SolverStop, t: SolverTruck) =>
    capableOf.get(s.id)!.includes(t) && capacityFits(loadOf.get(t.id)!, s, t).ok;
  const distToTruck = (s: SolverStop, t: SolverTruck): number => {
    const terr = byTruck.get(t.id)!;
    if (!terr.length) return fromDock.get(s.id)!;
    let best = Infinity;
    for (const x of terr) { if (x === s) continue; const d = haversineM(s, x); if (d < best) best = d; }
    return best === Infinity ? fromDock.get(s.id)! : best;
  };
  // The same balance term as routing-solver's assign (see its comment): one full truck is worth
  // BALANCE_M of detour, so a stop goes to a nearer truck over an emptier one for any realistic
  // in-town gap, and a big truck is not left following the small ones around.
  const BALANCE_M = Number(process.env.ROUTING_BALANCE_METRES) || 12000;
  const cost = (s: SolverStop, t: SolverTruck) => distToTruck(s, t) + BALANCE_M * loadFraction(loadOf.get(t.id)!, t);
  const spillCapacity = (s: SolverStop) => {
    const capable = capableOf.get(s.id)!;
    const roomiest = capable.reduce((p, c) =>
      (c.maxSkids - loadOf.get(c.id)!.skids) > (p.maxSkids - loadOf.get(p.id)!.skids) ? c : p);
    unassigned.push({ stopId: s.id, reasons: capacityFits(loadOf.get(roomiest.id)!, s, roomiest).reasons });
  };

  // ── 0. A stop no selected truck can EVER carry is listed with why, as before. ──
  const pool: SolverStop[] = [];
  for (const s of stops) {
    if (capableOf.get(s.id)!.length) { pool.push(s); continue; }
    const reasons = new Set<string>();
    for (const t of trucks) for (const r of truckCanCarry(s, t).reasons) reasons.add(r);
    unassigned.push({ stopId: s.id, reasons: [REASON.noTruckFits, ...reasons] });
  }

  // ── 1a. One seed per truck, spread out (farthest-point from the dock and from the seeds
  //    already chosen), and always a stop THAT truck can take. ──
  const seeds: SolverStop[] = [];
  for (const t of trucks) {
    let best: SolverStop | null = null, bestScore = -1;
    for (const s of pool) {
      if (!fits(s, t)) continue;
      let score = fromDock.get(s.id)!;
      for (const x of seeds) score = Math.min(score, haversineM(s, x));
      if (score > bestScore || (score === bestScore && best && s.id < best.id)) { bestScore = score; best = s; }
    }
    if (!best) continue;
    seeds.push(best);
    place(best, t);
    pool.splice(pool.indexOf(best), 1);
  }

  // ── 1b. Grow each truck's ground, one nearest stop at a time. Stops only some trucks can take
  //    go first; capacity is a hard stop. ──
  const tier = (s: SolverStop) => (capableOf.get(s.id)!.length < trucks.length ? 0 : 1);
  const maxIters = pool.length + 5;
  let guard = 0;
  while (pool.length && guard++ < maxIters) {
    let bs: SolverStop | null = null, bt: SolverTruck | null = null, bTier = 2, bCost = Infinity;
    for (const s of pool) {
      const ti = tier(s);
      if (ti > bTier) continue;
      for (const t of capableOf.get(s.id)!) {
        if (!fits(s, t)) continue;
        const c = cost(s, t);
        if (ti < bTier || c < bCost || (c === bCost && bs && s.id < bs.id)) { bs = s; bt = t; bTier = ti; bCost = c; }
      }
    }
    if (!bs) break;
    place(bs, bt!);
    pool.splice(pool.indexOf(bs), 1);
  }

  // ── 2. Each stop that did not fit is claimed by the capable truck whose ground it is nearest. ──
  const claims = new Map<string, SolverStop[]>();
  for (const u of [...pool].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    let home: SolverTruck | null = null, hd = Infinity;
    for (const t of capableOf.get(u.id)!) {
      const d = distToTruck(u, t);
      if (d < hd || (d === hd && home && truckOrder.get(t.id)! < truckOrder.get(home.id)!)) { hd = d; home = t; }
    }
    if (!home) continue;   // cannot happen: every stop left in the pool has a capable truck
    (claims.get(home.id) ?? claims.set(home.id, []).get(home.id)!).push(u);
  }

  // ── 3. Every truck takes on everything in its ground at once, so each one's real demand is
  //    known before anything moves. ──
  for (const t of trucks) {
    const claimed = claims.get(t.id);
    if (claimed) setStops(t, [...byTruck.get(t.id)!, ...claimed]);
  }
  const over = (t: SolverTruck) => capacityBreaches(loadOf.get(t.id)!, t).length > 0;
  // What each stop costs the run it is on: the detour to reach it, dock to dock. A far outlier
  // costs a lot; a stop the truck drives past costs ~0.
  const savings = (run: SolverStop[]) => run.map((x, i) => {
    const prev = i === 0 ? depot : run[i - 1], next = i === run.length - 1 ? depot : run[i + 1];
    return haversineM(prev, x) + haversineM(x, next) - haversineM(prev, next);
  });
  // Which END of the run comes off: the first stop or the last, whichever costs the truck more
  // driving (a far outlier before a dense run it passes through). Never a stop in between.
  const costlierEnd = (run: SolverStop[]) => {
    if (run.length < 2) return 0;
    const sv = savings(run), last = run.length - 1;
    if (Math.abs(sv[0] - sv[last]) > 1e-6) return sv[0] > sv[last] ? 0 : last;
    return farthestFirst(run[0], run[last]) <= 0 ? 0 : last;
  };

  // ── 4. A stop on a truck with more than it holds that ANOTHER truck can carry and has room for
  //    (after that truck's own freight) goes there, nearest ground first — freight a trailer could
  //    take never pushes box-only freight off a box. ──
  for (let guard2 = 0; guard2 < stops.length + 5; guard2++) {
    let mv: SolverStop | null = null, from: SolverTruck | null = null, to: SolverTruck | null = null, mc = Infinity;
    for (const t of trucks) {
      if (!over(t)) continue;
      for (const s of byTruck.get(t.id)!) {
        for (const y of capableOf.get(s.id)!) {
          if (y === t || over(y) || !capacityFits(loadOf.get(y.id)!, s, y).ok) continue;
          const c = cost(s, y);
          if (c < mc || (c === mc && mv && s.id < mv.id)) { mc = c; mv = s; from = t; to = y; }
        }
      }
    }
    if (!mv) break;
    setStops(from!, byTruck.get(from!.id)!.filter((x) => x !== mv));
    place(mv, to!);
    movedToRoom.push({ stopId: mv.id, from: from!.id, to: to!.id });
  }

  // ── 5. Still more than it holds: in the order the truck will drive them, a stop comes off the
  //    BEGINNING or the END of the run — whichever of the two costs the truck more driving — one at
  //    a time, until it fits. Never a stop between two it keeps. ──
  const shedBy = new Map<string, string>();
  const cameOff: SolverStop[] = [];
  for (const t of trucks) {
    if (!over(t)) continue;
    let mine = [...byTruck.get(t.id)!];
    while (mine.length && capacityBreaches(computeLoad(mine), t).length) {
      const run = order(mine);
      const off = run[costlierEnd(run)];
      cameOff.push(off);
      shedBy.set(off.id, t.id);
      mine = run.filter((x) => x !== off);
    }
    setStops(t, mine);
  }

  // ── 6. THE SEAM. Two trucks swap a stop each when each stop sits nearer the middle of the other
  //    truck's ground than its own — so one truck does not reach back past another's stops to the
  //    ones it grew into last. Swaps only (loads stay what capacity allowed), equipment and
  //    capacity hard, and only a swap that shortens the total by more than SEAM_MIN_M. ──
  const SEAM_MIN_M = 200;
  const centre = (t: SolverTruck) => {
    const list = byTruck.get(t.id)!;
    return list.length ? { lat: list.reduce((q, x) => q + x.lat, 0) / list.length, lng: list.reduce((q, x) => q + x.lng, 0) / list.length } : null;
  };
  for (let pass = 0; pass < 4 * stops.length + 10; pass++) {
    let best: { a: SolverStop; b: SolverStop; A: SolverTruck; B: SolverTruck; gain: number } | null = null;
    for (let i = 0; i < trucks.length; i++) {
      for (let j = i + 1; j < trucks.length; j++) {
        const A = trucks[i], B = trucks[j];
        const cA = centre(A), cB = centre(B);
        if (!cA || !cB) continue;
        for (const a of byTruck.get(A.id)!) {
          if (!capableOf.get(a.id)!.includes(B)) continue;
          const keepA = haversineM(a, cA) - haversineM(a, cB);
          if (keepA <= 0) continue;   // a is not nearer B's middle: no swap involving a can help
          for (const b of byTruck.get(B.id)!) {
            if (!capableOf.get(b.id)!.includes(A)) continue;
            const keepB = haversineM(b, cB) - haversineM(b, cA);
            if (keepB <= 0) continue;   // each stop must sit nearer the other truck's middle
            const gain = keepA + keepB;
            if (gain <= SEAM_MIN_M || (best && gain <= best.gain)) continue;
            const loadA = addLoad(computeLoad(byTruck.get(A.id)!.filter((x) => x !== a)), b);
            const loadB = addLoad(computeLoad(byTruck.get(B.id)!.filter((x) => x !== b)), a);
            if (capacityBreaches(loadA, A).length || capacityBreaches(loadB, B).length) continue;
            best = { a, b, A, B, gain };
          }
        }
      }
    }
    if (!best) break;
    setStops(best.A, [...byTruck.get(best.A.id)!.filter((x) => x !== best!.a), best.b]);
    setStops(best.B, [...byTruck.get(best.B.id)!.filter((x) => x !== best!.b), best.a]);
  }

  // ── 7. FILL THE ROOM THAT IS LEFT — but not by sending a truck across town. What came off goes
  //    on a truck that can carry it and has room (the one that shed it included: shedding a big stop
  //    can free room for a small one shed before it) only when adding it costs no more driving than
  //    the average stop already on that truck. A stop a few minutes away goes on; one skid 25 km
  //    into another truck's town does not — measured: re-offering to "any truck with room" sent a
  //    box there and made a hole in its own town. Cheapest first; repeated until nothing fits. ──
  const leftOffAtEnds: string[] = [];
  const leftOff: SolverStop[] = [...cameOff].sort(farthestFirst);
  const runLength = (run: SolverStop[]) => {
    let m = 0, prev: { lat: number; lng: number } = depot;
    for (const x of run) { m += haversineM(prev, x); prev = x; }
    return m + haversineM(prev, depot);
  };
  const cheapestInsert = (L: SolverStop, run: SolverStop[]) => {
    const pts = [depot, ...run, depot];
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, haversineM(pts[i], L) + haversineM(L, pts[i + 1]) - haversineM(pts[i], pts[i + 1]));
    return best;
  };
  for (let guard3 = 0; guard3 < stops.length + 5 && leftOff.length; guard3++) {
    let pick: { L: SolverStop; T: SolverTruck; c: number } | null = null;
    for (const L of leftOff) {
      for (const T of capableOf.get(L.id)!) {
        if (!fits(L, T)) continue;
        const run = order(byTruck.get(T.id)!);
        if (!run.length) continue;
        const c = cheapestInsert(L, run);
        if (c > runLength(run) / run.length) continue;   // costs more than an average stop on this truck
        if (!pick || c < pick.c || (c === pick.c && L.id < pick.L.id)) pick = { L, T, c };
      }
    }
    if (!pick) break;
    place(pick.L, pick.T);
    leftOff.splice(leftOff.indexOf(pick.L), 1);
  }

  // ── 9. NO HOLES. A stop still left off that a truck able to carry it DRIVES PAST — its cheapest
  //    place in that truck's run is between two of its stops, less than ON_THE_WAY_M out of the
  //    way — goes on that truck: straight on when it has room, otherwise in exchange for stops off
  //    the beginning or end of that run (the costlier end first), so what is left off is an end,
  //    not a neighbour. Never for fewer skids; and a stop a truck gave up here is never put back on
  //    it, so this settles. ──
  const ON_THE_WAY_M = 3000;
  const gaveUp = new Set<string>();   // `${stopId}|${truckId}`
  const placeInRun = (L: SolverStop, run: SolverStop[]) => {
    let best = Infinity, interior = false;
    const pts = [depot, ...run, depot];
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = haversineM(pts[i], L) + haversineM(L, pts[i + 1]) - haversineM(pts[i], pts[i + 1]);
      if (d < best) { best = d; interior = i > 0 && i + 1 < pts.length - 1; }
    }
    return { cost: best, interior };
  };
  for (let pass = 0; pass < 20 * stops.length + 50; pass++) {
    let changed = false;
    for (const L of [...leftOff].sort(farthestFirst)) {
      for (const T of capableOf.get(L.id)!) {
        if (gaveUp.has(`${L.id}|${T.id}`)) continue;
        const run = order(byTruck.get(T.id)!);
        if (run.length < 2) continue;
        const where = placeInRun(L, run);
        if (!where.interior || where.cost >= ON_THE_WAY_M) continue;
        if (fits(L, T)) {
          setStops(T, [...run, L]);
        } else {
          // Which ends come off: up to END_TRIES from the start and END_TRIES from the end, the
          // combination that lets L on, trades away no more skids than L brings, keeps the truck
          // fullest, and of those saves the most driving.
          const END_TRIES = 4;
          let bestCut: { k: number; m: number; skids: number; saved: number } | null = null;
          for (let k = 0; k <= Math.min(END_TRIES, run.length); k++) {
            for (let m = 0; m <= Math.min(END_TRIES, run.length - k); m++) {
              if (k + m === 0) continue;
              const cut = [...run.slice(0, k), ...run.slice(run.length - m)];
              const keep = run.slice(k, run.length - m);
              if (capacityBreaches(addLoad(computeLoad(keep), L), T).length) continue;
              const sk = computeLoad(cut).skids;
              if (sk > (L.skids || 0)) continue;   // never trade skids away
              const saved = runLength(run) - runLength(keep);
              if (!bestCut || sk < bestCut.skids || (sk === bestCut.skids && saved > bestCut.saved)) bestCut = { k, m, skids: sk, saved };
            }
          }
          if (!bestCut) continue;
          const removed = [...run.slice(0, bestCut.k), ...run.slice(run.length - bestCut.m)];
          const kept = run.slice(bestCut.k, run.length - bestCut.m);
          setStops(T, [...kept, L]);
          for (const r of removed) { leftOff.push(r); gaveUp.add(`${r.id}|${T.id}`); }
        }
        leftOff.splice(leftOff.indexOf(L), 1);
        changed = true;
        break;
      }
      if (changed) break;
    }
    if (!changed) break;
  }
  for (const s of leftOff) { spillCapacity(s); leftOffAtEnds.push(s.id); }

  return { byTruck, unassigned, leftOffAtEnds, movedToRoom };
}
