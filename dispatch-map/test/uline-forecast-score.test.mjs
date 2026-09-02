// test/uline-forecast-score.test.mjs
//
// ULINE'S FORECAST, JUDGED — every rule pinned on real nights or on the exact edge it guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  versionInForce, latestUsable, ladderForDate, horizonDays, horizonBucket, closedShipDays, deliveryDayFor,
  actualFromManifestDay, classifyNight, scorePair, summarize, byWeekday, byHorizon, weekdayBias, patternSentences,
  deliveryOutlook, diffVersions, expectedVersionMissing, tonightLine, mergeActuals, buildView, etParts, operatingDayET,
  usFederalHolidays, davisClosedDays, unknownShipDays,
  ROUTE_DAY_ORDERS_DEFAULT, MIN_WEEKDAY_N, STATS_WINDOW_DAYS,
} from '../src/lib/uline-forecast-score.js';

const AUG = JSON.parse(readFileSync(new URL('./fixtures/uline-forecast-2026-08-04.json', import.meta.url), 'utf8'));
const JUL = JSON.parse(readFileSync(new URL('./fixtures/uline-forecast-2026-07-07.json', import.meta.url), 'utf8'));
const ACT = JSON.parse(readFileSync(new URL('./fixtures/uline-forecast-actuals-2026-08.json', import.meta.url), 'utf8'));

const version = (fix, over = {}) => ({ versionId: `davis__${fix.sentDate}__deadbeef`, sentAt: fix.sentAt, sentDate: fix.sentDate, ok: true, from: fix.from, to: fix.to, days: fix.days, unreadableDates: [], medianBand: 62, rowsUsed: fix.rowsTotal, rowsTotal: fix.rowsTotal, ...over });
const V_AUG = version(AUG); const V_JUL = version(JUL);
/** manifest_days rows as the masked listDocs returns them. */
const manifestRows = () => Object.entries(ACT.nights).map(([d, n]) => ({ _id: `davis__${d}`, latest: { orders: n.orders, verified: n.verified, receivedAt: n.receivedAt, at: n.at, reportNo: n.reportNo, mailbox: 'gmail', totals: n.totals }, reportCount: n.reportCount, sawOrderCountFall: n.sawOrderCountFall }));
const TODAY = '2026-09-02';
// 10:51 EDT on a ship date, and the same clock in EST.
const edt = (iso, h, m) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), h + 4, m);
const est = (iso, h, m) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), h + 5, m);

// ── THE FIRST SCORE, PINNED ───────────────────────────────────────────────────

test('THE FIRST SCORE REPRODUCES: the Aug-04 file vs the 11 real nights — MAE 27.3, bias −6.7, never over the high', () => {
  const view = buildView({ versions: [V_AUG], manifestRows: manifestRows(), today: TODAY });
  assert.equal(view.counts.scored, 11, `all eleven count: ${JSON.stringify(view.unscored.map((u) => [u.date, u.status, u.reason]))}`);
  const s = view.stats.windows[30];
  assert.equal(s.n, 11);
  assert.equal(s.mae, 27.3);
  assert.equal(s.bias, -6.7, 'Uline runs slightly high');
  assert.equal(view.scored.filter((p) => p.err > 0).length, 3, 'three nights over the estimate');
  assert.equal(s.overHigh.count, 0, 'and none over Uline\'s own high');
  assert.deepEqual(s.worst, { date: '2026-09-01', err: 62, verdict: 'heavy' });
  assert.equal(view.floor, '2026-08-20');
  assert.deepEqual(view.holes, [], 'no holes: the nights before the archive are not holes');
});

test('the seven nights filed without a receive time score off the FILED time, which says 1am — final, not provisional', () => {
  // Number(null) is 0. Written the natural way the rule reads 7 complete reports as
  // preliminaries and the scorecard loses most of its nights for no reason.
  const n = ACT.nights['2026-08-20'];
  assert.equal(n.receivedAt, null, 'the fixture really has no receive time');
  const a = actualFromManifestDay({ latest: { orders: n.orders, verified: true, receivedAt: null, at: n.at, reportNo: n.reportNo }, reportCount: n.reportCount }, '2026-08-20');
  assert.equal(a.status, 'actual');
  assert.equal(a.stampFrom, 'filedAt');
});

// ── WHICH VERSION, HOW FAR OUT ────────────────────────────────────────────────

test('THE VERSION IN FORCE was in hand BEFORE the ship date — a file sent on the day is hindsight', () => {
  const onTheDay = version(AUG, { versionId: 'x', sentDate: '2026-09-01', sentAt: AUG.sentAt + 1 });
  assert.equal(versionInForce([V_JUL, V_AUG, onTheDay], '2026-09-01').versionId, V_AUG.versionId);
  assert.equal(versionInForce([V_JUL, V_AUG], '2026-08-04'), V_JUL, 'on Aug 4 itself the July file was the one in hand');
  assert.equal(versionInForce([V_JUL, V_AUG], '2026-07-01'), null, 'nothing was in hand for a date before any file');
  assert.equal(versionInForce([version(AUG, { ok: false })], '2026-09-01'), null, 'an unreadable version is never in force');
  assert.equal(latestUsable([V_JUL, V_AUG]).versionId, V_AUG.versionId, 'the outlook reads the newest');
});

