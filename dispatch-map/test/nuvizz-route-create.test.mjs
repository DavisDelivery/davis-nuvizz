// test/nuvizz-route-create.test.mjs — §R, creating a route (Chad, Jul 30:
// "I want to be able to create a route in the routing tab").
//
// Until now the app could DESTROY a route (emptying a load cancels it — and v0.54.17 made
// that easy) but could not make one: the Compare Save needs a load that already exists, and
// the only other create path is the load import, gated OFF since the Jul 2 incident where
// production treated import REFERENCE stops as full replaces and wiped freight on 10 live
// orders.
//
// This path uses routePlan/update with a header + ONE seed PlanStop REFERENCE. The original
// header-only design was refused live (Aug 3, reason 903: "Either PlanStop or Stop node
// should be present") — NuVizz will not create a stopless route — so the create now rides in
// with the first order the dispatcher picked. The pins below are the safety argument:
//   • the body NEVER carries a `stops` VALUE node — the Jul 2 failure mode needs stop data,
//     and a PlanStop is reference-shaped by schema (stopNbr + seq + schedule only: "All the
//     stops exist in the system. Hence only the schedule and route information is updated");
//   • `planStops` is EXACTLY the one sanitized seed — caller-passed junk can never widen it,
//     and schedule junk (addresses, coords, exec fields) is stripped to the schema's keys;
//   • the SEED gets the same respect as an RWB add: unreadable → refuse, already planned on
//     another load → refuse and NAME the holder, already executed → refuse. Nothing written;
//   • routePlan/update is "create OR UPDATE", so a create REFUSES unless the load number reads
//     a clean 404/400-absent first — an existing route is never silently edited, and an
//     UNREADABLE number (5xx/auth/429) is refused too: "I couldn't check" is not "it's free";
//   • the async ack is never trusted: the route is read back, AND the read-back must show the
//     seed riding it — a landed header with an unattached seed is reported, never assumed;
//   • the route NAME is verified against what was asked for — NuVizz assigning its own name
//     would otherwise report ✓ and the dispatcher would hunt for a route that isn't there;
//   • over-long name/number, a missing origin and a MISSING SEED are refused UP FRONT (zero
//     NuVizz calls) — all silent-discard traps on an async worker.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpRequest, buildRouteCreateBody, buildPlanStopRef, ROUTE_FIELD_MAX, WRITE_OPS, MUTATING_OPS } from '../netlify/functions/lib/nuvizz-write-ops.mts';
import { runNewRoute, routeCreateBlocked } from '../netlify/functions/lib/nuvizz-write.mts';

const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic xyz' };
const ORIGIN = { name: 'Davis Delivery', addr1: '943 Gainesville Hwy', city: 'Buford', state: 'Georgia', zip: '30518' };
const SEED = { stopNbr: '007155216', fromSchedule: { timeFrom: '2026-07-31T08:00:00', timeZone: 'EST' }, toSchedule: { timeFrom: '2026-07-31T12:00:00', timeTo: '2026-07-31T17:00:00' } };
const OK_INPUT = { loadNbr: 'TRAILER6-0731', routeName: 'TRAILER 6', date: '2026-07-31', origin: ORIGIN, seed: SEED };
// runNewRoute payload: the seed arrives as a bare stop NUMBER; the schedule is read live.
const OK_PAYLOAD = { loadNbr: 'TRAILER6-0731', routeName: 'TRAILER 6', date: '2026-07-31', origin: ORIGIN, seedStopNbr: SEED.stopNbr };

// No real clock in any test — the verify loop's sleep is injected.
const NOW_PACING = { tries: 3, waitMs: 0, sleep: async () => {} };

