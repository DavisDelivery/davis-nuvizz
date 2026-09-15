// test/manifest-heal.test.mjs — THE MANIFEST HISTORY ROW ASKS THE BOARD AGAIN.
//
// Chad, 2026-09-15, looking at the Manifest history panel:
//
//     2026-09-14   all on the board      728 orders · 3 reports
//     2026-09-13   all on the board       56 orders · 6 reports
//     2026-09-11   136 not routed yet    556 orders · 7 reports
//
// "why do these show not routed yet i think that is stale and it needs to be dynamic and self
// heal."
//
// These replay that row on its own dates and numbers. The first two tests are the diagnosis —
// why it froze, and why the obvious one-line fix makes it lie instead of healing it — because
// a fix whose premise is not pinned is a fix somebody removes next year.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  healEnabled, needsHeal, healDates, healNight, healPass, storedSuspects, validHeal,
  HEAL_SPAN_DAYS, HEAL_VERSION,
} from '../netlify/functions/lib/manifest-heal.mts';
import { manifestWindow, boardCoverage, gradeSuspects, gradeText } from '../src/lib/manifest-window.js';
import { boardProIndex, onBoard } from '../netlify/functions/lib/manifest-reconcile.mts';

// ── the real night ───────────────────────────────────────────────────────────
const SHIP = '2026-09-11';            // a FRIDAY
const EXPECTED = '2026-09-14';        // …so Uline's freight is due MONDAY
const FILED_AT = '2026-09-12T05:10:00.000Z';   // the 1:10a ET pass, overnight Fri→Sat
const TODAY = '2026-09-15';           // the Tuesday Chad is looking at it
const NOW = '2026-09-15T14:02:00.000Z';

/** The 136 orders that were off the board when the night was filed. */
const suspectRows = (n = 136) => Array.from({ length: n }, (_, i) => ({
  pro: String(7174000 + i).padStart(9, '0'), custName: 'ULINE', state: 'off_board',
}));

/** The archive's `latest` for 2026-09-11, as the nightly pass filed it. */
const filedNight = (over = {}) => ({
  at: FILED_AT,
  orders: 556,
  onBoard: 420,
  missingCount: 136,
  missing: suspectRows(),
  expectedDelivery: EXPECTED,
  // What the boards looked like at 1:10a Saturday: Monday's had not been built.
  checkedAgainst: [{ date: '2026-09-14', stops: 0 }, { date: '2026-09-15', stops: 0 }, { date: '2026-09-16', stops: 0 }],
  coverage: boardCoverage(
    [{ date: '2026-09-14', stops: 0 }, { date: '2026-09-15', stops: 0 }, { date: '2026-09-16', stops: 0 }],
    [EXPECTED], '2026-09-12',
  ),
  grade: { verdict: 'unrouted', count: 136 },
  pdfStored: true,
  ...over,
});

/** The board as it stands NOW: Monday built with 728 stops, and 134 of the 136 on it. The
 *  board carries the segment suffix ("007174583-1") the manifest never prints — proKeys is
 *  what makes those match, and a heal that lost it would report 136 still missing. */
const boardNow = (landed = 134) => {
  const pros = suspectRows().slice(0, landed).map((s) => `${s.pro}-1`);
  for (let i = 0; i < 594; i++) pros.push(String(8000000 + i));
  return pros;
};
const asBoardDays = (stops14 = 728) => [
  { date: '2026-09-14', stops: stops14 }, { date: '2026-09-15', stops: 412 }, { date: '2026-09-16', stops: 0 },
];
const healOpts = (pros, days = asBoardDays(), asOf = TODAY) => {
  const idx = boardProIndex(pros);
  return { isOnBoard: (pro) => onBoard(idx, pro), boardDays: days, asOf, at: NOW };
};

// ── 1. THE DIAGNOSIS ─────────────────────────────────────────────────────────

test('THE FROZEN ROW: a Friday manifest is graded against a Monday board that does not exist yet', () => {
  // This is not a bug in the grading — it was the honest answer at 1:10a on the Saturday, and
  // the sentence says so. The bug is that nothing ever asked again.
  const w = manifestWindow(SHIP, HEAL_SPAN_DAYS);
  assert.equal(w.expected, EXPECTED, '09-11 is a Friday, so the freight is due Monday');
  const l = filedNight();
  const g = gradeSuspects(l.missing, l.coverage);
  assert.equal(g.verdict, 'unrouted');
  assert.equal(g.count, 136);
  assert.match(gradeText(g, l.coverage), /136 orders not routed yet — 2026-09-14 has not come round yet/);
});

