// test/departure-refit-bad-window.test.mjs — A MISTYPED REFIT MUST NOT ERASE EVERY ROUTE'S
// LEARNED DEPARTURE.
//
// A5-S28-4. `route-departures?refit=1&days=abc` parsed the window as NaN, the day loop never ran,
// and the endpoint PUBLISHED an empty table over the good one. Every ETA on the board is walked
// forward from that table, so the whole fleet silently fell back to the 8:00a default — flags
// firing or going quiet on a day nobody changed anything. A bad `through` was not checked either.
//
// Now: a non-numeric `days` takes the documented default (21), a malformed `through` is a 400
// before anything is read, and a refit that learned NOTHING refuses to publish (409) rather than
// replace a table with an empty one. A dry refit still shows its (empty) result as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import routeDepartures, { refitWindow } from '../netlify/functions/route-departures.mts';
import { DEPARTURE_VERSION } from '../netlify/functions/lib/route-departure.mts';

delete process.env.AUTH_REQUIRED;

const GOOD = {
  tenant: 'davis', version: DEPARTURE_VERSION, through: '2026-09-20', days: 21, routes: 1,
  table: { JEAN: { departMin: 395, n: 12, spreadMin: 9 } }, fitted_at: '2026-09-21T08:00:00Z',
};
const call = (qs) => routeDepartures(new Request(`https://x.netlify.app/.netlify/functions/route-departures?${qs}`));

test('refitWindow: a non-numeric or missing days takes the default 21; a number is clamped to 1..30', () => {
  const today = '2026-09-27';
  for (const d of ['abc', '', null, 'NaN', ' ']) assert.equal(refitWindow(d, null, today).days, 21, String(d));
  assert.equal(refitWindow('7', null, today).days, 7);
  assert.equal(refitWindow('0', null, today).days, 1);
  assert.equal(refitWindow('-5', null, today).days, 1);
  assert.equal(refitWindow('999', null, today).days, 30);
  assert.equal(refitWindow('7', null, today).through, '2026-09-26', 'default through is yesterday ET');
});

test('refitWindow: a through that is not a real YYYY-MM-DD day is an error, not a window', () => {
  for (const t of ['garbage', '2026-9-1', '2026-13-01', '2026-02-30', '2026-09-01T00:00']) {
    assert.ok(refitWindow('7', t, '2026-09-27').error, t);
  }
  assert.equal(refitWindow('7', '2026-09-01', '2026-09-27').through, '2026-09-01');
});

test('?refit=1&days=abc no longer erases the learned table: it reads the default 21 days and refuses to publish nothing', async () => {
  const fake = installFirestoreFake({ 'route_departures/davis': GOOD });
  try {
    const r = await call('refit=1&days=abc&through=2026-09-20');
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(fake.log.lists.filter((p) => p.startsWith('history_days/')).length, 21, 'the default window was read');
    assert.deepEqual(fake.store.get('route_departures/davis'), GOOD, 'the good table is untouched');
    assert.equal(fake.log.sets.filter((s) => s.path.startsWith('route_departures')).length, 0);
  } finally { fake.restore(); }
});

test('?refit=1&through=garbage is a 400 and writes nothing', async () => {
  const fake = installFirestoreFake({ 'route_departures/davis': GOOD });
  try {
    const r = await call('refit=1&days=7&through=garbage');
    assert.equal(r.status, 400);
    assert.deepEqual(fake.store.get('route_departures/davis'), GOOD);
    assert.equal(fake.log.lists.length, 0, 'nothing was read for a window that does not exist');
  } finally { fake.restore(); }
});

test('a DRY refit that learned nothing still answers 200 with its empty table (unchanged)', async () => {
  const fake = installFirestoreFake({ 'route_departures/davis': GOOD });
  try {
    const r = await call('refit=1&dry=1&days=2&through=2026-09-20');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.dry, true);
    assert.equal(j.routesPublished, 0);
    assert.deepEqual(fake.store.get('route_departures/davis'), GOOD);
  } finally { fake.restore(); }
});

test('a real refit over three sealed days with a learned route still publishes (unchanged)', async () => {
  const stop = (date) => ({
    stopNbr: `S-${date}`, loadNbr: 'JEAN', routeSeq: 1, stopType: 'DL',
    lat: 34.237791, lng: -83.960911, deliveredDTTM: `${date}T06:30:00`,
  });
  const seed = { 'route_departures/davis': GOOD };
  for (const d of ['2026-09-18', '2026-09-19', '2026-09-20']) seed[`history_days/davis__${d}/stops/S-${d}`] = stop(d);
  const fake = installFirestoreFake(seed);
  try {
    const r = await call('refit=1&days=3&through=2026-09-20');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.routesPublished, 1);
    const doc = fake.store.get('route_departures/davis');
    assert.ok(doc.table.JEAN, 'JEAN was learned and published');
    assert.equal(doc.through, '2026-09-20');
  } finally { fake.restore(); }
});
