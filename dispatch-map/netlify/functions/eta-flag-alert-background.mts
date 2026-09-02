// eta-flag-alert-background.mts
//
// WATCHES TODAY'S BOARD AND EMAILS CUSTOMER SERVICE THE FIRST TIME A STOP GOES CRITICAL.
//
// Chad asked for this in the same breath as the tier rework: "if something gets a red flag,
// that we should send a email to customer service at Davis delivery dot com... needs to only
// send the email the first time the flag appears as a red flag which could come later in day
// if a driver gets behind... if we are already past the time shouldn't send."
//
// It runs the SAME flag engine the board runs — src/lib/board-flags.js, imported, not
// reimplemented. That is deliberate and it is the second time this session the point has
// come up: the ETA back-test re-implemented the model's accessors and silently diverged in
// three places, changing which routes were scored. An alert that fires off a COPY of the
// rules would eventually page customer service about a stop the dispatcher's screen never
// flagged, and nobody would be able to say which one was lying.
//
// Data diet: the Firestore stop index the scanner already writes, plus customer_notes for
// receiving hours. ZERO NuVizz calls — this never triggers a scan, it reads what the last
// scan left behind.
//
// ── Schedule: every 20 minutes through the working day, ET ───────────────────
// The scan itself refreshes every 15 minutes, so anything tighter re-reads the same board.
// Cron is UTC: 11:00-23:59 UTC covers roughly 07:00-19:59 ET, which brackets the delivery
// day either side of a DST flip without needing to be re-timed twice a year.
import { isFirestoreEnabled, readStops, getDoc, setDoc, listFleetLoads, createDocIfAbsent, etDayString, listDocs } from './lib/firestore.mts';
import { computeBoardFlags } from '../../src/lib/board-flags.js';
import { ensureLegs, readTravelCalibration, routeClassesPath } from './lib/travel-store.mts';
import { routeDeparturePath, readDepartureTable } from './lib/route-departure.mts';
import { readRouteClassesFor } from './lib/route-classes.mts';
import { withCustomerKeys, stopCustomerKey } from './lib/customer-key.mts';
import { selectAlertable, sendAlerts, ALERT_TO, AMBER_LEAD_GATE_MIN, ALERT_COLLECTION } from './lib/flag-alert.mts';
import { mergeSweep, scoreRowsLive, flagHistoryPath, FLAG_HISTORY_VERSION } from './lib/flag-history.mts';
import { arrivalAnchor, isFinishedStop } from '../../src/lib/board-flags.js';
import { auditRows } from './lib/flag-rows.mts';
import { emailEnabled } from './lib/email.mts';
import { gateScheduledOverride } from './lib/background-gate.mts';

const TENANT = 'davis';
const DEPOT = { name: 'Buford Terminal', lat: 34.147791, lng: -83.960911 };

export const config = { schedule: '*/20 11-23 * * 1-5' };

/** ET wall-clock minutes past midnight — the same clock the board's own nowMin uses. */
function etNowMin(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}
function weekdayKey(date: string): string | null {
  const [y, mo, d] = String(date || '').split('-').map(Number);
  if (!y || !mo || !d) return null;
  const dt = new Date(y, mo - 1, d, 12, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dt.getDay()];
}

