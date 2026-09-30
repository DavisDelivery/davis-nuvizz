// EVERY LATE STOP GETS ITS BADGE (Chad, 2026-09-30: "I see bugs one through three, and those look
// like something I want to fix." — bug 2). The flag engine folds more than 12 red (25 amber, 40
// critical) rows of one rule into a single summary row for the PANEL. The Compare card's late check
// read only rows naming a stop, so a card with 13 late stops showed none, and Time windows scored
// such a card as having no late stops at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routePreflight, preflightCountsEveryLateStopEnabled } from '../src/lib/route-preflight.js';
import { timeWindowSequence } from '../src/lib/time-window-sequence.js';
import { RED_CAP } from '../src/lib/board-flags.js';

const DEPOT = { lat: 34.147791, lng: -83.960911 };   // the real Buford depot
const DEG = 1 / 69.055;
const DATE = '2026-09-07';   // a Monday

// n stops strung out north of the depot, a mile or two apart, one customer each.
const line = (n) => Array.from({ length: n }, (_, i) => ({
  stopNbr: `S${i + 1}`, matchKey: `c${i + 1}`, businessName: `CO ${i + 1}`,
  lat: DEPOT.lat + (6 + i * 1.5) * DEG, lng: DEPOT.lng,
  normalizedStatus: 'PLANNED', status: '10', stopType: 'DL', driverName: 'DRV', driverUserName: 'd',
}));
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const args = (stops, notes, over = {}) => ({
  order: stops.map((s) => s.stopNbr), stopById: new Map(stops.map((s) => [s.stopNbr, s])), notes,
  routeKey: 'BEN 2', servedDate: DATE, dayKey: 'mon', depot: DEPOT, departMin: 8 * 60, ...over,
});
// Every one of the first `late` stops gets a dispatcher-typed close 15 minutes BEFORE the card
// reaches it: a real, confident miss on each.
function cardWithLate(n, late) {
  const stops = line(n);
  const eta = new Map(routePreflight(args(stops, new Map())).stops.map((s) => [s.stopNbr, s.etaMin]));
  const notes = new Map(stops.slice(0, late).map((s) => [s.matchKey, {
    manual_overrides: { receiving_hours: true },
    receiving_hours: { mon: { open: '06:00', close: hm(eta.get(s.stopNbr) - 15) } },
  }]));
  return { stops, notes };
}

test(`12 late stops: 12 badges — under the cap, nothing changes (RED_CAP is ${RED_CAP})`, () => {
  const { stops, notes } = cardWithLate(16, 12);
  assert.equal(routePreflight(args(stops, notes)).lateCount, 12);
  assert.equal(routePreflight(args(stops, notes, { countCollapsed: false })).lateCount, 12, 'the old reading agreed here');
});

test('13 late stops: 13 badges, where the old reading showed a clean card', () => {
  const { stops, notes } = cardWithLate(16, 13);
  const p = routePreflight(args(stops, notes));
  assert.equal(p.lateCount, 13);
  assert.deepEqual(p.late.map((s) => s.stopNbr), stops.slice(0, 13).map((s) => s.stopNbr), 'the right stops, in card order');
  for (const s of p.late) {
    assert.ok(s.lateBy >= 14 && s.lateBy <= 16, `${s.stopNbr} is ${s.lateBy} min late`);
    assert.equal(s.hoursTier, 'typed');
    assert.ok(Number.isFinite(s.closeMin));
    assert.equal(typeof s.hopeless, 'boolean', 'judged for can\'t-make like any late stop');
  }
  assert.ok(p.worstTier);
  // THE BUG, pinned so the switch provably puts it back.
  const old = routePreflight(args(stops, notes, { countCollapsed: false }));
  assert.equal(old.lateCount, 0);
});

test('Time windows can no longer "fix" a card by pushing it past the cap — the 23 → 0 that was really 26', () => {
  // 30 stops, no hours on file, rolling at 2:30p: 23 stops past the assumed 5:00p close, under the
  // 25-amber cap. The old reading let the search make three more stops late, fold all 26 into one
  // summary row, and report "23 late → 0 late" for an order that was worse.
  const stops = line(30).map((s, i) => ({ ...s, lng: DEPOT.lng + ((i % 3) - 1) * 0.02 }));
  const a = { ...args(stops, new Map()), departMin: 14 * 60 + 30, maxEvals: 3000 };
  const trulyLate = (order) => routePreflight({ ...a, order }).lateCount;

  // The search as it was then: the cap unread, and no miles price (v1.99.x's price would refuse the
  // longer order on its own, which is a different fix — pinned in time-window-sequence.test.mjs).
  const off = timeWindowSequence({ ...a, countCollapsed: false, milesCap: false });
  assert.equal(off.before.late, 23);
  assert.equal(off.after.late, 0, 'the old reading: it reported every late stop cleared');
  assert.ok(trulyLate(off.order) > 23, `that order really has ${trulyLate(off.order)} late`);

  const on = timeWindowSequence(a);
  assert.equal(on.before.late, 23);
  assert.ok(on.after.late <= 23);
  assert.equal(on.after.late, trulyLate(on.order), 'what it reports is what the card shows');
});

test('switch: on unless an explicit off-word — a typo never turns the fix off', () => {
  assert.equal(preflightCountsEveryLateStopEnabled({}), true);
  assert.equal(preflightCountsEveryLateStopEnabled(undefined), true);
  for (const v of ['off', 'OFF', ' 0 ', 'false', 'no']) assert.equal(preflightCountsEveryLateStopEnabled({ VITE_PREFLIGHT_COUNTS_EVERY_LATE_STOP: v }), false, v);
  for (const v of ['on', '1', 'of', 'disable', '']) assert.equal(preflightCountsEveryLateStopEnabled({ VITE_PREFLIGHT_COUNTS_EVERY_LATE_STOP: v }), true, `"${v}" leaves it on`);
});
