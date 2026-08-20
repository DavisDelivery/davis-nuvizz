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

const ENV = { FLAG_SMS_TO: '6789774808', FLAG_SMS_TO_NIGHT: '7703133517' };

test('Zach rides the 9pm and 5:59a sweeps — and is dropped at 6:00a SHARP', () => {
  assert.deepEqual(smsRecipients(ENV, 21 * 60), ['6789774808', '7703133517'], '9pm: both');
  assert.deepEqual(smsRecipients(ENV, 5 * 60 + 59), ['6789774808', '7703133517'], '5:59a: both');
  assert.deepEqual(smsRecipients(ENV, NIGHT_CUTOFF_MIN), ['6789774808'], '6:00a: Chad only');
  assert.deepEqual(smsRecipients(ENV, 6 * 60 + 30), ['6789774808'], '6:30a: Chad only');
});

test('recipients come from env and tolerate absence — no number is ever hard-coded', () => {
  assert.deepEqual(smsRecipients({}, 21 * 60), []);
  assert.deepEqual(smsRecipients({ FLAG_SMS_TO: 'a, b ,,', FLAG_SMS_TO_NIGHT: 'b' }, 21 * 60), ['a', 'b'], 'deduped, trimmed');
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
