// test/driver-loads.test.mjs — the load lookup's endpoint, END TO END against the Firestore fake.
//
// load-lookup.test.mjs pins what a load IS. This pins what the endpoint READS and ASKS: the week's
// days (sealed record when sealed, the board when not, never a future day), masked; the one
// outside call it may make (Google, for road miles, once per load and then from the cache); and
// that a switch, a missing key, a Google failure or a failed day read each SAY so instead of
// printing a number. The fake throws on any fetch that is not Firestore unless a test hands the
// Google stub in, and every test asserts nothing else went out — no NuVizz call is possible.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { LOAD_STOP_FIELDS } from '../netlify/functions/lib/board-fields.mts';
import { YARD } from '../src/lib/load-lookup.js';

const T = 'davis';
const call = async (qs) => {
  const handler = (await import('../netlify/functions/driver-loads.mts')).default;
  const r = await handler(new Request(`https://x.netlify.app/.netlify/functions/driver-loads?${qs}`));
  return { status: r.status, body: await r.json() };
};
const st = (stopNbr, date, extra = {}) => ({
  stopNbr, stopType: 'DO', businessName: `CONSIGNEE ${stopNbr}`, city: 'CUMMING', zip: '30040',
  lat: 34.2, lng: -84.1, routeName: 'COLIN 1', loadNbr: 'COLIN 1', driverName: 'COLIN', driverUserName: 'COLIN',
  normalizedStatus: 'DELIVERED', deliveredDTTM: `${date}T09:00:00`, routeSeq: 1, cartons: 1, volume: 0, weight: 100,
  orderInstructions: 'TOTAL-AMOUNT : 50.00', ...extra,
});
const sealed = (date, stops) => Object.fromEntries([
  [`history_days/${T}__${date}`, { tenant: T, date, complete: true, verified: true }],
  ...stops.map((s, i) => [`history_days/${T}__${date}/stops/s${i}`, { ...s, capture_version: 1 }]),
]);

// The week of Sep 14–20: Monday and Wednesday sealed, Colin on both; Enock on Monday.
const MON = '2026-09-14';
const WED = '2026-09-16';
const SEED = {
  ...sealed(MON, [
    st('007170001', MON, { deliveredDTTM: `${MON}T10:30:00`, lat: 34.30, lng: -84.10, routeSeq: 1 }),
    st('007170002', MON, { deliveredDTTM: `${MON}T08:15:00`, lat: 34.25, lng: -84.05, routeSeq: 2 }),   // delivered first
    st('007170003', MON, { normalizedStatus: 'EXCEPTION', deliveredDTTM: null, lat: 34.4, lng: -84.2 }),
    st('007170004', MON, { driverName: 'ENOCK AKYEA', driverUserName: 'ENOCK AKYEA', routeName: 'NOR 2', loadNbr: 'NOR 2' }),
  ]),
  ...sealed(WED, [
    st('ESTES-0538243875', WED, { orderInstructions: '', raw: { stop: { sealNbr: '$163.18' } } }),
  ]),
  [`travel_calibration/${T}__route_classes__${MON}`]: { classes: { 'COLIN 1': 'tractor' } },
};
const GOOGLE = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const googleStub = (bodies, meters = 80467.2) => async (url, init) => {
  if (!String(url).startsWith(GOOGLE)) throw new Error(`unexpected outside call: ${url}`);
  bodies.push(JSON.parse(String(init.body)));
  return new Response(JSON.stringify({ routes: [{ distanceMeters: meters }] }), { status: 200 });
};
const withKey = async (fn, key = 'test-key') => {
  const was = process.env.GOOGLE_ROUTES_API_KEY;
  if (key == null) delete process.env.GOOGLE_ROUTES_API_KEY; else process.env.GOOGLE_ROUTES_API_KEY = key;
  try { return await fn(); } finally { if (was == null) delete process.env.GOOGLE_ROUTES_API_KEY; else process.env.GOOGLE_ROUTES_API_KEY = was; }
};

