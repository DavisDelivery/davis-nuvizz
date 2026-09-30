// src/lib/route-preflight.js
//
// JUDGE A ROUTE WHILE IT IS BEING BUILT, NOT AFTER IT IS DRIVEN.
//
// Chad: "can we have flags pop in the routing page if we build a route that system
// immediately thinks won't make it on time."
//
// WHAT ALREADY EXISTED, AND WHAT DID NOT. The Routing screen has run computeBoardFlags since
// the flag panel shipped (App.jsx, the routingBoardFlags memo) — but over the BOARD: each
// stop in the route and position NuVizz currently holds for it. A router staging stops onto
// a Compare card is building a sequence that does not exist yet anywhere, so the panel was
// answering a question about yesterday's arrangement while he made tomorrow's. The judgement
// he needs is on the list in front of him, and it has to change when he drags a row.
//
// WHY THIS DELEGATES INSTEAD OF COMPUTING. Every rule here — the depot walk, the calibrated
// per-truck-class speeds, the measured dwell, the receiving-hours lookup and its three
// provenances, the error band, severityTier — already lives in computeBoardFlags and is
// already tested there. A second implementation would be a second answer, and this repo's
// most expensive recurring defect is two surfaces disagreeing about one rule (the screen and
// the inbox on tiers; the sweep and the browser on departures). So this module builds a
// SYNTHETIC ONE-ROUTE BOARD out of the draft and hands it to the same engine. If the engine
// changes, this changes with it, for free, and it cannot drift.
//
// THE THREE THINGS IT ADDS ON TOP, none of which the board engine can know:
//   1. THE ORDER IS THE DRAFT'S, not NuVizz's. routeSeq is stamped from the card's list, so
//      dragging a stop up genuinely re-walks the clock.
//   2. HOPELESS vs LATE-WHERE-YOU-PUT-IT. A stop projected past its close because it is
//      eleventh is a re-order; a stop that cannot be reached before its close even as stop
//      ONE is not, and telling a router to "move it up" when moving it up cannot work wastes
//      the only thing he is short of. Measured with the same leg function the walk uses.
//   3. WHAT IT COULD NOT JUDGE, counted and named. A stop with no geocode, or one the card
//      could not resolve, is not "fine" — it is unexamined, and a preflight that reports a
//      clean route while silently skipping four stops is worse than no preflight. The card
//      already learned this lesson for its own rows (an unresolved id renders as a stub
//      rather than vanishing); the same rule applies to the judgement.
//
// WHERE IT IS NOT WIRED, NAMED RATHER THAN LEFT TO BE DISCOVERED. The engine Build's Result
// cards (RoutingRouteCard) are the other place a route is proposed, and they print their own
// per-stop ETAs from the routing pipeline's model — a different and more optimistic clock than
// this one. A verdict from THIS engine beside an arrival time from THAT one gives a single
// card two clocks, which is how surfaces in this app have come to disagree before. Making the
// two agree is a larger change than the one asked for, so the preflight rides the Compare
// cards, which is where a route is finalised and saved.
//
// ZERO NETWORK. Pure: the stops, the notes and the travel calibration are already in the
// browser. Measured at 2.9 ms for 60 stops across 6 routes, so it can run on every drag.
import { computeBoardFlags, fmtMin } from './board-flags.js';
import { resolveLegMinutes } from './travel-model.js';
import { haversineMeters } from './routing-select.js';

/** The house departure, and the same one board-flags falls back to. */
export const DEFAULT_DEPART_MIN = 8 * 60;

/**
 * PURE. The travel calibration a draft is judged with on `servedDate`: the per-day route classes
 * only when they were measured for THAT day, the rest of the calibration either way. One helper,
 * because the card's badges and the Time windows re-sequence must read the same clock — two
 * copies of this rule is how the order a strategy picks and the badges it then shows disagree.
 */
