// test/driver-loads-cancelled-switch.test.mjs — BOARD_DROP_CANCELLED reaches the driver lookup.
//
// Audit 2026-09-27 (client-routing-board-libs-3): driver-loads called dropCancelledEnabled() with
// no env, and that function reads only the object it is handed (default {}), so the switch was
// permanently ON for the load lookup. BOARD_DROP_CANCELLED=off put a wrongly-cancelled order back
// on the Map board while the driver's week still stripped it — two screens disagreeing about the
// same order, after the one switch that is supposed to put it back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const T = 'davis';
const DAY = '2026-09-14';
const call = async (qs) => {
  const handler = (await import('../netlify/functions/driver-loads.mts')).default;
  const r = await handler(new Request(`https://x.netlify.app/.netlify/functions/driver-loads?${qs}`));
  return { status: r.status, body: await r.json() };
};
const st = (stopNbr, extra = {}) => ({
  stopNbr, stopType: 'DO', businessName: `CONSIGNEE ${stopNbr}`, city: 'CUMMING', zip: '30040',
  lat: 34.2, lng: -84.1, routeName: 'COLIN 1', loadNbr: 'COLIN 1', driverName: 'COLIN', driverUserName: 'COLIN',
  normalizedStatus: 'DELIVERED', deliveredDTTM: `${DAY}T09:00:00`, routeSeq: 1, cartons: 1, volume: 0, weight: 100,
  orderInstructions: 'TOTAL-AMOUNT : 50.00', capture_version: 1, ...extra,
});
const SEED = {
  [`history_days/${T}__${DAY}`]: { tenant: T, date: DAY, complete: true, verified: true },
  [`history_days/${T}__${DAY}/stops/s0`]: st('007170001'),
  // NuVizz's own cancellation record — the signal the board drops on.
  [`history_days/${T}__${DAY}/stops/s1`]: st('007170002', {
    raw: { stopExecutionInfo: { cancellation: { cancelDTTM: `${DAY}T07:00:00`, reasonCode: 'CANCELLED' } } },
  }),
};
const withEnv = async (v, fn) => {
  const was = process.env.BOARD_DROP_CANCELLED;
  const lm = process.env.LOAD_MILES;
  process.env.LOAD_MILES = 'off';   // no Google in this test; the switch under test is the other one
  if (v == null) delete process.env.BOARD_DROP_CANCELLED; else process.env.BOARD_DROP_CANCELLED = v;
  try { return await fn(); } finally {
    if (was == null) delete process.env.BOARD_DROP_CANCELLED; else process.env.BOARD_DROP_CANCELLED = was;
    if (lm == null) delete process.env.LOAD_MILES; else process.env.LOAD_MILES = lm;
  }
};
const ordersOnWeek = (body) => body.totals.orders;

test('BOARD_DROP_CANCELLED=off puts a cancelled order back in the driver\'s week, the same as on the board', async () => {
  const fake = installFirestoreFake(SEED);
  try {
    // Default ON: the cancelled order is off the driver's week and counted as such.
    const on = await withEnv(null, () => call(`from=${DAY}&to=${DAY}&key=COLIN`));
    assert.equal(on.status, 200);
    assert.equal(on.body.mode, 'driver-week');
    assert.equal(on.body.cancelledOff, 1, 'with the switch on, NuVizz\'s cancellation takes the order off');
    assert.equal(ordersOnWeek(on.body), 1);

    // OFF: the same order is back, exactly as BOARD_DROP_CANCELLED=off puts it back on the board.
    const off = await withEnv('off', () => call(`from=${DAY}&to=${DAY}&key=COLIN`));
    assert.equal(off.status, 200);
    assert.equal(off.body.cancelledOff, 0, 'BOARD_DROP_CANCELLED=off must reach the driver lookup');
    assert.equal(ordersOnWeek(off.body), 2, 'the cancelled order is counted in the driver\'s week again');
    assert.equal(fake.log.other.length, 0, 'nothing but Firestore was called');
  } finally { fake.restore(); }
});
