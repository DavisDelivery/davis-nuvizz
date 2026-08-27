// lib/routing-cleanup-core.mts
//
// END-OF-NIGHT CLEANUP — Chad's own description of the job: "at end of night
// when I'm just planning the extra box truck loads — give it 5 empties and let
// it route the leftover unplanned stops on them."
//
// This is the OPPOSITE POSTURE from the driver-scoped draft next door. That one
// is conservative on purpose: it claims only the freight a named driver's own
// history supports and hands the rest back. Cleanup mode's whole job is to make
// the leftovers GO SOMEWHERE — and leftovers are, by construction, the freight
// that did NOT fit anybody's pattern, so habit and territory are weak here and
// GEOGRAPHY AND CAPACITY do the work. Concretely that means: no candidate
// pre-filter (every truck may take every stop it can physically carry), and the
// honest output is not "whose is this?" but "did it fit, and if not, what is
// left over?"
//
// WHAT A "TRUCK" IS HERE. The dispatcher picks LOAD SHELLS, not drivers, and an
// empty shell has no driver to learn from — the roster carries no driver column
// and a load with no stops has no board rows to read one off. So a truck is
// bounded by what CHAD says it holds (the vehicle profile he maintains) rather
// than by a learned envelope, and the driver is picked per card after staging.
// The profile is applied as a cap_override, which can only ever TIGHTEN the
// class bound — a box shell rated 14 skids is loaded to 14, not to the fleet's
// p95 of 22, which is the number the per-driver phase exists to stop applying to
// everyone. When a shell DOES already hold board stops, its driver is known and
// their real envelope, affinity and zone ownership come along for free.
//
// ONE LOAD IS ONE TRIP. A NuVizz load is one route; a second truckload on one
// shell while another sits empty is not a reload, it is freight that belongs on
// the truck already provided. So the solve runs with max_loads_per_driver = 1,
// which makes the seed spread across the shells instead of double-loading one,
// and anything past one truckload comes back as explicit over-capacity leftovers
// rather than a quietly invented second trip.
//
// ZERO NuVizz calls, ZERO writes. This produces a proposal; the dispatcher edits
// it on the Compare workbench and the existing Save is the only path to NuVizz.

import { readStops } from './firestore.mts';
import { DEPOT } from './history-derive.mts';
import { ENGINE_VERSION, loadEngineConfig, type EngineConfig } from './routing-engine-config.mts';
import { type ZonePrecisions } from './zones.mts';
import { loadPlanInputs, type PlanInputs } from './routing-plan-core.mts';
import {
  driverEnvelope, driverZoneAffinity, fleetTripChain, zoneOwnersAsOf,
} from './routing-envelope.mts';
import {
  solveAssignment, capsFor, stopSkidEquiv, type AssignStop, type AssignDriver,
} from './routing-assignment-solver.mts';
import { solveRoute, type EngineStop } from './routing-engine-solver.mts';
import { pickReferences } from './routing-reference.mts';
import { serviceTimeAsOf } from './routing-service-times.mts';
import { liveStopToAssignStop, liveMatchKey, modalWarehouseOf, LIVE_SOLVER_MS } from './routing-draft-core.mts';
import { dayReceivingWindow, closedDayTier, fmtMin } from '../../../src/lib/board-flags.js';

// The dispatcher's truck classes and the engine's are DIFFERENT VOCABULARIES:
// the browser's vehicle profiles say capabilities.tractor, the learned engine
// says the literal strings 'box_truck' / 'tractor' (from the MarginIQ roster's
// vehicleType). Nothing bridged them before this. One function, so a rename on
// either side breaks in one place instead of silently mis-sizing a truck.
export function engineClassForProfile(profile: any): 'box_truck' | 'tractor' {
  return profile?.capabilities?.tractor === true ? 'tractor' : 'box_truck';
}

// A cleanup solve is a DISPATCHER WAITING AT A SCREEN, not a nightly job: it must
// answer inside the function timeout. The full-day cap (90s) is for the replay.
// Measured on this solver: 5 trucks x 80 stops converges in ~3.5s; the pathological
// 8 x 200 runs 64s uncapped and 12s capped, for a ~5% worse objective. Bounding it
// is the right trade — a dispatcher gets an answer, and the answer is barely different.
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_LABEL: Record<string, string> = {
  sun: 'Sundays', mon: 'Mondays', tue: 'Tuesdays', wed: 'Wednesdays',
  thu: 'Thursdays', fri: 'Fridays', sat: 'Saturdays',
};
// Noon local, so a DST boundary cannot roll the day. Same construction the
// browser's weekdayKey uses; duplicated rather than imported because that module
// pulls the whole time-restrictions table for one line.
function weekdayKeyOf(date: string): string | null {
  const [y, m, d] = String(date ?? '').split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : DAY_KEYS[dt.getDay()];
}

// A dock that shuts before this is one a night-planned route has to lead with,
// not bury. 3pm is the same line the map's EARLY CLOSE mark uses, so the panel
// and the pins say the same thing.
export const CLEANUP_EARLY_CLOSE_MIN = 15 * 60;

export const CLEANUP_SOLVER_MS = LIVE_SOLVER_MS;

// Total wall clock for sequencing ALL the picked shells, split between them.
// 12s assignment + 8s sequencing + Firestore leaves real headroom under the 26s
// function timeout instead of the 24s+ a per-truck second would have cost.
export const CLEANUP_SEQUENCE_MS = 8_000;
// Past this the pool is not "leftovers" and the request is almost certainly a
// mistake (wrong date, or the whole day unplanned). Refuse loudly.
export const CLEANUP_MAX_POOL = 400;
export const CLEANUP_MAX_TRUCKS = 12;
// Past this the pool is old enough that dispatch has probably planned against it.
export const CLEANUP_STALE_MIN = 90;

