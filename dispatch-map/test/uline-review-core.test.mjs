// test/uline-review-core.test.mjs — the rules behind the Uline straight-truck review.
//
// Chad: "a tab ... of the uline advisory straight truck only ... where the ui shows close up
// views of the building for each flag and we can quickly decide if we are going to make it no
// tractor trailer or not."
//
// These run the real functions on real-shaped notes. Every assertion names the freight event it
// protects, because the two mistakes here are not symmetrical: calling a building tractor-OK
// that is not sends a 53-footer to a dock it cannot back into; calling it box-only when it is
// not spends a box truck on it every day that customer has freight.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ULINE_KEY, hasUlineAdvisory, ulineDecision, ulineWords, bearingDeg, buildUlineRows, sortUlineRows,
  eligibilityPayload, decisionAfter, buildingTypePayload, buildingTypeWrite, undoWrite, BOX_ONLY_BUILDING_TYPES,
} from '../src/lib/uline-review.js';

const uline = (over = {}) => ({
  match_key: 'acme|100|norcross',
  equipment_restrictions: [ULINE_KEY],
  auto_sources: { [ULINE_KEY]: ['orderInstructions'] },
  auto_matches: { [ULINE_KEY]: [{ source: 'orderInstructions', text: 'STRAIGHT TRUCK ONLY', pattern: 'x' }] },
  ...over,
});

// ── which locations are still a question ─────────────────────────────────────

test('Uline\'s text alone is a QUESTION — undecided, and on the list', () => {
  assert.equal(ulineDecision(uline()), 'undecided');
});

test('a dispatcher\'s vehicle mark answers it, on this tab or anywhere else', () => {
  // The Routing brush and the stop card write the same field, so a location decided THERE
  // must not reappear HERE asking the same question.
  assert.equal(ulineDecision(uline({ vehicle_eligibility: 'box_only' })), 'box_only');
  assert.equal(ulineDecision(uline({ vehicle_eligibility: 'tractor' })), 'tractor');
});

test('A PERSON WHO ALREADY SAID NO IS NEVER OFFERED A ONE-TAP "TRACTOR OK"', () => {
  // vehicle_eligibility 'tractor' drops EVERY trailer blocker, not only Uline's. A Uline flag
  // sitting beside a Davis-typed Address 2 "NO TRACTOR TRL" is already answered by a person —
  // putting it in "to decide" would let one tap overrule them and send a 53' to that dock.
  const addr2 = uline({
    equipment_restrictions: [ULINE_KEY, 'no_tractor_trailer'],
    auto_sources: { [ULINE_KEY]: ['orderInstructions'], no_tractor_trailer: ['addressLine2'] },
  });
  assert.equal(ulineDecision(addr2), 'confirmed');
  // A ticked box with no scanner trail is a person too (unknown provenance counts as confirmed).
  assert.equal(ulineDecision(uline({ equipment_restrictions: [ULINE_KEY, 'box_truck_only'] })), 'confirmed');
  // A locked restriction list is a dispatcher taking ownership of the whole thing — Uline's
  // flag included.
  assert.equal(ulineDecision(uline({ manual_overrides: { equipment_restrictions: true } })), 'confirmed');
});

test('a non-trailer restriction beside the flag does not answer the trailer question', () => {
  assert.equal(ulineDecision(uline({ equipment_restrictions: [ULINE_KEY, 'liftgate_required'] })), 'undecided');
});

test('a malformed vehicle mark reads as NOT SET, never as a fourth invisible state', () => {
  for (const bad of ['', 'BOX', false, 0, 'yes']) {
    assert.equal(ulineDecision(uline({ vehicle_eligibility: bad })), 'undecided', String(bad));
  }
});

test('hasUlineAdvisory reads the restriction list, and a missing list is simply no', () => {
  assert.equal(hasUlineAdvisory(uline()), true);
  assert.equal(hasUlineAdvisory({ equipment_restrictions: ['no_tractor_trailer'] }), false);
  assert.equal(hasUlineAdvisory({}), false);
  assert.equal(hasUlineAdvisory(null), false);
});