test('HORIZON: the Aug-04 file is ≤4w for Sep 1; the Jul-07 file is 5–8w for the same night', () => {
  assert.equal(horizonDays('2026-08-04', '2026-09-01'), 28);
  assert.equal(horizonBucket(28), '≤4w');
  assert.equal(horizonDays('2026-07-07', '2026-09-01'), 56);
  assert.equal(horizonBucket(56), '5–8w');
  assert.equal(horizonBucket(57), '9–13w');
  assert.equal(horizonBucket(92), '14w+');
  assert.equal(horizonBucket(400), '14w+');
  const ladder = ladderForDate([V_AUG, V_JUL], '2026-09-01');
  assert.deepEqual(ladder.map((l) => [l.sentDate, l.estimate, l.bucket]), [['2026-07-07', 698, '5–8w'], ['2026-08-04', 702, '≤4w']]);
});

// ── THE VERDICT ───────────────────────────────────────────────────────────────

test('SEP 1: 764 against 702 (high 773) is +62 and HEAVY — a route-day nobody staffed — and not over the high', () => {
  const s = scorePair({ actual: 764, est: 702, upper: 773 });
  assert.equal(s.err, 62);
  assert.equal(s.verdict, 'heavy');
  assert.equal(s.overHigh, false);
  assert.equal(scorePair({ actual: 773, est: 702, upper: 773 }).verdict, 'heavy', 'AT the ceiling is not over it');
  assert.equal(scorePair({ actual: 774, est: 702, upper: 773 }).verdict, 'over_high', 'one more and it is');
});

test('HEAVY IS LOUDER THAN LIGHT: +35 is amber, −35 is nothing, −70 is grey, a fragment is a suspect', () => {
  assert.equal(scorePair({ actual: 735, est: 700, upper: 760 }).verdict, 'heavy');
  assert.equal(scorePair({ actual: 665, est: 700, upper: 760 }).verdict, 'on');
  assert.equal(scorePair({ actual: 630, est: 700, upper: 760 }).verdict, 'light');
  // band 60 → under 700 − 120 = 580 is more often a filed fragment than a quiet night.
  assert.equal(scorePair({ actual: 570, est: 700, upper: 760 }).verdict, 'light_suspect');
  assert.equal(scorePair({ actual: 570, est: 700, upper: null, medianBand: 60 }).verdict, 'light_suspect', 'the version median band stands in for a missing high');
  assert.equal(scorePair({ actual: 735, est: 700, upper: 760, routeDay: 50 }).verdict, 'on', 'Chad\'s route-day moves the line');
  assert.equal(ROUTE_DAY_ORDERS_DEFAULT, 35);
});

test('pct is null when the estimate is 0; a non-number scores nothing', () => {
  assert.equal(scorePair({ actual: 5, est: 0, upper: null }).pct, null);
  assert.equal(scorePair({ actual: null, est: 700 }).err, null);
});

// ── WHAT COUNTS AS AN ACTUAL ──────────────────────────────────────────────────

test('THE 10:51am PRELIMINARY IS PROVISIONAL — in EDT and in EST — and excluded, with the reason', () => {
  const row = (receivedAt) => ({ latest: { orders: 380, verified: true, receivedAt, at: '2026-09-01T15:00:00Z', reportNo: 1 }, reportCount: 1 });
  assert.equal(actualFromManifestDay(row(edt('2026-09-01', 10, 51)), '2026-09-01').status, 'provisional');
  assert.equal(actualFromManifestDay(row(est('2026-01-13', 10, 51)), '2026-01-13').status, 'provisional');
  assert.match(actualFromManifestDay(row(edt('2026-09-01', 10, 51)), '2026-09-01').reason, /only the early report on file \(380 at 10:51\)/);
  // The 8pm full report, and a 1am next-day one, are final.
  assert.equal(actualFromManifestDay(row(edt('2026-09-01', 20, 0)), '2026-09-01').status, 'actual');
  assert.equal(actualFromManifestDay(row(edt('2026-09-02', 1, 0)), '2026-09-01').status, 'actual');
  // 19:00 EST on a January night is final too — a 20:00 boundary would have called it early.
  assert.equal(actualFromManifestDay(row(est('2026-01-13', 19, 0)), '2026-01-13').status, 'actual');
});

test('unverified, count-fell and no-time nights are excluded with THEIR reasons, never scored and never silently dropped', () => {
  assert.equal(actualFromManifestDay({ latest: { orders: 600, verified: false, receivedAt: edt('2026-09-01', 20, 0) } }, '2026-09-01').status, 'unverified');
  assert.equal(actualFromManifestDay({ latest: { orders: 600, verified: true, receivedAt: edt('2026-09-01', 20, 0) }, sawOrderCountFall: true }, '2026-09-01').status, 'count_fell');
  const unknown = actualFromManifestDay({ latest: { orders: 600, verified: true, receivedAt: null, at: null } }, '2026-09-01');
  assert.equal(unknown.status, 'unknown');
  assert.match(unknown.reason, /cannot tell the preliminary from the final/);
  assert.equal(actualFromManifestDay(null, '2026-09-01').status, 'missing');
});

// ── WHERE A NIGHT STANDS ──────────────────────────────────────────────────────

test('A SUNDAY WITH NO MANIFEST YET IS PENDING, NOT A HOLE — its reports cannot be filed until Monday evening\'s board exists', () => {
  const c = classifyNight({ shipIso: '2026-09-06', version: V_AUG, row: null, floor: '2026-08-20', today: '2026-09-06' });
  assert.equal(c.status, 'pending');
  assert.equal(c.deliverOn, '2026-09-08', 'Sunday ships deliver Tuesday');
  assert.match(c.reason, /filed once the Tue 9\/8 board is scanned/);
  // Tonight's own ship date is pending too, not "no report".
  assert.equal(classifyNight({ shipIso: '2026-09-02', version: V_AUG, row: null, floor: '2026-08-20', today: '2026-09-02' }).status, 'pending');
  // Once the delivery day has passed with nothing filed, it is a hole.
  assert.equal(classifyNight({ shipIso: '2026-09-06', version: V_AUG, row: null, floor: '2026-08-20', today: '2026-09-09' }).status, 'hole');
});

