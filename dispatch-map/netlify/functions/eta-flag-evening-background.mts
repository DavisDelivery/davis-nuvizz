// eta-flag-evening-background.mts — the EVENING and OVERNIGHT flag sweep, with texts.
//
// Chad: "Flags need to show up on tomorrow's board for deliveries tomorrow soon as we
// start routing at 8pm tonight for tomorrow — shouldn't wait until 7. Trying to catch
// the clearly obvious problems or critical ones sooner."
//
// The measured case for this sweep (flag-replay over 49 sealed days): the existing
// 7:00a-7:40p sweep catches 40% of real receiving-hours misses with a median catch at
// 11:40a — a mid-morning system — while a route built at 9pm with an unmakeable close
// is knowable the moment it is sorted. This sweep runs the SAME engine (imported, never
// copied) over the board the routers are building RIGHT NOW:
//
//   * 8:00p-11:xx ET  -> TOMORROW's board (routing starts ~8pm; the tomorrow-loads scan
//                        gate opens at 20:00 ET, so the data arrives on the same clock)
//   * 12:xx-6:xx ET   -> TODAY's board (same board, across midnight), handing off to the
//                        existing day sweep at 7:00a.
//
// WHAT IT SENDS, AND TO WHOM. Texts, not email — the router is at a board, not an
// inbox. Recipients are env-owned (lib/flag-sms.mts): FLAG_SMS_TO rides every sweep;
// FLAG_SMS_TO_NIGHT (the router on duty — Zach) is dropped AT 6:00a ET sharp, per Chad:
// "Stop flag texts to Zach by 6am — after that he's no longer routing." Only red and
// critical hours_risk rows text ("clearly obvious problems or critical ones"); ambers
// stay on the board. One text per stop per board day per recipient-independent claim —
// claim-then-send, the same atomic pattern as the email path, so a retried sweep can
// never double-text. Worst-late-first, capped per sweep.
//
// AND SINCE v0.82.0, THE OTHER THING A ROUTER CAN STILL FIX AT 9PM. Chad: "stops we have put
// on a tractor that have been hardcoded as no tractor trailer by a dispatcher. Not the Uline
// advisory ones that we pick up automatically just the dispatcher hardcoded ones." That is
// board-flags R7 — a load running a tractor-trailer carrying a stop a human has marked as
// unable to take one. It is not a prediction and has no clock: two recorded facts contradict,
// and the freight does not arrive late, it does not arrive. One text per tractor LOAD (not per
// stop — six box-only stops on one load is one wrong truck), holding its own slice of the
// per-sweep cap so neither kind of news can silence the other.
//
// It needs to know which truck is on each load, so this sweep now builds the TARGET date's
// route→class map (lib/route-classes.mts, load header first, driver roster second) instead of
// running classless as it always has. THE ETA MODEL IS UNCHANGED BY THAT, deliberately: the
// per-class travel curves the day sweep also passes (classCurves/classService) are NOT read
// here, so every route keeps the fleet curve it has always had overnight and the only thing
// the class map moves is the trailer verdict. Putting this sweep's arrival estimates on
// per-truck clocks would change which hours rows text, which is a measurable change and not
// this one.
//
// Pre-day honesty: an evening verdict is a pure 8:00a-departure projection — nothing
// has driven yet — so the text is only sent for the tiers that survive the 90-minute
// unanchored error band, which is exactly the "obvious" population Chad asked for.
//
// INSPECTABILITY. eta-flag-check?date=<the target date> runs the same engine dry over
// the same index and explains per-stop verdicts — that endpoint answers "what would
// tonight's sweep see" without sending anything. Each run of THIS function also writes
// nuvizz_ops/flag_evening_status__<target-date> (attempted/sent/failed/skipped), so the
// morning question "did anything text last night" is one document read.
//
// Data diet: Firestore only — the stop index the scanner maintains, customer_notes,
// the travel cache. ZERO NuVizz calls, ever, from this path.
import { computeBoardFlags } from '../../src/lib/board-flags.js';
import { isFirestoreEnabled, getDoc, setDoc, createDocIfAbsent, readStops, listFleetLoads, readLoadRoster, etDayString } from './lib/firestore.mts';
import { withCustomerKeys, stopCustomerKey } from './lib/customer-key.mts';
import { weekdayKey } from './lib/miss-ledger.mts';
import { readTravelCalibration, ensureLegs } from './lib/travel-store.mts';
import { routeDeparturePath, readDepartureTable } from './lib/route-departure.mts';
import { mergeSweep, flagHistoryPath, FLAG_HISTORY_VERSION } from './lib/flag-history.mts';
import { auditRows } from './lib/flag-rows.mts';
import { smsEnabled, sendSms } from './lib/sms.mts';
import { smsRecipients, eveningTargetDate, smsText, smsClaimPath, selectTextable } from './lib/flag-sms.mts';
import { readRouteClassesFor } from './lib/route-classes.mts';
import { ensureLoadTypes, loadRowsFromTypes } from './lib/load-types.mts';

