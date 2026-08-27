// HOW LONG HAS THIS FLAG BEEN UP?
//
// Chad, at 1:23pm on a critical card: "What time did Ben's flag first time show up? ... Ben's
// flag should have been there from first thing this morning as it was on his second load so
// should have flagged early."
//
// He was right and the board could not say so. These are built on the REAL history row for
// that flag, pulled from Firestore, so they pin the answer that was actually wanted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flagProvenance, provenanceLine, etClock, ageLabel } from '../src/lib/flag-provenance.js';

// Verbatim from eta_flag_history/davis__2026-08-27, stop 007168168.
const BEN = {
  stopNbr: '007168168', customer: 'PRIMERICA LIFE INSURANCE',
  firstSeenAt: '2026-08-27T08:01:02.412Z',   // 4:01am ET
  firstRoute: 'JIM 1', lastRoute: 'BEN 2',
  firstTier: 'amber', worstTier: 'critical', sweeps: 12,
};
const AT_1323 = Date.parse('2026-08-27T17:23:00Z');   // 1:23pm ET, when Chad asked

test('Ben’s flag reports the 4:01am it was actually first seen', () => {
  const p = flagProvenance(BEN, { currentRoute: 'BEN 2', nowMs: AT_1323 });
  assert.equal(p.since, '4:01am');
  assert.equal(p.ago, '9h 22m ago');
});

test('the route change is named — that is what hid it from him', () => {
  // It was on JIM 1 that morning, not Ben. Looking for it on Ben's board at 8am would have
  // found nothing, and the card shows only where the stop is NOW.
  const p = flagProvenance(BEN, { currentRoute: 'BEN 2', nowMs: AT_1323 });
  assert.equal(p.movedFrom, 'JIM 1');
  assert.match(provenanceLine(p), /moved from JIM 1/);
});

test('the escalation is named — it opened amber and became critical', () => {
  const p = flagProvenance(BEN, { currentRoute: 'BEN 2', nowMs: AT_1323 });
  assert.equal(p.escalatedFrom, 'amber');
});

test('the whole line, as it prints on the card', () => {
  assert.equal(
    provenanceLine(flagProvenance(BEN, { currentRoute: 'BEN 2', nowMs: AT_1323 })),
    'flagged 4:01am · 9h 22m ago · was amber · moved from JIM 1',
  );
});

// ── Never invent a time ──────────────────────────────────────────────────────
test('a flag the sweep has not recorded gets NO stamp, not "just now"', () => {
  // A brand-new flag, or a board the sweep does not cover, must print nothing. "just now" is
  // a claim, and a card that claims a time it does not have is the thing being fixed.
  for (const row of [null, undefined, {}, { firstSeenAt: null }, { firstSeenAt: 'nonsense' }, 'nope', 7]) {
    assert.equal(flagProvenance(row, { nowMs: AT_1323 }), null, `for ${JSON.stringify(row)}`);
  }
  assert.equal(provenanceLine(null), null);
});

test('a stop that never moved says nothing about routes', () => {
  const p = flagProvenance({ ...BEN, firstRoute: 'BEN 2' }, { currentRoute: 'BEN 2', nowMs: AT_1323 });
  assert.equal(p.movedFrom, null);
  assert.ok(!/moved from/.test(provenanceLine(p)));
});

test('case and padding do not fake a route change', () => {
  const p = flagProvenance({ ...BEN, firstRoute: ' ben 2 ' }, { currentRoute: 'BEN 2', nowMs: AT_1323 });
  assert.equal(p.movedFrom, null);
});

test('an unknown route on either side is silence, not "moved from blank"', () => {
  assert.equal(flagProvenance({ ...BEN, firstRoute: '' }, { currentRoute: 'BEN 2', nowMs: AT_1323 }).movedFrom, null);
  assert.equal(flagProvenance(BEN, { currentRoute: null, nowMs: AT_1323 }).movedFrom, null);
});

test('a flag that never escalated says nothing about tiers', () => {
  const p = flagProvenance({ ...BEN, firstTier: 'critical', worstTier: 'critical' }, { currentRoute: 'BEN 2', nowMs: AT_1323 });
  assert.equal(p.escalatedFrom, null);
});

test('a flag that DE-escalated is not reported as escalated', () => {
  const p = flagProvenance({ ...BEN, firstTier: 'critical', worstTier: 'amber' }, { currentRoute: 'BEN 2', nowMs: AT_1323 });
  assert.equal(p.escalatedFrom, null);
});

// ── The clock ────────────────────────────────────────────────────────────────
test('times read in Eastern, which is the only clock a dispatcher uses', () => {
  assert.equal(etClock('2026-08-27T08:01:02.412Z'), '4:01am');
  assert.equal(etClock('2026-08-27T00:30:00Z'), '8:30pm');   // previous ET evening
  assert.equal(etClock('2026-08-27T16:00:00Z'), '12:00pm');
  assert.equal(etClock('bad'), null);
  assert.equal(etClock(null), null);
});

test('age reads in the units the question was asked in', () => {
  const base = Date.parse('2026-08-27T12:00:00Z');
  assert.equal(ageLabel('2026-08-27T11:25:00Z', base), '35m ago');
  assert.equal(ageLabel('2026-08-27T02:00:00Z', base), '10h ago');
  assert.equal(ageLabel('2026-08-27T01:30:00Z', base), '10h 30m ago');
  assert.equal(ageLabel('2026-08-27T12:00:00Z', base), 'just recorded');
});

test('a stamp from the future is not a negative duration', () => {
  // Clock skew between the sweep host and the browser must not print "-3m ago".
  const base = Date.parse('2026-08-27T12:00:00Z');
  assert.equal(ageLabel('2026-08-27T12:30:00Z', base), null);
  assert.equal(ageLabel('2026-08-27T12:00:30Z', base), 'just recorded');
});
