// test/new-route-form.test.mjs — the ＋ New route form has everything a route needs (v0.99.0).
//
// Chad: "This is not functional i should have everything i need to create a new route right
// here in this screen." Two rules ship behind that: the ship-from is RESOLVED (so the form is
// never a dead end on a device that has not used the New Order tab), and the map selection can
// start the route (minus whatever a create is not allowed to move).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveRouteOrigin, originUsable, originLine, newRouteSeed, newRouteSeedNote, validateNewRoute,
} from '../src/lib/route-create.js';

const TERMINAL = { name: 'Davis Delivery Service', addr1: '943 Gainesville Hwy 200-4000', city: 'Buford', state: 'GA', zip: '30518' };
const MINE = { name: 'ULINE ATLANTA', addr1: '1000 ULINE WAY', city: 'BRASELTON', state: 'GA', zip: '30517' };

test('a device that has never used New Order still gets an origin — the company terminal, labelled as the default', () => {
  const r = resolveRouteOrigin({ terminal: TERMINAL, lastUsed: null, saved: [] });
  assert.equal(r.origin.name, 'Davis Delivery Service');
  assert.equal(r.source, 'default');
  assert.equal(r.options.length, 1);
  // The whole point: the form's gate now passes on a fresh browser.
  const check = validateNewRoute({ routeName: 'TRAILER 6', date: '2026-09-09', existingNames: [], hasOrigin: !!r.origin });
  assert.equal(check.ok, true);
  assert.equal(check.loadNbr, 'TRAILER6-0909');
});

// Chad, 2026-10-02, on the form opening on Caliber Steel — the last pickup used in New Order:
// "This should always default to davis delivery."
const CALIBER = { name: 'Caliber Steel', addr1: '4485 Commerce Dr Unit 102', city: 'Buford', state: 'GA', zip: '30518' };

test('a new route defaults to Davis Delivery even when New Order last used Caliber Steel — and Caliber stays one pick away', () => {
  const r = resolveRouteOrigin({ terminal: TERMINAL, lastUsed: CALIBER, saved: [CALIBER, TERMINAL] });
  assert.equal(r.origin.name, 'Davis Delivery Service');
  assert.equal(r.source, 'default');
  // The form's dropdown opens on options[0]; the other pickup follows it, listed once.
  assert.deepEqual(r.options.map((o) => o.origin.name), ['Davis Delivery Service', 'Caliber Steel']);
  assert.equal(r.options[1].source, 'saved');
});

test('the terminal saved into New Order\'s own list is not offered twice, and keeps the default label', () => {
  const r = resolveRouteOrigin({ terminal: TERMINAL, lastUsed: TERMINAL, saved: [TERMINAL, MINE] });
  assert.deepEqual(r.options.map((o) => o.origin.name), ['Davis Delivery Service', 'ULINE ATLANTA']);
  assert.equal(r.options[0].source, 'default');
});

