// WHEN DID THE ROLL ACTUALLY LAND?
//
// Chad: "Want this to show date it actually delivered." The Flag history table could not,
// and for the one outcome where the DATE is the entire answer there was nothing to show:
// across the six scored days on file, all 56 `made` and all 37 `missed` rows carry a
// deliveredAt and all 11 `rolled` rows carry none.
//
// The scorer fetched the later day's board — the stamp was in memory — and reduced it to a
// Set of stop numbers before reading anything off it. These pin the record it keeps now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRow, needsOutcomeRescore } from '../netlify/functions/lib/flag-history.mts';

const NOON = 12 * 60;
const base = (o = {}) => ({
  stopNbr: 'ESTES-1171127388', customer: 'CARSON WEST',
  firstRoute: 'JIM 1', lastRoute: 'JIM 1', firstSeq: 3, lastSeq: 3,
  firstSeenMin: 8 * 60, firstSeenAt: '2026-08-25T12:00:00.000Z', lastSeenMin: 17 * 60,
  leadMin: 240, closeMin: 17 * 60, hoursTier: null, firstTier: 'amber', worstTier: 'red',
  firstEtaMin: null, lastEtaMin: null, worstLateBy: 40, sweeps: 9,
  anchored: false, emailed: false, matchKey: null,
  outcome: 'unknown', arrivalMin: null, deliveredAt: null, actedOn: false, scoredAt: null,
  ...o,
});
const AT = '2026-08-26T08:00:00.000Z';

test('a roll records WHEN and WHERE it landed, not just that it came back', () => {
  const r = scoreRow(base(), {
    arrivalMin: null, deliveredAt: null, finished: false, seenLater: true,
    rolledDeliveredAt: '2026-08-26T09:12:00', rolledOnDate: '2026-08-26', scoredAt: AT,
  });
  assert.equal(r.outcome, 'rolled');
  assert.equal(r.rolledDeliveredAt, '2026-08-26T09:12:00');
  assert.equal(r.rolledOnDate, '2026-08-26');
});

test('on a later board but not delivered there keeps the DATE and withholds the stamp', () => {
  // Present on a board is not delivered off it. The date still matters — it says which day
  // the freight is sitting on — but there is no delivery time to claim.
  const r = scoreRow(base(), {
    arrivalMin: null, deliveredAt: null, seenLater: true,
    rolledDeliveredAt: null, rolledOnDate: '2026-08-26', scoredAt: AT,
  });
  assert.equal(r.outcome, 'rolled');
  assert.equal(r.rolledDeliveredAt, null);
  assert.equal(r.rolledOnDate, '2026-08-26');
});

test('a made row never carries a later day’s stamp — one row, one delivery time', () => {
  // The later board is read once for the whole day, so every row is offered whatever the
  // lookup found. A stop that delivered on its own day must not end up with two answers.
  const r = scoreRow(base(), {
    arrivalMin: NOON - 30, deliveredAt: '2026-08-25T11:30:00', seenLater: true,
    rolledDeliveredAt: '2026-08-26T09:12:00', rolledOnDate: '2026-08-26', scoredAt: AT,
  });
  assert.equal(r.outcome, 'made');
  assert.equal(r.deliveredAt, '2026-08-25T11:30:00');
  assert.equal(r.rolledDeliveredAt, null);
  assert.equal(r.rolledOnDate, null);
});

test('a missed row does not either', () => {
  const r = scoreRow(base(), {
    arrivalMin: 17 * 60 + 8, deliveredAt: '2026-08-25T17:08:00', seenLater: true,
    rolledDeliveredAt: '2026-08-26T09:12:00', rolledOnDate: '2026-08-26', scoredAt: AT,
  });
  assert.equal(r.outcome, 'missed');
  assert.equal(r.rolledDeliveredAt, null);
});

test('an undelivered row carries no roll date — it never came back', () => {
  const r = scoreRow(base(), {
    arrivalMin: null, deliveredAt: null, seenLater: false,
    rolledDeliveredAt: null, rolledOnDate: '2026-08-26', scoredAt: AT,
  });
  assert.equal(r.outcome, 'undelivered');
  assert.equal(r.rolledOnDate, null);
});

test('a caller that passes nothing gets nulls, not undefined, on the stored row', () => {
  // These fields land in Firestore. `undefined` is not a value a document can hold.
  const r = scoreRow(base(), { arrivalMin: null, deliveredAt: null, seenLater: true, scoredAt: AT });
  assert.equal(r.outcome, 'rolled');
  assert.equal(r.rolledDeliveredAt, null);
  assert.equal(r.rolledOnDate, null);
});

// ── THE BACKFILL, AND WHY IT STOPS ───────────────────────────────────────────
const day = (rows, o = {}) => ({ rows, next_day_captured: true, ...o });

test('a settled day with an undated roll is re-scored — that is the backfill', () => {
  assert.equal(needsOutcomeRescore(day({ a: { outcome: 'rolled' } })), true);
  assert.equal(needsOutcomeRescore(day({ a: { outcome: 'rolled', rolledOnDate: null } })), true);
});

test('and it STOPS once the roll is dated, even with no delivery stamp on it', () => {
  // The terminator is rolledOnDate, not rolledDeliveredAt. Keying on the stamp would re-read
  // a genuinely still-open roll every night for ever, which is the sweep this guard exists
  // to keep cheap.
  assert.equal(needsOutcomeRescore(day({ a: { outcome: 'rolled', rolledOnDate: '2026-08-26', rolledDeliveredAt: null } })), false);
  assert.equal(needsOutcomeRescore(day({ a: { outcome: 'rolled', rolledOnDate: '2026-08-26', rolledDeliveredAt: '2026-08-26T09:12:00' } })), false);
});

test('the existing pending rules are untouched', () => {
  assert.equal(needsOutcomeRescore(day({ a: { outcome: 'made' } })), false);
  assert.equal(needsOutcomeRescore({ rows: { a: { outcome: 'made' } }, next_day_captured: false }), true);
  assert.equal(needsOutcomeRescore({ rows: {} }), false);
  assert.equal(needsOutcomeRescore(null), false);
  assert.equal(needsOutcomeRescore({ rows: null }), false);
});
