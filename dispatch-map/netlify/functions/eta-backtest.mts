// eta-backtest.mts
//
// HOW WRONG IS THE ARRIVAL MODEL? Chad, after PRO 007163412 (PYROK INC, 2pm close,
// second-to-last on the load) produced no flag at all: "How are we predicting a truck
// will be late or miss its time? Think long and hard about your answer... this was
// originally built as an afterthought but now it's vital."
//
// Before changing a single constant, measure. This replays the arrival model over the
// immutable history warehouse and scores it against what the trucks ACTUALLY did —
// ~15 sealed weekdays, ~800 stops each. Read-only, Firestore only, ZERO NuVizz calls.
//
//   GET ?from=YYYY-MM-DD&to=YYYY-MM-DD   (defaults to the whole captured window)
//      &sample=N                          include N worst-error rows for eyeballing
//
// WHAT IT SCORES. Four models on identical inputs, because the decision is which model
// to ship, and grading one in isolation cannot answer that:
//
//   A  current    — the shipped model: depart 8:00, 30mph, straight-line x1.3, 20min/stop
//   B  calibrated — same shape, but speed/service/road-factor fitted to this history
//   C  anchored   — walk the route, and whenever an EARLIER stop carries a real arrival
//                   stamp, reset the clock to it and project forward from there
//   D  vendor     — NuVizz's own per-stop ETA where the enrichment captured one
//
// THE AS-OF RULE, which is the whole reason C is trustworthy. C may only use stamps from
// stops EARLIER IN SEQUENCE than the one being predicted. Anchoring on a stamp from a
// later stop would be hindsight, and a model graded with hindsight always wins and always
// lies. Sequence order (not clock order) is the honest available-information boundary: at
// the moment the truck is heading for stop 9, stops 1-8 are what has happened.
//
// SIGNED ERROR, NOT ABSOLUTE. predicted minus actual, in minutes. Bias and spread are
// different problems with different fixes — a model 40 minutes optimistic on average is
// re-anchored, a model unbiased but +-60 wide needs better inputs. Averaging |error|
// hides which one we have.
import { isFirestoreEnabled } from './lib/firestore.mts';
import { listStops } from './lib/history-store.mts';

const TENANT = 'davis';

// Mirrors of the shipped constants (src/lib/routing-select.js + board-flags.js). Kept as
// literals rather than imported because this function bundles server-side and src/ is the
// client tree — but any drift here invalidates the whole exercise, so the numbers are
// named and commented, and the response echoes them for checking against the client.
const ROAD_FACTOR = 1.3;          // straight-line -> road distance
const AVG_SPEED_MPS = 13.4;       // ~30 mph, flat, all day
const SERVICE_SEC = 20 * 60;      // 20 minutes at every stop regardless of freight
const DEPART_MIN = 8 * 60;        // 8:00am assumed departure
const DEPOT = { lat: 34.147791, lng: -83.960911 };   // Buford Terminal

const R_EARTH = 6371000;
function haversineMeters(a: any, b: any): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/**
 * The stamps are NAIVE ET wall-clock ("YYYY-MM-DDTHH:MM") with no offset — the same shape
 * parseNaiveStamp documents in lib/customer-comms.mts, where handing one to Date+timeZone
 * reads 4-5 hours early and rolls a pre-dawn delivery to the previous DAY. So this reads
 * the digits directly and never constructs a Date. Returns minutes past midnight, or null.
 */
function stampMin(v: any): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  const hh = Number(m[4]), mm = Number(m[5]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}
/** The DATE half of a stamp, so a stop stamped on another day can be excluded. */
function stampDay(v: any): string { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '')); return m ? m[1] : ''; }

const numOr = (v: any) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const seqOf = (s: any) => numOr(s?.routeSeq ?? s?.stopSeq ?? s?.displaySeq ?? s?.position);
const routeKeyOf = (s: any) => String(s?.loadNbr || s?.routeName || '').trim();
const posOf = (s: any) => {
  const lat = numOr(s?.lat), lng = numOr(s?.lng);
  return lat != null && lng != null ? { lat, lng } : null;
};
const isPickup = (s: any) => String(s?.stopType || '').toUpperCase() === 'PU';
const isAppointmentRoute = (k: string) => /\b(APPT|APPOINTMENT)\b/i.test(k);

/** What the truck ACTUALLY did. Arrival is what the model predicts; delivery is the
 *  fallback when the feed carried no arrival stamp (it is later, so this is conservative
 *  — it makes the model look BETTER, never worse). */
