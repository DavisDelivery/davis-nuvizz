// netlify/functions/test/proxy-guards.test.mjs
//
// Pins the request guards on the SITE A NuVizz proxy. Run with:
//   node --test "netlify/functions/test/**/*.test.mjs"      (or `npm test` at the repo root)
// (Node 22's test runner takes file globs, not a bare directory.)
//
// Every test here runs with NO env (no FIREBASE_SA, no NuVizz creds) and a stubbed
// global fetch, so nothing can reach NuVizz or Firestore — the cost rule in CLAUDE.md
// applies to tests too. Each test is named for the real-world failure it prevents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nuvizz = require('../nuvizz.cjs');
const nvReq = require('../lib/nuvizz-request.cjs');
const fsdb = require('../lib/firestore.cjs');

// A fetch that records calls and returns a canned status. Any test that reaches it
// without expecting to has escaped the guard it is testing.
function stubFetch(status, body = '{}') {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const evt = (overrides = {}) => ({
  httpMethod: 'GET',
  queryStringParameters: {},
  body: null,
  ...overrides,
});

// ── Passthrough ───────────────────────────────────────────────────────────────

test('passthrough: a POST to the raw proxy is 405 and never reaches NuVizz', async () => {
  const f = stubFetch(200);
  try {
    const r = await nuvizz.handler(evt({ httpMethod: 'POST', queryStringParameters: { path: '/stop/info/007100000/DAVIS' }, body: '{"x":1}' }));
    assert.equal(r.statusCode, 405);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('passthrough: `..` traversal on the vendor host is 400, no call made', async () => {
  const f = stubFetch(200);
  try {
    for (const path of ['/stop/info/../../admin/DAVIS', '/load/info/..', '/stop/info/x/../y']) {
      const r = await nuvizz.handler(evt({ queryStringParameters: { path } }));
      assert.equal(r.statusCode, 400, path);
    }
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('passthrough: a path outside the four read routes is 400 (no /user/list, no query smuggling)', async () => {
  const f = stubFetch(200);
  try {
    for (const path of ['/user/list/DAVIS', '/load/static/info/DAVIS', '/stop/info', '/stop/info/1/DAVIS?x=1', '/stop/info/1/DAVIS#f', 'stop/info/1/DAVIS', '/stop/info/1/DAVIS%2F..']) {
      const r = await nuvizz.handler(evt({ queryStringParameters: { path } }));
      assert.equal(r.statusCode, 400, path);
    }
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('passthrough: resolvePassthroughPath accepts exactly what src/lib/api.js sends', () => {
  const ok = ['/stop/info/007100000/DAVIS', '/stop/etainfo/DAVIS', '/stop/eventinfo/ULINE', '/load/info/DAVIS000192640/DAVIS'];
  for (const p of ok) assert.equal(nuvizz.resolvePassthroughPath(p), p);
  assert.equal(nuvizz.resolvePassthroughPath('/stop/info/x/DAVIS/../..'), null);
  assert.equal(nuvizz.resolvePassthroughPath('//evil.example/stop/info/'), null);
  assert.equal(nuvizz.resolvePassthroughPath(undefined), null);
  assert.equal(nuvizz.resolvePassthroughPath('/stop/info/1/DAVIS%2Fx'), null);
});

// ── Date + range guards ───────────────────────────────────────────────────────

test('parseDateParam: a real calendar date passes, garbage and impossible dates are rejected', () => {
  assert.equal(nuvizz.parseDateParam('2026-09-02'), '2026-09-02');
  assert.equal(nuvizz.parseDateParam('2024-02-29'), '2024-02-29');   // leap day, real
  for (const bad of ['2026-02-30', '2026-13-01', '2025-02-29', 'abc', '2026-9-2', '20260902', '../x', '2026-09-02T00:00', '2026-00-10']) {
    assert.equal(nuvizz.parseDateParam(bad), null, bad);
  }
});

test('parseDateParam: absent date defaults to the ET day, which itself validates', () => {
  const d = nuvizz.parseDateParam(undefined);
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(d, nuvizz.etToday());
  assert.equal(nuvizz.parseDateParam(''), d);
});

test('__fleet etc: a garbage date is 400 {error:"bad date"} before any NuVizz or Firestore call', async () => {
  const f = stubFetch(200);
  try {
    for (const path of ['__fleet', '__fleetstops', '__refreshFleet', '__loadsbydate', '__refreshLoad']) {
      const r = await nuvizz.handler(evt({ queryStringParameters: { path, date: '2026-02-30', loadNbr: 'DAVIS000000001', userName: 'JIM' } }));
      assert.equal(r.statusCode, 400, path);
      assert.deepEqual(JSON.parse(r.body), { error: 'bad date' }, path);
    }
    const r = await nuvizz.handler(evt({ queryStringParameters: { path: '__driver', userName: 'JIM', date: 'nope' } }));
    assert.equal(r.statusCode, 400);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('parseLoadRange: integers, ordered, at most 700 wide — from=0&to=999999999 is refused', () => {
  assert.deepEqual(nuvizz.parseLoadRange('196094', '196192'), { startNbr: 196094, endNbr: 196192 });
  assert.deepEqual(nuvizz.parseLoadRange('100', '800'), { startNbr: 100, endNbr: 800 });      // exactly 700 wide
  assert.equal(nuvizz.parseLoadRange('100', '801'), null);                                    // 701 wide
  assert.equal(nuvizz.parseLoadRange('0', '999999999'), null);
  assert.equal(nuvizz.parseLoadRange('200', '100'), null);                                    // reversed
  assert.equal(nuvizz.parseLoadRange('abc', '100'), null);
  assert.equal(nuvizz.parseLoadRange('1e3', '2000'), null);
  assert.equal(nuvizz.parseLoadRange('-5', '5'), null);
  assert.equal(nuvizz.parseLoadRange(undefined, '5'), null);
  assert.equal(nuvizz.parseLoadRange('5', undefined), null);
  assert.equal(nuvizz.MAX_LOAD_RANGE_WIDTH, 700);
});

test('__fleet: a half or oversize manual range is 400 and does not fall through to a scan', async () => {
  const f = stubFetch(200);
  try {
    for (const q of [{ from: '0', to: '999999999' }, { from: '100' }, { to: '100' }, { from: 'x', to: 'y' }]) {
      const r = await nuvizz.handler(evt({ queryStringParameters: { path: '__fleet', date: '2026-09-02', ...q } }));
      assert.equal(r.statusCode, 400, JSON.stringify(q));
      assert.equal(JSON.parse(r.body).error, 'bad range');
    }
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

// ── Roster privacy ────────────────────────────────────────────────────────────

test('publicRosterUser: CDL and license fields never leave; what DriversScreen reads survives', () => {
  const u = { userName: 'JIM', name: 'Jim Pallette', userId: 1883, status: 'ENABLED', isDriver: true, isEnabled: true,
    email: 'j@x', mobileNumber: '555', cdlNumber: 'C123', licenseState: 'GA', licenseExpirationDttm: '2027-01-01', licenseClass: 'A' };
  const out = nuvizz.publicRosterUser(u);
  for (const k of ['cdlNumber', 'licenseState', 'licenseExpirationDttm', 'licenseClass']) assert.equal(k in out, false, k);
  for (const k of ['userName', 'name', 'userId', 'status', 'isDriver', 'isEnabled', 'email', 'mobileNumber']) assert.equal(out[k], u[k], k);
  assert.equal('cdlNumber' in u, true, 'input is not mutated');
  assert.equal(nuvizz.publicRosterUser(null), null);
});

// ── Error responses ───────────────────────────────────────────────────────────

test('errors: the vendor body is logged, not returned as `detail`', async () => {
  // Stub creds so the request gets as far as the (stubbed) fetch. A 400 rather than a
  // 5xx: 5xx is retryable and would walk the real backoff schedule (~8s) for nothing.
  const f = stubFetch(400, '{"message":"vendor exploded","internal":"secret-endpoint-name"}');
  const errors = [];
  const origErr = console.error;
  const origLog = console.log;
  const origUser = process.env.NUVIZZ_DAVIS_USER, origPass = process.env.NUVIZZ_DAVIS_PASS;
  process.env.NUVIZZ_DAVIS_USER = 'test-user';
  process.env.NUVIZZ_DAVIS_PASS = 'test-pass';
  console.error = (...a) => errors.push(a.join(' '));
  console.log = () => {};
  try {
    const r = await nuvizz.handler(evt({ queryStringParameters: { path: '/stop/info/1/DAVIS' } }));
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].url.startsWith('https://portal.nuvizz.com/deliverit/openapi/v7/stop/info/1/DAVIS'), f.calls[0].url);
    assert.equal(f.calls[0].init.method, 'GET');
    assert.equal(r.statusCode, 400);
    const body = JSON.parse(r.body);
    assert.equal(body.error, 'vendor exploded');
    assert.equal('detail' in body, false);
    assert.equal(r.body.includes('secret-endpoint-name'), false);
    assert.ok(errors.some(l => l.includes('secret-endpoint-name')), 'body went to console.error');
  } finally {
    f.restore(); console.error = origErr; console.log = origLog;
    if (origUser === undefined) delete process.env.NUVIZZ_DAVIS_USER; else process.env.NUVIZZ_DAVIS_USER = origUser;
    if (origPass === undefined) delete process.env.NUVIZZ_DAVIS_PASS; else process.env.NUVIZZ_DAVIS_PASS = origPass;
  }
});

// ── Request wrapper ───────────────────────────────────────────────────────────

test('parseCeiling: unset / blank / 0 / typo / negative → 12000; a real number is trimmed and honoured', () => {
  assert.equal(nvReq.DEFAULT_DAILY_CEILING, 12000);
  for (const bad of [undefined, null, '', '   ', '0', 'abc', '-5', 'NaN', 'Infinity', '0.4']) {
    assert.equal(nvReq.parseCeiling(bad), 12000, JSON.stringify(bad));
  }
  assert.equal(nvReq.parseCeiling(' 2000 '), 2000);
  assert.equal(nvReq.parseCeiling('12000.9'), 12000);
  assert.equal(nvReq.parseCeiling(500), 500);
  assert.equal(nvReq.parseCeiling('junk', 7), 7);
});

test('retry: a POST that 503s is sent ONCE; the same GET is retried', async () => {
  const origLog = console.log;
  console.log = () => {};
  const f = stubFetch(503, '{}');
  try {
    const req = nvReq.createRequester({ maxRetries: 2, backoffBaseMs: 1, backoffMaxMs: 1, backoffTotalCapMs: 100 });
    const post = await req.request('https://example.invalid/user/list/DAVIS', { method: 'POST', body: '{}', headers: {} }, { route: '/user/list', tenant: 'davis' });
    assert.equal(post.status, 503);
    assert.equal(f.calls.length, 1, 'POST must not be replayed');

    f.calls.length = 0;
    const get = await req.request('https://example.invalid/load/info/X/DAVIS', { method: 'GET', headers: {} }, { route: '/load/info', tenant: 'davis' });
    assert.equal(get.status, 503);
    assert.equal(f.calls.length, 3, 'GET keeps its backoff (1 + maxRetries)');

    f.calls.length = 0;
    await req.request('https://example.invalid/idem', { method: 'POST', body: '{}', headers: {}, idempotent: true }, { route: '/idem', tenant: 'davis' });
    assert.equal(f.calls.length, 3, 'an explicitly idempotent POST may retry');
  } finally { f.restore(); console.log = origLog; }
});

// ── Firestore path safety ─────────────────────────────────────────────────────

test('safeSegment: `..`, `.`, empty, and / \\ ? # all throw; ordinary ids pass', () => {
  for (const bad of ['..', '.', '', null, undefined, 'a/b', 'a\\b', 'a?b', 'a#b', '../x']) {
    assert.throws(() => fsdb.safeSegment(bad), /unsafe path segment/, JSON.stringify(bad));
  }
  assert.equal(fsdb.safeSegment('davis'), 'davis');
  assert.equal(fsdb.safeSegment('2026-09-02'), '2026-09-02');
  assert.equal(fsdb.safeSegment('DAVIS000192640'), 'DAVIS000192640');
  assert.equal(fsdb.safeSegment(20260902), '20260902');
  assert.equal(fsdb.safePath('nuvizzFleet/davis__2026-09-02/loads/DAVIS000192640'), 'nuvizzFleet/davis__2026-09-02/loads/DAVIS000192640');
  assert.throws(() => fsdb.safePath('nuvizzFleet/../nuvizz_ops/circuit'), /unsafe path segment/);
});

test('safeSegment: a traversal date can not reach a Firestore path builder', async () => {
  await assert.rejects(fsdb.readSummary('davis', '../nuvizz_ops'), /unsafe path segment/);
  await assert.rejects(fsdb.readLoad('davis', '2026-09-02', 'x/y'), /unsafe path segment/);
  await assert.rejects(fsdb.readDriverRoster('a?b'), /unsafe path segment/);
});

test('fieldPath: plain identifiers stand alone, anything else is backtick-quoted', () => {
  assert.equal(fsdb.fieldPath('tenant'), 'tenant');
  assert.equal(fsdb.fieldPath('last_scanned_at'), 'last_scanned_at');
  assert.equal(fsdb.fieldPath('a.b'), '`a.b`');
  assert.equal(fsdb.fieldPath('2x'), '`2x`');
});
