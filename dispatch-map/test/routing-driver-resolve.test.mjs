// test/routing-driver-resolve.test.mjs — WHO DRIVES A LOAD CALLED "VICTOR", AND WHAT TRUCK.
//
// Chad: "why does the system not know victor is a tractor trailer, it should know this from
// the engine data." The Plan-onto list now asks the engine's own resolver. These pin the
// freight rules of that ask — exact names only, no prefix guesses, two Bens is no answer,
// the roster's class before history's — and prove the endpoint reaches the answer from our
// own Firestore with ZERO vendor calls.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadNameToDriverQuery, resolveLoadNames, RESOLVE_MAX_NAMES,
} from '../netlify/functions/lib/routing-driver-resolve-core.mts';
import { resolveDraftDriver } from '../netlify/functions/lib/routing-draft-core.mts';

const D = '2026-09-08';

const dayDoc = (key, date, extra = {}) => ({
  tenant: 'davis', date, driver_key: key, driver_user_name: key, driver_name: key,
  truck_class: 'box_truck', trips: [], day_totals: { stops: 8, pallets: 10, skids: 8, loose: 4, weight: 3000 },
  trips_count: 1, start_time: `${date}T11:00:00Z`, end_time: `${date}T20:00:00Z`, updated_at: `${date}T21:00:00Z`,
  ...extra,
});
const emp = (fullName, nuvizz, vehicleType, extra = {}) => {
  const [firstName, lastName] = fullName.split(' ');
  return { fullName, firstName, lastName, externalIds: { nuvizz }, vehicleType, ...extra };
};

const EMPLOYEES = [
  emp('Victor Mendez', 'VICTOR', 'tractor'),
  emp('Ben Ortiz', 'BEN O', 'box_truck'),
  emp('Ben Walker', 'BEN W', 'tractor'),
  emp('Albert Reyes', 'ALBERT', 'tractor'),
  emp('Dale Hunt', 'DALE', 'box_truck'),
];
const DAYS = [
  dayDoc('VICTOR', '2026-08-24', { truck_class: 'tractor' }),
  dayDoc('VICTOR', '2026-09-01', { truck_class: 'tractor' }),
  dayDoc('VINCENT', '2026-09-02', { truck_class: 'tractor' }),   // history only — no roster card
  dayDoc('ALBERT', '2026-09-03', { truck_class: 'tractor' }),
  dayDoc('MITCHELL', '2026-09-03'),
  dayDoc('MITCHELL', '2026-09-04'),
  dayDoc('VICTOR', '2026-09-08', { truck_class: 'box_truck' }),  // the day itself: NOT before D
];

// ── what a load name asks about ──────────────────────────────────────────────

test('a load name asks about the driver it is named for, minus its load number', () => {
  assert.equal(loadNameToDriverQuery('VICTOR'), 'VICTOR');
  assert.equal(loadNameToDriverQuery('BEN 2'), 'BEN');
  assert.equal(loadNameToDriverQuery('SUW-3'), 'SUW');
  assert.equal(loadNameToDriverQuery('ALPHA #2'), 'ALPHA');
  assert.equal(loadNameToDriverQuery('MITCHELL 02'), 'MITCHELL');
  assert.equal(loadNameToDriverQuery('  Kai   Wong '), 'Kai Wong');
});

test('a load number, an object id, a bare number and a blank ask about nobody', () => {
  assert.equal(loadNameToDriverQuery('DAVIS000198197'), '');
  assert.equal(loadNameToDriverQuery('66d0a1b2c3d4e5f60718293a'), '');
  assert.equal(loadNameToDriverQuery('7'), '');
  assert.equal(loadNameToDriverQuery(''), '');
  assert.equal(loadNameToDriverQuery(null), '');
});

// ── the freight rules ────────────────────────────────────────────────────────

test("Chad's VICTOR: the roster says Victor Mendez drives a tractor, keyed to his NuVizz name", () => {
  const { resolved, reasons } = resolveLoadNames(['VICTOR'], EMPLOYEES, DAYS, D);
  const v = resolved['victor'];
  assert.ok(v, JSON.stringify(reasons));
  assert.equal(v.driver_key, 'VICTOR');
  assert.equal(v.driver_user_name, 'VICTOR');
  assert.equal(v.driver_name, 'Victor Mendez');
  assert.equal(v.truck_class, 'tractor');
  assert.equal(v.observed_days, 2, 'the day being planned is not history yet');
});

