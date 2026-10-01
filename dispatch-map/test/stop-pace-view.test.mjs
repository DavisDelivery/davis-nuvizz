// test/stop-pace-view.test.mjs — what the Performance screen DECIDES from the digests.
//
// Chad, 2026-09-30: "… compared to other days or like the daily average at that point in time to
// let us know if we're behind or ahead of schedule."
//
// "Behind" is a claim somebody acts on — a call to a driver, a truck sent to help. These pin when
// the screen is allowed to make it: against the right days, at the right minute, outside the
// ordinary spread of a normal day, and never on a day it cannot actually judge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUCKETS, BUCKET_MIN, cumulative, quantile, chooseBaseline, baselineBands, paceNow, compareBucket, bucketEndMinute,
  aggregateDays, periodTotals, outcomeMix, weekdayProfile, dayRows, routeRows, sortRows, searchRows, paginate,
  movingAverage, presetRange, previousRange, rangeLabel, fmtClock, fmtShare, fmtSigned, fmtPctChange, fmtPoints,
  pctChange, parseLeftOut, weekdayOf, dayLabel, paceWords, freshnessLine, rangeIsStale, etMinuteOf, lowerFirst, MIN_BASELINE_DAYS,
} from '../src/lib/stop-pace.js';

const TODAY = '2026-09-29';   // a Tuesday
const b = (hh, mm) => Math.floor((hh * 60 + mm) / BUCKET_MIN);

/** A day whose deliveries run evenly from `start` to `end` (minutes), `n` of them. */
function evenDay(date, n, { start = 8 * 60, end = 17 * 60, gradable = n, timed = n, delivered = n } = {}) {
  const curve = new Array(BUCKETS).fill(0);
  for (let i = 0; i < timed; i++) curve[Math.floor((start + ((end - start) * i) / Math.max(1, timed - 1)) / BUCKET_MIN)] += 1;
  return { date, weekday: weekdayOf(date), delivered, timed, untimed: delivered - timed, gradable, planned: gradable, curve, counts: { delivered_system: delivered, delivered_manual: 0, unable: 0, cancelled: 0, in_flight: 0, not_attempted: 0 }, open: 0 };
}
const tuesdays = ['2026-09-22', '2026-09-15', '2026-09-08', '2026-09-01', '2026-08-25', '2026-08-18', '2026-08-11', '2026-08-04', '2026-07-28'];

// ── which days make the typical day ──────────────────────────────────────────

test('the typical Tuesday is the last eight Tuesdays, newest first — never today, never a weekend, never a Monday', () => {
  const pool = [
    ...tuesdays.map((d) => evenDay(d, 600)),
    evenDay('2026-09-28', 900),                  // Monday
    evenDay('2026-09-27', 20),                   // Sunday
    evenDay(TODAY, 100),                         // today itself
    evenDay('2026-09-30', 600),                  // tomorrow — nothing after today is history
  ];
  const { days, mode, size } = chooseBaseline(pool, { today: TODAY, weekday: 2 });
  assert.equal(mode, 'weekday');
  assert.equal(size, 8);
  assert.deepEqual(days.map((d) => d.date), tuesdays.slice(0, 8));
});

test('recent-weekdays mode takes the last N weekdays of any kind — still no weekends', () => {
  const pool = [evenDay('2026-09-28', 900), evenDay('2026-09-27', 20), evenDay('2026-09-26', 20), evenDay('2026-09-25', 500), evenDay('2026-09-24', 500)];
  const { days } = chooseBaseline(pool, { today: TODAY, weekday: 2, mode: 'recent', size: 3 });
  assert.deepEqual(days.map((d) => d.date), ['2026-09-28', '2026-09-25', '2026-09-24']);
});

