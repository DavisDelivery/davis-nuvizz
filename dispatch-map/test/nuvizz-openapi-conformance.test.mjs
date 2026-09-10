// test/nuvizz-openapi-conformance.test.mjs — the write bodies vs. NuVizz's OWN document.
//
// Chad, on a ＋ New route card that answered a 500: "Your load creation doesn't work
// correctly go to nuvizz's api instructions to see what you are doing wrong." He was right
// to send us to the document, and the document had the answer — but not in the schema.
//
// WHAT THIS GUARD EXISTS TO CATCH, in two layers, because the first one is not enough:
//
//  1. STRUCTURE, from reference/nuvizz-openapi-v7.json itself: every key we send must exist
//     in the schema (additionalProperties:false), every required key must be present, and
//     every type / maxLength / minimum must hold. This is mechanical and complete.
//
//  2. THE RULES THE SCHEMA CANNOT STATE. The Sep 9 createRoute bug was structurally PERFECT
//     — every key legal, nothing extra, all lengths fine — and still wrong: `seq` numbers a
//     route's LEGS, so a 3-order route has six of them and every one needs its own number.
//     We sent from.seq === to.seq === the card position: three numbers for six legs. JSON
//     Schema has no way to say "these integers must be distinct", so only the vendor's three
//     worked examples say it. Those examples are ASSERTED here against the live spec file, so
//     if a future spec drop changes the convention this test says so instead of a 500 doing it.
//
// The point of layer 2 is that a body can validate and still be nonsense. Layer 1 alone would
// have passed the bug that prompted the whole exercise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRouteCreateBody, buildCancelStopBody, buildOpRequest } from '../netlify/functions/lib/nuvizz-write-ops.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'reference', 'nuvizz-openapi-v7.json'), 'utf8'));

// ── a small OpenAPI-3 (JSON-Schema subset) validator ─────────────────────────
// Deliberately tiny and dependency-free: $ref, type, required, additionalProperties:false,
// maxLength, minimum/exclusiveMinimum, maximum, maxItems. Anything it cannot check it says
// nothing about — a validator that quietly skips is worse than one with a stated scope.
function deref(s) {
  let guard = 0;
  while (s && s.$ref) {
    if (++guard > 50) throw new Error('schema $ref loop');
    s = s.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o[k], SPEC);
  }
  return s;
}
function validate(schema, value, at = '$', out = []) {
  const s = deref(schema);
  if (!s || value === null || value === undefined) return out;
  const t = s.type;
  if (t === 'object' || s.properties) {
    if (typeof value !== 'object' || Array.isArray(value)) { out.push(`${at}: expected object`); return out; }
    for (const r of s.required || []) if (value[r] === undefined) out.push(`${at}.${r}: REQUIRED but missing`);
    const props = s.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (!(k in props)) { if (s.additionalProperties === false) out.push(`${at}.${k}: NOT ALLOWED by the schema`); continue; }
      validate(props[k], v, `${at}.${k}`, out);
    }
    return out;
  }
  if (t === 'array') {
    if (!Array.isArray(value)) { out.push(`${at}: expected array`); return out; }
    if (s.maxItems != null && value.length > s.maxItems) out.push(`${at}: ${value.length} items exceeds maxItems ${s.maxItems}`);
    value.forEach((v, i) => validate(s.items, v, `${at}[${i}]`, out));
    return out;
  }
  if (t === 'string') {
    if (typeof value !== 'string') out.push(`${at}: expected string, got ${typeof value}`);
    else if (s.maxLength != null && value.length > s.maxLength) out.push(`${at}: length ${value.length} exceeds maxLength ${s.maxLength}`);
    return out;
  }
  if (t === 'integer' || t === 'number') {
    if (typeof value !== 'number') { out.push(`${at}: expected ${t}, got ${typeof value}`); return out; }
    if (t === 'integer' && !Number.isInteger(value)) out.push(`${at}: expected an integer`);
    if (s.minimum != null && (s.exclusiveMinimum === true ? value <= s.minimum : value < s.minimum)) out.push(`${at}: ${value} below minimum ${s.minimum}`);
    if (s.maximum != null && value > s.maximum) out.push(`${at}: ${value} above maximum ${s.maximum}`);
    return out;
  }
  if (t === 'boolean' && typeof value !== 'boolean') out.push(`${at}: expected boolean`);
  return out;
}
/** The request-body schema the document declares for a path, so a test can never validate
 *  against a schema the app does not actually POST to. */
