// scripts/lib/performance-fixture.mjs — More → Performance's answers, for the layout guards.
//
// BUILT, NOT TYPED: every day is produced by the real buildPaceDigest / paceSummaryOf over
// synthetic board stops, so the guards measure exactly the shape stop-performance returns and
// cannot drift from it when the digest grows a field. And built for the WORST layout:
//
//   • four-digit counts on every tile and every row;
//   • a live day part-way through, JUDGED (the verdict sentence, the four facts, the band);
//   • a route and a driver long enough to wrap at 360px, and a load with no driver on it;
//   • two captured days with no digest yet (gaps on the trend, the History card's Build button)
//     and one weekday never captured at all (the amber line under it);
//   • unable, hand-closed, in-flight and cancelled stops, so every row of the outcome meter draws.
//
// "TODAY" IS THE MOST RECENT WEEKDAY IN EASTERN TIME — on a Saturday run it is Friday — and the
// board's last scan is pinned at 11:10a, so the guards see a judged mid-morning whatever day and
// hour CI happens to run. Numbers are seeded by date, so a run is reproducible.
//
// Zero NuVizz calls, obviously: nothing here reaches past this process.
import { buildPaceDigest, paceSummaryOf } from '../../netlify/functions/lib/stop-pace.mts';

const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const isoWeekday = (d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The live day the fixture answers for: today in ET, or the Friday before a weekend. */
export function performanceToday(now = new Date()) {
  let d = ET_DAY.format(now);
  while (isoWeekday(d) > 5) d = addDays(d, -1);
  return d;
}

/** The minute the live board's last scan is pinned at: 11:10a. */
export const FIXTURE_SCAN_MINUTE = 11 * 60 + 10;

function seeded(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROUTES = [
  ['ATLANTA SOUTHWEST 3 — LATE SHIFT', 'ROBERT MENSAH-ADDAI'], ['NOR 2', 'Frank Okine'], ['SUW 1', 'Joe Gibbs'],
  ['MAR 3', 'Tyrese Griffin'], ['DUL 2', 'Sirdedrick Sheats'], ['BUF 1', 'Alpha Diallo'],
  ['CUM 4', 'Maria Hernandez-Castillo'], ['SOU 4', null], ['LAW 1', 'Darvin Mcclendon'], ['GAI 2', 'Marcus Webb'],
  ['KEN 1', 'Brian Tolliver'], ['ALP 3', 'Mone Jackson'], ['DOR 1', 'Luis Ortega'], ['CON 2', 'Andre Pickens'],
  ['NOR 11', 'Kevin Osei'], ['SMY 2', 'Terrence Hall'], ['JON 1', 'Cedric Moore'], ['ROS 2', 'Paul Nkemelu'],
  ['WIN 1', 'Derrick Stokes'], ['CAN 1', 'Samuel Adjei'], ['MCD 2', 'Jamal Rivers'], ['LIL 1', 'Chris Dunbar'],
  ['FAY 1', 'Omar Haddad'], ['PEA 3', 'Victor Oyelaran'],
];

/**
 * One board day of synthetic stops. `cutoff` (a minute) makes it a LIVE day: nothing is delivered
 * after it, a few stops are on the road or on site, and the rest are still open.
 */
function boardStops(date, { cutoff = null, lateStart = 0 } = {}) {
  const rnd = seeded(date);
  const out = [];
  let n = 0;
  ROUTES.forEach(([route, driver], ri) => {
    const stops = 40 + Math.floor(rnd() * 14);
    // Route 7 has not left the dock at the live day's scan — a real "0% done" row.
    let t = 7 * 60 + 40 + Math.floor(rnd() * 50) + lateStart + (cutoff != null && ri === 7 ? 200 : 0);
    for (let i = 0; i < stops; i++) {
      n += 1;
      t += 6 + Math.floor(rnd() * 12);
      const base = { stopNbr: String(7180000 + n).padStart(9, '0'), pro: String(7180000 + n).padStart(9, '0'), isPlanned: true, loadNbr: route, routeName: route, driverName: driver };
      const roll = rnd();
      if (roll < 0.01) { out.push({ ...base, status: '99', normalizedStatus: 'CANCELLED' }); continue; }
      if (roll < 0.03) { out.push({ ...base, status: '80', normalizedStatus: 'EXCEPTION', arrivalDTTM: `${date}T${hhmm(Math.min(t, 23 * 60))}` }); continue; }
      if (cutoff != null && t > cutoff) {
        const next = t - cutoff < 12 ? (rnd() < 0.5 ? '40' : '50') : '20';
        out.push({ ...base, status: next, normalizedStatus: next === '20' ? 'SCHEDULED' : 'IN_TRANSIT' });
        continue;
      }
      if (cutoff == null && roll > 0.985) { out.push({ ...base, status: '20', normalizedStatus: 'SCHEDULED' }); continue; }
      const manual = roll > 0.9;
      out.push({ ...base, status: manual ? '91' : '90', normalizedStatus: 'DELIVERED', deliveredDTTM: `${date}T${hhmm(Math.min(t, 23 * 60 + 55))}` });
    }
  });
  // One CHAD stop, which the count leaves out exactly as the 6:30 report does.
  out.push({ stopNbr: 'CHAD-1', pro: 'CHAD-1', isPlanned: true, loadNbr: 'CHAD', routeName: 'CHAD', status: '90', deliveredDTTM: `${date}T09:00` });
  return out;
}

const cache = new Map();
function sealedDigest(date) {
  if (!cache.has(date)) cache.set(date, buildPaceDigest(boardStops(date), { date, source: 'sealed', builtAt: `${addDays(date, 1)}T06:02:00.000Z`, excludeRoutes: ['CHAD'] }));
  return cache.get(date);
}
function liveDigest(today) {
  const key = `live:${today}`;
  if (!cache.has(key)) {
    // Twenty minutes late out of the gate: the pace reads Behind, the facts and the amber delta draw.
    const d = buildPaceDigest(boardStops(today, { cutoff: FIXTURE_SCAN_MINUTE, lateStart: 20 }), { date: today, source: 'live', builtAt: new Date().toISOString(), excludeRoutes: ['CHAD'] });
    cache.set(key, { ...d, asOf: { minute: FIXTURE_SCAN_MINUTE, at: `${today}T15:10:00.000Z` }, scanState: null, boardRows: 900 });
  }
  return cache.get(key);
}

/** The `n`th weekday before `day` (1 = the weekday before it). */
function weekdayBefore(day, n) {
  let d = day;
  for (let k = 0; k < n;) { d = addDays(d, -1); if (isoWeekday(d) <= 5) k += 1; }
  return d;
}

/**
 * Which weekdays have no digest yet, and which were never captured — counted in WEEKDAYS back from
 * today, so they land inside the default 30-day range on whatever day of the week the guard runs.
 */
function coverageShape(today) {
  return {
    missing: new Set([weekdayBefore(today, 2), weekdayBefore(today, 7)]),
    uncaptured: new Set([weekdayBefore(today, 12)]),
  };
}

/** The days the fixture holds as captured but not built yet — what History's Build button would build. */
export function performanceMissingDays(now = new Date()) {
  return [...coverageShape(performanceToday(now)).missing].sort();
}

/**
 * The endpoint's answer for a request URL — the main read, or one day (`detailOnly=1&day=…`), in
 * the same shape stop-performance returns (see that file's `J({...})`). `built` names missing days
 * to treat as built since, so a preview can play the History card's Build button through.
 */
export function performanceAnswer(url, now = new Date(), { built = [] } = {}) {
  const u = new URL(url, 'http://guard.local');
  const today = performanceToday(now);
  const yesterday = addDays(today, -1);
  const shape = coverageShape(today);
  const builtSince = new Set(built);
  const sealedOn = (d) => d < today && isoWeekday(d) <= 5 && !shape.uncaptured.has(d);
  const builtOn = (d) => sealedOn(d) && (!shape.missing.has(d) || builtSince.has(d));

  if (u.searchParams.get('detailOnly') === '1') {
    const day = u.searchParams.get('day');
    if (day === today) return { ok: true, nuvizzCalls: 0, today, detail: liveDigest(today) };
    return { ok: true, nuvizzCalls: 0, today, detail: day && builtOn(day) ? sealedDigest(day) : null };
  }

  const reqTo = u.searchParams.get('to') || today;
  const to = reqTo > today ? today : reqTo;
  const from = u.searchParams.get('from') || addDays(to, -29);
  const trendTo = to < today ? to : yesterday;
  const poolFrom = addDays(today, -84);
  const windowFrom = from < poolFrom ? from : poolFrom;

  const days = [];
  for (let d = from; d <= trendTo; d = addDays(d, 1)) if (builtOn(d)) days.push(paceSummaryOf(sealedDigest(d)));
  const live = liveDigest(today);
  if (from <= today && today <= to) days.push(paceSummaryOf(live));

  const pool = [];
  for (let d = yesterday; d >= poolFrom && pool.length < 40; d = addDays(d, -1)) {
    if (builtOn(d)) pool.push({ ...paceSummaryOf(sealedDigest(d)), curve: sealedDigest(d).curve });
  }

  const looked = (d) => (d >= from && d <= trendTo) || (d >= poolFrom && d <= yesterday);
  const lookedDays = [];
  for (let d = windowFrom; d <= yesterday; d = addDays(d, 1)) if (looked(d)) lookedDays.push(d);

  return {
    ok: true,
    nuvizzCalls: 0,
    today,
    now: { minute: FIXTURE_SCAN_MINUTE + 2, at: `${today}T15:12:00.000Z` },
    range: { from, to, clamped: null },
    days,
    pool,
    live,
    liveNote: null,
    detail: null,
    coverage: {
      from: windowFrom,
      to: yesterday,
      sealed: lookedDays.filter(sealedOn).length,
      built: lookedDays.filter(builtOn).length,
      missing: lookedDays.filter((d) => sealedOn(d) && !builtOn(d)),
      uncaptured: lookedDays.filter((d) => shape.uncaptured.has(d) && d < yesterday),
      noBoard: [],
    },
    excludedRoutes: ['CHAD'],
  };
}