test('a day left out, a day with no curve, a day that delivered nothing and a mostly-untimed day are skipped AND named', () => {
  const pool = [
    evenDay('2026-09-22', 600),
    { ...evenDay('2026-09-15', 600), curve: null },
    evenDay('2026-09-08', 0),
    evenDay('2026-09-01', 600, { timed: 300 }),     // half its deliveries carry no time
    evenDay('2026-08-25', 600),
    evenDay('2026-08-18', 600),
  ];
  const { days, skipped } = chooseBaseline(pool, { today: TODAY, weekday: 2, excluded: new Set(['2026-08-25']) });
  assert.deepEqual(days.map((d) => d.date), ['2026-09-22', '2026-08-18']);
  assert.deepEqual(skipped.map((s) => [s.date, s.reason]), [
    ['2026-09-15', 'no-curve'], ['2026-09-08', 'nothing-delivered'], ['2026-09-01', 'untimed'], ['2026-08-25', 'left-out'],
  ]);
});

// ── the band ─────────────────────────────────────────────────────────────────

test('the band is the 25th, 50th and 75th percentile of the running totals, bucket by bucket', () => {
  // Four days with 100, 200, 300, 400 delivered by 10:00 and nothing else.
  const days = [100, 200, 300, 400].map((n, i) => {
    const curve = new Array(BUCKETS).fill(0); curve[b(9, 55)] = n;
    return { date: `2026-09-0${i + 1}`, curve, gradable: n * 2 };
  });
  const bands = baselineBands(days);
  assert.equal(bands.n, 4);
  assert.equal(bands.median[b(9, 55)], 250);
  assert.equal(bands.p25[b(9, 55)], 175);
  assert.equal(bands.p75[b(9, 55)], 325);
  assert.equal(bands.median[b(9, 50)], 0, 'before any delivery the typical day has done nothing');
  assert.equal(bands.median[BUCKETS - 1], 250, 'the running total holds after the last delivery');
  const shares = baselineBands(days, { share: true });
  assert.equal(shares.median[b(9, 55)], 0.5, 'each day against ITS OWN board: every one of them was half done');
});

test('quantile is the interpolated one; an empty list has none', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([7], 0.25), 7);
  assert.equal(quantile([], 0.5), null);
});

// ── today against the band ───────────────────────────────────────────────────

const typicalTuesdays = () => tuesdays.slice(0, 8).map((d, i) => evenDay(d, 560 + i * 10));   // 560 … 630 a day

test('BEHIND means below the typical range at that minute — not merely under the middle day', () => {
  const bands = baselineBands(typicalTuesdays());
  const at = 11 * 60 + 30;
  const bucket = compareBucket(at);
  const lo = bands.p25[bucket]; const med = bands.median[bucket]; const hi = bands.p75[bucket];
  const liveWith = (count) => { const curve = new Array(BUCKETS).fill(0); curve[b(8, 0)] = count; return { curve, gradable: 600 }; };
  // One stop under the median is inside the band: on pace, not behind.
  assert.equal(paceNow(liveWith(Math.ceil(med) - 1), bands, { asOfMinute: at }).status, 'on-pace');
  assert.equal(paceNow(liveWith(Math.floor(lo) - 1), bands, { asOfMinute: at }).status, 'behind');
  assert.equal(paceNow(liveWith(Math.ceil(hi) + 1), bands, { asOfMinute: at }).status, 'ahead');
  const p = paceNow(liveWith(Math.floor(lo) - 1), bands, { asOfMinute: at });
  assert.ok(p.delta < 0);
  assert.equal(p.median, med);
  assert.ok(p.fromScan);
});

test('today is compared at the LAST WHOLE BUCKET before its scan — a scan at 11:10 is judged through 11:09', () => {
  assert.equal(compareBucket(11 * 60 + 10), b(11, 5));
  assert.equal(bucketEndMinute(compareBucket(11 * 60 + 10)), 11 * 60 + 9);
  assert.equal(compareBucket(11 * 60 + 14), b(11, 10), 'at 11:14 the 11:10 bucket is finished');
  assert.equal(compareBucket(0), -1, 'at midnight no bucket is finished');
  // A typical day that delivers 40 stops at 11:10–11:14 must not make a board scanned at 11:10 —
  // which cannot know about them yet — read as behind.
  const days = tuesdays.slice(0, 5).map((d) => { const c = new Array(BUCKETS).fill(0); c[b(9, 0)] = 200; c[b(11, 10)] = 40; return { date: d, curve: c, gradable: 600 }; });
  const bands = baselineBands(days);
  const live = { curve: (() => { const c = new Array(BUCKETS).fill(0); c[b(9, 0)] = 200; return c; })(), gradable: 600 };
  assert.equal(paceNow(live, bands, { asOfMinute: 11 * 60 + 10 }).status, 'on-pace');
});

