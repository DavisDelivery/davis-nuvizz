// test/nuvizz-route-create.test.mjs — §R, creating an EMPTY route (Chad, Jul 30:
// "I want to be able to create a route in the routing tab").
//
// Until now the app could DESTROY a route (emptying a load cancels it — and v0.54.17 made
// that easy) but could not make one: the Compare Save needs a load that already exists, and
// the only other create path is the load import, gated OFF since the Jul 2 incident where
// production treated import REFERENCE stops as full replaces and wiped freight on 10 live
// orders.
//
// This path uses routePlan/update with a HEADER ONLY. The pins below are the safety argument:
//   • the body NEVER carries a stops/planStops node — the Jul 2 failure mode needs stop data,
//     so it is structurally impossible here (asserted on the built request, not just claimed);
//   • routePlan/update is "create OR UPDATE", so a create REFUSES unless the load number reads
//     a clean 404 first — an existing route is never silently edited, and an UNREADABLE number
//     (5xx/network) is refused too, because "I couldn't check" is not "it's free";
//   • the async ack is never trusted: the route is read back before success is reported;
//   • the route NAME is verified against what was asked for — the gap the import path left,
//     where NuVizz assigning its own name would still report ✓ and the dispatcher would hunt
//     for a route that isn't on the board;
//   • over-long name/number and a missing origin are refused UP FRONT (zero NuVizz calls) —
//     both are silent-discard traps on an async worker.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpRequest, buildRouteCreateBody, ROUTE_FIELD_MAX, WRITE_OPS, MUTATING_OPS } from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runNewRoute, routeCreateBlocked } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const ORIGIN = { name: 'Davis Delivery', addr1: '943 Gainesville Hwy', city: 'Buford', state: 'Georgia', zip: '30518' };
const OK_INPUT = { loadNbr: 'TRAILER6-0731', routeName: 'TRAILER 6', date: '2026-07-31', origin: ORIGIN };

// No real clock in any test — the verify loop's sleep is injected.
const NOW_PACING = { tries: 3, waitMs: 0, sleep: async () => {} };

// existing: load numbers the fake tenant already has. created: filled by a successful write.
function makeRequester({ existing = {}, createAnswer = null, onCreate = null, getLoadStatus = null } = {}) {
  const calls = [];
  const state = { ...existing };
  return {
    calls, state,
    requester: {
      async request(url, opts, meta) {
        const method = (opts.method || 'GET').toUpperCase();
        calls.push({ url, method, route: meta?.route, body: opts.body });
        const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
        if (url.includes('/load/info/')) {
          const nbr = decodeURIComponent(url.split('/load/info/')[1].split('/')[0]);
          const L = state[nbr];
          // A forced status stands in for "the tenant has no such load" — so it applies only
          // while the load really is absent. Once the create lands it, the read-back sees it,
          // exactly as NuVizz would.
          if (!L && getLoadStatus && getLoadStatus[nbr] != null) return J({}, getLoadStatus[nbr]);
          if (!L) return J({}, 404);
          return J({ Load: {
            loadHeader: { loadId: L.loadId, loadNbr: nbr, routeName: L.routeName },
            versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' }, stops: [],
          } });
        }
        if (url.includes('/routePlan/update/')) {
          if (onCreate) onCreate(JSON.parse(String(opts.body)), state);
          return createAnswer ? createAnswer() : J({ status: 'Success' });
        }
        return J({});
      },
    },
  };
}
// The default tenant: the write lands the route so the read-back finds it.
const landing = (routeName = 'TRAILER 6') => (body, state) => {
  const h = body.route.loadHeader;
  state[h.loadNbr] = { loadId: 'newhex0000000000000000aa', routeName: routeName === true ? h.routeName : routeName };
};

// ── the invariant: no stop data, ever ────────────────────────────────────────

