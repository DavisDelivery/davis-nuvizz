// src/lib/board-flags.js — the Board Flags detector (PURE).
//
// Chad: "if it seems like a route might not make a particular set of receiving hours that are
// coded on the route or on the order, it has, like, a little red flag that pops up with a list
// of potential issues, on the top bar, that you need looking at closer."
//
// Every check here runs over data the browser already holds — the board stops, the customer
// notes, and (when the Routes panel has fetched it) the day's load roster. ZERO NuVizz calls,
// zero Google calls: the ETA model is the same free crow-flies×1.3 @ ~30 mph arithmetic the
// manual-reorder recompute already uses, and it is labelled as an estimate wherever it shows.
//
// The design rules that keep this from crying wolf (each one bought with a specific failure
// the design review found):
//   • A shared route NAME may not speak for a route. Two loads named STEVEN = the cheap feed
//     merges them into one phantom route, so every route-level check gates on resolveNameOwner:
//     cancelled-and-rebuilt (one live) judges normally; two LIVE loads = refuse + flag.
//   • No roster ⇒ route checks report "not checked", never "clean". The roster only rides
//     along when the Routes panel fetched it; this module NEVER causes a fetch.
//   • A saved pin override IS a location. The no-geocode check joins customer_notes.
//     location_override before judging, exactly like the map, so a pin the dispatcher already
//     fixed can never stay red.
//   • closed_days provenance is PER DAY, not the manual_overrides field lock: ticking one day
//     by hand must not promote every scanner-invented day to "dispatcher-set" red. Red only
//     when there is no scanner fingerprint (auto_matches pattern 'closed_<day>') for that day.
//   • Terminal freight is not a problem. DELIVERED / EXCEPTION / status 90/91/99/80 stops are
//     skipped — the driver already resolved them.
//   • Volume caps. A rule that would list more than its cap collapses to ONE summary row; the
//     badge number stays a number a person will actually read.
//
// Dismissal scoping (the caller persists; this module only stamps the keys):
//   scope 'standing'   → key omits the date; a dismissed standing condition (un-geocodable
//                        address, closed-day note) stays dismissed until its FACTS change,
//                        because the fingerprint hashes the facts.
//   scope 'occurrence' → key includes servedDate; clears itself at the next board day.

import { resolveNameOwner } from './route-status.js';
import { routeStopSeq } from './route-stop-line.js';
import { resolveLegMinutes, legKey } from './travel-model.js';
import {
  haversineMeters, ROUTE_ROAD_FACTOR, ROUTE_AVG_SPEED_MPS,
} from './routing-select.js';

// ── time + hours parsing ──────────────────────────────────────────────────────

// "08:00" / "8:00" / "8:00a" / "8:00 AM" / "14:30" → minutes since midnight; null when the
// text is not a clock time (free-text hours are NOT comparable and must never be guessed at).
export function parseClockMin(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(a|p)?\.?m?\.?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  if (m[3] === 'p' && h < 12) h += 12;
  if (m[3] === 'a' && h === 12) h = 0;
  return h * 60 + min;
}

export const fmtMin = (min) => {
  let h = Math.floor(min / 60) % 24; const m = Math.round(min % 60);
  const ap = h >= 12 ? 'p' : 'a'; h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')}${ap}`;
};

// A note's receiving window for one day key, with its trust tier.
//   { closeMin, openMin, tier: 'typed' | 'auto' } — or null when nothing comparable exists
//   (no note, no hours that day, or free-text hours we refuse to regex-guess).
// Tier: 'typed' only when the dispatcher has taken ownership of the hours field
// (manual_overrides.receiving_hours). Auto-scanner hours are advisory — the scanner copies one
// found range to all seven days and "DELIVER BY 2PM" invents a 6:00 opening — so they can
// inform an amber row but never a red one.
export function dayReceivingWindow(note, dayKey) {
  if (!note || !dayKey) return null;
  const v = note.receiving_hours?.[dayKey];
  if (!v) return null;
  if (typeof v === 'string') {
    // Legacy M2.x docs store a per-day RANGE string ("6AM-2PM", "8 - 5"). The UI's clock
    // badge lights for these, so the detector must read them too or a customer with real
    // hours on file silently never flags. The refusal rules matter as much as the parse:
    // BOTH halves must read as clock times ("noon-5" and "24-7" are free text, and free
    // text is never guessed at), and a close that lands at or before the open is only
    // rescued by the "8-5" business-hours convention when it carries NO meridiem — an
    // explicit overnight window ("9PM-5AM") is not comparable to a daytime route and is
    // refused rather than silently flipped 12 hours. A bare time stays close-only.
    const m = v.match(/^(.+?)\s*(?:-|–|—|to)\s*(.+)$/i);
    if (m) {
      const openMin = parseClockMin(m[1]);
      let closeMin = parseClockMin(m[2]);
      if (openMin == null || closeMin == null) return null;
      if (closeMin <= openMin) {
        const closeHasMeridiem = /[ap]\.?m?\.?\s*$/i.test(m[2]);
        if (closeHasMeridiem || closeMin >= 720) return null; // overnight dock — refuse
        closeMin += 720; // "8-5" = 8:00a–5:00p
      }
      return { openMin, closeMin, tier: tierOfHours(note) };
    }
    const one = parseClockMin(v);
    return one == null ? null : { openMin: null, closeMin: one, tier: tierOfHours(note) };
  }
  const closeMin = parseClockMin(v.close);
  if (closeMin == null) return null;
  const openMin = parseClockMin(v.open);
  // THE SAME REFUSAL THE STRING BRANCH ALREADY MAKES, and it belongs here too. The two
  // `<input type="time">` boxes on the stop card write this object shape, so a dispatcher
  // typing a real overnight dock (21:00–05:00) or a 24-hour dock (00:00–00:00) produced a
  // window whose close lands BEFORE its open — and because a typed window is tier 'typed',
  // severityTier makes any predicted overrun at least RED. Every stop at that customer then
  // carried a 5:00a (or midnight) deadline it could never meet, in the loudest tier, from a
  // dispatcher doing nothing but recording the truth. An overnight dock is not comparable to
  // a daytime route; saying "no comparable window" is the honest answer, exactly as the
  // string branch decided for "9PM-5AM".
  if (openMin != null && closeMin <= openMin) return null;
  return { openMin, closeMin, tier: tierOfHours(note) };
}
const tierOfHours = (note) => (note?.manual_overrides?.receiving_hours === true ? 'typed' : 'auto');

