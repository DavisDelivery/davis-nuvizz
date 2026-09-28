// test/draft-driver-list.test.mjs — STEP 4 · BY DRIVER IS A LIST YOU PICK FROM.
//
// Chad, on the box that read "Victor, Scott": "This should be a list that i select from not a
// type in situation other than type in to find the name or route to select."
//
// Pins: the list is exactly the cast the engine drafts from (a route in the window, never a
// supervisor, never another tenant), each row says what the draft will use (name, class) and the
// routes the driver runs, a pick is sent and honoured as the exact driver key — so the two
// typed-name faults the QA review found (a code landing on the other Victor, "Allen, John" read
// as two people) cannot happen from this screen — and the box only narrows. The endpoint runs
// against an in-memory Firestore with every other network call refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';
installServiceAccountEnv();
delete process.env.AUTH_REQUIRED;

import routingDraft from '../netlify/functions/routing-draft.mts';
import {
  draftableDrivers, resolveDraftDriverKey, routeNameFromRoster, rosterWindowFrom, recentRosterKeys, ROSTER_WINDOW_DAYS,
} from '../netlify/functions/lib/routing-draft-core.mts';
import {
  filterDraftDrivers, draftDriverMatches, togglePick, keepListedPicks, DRAFT_MAX_DRIVERS, draftDriverClassLabel,
} from '../src/lib/draft-driver-list.js';

const D = '2026-09-29';
const FROM = rosterWindowFrom(D);                         // 2026-08-30

// ── a small depot: two Victors (one with an employee card, one without), John Allen, the boss,
// a driver last seen before the window, and a driver whose only day is the day being built ──
const EMPLOYEES = [
  { fullName: 'Victor Martinez', firstName: 'Victor', lastName: 'Martinez', externalIds: { nuvizz: 'VICTOR_M' }, vehicleType: 'tractor' },
  { fullName: 'John Allen', firstName: 'John', lastName: 'Allen', externalIds: { nuvizz: 'JALLEN' } },
];
const day = (key, date, loadKeys, extra = {}) => ({
  tenant: 'davis', date, driver_key: key, driver_user_name: key, driver_name: key, truck_class: 'box_truck',
  trips: loadKeys.map((k, i) => ({ load_key: k, seq_index: i + 1, stops: 8, pallets: 10, skids: 8, loose: 2, weight: 3000 })),
  day_totals: { stops: 8 * loadKeys.length, pallets: 10, skids: 8, loose: 2, weight: 3000 }, trips_count: loadKeys.length,
  ...extra,
});
const DAYS = [
  day('VICTOR_M', '2026-09-22', ['DAVIS0001']),
  day('VICTOR_M', '2026-09-24', ['DAVIS0002']),
  day('VICTOR_M', '2026-09-26', ['DAVIS0003', 'DAVIS0004']),
  day('VICTOR', '2026-09-25', ['DAVIS0005'], { driver_name: 'Victor Reyes' }),
  day('JALLEN', '2026-09-26', ['CANTON__JALLEN']),        // no load number: the name rides the key
  day('CHAD_DAVIS', '2026-09-26', ['DAVIS0006']),          // the supervisor — never listed
  day('OLDIE', '2026-08-01', ['DAVIS0007']),               // outside the window
  day('TODAY_ONLY', D, ['DAVIS0008']),                     // the day being built is not history
  day('OTHER_TENANT', '2026-09-26', ['DAVIS0009'], { tenant: 'elsewhere' }),
];
const ROSTERS = {
  '2026-09-22': [{ loadNbr: 'DAVIS0001', name: 'SUW 2' }],
  '2026-09-24': [{ loadNbr: 'DAVIS0002', name: 'SUW 2' }],
  '2026-09-26': [{ loadNbr: 'DAVIS0003', name: 'CHE' }, { loadNbr: 'DAVIS0006', name: 'OFFICE' }],   // DAVIS0004 was never captured
  '2026-09-25': [{ loadNbr: 'DAVIS0005', name: 'ALPH 1' }],
};
const routeNameFor = (date, loadKey) => routeNameFromRoster(loadKey, ROSTERS[date]);
const inTenant = DAYS.filter((d) => d.tenant === 'davis');

test('THE LIST IS THE ENGINE\'S OWN CAST: a route in the 30 days before the date — never the boss, never older, never the day itself', () => {
  const list = draftableDrivers(inTenant, EMPLOYEES, D, routeNameFor);
  assert.deepEqual(list.map((d) => d.key).sort(), ['JALLEN', 'VICTOR', 'VICTOR_M']);
  assert.deepEqual(new Set(list.map((d) => d.key)), recentRosterKeys(inTenant, D), 'the same set the draft computes its candidates against');
  assert.deepEqual(list.map((d) => d.name), [...list.map((d) => d.name)].sort((a, b) => a.localeCompare(b)), 'A→Z by name, so a row never moves under the cursor');
});