test('the create body carries a header ONLY — no stops/planStops node can ever appear', () => {
  // Even when a caller passes stop-shaped junk, the builder cannot emit it: the Jul 2 freight
  // wipe was import REFERENCE stops being treated as full replaces, and this body has none.
  const body = buildRouteCreateBody(
    { ...OK_INPUT, stops: [{ stopNbr: 'X' }], planStops: [{ stopNbr: 'Y' }], route: { stops: [1] } },
    'DAVIS',
  );
  assert.deepEqual(Object.keys(body).sort(), ['companyCode', 'route']);
  assert.deepEqual(Object.keys(body.route), ['loadHeader'], 'route carries loadHeader and nothing else');
  const flat = JSON.stringify(body);
  assert.ok(!/stopNbr/.test(flat), 'no stop number reaches the wire');
  assert.ok(!/"stops"/.test(flat) && !/planStops/.test(flat), 'no stops/planStops key at any depth');
  // And the header is the proven shape.
  const h = body.route.loadHeader;
  assert.equal(h.loadNbr, 'TRAILER6-0731');
  assert.equal(h.routeName, 'TRAILER 6');
  assert.equal(h.earliestStartDttm, '2026-07-31T06:00:00', 'service day → the proven window shape');
  assert.equal(h.latestStartDttm, '2026-07-31T18:00:00');
  assert.equal(h.originState, 'GA', 'long-form state normalized like the import header');
  assert.equal(h.originCountry, 'USA');
  assert.equal(h.originName, 'Davis Delivery');
});

test('the built REQUEST targets routePlan/update and stays stopless', () => {
  const br = buildOpRequest('createRoute', { route: OK_INPUT }, CREDS);
  assert.equal(br.method, 'POST');
  assert.equal(br.url, 'https://portal.nuvizz.com/deliverit/openapi/v7/routePlan/update/default/DAVIS');
  assert.equal(br.meta.route, '/routePlan/update/default');
  assert.ok(!/"stops"|planStops|stopNbr/.test(String(br.body)), 'the wire body is stopless');
  // Registered as a real, MUTATING op so the handler's write gate + idempotency apply.
  assert.ok(WRITE_OPS.includes('createRoute') && WRITE_OPS.includes('newRoute'));
  assert.ok(MUTATING_OPS.has('createRoute') && MUTATING_OPS.has('newRoute'));
});

// ── up-front refusals: zero NuVizz calls ─────────────────────────────────────

test('silent-discard traps are refused UP FRONT (no call fired)', () => {
  const tooLong = 'X'.repeat(ROUTE_FIELD_MAX + 1);
  assert.throws(() => buildRouteCreateBody({ ...OK_INPUT, loadNbr: tooLong }, 'DAVIS'), /caps it at 20/);
  assert.throws(() => buildRouteCreateBody({ ...OK_INPUT, routeName: tooLong }, 'DAVIS'), /caps it at 20/);
  assert.throws(() => buildRouteCreateBody({ ...OK_INPUT, date: null }, 'DAVIS'), /service date/);
  assert.throws(() => buildRouteCreateBody({ ...OK_INPUT, origin: null }, 'DAVIS'), /ship-from origin/);
  assert.throws(() => buildRouteCreateBody({ ...OK_INPUT, origin: { name: 'X', addr1: '1 Rd' } }, 'DAVIS'), /ship-from origin/);
  assert.throws(() => buildRouteCreateBody({ ...OK_INPUT, loadNbr: '  ' }, 'DAVIS'), /loadNbr/);
});

// ── the collision guard ──────────────────────────────────────────────────────

