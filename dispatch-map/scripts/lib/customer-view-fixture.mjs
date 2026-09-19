// scripts/lib/customer-view-fixture.mjs — ONE customer-view fixture, shared by every layout
// guard, for the same reason stop-lookup-fixture.mjs and layout-measure.mjs are shared: two
// copies of a hundred-line fixture is two guards that slowly stop testing the same thing.
//
// Seeded with the WORST shape rather than a tidy one, per the phone guard's own rule: a
// 44-character business name, two docks, six stops across three days, a driver name that
// wraps, one of every outcome, a multi-order stop, a note with three flags and a contact,
// and the rollup tail. An empty screen cannot overflow, so a thin stub would make the guard
// pass by rendering nothing.

const stop = (over = {}) => ({
  key: `k${over.stopNbr || '1'}`, date: '2026-09-18', source: 'board',
  stopNbr: '007180001', pro: '007180001', proCount: 1,
  status: 'DELIVERED', outcome: 'delivered', isAttempt: false,
  route: 'ATLANTA SOUTHWEST 3', seq: 5, driver: 'ANDERSON FRIMPONG', planned: true,
  deliveredAt: '2026-09-18T10:21', arrivedAt: '2026-09-18T10:02', etaAt: null,
  windowFrom: null, windowTo: null,
  address: { addr1: '4200 WENDELL DR SW BUILDING C', addr2: 'DOCK 4 REAR', city: 'ATLANTA', state: 'GA', zip: '30336' },
  name: 'EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST',
  pieces: 6, pallets: 2, weight: 1240, pod: 2,
  refs: { po: '99120-REV-C', custRef: 'CR-7741', bol: 'BOL-3319', orderNbr: 'L-551202' },
  ...over,
});

const counts = (rows) => ({
  stops: rows.length,
  orders: rows.reduce((n, r) => n + (r.proCount || 1), 0),
  delivered: rows.filter((r) => r.outcome === 'delivered').length,
  attempted: rows.filter((r) => r.outcome === 'attempted').length,
  exceptions: rows.filter((r) => r.outcome === 'exception' || r.outcome === 'cancelled').length,
  open: rows.filter((r) => r.outcome === 'open').length,
  unfinished: rows.filter((r) => r.outcome === 'unfinished' || r.outcome === 'rolled').length,
  pieces: rows.reduce((n, r) => n + (r.pieces || 0), 0),
  weight: rows.reduce((n, r) => n + (r.weight || 0), 0),
});

const todayRows = [
  stop({ stopNbr: '007180001', pro: '007180001' }),
  stop({
    stopNbr: '007180002', pro: '007180002', key: 'k2', seq: 9, driver: 'ROBERT MENSAH-ADDAI',
    deliveredAt: '2026-09-18T13:44', arrivedAt: '2026-09-18T13:29', proCount: 3, pieces: 14, weight: 3180,
    address: { addr1: '1100 NORTHSIDE DRIVE NW SUITE 210', addr2: null, city: 'ATLANTA', state: 'GA', zip: '30318' },
  }),
  stop({
    stopNbr: '007180003', pro: '007180003', key: 'k3', seq: 12, driver: 'ROBERT MENSAH-ADDAI',
    status: 'OUT_FOR_DEL', outcome: 'open', deliveredAt: null, arrivedAt: null, etaAt: '2026-09-18T16:10', pod: 0,
  }),
];
const yesterdayRows = [
  stop({
    stopNbr: '007179001', pro: '007179001', key: 'k4', date: '2026-09-17', source: 'sealed', alsoOnBoard: true,
    status: 'SCHEDULED', outcome: 'attempted', deliveredAt: null, arrivedAt: '2026-09-17T16:41', pod: 0,
    driver: 'SIRDEDRICK SHEATS', seq: 3,
  }),
  stop({
    stopNbr: '007179002', pro: '007179002', key: 'k5', date: '2026-09-17', source: 'sealed',
    status: 'EXCEPTION', outcome: 'exception', deliveredAt: null, arrivedAt: '2026-09-17T17:55', pod: 0,
    driver: 'ENOCK AKYEA', seq: 7, route: 'NOR 2',
  }),
];
const olderRows = [
  stop({ stopNbr: '007177001', pro: '007177001', key: 'k6', date: '2026-09-15', source: 'sealed', driver: 'FRANK OKINE', deliveredAt: '2026-09-15T09:12', arrivedAt: '2026-09-15T09:01' }),
];
const all = [...todayRows, ...yesterdayRows, ...olderRows];