test('the wall clock is used only when nothing has scanned today, and the screen can tell which it was', () => {
  const bands = baselineBands(typicalTuesdays());
  const live = { curve: new Array(BUCKETS).fill(0), gradable: 600 };
  const p = paceNow(live, bands, { asOfMinute: null, nowMinute: 10 * 60 });
  assert.equal(p.fromScan, false);
  assert.equal(p.minute, 600);
});

test('no verdict without the history to make one: too few days, no board, or before a typical first delivery', () => {
  const few = baselineBands(typicalTuesdays().slice(0, MIN_BASELINE_DAYS - 1));
  const live = { curve: new Array(BUCKETS).fill(0), gradable: 600 };
  assert.equal(paceNow(live, few, { asOfMinute: 600 }).status, 'insufficient');
  assert.equal(paceNow(null, few, { asOfMinute: 600 }).status, 'no-board');
  assert.equal(paceNow(live, baselineBands(typicalTuesdays()), { asOfMinute: 6 * 60 }).status, 'not-started', '6am: a typical Tuesday has delivered nothing either');
});

test('share of the board: a light day is judged against light days, so a heavy Monday cannot fake a good morning', () => {
  // Typical days: 600-stop boards, half done by noon. Today: a 900-stop board, 350 done by noon —
  // more stops than a typical noon (ahead by count) but only 39% of its own board (behind by share).
  const days = tuesdays.slice(0, 6).map((d) => { const c = new Array(BUCKETS).fill(0); c[b(11, 0)] = 300; return { date: d, curve: c, gradable: 600 }; });
  const counts = baselineBands(days); const shares = baselineBands(days, { share: true });
  const c = new Array(BUCKETS).fill(0); c[b(11, 0)] = 350;
  const live = { curve: c, gradable: 900 };
  assert.equal(paceNow(live, counts, { asOfMinute: 12 * 60, shareBands: shares }).status, 'ahead');
  assert.equal(paceNow(live, counts, { asOfMinute: 12 * 60, shareBands: shares, measure: 'share' }).status, 'behind');
});

// ── periods ──────────────────────────────────────────────────────────────────

const summary = (date, delivered, o = {}) => ({ date, weekday: weekdayOf(date), delivered, gradable: delivered + 10, planned: delivered + 12, open: 8, counts: { delivered_manual: 2, unable: 2, cancelled: 2 }, source: 'sealed', ...o });

test('weeks run Monday to Sunday, months are calendar months, and a period holding today is PARTIAL', () => {
  const days = [summary('2026-09-21', 600), summary('2026-09-22', 610), summary('2026-09-28', 620), summary(TODAY, 300, { source: 'live' })];
  const weeks = aggregateDays(days, 'week', { today: TODAY });
  assert.deepEqual(weeks.map((w) => [w.from, w.to, w.delivered, w.partial]), [
    ['2026-09-21', '2026-09-27', 1210, false],
    ['2026-09-28', '2026-10-04', 920, true],
  ]);
  assert.equal(weeks[1].perDay, 620, 'the average is of CLOSED days — today\'s half-worked board does not drag it down');
  const months = aggregateDays(days, 'month', { today: TODAY });
  assert.deepEqual(months.map((m) => [m.key, m.label, m.partial]), [['2026-09', 'Sep 2026', true]]);
});

test('a sealed day with no digest yet is a GAP in its period, counted — never read as a slow week', () => {
  const weeks = aggregateDays([summary('2026-09-21', 600)], 'week', { today: TODAY, missing: ['2026-09-22', '2026-09-14'] });
  assert.deepEqual(weeks.map((w) => [w.from, w.gaps, w.delivered]), [['2026-09-14', 1, 0], ['2026-09-21', 1, 600]]);
});