// existing: load numbers the fake tenant already has. stops: the fake tenant's stop records
// (keyed by stopNbr) for the seed-guard read. created: filled by a successful write.
function makeRequester({ existing = {}, stops = null, createAnswer = null, onCreate = null, getLoadStatus = null } = {}) {
  const calls = [];
  const state = { ...existing };
  const stopState = stops ?? { [SEED.stopNbr]: { stopId: 'aabbccddeeff001122334455' } };
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
            versionId: 'v1', loadExecutionInfo: { loadStatus: 'PLANNED' },
            stops: (L.stops || []).map((sn, i) => ({ stop: { stopNbr: sn, stopType: 'DO', to: { seq: i + 1 } } })),
          } });
        }
        if (url.includes('/stop/info/')) {
          const nbr = decodeURIComponent(url.split('/stop/info/')[1].split('/')[0]);
          const S = stopState[nbr];
          if (!S) return J({}, 404);
          return J({ Stop: {
            stop: {
              stopId: S.stopId, stopNbr: nbr,
              from: { schedule: S.fromSchedule ?? SEED.fromSchedule },
              to: { schedule: S.toSchedule ?? SEED.toSchedule },
            },
            stopExecutionInfo: { stopStatus: S.stopStatus ?? 'SCHEDULED' },
            load: S.assignedLoadNbr ? { loadNbr: S.assignedLoadNbr, routeName: S.routeName ?? null } : {},
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
// The default tenant: the write lands the route WITH its planStops, so the read-back finds
// both — exactly what a settled async worker produces.
const landing = (routeName = 'TRAILER 6', { attachSeed = true } = {}) => (body, state) => {
  const h = body.route.loadHeader;
  const planned = (body.route.planStops || []).map((p) => p.stopNbr);
  state[h.loadNbr] = {
    loadId: 'newhex0000000000000000aa',
    routeName: routeName === true ? h.routeName : routeName,
    stops: attachSeed ? planned : [],
  };
};

// Which fake call is which, for call-shape assertions.
const kindOf = (c) => (c.url.includes('/routePlan/update/') ? 'write' : c.url.includes('/stop/info/') ? 'stopRead' : 'loadRead');

// ── the invariant: the seed reference and NOTHING else ──────────────────────

test('the create body carries the header + EXACTLY one sanitized PlanStop reference — never a stops value node', () => {
  // Even when a caller passes stop-shaped junk, the builder cannot emit it: the Jul 2 freight
  // wipe was import REFERENCE stops being treated as full replaces, and a PlanStop carries no
  // address and no freight by schema.
  const body = buildRouteCreateBody(
    { ...OK_INPUT, stops: [{ stopNbr: 'X' }], planStops: [{ stopNbr: 'Y' }], route: { stops: [1] } },
    'DAVIS',
  );
  assert.deepEqual(Object.keys(body).sort(), ['companyCode', 'route']);
  assert.deepEqual(Object.keys(body.route).sort(), ['loadHeader', 'planStops'], 'route carries loadHeader + planStops and nothing else');
  const flat = JSON.stringify(body);
  assert.ok(!/"stops"/.test(flat), 'no stops VALUE node at any depth');
  assert.ok(!/"X"|"Y"/.test(flat), 'caller-passed stop junk never reaches the wire');
  // The one reference is the SEED, shape pinned to the schema: {stopNbr, from, to} only.
  assert.equal(body.route.planStops.length, 1);
  const ref = body.route.planStops[0];
  assert.deepEqual(Object.keys(ref).sort(), ['from', 'stopNbr', 'to']);
  assert.equal(ref.stopNbr, SEED.stopNbr);
  assert.deepEqual(ref.from, { seq: 1, schedule: { timeFrom: '2026-07-31T08:00:00', timeZone: 'EST' } });
  assert.deepEqual(ref.to, { seq: 1, schedule: { timeFrom: '2026-07-31T12:00:00', timeTo: '2026-07-31T17:00:00' } });
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

test('schedule junk off the echoed record is stripped to the schema keys — nothing address- or freight-shaped can ride', () => {
  const ref = buildPlanStopRef({
    stopNbr: '007155216',
    fromSchedule: { timeFrom: '2026-07-31T08:00:00', address: { addr1: '1 Rd' }, latitude: 34.1, weight: 500 },
    toSchedule: { timeConstraint: 'PREFERRED', totalCartons: 9, exec: { status: 'X' } },
  });
  assert.deepEqual(ref.from.schedule, { timeFrom: '2026-07-31T08:00:00' });
  assert.deepEqual(ref.to.schedule, { timeConstraint: 'PREFERRED' });
  // A record with no schedule at all still builds — {} is valid per the Schedule schema.
  const bare = buildPlanStopRef({ stopNbr: '007155216' });
  assert.deepEqual(bare.from, { seq: 1, schedule: {} });
  assert.deepEqual(bare.to, { seq: 1, schedule: {} });
});

test('the built REQUEST targets routePlan/update and carries the reference, not a stops node', () => {
  const br = buildOpRequest('createRoute', { route: OK_INPUT }, CREDS);
  assert.equal(br.method, 'POST');
  assert.equal(br.url, 'https://portal.nuvizz.com/deliverit/openapi/v7/routePlan/update/default/DAVIS');
  assert.equal(br.meta.route, '/routePlan/update/default');
  assert.ok(!/"stops"/.test(String(br.body)), 'no stops value node on the wire');
  assert.ok(/planStops/.test(String(br.body)) && String(br.body).includes(SEED.stopNbr), 'the seed reference rides');
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
  // NuVizz refuses a stopless route (903) — a create with no seed cannot land, so it never fires.
  assert.throws(() => buildRouteCreateBody({ ...OK_INPUT, seed: null }, 'DAVIS'), /903/);
  assert.throws(() => buildRouteCreateBody({ ...OK_INPUT, seed: { stopNbr: '' } }, 'DAVIS'), /903/);
});

test('a payload with no seed order is refused before ANY NuVizz call', async () => {
  const { requester, calls } = makeRequester({});
  const r = await runNewRoute(requester, { ...OK_PAYLOAD, seedStopNbr: '', pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /first order/i);
  assert.match(r.error, /903/);
  assert.equal(calls.length, 0, 'zero calls — the refusal is free');
});

// ── the collision guard ──────────────────────────────────────────────────────

test('an EXISTING load number is refused — routePlan/update is create-OR-UPDATE, so it is never written blind', async () => {
  const { requester, calls } = makeRequester({ existing: { 'TRAILER6-0731': { loadId: 'oldhex', routeName: 'TRAILER 6' } } });
  const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
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
    const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
    assert.equal(r.ok, true, `status ${status}: ${r.error}`);
    assert.ok(calls.some((c) => c.url.includes('/routePlan/update/')), `status ${status} let the create fire`);
  }
});

test('an UNREADABLE load number is still refused — "could not check" is not "it is free"', async () => {
  // Auth, throttling and server errors are NOT absence: creating on one risks silently
  // editing a live route's header.
  for (const status of [500, 502, 403, 401, 429]) {
    const { requester, calls } = makeRequester({ getLoadStatus: { 'TRAILER6-0731': status } });
    const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
    assert.equal(r.ok, false, `status ${status}`);
    assert.match(r.error, /could not confirm/, `status ${status}`);
    assert.match(r.error, /nothing was created/, `status ${status}`);
    assert.ok(!calls.some((c) => c.url.includes('/routePlan/update/')), `no write on a ${status} check`);
  }
});

// ── the seed guard: the first order must be readable, unplanned, unexecuted ──

test('an UNREADABLE seed order refuses the create — never write on a stop we could not read', async () => {
  const { requester, calls } = makeRequester({ stops: {} });   // the tenant has no such stop
  const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /could not read first order 007155216/);
  assert.match(r.error, /nothing was created/i);
  assert.ok(!calls.some((c) => c.url.includes('/routePlan/update/')), 'no write fired');
});

test('a seed ALREADY PLANNED on another load refuses and NAMES the holder — a create never silently steals a stop', async () => {
  const { requester, calls } = makeRequester({
    stops: { [SEED.stopNbr]: { stopId: 'aabbccddeeff001122334455', assignedLoadNbr: 'DAVIS000198668', routeName: 'SUW 2' } },
  });
  const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /ALREADY PLANNED on SUW 2 \(DAVIS000198668\)/);
  assert.match(r.error, /pick an unplanned order/i);
  assert.ok(!calls.some((c) => c.url.includes('/routePlan/update/')), 'no write fired');
});

test('a seed the driver already ACTED on refuses — finished work cannot start a new route', async () => {
  const { requester, calls } = makeRequester({
    stops: { [SEED.stopNbr]: { stopId: 'aabbccddeeff001122334455', stopStatus: 'DELIVERED' } },
  });
  const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, false);
  assert.match(r.error, /already DELIVERED/);
  assert.ok(!calls.some((c) => c.url.includes('/routePlan/update/')), 'no write fired');
});

// ── the happy path + the read-back ───────────────────────────────────────────

test('a free number creates the route WITH the seed, then VERIFIES both by reading the load back', async () => {
  const { requester, calls } = makeRequester({ onCreate: landing('TRAILER 6') });
  const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.loadNbr, 'TRAILER6-0731');
  assert.equal(r.loadId, 'newhex0000000000000000aa', 'the new loadId comes back so the app can open it');
  assert.equal(r.routeName, 'TRAILER 6');
  assert.equal(r.nameMatched, true);
  assert.equal(r.seedStopNbr, SEED.stopNbr, 'the seed identity rides the result so the card can open with it');
  assert.equal(r.seedAttached, true);
  assert.equal(r.warning, undefined, 'a clean create carries no warning');
  // Call shape: collision read, seed-stop read, the write, the verify read. Four, in order.
  assert.deepEqual(calls.map(kindOf), ['loadRead', 'stopRead', 'write', 'loadRead']);
  // The wire body echoed the seed's OWN schedule off its live record (echo, never invent).
  const wire = JSON.parse(calls.find((c) => kindOf(c) === 'write').body);
  assert.equal(wire.route.planStops[0].stopNbr, SEED.stopNbr);
  assert.deepEqual(wire.route.planStops[0].to.schedule, SEED.toSchedule);
});

test('a landed header whose seed has NOT attached is reported honestly — success with a warning, never assumed', async () => {
  // The async worker can land the route without settling the plan. That must not read as a
  // failure (the route EXISTS — a re-create would collide) and must not read as a clean ✓
  // (the dispatcher would trust a first order that is not there).
  const { requester } = makeRequester({ onCreate: landing('TRAILER 6', { attachSeed: false }) });
  const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.seedAttached, false);
  assert.match(r.warning, /007155216 has not attached/);
  assert.match(r.warning, /do NOT re-create/i);
});

test('an async ack that never lands is reported as PENDING, never as success', async () => {
  // NuVizz says Success; the route never becomes readable. The old import lesson: a 200 ack
  // is not proof. Critically the message must NOT invite a retry that would double-create.
  const { requester } = makeRequester({ onCreate: null });   // write lands nothing
  const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
  assert.match(r.error, /not readable yet/);
  assert.match(r.error, /do NOT re-create with the same name/i);
});

test('NuVizz renaming the route is surfaced, not swallowed', async () => {
  // The gap the import path left: nothing ever read the name back, so a NuVizz-assigned name
  // would report ✓ and the dispatcher would look for a route that is not on the board.
  const { requester } = makeRequester({ onCreate: landing('RT-00912') });
  const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
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
  const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
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
    const r = await runNewRoute(requester, { ...OK_PAYLOAD, pacing: NOW_PACING }, CREDS);
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
    assert.equal(calls.length, 0, 'a blocked path fires nothing at all');
  } finally { if (prev === undefined) delete process.env.NUVIZZ_ROUTE_CREATE; else process.env.NUVIZZ_ROUTE_CREATE = prev; }
});