test('THE TRAP: re-grading with today\'s date but the STORED board does not heal the row, it makes it lie', () => {
  // The one-line fix — unfreeze `asOf` — is the first thing anybody reaches for. On the real
  // 09-11 numbers it keeps the row amber AND replaces a true sentence with a false one:
  // "no board has been built for 2026-09-14", when 09-14 has 728 orders on it.
  const l = filedNight();
  const naive = boardCoverage(l.checkedAgainst, [EXPECTED], TODAY);
  const g = gradeSuspects(l.missing, naive);
  assert.equal(g.verdict, 'unrouted', 'still amber');
  assert.match(gradeText(g, naive), /no board has been built for 2026-09-14/);
  // …which is why healNight re-reads the BOARD rather than only the clock.
});

// ── 2. THE HEAL, ON THE REAL NUMBERS ─────────────────────────────────────────

test('THE HEAL: 134 of the 136 are on the board now, so the row reports the 2 that genuinely never arrived', () => {
  // The operational point, and the reason this is not merely tidying: the stale amber was
  // CONCEALING a red. A dispatcher who has learned to ignore "Monday hasn't happened" ignores
  // the two orders that never came with it.
  const h = healNight(filedNight(), healOpts(boardNow(134)));
  assert.equal(h.reAsked, 136);
  assert.equal(h.stillOff, 2);
  assert.equal(h.unreadable, 0);
  assert.equal(h.verdict, 'missing', 'a conclusive board turns "not routed yet" into a real miss');
  assert.equal(h.verdictText, '2 orders on the manifest are not in the scan');
  assert.deepEqual(h.filed, { verdict: 'unrouted', missingCount: 136 }, 'what the night concluded is kept');
  assert.equal(h.asOf, TODAY);
  assert.equal(h.ofAt, FILED_AT, 'stamped with the manifest revision it speaks for');
});

test('THE HEAL: when every order did land, the row goes clean and says nothing more', () => {
  const h = healNight(filedNight(), healOpts(boardNow(136)));
  assert.equal(h.stillOff, 0);
  assert.equal(h.verdict, 'none');
  assert.equal(h.verdictText, '', 'no sentence — the row reads "all on the board"');
});

test('THE HEAL matches a board PRO that carries the segment suffix the manifest never prints', () => {
  // 007174583 on the paper is 007174583-1 on the board. Losing proKeys here would report every
  // order still missing and turn a heal into a false alarm on every night.
  const one = { ...filedNight(), missingCount: 1, missing: [{ pro: '007174583' }] };
  assert.equal(healNight(one, healOpts(['007174583-1', '8000001'])).stillOff, 0);
  assert.equal(healNight(one, healOpts(['8000001'])).stillOff, 1);
});

test('THE HEAL never turns a genuinely missing order green just because the day came round', () => {
  // The expensive mistake in this direction: freight Uline handed us that NuVizz never
  // received, marked clean. None of the 136 are on the board, and all 136 must still report.
  const h = healNight(filedNight(), healOpts(boardNow(0)));
  assert.equal(h.stillOff, 136);
  assert.equal(h.verdict, 'missing');
});

// ── 3. THE CAP — a partial answer is never presented as a whole one ──────────

test('a night whose suspect list hit the archive cap counts the remainder as STILL OFF, never as healed', () => {
  // The archive keeps 500 off-board rows but the count stays exact. A night with 640 off the
  // board can only be re-asked about 500 of them, and the safe direction is the one that keeps
  // a dispatcher looking: a false clean is the costly error here, a false amber only costs
  // attention.
  const big = { ...filedNight(), missingCount: 640, missing: suspectRows(500) };
  const { capped } = storedSuspects(big);
  assert.equal(capped, 140);
  const idx = boardProIndex(suspectRows(500).map((s) => `${s.pro}-1`));   // ALL 500 have landed
  const h = healNight(big, { isOnBoard: (p) => onBoard(idx, p), boardDays: asBoardDays(), asOf: TODAY, at: NOW });
  assert.equal(h.unreadable, 140);
  assert.equal(h.stillOff, 140, 'the 140 it could not read are still counted off the board');
  assert.notEqual(h.verdict, 'none', 'it must not read clean on a partial answer');
});

