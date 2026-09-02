// eta-miss-ledger-background.mts
//
// NIGHTLY: how often did we ACTUALLY miss a receiving close?
//
// Chad, after the back-test: "we need to build a system that records all this data and see
// how often we miss." Until now nothing recorded the outcome of a flag, so no change to the
// model could be shown to have helped. This writes the ground-truth label for every stop
// that had a real deadline and a real arrival stamp.
//
// Data diet: history_days + customer_notes. ZERO NuVizz calls, zero vendor reads. It scores
// SEALED days only — the capture at 06:00 UTC has closed the day long before this runs.
//
//   POST ?date=YYYY-MM-DD    explicit target (default: ET-yesterday)
//   POST ?from=&to=          backfill a range — the whole captured window is fair game,
//                            which is the point: the label exists retroactively.
//   POST ?force=1            rescore a date already scored at this LEDGER_VERSION
//
// ── Schedule: 08:00 UTC nightly ──────────────────────────────────────────────
// The history capture runs at 06:00 UTC and the routing shadow at 07:30. This feeds off the
// same sealed day and is ordered after both, so a capture that runs long cannot race it.
import { isFirestoreEnabled, getDoc, setDoc, updateDocFields } from './lib/firestore.mts';
import { etYesterday } from './lib/history-core.mts';
import { listStops } from './lib/history-store.mts';
import { scoreDay, ledgerPath, ledgerMatchKey, LEDGER_VERSION } from './lib/miss-ledger.mts';
import { scoreRow, summarize, flagHistoryPath, FLAG_HISTORY_VERSION, needsOutcomeRescore, ROLL_LOOKAHEAD_DAYS } from './lib/flag-history.mts';
import { arrivalAnchor, isFinishedStop } from '../../src/lib/board-flags.js';
import { fitCurveByClass, legSamplesFromRoutes, curveToDoc, travelClassOf, DEFAULT_CURVE } from '../../src/lib/travel-model.js';
import { loadVehicleRoster, vehicleTypeForStop } from './lib/tractor-flags.mts';
import { travelCalDayPath, travelCalCurrentPath } from './lib/travel-store.mts';
import { impliedDeparture, departureTable, routeDeparturePath, DEPARTURE_VERSION } from './lib/route-departure.mts';
import { gateScheduledOverride } from './lib/background-gate.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BACKFILL_DAYS = 60;
// How far back a scheduled run reaches to finish scoring days it could not finish at the
// time. Only needs to cover the one-day lag between scoring D and D+1 being sealed, but a
// week absorbs a capture that failed or a couple of days of the site being down without
// leaving those days stuck on "unknown" for ever.
const OUTCOME_RESCORE_DAYS = 7;

export const config = { schedule: '0 8 * * *' };

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
    if (out.length >= MAX_BACKFILL_DAYS) break;
  }
  return out;
}

/** customer_notes reads are memoised across the whole run: one route hits the same
 *  customer repeatedly and a backfill hits it on every day of the window. */
function makeNoteReader() {
  const cache = new Map<string, any>();
  return async (matchKeys: string[]) => {
    for (const k of matchKeys) {
      if (cache.has(k)) continue;
      try { cache.set(k, await getDoc(`customer_notes/${k}`)); } catch { cache.set(k, null); }
    }
    return (k: string) => cache.get(k) ?? null;
  };
}

/** ET minutes past midnight from a stamp the board engine already knows how to read. */
function stampMin(s: any, date: string): { min: number; at: string } | null {
  const a = arrivalAnchor(s, date);
  if (!a || !Number.isFinite(a.min)) return null;
  // THE STAMP THE MINUTES CAME FROM — not whichever field happens to be filled in. This read
  // `deliveredDTTM || arrivalDTTM` while arrivalAnchor prefers the opposite order AND refuses
  // a stamp dated to another day, so a stop anchored on today's arrivalDTTM could be handed
  // yesterday's deliveredDTTM string. Harmless while only the minutes were shown; it is a
  // wrong DATE on screen the moment the date is shown, which is what this change does.
  // (Checked against the 110 scored rows on file: stamp minutes equal arrivalMin on all 93
  // that have a stamp, so this has not bitten yet. It is one field-order away from doing so.)
  const at = a.source === 'arrival' ? s?.arrivalDTTM : s?.deliveredDTTM;
  return { min: a.min, at: String(at || '') };
}

/** `date` and the n-1 days before it, newest first — the scheduled run's catch-up window. */
function recentDates(date: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(addDays(date, -i));
  return out;
}

