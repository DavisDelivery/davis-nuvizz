// driver-loads.mts — A DRIVER'S WEEK OF LOADS, FOR THE STOP LOOKUP SCREEN.
//
// Chad, 2026-09-25: "add a load look up so if i wanted to evaluate a weeks worth of a drivers
// loads … want milage of load earnings of load cost of load stops ect" — "i want this to be part
// of the stops lookup tab".
//
//   GET ?week=2026-09-25                  who ran loads that week — a list to choose from
//   GET ?week=2026-09-25&driver=colin     that driver's week: every load, its stops, freight,
//                                         times, road miles and order prices; cost said absent
//   GET ?week=…&key=COLIN                 the same, by the key an earlier answer handed back
//   GET ?week=…&explain=1                 what the week's records HOLD — counts only, no names
//   → { ok, nuvizzCalls: 0, googleCalls, mode, week, … }
//
// THE RULES LIVE IN src/lib/load-lookup.js (pure, tested). This file reads and asks.
//
// ── WHAT IS READ ─────────────────────────────────────────────────────────────
//   history_days/{t}__{d}                   is the day sealed?
//   history_days/{t}__{d}/stops             the sealed day, masked to LOAD_STOP_FIELDS
//   nuvizz_stop_index/{t}__{d}/stops        the board, for a day not sealed yet (today)
//   employees + nuvizz_ops/driver_aliases   who is the same person (the territory sheet's fold)
//   travel_calibration/…route_classes__{d}  tractor or box, that day
//   load_miles/{t}__{d}__{load}__{driver}   a distance already measured for this exact path
//
// ZERO NUVIZZ CALLS, BY CONSTRUCTION: nothing this file imports can reach the vendor.
//
// ONE OUTSIDE CALL, AND IT IS GOOGLE'S. Road miles are stored nowhere (see load-lookup.js), so
// they are measured: Google's driving distance over the stops in the order they were delivered,
// yard to yard. One Google Routes request per load (two past 25 stops); the answer is kept in
// load_miles against the path's fingerprint, so a sealed load is measured once, ever.
// LOAD_MILES=off stops every Google request AND every cached read — the screen then says the
// miles are switched off, rather than showing yesterday's cache as if it were measured.
//
// Gated at DISPATCHER, one step above the rest of Stop lookup: this adds up a driver's week of
// order prices, which is a revenue picture, not the facts on one stop card.

import { isFirestoreEnabled, getDoc, setDoc, readStops, etDayString, listDocs, runQuery } from './lib/firestore.mts';
import { getManifest, listStops, histDocId, dayPath } from './lib/history-store.mts';
import { readRouteClasses } from './lib/travel-store.mts';
import { driverAliases } from './lib/marginiq.mts';
import { fetchWithTimeout } from './lib/async-util.mts';
import { requireUser, jsonResponse } from './lib/require-user.mts';
import { LOAD_STOP_FIELDS } from './lib/board-fields.mts';
import { dropCancelledEnabled } from '../../src/lib/stop-cancelled.js';
import { applyAliases, driverKeyOf } from '../../src/lib/driver-territory.js';
import { shipperOf } from '../../src/lib/label-shippers.js';
import {
  weekOf, datesBetween, driversOfWeek, resolveDriver, driverWeek, routeChunks, pathFingerprint, orderPrice, finishedAt,
  loadOf, YARD, COST_NOT_RECORDED,
} from '../../src/lib/load-lookup.js';

const TENANT = 'davis';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALIAS_PATH = 'nuvizz_ops/driver_aliases';
export const LOAD_MILES_COLLECTION = 'load_miles';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const GOOGLE_TIMEOUT_MS = 8000;
/** A whole week of one driver is ~6 loads; this is the ceiling one request may spend on Google. */
export const MAX_GOOGLE_CALLS = 24;
const READ_CONC = 4;
const READ_CONC_LONG = 24;
/** Up to two weeks, whole days are read; longer, the driver-first path. */
export const WHOLE_DAY_MAX = 14;
/** The widest range one request answers — a year and a little. */
export const MAX_DAYS = 400;

