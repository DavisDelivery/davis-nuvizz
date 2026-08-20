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
import { computeBoardFlags, isFinishedStop, dayReceivingWindow } from '../../src/lib/board-flags.js';
import { legSecondsMap, travelLegsPath, readTravelCalibration, readRouteClasses } from './lib/travel-store.mts';
import { routeDeparturePath } from './lib/route-departure.mts';
import { flagHistoryPath } from './lib/flag-history.mts';
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

/**
 * PURE. One stop number, one canonical form.
 *
 * Chad asked this endpoint about "7165047" three times and was told, three times, that no
 * stop with that number was on the board. The stop was there — the feed carries it as
 * 007164290-style, zero-padded to nine digits, and the compare was exact. The number Chad
 * has is the one printed on the paperwork and typed into a phone, which is the number
 * WITHOUT the padding. A diagnostic built to answer "why was this not flagged" that cannot
 * find the stop is worse than no diagnostic, because "not on this board" reads like an
 * answer instead of a miss.
 */
export function normStopNbr(v: any): string {
  return String(v ?? '').trim().toUpperCase()
    .replace(/-\d+$/, '')      // NuVizz's "-1" suffix on a split order
    .replace(/^0+(?=.)/, '');  // the feed pads; paperwork does not. Keep a lone "0".
}

/**
 * PURE. WHY THIS STOP HAS (OR HAS NOT) GOT A DEADLINE ON FILE.
 *
 * `close: null` used to be the end of the answer, and it hides four completely different
 * situations that need four different fixes: the stop has no customer key to look a note up
 * by; there is no note; there is a note with nothing recorded for today; or there IS text and
 * the parser refused it as not comparable. Only the last one is a parser question. The first
 * three are "nobody has told the system when this customer stops receiving", which no amount
 * of engine work fixes — and which is what "close: null" was quietly reporting.
 */
export function hoursProvenance(stop: any, notes: Map<string, any> | null, dayKey: string | null) {
  const matchKey = stop?.matchKey ?? null;
  if (!matchKey) {
    return { matchKey: null, noteOnFile: false, raw: null, parsed: null,
      why: 'this stop carries no customer match key, so no note can be looked up for it at all' };
  }
  const note = notes?.get(matchKey) || null;
  if (!note) {
    return { matchKey, noteOnFile: false, raw: null, parsed: null,
      why: `no customer note on file for "${matchKey}" — nobody has recorded receiving hours for this customer, so the board has no deadline to judge the stop against` };
  }
  const raw = note.receiving_hours?.[String(dayKey ?? '')] ?? null;
  if (!raw) {
    return { matchKey, noteOnFile: true, raw: null, parsed: null,
      why: `there is a note for this customer, but no receiving hours recorded for ${dayKey} — that weekday is blank on the customer card` };
  }
  const w = dayReceivingWindow(note, dayKey);
  if (!w) {
    return { matchKey, noteOnFile: true, raw, parsed: null,
      why: `receiving hours for ${dayKey} read ${JSON.stringify(raw)}, which is not a comparable clock window. Free text ("call first", "RH 7-11AM appt only") and overnight or 24-hour docks are refused rather than guessed at — a guessed deadline is worse than none` };
  }
  return {
    matchKey, noteOnFile: true, raw,
    parsed: { open: w.openMin != null ? clock(w.openMin) : null, close: clock(w.closeMin), tier: w.tier },
    why: null,
  };
}

/**
 * PURE. WHERE THE WHOLE BOARD'S DEADLINES COME FROM — one row per customer, not per stop.
 *
 * Chad, after METRO: "maybe we need the parser to learn how the note for hours was
 * constructed." The right way to answer that is not to read one customer's note and
 * generalise. It is to ask the board how many customers carry hours the parser REFUSES, and
 * to show the actual text it refused, so the question becomes "should it learn THESE shapes"
 * instead of "does it have a problem".
 *
 * The split matters because the fixes are different and land on different people:
 *   • noNote / noHoursAnyDay — nobody has recorded this customer's hours. Data entry.
 *   • blankToday             — hours exist for other weekdays but not this one. Data entry,
 *                              and the likeliest kind to be an oversight rather than a
 *                              deliberate "they are shut".
 *   • refused                — text IS on file and the parser will not guess at it. THIS is
 *                              the only bucket that parser work can move, and the samples
 *                              say whether it is worth moving.
 *
 * Samples are the hours text only — deduped and capped. No addresses, no customer names:
 * the question is what SHAPES appear, and a list of shapes is smaller and safer than a list
 * of customers.
 */
