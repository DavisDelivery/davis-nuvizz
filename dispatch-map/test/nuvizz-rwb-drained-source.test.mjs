// test/nuvizz-rwb-drained-source.test.mjs — emptying a route INTO other routes, in one Save.
//
// The Sep 8 2026 Save (Chad): every order off TERRANCE (DAVIS000203132) onto ALLEN C
// (DAVIS000203183), LANDMARK to Un-Planned, AMMERAAL off ALLEN C, Save. Nothing moved:
//   "TERRANCE: Vehicle Type unavailable or disabled … (code 903) | ALLEN C: stop 007172492
//    couldn't be added to ALLEN C — NuVizz still holds it on TERRANCE … (RWB can't pull a stop
//    off a route that isn't part of the Save)"
// The empty card ran the classic cancel FIRST (load/edit remove-all — a full-header echo NuVizz
// refused for the route's disabled Vehicle Type), and ALLEN C's arrivals then fired as plain adds
// against stops TERRANCE still held (NuVizz silently no-ops those). These tests pin the rule that
// replaces it: the moves ride the ONE atomic multi-route save (the source's entry drained to what
// stays — never 0 stops inside the save), both sides are verified, and only THEN is the drained
// route cancelled. A refused cancel costs the cancel — never the moves — and says so by name.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runCommitBoardRwb } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const T_ID = '1111aaaa2222bbbb3333cccc';
const A_ID = '4444dddd5555eeee6666ffff';
const TERRANCE = 'DAVIS000203132';
const ALLEN = 'DAVIS000203183';

