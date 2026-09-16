// test/load-history-endpoint.test.mjs — the send-history reader, driven end to end against an
// in-memory Firestore that THROWS on any non-Firestore fetch. That throw is the point: it
// proves the promise on the endpoint's own first line, that reading this history costs ZERO
// NuVizz calls, rather than asserting a number the code prints about itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const DAY = '2026-09-16';
const PRIOR = '2026-09-15';
const DOC = (d) => `nuvizz_ops/load_sends__davis__${d}`;

const row = (over = {}) => ({
  at: `${DAY}T18:14:00.000Z`, date: DAY, loadNbr: 'DAVIS1', loadId: 'hex1', routeName: 'ALPHA',
  op: 'commitBoard', verdict: 'confirmed', by: 'jrivera', clientOpId: 'op_1',
  before: ['007000001'], after: ['007000001', '007175992'],
  added: ['007175992'], removed: [], resequenced: false,
  driverSet: null, dispatched: false, created: false, cancelled: false, error: null,
  ...over,
});

const seedDay = (d, rows) => ({ [DOC(d)]: { tenant: 'davis', date: d, count: rows.length, rowsJson: JSON.stringify(rows) } });

async function call(qs) {
  const { default: handler } = await import('../netlify/functions/load-history.mts');
  const res = await handler(new Request(`https://x/.netlify/functions/load-history?${qs}`));
  return { res, body: await res.json() };
}

test('ZERO NUVIZZ CALLS — the whole history reads out of our own day documents, and a vendor '
  + 'fetch would throw in this harness', async () => {
  const fake = installFirestoreFake(seedDay(DAY, [row(), row({ clientOpId: 'op_2', routeName: 'SUW 2', loadNbr: 'DAVIS2' })]));
  try {
    const { body } = await call(`date=${DAY}`);
    assert.equal(body.ok, true);
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(body.rows.length, 2);
    assert.equal(fake.log.other.length, 0, 'nothing but Firestore was contacted');
  } finally { fake.restore(); }
});

test('one route across days: the load filter matches the route NAME, which is the identity that '
  + 'survives the nightly re-mint of loadNbr', async () => {
  const fake = installFirestoreFake({
    ...seedDay(DAY, [row({ routeName: 'ALPHA', loadNbr: 'DAVIS_TODAY' })]),
    ...seedDay(PRIOR, [row({ at: `${PRIOR}T14:00:00.000Z`, date: PRIOR, routeName: 'ALPHA', loadNbr: 'DAVIS_YESTERDAY' }),
      row({ at: `${PRIOR}T15:00:00.000Z`, date: PRIOR, routeName: 'CHE', loadNbr: 'DAVIS_OTHER' })]),
  });
  try {
    const { body } = await call(`from=${PRIOR}&to=${DAY}&load=ALPHA`);
    assert.equal(body.rows.length, 2);
    assert.deepEqual(body.rows.map((r) => r.loadNbr), ['DAVIS_TODAY', 'DAVIS_YESTERDAY'], 'newest first');
  } finally { fake.restore(); }
});

test('"what happened to 007175992" finds the send that ADDED it and the one that took it off', async () => {
  const fake = installFirestoreFake(seedDay(DAY, [
    row({ clientOpId: 'op_add', added: ['007175992'], after: ['007175992'] }),
    row({ clientOpId: 'op_drop', at: `${DAY}T19:00:00.000Z`, routeName: 'CHE', before: ['007175992'], after: [], removed: ['007175992'], added: [] }),
    row({ clientOpId: 'op_other', added: ['007000009'], before: [], after: ['007000009'] }),
  ]));
  try {
    const { body } = await call(`date=${DAY}&stop=007175992`);
    assert.equal(body.rows.length, 2);
    assert.deepEqual(body.rows.map((r) => r.clientOpId), ['op_drop', 'op_add']);
  } finally { fake.restore(); }
});

test('THE SUMMARY IGNORES THE VERDICT FILTER — the screen\'s pills carry these counts, so '
  + 'filtering to one must not zero the others', async () => {
  const fake = installFirestoreFake(seedDay(DAY, [
    row({ clientOpId: 'a', verdict: 'confirmed' }),
    row({ clientOpId: 'b', verdict: 'refused', after: null, error: 'load not found' }),
    row({ clientOpId: 'c', verdict: 'partial' }),
  ]));
  try {
    const { body } = await call(`date=${DAY}&verdict=refused`);
    assert.equal(body.rows.length, 1, 'the LIST is filtered');
    assert.equal(body.summary.confirmed, 1, 'and the breakdown still describes the whole day');
    assert.equal(body.summary.refused, 1);
    assert.equal(body.summary.partial, 1);
    assert.equal(body.summary.unobserved, 1, 'the honesty counter survives the filter too');
  } finally { fake.restore(); }
});