test('NO NAME: the week\'s drivers to choose from — sealed days read masked, nothing but Firestore', async () => {
  const fake = installFirestoreFake(SEED);
  try {
    const { status, body } = await call(`week=2026-09-17`);
    assert.equal(status, 200);
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(body.googleCalls, 0);
    assert.equal(fake.log.other.length, 0, 'choosing a driver makes no outside call at all');
    assert.equal(body.mode, 'driver-week-choose');
    assert.deepEqual(body.week.from, '2026-09-14');
    assert.deepEqual(body.drivers.map((d) => `${d.key}:${d.loads}`), ['COLIN:2', 'ENOCK_AKYEA:1']);
    assert.deepEqual(body.days.map((d) => `${d.date.slice(8)}:${d.source}`),
      ['14:sealed', '15:none', '16:sealed', '17:none', '18:none', '19:none', '20:none']);
    const m = fake.log.listMasks.find((x) => x.path === `history_days/${T}__${MON}/stops`);
    assert.deepEqual(m.mask.slice().sort(), LOAD_STOP_FIELDS.slice().sort(), 'a whole day is read — masked, never with raw');
  } finally { fake.restore(); }
});

test('ONE DRIVER: his loads, the run in delivery order sent to Google yard to yard, priced once, cost said absent', async () => {
  const bodies = [];
  const fake = installFirestoreFake(SEED, googleStub(bodies));
  try {
    const { body } = await withKey(() => call(`week=2026-09-17&driver=colin`));
    assert.equal(body.mode, 'driver-week');
    assert.equal(body.nuvizzCalls, 0);
    assert.ok(fake.log.other.every((o) => o.url.startsWith(GOOGLE)), 'the only outside call is Google');
    assert.equal(body.driver.key, 'COLIN');
    assert.deepEqual(body.loads.map((l) => `${l.date}|${l.name}|${l.truck}`), [`${MON}|COLIN 1|tractor`, `${WED}|COLIN 1|null`]);
    // ONE REQUEST PER LOAD, and the Monday path is yard → 002 (8:15) → 001 (10:30) → yard.
    assert.equal(body.googleCalls, 2);
    const mon = bodies.find((b) => b.intermediates?.length === 2);
    assert.deepEqual(mon.origin.location.latLng, { latitude: YARD.lat, longitude: YARD.lng });
    assert.deepEqual(mon.destination.location.latLng, { latitude: YARD.lat, longitude: YARD.lng });
    assert.deepEqual(mon.intermediates.map((p) => p.location.latLng.latitude), [34.25, 34.30], 'the order it was DELIVERED in, not dispatched');
    assert.equal(mon.intermediates[0].vehicleStopover, true);
    assert.equal(body.loads[0].miles.miles, 50);
    assert.equal(body.loads[0].miles.source, 'google');
    // Priced: two Uline orders delivered Monday, an Estes Seal # Wednesday; the exception is priced but not delivered.
    assert.equal(body.loads[0].price.delivered, 100);
    assert.equal(body.loads[0].price.notDelivered, 50);
    assert.equal(body.loads[1].rows[0].priceSource, 'seal');
    assert.equal(body.totals.price.delivered, 263.18);
    assert.equal(body.totals.miles, 100);
    assert.deepEqual(body.cost, { recorded: false, text: body.cost.text });
    assert.match(body.cost.text, /no record of what a load costs/);
    // THE MEASUREMENT IS KEPT, against the path it measured.
    const saved = fake.log.sets.find((x) => x.path.startsWith(`load_miles/${T}__${MON}__COLIN 1__COLIN`));
    assert.ok(saved, 'the distance is cached');
    assert.equal(saved.doc.meters, 80467.2);
    assert.match(saved.doc.fingerprint, /^4:/, 'yard, two stops, yard');
  } finally { fake.restore(); }
});

