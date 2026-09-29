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
  filterDraftDrivers, draftDriverMatches, togglePick, keepListedPicks, sendablePicks, DRAFT_MAX_DRIVERS, draftDriverClassLabel,
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
  day('VICTOR_M', '2026-09-22', ['DAVIS000200001']),
  day('VICTOR_M', '2026-09-24', ['DAVIS000200002']),
  day('VICTOR_M', '2026-09-26', ['DAVIS000200003', 'DAVIS000200004']),
  day('VICTOR', '2026-09-25', ['DAVIS000200005'], { driver_name: 'Victor Reyes' }),
  day('JALLEN', '2026-09-26', ['CANTON__JALLEN']),        // no load number: the name rides the key
  day('CHAD_DAVIS', '2026-09-26', ['DAVIS000200006']),          // the supervisor — never listed
  day('OLDIE', '2026-08-01', ['DAVIS000200007']),               // outside the window
  day('TODAY_ONLY', D, ['DAVIS000200008']),                     // the day being built is not history
  day('OTHER_TENANT', '2026-09-26', ['DAVIS000200009'], { tenant: 'elsewhere' }),
];
const ROSTERS = {
  '2026-09-22': [{ loadNbr: 'DAVIS000200001', name: 'SUW 2' }],
  '2026-09-24': [{ loadNbr: 'DAVIS000200002', name: 'SUW 2' }],
  '2026-09-26': [{ loadNbr: 'DAVIS000200003', name: 'CHE' }, { loadNbr: 'DAVIS000200006', name: 'OFFICE' }],   // DAVIS000200004 was never captured
  '2026-09-25': [{ loadNbr: 'DAVIS000200005', name: 'ALPH 1' }],
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
  assert.deepEqual(vm.routes, ['SUW 2', 'CHE'], 'most-run first; DAVIS000200004 was never captured, so it names nothing');
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
  const named = [day('name_pat_lee', '2026-09-20', ['DAVIS000200010'])];
  assert.equal(resolveDraftDriverKey('name_pat_lee', [], named, D).ok, true);
  assert.equal(resolveDraftDriverKey('NAME_PAT_LEE', [], named, D).ok, false, 'a key is never folded into a different one');
});

