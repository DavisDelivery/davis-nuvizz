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
  const keys = ['NUVIZZ_RWB_ENABLED', 'NUVIZZ_RWB_USER', 'NUVIZZ_RWB_PASS', 'NUVIZZ_RWB_LOGIN_BASE', 'NUVIZZ_RWB_PORTAL_BASE', 'NUVIZZ_RWB_SETTLE_MS'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    NUVIZZ_RWB_ENABLED: 'true', NUVIZZ_RWB_USER: 'Chad', NUVIZZ_RWB_PASS: 'pw',
    NUVIZZ_RWB_LOGIN_BASE: 'https://loginqa.nuvizz.com', NUVIZZ_RWB_PORTAL_BASE: 'https://uat.nuvizz.com',
    NUVIZZ_RWB_SETTLE_MS: '15',   // post-add settle beat — real default 1200ms; fast for tests
    ...over,
  });
  try { return await fn(); }
  finally { for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

// A URL-routing requester that serves BOTH the v7 API and the RWB portal login/flow.
// `saveBody` lets a test control what saveComparedRouteData returns. `loadStops` is a
// mutable ref (array of stopNbrs) so a re-read after removeStops reflects the removal.
// `applySave` (default true) makes saveComparedRouteData APPLY its declarative routeJsonData —
// set the load's stops to exactly the entry's trip order, like the real portal — so the
// post-save membership+ORDER verify sees the save. Pass applySave:false to simulate the
// Jul 9 DAWSONVILLE portal behavior: SUCCESS answered, nothing applied.
function makeRequester({ saveBody = { responseCode: 200 }, saveStatus = 200, loadStops, stopHolders = {}, applySave = true, seqless = false, stopTypes = {}, stopSeqs = {}, stopAddrs = {}, idAlias = {} } = {}) {
  const calls = [];
  const stopDoc = (n) => ({ stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: stopTypes[n] || 'DO', to: { seq: 1 } } });
  const loadJson = () => ({ Load: {
    loadHeader: { loadId: HEXID, loadNbr: 'DAVIS000000123', routeName: 'TEST', rtOrigin: { address: { latitude: 34.04, longitude: -83.71 } } },
    versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
    // weight/totalPallets/totalCartons/volume ride the RAW stop record (normalizeLoad.rawStops)
    // — the save entry's totalData sums them (Jul 9 manual-reorder HAR fidelity). `seqless`
    // simulates a read that lands before NuVizz stamps to.seq (the settling window).
    stops: (loadStops?.value ?? []).map((n, i) => ({ stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: stopTypes[n] || 'DO', to: seqless ? {} : { seq: stopSeqs[n] ?? (i + 2), ...(stopAddrs[n] ? { address: { name: stopAddrs[n], addressLine1: '1 Main St', city: 'Dalton' } } : {}) }, weight: 100, totalPallets: 2, totalCartons: 1, volume: 3 } })),
  } });
  return {
    calls,
    requester: {
      async request(url, opts, meta) {
        const method = (opts.method || 'GET').toUpperCase();
        calls.push({ url, method, route: meta?.route, headers: opts.headers || {}, body: opts.body });
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
            for (const sid of sids.split(',').filter(Boolean)) { const n = idAlias[sid] ?? (sid.startsWith('id-') ? sid.slice(3) : null); if (n && loadStops && !loadStops.value.includes(n)) loadStops.value.push(n); }
          } catch { /* no loadStops in unit tests */ }
          return J({ responseCode: 200, message: 'SUCCESS', stops: [] });
        }
        if (url.includes('fetchUpdatedJson')) {
          return J([{ etaStopVOList: [{ timeZone: 'America/New_York' }], distance: 10, duration: 20, schStartTime: { dttm: 'Jul 2, 2026' } }]);
        }
        if (url.includes('resequenceRoute')) return J({ responseCode: 200, message: 'SUCCESS' });
        if (url.includes('saveComparedRouteData')) {
          if (applySave && loadStops) {
            try {
              const rj = opts.body && opts.body.get ? String(opts.body.get('routeJsonData') || '') : '';
              for (const entry of JSON.parse(rj)) {
                if (String(entry.routePlanId) === HEXID && Array.isArray(entry.tripDataJsonArray)) {
                  loadStops.value = [...new Set(entry.tripDataJsonArray.map((id) => String(id).replace(/^id-/, '')))];
                }
              }
            } catch { /* no routeJsonData in unit tests */ }
          }
          return J(saveBody, saveStatus);
        }
        // ── v7 API ──
        if (url.includes('/load/info/')) return J(loadJson());
        if (url.includes('/stop/info/')) {
          const n = url.split('/stop/info/')[1].split('/')[0];
          // stopHolders lets a test declare a stop as ALREADY PLANNED on another load — the
          // pre-add verification reads assignedLoadNbr from here.
          return J({ Stop: { stop: { stopId: `id-${n}`, stopNbr: String(n), stopType: 'DO' }, load: { loadNbr: stopHolders[n] || '' } } });
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

test('rwbSequenceStops: portal calls carry browser-identity headers matching the HAR', async () => {
  await withRwb({}, async () => {
    const { requester, calls } = makeRequester();
    await rwbSequenceStops(requester, HEXID, ['id-A', 'id-B'], { lat: 34, lng: -83 });
    const save = calls.find((c) => c.url.includes('saveComparedRouteData'));
    assert.ok(save, 'save call captured');
    // Real macOS Chrome identity (not a Node/undici default) — verified vs the HAR.
    assert.match(save.headers['user-agent'] || '', /Mozilla\/5\.0 .*Chrome\//);
    assert.equal(save.headers['accept-language'], 'en-US,en;q=0.9');
    assert.match(save.headers['accept'] || '', /application\/json/);
    assert.match(save.headers['sec-ch-ua'] || '', /Chrome/);
    assert.equal(save.headers['sec-fetch-mode'], 'cors');
    // The real portal does NOT send X-Requested-With — neither should we.
    assert.equal(save.headers['x-requested-with'], undefined);
  });
});

test('rwbSequenceStops: delivery-only stoplist keeps the original [all _PU..., all _DO...] shape', async () => {
  // REGRESSION PIN for the pickup-leg fix: with no pickupLegIds the payload must be
  // byte-identical to the pre-fix shape — depot _PU block up front, customer _DO block after.
  await withRwb({}, async () => {
    const { requester, calls } = makeRequester();
    const r = await rwbSequenceStops(requester, HEXID, ['id-A', 'id-B', 'id-C'], { lat: 34, lng: -83 });
    assert.equal(r.ok, true);
    const fuj = calls.find((c) => c.url.includes('fetchUpdatedJson'));
    assert.equal(String(fuj.body.get('stoplist')), 'id-A_PU,id-B_PU,id-C_PU,id-A_DO,id-B_DO,id-C_DO');
  });
});

test('rwbSequenceStops: a PICKUP order (RA/return) rides its _PU leg at the REQUESTED position', async () => {
  // The "RA placed 11th, ran 1st" bug: a pickup order's customer visit is the _PU leg, so it
  // must sit at the dispatcher's position in the visit sequence — never in the front depot
  // block — and its _DO (return to depot) goes to the tail.
  await withRwb({}, async () => {
    const { requester, calls } = makeRequester();
    const r = await rwbSequenceStops(requester, HEXID, ['id-A', 'id-RA', 'id-B'], { lat: 34, lng: -83 }, ['id-RA']);
    assert.equal(r.ok, true);
    const fuj = calls.find((c) => c.url.includes('fetchUpdatedJson'));
    assert.equal(
      String(fuj.body.get('stoplist')),
      'id-A_PU,id-B_PU,id-A_DO,id-RA_PU,id-B_DO,id-RA_DO',
      'deliveries load at the depot up front; the RA is VISITED second (its _PU), returns at the tail',
    );
    // The persisted save must mirror the same leg sequence.
    const save = calls.find((c) => c.url.includes('saveComparedRouteData'));
    const entries = JSON.parse(String(save.body.get('routeJsonData')));
    assert.deepEqual(
      entries[0].stopDataJsonArray.map((s) => s.stopId),
      ['id-A_PU', 'id-B_PU', 'id-A_DO', 'id-RA_PU', 'id-B_DO', 'id-RA_DO'],
    );
  });
});

test('rwbSequenceStops: _PU rows blank, _DO rows carry EXACTLY the preview ETA fields, trips per-leg (manual-reorder HAR)', async () => {
  // Byte-verified from the Jul 9 manual-reorder HAR: _PU save rows are the blank 7-key shape;
  // _DO rows add the preview's stopETADTTM→plannedETA, etaCode, idleTime→timeLapse (NUMBER),
  // and duration/distance→deadHeadMins/Miles OMITTED when both are 0. tripDataJsonArray is one
  // tripId per LEG (duplicates included). NOTHING else may ride the rows — v0.45.16 echoed the
  // FULL preview row (stopNbr/stopSeq/lat/…, a shape the portal never sends) and deliverit
  // half-applied every save.
  await withRwb({}, async () => {
    const base = makeRequester();
    const real = base.requester.request;
    base.requester.request = async (url, opts, meta) => {
      if (url.includes('fetchUpdatedJson')) {
        return new Response(JSON.stringify([{
          etaStopVOList: [
            { stopId: 'id-A_PU', stopETADTTM: 'Jul 9, 2026, 8:05:00 AM', etaCode: 'ONTIME', idleTime: 0, duration: 0, distance: 0, stopSeq: 1, stopNbr: 'A', latitude: 34, timeZone: 'America/New_York' },
            { stopId: 'id-B_PU', stopETADTTM: 'Jul 9, 2026, 8:06:00 AM', etaCode: 'ONTIME', idleTime: 0, duration: 0, distance: 0, stopSeq: 2, stopNbr: 'B', latitude: 34, timeZone: 'America/New_York' },
            { stopId: 'id-A_DO', stopETADTTM: 'Jul 9, 2026, 9:12:00 AM', etaCode: 'ONTIME', idleTime: 0, duration: 0, distance: 0, stopSeq: 3, stopNbr: 'A', latitude: 34, timeZone: 'America/New_York' },
            { stopId: 'id-B_DO', stopETADTTM: 'Jul 9, 2026, 9:44:00 AM', etaCode: 'LATE', idleTime: 5, duration: 3.26, distance: 0.68, stopSeq: 4, stopNbr: 'B', latitude: 34, timeZone: 'America/New_York' },
          ],
          distance: 10, duration: 20, schStartTime: { dttm: 'Jul 9, 2026' },
        }]), { status: 200 });
      }
      return real(url, opts, meta);
    };
    const r = await rwbSequenceStops(base.requester, HEXID, ['id-A', 'id-B'], { lat: 34, lng: -83 });
    assert.equal(r.ok, true, r.message);
    const save = base.calls.find((c) => c.url.includes('saveComparedRouteData'));
    const entry = JSON.parse(String(save.body.get('routeJsonData')))[0];
    const rows = entry.stopDataJsonArray;
    assert.deepEqual(rows.map((s) => s.stopId), ['id-A_PU', 'id-B_PU', 'id-A_DO', 'id-B_DO'], 'leg order preserved');
    // _PU rows: blank 7-key shape, string blanks — even though the preview identifies them.
    for (const row of rows.slice(0, 2)) {
      assert.deepEqual(Object.keys(row).sort(), ['etaCode', 'plannedETA', 'routePlanId', 'stopId', 'timeLapse', 'timeZone', 'tripId']);
      assert.equal(row.plannedETA, '');
      assert.equal(row.timeLapse, '');
    }
    // _DO with zero deadhead: 7 keys, populated, deadhead OMITTED.
    assert.deepEqual(rows[2], {
      stopId: 'id-A_DO', plannedETA: 'Jul 9, 2026, 9:12:00 AM', routePlanId: HEXID,
      etaCode: 'ONTIME', timeLapse: 0, tripId: 'id-A', timeZone: 'America/New_York',
    });
    // _DO with real deadhead: the two extra keys, numbers throughout.
    assert.deepEqual(rows[3], {
      stopId: 'id-B_DO', plannedETA: 'Jul 9, 2026, 9:44:00 AM', routePlanId: HEXID,
      etaCode: 'LATE', timeLapse: 5, deadHeadMins: 3.26, deadHeadMiles: 0.68,
      tripId: 'id-B', timeZone: 'America/New_York',
    });
    // ONE tripId per LEG, duplicates included — stopIds with the leg suffix stripped.
    assert.deepEqual(entry.tripDataJsonArray, ['id-A', 'id-B', 'id-A', 'id-B']);
    // Date-only schStartTime keeps the 08:00 fallback window; unit level keeps legacy zeros.
    assert.equal(entry.routeStartTime, '07/09/2026 08:00:00 am GMT-04:00');
    assert.deepEqual(entry.totalData, { totalP: 0, totalC: 0, totalW: 0, totalV: 0, weightUOM: 'Lbs', volumeUOM: 'Loose' });
    assert.equal(entry.isStandingRoute, false);
  });
});

test('rwbSequenceStops: unidentified preview rows keep every save row blank (fallback pin)', async () => {
  await withRwb({}, async () => {
    const { requester, calls } = makeRequester();   // fixture rows carry no stopId
    const r = await rwbSequenceStops(requester, HEXID, ['id-A', 'id-B'], { lat: 34, lng: -83 });
    assert.equal(r.ok, true, r.message);
    const entry = JSON.parse(String(calls.find((c) => c.url.includes('saveComparedRouteData')).body.get('routeJsonData')))[0];
    for (const row of entry.stopDataJsonArray) {
      assert.equal(row.plannedETA, '');
      assert.equal(row.etaCode, '');
      assert.equal(row.timeLapse, '');
    }
    assert.deepEqual(entry.tripDataJsonArray, ['id-A', 'id-B', 'id-A', 'id-B'], 'per-leg trips even on the fallback');
  });
});

test('runCommitBoardRwb: save entry carries the route\'s REAL window + freight totals (Jul 9 HAR)', async () => {
  await withRwb({}, async () => {
    // The portal echoes schStartTime's FULL time into routeStartTime ("Jul 9, 2026, 12:00:00 PM"
    // → "07/09/2026 12:00:00 pm GMT-04:00") and populates totalData from the route's freight —
    // we fabricated 08:00 am and zeros. BEN 2 was a 12 PM route.
    const loadStops = { value: ['A', 'B'] };
    const base = makeRequester({ loadStops });
    const real = base.requester.request;
    base.requester.request = async (url, opts, meta) => {
      if (url.includes('fetchUpdatedJson')) {
        return new Response(JSON.stringify([{ etaStopVOList: [{ timeZone: 'America/New_York' }], distance: 1, duration: 1, schStartTime: { dttm: 'Jul 9, 2026, 12:00:00 PM' } }]), { status: 200 });
      }
      return real(url, opts, meta);
    };
    const r = await runCommitBoardRwb(base.requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['B', 'A'] }] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
    const entry = JSON.parse(String(base.calls.find((c) => c.url.includes('saveComparedRouteData')).body.get('routeJsonData')))[0];
    assert.equal(entry.routeStartTime, '07/09/2026 12:00:00 pm GMT-04:00', 'real start time echoed');
    assert.equal(entry.routeEndTime, '07/09/2026 11:59:00 pm GMT-04:00');
    // Summed from the load's raw stop records: 2 stops × {2 pieces, 1 skid, 3 loose, 100 lbs}.
    // volumeUOM 'Loose' only when loose exist (manual-reorder HAR: totalV 4 → 'Loose'; opti
    // HAR's loose-free route: totalV 0 → '').
    assert.deepEqual(entry.totalData, { totalP: 4, totalC: 2, totalW: 200, totalV: 6, weightUOM: 'Lbs', volumeUOM: 'Loose' });
    assert.equal(entry.isStandingRoute, true, 'standing defaults ON — true on all 3 captured portal saves');
  });
});

// ── observedOrder rides a membership-confirmed verify failure (SCOTT/SHP29379) ──

test('runCommitBoardRwb: a kept-order failure still reports NuVizz\'s OBSERVED order for the board', async () => {
  await withRwb({}, async () => {
    // Save is ignored (applySave:false) → order verify fails — but membership is confirmed, so
    // the result must carry the load\'s ACTUAL delivery order for the client write-through.
    const loadStops = { value: ['A', 'B', 'C'] };
    const { requester } = makeRequester({ loadStops, applySave: false });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['C', 'A', 'B'] }] }, CREDS);
    assert.equal(r.ok, false);
    assert.match(String(r.loads[0].error || ''), /KEPT its own stop order/i);
    assert.deepEqual(r.loads[0].observedOrder, ['A', 'B', 'C'], 'the truth NuVizz kept, in its seq order');
  });
});