const tally = (rows) => {
  const by = new Map();
  for (const r of rows) {
    if (!r.driver) continue;
    const c = by.get(r.driver) || { driver: r.driver, stops: 0, delivered: 0 };
    c.stops += 1; if (r.outcome === 'delivered') c.delivered += 1;
    by.set(r.driver, c);
  }
  return [...by.values()].sort((a, b) => b.delivered - a.delivered || b.stops - a.stops);
};

export const CUSTOMER_VIEW = {
  ok: true, nuvizzCalls: 0, mode: 'customer', query: 'earthly alternative', today: '2026-09-18',
  window: { from: '2026-09-12', to: '2026-09-18', days: 7, kind: 'days', clamped: null },
  errors: {},
  view: {
    query: 'earthly alternative',
    name: 'EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST',
    nameKey: 'earthly_alternative_distribution_southeast',
    window: { from: '2026-09-12', to: '2026-09-18', days: 7 },
    today: '2026-09-18', complete: true, hasToday: true,
    totals: counts(all), todayCounts: counts(todayRows),
    drivers: tally(all),
    days: [
      { date: '2026-09-18', isToday: true, rows: todayRows, counts: counts(todayRows), drivers: tally(todayRows) },
      { date: '2026-09-17', isToday: false, rows: yesterdayRows, counts: counts(yesterdayRows), drivers: tally(yesterdayRows) },
      { date: '2026-09-15', isToday: false, rows: olderRows, counts: counts(olderRows), drivers: tally(olderRows) },
    ],
    locations: [
      { key: 'a', name: 'EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST', address: { addr1: '4200 WENDELL DR SW BUILDING C', addr2: 'DOCK 4 REAR', city: 'ATLANTA', state: 'GA', zip: '30336' }, stops: 5, delivered: 2, lastDate: '2026-09-18' },
      { key: 'b', name: 'EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST', address: { addr1: '1100 NORTHSIDE DRIVE NW SUITE 210', addr2: null, city: 'ATLANTA', state: 'GA', zip: '30318' }, stops: 1, delivered: 1, lastDate: '2026-09-18' },
    ],
    rows: all,
    recent: [
      { pro: '007100077', date: '2026-08-14', driver: 'FRANK OKINE', location: '4200 WENDELL DR SW BUILDING C' },
      { pro: '007100066', date: '2026-08-02', driver: 'ANDERSON FRIMPONG', location: '4200 WENDELL DR SW BUILDING C' },
      { pro: '007100055', date: '2026-07-19', driver: null, location: '1100 NORTHSIDE DRIVE NW SUITE 210' },
    ],
    notes: {
      text: 'Inside delivery to DOCK 4 at the REAR of building C — the front lobby will refuse it. Receiving closes at 2pm sharp, no exceptions, and they will not take a tractor into the yard.',
      hours: { mon: { open: '07:00', close: '14:00' }, tue: { open: '07:00', close: '14:00' }, wed: { open: '07:00', close: '14:00' }, thu: { open: '07:00', close: '14:00' }, fri: { open: '07:00', close: '12:00' } }, customerNbr: 'EARTH-4471', updatedAt: '2026-09-16T15:20:00Z', updatedBy: 'dispatch', override: null,
      flags: [
        { key: 'no_tractor', label: 'No tractor — box truck only', tone: 'amber' },
        { key: 'notify_cs', label: 'Notify customer service', tone: 'amber' },
        { key: 'override', label: 'Address overridden here', tone: 'blue' },
      ],
      contacts: [{ name: 'RAY WHITTINGTON-BOYD', phone: '7705551212', email: 'receiving@earthlyalternative.example.com' }],
    },
    matches: [],
    sources: [
      { key: 'board', label: "Today's board", where: 'nuvizz_stop_index/…/stops', note: '7 days swept, 2026-09-12 → 2026-09-18', looked: true, count: 4, found: true, state: 'found' },
      { key: 'sealed', label: 'Sealed history', where: 'history_days/…/stops', note: 'the same days, from the immutable nightly capture', looked: true, count: 3, found: true, state: 'found' },
      { key: 'customer', label: 'Customer rollup', where: 'history_customers', note: 'deliveries older than the window, with their drivers', looked: true, count: 3, found: true, state: 'found' },
      { key: 'notes', label: 'Dispatcher notes', where: 'customer_notes', note: 'joined on 2 derived customer keys', looked: true, count: 1, found: true, state: 'found' },
    ],
  },
  note: 'Firestore only — nothing here spent a NuVizz call.',
};

