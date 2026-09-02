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
import { computeBoardFlags, AMBER_CAP, RED_CAP, CRITICAL_CAP } from '../src/lib/board-flags.js';
import { selectAlertable } from '../netlify/functions/lib/flag-alert.mts';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const NOW = 13 * 60, DEG = 1 / 69.055;
// THE CAPS ARE A RED CAP AND AN AMBER CAP, so these run at the floor those tiers can email
// from — ALERT_MIN_TIER=red, plus the amber gate where the amber cap is the subject. The
// defect being pinned is the collapse (a summary row carrying stopNbr: null silencing the
// whole batch), which has nothing to do with the tier floor Chad narrowed on 2026-09-02: it
// bites the same way at any floor, and the fixture has to reach the selector to prove it.
const RED_FLOOR = 'red';

// n single-stop routes, each predicted past a 1:30p close. `typed` decides the tier:
// dispatcher-typed hours are red at any overrun; scanner hours stay amber inside the band.
const board = (n, { typed = false, miles = 55 } = {}) => {
  const stops = [], notes = new Map();
  for (let i = 0; i < n; i += 1) {
    const k = `c${i}`;
    stops.push({
      stopNbr: `S${i}`, matchKey: k, businessName: `CO ${i}`, loadNbr: `R${i}`, routeName: `R${i}`,
      routeSeq: 1, stopType: 'DL', lat: DEPOT.lat + miles * DEG, lng: DEPOT.lng,
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
  const under = selectAlertable(board(RED_CAP, { typed: true }).rows, NOW, 0, RED_FLOOR);
  const over = selectAlertable(board(RED_CAP + 1, { typed: true }).rows, NOW, 0, RED_FLOOR);
  assert.equal(under.length, RED_CAP);
  assert.equal(over.length, RED_CAP + 1, 'the 13th red stop must not silence the other twelve');
});

test('THE CLIFF THE INBOX ACTUALLY SITS ON NOW IS THE CRITICAL ONE — forty email, forty-one email nobody', () => {
  // Since 2026-09-02 only critical emails (flag-alert ALERT_MIN_TIER), so the bucket that can
  // silence the inbox is CRITICAL_CAP 40, not RED_CAP 12. A worse day than thirteen — and the
  // same failure, in the same flattering direction, so it has to be pinned on this bucket too.
  // Two hundred miles out rather than fifty-five: the ETA lands 225 minutes past the 1:30p
  // close against a 90-minute band, which is what makes these critical rather than red
  // (lateBy > 2 x errorMin) while the close itself is STILL AHEAD of the 1:00p clock — an
  // earlier close would have made them critical and then had rule 2 refuse them all for a
  // window that had already shut, which is how the first draft of this test measured zero.
  const crit = (n) => board(n, { miles: 200 });
  assert.equal((crit(2).rows || []).filter((r) => r.rule === 'hours_risk')[0].tier, 'critical',
    'the fixture really is producing criticals, not reds');
  assert.equal(selectAlertable(crit(CRITICAL_CAP).rows, NOW).length, CRITICAL_CAP);
  assert.equal(selectAlertable(crit(CRITICAL_CAP + 1).rows, NOW).length, CRITICAL_CAP + 1,
    'the 41st critical must not silence the other forty');
});

test('the panel still collapses — this is an inbox fix, not a screen change', () => {
  const out = board(RED_CAP + 1, { typed: true });
  const rows = out.rows.filter((r) => r.rule === 'hours_risk');
  assert.equal(rows.length, 1, 'the panel still shows one summary line');
  assert.equal(rows[0].collapsed, RED_CAP + 1);
  assert.equal(rows[0].stopNbr, null, 'and the summary still refuses to claim to be a stop');
});

test('same cliff on the amber side, once the gate is switched on', () => {
  const under = selectAlertable(board(AMBER_CAP).rows, NOW, 120, RED_FLOOR);
  const over = selectAlertable(board(AMBER_CAP + 1).rows, NOW, 120, RED_FLOOR);
  assert.equal(under.length, AMBER_CAP);
  assert.equal(over.length, AMBER_CAP + 1);
});

test('and the gate still governs the recovered rows — off means off, even on a bad day', () => {
  assert.deepEqual(selectAlertable(board(AMBER_CAP + 1).rows, NOW, 0, RED_FLOOR), []);
});

test('every recovered candidate carries the facts the email needs, not a placeholder', () => {
  const [c] = selectAlertable(board(RED_CAP + 1, { typed: true }).rows, NOW, 0, RED_FLOOR);
  assert.ok(c.stopNbr, 'a real stop number');
  assert.ok(Number.isFinite(c.closeMin), 'a real close');
  assert.ok(Number.isFinite(c.lateBy), 'a real overrun');
  assert.match(c.customer, /CO \d+/, 'the customer, so the message names who is at risk');
});

test('the past-close refusal still applies to recovered rows', () => {
  // now is 2:00p, after the 1:30p close: nothing actionable is left in the message.
  assert.deepEqual(selectAlertable(board(RED_CAP + 1, { typed: true }).rows, 14 * 60, 0, RED_FLOOR), []);
});

test('a collapsed batch of a NON-alerting rule stays silent — this did not widen the rules', () => {
  const rows = [{
    rule: 'no_location', tier: 'red', stopNbr: null, collapsed: 30,
    collapsedRows: Array.from({ length: 30 }, (_, i) => ({
      rule: 'no_location', tier: 'red', stopNbr: `S${i}`, closeMin: 14 * 60, lateBy: 5,
    })),
  }];
  assert.deepEqual(selectAlertable(rows, NOW, 0, RED_FLOOR), []);
});

// ── AND THE SAME UN-COLLAPSE MUST REACH ALL THREE CONSUMERS ──────────────────
//
// The first version of this fix reached the email selector only. That left the inbox and
// the audit disagreeing about the same bad day: emails went out on a collapsed board while
// flag history recorded nothing, so the worst day of the week was invisible to the record
// the whole justification was measured from. The overnight texts had the cliff too.
import { mergeSweep } from '../netlify/functions/lib/flag-history.mts';
import { selectTextable } from '../netlify/functions/lib/flag-sms.mts';
import { flattenForConsumers } from '../netlify/functions/lib/flag-rows.mts';

// FROM THE REAL ENGINE, NOT A FIXTURE. The first version of this test hand-built the
// collapsed row and hand-wrote `scope` onto its constituents — a field the engine's own
// projection did not emit — so the test passed while production's overnight texts got rows
// selectTextable dropped on its scope filter. A fixture the engine cannot produce pins
// nothing. This builds enough genuinely-late routes through computeBoardFlags to blow the
// RED_CAP and hands consumers exactly what the engine emits.
const collapsedBatch = (n) => {
  const stops = []; const notes = new Map();
  for (let r = 0; r < n; r += 1) {
    const key = `c${r}`;
    stops.push({
      stopNbr: `S${r}`, matchKey: key, businessName: `CO ${r}`, loadNbr: `R${r}`,
      routeSeq: 1, stopType: 'DL', lat: DEPOT.lat + 3 * DEG, lng: DEPOT.lng + (r * 0.002),
      normalizedStatus: 'PLANNED', status: '10', driverName: 'D', driverUserName: 'd',
    });
    // Close chosen so the unanchored walk lands in RED's band (overrun 90-180 min against
    // the 90-minute unanchored error band): at a 2:00p sweep the yard clock projects
    // ~2:10p against a noon close -> ~130 late -> red. Earlier closes made these CRITICAL
    // (cap 40) and the collapse never happened, which this builder now asserts against.
    notes.set(key, { manual_overrides: { receiving_hours: true }, receiving_hours: { mon: { open: '08:00', close: '12:00' } } });
  }
  const out = computeBoardFlags({ stops, notes, servedDate: '2026-08-17', dayKey: 'mon', opts: { depot: DEPOT, nowMin: 14 * 60 } });
  const rows = out.rows.filter((x) => x.rule === 'hours_risk');
  assert.equal(rows.length, 1, `expected ${n} late routes to collapse to one summary row, got ${rows.length} (tiers: ${[...new Set(out.rows.map((x) => x.tier))].join(',')})`);
  assert.equal(rows[0].collapsed, n, 'the cap must actually have bitten for this test to mean anything');
  return rows;
};

test('flag history records the stops behind a collapsed row, not zero of them', () => {
  const { rows } = mergeSweep(null, collapsedBatch(13), 12 * 60, { emailedStops: new Set() });
  assert.equal(Object.keys(rows).length, 13, 'the audit must see the day the caps bit');
});

test('the overnight texts see them too', () => {
  assert.equal(selectTextable(collapsedBatch(13)).length, 8, 'capped at 8 per sweep, not silenced to 0');
});

test('a summary row that carried NO constituents is still not a stop, everywhere', () => {
  const orphan = [{ rule: 'hours_risk', tier: 'red', stopNbr: null, collapsed: 9, scope: 'occurrence' }];
  assert.deepEqual(flattenForConsumers(orphan), orphan, 'nothing to expand, so it passes through');
  assert.deepEqual(selectAlertable(orphan, 12 * 60, 0, RED_FLOOR), []);
  assert.deepEqual(Object.keys(mergeSweep(null, orphan, 12 * 60, { emailedStops: new Set() }).rows), []);
  assert.deepEqual(selectTextable(orphan), []);
});
