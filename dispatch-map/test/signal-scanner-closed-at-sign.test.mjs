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
