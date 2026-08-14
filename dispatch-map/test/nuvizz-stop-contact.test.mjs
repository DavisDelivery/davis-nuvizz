// test/nuvizz-stop-contact.test.mjs
//
// §C — putting the customer's name + number on the ORDER in NuVizz.
//
// The CUSTOMER # block (v0.54.68) saved to our own customer_notes doc only. Chad: "does it
// write it to nuvizz?" It didn't — so the portal, the carrier's record and the driver's
// device all still showed an order with no contact on it. The two halves are complementary:
// Firestore is per-CUSTOMER (it carries onto their next order), NuVizz is per-ORDER.
//
// Everything here is the note-write's safety contract applied to a second field: echo the
// whole stop because partialUpdate is a full replace, never blank what the dispatcher didn't
// type, and prove on read-back that nothing else on the order moved.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStopContactOverride, stopContactFrom, normalizeContactPhone,
  buildPartialUpdateStop, WRITE_OPS, MUTATING_OPS,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runSetStopContact } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://portal.example.com/deliverit/openapi/v7', companyCode: 'DAVIS', authHeader: 'Basic x' };

// An Estes order that arrived with no contact at all — the case the block exists for.
const rawStop = (over = {}) => ({
  stopId: '6a63c5844524f7f7b8ab5410', stopNbr: '0828068215', stopType: 'DO',
  weight: 2477, totalPallets: 4, totalCartons: 4, sealNbr: '$163.18', proNumber: '0828068215',
  to: {
    address: { addr1: '3570 ROLLING CREEK DR', city: 'BUFORD', state: 'GA', zip: '30519' },
    schedule: { timeFrom: '2026-08-13T12:00:00', timeTo: '2026-08-13T12:30:00', timeZone: 'America/New_York' },
    documents: [{ documentName: 'BOL', documentType: '03', documentExtType: 'pdf', reference: 'guid-1' }],
  },
  from: { address: { addr1: '943 GAINESVILLE HWY', city: 'BUFORD' }, schedule: { timeFrom: '2026-08-13T08:00:00', timeTo: '2026-08-13T12:00:00' } },
  stopDetails: [{ product: 'FREIGHT', productIdentifier: '0828068215', quantity: 4, quantityUOM: 'PLT', stopDetailSeq: 1 }],
  ...over,
});

// ── pure ─────────────────────────────────────────────────────────────────────

test('normalizeContactPhone: NuVizz gets clean digits, never the UI mask', () => {
  // v0.50.29's lesson: NuVizz server-side-validates this number (it feeds the driver→customer
  // SMS) and rejects the punctuation the phone mask adds.
  assert.equal(normalizeContactPhone('(678) 860-8099'), '6788608099');
  assert.equal(normalizeContactPhone(' 678.860.8099 '), '6788608099');
  assert.equal(normalizeContactPhone('+44 20 7946 0958'), '+442079460958', 'a leading + survives');
  assert.equal(normalizeContactPhone('call the office'), '', 'no digits is not a number');
  assert.equal(normalizeContactPhone(''), '');
  assert.equal(normalizeContactPhone(null), '');
});

test('stopContactFrom: contactName wins, the legacy `name` is the fallback', () => {
  assert.deepEqual(stopContactFrom(rawStop()), { name: '', phone: '', email: '' });
  const withContact = rawStop({ to: { ...rawStop().to, contact: { contactName: 'KAI WONG', phone: '6788608099', email: 'k@x.com' } } });
  assert.deepEqual(stopContactFrom(withContact), { name: 'KAI WONG', phone: '6788608099', email: 'k@x.com' });
  const legacy = rawStop({ to: { ...rawStop().to, contact: { name: 'OLD GUY', phone: '7705551212' } } });
  assert.equal(stopContactFrom(legacy).name, 'OLD GUY');
});

