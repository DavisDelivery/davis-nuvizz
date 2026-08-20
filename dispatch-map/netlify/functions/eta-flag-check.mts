// eta-flag-check.mts
//
// "SHOW ME WHAT THE ALERT WOULD DO." A plain, click-driven endpoint — no cron attached.
//
// This exists because of a property of this project that is easy to forget and expensive to
// rediscover: A FUNCTION CARRYING A SCHEDULE IS NOT REACHABLE OVER PLAIN HTTP. The v0.54.21
// notes record it from the Scan-now button ("a scheduled function is not reliably reachable
// ... the cron fires it happily on its own timer while a manual POST to the same address
// gets refused"), and eta-miss-ledger-background answers a manual POST with a flat 403 today.
//
// So eta-flag-alert-background will email customer service on its own timer and nobody —
// including whoever built it — can ask it what it is about to do. That is the wrong shape for
// something that reaches a real inbox. This endpoint runs the SAME engine and the SAME
// selection rules, always dry: it never sends and never claims, so calling it cannot consume
// a stop's one alert for the day.
//
// It also reports what has ALREADY been claimed today, because "why did customer service not
// hear about this stop" is the question that actually gets asked, and the claim ledger is the
// only place the answer lives.
//
// Read-only. Firestore only. ZERO NuVizz calls.
import { isFirestoreEnabled, readStops, getDoc, listDocs, etDayString } from './lib/firestore.mts';
import { computeBoardFlags, isFinishedStop } from '../../src/lib/board-flags.js';
import { legSecondsMap, travelLegsPath, readTravelCalibration, readRouteClasses } from './lib/travel-store.mts';
import { routeDeparturePath } from './lib/route-departure.mts';
import { withCustomerKeys, stopCustomerKey } from './lib/customer-key.mts';
import { selectAlertable, buildAlert, ALERT_COLLECTION, ALERT_TO, DAILY_ALERT_CAP, ALERT_TIERS, finiteMinutes } from './lib/flag-alert.mts';
import { emailEnabled } from './lib/email.mts';

const TENANT = 'davis';
const DEPOT = { name: 'Buford Terminal', lat: 34.147791, lng: -83.960911 };

