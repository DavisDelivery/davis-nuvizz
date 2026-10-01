// scripts/lib/stop-lookup-flow-fixture.mjs — the answers verify-stop-lookup.mjs needs that the
// layout fixtures do not carry: the "several businesses match" chooser, and the one-day, one-driver
// driver-loads answers a row's route opens (v1.99.10).
//
// BUILT, NOT TYPED, where the endpoint builds it: the loads are produced by the real driverWeek over
// synthetic rows, so a load the screen opens is exactly the shape driver-loads returns. The rows that
// open them are the ones in customer-view-fixture.mjs and stop-lookup-fixture.mjs, so the row and
// its load can never drift apart.

import { driversOfWeek, resolveDriver, driverWeek, YARD, COST_NOT_RECORDED } from '../../src/lib/load-lookup.js';
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

const CUSTOMER = 'EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST';
const sealedRow = (date, load, driver, user, stopNbr, i) => ({
  stopNbr, date, stopType: 'DO', businessName: /^00718000/.test(stopNbr) ? CUSTOMER : `FIXTURE CONSIGNEE ${i}`,
  city: 'ATLANTA', zip: '30336', lat: 33.70 + i * 0.013, lng: -84.50 + i * 0.011,
  driverName: driver, driverUserName: user || driver, routeName: load, loadNbr: load, routeSeq: i + 1,
  normalizedStatus: 'DELIVERED', deliveredDTTM: `${date}T${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '35' : '05'}:00`,
  cartons: 1 + (i % 3), volume: i % 2, weight: 200 + i * 55,
  orderInstructions: `TOTAL-AMOUNT : ${(52 + i * 4.1).toFixed(2)}`,
});
/** Every load on one day: [{ load, driver, user?, nbrs }], as the sealed day holds them. */
const dayRows = (date, loads) => loads.flatMap((L) => L.nbrs.map((n, i) => sealedRow(date, L.load, L.driver, L.user, n, i)));

/** A day that has not happened: driver-loads reads nothing for it and says so (source 'future'). */
export const FUTURE_DAY = '2099-01-02';

const DAYS = {
  // The customer's first row today rides ANDERSON FRIMPONG's ATLANTA SOUTHWEST 3 — and so does the
  // customer's third order, so the same order can be tapped under its row AND inside the load.
  '2026-09-18': dayRows('2026-09-18', [
    { load: 'ATLANTA SOUTHWEST 3', driver: 'ANDERSON FRIMPONG', nbrs: ['007180001', '007181101', '007181102', '007181103', '007180003', '007181105'] },
    // Two people answer to "ROBERT MENSAH-ADDAI": their log-ins differ, so the typed name is no
    // key and the name matches both labels — the real resolveDriver asks which (checked below).
    { load: 'ROBERT 1', driver: 'ROBERT MENSAH-ADDAI', user: 'rmensah', nbrs: ['007183301', '007183302', '007183303'] },
    { load: 'ROBERT 2', driver: 'ROBERT MENSAH-ADDAI JR', user: 'rmensahjr', nbrs: ['007183401', '007183402'] },
  ]),
  // The order view's 9/17 row (stop-lookup-fixture.mjs) rides his PEACHTREE CORNERS 2.
  '2026-09-17': dayRows('2026-09-17', [
    { load: 'PEACHTREE CORNERS 2', driver: 'ANDERSON FRIMPONG', nbrs: ['007174397', '007172201', '007172202', '007172203'] },
  ]),
  // A VENDOR RENAME: the row says "Brent  Boyd"; driver-loads folds the alias list first, so the day
  // holds only "Brent  Bryd" and the row's name matches nobody (marginiq.mts's documented case).
  '2026-09-16': dayRows('2026-09-16', [
    { load: 'BRENT 1', driver: 'Brent  Bryd', nbrs: ['007150001', '007150002', '007150003'] },
    { load: 'SAMUEL 2', driver: 'SAMUEL OSEI', nbrs: ['007150101', '007150102'] },
  ]),
  // A MOVED ORDER: the row names FRANK 1 (the morning plan); the sealed day files it on SAMUEL 2.
  '2026-09-15': dayRows('2026-09-15', [
    { load: 'FRANK 1', driver: 'FRANK OKINE', nbrs: ['007160101', '007160102', '007160103'] },
    { load: 'SAMUEL 2', driver: 'SAMUEL OSEI', nbrs: ['007160001', '007160201'] },
  ]),
};

