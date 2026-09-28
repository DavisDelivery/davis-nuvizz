// "CLOSED ON MONDAYS" is read from the ORDER, every time — never stored on the customer.
//
// Chad, 2026-09-28: "the closed on Fridays and closed on Mondays. I want those to be read live every
// time an order comes in. and not stored because we had a situation where a delivery today was
// marked closed on Mondays, but the new orders do not signify that. And therefore we did not deliver
// it because our system stored the closed on Mondays instead of reading it every time the order
// comes in and it's enriched."
//
// SANTA FE TORTILLAS, 4234 JONESBORO RD STE L, FOREST PARK — the texts below are the real order
// instructions, read from our own records (stop-lookup, zero NuVizz calls):
//   007135975  2026-06-19  "… CLOSED ON MONDAYS …"          → the scanner stored closed_days ['mon']
//   007159306  2026-08-10  "RECEIVING HOURS 8-430PM; DO NOT BREAKDOWN SKID"
//   007182580  2026-09-28  "RECEIVING HOURS 7-230PM; DO NOT BREAKDOWN SKID"   ← a Monday, not delivered
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderClosedDays, typedClosedDay, closedDaysFromOrderEnabled } from '../src/lib/closed-days.js';
import { closedDayTier } from '../src/lib/board-flags.js';
import { buildCleanupPlan } from '../netlify/functions/lib/routing-cleanup-core.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

const JUNE = 'SPL-INSTR-TEXT: RECEIVING HOURS 7-230PM\nSPL-INSTR-TEXT: CLOSED ON MONDAYS\nSPL-INSTR-TEXT: DO NOT BREAKDOWN SKID\nSPL-INSTR-TEXT: AM DELIVERY REQ - NO GUARANTEE\nTOTAL-AMOUNT : 132.27';
const TODAY = 'SPL-INSTR-TEXT: RECEIVING HOURS 7-230PM; SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID; TOTAL-AMOUNT : 134.33';
// What the June scan left on the customer: the day, and the scanner's fingerprint for it.
const STORED = {
  closed_days: ['mon'],
  auto_matches: { closed_days: [{ source: 'orderInstructions', text: 'CLOSED ON MONDAYS', pattern: 'closed_mon' }] },
  manual_overrides: { closed_days: true, receiving_hours: true },   // a dispatcher later edited the notes
};
const ON = {};
const OFF = { CLOSED_DAYS_FROM_ORDER: 'off' };

test('SANTA FE TORTILLAS, Monday 2026-09-28: today\'s order says nothing about Mondays, so it is NOT closed', () => {
  assert.equal(closedDayTier(STORED, 'mon', { orderInstructions: TODAY }, ON), null);
  // What the stored rule said — the very verdict that kept it off the trucks.
  assert.equal(closedDayTier(STORED, 'mon', { orderInstructions: TODAY }, OFF), 'auto');
});

test('an order that DOES say "CLOSED ON MONDAYS" is closed on a Monday — read off that order', () => {
  assert.equal(closedDayTier(null, 'mon', { orderInstructions: JUNE }, ON), 'order');
  assert.equal(closedDayTier(null, 'tue', { orderInstructions: JUNE }, ON), null);
  assert.deepEqual(orderClosedDays({ orderInstructions: JUNE }).map((d) => d.day), ['mon']);
});

test('a closed day a DISPATCHER typed still counts — that is a person at Davis, not an old order', () => {
  const typed = { closed_days: ['fri'], manual_overrides: { closed_days: true } };
  assert.equal(typedClosedDay(typed, 'fri'), true);
  assert.equal(closedDayTier(typed, 'fri', { orderInstructions: TODAY }, ON), 'typed');
  // The scanner's fingerprint on a day marks it as the scanner's, whoever edited the field since.
  assert.equal(typedClosedDay(STORED, 'mon'), false);
  // No provenance at all is not a person's word either.
  assert.equal(typedClosedDay({ closed_days: ['fri'] }, 'fri'), false);
});

