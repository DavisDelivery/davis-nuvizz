// test/board-flags.test.mjs — the Board Flags detector.
//
// Chad: "a little red flag that pops up with a list of potential issues, on the top bar."
// These tests pin the rules AND the specific traps the design review found — each one a way
// a naive version would have been confidently wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBoardFlags, parseClockMin, dayReceivingWindow, closedDayTier,
  stopPosition, isFinishedStop, RED_CAP,
} from '../src/lib/board-flags.js';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const OPTS = { depot: DEPOT, departMin: 8 * 60 };

const stop = (over = {}) => ({
  stopNbr: '1001', businessName: 'ACME', addr1: '1 Main', city: 'Buford',
  lat: 34.10, lng: -84.00, matchKey: 'acme|1 main|buford|30518',
  normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  loadNbr: 'SUW', routeName: 'SUW', routeSeq: 1, stopType: 'DO',
  ...over,
});
const note = (over = {}) => ({ ...over });
const run = (stops, notesObj = {}, extra = {}) => computeBoardFlags({
  stops, notes: new Map(Object.entries(notesObj)), servedDate: '2026-08-10', dayKey: 'mon',
  rosterRows: extra.rosterRows ?? [], opts: OPTS, ...extra,
});

// ── parsing ───────────────────────────────────────────────────────────────────

test('parseClockMin reads 24h, 12h and am/pm; refuses free text', () => {
  assert.equal(parseClockMin('14:30'), 14 * 60 + 30);
  assert.equal(parseClockMin('8:00'), 8 * 60);
  assert.equal(parseClockMin('8:00a'), 8 * 60);
  assert.equal(parseClockMin('2:30 PM'), 14 * 60 + 30);
  assert.equal(parseClockMin('12:15am'), 15);
  assert.equal(parseClockMin('12:00 pm'), 12 * 60);
  assert.equal(parseClockMin('RH 7-11AM'), null);     // free text is not a clock
  assert.equal(parseClockMin('call first'), null);
  assert.equal(parseClockMin(''), null);
});

test('free-text receiving hours are not comparable — never guessed at', () => {
  const n = note({ receiving_hours: { mon: 'RH 7-11AM appt only' } });
  assert.equal(dayReceivingWindow(n, 'mon'), null);
});

test('typed vs auto hours tier follows the manual override flag', () => {
  const auto = note({ receiving_hours: { mon: { open: '08:00', close: '14:00' } } });
  const typed = note({ ...auto, manual_overrides: { receiving_hours: true } });
  assert.equal(dayReceivingWindow(auto, 'mon').tier, 'auto');
  assert.equal(dayReceivingWindow(typed, 'mon').tier, 'typed');
});

// ── the closed-day provenance trap (design review: fatal #3) ─────────────────

test('a scanner-invented closed day stays AMBER even after a human ticks a different day', () => {
  // The field lock (manual_overrides.closed_days) covers the whole field — ticking Monday by
  // hand must not promote the scanner's invented Friday to dispatcher-set red.
  const n = note({
    closed_days: ['mon', 'fri'],
    manual_overrides: { closed_days: true },
    auto_matches: { closed_days: [{ source: 'orderInstructions', text: 'CLOSED FRIDAYS', pattern: 'closed_fri' }] },
  });
  assert.equal(closedDayTier(n, 'fri'), 'auto');   // scanner fingerprint exists for fri
  assert.equal(closedDayTier(n, 'mon'), 'typed');  // no fingerprint → the human set it
  assert.equal(closedDayTier(n, 'tue'), null);     // not closed at all
});

test('closed-day rows: typed goes red, scanner goes amber with the matched text shown', () => {
  const notesObj = {
    'a|k': note({ closed_days: ['mon'], manual_overrides: { closed_days: true } }),
    'b|k': note({
      closed_days: ['mon'],
      auto_matches: { closed_days: [{ text: 'CLOSED MONDAYS', pattern: 'closed_mon' }] },
    }),
  };
  const out = run([stop({ matchKey: 'a|k', stopNbr: '1' }), stop({ matchKey: 'b|k', stopNbr: '2' })], notesObj);
  const closed = out.rows.filter((r) => r.rule === 'closed_today');
  assert.equal(closed.length, 2);
  assert.equal(closed.find((r) => r.stopNbr === '1').tier, 'red');
  const amber = closed.find((r) => r.stopNbr === '2');
  assert.equal(amber.tier, 'amber');
  assert.ok(amber.detail.includes('CLOSED MONDAYS'), 'the scanner row must show its evidence');
});