/** ISO date + n days, on the digits, so no timezone can roll it. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Attach outcomes to the flags recorded live on `date`.
 *
 * `seenLater` — the evidence for Chad's "rolled to the next day" — comes from the first
 * LATER day that has a sealed board, which on a Friday is Monday. If no day in range is
 * captured yet we pass null rather than false, so a roll cannot be mislabelled as "never
 * delivered" purely because we scored it too early.
 *
 * ── WHY THIS RE-RUNS, AND WHY THAT USED TO BE IMPOSSIBLE ─────────────────────
 *
 * That deferral only works if something comes back later. It could not. This job runs at
 * 08:00 UTC and scores ET-yesterday (day D), but D+1 is not sealed until 06:00 UTC the
 * FOLLOWING morning — so `nextDay` was ALWAYS null on the scheduled path, and
 * classifyOutcome's `seenLater == null` branch filed every genuine roll as "unknown".
 * The next run then hit `prior?.version === LEDGER_VERSION` and `continue`d before ever
 * reaching this function, so nothing was re-scored and "unknown" was permanent.
 *
 * That made `rolled` and `undelivered` unreachable outcomes — i.e. the exact question the
 * feature was built to answer ("or at all and rolled to the next day") could never come back
 * anything but "we cannot tell". Every check stayed green the whole time, which is the
 * failure mode worth naming: a history that records nothing but shrugs looks identical to a
 * week when nothing went wrong.
 *
 * The fix is two-part and both halves are needed: this step now runs independently of the
 * miss ledger's own already-scored guard, and the scheduled run sweeps back over recent days
 * whose outcomes are still pending. Cheap by construction — a day that already resolved is
 * one getDoc and no further reads.
 */
/** One getDoc: does this day still have flag outcomes that could change? See
 *  needsOutcomeRescore — a resolved day costs exactly this read and nothing more. */
async function outcomesPending(date: string): Promise<boolean> {
  try { return needsOutcomeRescore(await getDoc(flagHistoryPath(TENANT, date))); } catch { return false; }
}

async function scoreFlagOutcomes(date: string, stops: any[]) {
  const path = flagHistoryPath(TENANT, date);
  const doc = await getDoc(path);
  const tracked = doc?.rows;
  if (!tracked || !Object.keys(tracked).length) return null;

  const byStop = new Map<string, any>();
  for (const s of stops) if (s?.stopNbr != null) byStop.set(String(s.stopNbr), s);

  // Did a LATER board carry it? Absent capture => null => "we cannot tell yet".
  //
  // This used to ask about day+1 and nothing else. On a Friday that is Saturday, Davis does
  // not run, no board is ever captured — so every Friday flag read "unknown" permanently and
  // the nightly sweep re-read those days until they aged out still ungraded. A fifth of the
  // week could not answer the question this table exists to ask. Walk to the first later day
  // that actually HAS a board; rollCheckDate bounds how far.
  // KEEP THE ROWS, NOT JUST THE NUMBERS. This reduced the later board to a Set of stop
  // numbers, which answered "did it come back?" and threw away "and when did it land?" — the
  // board was fetched, the stamp was in memory, and it was discarded. Measured across twelve
  // scored days: all 34 made and all 27 missed rows carried a deliveredAt, and all 11 ROLLED
  // rows carried none. The one outcome whose delivery happens on a different DATE was the one
  // with no date recorded at all.
  let nextDay: Map<string, any> | null = null;
  let rollCheckedDate: string | null = null;
  for (let i = 1; i <= ROLL_LOOKAHEAD_DAYS; i += 1) {
    const d = addDays(date, i);
    try {
      const later = await listStops(TENANT, d);
      if (later?.length) {
        nextDay = new Map(later.map((s: any) => [String(s?.stopNbr), s]));
        rollCheckedDate = d;
        break;
      }
    } catch { /* not captured — keep looking */ }
  }

  const scoredAt = new Date().toISOString();
  const out: Record<string, any> = {};
  for (const [stopNbr, row] of Object.entries<any>(tracked)) {
    const s = byStop.get(stopNbr);
    const stamp = s ? stampMin(s, date) : null;
    // The stop as the LATER board has it. Present on the board is not the same as delivered
    // there — a stop replanned and still open has no stamp, and "rolled, still open" must not
    // be printed as a delivery.
    const laterRow = nextDay && rollCheckedDate ? nextDay.get(stopNbr) : null;
    const laterStamp = laterRow && rollCheckedDate ? stampMin(laterRow, rollCheckedDate) : null;
    out[stopNbr] = scoreRow(row, {
      arrivalMin: stamp ? stamp.min : null,
      deliveredAt: stamp ? stamp.at : null,
      finished: s ? isFinishedStop(s) : false,
      seenLater: nextDay ? nextDay.has(stopNbr) : null,
      rolledDeliveredAt: laterStamp ? laterStamp.at : null,
      rolledOnDate: rollCheckedDate,
      scoredAt,
    });
  }

  const summary = summarize(out);
  await setDoc(path, {
    ...doc, tenant: TENANT, date, version: FLAG_HISTORY_VERSION,
    rows: out, summary, scored_at: scoredAt,
    next_day_captured: nextDay != null,
    // WHICH day settled it, so "rolled" is checkable rather than asserted. On a Friday this
    // is Monday, and a reader who does not know that would otherwise have no way to tell a
    // graded Friday from a Friday graded against the wrong day.
    roll_checked_date: rollCheckedDate,
  });
  return summary;
}