test('runCommitBoardRwb: a MEMBERSHIP failure carries NO observedOrder (nothing safe to paint)', async () => {
  await withRwb({}, async () => {
    const loadStops = { value: ['X'] };
    const base = makeRequester({ loadStops });
    const real = base.requester.request;
    base.requester.request = async (url, opts, meta) => {
      if (url.includes('addStopsToRouteAfterValidation')) return new Response(JSON.stringify({ responseCode: 200, message: 'SUCCESS' }), { status: 200 }); // ok, but does NOT add
      return real(url, opts, meta);
    };
    const r = await runCommitBoardRwb(base.requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['X', 'A'] }] }, CREDS);
    assert.equal(r.ok, false);
    assert.equal(r.loads[0].observedOrder, undefined);
  });
});

// ── co-located orders share a NuVizz position (SCOTT false failure, Jul 10) ────
// NuVizz gives same-address orders ONE stopSeq (11 stops / 12 orders). The dupe-corruption
// check must not flag that — it blocked closing a correctly-saved load ("acting like it
// didn't save"). Corruption = DIFFERENT places sharing a position (DAWSONVILLE 1,2,2,6…13).

test('runCommitBoardRwb: co-located orders sharing one position VERIFY green (SCOTT)', async () => {
  await withRwb({}, async () => {
    const loadStops = { value: ['A', 'B', 'C'] };
    const { requester } = makeRequester({ loadStops, stopSeqs: { B: 3, C: 3 }, stopAddrs: { B: 'USDA FOREST SERVICE', C: 'USDA FOREST SERVICE' } });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A', 'B', 'C'] }] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
  });
});

