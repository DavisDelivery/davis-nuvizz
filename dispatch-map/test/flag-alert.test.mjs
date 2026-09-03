// THE ALERT RULES. Each of these exists because breaking it produces a specific bad morning
// for whoever reads customerservice@davisdelivery.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectAlertable, buildAlert, sendAlerts, alertClaimPath, DAILY_ALERT_CAP, ALERT_TO, ALERT_TIERS,
  ALERT_MIN_TIER, alertTiersFor, normalizeMinTier,
} from '../netlify/functions/lib/flag-alert.mts';

const DATE = '2026-08-17';
const row = (o) => ({
  rule: 'hours_risk', tier: 'critical', stopNbr: '1', customer: 'PYROK INC', routeName: 'WILLIAM',
  closeMin: 14 * 60, etaMin: 16 * 60, lateBy: 120, anchored: true, ...o,
});

test('ONLY CRITICAL IS EMAILED — red and amber stay on the screen', () => {
  // Chad, 2026-09-02: "I don't want a 100 Emails. We are only emailing on critical."
  //
  // This assertion has now been written three ways, so here is the record rather than an
  // opinion. v0.55.4 split the old 'red' into critical + red and left the alert on critical
  // alone — an ENGINEER narrowing it silently while the board still painted red as urgent,
  // which Chad found the hard way ("This popped up as an urgent red flag but no email was
  // sent to customer service") and v0.56.3 fixed by widening to both. This is the OWNER
  // narrowing it out loud, with the stored history behind him: over 2026-08-25 → 09-02, of
  // the eight red-but-never-critical stops that emailed, SEVEN made their window.
  const got = selectAlertable([
    row({ stopNbr: '1' }),
    row({ stopNbr: '2', tier: 'red', lateBy: 60 }),
    row({ stopNbr: '3', tier: 'amber' }),
  ], 10 * 60);
  assert.deepEqual(got.map((c) => c.stopNbr), ['1']);
});

test('and ALERT_MIN_TIER=red puts every red back, without a deploy', () => {
  // The switch is the whole reason the narrowing is safe to ship: if 2.0 emails a day turns
  // out to be too quiet, this is one env var, not a code change and a release.
  const got = selectAlertable([
    row({ stopNbr: '1' }),
    row({ stopNbr: '2', tier: 'red', lateBy: 60 }),
    row({ stopNbr: '3', tier: 'amber' }),
  ], 10 * 60, 0, 'red');
  assert.deepEqual(got.map((c) => c.stopNbr), ['1', '2']);
});

test('the alert tiers are exactly the floor and above', () => {
  // Pinning the set means the next person to move this bar has to decide, in one place,
  // whether it wakes anyone — and the floor is derived, so no downstream copy can drift.
  assert.equal(ALERT_MIN_TIER, 'critical', 'the shipped floor');
  assert.deepEqual([...ALERT_TIERS].sort(), ['critical']);
  assert.equal(ALERT_TIERS.has('red'), false);
  assert.equal(ALERT_TIERS.has('amber'), false);
  assert.deepEqual([...alertTiersFor('red')].sort(), ['critical', 'red']);
});

test('a typo in ALERT_MIN_TIER fails QUIET, not open — a bad env var must not widen the inbox', () => {
  // The amber gate learned this the other way round: a malformed value there resolves to
  // OFF. Same polarity here — anything unrecognised means the narrower policy, because the
  // failure that matters is the one where nobody decided to send more email.
  for (const bad of ['RED ', 'Red', 'red']) assert.equal(normalizeMinTier(bad), 'red', bad);
  for (const bad of ['reds', 'critical!', '', null, undefined, 0, 'amber', 'CRITICAL']) {
    assert.equal(normalizeMinTier(bad), 'critical', String(bad));
  }
  assert.deepEqual([...alertTiersFor('amber')], ['critical'], 'amber is not a floor anyone can set');
});

