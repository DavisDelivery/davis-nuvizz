// Chad, 2026-09-29: the 5:30p email to customer service of every PLANNED order not yet delivered,
// sent after the 5:25p scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenOrders, sendDecision, inSendWindow, openOrdersSubject, openOrdersText, openOrdersHtml, openOrdersEmailEnabled, etClock, boardAsOf } from '../netlify/functions/lib/open-orders.mts';
import { buildDayCompletion } from '../netlify/functions/lib/day-completion.mts';
import { recipientsFor, COMPANY_CS_ADDRESS, ALERT_INTERNAL_SUFFIXES } from '../netlify/functions/lib/alert-recipients.mts';

const DATE = '2026-09-29';
const s = (pro, routeName, status, extra = {}) => ({ stopNbr: pro, pro, routeName, loadNbr: routeName, isPlanned: !!routeName, status, businessName: `CUST ${pro}`, city: 'BUFORD', state: 'GA', ...extra });

const BOARD = [
  s('1001', 'MARCUS', '90'),                    // delivered
  s('1002', 'MARCUS', '91'),                    // delivered by hand
  s('1003', 'MARCUS', '20', { routeSeq: 5 }),   // not attempted
  s('1004', 'DARVIN', '40', { routeSeq: 2 }),   // out for delivery
  s('1005', 'DARVIN', '80', { routeSeq: 1 }),   // refused — undelivered, listed
  s('1006', 'DARVIN', '99'),                    // cancelled — pulled, not missed
  s('1007', 'CHAD', '20'),                      // owner route — out
  s('1008', 'ULINE APPT', '20'),                // appointment holding pen — out
  s('1009', '', '10', { isPlanned: false }),    // unplanned — out
  s('1010', 'MARCUS', '20', { closedOnBoard: '2026-09-30' }), // closed on another day's board — out
];

test('lists only planned orders not delivered; cancelled, unplanned, CHAD and ULINE APPT are left out', () => {
  const r = buildOpenOrders(BOARD, { date: DATE });
  assert.deepEqual(r.open.map((o) => o.pro), ['1005', '1004', '1003']);   // DARVIN by sequence, then MARCUS
  assert.equal(r.planned, 5);
  assert.equal(r.delivered, 2);
  assert.deepEqual(r.excludedRoutes, ['CHAD', 'ULINE APPT']);
  assert.equal(r.open.find((o) => o.pro === '1005').status, 'Attempted — not delivered');
  assert.equal(r.open.find((o) => o.pro === '1003').status, 'Not delivered yet');
});

test('agrees with the 6:30 report about what is open on the same board', () => {
  const r = buildOpenOrders(BOARD, { date: DATE });
  const d = buildDayCompletion(BOARD, { date: DATE });
  assert.equal(r.open.length, d.open + d.counts.unable);
  assert.equal(r.delivered, d.delivered);
});

test('one row per PRO — a duplicated board row is one order, and two orders at one dock are two rows', () => {
  const r = buildOpenOrders([
    s('2001', 'MARCUS', '20', { stopNbr: 'S1' }), s('2001', 'MARCUS', '20', { stopNbr: 'S1' }),
    s('2002', 'MARCUS', '20', { stopNbr: 'S1' }),
  ], { date: DATE });
  assert.deepEqual(r.open.map((o) => o.pro), ['2001', '2002']);
});

// Tue 2026-09-29, EDT.
const at = (hhmm) => new Date(`2026-09-29T${hhmm}:00-04:00`);
const iso = (hhmm) => at(hhmm).toISOString();
const decide = (hhmm, stamps, alreadySent = false, weekday = 2) => {
  const [h, m] = hhmm.split(':').map(Number);
  return sendDecision({ weekday, hour: h, minute: m, nowMs: at(hhmm).getTime(), stamps, alreadySent });
};

test('5:30p with the 5:25 scan landed: send', () => {
  const d = decide('17:30', { planned: iso('17:25'), completed: iso('17:25') });
  assert.equal(d.action, 'send');
  assert.equal(d.fresh, true);
});

