// FREIGHT THAT CANNOT COME OFF A LIFTGATE — the email, the 9pm text, and the PRO on both.
//
// Chad, 2026-09-22, photographing the wall display with WEST RIDGE riding MICHAEL FRYE:
//   1. "The hydraulic stacker alert. I want those to fire an email the moment one of those
//      hits our system so that we can address it hopefully the day before we have to deliver."
//   2. "I want it to fire a text to the dispatchers at night when they're planning these loads
//      if they've put one on a box truck."
//   3. "on these messages, I would like the pro number to be up there."
//
// The real-world failure: a hydraulic stacker rolls off a dock or a trailer deck on its own
// castors. Every box truck in this fleet has a liftgate instead of a dock, and a top-heavy
// machine on a gate platform is how one gets tipped — a refusal, a redelivery, and a damaged
// machine that was ours to protect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags } from '../src/lib/board-flags.js';
import {
  selectStackerOrders, stackerEmail, stackerLine, stackerClaimPath,
  stackerAlertEnabled, runStackerAlert,
} from '../netlify/functions/lib/stacker-alert.mts';
import { selectTextable, smsText, smsClaimPath, proClause } from '../netlify/functions/lib/flag-sms.mts';

const DATE = '2026-09-22';
const DEPOT = { lat: 34.147791, lng: -83.960911 };

// A real stacker order: Uline writes the instruction, the scanner promotes it to a handling flag.
const STACKER_TEXT = 'ORDER CONTAINS HYDRAULIC STACKER';

const stop = (over = {}) => ({
  stopNbr: '007180089', businessName: 'WEST RIDGE CHURCH', addr1: '1 Main', city: 'DALLAS',
  primaryPro: '007180089', pro: '007180089',
  lat: 34.10, lng: -84.00, matchKey: 'westridge',
  normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  loadNbr: 'MICHAEL FRYE', routeName: 'MICHAEL FRYE', driverName: 'Michael Frye',
  routeSeq: 5, stopType: 'DO',
  orderInstructions: STACKER_TEXT,
  ...over,
});

// ── 1 · THE EMAIL: an order that needs a tractor, the day it lands ───────────

test('a stacker order is selected whether or not anybody has planned it yet', () => {
  // THE WHOLE POINT. R4b cannot speak about an unplanned order — it needs a route with a known
  // truck class — and an unplanned order is the one this alert exists for, because that is the
  // cheapest possible moment to put it on the right truck.
  const unplanned = selectStackerOrders([stop({ isPlanned: false, routeName: null, loadNbr: null })]);
  assert.equal(unplanned.length, 1, 'an order nobody has routed yet is exactly the early warning');
  assert.equal(unplanned[0].planned, false);
  assert.match(stackerLine(unplanned[0]), /not planned onto a route yet/);

  const planned = selectStackerOrders([stop()]);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].planned, true);
  assert.match(stackerLine(planned[0]), /planned on MICHAEL FRYE \(Michael Frye\)/);
});

test('freight with no stacker on it is never selected', () => {
  assert.deepEqual(selectStackerOrders([stop({ orderInstructions: 'CALL BEFORE DELIVERY' })]), []);
  assert.deepEqual(selectStackerOrders([stop({ orderInstructions: '' })]), []);
  assert.deepEqual(selectStackerOrders([]), []);
  assert.deepEqual(selectStackerOrders(null), []);
});

test('a depot row and delivered freight are dropped — neither is a decision anyone can make', () => {
  assert.deepEqual(selectStackerOrders([stop({ isTerminal: true })]), []);
  for (const st of ['DELIVERED', 'EXCEPTION', 'CANCELLED']) {
    assert.deepEqual(selectStackerOrders([stop({ normalizedStatus: st })]), [], `${st} is history`);
  }
  // …and the same row while it is still open IS selected, so the guard above cannot be
  // mistaken for "this board has no stackers on it".
  assert.equal(selectStackerOrders([stop({ normalizedStatus: 'SCHEDULED' })]).length, 1);
});

