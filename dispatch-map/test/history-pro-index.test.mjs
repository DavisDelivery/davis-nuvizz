// test/history-pro-index.test.mjs
//
// Unit tests for the PRO → delivery-day pointer index (lib/history-pro-index.mts):
// the PURE keying/merge/day-build logic and the IO passes with Firestore injected.
//
// The rule these pin, in Chad's words (2026-09-15): a week-old order must be findable
// by its PRO without a NuVizz call. The old lookup could only see a customer's most
// recent 20 PROs, so order 21 was in the warehouse and invisible to the screen.
// Run with: npm test.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  proIndexKeys, proIndexPath, mergeDayEntries, buildProIndexForDay,
  updateProIndexForDay, lookupProDays, proIndexEnabled, MAX_DAYS_PER_PRO,
} from '../netlify/functions/lib/history-pro-index.mts';

// ── keying ───────────────────────────────────────────────────────────────────
test('proIndexKeys: every zero-padding of one PRO collapses to ONE key', () => {
  // The old lookup only tried the raw token and padStart(9), so a 10-digit stored PRO
  // was unreachable from a 7-digit search. All of these are the same order.
  const k = proIndexKeys('007175119');
  assert.deepEqual(k, ['n_7175119']);
  assert.deepEqual(proIndexKeys('7175119'), k);
  assert.deepEqual(proIndexKeys('0007175119'), k);
  assert.deepEqual(proIndexKeys('  7175119  '), k);
});

test('proIndexKeys: a board segment suffix is stripped, so 007157687-1 answers to 7157687', () => {
  // manifest-reconcile records that the board's stopNbr is often "007157687-1" while a
  // dispatcher types the bare PRO. The old PRO search never stripped it.
  assert.deepEqual(proIndexKeys('007157687-1'), ['n_7157687']);
  assert.deepEqual(proIndexKeys('007157687-12'), ['n_7157687']);
});

test('proIndexKeys: a carrier PRO keeps its FULL digit run and is findable both ways', () => {
  // Never collapsed to the bare carrier token — that is the phantom-instance miscount
  // (AVRT-0028093763 vs ESTES-0538243875 read as siblings) CLAUDE.md records.
  assert.deepEqual(proIndexKeys('AVRT-0170416694'), ['n_170416694', 'r_AVRT-0170416694']);
  assert.notDeepEqual(proIndexKeys('AVRT-0028093763'), proIndexKeys('ESTES-0538243875'));
});

test('proIndexKeys: a lower-case search hits an upper-case carrier PRO', () => {
  assert.deepEqual(proIndexKeys('ra5732712'), proIndexKeys('RA5732712'));
});

test('proIndexKeys: an Estes-style 10-digit PRO keeps its dash (not a segment suffix)', () => {
  assert.deepEqual(proIndexKeys('028-8347656'), ['n_288347656', 'r_028-8347656']);
});

test('proIndexKeys: a too-short or empty token mints NO numeric key', () => {
  // A 2-digit key would swallow unrelated orders; every real PRO here is 7+ digits.
  assert.equal(proIndexKeys('12').some((k) => k.startsWith('n_')), false);
  assert.equal(proIndexKeys('123456').some((k) => k.startsWith('n_')), true, '6 digits is the floor');
  assert.deepEqual(proIndexKeys(''), []);
  assert.deepEqual(proIndexKeys('   '), []);
  assert.deepEqual(proIndexKeys(null), []);
});

test('proIndexPath: a slash in a PRO can never build an illegal Firestore path', () => {
  assert.equal(proIndexPath('davis', 'n_7175119'), 'history_pros/davis__n_7175119');
  assert.ok(!proIndexPath('davis', 'r_A/B').slice('history_pros/'.length).includes('/'));
});

// ── merge ────────────────────────────────────────────────────────────────────
test('mergeDayEntries: an attempt and its redelivery BOTH survive, newest first', () => {
  const merged = mergeDayEntries(
    [{ date: '2026-09-02', pro: '007175119', matchKey: 'mk', name: 'ACME' }],
    [{ date: '2026-09-08', pro: '007175119', matchKey: 'mk', name: 'ACME' }],
  );
  assert.deepEqual(merged.map((d) => d.date), ['2026-09-08', '2026-09-02']);
});