test('stopContactFrom: a PICKUP reads the `from` side', () => {
  const pu = rawStop({ stopType: 'PU', from: { address: { addr1: '943 GAINESVILLE HWY' }, contact: { contactName: 'DOCK', phone: '4045551000' } } });
  assert.equal(stopContactFrom(pu).name, 'DOCK');
  assert.equal(buildStopContactOverride(pu, { phone: '4045552000' }).side, 'from');
});

test('buildStopContactOverride: writes the contact and echoes the rest of the block as read', () => {
  const { side, block } = buildStopContactOverride(rawStop(), { name: 'Kai Wong', phone: '(678) 860-8099' });
  assert.equal(side, 'to');
  assert.equal(block.contact.contactName, 'Kai Wong');
  assert.equal(block.contact.phone, '6788608099', 'digits on the wire');
  assert.deepEqual(block.address, rawStop().to.address, 'the address is echoed untouched');
  assert.deepEqual(block.schedule, rawStop().to.schedule, 'so is the delivery window');
  assert.throws(() => buildStopContactOverride({ stopType: 'DO' }, { phone: '6788608099' }), /no "to" block/);
});

test('buildStopContactOverride: a field the dispatcher left blank keeps NuVizz\'s value', () => {
  // Clearing OUR saved contact must never blank the carrier's own number on the order.
  const stop = rawStop({ to: { ...rawStop().to, contact: { contactName: 'RECEIVING', phone: '7705551212', email: 'dock@x.com' } } });
  const nameOnly = buildStopContactOverride(stop, { name: 'Kai Wong', phone: '' }).block.contact;
  assert.equal(nameOnly.contactName, 'Kai Wong');
  assert.equal(nameOnly.phone, '7705551212', 'the number we did not type is still there');
  const phoneOnly = buildStopContactOverride(stop, { name: '', phone: '6788608099' }).block.contact;
  assert.equal(phoneOnly.contactName, 'RECEIVING');
  assert.equal(phoneOnly.phone, '6788608099');
  assert.equal(phoneOnly.email, 'dock@x.com', 'email is never in this write\'s blast radius');
});

test('buildStopContactOverride: a legacy `name` is kept in step, never invented', () => {
  const legacy = rawStop({ to: { ...rawStop().to, contact: { name: 'OLD GUY', phone: '7705551212' } } });
  const c = buildStopContactOverride(legacy, { name: 'Kai Wong' }).block.contact;
  assert.equal(c.contactName, 'Kai Wong');
  assert.equal(c.name, 'Kai Wong', 'the stale legacy key cannot disagree with the one we set');
  const fresh = buildStopContactOverride(rawStop(), { name: 'Kai Wong' }).block.contact;
  assert.equal('name' in fresh, false, 'a key we never read is never added');
});

test('buildStopContactOverride: the order\'s FILES never ride a contact write', () => {
  // The override spreads the `to` we read, which carries to.documents — the strip runs last.
  const { side, block } = buildStopContactOverride(rawStop(), { phone: '6788608099' });
  const sent = buildPartialUpdateStop(rawStop(), { [side]: block });
  assert.equal(sent.to.documents, undefined);
  assert.equal(sent.stopDetails, undefined, 'nor the freight lines');
  assert.equal(sent.to.contact.phone, '6788608099');
});

test('setStopContact is registered as a mutating write op', () => {
  assert.ok(WRITE_OPS.includes('setStopContact'));
  assert.ok(MUTATING_OPS.has('setStopContact'), 'must be behind the NUVIZZ_WRITE_ENABLED gate');
});

// ── end to end through the op runner ─────────────────────────────────────────

function makeRequester({ state, writeStatus = { status: 'SUCESS', apiResult: { updated: 1, failed: 0, errors: [] } }, onWrite } = {}) {
  const calls = [];
  return {
    calls,
    requester: {
      async request(url, opts) {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
        if (url.includes('/stop/info/')) return J({ Stop: { stop: state.stop, stopExecutionInfo: {}, load: {} } });
        if (url.includes('/stop/partialUpdate/')) {
          const sent = JSON.parse(opts.body).stops[0];
          if (onWrite) onWrite(sent, state);
          else state.stop = { ...state.stop, to: { ...state.stop.to, contact: sent.to.contact } };
          return J(writeStatus);
        }
        return J({}, 404);
      },
    },
  };
}