test('an EXISTING load number is refused — routePlan/update is create-OR-UPDATE, so it is never written blind', async () => {
  const { requester, calls } = makeRequester({ existing: { 'TRAILER6-0731': { loadId: 'oldhex', routeName: 'TRAILER 6' } } });
  const r = await runNewRoute(requester, { ...OK_INPUT, pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.exists, true);
  assert.match(r.error, /already exists in NuVizz \(TRAILER 6\)/);
  assert.match(r.error, /pick a different route name\/date/);
  assert.ok(!calls.some((c) => c.url.includes('/routePlan/update/')), 'no write fired at a number that is taken');
});

test('a 400 means the tenant does not have that number — the create proceeds (live shape, Jul 31)', async () => {
  // The FIRST real create refused itself: "NuVizz answered 400 to the check" on a number that
  // plainly did not exist. load/info answers 400, not 404, for an unknown load — while the
  // STOP existence gate elsewhere sees a true 404, so the two endpoints genuinely differ.
  // Either way the read returned NO LOAD, so nothing is there to overwrite.
  for (const status of [400, 404]) {
    const { requester, calls } = makeRequester({ getLoadStatus: { 'TRAILER6-0731': status }, onCreate: landing('TRAILER 6') });
    const r = await runNewRoute(requester, { ...OK_INPUT, pacing: NOW_PACING }, CREDS);
    assert.equal(r.ok, true, `status ${status}: ${r.error}`);
    assert.ok(calls.some((c) => c.url.includes('/routePlan/update/')), `status ${status} let the create fire`);
  }
});

test('an UNREADABLE load number is still refused — "could not check" is not "it is free"', async () => {
  // Auth, throttling and server errors are NOT absence: creating on one risks silently
  // editing a live route's header.
  for (const status of [500, 502, 403, 401, 429]) {
    const { requester, calls } = makeRequester({ getLoadStatus: { 'TRAILER6-0731': status } });
    const r = await runNewRoute(requester, { ...OK_INPUT, pacing: NOW_PACING }, CREDS);
    assert.equal(r.ok, false, `status ${status}`);
    assert.match(r.error, /could not confirm/, `status ${status}`);
    assert.match(r.error, /nothing was created/, `status ${status}`);
    assert.ok(!calls.some((c) => c.url.includes('/routePlan/update/')), `no write on a ${status} check`);
  }
});

// ── the happy path + the read-back ───────────────────────────────────────────

test('a free number creates the route, then VERIFIES it by reading it back', async () => {
  const { requester, calls } = makeRequester({ onCreate: landing('TRAILER 6') });
  const r = await runNewRoute(requester, { ...OK_INPUT, pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.loadNbr, 'TRAILER6-0731');
  assert.equal(r.loadId, 'newhex0000000000000000aa', 'the new loadId comes back so the app can open it');
  assert.equal(r.routeName, 'TRAILER 6');
  assert.equal(r.nameMatched, true);
  // Call shape: the pre-check read, the write, the verify read. Three, in that order.
  const seq = calls.map((c) => (c.url.includes('/routePlan/update/') ? 'write' : 'read'));
  assert.deepEqual(seq, ['read', 'write', 'read']);
});

test('an async ack that never lands is reported as PENDING, never as success', async () => {
  // NuVizz says Success; the route never becomes readable. The old import lesson: a 200 ack
  // is not proof. Critically the message must NOT invite a retry that would double-create.
  const { requester } = makeRequester({ onCreate: null });   // write lands nothing
  const r = await runNewRoute(requester, { ...OK_INPUT, pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
  assert.match(r.error, /not readable yet/);
  assert.match(r.error, /do NOT re-create with the same name/i);
});

test('NuVizz renaming the route is surfaced, not swallowed', async () => {
  // The gap the import path left: nothing ever read the name back, so a NuVizz-assigned name
  // would report ✓ and the dispatcher would look for a route that is not on the board.
  const { requester } = makeRequester({ onCreate: landing('RT-00912') });
  const r = await runNewRoute(requester, { ...OK_INPUT, pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.nameMatched, false);
  assert.equal(r.routeName, 'RT-00912');
  assert.equal(r.requestedRouteName, 'TRAILER 6');
  assert.match(r.warning, /named it "RT-00912" instead of "TRAILER 6"/);
});

test('a rejected write reports the failure and never claims a route', async () => {
  const { requester } = makeRequester({
    createAnswer: () => new Response(JSON.stringify({ Reasons: [{ description: 'origin is required' }] }), { status: 400 }),
  });
  const r = await runNewRoute(requester, { ...OK_INPUT, pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, false);
  assert.ok(!r.loadId, 'no route id is invented on a rejection');
  assert.match(r.error, /createRoute:/);
});

test('the emergency brake is DEFAULT-ON and kills the path when flipped', async () => {
  const prev = process.env.NUVIZZ_ROUTE_CREATE;
  try {
    delete process.env.NUVIZZ_ROUTE_CREATE;
    assert.equal(routeCreateBlocked(), false, 'unset = enabled (unlike the import brake)');
    for (const on of ['1', 'true', 'yes', 'on']) { process.env.NUVIZZ_ROUTE_CREATE = on; assert.equal(routeCreateBlocked(), false, on); }
    for (const off of ['0', 'false', 'no', 'off']) { process.env.NUVIZZ_ROUTE_CREATE = off; assert.equal(routeCreateBlocked(), true, off); }
    process.env.NUVIZZ_ROUTE_CREATE = 'off';
    const { requester, calls } = makeRequester({ onCreate: landing() });
    const r = await runNewRoute(requester, { ...OK_INPUT, pacing: NOW_PACING }, CREDS);
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.equal(calls.length, 0, 'a blocked path fires nothing at all');
  } finally { if (prev === undefined) delete process.env.NUVIZZ_ROUTE_CREATE; else process.env.NUVIZZ_ROUTE_CREATE = prev; }
});