// The rule only holds if the screen asks it. Every door into a create reads resolveNewRouteOrigin:
// the form's useMemo, the Loads-list shell tap and the Save's no-origin fallback (both through
// readShipFromOrigin). If the wrapper stopped passing the terminal, the form would quietly go
// back to opening on the last pickup used in New Order, which is the screenshot this fixed.
test('every door into a create reads the Davis-first rule (App.jsx wiring)', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const at = src.indexOf('function resolveNewRouteOrigin()');
  assert.ok(at > 0, 'resolveNewRouteOrigin exists');
  const body = src.slice(at, src.indexOf('function readShipFromOrigin()', at));
  assert.match(body, /resolveRouteOrigin\(\{\s*terminal:\s*NEWORDER_ORIGIN_DEFAULT\b/);
  assert.match(src, /const newRouteOrigin = useMemo\(\(\) => resolveNewRouteOrigin\(\)/, 'the ＋ New route form');
  assert.match(src, /const shipFrom = readShipFromOrigin\(\);/, 'a standard shell tapped on the Loads list');
  assert.match(src, /const origin = r\.origin \|\| readShipFromOrigin\(\);/, 'a Save whose card carries no ship-from');
  // The terminal really is Davis Delivery.
  assert.match(src, /const NEWORDER_ORIGIN_DEFAULT = \{ name: 'Davis Delivery Service', addr1: '943 Gainesville Hwy/);
});

test('a half-saved address is never offered — NuVizz accepts an incomplete origin and then creates nothing', () => {
  const halfSaved = { name: 'HALF', addr1: '', city: 'BUFORD', zip: '30518' };
  assert.equal(originUsable(halfSaved), false);
  const r = resolveRouteOrigin({ terminal: TERMINAL, lastUsed: halfSaved, saved: [halfSaved] });
  assert.equal(r.origin.name, 'Davis Delivery Service');
  assert.equal(r.options.length, 1, 'the unusable entry is not in the dropdown');
});

test('with nothing anywhere, the form still refuses rather than sending a route NuVizz will silently drop', () => {
  const r = resolveRouteOrigin({ terminal: null, lastUsed: null, saved: [] });
  assert.equal(r.origin, null);
  assert.equal(r.source, 'none');
  const check = validateNewRoute({ routeName: 'TRAILER 6', date: '2026-09-09', hasOrigin: !!r.origin });
  assert.equal(check.ok, false);
  assert.match(check.error, /ship-from/i);
});

test('the origin line reads as an address a dispatcher can check at a glance', () => {
  assert.equal(originLine(TERMINAL), 'Davis Delivery Service — 943 Gainesville Hwy 200-4000, Buford, GA 30518');
  assert.equal(originLine(null), '');
});

// ── the selection that starts the route ──
const board = new Map([
  ['101', { stopNbr: '101', isUnplanned: true }],
  ['102', { stopNbr: '102', isUnplanned: true }],
  ['201', { stopNbr: '201', isUnplanned: false, routeName: 'BEN 2' }],
  ['202', { stopNbr: '202', isUnplanned: false, loadNbr: 'DAVIS000198197' }],
]);

test('unplanned selected orders start the route, in the order given', () => {
  const r = newRouteSeed({ ids: ['102', '101'], stopById: board });
  assert.deepEqual(r.seed, ['102', '101']);
  assert.deepEqual(r.planned, []);
  assert.equal(newRouteSeedNote(r), '', 'nothing held back, nothing to say');
});

test('an order already planned on a live load is HELD, not seeded — a create carrying it is refused whole', () => {
  const r = newRouteSeed({ ids: ['101', '201', '202'], stopById: board });
  assert.deepEqual(r.seed, ['101']);
  assert.deepEqual(r.planned, [{ id: '201', holder: 'BEN 2' }, { id: '202', holder: 'DAVIS000198197' }]);
  const note = newRouteSeedNote(r);
  assert.match(note, /1 of 3 selected orders will start on this route/);
  assert.match(note, /2 already planned on BEN 2, DAVIS000198197/);
  assert.match(note, /stay selected/);
});

test('an order the other dispatcher is staging is held with their name on it', () => {
  const r = newRouteSeed({ ids: ['101', '102'], stopById: board, claimedBy: (id) => (id === '102' ? 'Dispatcher 4F2A' : null) });
  assert.deepEqual(r.seed, ['101']);
  assert.deepEqual(r.claimed, [{ id: '102', who: 'Dispatcher 4F2A' }]);
  assert.match(newRouteSeedNote(r), /being staged by Dispatcher 4F2A on another device/);
});

test('an order already staged on one of MY open cards is held — it cannot sit on two cards at once', () => {
  const r = newRouteSeed({ ids: ['101', '102'], stopById: board, stagedElsewhere: new Map([['101', 'ALPHA']]) });
  assert.deepEqual(r.seed, ['102']);
  assert.deepEqual(r.planned, [{ id: '101', holder: 'ALPHA' }]);
});

test('a selected order the board no longer carries is held and counted, never silently dropped', () => {
  const r = newRouteSeed({ ids: ['101', '999'], stopById: board });
  assert.deepEqual(r.seed, ['101']);
  assert.deepEqual(r.missing, ['999']);
  assert.match(newRouteSeedNote(r), /1 no longer on the board/);
});

test('duplicates in the selection cannot put one order on the route twice', () => {
  const r = newRouteSeed({ ids: ['101', '101', '102'], stopById: board });
  assert.deepEqual(r.seed, ['101', '102']);
});

test('an empty selection is not an error — the route just starts empty, as it always did', () => {
  const r = newRouteSeed({ ids: [], stopById: board });
  assert.deepEqual(r.seed, []);
  assert.equal(newRouteSeedNote(r), '');
});

test('the held-back holder reads the card RECORD the screen already derives, not just a bare name', () => {
  // wbStagedByStop maps stopNbr → { color, seq, key, name } — the same record the grid chips use.
  const staged = new Map([['101', { color: '#e11d48', seq: 3, key: 'DAVIS000198668', name: 'ALPHA' }]]);
  const r = newRouteSeed({ ids: ['101', '102'], stopById: board, stagedElsewhere: staged });
  assert.deepEqual(r.seed, ['102']);
  assert.deepEqual(r.planned, [{ id: '101', holder: 'ALPHA' }]);
  // A record with no name falls back to its key rather than printing [object Object].
  const noName = new Map([['102', { key: 'DAVIS000198197' }]]);
  assert.deepEqual(newRouteSeed({ ids: ['102'], stopById: board, stagedElsewhere: noName }).planned, [{ id: '102', holder: 'DAVIS000198197' }]);
});