// Per-day closed provenance. Red needs BOTH the field lock (a human has touched closed days)
// AND the absence of a scanner fingerprint for THIS day — the lock alone is not per-day
// evidence (it retroactively covers every day the scanner ever invented).
export function closedDayTier(note, dayKey) {
  if (!note || !dayKey) return null;
  const days = Array.isArray(note.closed_days) ? note.closed_days : [];
  if (!days.includes(dayKey)) return null;
  const prints = note.auto_matches?.closed_days || [];
  const scannerSetThisDay = prints.some((p) => String(p?.pattern ?? '') === `closed_${dayKey}`);
  const humanTouched = note.manual_overrides?.closed_days === true;
  return humanTouched && !scannerSetThisDay ? 'typed' : 'auto';
}

// ── real arrival stamps: the anchor ───────────────────────────────────────────

// The stamps are NAIVE ET wall-clock ("YYYY-MM-DDTHH:MM") carrying NO offset. Handing one
// to Date + timeZone reads 4-5 hours early and rolls a pre-dawn delivery to the previous
// DAY — the trap parseNaiveStamp documents in lib/customer-comms.mts. So this reads the
// digits directly and never constructs a Date. Returns minutes past midnight, or null.
export function stampMinutes(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v ?? ''));
  if (!m) return null;
  const hh = Number(m[4]), mm = Number(m[5]);
  return Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : null;
}

// What the truck ACTUALLY did at this stop, and WHICH kind of stamp said so — the two are
// not interchangeable and treating them as one double-counts the dwell:
//   arrival   → the truck is ON SITE and the service time is still ahead of it.
//   delivered → the service is already DONE, so the truck leaves at that moment.
// A stamp dated to another day is refused: a board can carry a stop re-dated from
// yesterday, and yesterday's arrival says nothing about where this truck is now.
export function arrivalAnchor(s, servedDate) {
  for (const [field, source] of [['arrivalDTTM', 'arrival'], ['deliveredDTTM', 'delivered']]) {
    const v = s?.[field];
    if (!v) continue;
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
    if (servedDate && day && day[1] !== servedDate) continue;
    const min = stampMinutes(v);
    if (min != null) return { min, source };
  }
  return null;
}

// THE PER-STOP COST, MEASURED RATHER THAN ASSUMED.
//
// The flag model used the routing engine's DEFAULT_SERVICE_SEC (20 min). That constant is
// for PLANNING a route — a deliberately conservative allowance — and it is not what a stop
// actually costs. Chad, on the proposal to feed the model learned dwell times: "the vast
// majority of deliveries show an arrival time and departure time that are less than 120
// seconds apart... the driver performs the actual delivery before ever clicking arrive at
// stop." He was right that arrive→deliver is not a usable dwell signal — and the warehouse
// makes it moot: arrivalDTTM is present on 8 stops out of 20,904, so there is no bracket to
// measure and routing_service_times (which mines exactly that bracket) cannot be trusted here.
//
// What CAN be measured is the residual between consecutive real delivery stamps, minus the
// modelled travel. That is dwell plus travel error, and the two look identical in aggregate —
// but not against distance. Dwell is a fixed cost per stop and stays flat as legs lengthen;
// a travel model running short scales with the leg. Over 32 sealed days the residual is
// FLAT — 10.9 min under a mile, 15.8 min at 3-8 miles, 13.7 min over 20 — so it is a real
// per-stop cost, not a travel-model artefact.
//
// Sweeping it against the anchored walk agrees. Mean bias by assumed per-stop cost:
//     0 min -> -14.3   (what v0.55.0 shipped for a delivered stamp)
//     8 min ->  -7.0
//    13 min ->  -2.1
//    15 min ->  -0.2
//    20 min ->  +4.0   (the planning default)
// 14 minutes sits at the bias-zero crossing and the |error| minimum, and moving there from
// zero lifts within-15-minutes from 41% to 52% and cuts the median miss from 18.9 to 14.3.
//
// Why this matters more than the accuracy: at 0 the model is systematically 14 minutes
// OPTIMISTIC, and for a deadline flag optimism is the dangerous direction — it is the model
// quietly deciding a late truck is fine. Kept separate from DEFAULT_SERVICE_SEC so tuning
// the flag never silently re-plans routes.
const FLAG_SERVICE_SEC = 14 * 60;

// ── SEVERITY: HOW MUCH SLACK IS LEFT, NOT WHO TYPED THE HOURS ────────────────
//
// Until now a receiving-hours flag was red if a dispatcher had typed the hours and amber if
// they were parsed out of Uline's order text. That is a statement about PROVENANCE, and it
// says nothing about whether freight is about to be refused. On Chad's board it produced a
// header reading "0 red - 6 advisory" while carrying a stop predicted 155 minutes past its
// close, sitting at the same weight as one predicted 28 minutes past.
//
// Severity now comes from SLACK measured against how wrong the estimate is KNOWN to be in
// the state it was produced in. That second half matters: the same "30 minutes late" is
// near-worthless at 6am off an assumed 8:00 departure and is worth acting on at 11am
// projected from a stamp two stops ago. The back-test measured both states over 39 sealed
// days, 24,238 stops:
//
//   anchored on a real arrival, 1-2 stops out ... median |error| ~15 min
//   anchored, further down the chain ........... error grows with each projected hop
//   never anchored (pure 8:00 projection) ...... median |error| ~96-128 min
//
// So each row carries the typical error for its own state, and lateness is judged against
// it. A row only reaches the top tier when the overrun clears TWICE that band — i.e. the
// miss survives the model being as wrong as it usually is.
export const MODEL_ERROR_MIN = { anchored: 15, anchoredFar: 25, anchoredDistant: 40, unanchored: 90 };

export function modelErrorMinutes({ anchored, hops }) {
  if (!anchored) return MODEL_ERROR_MIN.unanchored;
  if (hops <= 2) return MODEL_ERROR_MIN.anchored;
  if (hops <= 5) return MODEL_ERROR_MIN.anchoredFar;
  return MODEL_ERROR_MIN.anchoredDistant;
}

/**
 * The tier for a predicted receiving-hours overrun.
 *
 * critical — the overrun clears twice the model's typical error. We are confident this stop
 *            misses even allowing for the model being as wrong as it usually is. This is the
 *            tier Chad asked for: "a high priority flag that is even more prominent."
 * red      — the overrun clears the error band once, OR the hours were typed by a dispatcher
 *            and the stop is predicted late at all. Typed hours keep their weight: a human
 *            put that deadline on the record, so any predicted overrun against it is real
 *            enough to look at.
 * amber    — predicted late, but inside the error bars. Worth showing, not worth waking
 *            anyone: at this distance the model simply cannot tell late from on-time.
 *
 * Auto-detected hours can still reach critical. A truck 155 minutes past a close is a
 * problem whether the 11:00 came from a dispatcher or from Uline's order text — and refusing
 * to escalate it because of where the text came from is the exact defect being fixed.
 */
