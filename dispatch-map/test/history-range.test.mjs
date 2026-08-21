// The Flag history window. Chad: "I want to be able to select today and calendar to select a
// specific day and or range."
//
// The rule these tests protect: the screen and the endpoint must resolve a selection the SAME
// way. A header that says "Aug 1 – Aug 19" over numbers covering a different span is worse
// than an error, because both halves look correct on their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRange, expandRange, rangeLabel, shortDay, daysBetween, addDays, isDateStr,
  selectionFromParams, paramsForRange, MAX_RANGE_DAYS, DEFAULT_DAYS,
} from '../src/lib/history-range.js';

const TODAY = '2026-08-21';   // the Friday board this screen was built against.

// ── the three questions that get asked out loud ───────────────────────────────

test('TODAY is one day, and it is today', () => {
  // The old control could not express this at all: its shortest option was seven days.
  const r = resolveRange({ kind: 'today' }, TODAY);
  assert.deepEqual({ from: r.from, to: r.to, days: r.days }, { from: TODAY, to: TODAY, days: 1 });
  assert.equal(rangeLabel(r, TODAY), 'Today');
});

test('"what happened on the nineteenth" is one day, not a lookback containing it', () => {
  // The customer who called about the 19th does not care about the 20th and the 21st.
  const r = resolveRange({ kind: 'day', date: '2026-08-19' }, TODAY);
  assert.deepEqual({ from: r.from, to: r.to, days: r.days }, { from: '2026-08-19', to: '2026-08-19', days: 1 });
  assert.equal(rangeLabel(r, TODAY), 'Aug 19');
});

test('"was August better than July" is two arbitrary ends, which no lookback can express', () => {
  const r = resolveRange({ kind: 'range', from: '2026-07-01', to: '2026-07-31' }, TODAY);
  assert.equal(r.days, 31);
  assert.equal(rangeLabel(r, TODAY), 'Jul 1 – Jul 31 · 31 days');
});

test('the rolling lookbacks still mean what they always meant — today included', () => {
  const r = resolveRange({ kind: 'days', days: 14 }, TODAY);
  assert.equal(r.to, TODAY, 'a lookback ends today');
  assert.equal(r.from, '2026-08-08');
  assert.equal(r.days, 14, 'fourteen days INCLUDING today, matching the old ?days=14');
  assert.equal(rangeLabel(r, TODAY), 'Last 14 days');
});

// ── what a person actually does to two date fields ───────────────────────────

test('dates entered backwards mean the span between them, not nothing', () => {
  const r = resolveRange({ kind: 'range', from: '2026-08-19', to: '2026-08-01' }, TODAY);
  assert.deepEqual({ from: r.from, to: r.to }, { from: '2026-08-01', to: '2026-08-19' });
  assert.equal(r.clamped, 'swapped', 'and the screen is told, so it can say so');
});

test('"the 1st to the end of the month", typed on the 21st, is not an error', () => {
  // Everybody types a whole month. Clamping the future end keeps that working; refusing it
  // would make the control feel broken on every day except the last of the month.
  const r = resolveRange({ kind: 'range', from: '2026-08-01', to: '2026-08-31' }, TODAY);
  assert.equal(r.to, TODAY);
  assert.equal(r.clamped, 'future');
});

test('a day in the future has no history and is pulled back to today', () => {
  const r = resolveRange({ kind: 'day', date: '2026-12-25' }, TODAY);
  assert.deepEqual({ from: r.from, to: r.to }, { from: TODAY, to: TODAY });
  assert.equal(r.clamped, 'future');
});

test('a range wider than the cap keeps the RECENT end', () => {
  // One document is read per day, so the cap is real. Which half survives is a judgement:
  // somebody asking for a year wants this month far more than last October.
  const r = resolveRange({ kind: 'range', from: '2025-01-01', to: TODAY }, TODAY);
  assert.equal(r.days, MAX_RANGE_DAYS);
  assert.equal(r.to, TODAY, 'the end nearest now is the half that is kept');
  assert.equal(r.from, '2026-06-23');
  assert.equal(r.clamped, 'max-days', 'and it is REPORTED — a silently narrowed range reads as a quiet period');
});

// ── half-typed input must not blank the page ─────────────────────────────────

test('a half-typed date falls back to the default window instead of throwing', () => {
  for (const sel of [{ kind: 'day', date: '2026-08' }, { kind: 'range', from: '', to: TODAY },
    { kind: 'days', days: 'x' }, { kind: 'days', days: 0 }, null, undefined, {}]) {
    const r = resolveRange(sel, TODAY);
    assert.equal(r.days, DEFAULT_DAYS, `${JSON.stringify(sel)} should fall back, not break`);
    assert.equal(r.to, TODAY);
  }
});

