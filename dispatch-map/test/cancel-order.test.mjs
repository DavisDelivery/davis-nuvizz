// test/cancel-order.test.mjs
//
// ── CANCELLING AN ORDER ──────────────────────────────────────────────────────
//
// Chad: "I think we need to write a path to canceling orders and reason should
// be admin." Until v0.54.86 this app could CREATE an order and never take one
// back — a mistyped order, or the ZZTEST order the address-rewrite
// investigation left behind, could only be killed in the NuVizz portal.
//
// This is the one write in the app with NO undo. Every test here exists because
// the failure it describes would destroy a real customer's order:
//   • cancel the wrong twin           → someone else's freight disappears
//   • cancel by number, not by id     → same thing, one step earlier
//   • cancel a planned/delivered stop → history rewritten, or a bare vendor error
// The refusals are the feature. The successful cancel is one test; the rest are
// all the ways it must decline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCancelStopBody, buildOpRequest, CANCEL_REASON_DEFAULT } from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runCancelOrder } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://portal.example.com/deliverit/openapi/v7', companyCode: 'DAVIS', authHeader: 'Basic x' };

// ── the body on the wire ────────────────────────────────────────────────────

test('reason defaults to ADMIN — the value Chad specified', () => {
  assert.equal(CANCEL_REASON_DEFAULT, 'ADMIN');
  assert.equal(buildCancelStopBody({ stopId: 'abc123' }).reasonCode, 'ADMIN');
  assert.equal(buildCancelStopBody({ stopId: 'abc123', reasonCode: 'DUPE' }).reasonCode, 'DUPE');
  // The vendor caps reasonCode at 10 characters; a longer one would reject the whole call.
  assert.equal(buildCancelStopBody({ stopId: 'a', reasonCode: 'X'.repeat(40) }).reasonCode.length, 10);
});

test('ONE identifier goes on the wire, and the id always wins', () => {
  // Sending both invites NuVizz to resolve a disagreement between them. On a
  // destructive call that choice is not ours to hand over.
  const both = buildCancelStopBody({ stopId: 'abc123', stopNbr: 'ESTES-1' });
  assert.equal(both.stopId, 'abc123');
  assert.ok(!('stopNbr' in both), 'the number must not ride along beside the id');
  // Number-only is still accepted by the builder — the EXECUTOR is what refuses it.
  assert.equal(buildCancelStopBody({ stopNbr: 'ESTES-1' }).stopNbr, 'ESTES-1');
});

test('an identifier is mandatory', () => {
  assert.throws(() => buildCancelStopBody({}), /stopId or stopNbr is required/);
  assert.throws(() => buildCancelStopBody({ stopId: '   ', stopNbr: '' }), /required/);
});

test('comments are optional and capped', () => {
  assert.ok(!('reasonComments' in buildCancelStopBody({ stopId: 'a' })));
  assert.equal(buildCancelStopBody({ stopId: 'a', reasonComments: 'test order' }).reasonComments, 'test order');
  assert.equal(buildCancelStopBody({ stopId: 'a', reasonComments: 'y'.repeat(900) }).reasonComments.length, 500);
});

test('the request targets the vendor cancel endpoint', () => {
  const r = buildOpRequest('cancelStop', { stopId: 'abc123' }, CREDS);
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://portal.example.com/deliverit/openapi/v7/stop/cancel/DAVIS');
  assert.equal(r.meta.route, '/stop/cancel');
  assert.deepEqual(JSON.parse(r.body), { stopId: 'abc123', reasonCode: 'ADMIN' });
});

// ── the ladder ──────────────────────────────────────────────────────────────

const ID = '6a837b364569d2cf97d8e609';

// Stubs at the HTTP layer, exactly like test/nuvizz-stop-date.test.mjs — the
// executor talks to a requester object, not to op names.
const RAW = () => ({
  stopId: ID, stopNbr: 'ZZTEST0817', stopType: 'DO',
  to: {
    address: { name: 'ZZ TEST', addr1: '1180 PEACHTREE ST NE', city: 'ATLANTA', state: 'GA', zip: '30309' },
    schedule: { timeFrom: '2026-12-31T12:00:00', timeTo: '2026-12-31T17:00:00', timeZone: 'America/New_York' },
  },
  from: { address: { addr1: '943 GAINESVILLE HWY', city: 'BUFORD' }, schedule: { timeFrom: '2026-12-31T08:00:00', timeTo: '2026-12-31T12:00:00' } },
});