test('runCommitBoardRwb: equal-seq tie order never false-flags (tie-break by requested position)', async () => {
  await withRwb({}, async () => {
    const loadStops = { value: ['A', 'C', 'B'] };
    const { requester } = makeRequester({ loadStops, stopSeqs: { B: 3, C: 3 }, stopAddrs: { B: 'USDA FOREST SERVICE', C: 'USDA FOREST SERVICE' } });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A', 'C', 'B'] }] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
  });
});

test('runCommitBoardRwb: DIFFERENT places sharing a position still fail (DAWSONVILLE corruption pin)', async () => {
  await withRwb({}, async () => {
    const loadStops = { value: ['A', 'B', 'C'] };
    const { requester } = makeRequester({ loadStops, applySave: false, stopSeqs: { B: 3, C: 3 }, stopAddrs: { B: 'USDA FOREST SERVICE', C: 'SOME OTHER CUSTOMER' } });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A', 'B', 'C'] }] }, CREDS);
    assert.equal(r.ok, false, 'cross-address dupe is real corruption');
    assert.match(String(r.loads[0].error || ''), /duplicate position/i);
  });
});

// ── cross-card strand guard + pickup/RA edit support (Jul 9 pre-go-live audit) ──

test('runCommitBoardRwb: a SOURCE may not save while its move DESTINATION failed — no silent unplan (strand guard)', async () => {
  await withRwb({}, async () => {
    // P holds [A,B]; Q holds [C,Z]. The board moves B onto Q — but Q also carries Z, which the
    // (stale) board never listed, so Q trips the stale-board guard and drops out of the Save.
    // Without the strand guard, P still saved [A] declaratively → NuVizz removed B from P while
    // Q was never written → B silently UNPLANNED with P reporting ok. P must FAIL, loudly, with
    // NO save fired.
    const P = { loadId: '1111aaaa2222bbbb3333cccc', stops: ['A', 'B'] };
    const Q = { loadId: '4444dddd5555eeee6666ffff', stops: ['C', 'Z'] };
    const { requester, calls } = makeMoveRequester({ DAVISP: P, DAVISQ: Q });
    const r = await runCommitBoardRwb(requester, { loads: [
      { loadNbr: 'DAVISP', loadId: P.loadId, routeName: 'P', orderedStopNbrs: ['A'], orderedStopIds: ['id-A'] },
      { loadNbr: 'DAVISQ', loadId: Q.loadId, routeName: 'Q', orderedStopNbrs: ['C', 'B'], orderedStopIds: ['id-C', 'id-B'] },
    ] }, CREDS);
    assert.equal(r.ok, false);
    const rp = r.loads.find((l) => l.loadNbr === 'DAVISP');
    const rq = r.loads.find((l) => l.loadNbr === 'DAVISQ');
    assert.equal(rq.ok, false, 'Q fails its stale-board guard');
    assert.match(String(rq.error || ''), /board isn't showing/i);
    assert.equal(rp.ok, false, 'P must NOT save while its claimer is dead');
    assert.match(String(rp.error || ''), /would UNPLAN it/i);
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), false, 'nothing written');
    assert.deepEqual(P.stops, ['A', 'B'], 'B untouched on P');
  });
});

test('runCommitBoardRwb: an on-load PICKUP/RA reorders WITHOUT being re-added or refused', async () => {
  await withRwb({}, async () => {
    // Load holds A(DO), R(PU, mid-route seq>1), B(DO). Reorder to [B,R,A]. The old engine (a)
    // refused the load outright (hasUnmodeledDelivery saw a non-DO at seq>1) and (b) when it
    // didn't, classified R as an ARRIVAL (DO-only index) and re-added a stop already on the
    // route. Now: no refusal, no adds, no getStop — R rides pickupLegIds at its position.
    const loadStops = { value: ['A', 'R', 'B'] };
    const { requester, calls } = makeRequester({ loadStops, stopTypes: { R: 'PU' } });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['B', 'R', 'A'] }] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
    assert.equal(calls.some((c) => c.url.includes('addStopsToRouteAfterValidation')), false, 'no re-add of an on-load stop');
    assert.equal(calls.some((c) => c.url.includes('/stop/info/')), false, 'no arrival getStop for an on-load pickup');
    const fuj = calls.find((c) => c.url.includes('fetchUpdatedJson'));
    assert.equal(String(fuj.body.get('stoplist')), 'id-B_PU,id-A_PU,id-B_DO,id-R_PU,id-A_DO,id-R_DO', 'R visits at its requested position; its return rides the tail');
  });
});