test('totals: completion is delivered over gradable, the hand-close rate is of deliveries, an empty period has no rates', () => {
  const t = periodTotals([summary('2026-09-21', 590), summary('2026-09-22', 610)]);
  assert.equal(t.delivered, 1200);
  assert.equal(t.gradable, 1220);
  assert.equal(t.completionRate, 1200 / 1220);
  assert.equal(t.manualRate, 4 / 1200);
  assert.equal(t.perDay, 600);
  const none = periodTotals([]);
  assert.equal(none.completionRate, null);
  assert.equal(none.perDay, null);
});

test('where the stops ended up: cancelled is said on the side, never drawn as a share of the work', () => {
  const mix = outcomeMix([summary('2026-09-21', 590)]);
  assert.deepEqual(mix.rows.map((r) => [r.key, r.count]), [['scan', 588], ['hand', 2], ['open', 8], ['unable', 2]]);
  assert.equal(mix.cancelled, 2);
  assert.equal(mix.whole, 600);
  assert.equal(mix.unaccounted, 0, 'the four rows add up to the gradable stops');
  assert.equal(Math.round(mix.rows.reduce((a, r) => a + r.share, 0) * 1000) / 1000, 1);
});

test('the weekday profile averages CLOSED days only', () => {
  const p = weekdayProfile([summary('2026-09-22', 600), summary('2026-09-15', 500), summary(TODAY, 50, { source: 'live' })]);
  const tue = p.find((x) => x.weekday === 2);
  assert.equal(tue.avg, 550);
  assert.equal(tue.n, 2);
  assert.equal(p.find((x) => x.weekday === 1).avg, null, 'a weekday with no days has no average, not zero');
});

// ── the table ────────────────────────────────────────────────────────────────

test('"vs last week" is the same weekday seven days earlier — and blank for today, which is not finished', () => {
  const rows = dayRows([summary('2026-09-22', 660), summary('2026-09-15', 600), summary('2026-09-21', 500), summary(TODAY, 300, { source: 'live' })], { excluded: ['2026-09-15'], today: TODAY });
  const r22 = rows.find((r) => r.date === '2026-09-22');
  assert.equal(r22.vsLastWeek, 0.1);
  assert.equal(rows.find((r) => r.date === '2026-09-21').vsLastWeek, null, 'no Monday the week before in view');
  assert.equal(rows.find((r) => r.date === TODAY).vsLastWeek, null);
  assert.equal(rows.find((r) => r.date === '2026-09-15').leftOut, true);
  assert.equal(r22.label, 'Tue Sep 22');
});

test('a route\'s rate needs three deliveries over half an hour, and "vs fleet" is in points of its own board', () => {
  const rows = routeRows({ routes: [
    { route: 'SUW 1', driver: 'Joe', planned: 14, cancelled: 0, delivered: 10, firstMin: 480, lastMin: 660 },
    { route: 'DUL 2', driver: 'Ann', planned: 12, cancelled: 2, delivered: 2, firstMin: 500, lastMin: 510 },
    { route: 'GAIN', driver: null, planned: 8, cancelled: 0, delivered: 3, firstMin: 600, lastMin: 610 },
  ] }, { fleetShare: 0.5 });
  const suw = rows.find((r) => r.route === 'SUW 1');
  assert.equal(suw.perHour, 3, '9 gaps over 180 minutes');
  assert.equal(suw.planned, 14);
  assert.ok(Math.abs(suw.vsFleet - (10 / 14 - 0.5)) < 1e-12);
  assert.equal(rows.find((r) => r.route === 'DUL 2').perHour, null, 'two deliveries are not a rate');
  assert.equal(rows.find((r) => r.route === 'DUL 2').planned, 10, 'cancelled orders are not its work');
  assert.equal(rows.find((r) => r.route === 'GAIN').perHour, null, 'three deliveries in ten minutes are not a rate');
});

