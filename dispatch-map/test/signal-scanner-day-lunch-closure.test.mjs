// A LUNCH CLOSURE WRITTEN AGAINST A DAY SPAN IS NOT THE DOCK'S RECEIVING WINDOW.
//
// "MON-FRI 12-1 FOR LUNCH" says the dock is shut from noon to one and open the rest of the
// day. The day-qualified tier of the hours scanner outranks every other tier and had no
// lunch guard, so it stored 12:00-1:00p as the ONLY hour the customer receives, Monday to
// Friday: every real delivery then flags late, and the router tries to cram the stop into
// the one hour nobody is on the dock. The bare-pair tier has refused a lunch context since
// it was written; #938 taught the day tier to refuse "CLOSED MON-FRI ..." but not LUNCH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanStopFull } from '../src/lib/signal-scanner.ts';

const hours = (instr) => scanStopFull({ signalSources: { orderInstructions: instr } }).hours;
const LUNCH = { open: '12:00', close: '13:00' };
const isLunchWindow = (h) => !!h && (
  (h.open === LUNCH.open && h.close === LUNCH.close)
  || Object.values(h.byDay || {}).some((w) => w.open === LUNCH.open && w.close === LUNCH.close)
);

test('a customer who writes "MON-FRI 12-1 FOR LUNCH" is not recorded as receiving only 12-1', () => {
  for (const txt of [
    'MON-FRI 12-1 FOR LUNCH',
    'LUNCH MON-FRI 12-1',
    'CLOSED FOR LUNCH MON-FRI 12-1PM',
    'MON-FRI 12PM-1PM CLOSED FOR LUNCH',
    'SPL-INSTR-TEXT: LUNCH BREAK\nSPL-INSTR-TEXT: MON-FRI 12-1',
  ]) {
    const h = hours(txt);
    assert.ok(!isLunchWindow(h), `${JSON.stringify(txt)} stored the lunch hour as receiving hours: ${JSON.stringify(h)}`);
  }
});

test('a lunch line under real hours leaves the real hours standing', () => {
  // "RH 8-5" is the window; the lunch line after it used to OVERWRITE Monday-Friday with 12-1.
  const a = hours('RH 8-5 CLOSED FOR LUNCH MON-FRI 12-1');
  assert.equal(a.open, '08:00');
  assert.equal(a.close, '17:00');
  assert.ok(!isLunchWindow(a));
  const b = hours('RH MON-FRI 8-5 LUNCH MON-FRI 12-1');
  assert.deepEqual(b.byDay.mon, { open: '08:00', close: '17:00' });
  assert.deepEqual(b.byDay.fri, { open: '08:00', close: '17:00' });
});

test('a real morning window followed by a named lunch is still the morning window', () => {
  // The guard refuses the LUNCH, not the range that happens to sit next to the word.
  assert.deepEqual(hours('MON-FRI 8-12 CLOSED FOR LUNCH 12-1').byDay.mon, { open: '08:00', close: '12:00' });
  assert.deepEqual(hours('MON-FRI 8-12 CLOSED FOR LUNCH').byDay.fri, { open: '08:00', close: '12:00' });
  // A working day next to the word LUNCH is still a working day, on the days it names.
  assert.deepEqual(hours('NO LUNCH MON-FRI 8-5').byDay.mon, { open: '08:00', close: '17:00' });
  assert.equal(hours('NO LUNCH MON-FRI 8-5').byDay.sat, undefined, 'the weekend was not written');
  assert.deepEqual(hours('NO LUNCH BREAK MON-FRI 7AM-4PM').byDay.tue, { open: '07:00', close: '16:00' });
  // A split day whose afternoon half is written out keeps its envelope.
  assert.deepEqual(hours('MON-FRI 8-12 LUNCH RH 1-5').byDay.wed, { open: '08:00', close: '17:00' });
  assert.deepEqual(hours('MON-FRI 8-12 LUNCH 12-1 RH 1-5').byDay.wed, { open: '08:00', close: '17:00' });
});

test('ordinary day-qualified schedules are untouched', () => {
  const h = hours('MON-THURS 6 30-4 / FRI 8-12');
  assert.deepEqual(h.byDay.mon, { open: '06:30', close: '16:00' });
  assert.deepEqual(h.byDay.fri, { open: '08:00', close: '12:00' });
});