test('the per-day strip counts what the CALLER asked for — a strip reading 3 over a list of 1 '
  + 'is a screen arguing with itself', async () => {
  const fake = installFirestoreFake({
    ...seedDay(DAY, [row({ routeName: 'ALPHA' }), row({ clientOpId: 'x', routeName: 'CHE' })]),
    ...seedDay(PRIOR, [row({ at: `${PRIOR}T10:00:00Z`, date: PRIOR, routeName: 'CHE' })]),
  });
  try {
    const { body } = await call(`from=${PRIOR}&to=${DAY}&load=ALPHA`);
    const byDay = Object.fromEntries(body.days.map((d) => [d.date, d.count]));
    assert.equal(byDay[DAY], 1);
    assert.equal(byDay[PRIOR], 0);
  } finally { fake.restore(); }
});

test('THE WINDOW REACHES FORWARD. An 11pm Save files against TOMORROW\'s board day, and a '
  + 'window clamped at today could not ask for the row it had just written (v1.29.0)', async () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const fake = installFirestoreFake(seedDay(tomorrow, [row({ date: tomorrow, at: `${tomorrow}T03:00:00.000Z`, routeName: 'ALPHA' })]));
  try {
    const { body } = await call('days=2');
    assert.ok(body.range.to >= tomorrow, `the window reaches ${tomorrow}, got ${body.range.to}`);
    assert.equal(body.rows.length, 1, 'and the row written against it is readable');
  } finally { fake.restore(); }
});

test('a day nobody sent anything on answers cleanly rather than erroring', async () => {
  const fake = installFirestoreFake({});
  try {
    const { body } = await call(`date=${DAY}`);
    assert.equal(body.ok, true);
    assert.deepEqual(body.rows, []);
    assert.equal(body.summary.rows, 0);
  } finally { fake.restore(); }
});

test('LOAD_HISTORY=off SAYS SO. A screen quietly asking for days nothing writes any more is a '
  + 'new bug wearing the old feature\'s name', async () => {
  const fake = installFirestoreFake(seedDay(DAY, [row()]));
  process.env.LOAD_HISTORY = 'off';
  try {
    const { body } = await call(`date=${DAY}`);
    assert.equal(body.ok, false);
    assert.equal(body.disabled, true);
    assert.match(body.error, /LOAD_HISTORY=off/);
  } finally { delete process.env.LOAD_HISTORY; fake.restore(); }
});

// ── the writer ──────────────────────────────────────────────────────────────

test('recordLoadSends appends newest-first and REFUSES A REPLAY, so one move can never read as '
  + 'two', async () => {
  const fake = installFirestoreFake({});
  try {
    const { recordLoadSends, readLoadSends } = await import('../netlify/functions/lib/firestore.mts');
    assert.equal(await recordLoadSends('davis', DAY, [row({ clientOpId: 'op_1' })]), true);
    assert.equal(await recordLoadSends('davis', DAY, [row({ clientOpId: 'op_1' })]), false, 'the same op on the same load is not filed twice');
    assert.equal(await recordLoadSends('davis', DAY, [row({ clientOpId: 'op_2', at: `${DAY}T19:00:00.000Z` })]), true);
    const back = await readLoadSends('davis', DAY);
    assert.deepEqual(back.map((r) => r.clientOpId), ['op_2', 'op_1']);
  } finally { fake.restore(); }
});

test('THE REPLAY GUARD IGNORES THE CLOCK. A platform retry of a function whose response never '
  + 'came back re-runs the same Save with a NEW instant — keying the dedup on `at` would make '
  + 'that the one case it cannot catch, and one move would read as two', async () => {
  const fake = installFirestoreFake({});
  try {
    const { recordLoadSends, readLoadSends } = await import('../netlify/functions/lib/firestore.mts');
    await recordLoadSends('davis', DAY, [row({ clientOpId: 'op_retry', at: `${DAY}T18:14:00.000Z` })]);
    const again = await recordLoadSends('davis', DAY, [row({ clientOpId: 'op_retry', at: `${DAY}T18:14:09.500Z` })]);
    assert.equal(again, false, 'the same load in the same Save is not filed twice');
    assert.equal((await readLoadSends('davis', DAY)).length, 1);
  } finally { fake.restore(); }
});

test('a SECOND, GENUINELY DIFFERENT Save of the same load files its own row — the guard must '
  + 'not collapse a morning\'s real edits into one', async () => {
  const fake = installFirestoreFake({});
  try {
    const { recordLoadSends, readLoadSends } = await import('../netlify/functions/lib/firestore.mts');
    await recordLoadSends('davis', DAY, [row({ clientOpId: 'op_1' })]);
    await recordLoadSends('davis', DAY, [row({ clientOpId: 'op_2', at: `${DAY}T19:30:00.000Z` })]);
    assert.equal((await readLoadSends('davis', DAY)).length, 2);
  } finally { fake.restore(); }
});

test('a history write can never fail a Save: Firestore off is a quiet false, not a throw', async () => {
  const fake = installFirestoreFake({});
  try {
    const { recordLoadSends } = await import('../netlify/functions/lib/firestore.mts');
    assert.equal(await recordLoadSends('davis', DAY, []), false);
    assert.equal(await recordLoadSends('davis', DAY, null), false);
  } finally { fake.restore(); }
});