export function severityTier({ lateBy, errorMin, hoursTier }) {
  if (lateBy > errorMin * 2) return 'critical';
  if (lateBy > errorMin) return 'red';
  if (hoursTier === 'typed') return 'red';
  return 'amber';
}

// ── stop-level helpers ────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['DELIVERED', 'EXCEPTION']);
const TERMINAL_CODES = new Set(['90', '91', '99', '80']);
export function isFinishedStop(s) {
  if (s?.deliveredDTTM) return true;
  if (TERMINAL_STATUSES.has(String(s?.normalizedStatus ?? ''))) return true;
  return TERMINAL_CODES.has(String(s?.status ?? '').trim());
}

// Evidence the route's truck is MOVING: any finished stop, an on-site arrival stamp, or an
// out-for-delivery/arrived status ('40'/'50'). Used only to decide whether the hours model
// may re-anchor a route's departure to "now" — a rolling truck must never be told it
// hasn't left just because its first POD hasn't posted.
const ROLLING_STATUSES = new Set(['OUT_FOR_DEL', 'ARRIVED']);
const ROLLING_CODES = new Set(['40', '50']);
export function isRollingEvidence(s) {
  if (isFinishedStop(s)) return true;
  if (s?.arrivalDTTM) return true;
  if (ROLLING_STATUSES.has(String(s?.normalizedStatus ?? ''))) return true;
  return ROLLING_CODES.has(String(s?.status ?? '').trim());
}

const numOr = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };

// The stop's judged position: the dispatcher's saved pin override outranks the feed's geocode
// — the same precedence the map itself uses. A stop is only "un-located" when NEITHER exists.
export function stopPosition(s, note) {
  const ov = note?.location_override;
  const oLat = numOr(ov?.lat), oLng = numOr(ov?.lng);
  if (oLat != null && oLng != null) return { lat: oLat, lng: oLng, source: 'override' };
  const lat = numOr(s?.lat), lng = numOr(s?.lng);
  if (lat != null && lng != null) return { lat, lng, source: 'feed' };
  return null;
}

// Sequence + pickup detection go through the SAME accessor the route panel and the numbered
// map pins use (routeStopSeq: top-level routeSeq, then the raw feed's stop.to/from.seq, and
// pickups never wear a number). The detector used to read only the top-level field, so a
// board whose sequence lived in the raw shape showed numbered routes in the UI while every
// route here reported "no delivery sequence" — silently, because the chip hid itself too.
const seqOf = (s) => routeStopSeq(s).seq;
const isPickupStop = (s) => routeStopSeq(s).pickup;
const routeKeyOf = (s) => String(s?.loadNbr || s?.routeName || '').trim();

// APPOINTMENT ROUTES ARE NOT LATE — Chad: "dont put uline appt's in the flag as they are
// being held for appointments."
//
// ULINE APPT is a holding pen, not a truck. Freight sits on it precisely BECAUSE it cannot
// be delivered on a normal run — it is waiting on a scheduled appointment with the customer.
// Walking a delivery sequence down it and comparing the arrival estimate against receiving
// hours therefore measures nothing real: the route has no departure, the sequence is a
// filing order rather than a driving order, and "arrives 1:49a, 529 minutes late" is an
// arithmetic artefact of a stop that was never going out today. Same for the no-driver
// check — an appointment route has no driver because it is not being run, which is the
// normal state, not a problem to flag at 8am.
//
// Matched on the APPT/APPOINTMENT token with word boundaries rather than the literal string
// "ULINE APPT", so a future ESTES APPT or ULINE APPT 2 is covered the day it appears.
// Verified safe against three days of the real load roster (111 distinct route names):
// exactly one name carries the token, and no name contains "appt" inside another word, so
// the boundary match cannot silence a real route by accident.
const APPT_ROUTE_RE = /\b(?:APPTS?|APPOINTMENTS?)\b/i;

export function isAppointmentRoute(name) {
  return APPT_ROUTE_RE.test(String(name ?? ''));
}

// ── the detector ──────────────────────────────────────────────────────────────

export const RED_CAP = 12;    // per rule; beyond this a rule collapses to one summary row
export const AMBER_CAP = 25;
// A critical row is never collapsed away. The cap exists so a data-quality batch cannot bury
// the panel; a stop the model is CONFIDENT will miss its receiving window is the opposite of
// that, and there are only ever a handful. Ordering is critical, then red, then amber.
export const CRITICAL_CAP = 40;
export const TIER_ORDER = { critical: 0, red: 1, amber: 2 };
// Severity as a LADDER, worst highest. TIER_ORDER sorts for display and reads the other
// way; a dismissal has to compare "is this worse than what I waved off", so it needs a
// scale that grows with the trouble rather than one that grows with the list position.
export const TIER_RANK = { amber: 1, red: 2, critical: 3 };

/**
 * PURE: derive the day's flag rows from what the browser already holds.
 *
 * @param stops       board stops for the served day (client rows)
 * @param notes       Map<matchKey, customer_note>
 * @param rosterRows  raw day-loads roster rows [{loadId,name,loadNbr,status}] — or null when
 *                    the Routes panel has not fetched it (route checks then report skipped)
 * @param servedDate  'YYYY-MM-DD' — the board day being LOOKED AT (never stop.boardDate,
 *                    which carry-over folding can leave stale)
 * @param opts        { departMin?: number (default 480 = 8:00a), serviceSec?, nowMin? }
 */
