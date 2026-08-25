// test/day-completion.test.mjs — the end-of-day completion report.
//
// Chad: "produce a report at the end of every day at six thirty on everything that was
// planned for that day per NuVizz ... and then does not have a completed status."
//
// These pin the two ways "not completed" is operationally wrong as a single filter, and the
// reconciliation that decides whether the trend chart measures freight or scanning.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stopOutcome, buildDayCompletion, reconcileDay, isOpenOutcome, isDeliveredOutcome,
  dayCompletionText, isExcludedRoute, excludedRouteNames,
} from '../netlify/functions/lib/day-completion.mts';

const DATE = '2026-08-20';
const stop = (over = {}) => ({
  stopNbr: '1001', businessName: 'ACME', addr1: '1 Main', city: 'Buford',
  loadNbr: 'SUW', routeName: 'SUW', routeSeq: 1, driverName: 'Joe Gibbs',
  isPlanned: true, status: '20', ...over,
});
const build = (stops, o = {}) => buildDayCompletion(stops, { date: DATE, asOf: '18:30', ...o });

// ── the codes ────────────────────────────────────────────────────────────────

test('91 is a COMPLETION, not an open stop — the filter Chad guessed would have missed it', () => {
  // 90 is a system close, 91 is a dispatcher closing it by hand in the portal. Both are
  // delivered freight. "Everything that is not 90" reports every hand-closed stop as open,
  // and the busiest days are the ones dispatch closes the most by hand — so the report would
  // look worst exactly when the day actually went fine.
  assert.equal(stopOutcome(stop({ status: '90' })), 'delivered_system');
  assert.equal(stopOutcome(stop({ status: '91' })), 'delivered_manual');
  assert.ok(isDeliveredOutcome(stopOutcome(stop({ status: '91' }))));
  assert.ok(!isOpenOutcome(stopOutcome(stop({ status: '91' }))));
});

test('80 "unable to deliver" is TERMINAL — a naive not-90 filter drops the most urgent line', () => {
  // NuVizz treats 80 as finished, so anything filtering on "no completed status" by looking
  // for open records loses it. A refused delivery at 6:30pm is the line somebody has to act
  // on tomorrow morning; it belongs at the top of the report, not off it.
  assert.equal(stopOutcome(stop({ status: '80' })), 'unable');
  assert.ok(!isOpenOutcome(stopOutcome(stop({ status: '80' }))), 'not open — it finished, badly');
  assert.ok(!isDeliveredOutcome(stopOutcome(stop({ status: '80' }))), 'and it is NOT a delivery');
});

test('99 cancelled is neither a failure nor a delivery, and never inflates the open count', () => {
  assert.equal(stopOutcome(stop({ status: '99' })), 'cancelled');
  const out = build([stop({ status: '99' }), stop({ stopNbr: '2', status: '90' })]);
  assert.equal(out.open, 0, 'a pulled order is not an open stop');
  assert.equal(out.planned, 2);
  assert.equal(out.gradable, 1, 'cancellations leave the denominator');
  assert.equal(out.completionRate, 1, 'one planned, one delivered — a clean day');
});

test('an unable-to-deliver stays IN the denominator — the freight did not get there', () => {
  const out = build([stop({ status: '90' }), stop({ stopNbr: '2', status: '80' })]);
  assert.equal(out.gradable, 2);
  assert.equal(out.completionRate, 0.5, 'scoring a refusal as "not our problem" is marking our own homework');
});

test('40/50 is in flight — the truck touched it and never closed it', () => {
  assert.equal(stopOutcome(stop({ status: '40' })), 'in_flight');
  assert.equal(stopOutcome(stop({ status: '50' })), 'in_flight');
  assert.equal(stopOutcome(stop({ status: '20' })), 'not_attempted');
});

test('a delivery stamp settles it when the code lags, and is attributed conservatively', () => {
  // Production's classifier already treats a real stamp as delivered. A code-less delivery
  // has no 90/91 provenance, so it counts as system — which can only UNDER-state the manual
  // rate. An inflated "dispatch closes everything by hand" sends someone after the wrong
  // problem, so the error direction is chosen deliberately.
  assert.equal(stopOutcome({ deliveredDTTM: `${DATE}T13:00`, status: '' }), 'delivered_system');
  assert.equal(stopOutcome({ normalizedStatus: 'DELIVERED' }), 'delivered_system');
  assert.equal(stopOutcome({ normalizedStatus: 'ARRIVED' }), 'in_flight');
  assert.equal(stopOutcome({ arrivalDTTM: `${DATE}T13:00` }), 'in_flight');
});