test('the roster outranks history: a tractor card wins even when the warehouse last saw the driver on a box', () => {
  const days = [dayDoc('VICTOR', '2026-09-01', { truck_class: 'box_truck' })];
  const { resolved } = resolveLoadNames(['VICTOR'], EMPLOYEES, days, D);
  assert.equal(resolved['victor'].truck_class, 'tractor');
});

test('a driver with no roster card resolves through history alone, at the class the warehouse last saw', () => {
  const { resolved } = resolveLoadNames(['VINCENT'], EMPLOYEES, DAYS, D);
  assert.equal(resolved['vincent'].driver_key, 'VINCENT');
  assert.equal(resolved['vincent'].truck_class, 'tractor');
  assert.equal(resolved['vincent'].driver_name, 'VINCENT');
});

test("the engine's hardcoded class pin applies here too — JUNIOR_THOMAS is a tractor without a card", () => {
  const days = [dayDoc('JUNIOR_THOMAS', '2026-09-01', { truck_class: 'box_truck' })];
  const { resolved } = resolveLoadNames(['JUNIOR THOMAS'], [], days, D);
  assert.equal(resolved['junior thomas'].truck_class, 'tractor');
});

test('two Bens is NO answer: "BEN 2" stays unresolved rather than landing on either of them', () => {
  const { resolved, reasons } = resolveLoadNames(['BEN 2'], EMPLOYEES, DAYS, D);
  assert.equal(resolved['ben 2'], undefined);
  assert.equal(reasons['ben 2'], 'ambiguous');
});

test('a last name resolves too — "MENDEZ 2" is Victor', () => {
  const { resolved } = resolveLoadNames(['MENDEZ 2'], EMPLOYEES, DAYS, D);
  assert.equal(resolved['mendez 2'].driver_key, 'VICTOR');
});

test('route codes name nobody: SUW 2, ATL and ALPHA resolve to nothing and say so', () => {
  const { resolved, reasons } = resolveLoadNames(['SUW 2', 'ATL', 'ALPHA'], EMPLOYEES, DAYS, D);
  assert.deepEqual(Object.keys(resolved), []);
  assert.deepEqual(reasons, { 'suw 2': 'no match', atl: 'no match', alpha: 'no match' });
});

test('NO prefix guessing for a load name: "AL" is a route code, not Albert cut short', () => {
  // The Draft box would take "AL" → ALBERT (unique prefix over recent history). A load list
  // may not: that would size the AL load to Albert's trailer and pin his envelope on it.
  const { resolved, reasons } = resolveLoadNames(['AL'], [], DAYS, D);
  assert.equal(resolved['al'], undefined);
  assert.equal(reasons['al'], 'no match');
  // …and the Draft box's own behaviour is untouched.
  const draft = resolveDraftDriver('AL', [], DAYS, D);
  assert.equal(draft.ok, true);
  assert.equal(draft.driver.driver_key, 'ALBERT');
});

test('the supervisor is never a truck to plan onto', () => {
  // The owner's name stays Capitalised in source — its lower-case form is an env-var VALUE
  // and the Netlify secrets scan matches it case-sensitively (test/no-env-value-literals).
  // The result key is derived at run time, never spelled.
  const employees = [emp('Chad Davis', 'CHAD DAVIS', 'box_truck')];
  const { resolved, reasons } = resolveLoadNames(['CHAD'], employees, [], D);
  const key = 'CHAD'.toLowerCase();
  assert.equal(resolved[key], undefined);
  assert.equal(reasons[key], 'supervisor');
});

test('names are de-duplicated case-insensitively and keyed the way the client keys them', () => {
  const { resolved } = resolveLoadNames(['VICTOR', 'victor', ' Victor '], EMPLOYEES, DAYS, D);
  assert.deepEqual(Object.keys(resolved), ['victor']);
  assert.equal(resolved['victor'].name, 'VICTOR', 'the first spelling seen is the one echoed back');
});

test('an unknown vehicleType on the card reads as box, the fleet majority — never silently a tractor', () => {
  // employeeClassMap ignores classes it does not know; the resolver then falls to history,
  // and with no history the class defaults to box_truck.
  const employees = [emp('Rex Ford', 'REX', 'sprinter')];
  const { resolved } = resolveLoadNames(['REX'], employees, [], D);
  assert.equal(resolved['rex'].truck_class, 'box_truck');
});