// ── TRAVEL CALIBRATION ───────────────────────────────────────────────────────
//
// The distance-tiered speed curve the flag walk runs on is MEASURED, not assumed: every
// sealed day's consecutive same-route stamps are (distance, elapsed) pairs from the
// trucks that actually drive these roads. This job already holds the day's stops, so
// recording the samples costs one small write — and the rolling fit pools the last 28
// day-docs so no single bad afternoon steers the curve. Same "two writers, no new crons"
// discipline as the flag history itself.
const CAL_WINDOW_DAYS = 28;
const CAL_DEPOT = { lat: 34.147791, lng: -83.960911 };   // Buford Terminal, as every sweep uses
const CAL_MAX_SAMPLES_PER_DAY = 800;

// The SAME per-stop resolution the backtest's ?fit=1 preview uses — pickups out (their
// stamp is the terminal's, not a road's), appointment routes out (held freight paces
// nothing), dispatcher pin over feed geocode, strict numeric coords (Number(null) is 0
// and 0 is finite — the exact trap CLAUDE.md warns about, and lat 0 is a real ocean).
const calNumOr = (v: any) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
function calPos(s: any): { lat: number; lng: number } | null {
  const ov = s?.note?.location_override ?? s?.location_override;
  const oLat = calNumOr(ov?.lat), oLng = calNumOr(ov?.lng);
  if (oLat != null && oLng != null) return { lat: oLat, lng: oLng };
  const lat = calNumOr(s?.lat), lng = calNumOr(s?.lng);
  return lat != null && lng != null ? { lat, lng } : null;
}
const calIsAppointmentRoute = (k: string) => /\b(?:APPTS?|APPOINTMENTS?)\b/i.test(k);

function calSamplesForDay(stops: any[], date: string, roster: any = null) {
  const routes = new Map<string, any[]>();
  // The route's truck class, by MAJORITY of its stops' roster joins — a route is one
  // driver on a normal day, so this is usually unanimous; a midday driver swap or an
  // unknown alias degrades the route to null (fleet curve), never to a coin flip.
  const classVotes = new Map<string, Map<string, number>>();
  for (const s of stops) {
    const k = String(s?.loadNbr || s?.routeName || '').trim();
    if (!k || calIsAppointmentRoute(k)) continue;
    if (String(s?.stopType || '').toUpperCase() === 'PU') continue;
    if (roster) {
      const cls = travelClassOf(vehicleTypeForStop(s, roster));
      if (cls) {
        if (!classVotes.has(k)) classVotes.set(k, new Map());
        const v = classVotes.get(k)!;
        v.set(cls, (v.get(cls) || 0) + 1);
      }
    }
    const a = arrivalAnchor(s, date);
    if (!routes.has(k)) routes.set(k, []);
    routes.get(k)!.push({
      pos: calPos(s),
      stampMin: a ? a.min : null,
      // WHICH stamp it was, not just when. A delivered stamp has the dwell already spent —
      // impliedDeparture has to take it back out, and it cannot if the source is dropped here.
      stampSource: a ? a.source : null,
      seq: typeof s?.routeSeq === 'number' ? s.routeSeq : null,
    });
  }
  const classOfRoute = new Map<string, string>();
  for (const [k, votes] of classVotes) {
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 1 || (ranked.length > 1 && ranked[0][1] > ranked[1][1])) classOfRoute.set(k, ranked[0][0]);
  }
  return legSamplesFromRoutes(routes, classOfRoute).slice(0, CAL_MAX_SAMPLES_PER_DAY);
}