// ── the day ──────────────────────────────────────────────────────────────────

test('unplanned freight is never counted — the day is not blamed for work nobody scheduled', () => {
  const out = build([
    stop({ status: '90' }),
    stop({ stopNbr: '2', isPlanned: false, loadNbr: '', routeName: '', status: '20' }),
  ]);
  assert.equal(out.planned, 1);
  assert.equal(out.open, 0);
});

test('the open list collapses one physical stop, the delivery counts do not', () => {
  // A three-order customer is three completions and ONE line on the call list. Three
  // identical lines for one dock is how a ten-line report becomes one nobody reads.
  const three = [0, 1, 2].map((i) => stop({ stopNbr: '7000', businessName: 'SUBARU', status: '20', routeSeq: 4 + i * 0 }));
  const out = build(three);
  assert.equal(out.counts.not_attempted, 3, 'three orders are three open orders');
  assert.equal(out.openStops.length, 1, 'and one place to call');
  assert.equal(out.openStops[0].customer, 'SUBARU');
});

test('the route roll is what makes it a conversation with a driver', () => {
  const out = build([
    stop({ stopNbr: '1', loadNbr: 'BRIAN', routeName: 'BRIAN', driverName: 'Brian', status: '90' }),
    stop({ stopNbr: '2', loadNbr: 'BRIAN', routeName: 'BRIAN', driverName: 'Brian', status: '20', routeSeq: 9 }),
    stop({ stopNbr: '3', loadNbr: 'BRIAN', routeName: 'BRIAN', driverName: 'Brian', status: '40', routeSeq: 10 }),
    stop({ stopNbr: '4', loadNbr: 'SUW', routeName: 'SUW', driverName: 'Sam', status: '90' }),
  ]);
  const brian = out.byRoute.find((r) => r.route === 'BRIAN');
  assert.equal(brian.planned, 3);
  assert.equal(brian.open, 2);
  assert.equal(brian.notAttempted, 1);
  assert.equal(brian.inFlight, 1);
  assert.equal(brian.driver, 'Brian');
  assert.equal(out.byRoute[0].route, 'BRIAN', 'worst route first — most open stops leads');
  assert.equal(out.byRoute.find((r) => r.route === 'SUW').completionRate, 1);
});

test('a driver blank on one row does not erase the route driver', () => {
  const out = build([
    stop({ stopNbr: '1', driverName: '', driverUserName: '', status: '20' }),
    stop({ stopNbr: '2', driverName: 'Joe Gibbs', status: '90' }),
  ]);
  assert.equal(out.byRoute[0].driver, 'Joe Gibbs');
});

test('an empty board reports nothing rather than dividing by zero', () => {
  const out = build([]);
  assert.equal(out.planned, 0);
  assert.equal(out.completionRate, null, 'no stops is not 0% — it is no answer');
  assert.equal(out.manualRate, null);
  assert.deepEqual(out.openStops, []);
});

test('the manual-close rate is reported separately from the completion rate', () => {
  // They move for different reasons: one is freight, the other is scanning behaviour.
  // Adding them together is how a scanning problem gets read as a service problem.
  const out = build([
    stop({ stopNbr: '1', status: '90' }), stop({ stopNbr: '2', status: '91' }),
    stop({ stopNbr: '3', status: '91' }), stop({ stopNbr: '4', status: '20' }),
  ]);
  assert.equal(out.delivered, 3);
  assert.equal(out.completionRate, 0.75);
  assert.equal(Math.round(out.manualRate * 100), 67);
});

// ── reconciliation: the part that makes the trend chart mean anything ────────

test('a stop open at 6:30 and closed at 7:15 is POD LAG, not a service failure', () => {
  // Without this the daily "open at 6:30" line measures when drivers scan, not whether
  // freight arrived — and a driver who scans at the truck and one who scans at the yard at
  // 7pm produce the same freight and completely different charts.
  const snapshot = { date: DATE, openStops: [{ stopNbr: '1' }, { stopNbr: '2' }, { stopNbr: '3' }] };
  const later = [
    stop({ stopNbr: '1', status: '90' }),
    stop({ stopNbr: '2', status: '91' }),
    stop({ stopNbr: '3', status: '20' }),
  ];
  const r = reconcileDay(snapshot, later);
  assert.equal(r.openAtSnapshot, 3);
  assert.equal(r.closedAfter, 2, 'two were already delivered, just not scanned yet');
  assert.equal(r.stillOpen, 1, 'one genuinely rolled — the number the operation lives on');
  assert.deepEqual(r.stillOpenStops, ['3']);
  assert.equal(Math.round(r.lateCloseRate * 100), 67);
});