async function withRwb(over, fn) {
  const keys = ['NUVIZZ_RWB_ENABLED', 'NUVIZZ_RWB_USER', 'NUVIZZ_RWB_PASS', 'NUVIZZ_RWB_LOGIN_BASE', 'NUVIZZ_RWB_PORTAL_BASE', 'NUVIZZ_RWB_SETTLE_MS', 'NUVIZZ_RWB_DRAIN_SOURCE'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    NUVIZZ_RWB_ENABLED: 'true', NUVIZZ_RWB_USER: 'Chad', NUVIZZ_RWB_PASS: 'pw',
    NUVIZZ_RWB_LOGIN_BASE: 'https://loginqa.nuvizz.com', NUVIZZ_RWB_PORTAL_BASE: 'https://uat.nuvizz.com',
    NUVIZZ_RWB_SETTLE_MS: '5',
    ...over,
  });
  try { return await fn(); }
  finally { for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

// The vendor's truth: a mutable world of loads. A stop lives on ONE load. The portal's declarative
// save sets each saved route to exactly its entry (a stop entering a route leaves the one that held
// it); addStopsToRouteAfterValidation NO-OPS a stop planned elsewhere (verified live — the very
// behaviour that bit the Sep 8 Save); load/edit remove-all cancels the load, unless `editResponse`
// scripts a refusal (then nothing is applied, exactly like NuVizz's 903).
function makeWorld(loads, { editResponse = null, execStatus = {} } = {}) {
  const calls = [];
  const byId = {};
  for (const [nbr, v] of Object.entries(loads)) byId[v.loadId] = { nbr, v };
  const holderOf = (n) => Object.entries(loads).find(([, v]) => !v.cancelled && v.stops.includes(n))?.[0] || '';
  const loadJson = (nbr) => { const v = loads[nbr]; return { Load: {
    loadHeader: { loadId: v.loadId, loadNbr: nbr, routeName: v.routeName || nbr, vehicleType: v.vehicleType ?? 'BOX', rtOrigin: { address: { latitude: 34.04, longitude: -83.71 } } },
    versionId: `v${v.version || 1}`, loadExecutionInfo: { loadStatus: v.cancelled ? 'CANCELLED' : 'PLANNED' },
    stops: v.stops.map((n, i) => ({
      stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO', to: { seq: i + 2 }, weight: 100, totalPallets: 2, totalCartons: 1, volume: 3 },
      ...(execStatus[n] ? { stopExecutionInfo: { stopStatus: execStatus[n] } } : {}),
    })),
  } }; };
  const form = (opts, k) => (opts.body && typeof opts.body.get === 'function') ? String(opts.body.get(k) || '') : '';
  const requester = { async request(url, opts, meta) {
    const method = (opts.method || 'GET').toUpperCase();
    const rec = { url, method, route: meta?.route };
    calls.push(rec);
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    const T = (t) => new Response(t, { status: 200 });
    if (url.includes('/loginreg/') && method === 'GET') return T('<meta name="_csrf" content="x"><meta name="_csrf_header" content="X-CSRF-TOKEN">');
    if (url.includes('checkCompanyLogin')) return J({ ok: true });
    if (url.includes('auth/userLogin')) return J({ data: { jwtToken: 'j' } });
    if (url.includes('/authtoken/')) return J({ authToken: 't' });
    if (url.includes('saveRwbPreference')) return J({ ok: true });
    if (url.includes('validateStopstoPerformAction')) return T('Success');
    if (url.includes('addStopsToRouteAfterValidation')) {
      const tgt = byId[form(opts, 'routePlanId')];
      const ids = form(opts, 'stopIds').split(',').filter(Boolean);
      rec.stopIds = ids;
      if (tgt) for (const sid of ids) {
        const n = sid.replace(/^id-/, '');
        if (holderOf(n)) continue;   // planned elsewhere → the vendor's silent no-op
        if (!tgt.v.stops.includes(n)) tgt.v.stops.push(n);
      }
      return J({ responseCode: 200, message: 'SUCCESS' });
    }
    if (url.includes('fetchUpdatedJson')) return J([{ etaStopVOList: [{ timeZone: 'America/New_York' }], distance: 1, duration: 1, schStartTime: { dttm: 'Sep 8, 2026' } }]);
    if (url.includes('resequenceRoute')) return J({ responseCode: 200, message: 'SUCCESS' });
    if (url.includes('saveComparedRouteData')) {
      const entries = JSON.parse(form(opts, 'routeJsonData') || '[]');
      rec.entries = entries.map((e) => ({ routePlanId: String(e.routePlanId), stops: [...new Set((e.tripDataJsonArray || []).map((id) => String(id).replace(/^id-/, '')))] }));
      for (const e of rec.entries) {
        const tgt = byId[e.routePlanId];
        if (!tgt) continue;
        for (const n of e.stops) for (const other of Object.values(loads)) if (other !== tgt.v) other.stops = other.stops.filter((x) => x !== n);
        tgt.v.stops = e.stops.slice();
      }
      return J({ responseCode: 200, message: 'SUCCESS' });
    }
    const m = url.match(/\/load\/info\/([^/?]+)/);
    if (m) { const nbr = decodeURIComponent(m[1]); return loads[nbr] ? J(loadJson(nbr)) : J({}, 404); }
    if (url.includes('/stop/info/')) {
      const n = decodeURIComponent(url.split('/stop/info/')[1].split('/')[0]);
      return J({ Stop: { stop: { stopId: `id-${n}`, stopNbr: n, stopType: 'DO' }, load: { loadNbr: holderOf(n) } } });
    }
    if (url.includes('/load/edit/')) {
      const body = JSON.parse(String(opts.body || '{}'));
      const tgt = byId[String(body?.loadHeader?.loadId || '')];
      rec.removeStopIds = (body?.removeStopIds || []).map(String);
      rec.loadNbr = tgt?.nbr;
      if (editResponse) { const r = editResponse(tgt?.nbr, body); if (r) return r; }
      if (tgt) {
        const rm = new Set(rec.removeStopIds.map((id) => id.replace(/^id-/, '')));
        tgt.v.stops = tgt.v.stops.filter((n) => !rm.has(n));
        if (!tgt.v.stops.length) tgt.v.cancelled = true;
        tgt.v.version = (tgt.v.version || 1) + 1;
      }
      return J({ status: 'SUCCESS' });
    }
    if (url.includes('/load/insertstops/')) return J({ status: 'SUCCESS' });
    if (url.includes('/load/assignanddispatch/')) return J({ status: 'SUCCESS' });
    return J({});
  } };
  return { calls, loads, holderOf, requester };
}

// NuVizz's actual refusal of the Sep 8 cancel (the toast's text, code 903 via reasons[]).
const VEHICLE_TYPE_903 = () => new Response(JSON.stringify({
  reasons: [{ reasonCode: 903, description: `Vehicle Type unavailable or disabled. Please verify Vehicle Type in Vehicle Type Configuration for ${TERRANCE}` }],
}), { status: 400 });

const idx = (calls, pred) => calls.findIndex(pred);
const isSave = (c) => c.url.includes('saveComparedRouteData');
const isEdit = (c) => c.url.includes('/load/edit/');
const isAdd = (c) => c.url.includes('addStopsToRouteAfterValidation');
const isValidate = (c) => c.url.includes('validateStopstoPerformAction');
const isPortal = (c) => /loginreg|checkCompanyLogin|userLogin|authtoken|dirouteworkbench/.test(c.url);

// The Sep 8 board: TERRANCE holds four orders bound for ALLEN C plus LANDMARK (struck to
// Un-Planned); ALLEN C holds one of its own plus AMMERAAL (struck to Un-Planned).
const MOVING = ['007172492', '007173032', '007172963', '007172908'];
const ALLEN_ORDER = [...MOVING, '007172967'];
const sep8World = () => ({
  [TERRANCE]: { loadId: T_ID, routeName: 'TERRANCE', stops: [...MOVING, 'LANDMARK'] },
  [ALLEN]: { loadId: A_ID, routeName: 'ALLEN C', stops: ['007172967', 'AMMERAAL'] },
});
const sep8Payload = () => ({ date: '2026-09-08', loads: [
  { loadNbr: TERRANCE, loadId: T_ID, routeName: 'TERRANCE', emptyLoad: true, orderedStopNbrs: [], removeStopNbrs: ['LANDMARK'] },
  { loadNbr: ALLEN, loadId: A_ID, routeName: 'ALLEN C', orderedStopNbrs: ALLEN_ORDER, removeStopNbrs: ['AMMERAAL'] },
] });

test('Sep 8 TERRANCE → ALLEN C: the moves ride the ONE atomic save (source drained to what stays), THEN the drained route is cancelled — no adds, no cancel-first', async () => {
  await withRwb({}, async () => {
    const { requester, calls, loads, holderOf } = makeWorld(sep8World());
    const r = await runCommitBoardRwb(requester, sep8Payload(), CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads.map((l) => l.error)));
    assert.deepEqual(loads[ALLEN].stops, ALLEN_ORDER, 'ALLEN C ends with exactly the card order');
    assert.equal(loads[TERRANCE].cancelled, true, 'TERRANCE is cancelled');
    assert.deepEqual(loads[TERRANCE].stops, [], 'nothing left on TERRANCE');
    assert.equal(holderOf('LANDMARK'), '', 'LANDMARK is Un-Planned');
    assert.equal(holderOf('AMMERAAL'), '', 'AMMERAAL is Un-Planned');
    const saves = calls.filter(isSave);
    assert.equal(saves.length, 1, 'exactly ONE combined save');
    assert.deepEqual(saves[0].entries.find((e) => e.routePlanId === T_ID).stops, ['LANDMARK'], "TERRANCE's entry keeps only what nobody is taking — never 0 stops inside the save");
    assert.deepEqual(saves[0].entries.find((e) => e.routePlanId === A_ID).stops, ALLEN_ORDER, "ALLEN C's entry is the card order");
    assert.equal(calls.some(isAdd), false, 'a move fires NO add');
    assert.equal(calls.some(isValidate), false, 'a move fires NO validate');
    const iSave = idx(calls, isSave); const iEdit = idx(calls, isEdit);
    assert.ok(iEdit > iSave, 'the cancel runs AFTER the atomic save');
    assert.deepEqual(calls[iEdit].removeStopIds, ['id-LANDMARK'], 'the cancel removes only what stayed');
    assert.equal(calls.filter(isEdit).length, 1, 'one cancel');
    const t = r.loads.find((l) => l.loadNbr === TERRANCE); const a = r.loads.find((l) => l.loadNbr === ALLEN);
    assert.equal(r.loads.length, 2, 'one result per card');
    assert.equal(a.ok, true); assert.equal(t.ok, true);
    assert.equal(t.steps.find((s) => s.op === 'removeStops')?.cancelledRoute, true, 'the source result carries the confirmed cancel (the client closes the card on it)');
    assert.ok(t.steps.some((s) => String(s.op).startsWith('rwb:')), 'and the atomic-save steps');
    assert.equal(t.requestedLoadNbr, TERRANCE, 'joins back to the card the client sent');
  });
});

