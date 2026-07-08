// test/nuvizz-rwb.test.mjs — the Route Workbench (RWB) engine.
//
// Covers the RWB module (lib/nuvizz-rwb.mts) + the board engine runCommitBoardRwb
// (lib/nuvizz-write.mts), focused on the correctness fixes from the pre-prod review:
//   • env gating: rwbEngineBlocked / rwbConfigReady (no creds → refused up-front)
//   • rwbSequenceStops: 2-call happy path, <2-stop refusal, and — the key fix — a
//     HTTP-200 response carrying an application error body is treated as a FAILURE
//   • runCommitBoardRwb: a single-delivery load skips the sequence and SUCCEEDS
//     (membership is the whole change); a departure rides the proven removeStops op.
import test from 'node:test';
import assert from 'node:assert/strict';

import { rwbEngineBlocked, rwbConfigReady, rwbAddStopsToRoute, rwbSequenceStops } from '../netlify/functions/lib/nuvizz-rwb.mts';
import { runCommitBoardRwb } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const HEXID = '6a438e9d52ef82bd1ed4516b';

// Run `fn` with RWB fully configured (enabled + creds), restoring env afterward.
async function withRwb(over, fn) {
  const keys = ['NUVIZZ_RWB_ENABLED', 'NUVIZZ_RWB_USER', 'NUVIZZ_RWB_PASS', 'NUVIZZ_RWB_LOGIN_BASE', 'NUVIZZ_RWB_PORTAL_BASE'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    NUVIZZ_RWB_ENABLED: 'true', NUVIZZ_RWB_USER: 'Chad', NUVIZZ_RWB_PASS: 'pw',
    NUVIZZ_RWB_LOGIN_BASE: 'https://loginqa.nuvizz.com', NUVIZZ_RWB_PORTAL_BASE: 'https://uat.nuvizz.com',
    ...over,
  });
  try { return await fn(); }
  finally { for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

// A URL-routing requester that serves BOTH the v7 API and the RWB portal login/flow.
// `saveBody` lets a test control what saveComparedRouteData returns. `loadStops` is a
// mutable ref (array of stopNbrs) so a re-read after removeStops reflects the removal.
function makeRequester({ saveBody = { responseCode: 200 }, saveStatus = 200, loadStops } = {}) {
  const calls = [];
  const stopDoc = (n) => ({ stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: { seq: 1 } } });
  const loadJson = () => ({ Load: {
    loadHeader: { loadId: HEXID, loadNbr: 'DAVIS000000123', routeName: 'TEST', rtOrigin: { address: { latitude: 34.04, longitude: -83.71 } } },
    versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
    stops: (loadStops?.value ?? []).map((n, i) => ({ stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: { seq: i + 2 } } })),
  } });
  return {
    calls,
    requester: {
      async request(url, opts, meta) {
        const method = (opts.method || 'GET').toUpperCase();
        calls.push({ url, method, route: meta?.route });
        const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
        const T = (txt, status = 200) => new Response(txt, { status });
        // ── RWB portal login + flow (different hosts) ──
        if (url.includes('/loginreg/') && method === 'GET') {
          return T('<html><head><meta name="_csrf" content="tok123"><meta name="_csrf_header" content="X-CSRF-TOKEN"></head></html>');
        }
        if (url.includes('checkCompanyLogin')) return J({ ok: true });
        if (url.includes('auth/userLogin')) return J({ data: { jwtToken: 'jwt-abc' } });
        if (url.includes('/authtoken/')) return J({ authToken: 'authtok-xyz' });
        if (url.includes('validateStopstoPerformAction')) return T('Success');
        if (url.includes('addStopsToRouteAfterValidation')) {
          // Simulate the portal actually attaching the stops so the post-add verify re-read sees them.
          try {
            const sids = opts.body && opts.body.get ? String(opts.body.get('stopIds') || '') : '';
            for (const sid of sids.split(',').filter(Boolean)) { const n = sid.replace(/^id-/, ''); if (loadStops && !loadStops.value.includes(n)) loadStops.value.push(n); }
          } catch { /* no loadStops in unit tests */ }
          return J({ responseCode: 200, message: 'SUCCESS', stops: [] });
        }
        if (url.includes('fetchUpdatedJson')) {
          return J([{ etaStopVOList: [{ timeZone: 'America/New_York' }], distance: 10, duration: 20, schStartTime: { dttm: 'Jul 2, 2026' } }]);
        }
        if (url.includes('saveComparedRouteData')) return J(saveBody, saveStatus);
        // ── v7 API ──
        if (url.includes('/load/info/')) return J(loadJson());
        if (url.includes('/stop/info/')) {
          const n = url.split('/stop/info/')[1].split('/')[0];
          return J({ Stop: { stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO' }, load: { loadNbr: '' } } });
        }
        if (url.includes('/load/edit/')) return J({ status: 'SUCCESS' });        // removeStops
        if (url.includes('/load/insertstops/')) return J({ status: 'SUCCESS' });  // insertStops
        if (url.includes('/load/assignanddispatch/')) return J({ status: 'SUCCESS' });
        return J({});
      },
    },
  };
}

// ── env gating ──────────────────────────────────────────────────────────────

test('rwbEngineBlocked: true unless NUVIZZ_RWB_ENABLED is set truthy', async () => {
  const prev = process.env.NUVIZZ_RWB_ENABLED;
  delete process.env.NUVIZZ_RWB_ENABLED;
  assert.equal(rwbEngineBlocked(), true);
  process.env.NUVIZZ_RWB_ENABLED = 'true';
  assert.equal(rwbEngineBlocked(), false);
  if (prev === undefined) delete process.env.NUVIZZ_RWB_ENABLED; else process.env.NUVIZZ_RWB_ENABLED = prev;
});

test('rwbConfigReady: false when enabled but creds are missing', async () => {
  await withRwb({ NUVIZZ_RWB_USER: '', NUVIZZ_RWB_PASS: '' }, () => {
    assert.equal(rwbConfigReady(), false);
  });
  await withRwb({}, () => {
    assert.equal(rwbConfigReady(), true);
  });
});

// ── rwbSequenceStops ──────────────────────────────────────────────────────────

test('rwbSequenceStops: 2-call happy path returns ok with 2 calls', async () => {
  await withRwb({}, async () => {
    const { requester, calls } = makeRequester();
    const r = await rwbSequenceStops(requester, HEXID, ['id-A', 'id-B'], { lat: 34, lng: -83 });
    assert.equal(r.ok, true);
    assert.equal(r.calls, 2);
    assert.ok(calls.some((c) => c.url.includes('fetchUpdatedJson')));
    assert.ok(calls.some((c) => c.url.includes('saveComparedRouteData')));
  });
});

test('rwbSequenceStops: allows a single-stop route (HAR-verified), refuses zero', async () => {
  await withRwb({}, async () => {
    const one = makeRequester();
    const r1 = await rwbSequenceStops(one.requester, HEXID, ['id-A'], { lat: 34, lng: -83 });
    assert.equal(r1.ok, true, `1-stop route should save: ${r1.message}`);
    assert.ok(one.calls.some((c) => c.url.includes('saveComparedRouteData')));

    const zero = makeRequester();
    const r0 = await rwbSequenceStops(zero.requester, HEXID, [], { lat: 34, lng: -83 });
    assert.equal(r0.ok, false);
    assert.match(r0.message, /at least 1 stop/);
    assert.equal(zero.calls.length, 0);
  });
});

test('rwbAddStopsToRoute: adds N stops in TWO batched calls (one validate?routeId + one add)', async () => {
  await withRwb({}, async () => {
    const { requester, calls } = makeRequester();
    const r = await rwbAddStopsToRoute(requester, HEXID, ['id-A', 'id-B', 'id-C']);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.mode, 'batch');
    assert.equal(r.calls, 2, 'batch = 1 validate + 1 add, regardless of stop count');
    const val = calls.filter((c) => c.url.includes('validateStopstoPerformAction'));
    assert.equal(val.length, 1, 'ONE batched validate for all 3');
    assert.ok(val[0].url.includes('id-A,id-B,id-C') && val[0].url.includes('routeId='), 'validate carries all ids + routeId');
    assert.equal(calls.filter((c) => c.url.includes('addStopsToRouteAfterValidation')).length, 1, 'one batch add');
  });
});

test('rwbAddStopsToRoute: falls back to per-stop when the batched add is rejected', async () => {
  await withRwb({}, async () => {
    let firstAdd = true;
    const base = makeRequester();
    const real = base.requester.request;
    base.requester.request = async (url, opts, meta) => {
      if (url.includes('addStopsToRouteAfterValidation') && firstAdd) { firstAdd = false; return new Response(JSON.stringify({ responseCode: 500, message: 'batch not supported' }), { status: 200 }); }
      return real(url, opts, meta);
    };
    const r = await rwbAddStopsToRoute(base.requester, HEXID, ['id-A', 'id-B']);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.mode, 'batch-fallback');
    // 1 batched validate + 1 (rejected) batched add, then per-stop validate+add ×2.
    assert.equal(base.calls.filter((c) => c.url.includes('validateStopstoPerformAction')).length, 3, '1 batch + 2 per-stop validates');
  });
});

