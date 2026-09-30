// test/route-create-dryrun.test.mjs — ＋ New route's DRY RUN says which create a Save would make,
// and which NuVizz it would reach (v1.98.5). NUVIZZ_ROUTE_CREATE_RWB turns on a different create;
// a switch whose position cannot be read is not a switch, and NUVIZZ_RWB_PORTAL_BASE is its own
// setting, so "the UAT site" is only a test if the dry run says uat.nuvizz.com. Every path here
// returns before any NuVizz requester exists — zero calls.
import test from 'node:test';
import assert from 'node:assert/strict';

import handler from '../netlify/functions/nuvizz-write.mts';
import { routeCreateEngine } from '../netlify/functions/lib/nuvizz-write.mts';

const URL = 'http://localhost/.netlify/functions/nuvizz-write';
const post = (obj) => handler(new Request(URL, { method: 'POST', body: JSON.stringify(obj) }));
const CARD = { routeName: 'TEST', loadNbr: 'TEST-0930', date: '2026-09-30', orderedStopNbrs: ['A', 'B'] };

const KEYS = ['NUVIZZ_ROUTE_CREATE_RWB', 'NUVIZZ_RWB_ENABLED', 'NUVIZZ_RWB_USER', 'NUVIZZ_RWB_PASS', 'NUVIZZ_RWB_LOGIN_BASE', 'NUVIZZ_RWB_PORTAL_BASE', 'NUVIZZ_WRITE_ENABLED'];
async function withEnv(vars, fn) {
  const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try { return await fn(); } finally { for (const k of KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}
const SIGNED_IN = { NUVIZZ_RWB_ENABLED: 'true', NUVIZZ_RWB_USER: 'Chad', NUVIZZ_RWB_PASS: 'pw' };

test('switch off (the default): the dry run names the v7 create and prints its plan exactly as before', async () => {
  await withEnv({}, async () => {
    const j = await (await post({ op: 'newRoute', dryRun: true, payload: CARD })).json();
    assert.equal(j.ok, true);
    assert.equal(j.routeCreate.engine, 'v7');
    assert.equal(j.routeCreate.switchName, 'NUVIZZ_ROUTE_CREATE_RWB');
    assert.match(j.plan[0], /^CHECK load TEST-0930 is free/);
    assert.ok(j.plan.some((s) => /routePlan\/update with the header \+ 2 PlanStop REFERENCE/.test(s)));
    assert.equal(j.plan.some((s) => /addNewRoutePlan/.test(s)), false);
  });
});

test('switch on: the plan is the portal create, and says which portal host and sign-in host it reaches', async () => {
  await withEnv({ ...SIGNED_IN, NUVIZZ_ROUTE_CREATE_RWB: 'on' }, async () => {
    const j = await (await post({ op: 'newRoute', dryRun: true, payload: { ...CARD, driverId: 7, dispatch: true } })).json();
    assert.equal(j.routeCreate.engine, 'rwb');
    assert.equal(j.routeCreate.rwbReady, true);
    assert.equal(j.routeCreate.portalHost, 'uat.nuvizz.com', 'the portal default');
    assert.equal(j.routeCreate.loginHost, 'loginqa.nuvizz.com', 'the sign-in default');
    assert.equal(j.plan.some((s) => /^CHECK load/.test(s)), false, 'no collision read: the portal numbers the load');
    const create = j.plan.find((s) => /^CREATE route "TEST"/.test(s));
    assert.match(create, /addNewRoutePlan on uat\.nuvizz\.com, signing in at loginqa\.nuvizz\.com/);
    assert.match(create, /a name already in use that day is refused/);
    assert.match(j.plan.find((s) => /^ATTACH/.test(s)), /the 2 order\(s\).*assign the driver, dispatch/);
    // The preview is the portal entry, not the v7 body.
    assert.equal(j.preview.url, 'https://uat.nuvizz.com/deliverit/dirouteworkbench/routePlan/addNewRoutePlan');
    assert.equal(j.preview.body.isPlanningMode, 'true');
    assert.equal(j.preview.body.manualBuildJsonData[0].routePlanName, 'TEST');
    assert.equal(j.preview.body.manualBuildJsonData[0].routeDate, '09/30/2026');
    assert.equal('driver' in j.preview.body.manualBuildJsonData[0], false, 'no driver object is sent');
  });
});

test('switch on, portal pointed somewhere else: the dry run shows THAT host before any call is spent', async () => {
  await withEnv({ ...SIGNED_IN, NUVIZZ_ROUTE_CREATE_RWB: 'on', NUVIZZ_RWB_PORTAL_BASE: 'https://portal.example.test', NUVIZZ_RWB_LOGIN_BASE: 'https://login.example.test' }, async () => {
    const j = await (await post({ op: 'newRoute', dryRun: true, payload: CARD })).json();
    assert.equal(j.routeCreate.portalHost, 'portal.example.test');
    assert.equal(j.routeCreate.loginHost, 'login.example.test');
    assert.match(j.plan.find((s) => /^CREATE/.test(s)), /on portal\.example\.test, signing in at login\.example\.test/);
    assert.match(j.preview.url, /^https:\/\/portal\.example\.test\/deliverit\//);
  });
});

test('switch on without a portal sign-in: the plan leads with the refusal the live call would make', async () => {
  await withEnv({ NUVIZZ_ROUTE_CREATE_RWB: 'on' }, async () => {
    const j = await (await post({ op: 'newRoute', dryRun: true, payload: CARD })).json();
    assert.equal(j.routeCreate.rwbReady, false);
    assert.match(j.plan[0], /^REFUSE before any call: the Route Workbench sign-in is not ready/);
  });
});

test('switch on, a name the portal would refuse: the preview says so, with no call', async () => {
  await withEnv({ ...SIGNED_IN, NUVIZZ_ROUTE_CREATE_RWB: 'on' }, async () => {
    const j = await (await post({ op: 'newRoute', dryRun: true, payload: { ...CARD, routeName: 'A NAME FAR TOO LONG FOR NUVIZZ' } })).json();
    assert.match(j.preview.refused, /NuVizz caps it at 20/);
  });
});

test('routeCreateEngine reads the switch the way the create does: a typo is off, and hosts never carry the login', async () => {
  await withEnv({ ...SIGNED_IN, NUVIZZ_ROUTE_CREATE_RWB: 'onn' }, async () => {
    const e = routeCreateEngine();
    assert.equal(e.engine, 'v7', 'fails closed, like routeCreateViaRwb');
    assert.equal(JSON.stringify(e).includes('pw'), false, 'no password in the readout');
    assert.equal(JSON.stringify(e).includes('Chad'), false, 'no username in the readout');
  });
  await withEnv({ ...SIGNED_IN, NUVIZZ_ROUTE_CREATE_RWB: 'YES' }, async () => {
    assert.equal(routeCreateEngine().engine, 'rwb');
  });
});

test('other ops do not carry the route-create readout', async () => {
  await withEnv({}, async () => {
    const j = await (await post({ op: 'getStop', dryRun: true, payload: { stopNbr: '7' } })).json();
    assert.equal('routeCreate' in j, false);
  });
});