/** The ORDER DRAWER's response. Seeded with the widest real shape: two PROs on one stop, two
 *  line items (one oversize), six reference numbers, two POD documents, a multi-line
 *  instruction, two comments and two contacts — the drawer's longest possible column. */
export const ORDER_DETAIL = {
  ok: true, nuvizzCalls: 0, mode: 'detail', date: '2026-09-18', stopNbr: '007180002',
  source: 'sealed', complete: true, errors: {},
  matchKey: 'earthly|1100|atlanta',
  stop: {
    date: '2026-09-18', source: 'sealed', stopNbr: '007180002', pro: '007180002',
    pros: ['007180002', '007180003', '007180004'],
    name: 'EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST',
    address: { addr1: '1100 NORTHSIDE DRIVE NW SUITE 210', addr2: 'DOCK 4 REAR', city: 'ATLANTA', state: 'GA', zip: '30318' },
    status: 'DELIVERED', outcome: 'delivered', rawStatus: '90',
    timeline: [
      { key: 'scheduled', label: 'Delivery window', at: null, text: '08:00 – 14:00' },
      { key: 'eta', label: 'Planned ETA', at: '2026-09-18T12:40' },
      { key: 'arrived', label: 'Driver arrived', at: '2026-09-18T13:29' },
      { key: 'delivered', label: 'Delivered', at: '2026-09-18T13:44' },
    ],
    deliveredAt: '2026-09-18T13:44', arrivedAt: '2026-09-18T13:29',
    driver: 'ROBERT MENSAH-ADDAI', driverUserName: 'ROBERT', route: 'ATLANTA SOUTHWEST 3',
    loadNbr: 'DAVIS000203801', seq: 9, planned: true,
    pieces: 14, pallets: 2, weight: 3180, itemsSummary: '14 cartons · 2 pallets of LED panels and drivers',
    lines: [
      { product: 'LED PANEL 2X4 5000K DIMMABLE', sku: 'LP-24-50-DIM', qty: 8, weight: 2100, length: 96, oversize: true },
      { product: 'DRIVER BOX 100W', sku: 'DB-100', qty: 6, weight: 1080, length: null, oversize: false },
    ],
    refs: [
      { label: 'PO', value: '99120-REV-C' }, { label: 'BOL', value: 'BOL-3319' },
      { label: 'Customer ref', value: 'CR-7741' }, { label: 'Order', value: 'L-551202' },
      { label: 'Warehouse', value: 'G6' }, { label: 'Terms', value: 'PREPAID' },
    ],
    pod: [
      { name: 'signature-007180002.jpg', ext: 'jpg', at: '2026-09-18T17:44:00Z' },
      { name: 'freight-on-dock.jpg', ext: 'jpg', at: '2026-09-18T17:45:00Z' },
    ],
    instructions: 'Inside delivery to DOCK 4 at the REAR of building C — the front lobby will refuse it. Receiving closes at 2pm sharp and they will not take a tractor into the yard.',
    comments: [
      { text: 'Customer called asking for an ETA — told them early afternoon and gave the driver name.', by: 'CS', at: '2026-09-18T15:02:00Z', kind: 'CS' },
      { text: 'Gate code is 4412, the guard shack will not have it on file.', by: 'DISPATCH', at: '2026-09-18T12:10:00Z', kind: 'DISPATCH' },
    ],
    contact: { name: 'RAY WHITTINGTON-BOYD', phone: '7705551212', email: 'receiving@earthlyalternative.example.com' },
    matchKey: 'earthly|1100|atlanta', capturedAt: '2026-09-19T04:10:00Z',
  },
  note: {
    text: 'Inside delivery to DOCK 4 at the REAR of building C — the front lobby will refuse it.',
    hours: { mon: { open: '07:00', close: '14:00' }, fri: { open: '07:00', close: '12:00' } },
    customerNbr: 'EARTH-4471', updatedAt: '2026-09-16T15:20:00Z', updatedBy: 'dispatch', override: null,
    flags: [{ key: 'no_tractor', label: 'No tractor — box truck only', tone: 'amber' }],
    contacts: [{ name: 'RAY WHITTINGTON-BOYD', phone: '7705551212', email: 'receiving@earthlyalternative.example.com' }],
  },
};