/**
 * driver-loads for ONE day, answered the way the endpoint answers it (driver-loads.mts, the lines
 * after the aliases fold): the day's drivers by driversOfWeek, the typed name through the REAL
 * resolveDriver, a key looked up exactly; no match is `driver-week-choose` with the candidates and
 * the whole day's drivers. Built, not typed — a row that "asks which driver" here would ask for real.
 */
export function rowLoadAnswer(url) {
  const u = new URL(url, 'https://x');
  const date = u.searchParams.get('from');
  const key = String(u.searchParams.get('key') || '').trim();
  const typed = String(u.searchParams.get('driver') || '').trim();
  const base = { ok: true, nuvizzCalls: 0, week: { from: date, to: date, dates: [date] }, today: '2026-09-18', complete: true };
  if (date === FUTURE_DAY) return { ...base, googleCalls: 0, mode: 'driver-week-choose', typed, days: [{ date, source: 'future', orders: 0 }], drivers: [], candidates: [] };
  const rows = DAYS[date] || [];
  const days = [{ date, source: 'sealed', orders: rows.length }];
  const drivers = driversOfWeek(rows);
  const pick = key ? { match: drivers.find((d) => d.key === key) || null, candidates: [] } : resolveDriver(drivers, typed);
  if (!pick.match) return { ...base, days, googleCalls: 0, mode: 'driver-week-choose', typed: typed || key || null, drivers, candidates: typed ? pick.candidates : drivers };
  const names = [...new Set(rows.map((r) => r.loadNbr))];
  const miles = Object.fromEntries(names.map((n, i) => [`${date}|${n}`, { meters: 61000 + i * 9000, source: 'cache' }]));
  const wk = driverWeek(rows, pick.match.key, { miles });
  return {
    ...base, days, googleCalls: 0, mode: 'driver-week',
    driver: wk.driver, loads: wk.loads, totals: wk.totals, cancelledOff: 0, drivers, yard: YARD,
    miles: { enabled: true, googleKey: true, measured: wk.loads.length, cached: wk.loads.length, fetched: 0, failed: 0, skipped: 0, noPath: 0 },
    cost: { recorded: false, text: COST_NOT_RECORDED },
  };
}

// THE FIXTURE CHECKS ITSELF against the real matching rule, so a change to resolveDriver that made
// these cases unreachable fails the guard loudly instead of testing a screen no row can reach.
{
  const ask = (d, name) => rowLoadAnswer(`https://x/?from=${d}&to=${d}&driver=${encodeURIComponent(name)}`);
  if (ask('2026-09-18', 'ROBERT MENSAH-ADDAI').candidates?.length !== 2) throw new Error('fixture: ROBERT MENSAH-ADDAI no longer asks which of two drivers');
  if (ask('2026-09-16', 'Brent  Boyd').mode !== 'driver-week-choose' || ask('2026-09-16', 'Brent  Boyd').candidates.length !== 0) throw new Error('fixture: the renamed driver now matches');
  if (ask('2026-09-18', 'ANDERSON FRIMPONG').mode !== 'driver-week') throw new Error('fixture: ANDERSON FRIMPONG no longer resolves');
}

/** A one-day driver-loads ask is a row's load; a wider one (Driver's loads) is somebody's week. */
export const isRowLoadAsk = (url) => {
  const u = new URL(url, 'https://x');
  return !!u.searchParams.get('from') && u.searchParams.get('from') === u.searchParams.get('to') && !!(u.searchParams.get('driver') || u.searchParams.get('key'));
};

/** An order page whose first day is `over` — a future load, a renamed driver, a moved order. */
export function orderOn(dossier, query, over) {
  const d = JSON.parse(JSON.stringify(dossier));
  d.dossier.days = d.dossier.days.slice(0, 1);   // one day: a second row on the same date would share its key
  Object.assign(d.dossier.days[0], { outcome: 'open', status: 'SCHEDULED', deliveredAt: null, arrivedAt: null, currentDriver: null, ...over });
  d.dossier.days[0].refs = { ...d.dossier.days[0].refs, stopNbr: query, pro: query };
  d.dossier.query = query;
  d.dossier.identity = { ...d.dossier.identity, pro: query, stopNbr: query };
  return d;
}