test('rwbSequenceStops: HTTP 200 with an application-error body is a FAILURE (okSave fix)', async () => {
  await withRwb({}, async () => {
    const { requester } = makeRequester({ saveStatus: 200, saveBody: { responseCode: 500, message: 'route locked' } });
    const r = await rwbSequenceStops(requester, HEXID, ['id-A', 'id-B'], { lat: 34, lng: -83 });
    assert.equal(r.ok, false);
    assert.match(r.message, /application error|responseCode 500|route locked/);
  });
});

test('rwbSequenceStops: refused when creds are unset (before any network call)', async () => {
  await withRwb({ NUVIZZ_RWB_USER: '', NUVIZZ_RWB_PASS: '' }, async () => {
    const { requester, calls } = makeRequester();
    const r = await rwbSequenceStops(requester, HEXID, ['id-A', 'id-B'], { lat: 34, lng: -83 });
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  });
});

// ── runCommitBoardRwb ─────────────────────────────────────────────────────────

test('runCommitBoardRwb: gated off when RWB disabled', async () => {
  const prev = process.env.NUVIZZ_RWB_ENABLED;
  delete process.env.NUVIZZ_RWB_ENABLED;
  const { requester, calls } = makeRequester();
  const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'X', orderedStopNbrs: ['A', 'B'] }] }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.gated, true);
  assert.equal(calls.length, 0);  // nothing fired
  if (prev === undefined) delete process.env.NUVIZZ_RWB_ENABLED; else process.env.NUVIZZ_RWB_ENABLED = prev;
});

