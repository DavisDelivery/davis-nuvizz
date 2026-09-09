// THE EVENING FLAG TEXT — who, about which board, saying what.
//
// The rules here decide whether a phone buzzes at 9pm, so the tests pin the two
// promises Chad stated in words: Zach's texts STOP at 6:00a sharp, and the sweep aims
// at the board the routers are actually building — tomorrow's in the evening, today's
// after midnight, nobody's once the day sweep takes over at 7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  smsRecipients, eveningTargetDate, smsText, smsClaimPath, selectTextable,
  NIGHT_CUTOFF_MIN,
} from '../netlify/functions/lib/flag-sms.mts';

// FICTIONAL NUMBERS, AND THE REASON IS NOT PEDANTRY. These fixtures used to be two real
// Davis mobiles, committed and labelled by name in the assertions — in a file whose own module
// header says "phone numbers are personal data ... never in code". 555-01xx is the range
// reserved for fiction, so nothing here is anybody's phone and nothing here can collide with
// an env-var value Netlify's secrets scan greps for.
const ALWAYS = '6785550101';        // the standing list — rides every sweep
const ROUTER = '6785550102';        // the router on duty overnight, dropped at 6:00a
const ENV = { FLAG_SMS_TO: ALWAYS, FLAG_SMS_TO_NIGHT: ROUTER };

test('the overnight router rides the 9pm and 5:59a sweeps — and is dropped at 6:00a SHARP', () => {
  assert.deepEqual(smsRecipients(ENV, 21 * 60), [ALWAYS, ROUTER], '9pm: both');
  assert.deepEqual(smsRecipients(ENV, 5 * 60 + 59), [ALWAYS, ROUTER], '5:59a: both');
  assert.deepEqual(smsRecipients(ENV, NIGHT_CUTOFF_MIN), [ALWAYS], '6:00a: the standing list only');
  assert.deepEqual(smsRecipients(ENV, 6 * 60 + 30), [ALWAYS], '6:30a: the standing list only');
});

test('recipients come from env and tolerate absence — no number is ever hard-coded', () => {
  assert.deepEqual(smsRecipients({}, 21 * 60), []);
  assert.deepEqual(
    smsRecipients({ FLAG_SMS_TO: `${ALWAYS}, ${ROUTER} ,,`, FLAG_SMS_TO_NIGHT: ROUTER }, 21 * 60),
    [ALWAYS, ROUTER],
    'deduped, trimmed',
  );
});

test('AN ENV ENTRY THAT COULD NEVER BE DIALLED IS DROPPED BEFORE THE SEND, NOT AT IT', () => {
  // It used to survive the split and reach SimpleTexting, which refused it — so a typo in the
  // console became a `failed` counter in a status document nobody reads, on the one night the
  // text mattered. The same normalizePhone/validUsPhone the transport uses now runs here, so
  // the Diagnostics panel can NAME the bad entry while there is still time to fix it.
  assert.deepEqual(smsRecipients({ FLAG_SMS_TO: `nope, ${ALWAYS}` }, 21 * 60), [ALWAYS]);
  assert.deepEqual(smsRecipients({ FLAG_SMS_TO: '678-555-0101' }, 21 * 60), [ALWAYS], 'punctuation is normalised, not refused');
  assert.deepEqual(smsRecipients({ FLAG_SMS_TO: `+1 ${ALWAYS}` }, 21 * 60), [ALWAYS], 'a country code is stripped, as the sender strips it');
});

