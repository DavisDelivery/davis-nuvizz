// test/stop-search-endpoint.test.mjs — address / city search, END TO END against the Firestore fake.
//
// stop-search.test.mjs pins what a match IS. This pins what the endpoint READS and what the
// writers WRITE — the half where a search can quietly skip a week, double-count a day, or answer
// "no stops there" when the truth is "that search is switched off". The fake throws on any fetch
// that is not Firestore, so `log.other` being empty is the proof that no NuVizz call was made.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { encodeSearchDigest } from '../src/lib/stop-search.js';

const T = 'davis';
const call = async (qs) => {
  const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
  const r = await handler(new Request(`https://x.netlify.app/.netlify/functions/stop-lookup?${qs}`));
  return { status: r.status, body: await r.json() };
};
const rebuild = async (qs) => {
  const handler = (await import('../netlify/functions/history-search-rebuild.mts')).default;
  const r = await handler(new Request(`https://x.netlify.app/.netlify/functions/history-search-rebuild?${qs}`));
  return { status: r.status, body: await r.json() };
};
const today = async () => (await import('../netlify/functions/lib/firestore.mts')).etDayString();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const st = (n, addr1, city, zip, extra = {}) => ({
  stopNbr: n, pro: n, businessName: `ACME ${n}`, addr1, city, state: 'GA', zip,
  normalizedStatus: 'DELIVERED', driverName: 'ENOCK AKYEA', routeName: 'NOR 2', ...extra,
});
const manifest = (d, extra = {}) => ({ [`history_days/${T}__${d}`]: { tenant: T, date: d, complete: true, verified: true, ...extra } });
const digest = (d, stops) => ({ [`history_search/${T}__${d}`]: encodeSearchDigest(stops, { tenant: T, date: d, builtAt: 'test' }) });
const sealedDay = (d, stops) => ({ ...manifest(d), ...digest(d, stops) });

function withEnv(k, v, fn) {
  const was = process.env[k];
  process.env[k] = v;
  return Promise.resolve(fn()).finally(() => { if (was === undefined) delete process.env[k]; else process.env[k] = was; });
}

test('ALL DATES FINDS EVERY SPELLING OF AN ADDRESS ACROSS MONTHS — and nothing but Firestore was called', async () => {
  const fake = installFirestoreFake({
    ...sealedDay('2026-07-14', [st('A1', '1100 NORTHSIDE DR NW', 'ATLANTA', '30318'), st('A2', '5 OTHER RD', 'DULUTH', '30096')]),
    ...sealedDay('2026-09-15', [st('B1', '1100 Northside Drive NW Ste 210', 'Atlanta', '30318-2211')]),
  });
  try {
    const { status, body } = await call('addr=1100%20northside%20dr&city=atlanta');
    assert.equal(status, 200);
    assert.equal(body.mode, 'place');
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(fake.log.other.length, 0, 'no non-Firestore call may be made');
    assert.equal(body.range.kind, 'all', 'no dates given is ALL');
    assert.equal(body.view.matched, 2);
    assert.deepEqual(body.view.days.map((d) => d.date), ['2026-09-15', '2026-07-14'], 'newest first, across months');
    // THE READS: the digest a calendar month at a time, never one unbounded query once the
    // floor is known — the floor comes from the manifests.
    const searchQs = fake.log.queries.filter((q) => q.from?.[0]?.collectionId === 'history_search');
    assert.ok(searchQs.length >= 3, 'Jul, Aug, Sep … each its own query');
    for (const q of searchQs) assert.ok(q.where?.compositeFilter, 'every digest read is date-bounded');
  } finally { fake.restore(); }
});

test('A DAY WE HOLD BUT HAVE NO INDEX FOR IS NAMED — and a day Davis did not run is not', async () => {
  // The failure this prevents: an address search that silently skipped a week answering "we
  // never delivered there" about exactly that week.
  const fake = installFirestoreFake({
    ...sealedDay('2026-07-14', [st('A1', '1 MAIN ST', 'ATLANTA', '30318')]),
    ...manifest('2026-08-03'),                                   // sealed, no digest
    ...manifest('2026-08-01', { no_board: true }),               // a tombstone
  });
  try {
    const { body } = await call('city=atlanta');
    assert.deepEqual(body.coverage.missing, ['2026-08-03']);
    assert.equal(body.coverage.missingCount, 1);
    assert.equal(body.coverage.complete, false, 'an answer with a hole in it is not a complete answer');
    const sealed = body.sources.find((s) => s.key === 'sealed');
    assert.equal(sealed.state, 'partial');
    assert.match(sealed.note, /2026-08-03/, 'the ledger names the day too');
  } finally { fake.restore(); }
});