// ?dry / ?date / ?now are the hand-driven branches. ?date and ?now REPLAY the board against a
// clock the caller chose, which is what decides who gets an urgent customer-service email; ?dry
// sends nothing but walks the whole board and every customer_notes doc and returns the stops,
// their receiving hours and how late they are — a free customer-data read on an open POST. The
// scheduled run (*/20 11-23 weekdays) sends no query string and is untouched.
export const OVERRIDE_PARAMS = ['dry', 'date', 'now'] as const;

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  // Before isFirestoreEnabled and before any read: a refused override must cost nothing.
  const refused = await gateScheduledOverride(req, 'eta-flag-alert-background', OVERRIDE_PARAMS);
  if (refused) return refused;
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    // DRY RUN is the default-safe way to look at this: it computes and reports exactly what
    // WOULD be emailed, claims nothing and sends nothing.
    const dry = url.searchParams.get('dry') === '1';
    const date = url.searchParams.get('date') || etDayString();
    const nowMin = url.searchParams.get('now')
      ? Number(url.searchParams.get('now'))
      : (date === etDayString() ? etNowMin() : null);

    const { stops: rawStops } = await readStops(TENANT, date);
    // THE LIVE STOP INDEX DOES NOT CARRY matchKey. computeBoardFlags looks its receiving
    // hours up by stop.matchKey, so without this every stop reads as having no deadline and
    // the whole board comes back clean — measured: 778 stops, 63 routes judged, 0 flags.
    const stops = withCustomerKeys(rawStops);
    if (!stops?.length) return J({ ok: true, date, note: 'no board', alertable: 0 });

    // Receiving hours live in customer_notes, one doc per customer key. Read each distinct
    // key once — a 700-stop board is only a few hundred customers.
    const keys = [...new Set(stops.map((s: any) => stopCustomerKey(s)).filter(Boolean) as string[])];
    const notes = new Map<string, any>();
    const CHUNK = 25;
    for (let i = 0; i < keys.length; i += CHUNK) {
      await Promise.all(keys.slice(i, i + CHUNK).map(async (k) => {
        try { const d = await getDoc(`customer_notes/${k}`); if (d) notes.set(k, d); } catch { /* a missing note is the ordinary case */ }
      }));
    }

    // ── HOW LONG A LEG TAKES ─────────────────────────────────────────────────
    //
    // Real cached Google drive times where the cache holds them, the nightly-calibrated
    // distance-tiered curve everywhere else — never the old flat ~30 mph. TWO PASSES,
    // because the walk itself is what knows which legs today's boards need: pass one runs
    // on whatever is cached and reports its legsWanted, the store fills the gaps (capped,
    // cached, free-tier), and pass two — the one whose verdicts alert and get recorded —
    // runs with the filled cache. The engine is pure and takes milliseconds; running it
    // twice buys same-sweep freshness instead of always being one sweep behind.
    // WHEN EACH ROUTE ACTUALLY LEAVES — measured per-route departure, fitted nightly from
    // sealed history. Absent or thin, every route keeps the shipped 8:00a default.
    const departDoc = await getDoc(routeDeparturePath(TENANT)).catch(() => null);
    const departByRoute = readDepartureTable(departDoc);
    const cal = await readTravelCalibration(TENANT);
    // WHICH TRUCK RUNS EACH ROUTE — load header first, driver roster second. The precedence,
    // the vote and the "unknown is not box" rule all live in lib/route-classes.mts now,
    // because the evening sweep needs the same map and a second copy of it is how two answers
    // to one question get born.
    let routeClasses: Record<string, string> = {};
    let classSource = 'none';
    let unclassedRoutes: any[] = [];
    let nearMatches: any[] = [];
    try {
      const rc = await readRouteClassesFor(
        () => listFleetLoads(TENANT, date, ['loadNbr', 'routeName', 'vehicleType']),
        stops,
      );
      routeClasses = rc.classes;
      classSource = rc.source;
      unclassedRoutes = (rc.unclassed || []).filter((u) => u.reason !== 'appointment_route');
      nearMatches = rc.nearMatches || [];

      // The doc is TODAY's operational state and only a real sweep of today may write it.
      // A dry run must claim nothing, and a ?date= replay writing last Friday's trucks
      // over today's map would put every route on the fleet clock until the next sweep —
      // across a whole weekend, if the replay ran on a Friday night.
      if (!dry && date === etDayString()) {
        try {
          await setDoc(routeClassesPath(TENANT), { tenant: TENANT, date, classes: routeClasses, at: new Date().toISOString() });
        } catch (e: any) {
          // The sweep would now judge on a map the browser cannot read — say so where
          // the run record shows it rather than letting screen and inbox drift apart.
          console.error('route-classes publish failed (screen will run fleet-only):', e?.message);
        }
      }
    } catch (e: any) {
      console.error('route classes unavailable — fleet curve carries every route:', e?.message);
    }

    const calOpts = cal ? {
      curve: cal.curve, serviceMin: cal.serviceMin,
      ...(cal.classCurves ? { classCurves: cal.classCurves } : {}),
      ...(cal.classService ? { classService: cal.classService } : {}),
    } : {};
    // SEVERITY RATCHETS ON WHAT TODAY HAS ALREADY SEEN. Chad, on a stop still predicted past
    // its close while the panel read "0 red": "the flag should remain unless our updated eta
    // is showing we will get there in time." The floor is the worstTier this same history
    // doc already records — read here, BEFORE the judge, so this sweep and the screen agree
    // about a row rather than disagreeing by one tier for twenty minutes.
    let tierFloorByStop: Record<string, string> | null = null;
    try {
      const hist: any = await getDoc(flagHistoryPath(TENANT, date));
      const rows = hist?.rows && typeof hist.rows === 'object' ? Object.values<any>(hist.rows) : [];
      if (rows.length) {
        const t: Record<string, string> = {};
        for (const r of rows) if (r?.stopNbr && r?.worstTier) t[String(r.stopNbr)] = String(r.worstTier);
        tierFloorByStop = Object.keys(t).length ? t : null;
      }
    } catch { /* no floor — this sweep judges on its own, the shipped behaviour */ }

    const engineOpts = (legs: Record<string, number>) => ({
      depot: DEPOT, ...(nowMin != null ? { nowMin } : {}),
      travel: { legs, routeClasses, ...calOpts },
      ...(departByRoute ? { departByRoute } : {}),
      ...(tierFloorByStop ? { tierFloorByStop } : {}),
    });

    const first = computeBoardFlags({
      stops, notes, servedDate: date, dayKey: weekdayKey(date), opts: engineOpts({}),
    });
    let legInfo = { legs: {} as Record<string, number>, fetched: 0, missing: 0, googleEnabled: false };
    try {
      legInfo = await ensureLegs(TENANT, first.legsWanted || []);
    } catch { /* the curve carries the sweep; a cache failure must not */ }

    const flags = computeBoardFlags({
      stops, notes, servedDate: date, dayKey: weekdayKey(date), opts: engineOpts(legInfo.legs),
    });

    const candidates = selectAlertable(flags.rows, nowMin);

    // ── KEEP THE FLAG, NOT JUST THE EMAIL ─────────────────────────────────────
    //
    // Chad: "I want to build a history of flags... somewhere that tracks all the flags that
    // have presented itself." Until now a flag was a live computation — painted on the
    // board and discarded. The only durable trace was the alert claim, which exists only
    // for stops that earned an EMAIL, so ambers and post-close reds left no record that
    // they ever happened.
    //
    // This sweep already computes the whole board. Folding the result into the day's row
    // set costs one read and one write and no NuVizz calls, and it is what makes "did the
    // flag do any good" answerable at all. See lib/flag-history.mts.
    //
    // Never lets a bookkeeping failure stop an alert: the email is the job, this is the
    // record of it.
    // RECORDED AFTER THE SEND, FROM WHAT THE SEND REPORTED.
    //
    // This used to run BEFORE sendAlerts with emailedStops built from the candidate LIST —
    // so with RESEND_API_KEY unset, or Resend returning 500, or the runaway cap hit, the
    // history still carried emailed:true for every red and critical of that sweep. And
    // mergeSweep's sticky OR made the false claim permanent for the rest of the day, so the
    // Flag history screen reported "Emailed CS: 3" for a day customer service heard nothing
    // about. That is this repo's oldest sin — reporting an intent as an outcome — inside the
    // very feature built to stop doing it.
    const writeHistory = async (emailedStops: Set<string>) => {
      if (dry || nowMin == null) return { added: 0, updated: 0, skipped: dry ? 'dry run' : 'no clock' };
      try {
        const path = flagHistoryPath(TENANT, date);
        const prev = await getDoc(path);
        const atISO = new Date().toISOString();
        const merged = mergeSweep(prev?.rows, auditRows(flags), {
          nowMin, atISO, emailedStops,
        });

        // GRADE WHAT THE BOARD ALREADY ANSWERS. Chad, at 3:53pm on 12 flags and zeros
        // everywhere: "there should have been 12 results or close to it as most evening was
        // delivered by the time I check this." The outcomes were written only by the nightly
        // job, so a stop delivered at 1:40pm against a 2pm close read `unknown` for another
        // ten hours — while THIS sweep held the board carrying that very stamp.
        //
        // Only made/missed are reachable from today (see scoreRowsLive); rolled and
        // undelivered still wait for a later board, because nothing here can tell freight
        // that comes back tomorrow from freight that is gone.
        //
        // SKIPPED once the overnight join has run for this day. scored_at means the fuller
        // pass is done, and a sweep that fired afterwards would re-grade its rows with
        // seenLater unavailable and quietly turn a settled `rolled` back into `unknown`.
        const byStop = new Map<string, any>();
        for (const st of stops || []) { const k = String((st as any)?.stopNbr ?? ''); if (k) byStop.set(k, st); }
        const alreadyFinal = !!prev?.scored_at;
        const live = alreadyFinal
          ? { rows: merged.rows, decided: 0, pending: 0 }
          : scoreRowsLive(merged.rows, (stopNbr) => {
            const st = byStop.get(String(stopNbr));
            if (!st) return null;
            const a = arrivalAnchor(st, date);
            const min = a && Number.isFinite(a.min) ? a.min : null;
            // The stamp the MINUTES came from, not whichever field happens to be filled —
            // the same rule the nightly scorer follows, so the two cannot disagree about a row.
            const at = min == null ? null : String((a.source === 'arrival' ? st?.arrivalDTTM : st?.deliveredDTTM) || '') || null;
            return { arrivalMin: min, deliveredAt: at, finished: isFinishedStop(st) };
          }, atISO);

        await setDoc(path, {
          tenant: TENANT, date, version: FLAG_HISTORY_VERSION,
          updated_at: atISO,
          rows: live.rows,
          // NOT scored_at — that word means the overnight join has run and rolled /
          // undelivered are settled. This says only that today's decidable outcomes are
          // current, so the screen can tell a live partial grade from a finished one.
          ...(alreadyFinal ? {} : { live_scored_at: atISO, live_decided: live.decided }),
        });
        return { added: merged.added, updated: merged.updated, tracked: Object.keys(merged.rows).length };
      } catch (e: any) {
        console.error('flag history write failed (non-fatal):', e?.message);
        return { error: String(e?.message || e) };
      }
    };

    const base = {
      // THE SWITCH'S POSITION, REPORTED RATHER THAN INFERRED. A gate whose setting cannot be
      // read from a sweep is one nobody can confirm they flipped — and a malformed env var
      // silently resolves to off, which is indistinguishable from a quiet day.
      amberGate: AMBER_LEAD_GATE_MIN,
      // What the clock ran on, so a sweep is inspectable: how many legs rode real drive
      // times vs the curve, whether the calibration doc existed, whether Google is wired.
      travel: {
        legsGoogle: flags.checked?.legsGoogle ?? 0, legsTotal: flags.checked?.legsTotal ?? 0,
        fetched: legInfo.fetched, stillMissing: Math.max(0, legInfo.missing - legInfo.fetched),
        googleEnabled: legInfo.googleEnabled, calibrated: !!cal,
        classCurves: !!cal?.classCurves, routeClasses: Object.keys(routeClasses).length, classSource,
      },
      ok: true, date, nowMin,
      critical: flags.criticalCount ?? 0, red: flags.redCount ?? 0, amber: flags.amberCount ?? 0,
      // R7 rides the BOARD from this sweep but never this sweep's inbox: a trailer conflict
      // is a routing problem for the router, not a heads-up for customer service, and it
      // carries no receiving close for selectAlertable to judge. Reported anyway, because a
      // rule that fires and is invisible in the run record is a rule nobody can audit — the
      // overnight text sweep is where it reaches a phone.
      trailerConflicts: flags.checked?.trailerConflicts ?? 0,
      tractorRoutes: flags.checked?.tractorRoutes ?? 0,
      truckClassesKnown: !flags.skipped?.noTruckClasses,
      // Named, not counted — see the evening sweep. A class map with a hole in it is only
      // useful if the hole has a route name and a driver name on it.
      unclassedRoutes, nearMatches,
      alertable: candidates.length,
      candidates: candidates.map((c) => ({ stopNbr: c.stopNbr, customer: c.customer, lateBy: c.lateBy, rule: c.rule })),
    };
    if (dry) return J({ ...base, recorded: await writeHistory(new Set()), dryRun: true });
    // Email off is a real state, and the flags still happened — they are recorded, with
    // emailed FALSE, which is the truth and is what makes "0 emailed on a 6-red day" legible
    // instead of looking like a quiet day.
    if (!emailEnabled()) {
      return J({ ...base, recorded: await writeHistory(new Set()), sent: 0, note: 'email not configured (RESEND_API_KEY unset)' });
    }

    // Seed the runaway ceiling with what the DAY has already claimed, so the cap bounds the
    // day rather than the sweep. Best-effort: an unreadable collection seeds zero, which is
    // the old behaviour, still a per-sweep ceiling.
    let claimedToday = 0;
    try {
      const docs = await listDocs(ALERT_COLLECTION);
      claimedToday = (docs || []).filter((d: any) => d?.tenant === TENANT && d?.date === date).length;
    } catch { /* first claim of the day creates the collection */ }
    const result = await sendAlerts(candidates, date, TENANT, {
      createDocIfAbsent, claimedToday,
      // Lets the early band refuse to follow an urgent claim (bands must arrive in order).
      exists: async (path: string) => !!(await getDoc(path)),
    }, ALERT_TO);
    const { emailedStops, ...counts } = result;
    return J({ ...base, recorded: await writeHistory(emailedStops), ...counts, to: ALERT_TO });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