test('A WEEKDAY BEFORE THE ARCHIVE BEGAN IS NOT A HOLE — nothing was there to miss', () => {
  const c = classifyNight({ shipIso: '2026-07-15', version: V_JUL, row: null, floor: '2026-08-20', today: TODAY });
  assert.equal(c.status, 'before_archive');
  assert.match(c.reason, /before the manifest archive began \(2026-08-20\)/);
});

test('LABOR DAY IS CLOSED, A SATURDAY MANIFEST IS UNFORECAST, A DATE PAST THE FILE IS UNCOVERED, A BAD ROW IS UNREADABLE', () => {
  assert.equal(classifyNight({ shipIso: '2026-09-07', version: V_AUG, row: null, floor: '2026-08-20', today: '2026-09-10' }).status, 'closed');
  const sat = classifyNight({ shipIso: '2026-08-22', version: V_AUG, row: { latest: { orders: 12, verified: true, receivedAt: edt('2026-08-22', 21, 0) } }, floor: '2026-08-20', today: TODAY });
  assert.equal(sat.status, 'unforecast');
  const past = classifyNight({ shipIso: '2027-09-01', version: V_AUG, row: null, floor: '2026-08-20', today: '2027-09-05' });
  assert.equal(past.status, 'uncovered', 'a broken-ingest month must not read as a run of holidays');
  assert.match(past.reason, /runs 2026-07-15 to 2027-08-13/);
  const bad = version(AUG, { unreadableDates: ['2026-09-16'], days: Object.fromEntries(Object.entries(AUG.days).filter(([d]) => d !== '2026-09-16')) });
  assert.equal(classifyNight({ shipIso: '2026-09-16', version: bad, row: null, floor: '2026-08-20', today: '2026-09-20' }).status, 'unreadable');
});

// ── HOLIDAYS: THE FILE IS THE CALENDAR ────────────────────────────────────────

test('TWO CALENDARS: Uline closed is not Davis closed — Labor Day rolls Friday to Tuesday, Christmas Eve keeps Wednesday\'s freight, ULINE_DAVIS_CLOSED moves it', () => {
  const uline = closedShipDays(V_AUG);
  for (const d of ['2026-09-07', '2026-11-26', '2026-12-24', '2026-12-25', '2027-01-01', '2027-05-31', '2027-07-05']) assert.ok(uline.has(d), `Uline does not ship ${d}`);
  assert.ok(!uline.has('2026-09-08'));
  const davis = davisClosedDays(V_AUG);
  assert.deepEqual([...davis], [['2026-09-07', 'Labor Day'], ['2026-11-26', 'Thanksgiving'], ['2026-12-25', 'Christmas Day'], ['2027-01-01', "New Year's Day"], ['2027-05-31', 'Memorial Day'], ['2027-07-05', 'Independence Day']]);
  assert.ok(!davis.has('2026-12-24'), 'Christmas Eve: Uline does not ship, Davis still delivers');
  assert.equal(deliveryDayFor('2026-09-04', davis), '2026-09-08', 'Friday rolls past Labor Day');
  assert.equal(deliveryDayFor('2026-09-06', davis), '2026-09-08', 'Sunday delivers Tuesday as always');
  assert.equal(deliveryDayFor('2026-09-03', davis), '2026-09-04', 'an ordinary Thursday is unchanged');
  assert.equal(deliveryDayFor('2026-12-23', davis), '2026-12-24', "Wednesday's 318 orders are delivered on Christmas Eve");
  assert.equal(deliveryDayFor('2026-11-25', davis), '2026-11-27', 'the Wednesday before Thanksgiving delivers Friday');
  assert.equal(deliveryDayFor('2026-12-31', davis), '2027-01-04', "New Year's Eve's freight rolls past New Year's Day to Monday");
  // Chad's list: the day Davis takes off that Uline's file cannot know. Junk in the list is ignored.
  const eve = davisClosedDays(V_AUG, ['2026-12-24', 'not-a-date', null]);
  assert.equal(eve.get('2026-12-24'), 'Davis closed');
  assert.equal(eve.size, 7);
  assert.equal(deliveryDayFor('2026-12-23', eve), '2026-12-28', 'with Christmas Eve off, Wednesday rolls to Monday');
  // The rule this replaces — every Uline gap is a Davis holiday — printed "no deliveries" for Christmas Eve.
  assert.equal(deliveryDayFor('2026-12-23', uline), '2026-12-28');
  // Federal holidays as observed: July 4th 2026 is a Saturday → Fri 7/3; Christmas 2027 → Fri 12/24; New Year's 2028 → Fri 12/31/2027.
  assert.equal(usFederalHolidays(2026).get('2026-07-03'), 'Independence Day');
  assert.equal(usFederalHolidays(2026).get('2026-11-26'), 'Thanksgiving');
  assert.equal(usFederalHolidays(2027).get('2027-12-24'), 'Christmas Day');
  assert.equal(usFederalHolidays(2027).get('2027-12-31'), "New Year's Day");
  assert.equal(usFederalHolidays(2027).size, 12);
  assert.equal(usFederalHolidays('nope').size, 0);
  assert.equal(davisClosedDays(null).size, 0);
  // A federal holiday Uline SHIPS on is a working day: the July file has a Juneteenth row.
  assert.ok(JUL.days['2026-06-19'], 'the fixture has the row');
  assert.ok(!davisClosedDays(V_JUL).has('2026-06-19'));
});

