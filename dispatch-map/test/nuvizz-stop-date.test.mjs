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
  buildPartialUpdateStop, PARTIAL_UPDATE_DERIVED_KEYS, WRITE_OPS, MUTATING_OPS, boardDateHoldWarning,
  stopInstanceMismatch,
} from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runSetStopDate } from '../netlify/functions/lib/nuvizz-write.mts';
import { boardDayFor, bucketByDate } from '../netlify/functions/lib/nuvizz-list.mts';
import { pruneBoardDateOverrides, shiftBoardStopWindow } from '../netlify/functions/lib/firestore.mts';

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

// ── the cached row's OWN window moves too ────────────────────────────────────
//
// Chad, Jul 29: "Dont think that this is actually writing to nuvizz when you change the date."
// It was writing — and verifying, and refusing to claim success on drift. What never moved was
// the CACHED row: moveBoardStopDay re-filed it under the new boardDate/scheduledDate and left
// `scheduledFrom` on the old day. That is the first field the "Change delivery date (…)" label
// reads, it is not a LIVE_LIST_FIELD (mergeEnrich carries it forward untouched), and an
// already-enriched stop is never re-read — so the stale day outlived every later scan and a
// confirmed write read back as if it had never happened.

test('shiftBoardStopWindow: the row\'s delivery window follows the write, clock kept', () => {
  const row = { scheduledFrom: '2026-07-29T12:00:00', scheduledTo: '2026-07-29T12:30:00' };
  assert.deepEqual(shiftBoardStopWindow(row, '2026-07-30'), {
    scheduledFrom: '2026-07-30T12:00:00', scheduledTo: '2026-07-30T12:30:00',
  });
});

test('shiftBoardStopWindow: a window spanning midnight keeps its span', () => {
  const row = { scheduledFrom: '2026-07-29T22:00:00', scheduledTo: '2026-07-30T02:00:00' };
  assert.deepEqual(shiftBoardStopWindow(row, '2026-08-03'), {
    scheduledFrom: '2026-08-03T22:00:00', scheduledTo: '2026-08-04T02:00:00',
  });
});

test('shiftBoardStopWindow: moving BACKWARD works the same way', () => {
  assert.deepEqual(shiftBoardStopWindow({ scheduledFrom: '2026-08-05T09:00:00' }, '2026-07-30'), {
    scheduledFrom: '2026-07-30T09:00:00',
  });
});

test('shiftBoardStopWindow: nothing to move → no keys, so setDoc never fabricates a time', () => {
  // A row with no window, a junk window, a junk target, or one already on the day: the spread
  // in moveBoardStopDay must add NOTHING rather than write a null over a real value.
  assert.deepEqual(shiftBoardStopWindow({}, '2026-07-30'), {});
  assert.deepEqual(shiftBoardStopWindow({ scheduledFrom: null }, '2026-07-30'), {});
  assert.deepEqual(shiftBoardStopWindow({ scheduledFrom: 'sometime tuesday' }, '2026-07-30'), {});
  assert.deepEqual(shiftBoardStopWindow({ scheduledFrom: '2026-07-29T12:00:00' }, 'next week'), {});
  assert.deepEqual(shiftBoardStopWindow({ scheduledFrom: '2026-07-29T12:00:00' }, '2026-07-29'), {});
  assert.deepEqual(shiftBoardStopWindow(null, '2026-07-30'), {});
});

test('shiftBoardStopWindow: a missing scheduledTo does not invent one', () => {
  const out = shiftBoardStopWindow({ scheduledFrom: '2026-07-29T12:00:00', scheduledTo: null }, '2026-07-30');
  assert.deepEqual(out, { scheduledFrom: '2026-07-30T12:00:00' });
  assert.equal('scheduledTo' in out, false);
});

