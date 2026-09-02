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
  ROUTE_DAY_ORDERS_DEFAULT, MIN_WEEKDAY_N,
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

test('THE FILE IS THE HOLIDAY CALENDAR: Labor Day is absent, so Friday and Sunday both deliver on Tuesday', () => {
  const closed = closedShipDays(V_AUG);
  assert.ok(closed.has('2026-09-07'), 'Labor Day');
  assert.ok(closed.has('2026-11-26'), 'Thanksgiving');
  assert.ok(closed.has('2026-12-25'), 'Christmas');
  assert.ok(!closed.has('2026-09-08'));
  assert.equal(deliveryDayFor('2026-09-04', closed), '2026-09-08', 'Friday rolls past the closed Monday');
  assert.equal(deliveryDayFor('2026-09-06', closed), '2026-09-08', 'Sunday delivers Tuesday as always');
  assert.equal(deliveryDayFor('2026-09-03', closed), '2026-09-04', 'an ordinary Thursday is unchanged');
});

test('THE OUTLOOK ROLLS UP BY DELIVERY DAY: Tue 9/8 = Fri 9/4 + Sun 9/6, Mon 9/7 reads closed, Wed 9/9 = Tue 9/8', () => {
  const rows = deliveryOutlook({ version: V_AUG, today: TODAY, days: 14 });
  const by = Object.fromEntries(rows.map((r) => [r.deliverOn, r]));
  assert.equal(by['2026-09-07'].status, 'closed');
  assert.match(by['2026-09-07'].notes.join(' '), /Uline closed/);
  const tue = by['2026-09-08'];
  assert.deepEqual(tue.ships.map((s) => s.date), ['2026-09-04', '2026-09-06']);
  assert.equal(tue.est, AUG.days['2026-09-04'][0] + AUG.days['2026-09-06'][0]);
  assert.equal(tue.upper, AUG.days['2026-09-04'][1] + AUG.days['2026-09-06'][1]);
  assert.match(tue.notes.join(' '), /Uline closed 9\/7 — rolled into this day/);
  assert.deepEqual(by['2026-09-09'].ships.map((s) => s.date), ['2026-09-08']);
  // An ordinary week: Tuesday is Sunday + Monday, the heavy day nobody sees in the spreadsheet.
  assert.deepEqual(by['2026-09-15'].ships.map((s) => s.date), ['2026-09-13', '2026-09-14']);
  assert.equal(by['2026-09-15'].est, AUG.days['2026-09-13'][0] + AUG.days['2026-09-14'][0]);
  // Monday is Friday's freight — the light day.
  assert.deepEqual(by['2026-09-14'].ships.map((s) => s.date), ['2026-09-11']);
  assert.ok(by['2026-09-14'].chips.includes('LIGHT'), `Monday chips LIGHT against a typical day: ${JSON.stringify(by['2026-09-14'])}`);
  assert.ok(!by['2026-09-15'].chips.includes('LIGHT'));
  assert.equal(rows.every((r) => r.deliverOn > TODAY), true);
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
  assert.equal(tonightLine({ version: V_AUG, row: null, shipIso: '2026-09-07', today: '2026-09-07' }).text, 'Uline closed today');
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
