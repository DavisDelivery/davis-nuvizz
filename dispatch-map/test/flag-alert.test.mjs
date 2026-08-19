// THE ALERT RULES. Each of these exists because breaking it produces a specific bad morning
// for whoever reads customerservice@davisdelivery.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectAlertable, buildAlert, sendAlerts, alertClaimPath, DAILY_ALERT_CAP, ALERT_TO,
} from '../netlify/functions/lib/flag-alert.mts';

const DATE = '2026-08-17';
const row = (o) => ({
  rule: 'hours_risk', tier: 'critical', stopNbr: '1', customer: 'PYROK INC', routeName: 'WILLIAM',
  closeMin: 14 * 60, etaMin: 16 * 60, lateBy: 120, anchored: true, ...o,
});

test('only CRITICAL is emailed — amber and red stay on the screen', () => {
  const got = selectAlertable([
    row({ stopNbr: '1' }),
    row({ stopNbr: '2', tier: 'red' }),
    row({ stopNbr: '3', tier: 'amber' }),
  ], 10 * 60);
  assert.deepEqual(got.map((c) => c.stopNbr), ['1']);
});

test('nothing is emailed once the window has already closed', () => {
  // Chad: "if we are already past the time shouldn't send." Past the close the message
  // cannot change the outcome and competes with stops that can still be saved.
  assert.equal(selectAlertable([row({})], 14 * 60).length, 0, 'exactly at the close');
  assert.equal(selectAlertable([row({})], 15 * 60).length, 0, 'past the close');
  assert.equal(selectAlertable([row({})], 13 * 60 + 59).length, 1, 'one minute before, still actionable');
});

test('a collapsed summary row is never emailed — it is not a stop', () => {
  assert.equal(selectAlertable([row({ collapsed: 14, stopNbr: null })], 10 * 60).length, 0);
  assert.equal(selectAlertable([row({ collapsed: 14 })], 10 * 60).length, 0);
});

test('other rules never trigger the alert, whatever their tier', () => {
  assert.equal(selectAlertable([row({ rule: 'no_driver_hours' }), row({ rule: 'dup_number' })], 10 * 60).length, 0);
});

test('worst first, so the cap keeps the most urgent rather than an arbitrary slice', () => {
  const got = selectAlertable([
    row({ stopNbr: 'a', lateBy: 20 }), row({ stopNbr: 'b', lateBy: 200 }), row({ stopNbr: 'c', lateBy: 90 }),
  ], 10 * 60);
  assert.deepEqual(got.map((c) => c.stopNbr), ['b', 'c', 'a']);
});

test('the message names the stop, the close, the ETA and what the estimate rests on', () => {
  const m = buildAlert(selectAlertable([row({})], 10 * 60)[0], DATE);
  assert.match(m.subject, /PYROK INC/);
  assert.match(m.subject, /closes 2:00p/);
  assert.match(m.subject, /ETA 4:00p/);
  assert.match(m.text, /WILLIAM/);
  assert.match(m.text, /120 minutes late/);
  assert.match(m.text, /projected from a real arrival/);
  assert.match(m.html, /PYROK INC/);
});

test('an unanchored estimate says so, so nobody treats a guess as a measurement', () => {
  const m = buildAlert(selectAlertable([row({ anchored: false })], 10 * 60)[0], DATE);
  assert.match(m.text, /no stop on this route has reported in yet/);
});

test('the customer name is escaped into the HTML', () => {
  const m = buildAlert(selectAlertable([row({ customer: 'A & B <Ltd>' })], 10 * 60)[0], DATE);
  assert.ok(!/<Ltd>/.test(m.html));
  assert.match(m.html, /A &amp; B &lt;Ltd&gt;/);
});

test('ONE email per stop per day — the claim is what stops an all-afternoon repeat', async () => {
  // The board recomputes every few minutes. A truck that stays late is critical on every
  // single sweep; without the claim that is an email every sweep until the close passes.
  const claims = new Set();
  const sends = [];
  const io = {
    createDocIfAbsent: async (p) => (claims.has(p) ? false : (claims.add(p), true)),
    send: async (a) => { sends.push(a); return { ok: true, id: 'x' }; },
  };
  const cands = selectAlertable([row({})], 10 * 60);
  const first = await sendAlerts(cands, DATE, 'davis', io);
  const second = await sendAlerts(cands, DATE, 'davis', io);
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(second.skippedAlreadySent, 1);
  assert.equal(sends.length, 1, 'the second sweep sent nothing');
});

test('the claim is written BEFORE the send, so two overlapping sweeps cannot both email', async () => {
  const order = [];
  const io = {
    createDocIfAbsent: async (p) => { order.push('claim'); return true; },
    send: async () => { order.push('send'); return { ok: true }; },
  };
  await sendAlerts(selectAlertable([row({})], 10 * 60), DATE, 'davis', io);
  assert.deepEqual(order, ['claim', 'send']);
});

test('a failed send still keeps the claim — one missed alert beats an alert loop', async () => {
  const claims = new Set();
  const io = {
    createDocIfAbsent: async (p) => (claims.has(p) ? false : (claims.add(p), true)),
    send: async () => ({ ok: false, error: 'Resend HTTP 500' }),
  };
  const cands = selectAlertable([row({})], 10 * 60);
  const first = await sendAlerts(cands, DATE, 'davis', io);
  assert.equal(first.sent, 0);
  assert.equal(first.failed, 1);
  const second = await sendAlerts(cands, DATE, 'davis', io);
  assert.equal(second.skippedAlreadySent, 1, 'the claim survived the failure, deliberately');
});

test('a bad data day cannot become a hundred emails', async () => {
  const io = {
    createDocIfAbsent: async () => true,
    send: async () => ({ ok: true }),
  };
  const many = Array.from({ length: DAILY_ALERT_CAP + 12 }, (_, i) => row({ stopNbr: `s${i}`, lateBy: 100 + i }));
  const r = await sendAlerts(selectAlertable(many, 10 * 60), DATE, 'davis', io);
  assert.equal(r.sent, DAILY_ALERT_CAP);
  assert.equal(r.capped, 12);
});

test('the claim path is per tenant, per day, per stop — and safe as a doc id', () => {
  assert.equal(alertClaimPath('davis', DATE, '007163412'), 'eta_flag_alerts/davis__2026-08-17__007163412');
  assert.ok(!/[/#?]/.test(alertClaimPath('davis', DATE, 'a/b#c?d').split('/').slice(1).join('')));
});

test('the recipient is customer service', () => {
  assert.equal(ALERT_TO, 'customerservice@davisdelivery.com');
});
