// test/territory-sheet-dropped-stops.test.mjs — client-orders-labels-territory-libs-5.
//
// The printed driver-area sheet's "What this is built from" box says how many history stops
// were left out for having no ZIP or no driver. It counted them from the list AFTER the stops
// without a driver had already been filtered away, so it could only ever print "0 had no
// driver" — and when no stop lacked a ZIP it printed nothing about dropped stops at all.
// A trainee holding the paper was told a false zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import { territorySheetHtml } from '../src/lib/territory-sheet-html.js';

const DATES = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
const usable = (n) => Array.from({ length: n }, (_, i) => ({
  driverUserName: 'JSMITH', zip: '30518', city: 'BUFORD', lat: 34.12, lng: -84.0, boardDate: DATES[i % 5],
}));
const noZip = (n) => Array.from({ length: n }, (_, i) => ({
  driverUserName: 'JSMITH', zip: '', city: 'BUFORD', boardDate: DATES[i % 5],
}));
const noDriver = (n) => Array.from({ length: n }, (_, i) => ({
  driverUserName: '', driverName: '', zip: '30518', city: 'BUFORD', boardDate: DATES[i % 5],
}));
const builtFrom = (stops) => {
  const html = territorySheetHtml({ generatedAt: '2026-09-22', window: { from: DATES[0], to: DATES[4] }, roster: null, stops, maybeSame: [], readFailures: [] });
  const m = html.match(/What this is built from\.<\/b>[\s\S]*?(?=<br>)/);
  return (m ? m[0] : '').replace(/\s+/g, ' ');
};

test('a printed sheet built from history with driverless stops says how many had no driver, not zero', () => {
  const line = builtFrom([...usable(10), ...noZip(4), ...noDriver(6)]);
  assert.match(line, /10 deliveries/, 'the usable count is still the sheet\'s own');
  assert.match(line, /4 stops had no usable ZIP/);
  assert.match(line, /6 had no driver/, `six driverless stops were left out and the sheet must say so: ${line}`);
  assert.doesNotMatch(line, /\b0 had no driver/, 'never a false zero');
});

test('a printed sheet where every stop has a ZIP still reports the stops left out for having no driver', () => {
  const line = builtFrom([...usable(10), ...noDriver(6)]);
  assert.match(line, /6 stops had no driver/, `the dropped-stop sentence must not vanish: ${line}`);
  assert.doesNotMatch(line, /no usable ZIP/, 'and it does not invent a ZIP shortfall');
});

test('a printed sheet with nothing left out says nothing about dropped stops', () => {
  const line = builtFrom(usable(10));
  assert.doesNotMatch(line, /left out/);
});
