// test/board-flags.test.mjs — the Board Flags detector.
//
// Chad: "a little red flag that pops up with a list of potential issues, on the top bar."
// These tests pin the rules AND the specific traps the design review found — each one a way
// a naive version would have been confidently wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBoardFlags, parseClockMin, dayReceivingWindow, closedDayTier,
  stopPosition, isFinishedStop, RED_CAP, isAppointmentRoute,
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
  // The "flat ~30 mph model" disclaimer lives ONCE in the panel footer, not on every row —
  // Chad (Aug 12): repeating it per card made the panel a wall of identical boilerplate.
  assert.ok(!/30 mph/.test(r.detail), 'the model note belongs to the footer, not each row');
});

// SEVERITY IS SLACK, NOT PROVENANCE (v0.55.4). This test used to assert that auto-detected
// hours CAP at amber however late the truck was. That rule is what produced a board header
// reading "0 red - 6 advisory" while carrying a stop predicted 155 minutes past its close.
// A big overrun now escalates whatever the source of the hours; the caveat text stays.
test('scanner-guessed hours still SAY they are guessed — but a big miss escalates anyway', () => {
  // ETA at FAR CO is ~9:27 under the tiered curve (the 49-mile leg rides at ~47 mph now,
  // not a flat 30) — a 7:00 close puts the overrun in the red band past the 90-min bars.
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '06:00', close: '07:00' } } }) };
  const stops = [stop({ stopNbr: '1', routeSeq: 1 }), stop({ stopNbr: '2', routeSeq: 2, matchKey: 'far|k', lat: 33.60, lng: -84.60 })];
  const r = run(stops, notesObj).rows.find((x) => x.rule === 'hours_risk');
  assert.ok(r, 'the miss is still flagged');
  assert.equal(r.tier, 'red', 'the overrun clears the unanchored error band');
  assert.equal(r.errorMin, 90, 'nothing has reported in, so the wide unanchored band applies');
  assert.ok(r.lateBy > r.errorMin && r.lateBy <= r.errorMin * 2, `lateBy ${r.lateBy} sits in the red band`);
  assert.ok(/auto-detected/.test(r.detail), 'the provenance caveat survives — it just no longer sets the tier');
});

test('a small overrun on guessed hours stays AMBER — inside the error bars, the model cannot tell', () => {
  // Same route, but the close is late enough that the predicted arrival misses it by less
  // than the model's own typical error. That is not evidence, and it must not read as red.
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '08:00', close: '09:00' } } }) };
  const stops = [stop({ stopNbr: '1', routeSeq: 1 }), stop({ stopNbr: '2', routeSeq: 2, matchKey: 'far|k', lat: 33.60, lng: -84.60 })];
  const r = run(stops, notesObj).rows.find((x) => x.rule === 'hours_risk');
  assert.ok(r);
  assert.equal(r.tier, 'amber');
  assert.ok(r.lateBy <= r.errorMin, 'amber means the overrun did not clear the error band');
});

test('typed hours keep their weight: any predicted overrun is at least RED', () => {
  const notesObj = { 'far|k': note({
    receiving_hours: { mon: { open: '08:00', close: '09:00' } },
    manual_overrides: { receiving_hours: true },
  }) };
  const stops = [stop({ stopNbr: '1', routeSeq: 1 }), stop({ stopNbr: '2', routeSeq: 2, matchKey: 'far|k', lat: 33.60, lng: -84.60 })];
  const r = run(stops, notesObj).rows.find((x) => x.rule === 'hours_risk');
  assert.equal(r.tier, 'red', 'a human put that deadline on the record');
});

test('an overrun clearing TWICE the error band is CRITICAL, whatever typed the hours', () => {
  // Auto-detected hours, and a miss so large it survives the model being as wrong as it
  // usually is. This is the tier that did not exist when a 155-minute miss read as advisory.
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '05:00', close: '06:00' } } }) };
  const stops = [stop({ stopNbr: '1', routeSeq: 1 }), stop({ stopNbr: '2', routeSeq: 2, matchKey: 'far|k', lat: 33.60, lng: -84.60 })];
  const r = run(stops, notesObj).rows.find((x) => x.rule === 'hours_risk');
  assert.equal(r.tier, 'critical');
  assert.ok(r.lateBy > r.errorMin * 2);
});