export function travelForServedDate(travelInputs, servedDate) {
  if (!travelInputs) return null;
  return travelInputs.routeClasses && travelInputs.routeClassesDate !== servedDate
    ? { ...travelInputs, routeClasses: undefined }
    : travelInputs;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const hasCoords = (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng);

/**
 * PURE. The earliest this stop could be reached if it were the FIRST stop on the truck.
 *
 * This is the line between "you have it in the wrong place" and "this cannot be delivered
 * today from this depot", and they are different jobs: the first is a drag, the second is a
 * phone call to the customer or a stop that belongs on tomorrow's board. Uses the identical
 * leg resolution the walk uses (a cached real drive time when we have one, the calibrated
 * curve otherwise), so the two can never disagree about how far away something is.
 *
 * Deliberately NO service time: this is an arrival at stop one, and nothing precedes it.
 */
export function earliestArrivalMin(stop, { depot, travel = null, departMin = DEFAULT_DEPART_MIN } = {}) {
  if (!hasCoords(stop) || !hasCoords(depot)) return null;
  const d = num(departMin);
  if (d == null) return null;
  const leg = resolveLegMinutes(depot, stop, haversineMeters(depot, stop), travel);
  return Math.round(d + leg.min);
}

/**
 * PURE. Judge a draft route.
 *
 * @param opts.order      ordered stop numbers — the card's list, in the router's order
 * @param opts.stopById   Map<stopNbr, stop> the screen already keeps
 * @param opts.notes      customer notes Map, keyed by matchKey (receiving hours live here)
 * @param opts.routeKey   the load/route this draft is for. The REAL name, not a placeholder:
 *                        the engine reads it for the truck-class curve and for the
 *                        appointment/owner/set-aside route rules, and a fake name would
 *                        quietly opt the draft out of all four.
 * @param opts.depot      { lat, lng }
 * @param opts.travel     useTravelInputs() payload, or null for the shipped curve
 * @param opts.departMin  when this truck rolls
 * @param opts.departureSource 'measured' | 'assumed' — carried through to the card, because
 *                        "2:10p against a measured 3:42a departure" and "2:10p against a
 *                        departure nobody has measured" are different claims and a router
 *                        deciding whether to believe it needs to know which.
 * @param opts.countCollapsed  read the stops behind a capped summary row too (default on; see
 *                        EVERY LATE STOP GETS ITS BADGE below). false is the old reading.
 */
export function routePreflight({
  order = [],
  stopById = new Map(),
  notes = new Map(),
  routeKey = 'DRAFT',
  servedDate = null,
  dayKey = null,
  depot = null,
  travel = null,
  departMin = DEFAULT_DEPART_MIN,
  departureSource = 'assumed',
  rosterRows = null,
  countCollapsed = true,
} = {}) {
  const ids = (Array.isArray(order) ? order : []).map((v) => String(v)).filter(Boolean);
  const lookup = stopById instanceof Map ? stopById : new Map();
  const depart = num(departMin) ?? DEFAULT_DEPART_MIN;

  const empty = {
    stops: [], late: [], lateCount: 0, hopelessCount: 0, worstTier: null,
    departure: { min: depart, source: departureSource === 'measured' ? 'measured' : 'assumed' },
    unjudged: { unresolved: 0, noCoords: 0, total: 0 },
    judged: 0, routeKey: String(routeKey ?? ''),
  };
  if (!ids.length || !hasCoords(depot)) return empty;

  // WHAT WE CAN AND CANNOT LOOK AT. Counted before anything else, because the summary is
  // only honest if it can say how much of the route it did not see.
  const judgeable = [];
  let unresolved = 0;
  let noCoords = 0;
  for (const id of ids) {
    const s = lookup.get(id);
    if (!s) { unresolved += 1; continue; }
    if (!hasCoords(s)) { noCoords += 1; continue; }
    judgeable.push(s);
  }
  const unjudged = { unresolved, noCoords, total: unresolved + noCoords };
  if (!judgeable.length) return { ...empty, unjudged };

  // THE SYNTHETIC BOARD. One route, the draft's order, everything else left exactly as the
  // real stop carries it — status, stamps, matchKey, businessName. A delivered stop stays
  // delivered (the engine skips it) and a stop that has already reported in still anchors
  // the chain, which is right: those are facts about this truck today, not artefacts of the
  // old sequence.
  const key = String(routeKey ?? '').trim() || 'DRAFT';
  const staged = judgeable.map((s, i) => ({ ...s, routeName: key, loadNbr: key, routeSeq: i + 1 }));

  const out = computeBoardFlags({
    stops: staged,
    notes,
    rosterRows,
    servedDate,
    dayKey,
    // NO nowMin. NOT AN OVERSIGHT — IT PRODUCES A CLEAN CARD FOR A LATE ROUTE.
    //
    // The board callers pass the clock so the yard rule can catch a route that has not moved
    // by mid-afternoon. A DRAFT has not moved by definition, and it has no driver until the
    // router assigns one — so with a clock past 7:00a the engine correctly reads it as a
    // driverless load, restarts the walk from NOON (NO_DRIVER_START_MIN) and, worse, R6
    // supersedes every hours_risk row with one no_driver_hours card ("one route, one card").
    //
    // Measured on a three-stop draft closing at 1:00p: with no clock the walk gives 8:20a,
    // 9:01a, 9:47a and nothing is late. With a 9:00a clock it gives 12:20p, 1:01p, 1:47p —
    // two stops past their close — and this module returns ZERO flags, because the rows it
    // reads have been replaced by a card about the missing driver. A route with two stops
    // going to miss would render as a clean build. That is the exact shape of failure this
    // whole feature exists to prevent, so the clock stays out.
    //
    // A truck that IS rolling is still handled: a stop carrying a real arrival stamp
    // re-anchors the chain from that stamp, which needs no clock at all.
    opts: {
      depot,
      departMin: depart,
      ...(travel ? { travel } : {}),
    },
  });

  // EVERY LATE STOP GETS ITS BADGE (Chad, 2026-09-30: "I see bugs one through three, and those
  // look like something I want to fix." — this is bug 2). The flag engine caps each rule and tier
  // for the PANEL: past 12 reds, 25 ambers or 40 criticals it folds the rows into ONE summary row
  // with stopNbr null and carries the stops behind it in collapsedRows. Reading only rows with a
  // stopNbr, this check dropped the whole batch: thirteen stops each 15 minutes past a typed close
  // showed NO late badge, and Time windows could make one more stop late to get a card past the
  // cap and report "0 late". The cap is about how many lines a panel can show, never about which
  // stops are late, so the constituents are read too — they carry every field read below.
  const flagByStop = new Map();
  for (const r of out.rows || []) {
    if (r?.rule !== 'hours_risk') continue;
    if (r.stopNbr != null) { flagByStop.set(String(r.stopNbr), r); continue; }
    if (!countCollapsed || !Array.isArray(r.collapsedRows)) continue;
    for (const c of r.collapsedRows) {
      if (c?.stopNbr != null && !flagByStop.has(String(c.stopNbr))) flagByStop.set(String(c.stopNbr), c);
    }
  }

  const stops = staged.map((s, i) => {
    const id = String(s.stopNbr);
    const eta = out.etaByStop?.get?.(id) || null;
    const f = flagByStop.get(id) || null;
    const closeMin = f ? num(f.closeMin) : null;
    // The hopeless test runs only on a stop we already believe is late — asking it of a
    // stop that makes its window is answering a question nobody asked, and it is the only
    // part of this module that is not free.
    const earliest = f ? earliestArrivalMin(s, { depot, travel, departMin: depart }) : null;
    const hopeless = !!(f && closeMin != null && earliest != null && earliest > closeMin);
    return {
      stopNbr: id,
      seq: i + 1,
      customer: s.businessName || id,
      // ROUNDED HERE, ONCE. etaByStop carries the raw walk clock (500.1409…) while the flag
      // row rounds its own copy — so an unrounded ETA beside a rounded lateBy is two numbers
      // that do not add up on the same card. The card is not the place to learn that.
      etaMin: eta && num(eta.etaMin) != null ? Math.round(eta.etaMin) : null,
      errorMin: eta ? num(eta.errorMin) : null,
      anchored: eta ? !!eta.anchored : false,
      late: !!f,
      tier: f ? f.tier : null,
      lateBy: f ? num(f.lateBy) : null,
      closeMin,
      hoursTier: f ? f.hoursTier : null,
      // Only meaningful on a late stop; null elsewhere so nothing downstream can read a
      // reassuring "false" as "we checked and it is reachable".
      hopeless: f ? hopeless : null,
      earliestMin: f ? earliest : null,
    };
  });

  const late = stops.filter((s) => s.late);
  const rank = { critical: 3, red: 2, amber: 1 };
  let worstTier = null;
  for (const s of late) if (!worstTier || (rank[s.tier] || 0) > (rank[worstTier] || 0)) worstTier = s.tier;

  return {
    stops,
    late,
    lateCount: late.length,
    hopelessCount: late.filter((s) => s.hopeless === true).length,
    worstTier,
    departure: { min: depart, source: departureSource === 'measured' ? 'measured' : 'assumed' },
    unjudged,
    judged: judgeable.length,
    routeKey: key,
  };
}

// ── THE WORDS ON A STOP'S BADGE ──────────────────────────────────────────────
//
// Chad, 2026-09-28, once a can't-make row carried its hours on their own line (v1.85.1): "If
// there's not enough room on the can't make 12 p.m. line to put the amount of time it would be
// late, then I think I'd rather have the amount of time the system's going to think it's going to
// be late than the can't make it tag."
//
// So when the row already shows the hours (`lateOverCantMake` — the close is on the line above),
// an unreachable stop's badge says HOW LATE instead of "can't make 12:00p". The badge keeps its
// no-entry glyph and its "unreachable in any order" hover, so it still reads as unreachable. A row
// with no hours line keeps "can't make 12:00p", because there the close would be printed nowhere.
const durText = (m) => {
  const v = Math.abs(Math.round(Number(m) || 0));
  return v >= 60 ? `${Math.floor(v / 60)}h ${v % 60}m` : `${v}m`;
};
/**
 * PURE. The text on a stop's preflight badge, or null for a stop that makes its window.
 * @param v    one entry of routePreflight().stops
 * @param opts.lateOverCantMake  the row shows the hours on their own line
 */
export function preflightBadgeWords(v, { lateOverCantMake = false } = {}) {
  if (!v || !v.late) return null;
  const hasLate = v.lateBy != null && Number.isFinite(Number(v.lateBy));
  if (v.hopeless && !(lateOverCantMake && hasLate)) return `can’t make ${fmtMin(v.closeMin)}`;
  return `${durText(v.lateBy)} late`;
}

/** VITE_COMPARE_UNREACHABLE_LATE — house shape: default on, an off-word turns it off, anything
 *  malformed leaves it on. Off puts "can't make 12:00p" back on a row that shows its hours.
 *  Build-time, so flipping it is a redeploy. */
export function compareUnreachableLateEnabled(env) {
  const v = String(env?.VITE_COMPARE_UNREACHABLE_LATE ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** VITE_PREFLIGHT_COUNTS_EVERY_LATE_STOP — house shape: default on, an off-word (off/0/false/no)
 *  turns it off, anything malformed leaves it on. Off puts back the old reading, where a card with
 *  more late stops than the flag panel's cap showed none of them. It covers the card's badges and
 *  the Time windows re-sequence, which scores orders with this same check. Build-time, so flipping
 *  it is a redeploy. */
export function preflightCountsEveryLateStopEnabled(env) {
  const v = String(env?.VITE_PREFLIGHT_COUNTS_EVERY_LATE_STOP ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}