test('A LIST SAVED IN DIAGNOSTICS BEATS THE ENVIRONMENT — that is the whole point of the screen', () => {
  const SAVED = '6785550103';
  // One channel saved, the other not: the saved one wins, the untouched one still reads env.
  assert.deepEqual(
    smsRecipients(ENV, 21 * 60, { flagSmsTo: [SAVED] }),
    [SAVED, ROUTER],
    'the standing list is the saved one; the night list still comes from env',
  );
  // AND AN EMPTY SAVED LIST MEANS EMPTY. A control that silently reverts to an env var when
  // you clear it is a control that lies — see lib/alert-recipients.mts, decision 1.
  assert.deepEqual(smsRecipients(ENV, 21 * 60, { flagSmsTo: [] }), [ROUTER], 'cleared means cleared');
  assert.deepEqual(smsRecipients(ENV, 21 * 60, { flagSmsTo: [], flagSmsToNight: [] }), [], 'both cleared: nobody is texted');
  // The 6:00a cutoff is a rule about the JOB, not about whoever is on the list, so it still
  // applies to a saved night list.
  assert.deepEqual(smsRecipients(ENV, NIGHT_CUTOFF_MIN, { flagSmsToNight: [SAVED] }), [ALWAYS], '6:00a still drops the router');
});

test('an 8pm sweep judges TOMORROW; a 1am sweep judges TODAY; a 7am sweep stands down', () => {
  assert.deepEqual(eveningTargetDate('2026-08-19', 20 * 60), { date: '2026-08-20', offsetDays: 1 });
  assert.deepEqual(eveningTargetDate('2026-08-20', 1 * 60), { date: '2026-08-20', offsetDays: 0 });
  assert.deepEqual(eveningTargetDate('2026-08-20', 6 * 60 + 30), { date: '2026-08-20', offsetDays: 0 }, '6:30a still covers today (day sweep starts at 7)');
  assert.equal(eveningTargetDate('2026-08-20', 7 * 60), null, '7:00a belongs to the day sweep');
  assert.equal(eveningTargetDate('2026-08-20', 12 * 60), null, 'midday belongs to the day sweep');
});

test('the text carries the facts and names the board day', () => {
  const t = smsText({ customer: 'AWC INC', routeName: 'KOSTNER', etaMin: 13 * 60 + 5, closeMin: 11 * 60, lateBy: 125 }, '2026-08-20');
  assert.ok(t.includes('2026-08-20'), 'board day named');
  assert.ok(t.includes('AWC INC') && t.includes('KOSTNER'));
  assert.ok(t.includes('est 1:05p vs close 11:00a'), t);
  assert.ok(t.includes('125m past close'));
});

test('one text per stop per board day — the claim key ignores which sweep saw it', () => {
  assert.equal(smsClaimPath('davis', '2026-08-20', '9001'), 'eta_flag_sms/davis__2026-08-20__9001');
});

test('only red/critical hours_risk occurrences text — ambers and summaries stay on the board', () => {
  const rows = [
    { rule: 'hours_risk', tier: 'amber', scope: 'occurrence', stopNbr: '1', closeMin: 660, lateBy: 30 },
    { rule: 'hours_risk', tier: 'red', scope: 'occurrence', stopNbr: '2', closeMin: 660, lateBy: 40 },
    { rule: 'hours_risk', tier: 'critical', scope: 'occurrence', stopNbr: '3', closeMin: 660, lateBy: 200 },
    { rule: 'hours_risk', tier: 'red', scope: 'summary', closeMin: 660, lateBy: 999 },
    { rule: 'no_driver_hours', tier: 'red', scope: 'occurrence', stopNbr: '4' },
    { rule: 'hours_risk', tier: 'red', scope: 'occurrence', stopNbr: '5', closeMin: null, lateBy: 90 },
  ];
  const picked = selectTextable(rows);
  assert.deepEqual(picked.map((r) => r.stopNbr), ['3', '2'], 'worst first; amber, summary, R6, and closeless rows excluded');
});

test('the per-sweep cap holds worst-first', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    rule: 'hours_risk', tier: 'red', scope: 'occurrence', stopNbr: String(i), closeMin: 660, lateBy: i,
  }));
  const picked = selectTextable(rows, 3);
  assert.deepEqual(picked.map((r) => r.lateBy), [11, 10, 9]);
});