function bodySchemaFor(pathKey) {
  const p = SPEC.paths[pathKey];
  assert.ok(p, `the spec has no path ${pathKey} — did reference/nuvizz-openapi-v7.json change?`);
  const schema = p.post?.requestBody?.content?.['application/json']?.schema;
  assert.ok(schema?.$ref, `${pathKey} declares no JSON request body`);
  return schema;
}

// ── the sanity check on the validator itself ─────────────────────────────────
// A green conformance suite is only meaningful if the validator can go red.

test('the validator actually rejects — an unknown key, a missing required, an over-long string, a bad type', () => {
  const schema = bodySchemaFor('/load/cancel/{companyCode}');
  assert.deepEqual(validate(schema, { loadNbr: 'L1', reasonCode: 'ADMIN' }), []);
  assert.match(validate(schema, { loadNbr: 'L1', reasonCode: 'ADMIN', nope: 1 })[0], /\$\.nope: NOT ALLOWED/);
  assert.match(validate(schema, { loadNbr: 'L1' })[0], /\$\.reasonCode: REQUIRED/);
  assert.match(validate(schema, { loadNbr: 'x'.repeat(21), reasonCode: 'A' })[0], /exceeds maxLength 20/);
  assert.match(validate(schema, { loadNbr: 7, reasonCode: 'A' })[0], /expected string, got number/);
});

// ── layer 1: every write body we build validates ─────────────────────────────

const ORIGIN = { name: 'Davis Delivery', addr1: '943 Gainesville Hwy', city: 'Buford', state: 'GEORGIA', zip: '30518', country: 'UNITED STATES' };
const seeds = (n) => Array.from({ length: n }, (_, i) => ({
  stopNbr: `00717370${i}`,
  fromSchedule: { timeFrom: '2026-09-09T06:00:00', timeTo: '2026-09-09T07:00:00', timeZone: 'EST' },
  toSchedule: { timeFrom: '2026-09-09T08:00:00', timeTo: '2026-09-09T17:00:00', timeZone: 'EST' },
}));

test('createRoute: the body validates against RoutePlanLoad, for one order and for many', () => {
  for (const n of [1, 2, 3, 12]) {
    const body = buildRouteCreateBody({ loadNbr: 'Suw 3', routeName: 'Suw 3', date: '2026-09-09', origin: ORIGIN, seeds: seeds(n) }, 'DAVIS');
    assert.deepEqual(validate(bodySchemaFor('/routePlan/update/{serviceName}/{companyCode}'), body), [], `n=${n}`);
  }
});

test('createRoute: a stop whose record carries NO schedule still validates ({} is legal per Schedule)', () => {
  const body = buildRouteCreateBody({
    loadNbr: 'Suw 3', date: '2026-09-09', origin: ORIGIN,
    seeds: [{ stopNbr: '007173697' }, { stopNbr: '007173794', toSchedule: null }],
  }, 'DAVIS');
  assert.deepEqual(validate(bodySchemaFor('/routePlan/update/{serviceName}/{companyCode}'), body), []);
});

test('cancelStop bodies validate against CancelStop', () => {
  assert.deepEqual(validate(bodySchemaFor('/stop/cancel/{companyCode}'), buildCancelStopBody({ stopId: 'abc', reasonComments: 'x' })), []);
  assert.deepEqual(validate(bodySchemaFor('/stop/cancel/{companyCode}'), buildCancelStopBody({ stopNbr: '007155216' })), []);
});