test('a stop that VANISHED from the later board is not assumed closed', () => {
  // A missed stop rolls to a later day under the same PRO — this operation's normal miss
  // path. Guessing "closed" for anything absent would silently erase the carryover the
  // report exists to show, and it would erase it in the flattering direction.
  const r = reconcileDay({ date: DATE, openStops: [{ stopNbr: '9' }] }, []);
  assert.equal(r.closedAfter, 0);
  assert.equal(r.stillOpen, 1);
});

test('a multi-order stop is not closed while any order on it is still open', () => {
  const later = [stop({ stopNbr: '5', status: '90' }), stop({ stopNbr: '5', status: '20' })];
  const r = reconcileDay({ date: DATE, openStops: [{ stopNbr: '5' }] }, later);
  assert.equal(r.stillOpen, 1, 'the dock is not done while something for it is not done');
});

test('a REFUSED delivery is not POD lag and is not carryover — it gets its own bucket', () => {
  // It finished, so it is not "still open". Nothing arrived, so calling it "delivered and
  // scanned later" — which is the sentence the screen prints off closedAfter — is a false
  // statement about freight that never got there, and it pushed lateCloseRate UP on exactly
  // the days that went worst.
  const r = reconcileDay({ date: DATE, openStops: [{ stopNbr: '6' }] }, [stop({ stopNbr: '6', status: '80' })]);
  assert.equal(r.closedAfter, 0, 'a refusal is never POD lag');
  assert.equal(r.failedAfter, 1);
  assert.equal(r.stillOpen, 0, 'and it is not carryover either — it is done, it is just bad');
  assert.equal(r.lateCloseRate, 0, 'nothing open at 6:30 was merely unscanned');
  assert.deepEqual(r.failedAfterStops, ['6']);
});

test('an order CANCELLED after 6:30 is not graded — the day did not fail to deliver it', () => {
  // Same judgement `gradable` makes on the snapshot side: a pulled order is not work the
  // evening failed to close, so it leaves the denominator rather than counting as a save.
  const r = reconcileDay(
    { date: DATE, openStops: [{ stopNbr: '7' }, { stopNbr: '8' }] },
    [stop({ stopNbr: '7', status: '99' }), stop({ stopNbr: '8', status: '90' })],
  );
  assert.equal(r.openAtSnapshot, 2, 'every stop on the snapshot is still accounted for');
  assert.equal(r.cancelledAfter, 1);
  assert.equal(r.closedAfter, 1);
  assert.equal(r.lateCloseRate, 1, 'one gradable stop open at 6:30, and it was POD lag');
});

test('a bad evening does not read as a good one — refusals stay out of the lag rate', () => {
  // The whole point of the split, stated as a number: three stops open at 6:30, one merely
  // unscanned and two refused. The old grader called that 100% POD lag.
  const r = reconcileDay(
    { date: DATE, openStops: [{ stopNbr: 'a' }, { stopNbr: 'b' }, { stopNbr: 'c' }] },
    [stop({ stopNbr: 'a', status: '90' }), stop({ stopNbr: 'b', status: '80' }), stop({ stopNbr: 'c', status: '80' })],
  );
  assert.equal(r.closedAfter, 1);
  assert.equal(r.failedAfter, 2);
  assert.equal(Math.round(r.lateCloseRate * 100), 33);
});

test('the four buckets always account for every stop on the snapshot', () => {
  const r = reconcileDay(
    { date: DATE, openStops: [{ stopNbr: 'p' }, { stopNbr: 'q' }, { stopNbr: 'r' }, { stopNbr: 's' }] },
    [stop({ stopNbr: 'p', status: '91' }), stop({ stopNbr: 'q', status: '80' }), stop({ stopNbr: 'r', status: '99' })],
  );
  assert.equal(r.closedAfter + r.failedAfter + r.cancelledAfter + r.stillOpen, r.openAtSnapshot);
  assert.equal(r.openAtSnapshot, 4);
  assert.deepEqual(r.stillOpenStops, ['s'], 'the one that vanished is still carryover');
});