export interface CleanupTruckInput {
  // Does this truck carry a liftgate? A residential / no-dock consignee marked
  // liftgate_required cannot be served without one — the driver cannot get the
  // pallet on the ground and it comes back as a redelivery. Undefined means
  // "not stated", which is read as NO liftgate: assuming one we cannot see is
  // the expensive direction of that guess.
  liftgate?: boolean;
  key: string;                       // the load's display name — the join back to the Compare card
  name?: string | null;
  loadNbr?: string | null;
  loadId?: string | null;
  truck_class?: string | null;       // 'box_truck' | 'tractor'
  max_skids?: number | null;         // the dispatcher's vehicle profile — tightens only
  max_weight_lb?: number | null;
  driver_user_name?: string | null;  // known only when the shell already holds board stops
}

export interface CleanupLeftover {
  stopNbr: string;
  businessName: string | null;
  city: string | null;
  skids: number;
  reason: 'no_coords' | 'equipment' | 'over_capacity' | 'too_big' | 'closed_today';
  detail: string;
}

export interface CleanupTruck {
  key: string;
  name: string | null;
  loadNbr: string | null;
  loadId: string | null;
  truck_class: string;
  driver_user_name: string | null;
  cap: { skids: number; weight_lb: number | null; source: 'profile' | 'driver' | 'fleet' | 'class' };
  stops: Array<{
    stopNbr: string; businessName: string | null; addr1: string | null; city: string | null;
    lat: number; lng: number; skids: number; loose: number; weight: number; miles: number;
    // When this dock shuts today, if anyone has recorded it. A cleanup route is
    // built at night for tomorrow and a dispatcher cannot judge a sequence
    // without it — a 2pm close sitting ninth on the run is a refused delivery.
    // null means nothing is on file, NOT that the dock is open all day.
    close_min: number | null; close_label: string | null; early_close: boolean;
    pickup: boolean;
  }>;
  stop_count: number;
  skid_equiv: number;
  weight_lb: number;
  travel_min_est: number;
  mode: 'guided' | 'unguided';
  references_used: number;
  // NOTE: there is deliberately no per-truck "overflow" count. After the refill
  // pass a stop that spilled off truck A may be sitting on truck B, so a per-truck
  // number would be a fiction. What did not fit ANYWHERE is in left_unplanned with
  // reason 'over_capacity'; how full each truck is reads off skid_equiv vs cap.
}

export interface CleanupResult {
  ok: boolean;
  tenant: string;
  date: string;
  engine_version: string;
  generated_at: string;
  pool: {
    board_stops: number; unplanned: number; excluded_held: number; no_coords: number; routed: number;
    // Real work, but work that may not belong on a cleanup truck — surfaced so
    // Chad decides rather than discovering it on the road.
    pickups: number; attempts: number;
    // The same stop number appearing twice on the board. First row wins.
    duplicates: number;
    // Rows with no stop number at all — no identity, so never routed.
    no_id: number;
    // Customers whose dock is shut on the served day. Never routed.
    closed_today: number;
    // Rows with no freight numbers yet. Each is counted as one skid position so it
    // is not free against the caps, but the totals on screen are an ESTIMATE while
    // this is non-zero, and the panel says so.
    unknown_freight: number;
  };
  fit: {
    pool_skid_equiv: number; capacity_skid_equiv: number;
    fits: boolean; shortfall_skid_equiv: number; trucks_needed_estimate: number;
  };
  staleness: {
    last_scanned_at: string | null; last_load_scan_at: string | null; last_unplanned_scan_at: string | null;
    // How old the UNPLANNED feed is, and whether that is old enough to matter.
    // A cleanup plan is only as good as the pool it was built from: routes
    // dispatch planned after the last scan are still "unplanned" here, so a stale
    // board can put freight on a truck that already has a truck. The Save refuses
    // per load when that happens, which reads as "the engine is broken" when the
    // real problem is the age of the board. Say it up front instead.
    pool_age_min: number | null;
    stale: boolean;
  };
  trucks: CleanupTruck[];
  left_unplanned: CleanupLeftover[];
  notes: string[];
  ms: number;
}