export function computeBoardFlags({ stops = [], notes = new Map(), rosterRows = null, servedDate = null, dayKey = null, opts = {} } = {}) {
  const day = dayKey || null;
  const departMin = Number.isFinite(opts.departMin) ? opts.departMin : 8 * 60;
  // How legs turn into minutes. { legs: {legKey: seconds} — real cached drive times,
  // curve: distance-tiered speed control points, serviceMin: measured stop dwell,
  // routeClasses: {routeKey: 'tractor'|'box'}, classCurves / classService: per-truck-class
  // refinements }. Absent entirely, the tiered DEFAULT_CURVE still applies — the flat
  // ~30 mph model is gone even for callers that pass nothing.
  const travel = opts.travel || null;
  // Per-route measured departures: { routeKey: minutes } or a lookup fn. Absent entirely,
  // every route keeps departMin — the shipped behaviour, unchanged.
  const departFor = typeof opts.departByRoute === 'function'
    ? opts.departByRoute
    : (() => {
        const t = opts.departByRoute && typeof opts.departByRoute === 'object' ? opts.departByRoute : null;
        if (!t) return () => null;
        const byKey = new Map();
        for (const [k, v] of Object.entries(t)) {
          const m = Number(v && typeof v === 'object' ? v.departMin : v);
          if (Number.isFinite(m)) byKey.set(String(k).trim().toLowerCase(), m);
        }
        return (k) => { const h = byKey.get(String(k ?? '').trim().toLowerCase()); return Number.isFinite(h) ? h : null; };
      })();
  // Service precedence: an explicit caller override, then the nightly-measured dwell,
  // then the shipped constant. Calibration refining the dwell must not need a deploy.
  const serviceSec = Number.isFinite(opts.serviceSec) ? opts.serviceSec
    : Number.isFinite(travel?.serviceMin) ? travel.serviceMin * 60
      : FLAG_SERVICE_SEC;
  // A ROUTE RUNS ON ITS OWN TRUCK'S CLOCK. Chad: tractor-trailers and box trucks "get
  // around town and deliveries very differently" — so a route whose driver the roster
  // knows gets that class's calibrated curve and dwell, hierarchically: class fit →
  // fleet fit → defaults. An unknown driver rides the fleet numbers, never a guess.
  const travelForRoute = (k) => {
    if (!travel) return { travel: null, serviceSec };
    const cls = travel.routeClasses ? travel.routeClasses[k] : null;
    const clsCurve = cls && travel.classCurves ? travel.classCurves[cls] : null;
    const clsService = cls && travel.classService ? travel.classService[cls] : null;
    return {
      travel: clsCurve ? { ...travel, curve: clsCurve } : travel,
      serviceSec: Number.isFinite(opts.serviceSec) ? opts.serviceSec
        : Number.isFinite(clsService) ? clsService * 60
          : serviceSec,
    };
  };
  const depot = opts.depot || null;

  const open = stops.filter((s) => !isFinishedStop(s));
  const noteOf = (s) => (s?.matchKey ? notes.get(s.matchKey) : null) || null;
  const rows = [];
  const skipped = { noRoster: false, ambiguousRoutes: [], routesNoSequence: [], routesAppointment: [], stopsNoPosition: 0 };
  // What the detector actually LOOKED at — the panel shows these so a quiet board can
  // prove it was watched, and so "no hours on file" is visibly a data gap, not a bug.
  const checked = { stops: open.length, routesJudged: 0, stopsWithHours: 0, legsTotal: 0, legsGoogle: 0 };
  // Every leg the walk crosses, keyed and positioned, so the server sweep can prefetch
  // real drive times for exactly these pairs next pass. Deduped; order irrelevant.
  const legsWanted = new Map();
  // Predicted arrival per stop, from the SAME walk that decides the flags. Consumed by the
  // route-detail card so a dispatcher reads our ETA instead of a shared appointment window.
  const etaByStop = new Map();
  if (day) for (const s of open) { if (dayReceivingWindow(noteOf(s), day)) checked.stopsWithHours += 1; }

  // R1 — two NuVizz orders under one stop number (the Estes twin). Proof, not a guess: the
  // scan flags this only when record ids differ. Occurrence-scoped: cleaning the portal
  // clears it on the next scan anyway.
  for (const s of open) {
    if (s.dupNbr || s.dupNbrSuspect) {
      rows.push(row('red', 'dup_number', s, {
        title: `2 orders share number ${s.stopNbr}`,
        detail: `${s.businessName || 'This stop'} — NuVizz holds two records under this number; edits and portal searches can hit the wrong one. Cancel or renumber the extra entry in the portal.`,
        scope: 'occurrence', servedDate, fingerprint: `dup|${s.stopNbr}|${s.dupNbrOtherId || ''}`,
      }));
    }
  }

  // R2 — no map location. Judged AFTER the pin-override join; standing-scoped and
  // fingerprinted by the address text, so fixing the address genuinely retires the row.
  for (const s of open) {
    if (!stopPosition(s, noteOf(s))) {
      skipped.stopsNoPosition += 1;
      rows.push(row('red', 'no_location', s, {
        title: `No map location — ${s.businessName || s.stopNbr}`,
        detail: `"${[s.addr1, s.city].filter(Boolean).join(', ')}" never geocoded — this stop cannot be lasso-selected or routed by the map and is easy to miss. Fix the address on the card, or drag a pin with "Correct pin location".`,
        scope: 'standing', servedDate, fingerprint: `noloc|${s.matchKey || s.stopNbr}|${s.addr1 || ''}`,
      }));
    }
  }

  // R3 — two LIVE loads share one route name. Cancel-and-rebuild (Chad: "only time it
  // happens" — one cancelled + one live) resolves cleanly and never flags; a genuine
  // ambiguity poisons every by-name path, so it is the rarest and most serious flag here.
  let ambiguousNames = new Set();
  if (Array.isArray(rosterRows) && rosterRows.length) {
    const names = [...new Set(rosterRows.map((l) => String(l?.name ?? '').trim()).filter(Boolean))];
    for (const nm of names) {
      const { ambiguous } = resolveNameOwner(nm, rosterRows);
      if (ambiguous) ambiguousNames.add(nm.toLowerCase());
    }
    const onBoard = new Set(open.map((s) => routeKeyOf(s).toLowerCase()));
    for (const nm of ambiguousNames) {
      if (!onBoard.has(nm)) continue;
      skipped.ambiguousRoutes.push(nm);
      rows.push(row('red', 'route_name_ambiguous', null, {
        title: `2 live loads named "${nm.toUpperCase()}"`,
        detail: 'Two un-cancelled loads carry this name today, so the board may be merging two trucks into one route — and saves, assigns and the checks below refuse to guess between them. Rename one in the portal.',
        scope: 'occurrence', servedDate, fingerprint: `ambname|${servedDate}|${nm}`,
      }));
    }
  } else {
    skipped.noRoster = true; // route-level checks report "not checked", never "clean"
  }

  // R4 — delivering to a customer recorded closed that weekday. Tier decides red vs amber.
  for (const s of open) {
    const note = noteOf(s);
    const tier = closedDayTier(note, day);
    if (!tier) continue;
    const prints = (note.auto_matches?.closed_days || []).filter((p) => String(p?.pattern ?? '') === `closed_${day}`);
    rows.push(row(tier === 'typed' ? 'red' : 'amber', 'closed_today', s, {
      title: `Closed ${day?.toUpperCase()} — ${s.businessName || s.stopNbr}`,
      detail: tier === 'typed'
        ? 'This customer\'s notes say they are closed on this weekday (dispatcher-recorded). Move the date or call the customer.'
        : `The text scanner recorded this closed day${prints[0]?.text ? ` from order text: "${prints[0].text}"` : ''} — judge the evidence, then confirm with the customer or dismiss.`,
      scope: 'standing', servedDate, fingerprint: `closed|${s.matchKey || s.stopNbr}|${day}|${tier}`,
    }));
  }

  // R5 — Chad's check: a route sequenced so late it lands after the customer stops receiving.
  // HONESTY RULES: there is no per-stop ETA on the cheap feed, so the arrival is OUR estimate
  // (depart + crow-flies×1.3 @ ~30 mph + service time per prior stop) and every row says so.
  // Typed hours can go red; scanner-guessed hours only ever amber; free-text hours are not
  // comparable and are skipped. A route where most stops carry no sequence is not judged.
  // The clock is honest about the real day too: a route with no sign of movement cannot
  // depart in the past, so its chain starts at max(depart, now) — the "it's noon and JOE
  // hasn't left" case used to simulate an 8:00a departure and conclude everything was fine.
  // "Sign of movement" is EVIDENCE, not inference: a delivery, an exception, an arrival
  // stamp, or an out-for-delivery/arrived status all mean the truck is rolling even when
  // no POD has posted yet — re-anchoring a rolling route to "now" manufactured lateness.
  // The grace hour after departure covers the every-morning gap where a truck that left
  // on time simply hasn't reached its first stop's scanner.
  const nowMin = Number.isFinite(opts.nowMin) ? opts.nowMin : null;
  const NOT_STARTED_GRACE_MIN = 60;
  if (day && depot) {
    const startedRoutes = new Set();
    for (const s of stops) {
      if (!isRollingEvidence(s)) continue;
      const k = routeKeyOf(s);
      if (k) startedRoutes.add(k);
    }
    const byRoute = new Map();
    const apptRoutes = new Set();
    for (const s of open) {
      const k = routeKeyOf(s);
      if (!k || ambiguousNames.has(k.toLowerCase())) continue; // never judge a phantom route
      // Appointment routes are excluded HERE, at the one place both the arrival walk (R5)
      // and the no-driver check (R6) read from — so neither rule can fire on freight that
      // is deliberately parked waiting on a customer appointment.
      if (isAppointmentRoute(k)) { apptRoutes.add(k); continue; }
      if (!byRoute.has(k)) byRoute.set(k, []);
      byRoute.get(k).push(s);
    }
    // THE FULL SEQUENCED CHAIN, finished stops INCLUDED. R5 walks this rather than the open
    // set. A completed stop is the best information we have about where the truck actually
    // is; dropping it deleted its leg AND its service block from the front of the chain
    // while the clock stayed pinned to the 8:00 departure, so every remaining ETA walked
    // BACKWARDS as the day ran and a red flag was quietly withdrawn exactly when lateness
    // became real. Route SELECTION and R6 still read `byRoute` (open only) — unchanged.
    const chainByRoute = new Map();
    for (const s of stops) {
      const k = routeKeyOf(s);
      if (!k || ambiguousNames.has(k.toLowerCase())) continue;
      if (isAppointmentRoute(k)) continue;
      if (!chainByRoute.has(k)) chainByRoute.set(k, []);
      chainByRoute.get(k).push(s);
    }
    // Say what was set aside rather than quietly narrowing the sweep — the panel's footer
    // reports it, so "why is ULINE APPT never flagged" has a visible answer.
    for (const k of apptRoutes) skipped.routesAppointment.push(k);
    // R5's arrival flags, kept per route so R6 can supersede them — see the note there.
    const hoursRowsByRoute = new Map();
    for (const [k, openGroup] of byRoute) {
      // Judged over the full chain; only OPEN stops can raise a row (a delivered stop has
      // no deadline left to miss). openGroup still decides WHICH routes are looked at.
      const group = chainByRoute.get(k) || openGroup;
      const deliveries = group.filter((s) => !isPickupStop(s));
      const seqd = deliveries.filter((s) => seqOf(s) != null);
      // Judge against DELIVERIES only: pickups never carry a usable sequence (their
      // Display-Seq is the terminal's slot), so counting them in the denominator used
      // to skip any route where pickups were >30% of the stops.
      if (!seqd.length || seqd.length < deliveries.length * 0.7) {
        if (group.length > 1) skipped.routesNoSequence.push(k);
        continue; // an invented order would produce confident wrong answers
      }
      seqd.sort((a, b) => seqOf(a) - seqOf(b));
      // Collapse duplicate board rows of the SAME physical visit (a multi-order customer
      // arrives as one row per order, all sharing the sequence slot) before walking. Each
      // extra row added a phantom service block — inflating every later ETA on the route —
      // and emitted its own copy of the flag (Chad's screenshot: Subaru flagged at 1:06p,
      // 1:26p AND 1:46p, exactly one service-time apart). One visit, one clock, one flag.
      const visitSeen = new Set();
      // The rows behind each visit. A multi-order customer is ONE physical arrival spread
      // over several board rows; the walk prices it once, and every row of it shares that
      // arrival — otherwise the duplicates would show no ETA at all on the route card.
      const rowsOfVisit = new Map();
      const visits = seqd.filter((s) => {
        const vk = `${seqOf(s)}|${String(s.matchKey || s.businessName || s.stopNbr || '').toLowerCase()}`;
        if (!rowsOfVisit.has(vk)) rowsOfVisit.set(vk, []);
        rowsOfVisit.get(vk).push(s);
        s.__visitKey = vk;
        if (visitSeen.has(vk)) return false;
        visitSeen.add(vk);
        return true;
      });
      // WHEN THIS ROUTE ACTUALLY LEAVES. The 8:00a default is a fair guess for the MIDDLE
      // of the fleet (measured median 08:23) and badly wrong in the tails (p10 05:46, p90
      // 13:50) — and overnight, with no stamps to correct it, the tails are where the
      // texts come from. A route with enough clean days of history carries its own
      // measured departure; everything else keeps the default. See lib/route-departure.
      const learnedDepart = departFor(k);
      const routeDepart = learnedDepart != null ? learnedDepart : departMin;
      const notStarted = !startedRoutes.has(k) && nowMin != null && nowMin > routeDepart + NOT_STARTED_GRACE_MIN;
      const effDepart = notStarted ? nowMin : routeDepart;
      const rt = travelForRoute(k);
      let cur = depot; let clockMin = effDepart; let chainBroken = false;
      // Where the clock is currently running from, for the row's detail line. It starts as
      // the assumed departure and is replaced the moment a real stamp anchors the chain —
      // so the dispatcher can see whether the estimate rests on an assumption or on a truck.
      // The wording carries the PROVENANCE of the departure, because "departs 8:00a" and
      // "departs 3:42a (measured)" are different claims and a dispatcher deciding whether
      // to trust a 2am text needs to know which one the estimate rests on.
      let anchorNote = notStarted
        ? `no movement yet, clock runs from ${fmtMin(nowMin)}`
        : `departs ${fmtMin(effDepart)}${learnedDepart != null ? ' (measured)' : ' (assumed)'}`;
      // Anchor state drives SEVERITY, not just the wording: an estimate projected from a real
      // stamp two stops back is a different quality of evidence from one projected from an
      // assumed departure six hours ago, and the tier has to know which it is holding.
      let anchored = false;
      let hopsSinceAnchor = 0;
      for (const s of visits) {
        const pos = stopPosition(s, noteOf(s));
        // A MISSING PIN NO LONGER HAS TO END THE ROUTE. It used to, and that was right when
        // the walk only ever saw OPEN stops: with no position there is no leg, so the rest
        // of the chain was guesswork. But the chain now carries FINISHED stops too, and a
        // delivered stop that never got a pin would abandon a route that judged fine
        // yesterday — the change would have QUIETLY REDUCED flag coverage while appearing
        // to improve the model. When such a stop carries a real stamp we lose only its leg
        // length, not our grip on the clock: anchor on the stamp and keep walking. The
        // chain still breaks honestly when there is neither a position nor a stamp.
        const stamplessGap = !pos && !arrivalAnchor(s, servedDate);
        if (stamplessGap) { chainBroken = true; break; }
        if (pos) {
          // THE LEG. A cached real drive time when the sweep has one for this pair;
          // the distance-tiered curve otherwise. Never the old flat ~30 mph — a flat
          // speed understates town legs and overstates highway ones, in both cases at
          // the stops where being wrong costs a delivery.
          const lk = legKey(cur, pos);
          if (!legsWanted.has(lk)) legsWanted.set(lk, { key: lk, a: { lat: cur.lat, lng: cur.lng }, b: { lat: pos.lat, lng: pos.lng } });
          const leg = resolveLegMinutes(cur, pos, haversineMeters(cur, pos), rt.travel);
          clockMin += leg.min;
          checked.legsTotal += 1;
          if (leg.source === 'google') checked.legsGoogle += 1;
        }
        hopsSinceAnchor += 1;
        // A TRUCK CANNOT ARRIVE IN THE PAST.
        //
        // The clock is re-anchored on every real stamp, which is what makes it accurate —
        // and it was trusted no matter how OLD that stamp was. A route whose last POD is
        // 9:30 and which then stalls (a long dock wait, a breakdown, lunch) kept projecting
        // its remaining stops at 9:45, 10:05, 10:25 while the wall clock read 12:45, so
        // `clockMin > closeMin` stayed false against a typed 1:00p close and the board
        // showed NOTHING. The failure is silent in the worst direction: the model produces
        // fewer flags, and a clean board looks like a good day. Chad asked for this exact
        // case — the alert "could come later in day if a driver gets behind".
        //
        // The route-level `notStarted` clamp already encodes this reasoning for the
        // DEPARTURE ("a route with no sign of movement cannot depart in the past"); this is
        // the same rule applied per stop. Only for stops nobody has reported arriving at:
        // a stop with its own stamp already happened, and clamping that would be a lie in
        // the other direction.
        const ownAnchor = arrivalAnchor(s, servedDate);
        if (nowMin != null && !ownAnchor && !isFinishedStop(s)) clockMin = Math.max(clockMin, nowMin);
        // WHAT THE WALK ALREADY KNOWS, WRITTEN DOWN. The route card used to print NuVizz's
        // shared saved-search window ("appt 8:00 AM" on every stop of a load, which no route
        // ever runs). This is the same clock the flags are judged on — recorded, never
        // re-derived, so the card and the flag can never disagree about an arrival.
        // Recorded BEFORE the service block and BEFORE the anchor, so it is the predicted
        // ARRIVAL at this stop rather than the departure from it.
        for (const row of rowsOfVisit.get(s.__visitKey) || [s]) {
          if (row?.stopNbr == null) continue;
          etaByStop.set(String(row.stopNbr), {
            etaMin: clockMin,
            anchored,
            hops: hopsSinceAnchor,
            routeKey: k,
            // The model's own error band at this point in the chain — an estimate six hops
            // past the last real stamp is a different promise from one anchored next door,
            // and the card is entitled to say so.
            errorMin: modelErrorMinutes({ anchored, hops: hopsSinceAnchor }),
          });
        }
        const finished = isFinishedStop(s);
        const w = finished ? null : dayReceivingWindow(noteOf(s), day);
        if (w && clockMin > w.closeMin) {
          const lateBy = Math.round(clockMin - w.closeMin);
          const errorMin = modelErrorMinutes({ anchored, hops: hopsSinceAnchor });
          const tier = severityTier({ lateBy, errorMin, hoursTier: w.tier });
          const hoursRow = row(tier, 'hours_risk', s, {
            // Machine-readable facts alongside the human sentence: the alert path must not
            // have to parse the detail string to know when the window shuts.
            lateBy, errorMin, anchored,
            closeMin: w.closeMin, etaMin: Math.round(clockMin),
            customer: s.businessName || s.stopNbr || null,
            title: `May miss receiving hours — ${s.businessName || s.stopNbr}`,
            // Facts only, one breath (Chad, Aug 12: "fotmatting issues" — every card carried
            // four lines of identical boilerplate and the panel read as a wall of text).
            // The model disclaimer lives ONCE in the panel footer; "estimated" on the number
            // keeps the row honest; the auto-detected caveat is four words, not two sentences.
            detail: `Stop ${seqOf(s)} on ${k} — estimated arrival ~${fmtMin(clockMin)} vs close ${fmtMin(w.closeMin)} (${lateBy} min late); ${anchorNote}.${w.tier === 'auto' ? ' Hours auto-detected — verify.' : ''}`,
            scope: 'occurrence', servedDate, fingerprint: `hours|${servedDate}|${k}|${s.stopNbr}|${w.closeMin}`,
          });
          rows.push(hoursRow);
          if (!hoursRowsByRoute.has(k)) hoursRowsByRoute.set(k, []);
          hoursRowsByRoute.get(k).push(hoursRow);
        }
        // THE ANCHOR. Once this stop reports in, the clock stops being a projection and
        // becomes a measurement — and everything after it is projected from where the truck
        // REALLY was, not from an assumption made at 8:00 this morning. Applied AFTER the
        // row above, so a stop is never judged using its own answer.
        //
        // The two stamp kinds are not interchangeable: an arrival means the truck is on
        // site with the dwell still ahead of it, a delivered means the dwell already
        // happened. Adding service to a delivered stamp would count the dwell twice.
        //
        // An out-of-sequence stamp is trusted rather than clamped. Stops do get delivered
        // out of order, and when they do the stamp is still the truth about where the truck
        // is — refusing it to keep the clock monotonic would throw away the better answer.
        const anchor = ownAnchor;
        if (anchor) {
          clockMin = anchor.source === 'delivered' ? anchor.min : anchor.min + rt.serviceSec / 60;
          anchored = true;
          hopsSinceAnchor = 0;
          anchorNote = `from ${s.businessName || `stop ${seqOf(s)}`}'s ${fmtMin(anchor.min)} ${anchor.source === 'delivered' ? 'delivery' : 'arrival'}`;
        } else {
          clockMin += rt.serviceSec / 60;
        }
        if (pos) cur = pos;   // an unpinned stop leaves the last known position standing
      }
      // A chain-broken route was NOT judged — counting it would make the panel claim
      // "1 route judged" and "1 route not judged" about the same truck in one breath.
      if (chainBroken) skipped.routesNoSequence.push(`${k} (missing pin)`);
      else checked.routesJudged += 1;
    }

    // R6 — Chad's LVILLE case: "lund needs to be delivered by 2pm and there isn't even a
    // driver assigned to it". The ETA walk above cannot see this — at 9:24a even a
    // re-anchored clock lands mid-morning, hours before a 2:00p close — but a route that
    // is PAST its scheduled departure, shows no movement, carries a receiving close today
    // and has NO driver assigned is a problem right now, not at 1:30p when the arrival
    // math finally crosses the line. Facts only: driver assignment and hours are both
    // read straight off the board; the only estimate here is none at all. Today-board
    // only (nowMin present) — a tomorrow route without a driver yet is just tomorrow.
    if (nowMin != null && nowMin >= departMin) {
      for (const [k, group] of byRoute) {
        if (startedRoutes.has(k)) continue; // moving freight implies a driver, whatever the feed says
        const hasDriver = group.some((s) => String(s?.driverName || s?.driverUserName || '').trim());
        if (hasDriver) continue;
        // Same physical-visit collapse as the ETA walk: a 3-order customer is ONE stop
        // with hours, not three — "has 3 stops with receiving hours" overstated the load.
        const cSeen = new Set();
        const constrained = group
          .filter((s) => {
            const vk = String(s.matchKey || s.businessName || s.stopNbr || '').toLowerCase();
            if (cSeen.has(vk)) return false;
            cSeen.add(vk);
            return true;
          })
          .map((s) => ({ s, w: dayReceivingWindow(noteOf(s), day) }))
          .filter((x) => x.w);
        if (!constrained.length) continue;
        constrained.sort((a, b) => a.w.closeMin - b.w.closeMin);
        const first = constrained[0];
        // WHAT R5 ALREADY FOUND ON THIS ROUTE, read BEFORE the card is built — because the
        // supersede below deletes those rows, and deleting them used to delete their
        // SEVERITY with them. R6's own tier comes from provenance alone (typed hours → red,
        // auto → amber) and never calls severityTier, so a driverless route carrying five
        // stops predicted 200+ minutes past an auto-detected close collapsed to ONE amber:
        // critical 0, red 0, and — since selectAlertable only reads hours_risk rows with a
        // stopNbr — customer service heard nothing about the worst route on the board.
        // Removing the driver made the situation strictly worse and the board strictly calmer.
        const supersededRows = hoursRowsByRoute.get(k) || [];
        const worstHours = supersededRows.length
          ? [...supersededRows].sort((a, b) =>
            ((TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9)) || ((b.lateBy || 0) - (a.lateBy || 0)))[0]
          : null;
        const ownTier = constrained.some((x) => x.w.tier === 'typed') ? 'red' : 'amber';
        // The louder of the two. A card that replaces a critical has to be a critical.
        const tier = worstHours && (TIER_ORDER[worstHours.tier] ?? 9) < (TIER_ORDER[ownTier] ?? 9)
          ? worstHours.tier
          : ownTier;
        rows.push(row(tier, 'no_driver_hours', first.s, {
          // The alert path needs a real stop to claim and a close to check against. When R6
          // supersedes a genuine arrival row, it inherits that row's facts so the message
          // can be sent — with the BETTER reason (nobody is driving) rather than the vaguer
          // one it replaced. With nothing superseded these stay absent and the card is
          // screen-only, exactly as before.
          ...(worstHours ? {
            customer: worstHours.customer || first.s.businessName || null,
            closeMin: worstHours.closeMin, etaMin: worstHours.etaMin,
            lateBy: worstHours.lateBy, anchored: worstHours.anchored,
            supersededTier: worstHours.tier,
          } : {}),
          title: `No driver — ${k} must make ${fmtMin(first.w.closeMin)}`,
          detail: `${k} has ${constrained.length} stop${constrained.length === 1 ? '' : 's'} with receiving hours today (earliest close ${fmtMin(first.w.closeMin)} at ${first.s.businessName || first.s.stopNbr}); past the ${fmtMin(departMin)} departure, no movement, no driver.${tier === 'amber' ? ' Hours auto-detected — verify.' : ''} Assign a driver or move the dates.`,
          scope: 'occurrence', servedDate, fingerprint: `nodrv|${servedDate}|${k}|${first.w.closeMin}`,
        }));
        // ONE ROUTE, ONE CARD. Chad's screenshot: "May miss receiving hours — MCNAUGHTON
        // MCKAY ELECTRIC" (stop 5 on SUW, ~11:54a vs close 11:30a) sat three cards above
        // "No driver — SUW must make 11:30a", which names the SAME customer and the SAME
        // close — "there is same one listed twice".
        //
        // They are two rules, but on a driverless route they are one situation, and the
        // no-driver card is strictly the better one: it gives the CAUSE (nobody is
        // driving), counts every constrained stop on the route rather than just the ones
        // whose estimate happens to have crossed the line yet, and ends in the action to
        // take. The arrival card, next to it, implies the problem is a slow morning.
        //
        // Note this only overlaps sometimes — which is why it was easy to miss. R6 exists
        // because the ETA walk cannot see a driverless route EARLY (at 9:24a a re-anchored
        // clock still lands hours before a 2:00p close, so R5 says nothing). Once the clock
        // does cross, both fire. Suppressing R5 here loses nothing: every stop it would
        // have named is already inside R6's count, and R6 names the earliest one.
        if (supersededRows.length) {
          const drop = new Set(supersededRows);
          for (let i = rows.length - 1; i >= 0; i -= 1) if (drop.has(rows[i])) rows.splice(i, 1);
        }
      }
    }
  }

  // Volume caps — a wall of rows is how badges die. Collapse an over-cap rule to one line.
  //
  // PER RULE **AND TIER**, and that second half is the whole correctness of it. This used to
  // bucket by rule alone and then pick the cap from `rs[0].tier` — the first row pushed,
  // which is the first late stop of whichever route came first, a tier that is arbitrary
  // with respect to severity. So thirteen late stops whose first happened to be red
  // collapsed the ENTIRE rule to one red summary: eleven criticals erased, criticalCount 0,
  // and — because selectAlertable skips collapsed rows and rows with no stopNbr — customer
  // service emailed about none of them. Thirteen stops past their close is an ordinary bad
  // day on a 700-stop board, so this was reachable, and the failure is silent by
  // construction: one calm amber row is pixel-identical to a calm board.
  //
  // Bucketing by tier means a critical can only ever be summarized by criticals, and the
  // count that collapses is the count the dispatcher would have had to read anyway.
  const capped = [];
  const byRule = new Map();
  for (const r of rows) {
    const bucket = `${r.rule}|${r.tier}`;
    if (!byRule.has(bucket)) byRule.set(bucket, []);
    byRule.get(bucket).push(r);
  }
  for (const [bucketKey, rs] of byRule) {
    const rule = bucketKey.slice(0, bucketKey.lastIndexOf('|'));
    const cap = rs[0].tier === 'critical' ? CRITICAL_CAP : rs[0].tier === 'red' ? RED_CAP : AMBER_CAP;
    if (rs.length <= cap) { capped.push(...rs); continue; }
    // The summary row needs its OWN dismissal identity. Spreading rs[0] used to carry that
    // stop's dismissKey onto the collapsed line, so waving off the batch wrote a key
    // belonging to one constituent — and the batch reappeared while a single stop went
    // quiet. Rebuild the key from the collapsed fingerprint rather than inheriting it.
    const summaryRow = {
      ...rs[0], stopNbr: null, matchKey: null,
      title: `${rs.length} stops: ${rs[0].title.split('—')[0].trim()}`,
      detail: `Too many to list one by one (cap ${cap}) — this is a data-quality batch, not ${rs.length} separate emergencies. Work it from the stops grid.`,
      fingerprint: `collapsed|${rule}|${rs[0].tier}|${servedDate}|${rs.length}`, collapsed: rs.length,
    };
    summaryRow.dismissKey = `${rule}|${summaryRow.scope === 'occurrence' ? `${summaryRow.servedDate}|` : ''}${summaryRow.fingerprint}|t${TIER_RANK[summaryRow.tier] ?? 1}`;
    summaryRow.dismissKeys = dismissKeysFor(summaryRow);
    capped.push(summaryRow);
  }
  capped.sort((a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9));

  return {
    rows: capped,
    // criticalCount is reported separately AND folded into redCount. Every existing caller
    // reads redCount to decide whether the board is in trouble; if critical were its own
    // count only, promoting a row from red to critical would DECREASE redCount and the chip
    // would read calmer at the exact moment things got worse.
    criticalCount: capped.filter((r) => r.tier === 'critical').length,
    redCount: capped.filter((r) => r.tier === 'critical' || r.tier === 'red').length,
    amberCount: capped.filter((r) => r.tier === 'amber').length,
    skipped,
    checked,
    legsWanted: [...legsWanted.values()],
    etaByStop,
  };
}

