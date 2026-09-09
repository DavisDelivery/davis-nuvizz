// test/nuvizz-cancel-vehicle-type.test.mjs — the refused route CANCEL (Sep 9 2026).
//
// Chad, on TRAILER 5 with the red "This DELETES a route" modal open: "when i click cancel
// the route it doesn't do what it says it is going to do." The modal promises the route is
// deleted and its 7 orders go back to Un-Planned; the Save answered
//   "TRAILER 5: Vehicle Type unavailable or disabled. Please verify Vehicle Type in
//    Vehicle Type Configuration for DAVIS000203261 (code 903)"
// and the route kept every order. Emptying a route is a load/edit — a FULL HEADER ECHO —
// so the request hands NuVizz back the route's own vehicleType, and a type since disabled
// in the portal's Vehicle Type Configuration refuses the whole edit. Same refusal as
// TERRANCE on Sep 8 (v0.97.1), which made the message honest and left the button broken.
//
// Pins:
//   • the UNTOUCHED echo is always attempt one — a cancel NuVizz accepts is still 2 calls
//     and its step is byte-identical to before (no cancelAttempts key at all);
//   • a Vehicle Type refusal re-reads the load once, then retries with vehicleType OMITTED
//     — and that retry's body carries no vehicleType key while keeping the rest of the echo;
//   • omitted refused → the CLEARED (null) shape is tried, and it can win;
//   • the ladder is NOT keyed on reason 903 — the tenant's other 903 ("Either PlanStop or
//     Stop node should be present") retries nothing;
//   • a PARTIAL remove never climbs: that route keeps living, so its header stays echoed
//     verbatim, vehicleType included;
//   • refused in words but EMPTY in fact → the cancel LANDED (report the system, not the
//     response), and the ladder stops there;
//   • the refusal names a Vehicle Type our header never sent → NuVizz is validating its
//     STORED value, so no fallback is fired and the message says a re-Save cannot help;
//   • both fallbacks refused → the banner leads with the OUTCOME ("still holds all 6"),
//     carries NuVizz's reason verbatim, and names Vehicle Type Configuration;
//   • NUVIZZ_CANCEL_VT_FALLBACK=off restores the single-attempt behaviour exactly.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NUVIZZ_BASE_URL = '';
delete process.env.FIREBASE_SA;          // board write-through OFF — this suite is about the calls

const { runCommitBoard } = await import('../netlify/functions/lib/nuvizz-write.mts');
const { isVehicleTypeRefusal, cancelHeaderVariant, editHeaderHasVehicleType } =
  await import('../netlify/functions/lib/nuvizz-write-ops.mts');

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const HEX = '6a438e9d52ef82bd1ed4516b';
const NBR = 'DAVIS000203261';
// TRAILER 5's own orders from the Sep 9 screenshot.
const HELD = ['FUHSING', 'STACI1', 'STACI2', 'ONETREE', 'AMES', 'MURRELEKTRONIK'];

// NuVizz sends the sentence as reasons[0].description and 903 as reasonCode; firstError joins
// them, so the string the app actually sees is VT_ERR.
const VT_REFUSAL = `Vehicle Type unavailable or disabled. Please verify Vehicle Type in Vehicle Type Configuration for ${NBR}`;
const VT_ERR = `${VT_REFUSAL} (code 903)`;