test('ONE ROW PER ORDER, and the PRO is resolved rather than assumed equal to the stop number', () => {
  // A pickup's stop number is an RA-series string. Printing that under the word PRO is a
  // number nobody can look up, which is why the selector reads primaryPro first.
  const pickup = selectStackerOrders([stop({ stopNbr: 'RA60109098', primaryPro: '007180500', pro: '007180500' })]);
  assert.equal(pickup[0].pro, '007180500', 'the PRO, not the RA stop number');
  assert.equal(pickup[0].stopNbr, 'RA60109098', 'the stop number is still what it is claimed on');
  // A feed that repeats a row must not produce two emails about one order.
  assert.equal(selectStackerOrders([stop(), stop()]).length, 1);
});

test('the email names the order, the freight and the action', () => {
  const orders = selectStackerOrders([stop()]);
  const { subject, text } = stackerEmail(orders, DATE);
  assert.match(subject, /Needs a tractor trailer/);
  assert.match(subject, /WEST RIDGE CHURCH/);
  assert.match(text, /PRO 007180089/, 'the number a reader has to type next');
  assert.match(text, /hydraulic stacker/);
  assert.match(text, /liftgate/, 'says WHY, or it is a fact nobody can act on');
  assert.match(text, /Plan it onto a tractor trailer/, 'says what to DO');
});

test('the subject counts the orders rather than naming one of several', () => {
  const two = selectStackerOrders([stop(), stop({ stopNbr: '007180214', primaryPro: '007180214', businessName: 'ATLANTA VA CLINIC', matchKey: 'va' })]);
  assert.equal(two.length, 2);
  assert.match(stackerEmail(two, DATE).subject, /2 orders/);
});

test('unplanned orders sort FIRST — the ones still free to fix lead the email', () => {
  const rows = selectStackerOrders([
    stop({ stopNbr: 'B', primaryPro: 'B', matchKey: 'b', isPlanned: true }),
    stop({ stopNbr: 'A', primaryPro: 'A', matchKey: 'a', isPlanned: false }),
  ]);
  assert.deepEqual(rows.map((r) => r.stopNbr), ['A', 'B']);
});

// ── THE RATCHET: once per order per board day, across both sweeps ────────────

test('IT EMAILS ONCE AND THEN GOES QUIET — a 20-minute sweep must not send 39 times a day', async () => {
  const claims = new Set();
  const sent = [];
  const io = {
    createDocIfAbsent: async (p) => (claims.has(p) ? false : (claims.add(p), true)),
    send: async (a) => { sent.push(a); return { ok: true }; },
    to: 'cs@example.com', at: '2026-09-22T09:00:00Z',
  };
  const stops = [stop()];
  const first = await runStackerAlert(stops, DATE, 'davis', io);
  assert.equal(first.found, 1);
  assert.equal(first.claimed, 1);
  assert.equal(first.sent, 1);
  assert.equal(sent.length, 1);

  const second = await runStackerAlert(stops, DATE, 'davis', io);
  assert.equal(second.found, 1, 'the order is still on the board');
  assert.equal(second.claimed, 0, 'but it is already claimed');
  assert.equal(second.sent, 0, 'so nothing is sent');
  assert.equal(sent.length, 1, 'still exactly one email');
});

test('the two sweeps share one claim — the evening pass cannot duplicate the day pass', async () => {
  // The day sweep and the evening sweep both hold today's board between 6:00a and 7:00a.
  const claims = new Set();
  const sent = [];
  const io = () => ({
    createDocIfAbsent: async (p) => (claims.has(p) ? false : (claims.add(p), true)),
    send: async (a) => { sent.push(a); return { ok: true }; },
    to: 'cs@example.com',
  });
  await runStackerAlert([stop()], DATE, 'davis', io());   // evening sweep
  await runStackerAlert([stop()], DATE, 'davis', io());   // day sweep, same board
  assert.equal(sent.length, 1, 'one order, one email, whichever sweep saw it first');
});

test('a NEW order on a board already mailed gets its own email, and the old one does not repeat', async () => {
  const claims = new Set();
  const sent = [];
  const io = {
    createDocIfAbsent: async (p) => (claims.has(p) ? false : (claims.add(p), true)),
    send: async (a) => { sent.push(a); return { ok: true }; },
    to: 'cs@example.com',
  };
  await runStackerAlert([stop()], DATE, 'davis', io);
  const later = await runStackerAlert(
    [stop(), stop({ stopNbr: '007180214', primaryPro: '007180214', businessName: 'ATLANTA VA CLINIC', matchKey: 'va' })],
    DATE, 'davis', io,
  );
  assert.equal(later.claimed, 1, 'only the new one');
  assert.deepEqual(later.orders, ['007180214']);
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /ATLANTA VA CLINIC/);
});

