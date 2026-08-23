// TWO MONTHS OF FIRST-DELIVERY STAMPS WERE SITTING UNREAD IN THE WAREHOUSE.
//
// Chad: "we have a lot more data as to when those routes made their first deliveries than
// just a couple of days. We have a couple months we could study to procure better results."
// He was right twice over: the departure fit's window only read day-docs carrying a
// `departures` field, which exist since 2026-08-20 — so the table crawled from two days
// toward a full window at one day per night while the sealed history behind it went unread,
// permanently. The nightly now backfills the field into windowed day-docs from the sealed
// stops themselves. These tests pin the DECISION of when a day still needs that scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsDepartureBackfill } from '../netlify/functions/eta-miss-ledger-background.mts';

test('a day-doc written before v0.64.0 — samples but no departures key — gets backfilled', () => {
  assert.equal(needsDepartureBackfill({ tenant: 'davis', date: '2026-07-15', samples: [{ meters: 1, gapMin: 2 }] }), true);
});

test('a missing day-doc gets one too — the sealed stops may still exist for that day', () => {
  assert.equal(needsDepartureBackfill(null), true);
  assert.equal(needsDepartureBackfill(undefined), true);
});

test('the KEY is the stamp: an EMPTY departures map means "scanned, nothing usable" — never rescan it', () => {
  // Without this, a weekend or an uncaptured day would re-list ~800 stop docs every night
  // forever, for nothing.
  assert.equal(needsDepartureBackfill({ departures: {} }), false);
});

test('a day that already carries departures is left alone', () => {
  assert.equal(needsDepartureBackfill({ departures: { WILLIAM: 314 } }), false);
});