test('runSetStopContact: writes the contact, verifies it landed, echoes the rest', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopContact(requester, { stopNbr: '0828068215', name: 'Kai Wong', phone: '(678) 860-8099' }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.now.name, 'Kai Wong');
  assert.equal(r.now.phone, '6788608099');
  const sent = JSON.parse(calls.find((c) => c.url.includes('partialUpdate')).body).stops[0];
  assert.equal(sent.to.contact.phone, '6788608099');
  assert.equal(sent.weight, 2477, 'the rest of the order is echoed as read');
  assert.equal(sent.to.documents, undefined);
  assert.equal(calls.filter((c) => c.url.includes('/stop/info/')).length, 2, 'read → write → verify');
  assert.deepEqual(r.calls, { reads: 2, writes: 1 });
});

test('runSetStopContact: an order already carrying it writes NOTHING', async () => {
  const state = { stop: rawStop({ to: { ...rawStop().to, contact: { contactName: 'KAI WONG', phone: '6788608099' } } }) };
  const { requester, calls } = makeRequester({ state });
  // Typed with the mask and in mixed case — the same contact, and NuVizz upper-cases what it stores.
  const r = await runSetStopContact(requester, { stopNbr: '0828068215', name: 'Kai Wong', phone: '(678) 860-8099' }, CREDS);
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, true);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.deepEqual(r.calls, { reads: 1, writes: 0 });
});

test('runSetStopContact: nothing to write is refused before any call', async () => {
  const { requester, calls } = makeRequester({ state: { stop: rawStop() } });
  const r = await runSetStopContact(requester, { stopNbr: '0828068215', name: '', phone: '' }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing to write/);
  assert.equal(calls.length, 0, 'a cleared contact costs zero NuVizz calls');
});

test('runSetStopContact: a "number" with no digits is refused, not written', async () => {
  const { requester, calls } = makeRequester({ state: { stop: rawStop() } });
  const r = await runSetStopContact(requester, { stopNbr: '0828068215', phone: 'call the office' }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /no digits/);
  assert.equal(calls.length, 0);
});

test('runSetStopContact: refuses the WRONG TWIN rather than write the other order', async () => {
  // Estes-0828068215: two live records share one number and /stop/info answers with either.
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopContact(
    requester,
    { stopNbr: '0828068215', phone: '6788608099', stopId: '1111111111111111ffffffff' },
    CREDS,
  );
  assert.equal(r.ok, false);
  assert.equal(r.wrongInstance, true);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing written to either twin');
});

test('runSetStopContact: NuVizz moving another field fails LOUDLY', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({
    state,
    // The write lands, but the address comes back changed — the exact shape of the disaster
    // the read-back tripwire exists to catch.
    onWrite: (sent, s) => {
      s.stop = { ...s.stop, to: { ...s.stop.to, contact: sent.to.contact, address: { ...s.stop.to.address, addr1: '1 WRONG ST' } } };
    },
  });
  const r = await runSetStopContact(requester, { stopNbr: '0828068215', phone: '6788608099' }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.contactLanded, true, 'the contact itself did land — and it still fails');
  assert.ok(r.drift.includes('to.address.addr1'), JSON.stringify(r.drift));
  assert.match(r.error, /Check 0828068215 in the portal/);
});

test('runSetStopContact: losing the freight lines fails even though we never send them', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({
    state,
    onWrite: (sent, s) => { s.stop = { ...s.stop, to: { ...s.stop.to, contact: sent.to.contact }, stopDetails: [] }; },
  });
  const r = await runSetStopContact(requester, { stopNbr: '0828068215', phone: '6788608099' }, CREDS);
  assert.equal(r.ok, false);
  assert.ok(r.drift.some((p) => p.includes('stopDetails')), JSON.stringify(r.drift));
});