function actualArrivalMin(s: any, date: string): number | null {
  for (const f of ['arrivalDTTM', 'deliveredDTTM']) {
    const v = s?.[f];
    if (!v) continue;
    if (stampDay(v) && stampDay(v) !== date) continue;   // stamped on another day — not this board's run
    const m = stampMin(v);
    if (m != null) return m;
  }
  return null;
}

/** NuVizz's own ETA. route-stop-line.js documents that the TOP-LEVEL plannedEtaDTTM is
 *  ambiguous (the list scan fills it with a generic saved-search time); only the
 *  stopExecutionInfo path is the real route ETA. So only that path is read here. */
function vendorEtaMin(s: any): number | null {
  const v = s?.raw?.stopExecutionInfo?.to?.plannedEtaDTTM;
  return v ? stampMin(v) : null;
}

interface Row {
  date: string; route: string; seq: number; stopNbr: string; customer: string;
  actual: number; predA: number | null; predC: number | null; predD: number | null;
  idx: number; legMeters: number; pallets: number | null;
  predB: number | null;
  hops: number;   // stops since the last real arrival stamp C could anchor on (0 = none yet)
}

/** Replay one route. Returns one row per stop that has BOTH a position and a real
 *  arrival stamp — a stop we cannot score is excluded from the error stats and counted
 *  separately, never silently treated as correct. */
function replayRoute(stops: any[], date: string, tuned: { speed: number; service: number; road: number }): { rows: Row[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  const bump = (k: string) => { skipped[k] = (skipped[k] || 0) + 1; };
  const rows: Row[] = [];

  const deliveries = stops.filter((s) => !isPickup(s));
  const seqd = deliveries.filter((s) => seqOf(s) != null);
  // Same route-level gate the shipped model applies: an invented order produces confident
  // wrong answers, so a route without real sequence coverage is not judged at all.
  if (!seqd.length || seqd.length < deliveries.length * 0.7) { bump('route_no_sequence'); return { rows, skipped }; }
  seqd.sort((a, b) => (seqOf(a) as number) - (seqOf(b) as number));

  // Same duplicate-visit collapse: a multi-order customer arrives as one row per order
  // sharing a sequence slot, and counting each as its own stop adds a phantom service
  // block that inflates every later arrival.
  const seen = new Set<string>();
  const visits = seqd.filter((s) => {
    const vk = `${seqOf(s)}|${String(s.matchKey || s.businessName || s.stopNbr || '').toLowerCase()}`;
    if (seen.has(vk)) return false;
    seen.add(vk);
    return true;
  });

  let cur: any = DEPOT;
  let clockA = DEPART_MIN;          // model A: pure projection, SHIPPED constants
  let clockB = DEPART_MIN;          // model B: pure projection, TUNED constants (no anchor)
  let clockC = DEPART_MIN;          // model C: tuned constants AND re-anchored on observed stamps
  let idx = 0;
  // How far C is projecting past its last real stamp. This is the number that decides whether
  // a re-anchored model can answer "will the truck make a 2pm close five stops from now" —
  // C's headline accuracy is measured one hop out, and one hop is not the question being asked.
  let hops = 0;

  for (const s of visits) {
    idx += 1;
    const pos = posOf(s);
    // The shipped model BREAKS the chain here and abandons the rest of the route. The
    // back-test records that as a skip and keeps walking, because the question "how many
    // stops does the chain-break blind us to" is one of the things being measured.
    if (!pos) { bump('stop_no_position'); continue; }

    const legMeters = haversineMeters(cur, pos);
    const travelA = (legMeters * ROAD_FACTOR / AVG_SPEED_MPS) / 60;
    const travelT = (legMeters * tuned.road / tuned.speed) / 60;

    clockA += travelA;
    clockB += travelT;
    clockC += travelT;
    hops += 1;

    const actual = actualArrivalMin(s, date);
    if (actual == null) {
      bump('stop_no_arrival_stamp');
    } else {
      rows.push({
        date, route: routeKeyOf(s), seq: seqOf(s) as number, stopNbr: String(s.stopNbr ?? ''),
        customer: String(s.businessName || ''),
        actual,
        predA: Math.round(clockA),
        predB: Math.round(clockB),
        predC: Math.round(clockC),
        hops,
        predD: vendorEtaMin(s),
        idx, legMeters: Math.round(legMeters), pallets: numOr(s?.pallets),
      });
    }

    clockA += SERVICE_SEC / 60;
    clockB += tuned.service / 60;
    clockC += tuned.service / 60;

    // MODEL C's ANCHOR — and the as-of rule that makes it honest. Once this stop's own
    // arrival is known, later stops in the sequence may be projected from it. It is applied
    // AFTER this stop was scored, so no stop is ever predicted using its own answer.
    if (actual != null) { clockC = actual + tuned.service / 60; hops = 0; }

    cur = pos;
  }
  return { rows, skipped };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return Math.round(a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]);
};
const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((n, x) => n + x, 0) / xs.length) : null);