// WHEN EACH ROUTE ACTUALLY LEFT, for this one sealed day. Same `routes` shape the leg
// calibration builds, so this costs one extra pass over data already in memory and no
// extra reads. Routes whose first sequenced stop never reported yield nothing — see
// lib/route-departure for why a later stamp is deliberately not used.
function departureSamplesForDay(stops: any[], date: string, curve: any): Record<string, number> {
  const routes = new Map<string, any[]>();
  for (const s of stops) {
    const k = String(s?.loadNbr || s?.routeName || '').trim();
    if (!k || calIsAppointmentRoute(k)) continue;
    if (String(s?.stopType || '').toUpperCase() === 'PU') continue;
    const a = arrivalAnchor(s, date);
    if (!routes.has(k)) routes.set(k, []);
    routes.get(k)!.push({
      pos: calPos(s),
      stampMin: a ? a.min : null,
      seq: typeof s?.routeSeq === 'number' ? s.routeSeq : null,
    });
  }
  const out: Record<string, number> = {};
  for (const [k, entries] of routes) {
    const dep = impliedDeparture(entries, CAL_DEPOT, curve);
    if (dep != null) out[k] = dep;
  }
  return out;
}

/** PURE. Does this windowed day-doc still need its departures computed from sealed history?
 *  The KEY being present is the stamp — an empty map means "scanned, nothing usable", and
 *  re-scanning it nightly would re-list ~800 stop docs for nothing. */
export function needsDepartureBackfill(doc: any): boolean {
  return !doc || !('departures' in doc);
}