test('runCommitBoardRwb: a non-DO stop the card is NOT sequencing still refuses (unmodeled pin)', async () => {
  await withRwb({}, async () => {
    const loadStops = { value: ['A', 'X'] };
    const { requester, calls } = makeRequester({ loadStops, stopTypes: { X: 'PU' } });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A'] }] }, CREDS);
    assert.equal(r.loads[0].ok, false);
    assert.match(String(r.loads[0].error || ''), /not sequencing/i);
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), false);
  });
});

test('runCommitBoardRwb: UNPLANNING a non-DO pickup (removeStopNbrs) is ALLOWED — the guard counts removals', async () => {
  await withRwb({}, async () => {
    // Same load as the refuse case (A DO + X PU), but now the card STAGES X for removal
    // (unplan the MUGELE pickup). The guard must count removeStopNbrs as modeled, so the
    // save goes through and the declarative saveComparedRouteData fires (NuVizz unplans X).
    const loadStops = { value: ['A', 'X'] };
    const { requester, calls } = makeRequester({ loadStops, stopTypes: { X: 'PU' } });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A'], removeStopNbrs: ['X'] }] }, CREDS);
    assert.equal(r.loads[0].ok, true, JSON.stringify(r.loads?.[0]?.error));
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), true);
  });
});

// ── resequenceRoute: the OPTIMIZER's persist, env-gated escape lever only ──────
// The Jul 9 manual-reorder HAR proves the portal does NOT fire it for a manual sequence — the
// save alone persists a manual reorder. NUVIZZ_RWB_RESEQUENCE=on enables it as a lever for
// loads whose freshest-read delivery order differs from the requested order.

const withReseq = async (fn) => {
  const prev = process.env.NUVIZZ_RWB_RESEQUENCE;
  process.env.NUVIZZ_RWB_RESEQUENCE = 'on';
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.NUVIZZ_RWB_RESEQUENCE; else process.env.NUVIZZ_RWB_RESEQUENCE = prev; }
};

test('runCommitBoardRwb: a manual reorder does NOT fire resequenceRoute by default (manual-reorder HAR parity)', async () => {
  await withRwb({}, async () => {
    const loadStops = { value: ['A', 'B', 'C'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['C', 'A', 'B'] }] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
    assert.equal(calls.some((c) => c.url.includes('resequenceRoute')), false, 'the portal persists a manual reorder via the save alone');
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), true);
  });
});

test('runCommitBoardRwb: NUVIZZ_RWB_RESEQUENCE=on fires resequenceRoute (exact form) between preview and save', async () => {
  await withRwb({}, () => withReseq(async () => {
    const loadStops = { value: ['A', 'B', 'C'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['C', 'A', 'B'] }] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
    const rs = calls.find((c) => c.url.includes('resequenceRoute'));
    assert.ok(rs, 'resequenceRoute fired for a reorder of existing stops');
    assert.equal(String(rs.body.get('stopIdsStr')), 'id-C_PU,id-A_PU,id-B_PU,id-C_DO,id-A_DO,id-B_DO', 'leg list in the requested order');
    assert.equal(String(rs.body.get('seqMode')), 'Manual');
    assert.equal(String(rs.body.get('reqSource')), 'RWB_CP');
    assert.equal(String(rs.body.get('returnToDepot')), 'NEVER');
    const iRs = calls.findIndex((c) => c.url.includes('resequenceRoute'));
    const iSave = calls.findIndex((c) => c.url.includes('saveComparedRouteData'));
    const iPrev = calls.findIndex((c) => c.url.includes('fetchUpdatedJson'));
    assert.ok(iPrev < iRs && iRs < iSave, 'resequenceRoute sits between the preview and the save');
  }));
});

test('runCommitBoardRwb: with the lever ON, a pure ADD/build save still never fires resequenceRoute', async () => {
  await withRwb({}, () => withReseq(async () => {
    const loadStops = { value: ['A'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A', 'B'] }] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
    assert.equal(calls.some((c) => c.url.includes('resequenceRoute')), false, 'adds seat stops in order — no resequence call');
  }));
});

test('runCommitBoardRwb: with the lever ON, a FAILED resequenceRoute aborts the group with NO save', async () => {
  await withRwb({}, () => withReseq(async () => {
    const loadStops = { value: ['A', 'B'] };
    const base = makeRequester({ loadStops });
    const real = base.requester.request;
    base.requester.request = async (url, opts, meta) => {
      if (url.includes('resequenceRoute')) return new Response(JSON.stringify({ responseCode: 500, message: 'opt engine down' }), { status: 200 });
      return real(url, opts, meta);
    };
    const r = await runCommitBoardRwb(base.requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['B', 'A'] }] }, CREDS);
    assert.equal(r.ok, false, 'a save without its requested resequence would be the accepted-but-ignored reorder — abort');
    assert.equal(base.calls.some((c) => c.url.includes('saveComparedRouteData')), false, 'no save after a failed resequence');
    assert.match(String(r.loads[0].error || ''), /resequenceRoute failed/i);
  }));
});

