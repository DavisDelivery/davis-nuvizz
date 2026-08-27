// WHERE THE DAY'S NuVizz CALLS WENT.
//
// Chad: "what caused the spike in nuvizz calls this morning?" The answer was in the ledger the
// whole time and I reported that it was not, because the two paths write different field names
// (the list path count/enriched, the completed overlay pulled/changed) and the first reading
// looked for the wrong pair. A question this ordinary belongs in the endpoint, not in whoever
// happens to be reading its output — and these tests are built on the REAL rows from that
// morning, so they pin the answer that was actually wanted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeSpend, runCalls, enrichedByDate, explainRun } from '../netlify/functions/lib/scan-attribution.mts';

// Verbatim from the live ledger, 2026-08-26 — the two runs that made the morning look like a
// spike, one cheap run for contrast, and the hourly counter that hour.
const RUN_0930 = {
  etDate: '2026-08-26', etHour: 9, etMin: 30, trigger: 'schedule', path: 'full', outcome: 'ok',
  callsBefore: 172, callsAfter: 198,
  dates: [{ date: '2026-08-26', ok: true, source: 'list', count: 734, planned: 713, unplanned: 21, enriched: 21, newPros: 21 }],
};
const RUN_1045 = {
  etDate: '2026-08-26', etHour: 10, etMin: 45, trigger: 'schedule', path: 'full', outcome: 'ok',
  callsBefore: 245, callsAfter: 287,
  dates: [
    { date: '2026-08-26', ok: true, source: 'list', count: 748, enriched: 18, newPros: 18 },
    { date: '2026-08-27', ok: true, source: 'list', count: 21, enriched: 19, newPros: 19 },
    { date: '2026-08-28', ok: true, source: 'list', count: 1, enriched: 0, newPros: 0 },
  ],
};
const RUN_0900 = {
  etDate: '2026-08-26', etHour: 9, etMin: 0, trigger: 'schedule', path: 'full', outcome: 'ok',
  callsBefore: 166, callsAfter: 169,
  dates: [{ date: '2026-08-26', ok: true, source: 'list', count: 713, enriched: 0, newPros: 0 }],
};
const BY_HOUR = { 8: 15, 9: 60, 10: 71, 11: 1 };

test('the expensive run is explained as new orders, not as a number', () => {
  assert.equal(runCalls(RUN_1045), 42);
  const why = explainRun(RUN_1045);
  assert.match(why, /37 new orders/);
  // THE ANSWER THAT WAS ACTUALLY WANTED: half of that morning spike was TOMORROW's board.
  assert.match(why, /19 on 2026-08-27/);
  assert.match(why, /18 on 2026-08-26/);
});

test('a run with no new orders says so instead of looking mysterious', () => {
  assert.equal(runCalls(RUN_0900), 3);
  assert.match(explainRun(RUN_0900), /no new orders/);
});

test('enrichment is broken out per board date', () => {
  assert.deepEqual(enrichedByDate(RUN_1045), { '2026-08-26': 18, '2026-08-27': 19 });
  assert.deepEqual(enrichedByDate(RUN_0900), {});
});

test('the hourly counter stays the authority on totals, and the gap is NAMED', () => {
  // 60 calls landed in hour 9; the runs account for 29. The other 31 are live dispatcher
  // writes that no scan run knows about. Reporting only the runs would under-count the day
  // and reporting only the counter would leave the spike unexplained.
  const a = attributeSpend([RUN_0900, RUN_0930, RUN_1045], BY_HOUR, { etDate: '2026-08-26' });
  const h9 = a.hours.find((h) => h.hour === 9);
  assert.equal(h9.calls, 60);
  assert.equal(h9.runCalls, 29);
  assert.equal(h9.otherCalls, 31);
  assert.equal(h9.newOrders, 21);
  assert.equal(h9.runs, 2);
});

test('each hour names the run that dominated it', () => {
  const a = attributeSpend([RUN_0900, RUN_0930, RUN_1045], BY_HOUR, { etDate: '2026-08-26' });
  assert.equal(a.hours.find((h) => h.hour === 9).topRun.at, '09:30');
  assert.equal(a.hours.find((h) => h.hour === 10).topRun.at, '10:45');
  // An hour the counter saw but no run touched still appears, with nothing claimed for it.
  const h8 = a.hours.find((h) => h.hour === 8);
  assert.equal(h8.calls, 15);
  assert.equal(h8.topRun, null);
  assert.equal(h8.otherCalls, 15);
});