// ── requester harness ────────────────────────────────────────────────────────
// `edits` is a scripted list of answers to POST /load/edit, consumed in order; each entry is
// either { ok:true } or { reason }. `stopsAfter` lets a re-read report a DIFFERENT load than
// the first read did (the "refused in words, empty in fact" case).
function makeRequester({ stops = HELD, vehicleType = 'TRAILER', edits = [], stopsAfter = null, loadCancel = { ok: true }, stopAfterCancel = {} } = {}) {
  const calls = [];
  let infoReads = 0;
  return {
    calls,
    editBodies: () => calls.filter((c) => c.route === '/load/edit').map((c) => JSON.parse(c.body)),
    cancelBodies: () => calls.filter((c) => c.route === '/load/cancel').map((c) => JSON.parse(c.body)),
    requester: {
      async request(url, opts, meta) {
        const method = (opts.method || 'GET').toUpperCase();
        calls.push({ url, method, route: meta?.route, body: opts.body });
        const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
        if (url.includes('/load/info/')) {
          infoReads += 1;
          const list = infoReads > 1 && stopsAfter ? stopsAfter : stops;
          return J({ Load: {
            loadHeader: {
              loadId: HEX, loadNbr: NBR, routeName: 'TRAILER 5',
              ...(vehicleType === null ? {} : { vehicleType }),   // null = the header carries no vehicle type at all
              rtOrigin: { address: { latitude: 34.04, longitude: -83.71 } },
            },
            versionId: `v${infoReads}`,
            loadExecutionInfo: { loadStatus: 'PLANNED' },
            stops: list.map((n, i) => ({ stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: { seq: i + 2 } } })),
          } });
        }
        if (url.includes('/load/edit/')) {
          const next = edits.shift() ?? { ok: true };
          if (next.ok) return J({ status: 'SUCCESS' });
          return J({ status: 'FAILED', reasons: [{ description: next.reason, reasonCode: next.code ?? 903 }] }, 200);
        }
        if (url.includes('/load/cancel/')) {
          return loadCancel.ok ? J({ status: 'SUCCESS' }) : J({ status: 'FAILED', reasons: [{ description: loadCancel.reason }] }, 200);
        }
        if (url.includes('/stop/info/')) {
          const n0 = url.split('/stop/info/')[1].split('/')[0];
          const st = stopAfterCancel[n0] ?? {};
          return J({ Stop: {
            stop: { stopId: `id-${n0}`, stopNbr: n0, stopType: 'DO' },
            // status + cancellation live on stopExecutionInfo, NOT on the stop node (normalizeStop).
            stopExecutionInfo: { stopStatus: st.status ?? '10', ...(st.cancelledAt ? { cancellation: { cancelDTTM: st.cancelledAt } } : {}) },
            load: { loadNbr: st.holder || '' },
          } });
        }
        if (url.includes('/load/insertstops/')) return J({ status: 'SUCCESS' });
        if (url.includes('/load/assignanddispatch/')) return J({ status: 'SUCCESS' });
        return J({});
      },
    },
  };
}

const cancelCard = () => ({ loadNbr: NBR, loadId: HEX, routeName: 'TRAILER 5', emptyLoad: true, orderedStopNbrs: [], removeStopNbrs: [...HELD] });
const editCount = (h) => h.calls.filter((c) => c.route === '/load/edit').length;
const infoCount = (h) => h.calls.filter((c) => c.route === '/load/info').length;

async function withLever(value, fn) {
  const prev = process.env.NUVIZZ_CANCEL_VT_FALLBACK;
  if (value === undefined) delete process.env.NUVIZZ_CANCEL_VT_FALLBACK;
  else process.env.NUVIZZ_CANCEL_VT_FALLBACK = value;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.NUVIZZ_CANCEL_VT_FALLBACK; else process.env.NUVIZZ_CANCEL_VT_FALLBACK = prev; }
}

// ── the pure half ────────────────────────────────────────────────────────────

test('isVehicleTypeRefusal: the live Sep 9 refusal matches; the tenant OTHER 903 does not', () => {
  assert.equal(isVehicleTypeRefusal(VT_ERR), true);
  assert.equal(isVehicleTypeRefusal('Vehicle Type unavailable or disabled (code 903)'), true);
  // Reason 903 is reused by this tenant for the stopless-route refusal (§R). Retrying a
  // header shape against it would spend calls on a guaranteed no.
  assert.equal(isVehicleTypeRefusal('Either PlanStop or Stop node should be present (code 903)'), false);
  assert.equal(isVehicleTypeRefusal('stop 007172492 is already ARRIVED'), false);
  assert.equal(isVehicleTypeRefusal('version conflict'), false);
  assert.equal(isVehicleTypeRefusal(null), false);
  // Named the field but made no complaint about it → not this refusal.
  assert.equal(isVehicleTypeRefusal('Vehicle Type changed'), false);
});

test('cancelHeaderVariant: omit drops the key entirely, clear nulls it, and neither mutates the echo', () => {
  const echo = { seqMode: 'None', loadId: HEX, vehicleType: 'TRAILER', weight: 9435, cutOffTime: null };
  const omitted = cancelHeaderVariant(echo, 'omit');
  assert.equal('vehicleType' in omitted, false, 'omit must remove the KEY, not blank it');
  assert.equal(omitted.weight, 9435, 'the rest of the echo survives untouched');
  assert.equal(omitted.cutOffTime, null, 'a present-but-null echo field stays null');
  const cleared = cancelHeaderVariant(echo, 'clear');
  assert.equal('vehicleType' in cleared, true);
  assert.equal(cleared.vehicleType, null);
  assert.equal(echo.vehicleType, 'TRAILER', 'the caller\'s header is never mutated');
  assert.equal(editHeaderHasVehicleType(echo), true);
  assert.equal(editHeaderHasVehicleType(omitted), false);
  assert.equal(editHeaderHasVehicleType(cleared), false);
  assert.equal(editHeaderHasVehicleType({ vehicleType: '  ' }), false);
});