test('5:30p with the scan held back by the floor: wait, then send when it lands', () => {
  assert.equal(decide('17:30', { planned: iso('17:10'), completed: iso('17:15') }).action, 'wait');
  assert.equal(decide('17:35', { planned: iso('17:31'), completed: iso('17:31') }).action, 'send');
});

test('half a scan is not a fresh board — both lists must be past 5:20', () => {
  assert.equal(decide('17:30', { planned: iso('17:25'), completed: iso('17:10') }).action, 'wait');
});

test('no scan by 5:45p: send anyway, marked not fresh — late beats never', () => {
  const d = decide('17:45', { planned: iso('17:00'), completed: iso('17:00') });
  assert.equal(d.action, 'send');
  assert.equal(d.fresh, false);
});

test('once sent, the rest of the window stands down', () => {
  assert.equal(decide('17:40', { planned: iso('17:25'), completed: iso('17:25') }, true).action, 'skip');
});

test('never before 5:30p, never after 6:00p, never at the weekend', () => {
  assert.equal(decide('17:25', { planned: iso('17:25'), completed: iso('17:25') }).action, 'skip');
  assert.equal(decide('18:00', {}).action, 'skip');
  assert.equal(decide('17:30', { planned: iso('17:25'), completed: iso('17:25') }, false, 6).action, 'skip');
  assert.equal(inSendWindow(2, 17, 29), false);
  assert.equal(inSendWindow(2, 17, 30), true);
  assert.equal(inSendWindow(2, 17, 59), true);
  assert.equal(inSendWindow(0, 17, 30), false);
});

test('the cron covers 5:30p ET in both EDT and EST, on the ET clock', () => {
  // 21:30Z in September (EDT) and 22:30Z in December (EST) are both 5:30p ET.
  assert.deepEqual(etClock(new Date('2026-09-29T21:30:00Z')), { hour: 17, minute: 30, weekday: 2 });
  assert.deepEqual(etClock(new Date('2026-12-01T22:30:00Z')), { hour: 17, minute: 30, weekday: 2 });
});

test('customer service is always on the 5:30 list; the list adds whoever else is saved', () => {
  assert.deepEqual(recipientsFor('openOrdersTo', null, {}), [COMPANY_CS_ADDRESS]);
  const ops = `ops${ALERT_INTERNAL_SUFFIXES[0]}`;
  assert.deepEqual(recipientsFor('openOrdersTo', { openOrdersTo: [ops] }, {}), [COMPANY_CS_ADDRESS, ops]);
});

test('the email says how many, how fresh, and what was left out', () => {
  const r = buildOpenOrders(BOARD, { date: DATE });
  assert.match(openOrdersSubject(r), /3 planned deliveries not delivered yet/);
  const text = openOrdersText(r, '5:26p ET');
  assert.match(text, /2 of 5 planned deliveries delivered; 3 still open/);
  assert.match(text, /Board last scanned 5:26p ET/);
  assert.match(text, /Not included: CHAD, ULINE APPT/);
  assert.match(openOrdersHtml(r, null), /<b>1005<\/b>/);
  assert.match(openOrdersSubject(buildOpenOrders([s('1', 'MARCUS', '90')], { date: DATE })), /every planned delivery is delivered/);
});

test('HTML escapes what NuVizz sends', () => {
  const r = buildOpenOrders([s('3001', 'MARCUS', '20', { businessName: 'A&B <x>' })], { date: DATE });
  assert.match(openOrdersHtml(r, null), /A&amp;B &lt;x&gt;/);
});

test('board freshness is the OLDER of the two list stamps; a missing one is unknown', () => {
  assert.equal(boardAsOf({ planned: iso('17:25'), completed: iso('17:10') }), iso('17:10'));
  assert.equal(boardAsOf({ planned: iso('17:25') }), null);
});

test('OPEN_ORDERS_EMAIL: on by default, off-words turn it off, a typo leaves it on', () => {
  assert.equal(openOrdersEmailEnabled({}), true);
  for (const v of ['off', '0', 'false', 'NO']) assert.equal(openOrdersEmailEnabled({ OPEN_ORDERS_EMAIL: v }), false);
  assert.equal(openOrdersEmailEnabled({ OPEN_ORDERS_EMAIL: 'offf' }), true);
});