test('runCommitBoardRwb: NUVIZZ_RWB_STANDING_ROUTE=off reverts isStandingRoute to false', async () => {
  await withRwb({}, async () => {
    const prev = process.env.NUVIZZ_RWB_STANDING_ROUTE;
    process.env.NUVIZZ_RWB_STANDING_ROUTE = 'off';
    try {
      const loadStops = { value: ['A'] };
      const { requester, calls } = makeRequester({ loadStops });
      const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A'] }] }, CREDS);
      assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
      const entry = JSON.parse(String(calls.find((c) => c.url.includes('saveComparedRouteData')).body.get('routeJsonData')))[0];
      assert.equal(entry.isStandingRoute, false);
    } finally { if (prev === undefined) delete process.env.NUVIZZ_RWB_STANDING_ROUTE; else process.env.NUVIZZ_RWB_STANDING_ROUTE = prev; }
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

test('runCommitBoardRwb: supplied ids that do NOT look like NuVizz ids never skip the per-ADD getStop', async () => {
  await withRwb({}, async () => {
    // Scan-fed ids (stopIdsByNbr / paired orderedStopIds) may skip the pre-add read — but ONLY
    // when each value is id-SHAPED (isHashLikeId). Anything else (these 'id-A' style strings,
    // a stop NUMBER, junk) is refused by the guard and the engine reads every ADD from NuVizz
    // first, exactly the WIEDMANN→KOBE-era behavior: the already-planned refusal fires BEFORE
    // anything writes.
    const loadStops = { value: ['X'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{
      loadNbr: 'DAVIS000000123', loadId: HEXID, routeName: 'R',
      orderedStopNbrs: ['X', 'A', 'B', 'C'], orderedStopIds: ['id-X', 'id-A', 'id-B', 'id-C'],
    }] }, CREDS);
    assert.equal(r.ok, true, `expected success, got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    // A, B, C are adds → one pre-add verification read EACH, ids supplied or not.
    assert.equal(calls.filter((c) => c.url.includes('/stop/info/')).length, 3, 'one getStop per ADD arrival');
    assert.equal(calls.filter((c) => c.url.includes('addStopsToRouteAfterValidation')).length, 1, 'one batched add');
    const val = calls.filter((c) => c.url.includes('validateStopstoPerformAction'));
    assert.equal(val.length, 1, 'one batched validate');
    assert.ok(val[0].url.includes('routeId='), 'validate carries routeId');
  });
});

test('runCommitBoardRwb: scan-fed stopIdsByNbr skips the per-ADD getStop (the 24-call build fix)', async () => {
  await withRwb({}, async () => {
    // Board rows carry the internal stop id off the cheap list scan (Stop-Id column) or
    // enrichment; the client sends them as stopIdsByNbr. An id-SHAPED supplied id goes straight
    // into the batched validate+add — NO pre-add /stop/info read — which is what drops a
    // 14-stop build from ~24 NuVizz calls to the portal's own ~7. Safety is unchanged: the
    // post-add membership re-read still catches a silent no-op (next test).
    const A = 'a'.repeat(24), B = 'b'.repeat(24), C = 'c'.repeat(24);
    const loadStops = { value: ['X'] };
    const { requester, calls } = makeRequester({ loadStops, idAlias: { [A]: 'A', [B]: 'B', [C]: 'C' } });
    const r = await runCommitBoardRwb(requester, { loads: [{
      loadNbr: 'DAVIS000000123', loadId: HEXID, routeName: 'R',
      orderedStopNbrs: ['X', 'A', 'B', 'C'], stopIdsByNbr: { A, B, C, X: '007000111' },
    }] }, CREDS);
    assert.equal(r.ok, true, `expected success, got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    // X is on-load (no read needed) and its junk digits value must be REFUSED by the hash
    // guard either way — zero reads proves both the skip AND the map-branch guard.
    assert.equal(calls.filter((c) => c.url.includes('/stop/info/')).length, 0, 'no per-ADD getStop when scan-fed ids are supplied');
    const add = calls.find((c) => c.url.includes('addStopsToRouteAfterValidation'));
    assert.equal(String(add.body.get('stopIds')), [A, B, C].join(','), 'the supplied ids ride the batched add');
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), true);
  });
});

test('runCommitBoardRwb: the silent-no-op guard HOLDS on the scan-fed id path (no false success)', async () => {
  await withRwb({}, async () => {
    // The WIEDMANN protection did not move: with supplied ids the pre-add read is skipped, so
    // the post-add membership re-read is the guard — an add that returns SUCCESS without the
    // stop landing still fails loudly and still NAMES the holding load. Never a false "saved".
    const A = 'a'.repeat(24);
    const loadStops = { value: ['X'] };
    const base = makeRequester({ loadStops, stopHolders: { A: 'DAVIS000OTHER' } });
    const real = base.requester.request;
    base.requester.request = async (url, opts, meta) => {
      if (url.includes('addStopsToRouteAfterValidation')) return new Response(JSON.stringify({ responseCode: 200, message: 'SUCCESS' }), { status: 200 }); // ok, but does NOT add
      return real(url, opts, meta);
    };
    const r = await runCommitBoardRwb(base.requester, { loads: [{
      loadNbr: 'DAVIS000000123', loadId: HEXID, routeName: 'R',
      orderedStopNbrs: ['X', 'A'], stopIdsByNbr: { A },
    }] }, CREDS);
    assert.equal(r.ok, false, 'must NOT report success when the stop never landed');
    assert.match(String(r.loads[0].error || ''), /DAVIS000OTHER/, 'failure names the holding load');
    assert.equal(base.calls.some((c) => c.url.includes('saveComparedRouteData')), false, 'must not persist a route missing the stop');
  });
});

test('runCommitBoardRwb: positional orderedStopIds pair only 1:1 — a partial array falls back to getStop', async () => {
  await withRwb({}, async () => {
    // The client filters unknown ids out of orderedStopIds, so a partial array has LOST its
    // pairing with orderedStopNbrs — gluing ids to nbrs by position would seat the wrong stop.
    // Mismatched lengths are ignored and every ADD reads from NuVizz, exactly as before.
    const A = 'a'.repeat(24), B = 'b'.repeat(24);
    const loadStops = { value: ['X'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{
      loadNbr: 'DAVIS000000123', loadId: HEXID, routeName: 'R',
      orderedStopNbrs: ['X', 'A', 'B'], orderedStopIds: [A, B].slice(0, 1).concat(),
    }] }, CREDS);
    assert.equal(r.ok, true, `expected success, got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    assert.equal(calls.filter((c) => c.url.includes('/stop/info/')).length, 2, 'both ADDs read the old way (no positional guessing)');
  });
});

test('runCommitBoardRwb: a LAGGING post-add read settles instead of failing (no false "planned elsewhere")', async () => {
  await withRwb({}, async () => {
    // OWUSU 1 (Jul 10): add accepted 200 but NuVizz attaches async — the immediate re-read
    // showed none of the arrivals, and the save failed claiming the first stop was "planned
    // on another load" while its record read UNPLANNED. The verify must give NuVizz a beat
    // and re-read before judging.
    const loadStops = { value: ['X'] };
    const base = makeRequester({ loadStops });
    const real = base.requester.request;
    let addDone = false, lagged = 0;
    const staleLoad = JSON.stringify({ Load: {
      loadHeader: { loadId: HEXID, loadNbr: 'DAVIS000000123', routeName: 'TEST', rtOrigin: { address: { latitude: 34.04, longitude: -83.71 } } },
      versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
      stops: [{ stop: { stopId: 'id-X', stopNbr: 'X', stopType: 'DO', to: { seq: 2 }, weight: 100, totalPallets: 2, totalCartons: 1, volume: 3 } }],
    } });
    base.requester.request = async (url, opts, meta) => {
      if (url.includes('addStopsToRouteAfterValidation')) { const r = await real(url, opts, meta); addDone = true; return r; }
      if (addDone && lagged < 1 && url.includes('/load/info/')) { lagged++; return new Response(staleLoad, { status: 200 }); } // first post-add read: not attached yet
      return real(url, opts, meta);
    };
    const r = await runCommitBoardRwb(base.requester, { loads: [{
      loadNbr: 'DAVIS000000123', loadId: HEXID, routeName: 'R', orderedStopNbrs: ['X', 'A'],
    }] }, CREDS);
    assert.equal(r.ok, true, `lag must settle, got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    assert.equal(base.calls.some((c) => c.url.includes('saveComparedRouteData')), true, 'save proceeds once the add is visible');
  });
});

test('runCommitBoardRwb: a STALE supplied id self-heals — re-read by number, re-add with the fresh id', async () => {
  await withRwb({}, async () => {
    // The scan/enrichment id can be a dead instance of a recurring PRO: NuVizz no-ops adding a
    // dead id. The straggler pass reads the stop BY NUMBER, sees a different current id, and
    // re-adds with the fresh one — one extra read + one extra add for that stop, then green.
    const DEAD = 'f'.repeat(24);
    const loadStops = { value: ['X'] };
    const { requester, calls } = makeRequester({ loadStops });   // DEAD has no alias → attaches nothing
    const r = await runCommitBoardRwb(requester, { loads: [{
      loadNbr: 'DAVIS000000123', loadId: HEXID, routeName: 'R',
      orderedStopNbrs: ['X', 'A'], stopIdsByNbr: { A: DEAD },
    }] }, CREDS);
    assert.equal(r.ok, true, `stale id must self-heal, got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    const adds = calls.filter((c) => c.url.includes('addStopsToRouteAfterValidation'));
    assert.equal(adds.length, 2, 'dead-id add, then the fresh-id re-add');
    assert.equal(String(adds[1].body.get('stopIds')), 'id-A', 'the re-add carries the CURRENT id read by number');
    assert.equal(calls.filter((c) => c.url.includes('/stop/info/')).length, 1, 'exactly one straggler re-resolution read');
    assert.equal(calls.some((c) => c.url.includes('saveComparedRouteData')), true);
  });
});

test('runCommitBoardRwb: co-located ties verify green even when the vendor reads them back in a DIFFERENT record order', async () => {
  await withRwb({}, async () => {
    // Vendor record order A,C,B ≠ requested A,B,C; B and C share seq 3 at the SAME place.
    // Without the wantIdx tie-break the sorted read-back is A,C,B → false "KEPT its own stop
    // order". This is the pin the original tie-break test missed (its fixture's read order
    // happened to equal the requested order, so the comparator was a no-op).
    const loadStops = { value: ['A', 'C', 'B'] };
    const { requester, calls } = makeRequester({ loadStops, applySave: false,
      stopSeqs: { A: 2, B: 3, C: 3 }, stopAddrs: { B: 'USDA FOREST SERVICE', C: 'USDA FOREST SERVICE' } });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A', 'B', 'C'] }] }, CREDS);
    assert.equal(r.ok, true, `tie-break must hold: ${JSON.stringify(r.loads?.[0]?.error)}`);
    assert.equal(calls.filter((c) => c.url.includes('saveComparedRouteData')).length, 1, 'no repair save');
  });
});

test('runCommitBoardRwb: unknown-address co-located dupes stay benign when the order matches', async () => {
  await withRwb({}, async () => {
    // Same shared seq, NO addresses on the raw stops (rawStops lack address blocks on some
    // tenants) — the dupe must still read as co-location, not corruption, when the order is
    // exactly what we asked for.
    const loadStops = { value: ['A', 'B', 'C'] };
    const { requester } = makeRequester({ loadStops, applySave: false, stopSeqs: { A: 2, B: 3, C: 3 } });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A', 'B', 'C'] }] }, CREDS);
    assert.equal(r.ok, true, `unknown-address dupe must be benign: ${JSON.stringify(r.loads?.[0]?.error)}`);
  });
});

test('runCommitBoardRwb: REFUSES an add whose stop NuVizz says is planned on a load outside the Save', async () => {
  await withRwb({}, async () => {
    // Board says unplanned (stale); NuVizz's stop read says it's on OTHER-LOAD. The save must
    // refuse up-front with the actionable move error — never report success.
    const loadStops = { value: ['X'] };
    const { requester } = makeRequester({ loadStops, stopHolders: { A: 'DAVIS000OTHER' } });
    const r = await runCommitBoardRwb(requester, { loads: [{
      loadNbr: 'DAVIS000000123', loadId: HEXID, routeName: 'R',
      orderedStopNbrs: ['X', 'A'], orderedStopIds: ['id-X', 'id-A'],
    }] }, CREDS);
    assert.equal(r.loads[0].ok, false, 'save refused');
    assert.match(String(r.loads[0].error || ''), /ALREADY PLANNED on (load )?DAVIS000OTHER/i);
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
    assert.match(r.loads[0].error, /did not appear/i);
    assert.match(r.loads[0].error, /reads UNPLANNED right now|still processing|reads ON this load/i, 'the truthful state, never the guess');
    assert.doesNotMatch(r.loads[0].error, /planned on another load/i, 'the pre-fix lie must never return');
    assert.equal(base.calls.some((c) => c.url.includes('saveComparedRouteData')), false, 'must not persist a route missing the stop');
  });
});

test('runCommitBoardRwb: retargets to the same-named instance that holds the stops (duplicate recurring load)', async () => {
  await withRwb({}, async () => {
    // Two loads named DARYL: the opened one (EMPTY_ID) is empty; the twin (FULL) holds A,B.
    // The board opened the empty twin; the save must retarget to FULL and reorder there.
    const EMPTY_ID = '6a4778d0461cf601d983b6bf', FULL_ID = 'aa11bb22cc33dd44ee55ff66';
    const calls = [];
    const fullStops = ['A', 'B'];   // MUTABLE — the save applies its declarative order here
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
      if (url.includes('resequenceRoute')) return J({ responseCode: 200, message: 'SUCCESS' });
      if (url.includes('saveComparedRouteData')) {
        // Apply the declarative order to the retargeted FULL twin (like the real portal), so the
        // post-save order verify sees the reorder land.
        try {
          for (const e of JSON.parse(String(opts.body.get('routeJsonData') || ''))) {
            if (String(e.routePlanId) === FULL_ID && Array.isArray(e.tripDataJsonArray)) { fullStops.length = 0; fullStops.push(...new Set(e.tripDataJsonArray.map((id) => String(id).replace(/^id-/, '')))); }
          }
        } catch { /* keep */ }
        return J({ responseCode: 200, message: 'SUCCESS' });
      }
      if (url.includes('/load/info/LOAD113177')) return J(loadDoc(EMPTY_ID, 'DARYL_EMPTY', []));
      if (url.includes('/load/info/LOAD112852')) return J(loadDoc(FULL_ID, 'DARYL_FULL', fullStops));
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
// (the addStopsToRouteAfterValidation body / the multi-route save entries) so re-reads reflect writes.
// `applySave` (default true) makes saveComparedRouteData APPLY its declarative routeJsonData — set a
// load's stops to exactly the ids in its entry, like the real portal — so the post-save verify sees
// the move. Pass applySave:false to simulate a portal whose save does NOT transfer membership (the
// fallback path must then attach + re-sequence).
function makeMoveRequester(loads, { applySave = true } = {}) {
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
        if (tgt) for (const sid of sids.split(',').filter(Boolean)) {
          const n = sid.replace(/^id-/, '');
          // Physical accuracy: a stop lives on ONE load — attaching it releases it everywhere
          // else (as the real vendor does), so the source-side verify sees the departure.
          for (const other of Object.values(loads)) if (other !== tgt.v) other.stops = other.stops.filter((x) => x !== n);
          if (!tgt.v.stops.includes(n)) tgt.v.stops.push(n);
        }
      } catch { /* ignore */ }
      return J({ responseCode: 200, message: 'SUCCESS' });
    }
    if (url.includes('fetchUpdatedJson')) return J([{ etaStopVOList: [{ timeZone: 'America/New_York' }], distance: 1, duration: 1, schStartTime: { dttm: 'Jul 2, 2026' } }]);
    if (url.includes('resequenceRoute')) return J({ responseCode: 200, message: 'SUCCESS' });
    if (url.includes('saveComparedRouteData')) {
      if (applySave) {
        try {
          const rj = opts.body?.get ? String(opts.body.get('routeJsonData') || '') : '';
          for (const entry of JSON.parse(rj)) {
            const tgt = byId[String(entry.routePlanId)];
            if (tgt && Array.isArray(entry.tripDataJsonArray)) tgt.v.stops = [...new Set(entry.tripDataJsonArray.map((id) => String(id).replace(/^id-/, '')))];
          }
        } catch { /* ignore */ }
      }
      return J({ responseCode: 200, message: 'SUCCESS' });
    }
    const m = url.match(/\/load\/info\/([^/?]+)/);
    if (m) { const nbr = decodeURIComponent(m[1]); return loads[nbr] ? J(loadJson(nbr)) : J({}, 404); }
    if (url.includes('/stop/info/')) { const n = url.split('/stop/info/')[1].split('/')[0]; return J({ Stop: { stop: { stopId: `id-${n}`, stopNbr: n, stopType: 'DO' }, load: { loadNbr: '' } } }); }
    return J({});
  } } };
}

test('runCommitBoardRwb: cross-load move rides ONE atomic multi-route save (portal profile — no add, no probe)', async () => {
  await withRwb({}, async () => {
    // L1 holds [A,B]; L2 holds [C]. Move B from L1 → L2. The move reduces L1's ordered list but sends
    // NO removeStopNbrs; B is still on L1 in NuVizz at classification time. Expected (HAR-verified):
    // B classifies as a MOVE arrival → NO validate/addStopsToRoute, NO getStop, NO retarget probe;
    // ONE saveComparedRouteData carrying BOTH routes; a post-save verify read confirms B landed.
    const L1 = { loadId: '1111aaaa2222bbbb3333cccc', stops: ['A', 'B'] };
    const L2 = { loadId: '4444dddd5555eeee6666ffff', stops: ['C'] };
    const { requester, calls } = makeMoveRequester({ DAVISL1: L1, DAVISL2: L2 });
    const r = await runCommitBoardRwb(requester, { loads: [
      { loadNbr: 'DAVISL1', loadId: L1.loadId, routeName: 'L1', orderedStopNbrs: ['A'], orderedStopIds: ['id-A'] },
      { loadNbr: 'DAVISL2', loadId: L2.loadId, routeName: 'L2', orderedStopNbrs: ['C', 'B'], orderedStopIds: ['id-C', 'id-B'] },
    ] }, CREDS);
    assert.equal(r.ok, true, `move should not be refused; got: ${JSON.stringify(r.loads?.map((l) => l.error))}`);
    assert.ok(!r.loads.some((l) => /board isn't showing/i.test(l.error || '')), 'no false stale-board refusal on the source');
    assert.deepEqual(L2.stops, ['C', 'B'], 'B moved onto L2 in the sent order');
    assert.deepEqual(L1.stops, ['A'], 'B left L1 (declarative omission)');
    // The portal profile: membership transfer happens INSIDE the one multi-route save.
    assert.equal(calls.filter((c) => c.url.includes('saveComparedRouteData')).length, 1, 'exactly ONE combined save for both routes');
    assert.equal(calls.filter((c) => c.url.includes('fetchUpdatedJson')).length, 2, 'one preview per route');
    assert.equal(calls.some((c) => c.url.includes('addStopsToRouteAfterValidation')), false, 'a move fires NO add');
    assert.equal(calls.some((c) => c.url.includes('validateStopstoPerformAction')), false, 'a move fires NO validate');
    assert.equal(calls.some((c) => c.url.includes('/stop/info/')), false, 'no getStop probe (destination-empty retarget probe skipped for in-batch moves)');
    assert.equal(calls.some((c) => c.url.includes('/load/insertstops/')), false, 'no v7 insertStops');
  });
});

test('runCommitBoardRwb: A↔B SWAP commits atomically in the one save (previously refused as circular)', async () => {
  await withRwb({}, async () => {
    const L1 = { loadId: '1111aaaa2222bbbb3333cccc', stops: ['A', 'X'] };
    const L2 = { loadId: '4444dddd5555eeee6666ffff', stops: ['B', 'Y'] };
    const { requester, calls } = makeMoveRequester({ DAVISL1: L1, DAVISL2: L2 });
    // Swap X and Y between the loads in one Save.
    const r = await runCommitBoardRwb(requester, { loads: [
      { loadNbr: 'DAVISL1', loadId: L1.loadId, routeName: 'L1', orderedStopNbrs: ['A', 'Y'], orderedStopIds: ['id-A', 'id-Y'] },
      { loadNbr: 'DAVISL2', loadId: L2.loadId, routeName: 'L2', orderedStopNbrs: ['B', 'X'], orderedStopIds: ['id-B', 'id-X'] },
    ] }, CREDS);
    assert.equal(r.ok, true, `swap should commit atomically; got: ${JSON.stringify(r.loads?.map((l) => l.error))}`);
    assert.ok(!r.loads.some((l) => /circular/i.test(l.error || '')), 'no circular-move refusal');
    assert.deepEqual(L1.stops, ['A', 'Y'], 'L1 ends with A,Y');
    assert.deepEqual(L2.stops, ['B', 'X'], 'L2 ends with B,X');
    assert.equal(calls.filter((c) => c.url.includes('saveComparedRouteData')).length, 1, 'one combined save');
    assert.equal(calls.some((c) => c.url.includes('addStopsToRouteAfterValidation')), false, 'no adds for an in-batch swap');
  });
});

test('runCommitBoardRwb: move FALLBACK — if the save does not transfer membership, attach via add + re-sequence (never a false success)', async () => {
  await withRwb({}, async () => {
    // Simulate a portal whose combined save does NOT move the stop (applySave:false — L2 never gains
    // B from the save). The post-save verify must catch it, attach B via the proven add path, and
    // re-sequence L2 — the Save still ends OK with B actually on L2, never a silent no-op.
    const L1 = { loadId: '1111aaaa2222bbbb3333cccc', stops: ['A', 'B'] };
    const L2 = { loadId: '4444dddd5555eeee6666ffff', stops: ['C'] };
    const { requester, calls } = makeMoveRequester({ DAVISL1: L1, DAVISL2: L2 }, { applySave: false });
    const r = await runCommitBoardRwb(requester, { loads: [
      { loadNbr: 'DAVISL1', loadId: L1.loadId, routeName: 'L1', orderedStopNbrs: ['A'], orderedStopIds: ['id-A'] },
      { loadNbr: 'DAVISL2', loadId: L2.loadId, routeName: 'L2', orderedStopNbrs: ['C', 'B'], orderedStopIds: ['id-C', 'id-B'] },
    ] }, CREDS);
    assert.equal(r.ok, true, `fallback should land the move; got: ${JSON.stringify(r.loads?.map((l) => l.error))}`);
    assert.ok(L2.stops.includes('B'), 'B attached to L2 by the fallback add');
    assert.equal(calls.some((c) => c.url.includes('addStopsToRouteAfterValidation')), true, 'fallback add fired');
    assert.ok(calls.filter((c) => c.url.includes('saveComparedRouteData')).length >= 2, 'combined save + the fallback re-sequence save');
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

// ── post-save ORDER verification (the Jul 9 DAWSONVILLE false "saved") ─────────
// A pure reorder/removal edit has NO adds, so nothing used to check the order after the save:
// NuVizz answered SUCCESS, applied the MEMBERSHIP changes, kept every stop's OLD seq (1,2,2,6…13,
// duplicates included) — and we reported "saved" while the driver would have run the old route.

test('runCommitBoardRwb: pure REORDER verifies the new order actually landed (one extra read)', async () => {
  await withRwb({}, async () => {
    const loadStops = { value: ['A', 'B', 'C'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['C', 'A', 'B'] }] }, CREDS);
    assert.equal(r.ok, true, `expected verified success, got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    assert.deepEqual(loadStops.value, ['C', 'A', 'B'], 'the save applied the declarative order');
    assert.equal(calls.filter((c) => c.url.includes('saveComparedRouteData')).length, 1, 'no repair needed');
    assert.equal(calls.filter((c) => c.url.includes('/load/info/')).length, 2, 'PASS A read + exactly ONE post-save verify read');
  });
});

test('runCommitBoardRwb: FAILS LOUDLY when NuVizz answers SUCCESS but keeps its own order', async () => {
  await withRwb({}, async () => {
    // applySave:false = the DAWSONVILLE portal behavior: 200 SUCCESS, nothing applied. The verify
    // must catch it, try ONE repair save, then fail with the kept order spelled out.
    const loadStops = { value: ['A', 'B', 'C'] };
    const { requester, calls } = makeRequester({ loadStops, applySave: false });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['C', 'A', 'B'] }] }, CREDS);
    assert.equal(r.ok, false, 'must NOT report saved when the order never landed');
    assert.match(String(r.loads[0].error || ''), /KEPT its own stop order/i);
    assert.match(String(r.loads[0].error || ''), /wanted C → A → B/i, 'the error names the wanted order');
    assert.equal(calls.filter((c) => c.url.includes('saveComparedRouteData')).length, 2, 'original save + the one repair save');
    assert.ok((r.loads[0].steps || []).some((s) => String(s.op || '').includes('(repair)')), 'repair round recorded in steps');
  });
});

