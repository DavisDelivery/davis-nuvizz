// test/address-history-wiring.test.mjs — the log is WIRED, not just correct.
//
// address-history.test.mjs pins the classification rules. This pins the thing that actually
// failed on 2026-09-11: the scan HAD the change in its hands (refresh-stops-core computes
// `reconsigned` to decide whether to re-enrich) and wrote nothing down. A pure classifier
// nobody calls would reproduce that exactly, so these tests run the real write path against
// the in-memory Firestore fake and assert the ledger document afterwards.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const BASE = 'nuvizz_stop_index/davis__2026-09-10';
const AT = '2026-09-10T11:13:18.479Z';

const stop = (over = {}) => ({
  stopNbr: '007174397', businessName: 'LED ENERGY PLUS',
  addr1: '5965 PEACHTREE CORS E STE B3', addr2: null, city: 'NORCROSS', state: 'GA', zip: '30071',
  isPlanned: true, routeName: 'NOR 2', lat: 33.93537, lng: -84.21601, ...over,
});

/** Seed one stored stop, write a fresh one over it, hand back the ledger rows. */
async function writeAndRead(existingStop, freshStop, envPatch = {}) {
  const prevEnv = { ...process.env };
  Object.assign(process.env, envPatch);
  const fake = installFirestoreFake({ [`${BASE}/stops/${existingStop.stopNbr}`]: existingStop });
  try {
    const { writeStops, readAddressChanges } = await import('../netlify/functions/lib/firestore.mts');
    await writeStops('davis', '2026-09-10', [freshStop], AT, { includeUnplanned: true, includeLoads: true });
    return { rows: await readAddressChanges('davis', '2026-09-10'), fake };
  } finally {
    fake.restore();
    for (const k of Object.keys(envPatch)) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  }
}

test('the scan writing a changed address leaves a row behind — the thing that did not happen for 007174397', async () => {
  const { rows } = await writeAndRead(stop(), stop({ addr1: '5965 PEACHTREE STREET' }));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.stopNbr, '007174397');
  assert.equal(r.kind, 'renamed');
  assert.equal(r.source, 'scan');
  assert.equal(r.at, AT);
  assert.equal(r.date, '2026-09-10');
  assert.equal(r.before.addr1, '5965 PEACHTREE CORS E STE B3');
  assert.equal(r.after.addr1, '5965 PEACHTREE STREET');
  // The two facts that decide how urgent this is: it was already built onto a truck.
  assert.equal(r.route, 'NOR 2');
  assert.equal(r.planned, true);
});

test('an unchanged address writes NO ledger document at all — a quiet day costs nothing', async () => {
  const { rows, fake } = await writeAndRead(stop(), stop());
  assert.equal(rows.length, 0);
  const wrote = fake.log.sets.some((s) => s.path.includes('addr_changes__'));
  assert.equal(wrote, false, 'no address-log document should be written when nothing moved');
});

test('a brand-new stop is not a change — there is nothing it changed FROM', async () => {
  const prevEnv = process.env.ADDRESS_HISTORY;
  const fake = installFirestoreFake({});           // nothing stored: first sighting
  try {
    const { writeStops, readAddressChanges } = await import('../netlify/functions/lib/firestore.mts');
    await writeStops('davis', '2026-09-10', [stop()], AT, { includeUnplanned: true, includeLoads: true });
    assert.deepEqual(await readAddressChanges('davis', '2026-09-10'), []);
  } finally { fake.restore(); if (prevEnv === undefined) delete process.env.ADDRESS_HISTORY; }
});

test('the house number moving is recorded as MOVED, the class that strands a loaded truck', async () => {
  const { rows } = await writeAndRead(stop(), stop({ addr1: '5975 PEACHTREE CORS E STE B3' }));
  assert.equal(rows[0].kind, 'moved');
  assert.deepEqual(rows[0].fields, ['addr1']);
});

test('re-observing the SAME change does not file it twice', async () => {
  // A scan that records a change and then fails to write the stop would otherwise re-file the
  // identical row every fifteen minutes until it succeeded.
  const fake = installFirestoreFake({ [`${BASE}/stops/007174397`]: stop() });
  try {
    const { writeStops, readAddressChanges } = await import('../netlify/functions/lib/firestore.mts');
    const fresh = stop({ addr1: '5965 PEACHTREE STREET' });
    await writeStops('davis', '2026-09-10', [fresh], AT, { includeUnplanned: true, includeLoads: true });
    // Put the OLD row back, exactly as a failed write would leave it, and scan again.
    fake.store.set(`${BASE}/stops/007174397`, stop());
    await writeStops('davis', '2026-09-10', [fresh], '2026-09-10T11:28:00.000Z', { includeUnplanned: true, includeLoads: true });
    assert.equal((await readAddressChanges('davis', '2026-09-10')).length, 1);
  } finally { fake.restore(); }
});

test('ADDRESS_HISTORY=off stops the recording dead, and the write itself is untouched', async () => {
  const { rows, fake } = await writeAndRead(stop(), stop({ addr1: '5965 PEACHTREE STREET' }), { ADDRESS_HISTORY: 'off' });
  assert.equal(rows.length, 0);
  // The stop still landed — the switch turns off the LOG, not the board.
  const written = fake.log.sets.find((s) => s.path === `${BASE}/stops/007174397`);
  assert.ok(written, 'the stop must still be written with the log switched off');
  assert.equal(written.doc.addr1, '5965 PEACHTREE STREET');
});