test('mergeDayEntries: same day + same pro de-dupes, and a known customer key wins', () => {
  const merged = mergeDayEntries(
    [{ date: '2026-09-08', pro: '007175119', matchKey: null, name: null }],
    [{ date: '2026-09-08', pro: '007175119', matchKey: 'mk', name: 'ACME' }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].matchKey, 'mk');
});

test('mergeDayEntries: drops entries with no date or no pro, and caps the list', () => {
  assert.deepEqual(mergeDayEntries([], [{ date: '', pro: '1' }, { date: '2026-01-01', pro: '' }, null]), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, pro: 'P', matchKey: null, name: null }));
  assert.equal(mergeDayEntries([], many).length, MAX_DAYS_PER_PRO);
});

// ── one day's pointers ───────────────────────────────────────────────────────
test('buildProIndexForDay: a carrier PRO writes BOTH keys pointing at the same delivery', () => {
  const m = buildProIndexForDay([
    { pro: 'AVRT-0170416694', date: '2026-09-08', customerMatchKey: 'mk1', businessName: 'ACME' },
  ], '2026-09-08');
  assert.deepEqual([...m.keys()].sort(), ['n_170416694', 'r_AVRT-0170416694']);
  for (const e of m.values()) assert.equal(e.pro, 'AVRT-0170416694');
});

test('buildProIndexForDay: a stop with no PRO is skipped, stopNbr is the fallback', () => {
  const m = buildProIndexForDay([
    { date: '2026-09-08', customerMatchKey: 'mk' },
    { stopNbr: '007175119', date: '2026-09-08', customerMatchKey: 'mk', businessName: 'ACME' },
  ], '2026-09-08');
  assert.deepEqual([...m.keys()], ['n_7175119']);
});

test('buildProIndexForDay: a stop with no customer key still gets a pointer', () => {
  // The pointer is what resolves the PRO to its DAY; the full stop is then read from
  // the warehouse. An unkeyed customer must not make the order unfindable.
  const m = buildProIndexForDay([{ pro: '007175119', date: '2026-09-08' }], '2026-09-08');
  assert.equal(m.get('n_7175119').matchKey, null);
});

// ── write pass ───────────────────────────────────────────────────────────────
function fakeIo(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = { create: 0, get: 0, set: 0 };
  return {
    store, calls,
    getDoc: async (p) => { calls.get++; return store.has(p) ? store.get(p) : null; },
    setDoc: async (p, d) => { calls.set++; store.set(p, d); return true; },
    createDocIfAbsent: async (p, d) => { calls.create++; if (store.has(p)) return false; store.set(p, d); return true; },
  };
}

test('updateProIndexForDay: a first-time PRO costs ONE Firestore op (no read)', async () => {
  const io = fakeIo();
  const r = await updateProIndexForDay('davis', '2026-09-08', [
    { pro: '007175119', date: '2026-09-08', customerMatchKey: 'mk', businessName: 'ACME' },
  ], 4, io);
  assert.deepEqual(r, { keys: 1, created: 1, merged: 0 });
  assert.equal(io.calls.get, 0, 'no read on the common path');
  assert.equal(io.calls.set, 0);
  assert.equal(io.store.get('history_pros/davis__n_7175119').days[0].date, '2026-09-08');
});

test('updateProIndexForDay: a redelivery MERGES and never blind-writes the first day away', async () => {
  const io = fakeIo();
  await updateProIndexForDay('davis', '2026-09-02', [
    { pro: '007175119', date: '2026-09-02', customerMatchKey: 'mk', businessName: 'ACME' },
  ], 4, io);
  const r = await updateProIndexForDay('davis', '2026-09-08', [
    { pro: '007175119', date: '2026-09-08', customerMatchKey: 'mk', businessName: 'ACME' },
  ], 4, io);
  assert.deepEqual(r, { keys: 1, created: 0, merged: 1 });
  const doc = io.store.get('history_pros/davis__n_7175119');
  assert.deepEqual(doc.days.map((d) => d.date), ['2026-09-08', '2026-09-02']);
  assert.equal(doc.last_date, '2026-09-08');
});

