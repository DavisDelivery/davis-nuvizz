// The early-close floor: a dock that shuts before lunch has no afternoon.
//
// Chad, 2026-09-22: "i want it to flag at 30 mins late for anything that closes at 11 am or
// before." Every test below names the real-world event rather than the branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  earlyCloseRed, EARLY_CLOSE_POLICY, severityTier, MODEL_ERROR_MIN, computeBoardFlags,
} from '../src/lib/board-flags.js';

const AWC = { closeMin: 11 * 60, lateBy: 77, hoursTier: 'auto' };

test('AWC INC: 77 minutes past an 11:00a close, overnight, is no longer a shrug', () => {
  // The night that caused this. Unanchored, so the model's own band is 90 and 77 does not
  // clear it — which is why the sweep texted nobody and Chad found it in the morning.
  assert.equal(severityTier({ lateBy: 77, errorMin: MODEL_ERROR_MIN.unanchored, hoursTier: 'auto' }), 'amber');
  assert.equal(earlyCloseRed(AWC), true);
});

test('30 minutes is the edge, and the edge is inclusive', () => {
  assert.equal(earlyCloseRed({ ...AWC, lateBy: 29 }), false);
  assert.equal(earlyCloseRed({ ...AWC, lateBy: 30 }), true);
});

test('11:00a is inside the population and 11:01a is outside it', () => {
  // Chad said "closes at 11 am or before", so 11:00 itself counts.
  assert.equal(earlyCloseRed({ closeMin: 11 * 60, lateBy: 45, hoursTier: 'typed' }), true);
  assert.equal(earlyCloseRed({ closeMin: 11 * 60 + 1, lateBy: 45, hoursTier: 'typed' }), false);
});

test('a 5pm dock 45 minutes late is still the model\'s business, not this rule\'s', () => {
  // The whole argument for the floor is that lateness is not symmetrical across the day.
  assert.equal(earlyCloseRed({ closeMin: 17 * 60, lateBy: 45, hoursTier: 'auto' }), false);
});

test('a house-assumed 5pm close can never earn a text through this door', () => {
  assert.equal(earlyCloseRed({ closeMin: 10 * 60, lateBy: 200, hoursTier: 'assumed' }), false);
});

test('absent, non-finite and malformed inputs stay quiet rather than firing blind', () => {
  assert.equal(earlyCloseRed({ closeMin: null, lateBy: 60, hoursTier: 'typed' }), false);
  assert.equal(earlyCloseRed({ closeMin: NaN, lateBy: 60, hoursTier: 'typed' }), false);
  assert.equal(earlyCloseRed({ closeMin: 10 * 60, lateBy: null, hoursTier: 'typed' }), false);
  assert.equal(earlyCloseRed({ closeMin: 10 * 60, lateBy: NaN, hoursTier: 'typed' }), false);
});

test('policy null turns the rule off — that is what FLAG_EARLY_CLOSE=off buys', () => {
  assert.equal(earlyCloseRed(AWC, null), false);
  assert.equal(earlyCloseRed(AWC, false), false);
});

test('a half-typed policy override keeps the shipped fields it did not name', () => {
  // House shape: malformed must never silently widen OR silence the rule.
  assert.equal(earlyCloseRed({ ...AWC, lateBy: 35 }, { redAtMin: 'banana' }), true);
  assert.equal(earlyCloseRed({ ...AWC, lateBy: 35 }, { closeAtOrBeforeMin: undefined }), true);
  // A named, valid override IS honoured — this is the dial Chad moved from 45 to 30.
  assert.equal(earlyCloseRed({ ...AWC, lateBy: 35 }, { ...EARLY_CLOSE_POLICY, redAtMin: 45 }), false);
});

test('MODEL_ERROR_MIN is untouched: critical still means what it meant', () => {
  // The 90 is a measurement over 24,238 stops, not a policy dial. If a future change edits
  // it to force a tier, this fails and says why.
  assert.equal(MODEL_ERROR_MIN.unanchored, 90);
  assert.equal(MODEL_ERROR_MIN.anchored, 15);
  // 77 past an 11am close is a red, NOT a critical: the floor promotes to red and stops.
  assert.equal(severityTier({ lateBy: 77, errorMin: 90, hoursTier: 'auto' }), 'amber');
});