test('each row says what the draft will use and what the driver runs — route names read exactly, never guessed', () => {
  const byKey = new Map(draftableDrivers(inTenant, EMPLOYEES, D, routeNameFor).map((d) => [d.key, d]));
  const vm = byKey.get('VICTOR_M');
  assert.equal(vm.name, 'Victor Martinez', 'the employee card gives the name');
  assert.equal(vm.truckClass, 'tractor', 'the class the draft will plan them on (the card says tractor)');
  assert.deepEqual(vm.routes, ['SUW 2', 'CHE'], 'most-run first; DAVIS0004 was never captured, so it names nothing');
  assert.equal(vm.days, 3);
  assert.equal(vm.lastDate, '2026-09-26');
  assert.deepEqual(byKey.get('JALLEN').routes, ['CANTON'], 'a load with no number carries its route name in the key');
  assert.equal(byKey.get('VICTOR').name, 'Victor Reyes', 'no card: the name NuVizz had on that day');
  assert.equal(byKey.get('VICTOR').truckClass, 'box_truck');
});

test('THE LIST AND THE DRAFT AGREE: a picked key resolves to the very name, user and class its row showed', () => {
  for (const row of draftableDrivers(inTenant, EMPLOYEES, D, routeNameFor)) {
    const r = resolveDraftDriverKey(row.key, EMPLOYEES, inTenant, D);
    assert.equal(r.ok, true, row.key);
    assert.equal(r.driver.driver_key, row.key);
    assert.equal(r.driver.truck_class, row.truckClass, `${row.key}: class`);
    assert.equal(r.driver.driver_name || r.driver.driver_key, row.name, `${row.key}: name`);
    assert.equal(r.driver.driver_user_name, row.userName, `${row.key}: user`);
  }
});

test('A PICK IS THAT DRIVER: the card-less VICTOR is VICTOR, not the Victor with an employee card; the boss and a stale key are refused by name', () => {
  const v = resolveDraftDriverKey('VICTOR', EMPLOYEES, inTenant, D);
  assert.equal(v.ok && v.driver.driver_key, 'VICTOR');
  const boss = resolveDraftDriverKey('CHAD_DAVIS', EMPLOYEES, inTenant, D);
  assert.equal(boss.ok, false);
  assert.match(boss.error, /supervisor/);
  const old = resolveDraftDriverKey('OLDIE', EMPLOYEES, inTenant, D);
  assert.equal(old.ok, false);
  assert.match(old.error, new RegExp(`OLDIE has not run a route in the ${ROSTER_WINDOW_DAYS} days before ${D}`));
  assert.equal(resolveDraftDriverKey('  ', EMPLOYEES, inTenant, D).ok, false);
  // keys are matched EXACTLY — driverKeyFor's no-userName fallback is lower case and must stay so
  const named = [day('name_pat_lee', '2026-09-20', ['DAVIS0010'])];
  assert.equal(resolveDraftDriverKey('name_pat_lee', [], named, D).ok, true);
  assert.equal(resolveDraftDriverKey('NAME_PAT_LEE', [], named, D).ok, false, 'a key is never folded into a different one');
});

test('route names: a load number is looked up exactly in that day\'s roster, or names nothing', () => {
  assert.equal(routeNameFromRoster('DAVIS0003', ROSTERS['2026-09-26']), 'CHE');
  assert.equal(routeNameFromRoster('DAVIS0004', ROSTERS['2026-09-26']), null);
  assert.equal(routeNameFromRoster('DAVIS000', ROSTERS['2026-09-26']), null, 'no prefix match');
  assert.equal(routeNameFromRoster('SUW 1__FRYE', null), 'SUW 1');
  assert.equal(routeNameFromRoster('', ROSTERS['2026-09-26']), null);
});

test('the window read is the window counted: the first day of it counts, the day before does not', () => {
  assert.equal(FROM, '2026-08-30');
  const edge = [day('EDGE', FROM, ['X1']), day('BEFORE', '2026-08-29', ['X2'])];
  assert.deepEqual([...recentRosterKeys(edge, D)], ['EDGE']);
});

