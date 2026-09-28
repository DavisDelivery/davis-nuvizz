// test/labels-other-day-not-printed.test.mjs
//
// PRINT LABELS LISTED YESTERDAY'S ORDERS UNDER TOMORROW'S HEADING (audit 2026-09-27, app-A3-8).
//
// The Print labels screen kept the last answer on screen while the next day's read was out, and
// only checked that the answer was for the SAME SHIPPER. Change the day and keep the shipper —
// Estes today, tap Tomorrow — and today's Estes orders stayed listed under "Estes · <tomorrow>",
// with "Print all · N pages" live. On a heavy day that read covers the board, saved labels and
// customer notes and can take seconds; a tap in that window prints today's labels for a stack of
// tomorrow's freight. The endpoint says which day it answered (labels-by-shipper.mts `date`); the
// screen never compared it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { labelRowsForPick } from '../src/lib/label-shippers.js';
import { labelsAnswer } from '../scripts/lib/labels-fixture.mjs';

const ESTES_TODAY = {
  ok: true, date: '2026-09-27', shipper: { key: 'ESTES', name: 'Estes' },
  rows: [{ stopNbr: 'ESTES-0538243875', pages: 2 }, { stopNbr: 'ESTES-0538243876', pages: 1 }],
};

test('Tomorrow tapped on Estes: today\'s Estes orders are not listed (or printable) while tomorrow loads', () => {
  assert.deepEqual(labelRowsForPick(ESTES_TODAY, '2026-09-28', 'ESTES'), []);
});

test('the answer for the day and shipper on screen is listed as it came', () => {
  assert.equal(labelRowsForPick(ESTES_TODAY, '2026-09-27', 'ESTES'), ESTES_TODAY.rows);
});

test('another shipper\'s answer is still not listed under this one', () => {
  assert.deepEqual(labelRowsForPick(ESTES_TODAY, '2026-09-27', 'AVRT'), []);
});

test('nothing read yet, a day-only answer, or no rows is an empty list, never a crash', () => {
  assert.deepEqual(labelRowsForPick(null, '2026-09-27', 'ESTES'), []);
  assert.deepEqual(labelRowsForPick({ ok: true, date: '2026-09-27', shippers: [] }, '2026-09-27', 'ESTES'), []);
  assert.deepEqual(labelRowsForPick({ ...ESTES_TODAY, rows: undefined }, '2026-09-27', 'ESTES'), []);
});

test('the Print labels screen lists only the answer for the day AND shipper it is showing', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const screen = app.slice(app.indexOf('function LabelsScreen('), app.indexOf('\nfunction ', app.indexOf('function LabelsScreen(') + 1));
  assert.match(screen, /const rows = useMemo\(\(\) => labelRowsForPick\(data, date, shipper\), \[data, date, shipper\]\);/);
});

test('the layout guards\' stub answers for the day asked, as the endpoint does — so they still measure a real list', () => {
  const a = labelsAnswer('/.netlify/functions/labels-by-shipper?date=2031-01-02&shipper=ESTES');
  assert.equal(a.date, '2031-01-02');
  assert.ok(labelRowsForPick(a, '2031-01-02', 'ESTES').length > 0);
  assert.equal(labelsAnswer('/.netlify/functions/labels-by-shipper?date=2031-01-02').date, '2031-01-02');
  assert.equal(labelsAnswer('/.netlify/functions/labels-by-shipper?date=2031-01-02&shipper=NOPE').date, '2031-01-02');
});