test('a thrown logger never breaks the scan — the board is written either way', async () => {
  const fake = installFirestoreFake({ [`${BASE}/stops/007174397`]: stop() });
  try {
    const fs = await import('../netlify/functions/lib/firestore.mts');
    // A row shaped so the classifier is handed something hostile; the write must still land.
    const hostile = stop({ addr1: { toString() { throw new Error('boom'); } } });
    await fs.writeStops('davis', '2026-09-10', [hostile], AT, { includeUnplanned: true, includeLoads: true });
    assert.ok(fake.log.sets.some((s) => s.path === `${BASE}/stops/007174397`), 'the stop must still be written');
  } finally { fake.restore(); }
});

test('the endpoint reports zero NuVizz calls and refuses to pretend when switched off', async () => {
  const fake = installFirestoreFake({});
  const prev = process.env.ADDRESS_HISTORY;
  try {
    const handler = (await import('../netlify/functions/address-history.mts')).default;
    const url = 'https://x.netlify.app/.netlify/functions/address-history?days=2';

    process.env.ADDRESS_HISTORY = 'off';
    const offBody = await (await handler(new Request(url))).json();
    assert.equal(offBody.ok, false);
    assert.equal(offBody.disabled, true);

    delete process.env.ADDRESS_HISTORY;
    const onBody = await (await handler(new Request(url))).json();
    assert.equal(onBody.ok, true);
    assert.equal(onBody.nuvizzCalls, 0);
    assert.equal(onBody.summary.total, 0);
    assert.equal(fake.log.other.length, 0, 'no non-Firestore call may be made');
  } finally { fake.restore(); if (prev === undefined) delete process.env.ADDRESS_HISTORY; else process.env.ADDRESS_HISTORY = prev; }
});

test('the summary counts what is being WITHHELD, not just what is shown', async () => {
  // The default view hides formatting rows. A summary computed through that filter reported
  // formatting:0 always — so the checkbox read "Show formatting-only changes (0)" on a day
  // with rows sitting right behind it, and the empty state said "nothing was recorded at all"
  // when something was. A screen that cannot say what it is withholding is worse than one
  // that withholds nothing.
  const fake = installFirestoreFake({});
  try {
    const { recordAddressChanges } = await import('../netlify/functions/lib/firestore.mts');
    const { buildAddressChangeRow } = await import('../netlify/functions/lib/address-history.mts');
    const today = (await import('../netlify/functions/lib/firestore.mts')).etDayString();
    const row = buildAddressChangeRow({
      at: new Date().toISOString(), date: today, stopNbr: '007174397', source: 'scan',
      // A suite migrating between the two lines: real text, no freight moved → formatting.
      before: { addr1: '100 MAIN ST STE 4', addr2: null, city: 'BUFORD', zip: '30518' },
      after: { addr1: '100 MAIN ST', addr2: 'STE 4', city: 'BUFORD', zip: '30518' },
    });
    assert.equal(row.kind, 'formatting');
    await recordAddressChanges('davis', today, [row]);

    const handler = (await import('../netlify/functions/address-history.mts')).default;
    const body = await (await handler(new Request('https://x.netlify.app/.netlify/functions/address-history?days=1'))).json();
    assert.equal(body.rows.length, 0, 'the row itself stays hidden by default');
    assert.equal(body.summary.formatting, 1, 'but the screen is told it is there');
  } finally { fake.restore(); }
});

test('POST records a dispatcher override, and refuses to let a caller forge a scan row', async () => {
  const fake = installFirestoreFake({});
  try {
    const handler = (await import('../netlify/functions/address-history.mts')).default;
    const { readAddressChanges } = await import('../netlify/functions/lib/firestore.mts');
    const post = (body) => handler(new Request('https://x.netlify.app/.netlify/functions/address-history', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));

    const forged = await (await post({ source: 'scan', stopNbr: '1', date: '2026-09-10', before: { addr1: 'A ST' }, after: { addr1: 'B ST' } })).json();
    assert.equal(forged.ok, false);

    const ok = await (await post({
      source: 'override', stopNbr: '007174397', date: '2026-09-10',
      businessName: 'LED ENERGY PLUS', matchKey: 'led_energy_plus__5965_peachtree_st__norcross__30071',
      before: { addr1: '5965 PEACHTREE STREET', city: 'NORCROSS', zip: '30071' },
      after: { addr1: '5965 PEACHTREE CORS E STE B3', city: 'NORCROSS', zip: '30071' },
    })).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.recorded, true);
    assert.equal(ok.row.source, 'override');
    assert.equal(ok.row.kind, 'renamed');

    const rows = await readAddressChanges('davis', '2026-09-10');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].matchKey, 'led_energy_plus__5965_peachtree_st__norcross__30071');
  } finally { fake.restore(); }
});

test('saving the address that was already there records nothing and is still a success', async () => {
  const fake = installFirestoreFake({});
  try {
    const handler = (await import('../netlify/functions/address-history.mts')).default;
    const body = await (await handler(new Request('https://x.netlify.app/.netlify/functions/address-history', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'override', stopNbr: '007174397', date: '2026-09-10',
        before: { addr1: '5965 PEACHTREE STREET' }, after: { addr1: '5965 Peachtree Street' },
      }),
    }))).json();
    assert.equal(body.ok, true);
    assert.equal(body.recorded, false);
  } finally { fake.restore(); }
});