test('A FAILED SEND DOES NOT UN-CLAIM — a flaky provider must not become 39 emails an hour', async () => {
  const claims = new Set();
  let calls = 0;
  const io = {
    createDocIfAbsent: async (p) => (claims.has(p) ? false : (claims.add(p), true)),
    send: async () => { calls += 1; return { ok: false, error: 'provider down' }; },
    to: 'cs@example.com',
  };
  const first = await runStackerAlert([stop()], DATE, 'davis', io);
  assert.equal(first.failed, 1);
  assert.equal(first.sent, 0);
  const second = await runStackerAlert([stop()], DATE, 'davis', io);
  assert.equal(second.claimed, 0, 'the claim stands even though the mail did not go');
  assert.equal(calls, 1, 'one attempt, not one per sweep forever');
});

test('the claim key is one per ORDER per board day, and path-safe', () => {
  assert.equal(stackerClaimPath('davis', DATE, '007180089'), 'stacker_alert/davis__2026-09-22__007180089');
  assert.notEqual(stackerClaimPath('davis', DATE, 'A'), stackerClaimPath('davis', '2026-09-23', 'A'));
  // A slash in a Firestore doc id is a path segment, not a character — the v0.50.8 trap.
  assert.ok(!stackerClaimPath('davis', DATE, 'COLIN/DJ 1').split('/').slice(1).join('/').includes('/'));
});

test('STACKER_ALERT is house shape: default on, off-words off, MALFORMED LEAVES IT ON', async () => {
  assert.equal(stackerAlertEnabled({}), true);
  for (const v of ['off', 'OFF', '0', 'false', 'no', ' Off ']) {
    assert.equal(stackerAlertEnabled({ STACKER_ALERT: v }), false, `${v} turns it off`);
  }
  for (const v of ['offf', 'nope', 'true', 'yes', '1']) {
    assert.equal(stackerAlertEnabled({ STACKER_ALERT: v }), true, `${v} must NOT silence the alert`);
  }
  // …and off really does stop the send, not merely the flag.
  let sent = 0;
  const out = await runStackerAlert([stop()], DATE, 'davis', {
    createDocIfAbsent: async () => true, send: async () => { sent += 1; return { ok: true }; }, to: 'x@y.z',
  }, { STACKER_ALERT: 'off' });
  assert.equal(out.enabled, false);
  assert.equal(sent, 0);
});

// ── 2 · THE 9PM TEXT: a stacker that has been put on a box truck ─────────────

const runFlags = (stops, routeClasses) => computeBoardFlags({
  stops, notes: new Map(), rosterRows: [], servedDate: DATE, dayKey: 'tue',
  opts: { depot: DEPOT, departMin: 8 * 60, travel: { legs: {}, routeClasses } },
});

test('END TO END: a stacker on a box route flags, is selected, and texts', () => {
  const out = runFlags([stop({ loadNbr: 'BOX 1', routeName: 'BOX 1' })], { 'BOX 1': 'box' });
  const rows = out.rows.filter((r) => r.rule === 'box_truck_conflict');
  assert.equal(rows.length, 1, 'the board flags it');

  const picked = selectTextable(out.rows);
  assert.equal(picked.length, 1, 'the selector takes it');
  assert.equal(picked[0].rule, 'box_truck_conflict');

  const text = smsText(picked[0], DATE);
  assert.match(text, /runs a box truck/);
  assert.match(text, /hydraulic stacker/, 'names the machine, not "handling flag"');
  assert.match(text, /PRO 007180089/, 'Chad asked for the PRO on these messages');
  assert.match(text, /Move it to a tractor trailer/);
  // GSM-7 ONLY. One em dash forces the whole message to UCS-2 at 70 chars a segment
  // instead of 160 — measured at 60% of the SMS bill. See flag-sms.mts.
  assert.ok(/^[\x20-\x7E\n\r]*$/.test(text), `non-GSM-7 character in: ${text}`);
  assert.ok(text.length < 320, `two segments at most: ${text.length} chars`);
});

test('the same stacker on a TRACTOR route is not a conflict, and texts nobody', () => {
  const out = runFlags([stop({ loadNbr: 'T1', routeName: 'T1' })], { T1: 'tractor' });
  assert.deepEqual(out.rows.filter((r) => r.rule === 'box_truck_conflict'), []);
  assert.deepEqual(selectTextable(out.rows), []);
});