// ── the ladder ───────────────────────────────────────────────────────────────

test('REGRESSION: a cancel NuVizz accepts is still ONE edit after ONE read — no ladder, no extra key on the step', async () => {
  const h = makeRequester({ edits: [{ ok: true }] });
  const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]));
  assert.equal(editCount(h), 1, 'an accepted cancel must not cost a second edit');
  assert.equal(infoCount(h), 1, 'and must not re-read the load');
  const step = r.loads[0].steps.find((s) => s.op === 'removeStops');
  assert.equal(step.ok, true);
  assert.equal(step.cancelledRoute, true);
  assert.equal('cancelAttempts' in step, false, 'no journal key appears on a cancel that just worked');
  assert.equal('cancelledDespiteRefusal' in step, false);
  // The one edit carried the echoed header, vehicleType and all — unchanged behaviour.
  assert.equal(h.editBodies()[0].loadHeader.vehicleType, 'TRAILER');
});

test('SEP 9, TRAILER 5: a Vehicle Type refusal re-reads once and retries WITHOUT the vehicleType key — and the route is cancelled', async () => {
  const h = makeRequester({ edits: [{ reason: VT_REFUSAL }, { ok: true }] });
  const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
  assert.equal(r.loads[0].ok, true);
  assert.equal(editCount(h), 2, 'the untouched echo first, then exactly one fallback');
  assert.equal(infoCount(h), 2, 'one re-read between them (a versionId that cannot be stale)');

  const [first, second] = h.editBodies();
  assert.equal(first.loadHeader.vehicleType, 'TRAILER', 'attempt one is the echo, byte-for-byte');
  assert.equal('vehicleType' in second.loadHeader, false, 'the retry sends no vehicleType key at all');
  assert.deepEqual(second.removeStopIds, HELD.map((n) => `id-${n}`), 'the same six deliveries come off');
  assert.equal(second.versionId, 'v2', 'the retry uses the RE-READ versionId, not the stale one');

  const step = r.loads[0].steps.find((s) => s.op === 'removeStops');
  assert.equal(step.ok, true);
  assert.equal(step.cancelledRoute, true, 'the board write-through gate still sees a cancel');
  assert.deepEqual(step.cancelAttempts.map((a) => a.shape), ['echo', 're-read', 'omit']);
  assert.deepEqual(step.cancelAttempts.map((a) => a.ok), [false, true, true]);
  assert.equal(step.cancelAttempts[0].error, VT_ERR, 'NuVizz\'s verbatim answer is journalled');
  assert.equal(step.cancelAttempts[2].sentVehicleType, '(omitted)');
});

test('omitted refused → the CLEARED (null) shape is tried, and it can be the one that lands', async () => {
  const h = makeRequester({ edits: [{ reason: VT_REFUSAL }, { reason: VT_REFUSAL }, { ok: true }] });
  const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
  assert.equal(r.loads[0].ok, true, JSON.stringify(r.loads[0].error));
  assert.equal(editCount(h), 3);
  const [, , third] = h.editBodies();
  assert.equal('vehicleType' in third.loadHeader, true);
  assert.equal(third.loadHeader.vehicleType, null, 'the last shape states "no type" outright');
  const step = r.loads[0].steps.find((s) => s.op === 'removeStops');
  assert.deepEqual(step.cancelAttempts.map((a) => a.shape), ['echo', 're-read', 'omit', 'clear']);
});

