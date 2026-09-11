// test/uat-seed.test.mjs — writing JUST the orders a scenario needs into UAT.
//
// Chad, 2026-09-10: "we need to use firestore to see what data/orders are put into system
// daily so we are not running scans. Then we can design a way to test using that information
// so we need to test something we will write just the orders we need to test whatever
// scenario we are testing into the uat."
//
// Production's Firestore is the catalogue; UAT is a stage. These tests pin the four rules
// that make that safe, each named for what goes wrong without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  uatStopNbr, isUatSeededNbr, buildSeedRow, seedIndexRow, clearableRow, planSeed,
  UAT_PREFIX, UAT_STOP_NBR_MAX, CARRIED_FIELDS, DROPPED_FIELDS,
} from '../netlify/functions/lib/uat-seed.mts';
import { buildStopPayload } from '../netlify/functions/lib/nuvizz-write-ops.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = { name: 'Davis Delivery Service', addr1: '943 Gainesville Hwy 200-4000', city: 'Buford', state: 'GA', zip: '30518' };

/** A production board row, in the shape nuvizz-scan's normalizeStop actually writes. */
const prodRow = (over = {}) => ({
  stopNbr: '007174773', businessName: 'COSTCO LOGISTICS', addr1: '2999 Cumberland Blvd',
  city: 'ATLANTA', state: 'GA', zip: '30339', lat: 33.88, lng: -84.47,
  scheduledFrom: '2026-09-11T08:00:00', scheduledTo: '2026-09-11T14:00:00', timeConstraint: 'STRICT',
  cartons: 1, volume: 0, weight: 98, pallets: 1, itemsSummary: '1 pallet · 98 lbs',
  contact: { name: 'Receiving', phone: '7705551212', email: 'dock@example.com' },
  signalSources: { addressLine2: null, orderInstructions: 'Closes 2pm sharp' },
  // Production's plan — none of this may cross.
  isPlanned: true, isUnplanned: false, loadNbr: 'DAVIS000203261', loadId: '6a43ef',
  routeName: 'TRAILER 6', routeSeq: 4, loadStopSeq: 4, driverName: 'Steven Adjenty',
  driverUserName: 'ADJETEY', plannedEtaDTTM: '2026-09-11T13:10:00',
  board_write_at: '2026-09-11T01:00:00Z', boardDate: '2026-09-11', last_scanned_at: 'x',
  enriched: true, stopId: 'PRODSTOPID', raw: { huge: 'x'.repeat(500) },
  ...over,
});

// ── rule 2: the number is DERIVED, never minted ──────────────────────────────

test('THE UAT NUMBER IS DERIVED FROM THE PRODUCTION ONE — so a re-seed UPSERTS instead of duplicating', () => {
  assert.equal(uatStopNbr('007174773'), 'UT-007174773');
  assert.equal(uatStopNbr('007174773'), uatStopNbr('007174773'), 'deterministic — the same order always lands on the same UAT number');
  assert.equal(uatStopNbr('AVRT-0060189919'), 'UT-AVRT-0060189919');
  assert.equal(uatStopNbr('ESTES-0538243875'), 'UT-ESTES-0538243875');
  for (const n of ['007174773', 'AVRT-0060189919', 'ESTES-0538243875']) {
    assert.ok(uatStopNbr(n).length <= UAT_STOP_NBR_MAX, `${n} must fit NuVizz's 20-char cap`);
  }
  assert.equal(uatStopNbr(''), '');
  assert.equal(uatStopNbr(null), '');
});

test('an over-long number keeps its TAIL — cutting the front would collapse two orders onto one UPSERT', () => {
  const a = 'CARRIERPREFIX-0000000001';
  const b = 'CARRIERPREFIX-0000000002';
  assert.equal(uatStopNbr(a).length, UAT_STOP_NBR_MAX);
  assert.notEqual(uatStopNbr(a), uatStopNbr(b), 'the digits that tell them apart must survive');
  assert.ok(uatStopNbr(a).endsWith('0000000001'));
  assert.ok(isUatSeededNbr(uatStopNbr(a)));
});

