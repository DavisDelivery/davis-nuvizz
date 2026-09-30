// scripts/lib/stop-lookup-flow-fixture.mjs — the answers verify-stop-lookup.mjs needs that the
// layout fixtures do not carry: the "several businesses match" chooser, and the one-day, one-driver
// driver-loads answers a row's route opens (v1.99.10).
//
// BUILT, NOT TYPED, where the endpoint builds it: the loads are produced by the real driverWeek over
// synthetic rows, so a load the screen opens is exactly the shape driver-loads returns. The rows that
// open them are the ones in customer-view-fixture.mjs and stop-lookup-fixture.mjs, so the row and
// its load can never drift apart.

import { driversOfWeek, driverWeek, YARD, COST_NOT_RECORDED } from '../../src/lib/load-lookup.js';
import { CUSTOMER_VIEW } from './customer-view-fixture.mjs';

/** Twenty-two businesses answer "earthly". The first is CUSTOMER_VIEW, so a pick lands on a real answer. */
export const CUSTOMER_CHOOSE = {
  ok: true, nuvizzCalls: 0, mode: 'customer-choose', query: 'earthly', today: '2026-09-18',
  window: { from: '2026-09-12', to: '2026-09-18', days: 7 },
  matches: [
    { nameKey: CUSTOMER_VIEW.view.nameKey, name: CUSTOMER_VIEW.view.name, stops: 6, lastDate: '2026-09-18', today: 3 },
    { nameKey: 'earthly_goods', name: 'EARTHLY GOODS', stops: 1, lastDate: '2026-09-16', today: 0 },
    { nameKey: 'earthly_delights_bakery', name: 'EARTHLY DELIGHTS BAKERY', stops: 0, lastDate: '2026-08-30', today: 0 },
    // As many as Chad's "master" had (22): enough that, on a phone, the list scrolls the search
    // boxes and their busy button right off the top — the state his tap did nothing he could see in.
    ...Array.from({ length: 19 }, (_, i) => ({
      nameKey: `earthly_fixture_${i}`, name: `EARTHLY FIXTURE CUSTOMER ${i + 1}${i % 4 === 0 ? ' DISTRIBUTION CENTER SOUTHEAST' : ''}`,
      stops: i % 3, lastDate: `2026-09-${String(10 + (i % 8)).padStart(2, '0')}`, today: 0,
    })),
  ],
  complete: true, errors: {}, note: 'Firestore only — nothing here spent a NuVizz call.',
};

const sealedRow = (date, load, driver, stopNbr, i, over = {}) => ({
  stopNbr, date, stopType: 'DO', businessName: i === 0 ? 'EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST' : `FIXTURE CONSIGNEE ${i}`,
  city: 'ATLANTA', zip: '30336', lat: 33.70 + i * 0.013, lng: -84.50 + i * 0.011,
  driverName: driver, driverUserName: driver, routeName: load, loadNbr: load, routeSeq: i + 1,
  normalizedStatus: 'DELIVERED', deliveredDTTM: `${date}T${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '35' : '05'}:00`,
  cartons: 1 + (i % 3), volume: i % 2, weight: 200 + i * 55,
  orderInstructions: `TOTAL-AMOUNT : ${(52 + i * 4.1).toFixed(2)}`,
  ...over,
});

/** One driver's loads on one day, as driver-loads answers it: `loads` is [{ name, nbrs: [stopNbr…] }]. */
function dayAnswer(date, driver, loads) {
  const rows = loads.flatMap((L) => L.nbrs.map((n, i) => sealedRow(date, L.name, driver, n, i)));
  const drivers = driversOfWeek(rows);
  const key = drivers[0]?.key;
  const miles = Object.fromEntries(loads.map((L, i) => [`${date}|${L.name}`, { meters: 61000 + i * 9000, source: 'cache' }]));
  const wk = driverWeek(rows, key, { miles });
  return {
    ok: true, nuvizzCalls: 0, googleCalls: 0, mode: 'driver-week',
    week: { from: date, to: date, dates: [date] }, today: '2026-09-18',
    days: [{ date, source: 'sealed', orders: rows.length }], complete: true,
    driver: wk.driver, loads: wk.loads, totals: wk.totals, cancelledOff: 0, drivers, yard: YARD,
    miles: { enabled: true, googleKey: true, measured: loads.length, cached: loads.length, fetched: 0, failed: 0, skipped: 0, noPath: 0 },
    cost: { recorded: false, text: COST_NOT_RECORDED },
  };
}

