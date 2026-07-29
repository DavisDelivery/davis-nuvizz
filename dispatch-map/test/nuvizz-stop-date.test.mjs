// test/nuvizz-stop-date.test.mjs
//
// §D — moving an order to the day the customer actually wants it.
//
// The case that produced this (Jul 29): an Estes import the customer deferred to the 30th
// showed up on the 29th board and was plannable. The board files a stop by the saved
// search's Estimated Arrival — and NuVizz does NOT recompute that for an unplanned order —
// so changing the date has to be TWO writes to hold: the delivery window in NuVizz, and a
// board-date override of our own that every later scan honors. Tests for both halves.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDayString, primarySideKey, stopDeliveryDate, shiftScheduleToDate, buildStopDateOverride,
  buildPartialUpdateStop, PARTIAL_UPDATE_DERIVED_KEYS, WRITE_OPS, MUTATING_OPS,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runSetStopDate } from '../netlify/functions/lib/nuvizz-write.mts';
import { boardDayFor, bucketByDate } from '../netlify/functions/lib/nuvizz-list.mts';
import { pruneBoardDateOverrides } from '../netlify/functions/lib/firestore.mts';

const CREDS = { base: 'https://portal.example.com/deliverit/openapi/v7', companyCode: 'DAVIS', authHeader: 'Basic x' };

// KAI WONG, 3570 Rolling Creek Dr — the order from the report, with its 12:00–12:30 window.
const rawStop = (over = {}) => ({
  stopId: '6a63c5844524f7f7b8ab5410', stopNbr: '007150559', stopType: 'DO',
  weight: 2477, totalPallets: 4, totalCartons: 4, sealNbr: '$163.18',
  to: {
    address: { addr1: '3570 ROLLING CREEK DR', city: 'BUFORD', state: 'GA', zip: '30519' },
    contact: { contactName: 'KAI WONG', phone: '6788608099' },
    schedule: { timeFrom: '2026-07-29T12:00:00', timeTo: '2026-07-29T12:30:00', timeZone: 'America/New_York', timeConstraint: 'PREFERRED' },
    documents: [{ documentName: 'BOL', documentType: '03', documentExtType: 'pdf', documentData: '', reference: 'guid-1' }],
  },
  from: { address: { addr1: '943 GAINESVILLE HWY', city: 'BUFORD' }, schedule: { timeFrom: '2026-07-29T08:00:00', timeTo: '2026-07-29T12:00:00' } },
  ...over,
});

// ── pure ─────────────────────────────────────────────────────────────────────

test('isDayString: a real calendar day only', () => {
  for (const ok of ['2026-07-30', '2026-02-28', '2024-02-29']) assert.equal(isDayString(ok), true, ok);
  for (const bad of ['2026-7-30', '30/07/2026', '2026-13-01', '2026-02-30', '', null, undefined, '2026-07-30T12:00:00']) {
    assert.equal(isDayString(bad), false, String(bad));
  }
});

test('primarySideKey / stopDeliveryDate: a delivery reads `to`, a pickup reads `from`', () => {
  assert.equal(primarySideKey(rawStop()), 'to');
  assert.equal(stopDeliveryDate(rawStop()), '2026-07-29');
  const pu = rawStop({ stopType: 'PU' });
  assert.equal(primarySideKey(pu), 'from');
  assert.equal(stopDeliveryDate(pu), '2026-07-29');
  assert.equal(stopDeliveryDate({ stopType: 'DO', to: {} }), null, 'no window → no date, never a guess');
});

test('shiftScheduleToDate: moves the DAY and keeps the appointment TIME', () => {
  const s = shiftScheduleToDate(rawStop().to.schedule, '2026-07-30');
  assert.equal(s.timeFrom, '2026-07-30T12:00:00');
  assert.equal(s.timeTo, '2026-07-30T12:30:00');
  assert.equal(s.timeZone, 'America/New_York', 'the rest of the schedule rides through untouched');
  assert.equal(s.timeConstraint, 'PREFERRED');
});

test('shiftScheduleToDate: a window that spans midnight keeps its span', () => {
  const s = shiftScheduleToDate({ timeFrom: '2026-07-29T22:00:00', timeTo: '2026-07-30T06:00:00' }, '2026-08-04');
  assert.equal(s.timeFrom, '2026-08-04T22:00:00');
  assert.equal(s.timeTo, '2026-08-05T06:00:00');
});