test('a date that looks right but is not a real day is refused', () => {
  // A date input cannot produce these; a hand-edited URL can, and Date would roll Feb 30
  // forward into March and read days nobody asked for.
  assert.equal(isDateStr('2026-02-30'), false);
  assert.equal(isDateStr('2026-13-01'), false);
  assert.equal(isDateStr('2026-04-31'), false);
  assert.equal(isDateStr('2026-02-29'), false, '2026 is not a leap year');
  assert.equal(isDateStr('2024-02-29'), true, '2024 is');
});

test('with no today there is no window, and it says so rather than guessing one', () => {
  const r = resolveRange({ kind: 'today' }, null);
  assert.equal(r.days, 0);
  assert.equal(r.clamped, 'no-today');
  assert.equal(rangeLabel(r, null), '');
});

// ── the days actually read ───────────────────────────────────────────────────

test('the window expands newest first, which is the order the screen lists', () => {
  assert.deepEqual(expandRange('2026-08-19', '2026-08-21'),
    ['2026-08-21', '2026-08-20', '2026-08-19']);
});

test('one day expands to one day, not to none', () => {
  assert.deepEqual(expandRange(TODAY, TODAY), [TODAY]);
  assert.equal(daysBetween(TODAY, TODAY), 1);
});

test('a reversed or malformed pair expands to nothing rather than to a year of reads', () => {
  assert.deepEqual(expandRange('2026-08-21', '2026-08-19'), []);
  assert.deepEqual(expandRange('', TODAY), []);
});

test('expansion is capped even if a caller hands it an unclamped pair', () => {
  // resolveRange clamps, but expandRange is exported and the endpoint reads documents from
  // whatever it returns. Belt and braces on the one function that turns into billed reads.
  assert.equal(expandRange('2020-01-01', TODAY).length, MAX_RANGE_DAYS);
});

test('a month boundary and a leap day are ordinary steps', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

// ── the label describes what is SHOWN ────────────────────────────────────────

test('a clamped range labels itself by what it resolved to, never by what was typed', () => {
  const r = resolveRange({ kind: 'range', from: '2025-01-01', to: TODAY }, TODAY);
  assert.equal(rangeLabel(r, TODAY), 'Last 60 days');
  assert.ok(!rangeLabel(r, TODAY).includes('2025'));
});

test('a year is only printed when it is not this one', () => {
  assert.equal(shortDay('2026-08-19', TODAY), 'Aug 19');
  assert.equal(shortDay('2025-08-19', TODAY), 'Aug 19, 2025');
});

test('a range ending today reads as a lookback, one ending earlier reads as two ends', () => {
  assert.equal(rangeLabel(resolveRange({ kind: 'range', from: '2026-08-15', to: TODAY }, TODAY), TODAY),
    'Last 7 days');
  assert.equal(rangeLabel(resolveRange({ kind: 'range', from: '2026-08-14', to: '2026-08-20' }, TODAY), TODAY),
    'Aug 14 – Aug 20 · 7 days');
});

// ── the query string, which is the contract between the two readers ──────────

test('the endpoint reads the same selection the screen sends', () => {
  const r = resolveRange({ kind: 'range', from: '2026-08-01', to: '2026-08-19' }, TODAY);
  const qs = new URLSearchParams(paramsForRange(r));
  const back = resolveRange(selectionFromParams((k) => qs.get(k)), TODAY);
  assert.deepEqual({ from: back.from, to: back.to }, { from: r.from, to: r.to });
});

test('the old ?days= and ?date= links still resolve — a bookmark must not break', () => {
  const days = new URLSearchParams('days=30');
  assert.equal(resolveRange(selectionFromParams((k) => days.get(k)), TODAY).days, 30);
  const one = new URLSearchParams('date=2026-08-19');
  assert.equal(resolveRange(selectionFromParams((k) => one.get(k)), TODAY).from, '2026-08-19');
  const none = new URLSearchParams('');
  assert.equal(resolveRange(selectionFromParams((k) => none.get(k)), TODAY).days, DEFAULT_DAYS);
});

test('only one end given is that single day, not a range to today', () => {
  // ?from=2026-08-19 with no to. Reading it as "the 19th through today" would silently widen
  // what somebody asked for; the pair collapses to the day they named.
  const qs = new URLSearchParams('from=2026-08-19');
  const r = resolveRange(selectionFromParams((k) => qs.get(k)), TODAY);
  assert.deepEqual({ from: r.from, to: r.to }, { from: '2026-08-19', to: '2026-08-19' });
});
