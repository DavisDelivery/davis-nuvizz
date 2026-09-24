// scripts/lib/place-search-fixture.mjs — the ADDRESS / CITY answer the layout guards drive.
//
// BUILT, NOT TYPED. Every other stop-lookup fixture is a hand-written object, which is fine for a
// shape that rarely moves; this one is produced by running the REAL buildPlaceView over synthetic
// stops, so the guards measure exactly what the endpoint returns and cannot drift from it when the
// view grows a field.
//
// And built for the WORST layout, per the phone guard's own rule: a 44-character business name,
// a street line that wraps twice at 360px, four months of bars, the full address list, a drivers
// row that wraps, a second city, the postal-city banner, and the amber "days not searched" note —
// every one of which exists only after a search runs.

import { placeQuery, buildPlaceView } from '../../src/lib/stop-search.js';

const TODAY = '2026-09-18';
const DRIVERS = ['ANDERSON FRIMPONG', 'ROBERT MENSAH-ADDAI', 'SIRDEDRICK SHEATS', 'ENOCK AKYEA', 'OLAMIDE KAZEEM'];
const DOCKS = [
  { name: 'EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST', addr1: '1100 NORTHSIDE DRIVE NW SUITE 210', addr2: 'DOCK 4 REAR — RING BELL', zip: '30318' },
  { name: 'TITAN ELECTRIC COMPANIES QTS DATA CENTER', addr1: '1100 NORTHSIDE DR NW', addr2: null, zip: '30318' },
  { name: 'LED ENERGY PLUS', addr1: '1100 NORTHSIDE DR NW BLDG C', addr2: null, zip: '30318-4411' },
];
const STATUS = ['DELIVERED', 'DELIVERED', 'DELIVERED', 'EXCEPTION', 'DELIVERED', 'SCHEDULED'];

const days = [];
let n = 0;
for (const [date, count] of [['2026-09-18', 3], ['2026-09-16', 2], ['2026-09-15', 2], ['2026-08-27', 2], ['2026-08-04', 1], ['2026-07-22', 2], ['2026-06-11', 1]]) {
  const stops = [];
  for (let i = 0; i < count; i++) {
    const d = DOCKS[(n + i) % DOCKS.length];
    const status = STATUS[(n + i) % STATUS.length];
    stops.push({
      stopNbr: String(7180001 + n).padStart(9, '0'), pro: String(7180001 + n).padStart(9, '0'),
      businessName: d.name, addr1: d.addr1, addr2: d.addr2, city: 'ATLANTA', state: 'GA', zip: d.zip,
      normalizedStatus: status === 'SCHEDULED' && date < TODAY ? 'DELIVERED' : status,
      isAttempt: (n + i) % 7 === 3, routeName: 'ATLANTA SOUTHWEST 3', loadStopSeq: 3 + i * 4,
      driverName: DRIVERS[(n + i) % DRIVERS.length], isPlanned: true,
      deliveredDTTM: status === 'DELIVERED' ? `${date}T1${(i % 5) + 0}:2${i}` : null,
      cartons: 6, pallets: 2, weight: 1240, poRef: 'PO-99120-REV-C', proCount: i === 1 ? 3 : 1,
    });
    n += 1;
  }
  // One stop at the same address filed under a different town — the postal-city banner.
  if (date === '2026-08-27') stops.push({ stopNbr: '007179990', pro: '007179990', businessName: DOCKS[1].name, addr1: '1100 NORTHSIDE DR NW', city: 'SANDY SPRINGS', state: 'GA', zip: '30318', normalizedStatus: 'DELIVERED', driverName: DRIVERS[0] });
  days.push({ date, source: date === TODAY ? 'board' : 'sealed', stops });
}

const query = placeQuery({ addr: '1100 Northside Dr', city: 'Atlanta' });
const range = { kind: 'all', from: null, to: '2026-09-21', clamped: null };
const view = buildPlaceView({ query, range, today: TODAY, days });

export const PLACE_VIEW = {
  ok: true, nuvizzCalls: 0, mode: 'place', today: TODAY, query, range, view,
  coverage: {
    searchedDays: 108, from: '2026-06-04', to: '2026-09-21', digestDays: 104,
    boardDays: ['2026-09-21', '2026-09-20', '2026-09-19', '2026-09-18'], heldDays: 106,
    // The amber "not searched" note, at its longest.
    missing: ['2026-08-03', '2026-09-10'], missingCount: 2, unreadable: 0, complete: false,
  },
  sources: [
    { key: 'search', label: 'Search index', where: 'history_search', note: 'one document per sealed day — 104 read', looked: true, count: 55210, found: true, state: 'found' },
    { key: 'board', label: "Today's board", where: 'nuvizz_stop_index/…/stops', note: '4 days the index cannot hold yet', looked: true, count: 2140, found: true, state: 'found' },
    { key: 'sealed', label: 'Days we hold', where: 'history_days', note: '2 held days not searched yet — no index built: 2026-08-03, 2026-09-10', looked: true, count: 106, found: true, state: 'partial' },
  ],
  errors: {},
  note: 'Firestore only — nothing here spent a NuVizz call.',
};