test('shiftBoardStopWindow: the row lands on the day the label reads back', () => {
  // The editor's `current`: scheduledFrom.slice(0,10) → scheduledDate → boardDate. All three
  // must agree with the day NuVizz now holds, or the label contradicts the write.
  const row = { scheduledFrom: '2026-07-29T12:00:00', scheduledTo: '2026-07-29T12:30:00', scheduledDate: '2026-07-29', boardDate: '2026-07-29' };
  const moved = { ...row, ...shiftBoardStopWindow(row, '2026-07-30'), boardDate: '2026-07-30', scheduledDate: '2026-07-30' };
  assert.equal(String(moved.scheduledFrom).slice(0, 10) || moved.scheduledDate || moved.boardDate, '2026-07-30');
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

// ── "already dated" must still take it off OUR board ────────────────────────
//
// Chad, on an order he set to 7/30: "i changed this to 7/30 and it didn't write to nuvizz so it
// showed up in a new scan." Both halves of that are true, and the second is the bug. A date
// change is TWO writes: the delivery window in NuVizz, and a board-date override of our own that
// every later scan honors — needed because NuVizz never recomputes the Estimated Arrival the
// board files by. When NuVizz ALREADY carries the requested day (an Estes import the customer
// deferred to the 30th arrives that way — the founding case for this whole feature), the first
// write is correctly skipped… and the short-circuit used to skip the SECOND one too. So nothing
// was recorded anywhere, and the next scan filed the order straight back onto today. The one
// case the override exists for was the one case it never ran in.

test('runSetStopDate: an order already on that day still gets the BOARD override', async () => {
  const state = { stop: rawStop() };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-29' }, CREDS);
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, true);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'still writes NOTHING to NuVizz');
  assert.equal(r.calls.writes, 0);
  assert.equal(r.calls.reads, 1, 'and still costs exactly one read — the board half is Firestore only');
  // The board half RAN. (Firestore is off under test, so it reports skipped rather than a
  // write — the point is that it was attempted at all, where before it was never reached.)
  assert.ok(r.board, 'the board half must run on the already-dated path');
  assert.match(String(r.message), /already carries 2026-07-29/i);
});

test('runSetStopDate: an already-dated order says so plainly, and says what the board did', async () => {
  const { requester } = makeRequester({ state: { stop: rawStop() } });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-29' }, CREDS);
  // Never "Moved …" — nothing moved in NuVizz. But the message must not stop there either:
  // whether the order leaves today's board is the thing the dispatcher actually asked for.
  assert.doesNotMatch(String(r.message), /^Moved/i);
  assert.ok(String(r.message).length > 40, 'says what happened to the board too');
});

// ── the board half can fail, and it may never fail silently ─────────────────

test('boardDateHoldWarning: a failed override is reported, a healthy one is silent', () => {
  assert.equal(boardDateHoldWarning({ at: 'x', override: { count: 3, date: '2026-07-30' }, moved: { found: true } }), null);
  assert.match(boardDateHoldWarning({ skipped: 'firestore-disabled' }), /pull this order back onto today/i);
  assert.match(boardDateHoldWarning({ overrideError: 'PERMISSION_DENIED' }), /PERMISSION_DENIED/);
  assert.match(boardDateHoldWarning({ overrideError: 'boom' }), /pull this order back onto today/i);
  assert.equal(boardDateHoldWarning(null), boardDateHoldWarning({ skipped: true }), 'no result at all is the same as skipped');
});