test('shiftScheduleToDate: no window at all falls back to the create path default', () => {
  const s = shiftScheduleToDate(null, '2026-07-30');
  assert.equal(s.timeFrom, '2026-07-30T12:00:00');
  assert.equal(s.timeTo, '2026-07-30T17:00:00');
  assert.throws(() => shiftScheduleToDate({}, 'tomorrow'), /not a YYYY-MM-DD/);
});

test('buildStopDateOverride: only the schedule moves — address and contact are echoed as read', () => {
  const { side, block } = buildStopDateOverride(rawStop(), '2026-07-30');
  assert.equal(side, 'to');
  assert.deepEqual(block.address, rawStop().to.address);
  assert.deepEqual(block.contact, rawStop().to.contact);
  assert.equal(block.schedule.timeFrom, '2026-07-30T12:00:00');
  assert.throws(() => buildStopDateOverride({ stopType: 'DO' }, '2026-07-30'), /no "to" block/);
});

test('buildPartialUpdateStop: an override can NEVER put the order\'s files back on the wire', () => {
  // The override block is built by spreading the `to` we read, which carries to.documents.
  // Applying overrides before the strip is what keeps the attachment fix (v0.53.3) intact.
  const { side, block } = buildStopDateOverride(rawStop(), '2026-07-30');
  const sent = buildPartialUpdateStop(rawStop(), { [side]: block });
  assert.equal(sent.to.documents, undefined, 'attachments stay off a date change too');
  assert.equal(sent.to.schedule.timeFrom, '2026-07-30T12:00:00');
  for (const p of PARTIAL_UPDATE_DERIVED_KEYS) {
    const v = p.split('.').reduce((a, k) => (a == null ? a : a[k]), sent);
    assert.equal(v, undefined, `${p} must not be echoed`);
  }
});

test('setStopDate is a registered, gated MUTATING op', () => {
  assert.ok(WRITE_OPS.includes('setStopDate'));
  assert.ok(MUTATING_OPS.has('setStopDate'), 'must sit behind NUVIZZ_WRITE_ENABLED + idempotency');
});

// ── the board override ───────────────────────────────────────────────────────

test('boardDayFor: a dispatcher-set date beats the list\'s Estimated Arrival', () => {
  // The exact failure: an open unplanned order with no arrival date is filed on TODAY.
  const s = { stopNbr: '007150559', normalizedStatus: 'UNPLANNED', boardDate: null, requestedDate: null, scheduledDate: null };
  assert.equal(boardDayFor(s, '2026-07-29'), '2026-07-29', 'without an override it lands on today — the bug');
  assert.equal(boardDayFor(s, '2026-07-29', { '007150559': '2026-07-30' }), '2026-07-30', 'with one it holds until the 30th');
  // A stale arrival that disagrees loses too.
  const dated = { ...s, boardDate: '2026-07-29' };
  assert.equal(boardDayFor(dated, '2026-07-29', { '007150559': '2026-07-30' }), '2026-07-30');
  // Another stop's override never touches this one.
  assert.equal(boardDayFor(s, '2026-07-29', { '999': '2026-07-30' }), '2026-07-29');
});

test('boardDayFor: a FINISHED stop is never re-filed by an override', () => {
  // Where a delivery actually happened is history, not a plan.
  const done = { stopNbr: '007150559', normalizedStatus: 'DELIVERED', boardDate: '2026-07-29' };
  assert.equal(boardDayFor(done, '2026-07-29', { '007150559': '2026-07-30' }), '2026-07-29');
});

test('bucketByDate: the deferred order leaves today\'s bucket entirely', () => {
  const stops = [
    { stopNbr: '007150559', normalizedStatus: 'UNPLANNED' },
    { stopNbr: '007150560', normalizedStatus: 'UNPLANNED' },
  ];
  const m = bucketByDate(stops, '2026-07-29', { '007150559': '2026-07-30' });
  assert.deepEqual(m.get('2026-07-29').map((s) => s.stopNbr), ['007150560']);
  assert.deepEqual(m.get('2026-07-30').map((s) => s.stopNbr), ['007150559']);
});

