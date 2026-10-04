// test/address-push-bol-recreate.test.mjs — NUVIZZ'S BOL IS RE-CREATED, NOT LOST (v1.112.2).
//
// Chad, 2026-10-03, after every one of eight corrections came back orange ("NuVizz also changed one
// other thing on the order (the BOL document) — check it in the portal"): "stop the false alarm. i
// don't even need to go back and check."
//
// Read live with 8 calls that afternoon, every order had its BOL back — the same PDF named BOL,
// type 03, under a new file id created at the second of the push. NuVizz deletes the BOL and makes
// a fresh one whenever the order is updated; our read-back, a second after the write, landed
// between the two. What this pins, each named for the failure it prevents:
//   1. A MISSING BOL ON AN ADDRESS PUSH IS GREEN — and the write log still says it happened.
//   2. ANYTHING ELSE MISSING IS STILL ORANGE — another attachment, a freight line.
//   3. ONLY A BOL — name BOL and type 03, not every PDF.
//   4. ADDRESS_BOL_RECREATE_OK=off puts the old warning back.
//   5. STILL 3 NUVIZZ CALLS — the fix reads nothing extra.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRecreatedBolIdentity, addressPushLosses, bolRecreateOk,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runSetStopAddress } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://x.test/api/v7', companyCode: 'DAVIS', auth: 'Basic x' };
// A PLUS LAUNDRY 007186222, as it stood before Chad's push on 10/03.
const BOL = { documentName: 'BOL', documentType: '03', documentCategory: '', documentExtType: 'pdf', description: '', dispositionType: '01', reference: '639398d6-c24b-4d1a-b601-7ea9ca9c445d', documentGuid: '639398d6-c24b-4d1a-b601-7ea9ca9c445d' };
const PACKING = { documentName: 'PACKING LIST', documentType: '05', documentCategory: '', documentExtType: 'pdf', description: '', dispositionType: '01', reference: 'aaa', documentGuid: 'aaa' };
const rawOrder = (documents) => ({
  stopId: '6ac0c1e2a3b4c5d6e7f80911', stopNbr: '007186222', stopType: 'DO',
  to: {
    address: { addressType: 'ANY', name: 'A PLUS LAUNDRY', addr1: 'STE 109', addr2: '7131 PEACHTREE INDUSTRIAL BLVD', city: 'PEACHTREE CORNERS', state: 'GEORGIA', zip: '30092', country: 'USA' },
    contact: { name: 'A PLUS LAUNDRY' }, documents,
  },
  from: { address: { addressType: 'COM', name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HIGHWAY', city: 'BUFORD', state: 'GEORGIA', zip: '30518' } },
  comments: [],
});
const FIX = { addr1: '7131 PEACHTREE INDUSTRIAL BLVD', addr2: 'STE 109', city: 'PEACHTREE CORNERS', state: 'GA', zip: '30092' };

/** NuVizz: stores the address it is sent, and leaves the order holding `docsAfter` — what our
 *  read-back finds a second later. */
function vendor(docsBefore, docsAfter) {
  const state = { stop: rawOrder(docsBefore) };
  const calls = [];
  return {
    calls,
    requester: {
      async request(url, opts) {
        calls.push(String(url));
        const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st });
        if (String(url).includes('/stop/info/')) return J({ Stop: { stop: state.stop, stopExecutionInfo: { stopStatus: 'PLANNED' }, load: {} } });
        if (String(url).includes('/stop/partialUpdate/')) {
          const sent = JSON.parse(opts.body).stops[0];
          state.stop = { ...state.stop, to: { ...state.stop.to, address: { ...sent.to.address, state: 'GEORGIA' }, documents: docsAfter } };
          return J({ status: 'SUCESS', apiResult: { updated: 1, failed: 0, errors: [] } });
        }
        return J({}, 404);
      },
    },
  };
}
const push = (v) => runSetStopAddress(v.requester, { stopNbr: '007186222', stopId: '6ac0c1e2a3b4c5d6e7f80911', address: FIX }, CREDS);

// ── the rule ───────────────────────────────────────────────────────────────────────────────────