test('runSetStopContact: accepted-but-not-there is a failure, not a save', async () => {
  const state = { stop: rawStop() };
  // NuVizz says SUCESS and persists nothing — the "accepted but didn't take" symptom.
  const { requester } = makeRequester({ state, onWrite: () => {} });
  const r = await runSetStopContact(requester, { stopNbr: '0828068215', phone: '6788608099' }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /still reads no contact/);
});

test('runSetStopContact: a PICKUP writes the from side, and its email is guarded there too', async () => {
  const pu = () => rawStop({
    stopType: 'PU',
    from: { address: { addr1: '943 GAINESVILLE HWY', city: 'BUFORD' }, contact: { contactName: 'DOCK', phone: '4045551000', email: 'dock@x.com' }, schedule: { timeFrom: '2026-08-13T08:00:00', timeTo: '2026-08-13T12:00:00' } },
  });
  const state = { stop: pu() };
  const { requester, calls } = makeRequester({
    state,
    onWrite: (sent, s) => { s.stop = { ...s.stop, from: { ...s.stop.from, contact: sent.from.contact } }; },
  });
  const r = await runSetStopContact(requester, { stopNbr: '0828068215', phone: '4045552000' }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.side, 'from');
  const sent = JSON.parse(calls.find((c) => c.url.includes('partialUpdate')).body).stops[0];
  assert.equal(sent.from.contact.phone, '4045552000');
  assert.equal(sent.from.contact.email, 'dock@x.com', 'the email is echoed, never touched');

  // …and if NuVizz blanks that email, the write fails rather than reporting a clean save.
  const s2 = { stop: pu() };
  const { requester: r2 } = makeRequester({
    state: s2,
    onWrite: (sent, s) => { s.stop = { ...s.stop, from: { ...s.stop.from, contact: { ...sent.from.contact, email: '' } } }; },
  });
  const bad = await runSetStopContact(r2, { stopNbr: '0828068215', phone: '4045552000' }, CREDS);
  assert.equal(bad.ok, false);
  assert.ok(bad.drift.includes('from.contact.email'), JSON.stringify(bad.drift));
});

test('runSetStopContact: a rejected write says so and never claims a save', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, writeStatus: { status: 'SOMETHING WENT WRONG!!, PLEASE TRY AGAIN' } });
  const r = await runSetStopContact(requester, { stopNbr: '0828068215', phone: '6788608099' }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /rejected the contact/);
});

// ── the read-back twin (ESTES-2938079387, Aug 14) — same rule as setStopDate ──
// The pre-read guard (v0.54.36) checks the record BEFORE writing; nothing checked the
// record the VERIFY read answered with. A twin there made the echo diff compare two
// different orders and report the differences as damage this write had done.

test('setStopContact: a twin answering the read-back is a twin verdict, never a drift list', async () => {
  const mine = rawStop();
  const state = { stop: mine };
  const twin = {
    ...rawStop(),
    stopId: '7b8c99aa11223344556677ff',
    to: { ...rawStop().to, address: { name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HIGHWAY', city: 'BUFORD', state: 'GEORGIA', zip: '30518' } },
  };
  const { requester } = makeRequester({ state, onWrite: () => { state.stop = twin; } });
  const r = await runSetStopContact(requester, { stopNbr: mine.stopNbr, phone: '6788608099', stopId: mine.stopId }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.wrongInstanceReadback, true);
  assert.equal(r.unverified, true);
  assert.equal(r.drift, undefined, 'no cross-record diff presented as changes');
  assert.match(r.error, /DIFFERENT record/i);
  assert.match(r.error, /TWO orders carry this number/i);
  assert.ok(!/partialUpdate changed/.test(r.error));
});