test('storedSuspects: a count with no stored rows yields nothing to re-ask, and never invents PROs', () => {
  assert.deepEqual(storedSuspects({ missingCount: 12 }), { pros: [], rows: [], capped: 12 });
  assert.deepEqual(storedSuspects({}), { pros: [], rows: [], capped: 0 });
  assert.deepEqual(storedSuspects(null), { pros: [], rows: [], capped: 0 });
  // Rows with no usable PRO are dropped rather than looked up as the empty string.
  assert.equal(storedSuspects({ missingCount: 2, missing: [{ pro: '007' }, { pro: '  ' }, {}] }).pros.length, 1);
});

test('healNight returns null — never a fabricated verdict — when a night has no suspects to re-ask', () => {
  assert.equal(healNight({ missingCount: 5, missing: [] }, healOpts([])), null);
  assert.equal(healNight(null, healOpts([])), null);
  assert.equal(healNight(filedNight(), { boardDays: [], asOf: TODAY, at: NOW }), null, 'no lookup, no answer');
});

// ── 4. WHICH NIGHTS ARE WORTH A READ ─────────────────────────────────────────

test('needsHeal: the 09-11 row is re-asked once Monday has come round, and not before', () => {
  assert.equal(needsHeal(filedNight(), TODAY).heal, true);
  assert.equal(needsHeal(filedNight(), '2026-09-14').heal, true, 'on the day itself, the board exists');
  const early = needsHeal(filedNight(), '2026-09-13');
  assert.equal(early.heal, false, 'Sunday: Monday has not happened, re-reading only reprints the same honest answer');
  assert.match(early.why, /2026-09-14 has not come round yet/);
});

test('needsHeal: a clean night, a night with no stored suspects, and a night already asked today all cost nothing', () => {
  assert.equal(needsHeal({ ...filedNight(), missingCount: 0, missing: [] }, TODAY).heal, false);
  assert.equal(needsHeal({ ...filedNight(), missing: [] }, TODAY).heal, false);
  assert.match(needsHeal({ ...filedNight(), missing: [] }, TODAY).why, /cannot be re-asked/);
  const askedToday = needsHeal(filedNight(), TODAY, { asOf: TODAY, stillOff: 2 });
  assert.equal(askedToday.heal, false);
  assert.match(askedToday.why, /already re-asked today/);
});

test('needsHeal: a night healed CLEAN is settled for good and is never read again', () => {
  // Convergence is the cost model: once an order has been seen on the board it was received,
  // and no later board change can un-receive it. Without this the panel would re-read thirty
  // nights on every load, for ever.
  // Clean is terminal at ANY distance — even long after the tail below would have closed.
  const settled = needsHeal(filedNight(), '2026-10-01', { asOf: TODAY, stillOff: 0 });
  assert.equal(settled.heal, false);
  assert.match(settled.why, /already healed clean — settled/);
  // …but one that is still not clean IS re-asked again the next day, while the window is open.
  assert.equal(needsHeal(filedNight(), '2026-09-16', { asOf: TODAY, stillOff: 2 }).heal, true);
});

test('needsHeal: the window CLOSES, so a night left holding a real miss stops costing reads for ever', () => {
  // A masked Firestore read still bills per document, so re-asking the 09-11 night costs ~1,100
  // reads. Clean nights settle on their own; one holding a genuine miss would otherwise be
  // re-asked daily for ever. Its last delivery day is 09-16, so it keeps asking through the
  // tail and then stops — an order that has not appeared three delivery days after the last day
  // it could have arrived is missing freight, not late freight.
  const answered = { asOf: TODAY, stillOff: 2 };
  assert.equal(needsHeal(filedNight(), '2026-09-18', answered).heal, true, 'still inside the tail');
  assert.equal(needsHeal(filedNight(), '2026-09-19', answered).heal, true, 'last day of the tail');
  const shut = needsHeal(filedNight(), '2026-09-20', answered);
  assert.equal(shut.heal, false);
  assert.match(shut.why, /settled — nothing has appeared since 2026-09-16/);
  // BUT a night that has never been re-asked always gets its one read, however old — otherwise
  // every row filed before this shipped would stay frozen for good.
  assert.equal(needsHeal(filedNight(), '2026-12-25').heal, true, 'never asked: always worth one read');
});

test('needsHeal: garbage in gives "no", not a crash or a spurious read', () => {
  for (const bad of [null, undefined, {}, 'nope', 0]) assert.equal(needsHeal(bad, TODAY).heal, false);
  assert.equal(needsHeal(filedNight(), 'not-a-date').heal, false);
  assert.equal(needsHeal(filedNight(), '').heal, false);
});