test('critical is counted separately AND inside redCount — promotion never reads calmer', () => {
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '05:00', close: '06:00' } } }) };
  const stops = [stop({ stopNbr: '1', routeSeq: 1 }), stop({ stopNbr: '2', routeSeq: 2, matchKey: 'far|k', lat: 33.60, lng: -84.60 })];
  const out = run(stops, notesObj);
  assert.equal(out.criticalCount, 1);
  assert.equal(out.redCount, 1, 'the critical row is inside redCount, not instead of it');
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

// ── v0.54.57: the four silent-R5 regressions Chad hit ("no flags ... isn't working") ──

test('a sequence living only in the raw feed shape still gets judged (UI parity)', () => {
  // The cheap list feed sometimes carries the sequence only as raw.stop.to.seq. The route
  // panel and the numbered pins read that shape (routeStopSeq) — the detector must too, or
  // the UI shows a numbered route the checks refuse to judge, silently.
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '08:00', close: '09:00' } }, manual_overrides: { receiving_hours: true } }) };
  const stops = [
    stop({ stopNbr: '1', routeSeq: null, raw: { stop: { to: { seq: 1 } } } }),
    stop({ stopNbr: '2', routeSeq: null, raw: { stop: { to: { seq: 2 } } }, matchKey: 'far|k', lat: 33.60, lng: -84.60 }),
  ];
  const out = run(stops, notesObj);
  assert.equal(out.skipped.routesNoSequence.length, 0, 'raw-shape sequence must count as a sequence');
  const r = out.rows.find((x) => x.rule === 'hours_risk');
  assert.ok(r && r.tier === 'red' && r.stopNbr === '2');
});

test('pickups do not poison the sequence-coverage gate (deliveries-only denominator)', () => {
  // 2 sequenced deliveries + 2 pickups used to compute 2/4 = 50% < 70% and skip the route.
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '08:00', close: '09:00' } }, manual_overrides: { receiving_hours: true } }) };
  const stops = [
    stop({ stopNbr: '1', routeSeq: 1 }),
    stop({ stopNbr: '2', routeSeq: 2, matchKey: 'far|k', lat: 33.60, lng: -84.60 }),
    stop({ stopNbr: 'P1', stopType: 'PU', routeSeq: null }),
    stop({ stopNbr: 'P2', stopType: 'PU', routeSeq: null }),
  ];
  const out = run(stops, notesObj);
  assert.equal(out.skipped.routesNoSequence.length, 0, 'pickups must not count against sequence coverage');
  assert.ok(out.rows.some((x) => x.rule === 'hours_risk' && x.stopNbr === '2'));
});

test("a route with no sign of movement cannot depart in the past — the clock starts at now", () => {
  // Near stop, 2:00p close: from an 8:00a depart the model arrives ~8:30a and stays quiet.
  // But at 3:00p with nothing delivered or arrived the truck shows no movement — the clock
  // must run from 3:00p, land after close, and state the EVIDENCE (nothing recorded), not
  // assert "not started" as fact.
  const notesObj = { 'near|k': note({ receiving_hours: { mon: { open: '08:00', close: '14:00' } }, manual_overrides: { receiving_hours: true } }) };
  // driverName matters here: without one, R6 (no driver + hours today) fires instead and
  // SUPERSEDES this row by design — see the "one route, one card" note in board-flags.js.
  // This test is about R5's re-anchored clock, so the route has a driver.
  const stops = [stop({ stopNbr: '1', routeSeq: 1, matchKey: 'near|k', driverName: 'MICHAEL THARP' })];
  assert.equal(run(stops, notesObj).rows.filter((r) => r.rule === 'hours_risk').length, 0, 'on-schedule morning model stays quiet');
  const late = run(stops, notesObj, { opts: { ...OPTS, nowMin: 15 * 60 } });
  const r = late.rows.find((x) => x.rule === 'hours_risk');
  assert.ok(r, 'a 3:00p unmoved route must flag a 2:00p close');
  assert.ok(/no movement yet, clock runs from 3:00p/.test(r.detail), 'the row must state the evidence for the re-anchored clock (compact wording, Aug 12)');
});