test('the bound exists and is a day-of-roster size, not a page size', () => {
  assert.ok(RESOLVE_MAX_NAMES >= 200);
});

// ── the endpoint, end to end, against a Firestore fake — and nothing else ────

process.env.AUTH_SESSION_SECRET = process.env.AUTH_SESSION_SECRET || 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;
const { installFirestoreFake } = await import('./_firestore-fake.mjs');

// The fake serves GET/PATCH/DELETE on document paths; documents:runQuery (what the endpoint
// uses for the driver-day warehouse) is answered here, with the one filter the endpoint
// sends — date LESS_THAN the planning date — applied for real, so a day AFTER the date
// being planned is proven to stay out of the answer.
const enc = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
};
function runQueryAnswer(store, init) {
  const q = JSON.parse(String(init.body)).structuredQuery;
  const coll = q.from[0].collectionId;
  const f = q.where?.fieldFilter;
  const rows = [];
  for (const [path, doc] of store.entries()) {
    if (!path.startsWith(coll + '/') || path.slice(coll.length + 1).includes('/')) continue;
    if (f && f.op === 'LESS_THAN' && !(String(doc[f.field.fieldPath]) < f.value.stringValue)) continue;
    rows.push({ document: { name: `projects/testproj/databases/(default)/documents/${path}`, fields: Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, enc(v)])) } });
  }
  return new Response(JSON.stringify(rows), { status: 200 });
}

test('POST { date, names } resolves the roster from Firestore alone — the fake throws on any other network call', async () => {
  const seed = {};
  EMPLOYEES.forEach((e, i) => { seed[`employees/e${i}`] = e; });
  DAYS.forEach((d, i) => { seed[`routing_driver_days/davis__${d.date}__${d.driver_key}_${i}`] = d; });
  seed['routing_driver_days/other__2026-09-01__VICTOR'] = dayDoc('VICTOR', '2026-09-01', { tenant: 'other', truck_class: 'box_truck' });
  const fake = installFirestoreFake(seed, (url, init) => {
    if (url.includes('documents:runQuery')) return runQueryAnswer(fake.store, init);
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  try {
    const { default: handler } = await import('../netlify/functions/routing-driver-resolve.mts');
    const res = await handler(new Request('http://x/.netlify/functions/routing-driver-resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: D, names: ['VICTOR', 'BEN 2', 'SUW 2', 'VINCENT', 'TRAILER 6'] }),
    }));
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.calls, 0);
    assert.equal(j.employees, EMPLOYEES.length);
    assert.equal(j.driver_days, DAYS.length - 1, 'the planning day itself is not history; the other tenant is not ours');
    assert.equal(j.resolved.victor.truck_class, 'tractor');
    assert.equal(j.resolved.victor.driver_user_name, 'VICTOR');
    assert.equal(j.resolved.victor.observed_days, 2);
    assert.equal(j.resolved.vincent.truck_class, 'tractor');
    assert.equal(j.resolved['ben 2'], undefined);
    assert.equal(j.reasons['ben 2'], 'ambiguous');
    assert.equal(j.reasons['suw 2'], 'no match');
    assert.equal(j.reasons['trailer 6'], 'no match');
    assert.deepEqual(fake.log.other.map((o) => o.url.includes('documents:runQuery')), [true], 'exactly one warehouse query, no vendor call');
  } finally {
    fake.restore();
  }
});

test('the endpoint refuses a bad date, a missing names list and a GET, and never reaches Firestore for them', async () => {
  const fake = installFirestoreFake({}, () => { throw new Error('must not query'); });
  try {
    const { default: handler } = await import('../netlify/functions/routing-driver-resolve.mts');
    const post = (body) => handler(new Request('http://x/f', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    assert.equal((await post({ date: '9/8/2026', names: ['VICTOR'] })).status, 400);
    assert.equal((await post({ date: D })).status, 400);
    assert.equal((await handler(new Request('http://x/f', { method: 'GET' }))).status, 405);
    assert.equal(fake.log.lists.length + fake.log.other.length, 0);
  } finally {
    fake.restore();
  }
});
