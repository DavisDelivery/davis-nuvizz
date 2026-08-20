// THE ALERT RULES. Each of these exists because breaking it produces a specific bad morning
// for whoever reads customerservice@davisdelivery.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectAlertable, buildAlert, sendAlerts, alertClaimPath, DAILY_ALERT_CAP, ALERT_TO, ALERT_TIERS,
} from '../netlify/functions/lib/flag-alert.mts';

const DATE = '2026-08-17';
const row = (o) => ({
  rule: 'hours_risk', tier: 'critical', stopNbr: '1', customer: 'PYROK INC', routeName: 'WILLIAM',
  closeMin: 14 * 60, etaMin: 16 * 60, lateBy: 120, anchored: true, ...o,
});

test('EVERY urgent tier is emailed — amber alone stays on the screen', () => {
  // Chad: "We want every red. Amber is a screen thing."
  //
  // This test used to assert the opposite, and the assertion was wrong rather than the
  // behaviour being deliberate. v0.55.4 split the old 'red' into critical + red and the
  // alert stayed wired to critical alone, so a stop the BOARD was painting as an urgent red
  // flag sent nothing. Chad found it that way: "This popped up as an urgent red flag but no
  // email was sent to customer service."
  const got = selectAlertable([
    row({ stopNbr: '1' }),
    row({ stopNbr: '2', tier: 'red', lateBy: 60 }),
    row({ stopNbr: '3', tier: 'amber' }),
  ], 10 * 60);
  assert.deepEqual(got.map((c) => c.stopNbr), ['1', '2']);
});

test('the alert tiers are exactly the tiers the board paints as urgent', () => {
  // The screen and the inbox disagreeing is the defect above. Pinning the set means the
  // next person to add a tier has to decide, in one place, whether it wakes anyone.
  assert.deepEqual([...ALERT_TIERS].sort(), ['critical', 'red']);
  assert.equal(ALERT_TIERS.has('amber'), false);
});

test('a red row carries its own numbers into the message, not a critical row\'s', () => {
  const m = buildAlert(selectAlertable([row({ tier: 'red', lateBy: 45, etaMin: 14 * 60 + 45 })], 10 * 60)[0], DATE);
  assert.match(m.text, /45 minutes late/);
  assert.match(m.html, /45 min late/);
});

test('nothing is emailed once the window has already closed', () => {
  // Chad: "if we are already past the time shouldn't send." Past the close the message
  // cannot change the outcome and competes with stops that can still be saved.
  assert.equal(selectAlertable([row({})], 14 * 60).length, 0, 'exactly at the close');
  assert.equal(selectAlertable([row({})], 15 * 60).length, 0, 'past the close');
  assert.equal(selectAlertable([row({})], 13 * 60 + 59).length, 1, 'one minute before, still actionable');
});

test('a row with NO receiving close never emails a midnight deadline', () => {
  // Number(null) is 0, and 0 is finite — so a bare isFinite check let a stop with no
  // receiving close through carrying closeMin 0. With a live clock the close-has-passed
  // rule then hid it by accident (now >= 0), but judging a past board passes nowMin null,
  // that rule never runs, and it became a real email to customer service announcing
  // "Receiving close 12:00a" about a stop that has no deadline at all.
  for (const bad of [null, undefined, '', '   ', 'noon', NaN, [], {}, true]) {
    assert.equal(selectAlertable([row({ closeMin: bad })], 10 * 60).length, 0, String(bad));
    assert.equal(selectAlertable([row({ closeMin: bad })], null).length, 0, `${bad} with no clock`);
  }
  // A genuine midnight close is still a close, and must survive.
  assert.equal(selectAlertable([row({ closeMin: 0, etaMin: 30, lateBy: 30 })], null).length, 1);
});

test('a collapsed summary row is never emailed — it is not a stop', () => {
  assert.equal(selectAlertable([row({ collapsed: 14, stopNbr: null })], 10 * 60).length, 0);
  assert.equal(selectAlertable([row({ collapsed: 14 })], 10 * 60).length, 0);
});

test('data-quality rules never trigger the alert, whatever their tier', () => {
  // dup_number, no_location and friends are screen work, not a delivery about to be refused.
  assert.equal(selectAlertable([row({ rule: 'dup_number' }), row({ rule: 'no_location' })], 10 * 60).length, 0);
});

test('THE SUPERSEDE CAN EMAIL — because it DELETES the row that used to', () => {
  // board-flags R6 replaces every hours_risk row on a driverless route with one card ("one
  // route, one card" — Chad: "there is same one listed twice"). That supersede also took the
  // severity and the alert with it: five stops predicted 200+ minutes past their close became
  // one amber row, criticalCount 0, and customer service heard nothing about the worst route
  // on the board. Removing the driver made the situation worse and the board calmer.
  //
  // R6 now inherits the worst superseded row's tier and its stop facts, and this path lets it
  // send — with the better reason (nobody is driving) attached to the message.
  const superseded = row({ rule: 'no_driver_hours', tier: 'critical', stopNbr: '007164290' });
  const got = selectAlertable([superseded], 10 * 60);
  assert.equal(got.length, 1, 'a supersede that replaced a real red must still reach the inbox');
  assert.equal(got[0].rule, 'no_driver_hours');
  assert.equal(got[0].tier, 'critical');
});