test('runCommitBoardRwb: the one repair save rescues an order the first save dropped', async () => {
  await withRwb({}, async () => {
    const loadStops = { value: ['A', 'B'] };
    let saves = 0;
    const base = makeRequester({ loadStops, applySave: false });
    const real = base.requester.request;
    base.requester.request = async (url, opts, meta) => {
      if (url.includes('saveComparedRouteData')) {
        saves++;
        if (saves >= 2) {   // only the SECOND (repair) save is honored by the portal
          try {
            const e = JSON.parse(String(opts.body.get('routeJsonData') || ''))[0];
            loadStops.value = [...new Set(e.tripDataJsonArray.map((id) => String(id).replace(/^id-/, '')))];
          } catch { /* keep */ }
        }
        return new Response(JSON.stringify({ responseCode: 200, message: 'SUCCESS' }), { status: 200 });
      }
      return real(url, opts, meta);
    };
    const r = await runCommitBoardRwb(base.requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['B', 'A'] }] }, CREDS);
    assert.equal(r.ok, true, `repair should land the order; got: ${JSON.stringify(r.loads?.[0]?.error)}`);
    assert.deepEqual(loadStops.value, ['B', 'A']);
    assert.equal(saves, 2, 'original + one repair');
  });
});

test('runCommitBoardRwb: names the load NuVizz says holds a stop the save silently DROPPED (BEN 2)', async () => {
  await withRwb({}, async () => {
    // The BEN 2 failure (Jul 9, 11:16Z): every call 200-SUCCESSes but the save EJECTS a stop a
    // ghost route still claims. The post-save verify must fail AND name the holding load from
    // NuVizz's own stop record — "fell off, refresh" gave the dispatcher nothing to act on.
    const loadStops = { value: ['A', 'B'] };
    const base = makeRequester({ loadStops, stopHolders: { B: 'DAVIS000GHOST' }, applySave: false });
    const real = base.requester.request;
    base.requester.request = async (url, opts, meta) => {
      if (url.includes('saveComparedRouteData')) {
        try {
          const e = JSON.parse(String(opts.body.get('routeJsonData') || ''))[0];
          loadStops.value = e.tripDataJsonArray.map((id) => String(id).replace(/^id-/, '')).filter((n) => n !== 'B');
        } catch { /* keep */ }
        return new Response(JSON.stringify({ responseCode: 200, message: 'SUCCESS' }), { status: 200 });
      }
      return real(url, opts, meta);
    };
    const r = await runCommitBoardRwb(base.requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A', 'B'] }] }, CREDS);
    assert.equal(r.ok, false, 'must NOT report saved when NuVizz ejected a stop');
    assert.match(String(r.loads[0].error || ''), /dropped stop B/i);
    assert.match(String(r.loads[0].error || ''), /DAVIS000GHOST/, 'the holding load is named');
  });
});

test('runCommitBoardRwb: null stopSeq is SEQ-PENDING, not "duplicate position 0" — soft retry, no repair write', async () => {
  await withRwb({}, async () => {
    // The verify read can land before NuVizz stamps to.seq. Two unseq'd stops used to read as
    // duplicate position 0 → a false KEPT-order failure + a pointless repair save into the
    // vendor's settling window. Now: plain re-read, then an honest seq-pending failure.
    const loadStops = { value: ['A', 'B'] };
    const base = makeRequester({ loadStops, seqless: true });
    const r = await runCommitBoardRwb(base.requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['B', 'A'] }] }, CREDS);
    assert.equal(r.ok, false, 'cannot claim verified without positions');
    assert.match(String(r.loads[0].error || ''), /has not assigned stop positions/i);
    assert.doesNotMatch(String(r.loads[0].error || ''), /duplicate position/i, 'no phantom dupe-0');
    assert.equal(base.calls.filter((c) => c.url.includes('saveComparedRouteData')).length, 1, 'NO repair write during the settling window');
  });
});