test('the ops the app POSTs really do target the paths the document declares', () => {
  const CREDS = { base: 'https://portal.nuvizz.com/deliverit/openapi/v7', companyCode: 'DAVIS', auth: 'Basic x' };
  const declared = (key) => key.replace('{companyCode}', 'DAVIS').replace('{serviceName}', 'default');
  const cases = [
    ['cancelStop', { stopId: 'abc' }, '/stop/cancel/{companyCode}'],
    ['createRoute', { route: { loadNbr: 'R1', date: '2026-09-09', origin: ORIGIN, seeds: seeds(2) } }, '/routePlan/update/{serviceName}/{companyCode}'],
  ];
  for (const [op, payload, key] of cases) {
    const br = buildOpRequest(op, payload, CREDS);
    assert.equal(br.method, 'POST');
    assert.equal(br.url, `${CREDS.base}${declared(key)}`, `${op} must POST to the documented path`);
    assert.deepEqual(validate(bodySchemaFor(key), JSON.parse(br.body)), [], `${op} body`);
  }
});

// ── layer 2: the rules the schema cannot state ───────────────────────────────

test('THE SEP 9 BUG: seq numbers the route\'s LEGS — 2N legs, 2N distinct numbers, 1..2N with no gaps', () => {
  for (const n of [1, 2, 3, 12]) {
    const body = buildRouteCreateBody({ loadNbr: 'Suw 3', date: '2026-09-09', origin: ORIGIN, seeds: seeds(n) }, 'DAVIS');
    const legs = body.route.planStops.flatMap((p) => [p.from.seq, p.to.seq]);
    assert.equal(legs.length, 2 * n, `${n} orders make ${2 * n} legs`);
    assert.equal(new Set(legs).size, 2 * n, `n=${n}: every leg needs its OWN number — from.seq === to.seq is the bug that answered a 500`);
    assert.deepEqual([...legs].sort((a, b) => a - b), Array.from({ length: 2 * n }, (_, i) => i + 1), `n=${n}: 1..2N, no gaps`);
    // And the shape is the RouteExistingStops pattern specifically: load everything, then
    // deliver everything — which is also what the freight does out of Buford.
    assert.deepEqual(body.route.planStops.map((p) => p.from.seq), Array.from({ length: n }, (_, i) => i + 1));
    assert.deepEqual(body.route.planStops.map((p) => p.to.seq), Array.from({ length: n }, (_, i) => n + i + 1));
  }
});

test('the vendor\'s OWN examples still say every leg gets its own seq — if a spec drop changes that, this fails, not production', () => {
  const legsOf = (route) => [...(route.planStops || []), ...(route.stops || [])]
    .flatMap((s) => [s.from?.seq, s.to?.seq])
    .filter((v) => v != null);
  for (const name of ['RouteExistingStops', 'RouteNewStops', 'RouteCoMingledStops']) {
    const ex = SPEC.components.examples[name];
    assert.ok(ex, `the spec no longer ships the ${name} example`);
    const legs = legsOf(ex.value.route);
    assert.ok(legs.length >= 4, `${name}: expected at least two stops' worth of legs`);
    assert.equal(new Set(legs).size, legs.length, `${name}: the document never reuses a seq`);
    assert.deepEqual([...legs].sort((a, b) => a - b), Array.from({ length: legs.length }, (_, i) => i + 1), `${name}: 1..2N`);
  }
  // And the one we copy: interleaved, from-legs first (Stop001 1/3, Stop002 2/4).
  const ps = SPEC.components.examples.RouteExistingStops.value.route.planStops;
  assert.deepEqual(ps.map((p) => p.from.seq), [1, 2]);
  assert.deepEqual(ps.map((p) => p.to.seq), [3, 4]);
});
