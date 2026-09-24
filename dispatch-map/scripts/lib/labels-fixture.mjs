// scripts/lib/labels-fixture.mjs — the Print labels screen's answers, for the layout guards.
//
// BUILT, NOT TYPED: every row is produced by the real shipperSummary / shipperLabelRows over
// synthetic board stops, so the guards measure exactly what the endpoint returns and cannot drift
// from it when a row grows a field. And built for the WORST layout: a 44-character consignee, a
// street line with a suite that wraps twice at 360px, an order with no count, an address a
// dispatcher fixed, a delivered and an exception row, a long route and driver, a reference — and
// a Uline day big enough that Print all has to ask before it builds.

import { shipperSummary, shipperLabelRows, stopMatchKey } from '../../src/lib/label-shippers.js';

const DATE = '2026-08-17';
const NAMES = ['EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST', 'TITAN ELECTRIC COMPANIES QTS DATA CENTER', 'LED ENERGY PLUS', 'JOHN SMITH'];
const STREETS = ['1100 NORTHSIDE DRIVE NW SUITE 210 BUILDING C', '4200 WENDELL DR SW', '55 PEACHTREE INDUSTRIAL BLVD NORTHWEST UNIT 4', '12 OAK ST'];
const stop = (stopNbr, i, extra = {}) => ({
  stopNbr, pro: stopNbr, stopType: 'DO',
  businessName: NAMES[i % NAMES.length], addr1: STREETS[i % STREETS.length], addr2: i % 5 === 0 ? 'DOCK 4 REAR — RING BELL' : null,
  city: i % 3 === 0 ? 'PEACHTREE CORNERS' : 'ATLANTA', state: 'GA', zip: '30318',
  cartons: 1 + (i % 3), volume: i % 2, weight: 480 + i * 37, scheduledFrom: `${DATE}T12:00:00`,
  normalizedStatus: i % 7 === 3 ? 'DELIVERED' : i % 7 === 5 ? 'EXCEPTION' : 'SCHEDULED',
  routeName: i % 4 === 0 ? null : 'ATLANTA SOUTHWEST 3 — LATE SHIFT', driverName: i % 4 === 0 ? null : 'ROBERT MENSAH-ADDAI',
  ...extra,
});

const board = [
  ...Array.from({ length: 12 }, (_, i) => stop(`ESTES-05382438${String(i).padStart(2, '0')}`, i, i === 2 ? { cartons: null, volume: null } : {})),
  ...Array.from({ length: 4 }, (_, i) => stop(`AVRT-01704166${String(i).padStart(2, '0')}`, i)),
  stop('SHP29379', 1), stop('SHP29380', 2),
  stop('MILLER123', 3),
  ...Array.from({ length: 130 }, (_, i) => stop(String(7163000 + i).padStart(9, '0'), i, { cartons: 2, volume: 0 })),
  stop('RA5732712', 0, { stopType: 'PU' }),
];

// One dispatcher address fix, and one saved label with a reference — both kinds of chip render.
const fixed = board[1];
const notes = new Map([[stopMatchKey(fixed), { address_override: { addr1: '4200 WENDELL DR SW BUILDING C DOCK 4', city: 'ATLANTA', state: 'GA', zip: '30336' } }]]);
const saved = new Map([[board[0].stopNbr, { stopNbr: board[0].stopNbr, ref: 'EST-PO-99120-REV-C', dispatchNotes: 'Call ahead', source: 'manifest' }]]);

const summary = shipperSummary(board);
const base = { ok: true, nuvizzCalls: 0, date: DATE, boardAt: `${DATE}T13:05:00Z`, cancelledOff: 0, ...summary };
const forShipper = (key, name) => {
  const rows = shipperLabelRows(board, key, { saved, notes });
  return { ...base, shipper: { key, name }, rows, pages: rows.reduce((n, r) => n + r.pages, 0), reads: { orders: rows.length, savedFound: 1, notesRead: 1 }, errors: {} };
};

export const LABELS_DAY = base;
export const LABELS_BY_SHIPPER = {
  ESTES: forShipper('ESTES', 'Estes'),
  AVRT: forShipper('AVRT', 'Averitt'),
  SHP: forShipper('SHP', 'SHP'),
  MILLER: forShipper('MILLER', 'MILLER'),
  ULINE: forShipper('ULINE', 'Uline'),
};

/** The stub every guard installs: the day's shippers, or one shipper's orders. */
export function labelsAnswer(url) {
  const m = /[?&]shipper=([^&]+)/.exec(String(url));
  if (!m) return LABELS_DAY;
  const key = decodeURIComponent(m[1]).toUpperCase();
  return LABELS_BY_SHIPPER[key] || { ...base, shipper: { key, name: key }, rows: [], pages: 0, reads: { orders: 0, savedFound: 0, notesRead: 0 }, errors: {} };
}