test('healDates: the expected day plus the same slack the nightly diff allows, falling back to what was checked', () => {
  assert.deepEqual(healDates(filedNight()), ['2026-09-14', '2026-09-15', '2026-09-16']);
  // A night archived before expectedDelivery was stored still knows which boards it opened.
  const old = { ...filedNight(), expectedDelivery: null };
  assert.deepEqual(healDates(old), ['2026-09-14', '2026-09-15', '2026-09-16']);
  assert.deepEqual(healDates({ expectedDelivery: null, checkedAgainst: [] }), []);
  assert.deepEqual(healDates({ expectedDelivery: 'rubbish', checkedAgainst: [{ date: 'also-rubbish' }] }), []);
});

// ── 5. THE HEAL MUST SPEAK FOR THE MANIFEST ON FILE ──────────────────────────

test('validHeal: a heal of a superseded manifest is discarded, not shown against numbers it never saw', () => {
  const h = { v: HEAL_VERSION, ofAt: FILED_AT, stillOff: 2 };
  assert.deepEqual(validHeal({ latest: { at: FILED_AT }, heal: h }), h);
  // A fifth report landed after the heal — the heal speaks for a revision that is gone.
  assert.equal(validHeal({ latest: { at: '2026-09-12T06:00:00.000Z' }, heal: h }), null);
  assert.equal(validHeal({ latest: { at: FILED_AT } }), null);
  assert.equal(validHeal({ heal: h }), null);
  assert.equal(validHeal({ latest: { at: FILED_AT }, heal: 'not an object' }), null);
  // THE REPAIR. v1.30.0 wrote heals with no version at all, off a pooled index that could mark a
  // night clean using another night's board. Clean is terminal, so those records would be served
  // for ever — refusing them here is what throws them away and recomputes them on the next read.
  assert.equal(validHeal({ latest: { at: FILED_AT }, heal: { ofAt: FILED_AT, stillOff: 0 } }), null, 'v1.30.0 heal: no version, discarded');
  assert.equal(validHeal({ latest: { at: FILED_AT }, heal: { v: HEAL_VERSION - 1, ofAt: FILED_AT, stillOff: 0 } }), null, 'older schema, discarded');
  assert.equal(validHeal({ latest: { at: FILED_AT }, heal: { v: 'two', ofAt: FILED_AT, stillOff: 0 } }), null, 'junk version, discarded');
  assert.equal(validHeal(null), null);
  // THE LOOP CLOSES: what healNight actually produces must be accepted by validHeal. Without
  // this, stamping the wrong shape would silently make every heal un-servable — the panel would
  // recompute on every single load and nobody would see anything wrong.
  const fresh = healNight(filedNight(), healOpts(boardNow(134)));
  assert.equal(fresh.v, HEAL_VERSION);
  // WHICH orders are still off, not merely how many — the drill-down and the Rows viewer mark
  // their rows from this. Storing counts only is what left the row healed and the list under it
  // still showing all 136.
  assert.equal(fresh.stillOffPros.length, fresh.stillOff);
  assert.deepEqual(fresh.stillOffPros, ['007174134', '007174135'], 'exactly the two that never arrived');
  assert.deepEqual(validHeal({ latest: { at: FILED_AT }, heal: fresh }), fresh);
});

// ── 6. THE WAY BACK ──────────────────────────────────────────────────────────

test('MANIFEST_HISTORY_SELFHEAL: ON by default, off only on an explicit off-word, ON when malformed', () => {
  assert.equal(healEnabled({}), true);
  assert.equal(healEnabled({ MANIFEST_HISTORY_SELFHEAL: '' }), true);
  assert.equal(healEnabled(undefined), true);
  for (const off of ['off', 'OFF', ' Off ', '0', 'false', 'FALSE', 'no', 'NO']) {
    assert.equal(healEnabled({ MANIFEST_HISTORY_SELFHEAL: off }), false, off);
  }
  // A typo must never silently disable a rule — a quiet feature looks exactly like a working one.
  for (const bad of ['of', 'flase', 'disabled', 'nope', 'n', 'true', 'on', '1', 'yes']) {
    assert.equal(healEnabled({ MANIFEST_HISTORY_SELFHEAL: bad }), true, bad);
  }
});