// ── the pin-override trap (design review: fatal #1) ──────────────────────────

test('a saved pin override IS a location — no_location never fires on a fixed pin', () => {
  const s = stop({ lat: null, lng: null, matchKey: 'fixed|k' });
  const out = run([s], { 'fixed|k': note({ location_override: { lat: 34.1, lng: -84.0 } }) });
  assert.equal(out.rows.filter((r) => r.rule === 'no_location').length, 0);
  assert.equal(stopPosition(s, { location_override: { lat: 34.1, lng: -84.0 } }).source, 'override');
});

test('a stop with no geocode and no override flags red, fingerprinted by its address', () => {
  const out = run([stop({ lat: null, lng: null })]);
  const r = out.rows.find((x) => x.rule === 'no_location');
  assert.ok(r && r.tier === 'red');
  assert.ok(r.fingerprint.includes('1 Main'), 'fingerprint carries the address so fixing it retires the dismissal');
});

// ── the shared-name rule (Chad: cancel-then-rebuild is the only duplicate) ───

test("cancel-and-rebuild (one cancelled + one live) never flags; two LIVE loads do", () => {
  const rebuilt = [
    { loadId: 'L1', name: 'STEVEN', status: 'Cancelled' },
    { loadId: 'L2', name: 'STEVEN', status: 'In-Transit' },
  ];
  const twoLive = [
    { loadId: 'L1', name: 'STEVEN', status: 'In-Transit' },
    { loadId: 'L2', name: 'STEVEN', status: 'Draft' },
  ];
  const s = stop({ loadNbr: 'STEVEN', routeName: 'STEVEN' });
  assert.equal(run([s], {}, { rosterRows: rebuilt }).rows.filter((r) => r.rule === 'route_name_ambiguous').length, 0);
  const flagged = run([s], {}, { rosterRows: twoLive });
  assert.equal(flagged.rows.filter((r) => r.rule === 'route_name_ambiguous').length, 1);
  assert.ok(flagged.skipped.ambiguousRoutes.includes('steven'));
});

test('no roster ⇒ route checks report NOT CHECKED, never clean (fails closed)', () => {
  const out = run([stop()], {}, { rosterRows: null });
  assert.equal(out.skipped.noRoster, true);
  assert.equal(out.rows.filter((r) => r.rule === 'route_name_ambiguous').length, 0);
});

// ── the receiving-hours risk check (Chad's ask), honestly scoped ─────────────

test('a stop sequenced past a TYPED close flags red, labelled as an estimate', () => {
  // Stop 2 sits ~45 mi of driving from stop 1; with a 14:00 close and an 8:00 depart the
  // model cannot get there in time once stop 1's service is counted... use a tight close.
  const notesObj = {
    'far|k': note({
      receiving_hours: { mon: { open: '08:00', close: '09:00' } },
      manual_overrides: { receiving_hours: true },
    }),
  };
  const stops = [
    stop({ stopNbr: '1', routeSeq: 1 }),
    stop({ stopNbr: '2', routeSeq: 2, matchKey: 'far|k', businessName: 'FAR CO', lat: 33.60, lng: -84.60 }),
  ];
  const out = run(stops, notesObj);
  const r = out.rows.find((x) => x.rule === 'hours_risk');
  assert.ok(r, 'expected an hours_risk row');
  assert.equal(r.tier, 'red');
  assert.equal(r.stopNbr, '2');
  assert.ok(/estimate/i.test(r.detail), 'the row must say it is an estimate');
  assert.ok(/30 mph/.test(r.detail), 'the row must name the model');
});

test('scanner-guessed hours cap the same miss at AMBER, and say why', () => {
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '08:00', close: '09:00' } } }) };
  const stops = [stop({ stopNbr: '1', routeSeq: 1 }), stop({ stopNbr: '2', routeSeq: 2, matchKey: 'far|k', lat: 33.60, lng: -84.60 })];
  const r = run(stops, notesObj).rows.find((x) => x.rule === 'hours_risk');
  assert.ok(r && r.tier === 'amber');
  assert.ok(/auto-detected/.test(r.detail));
});