test('pruneBoardDateOverrides: a "not yet" whose day has passed is dropped', () => {
  const map = { a: '2026-07-28', b: '2026-07-29', c: '2026-08-05', d: 'nonsense', '': '2026-08-05' };
  assert.deepEqual(pruneBoardDateOverrides(map, '2026-07-29'), { b: '2026-07-29', c: '2026-08-05' });
  assert.deepEqual(pruneBoardDateOverrides(null, '2026-07-29'), {});
});

// ── end to end through the op runner ─────────────────────────────────────────

function makeRequester({ state, writeStatus = { status: 'SUCESS', apiResult: { updated: 1, failed: 0, errors: [] } }, onWrite, load = null, status = null } = {}) {
  const calls = [];
  return {
    calls,
    requester: {
      async request(url, opts) {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
        if (url.includes('/stop/info/')) {
          return J({ Stop: { stop: state.stop, stopExecutionInfo: status ? { stopStatus: status } : {}, load: load || {} } });
        }
        if (url.includes('/stop/partialUpdate/')) {
          const sent = JSON.parse(opts.body).stops[0];
          if (onWrite) onWrite(sent, state);
          else state.stop = { ...state.stop, to: { ...state.stop.to, schedule: sent.to.schedule } };
          return J(writeStatus);
        }
        return J({}, 404);
      },
    },
  };
}

test('runSetStopDate: moves the window, verifies it landed, reports the move', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30' }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.fromDate, '2026-07-29');
  assert.equal(r.date, '2026-07-30');
  const sent = JSON.parse(calls.find((c) => c.url.includes('partialUpdate')).body).stops[0];
  assert.equal(sent.to.schedule.timeFrom, '2026-07-30T12:00:00', 'the day moved');
  assert.equal(sent.to.schedule.timeTo, '2026-07-30T12:30:00', 'the appointment time did not');
  assert.equal(sent.weight, 2477, 'the rest of the order is echoed as read');
  assert.equal(sent.to.documents, undefined);
  assert.equal(calls.filter((c) => c.url.includes('/stop/info/')).length, 2, 'read → write → verify');
});

test('runSetStopDate: an order already on that day writes NOTHING', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-29' }, CREDS);
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, true);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('runSetStopDate: refuses a stop the driver is already running', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state, status: 'OUT_FOR_DELIVERY' });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30' }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /in flight/i);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing written');
});

test('runSetStopDate: a bad date never reaches NuVizz', async () => {
  const { requester, calls } = makeRequester({ state: { stop: rawStop() } });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '07/30/2026' }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /not a YYYY-MM-DD date/);
  assert.equal(calls.length, 0);
});

test('runSetStopDate: a write that moves ANY other field fails loudly', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, onWrite: (sent, st) => {
    st.stop = { ...st.stop, to: { ...st.stop.to, schedule: sent.to.schedule }, sealNbr: '' };
  } });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30' }, CREDS);
  assert.equal(r.ok, false, 'a blanked field must not report a clean move');
  assert.ok(r.drift.includes('sealNbr'), JSON.stringify(r.drift));
  assert.equal(r.dateLanded, true, 'the date itself did move');
  assert.match(r.error, /do not change dates again/i);
});

test('runSetStopDate: an accepted write that did NOT actually move the date is a failure', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, onWrite: () => { /* NuVizz says SUCESS, changes nothing */ } });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30' }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /still reads 2026-07-29/);
});

test('runSetStopDate: a rejected write says so and claims nothing', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, writeStatus: { status: 'FAILURE', errors: [{ message: 'nope' }] } });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30' }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /rejected the date change/i);
});

test('runSetStopDate: a failed FIRST read writes nothing at all', async () => {
  const calls = [];
  const requester = { async request(url, opts) { calls.push({ url, method: opts.method || 'GET' }); return new Response(JSON.stringify({ error: 'boom' }), { status: 500 }); } };
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30' }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing was written/i);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('runSetStopDate: a planned order still moves, and says which load it is on', async () => {
  // Not refused — the dispatcher may be deferring exactly because it must come off a route —
  // but the load rides back on the result so the UI can say so.
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state, load: { loadNbr: 'MITCHELL 1' } });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30' }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.onLoad, 'MITCHELL 1');
});