export function hoursCoverage(
  stops: any[], notes: Map<string, any> | null, dayKey: string | null,
  { sampleCap = 24 }: { sampleCap?: number } = {},
) {
  const seen = new Set<string>();
  const sampleSeen = new Set<string>();
  const out = {
    customers: 0, stopsWithNoMatchKey: 0,
    noNote: 0, noHoursAnyDay: 0, blankToday: 0, refused: 0, parsedTyped: 0, parsedAuto: 0,
    refusedSamples: [] as string[],
  };
  for (const s of stops || []) {
    if (!s?.matchKey) { out.stopsWithNoMatchKey += 1; continue; }
    if (seen.has(s.matchKey)) continue;   // one customer, one row — a 3-order stop is not 3 gaps
    seen.add(s.matchKey);
    out.customers += 1;
    const p = hoursProvenance(s, notes, dayKey);
    if (!p.noteOnFile) { out.noNote += 1; continue; }
    if (p.parsed) { if (p.parsed.tier === 'typed') out.parsedTyped += 1; else out.parsedAuto += 1; continue; }
    if (p.raw == null) {
      // "Never recorded" and "recorded for other days but not this one" are different gaps.
      const rh = notes?.get(s.matchKey)?.receiving_hours;
      const anyDay = rh && typeof rh === 'object' && Object.values(rh).some((v) => v);
      if (anyDay) out.blankToday += 1; else out.noHoursAnyDay += 1;
      continue;
    }
    out.refused += 1;
    const text = typeof p.raw === 'string' ? p.raw : JSON.stringify(p.raw);
    if (!sampleSeen.has(text) && out.refusedSamples.length < sampleCap) {
      sampleSeen.add(text);
      out.refusedSamples.push(text);
    }
  }
  return out;
}

// Any stop on the board, flagged or not — because "no email" and "no flag" are different
// answers and the difference is the whole question.
export function explainStop(
  askedStop: string, stops: any[], rows: any[], alertableSet: Set<string>,
  nowMin: number | null, claimed: any[],
  { notes = null, dayKey = null }: { notes?: Map<string, any> | null; dayKey?: string | null } = {},
) {
  const want = normStopNbr(askedStop);
  const matches = (v: any) => normStopNbr(v) === want;
  const stop = (stops || []).find((s: any) => matches(s?.stopNbr) || matches(s?.pro) || matches(s?.primaryPro));
  const row = (rows || []).find((r: any) => matches(r?.stopNbr));

  if (!stop && !row) return { asked: askedStop, found: false, note: 'no stop with that number on this board' };

  const alreadyClaimed = (claimed || []).some((c: any) => matches(c?.stopNbr));
  // WHERE THE DEADLINE COMES FROM — reported whether or not the stop flagged, because the
  // most common answer to "why was this not flagged" turns out not to be about the flag
  // engine at all: the hours were never on file.
  const hours = stop ? hoursProvenance(stop, notes, dayKey) : null;
  return {
    asked: askedStop,
    found: true,
    hours,
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
        // NOT FLAGGED SPLITS IN TWO, and the halves need different people. No parsable
        // hours is a data gap somebody has to fill in on the customer card; hours on file
        // with no flag is the engine saying the stop makes it.
        : hours && !hours.parsed
          ? `no receiving close on file, so nothing to be late for — ${hours.why}`
          : 'receiving hours ARE on file for this stop and the arrival walk does not predict it late'),
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
    // Severity ratchets on the day's own history (see tierFloorLookup). The dry twin reads
    // the SAME floor as the sweeps and the screen — a twin that judged a row one tier calmer
    // than the board would answer "what would the alert do" with something the alert would
    // not do, which is the whole failure this endpoint exists to make impossible.
    let tierFloorByStop: Record<string, string> | null = null;
    try {
      const hist: any = await getDoc(flagHistoryPath(TENANT, date));
      const hrows = hist?.rows && typeof hist.rows === 'object' ? Object.values<any>(hist.rows) : [];
      if (hrows.length) {
        const t: Record<string, string> = {};
        for (const r of hrows) if (r?.stopNbr && r?.worstTier) t[String(r.stopNbr)] = String(r.worstTier);
        tierFloorByStop = Object.keys(t).length ? t : null;
      }
    } catch { /* no floor — judged on this pass alone */ }
    const flags = computeBoardFlags({
      stops, notes, servedDate: date, dayKey: weekdayKey(date),
      opts: {
        depot: DEPOT, ...(nowMin != null ? { nowMin } : {}),
        ...(departByRoute ? { departByRoute } : {}),
        ...(tierFloorByStop ? { tierFloorByStop } : {}),
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
      // WHY THE BOARD HAS THE DEADLINE COVERAGE IT HAS, split by what would fix each gap.
      hoursCoverage: hoursCoverage(stops, notes, weekdayKey(date)),
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
      explain: askedStop ? explainStop(askedStop, stops, flags.rows || [], alertableSet, nowMin, claimed, { notes, dayKey: weekdayKey(date) }) : undefined,
      alreadyClaimedToday: claimed,
      wouldSendNow: alertable.filter((c) => !claimed.some((x) => x.stopNbr === c.stopNbr)).length,
      sample: alertable[0] ? buildAlert(alertable[0], date).subject : null,
    });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