test('sorting puts blanks LAST in both directions and keeps ties in their order', () => {
  const rows = [{ id: 'a', v: 3 }, { id: 'b', v: null }, { id: 'c', v: 1 }, { id: 'd', v: 3 }];
  assert.deepEqual(sortRows(rows, 'v', 'asc').map((r) => r.id), ['c', 'a', 'd', 'b']);
  assert.deepEqual(sortRows(rows, 'v', 'desc').map((r) => r.id), ['a', 'd', 'c', 'b']);
  assert.deepEqual(sortRows([{ id: 1, s: 'SUW 10' }, { id: 2, s: 'SUW 9' }], 's').map((r) => r.id), [2, 1], 'route names sort as a person would');
});

test('search matches every word, anywhere in the named fields', () => {
  const rows = [{ route: 'SUW 1', driver: 'Joe Gibbs' }, { route: 'DUL 2', driver: 'Ann Lee' }];
  assert.deepEqual(searchRows(rows, 'gibbs suw', ['route', 'driver']).map((r) => r.route), ['SUW 1']);
  assert.equal(searchRows(rows, '', ['route']).length, 2);
});

test('pages are clamped, and the footer\'s numbers are the rows it shows', () => {
  const rows = Array.from({ length: 53 }, (_, i) => ({ i }));
  const p = paginate(rows, 3, 25);
  assert.deepEqual([p.page, p.pages, p.first, p.last, p.rows.length], [3, 3, 51, 53, 3]);
  assert.equal(paginate(rows, 99, 25).page, 3);
  assert.equal(paginate([], 1, 25).first, 0);
});

// ── ranges, clocks and words ─────────────────────────────────────────────────

test('presets end today; a custom range is put the right way round and cannot run past today', () => {
  assert.deepEqual(presetRange('7d', TODAY), { from: '2026-09-23', to: TODAY });
  assert.deepEqual(presetRange('mtd', TODAY), { from: '2026-09-01', to: TODAY });
  assert.deepEqual(presetRange('ytd', TODAY), { from: '2026-01-01', to: TODAY });
  assert.deepEqual(presetRange('custom', TODAY, { from: '2026-10-10', to: '2026-09-01' }), { from: '2026-09-01', to: TODAY });
  assert.equal(presetRange('custom', TODAY, { from: '', to: '2026-09-01' }), null);
  assert.deepEqual(previousRange('2026-09-23', TODAY), { from: '2026-09-16', to: '2026-09-22' });
  assert.equal(rangeLabel('2026-08-31', TODAY), 'Aug 31 – Sep 29');
  assert.equal(rangeLabel('2026-09-01', TODAY), 'Sep 1 – 29');
});

test('the words: clock times as the app writes them, and a share that never claims 100% short of done', () => {
  assert.equal(fmtClock(9 * 60 + 5), '9:05a');
  assert.equal(fmtClock(12 * 60 + 30), '12:30p');
  assert.equal(fmtClock(0), '12:00a');
  assert.equal(fmtClock(null), '—');
  assert.equal(fmtShare(815 / 816), '99%', '815 of 816 is not a perfect day');
  assert.equal(fmtShare(1), '100%');
  assert.equal(fmtSigned(-28), '−28');
  assert.equal(fmtSigned(12), '+12');
  assert.equal(fmtPctChange(-0.117), '−11.7%');
  assert.equal(fmtPoints(0.021), '+2.1 pts');
  assert.equal(pctChange(110, 100), 0.1);
  assert.equal(pctChange(5, 0), null, 'no change from nothing');
  assert.equal(dayLabel('2025-12-30', TODAY), 'Tue Dec 30, 2025');
});

test('the left-out days survive a reload, and a corrupted setting reads as none left out — never a throw', () => {
  assert.deepEqual([...parseLeftOut('["2026-09-15","nope",3]')], ['2026-09-15']);
  assert.equal(parseLeftOut('{').size, 0);
  assert.equal(parseLeftOut(null).size, 0);
});

test('moving average waits for a full window and never averages across a blank', () => {
  assert.deepEqual(movingAverage([1, 2, 3, null, 5, 6, 7], 3), [null, null, 2, null, null, null, 6]);
});

test('cumulative ignores junk rather than propagating it', () => {
  const c = new Array(BUCKETS).fill(0); c[3] = 2; c[5] = 'x'; c[7] = -4; c[9] = 1;
  const cum = cumulative(c);
  assert.equal(cum[BUCKETS - 1], 3);
  assert.equal(cumulative(null)[10], 0);
});