// ── the endpoint, on an in-memory Firestore ────────────────────────────────────────────────
const seedFor = () => {
  const seed = {};
  for (const d of DAYS) seed[`routing_driver_days/${d.tenant}__${d.date}__${d.driver_key}`] = d;
  EMPLOYEES.forEach((e, i) => { seed[`employees/e${i}`] = e; });
  for (const [date, loads] of Object.entries(ROSTERS)) seed[`nuvizz_load_roster/davis__${date}`] = { loadsJson: JSON.stringify(loads), at: `${date}T22:00:00Z` };
  return seed;
};
const get = (qs) => routingDraft(new Request(`https://x.test/.netlify/functions/routing-draft${qs}`, { method: 'GET' }));

test('GET ?date= answers the list off Firestore alone — one windowed query, no other network call', async () => {
  const fake = installFirestoreFake(seedFor());
  try {
    const res = await get(`?date=${D}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.from, FROM);
    assert.equal(body.windowDays, ROSTER_WINDOW_DAYS);
    assert.deepEqual(body.drivers.map((d) => d.key).sort(), ['JALLEN', 'VICTOR', 'VICTOR_M'], 'another tenant\'s driver is not listed');
    assert.deepEqual(body.drivers.find((d) => d.key === 'VICTOR_M').routes, ['SUW 2', 'CHE']);
    const q = fake.log.queries.find((x) => x.from?.[0]?.collectionId === 'routing_driver_days');
    const ops = (q?.where?.compositeFilter?.filters || []).map((f) => `${f.fieldFilter.op} ${f.fieldFilter.value.stringValue}`);
    assert.deepEqual(ops, [`GREATER_THAN_OR_EQUAL ${FROM}`, `LESS_THAN ${D}`], 'only the window is read, never the whole history');
  } finally { fake.restore(); }
});

test('GET refuses a bad date, and anything but GET or POST', async () => {
  const fake = installFirestoreFake(seedFor());
  try {
    assert.equal((await get('?date=tomorrow')).status, 400);
    const put = await routingDraft(new Request('https://x.test/.netlify/functions/routing-draft', { method: 'PUT' }));
    assert.equal(put.status, 405);
  } finally { fake.restore(); }
});

// POST runs the real draft. loadPlanInputs reads the driver days with a single `date < D` query,
// a shape the fake answers only through its own hook — served here from the same documents.
const encode = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
};
function queryHook(url, init) {
  if (!String(url).includes(':runQuery')) throw new Error(`no network call is allowed here: ${url}`);
  const q = JSON.parse(String(init.body || '{}')).structuredQuery || {};
  if (q.from?.[0]?.collectionId !== 'routing_driver_days') return new Response('[]', { status: 200 });
  const f = q.where?.fieldFilter;
  const rows = DAYS.filter((d) => (f?.op === 'LESS_THAN' ? d.date < f.value.stringValue : true));
  const body = rows.map((d) => ({ document: { name: `projects/testproj/databases/(default)/documents/routing_driver_days/${d.tenant}__${d.date}__${d.driver_key}`, fields: encode(d).mapValue.fields } }));
  return new Response(JSON.stringify(body), { status: 200 });
}
const boardSeed = () => {
  const seed = { ...seedFor(), [`nuvizz_stop_index/davis__${D}`]: { tenant: 'davis', date: D } };
  [['A1', 34.0, -84.0], ['A2', 34.01, -84.01]].forEach(([n, lat, lng]) => {
    seed[`nuvizz_stop_index/davis__${D}/stops/${n}`] = { stopNbr: n, businessName: `CUST ${n}`, addr1: `1 ${n} St`, city: 'CANTON', zip: '30114', lat, lng, isUnplanned: true, cartons: 1, weight: 200 };
  });
  return seed;
};
const post = (body) => routingDraft(new Request('https://x.test/.netlify/functions/routing-draft', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

test('POST driver_keys drafts exactly the drivers picked — the card-less VICTOR is drafted as VICTOR', async () => {
  const fake = installFirestoreFake(boardSeed(), queryHook);
  try {
    const res = await post({ date: D, driver_keys: ['VICTOR', 'JALLEN'] });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.drivers.map((d) => d.driver_key).sort(), ['JALLEN', 'VICTOR']);
  } finally { fake.restore(); }
});

test('POST driver_keys refuses a fifth driver, the boss and a key off the list — by name, never re-matched', async () => {
  const fake = installFirestoreFake(boardSeed(), queryHook);
  try {
    const five = await post({ date: D, driver_keys: ['VICTOR', 'JALLEN', 'VICTOR_M', 'A', 'B'] });
    assert.equal(five.status, 400);
    assert.match((await five.json()).error, /pick 1-4 drivers/);
    const bad = await post({ date: D, driver_keys: ['CHAD_DAVIS', 'OLDIE'] });
    assert.equal(bad.status, 400);
    const details = (await bad.json()).details.join('\n');
    assert.match(details, /CHAD_DAVIS is a supervisor/);
    assert.match(details, /OLDIE has not run a route/);
  } finally { fake.restore(); }
});

test('POST drivers (typed names) still answers as before, for anything that still sends names', async () => {
  const fake = installFirestoreFake(boardSeed(), queryHook);
  try {
    const res = await post({ date: D, drivers: ['John Allen'] });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.drivers.map((d) => d.driver_key), ['JALLEN']);
  } finally { fake.restore(); }
});

// ── the box only narrows ───────────────────────────────────────────────────────────────────
const LIST = [
  { key: 'JALLEN', name: 'John Allen', userName: 'JALLEN', routes: ['CANTON'] },
  { key: 'VICTOR', name: 'Victor Reyes', userName: 'VICTOR', routes: ['ALPH 1'] },
  { key: 'VICTOR_M', name: 'Victor Martinez', userName: 'VICTOR_M', routes: ['SUW 2', 'CHE'] },
];

test('the box finds a driver by name, by code or by a route they run — every word must hit, prefixes only, never fuzzy', () => {
  assert.deepEqual(filterDraftDrivers(LIST, 'suw').map((d) => d.key), ['VICTOR_M'], 'who runs Suwanee');
  assert.deepEqual(filterDraftDrivers(LIST, 'vic').map((d) => d.key), ['VICTOR', 'VICTOR_M']);
  assert.deepEqual(filterDraftDrivers(LIST, 'vic mar').map((d) => d.key), ['VICTOR_M'], 'AND across words');
  assert.deepEqual(filterDraftDrivers(LIST, 'allen john').map((d) => d.key), ['JALLEN'], 'any order');
  assert.deepEqual(filterDraftDrivers(LIST, 'jallen').map((d) => d.key), ['JALLEN'], 'the NuVizz code');
  assert.deepEqual(filterDraftDrivers(LIST, 'ctor').map((d) => d.key), [], 'not a substring search');
  assert.deepEqual(filterDraftDrivers(LIST, '').map((d) => d.key), ['JALLEN', 'VICTOR', 'VICTOR_M'], 'an empty box hides nobody, order kept');
  assert.equal(draftDriverMatches({ key: 'X', name: 'X', routes: [] }, 'x'), true);
});

test(`a pick toggles; a ${DRAFT_MAX_DRIVERS + 1}th is refused; a new day's list drops a driver it does not carry`, () => {
  let p = [];
  for (const k of ['A', 'B', 'C', 'D']) p = togglePick(p, k);
  assert.deepEqual(p, ['A', 'B', 'C', 'D']);
  assert.deepEqual(togglePick(p, 'E'), p, 'the fifth is refused, the four are kept');
  assert.deepEqual(togglePick(p, 'B'), ['A', 'C', 'D'], 'tapping a picked row takes it off');
  assert.deepEqual(keepListedPicks(['VICTOR', 'GONE'], LIST), ['VICTOR']);
  assert.equal(draftDriverClassLabel('tractor'), 'Tractor');
  assert.equal(draftDriverClassLabel('box_truck'), 'Box truck');
});

test('THE BUILD PANEL SENDS PICKS, NOT TYPING — and the phone view is thumb-sized', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /body: JSON\.stringify\(\{ date: selectedDate, driver_keys: keys \}\)/);
  assert.doesNotMatch(app, /draftNames/, 'no typed-names box is left');
  assert.match(app, /<DraftDriverList[\s\S]{0,400}isMobile=\{isMobile\}/);
  // The list is not fetched for a role the engine refuses (they see the gate's reason, not a 403),
  // and the effect that reads the gate sits BELOW the gate's declaration — above it, the render
  // would throw on a variable that does not exist yet and take the Routing screen with it.
  const gateAt = app.indexOf("const engineGate = useRoleGate('dispatcher');");
  const loadAt = app.indexOf("if (engineMode !== 'driver' || !selectedDate || !engineGate.allowed || draftDrivers.date === selectedDate) return;");
  assert.ok(gateAt > 0 && loadAt > gateAt, 'the list loader reads the gate after it is declared');
  const ui = readFileSync(new URL('../src/components/DraftDriverList.jsx', import.meta.url), 'utf8');
  assert.match(ui, /isMobile \? 'min-h-\[44px\]/, 'every phone row and chip is a full thumb target');
  assert.match(ui, /isMobile \? 'p-2 text-\[16px\]'/, 'a 16px box, so iOS does not zoom the page on focus');
});