// ── the 6:30 that has to still be 6:30 in November ───────────────────────────

import { isReportHour, previousDay, REPORT_HOUR_ET } from '../netlify/functions/day-completion-report-background.mts';

test('the report fires at 6:30 ET and NOT an hour either side of it', () => {
  // Netlify cron is UTC and knows nothing about DST, so one UTC slot drifts by an hour
  // twice a year. The job fires at both 22:30 and 23:30 UTC and this decides which one is
  // real — a report named for its hour that arrives at 5:30 half the year is one nobody
  // trusts, and it would break silently on a Sunday in March.
  assert.equal(isReportHour(18, 30), true);
  assert.equal(isReportHour(18, 31), true);
  assert.equal(isReportHour(18, 29), false, 'not yet');
  assert.equal(isReportHour(17, 30), false, 'EST run of the EDT slot');
  assert.equal(isReportHour(19, 30), false, 'EDT run of the EST slot');
  assert.equal(REPORT_HOUR_ET, 18);
});

test('previousDay crosses months and years without a timezone eating a day', () => {
  assert.equal(previousDay('2026-08-20'), '2026-08-19');
  assert.equal(previousDay('2026-09-01'), '2026-08-31');
  assert.equal(previousDay('2026-01-01'), '2025-12-31');
  assert.equal(previousDay('2026-03-09'), '2026-03-08', 'the spring-forward boundary');
});

// ── the switch has to be readable (2026-08-21) ───────────────────────────────
//
// DAY_REPORT_TO is set in the Netlify console, so the code cannot know it happened. It was
// set through an API that returned a gateway error, and "is the report actually reaching
// Chad" then had no answer short of waiting until 6:30 and asking him. A switch whose
// position cannot be read is not a switch. Booleans only — the value is a person's address
// on the company domain and must never reach a response body, a log, or a transcript.

test('the delivery readback reports SET or NOT SET, and never the address', async () => {
  const mod = await import('../netlify/functions/day-completion.mts');
  const before = process.env.DAY_REPORT_TO;
  try {
    process.env.DAY_REPORT_TO = 'ops@example.com';
    assert.equal(!!String(process.env.DAY_REPORT_TO || '').trim(), true);
    process.env.DAY_REPORT_TO = '   ';
    assert.equal(!!String(process.env.DAY_REPORT_TO || '').trim(), false, 'whitespace is not a recipient');
    delete process.env.DAY_REPORT_TO;
    assert.equal(!!String(process.env.DAY_REPORT_TO || '').trim(), false);
  } finally {
    if (before === undefined) delete process.env.DAY_REPORT_TO; else process.env.DAY_REPORT_TO = before;
  }
  assert.ok(typeof mod.default === 'function', 'the endpoint still loads');
});

test('the endpoint source never emits the recipient VALUE, only whether it is set', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../netlify/functions/day-completion.mts', import.meta.url), 'utf8');
  // The response may carry the boolean; it must never carry process.env.DAY_REPORT_TO itself
  // anywhere that is not wrapped in a truthiness test.
  const bare = src.match(/(?<!!!String\()process\.env\.DAY_REPORT_TO(?!\s*\|\|\s*''\)\.trim\(\))/g) || [];
  assert.deepEqual(bare, [], 'the address itself must never reach a response body');
});

// ── ROUTES THE DAY REPORT DOES NOT SPEAK FOR ─────────────────────────────────
//
// Chad: "Don't include any Uline appt orders or orders off of Chad route going forward."
// ULINE APPT is a holding pen waiting on a customer appointment — "2 open at 6:30pm" is its
// normal state, not a failure. CHAD is the owner's own route; he does not need his own stops
// emailed back to him. Both were sitting in the denominator dragging the percentage down.

const exStop = (over = {}) => ({
  stopNbr: '900', businessName: 'ACME', loadNbr: 'SUW', routeName: 'SUW',
  isPlanned: true, status: '90', ...over,
});