test('ONLY A BOL: name BOL and type 03 — not every PDF, not a BOL-named file of another type', () => {
  assert.equal(isRecreatedBolIdentity('to|BOL|03||pdf||01'), true);
  assert.equal(isRecreatedBolIdentity('to|bol|03||pdf||01'), true, 'case aside');
  assert.equal(isRecreatedBolIdentity('to|PACKING LIST|05||pdf||01'), false);
  assert.equal(isRecreatedBolIdentity('to|BOL|07||pdf||01'), false, 'a file named BOL of another type is not NuVizz’s BOL');
  assert.equal(isRecreatedBolIdentity(''), false);
});

test('addressPushLosses sets the BOL aside and keeps every other loss', () => {
  const lines = { path: 'stopDetails', lost: ['PALLET|1|...'] };
  assert.deepEqual(addressPushLosses([{ path: 'documents', lost: ['to|BOL|03||pdf||01'] }]), { losses: [], bolRecreating: ['to|BOL|03||pdf||01'] });
  assert.deepEqual(
    addressPushLosses([{ path: 'documents', lost: ['to|BOL|03||pdf||01', 'to|PACKING LIST|05||pdf||01'] }, lines]),
    { losses: [{ path: 'documents', lost: ['to|PACKING LIST|05||pdf||01'] }, lines], bolRecreating: ['to|BOL|03||pdf||01'] },
  );
  assert.deepEqual(addressPushLosses([{ path: 'documents', lost: ['to|BOL|03||pdf||01'] }], false).losses.length, 1, 'switched off: a loss again');
});

test('ADDRESS_BOL_RECREATE_OK: default on, an off-word turns it off, a typo leaves it on', () => {
  for (const off of ['off', 'OFF', '0', 'false', 'no']) assert.equal(bolRecreateOk({ ADDRESS_BOL_RECREATE_OK: off }), false, off);
  for (const on of [undefined, '', 'on', 'of', 'nope']) assert.equal(bolRecreateOk({ ADDRESS_BOL_RECREATE_OK: on }), true, String(on));
});

// ── the push ───────────────────────────────────────────────────────────────────────────────────

test('THE EIGHT OF 10/03: the BOL gone from the read-back is a clean push — green, and the log still says so', async () => {
  const v = vendor([BOL], []);
  const r = await push(v);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.error, undefined, 'no "check it in the portal"');
  assert.deepEqual(r.bolRecreating, ['to|BOL|03||pdf||01'], 'the write log keeps it');
  assert.match(r.message, /now reads 7131 PEACHTREE INDUSTRIAL BLVD/);
  assert.deepEqual(r.calls, { reads: 2, writes: 1 }, 'still 3 NuVizz calls — nothing read again');
  assert.equal(v.calls.length, 3);
});

test('ANYTHING ELSE MISSING IS STILL ORANGE: a packing list gone is a loss, BOL gap or not', async () => {
  const r = await push(vendor([BOL, PACKING], []));
  assert.equal(r.ok, false);
  assert.equal(r.addressLanded, true, 'the address is still reported as on the order');
  assert.match(r.error, /PACKING LIST/);
  assert.doesNotMatch(r.error, /LOST to\|BOL/, 'and the BOL is not what it warns about');
  assert.deepEqual(r.bolRecreating, ['to|BOL|03||pdf||01']);
});

test('ADDRESS_BOL_RECREATE_OK=off puts the old warning back', async () => {
  process.env.ADDRESS_BOL_RECREATE_OK = 'off';
  try {
    const r = await push(vendor([BOL], []));
    assert.equal(r.ok, false);
    assert.match(r.error, /documents: LOST to\|BOL\|03\|\|pdf\|\|01/);
    assert.equal(r.bolRecreating, undefined);
  } finally { delete process.env.ADDRESS_BOL_RECREATE_OK; }
});

test('a BOL that is still there (or back under a new id) was never a loss, and is not reported as re-created', async () => {
  const r = await push(vendor([BOL], [{ ...BOL, reference: 'b61aadd8', documentGuid: 'b61aadd8' }]));
  assert.equal(r.ok, true);
  assert.equal(r.bolRecreating, undefined);
});