// ── the evidence ──────────────────────────────────────────────────────────────

test('Uline\'s own words are shown, deduped, whitespace-collapsed, capped', () => {
  const n = uline({ auto_matches: { [ULINE_KEY]: [
    { text: 'STRAIGHT   TRUCK ONLY' }, { text: 'STRAIGHT TRUCK ONLY' }, { text: 'NO 53' }, { text: 'CALL AHEAD' }, { text: 'FOURTH' },
  ] } });
  assert.deepEqual(ulineWords(n), ['STRAIGHT TRUCK ONLY', 'NO 53', 'CALL AHEAD']);
  assert.deepEqual(ulineWords({}), [], 'a flag set before matches were stored has no words, not a crash');
});

test('THE STREET VIEW CAMERA FACES THE BUILDING, not down the road', () => {
  const at = { lat: 33.95, lng: -84.2 };
  assert.equal(Math.round(bearingDeg(at, { lat: 33.951, lng: -84.2 })), 0, 'north');
  assert.equal(Math.round(bearingDeg(at, { lat: 33.95, lng: -84.199 })), 90, 'east');
  assert.equal(Math.round(bearingDeg(at, { lat: 33.949, lng: -84.2 })), 180, 'south');
  assert.equal(Math.round(bearingDeg(at, { lat: 33.95, lng: -84.201 })), 270, 'west');
  // Always a usable heading — never NaN, which would leave the panorama pointing nowhere.
  assert.equal(bearingDeg(null, at), 0);
  assert.equal(bearingDeg({ lat: 'x', lng: 1 }, at), 0);
});

// ── one row per LOCATION ─────────────────────────────────────────────────────

const stop = (over = {}) => ({ stopNbr: '007176403', matchKey: 'acme|100|norcross', businessName: 'ACME', lat: 33.9, lng: -84.2, routeName: 'NOR 2', isPlanned: true, ...over });
const notes = (...pairs) => new Map(pairs);

