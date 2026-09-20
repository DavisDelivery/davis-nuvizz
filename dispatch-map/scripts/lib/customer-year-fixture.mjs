// scripts/lib/customer-year-fixture.mjs — the "All of <year>" state of Stop lookup, shared by
// every layout guard, for the same reason the other two fixtures are: two copies of a fixture
// is two guards that slowly stop testing the same thing.
//
// Seeded with the state that is hardest to lay out AND easiest to get wrong: a PARTIAL year,
// so January renders as a dashed "not counted yet" row beside eight counted ones, four stat
// tiles, a wrapping driver row of four long names, a nine-row bar chart whose right-hand
// figures must not collide with the bars, and two location cards.
const mon = (m, stops, delivered, attempted = 0, exceptions = 0, uncounted = false) =>
  ({ month: `2026-${m}`, label: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep'][Number(m) - 1], stops, delivered, attempted, exceptions, uncounted });
export const CUSTOMER_YEAR = {
  ok: true, nuvizzCalls: 0, mode: 'customer-year', query: 'earthly alternative', today: '2026-09-18', year: '2026',
  name: 'EARTHLY ALTERNATIVE', nameKey: 'earthly_alternative', errors: {},
  view: {
    year: '2026', counted: true, monthsFrom: '2026-02-09', countedThrough: '2026-09-18', wholeYear: false, uncountedMonths: 1, uncountedAfter: 0,
    months: [
      mon('01', 0, 0, 0, 0, true),
      mon('02', 9, 9), mon('03', 14, 13, 1), mon('04', 11, 10, 0, 1), mon('05', 17, 16, 1),
      mon('06', 12, 12), mon('07', 8, 7, 1), mon('08', 18, 17, 1), mon('09', 11, 10, 0, 1),
    ],
    totals: { stops: 100, delivered: 94, attempted: 4, exceptions: 2 },
    busiest: mon('08', 18, 17, 1),
    drivers: [
      { driver: 'ANDERSON FRIMPONG', stops: 41, delivered: 40 },
      { driver: 'ROBERT MENSAH-ADDAI', stops: 33, delivered: 30 },
      { driver: 'FRANK OKINE', stops: 19, delivered: 19 },
      { driver: 'SIRDEDRICK SHEATS', stops: 7, delivered: 5 },
    ],
    orders: [
      { pro: '007180002', date: '2026-09-18', driver: 'ROBERT MENSAH-ADDAI', location: '4200 WENDELL DR SW BUILDING C' },
      { pro: '007179001', date: '2026-09-17', driver: 'SIRDEDRICK SHEATS', location: '4200 WENDELL DR SW BUILDING C' },
      { pro: '007177001', date: '2026-09-15', driver: 'FRANK OKINE', location: '1100 NORTHSIDE DRIVE NW SUITE 210' },
      { pro: '007170412', date: '2026-08-28', driver: 'ANDERSON FRIMPONG', location: '4200 WENDELL DR SW BUILDING C' },
    ],
    locations: [
      { matchKey: 'a', address: { addr1: '4200 WENDELL DR SW', addr2: 'DOCK 4', city: 'ATLANTA', state: 'GA', zip: '30336' }, lastDate: '2026-09-18', stops: 82 },
      { matchKey: 'b', address: { addr1: '1100 NORTHSIDE DR NW', addr2: null, city: 'ATLANTA', state: 'GA', zip: '30318' }, lastDate: '2026-09-18', stops: 18 },
    ],
  },
  sources: [
    { key: 'customer', label: 'Customer rollup', where: 'history_customers', note: '2 location documents — the year is counted nightly, not swept', looked: true, count: 2, found: true, state: 'found' },
    { key: 'board', label: "Today's board", where: 'nuvizz_stop_index/…/stops', note: 'not read for a year — that is ~510,000 documents; pick Today / 7 / 14 days for stop-by-stop detail', looked: 'skipped', count: 0, found: false, state: 'skipped' },
    { key: 'sealed', label: 'Sealed history', where: 'history_days/…/stops', note: 'not read for a year, for the same reason', looked: 'skipped', count: 0, found: false, state: 'skipped' },
  ],
};
