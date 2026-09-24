// lib/claude-shadow/learn-core.mts — WHAT THE SHADOW LEARNS FROM THE SEALED HISTORY. Pure: no I/O.
//
// Chad, 2026-09-24: "truck capacity should be learned from all the data we have and we should have
// a ui where we can customize it." And earlier: the cap for a driver is learned "from the routes
// they're assigned to", the planner should know "the driver and the route and the skid capacity
// that they can take", and loose pieces count: "if they put 17 skids on a box truck, you then can't
// put 30 bags of peanuts as well."
//
// THE SOURCE IS THE SEALED WAREHOUSE (history_days), every day of it — 82 sealed days on
// 2026-09-24, back to June 4 — read by this repo's own nightly capture. Nothing here reads the
// board, the Build job's profiles or the learned engine's envelopes: the shadow learns its own
// numbers from the same freight, so a change to either side cannot move the other.
//
// A TRUCK TRIP here is the freight that went out on one route with one driver on one day:
//   • deliveries only — a pickup (RA… / stopType PU) comes BACK on the truck and takes no outbound
//     room, and its Display Seq is the terminal-return slot, not a run position;
//   • grouped by route name AND driver, because on the list scan the load number IS the route name
//     (lib/nuvizz-list.mts:264), so two drivers sharing a name would otherwise be one "truck";
//   • only rows with EVIDENCE THEY RAN THAT DAY (v2, after review). "Filed on day D's board" is not
//     "rode the truck on D": a carried-forward order keeps its old route and driver and is re-filed
//     onto today while NuVizz still lists it open, and tomorrow's pre-built freight lands on today
//     (the 2026-07-28 DAWSONVILLE/CRUMPTON replay — lib/routing-reference.mts executedOnDate). So a
//     delivered row (90/91) counts only when its delivery stamp is on D, an unable-to-deliver row
//     (80 — it rode the truck and came back) only when its last update is on D, and a row still
//     out-for-delivery or arrived (40/50) at the seal counts not at all: nothing says it was
//     carried that day rather than left open. Scheduled (20), unplanned (10) and cancelled (99)
//     never left. Like the engine's gate, the stamp test SWITCHES ITSELF OFF on a day where fewer
//     than half the delivered rows carry a same-day stamp — a census with no stamps would erase
//     real work — and the day says so.
//
// ONE DRIVER RUNNING TWO LOADS UNDER ONE NAME ON ONE DAY cannot be pulled apart from the history
// rows — they share the name, and so the key. Counting them as one trip would teach the shadow a
// truck twice its real size. The day's own load roster (nuvizz_load_roster, which this repo
// captures) settles it per name: more live loads under a name than trips the history has for it
// means some trip absorbed two loads. When the roster cannot say — no roster that day (all of
// June), no usable stop counts on it, the name missing from it — the trip is NOT used for capacity
// and is counted as unknown. Leaving it out is the honest default; guessing "not shared" is how a
// double truck gets in.
//
// CAPACITY IS IN SKID SPOTS: skids + loose ÷ (loose pieces per skid spot). The ratio is a SETTING,
// not a learned number — no stored field says how much room a loose piece takes — so the day
// summaries keep skids and loose separately and the ratio is applied when the model is built.
// Changing it never needs a re-read of the history.

export const LEARN_VERSION = 2;
export const LEARN_TENANT = 'davis';
export const LEARN_DAYS_COLLECTION = 'claude_shadow_learn_days';
export const CAPACITY_PATH = 'claude_shadow_learned/davis__capacity';
export const LEARN_LAST_PATH = 'claude_shadow_meta/learn_last';
export const SETTINGS_PATH = 'claude_shadow_settings/davis';