test('runCommitBoardRwb: enabled but no creds → refused before any write', async () => {
  await withRwb({ NUVIZZ_RWB_USER: '', NUVIZZ_RWB_PASS: '' }, async () => {
    const { requester, calls } = makeRequester();
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A', 'B'] }] }, CREDS);
    assert.equal(r.ok, false);
    assert.equal(r.gated, true);
    assert.equal(calls.length, 0);  // NOT a single v7 membership write fired
  });
});

test('runCommitBoardRwb: single-delivery load saves via RWB (1 stop is valid)', async () => {
  await withRwb({}, async () => {
    // Load already carries [A]; the Save re-orders to [A] (one stop). RWB saves the 1-stop route.
    const loadStops = { value: ['A'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A'] }] }, CREDS);
    assert.equal(r.ok, true, `expected success, got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), true);
  });
});

test('runCommitBoardRwb: an arrival is added via the RWB portal (not v7 insertStops)', async () => {
  await withRwb({}, async () => {
    // Load carries [A]; user adds B (unplanned) → orderedStopNbrs=[A,B]. B is added the RWB way.
    const loadStops = { value: ['A'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A', 'B'] }] }, CREDS);
    assert.equal(r.ok, true, `expected success, got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    assert.equal(calls.some((c) => c.url.includes('addStopsToRouteAfterValidation')), true, 'arrival must be added via RWB portal');
    assert.equal(calls.some((c) => c.url.includes('/load/insertstops/')), false, 'must NOT use v7 insertStops');
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), true);
  });
});

test('runCommitBoardRwb: client-supplied orderedStopIds skip the per-stop getStop (portal-scale path)', async () => {
  await withRwb({}, async () => {
    // Load already has X; add A,B,C as arrivals passing their ids → engine resolves without any
    // getStop (non-empty load, so no retarget probe either), and adds via the batched validate+add.
    const loadStops = { value: ['X'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{
      loadNbr: 'DAVIS000000123', loadId: HEXID, routeName: 'R',
      orderedStopNbrs: ['X', 'A', 'B', 'C'], orderedStopIds: ['id-X', 'id-A', 'id-B', 'id-C'],
    }] }, CREDS);
    assert.equal(r.ok, true, `expected success, got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    assert.equal(calls.some((c) => c.url.includes('/stop/info/')), false, 'no getStop when ids are supplied');
    assert.equal(calls.filter((c) => c.url.includes('addStopsToRouteAfterValidation')).length, 1, 'one batched add');
    const val = calls.filter((c) => c.url.includes('validateStopstoPerformAction'));
    assert.equal(val.length, 1, 'one batched validate');
    assert.ok(val[0].url.includes('routeId='), 'validate carries routeId');
  });
});

test('runCommitBoardRwb: fails loudly when an add silently no-ops (stop planned elsewhere, never lands)', async () => {
  await withRwb({}, async () => {
    // addStopsToRouteAfterValidation returns SUCCESS but the stop never appears on the load (the
    // portal no-ops a stop already planned on another route). The post-add verify must catch it.
    const loadStops = { value: ['X'] };
    const base = makeRequester({ loadStops });
    const real = base.requester.request;
    base.requester.request = async (url, opts, meta) => {
      if (url.includes('addStopsToRouteAfterValidation')) return new Response(JSON.stringify({ responseCode: 200, message: 'SUCCESS' }), { status: 200 }); // ok, but does NOT add
      return real(url, opts, meta);
    };
    const r = await runCommitBoardRwb(base.requester, { loads: [{
      loadNbr: 'DAVIS000000123', loadId: HEXID, routeName: 'R',
      orderedStopNbrs: ['X', 'A'], orderedStopIds: ['id-X', 'id-A'],
    }] }, CREDS);
    assert.equal(r.ok, false, 'must NOT report success when the stop never landed');
    assert.match(r.loads[0].error, /still planned on another load|couldn't be added|unplan it/i);
    assert.equal(base.calls.some((c) => c.url.includes('saveComparedRouteData')), false, 'must not persist a route missing the stop');
  });
});

test('runCommitBoardRwb: retargets to the same-named instance that holds the stops (duplicate recurring load)', async () => {
  await withRwb({}, async () => {
    // Two loads named DARYL: the opened one (EMPTY_ID) is empty; the twin (FULL) holds A,B.
    // The board opened the empty twin; the save must retarget to FULL and reorder there.
    const EMPTY_ID = '6a4778d0461cf601d983b6bf', FULL_ID = 'aa11bb22cc33dd44ee55ff66';
    const calls = [];
    const loadDoc = (id, name, stops) => ({ Load: {
      loadHeader: { loadId: id, loadNbr: name === 'DARYL_EMPTY' ? 'LOAD113177' : 'LOAD112852', routeName: 'DARYL', rtOrigin: { address: { latitude: 34, longitude: -83 } } },
      versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
      stops: stops.map((n, i) => ({ stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: { seq: i + 2 } } })),
    } });
    const requester = { async request(url, opts) {
      const method = (opts.method || 'GET').toUpperCase(); calls.push({ url, method });
      const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
      const T = (t) => new Response(t, { status: 200 });
      if (url.includes('/loginreg/') && method === 'GET') return T('<meta name="_csrf" content="x"><meta name="_csrf_header" content="X-CSRF-TOKEN">');
      if (url.includes('checkCompanyLogin')) return J({ ok: true });
      if (url.includes('auth/userLogin')) return J({ data: { jwtToken: 'j' } });
      if (url.includes('/authtoken/')) return J({ authToken: 't' });
      if (url.includes('validateStopstoPerformAction')) return T('Success');
      if (url.includes('addStopsToRouteAfterValidation')) return J({ responseCode: 200, message: 'SUCCESS' });
      if (url.includes('fetchUpdatedJson')) return J([{ etaStopVOList: [{ timeZone: 'America/New_York' }], distance: 1, duration: 1, schStartTime: { dttm: 'Jul 2, 2026' } }]);
      if (url.includes('saveComparedRouteData')) return J({ responseCode: 200, message: 'SUCCESS' });
      if (url.includes('/load/info/LOAD113177')) return J(loadDoc(EMPTY_ID, 'DARYL_EMPTY', []));
      if (url.includes('/load/info/LOAD112852')) return J(loadDoc(FULL_ID, 'DARYL_FULL', ['A', 'B']));
      if (url.includes('/stop/info/')) { const n = url.split('/stop/info/')[1].split('/')[0]; return J({ Stop: { stop: { stopId: `id-${n}`, stopNbr: n, stopType: 'DO' }, load: { loadNbr: 'LOAD112852' } } }); }
      return J({});
    } };
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'LOAD113177', loadId: EMPTY_ID, routeName: 'DARYL', orderedStopNbrs: ['B', 'A'] }] }, CREDS);
    assert.equal(r.ok, true, `expected retarget+reorder to succeed, got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    // Retarget step recorded, and NO stops added the RWB way (they're already on the full twin).
    const steps = r.loads[0].steps || [];
    assert.ok(steps.some((s) => s.op === 'retargetInstance' && s.to === 'LOAD112852'), 'should record a retarget to the full instance');
    assert.equal(calls.some((c) => c.url.includes('addStopsToRouteAfterValidation')), false, 'no arrivals — stops already on the retargeted load');
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), true);
  });
});