test('the first hour after departure is grace — a truck en route to stop 1 is not "late"', () => {
  // 8:30a, nothing scanned yet: that is every normal morning, not evidence of a parked
  // truck. The clock must NOT re-anchor inside the grace hour.
  const notesObj = { 'near|k': note({ receiving_hours: { mon: { open: '08:00', close: '08:20' } }, manual_overrides: { receiving_hours: true } }) };
  const stops = [stop({ stopNbr: '1', routeSeq: 1, matchKey: 'near|k' })];
  const out = run(stops, notesObj, { opts: { ...OPTS, nowMin: 8 * 60 + 30 } });
  const r = out.rows.find((x) => x.rule === 'hours_risk');
  // The 8:00a-model arrival (~8:13a) is before the 8:20a close → quiet. A re-anchored
  // 8:30a clock would have flagged it.
  assert.equal(r, undefined, 'inside the grace hour the schedule model holds');
});

test('any movement evidence keeps the scheduled departure model — POD, arrival stamp, or status', () => {
  // 3:00p clock, but a sibling stop shows the truck is out. All three evidence shapes count:
  // a DELIVERED stop, an ARRIVED status (driver at a dock, no POD yet), an arrivalDTTM stamp.
  const notesObj = { 'near|k': note({ receiving_hours: { mon: { open: '08:00', close: '14:00' } }, manual_overrides: { receiving_hours: true } }) };
  for (const evidence of [
    { stopNbr: '0', normalizedStatus: 'DELIVERED', deliveredDTTM: '2026-08-10T10:00:00' },
    { stopNbr: '0', normalizedStatus: 'ARRIVED' },
    { stopNbr: '0', arrivalDTTM: '2026-08-10T08:40:00' },
    { stopNbr: '0', status: '40' }, // out for delivery
  ]) {
    const out = run([stop(evidence), stop({ stopNbr: '1', routeSeq: 1, matchKey: 'near|k' })], notesObj, { opts: { ...OPTS, nowMin: 15 * 60 } });
    assert.equal(out.rows.filter((r) => r.rule === 'hours_risk').length, 0,
      `a route with ${JSON.stringify(evidence)} is rolling — never re-anchored to now`);
  }
});

// ── v0.54.58: Chad's LVILLE case — a deadline route with no driver assigned ──

test('past departure, a driverless route with a receiving close today flags NOW', () => {
  // 9:24a, LVILLE untouched, LUND closes 2:00p, nobody assigned. The ETA walk stays quiet
  // (a re-anchored clock still lands mid-morning) — the no-driver fact is the flag.
  const notesObj = { 'lund|k': note({ receiving_hours: { mon: { open: '06:00', close: '14:00' } } }) };
  const stops = [
    stop({ stopNbr: '1', routeSeq: 1, loadNbr: 'LVILLE', routeName: 'LVILLE', driverName: null, driverUserName: null }),
    stop({ stopNbr: '2', routeSeq: 2, loadNbr: 'LVILLE', routeName: 'LVILLE', driverName: null, driverUserName: null, matchKey: 'lund|k', businessName: 'LUND INTERNATIONAL' }),
  ];
  const out = run(stops, notesObj, { opts: { ...OPTS, nowMin: 9 * 60 + 24 } });
  const r = out.rows.find((x) => x.rule === 'no_driver_hours');
  assert.ok(r, 'a driverless deadline route must flag as soon as departure time passes');
  assert.equal(r.tier, 'amber', 'scanner-guessed hours cap at amber');
  assert.ok(r.title.includes('LVILLE') && r.title.includes('2:00p'));
  assert.ok(/LUND INTERNATIONAL/.test(r.detail), 'the earliest-close stop is named');
  assert.equal(out.rows.filter((x) => x.rule === 'hours_risk').length, 0, 'the ETA walk alone stays quiet at 9:24a');
});

