// Which place mark a stop wears, whether it carries the no-tractor rule, and whether the
// hollow lime Shiplify pin may show. Synthetic places only (see shiplify-import.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePlaceMark, shiplifyPlaceMark, normalizeBuildingType, placeNoTractor, placeNoTractorReason,
  placeNoTractorLine, placeKeyFromMatchKey, tractorPlaceKeys, tractorSeenAt, limeAsOf,
  shiplifyPinCandidate, shiplifyPinKind, buildShiplifyLookup, shiplifyRecordFor, shiplifyPanelRows,
  limeNoDockLine, NO_TRACTOR_PLACE_MARKS, BUILDING_TYPES,
} from '../src/lib/place-mark.js';
import { normalizeMatchKey, normalizePlaceKey } from '../src/lib/matchKey.js';
import { tractorFriendlySelection } from '../src/lib/map-legend.js';

const rec = (o = {}) => ({
  match_key: 'k', place_key: 'p', location_types: [], tariff_items: [], dock_access: '', forklift: '', ...o,
});

test('Shiplify: school, then church, then government, then residential', () => {
  assert.equal(shiplifyPlaceMark(rec({ location_types: ['Place of Worship', 'School'] })), 'school',
    'the 12 Place of Worship|School rows are schools');
  assert.equal(shiplifyPlaceMark(rec({ location_types: ['University'] })), 'school');
  assert.equal(shiplifyPlaceMark(rec({ location_types: ['Day Care / Preschool'] })), 'school');
  assert.equal(shiplifyPlaceMark(rec({ location_types: ['Place of Worship'], tariff_items: ['RES'] })), 'church');
  for (const t of ['Courthouse', 'Police Station', 'Fire Station', 'Prison / Detention Center', 'Military Base', 'Public Library']) {
    assert.equal(shiplifyPlaceMark(rec({ location_types: [t, 'Commercial'] })), 'government', t);
  }
  assert.equal(shiplifyPlaceMark(rec({ location_types: ['Courthouse', 'Place of Worship'] })), 'church');
  assert.equal(shiplifyPlaceMark(rec({ tariff_items: ['RES', 'LIM'] })), 'residential');
  assert.equal(shiplifyPlaceMark(rec({ location_types: ['Distribution Center'], tariff_items: ['LIM'] })), null);
  assert.equal(shiplifyPlaceMark(null), null);
});

test('a dispatcher-set type beats Shiplify, and shows with the Shiplify switch off', () => {
  const school = rec({ location_types: ['School'] });
  assert.deepEqual(resolvePlaceMark({ buildingType: 'church', shiplify: school, shiplifyOn: true }).mark, 'church');
  assert.equal(resolvePlaceMark({ buildingType: 'church', shiplify: school, shiplifyOn: true }).source, 'dispatcher');
  const off = resolvePlaceMark({ buildingType: 'government', shiplify: school, shiplifyOn: false });
  assert.equal(off.mark, 'government');
  assert.equal(off.source, 'dispatcher');
});

test('"None" hides what Shiplify says', () => {
  const r = resolvePlaceMark({ buildingType: 'none', shiplify: rec({ location_types: ['School'] }), shiplifyOn: true });
  assert.equal(r.mark, null);
  assert.equal(r.source, 'dispatcher');
  assert.equal(r.shiplifyMark, 'school', 'the editor can still say what Shiplify would have drawn');
});

test('Auto follows Shiplify only while the tab\'s switch is on', () => {
  const school = rec({ location_types: ['School'] });
  assert.deepEqual(resolvePlaceMark({ shiplify: school, shiplifyOn: true }), { mark: 'school', source: 'shiplify', shiplifyMark: 'school' });
  assert.deepEqual(resolvePlaceMark({ shiplify: school, shiplifyOn: false }), { mark: null, source: null, shiplifyMark: null });
  assert.deepEqual(resolvePlaceMark({}), { mark: null, source: null, shiplifyMark: null });
});

test('a malformed building_type reads as Auto, never as a type', () => {
  for (const v of [undefined, null, '', 'School ', 'SCHOOL', 'warehouse', 3, {}]) {
    const n = normalizeBuildingType(v);
    assert.ok(n === null || BUILDING_TYPES.includes(n), String(v));
  }
  assert.equal(normalizeBuildingType('warehouse'), null);
  assert.equal(normalizeBuildingType(' School '), 'school', 'case and padding are forgiven');
});