test('both fallbacks refused: the banner leads with the OUTCOME, keeps NuVizz\'s reason, and names Vehicle Type Configuration', async () => {
  const h = makeRequester({ edits: [{ reason: VT_REFUSAL }, { reason: VT_REFUSAL }, { reason: VT_REFUSAL }] });
  const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
  assert.equal(r.ok, false);
  const err = r.loads[0].error;
  assert.match(err, /refused to cancel TRAILER 5 \(DAVIS000203261\)/, 'names the route the way the card does');
  assert.match(err, /nothing was unplanned and it still holds all 6 orders/, 'the outcome, not just the cause');
  assert.match(err, /Vehicle Type unavailable or disabled/, 'NuVizz\'s own words survive');
  assert.match(err, /retried with the Vehicle Type omitted and then cleared/, 'says what was already tried');
  assert.match(err, /Vehicle Type Configuration in the portal/, 'and where the dispatcher fixes it');
  assert.equal(editCount(h), 3, 'the ladder stops — it never loops');
});

test('the ladder is NOT keyed on reason 903: the tenant\'s other 903 retries nothing', async () => {
  const h = makeRequester({ edits: [{ reason: 'Either PlanStop or Stop node should be present (code 903)' }] });
  const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(editCount(h), 1, 'no fallback is spent on a refusal a header shape cannot answer');
  assert.equal(infoCount(h), 1, 'and no re-read either');
  assert.match(r.loads[0].error, /still holds all 6 orders/);
  assert.match(r.loads[0].error, /re-Save, or cancel it in the portal/);
  assert.doesNotMatch(r.loads[0].error, /Vehicle Type/);
});

test('a PARTIAL remove never climbs the ladder — that route keeps living, so its header stays echoed verbatim', async () => {
  // Four of the six stay: this is a re-sequence with removes, not a cancel.
  const keep = HELD.slice(0, 4);
  const h = makeRequester({ edits: [{ reason: VT_REFUSAL }] });
  const r = await runCommitBoard(h.requester, {
    date: '2026-09-09',
    loads: [{ loadNbr: NBR, loadId: HEX, routeName: 'TRAILER 5', orderedStopNbrs: keep }],
  }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(editCount(h), 1, 'one edit only — a full-header REPLACE must not drop a key on a live route');
  assert.equal(h.editBodies()[0].loadHeader.vehicleType, 'TRAILER');
  const step = r.loads[0].steps.find((s) => s.op === 'removeStops');
  assert.equal('cancelAttempts' in step, false);
  assert.equal(r.loads[0].error, null, 'a partial remove keeps the old step-error reporting');
});

test('refused in words, EMPTY in fact: the re-read shows no deliveries, so the cancel LANDED', async () => {
  // NuVizz answers with a refusal but has already emptied the route. Report the system, never
  // the response — and spend nothing further proving it.
  const h = makeRequester({ edits: [{ reason: VT_REFUSAL }], stopsAfter: [] });
  const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
  assert.equal(r.ok, true, JSON.stringify(r.loads[0].error));
  assert.equal(editCount(h), 1, 'the read-back ends the ladder — no fallback shapes are fired');
  assert.equal(infoCount(h), 2);
  const step = r.loads[0].steps.find((s) => s.op === 'removeStops');
  assert.equal(step.ok, true);
  assert.equal(step.cancelledRoute, true);
  assert.equal(step.cancelledDespiteRefusal, true, 'the journal records that the words and the facts disagreed');
});

test('a refusal naming a Vehicle Type we never SENT is NuVizz\'s stored value — no calls are wasted, and the message says a re-Save cannot help', async () => {
  const h = makeRequester({ vehicleType: null, edits: [{ reason: VT_REFUSAL }] });
  const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(editCount(h), 1, 'nothing in the payload names a type — there is no shape left to try');
  assert.equal(infoCount(h), 2, 'the re-read still happens: it is what proves the header carried none');
  assert.match(r.loads[0].error, /still holds all 6 orders/);
  assert.match(r.loads[0].error, /STORED Vehicle Type/);
  assert.match(r.loads[0].error, /no re-Save can get past it/);
  assert.match(r.loads[0].error, /Vehicle Type Configuration in the portal/);
});

test('NUVIZZ_CANCEL_VT_FALLBACK=off restores the single-attempt behaviour exactly', async () => {
  await withLever('off', async () => {
    const h = makeRequester({ edits: [{ reason: VT_REFUSAL }, { ok: true }] });
    const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
    assert.equal(r.ok, false, 'the lever really does turn the recovery off');
    assert.equal(editCount(h), 1);
    assert.equal(infoCount(h), 1);
    const step = r.loads[0].steps.find((s) => s.op === 'removeStops');
    assert.equal('cancelAttempts' in step, false);
    assert.match(r.loads[0].error, /still holds all 6 orders/, 'the honest outcome line survives the lever');
  });
});

// ── the documented endpoint: POST /load/cancel (§Y) ──────────────────────────

async function withLoadCancelApi(value, fn) {
  const prev = process.env.NUVIZZ_LOAD_CANCEL_API;
  if (value === undefined) delete process.env.NUVIZZ_LOAD_CANCEL_API;
  else process.env.NUVIZZ_LOAD_CANCEL_API = value;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.NUVIZZ_LOAD_CANCEL_API; else process.env.NUVIZZ_LOAD_CANCEL_API = prev; }
}
const cancelCalls = (h) => h.calls.filter((c) => c.route === '/load/cancel').length;

