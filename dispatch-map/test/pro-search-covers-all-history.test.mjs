// test/pro-search-covers-all-history.test.mjs
//
// THE BUG, END TO END, THROUGH THE REAL ENDPOINT — not through a pure helper.
//
// Chad, 2026-09-15, typing a week-old PRO into "Search past PROs" and being offered a
// NuVizz call for it: "this order is a week old why is it not in the history? we should
// be keeping all orders in history it shouldn't be asking for a nuvizz call here."
//
// We WERE keeping it. history_days holds every stop of every captured day and never
// prunes. What could not see it was the SEARCH: the only PRO-searchable structure was
// `pro_index` on the per-customer rollup, and that array is a customer's most recent 20
// deliveries — so a busy customer's week-old order had fallen off the index while its
// full stop record sat in the warehouse.
//
// These tests build exactly that state against the in-memory Firestore fake, then call
// the REAL nuvizz-customer-history handler. The fake THROWS on any fetch that is not
// Firestore, so "zero NuVizz calls" is proved rather than asserted. PRO_INDEX=off
// reproduces the original failure, which is what proves these tests bite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const TENANT = 'davis';
const MK = 'acme|123 main st|buford|30518';
const TARGET = '007175119';
const TARGET_DAY = '2026-09-08';

const stop = (pro, date) => ({
  pro, stopNbr: pro, date, tenant: TENANT,
  customerMatchKey: MK, businessName: 'ACME SUPPLY',
  addr1: '123 MAIN ST', city: 'BUFORD', state: 'GA', zip: '30518',
  driverName: 'ANDERSON FRIMPONG',
});

// Minimal ARRAY_CONTAINS runQuery over the fake's store — so the OLD last-20 path is
// genuinely exercised (and genuinely comes up empty) rather than erroring into a pass.
function queryHandler(store) {
  return (url, init) => {
    if (!url.includes(':runQuery')) throw new Error(`unexpected non-Firestore fetch: ${url}`);
    const q = JSON.parse(String(init.body)).structuredQuery;
    const coll = q.from?.[0]?.collectionId;
    const f = q.where?.fieldFilter;
    const rows = [...store.entries()]
      .filter(([k]) => k.startsWith(`${coll}/`) && k.slice(coll.length + 1).split('/').length === 1)
      .filter(([, v]) => {
        if (!f) return true;
        const field = v?.[f.field.fieldPath];
        if (f.op === 'ARRAY_CONTAINS') return Array.isArray(field) && field.includes(f.value.stringValue);
        return false;
      })
      .map(([k, v]) => ({ document: { name: `projects/testproj/databases/(default)/documents/${k}`, fields: encodeFields(v) } }));
    return new Response(JSON.stringify(rows), { status: 200 });
  };
}
const encodeFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const enc = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
};

/**
 * The real state: the target delivered a week ago, then 25 more deliveries to the SAME
 * customer — enough to push it off the rollup's 20-entry pro_index — with both the rollup
 * and the pointer index built exactly the way the nightly post-seal hooks build them.
 */
function installFirestoreFakeWithQuery() {
  const holder = {};
  const fake = installFirestoreFake({}, (url, init) => queryHandler(holder.store)(url, init));
  holder.store = fake.store;
  return fake;
}

async function buildHistory(fake) {
  const { updateCustomerRollupsForDay } = await import('../netlify/functions/lib/history-customers.mts');
  const { updateProIndexForDay } = await import('../netlify/functions/lib/history-pro-index.mts');
  const days = [[TARGET_DAY, [stop(TARGET, TARGET_DAY)]]];
  for (let i = 0; i < 25; i++) {
    const d = `2026-09-${String(9 + (i % 5)).padStart(2, '0')}`;
    days.push([d, [stop(`0072000${String(i).padStart(2, '0')}`, d)]]);
  }
  for (const [date, stops] of days) {
    for (const s of stops) fake.store.set(`history_days/${TENANT}__${date}/stops/${s.pro}`, s);
    await updateCustomerRollupsForDay(TENANT, date, stops);
    await updateProIndexForDay(TENANT, date, stops);
  }
}

async function searchPro(pro) {
  const handler = (await import('../netlify/functions/nuvizz-customer-history.mts')).default;
  const res = await handler(new Request(`https://x/.netlify/functions/nuvizz-customer-history?pro=${encodeURIComponent(pro)}`));
  return res.json();
}