test('a route without sequence numbers is not judged — an invented order is worse than silence', () => {
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '08:00', close: '09:00' } }, manual_overrides: { receiving_hours: true } }) };
  const stops = [
    stop({ stopNbr: '1', routeSeq: null }),
    stop({ stopNbr: '2', routeSeq: null, matchKey: 'far|k', lat: 33.60, lng: -84.60 }),
  ];
  const out = run(stops, notesObj);
  assert.equal(out.rows.filter((r) => r.rule === 'hours_risk').length, 0);
  assert.ok(out.skipped.routesNoSequence.includes('SUW'));
});

test('an ambiguous route name gates the hours check too — no judging a phantom route', () => {
  const twoLive = [
    { loadId: 'L1', name: 'SUW', status: 'In-Transit' },
    { loadId: 'L2', name: 'SUW', status: 'Draft' },
  ];
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '08:00', close: '09:00' } }, manual_overrides: { receiving_hours: true } }) };
  const stops = [stop({ stopNbr: '1', routeSeq: 1 }), stop({ stopNbr: '2', routeSeq: 2, matchKey: 'far|k', lat: 33.60, lng: -84.60 })];
  const out = run(stops, notesObj, { rosterRows: twoLive });
  assert.equal(out.rows.filter((r) => r.rule === 'hours_risk').length, 0, 'phantom route must not be judged');
  assert.equal(out.rows.filter((r) => r.rule === 'route_name_ambiguous').length, 1);
});

// ── terminal freight, dup numbers, caps, dismissal keys ──────────────────────

test('delivered / exception freight is never flagged', () => {
  const stops = [
    stop({ stopNbr: '1', lat: null, lng: null, normalizedStatus: 'DELIVERED' }),
    stop({ stopNbr: '2', lat: null, lng: null, status: '80', normalizedStatus: 'EXCEPTION' }),
    stop({ stopNbr: '3', dupNbr: true, normalizedStatus: 'DELIVERED', deliveredDTTM: '2026-08-10T14:00:00' }),
  ];
  assert.equal(run(stops).rows.length, 0);
  assert.ok(isFinishedStop(stops[2]));
});

test('the twin-number flag rides the scan flags and is occurrence-scoped', () => {
  const out = run([stop({ dupNbr: true, dupNbrOtherId: 'abc123' })]);
  const r = out.rows.find((x) => x.rule === 'dup_number');
  assert.ok(r && r.tier === 'red');
  assert.ok(r.dismissKey.includes('2026-08-10'), 'occurrence dismissals carry the board day');
});

test('standing dismissal keys omit the date; occurrence keys include it', () => {
  const out = run([stop({ lat: null, lng: null }), stop({ stopNbr: '9', dupNbr: true })]);
  const standing = out.rows.find((r) => r.rule === 'no_location');
  const occurrence = out.rows.find((r) => r.rule === 'dup_number');
  assert.ok(!standing.dismissKey.includes('2026-08-10'));
  assert.ok(occurrence.dismissKey.includes('2026-08-10'));
});

test(`an over-cap rule collapses to ONE summary row (cap ${RED_CAP} red)`, () => {
  const stops = Array.from({ length: RED_CAP + 8 }, (_, i) =>
    stop({ stopNbr: String(i), matchKey: `k${i}|x`, addr1: `${i} Nowhere`, lat: null, lng: null }));
  const out = run(stops);
  const noloc = out.rows.filter((r) => r.rule === 'no_location');
  assert.equal(noloc.length, 1);
  assert.equal(noloc[0].collapsed, RED_CAP + 8);
  assert.equal(out.redCount, 1, 'the badge counts the summary, not the flood');
});

test('red sorts before amber, and the counts split by tier', () => {
  const notesObj = { 'b|k': note({ closed_days: ['mon'], auto_matches: { closed_days: [{ text: 'x', pattern: 'closed_mon' }] } }) };
  const out = run([stop({ dupNbr: true }), stop({ stopNbr: '2', matchKey: 'b|k' })], notesObj);
  assert.equal(out.rows[0].tier, 'red');
  assert.equal(out.redCount, 1);
  assert.equal(out.amberCount, 1);
});
