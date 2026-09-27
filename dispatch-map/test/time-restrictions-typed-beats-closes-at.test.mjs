// A DISPATCHER WHO PHONED THE DOCK OUTRANKS ONE UNUSUAL LINE ON ONE ORDER.
//
// The module's own rule (classifyStopTimeRestriction): "Typed hours (a dispatcher entered
// them) outrank the scanner's reading of Uline's text". The 'CLOSES AT' override below the
// hours block ran unconditionally, so a customer a dispatcher had typed in as 7a-5p Thursday
// came out of the PRO report as "closes 2:00p, this order" the day an order said CLOSES AT
// 2 PM — the typed window thrown away and its source relabelled as the order text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStopTimeRestriction } from '../src/lib/time-restrictions.js';

const THU = '2026-09-10'; // a Thursday
const stop = (instr) => ({
  primaryPro: '007170000',
  businessName: 'ACME WAREHOUSE',
  scheduledFrom: `${THU}T08:00:00`,
  scheduledTo: `${THU}T20:00:00`,
  signalSources: { orderInstructions: `SPL-INSTR-TEXT: ${instr}` },
});
const typedNote = {
  receiving_hours: { thu: { open: '07:00', close: '17:00' } },
  manual_overrides: { receiving_hours: true },
};

test('hours a dispatcher typed survive an order that says "CLOSES AT 2 PM"', () => {
  const r = classifyStopTimeRestriction(stop('CLOSES AT 2 PM'), typedNote, THU);
  // 7a-5p is a working day, so with the typed hours standing nothing constrains the clock.
  assert.ok(r === null || (r.openMin === 7 * 60 && r.closeMin === 17 * 60),
    `the typed 7a-5p window was replaced: ${JSON.stringify(r && { openMin: r.openMin, closeMin: r.closeMin, hoursProvenance: r.hoursProvenance, hoursLabel: r.hoursLabel })}`);
});

test('typed early-close hours stay the dispatcher’s, attributed to the dispatcher', () => {
  const note = { receiving_hours: { thu: { open: '07:00', close: '13:00' } }, manual_overrides: { receiving_hours: true } };
  const r = classifyStopTimeRestriction(stop('CLOSES AT 2 PM'), note, THU);
  assert.equal(r.closeMin, 13 * 60, 'the typed 1p close stands');
  assert.equal(r.openMin, 7 * 60, 'the typed open stands');
  assert.equal(r.hoursTier, 'typed');
  assert.equal(r.hoursProvenance, 'dispatcher');
  assert.ok(!r.sources.includes('Order instructions (closing time)'));
});

test('with nothing typed, "CLOSES AT" still outranks the scanner and clears its invented open', () => {
  const r = classifyStopTimeRestriction(stop('CLOSES AT 11 30 AM'), null, THU);
  assert.equal(r.closeMin, 11 * 60 + 30);
  assert.equal(r.openMin, null);
  assert.equal(r.hoursProvenance, 'order-text');
});
