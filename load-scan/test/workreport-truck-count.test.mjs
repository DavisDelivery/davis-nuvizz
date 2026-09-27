// workreport-truck-count.test.mjs — review of A6-S31-5.
//
// The shift report now judges a truck by its scan-session record's own count.
// Two things must not distort that verdict:
//
//   1. The PREVIOUS shift's truck. loadNbr is the route name — STEVEN every day
//      he works — and the report reads records filed under the shift day AND the
//      day before. Since #815 (2026-09-03) the phone files a truck under its
//      shift day, so the record under the day before is yesterday's truck; one
//      late push to it after 8pm put it in this shift's window, and its 9 pieces
//      were added to tonight's 6 of 10. A short truck read complete.
//   2. A pickup. It is collected on the route and never loads at the dock (the
//      phone says so on screen: "They are not counted in the piece total"). The
//      report took the load's expected pieces from groupIntoLoads, which sums
//      every stop, so a truck closed with every delivery aboard read short by the
//      pickup — the same defect A5-S30-7 fixed in the Activity view.
//
// Driven end to end against the in-memory Firestore.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeFirestore } from './helpers/fake-firestore.mjs';

process.env.LOADSCAN_JWT_SECRET = 'test-secret-that-is-long-enough-to-pass-32';
const fake = installFakeFirestore();

const fs = await import('../netlify/functions/lib/firestore.mts');
const auth = await import('../netlify/functions/lib/auth.mts');
const workReport = await import('../netlify/functions/work-report.mts');

const DAY = '2026-08-07';
const PREV = '2026-08-06';
const TOKEN = auth.issueToken('1', 'Dispatcher', 'dispatcher');
const STOPS = `nuvizz_stop_index/davis__${DAY}/stops`;

const seed = async () => {
  fake.docs.clear();
  await fs.setDoc('driver_auth/1', { driverNumber: '1', displayName: 'Dispatcher', role: 'dispatcher', active: true, pinHash: '' });
};

const getReport = async () => {
  const res = await workReport.default(
    new Request(`http://localhost/.netlify/functions/work-report?shiftDay=${DAY}&days=1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  assert.equal(res.status, 200);
  return (await res.json()).reports[0];
};

// Tonight's STEVEN: 6 of 10 aboard, closed out — 01:30Z is 9:30pm ET on the 6th, inside shift Aug 7.
const tonight = (scannedCount, expectedPieces = 10) => ({
  tenant: 'davis', date: DAY, loadNbr: 'STEVEN', closedAt: '2026-08-07T01:30:00.000Z', expectedPieces, scannedCount,
  workedBy: [{ driverNumber: '4471', role: 'loader', pieces: scannedCount, firstAt: '2026-08-07T01:00:00.000Z', lastAt: '2026-08-07T01:30:00.000Z' }],
});

test('yesterday\'s truck on the same route cannot fill tonight\'s short truck', async () => {
  await seed();
  await fs.setDoc(`${STOPS}/007157687`, { stopNbr: '007157687', loadNbr: 'STEVEN', routeName: 'STEVEN', pallets: 10, cartons: 10, volume: 0 });
  await fs.setDoc(`nuvizz_load_scans/davis__${DAY}__STEVEN`, tonight(6));
  // Yesterday's STEVEN, filed under the 6th, loaded that morning; its driver's
  // phone pushed once more at 8:30pm ET — inside tonight's window.
  await fs.setDoc(`nuvizz_load_scans/davis__${PREV}__STEVEN`, {
    tenant: 'davis', date: PREV, loadNbr: 'STEVEN', closedAt: '2026-08-06T09:00:00.000Z', expectedPieces: 9, scannedCount: 9,
    workedBy: [{ driverNumber: '4480', role: 'driver', pieces: 9, firstAt: '2026-08-06T05:00:00.000Z', lastAt: '2026-08-07T00:30:00.000Z' }],
  });

  const report = await getReport();
  const loader = report.rows.find((r) => r.worker === '4471');
  assert.equal(loader.status, 'short', 'tonight\'s truck has 6 of 10 aboard');
  assert.equal(loader.short, 4);
  assert.equal(report.totals.loadsComplete, 0);
});

test('a record filed only under the previous date (the old calendar keying) still counts', async () => {
  await seed();
  await fs.setDoc(`${STOPS}/007157687`, { stopNbr: '007157687', loadNbr: 'STEVEN', routeName: 'STEVEN', pallets: 10, cartons: 10, volume: 0 });
  await fs.setDoc(`nuvizz_load_scans/davis__${PREV}__STEVEN`, { ...tonight(10), date: PREV });
  const report = await getReport();
  assert.equal(report.rows[0].status, 'complete');
});

test('a truck closed with every delivery aboard reads complete, not short by its pickup', async () => {
  await seed();
  await fs.setDoc(`${STOPS}/007157687`, { stopNbr: '007157687', loadNbr: 'STEVEN', routeName: 'STEVEN', pallets: 2, cartons: 1, volume: 1 });
  await fs.setDoc(`${STOPS}/RA5732712`, { stopNbr: 'RA5732712', loadNbr: 'STEVEN', routeName: 'STEVEN', pallets: 3, cartons: 3, volume: 0, type: 'PU' });
  await fs.setDoc(`nuvizz_load_scans/davis__${DAY}__STEVEN`, tonight(2, 2));

  const report = await getReport();
  assert.equal(report.rows[0].expectedPieces, 2, 'the pickup\'s 3 pieces are not dock freight');
  assert.equal(report.rows[0].short, 0);
  assert.equal(report.rows[0].status, 'complete');
  assert.equal(report.totals.loadsComplete, 1);
});

test('a truck genuinely short of a delivery piece still reads short with a pickup on it', async () => {
  await seed();
  await fs.setDoc(`${STOPS}/007157687`, { stopNbr: '007157687', loadNbr: 'STEVEN', routeName: 'STEVEN', pallets: 2, cartons: 1, volume: 1 });
  await fs.setDoc(`${STOPS}/RA5732712`, { stopNbr: 'RA5732712', loadNbr: 'STEVEN', routeName: 'STEVEN', pallets: 3, cartons: 3, volume: 0, type: 'PU' });
  await fs.setDoc(`nuvizz_load_scans/davis__${DAY}__STEVEN`, tonight(1, 2));

  const report = await getReport();
  assert.equal(report.rows[0].status, 'short');
  assert.equal(report.rows[0].short, 1);
});