// The key a row is hidden under, and the keys a dismissal must WRITE.
//
// A DISMISSAL IS CAPPED AT THE SEVERITY IT WAS MADE AT. Waving off an amber used to hide the
// same stop after it escalated to red or critical, because the hours fingerprint
// (`hours|date|route|stop|close`) carries no tier — so the worst thing the board can say was
// silenceable by a shrug at the mildest version of it. Tier is now part of the key, and a
// dismissal writes its own rank AND every rank below it:
//
//   dismiss at amber    → writes t1        → escalation to red (t2) is NOT hidden, it returns
//   dismiss at critical → writes t1,t2,t3  → de-escalation to amber stays hidden
//
// That asymmetry is the point. Getting worse earns another look; getting better does not
// earn another interruption. Putting tier in the fingerprint alone would have given both,
// which is how closed_today (fingerprint `closed|…|${tier}`) currently re-raises rows that
// merely improved.
export function dismissKeysFor(r) {
  if (!r) return [];
  const base = `${r.rule}|${r.scope === 'occurrence' ? `${r.servedDate}|` : ''}${r.fingerprint}`;
  const rank = TIER_RANK[r.tier] ?? 1;
  const keys = [];
  for (let i = 1; i <= rank; i++) keys.push(`${base}|t${i}`);
  return keys;
}

function row(tier, rule, s, extra) {
  const r = {
    tier, rule,
    stopNbr: s?.stopNbr ?? null,
    matchKey: s?.matchKey ?? null,
    routeName: s ? (s.routeName || s.loadNbr || null) : null,
    ...extra,
  };
  // Dismissal key: standing conditions ignore the date (they persist until the FACTS in the
  // fingerprint change); occurrences carry the board day and so expire with it. The `|t<rank>`
  // suffix is what caps a dismissal at the severity it was made at — see dismissKeysFor.
  r.dismissKey = `${rule}|${extra.scope === 'occurrence' ? `${extra.servedDate}|` : ''}${extra.fingerprint}|t${TIER_RANK[tier] ?? 1}`;
  r.dismissKeys = dismissKeysFor(r);
  return r;
}