test('ONE QUESTION PER LOCATION — three stops at one customer are one row, carrying all three', () => {
  // The answer is saved to the customer and holds for every order there. Listing the same dock
  // three times invites three answers.
  const rows = buildUlineRows([
    { date: '2026-09-24', stops: [stop()] },
    { date: '2026-09-25', stops: [stop({ stopNbr: '007176415', routeName: null, isPlanned: false })] },
    { date: '2026-09-28', stops: [stop({ stopNbr: '007176594', routeName: 'NOR 11' })] },
  ], notes(['acme|100|norcross', uline()]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stops.length, 3);
  assert.equal(rows[0].firstDate, '2026-09-24');
  assert.deepEqual(rows[0].stops.map((s) => s.routeName), ['NOR 2', null, 'NOR 11']);
});

test('a stop whose customer carries no Uline flag is not on this list', () => {
  const rows = buildUlineRows([{ date: '2026-09-24', stops: [stop(), stop({ stopNbr: 'B', matchKey: 'other' })] }],
    notes(['acme|100|norcross', uline()], ['other', { equipment_restrictions: ['no_tractor_trailer'] }]));
  assert.deepEqual(rows.map((r) => r.key), ['acme|100|norcross']);
});

test('a stop with no customer key cannot carry a flag and is skipped rather than guessed at', () => {
  assert.equal(buildUlineRows([{ date: 'd', stops: [stop({ matchKey: '' })] }], notes(['acme|100|norcross', uline()])).length, 0);
});

test('the pin and address come from the injected board functions — the ones every screen draws', () => {
  const rows = buildUlineRows([{ date: 'd', stops: [stop()] }], notes(['acme|100|norcross', uline()]), {
    positionOf: () => ({ lat: 1, lng: 2, source: 'override' }),
    addressOf: () => ({ addr1: '100 MAIN ST' }),
    tractorOf: () => ({ count: 3, last: '2026-08-17' }),
  });
  assert.deepEqual(rows[0].pin, { lat: 1, lng: 2, source: 'override' });
  assert.deepEqual(rows[0].address, { addr1: '100 MAIN ST' });
  assert.deepEqual(rows[0].tractor, { count: 3, last: '2026-08-17' });
});

test('no pin is null, not a pin on the equator — the screen says "fix it on Problem addresses"', () => {
  const rows = buildUlineRows([{ date: 'd', stops: [stop()] }], notes(['acme|100|norcross', uline()]), { positionOf: () => null });
  assert.equal(rows[0].pin, null);
});

test('no tractor history is null, not "0 deliveries" — absence is not evidence of a no', () => {
  const rows = buildUlineRows([{ date: 'd', stops: [stop()] }], notes(['acme|100|norcross', uline()]), { tractorOf: () => ({ count: 0, last: null }) });
  assert.equal(rows[0].tractor, null);
});

test('undecided first, then the soonest freight — Thursday waits for Thursday', () => {
  const sorted = sortUlineRows([
    { key: 'a', decision: 'tractor', firstDate: '2026-09-24', businessName: 'A' },
    { key: 'b', decision: 'undecided', firstDate: '2026-09-28', businessName: 'B' },
    { key: 'c', decision: 'undecided', firstDate: '2026-09-24', businessName: 'Z' },
    { key: 'd', decision: 'confirmed', firstDate: '2026-09-24', businessName: 'D' },
  ]);
  assert.deepEqual(sorted.map((r) => r.key), ['c', 'b', 'd', 'a']);
});

// ── the write ────────────────────────────────────────────────────────────────

test('THE WRITE IS THE SAME THREE FIELDS THE ROUTING BRUSH WRITES, and nothing else', () => {
  // A location decided here must be indistinguishable from one painted in Routing. Never the
  // restriction list (the scanner re-adds Uline's flag on every Uline order and would fight it)
  // and never auto_scan_dismissed (nothing in the app writes it; this must not be the first).
  const STAMP = { __stamp: true };
  const p = eligibilityPayload('acme|100|norcross', 'box_only', STAMP);
  assert.deepEqual(Object.keys(p).sort(), ['last_updated', 'match_key', 'vehicle_eligibility', 'vehicle_eligibility_at', 'vehicle_eligibility_by']);
  assert.equal(p.vehicle_eligibility, 'box_only');
  assert.equal(p.vehicle_eligibility_by, 'dispatcher');
  assert.equal(p.vehicle_eligibility_at, STAMP);
  assert.equal(eligibilityPayload('k', 'tractor', STAMP).vehicle_eligibility, 'tractor');
  // Clearing writes an explicit null — the stored "not set" every reader already understands.
  assert.equal(eligibilityPayload('k', null, STAMP).vehicle_eligibility, null);
  // And a malformed value can never be stored as a fourth state.
  assert.equal(eligibilityPayload('k', 'TRUCK', STAMP).vehicle_eligibility, null);
});

test('UNDO PUTS A ROW BACK WHERE IT CAME FROM — including "a person already said no"', () => {
  assert.equal(decisionAfter({ baseDecision: 'undecided' }, 'box_only'), 'box_only');
  assert.equal(decisionAfter({ baseDecision: 'undecided' }, null), 'undecided');
  // Clearing the mark on a location a dispatcher had ALSO ticked "No tractor trailer" must not
  // drop it back into "to decide" as if Uline were the only voice.
  assert.equal(decisionAfter({ baseDecision: 'confirmed' }, null), 'confirmed');
  assert.equal(decisionAfter({}, null), 'undecided');
});

test('the row remembers its base decision, computed with the vehicle mark removed', () => {
  const addr2 = uline({
    vehicle_eligibility: 'tractor',
    equipment_restrictions: [ULINE_KEY, 'no_tractor_trailer'],
    auto_sources: { [ULINE_KEY]: ['orderInstructions'], no_tractor_trailer: ['addressLine2'] },
  });
  const rows = buildUlineRows([{ date: 'd', stops: [stop()] }], notes(['acme|100|norcross', addr2]));
  assert.equal(rows[0].decision, 'tractor');
  assert.equal(rows[0].baseDecision, 'confirmed');
});

// ── BUILDING TYPE FROM THE CARD — Residential does double duty ─────────────────
//
// Chad: "give me options to label building type like this is residential ... double duty as
// residentials we don't allow to be planned on tractors as we flag it as well as it would be
// marked residential." Before this, a Residential type kept NOTHING off a tractor: the place rule
// covers school/church/government only, and the auto-builder never reads building_type.

test('a building type writes the SAME three fields the stop card writes, and nothing else', () => {
  const STAMP = { __stamp: true };
  const p = buildingTypePayload('acme|1|x', 'school', STAMP);
  assert.deepEqual(Object.keys(p).sort(), ['building_type', 'building_type_at', 'building_type_by', 'last_updated', 'match_key']);
  assert.equal(p.building_type, 'school');
  assert.equal(p.building_type_by, 'dispatcher');
  // A malformed type is stored as Auto, never as an invisible sixth value.
  assert.equal(buildingTypePayload('k', 'WAREHOUSE', STAMP).building_type, null);
  assert.equal(buildingTypePayload('k', null, STAMP).building_type, null);
});

test('RESIDENTIAL SAVES THE TYPE AND BOX TRUCK ONLY, IN ONE WRITE', () => {
  // On its own a Residential type changes no truck — so the press that means "we don't send
  // tractors to houses" has to write the mark the router actually enforces.
  const STAMP = { __stamp: true };
  const w = buildingTypeWrite('acme|1|x', 'residential', STAMP);
  assert.equal(w.eligibility, 'box_only', 'the press decided the vehicle question');
  assert.equal(w.fields.building_type, 'residential');
  assert.equal(w.fields.vehicle_eligibility, 'box_only');
  assert.equal(w.fields.vehicle_eligibility_by, 'dispatcher');
  assert.equal(w.fields.building_type_by, 'dispatcher');
});

test('the other types LABEL ONLY — no truck rule is invented for them here', () => {
  // School, church and government already carry the place rule's no-tractor FLAG. Chad named
  // residential; widening "double duty" to the rest is his call, not a side effect.
  const STAMP = {};
  for (const t of ['school', 'church', 'government', 'none', null]) {
    const w = buildingTypeWrite('k', t, STAMP);
    assert.equal(w.eligibility, undefined, String(t));
    assert.ok(!('vehicle_eligibility' in w.fields), `${t} must not touch the vehicle mark`);
  }
  assert.deepEqual([...BOX_ONLY_BUILDING_TYPES], ['residential']);
});

test('UNDO PUTS BACK EXACTLY WHAT THE PRESS CHANGED — both fields after a Residential press', () => {
  const STAMP = {};
  const both = undoWrite('k', { buildingType: null, eligibility: null }, STAMP);
  assert.equal(both.building_type, null);
  assert.equal(both.vehicle_eligibility, null);
  // A plain type press moved only the type, so only the type goes back.
  const typeOnly = undoWrite('k', { buildingType: 'school' }, STAMP);
  assert.equal(typeOnly.building_type, 'school');
  assert.ok(!('vehicle_eligibility' in typeOnly), 'the vehicle mark is not rewritten by an undo that never moved it');
  // And a vehicle-only press.
  const eligOnly = undoWrite('k', { eligibility: 'tractor' }, STAMP);
  assert.equal(eligOnly.vehicle_eligibility, 'tractor');
  assert.ok(!('building_type' in eligOnly));
});
