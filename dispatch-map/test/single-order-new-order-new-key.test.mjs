// test/single-order-new-order-new-key.test.mjs
//
// SINGLE NEW ORDER SENT A DIFFERENT ORDER UNDER THE LOST ONE'S KEY (review 2026-09-03, A2-S9-10).
//
// Single New Order mints one clientOpId per ORDER so a retry after a lost answer is replayed by
// the server's ledger instead of creating the order twice. The key was renewed only on a
// confirmed success — so after a lost answer, the NEXT order typed into the form went out under
// the SAME key. When the lost create had in fact landed, the server replayed ITS result: the new
// order was never created, and the form announced "✓ Order created — <the old number>" for the
// new form's contents. The replay flag (`idempotent`) was never read.
//
// These RUN the real submit out of NewOrderSingleScreen against a stand-in server that keeps an
// op ledger the way nuvizz-write.mts does (a succeeded key replays with idempotent: true).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { singleOrderOpId, singleOrderCreatedMsg } from '../src/lib/single-order-op.js';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const comp = APP.indexOf('function NewOrderSingleScreen(');
const from = APP.indexOf('  const opIdRef = useRef(', comp);
const submitAt = APP.indexOf('  const submit = async () => {', from);
const to = APP.indexOf('\n  };\n', submitAt);
assert.ok(comp > 0 && from > comp && submitAt > from && to > submitAt, 'the submit is where it was');
const SUBMIT = APP.slice(from, to + 5);

const ROW = (name, addr1) => ({ name, addr1, addr2: '', city: 'ATLANTA', state: 'GA', zip: '30318', stopNbr: '', pro: '', itemDesc: '', pallets: '1', loose: '', weight: '', price: '', phone: '', email: '', dispatchNotes: '' });

/** A server with an op ledger, whose NEXT answer can be lost after the order is created. */
function server() {
  const ledger = new Map();
  const created = [];
  let loseNext = false;
  let mints = 0;
  return {
    created,
    loseNextAnswer: () => { loseNext = true; },
    newClientOpId: () => `op-${++mints}`,
    async callWrite(op, payload, { clientOpId }) {
      const prior = ledger.get(clientOpId);
      if (prior) return { ok: true, idempotent: true, result: prior };
      created.push(payload.row.name);
      const result = { ok: true, entityNbr: `0071${String(created.length).padStart(6, '0')}` };
      ledger.set(clientOpId, result);
      if (loseNext) { loseNext = false; throw new Error('network error'); }
      return { ok: true, result };
    },
  };
}

function form(srv) {
  let result = null;
  // The body runs ONCE: opIdRef lives as long as the form, exactly as a React ref does, and the
  // submit reads the row the dispatcher has typed at the moment it is pressed.
  // eslint-disable-next-line no-new-func
  const make = new Function('useRef', 'newClientOpId', 'callWrite', 'setResult', 'singleOrderOpId', 'singleOrderCreatedMsg',
    'labelOrderFromCreate', 'saveOrderLabels', 'setBusy', 'setListRefresh', 'persistOrigin', 'EMPTY_ORDER_ROW',
    `'use strict';
     const origin = { name: 'DAVIS DELIVERY', addr1: '1 DOCK RD', city: 'BUFORD', state: 'GA', zip: '30518' };
     const serviceDate = '2026-09-28';
     const canSubmit = true;
     let row = null;
     const setRow = (v) => { row = typeof v === 'function' ? v(row) : v; };
     ${SUBMIT}
     return { type: (r) => { row = r; }, submit };`);
  const body = make((v) => ({ current: v }), srv.newClientOpId, srv.callWrite.bind(srv), (v) => { result = v; },
    singleOrderOpId, singleOrderCreatedMsg, () => null, async () => ({ ok: true }), () => {}, () => {}, () => {}, ROW('', ''));
  return {
    type: body.type,
    async submit() { await body.submit(); return result; },
    get result() { return result; },
  };
}

test('a lost answer, then a DIFFERENT order typed and created — that order is created, not replayed as the old one', async () => {
  const srv = server();
  const f = form(srv);
  f.type(ROW('ACME SUPPLY', '100 MAIN ST'));
  srv.loseNextAnswer();
  await f.submit();
  assert.equal(f.result.ok, false, 'the lost answer reads as a failure on the form');
  f.type(ROW('BETA FOODS', '200 PINE ST'));   // the dispatcher moves on to the next order
  await f.submit();
  assert.deepEqual(srv.created, ['ACME SUPPLY', 'BETA FOODS'], 'BETA FOODS reached NuVizz');
  assert.match(f.result.msg, /0071000002/, 'and the form names BETA\'s number, not ACME\'s');
});

test('the SAME order sent again after a lost answer is not created twice — and the form says it was the earlier try', async () => {
  const srv = server();
  const f = form(srv);
  f.type(ROW('ACME SUPPLY', '100 MAIN ST'));
  srv.loseNextAnswer();
  await f.submit();
  f.type(ROW('ACME SUPPLY', '100 MAIN ST'));
  await f.submit();
  assert.deepEqual(srv.created, ['ACME SUPPLY'], 'one order in NuVizz');
  assert.equal(f.result.ok, true);
  assert.match(f.result.msg, /already created by an earlier try/);
  assert.doesNotMatch(f.result.msg, /Order created —/, 'a replay is never announced as a fresh create');
});

test('two orders in a row, both answered, each go out under their own key', async () => {
  const srv = server();
  const f = form(srv);
  f.type(ROW('ACME SUPPLY', '100 MAIN ST'));
  await f.submit();
  f.type(ROW('ACME SUPPLY', '100 MAIN ST'));   // the same consignee again on purpose — a second order
  await f.submit();
  assert.deepEqual(srv.created, ['ACME SUPPLY', 'ACME SUPPLY']);
  assert.match(f.result.msg, /Order created — 0071000002/);
});

test('the key rule, on its own: same request keeps the key, a changed one gets a new key', () => {
  let n = 0;
  const mint = () => `k${++n}`;
  const a = { row: { name: 'ACME' }, settings: { serviceDate: '2026-09-28' } };
  const first = singleOrderOpId({ id: 'k0', sent: null }, a, mint);
  assert.equal(first.id, 'k0', 'the key minted when the form opened is used first');
  assert.equal(singleOrderOpId(first, a, mint).id, 'k0', 'a retry of the same request replays');
  assert.equal(singleOrderOpId(first, { ...a, row: { name: 'BETA' } }, mint).id, 'k1', 'a different order is a new request');
  assert.equal(singleOrderOpId(first, { ...a, settings: { serviceDate: '2026-09-29' } }, mint).id, 'k2', 'so is a different day');
  assert.equal(singleOrderOpId(null, a, mint).id, 'k3', 'no key yet — one is minted');
});