const TENANT = 'davis';
const DEPOT = { name: 'Buford Terminal', lat: 34.147791, lng: -83.960911 };

function etNowMin(): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const etMin = etNowMin();
    const etToday = etDayString();
    const target = eveningTargetDate(etToday, etMin);
    if (!target) return J({ ok: true, note: 'daytime — the 7:00a-7:40p sweep owns this window', etMin });

    const { date, offsetDays } = target;
    const { stops: rawStops } = await readStops(TENANT, date);
    const stops = withCustomerKeys(rawStops || []);
    if (!stops.length) return J({ ok: true, date, note: 'no board yet for the target date', etMin });

    const keys = [...new Set(stops.map((s: any) => stopCustomerKey(s)).filter(Boolean) as string[])];
    const notes = new Map<string, any>();
    const CHUNK = 25;
    for (let i = 0; i < keys.length; i += CHUNK) {
      await Promise.all(keys.slice(i, i + CHUNK).map(async (k) => {
        try { const d = await getDoc(`customer_notes/${k}`); if (d) notes.set(k, d); } catch { /* missing note = ordinary */ }
      }));
    }

    // Same two-pass travel flow as the day sweep: judge on the cache, fill wanted legs,
    // judge again on the filled cache so tonight's verdicts price legs like the board.
    // WHEN EACH ROUTE ACTUALLY LEAVES — the measured per-route departure, fitted nightly
    // from sealed history. Absent or thin, every route keeps the shipped 8:00a default.
    const departDoc = await getDoc(routeDeparturePath(TENANT)).catch(() => null);
    const departByRoute = readDepartureTable(departDoc);
    // SEVERITY RATCHETS (see tierFloorLookup). A stop that texted at 1:00a must not read as
    // advisory at 6:00a because the clock crept closer to it — Chad: "the flag should remain
    // unless our updated eta is showing we will get there in time." The floor is the
    // worstTier this night's own history already records.
    let tierFloorByStop: Record<string, string> | null = null;
    try {
      const hist: any = await getDoc(flagHistoryPath(TENANT, date));
      const histRows = hist?.rows && typeof hist.rows === 'object' ? Object.values<any>(hist.rows) : [];
      if (histRows.length) {
        const t: Record<string, string> = {};
        for (const r of histRows) if (r?.stopNbr && r?.worstTier) t[String(r.stopNbr)] = String(r.worstTier);
        tierFloorByStop = Object.keys(t).length ? t : null;
      }
    } catch { /* no floor — this sweep judges on its own */ }
    let loadTypes: any = { enabled: false, cached: 0, fetched: 0, failed: 0, wanted: 0 };
    const cal = await readTravelCalibration(TENANT).catch(() => null);
    const calOpts = cal ? { curve: cal.curve, serviceMin: cal.serviceMin } : {};
    // WHICH TRUCK RUNS EACH ROUTE ON THE BOARD BEING JUDGED — and it is the TARGET date's
    // map, never today's. Route names repeat nightly and drivers rotate, so tonight's trucks
    // applied to tomorrow's routes would put a tractor on whatever load inherited the name.
    // The fleet index is written per date and the tomorrow-loads scan gate opens at 20:00 ET,
    // on the same clock this sweep runs on.
    //
    // THIS SWEEP NEVER PUBLISHES route_classes. That document is TODAY's operational state and
    // the day sweep owns it; writing tomorrow's trucks into it at 9pm would put the browser's
    // whole board on the wrong clock until 7am.
    //
    // An empty map is a REAL and ordinary pre-day state — loads exist before anybody has said
    // what is pulling them — and board-flags reports it as skipped.noTruckClasses rather than
    // reading every route as a box truck. No class, no trailer verdict.
    const rc = await readRouteClassesFor(
      () => listFleetLoads(TENANT, date, ['loadNbr', 'routeName', 'vehicleType']),
      stops,
      {},
      async () => {
        // The hourly Loads-grid cache costs nothing and carries the load's own type IF that
        // saved search has the column. Where it does not (the live grid today), ensureLoadTypes
        // asks each load directly — once per load, cached, and only when its switch is on.
        const roster = (await readLoadRoster(TENANT, date).catch(() => null))?.loads || [];
        loadTypes = await ensureLoadTypes(TENANT, date, roster, stops);
        return [...roster, ...loadRowsFromTypes(roster, loadTypes.types)];
      },
    ).catch(() => null);
    const routeClasses = rc?.classes && Object.keys(rc.classes).length ? rc.classes : null;
    const routeClassSource = rc?.sourceByRoute && Object.keys(rc.sourceByRoute).length ? rc.sourceByRoute : null;
    // A pre-day board gets NO nowMin: nothing has departed, so the not-started clamp and
    // the driverless rule (R6) must stay out of it — a tomorrow route without a driver
    // yet is just tomorrow. After midnight the board is today's; nowMin is real, and the
    // pre-dawn hours keep both of those rules naturally quiet anyway.
    const nowOpt = offsetDays === 0 ? { nowMin: etMin } : {};
    const engineOpts = (legs: Record<string, number>) => ({
      depot: DEPOT, ...nowOpt,
      travel: { legs, ...calOpts, ...(routeClasses ? { routeClasses } : {}), ...(routeClassSource ? { routeClassSource } : {}) },
      ...(departByRoute ? { departByRoute } : {}),
      ...(tierFloorByStop ? { tierFloorByStop } : {}),
    });
    const first = computeBoardFlags({ stops, notes, servedDate: date, dayKey: weekdayKey(date), opts: engineOpts({}) });
    let legInfo = { legs: {} as Record<string, number> };
    try { legInfo = await ensureLegs(TENANT, first.legsWanted || []); } catch { /* curve carries it */ }
    const flags = computeBoardFlags({ stops, notes, servedDate: date, dayKey: weekdayKey(date), opts: engineOpts(legInfo.legs) });

    const candidates = selectTextable(flags.rows);
    const recipients = smsRecipients(process.env, etMin);

    const status: any = {
      tenant: TENANT, date, offsetDays, etMin, at: new Date().toISOString(),
      boardStops: stops.length, redCount: flags.redCount, amberCount: flags.amberCount,
      candidates: candidates.length, recipients: recipients.length,
      departuresKnown: departByRoute ? Object.keys(departByRoute).length : 0,
      // WHAT THE TRAILER RULE COULD AND COULD NOT SEE. A pre-day board with no truck classes
      // yet is the ordinary 8pm state, and a night that texted nothing because nobody had
      // said what was pulling the loads must not read like a night with nothing wrong.
      truckClassesKnown: !flags.checked ? null : !flags.skipped?.noTruckClasses,
      routeClassesKnown: routeClasses ? Object.keys(routeClasses).length : 0,
      classSource: rc?.source ?? 'none',
      // How many routes carry a class the LOAD itself stated — the only kind the no-trailer
      // rule acts on. Zero here means that rule is silent tonight, for a data reason.
      loadHeaderClasses: Object.values(rc?.sourceByRoute ?? {}).filter((v) => v === 'load_header').length,
      // The switch's position and what it bought, reported rather than inferred: a no-trailer
      // rule that judged nothing because the fetch is OFF must not read like a clean board.
      loadTypes: { enabled: loadTypes.enabled, cached: loadTypes.cached, fetched: loadTypes.fetched, failed: loadTypes.failed, wanted: loadTypes.wanted },
      tractorRoutes: flags.checked?.tractorRoutes ?? 0,
      trailerConflicts: flags.checked?.trailerConflicts ?? 0,
      // THE ROUTES THIS SWEEP COULD NOT CLASS, BY NAME, WITH THE DRIVER NUVIZZ CARRIES. The
      // Evans miss: BRENT sat unclassed for a one-letter alias difference and no record
      // anywhere said so — a route the map cannot class read exactly like one judged fine.
      // A near-match is named too, so nobody mistakes it for an exact join.
      unclassedRoutes: (rc?.unclassed ?? []).filter((u) => u.reason !== 'appointment_route'),
      nearMatches: rc?.nearMatches ?? [],
      smsEnabled: smsEnabled(), sent: 0, failed: 0, alreadyClaimed: 0,
      texted: [] as any[],
    };

    if (smsEnabled() && recipients.length) {
      for (const row of candidates) {
        // Claim BEFORE sending — one message per subject per board day, no matter how many
        // sweeps see it or how a retry lands. A claim on a failed send is kept, same
        // deliberate trade as the email path: silence over spam.
        //
        // THE SUBJECT IS NOT ALWAYS THE STOP. An hours row claims its stop; a trailer
        // conflict claims its ROUTE, because that is the grain the text is sent at — one
        // message per tractor load, not one per box-only stop on it. Keyed on the stop, a
        // route with four conflicts would have nagged four times as they were fixed one by
        // one, and a stop that was BOTH late and on the wrong truck would have sent whichever
        // message came first and silently swallowed the other.
        const trailer = row.rule === 'trailer_conflict';
        const claimSubject = trailer
          ? String(row.routeKey || row.routeName || row.stopNbr)
          : String(row.stopNbr);
        const claimed = await createDocIfAbsent(smsClaimPath(TENANT, date, claimSubject, row.rule), {
          at: status.at, rule: row.rule ?? 'hours_risk', stopNbr: row.stopNbr ?? null,
          routeName: row.routeKey ?? row.routeName ?? null,
          tier: row.tier, closeMin: row.closeMin ?? null, etaMin: row.etaMin ?? null, etMin,
          ...(trailer ? { routeConflicts: row.routeConflicts ?? 1, blockers: row.blockers ?? [] } : {}),
        });
        if (!claimed) { status.alreadyClaimed += 1; continue; }
        const text = smsText(row, date);
        for (const to of recipients) {
          const r = await sendSms({ to, text });
          if (r.ok) status.sent += 1; else { status.failed += 1; console.error('flag sms failed:', r.error); }
        }
        status.texted.push({
          stopNbr: row.stopNbr, customer: row.customer ?? null, tier: row.tier,
          rule: row.rule ?? 'hours_risk',
          ...(trailer ? { routeName: row.routeKey ?? row.routeName ?? null, routeConflicts: row.routeConflicts ?? 1 } : {}),
        });
      }
    }

    // THE NIGHT NOW LEAVES A RECORD, which is what makes the ratchet survive to breakfast.
    // Only the day sweep wrote flag history, and it does not start until 7:00a — so a stop
    // that texted at 1:00a had no worstTier on file, and the first morning sweep judged it
    // from scratch. A row that had already earned a text could therefore turn up as an
    // advisory on the 7:00a board. Same tested merge the day sweep uses, same document.
    // emailedStops is EMPTY on purpose: this path texts, it never emails, and claiming
    // otherwise in the history is the intent-as-outcome mistake that column already carries
    // scar tissue from.
    if (etMin != null) {
      try {
        const path = flagHistoryPath(TENANT, date);
        const prev = await getDoc(path);
        // THE HISTORY CLOCK MUST LIVE ON THE BOARD'S OWN DAY. A 9:00pm sighting of a stop
        // closing 8:30a TOMORROW is 690 minutes of lead — the earliest warning this system
        // produces. Recorded with tonight's raw etMin (1260) against tomorrow's closeMin
        // (510), leadMin came out -750 and summarize() filed the sweep's best warnings as
        // tooLateToAct, dragging medianLeadMin down across every day the evening sweep ran.
        // On a pre-day board (offsetDays 1) the sighting happens one day BEFORE the board,
        // so its wall-clock minute relative to that board is etMin - 1440.
        const merged = mergeSweep(prev?.rows, auditRows(flags), {
          nowMin: offsetDays === 1 ? etMin - 1440 : etMin, atISO: status.at, emailedStops: new Set<string>(),
        });
        await setDoc(path, {
          tenant: TENANT, date, version: FLAG_HISTORY_VERSION,
          updated_at: status.at, rows: merged.rows,
        });
        status.historyTracked = Object.keys(merged.rows).length;
      } catch (e: any) { console.warn('evening flag history write failed:', e?.message); }
    }
    try { await setDoc(`nuvizz_ops/flag_evening_status__${date}`, status); } catch { /* status is best-effort */ }
    return J({ ok: true, ...status });
  } catch (err: any) {
    return J({ ok: false, error: String(err?.message || err) }, 500);
  }
};

// Hourly through the routing evening and overnight: 00:00-11:00 UTC = 8:00p-7:00a EDT
// (7:00p-6:00a EST). The ET-side rules are the authority, not the cron: a fire that
// lands at 7:00a ET stands down (the day sweep owns it), and Zach's number is dropped
// the minute the 6:00a cutoff passes — recipient logic is minute-accurate. Netlify cron
// fires only on published production deploys.
export const config = { schedule: '0 0-11 * * *' };