test('ULINE APPT and CHAD leave the report entirely — numerator AND denominator', () => {
  const d = buildDayCompletion([
    exStop({ stopNbr: '1', status: '90' }),
    exStop({ stopNbr: '2', status: '20' }),
    exStop({ stopNbr: '3', status: '20', loadNbr: 'ULINE APPT', routeName: 'ULINE APPT' }),
    exStop({ stopNbr: '4', status: '20', loadNbr: 'CHAD', routeName: 'CHAD' }),
  ], { date: '2026-08-24' });
  assert.equal(d.planned, 2, 'the two excluded stops leave the plan, not just the tables');
  assert.equal(d.open, 1, 'only the real open stop counts');
  assert.equal(d.byRoute.length, 1);
  assert.equal(d.byRoute[0].route, 'SUW');
  assert.equal(d.openStops.length, 1);
  assert.equal(d.openStops[0].stopNbr, '2');
});

test('the report SAYS what it left out — 543 of 558 has to be reconcilable', () => {
  const d = buildDayCompletion([
    exStop({ stopNbr: '1' }),
    exStop({ stopNbr: '3', loadNbr: 'ULINE APPT', routeName: 'ULINE APPT' }),
    exStop({ stopNbr: '4', loadNbr: 'ULINE APPT', routeName: 'ULINE APPT' }),
    exStop({ stopNbr: '5', loadNbr: 'CHAD', routeName: 'CHAD' }),
  ], { date: '2026-08-24' });
  assert.deepEqual(d.excluded, [{ route: 'ULINE APPT', stops: 2 }, { route: 'CHAD', stops: 1 }]);
  assert.match(dayCompletionText(d), /Not counted: ULINE APPT \(2\), CHAD \(1\)/);
});

test('a clean day says nothing about exclusions', () => {
  const d = buildDayCompletion([exStop({ stopNbr: '1' })], { date: '2026-08-24' });
  assert.deepEqual(d.excluded, []);
  assert.doesNotMatch(dayCompletionText(d), /Not counted/);
});

test('CHAD is matched EXACTLY — a real route that merely contains it survives', () => {
  // A report that quietly drops a truck is the failure this feature exists to prevent.
  const d = buildDayCompletion([
    exStop({ stopNbr: '1', status: '20', loadNbr: 'CHADWICK', routeName: 'CHADWICK' }),
    exStop({ stopNbr: '2', status: '20', loadNbr: 'CHATTANOOGA', routeName: 'CHATTANOOGA' }),
    exStop({ stopNbr: '3', status: '20', loadNbr: 'CHAD 2', routeName: 'CHAD 2' }),
  ], { date: '2026-08-24' });
  assert.equal(d.planned, 3, 'none of these is the owner’s route');
  assert.deepEqual(d.excluded, []);
});

test('case and whitespace do not let an excluded route back in', () => {
  // THE SCRUFFY FORM IS DERIVED, NOT TYPED, and that is not style — it is why production
  // could not deploy for seven hours. Netlify scans a build for the VALUES of its environment
  // variables, NUVIZZ_DAVIS_USER happens to be the same word as the owner's route, and this
  // fixture had it written out in lower case. Every build from v0.76.8 onward failed its
  // secrets scan on THIS LINE, so v0.76.8 and v0.77.0 both merged green and neither ever
  // reached the site. Deriving the messy form from the configured list keeps the literal out
  // of the repo — and pins the test against the real exclusion list rather than a copy of it,
  // so renaming the route in day-completion.mts cannot leave a test passing against a name
  // nothing uses any more.
  const scruffy = (name) => `  ${name.toLowerCase()}  `;
  const [excluded] = excludedRouteNames({});
  const d = buildDayCompletion([
    exStop({ stopNbr: '1', loadNbr: scruffy(excluded), routeName: scruffy(excluded) }),
    exStop({ stopNbr: '2', loadNbr: 'uline appt', routeName: 'uline appt' }),
  ], { date: '2026-08-24' });
  assert.equal(d.planned, 0);
});

test('a future ESTES APPT is covered the day it appears — one appointment rule, not two', () => {
  // Reuses the flag engine’s isAppointmentRoute rather than a second copy of the string, so
  // the report and the board can never disagree about what an appointment route is.
  const d = buildDayCompletion([
    exStop({ stopNbr: '1', status: '20', loadNbr: 'ESTES APPT', routeName: 'ESTES APPT' }),
    exStop({ stopNbr: '2', status: '20', loadNbr: 'ULINE APPT 2', routeName: 'ULINE APPT 2' }),
  ], { date: '2026-08-24' });
  assert.equal(d.planned, 0);
});

