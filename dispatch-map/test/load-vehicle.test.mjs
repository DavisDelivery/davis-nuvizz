// test/load-vehicle.test.mjs — which truck runs this load, and where that answer came from.
//
// Chad: "on the loads when we put them in the [selection] panel make a quick button tractor
// or box truck and have system remember the choice going forward."
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  vehicleClassOf, profileForClass, loadVehicleChoices, loadVehicleKey, resolveLoadVehicle,
  LOAD_VEHICLE_CLASSES,
} from '../src/lib/routing-select.js';

// The two profiles the client seeds (CLIENT_DEFAULT_TRUCKS), which is what this fleet has.
const BOX = { id: 'box_26', label: '26ft Box', maxSkids: 14, capabilities: { tractor: false, lengthClassFt: 26 } };
const TRACTOR = { id: 'tractor_53', label: '53ft Trailer', maxSkids: 28, capabilities: { tractor: true, lengthClassFt: 53 } };
const FLEET = [BOX, TRACTOR];

// ── what a profile IS ──
test('a profile is classed by the flag the solver itself reads', () => {
  assert.equal(vehicleClassOf(TRACTOR), 'tractor');
  assert.equal(vehicleClassOf(BOX), 'box');
  // Length filled in, flag forgotten — still a trailer.
  assert.equal(vehicleClassOf({ capabilities: { lengthClassFt: 53 } }), 'tractor');
  // Nothing known is a box: the SMALLER truck, so an unknown never over-plans.
  assert.equal(vehicleClassOf({}), 'box');
  assert.equal(vehicleClassOf(null), 'box');
});

test('profileForClass answers out of the fleet that exists, and null when it does not', () => {
  assert.equal(profileForClass(FLEET, 'tractor'), TRACTOR);
  assert.equal(profileForClass(FLEET, 'box'), BOX);
  assert.equal(profileForClass([BOX], 'tractor'), null);
  assert.equal(profileForClass([], 'box'), null);
});

// ── the buttons ──
test('THE TWO BUTTONS ARE BOX AND TRACTOR, in that order', () => {
  assert.deepEqual(LOAD_VEHICLE_CLASSES, ['box', 'tractor']);
  assert.deepEqual(loadVehicleChoices(FLEET).map((c) => c.label), ['Box', 'Tractor']);
});

test('a class the fleet cannot run is DISABLED and says why — never an enabled no-op', () => {
  const [box, tractor] = loadVehicleChoices([BOX]);
  assert.equal(box.disabled, false);
  assert.equal(tractor.disabled, true);
  assert.match(tractor.title, /No tractor profile in the fleet/);
  assert.equal(tractor.profile, null);
});

// ── the memory key ──
test('THE MEMORY IS KEYED ON THE NAME, normalised — "SUW  2" and "suw 2" are one load', () => {
  assert.equal(loadVehicleKey('SUW 2'), 'suw 2');
  assert.equal(loadVehicleKey('  SUW   2 '), 'suw 2');
  assert.equal(loadVehicleKey('suw 2'), 'suw 2');
  assert.equal(loadVehicleKey(''), null);
  assert.equal(loadVehicleKey('   '), null);
  assert.equal(loadVehicleKey(null), null);
});

test('the key is a LEGAL Firestore document id for every name a load could carry', () => {
  for (const n of ['A/B', '.', '..', '__x__', 'a.b', 'ALPHA-2', 'SUW/ATL 3']) {
    const k = loadVehicleKey(n);
    assert.ok(k && !k.includes('/'), `"${n}" → "${k}" still contains a slash`);
    assert.ok(k !== '.' && k !== '..', `"${n}" → "${k}" is a reserved id`);
    assert.ok(!/^__.*__$/.test(k), `"${n}" → "${k}" matches the reserved __…__ shape`);
    assert.ok(k.length <= 1500, `"${n}" → an id of ${k.length} bytes`);
  }
});