test('THE OUTLOOK ROLLS UP BY DELIVERY DAY: Tue 9/8 = Fri 9/4 + Sun 9/6, Mon 9/7 reads closed, Wed 9/9 = Tue 9/8', () => {
  const rows = deliveryOutlook({ version: V_AUG, today: TODAY, days: 14 });
  const by = Object.fromEntries(rows.map((r) => [r.deliverOn, r]));
  assert.equal(by['2026-09-07'].status, 'closed');
  assert.match(by['2026-09-07'].notes.join(' '), /Labor Day — no deliveries/);
  const tue = by['2026-09-08'];
  assert.deepEqual(tue.ships.map((s) => s.date), ['2026-09-04', '2026-09-06']);
  assert.equal(tue.est, AUG.days['2026-09-04'][0] + AUG.days['2026-09-06'][0]);
  assert.equal(tue.upper, AUG.days['2026-09-04'][1] + AUG.days['2026-09-06'][1]);
  assert.match(tue.notes.join(' '), /Fri 9\/4 freight rolled past Labor Day/);
  assert.match(tue.notes.join(' '), /Uline closed 9\/7/);
  assert.deepEqual(by['2026-09-09'].ships.map((s) => s.date), ['2026-09-08']);
  // An ordinary week: Tuesday is Sunday + Monday, the heavy day nobody sees in the spreadsheet.
  assert.deepEqual(by['2026-09-15'].ships.map((s) => s.date), ['2026-09-13', '2026-09-14']);
  assert.equal(by['2026-09-15'].est, AUG.days['2026-09-13'][0] + AUG.days['2026-09-14'][0]);
  // Monday is Friday's freight — but an ORDINARY Monday is not LIGHT. Light is judged against
  // its own weekday; against all days the chip was on 33 of 37 Mondays and meant nothing.
  assert.deepEqual(by['2026-09-14'].ships.map((s) => s.date), ['2026-09-11']);
  assert.ok(!by['2026-09-14'].chips.includes('LIGHT'), `an ordinary Monday (526 against a typical 512) is not light: ${JSON.stringify(by['2026-09-14'].chips)}`);
  assert.ok(!by['2026-09-15'].chips.includes('LIGHT'));
  // The Tuesday after Labor Day IS light for a Tuesday: Friday's + Sunday's freight, not Sunday's + Monday's.
  assert.ok(tue.chips.includes('LIGHT'));
  assert.match(tue.notes.join(' '), /light for a Tue — typical 746/);
  assert.equal(rows.every((r) => r.deliverOn > TODAY), true);
  // FOURTEEN DELIVERY DAYS ARE ~20 CALENDAR DAYS: the last rows carry their freight (the old
  // ship window stopped at today+17 and read "no Uline freight expected" against a 770-order Tuesday).
  assert.equal(rows.length, 14);
  const lastRow = rows[rows.length - 1];
  assert.equal(lastRow.deliverOn, '2026-09-22');
  assert.deepEqual(lastRow.ships.map((s) => s.date), ['2026-09-20', '2026-09-21']);
  assert.equal(lastRow.est, AUG.days['2026-09-20'][0] + AUG.days['2026-09-21'][0]);
  for (const r of rows) assert.ok(r.status !== 'none', `${r.label} inside the file must never read as no freight: ${JSON.stringify(r.notes)}`);
  // The Monday after Thanksgiving at 234 (Friday 11/27's freight) is the LIGHT that matters — and Christmas Eve at 318 is a light Thursday, not a closed one.
  const nov = Object.fromEntries(deliveryOutlook({ version: V_AUG, today: '2026-11-20', days: 14 }).map((r) => [r.deliverOn, r]));
  assert.ok(nov['2026-11-30'].chips.includes('LIGHT'), JSON.stringify(nov['2026-11-30']));
  assert.equal(nov['2026-11-30'].est, 234);
  assert.equal(nov['2026-11-26'].status, 'closed');
  assert.match(nov['2026-11-26'].notes.join(' '), /Thanksgiving — no deliveries/);
  assert.deepEqual(nov['2026-11-27'].ships.map((s) => s.date), ['2026-11-25'], 'the Wednesday before Thanksgiving delivers Friday');
  const dec = Object.fromEntries(deliveryOutlook({ version: V_AUG, today: '2026-12-21', days: 8 }).map((r) => [r.deliverOn, r]));
  assert.equal(dec['2026-12-24'].status, 'ok');
  assert.deepEqual(dec['2026-12-24'].ships.map((s) => s.date), ['2026-12-23']);
  assert.equal(dec['2026-12-24'].est, 318);
  assert.ok(dec['2026-12-24'].chips.includes('LIGHT'));
  assert.equal(dec['2026-12-25'].status, 'closed');
  assert.equal(dec['2026-12-28'].status, 'none', 'nothing shipped Thursday or Friday');
  assert.match(dec['2026-12-28'].notes.join(' '), /Uline closed 12\/24, 12\/25/);
  const eve = Object.fromEntries(deliveryOutlook({ version: V_AUG, today: '2026-12-21', days: 8, davisClosed: ['2026-12-24'] }).map((r) => [r.deliverOn, r]));
  assert.equal(eve['2026-12-24'].status, 'closed');
  assert.match(eve['2026-12-24'].notes.join(' '), /Davis closed — no deliveries/);
  assert.deepEqual(eve['2026-12-28'].ships.map((s) => s.date), ['2026-12-23']);
  assert.match(eve['2026-12-28'].notes.join(' '), /Wed 12\/23 freight rolled past Davis closed/);
});