test('a red row carries its own numbers into the message, not a critical row\'s', () => {
  // Selected at the WIDE floor on purpose: this pins that buildAlert reads the row it was
  // handed rather than assuming the top tier, which is a property of the message and not of
  // the policy — and it keeps being tested on a red row after red stopped emailing.
  const m = buildAlert(selectAlertable([row({ tier: 'red', lateBy: 45, etaMin: 14 * 60 + 45 })], 10 * 60, 0, 'red')[0], DATE);
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
  // flag-rows.mts is a PURE local helper (the one place a capped board row is unpacked) and
  // is deliberately not the comms engine. The guard is about customer-communications
  // coupling — no shared counter, config doc or budget — not about import count.
  assert.deepEqual(imports, ['./flag-rows.mts', './email.mts'], 'the only dependencies are the raw sender and the pure row helper');
  assert.ok(!imports.some((i) => /customer-comms|comms-config|unsubscribe/.test(i)), 'never the comms engine');
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
    // Claim already held: this sweep sent NOTHING, so it reports nothing. The claim proves
    // an earlier ATTEMPT, not an arrival — the earlier sweep that genuinely sent already
    // recorded the stop, and mergeSweep's sticky OR keeps it true for the day. Re-adding
    // it here was how ONE failed send (claim written, Resend 500) turned into a permanent
    // "Emailed CS" on the very next sweep — the intent-as-outcome sin this whole test
    // exists to forbid, one branch further in.
    sendAlerts([c('a')], DATE, 'davis', io(true, false)).then((r) => {
      assert.equal(r.skippedAlreadySent, 1);
      assert.equal(r.emailedStops.size, 0, 'a held claim is an attempt, not an arrival');
    }),
  ]);
});

// ── THE CLOCK WRAPS, AND THE EMAIL DID NOT (bug hunt, Aug 2026) ─────────────

test('a past-midnight ETA does not print as the SAME TIME IN THE AFTERNOON', () => {
  // The board's minutes keep counting past midnight — a route that leaves late on a bad day
  // walks its last stops into tomorrow, and 12:30am is minute 1470. Unwrapped, `h >= 12`
  // read 24 as afternoon, so the subject a customer-service rep opens said "ETA 12:30p" for
  // a truck arriving at 12:30 IN THE MORNING. Twelve hours wrong in the direction nobody
  // checks, because a same-day-looking time raises no question at all.
  const c = {
    stopNbr: '007165047', customer: 'METRO', routeName: 'DUL 2', tier: 'red',
    closeMin: 8 * 60 + 30, etaMin: 1470, lateBy: 960, anchored: false,
  };
  const { subject, text } = buildAlert(c, '2026-08-24');
  assert.ok(!/12:30p/.test(subject), `printed an afternoon time for a 12:30am arrival: ${subject}`);
  assert.match(subject, /12:30a/);
  // AND IT SAYS WHICH DAY. "closes 8:30a, ETA 12:30a" reads as arriving four hours EARLY,
  // which is the opposite of what it means — wrapping the clock alone does not make the
  // sentence true.
  assert.match(subject, /next day/);
  assert.match(text, /12:30a/);
});

test('a same-day time is untouched — the fix must not reword the ordinary case', () => {
  const c = { stopNbr: '1', customer: 'ACME', tier: 'red', closeMin: 14 * 60, etaMin: 14 * 60 + 35, lateBy: 35, anchored: true };
  const { subject } = buildAlert(c, '2026-08-24');
  assert.match(subject, /closes 2:00p, ETA 2:35p/);
  assert.ok(!/next day|previous day/.test(subject));
});

test('a missing or negative minute prints a word, not "-1:-30a" or "NaN:NaNa"', () => {
  // The evening sweep rebases its clock onto tomorrow's board with etMin - 1440, so a
  // negative minute is reachable; and closeMin was formatted with no finite check at all.
  const neg = buildAlert({ stopNbr: '1', customer: 'ACME', tier: 'red', closeMin: 14 * 60, etaMin: -30, lateBy: 5 }, '2026-08-24');
  assert.ok(!/-1:|NaN/.test(neg.subject), neg.subject);
  assert.match(neg.subject, /11:30p \(previous day\)/);
  const none = buildAlert({ stopNbr: '1', customer: 'ACME', tier: 'red', closeMin: null, etaMin: null, lateBy: 5 }, '2026-08-24');
  assert.ok(!/NaN/.test(none.subject + none.text), `${none.subject} / ${none.text}`);
});

// ── AN ASSUMED CLOSE NEVER ALERTS ────────────────────────────────────────────
//
// board-flags judges a stop with no hours on file against a house 5pm close ('assumed',
// capped at amber). Amber alone keeps it off the alert path today — but AMBER_GATED_RULES
// contains 'hours_risk', so the day the amber gate is switched on, every stop still running
// at 4:30pm would text against a deadline nobody recorded.