test('A SEALED LOAD IS MEASURED ONCE — the second look reads the cache and asks Google nothing', async () => {
  const bodies = [];
  const fake = installFirestoreFake(SEED, googleStub(bodies));
  try {
    await withKey(() => call(`week=2026-09-17&key=COLIN`));
    const before = bodies.length;
    const { body } = await withKey(() => call(`week=2026-09-17&key=COLIN`));
    assert.equal(bodies.length, before, 'no second Google request');
    assert.equal(body.googleCalls, 0);
    assert.equal(body.miles.cached, 2);
    assert.equal(body.loads[0].miles.source, 'cache');
  } finally { fake.restore(); }
});

test('A CACHED DISTANCE FOR A DIFFERENT PATH IS NOT USED — the load changed, so it is measured again', async () => {
  const bodies = [];
  const fake = installFirestoreFake({
    ...SEED,
    [`load_miles/${T}__${MON}__COLIN 1__COLIN`]: { fingerprint: '4:deadbeef', meters: 1 },
  }, googleStub(bodies));
  try {
    const { body } = await withKey(() => call(`week=2026-09-17&key=COLIN`));
    assert.equal(body.loads[0].miles.source, 'google');
    assert.equal(body.loads[0].miles.miles, 50);
  } finally { fake.restore(); }
});

test('LOAD_MILES=off: no Google, no cache read, and the answer says the miles are off', async () => {
  const fake = installFirestoreFake(SEED);
  process.env.LOAD_MILES = 'off';
  try {
    const { body } = await withKey(() => call(`week=2026-09-17&key=COLIN`));
    assert.equal(fake.log.other.length, 0);
    assert.equal(body.miles.enabled, false);
    assert.equal(body.loads[0].miles.miles, null);
    assert.ok(!fake.log.gets.some((p) => p.startsWith('load_miles/')), 'switched off means the cache is not read either');
  } finally { delete process.env.LOAD_MILES; fake.restore(); }
});

test('no Google key, or Google failing: no number, a reason — and a failure is not cached', async () => {
  const fake = installFirestoreFake(SEED);
  try {
    const { body } = await withKey(() => call(`week=2026-09-17&key=COLIN`), null);
    assert.equal(fake.log.other.length, 0);
    assert.equal(body.loads[0].miles.miles, null);
    assert.match(body.loads[0].miles.reason, /no Google Routes key/);
  } finally { fake.restore(); }
  const fail = installFirestoreFake(SEED, async () => new Response('{"error":"quota"}', { status: 429 }));
  try {
    const { body } = await withKey(() => call(`week=2026-09-17&key=COLIN`));
    assert.match(body.loads[0].miles.reason, /Google was busy and did not measure it/);
    assert.equal(body.miles.failed, 2);
    assert.ok(!fail.log.sets.some((x) => x.path.startsWith('load_miles/')), 'a failed measurement is tried again next time, not remembered');
  } finally { fail.restore(); }
});

test('two Anthonys is a choice; a name nobody ran under says so and lists who did', async () => {
  const fake = installFirestoreFake({
    ...sealed(MON, [
      st('1', MON, { driverName: 'Anthony  Bennett', driverUserName: 'Anthony  Bennett', routeName: 'ANTHONY B', loadNbr: 'ANTHONY B' }),
      st('2', MON, { driverName: 'Anthony Wells', driverUserName: 'Anthony Wells', routeName: 'ANTHONY W', loadNbr: 'ANTHONY W' }),
    ]),
  });
  try {
    const two = await call(`week=${MON}&driver=anthony`);
    assert.equal(two.body.mode, 'driver-week-choose');
    assert.deepEqual(two.body.candidates.map((c) => c.label), ['Anthony Bennett', 'Anthony Wells']);
    const none = await call(`week=${MON}&driver=zed`);
    assert.deepEqual(none.body.candidates, []);
    assert.equal(none.body.drivers.length, 2);
  } finally { fake.restore(); }
});