/**
 * THE WAY BACK (CLAUDE.md, "ship it so it can be put back"). Default ON; an explicit off-word
 * turns it off; anything malformed leaves it on — a typo must not silently blank the miles.
 */
export function loadMilesEnabled(env: any = process.env): boolean {
  const v = String(env?.LOAD_MILES ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/**
 * The cached distance's document. A load's NAME is a person's string — "APPT #2", "COLIN/DJ 1",
 * an em dash — and firestore.mts refuses `/ \\ ? #` in a segment (a `#` would drop the rest of
 * the URL). A refused path is swallowed on this cache path, so the load would never be kept and
 * would be measured by Google on every look. Slashes become `_` (histDocId, the warehouse's own
 * rule — an encoded slash is still a separator); everything else is percent-encoded, which the
 * guard allows and Firestore decodes back to the name.
 */
export function loadMilesPath(date: string, load: string, driverKey: string): string {
  const seg = (v: string) => encodeURIComponent(histDocId(v));
  return `${LOAD_MILES_COLLECTION}/${TENANT}__${date}__${seg(load)}__${seg(driverKey)}`;
}

/** Why Google did not measure a load, in the words the screen prints under the blank. */
export function googleRefusal(status: number): string {
  if (status === 429) return 'Google was busy and did not measure it — open the week again';
  if (status === 403 || status === 401) return `Google refused to measure it (${status}) — the site's Routes key may not allow route requests`;
  return `Google could not measure it (answered ${status})`;
}

/** Google's driving distance along one path, request by request. Null + a reason on any failure. */
export async function googleMeters(points: any[], apiKey: string, fetchFn: typeof fetchWithTimeout = fetchWithTimeout): Promise<{ meters: number | null; calls: number; error?: string }> {
  const ll = (p: any) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  let meters = 0;
  let calls = 0;
  for (const c of routeChunks(points)) {
    calls += 1;
    try {
      const resp = await fetchFn(ROUTES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'routes.distanceMeters' },
        body: JSON.stringify({
          origin: ll(c.origin), destination: ll(c.destination), travelMode: 'DRIVE',
          // vehicleStopover: the truck stops at each of these — Google then keeps the drop on a road a truck can stop on.
          ...(c.intermediates.length ? { intermediates: c.intermediates.map((p: any) => ({ ...ll(p), vehicleStopover: true })) } : {}),
        }),
      }, GOOGLE_TIMEOUT_MS);
      if (!resp.ok) return { meters: null, calls, error: googleRefusal(resp.status) };
      const j: any = await resp.json();
      const m = Number(j?.routes?.[0]?.distanceMeters);
      if (!Number.isFinite(m) || m <= 0) return { meters: null, calls, error: 'Google found no drivable route for this load' };
      meters += m;
    } catch {
      return { meters: null, calls, error: 'Google did not answer in time — open the week again to measure it' };
    }
  }
  return { meters, calls };
}