test('driverless-deadline goes RED when any constrained stop has dispatcher-typed hours', () => {
  const notesObj = { 'lund|k': note({ receiving_hours: { mon: { open: '06:00', close: '14:00' } }, manual_overrides: { receiving_hours: true } }) };
  const stops = [stop({ stopNbr: '1', routeSeq: 1, driverName: null, driverUserName: null, matchKey: 'lund|k' })];
  const r = run(stops, notesObj, { opts: { ...OPTS, nowMin: 10 * 60 } }).rows.find((x) => x.rule === 'no_driver_hours');
  assert.ok(r && r.tier === 'red');
});

test('the no-driver check stays quiet when it should', () => {
  const notesObj = { 'lund|k': note({ receiving_hours: { mon: { open: '06:00', close: '14:00' } } }) };
  const base = { stopNbr: '1', routeSeq: 1, matchKey: 'lund|k', driverName: null, driverUserName: null };
  const fires = (stops, opts) => run(stops, notesObj, { opts }).rows.some((x) => x.rule === 'no_driver_hours');
  // A driver on ANY stop of the route = assigned.
  assert.equal(fires([stop({ ...base, driverName: 'Joe Gibbs' })], { ...OPTS, nowMin: 10 * 60 }), false);
  // Before the scheduled departure, assignment is normal morning work — not a flag.
  assert.equal(fires([stop(base)], { ...OPTS, nowMin: 7 * 60 }), false);
  // Not the today board (no nowMin) — tomorrow's unassigned route is just tomorrow.
  assert.equal(fires([stop(base)], OPTS), false);
  // Movement evidence implies a driver, whatever the feed says.
  assert.equal(fires([stop({ stopNbr: '0', normalizedStatus: 'ARRIVED' }), stop(base)], { ...OPTS, nowMin: 10 * 60 }), false);
  // No receiving hours anywhere on the route — no deadline, no flag.
  assert.equal(run([stop({ ...base, matchKey: 'plain|k' })], {}, { opts: { ...OPTS, nowMin: 10 * 60 } }).rows.some((x) => x.rule === 'no_driver_hours'), false);
});

test('a chain-broken route is NOT counted as judged — the tallies may not contradict', () => {
  const stops = [
    stop({ stopNbr: '1', routeSeq: 1, lat: null, lng: null }), // no position → chain breaks
    stop({ stopNbr: '2', routeSeq: 2 }),
  ];
  const out = run(stops);
  assert.equal(out.checked.routesJudged, 0, 'zero stops were actually assessed');
  assert.ok(out.skipped.routesNoSequence.some((k) => k.includes('missing pin')));
});

test('legacy M2.x range strings are windows, not free text', () => {
  // Old docs store per-day strings like "6AM-2PM"; the note editor's clock badge lights for
  // them, so the detector must read them too. "8-5" follows the business-hours convention.
  assert.deepEqual(
    dayReceivingWindow(note({ receiving_hours: { mon: '6AM-2PM' } }), 'mon'),
    { openMin: 6 * 60, closeMin: 14 * 60, tier: 'auto' },
  );
  assert.equal(dayReceivingWindow(note({ receiving_hours: { mon: '8-5' } }), 'mon').closeMin, 17 * 60);
  assert.equal(dayReceivingWindow(note({ receiving_hours: { mon: '11AM-1PM' } }), 'mon').closeMin, 13 * 60);
  // A bare time is still close-only; true free text is still refused.
  assert.equal(dayReceivingWindow(note({ receiving_hours: { mon: '2PM' } }), 'mon').closeMin, 14 * 60);
  assert.equal(dayReceivingWindow(note({ receiving_hours: { mon: 'RH 7-11AM appt only' } }), 'mon'), null);
});