test('the LIVE list text wins over the enrichment copy; the address line is read too', () => {
  // The list's order text refreshes every scan; signalSources is the one-time enrichment snapshot.
  assert.deepEqual(orderClosedDays({ orderInstructions: TODAY, signalSources: { orderInstructions: JUNE } }), []);
  assert.deepEqual(orderClosedDays({ orderInstructions: '', signalSources: { orderInstructions: JUNE } }).map((d) => d.day), ['mon']);
  assert.deepEqual(orderClosedDays({ addr2: 'CLOSED FRIDAYS' }).map((d) => d.day), ['fri']);
  assert.deepEqual(orderClosedDays(null), []);
});

test('"CLOSED FRI AT 12PM" is an early close, not a closed Friday — the scanner\'s own rule, unchanged', () => {
  assert.deepEqual(orderClosedDays({ orderInstructions: 'SPL-INSTR-TEXT: CLOSED FRI AT 12PM' }), []);
});

test('CLOSED_DAYS_FROM_ORDER / VITE_CLOSED_DAYS_FROM_ORDER: default on, either off-word turns it off, a typo leaves it on', () => {
  assert.equal(closedDaysFromOrderEnabled({}), true);
  for (const k of ['CLOSED_DAYS_FROM_ORDER', 'VITE_CLOSED_DAYS_FROM_ORDER']) {
    for (const off of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(closedDaysFromOrderEnabled({ [k]: off }), false, `${k}=${off}`);
    assert.equal(closedDaysFromOrderEnabled({ [k]: 'of' }), true, `${k}=of`);
  }
});

// ── the route builder: the decision that actually kept the freight at the dock ──
const D = '2026-08-27';   // a Thursday
const MK = 'narrow_dock__b1_main_st__buford__30518';
const inputs = (notes) => ({
  driverDaysBefore: [], referencesBefore: [], serviceDocByKey: new Map(), fleetServiceDoc: null,
  habitDocByKey: new Map(), notesRestrictions: new Map(), tractorCapable: new Set(), employees: [],
  noteByKey: new Map(notes),
});
const row = (nbr, o = {}) => ({
  stopNbr: nbr, isUnplanned: true, isPlanned: false, businessName: o.name || `BIZ ${nbr}`,
  addr1: `${nbr} Main St`, city: 'Buford', zip: '30518', lat: 34.08, lng: -84.05,
  cartons: 3, volume: 0, pallets: 3, weight: 700, timeConstraint: null, ...o.raw,
});
const plan = (rows, notes) => buildCleanupPlan('davis', D, {
  cfg: engineConfigDefaults({}), inputs: inputs(notes), liveStops: rows, meta: null,
  trucks: [{ key: 'T1', name: 'T1', loadNbr: 'LT1', loadId: null, truck_class: 'box_truck', max_skids: null, max_weight_lb: null, driver_user_name: null }],
  nowIso: '2026-08-27T01:00:00Z',
});
const onTruck = (p, nbr) => p.trucks.some((t) => t.stops.some((s) => s.stopNbr === nbr));

test('the builder ROUTES a stop whose only "closed" is a day the scanner stored from an old order', () => {
  const stored = { closed_days: ['thu'], auto_matches: { closed_days: [{ pattern: 'closed_thu', text: 'CLOSED ON THURSDAYS' }] } };
  const p = plan([row('B1', { name: 'NARROW DOCK', raw: { orderInstructions: 'SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID' } })], [[MK, stored]]);
  assert.equal(p.pool.closed_today, 0);
  assert.ok(onTruck(p, 'B1'), 'this order says nothing about Thursdays — it rides');
});

test('the builder leaves a stop off when THIS order says the customer is closed that day', () => {
  const p = plan([row('B1', { name: 'NARROW DOCK', raw: { orderInstructions: 'SPL-INSTR-TEXT: CLOSED ON THURSDAYS' } }), row('U1')], []);
  const l = p.left_unplanned.find((s) => s.stopNbr === 'B1');
  assert.equal(l?.reason, 'closed_today', 'no customer note needed — the order said it');
  assert.ok(!onTruck(p, 'B1'));
  assert.ok(onTruck(p, 'U1'));
});