async function inPool<T, R>(items: T[], conc: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/**
 * ONE DAY'S ROWS — the sealed record when the day is sealed, the board when it is not. Which one
 * answered is part of the answer: a sealed day cannot change again, a board day still can.
 */
async function readDay(date: string, today: string): Promise<{ date: string; source: string; rows: any[]; error?: string }> {
  if (date > today) return { date, source: 'future', rows: [] };
  try {
    const m = await getManifest(TENANT, date);
    const sealed = !!(m && (m.complete || m.verified) && !m.no_board);
    const docs = sealed
      ? await listStops(TENANT, date, { mask: LOAD_STOP_FIELDS })
      : (await readStops(TENANT, date, { mask: LOAD_STOP_FIELDS })).stops;
    // THE COLLECTION KEY IS THE BOARD DAY — a stored date field that disagrees is stale.
    const rows = docs.map(({ _id, last_scanned_at, ...r }: any) => ({ ...r, date }));
    return { date, source: sealed ? 'sealed' : (rows.length ? 'board' : 'none'), rows };
  } catch (e: any) {
    return { date, source: 'unread', rows: [], error: String(e?.message || e).slice(0, 160) };
  }
}

/**
 * A DAY FOR A LONG RANGE: a sealed day's DRIVERS list (~70 small documents, written at the seal),
 * one stand-in row per load; a day not sealed is read whole off the board, as the short path does.
 */
async function readDayDrivers(date: string, today: string): Promise<any> {
  if (date > today) return { date, source: 'future', rows: [] };
  try {
    const m = await getManifest(TENANT, date);
    if (!(m && (m.complete || m.verified) && !m.no_board)) return readDay(date, today);
    const docs = await listDocs(`${dayPath(TENANT, date)}/drivers`);
    const rows = docs.flatMap((d: any) => (Array.isArray(d.loadNbrs) ? d.loadNbrs : []).map((ln: string) => ({
      __fromDrivers: true, __names: [d.driverName, d.driverUserName].filter(Boolean),
      date, driverName: d.driverName ?? null, driverUserName: d.driverUserName ?? null, loadNbr: ln, routeName: ln,
    })));
    return { date, source: 'sealed', rows };
  } catch (e: any) {
    return { date, source: 'unread', rows: [], error: String(e?.message || e).slice(0, 160) };
  }
}

/** One sealed day's orders for these driver names only — a query, masked, not the whole day. */
async function readDriverStops(date: string, names: string[]): Promise<any[]> {
  const docs = await runQuery({
    from: [{ collectionId: 'stops' }],
    where: { fieldFilter: { field: { fieldPath: 'driverName' }, op: 'IN', value: { arrayValue: { values: names.slice(0, 30).map((n) => ({ stringValue: n })) } } } },
    select: { fields: LOAD_STOP_FIELDS.map((f) => ({ fieldPath: f })) },
  }, dayPath(TENANT, date));
  return docs.map(({ _id, last_scanned_at, ...r }: any) => r);
}

/** Counts only — what the week's records hold. The free diagnostic, and it names nobody. */
export function explainWeek(days: any[]) {
  return days.map((d) => {
    const rows = d.rows || [];
    const onLoads = rows.filter((r: any) => loadOf(r));
    const prices = onLoads.map((r: any) => orderPrice(r));
    // WHOSE orders carry no price, by the shipper the order number names — a count per prefix.
    const unpricedByShipper: Record<string, number> = {};
    onLoads.forEach((r: any, i: number) => {
      if (prices[i].amount != null) return;
      const k = shipperOf(r.stopNbr)?.key || 'NONE';
      unpricedByShipper[k] = (unpricedByShipper[k] || 0) + 1;
    });
    // HOW OFTEN A RATE CAN PRINT: a load gets $/mile only when every order on it is priced.
    const byLoad = new Map<string, boolean>();
    onLoads.forEach((r: any, i: number) => {
      const k = String(loadOf(r));
      byLoad.set(k, (byLoad.get(k) ?? true) && prices[i].amount != null);
    });
    return {
      date: d.date, source: d.source, error: d.error || null,
      rows: rows.length,
      onLoads: onLoads.length,
      withDriver: onLoads.filter((r: any) => r.driverName || r.driverUserName).length,
      delivered: onLoads.filter((r: any) => String(r.normalizedStatus || '').toUpperCase() === 'DELIVERED').length,
      deliveredWithTime: onLoads.filter((r: any) => String(r.normalizedStatus || '').toUpperCase() === 'DELIVERED' && finishedAt(r)).length,
      withPin: onLoads.filter((r: any) => Number.isFinite(r.lat) && Number.isFinite(r.lng)).length,
      priceFromUline: prices.filter((p: any) => p.source === 'uline').length,
      priceFromSeal: prices.filter((p: any) => p.source === 'seal').length,
      sealUnreadable: prices.filter((p: any) => p.unreadable).length,
      priceConflicts: prices.filter((p: any) => p.conflict).length,
      sealDisagrees: prices.filter((p: any) => p.sealDiffers != null).length,
      unpriced: prices.filter((p: any) => p.amount == null).length,
      unpricedByShipper,
      loads: byLoad.size,
      loadsFullyPriced: [...byLoad.values()].filter(Boolean).length,
    };
  });
}

export default async (req: Request): Promise<Response> => {
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return jsonResponse({ ok: false, nuvizzCalls: 0, error: 'Firestore is not configured — there are no records to read' }, 500);

  const url = new URL(req.url);
  const today = etDayString();
  // THE RANGE: ?from=&to= from the period buttons (v1.70.0); ?week= is the v1.69.0 shape, still
  // answered so a Recent-lookups entry saved before the buttons keeps working.
  const qFrom = String(url.searchParams.get('from') || '').trim();
  const qTo = String(url.searchParams.get('to') || '').trim();
  const qWeek = String(url.searchParams.get('week') || '').trim();
  let range: { from: string; to: string } | null;
  if (qFrom || qTo) range = DAY_RE.test(qFrom) && DAY_RE.test(qTo) ? (qFrom <= qTo ? { from: qFrom, to: qTo } : { from: qTo, to: qFrom }) : null;
  else if (qWeek) range = DAY_RE.test(qWeek) ? { from: weekOf(qWeek)!.from, to: weekOf(qWeek)!.to } : null;
  else range = { from: today, to: today };
  if (!range) return jsonResponse({ ok: false, nuvizzCalls: 0, error: 'from and to must be days, YYYY-MM-DD' }, 400);
  const dates = datesBetween(range.from, range.to, MAX_DAYS);
  const week = { from: dates[0] || range.from, to: range.to, dates, clipped: dates[0] !== range.from ? MAX_DAYS : null };
  const dropCancelled = dropCancelledEnabled();
  // SHORT RANGES READ WHOLE DAYS (the v1.69.0 path, unchanged). A month or a year cannot: ~800
  // orders a day × 365 is past this function's 26 seconds. There, a sealed day is read as its
  // small drivers list first, and only the chosen driver's own orders are fetched afterwards.
  const long = dates.length > WHOLE_DAY_MAX;

  if (url.searchParams.get('explain') === '1' && long) {
    return jsonResponse({ ok: false, nuvizzCalls: 0, error: `explain reads every order of every day — ask for ${WHOLE_DAY_MAX} days or fewer` }, 400);
  }

  const days = long
    ? await inPool(dates, READ_CONC_LONG, (d) => readDayDrivers(d, today))
    : await inPool(dates, READ_CONC, (d) => readDay(d, today));
  const ledger = days.map((d: any) => ({ date: d.date, source: d.source, orders: d.rows.length, ...(d.error ? { error: d.error } : {}) }));
  const unread = ledger.filter((d) => d.source === 'unread');
  let rows: any[] = days.flatMap((d: any) => d.rows);
  const base = { ok: true, nuvizzCalls: 0, week, today, days: ledger, complete: unread.length === 0 };

  if (url.searchParams.get('explain') === '1') {
    return jsonResponse({ ...base, googleCalls: 0, mode: 'explain', explain: explainWeek(days) });
  }

  // Aliases from both places the territory sheet reads, ops second so a person's edit wins.
  const fromOps = await getDoc(ALIAS_PATH).then((d: any) => d?.aliases || []).catch(() => []);
  const aliases = [...(await driverAliases()), ...fromOps];
  const drivers = driversOfWeek(rows, aliases, { dropCancelled });

  const byKey = String(url.searchParams.get('key') || '').trim();
  const typed = String(url.searchParams.get('driver') || '').trim();
  const pick = byKey ? { match: drivers.find((d) => d.key === byKey) || null, candidates: [] as any[] } : resolveDriver(drivers, typed);
  if (!pick.match) {
    return jsonResponse({
      ...base, googleCalls: 0, mode: 'driver-week-choose', typed: typed || byKey || null,
      drivers, candidates: typed ? pick.candidates : drivers,
    });
  }
  const key = pick.match.key;

  if (long) {
    // The sealed days' rows so far are one stand-in per LOAD from the drivers list. Swap each day
    // this driver ran for his real orders; the board days were read whole and stay as they are.
    const mineByDay = new Map<string, Set<string>>();
    for (const r of applyAliases(rows.filter((x: any) => x.__fromDrivers), aliases)) {
      if (driverKeyOf(r) !== key) continue;
      const set = mineByDay.get(r.date) || new Set<string>();
      for (const n of r.__names) set.add(n);
      mineByDay.set(r.date, set);
    }
    const fetched = await inPool([...mineByDay.entries()], READ_CONC_LONG, async ([d, names]) => {
      try { return { d, rows: await readDriverStops(d, [...names]) }; }
      catch (e: any) { return { d, rows: [], error: String(e?.message || e).slice(0, 160) }; }
    });
    for (const f of fetched) if (f.error) { const l = ledger.find((x) => x.date === f.d); if (l) { (l as any).source = 'unread'; (l as any).error = f.error; } }
    base.complete = ledger.every((d) => d.source !== 'unread');
    rows = [...rows.filter((x: any) => !x.__fromDrivers), ...fetched.flatMap((f) => f.rows.map((r: any) => ({ ...r, date: f.d })))];
  }

  // TRACTOR OR BOX, per day — only for the days this driver ran.
  const hisDays = [...new Set(rows.filter((r) => loadOf(r)).map((r) => r.date))];
  const classes: Record<string, any> = {};
  await Promise.all(hisDays.map(async (d) => { classes[d] = await readRouteClasses(TENANT, d).catch(() => ({})); }));

  const first = driverWeek(rows, key, { aliases, classes, dropCancelled, today });

  // ROAD MILES — the cache first, then Google, within this request's ceiling.
  const milesOn = loadMilesEnabled();
  const apiKey = process.env.GOOGLE_ROUTES_API_KEY || '';
  const miles: Record<string, any> = {};
  const tally = { measured: 0, cached: 0, fetched: 0, failed: 0, skipped: 0, noPath: 0 };
  let googleCalls = 0;
  if (milesOn) {
    await inPool(first.loads, 3, async (load: any) => {
      if (load.path.length < 2) { tally.noPath += 1; miles[load.key] = { meters: null, reason: 'nothing on this load was delivered with a time and a pin, so there is no drive to measure' }; return; }
      const fp = pathFingerprint(load.path);
      const docPath = loadMilesPath(load.date, load.name, key);
      const cached = await getDoc(docPath).catch(() => null);
      if (cached && cached.fingerprint === fp && Number.isFinite(cached.meters)) {
        tally.cached += 1; tally.measured += 1;
        miles[load.key] = { meters: cached.meters, source: 'cache' };
        return;
      }
      if (!apiKey) { tally.skipped += 1; miles[load.key] = { meters: null, reason: 'this site has no Google Routes key' }; return; }
      const need = routeChunks(load.path).length;
      if (googleCalls + need > MAX_GOOGLE_CALLS) { tally.skipped += 1; miles[load.key] = { meters: null, reason: 'not measured on this request — open the week again to measure it' }; return; }
      googleCalls += need;
      const g = await googleMeters(load.path, apiKey);
      if (g.meters == null) { tally.failed += 1; miles[load.key] = { meters: null, reason: g.error }; return; }
      tally.fetched += 1; tally.measured += 1;
      miles[load.key] = { meters: g.meters, source: 'google' };
      // Our own document, keyed by the exact path it measured: a replace is correct here.
      await setDoc(docPath, {
        tenant: TENANT, date: load.date, load: load.name, driverKey: key, fingerprint: fp, meters: g.meters,
        points: load.path.length, requests: g.calls, source: 'google-routes', computed_at: new Date().toISOString(),
      }).catch(() => { /* the measurement stands; it is simply measured again next time */ });
    });
  }

  const week2 = driverWeek(rows, key, { aliases, classes, miles, dropCancelled, today });
  return jsonResponse({
    ...base, googleCalls, mode: 'driver-week',
    driver: week2.driver, loads: week2.loads, totals: week2.totals, cancelledOff: week2.cancelledOff,
    drivers,
    yard: YARD,
    miles: { enabled: milesOn, googleKey: !!apiKey, ...tally },
    cost: { recorded: false, text: COST_NOT_RECORDED },
  });
};