// The learned cap is the fuller end of what this driver (or route) has actually carried: the
// 95th percentile of their trips in skid spots. Not the single most ever — one mis-keyed day would
// set it — and not the typical load, which is a light day as often as a full one.
// MIN_TRIPS_FOR_CAP IS 20 BECAUSE OF THAT: with the nearest-rank convention the 95th percentile of
// fewer than 20 trips IS the single fullest one (index ceil(0.95·n)−1 = n−1 for every n ≤ 19), so
// a smaller minimum would publish "the most ever" under the name of a percentile.
export const CAP_QUANTILE = 0.95;
export const MIN_TRIPS_FOR_CAP = 20;
export const DEFAULT_LOOSE_PER_SKID = 10;

// Exactly the fields a day's learning reads (Firestore list mask). An unmasked history stop
// carries the raw NuVizz object — kilobytes a stop, eighty-odd days of them.
export const HISTORY_STOP_MASK = [
  'stopNbr', 'stopType', 'status', 'normalizedStatus', 'isPlanned', 'routeName', 'loadNbr',
  'driverName', 'driverUserName', 'cartons', 'volume', 'weight', 'routeSeq', 'deliveredDTTM',
  'listUpdatedDTTM', 'zip', 'city', 'customerMatchKey',
];
export const HISTORY_MANIFEST_MASK = ['complete', 'verified', 'no_board', 'captured_at', 'healed_at'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DELIVERED_CODES = new Set(['90', '91']);
const OPEN_CODES = new Set(['40', '50']);
const NEVER_LEFT_CODES = new Set(['10', '20', '99']);

/** A stored number, or null — `Number(null)` is 0 and 0 is finite, so a bare Number() would
 *  turn "no skids recorded" into "zero skids", which is a different fact. */
export function num(v: any): number | null {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Whitespace-collapsed, trimmed. NuVizz display names arrive as "Ben  Paintsil". */
export function tidy(v: any): string {
  return String(v ?? '').trim().replace(/\s+/g, ' ');
}
export function keyOf(v: any): string {
  return tidy(v).toUpperCase();
}

export function isPickup(row: any): boolean {
  if (String(row?.stopType ?? '').trim().toUpperCase() === 'PU') return true;
  return /^RA/i.test(String(row?.stopNbr ?? '').trim());
}

const onDay = (stamp: any, date: string) => String(stamp ?? '').slice(0, 10) === date;

export type RowKind = 'delivered' | 'unable' | 'open' | 'neverLeft' | 'unknown';

/** What a row's status says, from the raw code (the normalised word only when there is no code). */
export function rowKind(row: any): RowKind {
  const code = String(row?.status ?? '').trim();
  if (DELIVERED_CODES.has(code)) return 'delivered';
  if (code === '80') return 'unable';
  if (OPEN_CODES.has(code)) return 'open';
  if (NEVER_LEFT_CODES.has(code)) return 'neverLeft';
  if (code) return 'unknown';
  const ns = String(row?.normalizedStatus ?? '').trim().toUpperCase();
  if (ns === 'DELIVERED') return 'delivered';
  if (ns === 'OUT_FOR_DEL' || ns === 'ARRIVED') return 'open';
  if (ns === 'SCHEDULED' || ns === 'UNPLANNED' || ns === 'CANCELLED') return 'neverLeft';
  return 'unknown';
}

/** Nearest-rank quantile of an ascending-sorted list (the learned engine's convention). */
export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

export interface SealedDay { date: string; stamp: string }

/** The days the warehouse holds as SEALED — manifest written, verified, complete, not a
 *  no-board tombstone — keyed by date, each with the stamp that changes if the day is healed. */
export function sealedDaysFrom(manifests: any[], tenant = LEARN_TENANT): SealedDay[] {
  const out: SealedDay[] = [];
  for (const m of manifests || []) {
    const id = String(m?._id ?? '');
    if (!id.startsWith(`${tenant}__`)) continue;
    const date = id.slice(tenant.length + 2);
    if (!DATE_RE.test(date)) continue;
    if (m.no_board || m.complete !== true || m.verified !== true) continue;
    out.push({ date, stamp: String(m.healed_at || m.captured_at || '') });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Sealed days re-read on EVERY run whether or not they changed: a stop the Stops lookup files into
// a past day after it sealed moves no manifest stamp, and would otherwise never be learned.
export const RELEARN_RECENT_DAYS = 3;

/** Which sealed days a run reads: never learned, learned by an older LEARN_VERSION, healed since
 *  (stamp moved), plus the newest RELEARN_RECENT_DAYS always. Oldest first. */
export function daysToLearn(sealed: SealedDay[], learned: any[], tenant = LEARN_TENANT): { toLearn: string[]; refresh: string[] } {
  const have = new Map<string, any>();
  for (const d of learned || []) {
    const id = String(d?._id ?? '');
    if (id.startsWith(`${tenant}__`)) have.set(id.slice(tenant.length + 2), d);
  }
  const toLearn = sealed
    .filter((s) => {
      const h = have.get(s.date);
      return !h || h.learnVersion !== LEARN_VERSION || String(h.sourceStamp ?? '') !== s.stamp;
    })
    .map((s) => s.date);
  const need = new Set(toLearn);
  const refresh = sealed.slice(-RELEARN_RECENT_DAYS).map((s) => s.date).filter((d) => !need.has(d));
  return { toLearn, refresh };
}

/** The load roster document's loads, or null when the day has none on file. */
export function rosterLoadsOf(doc: any): any[] | null {
  if (!doc) return null;
  const raw = doc.loadsJson;
  if (typeof raw !== 'string' || !raw) return Array.isArray(doc.loads) ? doc.loads : null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export interface RosterNames { usable: boolean; live: Map<string, number>; unknown: Map<string, number> }

/** Per route name, how many LIVE loads the roster shows that day (not cancelled, stops > 0) and how
 *  many it cannot judge (stop count missing). Unusable — null — when there is no roster, or no load
 *  on it has a stop count at all (an empty capture, or a column that did not resolve). */
export function rosterNamesFrom(loads: any[] | null): RosterNames | null {
  if (!loads) return null;
  const live = new Map<string, number>();
  const unknown = new Map<string, number>();
  let anyCounted = false;
  for (const l of loads) {
    if (/cancel/i.test(String(l?.status ?? ''))) continue;
    const k = keyOf(l?.name);
    if (!k) continue;
    const t = num(l?.trips);
    if (t == null) { unknown.set(k, (unknown.get(k) || 0) + 1); continue; }
    if (t <= 0) continue;
    anyCounted = true;
    live.set(k, (live.get(k) || 0) + 1);
  }
  if (!anyCounted) return null;
  return { usable: true, live, unknown };
}

/** Is the trip under this route name one of two loads merged by their shared name?
 *  true — the roster has more live loads under the name than the history has trips for it;
 *  false — exactly as many, all with known stop counts;
 *  null — the roster cannot say (none that day, the name absent, a stop count missing, or more
 *         trips than loads, which is a driver swap or a stray row and not a clean truck either). */
export function sharedVerdict(names: RosterNames | null, routeKey: string, groupsUnderName: number): boolean | null {
  if (!names) return null;
  if ((names.unknown.get(routeKey) || 0) > 0) return null;
  const live = names.live.get(routeKey) || 0;
  if (live === 0) return null;
  if (live > groupsUnderName) return true;
  if (live === groupsUnderName) return false;
  return null;
}

export interface OrderStop { n: string; s: number | null; t: string | null; z: string | null; k: string | null }
export interface DayTrip {
  route: string; driver: string; stops: number;
  skids: number; loose: number; weight: number;
  freightStops: number;          // stops that carried a skid or loose count
  uncountedStops: number;        // stops with NEITHER count recorded — the trip's total is short by an unknown amount
  shared: boolean | null;        // see sharedVerdict; only `false` is used for capacity
}

/**
 * ONE SEALED DAY → its truck trips (capacity) and each trip's stop order (planned and driven).
 * `rows` are that day's history_days stops (HISTORY_STOP_MASK); `rosterDoc` is that day's
 * nuvizz_load_roster document or null.
 */
export function learnDay(rows: any[], date: string, sourceStamp: string, rosterDoc: any, learnedAt: string) {
  const names = rosterNamesFrom(rosterLoadsOf(rosterDoc));
  const counts = {
    rows: 0, pickups: 0, deliveries: 0, neverLeft: 0, openAtSeal: 0, otherDay: 0, noStamp: 0, unknownStatus: 0,
    ran: 0, noRoute: 0, trips: 0, withSeq: 0,
  };
  const candidates: any[] = [];
  let deliveredRows = 0, deliveredStampedOnDay = 0;
  for (const r of rows || []) {
    counts.rows++;
    if (isPickup(r)) { counts.pickups++; continue; }
    counts.deliveries++;
    const kind = rowKind(r);
    if (kind === 'neverLeft') { counts.neverLeft++; continue; }
    if (kind === 'open') { counts.openAtSeal++; continue; }
    if (kind === 'unknown') { counts.unknownStatus++; continue; }
    if (kind === 'delivered') { deliveredRows++; if (onDay(r?.deliveredDTTM, date)) deliveredStampedOnDay++; }
    candidates.push({ r, kind });
  }
  // The stamp gate, and its self-switch: on a day where most delivered rows carry no same-day
  // stamp, the stamps are not a census and the gate would erase real work.
  const gate = deliveredRows > 0 && deliveredStampedOnDay >= deliveredRows * 0.5;
  const groups = new Map<string, any[]>();
  for (const { r, kind } of candidates) {
    if (gate) {
      const stamp = kind === 'delivered' ? r?.deliveredDTTM : r?.listUpdatedDTTM;
      if (!stamp) { counts.noStamp++; continue; }
      if (!onDay(stamp, date)) { counts.otherDay++; continue; }
    }
    counts.ran++;
    const route = tidy(r?.routeName || r?.loadNbr);
    if (!route) { counts.noRoute++; continue; }
    const driver = tidy(r?.driverName || r?.driverUserName) || '(no driver)';
    const k = `${keyOf(route)}|${keyOf(driver)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push({ ...r, _route: route, _driver: driver });
  }

  const ordered = [...groups.values()].sort((a, b) => keyOf(a[0]._route).localeCompare(keyOf(b[0]._route)) || keyOf(a[0]._driver).localeCompare(keyOf(b[0]._driver)));
  const groupsPerName = new Map<string, number>();
  for (const g of ordered) { const rk = keyOf(g[0]._route); groupsPerName.set(rk, (groupsPerName.get(rk) || 0) + 1); }

  const trips: DayTrip[] = [];
  // One entry per trip, same index as `trips`. `stops` is in PLANNED order when the day knows it
  // (else in stop-number order); `driven` is the stop numbers in delivered order, or null.
  const orders: { planned: boolean; stops: OrderStop[]; driven: string[] | null }[] = [];
  for (const g of ordered) {
    let skids = 0, loose = 0, weight = 0, freightStops = 0, uncountedStops = 0;
    for (const r of g) {
      const s = num(r.cartons), l = num(r.volume), w = num(r.weight);
      if (s != null) skids += s;
      if (l != null) loose += l;
      if (w != null) weight += w;
      if (s == null && l == null) uncountedStops++;
      if ((s ?? 0) > 0 || (l ?? 0) > 0) freightStops++;
    }
    const routeKey = keyOf(g[0]._route);
    trips.push({
      route: g[0]._route, driver: g[0]._driver, stops: g.length,
      skids: round1(skids)!, loose: round1(loose)!, weight: Math.round(weight), freightStops, uncountedStops,
      shared: sharedVerdict(names, routeKey, groupsPerName.get(routeKey) || 0),
    });

    // ORDER. Planned = NuVizz's ShipTo Display Seq, when every stop on the trip carries one (a
    // half-numbered route is not an order). Driven = the delivered timestamps, when every stop
    // has one. Each is absent when the day cannot say.
    const stop = (r: any): OrderStop => ({
      n: String(r.stopNbr ?? ''), s: num(r.routeSeq), t: r.deliveredDTTM ? String(r.deliveredDTTM) : null,
      z: r.zip ? String(r.zip) : null, k: r.customerMatchKey ? String(r.customerMatchKey) : null,
    });
    const all = g.map(stop);
    const planned = all.every((x) => x.s != null);
    const stops = planned
      ? all.slice().sort((a, b) => (a.s! - b.s!) || a.n.localeCompare(b.n))
      : all.slice().sort((a, b) => a.n.localeCompare(b.n));
    const driven = all.every((x) => x.t)
      ? all.slice().sort((a, b) => a.t!.localeCompare(b.t!) || a.n.localeCompare(b.n)).map((x) => x.n)
      : null;
    if (planned) counts.withSeq++;
    orders.push({ planned, stops, driven });
  }
  counts.trips = trips.length;
  return {
    tenant: LEARN_TENANT, date, learnVersion: LEARN_VERSION, sourceStamp, learnedAt,
    roster: names ? 'read' : 'none',
    stampGate: gate ? 'applied' : 'off',
    counts, trips, orders,
  };
}

export interface CapacityConfig { loosePerSkid: number; capQuantile?: number; minTrips?: number }

/** Skid spots a trip used: skids + loose ÷ loosePerSkid (never divides by less than 1). */
export function skidSpots(skids: number, loose: number, loosePerSkid: number): number {
  return skids + loose / Math.max(1, loosePerSkid);
}

function statsFor(entries: { eq: number; t: any; date: string }[], cfg: Required<CapacityConfig>) {
  const eqs = entries.map((e) => e.eq).sort((a, b) => a - b);
  const fullest = entries.reduce((best, e) => (!best || e.eq > best.eq || (e.eq === best.eq && e.date > best.date) ? e : best), null as any);
  const days = new Set(entries.map((e) => e.date));
  const p95 = quantile(eqs, cfg.capQuantile);
  return {
    trips: entries.length,
    days: days.size,
    lastDate: entries.reduce((d, e) => (e.date > d ? e.date : d), ''),
    p50: round1(quantile(eqs, 0.5)),
    p85: round1(quantile(eqs, 0.85)),
    p95: round1(p95),
    max: round1(eqs.length ? eqs[eqs.length - 1] : null),
    maxSkids: entries.reduce((m, e) => Math.max(m, e.t.skids), 0),
    maxLoose: entries.reduce((m, e) => Math.max(m, e.t.loose), 0),
    maxWeight: entries.reduce((m, e) => Math.max(m, e.t.weight), 0),
    fullest: fullest ? { date: fullest.date, route: fullest.t.route, driver: fullest.t.driver, skids: fullest.t.skids, loose: fullest.t.loose, spots: round1(fullest.eq) } : null,
    cap: entries.length >= cfg.minTrips ? round1(p95) : null,
  };
}

const topNames = (m: Map<string, number>, n = 3) =>
  [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([name, trips]) => ({ name, trips }));

/**
 * ALL LEARNED DAYS → the capacity model: per driver, per route, and per driver on a route.
 * Trips and rows left out of capacity are counted by reason, never silently dropped.
 */
export function buildCapacityModel(days: any[], config: CapacityConfig, builtAt: string) {
  const cfg: Required<CapacityConfig> = {
    loosePerSkid: Math.max(1, num(config.loosePerSkid) ?? DEFAULT_LOOSE_PER_SKID),
    capQuantile: config.capQuantile ?? CAP_QUANTILE,
    minTrips: config.minTrips ?? MIN_TRIPS_FOR_CAP,
  };
  const byDriver = new Map<string, { name: string; entries: any[]; routes: Map<string, number> }>();
  const byRoute = new Map<string, { name: string; entries: any[]; drivers: Map<string, number> }>();
  const byPair = new Map<string, { driver: string; route: string; entries: any[] }>();
  const skipped = { shared: 0, rosterUnknown: 0, uncounted: 0, noFreight: 0, noDriver: 0 };
  const rowsLeftOut = { openAtSeal: 0, otherDay: 0, noStamp: 0, unknownStatus: 0 };
  let used = 0, total = 0, noRosterDays = 0, gateOffDays = 0;
  const dates: string[] = [];

  for (const d of days || []) {
    const date = String(d?.date ?? '');
    if (!DATE_RE.test(date) || d?.learnVersion !== LEARN_VERSION) continue;
    dates.push(date);
    if (d.roster === 'none') noRosterDays++;
    if (d.stampGate === 'off') gateOffDays++;
    for (const k of Object.keys(rowsLeftOut) as (keyof typeof rowsLeftOut)[]) rowsLeftOut[k] += Number(d?.counts?.[k]) || 0;
    for (const t of Array.isArray(d.trips) ? d.trips : []) {
      total++;
      if (t.shared === true) { skipped.shared++; continue; }
      if (t.shared !== false) { skipped.rosterUnknown++; continue; }
      if (t.driver === '(no driver)') { skipped.noDriver++; continue; }
      if (!(t.freightStops > 0)) { skipped.noFreight++; continue; }
      if (Number(t.uncountedStops) > 0) { skipped.uncounted++; continue; }
      used++;
      const eq = skidSpots(Number(t.skids) || 0, Number(t.loose) || 0, cfg.loosePerSkid);
      const e = { eq, t, date };
      const dk = keyOf(t.driver), rk = keyOf(t.route);
      const dv = byDriver.get(dk) ?? byDriver.set(dk, { name: t.driver, entries: [], routes: new Map() }).get(dk)!;
      dv.entries.push(e); dv.routes.set(t.route, (dv.routes.get(t.route) || 0) + 1);
      const rv = byRoute.get(rk) ?? byRoute.set(rk, { name: t.route, entries: [], drivers: new Map() }).get(rk)!;
      rv.entries.push(e); rv.drivers.set(t.driver, (rv.drivers.get(t.driver) || 0) + 1);
      const pk = `${dk}|${rk}`;
      const pv = byPair.get(pk) ?? byPair.set(pk, { driver: t.driver, route: t.route, entries: [] }).get(pk)!;
      pv.entries.push(e);
    }
  }
  dates.sort();
  const byName = (a: any, b: any) => a.name.localeCompare(b.name);
  return {
    tenant: LEARN_TENANT, learnVersion: LEARN_VERSION, builtAt,
    loosePerSkid: cfg.loosePerSkid, capQuantile: cfg.capQuantile, minTrips: cfg.minTrips,
    days: { count: dates.length, first: dates[0] ?? null, last: dates[dates.length - 1] ?? null, noRoster: noRosterDays, stampGateOff: gateOffDays },
    trips: { total, used, skipped },
    rowsLeftOut,
    drivers: [...byDriver.entries()].map(([key, v]) => ({ key, name: v.name, routes: topNames(v.routes), ...statsFor(v.entries, cfg) })).sort(byName),
    routes: [...byRoute.entries()].map(([key, v]) => ({ key, name: v.name, drivers: topNames(v.drivers), ...statsFor(v.entries, cfg) })).sort(byName),
    pairs: [...byPair.values()].map((v) => {
      const s = statsFor(v.entries, cfg);
      return { driver: v.driver, route: v.route, trips: s.trips, p85: s.p85, p95: s.p95, max: s.max, cap: s.cap, lastDate: s.lastDate };
    }).sort((a, b) => a.driver.localeCompare(b.driver) || a.route.localeCompare(b.route)),
  };
}