test('updateProIndexForDay: re-running the same day is idempotent (backfill is safe to repeat)', async () => {
  const io = fakeIo();
  const stops = [{ pro: '007175119', date: '2026-09-08', customerMatchKey: 'mk', businessName: 'ACME' }];
  await updateProIndexForDay('davis', '2026-09-08', stops, 4, io);
  await updateProIndexForDay('davis', '2026-09-08', stops, 4, io);
  assert.deepEqual(io.store.get('history_pros/davis__n_7175119').days.map((d) => d.date), ['2026-09-08']);
});

test('updateProIndexForDay: an empty day writes nothing and does not throw', async () => {
  const io = fakeIo();
  assert.deepEqual(await updateProIndexForDay('davis', '2026-09-08', [], 4, io), { keys: 0, created: 0, merged: 0 });
  assert.equal(io.store.size, 0);
});

// ── read pass ────────────────────────────────────────────────────────────────
test('lookupProDays: THE BUG — a PRO far beyond the customer last-20 still resolves', async () => {
  // 40 later deliveries to this customer have pushed 007175119 off history_customers'
  // 20-entry pro_index. The pointer index does not care how many came after.
  const io = fakeIo();
  await updateProIndexForDay('davis', '2026-09-08', [
    { pro: '007175119', date: '2026-09-08', customerMatchKey: 'mk', businessName: 'ACME' },
  ], 4, io);
  for (let i = 0; i < 40; i++) {
    await updateProIndexForDay('davis', '2026-09-09', [
      { pro: `00720000${i}`, date: '2026-09-09', customerMatchKey: 'mk', businessName: 'ACME' },
    ], 4, io);
  }
  const hits = await lookupProDays('davis', '7175119', io);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].date, '2026-09-08');
  assert.equal(hits[0].pro, '007175119');
});

test('lookupProDays: finds a carrier PRO by its digits OR its full string', async () => {
  const io = fakeIo();
  await updateProIndexForDay('davis', '2026-09-08', [
    { pro: 'AVRT-0170416694', date: '2026-09-08', customerMatchKey: 'mk', businessName: 'ACME' },
  ], 4, io);
  assert.equal((await lookupProDays('davis', '170416694', io))[0].pro, 'AVRT-0170416694');
  assert.equal((await lookupProDays('davis', 'avrt-0170416694', io))[0].pro, 'AVRT-0170416694');
});

test('lookupProDays: a PRO we never captured returns EMPTY — the one NuVizz call that is right', async () => {
  const io = fakeIo();
  assert.deepEqual(await lookupProDays('davis', '9999999', io), []);
  assert.deepEqual(await lookupProDays('davis', '', io), []);
});

test('lookupProDays: a Firestore read that throws degrades to a miss, never a 500', async () => {
  const io = { getDoc: async () => { throw new Error('firestore down'); } };
  assert.deepEqual(await lookupProDays('davis', '7175119', io), []);
});

test('lookupProDays: both keys of one carrier PRO de-dupe to a single hit', async () => {
  const io = fakeIo();
  await updateProIndexForDay('davis', '2026-09-08', [
    { pro: 'RA5732712', date: '2026-09-08', customerMatchKey: 'mk', businessName: 'ACME' },
  ], 4, io);
  assert.equal((await lookupProDays('davis', 'RA5732712', io)).length, 1);
});

// ── the switch ───────────────────────────────────────────────────────────────
test('proIndexEnabled: default ON, explicit off-words OFF, a typo leaves it ON', () => {
  assert.equal(proIndexEnabled({}), true);
  assert.equal(proIndexEnabled({ PRO_INDEX: '' }), true);
  for (const v of ['off', 'OFF', '0', 'false', 'no', ' Off ']) {
    assert.equal(proIndexEnabled({ PRO_INDEX: v }), false, `${v} turns it off`);
  }
  // A typo must never silently put PRO search back to spending a NuVizz call.
  for (const v of ['of', 'ofF!', 'disabled', 'true', 'yes']) {
    assert.equal(proIndexEnabled({ PRO_INDEX: v }), true, `${v} leaves it on`);
  }
});