test('half-parseable and overnight ranges are refused — a guessed window is a false flag factory', () => {
  // BOTH halves must parse: "noon-5" would otherwise invent a 5:00 AM close and flag every
  // arrival after dawn; "24-7" (always open!) would become a 7:00 AM close.
  assert.equal(dayReceivingWindow(note({ receiving_hours: { mon: 'noon-5' } }), 'mon'), null);
  assert.equal(dayReceivingWindow(note({ receiving_hours: { mon: '24-7' } }), 'mon'), null);
  // An explicit overnight window ("9PM-5AM" dock) is not comparable to a daytime route —
  // the "8-5" pm-shift must never relabel a written AM close as afternoon.
  assert.equal(dayReceivingWindow(note({ receiving_hours: { mon: '9PM-5AM' } }), 'mon'), null);
  assert.equal(dayReceivingWindow(note({ receiving_hours: { mon: '10PM-6AM' } }), 'mon'), null);
});

test('the checked tally proves what a quiet board actually looked at', () => {
  const notesObj = { 'near|k': note({ receiving_hours: { mon: { open: '08:00', close: '17:00' } } }) };
  const out = run([stop({ stopNbr: '1', routeSeq: 1, matchKey: 'near|k' }), stop({ stopNbr: '2', routeSeq: 2 })], notesObj);
  assert.equal(out.rows.length, 0, 'this board is genuinely clean');
  assert.equal(out.checked.stops, 2);
  assert.equal(out.checked.routesJudged, 1);
  assert.equal(out.checked.stopsWithHours, 1);
});

test('red sorts before amber, and the counts split by tier', () => {
  const notesObj = { 'b|k': note({ closed_days: ['mon'], auto_matches: { closed_days: [{ text: 'x', pattern: 'closed_mon' }] } }) };
  const out = run([stop({ dupNbr: true }), stop({ stopNbr: '2', matchKey: 'b|k' })], notesObj);
  assert.equal(out.rows[0].tier, 'red');
  assert.equal(out.redCount, 1);
  assert.equal(out.amberCount, 1);
});

// ── the duplicate-visit collapse (Chad's screenshot: "repeat information here") ──

test('a multi-order customer flags ONCE, not once per board row', () => {
  // Subaru case: three orders at one customer arrive as three board rows sharing the
  // sequence slot — the panel showed the same "may miss" flag at 1:06p, 1:26p and 1:46p,
  // one phantom service block apart.
  const notesObj = { 'subaru|k': note({ receiving_hours: { mon: { open: '08:00', close: '09:00' } } }) };
  const dupRow = { stopNbr: '2', routeSeq: 2, matchKey: 'subaru|k', businessName: 'SUBARU', lat: 33.60, lng: -84.60 };
  const stops = [
    stop({ stopNbr: '1', routeSeq: 1 }),
    stop({ ...dupRow }), stop({ ...dupRow, stopNbr: '2b' }), stop({ ...dupRow, stopNbr: '2c' }),
  ];
  const out = run(stops, notesObj);
  assert.equal(out.rows.filter((r) => r.rule === 'hours_risk').length, 1, 'one visit, one flag');
});

test('duplicate rows add no phantom service time to later stops on the route', () => {
  // The stop AFTER the duplicated visit must get the same ETA whether the customer
  // arrived as one row or three — each extra row used to add a full service block.
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '08:00', close: '09:00' } } }) };
  const mid = { stopNbr: '2', routeSeq: 2, matchKey: 'mid|k', businessName: 'MID', lat: 34.05, lng: -84.20 };
  const far = stop({ stopNbr: '3', routeSeq: 3, matchKey: 'far|k', businessName: 'FAR CO', lat: 33.60, lng: -84.60 });
  const once = run([stop({ stopNbr: '1', routeSeq: 1 }), stop({ ...mid }), far], notesObj);
  const tripled = run([stop({ stopNbr: '1', routeSeq: 1 }), stop({ ...mid }), stop({ ...mid, stopNbr: '2b' }), stop({ ...mid, stopNbr: '2c' }), far], notesObj);
  const detailOf = (o) => o.rows.find((r) => r.rule === 'hours_risk' && String(r.stopNbr) === '3')?.detail;
  assert.ok(detailOf(once), 'far stop misses its 9:00 close in the clean walk');
  assert.equal(detailOf(tripled), detailOf(once), 'identical ETA math with or without duplicate rows');
});