// ── 7. ONE NIGHT, ONE WINDOW — the bug review caught before this shipped ─────
//
// The first cut of the endpoint pooled every stale night's board PROs into ONE index and handed
// it to all of them. A 2026-09-04 manifest's missing order was then found on the 2026-09-15
// board — a day in a LATER night's window, not its own — and healed CLEAN. The same night got a
// different answer depending on which other nights happened to share the request, and clean is
// TERMINAL, so that false clean would never have been re-asked: genuinely missing freight,
// marked resolved, for good. It was invisible to every test above because it lived in the
// handler, which is why healPass exists.

const nightOf = (at, expected, pro) => ({
  at, orders: 500, missingCount: 1, missing: [{ pro }],
  expectedDelivery: expected, grade: { verdict: 'unrouted', count: 1 },
});
/** A = due Mon 09-07 (window 07/08/09); B = due Mon 09-14 (window 14/15/16). */
const NIGHT_A = { date: '2026-09-04', l: nightOf('2026-09-05T05:10:00.000Z', '2026-09-07', '007111111') };
const NIGHT_B = { date: '2026-09-11', l: nightOf('2026-09-12T05:10:00.000Z', '2026-09-14', '007222222') };
// A's order NEVER appears on any of A's own days. It turns up on 09-15 — inside B's window only.
const PROS_BY_DATE = new Map([
  ['2026-09-07', ['009000001', '009000002']],
  ['2026-09-08', ['009000003']],
  ['2026-09-09', []],
  ['2026-09-14', ['007222222-1', '009000004']],
  ['2026-09-15', ['007111111-1', '009000005']],
  ['2026-09-16', []],
]);
const STOPS_BY_DATE = new Map([...PROS_BY_DATE].map(([d, p]) => [d, p.length]));
const passOpts = { prosByDate: PROS_BY_DATE, stopsByDate: STOPS_BY_DATE, asOf: TODAY, at: NOW };

test('a night is graded against ITS OWN window — sharing a request with another night cannot change its answer', () => {
  const alone = healPass([NIGHT_A], passOpts).healed[0].heal;
  const beside = healPass([NIGHT_A, NIGHT_B], passOpts).healed.find((h) => h.date === NIGHT_A.date).heal;
  assert.equal(alone.stillOff, 1, 'its order is on none of 09-07/08/09');
  assert.equal(beside.stillOff, 1, 'and it is still 1 when a later night rides along');
  assert.deepEqual(alone, beside, 'byte-identical: the request it arrived in is not evidence');
  // The 09-15 board proves nothing about a manifest due 09-07, and the stated checkedAgainst
  // must be the set the answer actually came from.
  assert.deepEqual(beside.checkedAgainst.map((d) => d.date), ['2026-09-07', '2026-09-08', '2026-09-09']);
  assert.equal(beside.verdict, 'missing');
  // Meanwhile B, whose order really is on its own 09-14 board, heals clean.
  const b = healPass([NIGHT_A, NIGHT_B], passOpts).healed.find((h) => h.date === NIGHT_B.date).heal;
  assert.equal(b.stillOff, 0);
  assert.equal(b.verdict, 'none');
});

test('healPass skips a night whose board could not be read, and says which — never grades it against an unopened board', () => {
  // A day absent from stopsByDate was NOT read. That is not an empty board, and treating it as
  // one would mark every suspect on it missing off a board nobody opened.
  const partial = { prosByDate: PROS_BY_DATE, stopsByDate: new Map([['2026-09-07', 2], ['2026-09-08', 1]]), asOf: TODAY, at: NOW };
  const r = healPass([NIGHT_A], partial);
  assert.equal(r.healed.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].date, '2026-09-04');
  assert.match(r.skipped[0].why, /could not be read — left as filed/);
});

test('healPass reports every night it could not re-ask, and survives junk candidates', () => {
  const noWindow = { date: '2026-08-01', l: { at: 'x', missingCount: 1, missing: [{ pro: '1' }], expectedDelivery: null, checkedAgainst: [] } };
  const noSuspects = { date: '2026-08-02', l: { at: 'y', missingCount: 3, missing: [], expectedDelivery: '2026-09-07' } };
  const r = healPass([noWindow, noSuspects, null, { date: 'z' }], passOpts);
  assert.equal(r.healed.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.date).sort(), ['2026-08-01', '2026-08-02']);
  assert.match(r.skipped.find((s) => s.date === '2026-08-01').why, /no delivery window/);
  assert.match(r.skipped.find((s) => s.date === '2026-08-02').why, /no suspect PROs/);
  assert.deepEqual(healPass([], passOpts), { healed: [], skipped: [] });
  assert.deepEqual(healPass(null, passOpts), { healed: [], skipped: [] });
});