function stats(errs: number[]) {
  if (!errs.length) return { n: 0 };
  const abs = errs.map(Math.abs);
  return {
    n: errs.length,
    bias_mean: mean(errs),          // + = predicted LATER than reality (pessimistic)
    bias_median: pct(errs, 50),
    p10: pct(errs, 10), p90: pct(errs, 90),
    abs_median: pct(abs, 50), abs_p90: pct(abs, 90),
    within_15: Math.round((abs.filter((x) => x <= 15).length / abs.length) * 100),
    within_30: Math.round((abs.filter((x) => x <= 30).length / abs.length) * 100),
    within_60: Math.round((abs.filter((x) => x <= 60).length / abs.length) * 100),
  };
}

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const from = url.searchParams.get('from') || '2026-07-28';
    const to = url.searchParams.get('to') || '2026-08-17';
    const sampleN = Math.min(60, Number(url.searchParams.get('sample') || 20));
    const speed = Number(url.searchParams.get('speed') || AVG_SPEED_MPS);
    const service = Number(url.searchParams.get('service') || SERVICE_SEC);
    const road = Number(url.searchParams.get('road') || ROAD_FACTOR);
    const tuned = { speed, service, road };

    const dates: string[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    const allRows: Row[] = [];
    const skipped: Record<string, number> = {};
    const perDay: Record<string, number> = {};
    let routesSeen = 0;

    for (const date of dates) {
      let stops: any[] = [];
      try { stops = await listStops(TENANT, date); } catch { continue; }
      if (!stops.length) continue;

      const byRoute = new Map<string, any[]>();
      for (const s of stops) {
        const k = routeKeyOf(s);
        if (!k || isAppointmentRoute(k)) continue;
        if (!byRoute.has(k)) byRoute.set(k, []);
        (byRoute.get(k) as any[]).push(s);
      }
      for (const [, group] of byRoute) {
        routesSeen += 1;
        const r = replayRoute(group, date, tuned);
        allRows.push(...r.rows);
        for (const [k, v] of Object.entries(r.skipped)) skipped[k] = (skipped[k] || 0) + v;
      }
      perDay[date] = allRows.filter((x) => x.date === date).length;
    }

    const errA = allRows.filter((r) => r.predA != null).map((r) => (r.predA as number) - r.actual);
    const errB = allRows.filter((r) => r.predB != null).map((r) => (r.predB as number) - r.actual);
    const errC = allRows.filter((r) => r.predC != null).map((r) => (r.predC as number) - r.actual);
    const withVendor = allRows.filter((r) => r.predD != null);
    const errD = withVendor.map((r) => (r.predD as number) - r.actual);

    // Does error compound down the route? This is the question behind PYROK being
    // second-to-last: if it grows with position, late stops are where the model is blindest.
    const byIdx: Record<string, any> = {};
    for (const b of [[1, 3], [4, 6], [7, 10], [11, 15], [16, 99]]) {
      const sel = allRows.filter((r) => r.idx >= b[0] && r.idx <= b[1] && r.predA != null);
      byIdx[`stops_${b[0]}_${b[1] === 99 ? 'plus' : b[1]}`] = stats(sel.map((r) => (r.predA as number) - r.actual));
    }
    // And by hour of day, which is where a flat 30mph should show its seams.
    const byHour: Record<string, any> = {};
    for (const h of [[6, 9], [9, 12], [12, 15], [15, 24]]) {
      const sel = allRows.filter((r) => r.actual >= h[0] * 60 && r.actual < h[1] * 60 && r.predA != null);
      byHour[`${h[0]}-${h[1]}`] = stats(sel.map((r) => (r.predA as number) - r.actual));
    }

    // HOW FAR CAN A RE-ANCHORED MODEL SEE? C's headline number is dominated by one-hop
    // predictions, and a flag that only fires one stop ahead fires too late to act on.
    // Bucketing by hops-since-anchor is the honest read of C's usable horizon.
    const byHop: Record<string, any> = {};
    for (const b of [[1, 1], [2, 2], [3, 4], [5, 7], [8, 99]]) {
      const sel = allRows.filter((r) => r.hops >= b[0] && r.hops <= b[1] && r.predC != null);
      byHop[`hops_${b[0]}${b[1] === b[0] ? '' : `_${b[1] === 99 ? 'plus' : b[1]}`}`] = stats(sel.map((r) => (r.predC as number) - r.actual));
    }

    // WHAT TIME DOES THE TRUCK ACTUALLY LEAVE? The 8:00 departure is an assumption nobody
    // ever checked. Back the first stop's travel out of its real arrival and the assumption
    // becomes a measurement — and if it is wrong, every stop on every route inherits the error.
    const firsts = allRows.filter((r) => r.idx === 1);
    const departImplied = firsts.map((r) => r.actual - ((r.legMeters * ROAD_FACTOR / AVG_SPEED_MPS) / 60));
    const departStats = departImplied.length ? {
      n: departImplied.length,
      median_min: pct(departImplied, 50), p10: pct(departImplied, 10), p90: pct(departImplied, 90),
      median_clock: (() => { const m = pct(departImplied, 50) as number; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`; })(),
    } : { n: 0 };

    // WHAT IS A STOP ACTUALLY WORTH IN MINUTES? Consecutive real stamps on the same route
    // give service+travel end to end; subtract modelled travel and the remainder is service.
    const svc: number[] = [];
    for (let i = 1; i < allRows.length; i += 1) {
      const a = allRows[i - 1], b = allRows[i];
      if (a.date !== b.date || a.route !== b.route || b.idx !== a.idx + 1) continue;
      const travel = (b.legMeters * ROAD_FACTOR / AVG_SPEED_MPS) / 60;
      const gap = b.actual - a.actual - travel;
      if (gap > -60 && gap < 240) svc.push(gap);
    }
    const serviceStats = svc.length
      ? { n: svc.length, median_min: pct(svc, 50), p10: pct(svc, 10), p90: pct(svc, 90), mean_min: mean(svc) }
      : { n: 0 };

    // RAW ERROR ARRAYS so a caller can pool exactly across days instead of averaging medians.
    const raw = url.searchParams.get('raw') === '1'
      ? allRows.map((r) => [r.actual, r.predA, r.predB, r.predC, r.predD, r.idx, r.hops, r.legMeters])
      : undefined;

    const worst = [...allRows]
      .filter((r) => r.predA != null)
      .sort((a, b) => Math.abs((b.predA as number) - b.actual) - Math.abs((a.predA as number) - a.actual))
      .slice(0, sampleN)
      .map((r) => ({
        date: r.date, route: r.route, seq: r.seq, idx: r.idx, customer: r.customer,
        predicted: `${String(Math.floor((r.predA as number) / 60)).padStart(2, '0')}:${String((r.predA as number) % 60).padStart(2, '0')}`,
        actual: `${String(Math.floor(r.actual / 60)).padStart(2, '0')}:${String(r.actual % 60).padStart(2, '0')}`,
        error_min: (r.predA as number) - r.actual,
        leg_mi: Math.round((r.legMeters / 1609) * 10) / 10,
      }));

    return J({
      ok: true,
      window: { from, to, days: dates.length },
      constants: { road_factor: ROAD_FACTOR, avg_speed_mps: AVG_SPEED_MPS, service_min: SERVICE_SEC / 60, depart: '08:00', depot: DEPOT },
      tuned_used: { road: tuned.road, speed_mps: tuned.speed, service_min: tuned.service / 60 },
      coverage: {
        routes_seen: routesSeen,
        stops_scored: allRows.length,
        vendor_eta_present: withVendor.length,
        vendor_eta_pct: allRows.length ? Math.round((withVendor.length / allRows.length) * 100) : 0,
        skipped,
      },
      models: {
        A_current: stats(errA),
        B_calibrated: stats(errB),
        C_anchored: stats(errC),
        D_vendor: stats(errD),
      },
      A_by_route_position: byIdx,
      A_by_hour_of_day: byHour,
      C_by_horizon: byHop,
      observed_departure: departStats,
      observed_service: serviceStats,
      raw,
      per_day_scored: perDay,
      worst_rows: worst,
    });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