test('load/cancel is OFF by default — four refusals end the ladder without ever calling it', async () => {
  const h = makeRequester({ edits: [{ reason: VT_REFUSAL }, { reason: VT_REFUSAL }, { reason: VT_REFUSAL }] });
  const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(cancelCalls(h), 0, 'an unproven destructive endpoint is never reached by default');
});

test('switched ON, load/cancel is the LAST rung — it runs only after every load/edit shape was refused, and it carries no header to refuse', async () => {
  await withLoadCancelApi('true', async () => {
    const h = makeRequester({
      edits: [{ reason: VT_REFUSAL }, { reason: VT_REFUSAL }, { reason: VT_REFUSAL }],
      stopAfterCancel: Object.fromEntries(HELD.map((n) => [n, { status: '10', holder: '' }])),   // unplanned
    });
    const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads[0].error));
    assert.equal(editCount(h), 3, 'the proven path is still tried first, in full');
    assert.equal(cancelCalls(h), 1);
    const body = h.cancelBodies()[0];
    assert.deepEqual(Object.keys(body).sort(), ['loadId', 'reasonCode', 'reasonComments']);
    assert.equal(body.loadId, HEX, 'the internal id, never the recurring route NAME');
    assert.equal('loadNbr' in body, false, 'ONE identifier on the wire for a destructive call');
    assert.equal(body.reasonCode, 'ADMIN');
    assert.equal('loadHeader' in body, false, 'no header — so a disabled Vehicle Type has nothing to refuse');
    const step = r.loads[0].steps.find((s) => s.op === 'removeStops');
    assert.equal(step.viaLoadCancelApi, true);
    assert.equal(step.orderFate, '6 unplanned', 'the read-back reports what the orders BECAME');
    assert.equal(step.cancelledRoute, true);
  });
});

test('if load/cancel cancels the ORDERS instead of unplanning them, that is a LOUD failure, never a clean cancel', async () => {
  // The open question the switch exists for. The API document says what becomes of the load
  // and nothing about the freight on it; the modal promises Un-Planned. If NuVizz takes the
  // orders with it, the Save must say so — not report a route cancelled and move on.
  await withLoadCancelApi('on', async () => {
    const h = makeRequester({
      edits: [{ reason: VT_REFUSAL }, { reason: VT_REFUSAL }, { reason: VT_REFUSAL }],
      stopAfterCancel: Object.fromEntries(HELD.map((n) => [n, { cancelledAt: '2026-09-09T14:02:00Z', holder: '' }])),
    });
    const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
    assert.equal(r.ok, false, 'a cancel that took the freight with it is NOT a success');
    assert.match(r.loads[0].error, /CANCELLED 6 ORDER\(S\) instead of unplanning them/);
    assert.match(r.loads[0].error, /turn NUVIZZ_LOAD_CANCEL_API off/);
    const step = r.loads[0].steps.find((s) => s.op === 'removeStops');
    assert.equal(step.orderFate, '6 cancelled');
  });
});

test('a refused load/cancel keeps the honest outcome line — nothing was unplanned', async () => {
  await withLoadCancelApi('true', async () => {
    const h = makeRequester({
      edits: [{ reason: VT_REFUSAL }, { reason: VT_REFUSAL }, { reason: VT_REFUSAL }],
      loadCancel: { ok: false, reason: 'Load is assigned to a driver and cannot be cancelled' },
    });
    const r = await runCommitBoard(h.requester, { date: '2026-09-09', loads: [cancelCard()] }, CREDS);
    assert.equal(r.ok, false);
    assert.equal(cancelCalls(h), 1);
    assert.match(r.loads[0].error, /still holds all 6 orders/);
    assert.match(r.loads[0].error, /assigned to a driver/, 'the LAST reason is the one reported');
  });
});
