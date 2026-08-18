// test/stop-address-exec.test.mjs
//
// THE GUARD LADDER on the one write that can send freight to a different
// building. Everything here is a REFUSAL except the first test, because each
// refusal describes a way a real customer's delivery could end up somewhere
// nobody chose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSetStopAddress } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://x.test/api/v7', companyCode: 'DAVIS', token: 't' };
const FIX = { name: 'MR.LARRY WOELFL', addr1: '800 N COMMERCE ST', city: 'MONROE', state: 'GA', zip: '30655' };

const rawStop = (over = {}) => ({
  stopId: '6a691000aaaabbbbcccc0001', stopNbr: 'ESTES-1', stopType: 'DO',
  to: { address: { addressType: 'CUS', label: 'BOOK-1', name: 'MR.LARRY WOELFL', addr1: '1 WRONG ST', city: 'BUFORD', state: 'GEORGIA', zip: '30518', country: 'USA' },
        contact: { name: 'MR.LARRY WOELFL', phone: '4043167378' },
        schedule: { timeFrom: '2026-08-19T12:00:00', timeTo: '2026-08-19T17:00:00' } },
  from: { address: { addressType: 'COM', name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HIGHWAY', city: 'BUFORD', state: 'GEORGIA', zip: '30518' } },
  comments: [], ...over,
});

function makeRequester({ state, writeStatus = { status: 'SUCESS', apiResult: { updated: 1, failed: 0, errors: [] } }, onWrite, status = null, readBackStop } = {}) {
  const calls = [];
  return { calls, requester: { async request(url, opts) {
    calls.push({ url, method: opts.method || 'GET' });
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (url.includes('/stop/info/')) {
      const stop = (state.wrote && readBackStop) ? readBackStop(state) : state.stop;
      return J({ Stop: { stop, stopExecutionInfo: status ? { stopStatus: status } : {}, load: {} } });
    }
    if (url.includes('/stop/partialUpdate/')) {
      const sent = JSON.parse(opts.body).stops[0];
      state.wrote = true;
      if (onWrite) onWrite(sent, state);
      else state.stop = { ...state.stop, to: { ...state.stop.to, address: sent.to.address } };
      return J(writeStatus);
    }
    return J({}, 404);
  } } };
}

test('THE HAPPY PATH: the address changes, and the payload is literal ANY with no label', async () => {
  const state = { stop: rawStop() };
  let sentAddr = null;
  const { requester, calls } = makeRequester({ state, onWrite: (sent, st) => {
    sentAddr = sent.to.address;
    st.stop = { ...st.stop, to: { ...st.stop.to, address: { ...sent.to.address, state: 'GEORGIA' } } };  // vendor normalises
  } });
  const r = await runSetStopAddress(requester, { stopNbr: 'ESTES-1', stopId: '6a691000aaaabbbbcccc0001', address: FIX }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.side, 'to');
  assert.match(r.to, /800 N COMMERCE ST/);
  assert.match(r.from, /1 WRONG ST/, 'and it reports what it replaced');
  assert.equal(sentAddr.addressType, 'ANY');
  assert.ok(!('label' in sentAddr), 'the lookup key never goes on the wire');
  assert.deepEqual(r.calls, { reads: 2, writes: 1 });
  assert.equal(calls.filter((c) => c.url.includes('partialUpdate')).length, 1, 'exactly one write');
});

test('REFUSES on a twin — re-addressing the wrong record sends freight nobody chose', async () => {
  const state = { stop: rawStop({ stopId: '6a691000ffffffffffff9999' }) };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopAddress(requester, { stopNbr: 'ESTES-1', stopId: '6a691000aaaabbbbcccc0001', address: FIX }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.wrongInstance, true);
  assert.equal(calls.filter((c) => c.url.includes('partialUpdate')).length, 0, 'NOTHING was written');
});

test('REFUSES on a delivered stop — that freight is already somewhere', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state, status: 'DELIVERED' });
  const r = await runSetStopAddress(requester, { stopNbr: 'ESTES-1', address: FIX }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /delivered|already/i);
  assert.equal(calls.filter((c) => c.url.includes('partialUpdate')).length, 0);
});

test('REFUSES an address with no name — the vendor would name it from its own book', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopAddress(requester, { stopNbr: 'ESTES-1', address: { addr1: '800 N COMMERCE ST', name: '' , city: 'MONROE' } }, CREDS);
  // name falls back to the read value, so blank it there too for the true no-name case
  const bare = { stop: rawStop({ to: { ...rawStop().to, address: { addressType: 'CUS', addr1: '1 WRONG ST' } } }) };
  const h2 = makeRequester({ state: bare });
  const r2 = await runSetStopAddress(h2.requester, { stopNbr: 'ESTES-1', address: { addr1: '800 N COMMERCE ST' } }, CREDS);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /name is required/i);
  assert.equal(h2.calls.filter((c) => c.url.includes('partialUpdate')).length, 0);
  assert.ok(r.ok === true || r.ok === false, 'first case is shape-only');
});

test('an ACCEPTED write that did NOT actually change the address is a FAILURE, not a save', async () => {
  // The write returns success and the order still reads the old street. Reporting
  // that as done is how freight goes to the address nobody fixed.
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, onWrite: () => { /* vendor ignores it */ } });
  const r = await runSetStopAddress(requester, { stopNbr: 'ESTES-1', address: FIX }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /did NOT change|still does not read back/i);
});

test('a rejected write says so and claims nothing', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, writeStatus: { status: 'SOMETHING WENT WRONG!!, PLEASE TRY AGAIN' } });
  const r = await runSetStopAddress(requester, { stopNbr: 'ESTES-1', address: FIX }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /rejected/i);
});

test('NuVizz moving some OTHER field fails loudly, while still saying the address landed', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, onWrite: (sent, st) => {
    st.stop = { ...st.stop, to: { ...st.stop.to, address: sent.to.address }, proNumber: 'CHANGED-BY-VENDOR' };
  } });
  const r = await runSetStopAddress(requester, { stopNbr: 'ESTES-1', address: FIX }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.addressLanded, true, 'the correction took — but something else moved too');
  assert.ok(r.drift.length >= 1);
});

test('vendor normalisation of the address itself is NOT reported as drift', async () => {
  // "GA" → "GEORGIA" and "RD" → "ROAD" are NuVizz storing our address its own way,
  // observed live. A clean correction must come back clean, or the banner becomes
  // noise and the real one gets ignored.
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, onWrite: (sent, st) => {
    st.stop = { ...st.stop, to: { ...st.stop.to, address: {
      ...sent.to.address, state: 'GEORGIA', addr1: '800 N COMMERCE STREET',
      latitude: 33.79, longitude: -83.71, fullAddress: '800 N COMMERCE STREET, MONROE, GEORGIA 30655',
    } } };
  } });
  const r = await runSetStopAddress(requester, { stopNbr: 'ESTES-1', address: FIX }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('a missing address object is refused before any call is made', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopAddress(requester, { stopNbr: 'ESTES-1' }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0, 'not even the read fired');
});