// ── the geometric seed ───────────────────────────────────────────────────────
//
// WHY THIS EXISTS. The assignment solver seeds pass 1 with an OWNERSHIP score:
// customer habit, zone affinity, learned territory. Every one of those terms is
// about a DRIVER, and cleanup mode's trucks are empty load shells with no driver
// to know anything about — so all three read zero and the seed collapses to its
// own tie-break jitter. Measured, before this: five clean geographic clusters
// onto five empty shells put FOUR of the five trucks across two towns each,
// including one running Gainesville and Conyers, 46 miles apart. The local
// search cannot undo that because first-improvement polishing starts from where
// the seed left it.
//
// So cleanup states the geometry itself, with the classic SWEEP: order every
// stop by its compass bearing from the depot and walk that circle, filling one
// truck to capacity before starting the next. Trucks come out as contiguous
// wedges radiating from Buford — which is how a dispatcher describes territory
// out loud ("everything north", "the Conyers side"). The sweep starts at the
// widest empty gap in the circle so a natural cluster is never split across the
// seam. It is deterministic, and it is only a STARTING POINT: the solver's shed
// pass and local search still move freight for capacity, equipment and travel.
export function sweepSeed(
  stops: AssignStop[], trucks: AssignDriver[], caps: Map<string, { hard: number; weightLb: number }>,
  depot: { lat: number; lng: number }, cfg: EngineConfig,
): Map<string, string> {
  const seed = new Map<string, string>();
  if (!stops.length || !trucks.length) return seed;

  const bearing = (s: AssignStop) => {
    const a = Math.atan2((s.lng - depot.lng) * 57, (s.lat - depot.lat) * 69);
    return a < 0 ? a + Math.PI * 2 : a;
  };
  const ordered = stops
    .map((s) => ({ s, a: bearing(s) }))
    .sort((x, y) => (x.a - y.a) || x.s.id.localeCompare(y.s.id));

  // Start the circle at the WIDEST GAP between neighbouring bearings, so the
  // seam falls in empty sky instead of through the middle of a town.
  let startIdx = 0, widest = -1;
  for (let i = 0; i < ordered.length; i++) {
    const prev = ordered[(i - 1 + ordered.length) % ordered.length].a;
    const gap = (ordered[i].a - prev + Math.PI * 2) % (Math.PI * 2);
    if (gap > widest + 1e-12) { widest = gap; startIdx = i; }
  }
  const walk = ordered.slice(startIdx).concat(ordered.slice(0, startIdx));

  // Deterministic truck order.
  const order = [...trucks].sort((a, b) => a.driver_key.localeCompare(b.driver_key));
  const used = new Map(order.map((d) => [d.driver_key, { eq: 0, lb: 0 }] as const));

  // FILL TO A FAIR SHARE FIRST, THE HARD CAP ONLY AS A FALLBACK.
  //
  // The textbook sweep fills one vehicle to its capacity, then starts the next.
  // That is right when the pool needs the whole fleet, and wrong here, because
  // cleanup is usually the opposite case: a handful of leftovers against trucks
  // with room to spare. Filled greedily the first truck runs to its cap, crosses
  // the seam and keeps going, and the last truck gets one stop — one truck doing
  // a 60-mile straddle while another does a single delivery. Giving each truck a
  // share of the pool in proportion to what it holds keeps every wedge
  // contiguous, and the hard cap is still there as the fallback so nothing goes
  // unseeded just because its share is full.
  const totalEq = stops.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0);
  const totalCap = order.reduce((a, d) => a + (caps.get(d.driver_key)?.hard || 0), 0);
  const shareOf = (d: AssignDriver) => {
    const c = caps.get(d.driver_key);
    if (!c) return 0;
    if (!(totalCap > 0)) return c.hard;
    return Math.min(c.hard, (totalEq * c.hard) / totalCap);
  };
  const fits = (d: AssignDriver, s: AssignStop, bound: 'share' | 'cap') => {
    if (s.blocksTractor && d.truck_class === 'tractor') return false;
    const c = caps.get(d.driver_key);
    if (!c) return false;
    const u = used.get(d.driver_key)!;
    const eq = stopSkidEquiv(s, cfg), lb = Number(s.weight) || 0;
    // NO "rides alone if it is bigger than the truck" escape here. splitFarFirst
    // has one because a learned cap is a preference and stranding freight is
    // worse; in cleanup the pool has already had everything that fits NO truck
    // pulled out, so every stop left has a truck that can legally hold it and
    // the seed's job is to find it. Letting a 10-skid stop ride alone on a
    // 6-skid truck fills that truck, the capacity repair below takes the stop
    // straight back off, and the truck ends up carrying one stop.
    const limit = bound === 'share' ? shareOf(d) : c.hard;
    return u.eq + eq <= limit + 1e-9 && u.lb + lb <= c.weightLb + 1e-9;
  };

  let ti = 0;
  for (const { s } of walk) {
    let placed = false;
    // Try the truck currently being filled, then the rest in order — so the wedge
    // stays contiguous, and a stop this truck cannot take (equipment, weight)
    // rolls forward instead of stranding. Fair share first, then the hard cap.
    for (const bound of ['share', 'cap'] as const) {
      for (let k = 0; k < order.length; k++) {
        const d = order[(ti + k) % order.length];
        if (!fits(d, s, bound)) continue;
        seed.set(s.id, d.driver_key);
        const u = used.get(d.driver_key)!;
        u.eq += stopSkidEquiv(s, cfg); u.lb += Number(s.weight) || 0;
        ti = (ti + k) % order.length;
        placed = true;
        break;
      }
      if (placed) break;
    }
    // Nothing has room: leave it unseeded and let the solver's own path decide
    // (it lands as over-capacity in the report, which is the honest answer).
    if (!placed) continue;
  }
  return seed;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export interface BuildCleanupOpts {
  cfg: EngineConfig;
  inputs: PlanInputs;
  liveStops: any[];
  meta: any | null;
  trucks: CleanupTruckInput[];
  excludeStopNbrs?: string[];
  nowIso?: string;
}

