// test/load-columns-period-docs.test.mjs — A STORED ROSTER PROBE ANSWERS ONLY THE PERIOD IT WAS TAKEN FOR.
//
// nuvizz-load-columns keeps each ?period= probe under its own document so the free read
// (?period=… without confirm) can hand it back for nothing. The document name used to squash
// every run of '+', '-' and '/' into '_', so '+1d', '-1d' and '+/-1d' were ONE document: a probe
// of yesterday's roster was served, free, as the answer about tomorrow's. That diagnostic is how
// Chad decides which period NuVizz honours, so a past-day answer to a future-day question is the
// exact wrong reading it exists to prevent.
//
// Driven through the REAL handler against the in-memory Firestore; the one NuVizz call is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
delete process.env.NUVIZZ_SCANS_ENABLED;
delete process.env.AUTH_REQUIRED;

const DATE = '2026-09-28';
const grid = { filterData: [{ KeyColumn: { columnName: 'KeyColumn' }, name: { columnName: 'Load Name' } }], values: [['a1', 'CHE']], totalRecords: 1 };

async function withHandler(seed, fn) {
  const vendor = [];
  const fake = installFirestoreFake(seed, async (url) => {
    if (/PkgRoute/.test(url)) { vendor.push(url); return new Response(JSON.stringify(grid), { status: 200 }); }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  try {
    const { default: handler } = await import('../netlify/functions/nuvizz-load-columns.mts');
    const call = async (q) => {
      const r = await handler(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-load-columns?${q}`));
      return { status: r.status, body: await r.json() };
    };
    return await fn({ call, store: fake.store, vendor });
  } finally { fake.restore(); }
}

test("a roster probe for yesterday's period is never served, free, as the answer about tomorrow's", async () => {
  await withHandler({}, async ({ call, store, vendor }) => {
    const probe = await call(`date=${DATE}&period=${encodeURIComponent('-1d')}&confirm=1`);
    assert.equal(probe.status, 200);
    assert.equal(probe.body.period, '-1d');
    assert.equal(vendor.length, 1, 'the probe is the one call');

    for (const other of ['+1d', '+/-1d']) {
      const r = await call(`date=${DATE}&period=${encodeURIComponent(other)}`);
      assert.equal(r.status, 428, `period ${other} was never probed, so there is nothing stored to serve (got ${r.body.source} ${r.body.period})`);
    }
    const same = await call(`date=${DATE}&period=${encodeURIComponent('-1d')}`);
    assert.equal(same.status, 200);
    assert.equal(same.body.source, 'stored');
    assert.equal(same.body.period, '-1d', 'the period that was probed still reads back for nothing');
    assert.equal(vendor.length, 1, 'the free reads spent nothing');
    assert.equal([...store.keys()].filter((k) => k.includes('load_columns')).length, 1);
  });
});

test('probing +1d after -1d keeps both answers — neither one replaces the other', async () => {
  await withHandler({}, async ({ call }) => {
    await call(`date=${DATE}&period=${encodeURIComponent('-1d')}&confirm=1`);
    await call(`date=${DATE}&period=${encodeURIComponent('+1d')}&confirm=1`);
    await call(`date=${DATE}&period=${encodeURIComponent('+/-1d')}&confirm=1`);
    for (const p of ['-1d', '+1d', '+/-1d']) {
      const r = await call(`date=${DATE}&period=${encodeURIComponent(p)}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.period, p, `the free read for ${p} is ${p}'s own answer`);
    }
  });
});

test('an answer stored under the old squashed name is still read back for its own period, and only for it', async () => {
  // What a probe written before this fix left behind: '+/-7d' filed under '__p__7d'.
  const legacy = { [`nuvizz_ops/load_columns__${DATE}__p__7d`]: { date: DATE, period: '+/-7d', periodOverride: true, httpStatus: 200, ok: true, storedAt: '2026-09-26T15:00:00Z' } };
  await withHandler(legacy, async ({ call, vendor }) => {
    const own = await call(`date=${DATE}&period=${encodeURIComponent('+/-7d')}`);
    assert.equal(own.status, 200, 'the probe already paid for is not thrown away');
    assert.equal(own.body.period, '+/-7d');
    for (const other of ['+7d', '-7d']) {
      const r = await call(`date=${DATE}&period=${encodeURIComponent(other)}`);
      assert.equal(r.status, 428, `the +/-7d answer is not served for ${other}`);
    }
    assert.equal(vendor.length, 0);
  });
});

test('the everyday stored answer (no period override) reads back exactly as before', async () => {
  const everyday = { [`nuvizz_ops/load_columns__${DATE}`]: { date: DATE, period: '+1d', periodOverride: false, httpStatus: 200, ok: true } };
  await withHandler(everyday, async ({ call, vendor }) => {
    const r = await call(`date=${DATE}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'stored');
    assert.equal(vendor.length, 0);
  });
});