test('the driverless-deadline count speaks in customers, not board rows', () => {
  const notesObj = { 'subaru|k': note({ receiving_hours: { mon: { open: '08:00', close: '14:00' } } }) };
  const dupRow = { stopNbr: '2', routeSeq: 2, matchKey: 'subaru|k', businessName: 'SUBARU', driverName: '' };
  const stops = [stop({ ...dupRow }), stop({ ...dupRow, stopNbr: '2b' }), stop({ ...dupRow, stopNbr: '2c' })];
  const out = run(stops.map((s) => ({ ...s, driverName: '' })), notesObj, { opts: { ...OPTS, nowMin: 9 * 60 } });
  const r = out.rows.find((x) => x.rule === 'no_driver_hours');
  assert.ok(r, 'expected the driverless-deadline flag');
  assert.match(r.detail, /has 1 stop with receiving hours/, 'three rows, one customer, count of 1');
});

// ── appointment routes (Chad: "dont put uline appt's in the flag") ────────────
//
// ULINE APPT is a holding pen, not a truck: freight sits on it BECAUSE it is waiting on a
// scheduled appointment. Walking a delivery sequence down it produced rows like "estimated
// arrival ~1:49a vs close 5:00p, 529 min late" — arithmetic about a stop that was never
// going out that day. The risk in silencing a route is silencing a REAL one, so these pin
// both directions.

test('isAppointmentRoute matches the APPT token, not substrings', () => {
  for (const n of ['ULINE APPT', 'uline appt', 'ULINE APPT 2', 'ESTES APPT', 'APPT', 'APPTS', 'Appointment Hold'])
    assert.ok(isAppointmentRoute(n), `should match: ${n}`);
  // The failure that would actually hurt: silencing a live truck whose name happens to
  // contain the letters. Verified against 3 days of the real roster — 111 route names, none
  // like this — but the boundary is what makes that safe, so it is pinned.
  for (const n of ['APPTON', 'RAPPTON', 'SUW', 'STEVEN', 'ALPHA 2', 'TRAILER 6', '', null, undefined])
    assert.ok(!isAppointmentRoute(n), `should NOT match: ${n}`);
});

test('THE REPORT: a late-looking stop on ULINE APPT produces no hours_risk row', () => {
  const notesObj = {
    'far|k': note({
      receiving_hours: { mon: { open: '08:00', close: '09:00' } },
      manual_overrides: { receiving_hours: true },
    }),
  };
  const stops = [
    stop({ stopNbr: '1', routeSeq: 1, loadNbr: 'ULINE APPT', routeName: 'ULINE APPT' }),
    stop({ stopNbr: '2', routeSeq: 2, loadNbr: 'ULINE APPT', routeName: 'ULINE APPT',
      matchKey: 'far|k', businessName: 'RIOF INSTALLATIONS', lat: 33.60, lng: -84.60 }),
  ];
  const out = run(stops, notesObj);
  assert.equal(out.rows.filter((r) => r.rule === 'hours_risk').length, 0,
    'held-for-appointment freight is not late freight');
  assert.deepEqual(out.skipped.routesAppointment, ['ULINE APPT'],
    'and the panel is told, so the exclusion is visible rather than silent');
  assert.equal(out.checked.routesJudged, 0, 'an excluded route is not counted as judged either');
});

