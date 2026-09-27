// "CLOSED FRIDAYS @ 12PM" IS AN EARLY CLOSE, NOT A DAY OFF.
//
// The customer is open Friday morning. The hours scanner has always read '@' the same as
// 'AT' for this form (dayCloseRes: "(?:AT|@)") and records Friday closing at noon — but the
// closed-day scanner's early-close tail accepted only the word AT, so the same sentence was
// ALSO marked a closed Friday. The closed-day badge wins on the board, so dispatch skipped a
// morning the customer had said was deliverable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanStopFull } from '../src/lib/signal-scanner.ts';

const scan = (instr) => scanStopFull({ signalSources: { orderInstructions: instr } });
const days = (instr) => scan(instr).closedDays.map((c) => c.day).sort();

test('a customer who writes "CLOSED FRIDAYS @ 12PM" is not marked closed on Friday', () => {
  for (const txt of ['CLOSED FRIDAYS @ 12PM', 'CLOSED FRI @12PM', 'CLOSED ON FRIDAY @ NOON', 'CLOSED FRI AT12PM']) {
    assert.deepEqual(days(txt), [], `${txt} is an early close, not a closed day`);
  }
  // ...and the Friday noon close the hours scanner reads from it is still there.
  assert.deepEqual(scan('CLOSED FRIDAYS @ 12PM').hours.byDay.fri, { open: '', close: '12:00' });
});

test('the AT form was already right and stays right', () => {
  assert.deepEqual(days('CLOSED FRIDAYS AT 12PM'), []);
});

test('a real closed day is still a closed day', () => {
  assert.deepEqual(days('CLOSED FRIDAYS'), ['fri']);
  assert.deepEqual(days('CLOSED ON FRIDAYS @ THE WAREHOUSE'), ['fri']);
  assert.deepEqual(days('FRIDAY CLOSED'), ['fri']);
});

test('"FRIDAYS CLOSED @ 12PM" is a FRIDAY noon close, not a noon close every day', () => {
  // The closed-day scanner hands this word order to the hours scanner as an early close; the
  // hours scanner only read "FRIDAYS CLOSES AT", so the sentence fell through to the day-less
  // close-only form and every day of the week closed at noon.
  for (const txt of ['FRIDAYS CLOSED @ 12PM', 'FRIDAYS CLOSED AT 12PM', 'FRI CLOSED @NOON']) {
    const r = scan(txt);
    assert.deepEqual(r.closedDays, [], `${txt} is not a closed day`);
    assert.deepEqual(r.hours.byDay, { fri: { open: '', close: '12:00' } }, `${txt} closes Friday only`);
  }
  // The CLOSES form is unchanged.
  assert.deepEqual(scan('FRIDAYS CLOSES AT NOON').hours.byDay, { fri: { open: '', close: '12:00' } });
});