test('school, church and government carry the no-tractor rule; residential never does', () => {
  for (const m of ['school', 'church', 'government']) {
    assert.deepEqual(placeNoTractor({ mark: m }), { applies: true, lifted: null }, m);
  }
  assert.equal(placeNoTractor({ mark: 'residential' }).applies, false);
  assert.equal(placeNoTractor({ mark: null }).applies, false);
  assert.equal(NO_TRACTOR_PLACE_MARKS.has('residential'), false);
});

test('Vehicle "Tractor-trailer OK" lifts it; so does a tractor having delivered there', () => {
  assert.deepEqual(placeNoTractor({ mark: 'school', eligibility: 'tractor' }), { applies: false, lifted: 'tractor_ok' });
  assert.deepEqual(placeNoTractor({ mark: 'church', tractorSeen: true }), { applies: false, lifted: 'tractor_seen' });
  assert.deepEqual(placeNoTractor({ mark: 'government', eligibility: 'box_only' }), { applies: true, lifted: null },
    'Box truck only does not lift a no-tractor rule — it agrees with it');
});

test('the rule\'s words', () => {
  assert.equal(placeNoTractorReason('school'), 'School: no tractor trailer unless Vehicle is Tractor-trailer OK');
  assert.equal(placeNoTractorLine('church'), 'No tractor trailer: Church. Set Vehicle to Tractor-trailer OK if a trailer fits.');
  assert.equal(placeNoTractorLine('government'), 'No tractor trailer: Government. Set Vehicle to Tractor-trailer OK if a trailer fits.');
});

test('the street + ZIP half of a match key equals the board\'s own place key', () => {
  const cases = [
    ['Example Widget Co', '100 Sample Pkwy', 'Testville', '30000'],
    ['Invented Holdings LLC', '22 North Fake Street Suite 4', 'Sample City', '30001-1234'],
    ['A. B. C. Supply, Inc.', '5 W Imaginary Blvd.', "O'Nowhere", '30002'],
    ['LLC', '9 Placeholder Rd', 'X', '30003'],
    // A bare suite word normalises to a street ENDING in an underscore ("…_ste_"), which runs
    // into the city separator — the case a left-to-right split got wrong.
    ['Acme LLC', '1 Main St Suite', 'Buford', '30518'],
    ['Acme', '1 Main St Ste', 'Buford', '30518'],
    ['Acme', '1 Main St Apt', '', '30518'],
    ['', '2 Main St Unit', 'Buford', '30518'],
    ['Acme', '  3 Padded Rd  ', 'Buford', '30518'],
    ['Acme', '4 Main St Ste #4', 'Buford', '30518'],
  ];
  for (const [name, street, city, zip] of cases) {
    const mk = normalizeMatchKey(name, street, city, zip);
    assert.equal(placeKeyFromMatchKey(mk), normalizePlaceKey(street, zip), mk);
  }
  assert.equal(placeKeyFromMatchKey(''), '');
  assert.equal(placeKeyFromMatchKey('no_separators'), '');
  assert.equal(placeKeyFromMatchKey(normalizeMatchKey('Name', '', 'City', '30000')), '', 'no street → no place');
});

test('a tractor at the same street + ZIP under another name counts as seen', () => {
  const lime = new Map([[normalizeMatchKey('Old Name Inc', '7 Fake Ave', 'Testville', '30000'), { first: '2026-01-02' }]]);
  const places = tractorPlaceKeys(lime);
  const stop = { matchKey: normalizeMatchKey('New Tenant', '7 Fake Ave', 'Testville', '30000'), addr1: '7 Fake Ave', zip: '30000' };
  assert.deepEqual(tractorSeenAt(stop, lime, places), { byKey: false, byPlace: true, any: true });
  const own = { matchKey: normalizeMatchKey('Old Name Inc', '7 Fake Ave', 'Testville', '30000'), addr1: '7 Fake Ave', zip: '30000' };
  assert.equal(tractorSeenAt(own, lime, places).byKey, true);
  const elsewhere = { matchKey: 'x', addr1: '8 Fake Ave', zip: '30000' };
  assert.equal(tractorSeenAt(elsewhere, lime, places).any, false);
});