// The pure core: pool → solve → one trip per shell → proposal. No I/O.
export function buildCleanupPlan(tenant: string, date: string, opts: BuildCleanupOpts): CleanupResult {
  const t0 = Date.now();
  const { cfg: baseCfg, inputs, liveStops, meta, trucks: truckInputs } = opts;
  const cfg: EngineConfig = { ...baseCfg, assignment_ms_cap: Math.min(baseCfg.assignment_ms_cap, CLEANUP_SOLVER_MS) };
  const nowIso = opts.nowIso || new Date().toISOString();
  const precisions: ZonePrecisions = {
    zone_precision: cfg.zone_precision, super_precision: cfg.super_precision, top_precision: cfg.top_precision,
  };
  const notes: string[] = [];
  const left: CleanupLeftover[] = [];

  // How old is the pool? Deliberately a WARNING and not a refusal: the scanner is
  // dark from Friday night to Sunday evening, and planning Monday's leftovers on
  // Sunday night is a real thing Chad does. Refusing then would block the exact
  // job this feature exists for. Naming the age lets him judge it.
  const stampIso = meta?.lastUnplannedScanAt ?? meta?.last_scanned_at ?? null;
  const stampMs = stampIso ? Date.parse(String(stampIso)) : NaN;
  const poolAgeMin = Number.isFinite(stampMs)
    ? Math.max(0, Math.round((Date.parse(nowIso) - stampMs) / 60000)) : null;
  if (poolAgeMin != null && poolAgeMin > CLEANUP_STALE_MIN) {
    const h = Math.floor(poolAgeMin / 60), m = poolAgeMin % 60;
    notes.push(`This board was last scanned ${h ? `${h}h ${m}m` : `${m}m`} ago. Anything dispatch has planned since still looks unplanned here — scan before you save, or check the routes you get.`);
  }

  // ── the pool: everything still to do that nobody has planned ──
  // isUnplanned already means "not planned AND not terminal" (a cancelled or
  // delivered stop is not leftovers), so this is the whole leftover pile.
  const exclude = new Set((opts.excludeStopNbrs || []).map(String));
  const unplannedRows = (liveStops || []).filter((s) => s?.isUnplanned === true);
  const byId = new Map<string, any>();
  const pool: AssignStop[] = [];
  let noCoords = 0, excludedHeld = 0, unknownFreight = 0, pickups = 0, attempts = 0, duplicates = 0, noId = 0, closedToday = 0;
  const clockByStop = new Map<string, number>();   // stopNbr → the minute this dock shuts
  const dayKey = weekdayKeyOf(date);
  for (const s of unplannedRows) {
    // ONE id, used for the exclude test, the dedupe and the stored row. Deriving
    // the guard key differently from the id actually stored (String(x ?? '') vs
    // String(x)) meant a row with no stopNbr was keyed '' here and 'undefined'
    // there, so the guard never matched and two such rows both rode a truck.
    const id = String(s?.stopNbr ?? '');
    // No stop number is no identity: it cannot be excluded, cannot be staged onto
    // a card and cannot be saved back to the load. Counted, never routed.
    if (!id || id === 'undefined' || id === 'null') { noId++; continue; }
    if (exclude.has(id)) { excludedHeld++; continue; }
    // The same stop number twice is a vendor anomaly, not two deliveries. Left
    // alone it rides two trucks: the second driver arrives for freight the first
    // already took, and every fill number on both cards is overstated. First row
    // wins, and the collapse is counted so it is visible rather than silent.
    if (byId.has(id)) { duplicates++; continue; }
    const as = liveStopToAssignStop(s, cfg, precisions, inputs, date);
    if (!as) {
      noCoords++;
      left.push({
        stopNbr: id || '?', businessName: s?.businessName ?? null, city: s?.city ?? null,
        skids: Number(s?.cartons) || 0, reason: 'no_coords',
        detail: 'no map position yet — the engine cannot place it; put it on a truck by hand',
      });
      continue;
    }
    // No candidate restriction: cleanup is allowed to put any stop on any truck
    // that can physically carry it. An empty cast also contributes zero rank cost,
    // so a driverless shell is never penalised for not being in a cast.
    as.candidates = undefined;
    // ── A DOCK THAT IS SHUT TOMORROW IS NOT ROUTABLE TOMORROW ──
    // The cheapest real failure this feature can cause: a consignee closed on the
    // served day gets sequenced onto a truck, the driver arrives, there is nobody
    // to take the freight, and it comes back. No amount of good sequencing fixes
    // a closed door. closedDayTier is the same pure function the map draws its
    // closed marks from, so the engine and the screen cannot disagree.
    const note = as.matchKey ? (inputs.noteByKey?.get(as.matchKey) ?? null) : null;
    if (dayKey && note && closedDayTier(note, dayKey)) {
      closedToday++;
      left.push({
        stopNbr: id, businessName: s?.businessName ?? null, city: s?.city ?? null,
        skids: as.skids, reason: 'closed_today',
        detail: `this customer is closed ${DAY_LABEL[dayKey] || dayKey} — the freight cannot be delivered on ${date}`,
      });
      continue;
    }
    if (dayKey && note) {
      const w = dayReceivingWindow(note, dayKey);
      if (w && Number.isFinite(w.closeMin)) clockByStop.set(as.id, w.closeMin);
    }
    if (as.freight_unknown) unknownFreight++;
    if (String(s?.stopType || '').toUpperCase() === 'PU') pickups++;
    if (s?.isAttempt === true) attempts++;
    byId.set(id, s);
    pool.push(as);
  }

  // ── the trucks ──
  const drivers: AssignDriver[] = truckInputs.map((t) => {
    const cls = t.truck_class === 'tractor' ? 'tractor' : 'box_truck';
    const uname = String(t.driver_user_name || '').trim().toUpperCase() || null;
    // A shell with a known driver (it already holds board stops) gets that
    // driver's real learned envelope, zone affinity and ownership standing; an
    // empty shell gets the class-level fallback and is bounded by its profile.
    // THE KEY IS THE SHELL, NOT THE DRIVER. solveAssignment keys bag, capsByKey,
    // shiftByKey and kept by driver_key, so two picked loads with the same driver
    // — a driver's first load plus their reload, which is the ordinary end-of-night
    // shape — collapsed into ONE bag. Measured: pick SUW 2 and SUW 9 both driven by
    // John Smith and the panel showed two cards BOTH labelled SUW 9, holding the
    // same four stops, with SUW 2 gone and half the picked capacity never used.
    // The learned envelope is still looked up by the DRIVER's key, and zone
    // ownership matches on driver_user_name, so nothing learned is lost by this.
    const learnKey = uname ? uname.replace(/\s+/g, '_') : `LOAD__${t.key}`;
    const envelope = driverEnvelope(learnKey, inputs.driverDaysBefore, date, cfg);
    return {
      driver_key: `LOAD__${t.key}`,
      driver_user_name: uname,
      driver_name: t.name || t.key,
      truck_class: cls,
      start_minute: envelope.start_minute_typical,
      envelope,
      affinity: uname ? driverZoneAffinity(uname, inputs.referencesBefore, date, precisions) : new Map(),
      cap_override: { skids: t.max_skids ?? null, weightLb: t.max_weight_lb ?? null },
    };
  });
  const truckByKey = new Map(drivers.map((d, i) => [d.driver_key, truckInputs[i]] as const));

  const capsByKey = new Map(drivers.map((d) => [d.driver_key, capsFor(d, cfg)] as const));

  // ── freight that does not fit on ANY truck he picked, pulled out FIRST ──
  //
  // A single stop can be bigger than a whole box truck: one consignee with 10
  // skids against a 6-skid straight truck. Left in the pool the solver has
  // nowhere legal to put it, so it lands on a truck anyway — the card then reads
  // "cap 6, loaded 10", which is a load that physically will not go on, and the
  // truck it landed on is now "full", so a 1-skid stop that WOULD have fit gets
  // reported as needing another truck. Both halves of that are wrong, and the
  // second one is the expensive half: it tells Chad to roll a truck he does not
  // need. A stop no provided truck can carry is not a routing problem — it needs
  // a bigger truck or a split across two, and both of those are his call, so it
  // is named and set aside rather than forced on.
  //
  // Measured against the truck that COULD take it (equipment first): a
  // tractor-blocked stop is not judged against the trailer's cap. If no truck can
  // take it on equipment grounds at all, it stays in the pool and comes back
  // through the 'equipment' path below, which says so in those words.
  const canServe = (d: AssignDriver, s: AssignStop) => {
    if (s.blocksTractor && d.truck_class === 'tractor') return false;
    return true;
  };
  const servingCaps = (s: AssignStop) => drivers
    .filter((d) => canServe(d, s))
    .map((d) => capsByKey.get(d.driver_key)!)
    .filter(Boolean);
  // ── LIFTGATE: a positive capability the truck_class bit cannot express ──
  // blocksTractor is one bit and it only ever says "not a trailer". A consignee
  // marked liftgate_required needs a truck that HAS one, and a 53ft trailer does
  // not. Routed anyway, the driver cannot get the pallet on the ground and it
  // comes back — a wasted round trip and a redelivery charge, discovered at the
  // door. Checked here, before the solve, so the stop is named rather than
  // quietly loaded.
  const liftgateTrucks = drivers.filter((d) => truckByKey.get(d.driver_key)?.liftgate === true);
  const needsLiftgate = (s: AssignStop) => {
    if (!s.matchKey) return false;
    const r = inputs.notesRestrictions.get(s.matchKey) || [];
    return r.some((x: any) => String(x).toLowerCase() === 'liftgate_required');
  };

  const routable: AssignStop[] = [];
  for (const s of pool) {
    if (needsLiftgate(s) && !liftgateTrucks.length) {
      const raw = byId.get(s.id);
      left.push({
        stopNbr: s.id, businessName: raw?.businessName ?? null, city: raw?.city ?? null,
        skids: s.skids, reason: 'equipment',
        detail: 'this customer needs a liftgate and none of the loads you picked has one',
      });
      continue;
    }
    const caps = servingCaps(s);
    if (!caps.length) { routable.push(s); continue; }   // equipment path owns this one
    const need = stopSkidEquiv(s, cfg);
    const needLb = Number(s.weight) || 0;
    const biggestEq = Math.max(...caps.map((c) => c.hard));
    // A non-positive weight rating means NO weight gate for that class — the same
    // rule classCapsFor uses. Only a real positive number can refuse freight.
    const biggestLb = Math.max(...caps.map((c) => (Number.isFinite(c.weightLb) && c.weightLb > 0 ? c.weightLb : Infinity)));
    const overEq = need > biggestEq + 1e-9;
    const overLb = needLb > biggestLb + 1e-9;
    if (!overEq && !overLb) { routable.push(s); continue; }
    const raw = byId.get(s.id);
    left.push({
      stopNbr: s.id, businessName: raw?.businessName ?? null, city: raw?.city ?? null,
      skids: s.skids, reason: 'too_big',
      detail: overEq
        ? `this stop alone is ${r1(need)} skid-equivalents and the biggest truck you picked holds ${r1(biggestEq)} — it needs a bigger truck or splitting across two`
        : `this stop alone is ${Math.round(needLb)} lb and the biggest truck you picked is rated ${Math.round(biggestLb)} lb — it needs a bigger truck or splitting across two`,
    });
  }
  const tooBig = pool.length - routable.length;
  pool.length = 0;
  pool.push(...routable);
  if (tooBig) {
    notes.push(`${tooBig} stop${tooBig === 1 ? '' : 's'} will not fit on any truck you picked, even empty — listed below. They are left out of the fit numbers because another truck this size would not take them either.`);
  }

  // ── the fit question, answered BEFORE anything is staged ──
  const poolEq = pool.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0);
  const capacityEq = drivers.reduce((a, d) => a + (capsByKey.get(d.driver_key)?.hard || 0), 0);
  const perTruckAvg = drivers.length ? capacityEq / drivers.length : 0;
  const fit = {
    pool_skid_equiv: r1(poolEq),
    capacity_skid_equiv: r1(capacityEq),
    fits: poolEq <= capacityEq,
    shortfall_skid_equiv: r1(Math.max(0, poolEq - capacityEq)),
    trucks_needed_estimate: perTruckAvg > 0 ? Math.ceil(poolEq / perTruckAvg) : 0,
  };
  if (!fit.fits) {
    notes.push(`The pool is ${fit.pool_skid_equiv} skid-equivalents and these ${drivers.length} truck${drivers.length === 1 ? '' : 's'} hold about ${fit.capacity_skid_equiv} — roughly ${fit.trucks_needed_estimate} trucks would clear it. The overflow is listed, not hidden.`);
  }

  const fleet = fleetTripChain(inputs.driverDaysBefore, date, cfg);
  const svcCache = new Map<string, number>();
  const serviceMedianFor = (s: AssignStop): number => {
    const k = `${s.matchKey}__${s.pallets}`;
    let v = svcCache.get(k);
    if (v == null) {
      const doc = s.matchKey ? inputs.serviceDocByKey.get(s.matchKey) : null;
      v = serviceTimeAsOf(doc, inputs.fleetServiceDoc, s.pallets, date, cfg).median_min;
      svcCache.set(k, v);
    }
    return v;
  };

  const capsForSeed = new Map([...capsByKey].map(([k, c]) => [k, { hard: c.hard, weightLb: c.weightLb }] as const));
  const result = pool.length
    ? solveAssignment({
      date, stops: pool, drivers, fleetChain: fleet, cfg,
      depot: { lat: DEPOT.lat, lng: DEPOT.lng }, serviceMedianFor,
      zoneOwners: zoneOwnersAsOf(inputs.referencesBefore, date, precisions, cfg),
      // One shell, one truckload — see the header.
      max_loads_per_driver: 1,
      // GEOMETRY IS THE SIGNAL HERE — see sweepSeed.
      seedAssignment: sweepSeed(pool, drivers, capsForSeed, { lat: DEPOT.lat, lng: DEPOT.lng }, cfg),
    })
    : { date, shifts: [], unassigned: [] as AssignStop[], cost: 0, drivers_used: 0, tie_margin: null };

  for (const s of result.unassigned) {
    const raw = byId.get(s.id);
    // Say WHICH refusal it was. "The customer bars a tractor" sends Chad to find
    // a box truck; "you picked no trucks" sends him to pick one. Printing the
    // first when the second is true is the confident-wrong-answer failure.
    left.push({
      stopNbr: s.id, businessName: raw?.businessName ?? null, city: raw?.city ?? null,
      skids: s.skids, reason: 'equipment',
      detail: !drivers.length
        ? 'no loads were picked to route onto'
        : (s.blocksTractor
          ? 'this customer bars a tractor/trailer and every load you picked is one'
          : 'none of the loads you picked can take it'),
    });
  }

  // ── one trip per shell, THEN refill before anything is called overflow ──
  //
  // The solver splits a driver's bag into as many trips as the caps demand, and
  // cleanup keeps only the first (a shell is one route). Taking trips[0] and
  // stopping there would strand freight on a truck that is already full while
  // ANOTHER picked shell sits empty — the exact opposite of "give it 5 empties
  // and let it route the leftovers on them". So every stop past a shell's one
  // load is re-offered to every shell that still has room, nearest-first, and
  // only what STILL does not fit is reported as needing another truck.
  // ── the SEQUENCING budget, split across the shells ──
  // LIVE_SOLVER_MS bounds the assignment only. Sequencing runs solveRoute ONCE
  // PER TRUCK against solver_ms_cap (1s by default), so 12 shells could add 12
  // more seconds on top of a 12-second assignment and blow the 26s function
  // timeout — and the failure mode there is the HTML 502 the timeout bump exists
  // to prevent. One budget for the whole loop, divided by the shells actually
  // picked, so the answer arrives whatever Chad hands it.
  const seqCfg: EngineConfig = {
    ...cfg,
    solver_ms_cap: Math.max(50, Math.min(cfg.solver_ms_cap, Math.floor(CLEANUP_SEQUENCE_MS / Math.max(1, drivers.length)))),
  };
  const modalWarehouse = modalWarehouseOf(inputs.referencesBefore);
  const shiftByKey = new Map(result.shifts.map((sh) => [sh.driver.driver_key, sh] as const));

  const kept = new Map<string, AssignStop[]>();     // driver_key → the one truckload
  const spill: AssignStop[] = [];
  for (const d of drivers) {
    const trips = shiftByKey.get(d.driver_key)?.trips.filter((t) => t.stops.length) || [];
    kept.set(d.driver_key, [...(trips[0]?.stops || [])]);
    for (const extra of trips.slice(1)) spill.push(...extra.stops);
  }
  // ── capacity repair: no truck keeps freight it cannot legally carry ──
  //
  // The solver's trip splitter puts a single stop that exceeds a driver's cap in
  // a trip BY ITSELF rather than drop it, and for the nightly plan that is right:
  // there the cap is a LEARNED typical load, not a physical wall, and a driver
  // who usually runs 8 skids can take a 10-skid stop. Cleanup keeps one trip per
  // shell, so that over-cap trip becomes the truck's entire load and the card
  // reads "cap 8, loaded 10". Here the cap IS the wall — Chad picked these
  // trucks and told us what they hold — so anything past it comes back off,
  // biggest first, and is re-offered below to a truck that can actually take it.
  const weightCapOf = (c: { weightLb: number }) => (Number.isFinite(c.weightLb) && c.weightLb > 0 ? c.weightLb : Infinity);
  for (const d of drivers) {
    const caps = capsByKey.get(d.driver_key)!;
    const load = kept.get(d.driver_key)!;
    const lbCap = weightCapOf(caps);
    const over = () => load.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0) > caps.hard + 1e-9
      || load.reduce((a, s) => a + (Number(s.weight) || 0), 0) > lbCap + 1e-9;
    while (load.length && over()) {
      // Biggest first — sheds the overflow in the fewest moves — ties by id so
      // the same board always evicts the same stop.
      let worst = 0;
      for (let i = 1; i < load.length; i++) {
        const a = stopSkidEquiv(load[i], cfg), b = stopSkidEquiv(load[worst], cfg);
        if (a > b + 1e-9 || (Math.abs(a - b) <= 1e-9 && load[i].id.localeCompare(load[worst].id) < 0)) worst = i;
      }
      spill.push(load.splice(worst, 1)[0]);
    }
  }
  // Deterministic: biggest freight first (same discipline as the solver's seed),
  // ties by id — never insertion order.
  spill.sort((a, b) => (stopSkidEquiv(b, cfg) - stopSkidEquiv(a, cfg)) || a.id.localeCompare(b.id));
  const roomFor = (d: AssignDriver) => {
    const caps = capsByKey.get(d.driver_key)!;
    const load = kept.get(d.driver_key)!;
    const eq = load.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0);
    const lb = load.reduce((a, s) => a + (Number(s.weight) || 0), 0);
    return { eq: caps.hard - eq, lb: weightCapOf(caps) - lb };
  };
  const refilled: AssignStop[] = [];
  for (const s of spill) {
    const need = stopSkidEquiv(s, cfg), needLb = Number(s.weight) || 0;
    let best: AssignDriver | null = null, bestDist = Infinity;
    for (const d of drivers) {
      if (s.blocksTractor && d.truck_class === 'tractor') continue;   // equipment is inviolable
      const room = roomFor(d);
      if (room.eq + 1e-9 < need || room.lb + 1e-9 < needLb) continue;
      // Nearest-first keeps the refill compact: distance to what the truck already
      // holds, or to the depot when it is still empty (which is what makes an
      // empty shell win the near-in freight instead of staying empty).
      const load = kept.get(d.driver_key)!;
      const dist = load.length
        ? Math.min(...load.map((x) => Math.hypot((x.lat - s.lat) * 69, (x.lng - s.lng) * 57)))
        : Math.hypot((DEPOT.lat - s.lat) * 69, (DEPOT.lng - s.lng) * 57);
      if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && best && d.driver_key < best.driver_key)) {
        bestDist = dist; best = d;
      }
    }
    if (best) { kept.get(best.driver_key)!.push(s); refilled.push(s); }
  }
  const stillOver = new Set(spill.filter((s) => !refilled.includes(s)).map((s) => s.id));
  if (refilled.length) {
    notes.push(`${refilled.length} stop${refilled.length === 1 ? '' : 's'} moved onto trucks that still had room.`);
  }
  const out: CleanupTruck[] = drivers.map((d) => {
    const t = truckByKey.get(d.driver_key)!;
    const caps = capsByKey.get(d.driver_key)!;
    // SAY WHICH NUMBER THIS IS, HONESTLY. An empty shell has no driver, so
    // driverEnvelope finds no days, falls through with truck_class null and
    // returns a WHOLE-FLEET envelope — box and tractor days mixed. capsFor sees a
    // p85 and reports learned:true, so calling that 'driver' put the word
    // "driver" on a truck that has none, and the p85 of a mixed fleet clamps to
    // the box class cap of 22. Chad's own comment on capsFor says most of the
    // fleet cannot put 22 skids on a box truck; most run 12-15. Labelling it
    // 'driver' also suppressed the one warning written to catch exactly this.
    const envSource = String((d.envelope as any)?.source || '');
    const capSource: 'profile' | 'driver' | 'fleet' | 'class' =
      (t.max_skids && t.max_skids > 0 && t.max_skids <= caps.hard + 1e-9) ? 'profile'
        : (caps.learned && d.driver_user_name && envSource === 'driver') ? 'driver'
          : caps.learned ? 'fleet' : 'class';
    const stops = kept.get(d.driver_key) || [];
    let travelMin = 0, mode: 'guided' | 'unguided' = 'unguided', refsUsed = 0;
    let ordered = stops;
    if (stops.length) {
      const engineStops: EngineStop[] = stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, zone: s.zone }));
      const picked = pickReferences(
        inputs.referencesBefore,
        {
          date, zones: new Set(engineStops.map((s) => s.zone)),
          driverUserName: d.driver_user_name, truckClass: d.truck_class,
          warehouse: modalWarehouse || null, minOverlap: cfg.min_reference_zone_overlap,
        },
        { topK: cfg.reference_top_k, halfLifeDays: cfg.reference_half_life_days, sameDriverMultiplier: cfg.same_driver_multiplier },
      );
      const solved = solveRoute({
        loadKey: `cleanup__${date}__${d.driver_key}`,
        stops: engineStops, depot: { lat: DEPOT.lat, lng: DEPOT.lng },
        referenceZoneSeq: null,
        references: picked.length ? picked.map((p) => ({ zone_seq: p.ref.zone_seq, weight: p.weight })) : null,
        cfg: seqCfg,
      });
      const byStopId = new Map(stops.map((s) => [s.id, s] as const));
      ordered = solved.order.map((o) => byStopId.get(o.id)!).filter(Boolean);
      travelMin = solved.travelMin;
      refsUsed = picked.length;
      mode = picked.length ? 'guided' : 'unguided';
    }
    return {
      key: t.key,
      name: t.name ?? null,
      loadNbr: t.loadNbr ?? null,
      loadId: t.loadId ?? null,
      truck_class: d.truck_class || 'box_truck',
      driver_user_name: d.driver_user_name,
      cap: { skids: r1(caps.hard), weight_lb: Number.isFinite(caps.weightLb) ? caps.weightLb : null, source: capSource },
      stops: ordered.map((s) => {
        const raw = byId.get(s.id);
        const closeMin = clockByStop.has(s.id) ? clockByStop.get(s.id)! : null;
        return {
          stopNbr: s.id, businessName: raw?.businessName ?? null, addr1: raw?.addr1 ?? null, city: raw?.city ?? null,
          lat: s.lat, lng: s.lng, skids: s.skids, loose: s.loose, weight: s.weight, miles: r1(s.miles),
          close_min: closeMin,
          close_label: closeMin == null ? null : fmtMin(closeMin),
          early_close: closeMin != null && closeMin < CLEANUP_EARLY_CLOSE_MIN,
          pickup: String(raw?.stopType || '').toUpperCase() === 'PU',
        };
      }),
      stop_count: ordered.length,
      skid_equiv: r1(ordered.reduce((a, s) => a + stopSkidEquiv(s, cfg), 0)),
      weight_lb: Math.round(ordered.reduce((a, s) => a + (Number(s.weight) || 0), 0)),
      travel_min_est: r1(travelMin),
      mode,
      references_used: refsUsed,
    };
  });

  for (const s of spill) {
    if (!stillOver.has(s.id)) continue;
    const raw = byId.get(s.id);
    left.push({
      stopNbr: s.id, businessName: raw?.businessName ?? null, city: raw?.city ?? null,
      skids: s.skids, reason: 'over_capacity',
      detail: 'every truck you picked is full — this needs another truck',
    });
  }

  if (closedToday) {
    notes.push(`${closedToday} stop${closedToday === 1 ? '' : 's'} are at customers closed on ${DAY_LABEL[dayKey || ''] || 'that day'} — listed below, not routed. Nobody is there to take the freight.`);
  }
  // An early-closing dock buried in the back half of a route is the refusal this
  // feature would otherwise cause. The sequencer is geographic and does not know
  // about clocks, so rather than pretend otherwise, name the ones at risk and let
  // the dispatcher drag them up — which is a thing he can actually do on the card.
  const lateEarlyClosers: string[] = [];
  for (const t of out) {
    t.stops.forEach((st, i) => {
      if (st.early_close && i >= Math.floor(t.stops.length / 2)) {
        lateEarlyClosers.push(`${st.businessName || st.stopNbr} (shuts ${st.close_label}, ${i + 1} of ${t.stops.length} on ${t.key})`);
      }
    });
  }
  if (lateEarlyClosers.length) {
    notes.push(`Sequenced late but shuts early — move ${lateEarlyClosers.length === 1 ? 'it' : 'them'} up or the truck arrives to a closed dock: ${lateEarlyClosers.join('; ')}.`);
  }
  const routed = out.reduce((a, t) => a + t.stop_count, 0);
  if (!pool.length) notes.push('nothing is sitting unplanned on this board — there is nothing to clean up');
  if (pickups || attempts) {
    const bits = [pickups ? `${pickups} pickup${pickups === 1 ? '' : 's'}` : null,
      attempts ? `${attempts} re-delivery attempt${attempts === 1 ? '' : 's'}` : null].filter(Boolean);
    notes.push(`The pool includes ${bits.join(' and ')} — real work, but check they belong on these trucks.`);
  }
  if (unknownFreight) {
    notes.push(`${unknownFreight} stop${unknownFreight === 1 ? '' : 's'} have no freight numbers yet — each is counted as one skid, so the fills below are an estimate.`);
  }
  const emptyTrucks = out.filter((t) => !t.stop_count).map((t) => t.key);
  if (emptyTrucks.length && pool.length) {
    notes.push(`${emptyTrucks.join(', ')} got nothing — the pool fit on the others.`);
  }

  return {
    ok: true, tenant, date, engine_version: ENGINE_VERSION, generated_at: nowIso,
    pool: {
      board_stops: (liveStops || []).length, unplanned: unplannedRows.length,
      excluded_held: excludedHeld, no_coords: noCoords, routed,
      pickups, attempts, unknown_freight: unknownFreight, duplicates, no_id: noId, closed_today: closedToday,
    },
    fit,
    staleness: {
      last_scanned_at: meta?.last_scanned_at ?? null,
      last_load_scan_at: meta?.lastLoadScanAt ?? null,
      last_unplanned_scan_at: meta?.lastUnplannedScanAt ?? null,
      pool_age_min: poolAgeMin,
      stale: poolAgeMin != null && poolAgeMin > CLEANUP_STALE_MIN,
    },
    trucks: out,
    left_unplanned: left,
    notes,
    ms: Date.now() - t0,
  };
}