test('the SAME stops on a normal route still flag — the rule narrowed, it did not break', () => {
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
  assert.equal(out.rows.filter((r) => r.rule === 'hours_risk').length, 1);
  assert.deepEqual(out.skipped.routesAppointment, []);
});

test('the no-driver rule is silenced on appointment routes too', () => {
  // An appointment route has no driver because it is not being run. Flagging that at 8am
  // every day is the same false alarm wearing a different hat.
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '08:00', close: '15:00' } }, manual_overrides: { receiving_hours: true } }) };
  const stops = [
    stop({ stopNbr: '1', routeSeq: 1, loadNbr: 'ULINE APPT', routeName: 'ULINE APPT', driverName: '', driverUserName: '',
      matchKey: 'far|k', businessName: 'HELD CO' }),
  ];
  const out = run(stops, notesObj, { opts: { ...OPTS, nowMin: 10 * 60 } });
  assert.equal(out.rows.filter((r) => r.rule === 'no_driver_hours').length, 0);
});

test('a driverless NORMAL route past departure still raises no_driver_hours', () => {
  const notesObj = { 'far|k': note({ receiving_hours: { mon: { open: '08:00', close: '15:00' } }, manual_overrides: { receiving_hours: true } }) };
  const stops = [
    stop({ stopNbr: '1', routeSeq: 1, loadNbr: 'LVILLE', routeName: 'LVILLE', driverName: '', driverUserName: '',
      matchKey: 'far|k', businessName: 'LUND' }),
  ];
  const out = run(stops, notesObj, { opts: { ...OPTS, nowMin: 10 * 60 } });
  assert.equal(out.rows.filter((r) => r.rule === 'no_driver_hours').length, 1,
    'silencing appointment routes must not silence the LVILLE case');
});

// Chad, v0.54.88, on a Board flags screenshot: "there is same one listed twice". A driverless
// route whose earliest close the arrival walk had ALSO crossed produced two cards for one
// situation — "May miss receiving hours — MCNAUGHTON MCKAY ELECTRIC" and "No driver — SUW
// must make 11:30a", the second naming the same customer and the same close.
test('a driverless route reports ONCE — the no-driver card supersedes the arrival card', () => {
  const notesObj = {
    'mck|k': note({ receiving_hours: { mon: { open: '08:00', close: '11:30' } }, manual_overrides: { receiving_hours: true } }),
  };
  // No driverName anywhere on the route, past departure, nothing moving: both rules qualify.
  const stops = [stop({ stopNbr: '5', routeSeq: 5, matchKey: 'mck|k', businessName: 'MCNAUGHTON MCKAY ELECTRIC' })];
  const out = run(stops, notesObj, { opts: { ...OPTS, nowMin: 11 * 60 + 20 } });

  const noDriver = out.rows.filter((r) => r.rule === 'no_driver_hours');
  const hours = out.rows.filter((r) => r.rule === 'hours_risk');
  assert.equal(noDriver.length, 1, 'the no-driver card is the one that names the cause and the action');
  assert.equal(hours.length, 0, 'the arrival card for the SAME route is the same problem told twice');
  assert.match(noDriver[0].title, /MCNAUGHTON MCKAY ELECTRIC|must make/);
});

test('a route WITH a driver still gets its arrival card — the supersede is scoped to the route', () => {
  const notesObj = {
    'mck|k': note({ receiving_hours: { mon: { open: '08:00', close: '11:30' } }, manual_overrides: { receiving_hours: true } }),
  };
  const stops = [stop({ stopNbr: '5', routeSeq: 5, matchKey: 'mck|k', driverName: 'MICHAEL THARP' })];
  const out = run(stops, notesObj, { opts: { ...OPTS, nowMin: 11 * 60 + 20 } });
  assert.equal(out.rows.filter((r) => r.rule === 'no_driver_hours').length, 0);
  assert.equal(out.rows.filter((r) => r.rule === 'hours_risk').length, 1, 'a driver is assigned — the timing risk is the real story');
});