test('Lime as of board date: only locations first served BEFORE the board date', () => {
  const m = new Map([['a', { first: '2026-09-01' }], ['b', { first: '2026-09-10' }], ['c', { first: null }], ['d', { first: '2026-09-09' }]]);
  const asOf = limeAsOf(m, '2026-09-10');
  assert.deepEqual([...asOf.keys()].sort(), ['a', 'd'], 'the board date itself does not count; no date does not count');
  assert.equal(limeAsOf(m, '2026-09-10'), asOf, 'one Map per (map, date), so effects do not rebuild for nothing');
  assert.equal(limeAsOf(m, ''), m, 'no board date → the map untouched');
});

test('the Shiplify candidate: dock yes → dock; dock no + forklift yes → forklift; else nothing', () => {
  assert.equal(shiplifyPinCandidate(rec({ dock_access: 'yes' })), 'dock');
  assert.equal(shiplifyPinCandidate(rec({ dock_access: 'yes', forklift: 'yes' })), 'dock');
  assert.equal(shiplifyPinCandidate(rec({ dock_access: 'no', forklift: 'yes' })), 'forklift');
  assert.equal(shiplifyPinCandidate(rec({ dock_access: 'no', forklift: 'no' })), null);
  assert.equal(shiplifyPinCandidate(rec({ dock_access: 'no', forklift: '' })), null);
  assert.equal(shiplifyPinCandidate(rec({ dock_access: '', forklift: 'yes' })), null, 'forklift is only asked when dock is no');
  assert.equal(shiplifyPinCandidate(null), null);
});

const pinFacts = (o = {}) => ({ candidate: 'dock', shiplifyOn: true, statusKind: 'UNPLANNED', ...o });

test('the pin shows on a plain resting stop, for both kinds', () => {
  assert.equal(shiplifyPinKind(pinFacts()), 'dock');
  assert.equal(shiplifyPinKind(pinFacts({ candidate: 'forklift', statusKind: 'SCHEDULED' })), 'forklift');
});

test('every suppression, one at a time', () => {
  const off = {
    'switch off': { shiplifyOn: false },
    'tractor seen (key or street + ZIP)': { tractorSeen: true },
    'Tractor-trailer OK': { eligibility: 'tractor' },
    'Box truck only': { eligibility: 'box_only' },
    'confirmed blocker': { paintAllowed: false },
    school: { placeMark: 'school' },
    church: { placeMark: 'church' },
    government: { placeMark: 'government' },
    'out for delivery': { statusKind: 'OUT_FOR_DEL' },
    delivered: { statusKind: 'DELIVERED' },
    arrived: { statusKind: 'ARRIVED' },
    exception: { statusKind: 'EXCEPTION' },
    'do not send': { dns: true },
    selected: { matched: true },
    'search hit': { searchMatched: true },
    'open route card': { inRoute: true },
    'planned-muted': { plannedMuted: true },
    'priority flag': { priorityFlag: 'red' },
    '? flag': { priorityFlag: 'question' },
    'address off': { addressOff: true },
    Estes: { estes: true },
    'restriction cluster': { restrictionCount: 1 },
  };
  for (const kind of ['dock', 'forklift']) {
    for (const [why, o] of Object.entries(off)) {
      assert.equal(shiplifyPinKind(pinFacts({ candidate: kind, ...o })), null, `${kind}: ${why}`);
    }
  }
  assert.equal(shiplifyPinKind(pinFacts({ placeMark: 'residential' })), 'dock', 'a house does not suppress the pin');
});

test('lookup: by match key first, then by street + ZIP (merged, dock yes wins)', () => {
  const a = rec({ match_key: 'a__1_fake_st__x__30000', place_key: '1_fake_st__30000', dock_access: 'no', forklift: 'yes' });
  const b = rec({ match_key: 'b__1_fake_st__x__30000', place_key: '1_fake_st__30000', dock_access: 'yes' });
  const L = buildShiplifyLookup([a, b]);
  assert.equal(shiplifyRecordFor(L, { matchKey: a.match_key, addr1: '1 Fake St', zip: '30000' }).rec, a);
  const byPlace = shiplifyRecordFor(L, { matchKey: 'someone_else', addr1: '1 Fake St', zip: '30000' });
  assert.equal(byPlace.via, 'place');
  assert.equal(byPlace.rec.dock_access, 'yes');
  assert.equal(shiplifyRecordFor(L, { matchKey: 'nobody', addr1: '2 Fake St', zip: '30000' }), null);
});