// ── rule 3: the scenario IS the window ───────────────────────────────────────

test('THE SCENARIO IS THE WINDOW — a 2pm close crosses, and is never invented when absent', () => {
  const p = buildSeedRow(prodRow());
  assert.deepEqual(p.window, { from: '2026-09-11T08:00:00', to: '2026-09-11T14:00:00' });
  assert.deepEqual(p.warnings, [], 'a row with a real window has nothing to warn about');

  // No window on the board → SAY SO rather than synthesize one. A fabricated 12–5 would turn
  // a test for a deadline into a test for nothing, silently.
  const none = buildSeedRow(prodRow({ scheduledFrom: null, scheduledTo: null }));
  assert.deepEqual(none.window, { from: null, to: null });
  assert.match(none.warnings[0], /no delivery window/);
  assert.match(none.warnings[0], /cannot test a deadline/);
});

test('the real-world condition rides along, and the copy says what it is', () => {
  const p = buildSeedRow(prodRow(), { label: 'route-create 14 stops' });
  assert.match(p.row.dispatchNotes, /TEST COPY of production order 007174773/);
  assert.match(p.row.dispatchNotes, /route-create 14 stops/);
  assert.match(p.row.dispatchNotes, /Closes 2pm sharp/, "the scenario's own instruction survives");
});

test('freight and contact cross in DAVIS terms — the relabelling stays consistent end to end', () => {
  // The board row already relabels NuVizz's mislabeled fields (cartons IS pallets, volume IS
  // loose). Reading them back under the Davis names keeps one meaning across the round trip.
  const p = buildSeedRow(prodRow({ cartons: 3, volume: 2, weight: 775 }));
  assert.equal(p.row.pallets, 3);
  assert.equal(p.row.loose, 2);
  assert.equal(p.row.weight, 775);
  assert.equal(p.row.phone, '7705551212');
  assert.equal(p.row.email, 'dock@example.com');
  // And the built payload maps them back onto NuVizz's fields the way New Order does.
  const body = buildStopPayload(p.row, { origin: ORIGIN, serviceDate: '2026-09-11' });
  assert.equal(body.totalCartons, 3, 'NuVizz "cartons" = pallets');
  assert.equal(body.volume, 2, 'NuVizz "volume" = loose');
  assert.equal(body.totalPallets, 5, 'NuVizz "pallets" = total pieces');
  assert.equal(body.stopNbr, 'UT-007174773');
});

test('a half address is REFUSED, not geocoded to somewhere nobody chose', () => {
  for (const missing of [{ businessName: '' }, { addr1: '' }, { city: '' }, { zip: '' }]) {
    assert.equal(buildSeedRow(prodRow(missing)), null, JSON.stringify(missing));
  }
  assert.equal(buildSeedRow(prodRow({ stopNbr: '' })), null);
  assert.equal(buildSeedRow(null), null);
  // A missing STATE is not fatal — zip carries the geocode — so that one still builds.
  assert.ok(buildSeedRow(prodRow({ state: '' })));
});

// ── rule 4: nothing about production's plan comes with it ────────────────────