// ── THROUGH THE WHOLE ENGINE, not just the predicate ─────────────────────────
//
// A pure-function test passes happily while the rule is wired to nothing, which is how a
// feature ships silently. These run a real board through computeBoardFlags.
//
// THE FIXTURE IS AUTO-DETECTED HOURS, AND THAT IS THE WHOLE POPULATION THIS RULE MOVES.
// severityTier already returns red for ANY predicted overrun against dispatcher-TYPED hours
// ("a human put that deadline on the record"), so a typed dock was never the silent case.
// The silent case is hours the scanner parsed out of order text — which is what AWC INC's
// 11:00a close is, and why the night Chad asked about produced an amber and no text. A first
// draft of this file used typed hours, went green, and proved nothing: every assertion was
// guarded behind a branch the fixture could not reach.
const DEPOT = { name: 'Buford Terminal', lat: 34.147791, lng: -83.960911 };
const DATE = '2026-08-17';                       // a Monday
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Ten stops, spaced so the pure 8:00a projection reaches stop 9 about an hour past an 11:00a
// close — 60 minutes late, which is INSIDE the model's 90-minute unanchored band and would
// therefore be an amber on its own. That is exactly the gap Chad is closing.
const stopsFor = () => Array.from({ length: 10 }, (_, idx) => {
  const i = idx + 1;
  return {
    stopNbr: `S${i}`, matchKey: `c${i}`, businessName: `CUST ${i}`, loadNbr: 'TESTLOAD',
    routeSeq: i, stopType: 'DL', lat: 34.147791 + i * 0.08, lng: -83.960911,
    normalizedStatus: 'PLANNED', status: '10',
    driverName: 'TEST DRIVER', driverUserName: 'tdriver',   // keeps R6 from superseding
  };
});

// No manual_overrides: these are parsed hours, tier 'auto'. See the note above.
const notesFor = (closeMin) => new Map([['c9', {
  receiving_hours: { mon: { open: '08:00', close: hhmm(closeMin) } },
}]]);

const hoursRowOf = (opts = {}, closeMin = 11 * 60) => {
  const out = computeBoardFlags({
    stops: stopsFor(), notes: notesFor(closeMin), servedDate: DATE, dayKey: 'mon',
    opts: { depot: DEPOT, nowMin: 8 * 60 + 5, ...opts },
  });
  return (out.rows || []).find((r) => r.rule === 'hours_risk' && r.stopNbr === 'S9') || null;
};

test('THE FIXTURE IS THE CASE: stop 9 lands inside the error band, not past it', () => {
  // If this drifts, every assertion below starts passing for the wrong reason.
  const row = hoursRowOf();
  assert.ok(row, 'the board must flag a dock it cannot reach before its 11:00a close');
  assert.equal(row.hoursTier, 'auto');
  assert.equal(row.errorMin, MODEL_ERROR_MIN.unanchored);
  assert.ok(row.lateBy >= EARLY_CLOSE_POLICY.redAtMin, `only ${row.lateBy} min late`);
  assert.ok(row.lateBy < MODEL_ERROR_MIN.unanchored, `${row.lateBy} min clears the band on its own`);
});

test('the engine carries the floor end to end, and the row says why', () => {
  const row = hoursRowOf();
  assert.equal(row.tier, 'red');
  assert.equal(row.earlyClose, true);
  assert.equal(row.modelTier, 'amber');
});

test('FLAG_EARLY_CLOSE=off puts this exact board back to the amber it used to be', () => {
  const off = hoursRowOf({ earlyClose: null });
  assert.ok(off, 'turning the floor off must not remove the row — only its tier can move');
  assert.equal(off.tier, 'amber');
  assert.equal(off.earlyClose, undefined);
  assert.equal(off.modelTier, undefined);
});

test('a 5:00p close on the same route is judged by the model alone', () => {
  const row = hoursRowOf({}, 17 * 60);
  if (row) assert.equal(row.earlyClose, undefined);
});

test('29 minutes past an 11:00a close is still an amber — the edge holds on the board too', () => {
  // 0.05 of a degree per leg lands stop 9 about 27 minutes past, just under Chad's 30.
  const stops = stopsFor().map((s, idx) => ({ ...s, lat: 34.147791 + (idx + 1) * 0.05 }));
  const out = computeBoardFlags({
    stops, notes: notesFor(11 * 60), servedDate: DATE, dayKey: 'mon',
    opts: { depot: DEPOT, nowMin: 8 * 60 + 5 },
  });
  const row = (out.rows || []).find((r) => r.rule === 'hours_risk' && r.stopNbr === 'S9');
  assert.ok(row && row.lateBy < EARLY_CLOSE_POLICY.redAtMin, 'fixture drifted past the edge');
  assert.equal(row.tier, 'amber');
  assert.equal(row.earlyClose, undefined);
});
