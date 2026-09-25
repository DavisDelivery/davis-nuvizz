// src/lib/load-lookup.js — A DRIVER'S WEEK OF LOADS, READ OFF OUR OWN RECORDS (PURE).
//
// Chad, 2026-09-25: "add a load look up so if i wanted to evaluate a weeks worth of a drivers
// loads i can do that and gives me an anaylsys of the loads with all the pertinent information
// and a map of the load so i can visually see it the map can be behind a drop down. want
// milage of load earnings of load cost of load stops ect" — and, a minute later: "i want this
// to be part of the stops lookup tab".
//
// WHAT OUR RECORDS CAN ANSWER, AND WHAT THEY CANNOT. Said here because the screen says it too,
// and a number with no source is the thing this repo refuses to print (CLAUDE.md).
//
//   • STOPS, FREIGHT, TIMES, DELIVERED OR NOT — on every board row and every sealed day.
//   • ROAD MILES — stored NOWHERE. NuVizz's planned distance only arrives with the one-time
//     /stop/info enrichment, usually before the order is even planned; the travel cache holds
//     drive SECONDS, not distance; and the Motive integration reads positions, never an
//     odometer. So the miles are measured here: Google's driving distance over the stops in the
//     order they were delivered, yard to yard. The path is built in this file (milesPath) so
//     the rule is tested; the endpoint only asks Google for it.
//   • EARNINGS — the price Davis records on each order, and only that. Two places carry it:
//     Uline writes "TOTAL-AMOUNT : 84.21" into the order instructions, a LIVE list field the
//     scan refreshes every pass (nuvizz-list.mts LIVE_LIST_FIELDS); and Davis records a
//     shipment's price in NuVizz's Seal # field (v0.50.16, nuvizz-write-ops.mts). Neither is
//     on every order, so every total says how many orders it covers rather than passing a
//     partial sum off as the load's.
//   • COST — nothing in this system records driver pay, fuel or truck cost. The screen says
//     so in words instead of printing a zero, because a zero is a claim.
//
// NOTHING HERE READS A CLOCK OR THE NETWORK. The endpoint (netlify/functions/driver-loads.mts)
// reads the days and asks Google; everything it decides, it decides by calling this file.

import { driverKeyOf, canonicalDriver, betterLabel, applyAliases } from './driver-territory.js';
import { dropCancelledStops } from './stop-cancelled.js';
import { isPickup, compareStopNbr } from './label-shippers.js';

/** The Buford yard — the origin every sealed route records (history-derive.mts DEPOT). */
export const YARD = Object.freeze({ name: 'Buford Terminal', lat: 34.14838, lng: -83.95948 });
export const METERS_PER_MILE = 1609.344;
/** Google's Routes API takes at most 25 intermediate waypoints in one request. */
export const MAX_INTERMEDIATES = 25;
export const COST_NOT_RECORDED = 'This app has no record of what a load costs. No driver pay, fuel or truck cost is stored anywhere it reads.';

