// scripts/lib/driver-week-fixture.mjs — the load lookup's answers (driver-loads), for the guards.
//
// BUILT, NOT TYPED: the week is produced by the real driversOfWeek / driverWeek over synthetic
// sealed rows, so the guards measure exactly what the endpoint returns and cannot drift from it
// when a load grows a field. Built for the WORST layout: a long hyphenated driver name, a load
// name that runs to 32 characters, 44-character consignees, a load with an order that has no
// price, a not-delivered and a still-open order, a pickup, a redelivery, a tractor and a box
// truck, a load Google could not measure and one the switch never asked about.

import { weekOf, driversOfWeek, driverWeek, YARD, COST_NOT_RECORDED } from '../../src/lib/load-lookup.js';

const WEEK = weekOf('2026-09-16');
const DRIVER = 'ROBERT MENSAH-ADDAI';
const NAMES = ['EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST', 'TITAN ELECTRIC COMPANIES QTS DATA CENTER', 'LED ENERGY PLUS', 'JOHN SMITH',
  'PEACHTREE CORNERS MEDICAL OFFICE PARK SUITE 210', 'SATELLITE INDUSTRIES'];
const CITIES = ['PEACHTREE CORNERS', 'LAWRENCEVILLE', 'BUFORD', 'DAWSONVILLE', 'SUGAR HILL'];
const LOADS = [
  { date: WEEK.dates[0], name: 'ATLANTA SOUTHWEST 3 — LATE SHIFT', n: 18, start: 6 },
  { date: WEEK.dates[1], name: 'ROBERT 1', n: 14, start: 7 },
  { date: WEEK.dates[2], name: 'ROBERT 1', n: 21, start: 5 },
  { date: WEEK.dates[2], name: 'ROBERT/DJ 1', n: 4, start: 15 },
  { date: WEEK.dates[3], name: 'ROBERT 1', n: 12, start: 8 },
];

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const rows = [];
let serial = 7171000;
LOADS.forEach((L, li) => {
  for (let i = 0; i < L.n; i += 1) {
    serial += 1;
    const stopNbr = i === 3 ? `ESTES-05382${String(serial).slice(-5)}` : i === 5 ? `RA57${serial}` : String(serial).padStart(9, '0');
    const at = L.start * 60 + i * 23;
    const status = li === 0 && i === 7 ? 'EXCEPTION' : li === 4 && i === 11 ? 'SCHEDULED' : 'DELIVERED';
    rows.push({
      stopNbr, date: L.date, stopType: i === 5 ? 'PU' : 'DO',
      businessName: NAMES[(i + li) % NAMES.length], city: CITIES[(i + li) % CITIES.length], zip: '30518',
      lat: 34.0 + ((i * 7 + li * 3) % 40) / 100, lng: -84.25 + ((i * 11 + li * 5) % 50) / 100,
      driverName: L.name.startsWith('ROBERT/') ? 'ROBERT/DJ 1' : DRIVER, driverUserName: L.name.startsWith('ROBERT/') ? 'ROBERT/DJ 1' : DRIVER,
      routeName: L.name, loadNbr: L.name, routeSeq: i + 1, normalizedStatus: status,
      deliveredDTTM: status === 'DELIVERED' ? `${L.date}T${hhmm(at)}:00` : null,
      cartons: 1 + (i % 3), volume: i % 2, weight: 180 + i * 41,
      isAttempt: li === 2 && i === 1,
      // Uline's price line on most orders, a Seal # on the Estes one, and one order with neither.
      orderInstructions: i === 3 || (li === 1 && i === 9) ? '' : `TOTAL-AMOUNT : ${(48 + i * 3.17).toFixed(2)} LIFT GATE NEEDED`,
      ...(i === 3 ? { raw: { stop: { sealNbr: '$163.18' } } } : {}),
    });
  }
});
// Somebody else's loads that week, so the chooser has a crowd to lay out.
const OTHERS = ['ANTHONY BENNETT', 'ANTHONY WELLS', 'ENOCK AKYEA', 'KWADWO OWUSU-ANSAH', 'COLIN', 'TREVARR JOHNSON', 'SIRDEDRICK SHEATS', 'TYRESE GRIFFIN'];
OTHERS.forEach((d, k) => WEEK.dates.slice(0, 4).forEach((date, j) => rows.push({
  stopNbr: String(7190000 + k * 10 + j).padStart(9, '0'), date, stopType: 'DO', businessName: 'LED ENERGY PLUS', city: 'BUFORD',
  lat: 34.1, lng: -84.0, driverName: d, driverUserName: d, routeName: `${d.split(' ')[0]} ${1 + (k % 2)}`, loadNbr: `${d.split(' ')[0]} ${1 + (k % 2)}`,
  normalizedStatus: 'DELIVERED', deliveredDTTM: `${date}T09:00:00`, routeSeq: 1, cartons: 1, volume: 0, weight: 300,
})));

const DAYS = WEEK.dates.map((date, i) => ({ date, source: i < 4 ? 'sealed' : i === 4 ? 'board' : 'future', orders: i < 5 ? 800 : 0 }));
const drivers = driversOfWeek(rows);
const key = drivers.find((d) => d.label === DRIVER)?.key;
const first = driverWeek(rows, key, { classes: { [WEEK.dates[0]]: { [LOADS[0].name]: 'tractor' }, [WEEK.dates[1]]: { 'ROBERT 1': 'box' } } });
// Miles: measured for three loads, a Google failure on one, the fourth never asked (the cap).
const miles = {};
first.loads.forEach((l, i) => {
  miles[l.key] = i === 3 ? { meters: null, reason: 'Google was busy and did not measure it — open the week again' }
    : i === 4 ? { meters: null, reason: 'not measured on this request — open the week again to measure it' }
      : { meters: 90000 + i * 23111, source: i === 0 ? 'cache' : 'google' };
});
const week = driverWeek(rows, key, { classes: { [WEEK.dates[0]]: { [LOADS[0].name]: 'tractor' }, [WEEK.dates[1]]: { 'ROBERT 1': 'box' } }, miles });

const base = { ok: true, nuvizzCalls: 0, week: WEEK, today: WEEK.dates[4], days: DAYS, complete: true };

export const DRIVER_WEEK = {
  ...base, googleCalls: 3, mode: 'driver-week',
  driver: week.driver, loads: week.loads, totals: week.totals, cancelledOff: 1, drivers,
  yard: YARD,
  miles: { enabled: true, googleKey: true, measured: 3, cached: 1, fetched: 2, failed: 1, skipped: 1, noPath: 0 },
  cost: { recorded: false, text: COST_NOT_RECORDED },
};
export const DRIVER_CHOOSE = { ...base, googleCalls: 0, mode: 'driver-week-choose', typed: null, drivers, candidates: drivers };

/** The stub's answer, picked the way the endpoint picks: a name or a key is a driver's week. */
export function driverWeekAnswer(url) {
  const u = new URL(url, 'https://x');
  return (u.searchParams.get('key') || u.searchParams.get('driver')) ? DRIVER_WEEK : DRIVER_CHOOSE;
}