test('ONE DAY IS ONE DAY — nothing outside it is read or counted', async () => {
  const fake = installFirestoreFake({
    ...sealedDay('2026-07-14', [st('A1', '1 MAIN ST', 'ATLANTA', '30318')]),
    ...sealedDay('2026-07-15', [st('A2', '1 MAIN ST', 'ATLANTA', '30318')]),
  });
  try {
    const { body } = await call('addr=1%20main%20st&date=2026-07-14');
    assert.equal(body.range.kind, 'day');
    assert.equal(body.view.matched, 1);
    assert.equal(body.view.days[0].date, '2026-07-14');
    assert.equal(body.coverage.searchedDays, 1);
  } finally { fake.restore(); }
});

test('A RANGE WIDER THAN SIXTY DAYS IS NOT QUIETLY SHORTENED', async () => {
  const fake = installFirestoreFake({
    ...sealedDay('2026-03-02', [st('A1', '1 MAIN ST', 'ATLANTA', '30318')]),
    ...sealedDay('2026-07-14', [st('A2', '1 MAIN ST', 'ATLANTA', '30318')]),
  });
  try {
    const { body } = await call('zip=30318&from=2026-01-01&to=2026-08-31');
    assert.deepEqual([body.range.from, body.range.to, body.range.clamped], ['2026-01-01', '2026-08-31', null]);
    assert.equal(body.view.matched, 2, 'March is still in it');
  } finally { fake.restore(); }
});

test('TODAY COMES FROM THE LIVE BOARD — it is never sealed, and a search that skipped it would miss this morning', async () => {
  const t = await today();
  const fake = installFirestoreFake({
    ...sealedDay('2026-07-14', [st('A1', '1 MAIN ST', 'ATLANTA', '30318')]),
    [`nuvizz_stop_index/${T}__${t}/stops/B1`]: st('B1', '1 MAIN ST', 'ATLANTA', '30318', { normalizedStatus: 'SCHEDULED' }),
  });
  try {
    const { body } = await call('addr=1%20main%20st');
    assert.equal(body.view.matched, 2);
    const todayRow = body.view.days.find((d) => d.date === t).rows[0];
    assert.equal(todayRow.source, 'board');
    assert.equal(todayRow.outcome, 'open', 'still out, and it says so');
    assert.ok(body.coverage.boardDays.includes(t));
  } finally { fake.restore(); }
});

test('A SEALED DAY IS NEVER ALSO READ FROM THE BOARD — the same delivery must not count twice', async () => {
  const t = await today();
  const y = addDays(t, -1);
  const fake = installFirestoreFake({
    ...sealedDay(y, [st('A1', '1 MAIN ST', 'ATLANTA', '30318')]),
    [`nuvizz_stop_index/${T}__${y}/stops/A1`]: st('A1', '1 MAIN ST', 'ATLANTA', '30318'),
  });
  try {
    const { body } = await call('addr=1%20main%20st');
    assert.equal(body.view.matched, 1);
    assert.equal(body.coverage.boardDays.includes(y), false, 'the board is not even read for a day the index holds');
  } finally { fake.restore(); }
});

test('SWITCHED OFF IS SAID, NOT EMPTIED — and nothing is read', async () => {
  const fake = installFirestoreFake({ ...sealedDay('2026-07-14', [st('A1', '1 MAIN ST', 'ATLANTA', '30318')]) });
  try {
    await withEnv('STOP_SEARCH', 'off', async () => {
      const { status, body } = await call('city=atlanta');
      assert.equal(status, 200);
      assert.equal(body.switchedOff, true);
      assert.equal(body.view, undefined, 'no view — a zero here would read as a fact');
      assert.equal(fake.log.queries.length, 0, 'the switch reverts the read as well');
    });
  } finally { fake.restore(); }
});

test('a state alone is refused rather than read as every stop in Georgia', async () => {
  const fake = installFirestoreFake({});
  try {
    const { status } = await call('city=&state=GA&zip=');
    assert.equal(status, 400);
  } finally { fake.restore(); }
});