test('the stop panel block says every fact in words, and says so when there is no record', () => {
  assert.deepEqual(shiplifyPanelRows(null), { found: false, rows: [] });
  const { rows } = shiplifyPanelRows(rec({
    dock_access: 'no', forklift: 'yes', gated_access: 'partial', call_box: 'yes',
    location_types: ['School'], tariff_items: ['RES', 'LIM', 'GROC'],
  }));
  const m = Object.fromEntries(rows);
  assert.equal(m.Dock, 'No');
  assert.equal(m.Forklift, 'Yes');
  assert.equal(m.Gated, 'Partial');
  assert.equal(m['Security hut'], 'Not given');
  assert.equal(m.Tariffs, 'Residential, Limited access, Grocery');
  assert.equal(limeNoDockLine(rec({ dock_access: 'no' }), true), 'A tractor has delivered here, though Shiplify lists no dock.');
  assert.equal(limeNoDockLine(rec({ dock_access: 'no' }), false), null);
  assert.equal(limeNoDockLine(rec({ dock_access: 'yes' }), true), null);
});

// OUT OF SCOPE, VERIFIED NOT CHANGED: the Selected list's green row and "Drop N non-tractor" read
// tractorFriendlySelection, and it already treats a stop nobody has proven as NOT friendly — so a
// school, church or government stop the no-tractor rule applies to (no Tractor-trailer OK, no
// tractor delivery) is already off the green list and dropped by the button, with no change here.
test('an unlifted school, church or government stop is already not tractor-friendly (green row / Drop N non-tractor)', () => {
  for (const mark of ['school', 'church', 'government']) {
    const rule = placeNoTractor({ mark, eligibility: null, tractorSeen: false });
    assert.equal(rule.applies, true);
    assert.equal(tractorFriendlySelection({ eligibility: null, friendlyBadge: false, tractorSeen: false }), false, `${mark} stays off the green list`);
  }
  // …and the two lifts agree with the green row's own "yes" answers.
  assert.equal(placeNoTractor({ mark: 'school', eligibility: 'tractor' }).applies, false);
  assert.equal(tractorFriendlySelection({ eligibility: 'tractor' }), true);
  assert.equal(placeNoTractor({ mark: 'school', tractorSeen: true }).applies, false);
  assert.equal(tractorFriendlySelection({ tractorSeen: true }), true);
});

test('street + ZIP: a stop never inherits a NEIGHBOUR\'s school — types carry over only when everyone at the address agrees', () => {
  const daycare = rec({ match_key: 'daycare__100_sample_pkwy__x__30000', place_key: '100_sample_pkwy__30000', location_types: ['Day Care / Preschool'], dock_access: 'no' });
  const supply = rec({ match_key: 'supply__100_sample_pkwy__x__30000', place_key: '100_sample_pkwy__30000', location_types: ['Warehouse'], dock_access: 'yes' });
  const L = buildShiplifyLookup([daycare, supply]);
  const other = shiplifyRecordFor(L, { matchKey: 'other_tenant', addr1: '100 Sample Pkwy', zip: '30000' });
  assert.equal(other.via, 'place');
  assert.equal(resolvePlaceMark({ shiplify: other.rec, shiplifyOn: true }).mark, null, 'no borrowed school');
  assert.equal(other.rec.dock_access, 'yes', 'the building still has the dock');
  assert.equal(other.rec.mixed_types, true);
  assert.equal(Object.fromEntries(shiplifyPanelRows(other.rec).rows)['Location types'], 'Differs by customer at this address');
  // Everyone agreeing is still inherited.
  const twoSchools = buildShiplifyLookup([daycare, { ...daycare, match_key: 'school2__100_sample_pkwy__x__30000', location_types: ['School'] }]);
  const agreed = shiplifyRecordFor(twoSchools, { matchKey: 'third', addr1: '100 Sample Pkwy', zip: '30000' });
  assert.equal(resolvePlaceMark({ shiplify: agreed.rec, shiplifyOn: true }).mark, 'school');
});

test('the stop panel block includes Shiplify\'s appointment answer', () => {
  const m = Object.fromEntries(shiplifyPanelRows(rec({ appointment_required: 'yes' })).rows);
  assert.equal(m.Appointment, 'Yes');
  assert.equal(Object.fromEntries(shiplifyPanelRows(rec()).rows).Appointment, 'Not given');
});