test('A DAY THAT COULD NOT BE READ IS SAID — never a short week passed off as a whole one', async () => {
  const fake = installFirestoreFake(SEED);
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => (String(input?.url ?? input).includes(`/documents/history_days/${T}__${WED}`)
    ? new Response('{"error":"boom"}', { status: 500 })
    : inner(input, init));
  try {
    const { body } = await call(`week=2026-09-17`);
    assert.equal(body.complete, false);
    const wed = body.days.find((d) => d.date === WED);
    assert.equal(wed.source, 'unread');
    assert.ok(wed.error);
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('explain=1 answers in COUNTS — what the records hold for prices and times, naming nobody', async () => {
  const fake = installFirestoreFake(SEED);
  try {
    const { body } = await call(`week=2026-09-17&explain=1`);
    assert.equal(body.mode, 'explain');
    const mon = body.explain.find((d) => d.date === MON);
    assert.deepEqual(
      [mon.rows, mon.onLoads, mon.delivered, mon.deliveredWithTime, mon.priceFromUline, mon.priceFromSeal, mon.unpriced],
      [4, 4, 3, 3, 4, 0, 0],
    );
    assert.equal(body.explain.find((d) => d.date === WED).priceFromSeal, 1);
    // Whose orders go unpriced, and how many loads could carry a rate — counts, keyed by shipper
    // prefix and never by customer.
    assert.deepEqual(mon.unpricedByShipper, {});
    assert.deepEqual([mon.loads, mon.loadsFullyPriced], [2, 2]);
    const text = JSON.stringify(body);
    assert.ok(!/CONSIGNEE|COLIN|ENOCK|CUMMING/.test(text), 'no customer, place or driver in a count');
  } finally { fake.restore(); }
});

test('a future day is not read; today comes off the board; a malformed week is refused', async () => {
  const { etDayString } = await import('../netlify/functions/lib/firestore.mts');
  const today = etDayString();
  const fake = installFirestoreFake({
    [`nuvizz_stop_index/${T}__${today}`]: { tenant: T, date: today },
    [`nuvizz_stop_index/${T}__${today}/stops/a`]: st('007180001', today),
  });
  try {
    const { body } = await call(`week=${today}`);
    const t = body.days.find((d) => d.date === today);
    assert.equal(t.source, 'board');
    assert.ok(body.days.filter((d) => d.date > today).every((d) => d.source === 'future'));
    assert.ok(!fake.log.lists.some((p) => body.days.some((d) => d.date > today && p.includes(d.date))), 'nothing is read for a day that has not happened');
    assert.equal((await call('week=09/17/2026')).status, 400);
  } finally { fake.restore(); }
});

test('the projection carries every field the load rules read', () => {
  for (const f of ['stopNbr', 'stopType', 'businessName', 'city', 'lat', 'lng', 'driverName', 'driverUserName', 'routeName',
    'loadNbr', 'normalizedStatus', 'deliveredDTTM', 'executed.deliveredDTTM', 'raw.stopExecutionInfo.to.deliveredDTTM',
    'routeSeq', 'loadStopSeq', 'plannedEtaDTTM', 'cartons', 'volume', 'weight', 'isAttempt', 'orderInstructions',
    'signalSources.orderInstructions', 'raw.stop.sealNbr', 'raw.stopExecutionInfo.cancellation']) {
    assert.ok(LOAD_STOP_FIELDS.includes(f), `LOAD_STOP_FIELDS must carry ${f}`);
  }
  assert.ok(!LOAD_STOP_FIELDS.includes('raw'), 'never the whole raw object');
});

test('ZERO NUVIZZ CALLS BY CONSTRUCTION, gated at dispatcher, and the switch is the house shape', async () => {
  const src = readFileSync(new URL('../netlify/functions/driver-loads.mts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import [\s\S]*?from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 8);
  for (const i of imports) assert.ok(!/nuvizz-(scan|request|list|loads|write|rwb)/.test(i), `must not import a vendor-calling module: ${i}`);
  assert.match(src, /nuvizzCalls: 0/);
  assert.match(src, /requireUser\(req, \{ role: 'dispatcher' \}\)/);
  const { loadMilesEnabled } = await import('../netlify/functions/driver-loads.mts');
  assert.equal(loadMilesEnabled({}), true);
  assert.equal(loadMilesEnabled({ LOAD_MILES: 'off' }), false);
  assert.equal(loadMilesEnabled({ LOAD_MILES: 'NO' }), false);
  assert.equal(loadMilesEnabled({ LOAD_MILES: 'of' }), true, 'a typo leaves it on — a quiet feature looks like a working one');
  const { googleRefusal } = await import('../netlify/functions/driver-loads.mts');
  assert.match(googleRefusal(403), /Routes key may not allow route requests/, 'a refused key says so rather than "no route"');
  assert.match(googleRefusal(500), /answered 500/);
});

test('a load called "APPT #2" is cached like any other — a # or ? in a name must not cost a Google call every look', async () => {
  const bodies = [];
  const D = '2026-09-15';
  const fake = installFirestoreFake(sealed(D, [
    st('007170101', D, { routeName: 'APPT #2', loadNbr: 'APPT #2', lat: 34.3, lng: -84.1 }),
    st('007170102', D, { routeName: 'COLIN/DJ 1', loadNbr: 'COLIN/DJ 1', lat: 34.2, lng: -84.2 }),
  ]), googleStub(bodies));
  try {
    const { loadMilesPath } = await import('../netlify/functions/driver-loads.mts');
    const { assertSafePath } = await import('../netlify/functions/lib/firestore.mts');
    for (const name of ['APPT #2', 'WHY? 3', 'COLIN/DJ 1', 'ATLANTA SOUTHWEST 3 — LATE SHIFT']) {
      assert.doesNotThrow(() => assertSafePath(loadMilesPath(D, name, 'COLIN')), `${name} must make a legal path`);
    }
    await withKey(() => call(`week=${D}&key=COLIN`));
    const first = bodies.length;
    assert.equal(first, 2, 'both loads measured once');
    const { body } = await withKey(() => call(`week=${D}&key=COLIN`));
    assert.equal(bodies.length, first, 'and the second look is all cache');
    assert.deepEqual(body.loads.map((l) => l.miles.source), ['cache', 'cache']);
  } finally { fake.restore(); }
});

test('explain=1 says WHOSE orders are unpriced and how many loads could carry a rate', async () => {
  const D = '2026-09-15';
  const fake = installFirestoreFake(sealed(D, [
    st('007170201', D),                                                                            // Uline, priced
    st('ESTES-0538240001', D, { orderInstructions: '' }),                                           // Estes, no price
    st('AVRT-0170416601', D, { orderInstructions: '', routeName: 'NOR 2', loadNbr: 'NOR 2' }),      // Averitt, no price
    st('007170202', D, { routeName: 'NOR 2', loadNbr: 'NOR 2' }),
    st('007170203', D, { routeName: 'EAST 1', loadNbr: 'EAST 1' }),
  ]));
  try {
    const { body } = await call(`week=${D}&explain=1`);
    const d = body.explain.find((x) => x.date === D);
    assert.deepEqual(d.unpricedByShipper, { ESTES: 1, AVRT: 1 });
    assert.deepEqual([d.loads, d.loadsFullyPriced], [3, 1], 'COLIN 1 and NOR 2 each hold an unpriced order; EAST 1 is whole');
    assert.ok(!/0538240001|0170416601|CONSIGNEE/.test(JSON.stringify(body)), 'a prefix count, never an order or a customer');
  } finally { fake.restore(); }
});

