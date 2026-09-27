// test/address-queue-repush-changed-address.test.mjs
//
// A RE-PUSH OF A CORRECTED ADDRESS WAS ANSWERED WITH THE OLD PUSH, AND NOTHING WENT OUT
// (audit 2026-09-27, app-A3-3).
//
// The problem-address queue sent every push for a row under one idempotency key,
// `op_queue_${row.key}` — and row.key is signal + stop number, with no address in it. The write
// ledger short-circuits any key that already succeeded. So: a no_pin row, a street fixed but the
// zip mistyped, pushed — NuVizz takes it. The geocode fails on the bad zip, the row stays no_pin
// under the same key. The dispatcher fixes the zip and presses "Save & correct NuVizz (3 calls)"
// again: the server replays the FIRST push, spends nothing, the screen says "Already pushed
// earlier", the address log records the new address as having reached NuVizz — and the driver's
// manifest keeps the bad zip.
//
// The replay exists for one case: a re-press of the SAME correction must not re-fire it. So the
// key now carries the address being sent — same address, same key, free replay; a different
// address, a different key, and it goes out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFirestoreFake } from './_firestore-fake.mjs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}
const queueClientOpId = (() => {
  // eslint-disable-next-line no-new-func
  try { return new Function(`'use strict';\n${fnSource('queueClientOpId')}\nreturn queueClientOpId;`)(); } catch { return null; }
})();

const ROW = { key: 'no_pin__007174397', signal: 'no_pin', stopNbr: '007174397', stopId: '999' };
const FIRST = { addr1: '200 NEW RD', addr2: '', city: 'BUFORD', state: 'GA', zip: '30581' };   // zip mistyped
const FIXED = { ...FIRST, zip: '30518' };

test('pressing Save & correct NuVizz again with the SAME address replays the first push for free', () => {
  assert.equal(typeof queueClientOpId, 'function', 'queueClientOpId must exist in App.jsx');
  assert.equal(queueClientOpId(ROW, FIRST), queueClientOpId(ROW, { ...FIRST }));
  assert.match(queueClientOpId(ROW, FIRST), /^op_queue_no_pin__007174397_/, 'still names the row, for the write log');
});

test('a corrected zip on the same row is a NEW push, not a replay of the one with the typo', () => {
  assert.equal(typeof queueClientOpId, 'function', 'queueClientOpId must exist in App.jsx');
  assert.notEqual(queueClientOpId(ROW, FIRST), queueClientOpId(ROW, FIXED));
});

test('moving text between the street and suite lines is a different address too', () => {
  // The mis-split fix IS moving text between the two lines; a key that joined them would call
  // "1 MAIN ST, STE 2" in the street box the same correction as the proper split.
  assert.equal(typeof queueClientOpId, 'function', 'queueClientOpId must exist in App.jsx');
  const a = queueClientOpId(ROW, { addr1: '1 MAIN ST, STE 2', addr2: '', city: 'BUFORD', state: 'GA', zip: '30518' });
  const b = queueClientOpId(ROW, { addr1: '1 MAIN ST', addr2: 'STE 2', city: 'BUFORD', state: 'GA', zip: '30518' });
  assert.notEqual(a, b);
});

test('both queue buttons key the push on the address they actually send', () => {
  const run = fnSource('useQueuePush');
  assert.match(run, /fields: correctedFields\(row\)[\s\S]{0,200}?clientOpId: queueClientOpId\(row, correctedFields\(row\)\)/, 'the group run');
  const edit = fnSource('useQueueRowEdit');
  assert.match(edit, /fields: f,[\s\S]{0,120}?clientOpId: queueClientOpId\(row, f\)/, 'the single-row editor');
  assert.doesNotMatch(APP, /clientOpId: `op_queue_\$\{row\.key\}`/, 'no call site keeps the per-row key');
});

test('END TO END against the real write endpoint: the corrected re-push gets past the ledger; the same one is replayed', async () => {
  assert.equal(typeof queueClientOpId, 'function', 'queueClientOpId must exist in App.jsx');
  const keep = { ...process.env };
  Object.assign(process.env, {
    NUVIZZ_WRITE_ENABLED: 'true', NUVIZZ_DAVIS_USER: 'u', NUVIZZ_DAVIS_PASS: 'p',
    // Refuse at step 4b, which sits AFTER the idempotency ledger and BEFORE any NuVizz call —
    // so "got past the ledger" is observable here without a single vendor request.
    NUVIZZ_PERSONAL_LOGINS: 'required',
  });
  delete process.env.AUTH_REQUIRED;
  const vendor = [];
  const fake = installFirestoreFake({}, (url) => { vendor.push(String(url)); throw new Error(`NON-FIRESTORE CALL: ${url}`); });
  try {
    const { putOpRecord } = await import('../netlify/functions/lib/write-registries.mts');
    const { default: handler } = await import('../netlify/functions/nuvizz-write.mts');
    await putOpRecord({ clientOpId: queueClientOpId(ROW, FIRST), op: 'setStopAddress', status: 'succeeded', tenant: 'DAVIS', at: '2026-09-27T13:00:00Z',
      result: { ok: true, addressLanded: true, now: '200 NEW RD, BUFORD, GA 30581' } });
    const post = async (fields) => (await handler(new Request('https://x/.netlify/functions/nuvizz-write', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'setStopAddress', dryRun: false, clientOpId: queueClientOpId(ROW, fields),
        payload: { stopNbr: ROW.stopNbr, stopId: ROW.stopId, address: fields } }),
    }))).json();

    const again = await post(FIRST);
    assert.equal(again.idempotent, true, 'the same correction is replayed');
    const fixed = await post(FIXED);
    assert.notEqual(fixed.idempotent, true, 'the corrected zip is NOT answered with the typo’s result');
    assert.equal(fixed.identity?.as, 'refused', 'it reached the step after the ledger');
    assert.deepEqual(vendor, [], 'and no NuVizz call was made by this test');
  } finally {
    fake.restore();
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});