// ── the words the screen says about today ────────────────────────────────────

/** A judged pace, as paceNow returns it: 11:09a, 300 delivered against a median of 358.5. */
const judged = (over = {}) => ({
  status: 'behind', n: 8, bucket: b(11, 5), atMinute: 11 * 60 + 9, fromScan: true,
  count: 300, share: 0.37, gradable: 811,
  median: 358.5, p25: 348.75, p75: 363.25, delta: -58.5, deltaPct: -58.5 / 358.5,
  shareMedian: 0.44, shareP25: 0.42, shareP75: 0.46, shareDelta: -0.07,
  ...over,
});

test('BEHIND is said with the minute, the band and the days it was judged against — the sentence Chad asked for', () => {
  const w = paceWords({ pace: judged(), measure: 'stops', typical: 'weekday', typicalLabel: 'Typical Wednesday', todayWd: 3 });
  assert.equal(w.head, '300 delivered by 11:09a — below the middle half of the last 8 Wednesdays (349–363).');
  assert.equal(w.note, null);
  const diff = w.facts.find((f) => f.key === 'diff');
  assert.equal(diff.value, '−59', 'a real minus sign, rounded like every other count');
  assert.equal(diff.tone, 'bad');
  assert.equal(diff.sub, '−16.3% of the median');
  assert.equal(w.facts.find((f) => f.key === 'typical').label, 'Typical Wednesday by then');
  assert.equal(w.facts.find((f) => f.key === 'now').sub, 'at the last scan');
});

test('AHEAD and ON PACE say above and inside; the "last 20 weekdays" mode names weekdays, not Wednesdays', () => {
  assert.match(paceWords({ pace: judged({ status: 'ahead', count: 380, delta: 21.5 }), todayWd: 3 }).head, /^380 delivered by 11:09a — above the middle half of the last 8 Wednesdays/);
  const on = paceWords({ pace: judged({ status: 'on-pace', count: 355, n: 20 }), typical: 'recent', todayWd: 3 });
  assert.match(on.head, /inside the middle half of the last 20 weekdays \(349–363\)\.$/);
});

test('judged by SHARE, the sentence and the facts are shares and points — never a stop count', () => {
  const w = paceWords({ pace: judged(), measure: 'share', todayWd: 3, typicalLabel: 'Typical Wednesday' });
  assert.equal(w.head, '37% of today’s board done by 11:09a — below the middle half of the last 8 Wednesdays (42%–46%).');
  assert.equal(w.facts.find((f) => f.key === 'diff').value, '−7.0 pts');
  assert.equal(w.facts.find((f) => f.key === 'band').value, '42%–46%');
});

test('with no scan today the facts say the clock was used, not a scan', () => {
  const w = paceWords({ pace: judged({ fromScan: false }), todayWd: 3 });
  assert.equal(w.facts.find((f) => f.key === 'now').sub, 'at the clock — no scan today yet');
});

test('NO VERDICT, SAID IN WORDS: too few days, no board, before the day starts — facts are null, never zeros', () => {
  const few = paceWords({ pace: { status: 'insufficient', n: 2, atMinute: 600 }, todayWd: 3 });
  assert.equal(few.facts, null);
  assert.equal(few.head, null);
  assert.equal(few.note, `2 Wednesdays built to compare with, and ${MIN_BASELINE_DAYS} are needed before today is called ahead or behind. The History card builds the rest.`);
  assert.match(paceWords({ pace: { status: 'insufficient', n: 1 }, todayWd: 3 }).note, /^1 Wednesday built/);
  assert.match(paceWords({ pace: { status: 'insufficient', n: 0 }, typical: 'recent', todayWd: 3 }).note, /^0 weekdays built/);
  assert.match(paceWords({ pace: { status: 'no-board' } }).note, /Nothing is on today’s board yet/);
  assert.match(paceWords({ pace: { status: 'not-started', atMinute: 6 * 60 + 4 }, todayWd: 3 }).note, /^A typical Wednesday has not delivered anything by 6:04a either/);
  assert.equal(paceWords({ pace: { status: 'not-started', atMinute: null } }).note, 'The day has not started yet.');
  assert.deepEqual(paceWords({}), { head: null, facts: null, note: null }, 'nothing at all is nothing — not a verdict');
});