test('route names: a load number is looked up exactly in that day\'s roster, or names nothing', () => {
  assert.equal(routeNameFromRoster('DAVIS000200003', ROSTERS['2026-09-26']), 'CHE');
  assert.equal(routeNameFromRoster('DAVIS000200004', ROSTERS['2026-09-26']), null);
  assert.equal(routeNameFromRoster('DAVIS00020000', ROSTERS['2026-09-26']), null, 'no prefix match');
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


// ═══ HARDENING (2026-09-29 verification): what independent reviewers found wrong with the above ═══

test('ROUTE NAMES: a trip filed by route NAME (what a board row\'s loadNbr holds) names that route — the list found no one for "suw" before', () => {
  // nuvizz-list toBoardStop: `loadNbr: hasRoute ? r.routeName : null` — and loadKeyForStop reads loadNbr.
  const src = readFileSync(new URL('../netlify/functions/lib/nuvizz-list.mts', import.meta.url), 'utf8');
  assert.match(src, /loadNbr: hasRoute \? r\.routeName : null/, 'a board row carries the route NAME in loadNbr');
  assert.equal(routeNameFromRoster('SUW 2', ROSTERS['2026-09-22']), 'SUW 2');
  assert.equal(routeNameFromRoster('CHE', undefined), 'CHE', 'no roster cached for that day: the name still stands');
  assert.equal(routeNameFromRoster('DAVIS000200099', ROSTERS['2026-09-22']), null, 'a load NUMBER the roster does not have is unknown, never guessed');
  assert.equal(routeNameFromRoster('DAVIS000200001', ROSTERS['2026-09-22']), 'SUW 2', 'a load number the roster has is its name');
  assert.equal(routeNameFromRoster('64f0a1b2c3d4e5f6a7b8c9d0', ROSTERS['2026-09-22']), null, 'an opaque id is not a name');
  for (const bad of [5, 'abc', {}, { loads: [] }, null, undefined]) assert.equal(routeNameFromRoster('DAVIS000200001', bad), null, `a roster that is not a list names nothing: ${JSON.stringify(bad)}`);
  const byName = [day('MIKE_F', '2026-09-24', ['SUW 2', 'SUW 2', 'CHE']), day('MIKE_F', '2026-09-26', ['SUW 2'])];
  const row = draftableDrivers(byName, [], D, (date, k) => routeNameFromRoster(k, undefined)).find((d) => d.key === 'MIKE_F');
  assert.deepEqual(row.routes, ['SUW 2', 'CHE'], 'the routes this driver runs, most often first');
  assert.equal(filterDraftDrivers([row], 'suw').length, 1, 'so "suw" finds them');
});

test('A PLANNED LOAD WITH NO DRIVER IS NOT A DRIVER: "unknown" is not listed and not draftable — the engine\'s own roster is unchanged', () => {
  const days = [...inTenant, day('unknown', '2026-09-26', ['CHE'])];
  assert.ok(recentRosterKeys(days, D).has('unknown'), 'the engine still counts it, as before');
  assert.ok(!draftableDrivers(days, EMPLOYEES, D, routeNameFor).some((d) => d.key === 'unknown'));
  const r = resolveDraftDriverKey('unknown', EMPLOYEES, days, D);
  assert.equal(r.ok, false);
  assert.match(r.error, /no driver on it/);
});

test('A STRAY DOCUMENT COSTS A ROW, NOT THE LIST: a non-string driver key, and a roster that is not a list, do not take the endpoint down', async () => {
  const seed = seedFor();
  seed['routing_driver_days/davis__2026-09-27__odd1'] = { tenant: 'davis', date: '2026-09-27', driver_key: 12345, trips: [] };
  seed['routing_driver_days/davis__2026-09-27__odd2'] = { tenant: 'davis', date: '2026-09-27', driver_key: true, trips: [] };
  for (const [i, bad] of ['5', '"abc"', '{}', '{"loads":[]}', 'null'].entries()) {
    seed[`nuvizz_load_roster/davis__2026-09-2${i}x`] = { loadsJson: bad, at: '2026-09-27T22:00:00Z' };
  }
  seed['nuvizz_load_roster/davis__2026-09-22'] = { loadsJson: '5', at: '2026-09-22T22:00:00Z' };   // a real day in the window, unreadable
  const fake = installFirestoreFake(seed);
  try {
    const res = await get(`?date=${D}`);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.drivers.map((d) => d.key).sort(), ['JALLEN', 'VICTOR', 'VICTOR_M'], 'the stray keys are not rows');
    assert.deepEqual(body.drivers.find((d) => d.key === 'VICTOR_M').routes, ['CHE', 'SUW 2'], 'the unreadable day (09-22) lost its own route name — SUW 2 is counted once (09-24) instead of twice, so CHE now leads — and nothing else');
  } finally { fake.restore(); }
});

test('A DATE THAT IS NOT A REAL DAY IS REFUSED, not a 500 and not a window for a different day — GET and POST', async () => {
  const fake = installFirestoreFake(seedFor());
  try {
    for (const bad of ['2026-13-45', '2026-00-00', '2026-02-30', '2026-02-29', '2026-04-31', '2026-9-9']) {
      const g = await get(`?date=${bad}`);
      assert.equal(g.status, 400, `GET ${bad}`);
      assert.match((await g.json()).error, /bad or missing date/);
      const p = await post({ date: bad, driver_keys: ['VICTOR'] });
      assert.equal(p.status, 400, `POST ${bad}`);
    }
    const leap = await get('?date=2028-02-29');
    assert.equal(leap.status, 200, 'a real leap day is a real day');
    assert.equal((await leap.json()).from, '2028-01-30');
  } finally { fake.restore(); }
});

test('A FIRESTORE FAILURE READS AS A SENTENCE, not as the upstream error — the index name and project stay in the log', async () => {
  const seen = [];
  const fake = installFirestoreFake(seedFor(), (url) => {
    if (String(url).includes(':runQuery')) return new Response('{"error":{"message":"The query requires an index for project davismarginiq collection routing_driver_days field date"}}', { status: 503 });
    throw new Error(`no network call is allowed here: ${url}`);
  });
  const log = console.error; console.error = (...a) => seen.push(a.join(' '));
  try {
    const res = await get(`?date=${D}`);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.match(text, /the driver list could not be read/);
    assert.doesNotMatch(text, /davismarginiq|index/i, 'nothing of the upstream body reaches the browser');
    assert.ok(seen.some((l) => /davismarginiq/.test(l)), 'the detail is in the server log');
  } finally { console.error = log; fake.restore(); }
});

// ── the box, and what the button may send ─────────────────────────────────────────────────────
test('THE BOX FOLDS ACCENTS and never mistakes text it cannot read for an empty box', () => {
  // the codes carry no "jose" — only the name does, so the match has to read "José" as jose
  const list = [{ key: 'JPEREZ', name: 'José Pérez', userName: 'JPEREZ', routes: [] }, { key: 'JSMITH', name: 'Joseph Smith', userName: 'JSMITH', routes: [] }];
  assert.deepEqual(filterDraftDrivers(list, 'jose').map((d) => d.key), ['JPEREZ', 'JSMITH'], '"jose" finds José');
  assert.deepEqual(filterDraftDrivers(list, 'josé').map((d) => d.key), ['JPEREZ', 'JSMITH'], '"josé" is one word, not "jos"');
  assert.deepEqual(filterDraftDrivers(list, 'josé p').map((d) => d.key), ['JPEREZ']);
  assert.deepEqual(filterDraftDrivers(list, 'pérez').map((d) => d.key), ['JPEREZ'], 'an accented query finds the plain letters too');
  assert.deepEqual(filterDraftDrivers(list, 'perez').map((d) => d.key), ['JPEREZ'], 'and a plain one finds the accented name');
  for (const unreadable of ['ñ', '李', '🚚', '---']) assert.deepEqual(filterDraftDrivers(list, unreadable).map((d) => d.key), unreadable === 'ñ' ? [] : [], `"${unreadable}" shows no one, not everyone`);
  assert.deepEqual(filterDraftDrivers(list, '   ').length, 2, 'a box of spaces is an empty box');
});

test('THE DRAFT BUTTON SENDS ONLY PICKS THAT A LIST LOADED FOR THIS DATE VOUCHES FOR — not while it loads, not after it fails, not for another day', () => {
  const list = [{ key: 'VICTOR' }, { key: 'JALLEN' }];
  const picks = ['VICTOR', 'AARON_BAKER_8'];
  assert.deepEqual(sendablePicks(picks, list, D, D), ['VICTOR'], 'a loaded list for this day keeps what it carries');
  assert.deepEqual(sendablePicks(picks, null, D, D), [], 'still loading, or failed: nothing');
  assert.deepEqual(sendablePicks(picks, list, '2026-09-28', D), [], 'a list for another day vouches for nothing on this one');
  assert.deepEqual(sendablePicks(picks, list, D, '2026-09-30'), [], 'the date moved on and the new list has not arrived');
  assert.deepEqual(sendablePicks(picks, [], D, D), [], 'an empty list vouches for nobody');
  assert.deepEqual(sendablePicks(picks, list, D, ''), []);
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const draftPicked = useMemo\(\s*\(\) => sendablePicks\(draftPickedRaw, draftDrivers\.list, draftDrivers\.date, selectedDate\)/, 'the button and the POST read the gated picks, not the raw ones');
  assert.match(app, /disabled=\{draftBusy \|\| !draftPicked\.length \|\| !engineGate\.allowed\}/, 'and the button stays disabled on them');
});

test('THE PHONE LIST NEVER FILLS THE WHOLE SHEET (30vh), a removed chip keeps a keyboard user\'s place on a desktop, and a truncated row carries its full text', () => {
  const ui = readFileSync(new URL('../src/components/DraftDriverList.jsx', import.meta.url), 'utf8');
  assert.match(ui, /isMobile \? 'max-h-\[30vh\]' : 'max-h-56'/);
  assert.doesNotMatch(ui, /max-h-\[45vh\]/);
  assert.match(ui, /onToggle\?\.\(k\); if \(!isMobile\) searchRef\.current\?\.focus\(\);/, 'focus returns to the box on desktop; on a phone it would raise the keyboard');
  assert.match(ui, /ref=\{searchRef\} type="search"/);
  assert.match(ui, /runs \$\{d\.routes\.join\(' · '\)\}/, 'the row title says the routes in full');
});