async function writeTravelCalibration(date: string, stops: any[]) {
  // Best-effort roster: a missing/unreadable roster means class-less samples — the fleet
  // fit still runs and nothing is lost except the split, which returns when it does.
  let roster: any = null;
  try { roster = await loadVehicleRoster(); } catch { /* class-less day */ }
  const samples = calSamplesForDay(stops, date, roster);
  // Departures ride in the SAME day-doc: one write, one window, and a backfill of an old
  // day repairs both fits together rather than leaving them describing different histories.
  const departures = departureSamplesForDay(stops, date, DEFAULT_CURVE);
  await setDoc(travelCalDayPath(TENANT, date), {
    tenant: TENANT, date, n: samples.length, samples, departures, written_at: new Date().toISOString(),
  });

  // A BACKFILLED OLD DAY MUST NOT STEER THE LIVE CURVE BACKWARDS. ?force/?date re-scores
  // are fair game for day-docs, but __current is what every board runs on tonight — it
  // only moves forward. (String compare is correct: ISO dates.)
  const existing = await getDoc(travelCalCurrentPath(TENANT)).catch(() => null);
  if (existing?.through && String(existing.through) > date) {
    return { samples: samples.length, skippedCurrent: `through ${existing.through} > ${date}` };
  }

  // Pool the window and refit. A day with no doc contributes nothing; the fit itself
  // falls back per-bucket to the shipped defaults wherever the pool is thin.
  //
  // THE DEPARTURE BACKFILL. Departures ride in day-docs only since v0.64.0 (2026-08-20), and
  // this loop used to skip any doc without the field — so every sealed day before that date
  // was invisible to the departure fit FOREVER, and the table had to crawl from 2 days to a
  // full window at one day per night while two months of first-delivery stamps sat unread in
  // the warehouse. Chad: "we have a couple months we could study to procure better results."
  // The two-month study (66 routes, ~9 weekly windows; adversarially verified) also asked
  // whether the window should WIDEN before this shipped. Verified answer: window size
  // barely matters — last-week/2wk/4wk/8wk all land within ~1-2 min of each other (median
  // abs error ~25-26) and are statistically indistinguishable; the corpus cannot even
  // genuinely test 8 weeks (on 181 of 314 backtest rows the 4- and 8-week windows hold
  // identical data). An earlier draft claimed 8 weeks actively HURT the drifting routes
  // (52 vs 46) — that did not survive verification (10 routes, CI spans zero). What stands:
  // no detectable benefit beyond a few weeks, so the fix is to FILL the existing 28-day
  // window from history, not to widen it.
  //
  // Mechanics: a windowed day whose doc lacks the field gets its departures computed from the
  // sealed stops and PATCHED in — updateDocFields, never setDoc, because these docs carry the
  // travel-curve samples and a blind write would take the curve's history with it. An empty
  // result still stamps the field, so a dayless weekend is scanned once, not nightly. Capped
  // per run: the window fills over the first few nights instead of one heavy one.
  const BACKFILL_PER_RUN = 8;
  let departuresBackfilled = 0;
  const pooled: any[] = [];
  const daysUsed: string[] = [];
  const departureDays: Array<{ date: string; byRoute: Record<string, number> }> = [];
  for (let i = 0; i < CAL_WINDOW_DAYS; i++) {
    const d = addDays(date, -i);
    try {
      let doc = await getDoc(travelCalDayPath(TENANT, d));
      if (needsDepartureBackfill(doc) && departuresBackfilled < BACKFILL_PER_RUN) {
        try {
          const dayStops = await listStops(TENANT, d);
          const dep = dayStops?.length ? departureSamplesForDay(dayStops, d, DEFAULT_CURVE) : {};
          await updateDocFields(travelCalDayPath(TENANT, d), {
            tenant: TENANT, date: d, departures: dep,
            departures_backfilled_at: new Date().toISOString(),
          });
          departuresBackfilled += 1;
          doc = { ...(doc || {}), departures: dep };
        } catch { /* uncaptured day — the stamp is not written, so it retries another night */ }
      }
      if (doc?.samples?.length) { pooled.push(...doc.samples); daysUsed.push(d); }
      if (doc?.departures && Object.keys(doc.departures).length) {
        departureDays.push({ date: d, byRoute: doc.departures });
      }
    } catch { /* absent day — fine */ }
  }
  // The measured departure per route, published separately so a bad travel fit and a bad
  // departure fit can never be mistaken for each other. Routes with too few clean days are
  // omitted by departureTable, and the board keeps its 8:00a default for them.
  try {
    const table = departureTable(departureDays);
    await setDoc(routeDeparturePath(TENANT), {
      tenant: TENANT, version: DEPARTURE_VERSION, through: date,
      days: departureDays.length, routes: Object.keys(table).length,
      backfilledThisRun: departuresBackfilled,
      table, fitted_at: new Date().toISOString(),
    });
  } catch (e: any) { console.error('route departure fit failed (non-fatal):', e?.message); }
  const { fleet: fit, classes } = fitCurveByClass(pooled, { defaults: DEFAULT_CURVE });
  await setDoc(travelCalCurrentPath(TENANT), {
    tenant: TENANT,
    // AS MAPS, NOT PAIRS. Firestore rejects an array nested in an array with a 400, the
    // write here is wrapped in a best-effort catch, and the resulting "calibration never
    // persists" is pixel-identical to day one. curveToDoc/curveFromDoc are the only two
    // ways this shape crosses the wire, and a test round-trips them.
    curve: curveToDoc(fit.curve), buckets: fit.buckets,
    serviceMin: fit.serviceMin, serviceMeasured: fit.serviceMeasured,
    // Per truck class, same codec, hierarchically defaulted to the FLEET fit above —
    // Chad: tractors and box trucks "get around town and deliveries very differently".
    classes: Object.fromEntries(Object.entries(classes).map(([cls, c]: [string, any]) => [cls, {
      curve: curveToDoc(c.curve), buckets: c.buckets,
      serviceMin: c.serviceMin, serviceMeasured: c.serviceMeasured, n: c.n,
    }])),
    n: fit.n, days: daysUsed.length, through: date,
    fitted_at: new Date().toISOString(),
  });
  return {
    samples: samples.length, pooled: fit.n, days: daysUsed.length, serviceMin: fit.serviceMin,
    classes: Object.fromEntries(Object.entries(classes).map(([cls, c]: [string, any]) => [cls, { n: c.n, serviceMin: c.serviceMin }])),
  };
}

/** Is this date's calibration day-doc absent? One getDoc; lets the scheduled 7-day sweep
 *  seed history that predates the feature instead of pooling a single day for a month. */
async function calDayMissing(date: string): Promise<boolean> {
  try { return !(await getDoc(travelCalDayPath(TENANT, date))); } catch { return false; }
}