test('A ROUTE WITH NO TRUCK CLASS IS NOT JUDGED — "we do not know" is not "it is a box"', () => {
  const out = runFlags([stop({ loadNbr: 'MYSTERY', routeName: 'MYSTERY' })], { 'SOMETHING ELSE': 'box' });
  assert.deepEqual(out.rows.filter((r) => r.rule === 'box_truck_conflict'), []);
});

test('ONE TEXT PER ROUTE, not per stop — three stackers on one box truck is one problem', () => {
  const stops = ['A', 'B', 'C'].map((k, i) => stop({
    stopNbr: `00718010${i}`, primaryPro: `00718010${i}`, matchKey: k, businessName: `CUST ${k}`,
    addr1: `${i} Main`, loadNbr: 'BOX 1', routeName: 'BOX 1', routeSeq: i + 1,
  }));
  const out = runFlags(stops, { 'BOX 1': 'box' });
  assert.equal(out.rows.filter((r) => r.rule === 'box_truck_conflict').length, 3, 'three cards on the board');
  const picked = selectTextable(out.rows);
  assert.equal(picked.length, 1, 'but ONE text — the wrong truck is one problem with one answer');
  assert.match(smsText(picked[0], DATE), /\+2 more stops on this route/);
});

test('the box-truck claim is its own — a load can be wrong in both directions at once', () => {
  const box = smsClaimPath('davis', DATE, 'BOX 1', 'box_truck_conflict');
  const trailer = smsClaimPath('davis', DATE, 'BOX 1', 'trailer_conflict');
  const hours = smsClaimPath('davis', DATE, 'BOX 1', 'hours_risk');
  assert.equal(new Set([box, trailer, hours]).size, 3, 'three rules, three claims, three messages');
  assert.match(box, /__box$/);
});

// ── 3 · THE PRO, on every flag row and every message ─────────────────────────

test('every flag row carries the PRO, and a multi-order dock says how many', () => {
  const out = runFlags([stop({ loadNbr: 'BOX 1', routeName: 'BOX 1' })], { 'BOX 1': 'box' });
  const r = out.rows.find((x) => x.rule === 'box_truck_conflict');
  assert.equal(r.pro, '007180089');
  assert.equal(r.pros, undefined, 'a one-order dock carries no array for consumers to special-case');

  const multi = runFlags(
    [stop({ loadNbr: 'BOX 1', routeName: 'BOX 1', pros: ['007180089', '007180090'], proCount: 2 })],
    { 'BOX 1': 'box' },
  ).rows.find((x) => x.rule === 'box_truck_conflict');
  assert.deepEqual(multi.pros, ['007180089', '007180090']);
  assert.match(proClause(multi), /PRO 007180089 \+1/);
});

test('a flag row on a PICKUP prints the PRO, never the RA stop number', () => {
  // THIS TEST EXISTS BECAUSE THE FIRST VERSION OF THE ONE ABOVE COULD NOT FAIL. Its fixture
  // gave stopNbr and primaryPro the same value — true of all 834 rows on the 2026-09-22 board
  // — so replacing the whole resolution with `pro: s.stopNbr` passed every assertion. A
  // pickup is where they diverge: NuVizz numbers those RA60109098, and an RA number printed
  // under the word PRO is a number nobody can look up in the portal.
  const out = runFlags(
    [stop({ loadNbr: 'BOX 1', routeName: 'BOX 1', stopNbr: 'RA60109098', primaryPro: '007180500', pro: '007180500' })],
    { 'BOX 1': 'box' },
  );
  const r = out.rows.find((x) => x.rule === 'box_truck_conflict');
  assert.equal(r.pro, '007180500', 'the PRO');
  assert.equal(r.stopNbr, 'RA60109098', 'the stop number is still the identity it is claimed on');
  assert.match(smsText(r, DATE), /PRO 007180500/);
  assert.ok(!smsText(r, DATE).includes('PRO RA60109098'), 'never the RA number under the word PRO');
});

test('proClause prints nothing when there is no PRO, rather than "PRO undefined"', () => {
  assert.equal(proClause({}), '');
  assert.equal(proClause({ pro: null }), '');
  assert.equal(proClause({ pro: '  ' }), '');
});