// I/O wrapper: live board + the same as-of learning inputs the nightly uses.
// ZERO NuVizz calls — readStops and loadPlanInputs are Firestore-only.
export async function runCleanup(
  tenant: string, date: string, trucks: CleanupTruckInput[], excludeStopNbrs?: string[],
): Promise<{ ok: true; plan: CleanupResult } | { ok: false; status: number; error: string }> {
  if (!Array.isArray(trucks) || !trucks.length) {
    return { ok: false, status: 400, error: 'pick at least one load to route onto' };
  }
  if (trucks.length > CLEANUP_MAX_TRUCKS) {
    return { ok: false, status: 400, error: `too many loads (${trucks.length}) — cleanup handles up to ${CLEANUP_MAX_TRUCKS}` };
  }
  const seen = new Set<string>();
  for (const t of trucks) {
    const k = String(t?.key || '').trim();
    if (!k) return { ok: false, status: 400, error: 'every load needs a name/key' };
    if (seen.has(k)) return { ok: false, status: 400, error: `the same load is picked twice: ${k}` };
    seen.add(k);
  }

  const cfg = await loadEngineConfig(tenant);
  const { meta, stops } = await readStops(tenant, date);
  if (!stops.length) {
    return { ok: false, status: 404, error: `no board data for ${date} — the scheduled scan has not written that day yet` };
  }
  const unplanned = stops.filter((s: any) => s?.isUnplanned === true);
  if (unplanned.length > CLEANUP_MAX_POOL) {
    return {
      ok: false, status: 400,
      error: `${unplanned.length} stops are unplanned on ${date} — that is a whole board, not leftovers. Check the date, or plan the main routes first.`,
    };
  }
  // STAMP THE MATCH KEY FIRST. loadPlanInputs builds its bounded per-customer
  // reads from s.customerMatchKey, and board rows never carry that field — it is
  // the whole reason liveStopToAssignStop computes it on the fly. Handing it raw
  // rows made wantKeys empty, so serviceDocByKey and habitDocByKey came back
  // EMPTY every time: every stop's dwell fell back to the flat 15-minute default
  // (so the shift-length term could not tell a 5-minute dock drop from a 45-minute
  // inside delivery) and customer habit was dead for the whole pool. Nothing
  // errored and the plan looked normal — the confident-wrong-answer class. The
  // draft path stamps these and says why; cleanup had simply omitted the line.
  const stamped = (stops || []).map((s: any) => ({ ...s, customerMatchKey: liveMatchKey(s) }));
  const inputs = await loadPlanInputs(tenant, date, stamped.filter((s: any) => s?.isUnplanned === true));
  return { ok: true, plan: buildCleanupPlan(tenant, date, { cfg, inputs, liveStops: stamped, meta, trucks, excludeStopNbrs }) };
}