test('runCommitBoardRwb: refuses when the load carries a stop the board is not showing (stale-board guard)', async () => {
  await withRwb({}, async () => {
    // Load actually carries [A,B,C]; the board only knows [A,B] and reorders to [B,A] without
    // removing C. A declarative save of [B,A] would silently unplan C — the guard must refuse.
    const loadStops = { value: ['A', 'B', 'C'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['B', 'A'] }] }, CREDS);
    assert.equal(r.ok, false);
    assert.match(r.loads[0].error, /board isn't showing|unplan them|Refresh/i);
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), false, 'nothing should be saved when the guard trips');
  });
});

test('runCommitBoardRwb: a departure is removed by save-omission (no v7 load/edit)', async () => {
  await withRwb({}, async () => {
    // Load carries [A,B]; user drops B → orderedStopNbrs=[A]. RWB removes B by OMITTING it from
    // the declarative save — no v7 removeStops (load/edit) call.
    const loadStops = { value: ['A', 'B'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A'], removeStopNbrs: ['B'] }] }, CREDS);
    assert.equal(r.ok, true, `expected success, got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    assert.equal(calls.some((c) => c.url.includes('/load/edit/')), false, 'must NOT use v7 removeStops');
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), true, 'removal is via the declarative save');
  });
});

// ── cross-load move: the stale-board guard must be BATCH-AWARE ─────────────────
// A move (drag / move-menu / "→ LOAD") reduces the SOURCE load's orderedStopNbrs but does NOT
// populate removeStopNbrs, so the moved stop is still physically on the source at classification
// time. Without batch-awareness the guard flagged it as an orphan and refused the source, cascading
// a failure to the destination — the "moved one to the other route and it did not work" bug.

// Two distinct loads, each with a MUTABLE stop list, routed by loadNbr (load/info) and by routePlanId
// (the addStopsToRouteAfterValidation body) so a post-add re-read reflects the arrival.
function makeMoveRequester(loads) {
  const calls = [];
  const byId = {};
  for (const [nbr, v] of Object.entries(loads)) byId[v.loadId] = { nbr, v };
  const loadJson = (nbr) => { const v = loads[nbr]; return { Load: {
    loadHeader: { loadId: v.loadId, loadNbr: nbr, routeName: nbr, rtOrigin: { address: { latitude: 34.04, longitude: -83.71 } } },
    versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
    stops: v.stops.map((n, i) => ({ stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: { seq: i + 2 } } })),
  } }; };
  return { calls, requester: { async request(url, opts, meta) {
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ url, method, route: meta?.route });
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    const T = (t) => new Response(t, { status: 200 });
    if (url.includes('/loginreg/') && method === 'GET') return T('<meta name="_csrf" content="x"><meta name="_csrf_header" content="X-CSRF-TOKEN">');
    if (url.includes('checkCompanyLogin')) return J({ ok: true });
    if (url.includes('auth/userLogin')) return J({ data: { jwtToken: 'j' } });
    if (url.includes('/authtoken/')) return J({ authToken: 't' });
    if (url.includes('validateStopstoPerformAction')) return T('Success');
    if (url.includes('addStopsToRouteAfterValidation')) {
      try {
        const rp = opts.body?.get ? String(opts.body.get('routePlanId') || '') : '';
        const sids = opts.body?.get ? String(opts.body.get('stopIds') || '') : '';
        const tgt = byId[rp];
        if (tgt) for (const sid of sids.split(',').filter(Boolean)) { const n = sid.replace(/^id-/, ''); if (!tgt.v.stops.includes(n)) tgt.v.stops.push(n); }
      } catch { /* ignore */ }
      return J({ responseCode: 200, message: 'SUCCESS' });
    }
    if (url.includes('fetchUpdatedJson')) return J([{ etaStopVOList: [{ timeZone: 'America/New_York' }], distance: 1, duration: 1, schStartTime: { dttm: 'Jul 2, 2026' } }]);
    if (url.includes('saveComparedRouteData')) return J({ responseCode: 200, message: 'SUCCESS' });
    const m = url.match(/\/load\/info\/([^/?]+)/);
    if (m) { const nbr = decodeURIComponent(m[1]); return loads[nbr] ? J(loadJson(nbr)) : J({}, 404); }
    if (url.includes('/stop/info/')) { const n = url.split('/stop/info/')[1].split('/')[0]; return J({ Stop: { stop: { stopId: `id-${n}`, stopNbr: n, stopType: 'DO' }, load: { loadNbr: '' } } }); }
    return J({});
  } } };
}

test('runCommitBoardRwb: cross-load move is NOT falsely refused by the stale-board guard (batch-aware)', async () => {
  await withRwb({}, async () => {
    // L1 holds [A,B]; L2 holds [C]. Move B from L1 → L2. The move reduces L1's ordered list but sends
    // NO removeStopNbrs; B is still on L1 in NuVizz at classification time. The guard must recognize B
    // as claimed by L2 (in-batch) — not an orphan — and must NOT refuse L1.
    const L1 = { loadId: '1111aaaa2222bbbb3333cccc', stops: ['A', 'B'] };
    const L2 = { loadId: '4444dddd5555eeee6666ffff', stops: ['C'] };
    const { requester, calls } = makeMoveRequester({ DAVISL1: L1, DAVISL2: L2 });
    const r = await runCommitBoardRwb(requester, { loads: [
      { loadNbr: 'DAVISL1', loadId: L1.loadId, routeName: 'L1', orderedStopNbrs: ['A'], orderedStopIds: ['id-A'] },
      { loadNbr: 'DAVISL2', loadId: L2.loadId, routeName: 'L2', orderedStopNbrs: ['C', 'B'], orderedStopIds: ['id-C', 'id-B'] },
    ] }, CREDS);
    assert.equal(r.ok, true, `move should not be refused; got: ${JSON.stringify(r.loads?.map((l) => l.error))}`);
    assert.ok(!r.loads.some((l) => /board isn't showing/i.test(l.error || '')), 'no false stale-board refusal on the source');
    assert.ok(L2.stops.includes('B'), 'B moved onto L2 (added the RWB way)');
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), true, 'the move persists via the declarative save');
    assert.equal(calls.some((c) => c.url.includes('/load/insertstops/')), false, 'no v7 insertStops');
  });
});

test('runCommitBoardRwb: batch-aware guard STILL refuses a true orphan (not claimed by any in-batch load)', async () => {
  await withRwb({}, async () => {
    // L1 actually holds [A,B,X]; the board reorders L1 to [B,A] and L2 (independent) plans [C]. X is on
    // NO load's ordered list — a genuine orphan a declarative save would silently unplan. Must refuse L1.
    const L1 = { loadId: '1111aaaa2222bbbb3333cccc', stops: ['A', 'B', 'X'] };
    const L2 = { loadId: '4444dddd5555eeee6666ffff', stops: ['C'] };
    const { requester } = makeMoveRequester({ DAVISL1: L1, DAVISL2: L2 });
    const r = await runCommitBoardRwb(requester, { loads: [
      { loadNbr: 'DAVISL1', loadId: L1.loadId, routeName: 'L1', orderedStopNbrs: ['B', 'A'], orderedStopIds: ['id-B', 'id-A'] },
      { loadNbr: 'DAVISL2', loadId: L2.loadId, routeName: 'L2', orderedStopNbrs: ['C'], orderedStopIds: ['id-C'] },
    ] }, CREDS);
    const l1 = r.loads.find((l) => l.loadNbr === 'DAVISL1');
    assert.equal(r.ok, false, 'overall save fails when the source carries a true orphan');
    assert.equal(l1.ok, false, 'the source with a true orphan (X) must still be refused');
    assert.match(l1.error, /board isn't showing|unplan them|Refresh/i);
  });
});