test('Sep 8, as it actually went — NuVizz refuses the cancel (Vehicle Type, 903): the orders STILL land on ALLEN C; TERRANCE lingers with LANDMARK and says exactly why', async () => {
  await withRwb({}, async () => {
    const { requester, calls, loads } = makeWorld(sep8World(), { editResponse: (nbr) => (nbr === TERRANCE ? VEHICLE_TYPE_903() : null) });
    const r = await runCommitBoardRwb(requester, sep8Payload(), CREDS);
    assert.equal(r.ok, false, 'the Save is not green — the cancel did not land');
    const t = r.loads.find((l) => l.loadNbr === TERRANCE); const a = r.loads.find((l) => l.loadNbr === ALLEN);
    assert.equal(a.ok, true, `the consolidation landed regardless: ${a.error}`);
    assert.deepEqual(loads[ALLEN].stops, ALLEN_ORDER, 'ALLEN C has every order in the card order');
    assert.equal(t.ok, false);
    assert.match(t.error, /Vehicle Type/, "NuVizz's own reason is surfaced");
    assert.match(t.error, /code 903/);
    assert.match(t.error, /moved to ALLEN C/, 'says the moves landed');
    assert.match(t.error, /still holds LANDMARK/, 'names what is left on the route');
    assert.match(t.error, /Vehicle Type Configuration/, 'and where to fix it');
    assert.deepEqual(loads[TERRANCE].stops, ['LANDMARK'], 'TERRANCE keeps only what stayed — not cancelled');
    assert.notEqual(loads[TERRANCE].cancelled, true);
    assert.equal(calls.some(isAdd), false, 'no doomed adds');
    assert.equal(calls.some(isValidate), false);
    assert.equal(/isn't part of the Save/.test(String(a.error) + String(t.error)), false, 'never blames a route that IS in the Save');
  });
});

test('every order is leaving: the last one anchors the source through the atomic save, then rides validate+add once the cancel freed it; the taker verifies its FULL order', async () => {
  await withRwb({}, async () => {
    const { requester, calls, loads } = makeWorld({
      [TERRANCE]: { loadId: T_ID, routeName: 'TERRANCE', stops: ['X1', 'X2', 'X3'] },
      [ALLEN]: { loadId: A_ID, routeName: 'ALLEN C', stops: ['A1'] },
    });
    const r = await runCommitBoardRwb(requester, { loads: [
      { loadNbr: TERRANCE, loadId: T_ID, routeName: 'TERRANCE', emptyLoad: true, orderedStopNbrs: [], removeStopNbrs: [] },
      { loadNbr: ALLEN, loadId: A_ID, routeName: 'ALLEN C', orderedStopNbrs: ['A1', 'X1', 'X2', 'X3'] },
    ] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads.map((l) => l.error)));
    assert.deepEqual(loads[ALLEN].stops, ['A1', 'X1', 'X2', 'X3']);
    assert.equal(loads[TERRANCE].cancelled, true);
    const saves = calls.filter(isSave);
    assert.equal(saves.length, 2, 'the atomic save, then the anchor re-sequence');
    assert.deepEqual(saves[0].entries.find((e) => e.routePlanId === T_ID).stops, ['X3'], 'the tail of the taker’s order anchors the source');
    assert.deepEqual(saves[0].entries.find((e) => e.routePlanId === A_ID).stops, ['A1', 'X1', 'X2'], 'the taker’s entry leaves the anchor out — it cannot be in two entries');
    assert.deepEqual(saves[1].entries.find((e) => e.routePlanId === A_ID).stops, ['A1', 'X1', 'X2', 'X3'], 'the re-sequence sets the full order');
    const iSave = idx(calls, isSave); const iEdit = idx(calls, isEdit); const iAdd = idx(calls, isAdd);
    assert.ok(iSave < iEdit && iEdit < iAdd, `save → cancel → add, in that order (got ${iSave}, ${iEdit}, ${iAdd})`);
    assert.deepEqual(calls[iEdit].removeStopIds, ['id-X3'], 'the cancel frees the anchor');
    assert.deepEqual(calls[iAdd].stopIds, ['id-X3'], 'and only the anchor is added');
    assert.equal(calls.filter(isAdd).length, 1);
  });
});

test('every order is leaving AND the cancel is refused: the taker reports the ONE stop left behind by name, carries the order that DID land for the board, and never claims success', async () => {
  await withRwb({}, async () => {
    const { requester, calls, loads } = makeWorld({
      [TERRANCE]: { loadId: T_ID, routeName: 'TERRANCE', stops: ['X1', 'X2', 'X3'] },
      [ALLEN]: { loadId: A_ID, routeName: 'ALLEN C', stops: ['A1'] },
    }, { editResponse: (nbr) => (nbr === TERRANCE ? VEHICLE_TYPE_903() : null) });
    const r = await runCommitBoardRwb(requester, { loads: [
      { loadNbr: TERRANCE, loadId: T_ID, routeName: 'TERRANCE', emptyLoad: true, orderedStopNbrs: [], removeStopNbrs: [] },
      { loadNbr: ALLEN, loadId: A_ID, routeName: 'ALLEN C', orderedStopNbrs: ['A1', 'X1', 'X2', 'X3'] },
    ] }, CREDS);
    assert.equal(r.ok, false);
    const t = r.loads.find((l) => l.loadNbr === TERRANCE); const a = r.loads.find((l) => l.loadNbr === ALLEN);
    assert.equal(a.ok, false, 'three of four is not success');
    assert.match(a.error, /3 of 4 stop\(s\) landed on ALLEN C/);
    assert.match(a.error, /stop X3 is still on TERRANCE/);
    assert.match(a.error, /Vehicle Type/, "carries the source's reason");
    assert.deepEqual(a.observedOrder, ['A1', 'X1', 'X2'], 'the board gets the truth that landed');
    assert.equal(t.ok, false); assert.match(t.error, /code 903/);
    assert.deepEqual(loads[ALLEN].stops, ['A1', 'X1', 'X2']);
    assert.deepEqual(loads[TERRANCE].stops, ['X3']);
    assert.equal(calls.some(isAdd), false, 'no add against a stop the refused route still holds');
  });
});

test('a claimed order the driver already acted on refuses BEFORE any write — no save, no cancel — and the taker is refused with the source’s reason (no wasted adds)', async () => {
  await withRwb({}, async () => {
    const { requester, calls } = makeWorld({
      [TERRANCE]: { loadId: T_ID, routeName: 'TERRANCE', stops: ['X1', 'X2', 'LANDMARK'] },
      [ALLEN]: { loadId: A_ID, routeName: 'ALLEN C', stops: ['A1'] },
    }, { execStatus: { X2: 'ARRIVED' } });
    const r = await runCommitBoardRwb(requester, { loads: [
      { loadNbr: TERRANCE, loadId: T_ID, routeName: 'TERRANCE', emptyLoad: true, orderedStopNbrs: [], removeStopNbrs: ['LANDMARK'] },
      { loadNbr: ALLEN, loadId: A_ID, routeName: 'ALLEN C', orderedStopNbrs: ['A1', 'X1', 'X2'] },
    ] }, CREDS);
    assert.equal(r.ok, false);
    const t = r.loads.find((l) => l.loadNbr === TERRANCE); const a = r.loads.find((l) => l.loadNbr === ALLEN);
    assert.equal(t.ok, false); assert.match(t.error, /X2 on DAVIS000203132 is already ARRIVED/);
    assert.equal(a.ok, false); assert.match(a.error, /TERRANCE \(DAVIS000203132\), which FAILED this Save/); assert.match(a.error, /nothing was written for ALLEN C/);
    assert.equal(calls.some(isSave), false, 'no save');
    assert.equal(calls.some(isEdit), false, 'no cancel');
    assert.equal(calls.some(isAdd) || calls.some(isValidate), false, 'no adds');
  });
});

test('regression: a plain Cancel-route Save (nobody taking the orders) is byte-for-byte the classic cancel — load/info then load/edit, no portal call, no extra read', async () => {
  await withRwb({}, async () => {
    const { requester, calls, loads } = makeWorld({ [TERRANCE]: { loadId: T_ID, routeName: 'TERRANCE', stops: ['P', 'Q'] } });
    const r = await runCommitBoardRwb(requester, { loads: [
      { loadNbr: TERRANCE, loadId: T_ID, routeName: 'TERRANCE', emptyLoad: true, orderedStopNbrs: [], removeStopNbrs: ['P', 'Q'] },
    ] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads[0]?.error));
    assert.deepEqual(calls.map((c) => c.url.replace(/^.*\/(load\/(?:info|edit))\/.*$/, '$1')), ['load/info', 'load/edit'], 'exactly the classic sequence');
    assert.deepEqual(calls[1].removeStopIds, ['id-P', 'id-Q'], 'removes every delivery');
    assert.equal(calls.some(isPortal), false, 'the portal is never touched');
    assert.equal(loads[TERRANCE].cancelled, true);
    assert.equal(r.loads.length, 1);
    assert.equal(r.loads[0].steps.find((s) => s.op === 'removeStops')?.cancelledRoute, true);
  });
});

test('a taker whose orders come off a SEQUENCED source that failed is refused up front with that source’s reason — no validate/add, no save, and no "isn’t part of the Save"', async () => {
  await withRwb({}, async () => {
    // L1 really holds [A,B,X] but the board never knew X (a true orphan) → L1 is refused by the
    // stale-board guard. L2 is taking B off L1. Before: L2 fired validate+add for B, NuVizz
    // no-op'd it (B still on L1), and the verdict blamed a route "not part of the Save".
    const L1 = { loadId: T_ID, routeName: 'L1', stops: ['A', 'B', 'X'] };
    const L2 = { loadId: A_ID, routeName: 'L2', stops: ['C'] };
    const { requester, calls } = makeWorld({ DAVISL1: L1, DAVISL2: L2 });
    const r = await runCommitBoardRwb(requester, { loads: [
      { loadNbr: 'DAVISL1', loadId: T_ID, routeName: 'L1', orderedStopNbrs: ['A'] },
      { loadNbr: 'DAVISL2', loadId: A_ID, routeName: 'L2', orderedStopNbrs: ['C', 'B'] },
    ] }, CREDS);
    assert.equal(r.ok, false);
    const l1 = r.loads.find((l) => l.loadNbr === 'DAVISL1'); const l2 = r.loads.find((l) => l.loadNbr === 'DAVISL2');
    assert.equal(l1.ok, false); assert.match(l1.error, /board isn't showing/);
    assert.equal(l2.ok, false);
    assert.match(l2.error, /stop B is on L1 \(DAVISL1\), which FAILED this Save/);
    assert.match(l2.error, /board isn't showing/, "carries L1's own reason");
    assert.equal(/isn't part of the Save/.test(l2.error), false);
    assert.equal(calls.some(isAdd) || calls.some(isValidate) || calls.some(isSave), false, 'nothing fired');
    assert.deepEqual(L2.stops, ['C']);
  });
});

test('NUVIZZ_RWB_DRAIN_SOURCE=off reverts to cancel-first: the classic cancel runs before any portal call, and the freed orders ride validate+add', async () => {
  await withRwb({ NUVIZZ_RWB_DRAIN_SOURCE: 'off' }, async () => {
    const { requester, calls, loads } = makeWorld(sep8World());
    const r = await runCommitBoardRwb(requester, sep8Payload(), CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads.map((l) => l.error)));
    const iEdit = idx(calls, isEdit); const iPortal = idx(calls, isPortal);
    assert.ok(iEdit >= 0 && iEdit < iPortal, 'cancel first');
    assert.deepEqual([...calls[iEdit].removeStopIds].sort(), [...MOVING, 'LANDMARK'].map((n) => `id-${n}`).sort(), 'the old path empties the route outright');
    assert.equal(calls.some(isAdd), true, 'then the freed orders are ADDED');
    assert.deepEqual(loads[ALLEN].stops, ALLEN_ORDER);
    assert.equal(loads[TERRANCE].cancelled, true);
  });
});

test('cancel-first (lever off) + a refused cancel: the taker is refused with the cancel’s reason instead of adding against orders the route still holds', async () => {
  await withRwb({ NUVIZZ_RWB_DRAIN_SOURCE: 'off' }, async () => {
    const { requester, calls, loads } = makeWorld(sep8World(), { editResponse: (nbr) => (nbr === TERRANCE ? VEHICLE_TYPE_903() : null) });
    const r = await runCommitBoardRwb(requester, sep8Payload(), CREDS);
    assert.equal(r.ok, false);
    const a = r.loads.find((l) => l.loadNbr === ALLEN);
    assert.equal(a.ok, false);
    assert.match(a.error, /TERRANCE \(DAVIS000203132\), which FAILED this Save/);
    assert.match(a.error, /Vehicle Type/);
    assert.equal(calls.some(isAdd) || calls.some(isValidate), false, 'no doomed adds');
    assert.deepEqual(loads[ALLEN].stops, ['007172967', 'AMMERAAL'], 'ALLEN C untouched — nothing was written for it');
  });
});