test('THE KEY IS INJECTIVE — two load names may never share one memory', () => {
  // The escape character itself is the case that breaks a two-pass version of this: '~x'
  // and the literal text 'a~2f~b' must not collapse onto the escaping of 'A/B'.
  assert.notEqual(loadVehicleKey('A/B'), loadVehicleKey('a~2f~b'));
  assert.notEqual(loadVehicleKey('~x'), loadVehicleKey('x'));
  // And the CLOSING delimiter earns its keep here: without it '~' escapes to '~7e' and a
  // code point above 0xff escapes to four hex digits, so "~e" and "\u07EE" both read '~7ee'.
  assert.notEqual(loadVehicleKey('~e'), loadVehicleKey('\u07EE'));
  const seen = new Map();
  let collisions = 0;
  for (let i = 0; i < 20000; i++) {
    const name = Array.from({ length: 1 + (i % 8) }, (_, j) => String.fromCharCode(32 + ((i * 7 + j * 13) % 95))).join('');
    const norm = name.trim().toLowerCase().replace(/\s+/g, ' ');
    const key = loadVehicleKey(name);
    if (!key) continue;
    if (seen.has(key) && seen.get(key) !== norm) collisions++;
    seen.set(key, norm);
  }
  assert.equal(collisions, 0, `${collisions} distinct load names collided onto one key`);
});

// ── the five sources, in order ──
test('NOTHING OUTRANKS A PERSON: this session’s tap wins over everything', () => {
  const v = resolveLoadVehicle({ profiles: FLEET, name: '53 TRAILER', picked: 'box', remembered: 'tractor', assigned: 'tractor' });
  assert.equal(v.cls, 'box');
  assert.equal(v.source, 'picked');
  assert.equal(v.profile, BOX);
});

test('THE REMEMBERED CHOICE IS WHAT CHAD ASKED FOR — it outranks NuVizz and the name', () => {
  const v = resolveLoadVehicle({ profiles: FLEET, name: 'SUW 2', remembered: 'tractor', assigned: 'box' });
  assert.equal(v.cls, 'tractor');
  assert.equal(v.source, 'remembered');
});

test('A FACT BEATS A REGEX: with nothing remembered, NuVizz’s own class for today decides', () => {
  const v = resolveLoadVehicle({ profiles: FLEET, name: 'SUW 2', assigned: 'tractor' });
  assert.equal(v.cls, 'tractor');
  assert.equal(v.source, 'assigned');
});

test('the name guess is the last resort it always was', () => {
  assert.equal(resolveLoadVehicle({ profiles: FLEET, name: 'NOR TRAILER' }).source, 'name');
  assert.equal(resolveLoadVehicle({ profiles: FLEET, name: 'NOR TRAILER' }).cls, 'tractor');
});

test('EVERY DAVIS LOAD NAME USED TO DEFAULT TO A BOX, and with no other signal it still does', () => {
  // The regex never matches one of them — which is the whole reason the memory exists.
  for (const n of ['ALPHA', 'ALPHA 2', 'ATL', 'SUW', 'SUW 2']) {
    const v = resolveLoadVehicle({ profiles: FLEET, name: n });
    assert.equal(v.cls, 'box', `${n} defaulted to ${v.cls}`);
    assert.equal(v.source, 'default');
  }
});

test('a remembered class the fleet cannot run is skipped, not planned onto nothing', () => {
  const v = resolveLoadVehicle({ profiles: [BOX], name: 'SUW', remembered: 'tractor' });
  assert.equal(v.cls, 'box');
  assert.equal(v.source, 'default');
  assert.equal(v.profile, BOX);
});

test('no profiles at all is "none", never a route built on an undefined truck', () => {
  const v = resolveLoadVehicle({ profiles: [], name: 'SUW' });
  assert.equal(v.cls, null);
  assert.equal(v.source, 'none');
  assert.equal(v.profile, null);
});

// ── the conflict line ──
test('A STANDING PREFERENCE MAY NOT QUIETLY OUT-PLAN THE TRUCK IN THE YARD', () => {
  const v = resolveLoadVehicle({ profiles: FLEET, name: 'SUW', remembered: 'tractor', assigned: 'box' });
  assert.equal(v.conflict, true, 'a remembered tractor over an assigned box raised nothing');
  assert.equal(v.assigned, 'box');
});

test('agreement is not a conflict, and an unknown assignment is not a disagreement', () => {
  assert.equal(resolveLoadVehicle({ profiles: FLEET, name: 'SUW', remembered: 'box', assigned: 'box' }).conflict, false);
  assert.equal(resolveLoadVehicle({ profiles: FLEET, name: 'SUW', remembered: 'box', assigned: null }).conflict, false);
  // NuVizz says tractor, the fleet has no tractor: true, and not actionable. No line.
  assert.equal(resolveLoadVehicle({ profiles: [BOX], name: 'SUW', remembered: 'box', assigned: 'tractor' }).conflict, false);
});

test('the source NuVizz supplied cannot conflict with itself', () => {
  const v = resolveLoadVehicle({ profiles: FLEET, name: 'SUW', assigned: 'tractor' });
  assert.equal(v.source, 'assigned');
  assert.equal(v.conflict, false);
});