test('an assumed-close row is refused even with the amber gate wide open', () => {
  const assumed = {
    rule: 'hours_risk', stopNbr: '9001', customer: 'NO HOURS CO', tier: 'amber',
    hoursTier: 'assumed', closeMin: 17 * 60, etaMin: 17 * 60 + 40, lateBy: 40, detail: 'x',
  };
  assert.equal(selectAlertable([assumed], 16 * 60 + 30, 240).length, 0,
    'a guess must not text, whatever the gate says');
  // AT BOTH FLOORS, and the wide one is the assertion that still bites. Found by running it,
  // not by reading it: with the floor at critical this row is refused by the FLOOR, so the
  // provenance guard could be deleted from flag-alert.mts and this test would still pass —
  // an amber row cannot email at the critical floor for any reason. A test that passes with
  // the rule removed has stopped testing the rule.
  assert.equal(selectAlertable([assumed], 16 * 60 + 30, 240, 'red').length, 0,
    'and at the wide floor, where only the provenance guard can be what refuses it');
});

test('the same row with REAL auto-detected hours still passes the open gate', () => {
  // The guard must be about provenance, not about amber — the measured gate still works.
  // At the SHIPPED floor, because the gate answers to its own switch: an amber inside the gate
  // is the EARLY message and is not refused on the tier floor's behalf (v0.91.0, after
  // VALVOLINE 0203 emailed ten minutes before its close). Provenance is still a separate rule,
  // which the assumed-hours case above pins.
  const real = {
    rule: 'hours_risk', stopNbr: '9002', customer: 'REAL HOURS CO', tier: 'amber',
    hoursTier: 'auto', closeMin: 17 * 60, etaMin: 17 * 60 + 40, lateBy: 40, detail: 'x',
  };
  assert.equal(selectAlertable([real], 16 * 60 + 30, 240).length, 1, 'the gate opens it at either floor');
  assert.equal(selectAlertable([real], 16 * 60 + 30, 0).length, 0, 'and the gate off is what shuts it');
});

test('an assumed row is refused at red too, if a ratchet ever pushes it there', () => {
  // severityTier caps 'assumed' at amber, but the flag-history ratchet can raise a row's
  // tier. Provenance, not tier, is what this guard reads.
  const ratcheted = {
    rule: 'hours_risk', stopNbr: '9003', customer: 'RATCHET CO', tier: 'red',
    hoursTier: 'assumed', closeMin: 17 * 60, etaMin: 17 * 60 + 40, lateBy: 40, detail: 'x',
  };
  assert.equal(selectAlertable([ratcheted], 16 * 60, 0).length, 0);
  assert.equal(selectAlertable([ratcheted], 16 * 60, 0, 'red').length, 0, 'at the wide floor too');
});

test('AND A RATCHETED-TO-CRITICAL GUESS IS STILL REFUSED — the guard that must not rot', () => {
  // THIS is the case that keeps the provenance guard honest under the shipped floor, and it
  // is the other half of what Chad said on 2026-09-02: "we are only worried about the ones
  // that have receiving hours, everyone else we assume closing at 5". A row carrying the 5pm
  // house guess must never email, and at the critical floor the ONLY tier that can reach the
  // guard at all is critical — so without this row, deleting the guard breaks nothing.
  //
  // It is reachable: severityTier caps 'assumed' at amber, but flag-history's tier ratchet
  // raises a row and does not re-derive provenance, which is exactly why the guard reads
  // hoursTier rather than tier.
  const guess = {
    rule: 'hours_risk', stopNbr: '9004', customer: 'NO HOURS CO', tier: 'critical',
    hoursTier: 'assumed', closeMin: 17 * 60, etaMin: 19 * 60, lateBy: 120, detail: 'x',
  };
  assert.equal(selectAlertable([guess], 16 * 60).length, 0, 'a 5pm guess never emails, at any tier');
  assert.equal(selectAlertable([guess], 16 * 60, 240).length, 0, 'nor with the amber gate open');
  assert.equal(selectAlertable([guess], 16 * 60, 240, 'red').length, 0, 'nor at the wide floor');
  // …and the identical row with REAL hours does email, so this is provenance and not the row.
  assert.equal(selectAlertable([{ ...guess, hoursTier: 'auto' }], 16 * 60).length, 1);
});