test("PRODUCTION'S PLAN NEVER CROSSES — the stage starts empty, whatever the order was doing", () => {
  const prod = prodRow();
  const p = buildSeedRow(prod);
  const row = seedIndexRow(prod, p, { stopId: 'UATSTOPID', stopNbr: 'UT-007174773' });
  assert.ok(row);
  // The rule is that PRODUCTION'S value never crosses — not that the key is always absent.
  // stopId is the one field that is dropped and then re-set, to the UAT order's own id.
  for (const k of DROPPED_FIELDS) {
    if (prod[k] === undefined) continue;   // the fixture does not set it, so there is nothing to carry
    assert.notEqual(row[k], prod[k], `${k} must not carry production's value (got ${JSON.stringify(row[k])})`);
  }
  for (const k of DROPPED_FIELDS.filter((f) => f !== 'stopId')) {
    assert.ok(row[k] === undefined || row[k] === null, `${k} must be gone entirely (got ${JSON.stringify(row[k])})`);
  }
  assert.equal(row.routeName, null);
  assert.equal(row.driverName, null);
  assert.equal(row.isPlanned, false);
  assert.equal(row.isUnplanned, true);
  // status and normalizedStatus must AGREE — a row that says one and not the other renders
  // as SCHEDULED on a board that was just told it is unplanned.
  assert.equal(row.status, '10');
  assert.equal(row.normalizedStatus, 'UNPLANNED');
  // The identity is the UAT order's, not production's.
  assert.equal(row.stopNbr, 'UT-007174773');
  assert.equal(row.stopId, 'UATSTOPID');
  assert.notEqual(row.stopId, prod.stopId);
  assert.equal(row.pro, 'UT-007174773');
  // The geometry DOES cross — it is the same physical delivery, and re-geocoding it would
  // spend a Google call to learn what production already knows.
  assert.equal(row.lat, 33.88);
  assert.equal(row.lng, -84.47);
  assert.equal(row.addr1, '2999 Cumberland Blvd');
  assert.equal(row.scheduledTo, '2026-09-11T14:00:00');
  // Provenance is on the row itself.
  assert.equal(row.uatSeed.prodStopNbr, '007174773');
});

test('no stopId back = NO board row — a row for an order we cannot prove exists is worse than a short board', () => {
  const prod = prodRow();
  const p = buildSeedRow(prod);
  assert.equal(seedIndexRow(prod, p, { stopId: null, stopNbr: 'UT-007174773' }), null);
  assert.equal(seedIndexRow(prod, p, {}), null);
  assert.equal(seedIndexRow(prod, p, { stopId: '   ' }), null);
});

test('CARRIED_FIELDS and DROPPED_FIELDS do not overlap — one field cannot be both', () => {
  const carried = new Set(CARRIED_FIELDS);
  for (const k of DROPPED_FIELDS) assert.equal(carried.has(k), false, `${k} is in both lists`);
});

// ── rule 1: a clear needs BOTH keys ──────────────────────────────────────────

test('A CLEAR NEEDS BOTH KEYS — the UT- prefix AND the seed ledger', () => {
  const ledger = new Set(['UT-007174773', 'UT-007174458']);
  assert.equal(clearableRow({ stopNbr: 'UT-007174773' }, ledger), true);
  // In the ledger but not prefixed: a ledger that has drifted must not authorise a cancel.
  assert.equal(clearableRow({ stopNbr: '007174773' }, ledger), false);
  // Prefixed but not in the ledger: somebody typed a UT- order in the portal by hand. Leave it.
  assert.equal(clearableRow({ stopNbr: 'UT-999999999' }, ledger), false);
  // A real production order can never be clearable, whatever the ledger says.
  assert.equal(clearableRow({ stopNbr: 'ESTES-0538243875' }, new Set(['ESTES-0538243875'])), false);
  for (const junk of [null, undefined, {}, { stopNbr: '' }, { stopNbr: '   ' }]) {
    assert.equal(clearableRow(junk, ledger), false, JSON.stringify(junk));
  }
});

// ── the batch plan ───────────────────────────────────────────────────────────

test('planSeed names every order it will NOT create, and why — a tick that silently does nothing is the worst outcome', () => {
  const rows = [prodRow(), prodRow({ stopNbr: '007174458', businessName: 'KM DESIGN' }), prodRow({ stopNbr: '007174239', addr1: '' })];
  const { plan, skipped } = planSeed(rows, ['007174773', '007174458', '007174239', '000000000']);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((p) => p.uatStopNbr), ['UT-007174773', 'UT-007174458']);
  assert.equal(skipped.length, 2);
  assert.match(skipped.find((s) => s.stopNbr === '007174239').why, /no usable delivery address/);
  assert.match(skipped.find((s) => s.stopNbr === '000000000').why, /not on the production board/);
});