function world({ stop = RAW(), status = null, load = null, readStatus = 200,
                 cancelBody = { status: 'SUCESS', apiResult: { updated: 1, failed: 0, errors: [] } },
                 cancelStatus = 200 } = {}) {
  const calls = [];
  return {
    calls,
    requester: {
      async request(url, opts) {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st });
        if (url.includes('/stop/info/')) {
          if (readStatus !== 200) return J({}, readStatus);
          return J({ Stop: { stop, stopExecutionInfo: status ? { stopStatus: status } : {}, load: load || {} } });
        }
        if (url.includes('/stop/cancel/')) return J(cancelBody, cancelStatus);
        return J({}, 404);
      },
    },
  };
}

test('the happy path: reads first, then cancels BY ID, and records what it destroyed', async () => {
  const { requester, calls } = world();
  const out = await runCancelOrder(requester, { stopNbr: 'ZZTEST0817' }, CREDS);
  assert.equal(out.ok, true);
  assert.deepEqual(out.calls, { reads: 1, writes: 1 });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('/stop/info/'), 'reads first');
  assert.ok(calls[1].url.includes('/stop/cancel/'), 'then cancels');
  // BY ID, never by number.
  const sent = JSON.parse(calls[1].body);
  assert.equal(sent.stopId, ID);
  assert.ok(!('stopNbr' in sent), 'never by number');
  // The before-image is the record of what no longer exists.
  assert.equal(out.cancelled.consignee, 'ZZ TEST');
  assert.match(out.cancelled.address, /1180 PEACHTREE ST NE, ATLANTA, GA, 30309/);
  assert.equal(out.cancelled.stopId, ID);
  assert.equal(out.reasonCode, 'ADMIN');
});

test('A TWIN IS REFUSED — nothing is cancelled', async () => {
  // The one failure with no undo: two orders share a number and we kill the
  // wrong customer's freight.
  const { requester, calls } = world();
  const out = await runCancelOrder(requester, { stopNbr: 'ZZTEST0817', stopId: 'ffffffffffffffffffffffff' }, CREDS);
  assert.equal(out.ok, false);
  assert.equal(out.wrongInstance, true);
  assert.equal(out.calls.writes, 0, 'NOTHING was written');
  assert.equal(calls.length, 1, 'the read happened and nothing else did');
});

test('a record with no stopId is refused rather than cancelled by number', async () => {
  const { requester, calls } = world({ stop: { ...RAW(), stopId: undefined } });
  const out = await runCancelOrder(requester, { stopNbr: 'ZZTEST0817' }, CREDS);
  assert.equal(out.ok, false);
  assert.match(out.error, /refusing to cancel by number/);
  assert.equal(out.calls.writes, 0);
  assert.equal(calls.length, 1, 'the read happened and nothing else did');
});

test('a DELIVERED stop cannot be cancelled', async () => {
  const { requester } = world({ status: 'DELIVERED' });
  const out = await runCancelOrder(requester, { stopNbr: 'ZZTEST0817' }, CREDS);
  assert.equal(out.ok, false);
  assert.match(out.error, /cannot be cancelled/);
  assert.equal(out.calls.writes, 0);
});

test('a stop PLANNED on a load says which load to unplan it from', async () => {
  // NuVizz only cancels unplanned/created stops, so say so in words rather than
  // letting the vendor return a bare failure.
  const { requester } = world({ load: { loadNbr: 'DAVIS000198197' } });
  const out = await runCancelOrder(requester, { stopNbr: 'ZZTEST0817' }, CREDS);
  assert.equal(out.ok, false);
  assert.match(out.error, /planned on load DAVIS000198197/);
  assert.equal(out.calls.writes, 0);
});

test('a failed read cancels nothing', async () => {
  const { requester, calls } = world({ readStatus: 500 });
  const out = await runCancelOrder(requester, { stopNbr: 'ZZTEST0817' }, CREDS);
  assert.equal(out.ok, false);
  assert.match(out.error, /nothing was cancelled/);
  assert.equal(calls.length, 1, 'the read happened and nothing else did');
});

test('a vendor refusal is reported with its own reason, and claims nothing', async () => {
  const { requester } = world({ cancelBody: { status: 'FAIL', Reasons: [{ description: 'NuVizz says no' }] } });
  const out = await runCancelOrder(requester, { stopNbr: 'ZZTEST0817' }, CREDS);
  assert.equal(out.ok, false);
  assert.match(out.error, /NuVizz says no/);
  assert.match(out.error, /Nothing was cancelled/);
  // The before-image still rides along, so the journal shows what was ATTEMPTED.
  assert.equal(out.cancelled.stopId, ID);
});

test('stopNbr is mandatory', async () => {
  const { requester } = world();
  await assert.rejects(() => runCancelOrder(requester, {}, CREDS), /stopNbr/);
});