test('ON A SATURDAY there is no typical Saturday — the words say so and say what would compare, not "build more"', () => {
  assert.equal(
    paceWords({ pace: { status: 'insufficient', n: 0 }, typical: 'weekday', todayWd: 6 }).note,
    'Today is a Saturday, and typical days are built from weekdays only. To compare anyway, set Typical day to the last 20 weekdays in Filters.',
  );
  assert.match(paceWords({ pace: { status: 'insufficient', n: 3 }, typical: 'recent', todayWd: 6 }).note, /^3 weekdays built/, 'in the weekdays mode a Saturday is short of days like any other');
});

test('the freshness line names the scan, the read and the call count — and the count is always zero', () => {
  assert.equal(freshnessLine({ live: { asOf: { minute: 670 } }, hasData: true, readAt: '11:12 AM' }), 'Board as of the 11:10a scan · read 11:12 AM · 0 NuVizz calls');
  assert.equal(freshnessLine({ live: { asOf: null }, hasData: true }), 'No scan has landed today yet · 0 NuVizz calls');
  assert.equal(freshnessLine({ live: null, hasData: true }), 'No board for today · 0 NuVizz calls');
  assert.equal(freshnessLine({}), '0 NuVizz calls');
});

test('a DIFFERENT range loading dims the charts; the same range refreshing every three minutes does not', () => {
  const range = { from: '2026-09-01', to: '2026-09-30' };
  const prev = { from: '2026-08-02', to: '2026-08-31' };
  assert.equal(rangeIsStale({ loading: true, served: { from: '2026-08-02', to: '2026-09-30' }, range, prev }), false, 'the refresh of what is on screen');
  assert.equal(rangeIsStale({ loading: true, served: { from: '2026-07-03', to: '2026-09-30' }, range, prev }), true, 'a new range is on its way');
  assert.equal(rangeIsStale({ loading: true, served: { from: '2026-08-02', to: '2026-09-29' }, range, prev }), true);
  assert.equal(rangeIsStale({ loading: false, served: { from: '2026-07-03', to: '2026-09-30' }, range, prev }), false, 'nothing loading, nothing stale');
  assert.equal(rangeIsStale({ loading: true, served: { from: '2026-08-10', to: '2026-09-30', clamped: 'range-too-long' }, range, prev }), false, 'cut short by the endpoint is not "different"');
  assert.equal(rangeIsStale({ loading: true, served: null, range, prev }), false, 'the first load has nothing to dim');
});

test('"read 3:37p" is on the BOARD\'s clock — Eastern, summer and winter — whatever zone the device is in', () => {
  assert.equal(etMinuteOf(new Date('2026-09-30T19:37:00Z')), 15 * 60 + 37, 'EDT is UTC−4');
  assert.equal(etMinuteOf('2026-01-15T19:37:00Z'), 14 * 60 + 37, 'EST is UTC−5');
  assert.equal(etMinuteOf('2026-09-30T04:05:00Z'), 5, 'just after midnight is minute 5, not 24:05');
  assert.equal(etMinuteOf('not a time'), null);
  assert.equal(fmtClock(etMinuteOf('2026-09-30T19:37:00Z')), '3:37p');
});

test('the typical day keeps its weekday capitalised mid-sentence', () => {
  assert.equal(lowerFirst('Typical Wednesday'), 'typical Wednesday');
  assert.equal(lowerFirst(''), '');
  assert.equal(lowerFirst(null), '');
});

test('the phone\'s freshness line keeps the call count when the words are short', () => {
  assert.equal(freshnessLine({ live: { asOf: { minute: 670 } }, hasData: true, readAt: '3:37p', short: true }), 'Scan 11:10a · read 3:37p · 0 NuVizz calls');
  assert.equal(freshnessLine({ live: null, hasData: true, short: true }), 'No board today · 0 NuVizz calls');
});