const s = (v) => (v == null ? '' : String(v).trim());
const num = (v) => { const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── THE WEEK ─────────────────────────────────────────────────────────────────

/** YYYY-MM-DD plus n calendar days. Noon UTC so no offset can move the day. */
export function addDays(day, n) {
  if (!DAY_RE.test(s(day))) return null;
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

/**
 * THE WEEK A DAY FALLS IN — Monday through Sunday. A payroll week and a dispatch week both
 * start on Monday here, and Saturday work belongs to the week it was run in, so it is Monday
 * to Sunday rather than the five business days the territory sheet reads.
 */
export function weekOf(day) {
  if (!DAY_RE.test(s(day))) return null;
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();   // 0 = Sunday
  const from = addDays(day, -((dow + 6) % 7));
  const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  return { from, to: dates[6], dates };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monDay = (day) => `${MON[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

/** "Sep 21 – 27", "Sep 28 – Oct 4", "Dec 28, 2026 – Jan 3, 2027". */
export function weekLabel(week) {
  if (!week?.from || !week?.to) return '';
  const [a, b] = [week.from, week.to];
  if (a.slice(0, 4) !== b.slice(0, 4)) return `${monDay(a)}, ${a.slice(0, 4)} – ${monDay(b)}, ${b.slice(0, 4)}`;
  if (a.slice(5, 7) === b.slice(5, 7)) return `${monDay(a)} – ${Number(b.slice(8, 10))}`;
  return `${monDay(a)} – ${monDay(b)}`;
}

// ── TIME, ON DAVIS'S CLOCK ───────────────────────────────────────────────────

const ET_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/**
 * A delivery stamp as Eastern wall-clock text, "2026-09-23T14:19", or null.
 *
 * READ ON THE DIGITS. The board stores a local wall-clock string with no zone; Date.parse reads
 * that as UTC and every delivery lands four or five hours early — the bug App.jsx's stopWhen and
 * the flag-history column were each fixed for. Only a stamp that CARRIES a zone is converted.
 */
export function wallTime(v) {
  const t = s(v);
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(t);
  if (!m) return null;
  if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(t)) return `${m[1]}T${m[2]}:${m[3]}`;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Minutes from one wall time to another (both read in the same frame, so no zone enters). */
export function wallMinutes(a, b) {
  const x = Date.parse(`${a}:00Z`);
  const y = Date.parse(`${b}:00Z`);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 60000) : null;
}

/** When a finished order was finished: the delivery stamp, from wherever the record keeps it. */
export function finishedAt(stop) {
  return wallTime(stop?.deliveredDTTM)
    || wallTime(stop?.executed?.deliveredDTTM)
    || wallTime(stop?.raw?.stopExecutionInfo?.to?.deliveredDTTM)
    || null;
}

// ── WHAT AN ORDER WAS PRICED AT ──────────────────────────────────────────────

const cents = (n) => Math.round(n * 100) / 100;
const MONEY = /^\$?\s*((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d{1,2}))?$/;
const TOTAL = /TOTAL[\s-]*AMOUNT\s*:?\s*\$?\s*((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d{1,2}))?/gi;
const toNum = (whole, frac) => cents(Number(String(whole).replace(/,/g, '')) + (frac ? Number(`0.${frac.padEnd(2, '0')}`) : 0));

/** Every distinct "TOTAL-AMOUNT : 84.21" figure in a block of order text. */
export function totalAmounts(text) {
  const out = new Set();
  for (const m of s(text).matchAll(TOTAL)) out.add(toNum(m[1], m[2]));
  return [...out];
}

/**
 * The Seal # read as a price — ONLY when it is written like one.
 *
 * "$163.18" and "163.18" are prices. A bare "1234567" might be a price somebody typed without
 * cents or might be a real trailer seal number; nothing on the record says which, so it is
 * reported as unreadable rather than added to anybody's earnings.
 */
export function sealPrice(v) {
  const t = s(v);
  if (!t) return null;
  const m = MONEY.exec(t);
  if (!m || (!t.includes('$') && m[2] == null)) return { amount: null, unreadable: t };
  return { amount: toNum(m[1], m[2]) };
}

/**
 * WHAT DAVIS RECORDED THIS ORDER AS PRICED AT, and where that came from.
 *
 * Uline's TOTAL-AMOUNT line first: it rides the order instructions, which the scan refreshes on
 * every pass, while the Seal # is read off the one-time enrichment copy and can be older. Two
 * DIFFERENT TOTAL-AMOUNT figures on one order is a conflict and prices nothing — picking one
 * would be a guess, and the other might be the correction.
 */
export function orderPrice(stop) {
  const texts = [stop?.orderInstructions, stop?.signalSources?.orderInstructions,
    ...(Array.isArray(stop?.allComments) ? stop.allComments.map((c) => c?.text ?? c?.commentDescription) : [])];
  const amounts = [...new Set(texts.flatMap((t) => totalAmounts(t)))];
  const seal = sealPrice(stop?.raw?.stop?.sealNbr ?? stop?.raw?.sealNbr ?? stop?.sealNbr);
  if (amounts.length > 1) return { amount: null, source: null, conflict: `two different TOTAL-AMOUNT figures (${amounts.map((a) => `$${a.toFixed(2)}`).join(' and ')})` };
  if (amounts.length === 1) {
    const differs = seal?.amount != null && seal.amount !== amounts[0];
    return { amount: amounts[0], source: 'uline', ...(differs ? { sealDiffers: seal.amount } : {}) };
  }
  if (seal?.amount != null) return { amount: seal.amount, source: 'seal' };
  if (seal?.unreadable) return { amount: null, source: null, unreadable: seal.unreadable };
  return { amount: null, source: null };
}

/**
 * One order, however many rows it arrives as. A Uline order split into pieces lands as
 * 007157687-1, -2 … and each piece carries the same instruction text, so pricing every row
 * would count the order's price once per piece. Carrier PROs (AVRT-…, ESTES-…) keep their dash.
 */
export function baseOrderNbr(stopNbr) {
  const t = s(stopNbr);
  const m = /^(\d{6,})-\d{1,2}$/.exec(t);
  return (m ? m[1] : t).replace(/^0+(?=\d)/, '');
}

// ── WHO DROVE IT ─────────────────────────────────────────────────────────────

/** The load a row rode on — the board files the load's NAME as its number on list rows. */
export function loadOf(stop) {
  return s(stop?.loadNbr) || s(stop?.routeName) || null;
}

/**
 * EVERY DRIVER WHO RAN A LOAD IN THE WEEK, one row per person.
 *
 * Identity is the territory sheet's rule (driver-territory.js): "COLIN/DJ 1" and "COLIN 2" are
 * Colin, a vendor rename folds through the alias list, and the double space NuVizz puts in
 * names is not a second person. One rule, so the sheet and this screen can never disagree about
 * who somebody is.
 */
export function driversOfWeek(stops, aliases = [], { dropCancelled = true } = {}) {
  const rows = dropCancelledStops(applyAliases(stops || [], aliases), dropCancelled).stops;
  const by = new Map();
  for (const r of rows) {
    const key = driverKeyOf(r);
    const load = loadOf(r);
    if (!key || !load) continue;
    const e = by.get(key) || { key, label: '', days: new Set(), loads: new Set(), orders: 0 };
    e.label = betterLabel(e.label, canonicalDriver(s(r.driverName) || s(r.driverUserName)).label);
    e.days.add(r.date);
    e.loads.add(`${r.date}|${load}`);
    e.orders += 1;
    by.set(key, e);
  }
  return [...by.values()]
    .map((e) => ({ key: e.key, label: e.label || e.key, days: e.days.size, loads: e.loads.size, orders: e.orders }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * WHICH DRIVER A TYPED NAME MEANS. An exact key wins; otherwise every driver whose name
 * contains what was typed. One hit is the answer, several are a choice for the person to make —
 * never ours, because "Anthony" is two men on this roster.
 */
export function resolveDriver(drivers, typed) {
  const list = drivers || [];
  const t = s(typed);
  if (!t) return { match: null, candidates: list };
  const key = canonicalDriver(t).key;
  const exact = list.find((d) => d.key === key);
  if (exact) return { match: exact, candidates: [exact] };
  const want = t.toLowerCase().replace(/\s+/g, ' ');
  const hits = list.filter((d) => d.label.toLowerCase().replace(/\s+/g, ' ').includes(want) || d.key.toLowerCase().includes(want.replace(/ /g, '_')));
  return { match: hits.length === 1 ? hits[0] : null, candidates: hits };
}

// ── ONE LOAD ─────────────────────────────────────────────────────────────────

const pointKey = (r) => (Number.isFinite(r?.lat) && Number.isFinite(r?.lng) ? `${r.lat.toFixed(4)},${r.lng.toFixed(4)}` : null);
const seqOf = (r) => (Number.isFinite(r?.routeSeq) ? r.routeSeq : Number.isFinite(r?.loadStopSeq) ? r.loadStopSeq : Infinity);
const isDone = (r) => s(r?.normalizedStatus).toUpperCase() === 'DELIVERED';
const outcomeOf = (r) => {
  const st = s(r?.normalizedStatus).toUpperCase();
  if (st === 'DELIVERED') return 'delivered';
  if (st === 'EXCEPTION') return 'not-delivered';
  return 'open';
};

/**
 * THE ORDER THE TRUCK ACTUALLY WENT, as physical stops.
 *
 * Finished orders only, by the time each was finished — that is what happened, and it is what a
 * driver is being judged on. Orders at one point are one stop (a strip mall is one stop with
 * three receivers), timed by the first delivery there. Ties break on the dispatched sequence.
 * An order that was never finished, or finished with no time on it, cannot be placed in the run
 * without inventing where it went, so it is left out of the run and counted instead.
 */
export function deliveredRun(rows) {
  const points = new Map();
  let noTime = 0;
  let noPin = 0;
  for (const r of rows || []) {
    if (!isDone(r)) continue;
    const at = finishedAt(r);
    const k = pointKey(r);
    if (!at) { noTime += 1; continue; }
    if (!k) { noPin += 1; continue; }
    const p = points.get(k) || { lat: r.lat, lng: r.lng, at, seq: Infinity, eta: '', stopNbrs: [], names: [] };
    if (at < p.at) p.at = at;
    p.seq = Math.min(p.seq, seqOf(r));
    const eta = s(r.plannedEtaDTTM);
    if (eta && (!p.eta || eta < p.eta)) p.eta = eta;
    p.stopNbrs.push(s(r.stopNbr));
    const nm = s(r.businessName);
    if (nm && !p.names.includes(nm)) p.names.push(nm);
    p.city = p.city || s(r.city);
    points.set(k, p);
  }
  const run = [...points.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1
    : a.seq !== b.seq ? a.seq - b.seq : a.eta < b.eta ? -1 : a.eta > b.eta ? 1 : compareStopNbr(a.stopNbrs[0], b.stopNbrs[0])));
  return { run: run.map((p, i) => ({ n: i + 1, lat: p.lat, lng: p.lng, at: p.at, city: p.city, names: p.names, stopNbrs: p.stopNbrs.sort(compareStopNbr) })), noTime, noPin };
}

/** Yard → each stop of the run → yard, with a repeated point collapsed (it adds no road). */
export function milesPath(run, yard = YARD) {
  const pts = [{ lat: yard.lat, lng: yard.lng }, ...(run || []).map((p) => ({ lat: p.lat, lng: p.lng })), { lat: yard.lat, lng: yard.lng }];
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.lat.toFixed(5) === p.lat.toFixed(5) && last.lng.toFixed(5) === p.lng.toFixed(5)) continue;
    out.push(p);
  }
  return out.length >= 2 ? out : [];
}

/** A short, stable name for a path — what a cached distance is checked against. */
export function pathFingerprint(points) {
  const str = (points || []).map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${(points || []).length}:${h.toString(16).padStart(8, '0')}`;
}

/** The path cut into requests Google will take: each ≤ 25 intermediates, chained end to start. */
export function routeChunks(points, maxIntermediates = MAX_INTERMEDIATES) {
  const pts = points || [];
  if (pts.length < 2) return [];
  const span = maxIntermediates + 1;
  const out = [];
  for (let i = 0; i < pts.length - 1; i += span) {
    const end = Math.min(i + span, pts.length - 1);
    out.push({ origin: pts[i], destination: pts[end], intermediates: pts.slice(i + 1, end) });
  }
  return out;
}

export const toMiles = (meters) => (Number.isFinite(meters) ? Math.round((meters / METERS_PER_MILE) * 10) / 10 : null);

/**
 * ONE LOAD, EVERYTHING WE HOLD ABOUT IT. `rows` are its orders on one board day; `priced` says
 * which of them carry the order's price for this week (see pricedRows).
 */
export function buildLoad(date, name, rows, { truck = null, priced = null } = {}) {
  const list = [...(rows || [])].sort((a, b) => seqOf(a) - seqOf(b) || compareStopNbr(a.stopNbr, b.stopNbr));
  const pricing = priced || pricedRows(list);
  const { run, noTime, noPin } = deliveredRun(list);
  const at = list.filter(isDone).map(finishedAt).filter(Boolean).sort();
  const firstAt = at[0] || null;
  const lastAt = at[at.length - 1] || null;
  const places = new Set(list.map((r) => pointKey(r) || `nopin:${s(r.stopNbr)}`));
  const price = { delivered: 0, deliveredOrders: 0, notDelivered: 0, notDeliveredOrders: 0, priced: 0, orders: 0, unpriced: 0, unreadable: 0, conflicts: 0, elsewhere: 0 };
  const views = list.map((r) => {
    const p = pricing.get(r) || { counted: false, price: orderPrice(r) };
    const out = outcomeOf(r);
    if (p.counted) {
      price.orders += 1;
      if (p.price.amount != null) {
        price.priced += 1;
        if (out === 'delivered') { price.delivered = cents(price.delivered + p.price.amount); price.deliveredOrders += 1; }
        else { price.notDelivered = cents(price.notDelivered + p.price.amount); price.notDeliveredOrders += 1; }
      } else {
        price.unpriced += 1;
        if (p.price.unreadable) price.unreadable += 1;
        if (p.price.conflict) price.conflicts += 1;
      }
    } else if (p.countedOn) price.elsewhere += 1;
    const inRun = run.find((x) => x.stopNbrs.includes(s(r.stopNbr)));
    return {
      stopNbr: s(r.stopNbr), date, businessName: s(r.businessName) || null, city: s(r.city) || null, zip: s(r.zip) || null,
      lat: Number.isFinite(r.lat) ? r.lat : null, lng: Number.isFinite(r.lng) ? r.lng : null,
      outcome: out, status: s(r.normalizedStatus) || null, pickup: isPickup(r), attempt: !!r.isAttempt,
      at: out === 'delivered' ? finishedAt(r) : null, stop: inRun ? inRun.n : null, seq: Number.isFinite(seqOf(r)) ? seqOf(r) : null,
      weight: num(r.weight), skids: num(r.cartons), loose: num(r.volume),
      price: p.counted ? p.price.amount : null, priceSource: p.counted ? p.price.source : null,
      priceNote: p.counted ? (p.price.conflict || (p.price.unreadable ? `Seal # reads "${p.price.unreadable}" — not clearly a price` : null)) : null,
      countedOn: p.countedOn || null,
    };
  });
  const sum = (f) => views.reduce((a, v) => a + (v[f] || 0), 0);
  const spanMin = firstAt && lastAt ? wallMinutes(firstAt, lastAt) : null;
  return {
    key: `${date}|${name}`, date, name, truck,
    orders: views.length,
    deliveries: views.filter((v) => !v.pickup).length,
    pickups: views.filter((v) => v.pickup).length,
    stops: places.size,
    delivered: views.filter((v) => v.outcome === 'delivered').length,
    notDelivered: views.filter((v) => v.outcome === 'not-delivered').length,
    open: views.filter((v) => v.outcome === 'open').length,
    attempts: views.filter((v) => v.attempt).length,
    weight: Math.round(sum('weight')), skids: sum('skids'), loose: sum('loose'),
    firstAt, lastAt, spanMin,
    run, runLeftOut: { noTime, noPin, notFinished: views.filter((v) => v.outcome !== 'delivered').length },
    path: milesPath(run),
    price,
    rows: views,
  };
}

/**
 * WHICH ROW CARRIES EACH ORDER'S PRICE THIS WEEK — once per order, on the load that delivered it.
 *
 * The same order can be on the week more than once: pieces of one Uline order, and a failed
 * attempt redelivered later in the week. Its price belongs to it once. The delivering row takes
 * it (the latest delivery if there were two); an order never delivered this week is priced on
 * its first appearance, and the screen still shows it as not delivered. Pieces that carry
 * DIFFERENT prices are not added up or picked between — the order is left unpriced and says why.
 */
export function pricedRows(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const k = baseOrderNbr(r.stopNbr);
    if (!k) continue;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const out = new Map();
  for (const list of groups.values()) {
    const prices = list.map((r) => orderPrice(r));
    const amounts = [...new Set(prices.map((p) => p.amount).filter((a) => a != null))];
    const done = list.filter(isDone);
    const pick = done.length
      ? done.reduce((a, b) => ((finishedAt(b) || '') > (finishedAt(a) || '') ? b : a))
      : list.reduce((a, b) => (s(b.date) < s(a.date) ? b : a));
    const pickPrice = amounts.length > 1
      ? { amount: null, source: null, conflict: `pieces of this order carry different prices (${amounts.map((a) => `$${a.toFixed(2)}`).join(', ')})` }
      : (prices[list.indexOf(pick)].amount != null ? prices[list.indexOf(pick)] : (prices.find((p) => p.amount != null) || prices[list.indexOf(pick)]));
    for (const r of list) {
      out.set(r, r === pick ? { counted: true, price: pickPrice } : { counted: false, price: prices[list.indexOf(r)], countedOn: { date: s(pick.date), load: loadOf(pick), stopNbr: s(pick.stopNbr) } });
    }
  }
  return out;
}

// ── THE WEEK ─────────────────────────────────────────────────────────────────

/**
 * A DRIVER'S WEEK: every load they ran, day by day, and the totals.
 *
 * `stops` are the week's rows, each carrying `date` (the board day that filed it — the
 * collection key, never a stored field that may be stale). `classes` is { [date]: { [load]:
 * 'tractor' | 'box' } }, the per-day truck map the board uses; a day without one reads unknown
 * rather than borrowing another day's trucks. `miles` is { [load.key]: { meters, ... } } from
 * the endpoint, applied here so the ratios below are computed in one place.
 */
export function driverWeek(stops, driverKey, { aliases = [], classes = {}, miles = {}, dropCancelled = true } = {}) {
  const folded = applyAliases(stops || [], aliases);
  const mine = folded.filter((r) => loadOf(r) && driverKeyOf(r) === driverKey);
  // The board's own switch (BOARD_DROP_CANCELLED): off there means off here, so this screen can
  // never count a load differently from the board it was read off.
  const { stops: kept, dropped } = dropCancelledStops(mine, dropCancelled);
  const priced = pricedRows(kept);
  const byLoad = new Map();
  for (const r of kept) {
    const k = `${r.date}|${loadOf(r)}`;
    (byLoad.get(k) || byLoad.set(k, []).get(k)).push(r);
  }
  const loads = [...byLoad.entries()].map(([k, rows]) => {
    const [date, name] = [k.slice(0, 10), k.slice(11)];
    const load = buildLoad(date, name, rows, { truck: classes?.[date]?.[name] || null, priced });
    return withMiles(load, miles[load.key]);
  }).sort((a, b) => (a.date !== b.date ? a.date.localeCompare(b.date) : (a.firstAt || '~').localeCompare(b.firstAt || '~') || a.name.localeCompare(b.name)));
  const label = mine.reduce((acc, r) => betterLabel(acc, canonicalDriver(s(r.driverName) || s(r.driverUserName)).label), '');
  return { driver: { key: driverKey, label: label || driverKey }, loads, cancelledOff: dropped.length, totals: weekTotals(loads) };
}

/**
 * Put a measured distance on a load, and the two ratios a distance and a price make.
 *
 * $/mile and $/stop are printed ONLY when every order on the load that counts toward it is
 * priced. A load with one unpriced order would otherwise show a rate that is low by exactly the
 * missing price, and nothing on screen would say so — the partial-sum-as-total failure again.
 */
export function withMiles(load, m) {
  const meters = Number.isFinite(m?.meters) ? m.meters : null;
  const miles = toMiles(meters);
  const complete = load.price.orders > 0 && load.price.unpriced === 0;
  return {
    ...load,
    miles: { miles, source: m?.source || null, reason: m?.reason || null, inProgress: load.open > 0 },
    perMile: complete && miles ? cents(load.price.delivered / miles) : null,
    perStop: complete && load.run.length ? cents(load.price.delivered / load.run.length) : null,
    priceComplete: complete,
  };
}

/** The week's totals. Rates are over the loads that can carry one, and say how many those are. */
export function weekTotals(loads) {
  const L = loads || [];
  const add = (f) => L.reduce((a, l) => a + (Number(f(l)) || 0), 0);
  const measured = L.filter((l) => l.miles?.miles != null);
  const rated = L.filter((l) => l.perMile != null);
  const ratedMiles = rated.reduce((a, l) => a + l.miles.miles, 0);
  const ratedPay = rated.reduce((a, l) => a + l.price.delivered, 0);
  const ratedStops = rated.reduce((a, l) => a + l.run.length, 0);
  const span = L.filter((l) => l.spanMin != null);
  const spanMin = span.reduce((a, l) => a + l.spanMin, 0);
  const spanStops = span.reduce((a, l) => a + l.run.length, 0);
  return {
    loads: L.length,
    days: new Set(L.map((l) => l.date)).size,
    orders: add((l) => l.orders), deliveries: add((l) => l.deliveries), pickups: add((l) => l.pickups),
    stops: add((l) => l.stops), delivered: add((l) => l.delivered), notDelivered: add((l) => l.notDelivered),
    open: add((l) => l.open), attempts: add((l) => l.attempts),
    weight: add((l) => l.weight), skids: add((l) => l.skids), loose: add((l) => l.loose),
    miles: measured.length ? Math.round(measured.reduce((a, l) => a + l.miles.miles, 0) * 10) / 10 : null,
    milesLoads: measured.length,
    spanMin: span.length ? spanMin : null, spanLoads: span.length,
    stopsPerHour: spanMin > 0 ? Math.round((spanStops / (spanMin / 60)) * 10) / 10 : null,
    price: {
      delivered: cents(add((l) => l.price.delivered)), deliveredOrders: add((l) => l.price.deliveredOrders),
      notDelivered: cents(add((l) => l.price.notDelivered)), notDeliveredOrders: add((l) => l.price.notDeliveredOrders),
      priced: add((l) => l.price.priced), orders: add((l) => l.price.orders), unpriced: add((l) => l.price.unpriced),
    },
    perMile: ratedMiles > 0 ? cents(ratedPay / ratedMiles) : null,
    perStop: ratedStops > 0 ? cents(ratedPay / ratedStops) : null,
    ratedLoads: rated.length,
    cost: null,
  };
}
