// A COLLAPSED PANEL ROW MUST NOT SILENCE THE INBOX.
//
// board-flags collapses a rule+tier bucket past its cap into ONE summary row carrying
// stopNbr: null, so the badge stays a number a person will read. selectAlertable drops rows
// with no stopNbr — correct for a data-quality batch, catastrophic for freight predicted to
// miss its window. Measured on the shipped engine before this fix:
//
//     12 red hours_risk rows -> 12 emails.  13 red rows -> ZERO.
//     25 amber rows -> 25 candidates.       26 -> ZERO.
//
// board-flags.js's own comment calls thirteen stops past their close "an ordinary bad day on
// a 700-stop board", so this was reachable, and the failure is silent by construction: one
// calm summary line is pixel-identical to a calm board. The summary row now carries its
// constituents so the alert path can judge them individually.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags, AMBER_CAP, RED_CAP } from '../src/lib/board-flags.js';
import { selectAlertable } from '../netlify/functions/lib/flag-alert.mts';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const NOW = 13 * 60, DEG = 1 / 69.055;

// n single-stop routes, each predicted past a 1:30p close. `typed` decides the tier:
// dispatcher-typed hours are red at any overrun; scanner hours stay amber inside the band.
const board = (n, { typed = false } = {}) => {
  const stops = [], notes = new Map();
  for (let i = 0; i < n; i += 1) {
    const k = `c${i}`;
    stops.push({
      stopNbr: `S${i}`, matchKey: k, businessName: `CO ${i}`, loadNbr: `R${i}`, routeName: `R${i}`,
      routeSeq: 1, stopType: 'DL', lat: DEPOT.lat + 55 * DEG, lng: DEPOT.lng,
      normalizedStatus: 'PLANNED', status: '10', driverName: 'DRV', driverUserName: 'd',
    });
    notes.set(k, {
      ...(typed ? { manual_overrides: { receiving_hours: true } } : {}),
      receiving_hours: { mon: { open: '06:00', close: '13:30' } },
    });
  }
  return computeBoardFlags({
    stops, notes, servedDate: '2026-08-17', dayKey: 'mon', rosterRows: [],
    opts: { depot: DEPOT, nowMin: NOW },
  });
};

test('THE BAD DAY: one more red than the cap must not email zero people', () => {
  const under = selectAlertable(board(RED_CAP, { typed: true }).rows, NOW);
  const over = selectAlertable(board(RED_CAP + 1, { typed: true }).rows, NOW);
  assert.equal(under.length, RED_CAP);
  assert.equal(over.length, RED_CAP + 1, 'the 13th red stop must not silence the other twelve');
});

test('the panel still collapses — this is an inbox fix, not a screen change', () => {
  const out = board(RED_CAP + 1, { typed: true });
  const rows = out.rows.filter((r) => r.rule === 'hours_risk');
  assert.equal(rows.length, 1, 'the panel still shows one summary line');
  assert.equal(rows[0].collapsed, RED_CAP + 1);
  assert.equal(rows[0].stopNbr, null, 'and the summary still refuses to claim to be a stop');
});

test('same cliff on the amber side, once the gate is switched on', () => {
  const under = selectAlertable(board(AMBER_CAP).rows, NOW, 120);
  const over = selectAlertable(board(AMBER_CAP + 1).rows, NOW, 120);
  assert.equal(under.length, AMBER_CAP);
  assert.equal(over.length, AMBER_CAP + 1);
});

test('and the gate still governs the recovered rows — off means off, even on a bad day', () => {
  assert.deepEqual(selectAlertable(board(AMBER_CAP + 1).rows, NOW), []);
});

test('every recovered candidate carries the facts the email needs, not a placeholder', () => {
  const [c] = selectAlertable(board(RED_CAP + 1, { typed: true }).rows, NOW);
  assert.ok(c.stopNbr, 'a real stop number');
  assert.ok(Number.isFinite(c.closeMin), 'a real close');
  assert.ok(Number.isFinite(c.lateBy), 'a real overrun');
  assert.match(c.customer, /CO \d+/, 'the customer, so the message names who is at risk');
});

test('the past-close refusal still applies to recovered rows', () => {
  // now is 2:00p, after the 1:30p close: nothing actionable is left in the message.
  assert.deepEqual(selectAlertable(board(RED_CAP + 1, { typed: true }).rows, 14 * 60), []);
});

test('a collapsed batch of a NON-alerting rule stays silent — this did not widen the rules', () => {
  const rows = [{
    rule: 'no_location', tier: 'red', stopNbr: null, collapsed: 30,
    collapsedRows: Array.from({ length: 30 }, (_, i) => ({
      rule: 'no_location', tier: 'red', stopNbr: `S${i}`, closeMin: 14 * 60, lateBy: 5,
    })),
  }];
  assert.deepEqual(selectAlertable(rows, NOW), []);
});