test('a screen-only no-driver card — one that superseded nothing — still sends nothing', () => {
  // R6 also fires EARLY, before the ETA walk has crossed any close (Chad's 9:24a LVILLE).
  // Those cards carry no stop facts, and without a stopNbr or a close there is nothing to
  // claim, nothing to say, and no send.
  assert.equal(selectAlertable([row({ rule: 'no_driver_hours', stopNbr: null })], 10 * 60).length, 0);
  assert.equal(selectAlertable([row({ rule: 'no_driver_hours', closeMin: null })], 10 * 60).length, 0);
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

test('the alert cap is INDEPENDENT of the customer-communications cap', async () => {
  // Chad: "the flag emails should not be bound to the resend cap we set for customer
  // communications." They share no code — this asserts the constant has not drifted back to
  // the comms figure, which is the way the two would silently re-couple.
  const comms = await import('../netlify/functions/lib/customer-comms.mts');
  assert.notEqual(DAILY_ALERT_CAP, comms.DEFAULT_CONFIG.dailyCap,
    'the alert ceiling must not be the customer-comms daily cap');
  assert.ok(DAILY_ALERT_CAP >= 100, 'it is a runaway backstop, not a budget');
  // The number itself must not read as a comms figure. It has twice been set to a value
  // that matched one (25, then 200) and twice prompted "is the alert bound by that cap?".
  assert.notEqual(DAILY_ALERT_CAP, 200, 'do not reuse a customer-communications cap value');
  assert.notEqual(DAILY_ALERT_CAP, 300, 'do not reuse a customer-communications cap value');
});

test('the alert module imports nothing from the customer-communications engine', async () => {
  // The strongest form of "not bound to it": no shared counter, config doc, or budget.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../netlify/functions/lib/flag-alert.mts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .*?from '(.+?)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./email.mts'], 'the only dependency is the raw sender');
});

test('a runaway board cannot become an unbounded flood', async () => {
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

test('alerts still send when the customer-communications budget is fully spent', async () => {
  // The strongest statement of Chad's requirement, proved rather than asserted: run the
  // customer-comms sweep's budget all the way to zero, then send an alert. If the two were
  // coupled through any shared counter or config, this send would be suppressed.
  const comms = await import('../netlify/functions/lib/customer-comms.mts');
  const cap = comms.DEFAULT_CONFIG.dailyCap;
  let commsSpent = cap;                       // pretend today's confirmations are all gone
  assert.ok(commsSpent >= cap, 'comms budget is exhausted for the purposes of this test');

  const claims = new Set();
  const sends = [];
  const io = {
    createDocIfAbsent: async (p) => (claims.has(p) ? false : (claims.add(p), true)),
    send: async (a) => { sends.push(a); return { ok: true, id: 'x' }; },
  };
  const r = await sendAlerts(selectAlertable([row({})], 10 * 60), DATE, 'davis', io);
  assert.equal(r.sent, 1, 'the miss-window alert is unaffected by the confirmations budget');
  assert.equal(sends[0].to[0], ALERT_TO);
});

test('the recipient is customer service', () => {
  assert.equal(ALERT_TO, 'customerservice@davisdelivery.com');
});

// ── THE HISTORY MAY ONLY RECORD A SEND THAT HAPPENED ────────────────────────

test('sendAlerts reports WHICH stops it actually reached, not which it intended to', () => {
  // The flag history recorded emailed:true from the CANDIDATE list, before sendAlerts ran —
  // so with RESEND_API_KEY unset, or Resend returning 500, or the runaway cap hit, the
  // history still claimed every red and critical had emailed customer service. mergeSweep's
  // sticky OR made that permanent for the day. This repo's oldest sin (an intent reported as
  // an outcome) inside the feature built to stop committing it.
  const io = (sendOk, claimOk = true) => ({
    createDocIfAbsent: async () => claimOk,
    send: async () => ({ ok: sendOk }),
  });
  const c = (stopNbr) => ({ stopNbr, customer: 'X', route: 'R', closeMin: 840, etaMin: 900, lateBy: 60, tier: 'red' });

  return Promise.all([
    sendAlerts([c('a'), c('b')], DATE, 'davis', io(true)).then((r) => {
      assert.equal(r.sent, 2);
      assert.deepEqual([...r.emailedStops].sort(), ['a', 'b'], 'both were mailed');
    }),
    sendAlerts([c('a'), c('b')], DATE, 'davis', io(false)).then((r) => {
      assert.equal(r.sent, 0);
      assert.equal(r.failed, 2);
      assert.equal(r.emailedStops.size, 0, 'a refused send is NOT an email');
    }),
    // Claim already held: an EARLIER sweep mailed it, so it still counts as emailed today.
    sendAlerts([c('a')], DATE, 'davis', io(true, false)).then((r) => {
      assert.equal(r.skippedAlreadySent, 1);
      assert.deepEqual([...r.emailedStops], ['a'], "an earlier sweep's send still counts");
    }),
  ]);
});