test('THE PLAN ONLY EVER MOVES UP, only at n ≥ 4 per contributing weekday, rounded up to 5; a high-running Uline is named, not trimmed', () => {
  const noBias = deliveryOutlook({ version: V_AUG, today: TODAY, bias: { 0: { n: 2, bias: 30 }, 1: { n: 2, bias: 30 } } });
  const tue = noBias.find((r) => r.deliverOn === '2026-09-15');
  assert.equal(tue.plan, tue.est, 'not enough nights: the plan IS Uline\'s number');
  assert.match(tue.notes.join(' '), /not enough nights to adjust/);
  const low = deliveryOutlook({ version: V_AUG, today: TODAY, bias: { 0: { n: 4, bias: 12 }, 1: { n: 5, bias: 30 } } });
  const t2 = low.find((r) => r.deliverOn === '2026-09-15');
  assert.equal(t2.plan, Math.ceil((t2.est + 42) / 5) * 5);
  assert.equal(t2.adjusted, true);
  const high = deliveryOutlook({ version: V_AUG, today: TODAY, bias: { 0: { n: 4, bias: -9 }, 1: { n: 5, bias: -7 } } });
  const t3 = high.find((r) => r.deliverOn === '2026-09-15');
  assert.equal(t3.plan, t3.est, 'never trimmed');
  assert.match(t3.notes.join(' '), /Uline has run Sun 9 high, Mon 7 high — the plan is not trimmed/);
});

test('HEAVY and could-be-over chips exist only when Chad\'s capacity is set', () => {
  const none = deliveryOutlook({ version: V_AUG, today: TODAY });
  assert.ok(none.every((r) => !r.chips.includes('HEAVY') && !r.chips.includes('could be over')));
  const capped = deliveryOutlook({ version: V_AUG, today: TODAY, capacity: 720 });
  const tue = capped.find((r) => r.deliverOn === '2026-09-15');
  assert.ok(tue.est > 720, 'fixture sanity: Sun+Mon exceeds 720');
  assert.ok(tue.chips.includes('HEAVY'));
  const wed = capped.find((r) => r.deliverOn === '2026-09-16');
  assert.ok(wed.est <= 720 && wed.upper > 720, `fixture sanity: ${wed.est}/${wed.upper}`);
  assert.ok(wed.chips.includes('could be over'));
});

test('a day past the file is "not forecast yet"; a day Uline sent an unreadable row for is NOT "no freight"', () => {
  const short = version(AUG, { to: '2026-09-10', days: Object.fromEntries(Object.entries(AUG.days).filter(([d]) => d <= '2026-09-10')) });
  const rows = deliveryOutlook({ version: short, today: TODAY, days: 14 });
  assert.equal(rows.find((r) => r.deliverOn === '2026-09-14').status, 'not_forecast_yet');
  const bad = version(AUG, { unreadableDates: ['2026-09-15'], days: Object.fromEntries(Object.entries(AUG.days).filter(([d]) => d !== '2026-09-15')) });
  const wed = deliveryOutlook({ version: bad, today: TODAY, days: 14 }).find((r) => r.deliverOn === '2026-09-16');
  assert.equal(wed.status, 'unreadable');
  assert.match(wed.notes.join(' '), /no readable estimate for 9\/15/);
  assert.equal(wed.plan, null, 'no confident number for a day with no number');
});

// ── ROLL-UPS AND SENTENCES ────────────────────────────────────────────────────

test('an empty window is n:0 and nulls — never NaN', () => {
  const s = summarize([]);
  assert.equal(s.n, 0); assert.equal(s.mae, null); assert.equal(s.bias, null); assert.equal(s.worst, null);
  assert.equal(s.overHigh.rate, null);
});

test('byWeekday prints nothing below n = 4', () => {
  const view = buildView({ versions: [V_AUG], manifestRows: manifestRows(), today: TODAY });
  for (const w of Object.values(view.stats.byWeekday)) { assert.ok(w.n < MIN_WEEKDAY_N); assert.equal(w.shown, false); assert.equal(w.mae, null); }
});