test('runCommitBoardRwb: a SOURCE that keeps a moved-away stop FAILS (half-applied move, source side)', async () => {
  await withRwb({}, async () => {
    // Vendor index-skew: the destination gains the stop but the source never releases it.
    // The source's verify must catch the lingering stop — the inverse of the BEN 2 ejection.
    const L1 = { loadId: '1111aaaa2222bbbb3333cccc', stops: ['A', 'B'] };
    const L2 = { loadId: '4444dddd5555eeee6666ffff', stops: ['C'] };
    const base = makeMoveRequester({ DAVISL1: L1, DAVISL2: L2 });
    const real = base.requester.request;
    base.requester.request = async (url, opts, meta) => {
      const res = await real(url, opts, meta);
      // After every save/add, force the skew: B stays on L1 no matter what.
      if ((url.includes('saveComparedRouteData') || url.includes('addStopsToRouteAfterValidation')) && !L1.stops.includes('B')) L1.stops.push('B');
      return res;
    };
    const r = await runCommitBoardRwb(base.requester, { loads: [
      { loadNbr: 'DAVISL1', loadId: L1.loadId, routeName: 'L1', orderedStopNbrs: ['A'], orderedStopIds: ['id-A'] },
      { loadNbr: 'DAVISL2', loadId: L2.loadId, routeName: 'L2', orderedStopNbrs: ['C', 'B'], orderedStopIds: ['id-C', 'id-B'] },
    ] }, CREDS);
    const l1 = r.loads.find((l) => l.loadNbr === 'DAVISL1');
    const l2 = r.loads.find((l) => l.loadNbr === 'DAVISL2');
    assert.equal(l2.ok, true, `destination landed: ${JSON.stringify(l2.error)}`);
    assert.equal(l1.ok, false, 'source keeping the moved-away stop must FAIL, never report saved');
    assert.match(String(l1.error || ''), /KEPT stop B/i);
    assert.match(String(l1.error || ''), /move to its new load/i);
  });
});