function etNowMin(): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  return Number(p.find((x) => x.type === 'hour')?.value ?? 0) * 60
       + Number(p.find((x) => x.type === 'minute')?.value ?? 0);
}
function weekdayKey(date: string): string | null {
  const [y, m, d] = String(date || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dt.getDay()];
}
const clock = (m: number) => {
  const h = Math.floor(m / 60), x = m % 60, ap = h >= 12 ? 'p' : 'a', h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(x).padStart(2, '0')}${ap}`;
};

// ── WHY DID (OR DIDN'T) THIS EMAIL ─────────────────────────────────────────────
//
// PURE, and exported, because "why was customer service not told about this stop?" took
// three modules and a code read to answer the first time it was asked. It should cost one
// request and be provable by a test.

export function heldReason(r: any, alertable: boolean, nowMin: number | null): string | null {
  if (alertable) return null;
  if (r?.rule !== 'hours_risk') return 'not a receiving-hours risk';
  if (!ALERT_TIERS.has(String(r?.tier))) return `tier is ${r?.tier} — only ${[...ALERT_TIERS].join(' and ')} email`;
  if (!r?.stopNbr || r?.collapsed) return 'a collapsed summary row, not an individual stop';
  // The same strict parser the gate uses — Number('') and Number(null) are both 0, which is
  // finite, so a loose check reports a stop with no deadline as "the window closed at
  // 12:00a" and sends someone chasing the wrong thing.
  const close = finiteMinutes(r?.closeMin);
  if (close == null) return 'no receiving close on this stop';
  if (nowMin != null && nowMin >= close) {
    return `the window closed at ${clock(close)} and it is now ${clock(nowMin)} — Chad: "if we are already past the time shouldn't send"`;
  }
  return 'held for a reason this endpoint does not model — read selectAlertable';
}

export function explainRow(r: any, alertableSet: Set<string>, nowMin: number | null) {
  const alertable = alertableSet.has(String(r?.stopNbr));
  return {
    stopNbr: r?.stopNbr, customer: r?.customer, route: r?.routeName, tier: r?.tier,
    close: clock(r?.closeMin), eta: clock(r?.etaMin), lateBy: r?.lateBy,
    anchored: r?.anchored, errorBand: r?.errorMin,
    wouldEmailNow: alertable,
    heldBecause: heldReason(r, alertable, nowMin),
  };
}

// Any stop on the board, flagged or not — because "no email" and "no flag" are different
// answers and the difference is the whole question.
export function explainStop(
  askedStop: string, stops: any[], rows: any[], alertableSet: Set<string>,
  nowMin: number | null, claimed: any[],
) {
  const want = String(askedStop).trim().toUpperCase();
  const matches = (v: any) => String(v ?? '').trim().toUpperCase().replace(/-\d+$/, '') === want.replace(/-\d+$/, '');
  const stop = (stops || []).find((s: any) => matches(s?.stopNbr) || matches(s?.pro) || matches(s?.primaryPro));
  const row = (rows || []).find((r: any) => matches(r?.stopNbr));

  if (!stop && !row) return { asked: askedStop, found: false, note: 'no stop with that number on this board' };

  const alreadyClaimed = (claimed || []).some((c: any) => matches(c?.stopNbr));
  return {
    asked: askedStop,
    found: true,
    customer: stop?.businessName || row?.customer || null,
    route: row?.routeName || stop?.routeName || null,
    status: stop?.normalizedStatus || stop?.status || null,
    finished: isFinishedStop(stop || {}),
    flagged: !!row,
    // No row at all means the hours never reached the engine — a different failure from
    // "flagged but held", and the one that used to make the whole board read clean.
    tier: row?.tier ?? null,
    close: row?.closeMin != null ? clock(row.closeMin) : null,
    eta: row?.etaMin != null ? clock(row.etaMin) : null,
    lateBy: row?.lateBy ?? null,
    emailedToday: alreadyClaimed,
    wouldEmailNow: row ? alertableSet.has(String(row.stopNbr)) : false,
    heldBecause: alreadyClaimed ? 'already emailed once today — one per stop per board day'
      : (row ? heldReason(row, alertableSet.has(String(row.stopNbr)), nowMin)
             : 'no receiving-hours flag on this stop: either it has no parsed receiving close, or it is not predicted late'),
  };
}

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date') || etDayString();
    const nowParam = url.searchParams.get('now');
    // `?now=` lets a dispatcher ask "what will this look like at 2pm" without waiting for 2pm.
    const nowMin = nowParam ? Number(nowParam) : (date === etDayString() ? etNowMin() : null);

    const { stops: rawStops } = await readStops(TENANT, date);
    // THE LIVE STOP INDEX DOES NOT CARRY matchKey. computeBoardFlags looks its receiving
    // hours up by stop.matchKey, so without this every stop reads as having no deadline and
    // the whole board comes back clean — measured: 778 stops, 63 routes judged, 0 flags.
    const stops = withCustomerKeys(rawStops);
    if (!stops?.length) return J({ ok: true, date, note: 'no board for this date' });

    const keys = [...new Set(stops.map((s: any) => stopCustomerKey(s)).filter(Boolean) as string[])];
    const notes = new Map<string, any>();
    for (let i = 0; i < keys.length; i += 25) {
      await Promise.all(keys.slice(i, i + 25).map(async (k) => {
        try { const d = await getDoc(`customer_notes/${k}`); if (d) notes.set(k, d); } catch { /* no note is ordinary */ }
      }));
    }

    // The SAME travel inputs the alert sweep judges on — cached real legs plus the
    // calibrated curve — read, never fetched: a diagnostic must not spend API calls or
    // warm caches, only explain the verdicts the live path produced.
    const [cal, legDoc, routeClasses] = await Promise.all([
      readTravelCalibration(TENANT).catch(() => null),
      getDoc(travelLegsPath(TENANT)).catch(() => null),
      readRouteClasses(TENANT, date).catch(() => ({})),
    ]);
    // Measured per-route departures, same table the sweeps judge on — so the dry twin
    // cannot disagree with the alert about when a truck leaves.
    const departDoc = await getDoc(routeDeparturePath(TENANT)).catch(() => null);
    const departByRoute = departDoc?.table || null;
    const flags = computeBoardFlags({
      stops, notes, servedDate: date, dayKey: weekdayKey(date),
      opts: {
        depot: DEPOT, ...(nowMin != null ? { nowMin } : {}),
        ...(departByRoute ? { departByRoute } : {}),
        travel: {
          legs: legSecondsMap(legDoc), routeClasses,
          ...(cal ? {
            curve: cal.curve, serviceMin: cal.serviceMin,
            ...(cal.classCurves ? { classCurves: cal.classCurves } : {}),
            ...(cal.classService ? { classService: cal.classService } : {}),
          } : {}),
        },
      },
    });

    // EVERY URGENT ROW, not just the top tier. This list used to filter to
    // tier === 'critical', which gave it the same blind spot as the alert itself: when Chad
    // asked why a red flag on SIMPLY CHARLOTTE MASON sent no email, the endpoint built to
    // answer that question could not see the row either. A diagnostic that shares the bug it
    // is meant to diagnose is worse than none, because it reads like a clean bill of health.
    const urgent = (flags.rows || []).filter((r: any) => r.rule === 'hours_risk' && ALERT_TIERS.has(String(r.tier)));
    const askedStop = url.searchParams.get('stop');
    const alertable = selectAlertable(flags.rows, nowMin);
    const alertableSet = new Set(alertable.map((c) => c.stopNbr));

    // What has already been claimed today. A claim means an email was attempted; it is
    // deliberately kept even when the send failed, so this list answers "why no second one".
    let claimed: any[] = [];
    try {
      const docs = await listDocs(ALERT_COLLECTION);
      claimed = (docs || [])
        .filter((d: any) => d?.tenant === TENANT && d?.date === date)
        .map((d: any) => ({ stopNbr: d.stopNbr, customer: d.customer, lateBy: d.lateBy, claimed_at: d.claimed_at }));
    } catch { /* the collection does not exist until the first claim */ }

    // PROVE IT LOOKED. A bare "0 critical" is indistinguishable from "the notes never
    // loaded and every stop looked deadline-free" — the silent-zero failure this endpoint
    // exists to catch. computeBoardFlags already counts what it examined; surface it.
    const diag = {
      stopsSeen: stops.length,
      distinctCustomerKeys: keys.length,
      notesLoaded: notes.size,
      stopsWithHoursToday: flags.checked?.stopsWithHours ?? null,
      routesJudged: flags.checked?.routesJudged ?? null,
      openStopsChecked: flags.checked?.stops ?? null,
      skipped: flags.skipped,
      sampleStopKeys: stops.slice(0, 3).map((s: any) => s?.matchKey ?? null),
    };

    return J({
      ok: true, dryRun: true, date, diag,
      now: nowMin != null ? clock(nowMin) : null,
      emailConfigured: emailEnabled(), to: ALERT_TO, dailyCap: DAILY_ALERT_CAP,
      counts: { critical: flags.criticalCount ?? 0, red: flags.redCount ?? 0, amber: flags.amberCount ?? 0 },
      // Every urgent row, and for each one WHY it would or would not be emailed right now.
      urgent: urgent.map((r: any) => explainRow(r, alertableSet, nowMin)),
      // ?stop=<PRO> — the answer to "why did I not get an email about THIS one", for any
      // stop on the board, flagged or not. Added because answering it once by hand meant
      // reading three modules; it should cost one request.
      explain: askedStop ? explainStop(askedStop, stops, flags.rows || [], alertableSet, nowMin, claimed) : undefined,
      alreadyClaimedToday: claimed,
      wouldSendNow: alertable.filter((c) => !claimed.some((x) => x.stopNbr === c.stopNbr)).length,
      sample: alertable[0] ? buildAlert(alertable[0], date).subject : null,
    });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
