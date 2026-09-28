// fmt-et-date.test.mjs — a timestamp reads the DOCK's calendar day, not London's.
//
// fmtDate took a regex shortcut for anything starting YYYY-MM-DD, which includes
// a full ISO instant. Every instant this app stores is UTC, so from 8pm ET (EDT)
// or 7pm ET (EST) until midnight the date printed beside the ET clock time was
// TOMORROW: a lockout ending at 9:30pm on Sep 9 read "Sep 10, 2026 9:30p".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmtDate, fmtDateTime } from '../src/lib/fmt.js';

test('a PIN lockout that ends at 9:30pm ET on Sep 9 reads Sep 9, not Sep 10', () => {
  // 2026-09-10T01:30Z is Wednesday Sep 9, 9:30pm EDT.
  assert.equal(fmtDateTime('2026-09-10T01:30:00.000Z'), 'Sep 9, 2026 9:30p');
  assert.equal(fmtDate('2026-09-10T01:30:00.000Z'), 'Sep 9, 2026');
});

test('a scan at 7:15pm ET in winter (EST) still reads the ET day', () => {
  // 2026-12-03T00:15Z is Wednesday Dec 2, 7:15pm EST.
  assert.equal(fmtDateTime('2026-12-03T00:15:00.000Z'), 'Dec 2, 2026 7:15p');
});

test('a Date object is read on the dock clock too', () => {
  assert.equal(fmtDate(new Date('2026-09-10T01:30:00.000Z')), 'Sep 9, 2026');
});

test('a bare shift day is printed as written — never shifted by a timezone', () => {
  // A YYYY-MM-DD key names a day, not an instant: it must not move.
  assert.equal(fmtDate('2026-09-10'), 'Sep 10, 2026');
  assert.equal(fmtDate('2026-01-01'), 'Jan 1, 2026');
});

test('a daytime ET instant is unchanged', () => {
  assert.equal(fmtDateTime('2026-09-10T14:05:00.000Z'), 'Sep 10, 2026 10:05a');
});

test('nothing, or nonsense, prints nothing', () => {
  assert.equal(fmtDate(''), '');
  assert.equal(fmtDate(null), '');
  assert.equal(fmtDate('not a date'), '');
  assert.equal(fmtDateTime(undefined), '');
});