test('two orders whose UAT numbers would collide: the second is REFUSED, not silently upserted over the first', () => {
  const a = 'CARRIERPREFIXX-0000000001';
  const rows = [prodRow({ stopNbr: a }), prodRow({ stopNbr: `Z${a}` })];
  const { plan, skipped } = planSeed(rows, [a, `Z${a}`]);
  assert.equal(plan.length, 1, 'only one may take that number');
  assert.match(skipped[0].why, /collides/);
});

test('the card order is preserved and duplicates in the request are harmless', () => {
  const rows = [prodRow(), prodRow({ stopNbr: '007174458' }), prodRow({ stopNbr: '007174239' })];
  const { plan } = planSeed(rows, ['007174239', '007174773', '007174458']);
  assert.deepEqual(plan.map((p) => p.prodStopNbr), ['007174239', '007174773', '007174458']);
  const { plan: dup, skipped } = planSeed(rows, ['007174773', '007174773']);
  assert.equal(dup.length, 1);
  assert.match(skipped[0].why, /collides/);
});

// ── the structural guarantee the catalogue reader rests on ───────────────────

test('THE CATALOGUE READER HAS NO WRITER — not a disabled one, none', () => {
  // A read-only reader that COULD be made to write is one careless refactor away from the
  // test board editing the live one. This is asserted against the source text because that
  // is the only form of the claim that a future edit cannot quietly falsify.
  const src = fs.readFileSync(path.join(HERE, '..', 'netlify', 'functions', 'lib', 'prod-catalogue.mts'), 'utf8');
  assert.doesNotMatch(src, /method:\s*['"](POST|PATCH|PUT|DELETE)['"]/i, 'no mutating HTTP method anywhere in the file');
  assert.doesNotMatch(src, /\bsetDoc\b|\bdeleteDoc\b|\bupdateDocFields\b|:commit\b/, 'no Firestore writer imported or called');
  // And it can only ever address production's database — never a parameter a caller can get wrong.
  assert.match(src, /const PROD_DATABASE = '\(default\)'/);
  // The database in the URL is the module constant and nothing else — never an argument, a
  // field of opts, or anything a caller could reach.
  assert.match(src, /databases\/\$\{PROD_DATABASE\}/, 'the URL interpolates the constant');
  assert.equal((src.match(/databases\/\$\{([A-Za-z_$][\w$]*)\}/g) || []).length, 1, 'exactly one database is ever addressed');
  assert.match(src, /const PROD_DATABASE = '\(default\)';/, 'and it is a const, so nothing can point it elsewhere');
  // It refuses off a mirror, rather than no-opping.
  assert.match(src, /if \(!catalogueEnabled\(env\)\) throw new Error/);
});

test('THE BENCH REFUSES ON PRODUCTION, structurally — keyed on the deploy, not on a date or a flag', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'netlify', 'functions', 'uat-seed.mts'), 'utf8');
  assert.match(src, /if \(!isMirrorDeploy\(\)\) \{[\s\S]{0,200}?403\)/, 'the mirror gate is the FIRST thing the handler does');
  // The gate must come before any op is read, so no path can run ahead of it.
  assert.ok(src.indexOf('isMirrorDeploy()') < src.indexOf("const op ="), 'production is refused before an op is even parsed');
  // A destructive clear cannot reach NuVizz without the mirror's own outbound grant.
  assert.match(src, /if \(op === 'clear'\) \{[\s\S]{0,400}?outboundAllowed\('nuvizz-write'\)/);
  assert.ok(src.includes(UAT_PREFIX), 'the prefix the clear keys on is the shared one');
});