test('busiest puts the spike first, which is the question being asked', () => {
  const a = attributeSpend([RUN_0900, RUN_0930, RUN_1045], BY_HOUR, { etDate: '2026-08-26' });
  assert.deepEqual(a.busiest.map((h) => h.hour), [10, 9, 8]);
});

test('another day’s runs are not counted against today', () => {
  const yesterday = { ...RUN_1045, etDate: '2026-08-25' };
  const a = attributeSpend([RUN_0930, yesterday], BY_HOUR, { etDate: '2026-08-26' });
  assert.equal(a.hours.find((h) => h.hour === 10).runCalls, 0);
});

// ── THE ONE THAT SHIPPED WRONG ───────────────────────────────────────────────
test('an UNDATED row is not counted into today — it inflated the live numbers', () => {
  // Live, this reported runCalls 2,070 against a day total of 1,209. The ledger holds ~3 days
  // and every row written before etDate was stamped has none, so "be generous, keep the legacy
  // rows" silently added other days into today. An impossible number is worse than a missing
  // one: it cannot be sanity-checked by the person reading it.
  const undated = { ...RUN_1045, etDate: undefined };
  const a = attributeSpend([RUN_0930, undated], BY_HOUR, { etDate: '2026-08-26' });
  assert.equal(a.hours.find((h) => h.hour === 10).runCalls, 0);
  assert.equal(a.skippedUndated, 1, 'and the omission is COUNTED, not silent');
  assert.ok(a.totals.runCalls <= a.totals.calls, 'runs can never account for more than were made');
});

test('with no day asked for, every row counts and nothing is skipped', () => {
  const a = attributeSpend([RUN_0930, { ...RUN_1045, etDate: undefined }], BY_HOUR);
  assert.equal(a.skippedUndated, 0);
  assert.equal(a.hours.find((h) => h.hour === 10).runCalls, 42);
});

test('runs claiming more than the counter saw is FLAGGED, not rounded away', () => {
  // The clamp keeps the totals adding up; the flag is what says the two sources disagree.
  const a = attributeSpend([RUN_1045], { 10: 5 }, { etDate: '2026-08-26' });
  const h10 = a.hours.find((h) => h.hour === 10);
  assert.equal(h10.otherCalls, 0);
  assert.equal(h10.overAttributed, 37);
  assert.equal(a.consistent, false);
});

test('a healthy day reports itself consistent', () => {
  const a = attributeSpend([RUN_0900, RUN_0930, RUN_1045], BY_HOUR, { etDate: '2026-08-26' });
  assert.equal(a.consistent, true);
  assert.equal(a.skippedUndated, 0);
});

test('a row from before `calls` was recorded still reports its cost', () => {
  assert.equal(runCalls({ callsBefore: 10, callsAfter: 16 }), 6);
  assert.equal(runCalls({ calls: 6 }), 6);
  // A run whose counter read failed must not report a negative or a wild number.
  assert.equal(runCalls({ callsBefore: 20, callsAfter: 5 }), 0);
  assert.equal(runCalls({}), 0);
  assert.equal(runCalls(null), 0);
});

test('malformed ledger rows and counter keys are skipped, not thrown on', () => {
  const a = attributeSpend(
    // etHour null is the one that bites: Number(null) is 0, a valid hour.
    [null, {}, { etHour: 99 }, { etHour: -1 }, { etHour: null, callsBefore: 0, callsAfter: 500 }, RUN_0930],
    { 9: 60, notAnHour: 5, 25: 9, '': 3, ' ': 4 },
    { etDate: '2026-08-26' },
  );
  assert.equal(a.hours.length, 1);
  assert.equal(a.hours[0].hour, 9);
  assert.equal(a.hours[0].calls, 60);
});

test('empty everything returns an empty account rather than throwing', () => {
  const a = attributeSpend(null, null);
  assert.deepEqual(a.hours, []);
  assert.deepEqual(a.busiest, []);
  assert.equal(a.totals.calls, 0);
});