// ?force / ?from&to / ?date drive the ledger by hand. ?force is the sharp one: it discards the
// already-scored guard, so a range plus force re-scores an arbitrary span of the miss ledger and
// the flag-outcome rescore that grades every past red — the record the alert thresholds are
// tuned against — while holding an instance for as long as it takes. The 08:00 UTC cron sends no
// query string and keeps its own look-back window.
export const OVERRIDE_PARAMS = ['force', 'from', 'to', 'date'] as const;

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  // Before isFirestoreEnabled and before any read: a refused override must cost nothing.
  const refused = await gateScheduledOverride(req, 'eta-miss-ledger-background', OVERRIDE_PARAMS);
  if (refused) return refused;
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const force = url.searchParams.get('force') === '1';
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const one = url.searchParams.get('date');

    let dates: string[];
    if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) dates = datesBetween(from, to);
    else if (one && DATE_RE.test(one)) dates = [one];
    // THE SCHEDULED RUN LOOKS BACK, not just at last night. Scoring ET-yesterday alone can
    // never resolve a roll, because the day a rolled stop would reappear on is not sealed
    // yet at 08:00 UTC. The older days in this window are visited for their flag outcomes
    // only — each costs one getDoc unless it actually has something left to settle.
    else dates = recentDates(etYesterday(), OUTCOME_RESCORE_DAYS);

    const warmNotes = makeNoteReader();
    const done: any[] = [];

    for (const date of dates) {
      // THE LEDGER'S GUARD MUST NOT GATE THE FLAG STEP. These are two different jobs behind
      // one version number: the miss ledger is finished with a day as soon as that day is
      // sealed, while flag outcomes are not finished until the day AFTER it is sealed too.
      // Sharing the guard meant the second job could never run a second time, which is
      // precisely why every roll was filed as "unknown" for ever. `ledgerDone` now skips
      // only the ledger's own work.
      const priorLedger = force ? null : await getDoc(ledgerPath(TENANT, date));
      const ledgerDone = priorLedger?.version === LEDGER_VERSION;
      const calMissing = await calDayMissing(date);
      if (ledgerDone && !calMissing && !(await outcomesPending(date))) {
        done.push({ date, skipped: 'already scored' });
        continue;
      }
      let stops: any[] = [];
      try { stops = await listStops(TENANT, date); } catch { done.push({ date, skipped: 'no capture' }); continue; }
      if (!stops.length) { done.push({ date, skipped: 'no capture' }); continue; }

      let summary: any = priorLedger || null;
      if (!ledgerDone) {
        const keys = [...new Set(stops.map((s) => ledgerMatchKey(s)).filter(Boolean) as string[])];
        const noteFor = await warmNotes(keys);
        const scored = scoreDay(stops, date, noteFor);
        summary = scored.summary;

        // The per-stop rows are kept alongside the summary: a rollup answers "how often", the
        // rows answer "which customers, and by how long" — which is what actually gets fixed.
        await setDoc(ledgerPath(TENANT, date), { tenant: TENANT, ...scored.summary, rows: scored.rows, scored_at: new Date().toISOString() });
      }

      // ── DID THE FLAGS DO ANY GOOD? ───────────────────────────────────────────
      //
      // Chad: "the time the shipment actually delivered. And if the flag allowed us to fix
      // the problem or not before it didn't deliver on time or at all and rolled to the
      // next day."
      //
      // The flags themselves were recorded live through the day by
      // eta-flag-alert-background. This is the other half: what actually happened to each
      // one, read off the SAME sealed day the miss ledger just scored, so the two can never
      // disagree about an arrival.
      //
      // Best-effort. A day with no flags recorded is the ordinary case for any date before
      // this feature existed, and must not fail the ledger run that is its actual job.
      let flagOutcome: any = null;
      try {
        flagOutcome = await scoreFlagOutcomes(date, stops);
      } catch (e: any) {
        console.error('flag outcome scoring failed (non-fatal):', date, e?.message);
      }
      // Calibration rides the same sealed stops. Best-effort for the same reason the flag
      // step is: the ledger is the job, this is a measurement taken while the data is warm.
      let travelCal: any = null;
      if (!ledgerDone || calMissing) {
        try { travelCal = await writeTravelCalibration(date, stops); }
        catch (e: any) { console.error('travel calibration failed (non-fatal):', date, e?.message); }
      }
      done.push({
        date, scored: summary?.scored, missed: summary?.missed, miss_rate_pct: summary?.miss_rate_pct,
        ...(ledgerDone ? { ledger: 'already scored' } : {}),
        ...(flagOutcome ? { flags: flagOutcome } : {}),
        ...(travelCal ? { travel: travelCal } : {}),
      });
    }

    return J({ ok: true, version: LEDGER_VERSION, days: done.length, results: done });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