test('THE ORDER AND CUSTOMER SEARCHES ARE UNTOUCHED — a name is still a name, a PRO still a PRO', async () => {
  // The place branch only opens on addr/city/zip with no stop, name or detail beside them.
  const fake = installFirestoreFake({});
  try {
    const { body } = await call('stop=007174397&city=atlanta');
    assert.equal(body.mode, 'stop', 'a PRO wins over a stray city param');
  } finally { fake.restore(); }
});

// ── THE WRITERS ──────────────────────────────────────────────────────────────

test('THE NIGHTLY HOOK WRITES ONE DIGEST FOR THE DAY — and the switch stops it writing', async () => {
  const { updateStopSearchForDay, searchDigestPath } = await import('../netlify/functions/lib/stop-search-store.mts');
  const fake = installFirestoreFake({});
  try {
    const r = await updateStopSearchForDay(T, '2026-09-15', [st('A1', '1 MAIN ST', 'ATLANTA', '30318'), st('A2', '2 MAIN ST', 'ATLANTA', '30318')]);
    assert.equal(r.count, 2);
    const doc = fake.store.get(searchDigestPath(T, '2026-09-15'));
    assert.ok(doc, 'written where the search reads');
    assert.equal(doc.count, 2);
    assert.equal(doc.date, '2026-09-15');
    await withEnv('STOP_SEARCH', 'off', async () => {
      const off = await updateStopSearchForDay(T, '2026-09-16', [st('A3', '3 MAIN ST', 'ATLANTA', '30318')]);
      assert.deepEqual(off, { skipped: 'STOP_SEARCH=off' });
      assert.equal(fake.store.has(searchDigestPath(T, '2026-09-16')), false);
    });
  } finally { fake.restore(); }
});

test('AN OVER-SIZE DAY FAILS LOUDLY — it is never truncated into a digest that drops stops', async () => {
  const { writeSearchDigest } = await import('../netlify/functions/lib/stop-search-store.mts');
  const writes = [];
  const huge = Array.from({ length: 4000 }, (_, i) => st(`X${i}`, `${i} ${'VERY LONG STREET NAME '.repeat(10)}`, 'ATLANTA', '30318'));
  await assert.rejects(() => writeSearchDigest(T, '2026-09-15', huge, { setDoc: async (p, d) => { writes.push(p); } }), /NOT searchable/);
  assert.equal(writes.length, 0, 'nothing was written');
});

test('THE REBUILD: a dry run plans and writes nothing; a real run builds oldest first and the days become searchable', async () => {
  const fake = installFirestoreFake({
    ...manifest('2026-06-04'), [`history_days/${T}__2026-06-04/stops/A1`]: st('A1', '1 MAIN ST', 'ATLANTA', '30318'),
    ...manifest('2026-06-05'), [`history_days/${T}__2026-06-05/stops/A2`]: st('A2', '1 MAIN ST', 'ATLANTA', '30318'),
    ...sealedDay('2026-06-06', [st('A3', '1 MAIN ST', 'ATLANTA', '30318')]),
  });
  try {
    const dry = await rebuild('missing=1&dry=1');
    assert.equal(dry.status, 200);
    assert.deepEqual(dry.body.planned, ['2026-06-04', '2026-06-05']);
    assert.equal(dry.body.alreadyIndexed, 1);
    assert.equal(fake.log.sets.length, 0, 'a dry run writes NOTHING');

    const before = await call('addr=1%20main%20st&from=2026-06-01&to=2026-06-30');
    assert.equal(before.body.view.matched, 1, 'only the indexed day is searchable');
    assert.equal(before.body.coverage.missingCount, 2);

    const real = await rebuild('missing=1');
    assert.equal(real.body.ok, true);
    assert.deepEqual(real.body.built.map((b) => b.date), ['2026-06-04', '2026-06-05']);
    assert.equal(real.body.nuvizzCalls, 0);
    assert.equal(fake.log.other.length, 0);

    const after = await call('addr=1%20main%20st&from=2026-06-01&to=2026-06-30');
    assert.equal(after.body.view.matched, 3);
    assert.equal(after.body.coverage.complete, true);
  } finally { fake.restore(); }
});

test('THE REBUILD REFUSES WHEN THE SWITCH IS OFF — one switch reverts every side', async () => {
  const fake = installFirestoreFake({ ...manifest('2026-06-04') });
  try {
    await withEnv('STOP_SEARCH', 'off', async () => {
      const r = await rebuild('missing=1');
      assert.equal(r.status, 409);
      assert.equal(r.body.switchedOff, true);
      assert.equal(fake.log.sets.length, 0);
    });
  } finally { fake.restore(); }
});