test('runCommitBoardRwb: totalData sums ONLY the stops being saved (removals excluded)', async () => {
  await withRwb({}, async () => {
    const loadStops = { value: ['A', 'B'] };
    const { requester, calls } = makeRequester({ loadStops });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A'], removeStopNbrs: ['B'] }] }, CREDS);
    assert.equal(r.ok, true, JSON.stringify(r.loads?.[0]?.error));
    const entry = JSON.parse(String(calls.find((c) => c.url.includes('saveComparedRouteData')).body.get('routeJsonData')))[0];
    // One kept stop × {2 pieces, 1 skid, 3 loose, 100 lbs} — the removed stop must NOT count.
    assert.deepEqual(entry.totalData, { totalP: 2, totalC: 1, totalW: 100, totalV: 3, weightUOM: 'Lbs', volumeUOM: 'Loose' });
  });
});

test('runCommitBoardRwb: FAILS LOUDLY when a removal is accepted but never applied', async () => {
  await withRwb({}, async () => {
    const loadStops = { value: ['A', 'B'] };
    const { requester } = makeRequester({ loadStops, applySave: false });
    const r = await runCommitBoardRwb(requester, { loads: [{ loadNbr: 'DAVIS000000123', loadId: HEXID, orderedStopNbrs: ['A'], removeStopNbrs: ['B'] }] }, CREDS);
    assert.equal(r.ok, false, 'must NOT report saved when the removal never landed');
    assert.match(String(r.loads[0].error || ''), /KEPT stop B/i);
    assert.match(String(r.loads[0].error || ''), /removal was accepted but the stop never left/i);
  });
});