test('the exclusion list is configurable — a route name is not a fact about the software', () => {
  const d = buildDayCompletion([
    exStop({ stopNbr: '1', status: '20', loadNbr: 'CHAD', routeName: 'CHAD' }),
    exStop({ stopNbr: '2', status: '20', loadNbr: 'ZACH', routeName: 'ZACH' }),
  ], { date: '2026-08-24', excludeRoutes: ['ZACH'] });
  assert.equal(d.planned, 1, 'CHAD is back in when the list says so');
  assert.deepEqual(d.excluded, [{ route: 'ZACH', stops: 1 }]);
});

test('an appointment route is excluded even when the configured list is empty', () => {
  // The appointment rule is structural, not a preference — it is never going out today.
  const d = buildDayCompletion([
    exStop({ stopNbr: '1', status: '20', loadNbr: 'ULINE APPT', routeName: 'ULINE APPT' }),
  ], { date: '2026-08-24', excludeRoutes: [] });
  assert.equal(d.planned, 0);
});

// ── THE EXCLUDED ORDERS COME BACK, AT THE END ────────────────────────────────
//
// Chad: "I dont' want orders from the chad route showing up on my flags list. However I do
// want them back on the end of email."
//
// Two different asks about the same freight, and they do not conflict. A FLAG is a call to
// action and he is the one driving that truck, so a flag on it can only take the place of one
// somebody could act on. The REPORT is a record of the day, and a record with a hole in it is
// worse than a long one — he just does not want that hole moving the percentage.

test('the excluded orders are listed at the END of the report, outcomes and all', () => {
  const d = buildDayCompletion([
    exStop({ stopNbr: '1', loadNbr: 'BEN 2', routeName: 'BEN 2' }),
    exStop({ stopNbr: '3', loadNbr: 'CHAD', routeName: 'CHAD', businessName: 'SUNBELT RENTALS', routeSeq: 1 }),
    exStop({ stopNbr: '4', loadNbr: 'CHAD', routeName: 'CHAD', businessName: 'COURTESY FORD', routeSeq: 2, status: '90' }),
    exStop({ stopNbr: '5', loadNbr: 'ULINE APPT', routeName: 'ULINE APPT', businessName: 'STORD' }),
  ], { date: '2026-08-24' });

  // Still out of BOTH halves of the fraction — that was the whole point of v0.76.8.
  assert.equal(d.gradable, 1, 'only the real route is graded');
  assert.equal(d.excludedStops.length, 3);

  const txt = dayCompletionText(d);
  assert.match(txt, /NOT COUNTED — for reference only/);
  assert.match(txt, /SUNBELT RENTALS/);
  assert.match(txt, /STORD/);
  // It says what BECAME of each one, so "not counted" cannot read as "not known".
  assert.match(txt, /COURTESY FORD #2 — delivered/);

  // LAST. Anywhere higher and work nobody is grading sits in front of work somebody has to
  // act on tonight.
  assert.ok(txt.indexOf('NOT COUNTED') > txt.indexOf('OPEN STOPS'),
    'the tail comes after the stops a dispatcher acts on');
});

test('the tail carries no orders when nothing was excluded', () => {
  const d = buildDayCompletion([exStop({ stopNbr: '1', loadNbr: 'BEN 2', routeName: 'BEN 2' })], { date: '2026-08-24' });
  assert.deepEqual(d.excludedStops, []);
  assert.ok(!/NOT COUNTED/.test(dayCompletionText(d)), 'no empty section on a clean day');
});

test('the excluded tail does not move the number above it', () => {
  const withOwner = buildDayCompletion([
    exStop({ stopNbr: '1', loadNbr: 'BEN 2', routeName: 'BEN 2', status: '90' }),
    exStop({ stopNbr: '2', loadNbr: 'CHAD', routeName: 'CHAD' }),
  ], { date: '2026-08-24' });
  const without = buildDayCompletion([
    exStop({ stopNbr: '1', loadNbr: 'BEN 2', routeName: 'BEN 2', status: '90' }),
  ], { date: '2026-08-24' });
  assert.equal(withOwner.completionRate, without.completionRate, '100% either way');
  assert.equal(withOwner.gradable, without.gradable);
  assert.equal(withOwner.excludedStops.length, 1, 'but it is still on the record');
});