test('boardDateHoldWarning: a failed ROW MOVE is a lesser note — the day itself still holds', () => {
  // The override is what survives a scan; the row move only makes the board catch up sooner.
  const w = boardDateHoldWarning({ override: { count: 1 }, moveError: 'not found' });
  assert.match(w, /until the next scan/i);
  assert.doesNotMatch(w, /pull this order back/i, 'must not imply the day was lost');
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

// ── the wrong-twin guard (the Estes-0828068215 lesson, Aug 4) ────────────────
//
// NuVizz can hold TWO order records under ONE stop number (a rekeyed order next to the
// original entry), and /stop/info BY NUMBER answers with whichever instance it picks.
// Jessica: "I tried to update this Estes delivery date … and it completely changed the
// address" — the read returned the OTHER record (consigned to Davis), the write moved ITS
// window, and the card refreshed into its address. The board knows which record it is
// showing (the list's Stop-Id column), so the op must refuse when the read disagrees.

test('stopInstanceMismatch: agrees / missing ids / number-shaped ids → never arms', () => {
  const raw = rawStop();
  assert.equal(stopInstanceMismatch('setStopDate', '007150559', raw.stopId, raw), null, 'same record');
  assert.equal(stopInstanceMismatch('setStopDate', '007150559', null, raw), null, 'caller has no id → old behavior');
  assert.equal(stopInstanceMismatch('setStopDate', '007150559', '', raw), null);
  assert.equal(stopInstanceMismatch('setStopDate', '007150559', '007150559', raw), null, 'a stop NUMBER passed as an id must never block a write');
  assert.equal(stopInstanceMismatch('setStopDate', '007150559', 'ffffffffffffffffffffffff', { stopNbr: '007150559' }), null, 'record with no id → cannot judge, old behavior');
});

test('stopInstanceMismatch: a DIFFERENT record refuses, naming both ids and the twin', () => {
  const twin = rawStop({ stopId: 'ffffffffffffffffffffffff' });
  twin.to.address.name = 'DAVIS DELIVERY';
  const msg = stopInstanceMismatch('setStopDate', 'Estes-0828068215', '6a63c5844524f7f7b8ab5410', twin);
  assert.ok(msg, 'must refuse');
  assert.match(msg, /TWO NuVizz orders/i);
  assert.match(msg, /Estes-0828068215/);
  assert.match(msg, /ffffff/, 'names the record NuVizz answered with');
  assert.match(msg, /ab5410/, 'names the record on the board');
  assert.match(msg, /DAVIS DELIVERY/, 'says WHO the twin is consigned to');
  assert.match(msg, /Nothing was written/i);
});

test('runSetStopDate: refuses when NuVizz answers with the OTHER record sharing the number', async () => {
  // The board's card carries the live record's id; the by-number read returns the twin.
  const state = { stop: rawStop({ stopId: 'ffffffffffffffffffffffff' }) };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30', stopId: '6a63c5844524f7f7b8ab5410' }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.wrongInstance, true);
  assert.match(r.error, /TWO NuVizz orders/i);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing written');
  assert.equal(r.calls.reads, 1);
});

test('runSetStopDate: the already-dated short-circuit refuses the twin too', async () => {
  // The date read off the WRONG record must never seed a board override for the right one:
  // "already carries that day" is a claim about the twin, not about the dispatcher's order.
  const state = { stop: rawStop({ stopId: 'ffffffffffffffffffffffff' }) };
  const { requester, calls } = makeRequester({ state });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-29', stopId: '6a63c5844524f7f7b8ab5410' }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.wrongInstance, true);
  assert.equal(r.board, undefined, 'the board half must not run on the twin');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('runSetStopDate: a MATCHING id proceeds, and the result names the verified record', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({ state });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30', stopId: '6a63c5844524f7f7b8ab5410' }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.stopId, '6a63c5844524f7f7b8ab5410', 'the client repaint guard needs the verified id');
});

// ── the read-back twin (ESTES-2938079387, Aug 14) ────────────────────────────
//
// Brandi moved a date on Khalid Mutakabbir's Estes order. Pre-read: his record (the screen's
// stopId — the v0.54.36 guard passed). Write: his stopId, his address, the new window. But
// the READ-BACK is the same by-number lookup, and NuVizz answered it with the OTHER record
// sharing the number — consigned to Davis's own terminal. The echo diff then compared two
// DIFFERENT ORDERS and the banner claimed the write had re-addressed the order to
// "943 GAINESVILLE HIGHWAY", turned "GA" into "GEORGIA", and renamed the shipper. Every one
// of those "changes" was the twin's data. These tests pin the honest verdict.

import { readBackInstanceMismatch, orderDriftPaths, addressDriftWarning } from '../netlify/functions/lib/nuvizz-write-ops.mts';

// The twin: same stop number, different record — the Estes linehaul entry consigned to the
// Davis terminal, formatted by a different system ("GEORGIA", "DAVIS DELIVERY").
const TWIN = {
  stopId: '7b8c99aa11223344556677ff', stopNbr: 'ESTES-2938079387', stopType: 'DO',
  weight: 2477, totalPallets: 4, totalCartons: 4,
  to: {
    address: { name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HIGHWAY', city: 'BUFORD', state: 'GEORGIA', zip: '30518' },
    schedule: { timeFrom: '2026-08-17T12:00:00', timeTo: '2026-08-17T17:00:00', timeZone: 'America/New_York' },
  },
  from: { address: { name: 'DAVIS DELIVERY', addr1: '943 GAINESVILLE HWY', city: 'BUFORD' } },
};

test('THE INCIDENT: a twin answering the read-back is reported as a twin, not as 15 changed fields', async () => {
  const khalid = rawStop({
    stopNbr: 'ESTES-2938079387',
    to: {
      address: { name: 'KHALID MUTAKABBIR', addr1: '670 HUNTERS CT', city: 'LAWRENCEVILLE', state: 'GA', zip: '30043' },
      schedule: { timeFrom: '2026-08-12T12:00:00', timeTo: '2026-08-12T17:00:00', timeZone: 'America/New_York' },
    },
  });
  const state = { stop: khalid };
  const { requester } = makeRequester({
    state,
    // The write succeeds against Khalid's record; the read-back answers with the TWIN.
    onWrite: () => { state.stop = TWIN; },
  });
  const r = await runSetStopDate(requester, { stopNbr: 'ESTES-2938079387', date: '2026-08-17', stopId: khalid.stopId }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.wrongInstanceReadback, true, 'the verdict is identity, not drift');
  assert.equal(r.unverified, true);
  assert.equal(r.drift, undefined, 'no cross-record field list is presented as changes');
  assert.equal(r.dateLanded, undefined, 'the twin\'s window must not be read as "the date moved"');
  assert.match(r.error, /DIFFERENT record/i);
  assert.match(r.error, /TWO orders appear to carry this number/i);
  assert.match(r.error, /943 GAINESVILLE HIGHWAY/, 'names the twin\'s consignee so the portal hunt is short');
  assert.match(r.error, new RegExp(khalid.stopId.slice(-6)), 'names the id we wrote');
  assert.match(r.error, new RegExp(TWIN.stopId.slice(-6)), 'and the id that answered');
  assert.ok(!/partialUpdate changed/.test(r.error), 'the old terrifying wording is gone for this case');
});

test('the SAME record with a genuinely rewritten address still fails loudly — and says ADDRESS first', async () => {
  const state = { stop: rawStop() };
  const { requester } = makeRequester({
    state,
    // Same stopId, but NuVizz "re-addressed" the order during the write — the other world
    // the screenshot could have meant. This must stay a red banner, sharper than before.
    onWrite: (sent) => {
      state.stop = {
        ...state.stop,
        to: { ...state.stop.to, schedule: sent.to.schedule, address: { ...state.stop.to.address, addr1: '943 GAINESVILLE HIGHWAY', zip: '30518' } },
      };
    },
  });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30', stopId: '6a63c5844524f7f7b8ab5410' }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.wrongInstanceReadback, undefined, 'same record — this genuinely IS drift');
  assert.match(r.error, /AN ADDRESS ON THE ORDER MOVED/, 'address drift is called out in words');
  assert.match(r.error, /to\.address\.addr1/, 'and the address field is in the visible details, not behind the cap');
  assert.equal(r.dateLanded, true, 'the date claim is trustworthy here because the record is ours');
});

test('orderDriftPaths puts address ahead of everything; addressDriftWarning fires only on address paths', () => {
  const ordered = orderDriftPaths(['sealNbr', 'to.schedule.timeZone', 'to.contact.phone', 'weight', 'to.address.addr1']);
  assert.equal(ordered[0], 'to.address.addr1');
  assert.equal(ordered[1], 'to.contact.phone');
  assert.deepEqual(orderDriftPaths([]), []);
  assert.match(addressDriftWarning(['to.address.zip']), /ADDRESS ON THE ORDER MOVED/);
  assert.equal(addressDriftWarning(['sealNbr', 'to.contact.phone']), '');
  assert.equal(addressDriftWarning([]), '');
});

test('readBackInstanceMismatch: unarmed without two id-shaped ids; silent when they agree', () => {
  assert.equal(readBackInstanceMismatch('setStopDate', 'X', '6a63c5844524f7f7b8ab5410', { stopId: '6a63c5844524f7f7b8ab5410' }), null);
  assert.equal(readBackInstanceMismatch('setStopDate', 'X', null, TWIN), null, 'no written id → cannot judge');
  assert.equal(readBackInstanceMismatch('setStopDate', 'X', '6a63c5844524f7f7b8ab5410', { stopId: null }), null, 'no read-back id → cannot judge');
  assert.match(readBackInstanceMismatch('setStopDate', 'X', '6a63c5844524f7f7b8ab5410', TWIN) || '', /DIFFERENT record/);
});

// ── the review's findings, pinned (v0.54.73) ─────────────────────────────────

test('UNPINNED FLIP: with no client stopId, the twin banner claims only what is proven', async () => {
  // The adversarial review's D1: no payload.stopId → the pre-read is itself an unguarded
  // by-number lookup. If the PRE-read answers the TWIN and the READ-BACK answers the screen's
  // record, a banner saying "written to the record on your screen" inverts both identity
  // claims — the write actually landed on the twin. Unpinned wording must hedge.
  const khalid = rawStop({ stopNbr: 'ESTES-2938079387' });
  const state = { stop: TWIN };                       // pre-read answers the TWIN
  const { requester } = makeRequester({
    state,
    onWrite: () => { state.stop = khalid; },          // read-back answers the screen's record
  });
  // 8/18, not 8/17: the TWIN fixture already carries 8/17, and an unchanged date would
  // short-circuit before the write — the flip needs the write to actually happen.
  const r = await runSetStopDate(requester, { stopNbr: 'ESTES-2938079387', date: '2026-08-18' }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.wrongInstanceReadback, true);
  assert.ok(!/record on your screen/.test(r.error), 'unpinned must not claim the screen record was written');
  assert.match(r.error, /may or may not be the one on your screen/);
  assert.match(r.error, /confirm which record took the change/);
});

test('PINNED twin verdict still speaks plainly — the hedge is only for the unpinned case', async () => {
  const khalid = rawStop({ stopNbr: 'ESTES-2938079387' });
  const state = { stop: khalid };
  const { requester } = makeRequester({ state, onWrite: () => { state.stop = TWIN; } });
  const r = await runSetStopDate(requester, { stopNbr: 'ESTES-2938079387', date: '2026-08-17', stopId: khalid.stopId }, CREDS);
  assert.match(r.error, /record on your screen/);
  assert.ok(!/may or may not/.test(r.error));
});

test('an UNIDENTIFIABLE read-back verdicts as unverified, never as a drift list', async () => {
  // D3: a 200 read-back whose record carries no usable stopId. Diffing it is the same
  // two-different-things trap as the twin — "field → (absent)" about a record nobody named.
  const mine = rawStop();
  const state = { stop: mine };
  const { requester } = makeRequester({
    state,
    onWrite: () => { const { stopId, ...rest } = mine; state.stop = { ...rest, to: { schedule: { timeFrom: '2026-07-30T12:00:00' } } }; },
  });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30', stopId: mine.stopId }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.unverified, true);
  assert.equal(r.drift, undefined, 'no diff against an unidentified record');
  assert.match(r.error, /no usable identity/);
});

test('CAP DEFEAT end to end: with >5 drifted fields, the address line is visible, not hidden', async () => {
  // D6: the incident had 15 drifted fields and a 5-line cap; discovery order decided what the
  // dispatcher saw. This drives >5 drifts through the real executor with the address changed
  // LAST in echo order, and requires it in the shown details plus an honest (+N more).
  const state = { stop: rawStop() };
  const { requester } = makeRequester({
    state,
    onWrite: (sent) => {
      state.stop = {
        ...state.stop,
        weight: 9999, totalPallets: 9, totalCartons: 9, sealNbr: '$0.01',
        proNumber: 'ZZ', bol: 'CHANGED',
        to: { ...state.stop.to, schedule: sent.to.schedule, address: { ...state.stop.to.address, addr1: '943 GAINESVILLE HIGHWAY' } },
      };
    },
  });
  const r = await runSetStopDate(requester, { stopNbr: '007150559', date: '2026-07-30', stopId: '6a63c5844524f7f7b8ab5410' }, CREDS);
  assert.equal(r.ok, false);
  assert.ok(r.drift.length > 5, `needs more drift than the cap, got ${r.drift.length}`);
  assert.equal(r.drift[0], 'to.address.addr1', 'address ordered first');
  assert.match(r.error, /to\.address\.addr1: .*943 GAINESVILLE HIGHWAY/, 'address inside the visible five');
  assert.match(r.error, /\(\+\d+ more\)/, 'the hidden remainder is accounted for');
});
