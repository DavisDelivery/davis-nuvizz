// activity-pickups.test.mjs — A5-S30-7.
//
// A pickup is collected on the route; nothing about it loads at the dock. The
// phone knows that (loadProgress drops pickups from what has to go on the
// truck), but the dispatcher's Activity view took the load's expected pieces
// from groupIntoLoads, which sums EVERY stop. So a truck the loader closed with
// every delivery aboard read "closed short" by exactly the pickup's pieces, and
// the office went looking for freight that was never meant to be on it.

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildActivity } = await import('../netlify/functions/lib/activity.mts');
const { toManifestStop, groupIntoLoads } = await import('../netlify/functions/lib/manifest.mts');
const { loadProgress } = await import('../src/lib/scan-logic.js');

const DAY = '2026-08-07';

// The board exactly as scan-activity builds it: index rows -> manifest stops -> loads.
const boardRows = [
  { stopNbr: '007157687', loadNbr: 'STEVEN', routeSeq: 1, pallets: 2, cartons: 1, volume: 1, businessName: 'ACME' },
  { stopNbr: 'RA5732712', loadNbr: 'STEVEN', routeSeq: 2, pallets: 3, cartons: 3, volume: 0, businessName: 'RETURN CO', type: 'PU' },
];
const loads = groupIntoLoads(boardRows.map((r) => toManifestStop(r))).map((l) => ({
  loadNbr: l.loadNbr,
  routeName: l.routeName,
  expectedPieces: l.expectedPieces,
  stopCount: l.stopCount,
  stops: l.stops.map((s) => ({ stopNbr: s.stopNbr, businessName: s.businessName, expectedPieces: s.expectedPieces, isPickup: s.isPickup })),
}));

const closedSession = {
  loadNbr: 'STEVEN',
  date: DAY,
  closedAt: '2026-08-07T09:30:00.000Z',
  scannedCount: 2,
  scannedPieces: 2,
  scans: [
    { og: 'OG0000000001', pro: '7157687', stopNbr: '007157687', scannedAt: '2026-08-07T09:00:00.000Z' },
    { og: 'OG0000000002', pro: '7157687', stopNbr: '007157687', scannedAt: '2026-08-07T09:01:00.000Z' },
  ],
};

test('a truck closed with every delivery aboard reads closed clean, not short by the pickup', () => {
  const out = buildActivity({ date: DAY, loads, sessions: [closedSession], creds: [] });
  const row = out.loads[0];
  assert.equal(row.expectedPieces, 2, 'the pickup\'s 3 pieces are not dock freight');
  assert.equal(row.short, 0);
  assert.equal(row.status, 'closed_clean');
  assert.equal(out.totals.closedShort, 0);
  assert.equal(out.totals.closedClean, 1);
  assert.equal(out.totals.piecesExpected, 2);
});

test('the Activity view and the loader\'s phone agree on what the truck needs', () => {
  const phoneStops = boardRows.map((r) => toManifestStop(r));
  const phone = loadProgress(phoneStops, closedSession.scans, []);
  const out = buildActivity({ date: DAY, loads, sessions: [closedSession], creds: [] });
  assert.equal(out.loads[0].expectedPieces, phone.expected, 'one number for one truck');
});

test('a truck genuinely short of a delivery piece still reads closed short', () => {
  const short = { ...closedSession, scannedCount: 1, scannedPieces: 1, scans: closedSession.scans.slice(0, 1) };
  const row = buildActivity({ date: DAY, loads, sessions: [short], creds: [] }).loads[0];
  assert.equal(row.status, 'closed_short');
  assert.equal(row.short, 1);
});

test('a board row with no stop list attached keeps the load total it was given', () => {
  const bare = [{ loadNbr: 'MANDI', routeName: 'MANDI', expectedPieces: 4, stopCount: 2 }];
  const s = { loadNbr: 'MANDI', date: DAY, closedAt: '2026-08-07T09:30:00.000Z', scannedCount: 4 };
  const row = buildActivity({ date: DAY, loads: bare, sessions: [s], creds: [] }).loads[0];
  assert.equal(row.expectedPieces, 4);
  assert.equal(row.status, 'closed_clean');
});