test('the week-old PRO is FOUND, with zero NuVizz calls, though 25 deliveries pushed it off the last-20', async () => {
  const fake = installFirestoreFakeWithQuery();
  const prev = process.env.PRO_INDEX;
  delete process.env.PRO_INDEX;   // default ON
  try {
    await buildHistory(fake);
    // Precondition: the rollup really has dropped it — this is the state Chad hit.
    const rollup = fake.store.get(`history_customers/${TENANT}__${MK}`);
    assert.equal(rollup.pros.length, 20);
    assert.equal(rollup.pro_index.includes(TARGET), false, 'the last-20 index no longer holds it');

    const d = await searchPro('7175119');
    assert.equal(d.ok, true);
    assert.equal(d.indexed, true);
    assert.equal(d.customers.length, 1, 'the customer comes back');
    assert.equal(d.customers[0].name, 'ACME SUPPLY');
    assert.equal(d.customers[0].hitPro, TARGET);
    assert.equal(d.customers[0].hitDate, TARGET_DAY);
    // The searched order rides FIRST, so one tap opens it rather than the newest delivery.
    assert.equal(d.customers[0].pros[0].pro, TARGET);
    assert.equal(d.customers[0].pros[0].date, TARGET_DAY);
  } finally {
    fake.restore();
    if (prev === undefined) delete process.env.PRO_INDEX; else process.env.PRO_INDEX = prev;
  }
});

test('PRO_INDEX=off reproduces the original failure — nothing found, and the screen would ask for a NuVizz call', async () => {
  const fake = installFirestoreFakeWithQuery();
  const prev = process.env.PRO_INDEX;
  process.env.PRO_INDEX = 'off';
  try {
    await buildHistory(fake);
    const d = await searchPro('7175119');
    assert.equal(d.ok, true);
    assert.equal(d.indexed, false);
    assert.deepEqual(d.customers, [], 'the pre-fix behaviour: an order we hold reads as missing');
  } finally {
    fake.restore();
    if (prev === undefined) delete process.env.PRO_INDEX; else process.env.PRO_INDEX = prev;
  }
});

test('the padded form, the bare form and the segment-suffixed form all find the same order', async () => {
  const fake = installFirestoreFakeWithQuery();
  const prev = process.env.PRO_INDEX;
  delete process.env.PRO_INDEX;
  try {
    await buildHistory(fake);
    for (const typed of ['7175119', '007175119', '0007175119', '007175119-1']) {
      const d = await searchPro(typed);
      assert.equal(d.customers.length, 1, `"${typed}" finds it`);
      assert.equal(d.customers[0].hitPro, TARGET, `"${typed}" resolves to the stored PRO`);
    }
  } finally {
    fake.restore();
    if (prev === undefined) delete process.env.PRO_INDEX; else process.env.PRO_INDEX = prev;
  }
});

test('a PRO we have never captured still returns nothing — the one case the NuVizz button is right for', async () => {
  const fake = installFirestoreFakeWithQuery();
  const prev = process.env.PRO_INDEX;
  delete process.env.PRO_INDEX;
  try {
    await buildHistory(fake);
    const d = await searchPro('9999999');
    assert.deepEqual(d.customers, []);
  } finally {
    fake.restore();
    if (prev === undefined) delete process.env.PRO_INDEX; else process.env.PRO_INDEX = prev;
  }
});

test('the full archived delivery is still readable from the warehouse for the found day', async () => {
  // The pointer resolves PRO → day; getStop then serves route, driver, ticket and line
  // items out of the immutable warehouse. Both halves, still zero NuVizz calls.
  const fake = installFirestoreFakeWithQuery();
  const prev = process.env.PRO_INDEX;
  delete process.env.PRO_INDEX;
  try {
    await buildHistory(fake);
    const d = await searchPro('7175119');
    const { getStop } = await import('../netlify/functions/lib/history-store.mts');
    const doc = await getStop(TENANT, d.customers[0].hitDate, d.customers[0].hitPro);
    assert.equal(doc.driverName, 'ANDERSON FRIMPONG');
    assert.equal(doc.businessName, 'ACME SUPPLY');
  } finally {
    fake.restore();
    if (prev === undefined) delete process.env.PRO_INDEX; else process.env.PRO_INDEX = prev;
  }
});
