// test/save-sent-journal-e2e.test.mjs — the REAL handlers write `sent` onto the journal row.
//
// save-sent.test.mjs pins the rule; this pins that the two endpoints that journal a Save actually
// keep it: nuvizz-write (the Save itself — kept whether NuVizz takes it or refuses it, since the
// refused ones are the rows the BRIAN question needed) and nuvizz-board-sync (the write-through
// that follows a confirmed Save). In-memory Firestore; a fake NuVizz that answers every load read
// "not found", so the Save fails the way a real one can and is still journaled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
delete process.env.AUTH_REQUIRED;
delete process.env.NUVIZZ_PERSONAL_LOGINS;
delete process.env.NUVIZZ_RWB_ENABLED;
process.env.NUVIZZ_WRITE_ENABLED = 'true';
process.env.NUVIZZ_DAVIS_USER = 'sharednv';
process.env.NUVIZZ_DAVIS_PASS = 'shared-pw';

const { default: writeHandler } = await import('../netlify/functions/nuvizz-write.mts');
const { default: syncHandler } = await import('../netlify/functions/nuvizz-board-sync.mts');

const PICKUP = 'RA58610778-1-1';
const DELIVERIES = ['007183174', '007183608', '007183661'];
const post = (h, url, body) => h(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const opRows = (fake) => [...fake.store.entries()].filter(([k]) => k.startsWith('nuvizz_write_ops/')).map(([, v]) => v);

test('nuvizz-write: a refused Save is journaled WITH the stops it sent, per load, in order', async () => {
  const vendor = [];
  const fake = installFirestoreFake({}, async (url) => { vendor.push(String(url)); return new Response(JSON.stringify({ message: 'not found' }), { status: 404 }); });
  try {
    const res = await post(writeHandler, 'http://localhost/.netlify/functions/nuvizz-write', {
      op: 'commitBoard', clientOpId: 'op-brian-838', createdBy: 'dispatcher',
      payload: { date: '2026-09-29', loads: [{ __key: 'BRIAN', loadNbr: 'DAVIS000204685', routeName: 'BRIAN', orderedStopNbrs: DELIVERIES, removeStopNbrs: [] }] },
    });
    const j = await res.json();
    assert.equal(j.ok, false, 'the fake NuVizz has no such load — the Save fails, as a real one can');
    const rec = opRows(fake).find((r) => r.clientOpId === 'op-brian-838');
    assert.ok(rec, 'the op record was written');
    assert.equal(rec.status, 'failed');
    assert.ok(rec.result, 'the result is still kept');
    assert.deepEqual(rec.sent, {
      date: '2026-09-29', engine: null, source: 'dispatcher',
      loads: [{ card: 'BRIAN', loadNbr: 'DAVIS000204685', loadId: null, routeName: 'BRIAN', ordered: DELIVERIES, removed: [] }],
    });
  } finally { fake.restore(); }
});

test('nuvizz-write: an op with no loads keeps its row exactly as before — no `sent` at all', async () => {
  const fake = installFirestoreFake({}, async () => new Response(JSON.stringify({ status: 'SUCCESS' }), { status: 200 }));
  try {
    await post(writeHandler, 'http://localhost/.netlify/functions/nuvizz-write', {
      op: 'assignDriver', clientOpId: 'op-assign-1', createdBy: 'dispatcher', payload: { loadId: '6ab3f1195b97db56e47eb3c6', driverId: 7 },
    });
    const rec = opRows(fake).find((r) => r.clientOpId === 'op-assign-1');
    assert.ok(rec, 'the op record was written');
    assert.equal('sent' in rec, false);
  } finally { fake.restore(); }
});

test('nuvizz-board-sync: the write-through row names the stops it planned, not just how many', async () => {
  const fake = installFirestoreFake({
    'nuvizz_stop_index/davis__2026-09-29/stops/007183174': { stopNbr: '007183174' },
    [`nuvizz_stop_index/davis__2026-09-29/stops/${PICKUP}`]: { stopNbr: PICKUP, stopType: 'PU' },
  });
  try {
    const res = await post(syncHandler, 'http://localhost/.netlify/functions/nuvizz-board-sync', {
      date: '2026-09-29', routeName: 'BRIAN', orderedStopNbrs: ['007183174', PICKUP], unplannedStopNbrs: [],
    });
    assert.equal((await res.json()).ok, true);
    const rec = opRows(fake).find((r) => r.op === 'boardSync');
    assert.ok(rec, 'the board-sync row was written');
    assert.equal(rec.result.ordered, 2, 'the count readers already use is unchanged');
    assert.deepEqual(rec.sent, { ordered: ['007183174', PICKUP], unplanned: [] });
  } finally { fake.restore(); }
});