test('THE PATTERN SENTENCE fires on 3 of the last 5 same-weekday nights ≥ 30 the same side, and not on 2', () => {
  const tue = (d, err) => ({ date: d, err, verdict: 'on' });
  const fires = patternSentences([tue('2026-08-04', 40), tue('2026-08-11', 5), tue('2026-08-18', 35), tue('2026-08-25', -10), tue('2026-09-01', 62)]);
  assert.equal(fires.length, 1);
  assert.match(fires[0].text, /Tuesdays: Uline's number has run 46 low on 3 of the last 5/);
  assert.equal(patternSentences([tue('2026-08-18', 35), tue('2026-08-25', -10), tue('2026-09-01', 62)]).length, 0, 'two is coincidence');
  assert.equal(patternSentences([tue('2026-08-04', 40), tue('2026-08-11', -40), tue('2026-08-18', 5), tue('2026-08-25', -40), tue('2026-09-01', 35)]).length, 0, 'two each way is not a pattern');
});

test('byHorizon buckets every version\'s pair; weekdayBias keeps only the last 90 days', () => {
  const view = buildView({ versions: [V_JUL, V_AUG], manifestRows: manifestRows(), today: TODAY });
  assert.equal(view.stats.byHorizon['≤4w'].n, 11, 'Aug-04 pairs');
  assert.equal(view.stats.byHorizon['5–8w'].n, 11, 'Jul-07 pairs for the same nights');
  assert.equal(view.stats.byHorizon['14w+'].n, 0);
  const b = weekdayBias([{ date: '2026-05-01', err: 100 }, { date: '2026-08-28', err: 10 }], TODAY);
  assert.equal(b[5].n, 1, 'May is outside the quarter');
  assert.equal(b[5].bias, 10);
});

// ── VERSIONS OVER TIME ────────────────────────────────────────────────────────

test('an ~8-order monthly wobble is not a change note; a week raised ~90/day is', () => {
  const real = diffVersions(V_JUL, V_AUG, '2026-08-04');
  assert.equal(real.overlap, 308);
  assert.equal(real.unchanged, 14);
  assert.deepEqual(real.weeks, [], 'the real revision moved nothing worth a sentence');
  const raised = version(AUG, { days: Object.fromEntries(Object.entries(AUG.days).map(([d, [e, u]]) => [d, d >= '2026-09-21' && d <= '2026-09-27' ? [e + 90, u + 90] : [e, u]])) });
  const w = diffVersions(V_AUG, raised, TODAY).weeks;
  assert.equal(w.length, 1);
  assert.equal(w[0].text, 'Uline raised the week of 9/21 by ~90/day');
});

test('the forecast is EXPECTED by the 11th: missing then, not before, and an unreadable one does not count', () => {
  assert.equal(expectedVersionMissing([V_AUG], '2026-09-11'), true);
  assert.equal(expectedVersionMissing([V_AUG], '2026-09-05'), false);
  assert.equal(expectedVersionMissing([V_AUG, version(AUG, { sentDate: '2026-09-03', ok: false })], '2026-09-11'), true);
  assert.equal(expectedVersionMissing([V_AUG, version(AUG, { sentDate: '2026-09-03' })], '2026-09-11'), false);
});

// ── TONIGHT ───────────────────────────────────────────────────────────────────

test('TONIGHT: no report, the preliminary only, over the estimate under the high, and OVER THE HIGH — and Sunday reads "deliver Tue"', () => {
  const none = tonightLine({ version: V_AUG, row: null, shipIso: '2026-09-02', today: '2026-09-02' });
  assert.equal(none.head, 'Ship Wed 9/2 → deliver Thu 9/3');
  assert.match(none.text, /no report yet tonight/);
  const prelim = tonightLine({ version: V_AUG, row: { latest: { orders: 380, verified: true, receivedAt: edt('2026-09-02', 10, 51), reportNo: 1 } }, shipIso: '2026-09-02', today: '2026-09-02' });
  assert.match(prelim.text, /only the preliminary so far \(380 at 10:51\)/);
  const over = tonightLine({ version: V_AUG, row: { latest: { orders: 733, verified: true, receivedAt: edt('2026-09-02', 21, 40), reportNo: 3 } }, shipIso: '2026-09-02', today: '2026-09-02' });
  assert.equal(over.status, 'on');
  assert.match(over.text, /manifest so far 733 \(#3, 21:40\) · 27 over the estimate, under the high/);
  const high = tonightLine({ version: V_AUG, row: { latest: { orders: 790, verified: true, receivedAt: edt('2026-09-02', 21, 40), reportNo: 3 } }, shipIso: '2026-09-02', today: '2026-09-02' });
  assert.equal(high.tone, 'red');
  assert.match(high.text, /OVER ULINE'S HIGH by 9 — heavy morning/);
  const sun = tonightLine({ version: V_AUG, row: null, shipIso: '2026-09-06', today: '2026-09-06' });
  assert.equal(sun.head, 'Ship Sun 9/6 → deliver Tue 9/8');
  const labor = tonightLine({ version: V_AUG, row: null, shipIso: '2026-09-07', today: '2026-09-07' });
  assert.equal(labor.text, 'Labor Day — Uline closed, no reports tonight');
  assert.equal(labor.status, 'closed');
  assert.equal(tonightLine({ version: V_AUG, row: null, shipIso: '2026-12-24', today: '2026-12-24' }).text, 'Uline closed today — no reports tonight', 'Christmas Eve: Uline closed, Davis ran');
  // Saturday is not "no forecast" — that is what a short file reads as. Say what Saturday is, and what is next.
  const sat = tonightLine({ version: V_AUG, row: null, shipIso: '2026-09-05', today: '2026-09-05' });
  assert.equal(sat.status, 'closed');
  assert.equal(sat.head, 'Sat 9/5 — Uline does not ship Saturdays');
  assert.equal(sat.text, 'next: Sun 9/6 ships → Tue 9/8 · Uline 71 (high 95)');
  assert.equal(tonightLine({ version: V_AUG, row: null, shipIso: '2027-09-04', today: '2027-09-04' }).text, 'no reports tonight', 'a Saturday past the file still is not "no forecast"');
});

test('NO "UNCOVERED" FILLER BEFORE THE FIRST FILE WAS IN HAND: the ledger starts the day after the earliest version was sent', () => {
  const v = buildView({ versions: [V_JUL, V_AUG], manifestRows: manifestRows(), today: TODAY, windowDays: 60 });
  assert.ok(!v.unscored.some((u) => u.status === 'uncovered'), `uncovered rows: ${JSON.stringify(v.unscored.filter((u) => u.status === 'uncovered').map((u) => u.date))}`);
  const dates = [...v.scored, ...v.unscored, ...v.pending, ...v.closed].map((x) => x.date).sort();
  assert.equal(dates[0], '2026-07-08', 'the July 7 file was in force from July 8');
  // A file whose range starts AFTER its send date starts the ledger at its range.
  const late = version(AUG, { versionId: 'late', sentDate: '2026-07-01', sentAt: Date.UTC(2026, 6, 1, 12) });
  const w = buildView({ versions: [late], manifestRows: [], today: TODAY, windowDays: 60 });
  assert.equal([...w.unscored, ...w.closed, ...w.pending, ...w.holes].map((x) => x.date).sort()[0], AUG.from);
  assert.ok(!w.unscored.some((u) => u.status === 'uncovered'));
});

test('the operating day rolls at 5am ET', () => {
  assert.equal(operatingDayET(edt('2026-09-02', 4, 30)), '2026-09-01');
  assert.equal(operatingDayET(edt('2026-09-02', 5, 0)), '2026-09-02');
  assert.equal(operatingDayET(null), null, 'Number(null) is not an instant');
  assert.equal(etParts(0), null);
});

// ── TWO SOURCES OF ACTUALS ────────────────────────────────────────────────────

test('manifest_days wins over the back-fill, and a date in both with a different count is a disagreement', () => {
  const { rows, disagreements } = mergeActuals(
    [{ _id: 'davis__2026-08-20', latest: { orders: 686, verified: true } }],
    [{ _id: 'davis__2026-08-20', orders: 680, verified: true }, { _id: 'davis__2025-09-01', orders: 601, verified: true, receivedAt: 1 }],
  );
  assert.equal(rows.get('2026-08-20').latest.orders, 686);
  assert.equal(rows.get('2025-09-01').source, 'uline_actual_days');
  assert.deepEqual(disagreements, [{ date: '2026-08-20', manifestDays: 686, backfill: 680 }]);
});

// ── THE SHAPE THE SCREEN RELIES ON ────────────────────────────────────────────

test('WITH NOTHING ON FILE every array is an array and the note says why', () => {
  const v = buildView({ versions: [], manifestRows: [], today: TODAY });
  for (const k of ['versions', 'outlook', 'scored', 'unscored', 'pending', 'holes', 'closed', 'unforecast', 'changes', 'pattern', 'disagreements']) assert.ok(Array.isArray(v[k]), k);
  assert.equal(v.latest, null);
  assert.equal(v.note, 'no forecast on file yet');
  assert.equal(buildView({ versions: [version(AUG, { ok: false })], manifestRows: [], today: TODAY }).note, 'no readable forecast on file yet');
  assert.match(buildView({ versions: [], manifestRows: [] }).note, /nowMs or today is required/);
});

test('the full view: today is pending, Saturdays are closed, the pre-archive weeks are unscored not holes, versions never carry days', () => {
  const v = buildView({ versions: [V_JUL, V_AUG], manifestRows: manifestRows(), today: TODAY, windowDays: 60 });
  assert.equal(v.pending.length, 1);
  assert.equal(v.pending[0].date, TODAY);
  assert.ok(v.closed.some((c) => c.date === '2026-08-22' && /Saturday/.test(c.reason)));
  assert.ok(v.unscored.some((u) => u.status === 'before_archive' && u.date === '2026-08-19'));
  assert.deepEqual(v.holes, []);
  assert.equal(v.tonight.shipIso, TODAY);
  assert.ok(v.versions.every((x) => !('days' in x)));
  assert.equal(v.versions[0].sentDate, '2026-08-04', 'newest first');
  assert.equal(v.latest.versionId, V_AUG.versionId);
  assert.ok(v.outlook.length >= 10);
});

// ── TONIGHT IS NOT A NIGHT YET ────────────────────────────────────────────────

test('AN 8PM REPORT FOR TODAY\'S SHIP DATE IS PENDING, NOT SCORED — the scorecard does not move on a third of the freight, and the same row scores after the 5am roll', () => {
  const rows = manifestRows();
  rows.push({ _id: `davis__${TODAY}`, latest: { orders: 420, verified: true, receivedAt: edt(TODAY, 20, 5), at: null, reportNo: 1, mailbox: 'gmail', totals: null }, reportCount: 1, sawOrderCountFall: false });
  const v = buildView({ versions: [V_AUG], manifestRows: rows, today: TODAY });
  assert.equal(v.counts.scored, 11, 'still the eleven');
  assert.equal(v.stats.windows[30].mae, 27.3, 'the figures did not move');
  assert.equal(v.stats.windows[30].worst.date, '2026-09-01');
  assert.ok(!v.scored.some((p) => p.date === TODAY) && !v.unscored.some((p) => p.date === TODAY), 'tonight is in neither list');
  assert.equal(v.pending.length, 1);
  assert.deepEqual([v.pending[0].date, v.pending[0].actual, v.pending[0].inProgress], [TODAY, 420, true]);
  assert.match(v.pending[0].reason, /tonight — 420 so far \(#1\); scored after the 5am roll/);
  assert.deepEqual(v.pattern, []);
  assert.match(v.tonight.text, /manifest so far 420 \(#1, 20:05\)/, 'the tonight line still reads it live');
  // The next operating day the same row is a night — and a light_suspect one, 286 under: "check the reports", not a verdict on Uline.
  const next = buildView({ versions: [V_AUG], manifestRows: rows, today: '2026-09-03' });
  assert.equal(next.scored.find((x) => x.date === TODAY)?.verdict, 'light_suspect');
  assert.equal(next.counts.scored, 12);
});

test('THE LEDGER REACHES BACK 180 DAYS whatever the screen lists: a night 84 days back is in the 90-night figure and the Wednesday bias, not in the 60-day list', () => {
  const early = version(JUL, { versionId: 'davis__2026-05-01__early', sentDate: '2026-05-01', sentAt: Date.UTC(2026, 4, 1, 12), from: '2026-05-02', days: { ...JUL.days, '2026-06-10': [600, 660] } });
  const rows = manifestRows();
  rows.push({ _id: 'davis__2026-06-10', latest: { orders: 640, verified: true, receivedAt: edt('2026-06-10', 23, 0), reportNo: 5, mailbox: 'gmail' }, reportCount: 5, sawOrderCountFall: false });
  const v = buildView({ versions: [early, V_AUG], manifestRows: rows, today: TODAY, windowDays: 60 });
  assert.equal(v.stats.windows[90].n, 12);
  assert.equal(v.stats.windows[30].n, 11);
  assert.ok(!v.scored.some((p) => p.date === '2026-06-10'), 'not listed');
  assert.equal(v.counts.scored, 11);
  assert.equal(v.counts.scoredAll, 12);
  assert.equal(v.stats.bias[3].n, 2, 'Wednesday: 8/26 and 6/10');
  assert.equal(v.statsDays, STATS_WINDOW_DAYS);
  assert.equal(v.windowDays, 60);
  // A wider list is honoured; the ledger never shrinks below 180.
  assert.equal(buildView({ versions: [early, V_AUG], manifestRows: rows, today: TODAY, windowDays: 120 }).counts.scored, 12);
});

// ── A FILE WITH A BAD DATE ────────────────────────────────────────────────────

test('A BAD-DATE ROW MAKES EVERY WEEKDAY GAP UNKNOWN, NOT CLOSED — Tuesday is not staffed for Thursday, Wednesday is not staffed for nothing', () => {
  const days = Object.fromEntries(Object.entries(AUG.days).filter(([d]) => d !== '2026-09-16'));
  const bad = version(AUG, { days, rowsDropped: { badDate: 1 }, warnings: ['row 41: unreadable date "9/16/2O26"'] });
  assert.ok(unknownShipDays(bad).has('2026-09-16'));
  assert.ok(!closedShipDays(bad).has('2026-09-16'), 'not a closure');
  assert.ok(!unknownShipDays(bad).has('2026-09-07'), 'Labor Day is still a holiday, not an unknown');
  assert.ok(closedShipDays(bad).has('2026-09-07'));
  assert.ok(davisClosedDays(bad).has('2026-09-07'));
  const by = Object.fromEntries(deliveryOutlook({ version: bad, today: '2026-09-13' }).map((r) => [r.deliverOn, r]));
  assert.equal(by['2026-09-16'].status, 'ok', "Wednesday still gets Tuesday's freight");
  assert.deepEqual(by['2026-09-16'].ships.map((s) => s.date), ['2026-09-15']);
  assert.equal(by['2026-09-17'].status, 'unreadable');
  assert.match(by['2026-09-17'].notes.join(' '), /no readable estimate for 9\/16/);
  assert.equal(by['2026-09-17'].plan, null);
  assert.equal(classifyNight({ shipIso: '2026-09-16', version: bad, row: null, floor: '2026-08-20', today: '2026-09-20' }).status, 'unreadable');
  // Without a bad-date row the same gap IS a closure — Uline's calendar is trusted when the file read clean.
  assert.ok(closedShipDays(version(AUG, { days })).has('2026-09-16'));
  assert.equal(unknownShipDays(null).size, 0);
});

test('expectedVersionMissing judges the MASKED list too — a version with no days but this month\'s sentDate counts', () => {
  assert.equal(expectedVersionMissing([{ versionId: 'x', ok: true, sentDate: '2026-09-04' }], '2026-09-12'), false);
  assert.equal(expectedVersionMissing([{ versionId: 'x', ok: false, sentDate: '2026-09-04' }], '2026-09-12'), true);
  assert.equal(expectedVersionMissing([{ versionId: 'x', ok: true, sentDate: '2026-08-04' }], '2026-09-12'), true);
  assert.equal(expectedVersionMissing([null, undefined], '2026-09-12'), true);
});

test('the view names the days no route runs — the assumption on the Job panel that Chad can read and correct', () => {
  const v = buildView({ versions: [V_AUG], manifestRows: manifestRows(), today: TODAY });
  assert.deepEqual(v.holidays.slice(0, 3), [{ date: '2026-09-07', dow: 'Mon', reason: 'Labor Day' }, { date: '2026-11-26', dow: 'Thu', reason: 'Thanksgiving' }, { date: '2026-12-25', dow: 'Fri', reason: 'Christmas Day' }]);
  const extra = buildView({ versions: [V_AUG], manifestRows: manifestRows(), today: TODAY, davisClosed: ['2026-12-24'] });
  assert.ok(extra.holidays.some((h) => h.date === '2026-12-24' && h.reason === 'Davis closed'));
  assert.equal(extra.outlook.find((r) => r.deliverOn === '2026-09-08').ships.length, 2, 'the extra list does not disturb Labor Day');
  assert.deepEqual(buildView({ versions: [], manifestRows: [], today: TODAY }).holidays, []);
});