// The customer's first row today rides ANDERSON FRIMPONG's ATLANTA SOUTHWEST 3 — the plain case.
const ANDERSON_0918 = dayAnswer('2026-09-18', 'ANDERSON FRIMPONG', [
  { name: 'ATLANTA SOUTHWEST 3', nbrs: ['007180001', '007181101', '007181102', '007181103', '007181104', '007181105'] },
]);
// The order view's 9/17 row (stop-lookup-fixture.mjs) rides his PEACHTREE CORNERS 2.
const ANDERSON_0917 = dayAnswer('2026-09-17', 'ANDERSON FRIMPONG', [
  { name: 'PEACHTREE CORNERS 2', nbrs: ['007174397', '007172201', '007172202', '007172203'] },
]);
// The customer's second row names ROBERT MENSAH-ADDAI, and two people answer to that name: the
// screen must ask which, then — this one ran ROBERT 1, not the row's ATLANTA SOUTHWEST 3 — list the
// day's loads rather than open one for him.
const ROBERT_KEY = 'ROBERT MENSAH-ADDAI';
const ROBERT_0918 = dayAnswer('2026-09-18', ROBERT_KEY, [
  { name: 'ROBERT 1', nbrs: ['007183301', '007183302', '007183303'] },
]);
const ROBERT_CHOOSE = {
  ok: true, nuvizzCalls: 0, googleCalls: 0, mode: 'driver-week-choose', typed: ROBERT_KEY,
  week: { from: '2026-09-18', to: '2026-09-18', dates: ['2026-09-18'] }, today: '2026-09-18',
  days: [{ date: '2026-09-18', source: 'sealed', orders: 9 }], complete: true,
  drivers: [], candidates: [
    { key: ROBERT_0918.driver.key, label: 'ROBERT MENSAH-ADDAI', days: 1, loads: 1, orders: 3 },
    { key: 'robert_mensah_addai_jr', label: 'ROBERT MENSAH-ADDAI JR', days: 1, loads: 1, orders: 5 },
  ],
};
const EMPTY_DAY = (date, driver) => ({ ...dayAnswer(date, driver, []), driver: { key: String(driver).toLowerCase(), label: driver } });
/** A day that has not happened: driver-loads reads nothing for it and says so (source 'future'). */
export const FUTURE_DAY = '2099-01-02';
const FUTURE = (driver) => ({ ...EMPTY_DAY(FUTURE_DAY, driver), days: [{ date: FUTURE_DAY, source: 'future', orders: 0 }] });

/** driver-loads, answered the way the endpoint picks: by the day, then the key or the typed name. */
export function rowLoadAnswer(url) {
  const u = new URL(url, 'https://x');
  const from = u.searchParams.get('from');
  const key = u.searchParams.get('key');
  const driver = u.searchParams.get('driver') || '';
  if (from === '2026-09-18' && key === ROBERT_0918.driver.key) return ROBERT_0918;
  if (from === '2026-09-18' && /^ROBERT MENSAH-ADDAI$/i.test(driver)) return ROBERT_CHOOSE;
  if (from === '2026-09-18' && /ANDERSON FRIMPONG/i.test(driver)) return ANDERSON_0918;
  if (from === '2026-09-17' && /ANDERSON FRIMPONG/i.test(driver)) return ANDERSON_0917;
  if (from === FUTURE_DAY) return FUTURE(driver || key);
  return EMPTY_DAY(from, driver || key);
}

/** A one-day driver-loads ask is a row's load; a wider one (Driver's loads) is somebody's week. */
export const isRowLoadAsk = (url) => {
  const u = new URL(url, 'https://x');
  return !!u.searchParams.get('from') && u.searchParams.get('from') === u.searchParams.get('to') && !!(u.searchParams.get('driver') || u.searchParams.get('key'));
};

/** An order planned onto a load that runs on a day that has not happened (the order view reads three
 *  days ahead): its route must say the load has not run yet, never that there is no load. */
export function futureOrder(dossier) {
  const d = JSON.parse(JSON.stringify(dossier));
  const day = d.dossier.days[0];
  Object.assign(day, { date: FUTURE_DAY, outcome: 'open', status: 'SCHEDULED', deliveredAt: null, arrivedAt: null, route: 'GAINESVILLE 1', seq: 4 });
  d.dossier.query = '007199999';
  return d;
}
