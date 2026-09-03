// hardening.test.mjs — the rules behind the security and bug fixes, each named
// for the real-world event it prevents. Handlers are driven end to end against
// an in-memory Firestore (test/helpers/fake-firestore.mjs) so a doc written by
// one endpoint is read back by another exactly as production would.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { installFakeFirestore } from './helpers/fake-firestore.mjs';

process.env.LOADSCAN_JWT_SECRET = 'test-secret-that-is-long-enough-to-pass-32';
process.env.LOADSCAN_ADMIN_BOOTSTRAP_SECRET = 'bootstrap-secret-that-is-long-enough';
const fake = installFakeFirestore();

const fs = await import('../netlify/functions/lib/firestore.mts');
const auth = await import('../netlify/functions/lib/auth.mts');
const http = await import('../netlify/functions/lib/http.mts');
const shift = await import('../netlify/functions/lib/shift.mts');
const admin = await import('../netlify/functions/driver-admin.mts');
const changePin = await import('../netlify/functions/driver-change-pin.mts');
const login = await import('../netlify/functions/driver-login.mts');
const scanSession = await import('../netlify/functions/scan-session.mts');
const workReport = await import('../netlify/functions/work-report.mts');
const api = await import('../src/lib/api.js');

const DISPATCHER_TOKEN = auth.issueToken('1', 'Dispatcher', 'dispatcher');
const DRIVER_TOKEN = auth.issueToken('4471', 'Brad Goodroe', 'driver');

/** Drive a handler with a Request the way Netlify would. */
const invoke = (mod, { method = 'POST', body, token, headers = {}, query = '' } = {}) =>
  mod.default(
    new Request(`http://localhost/.netlify/functions/x${query}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );

const seedDispatcher = () =>
  fs.setDoc('driver_auth/1', { driverNumber: '1', displayName: 'Dispatcher', role: 'dispatcher', active: true, pinHash: '' });

// ── A. Firestore paths stay inside their collection ──────────────────────────

test('a ".." segment cannot walk a driver_auth path into another collection', () => {
  assert.throws(() => fs.encodePath('driver_auth/../customer_notes/X'), /unsafe Firestore path segment/);
  assert.throws(() => fs.encodePath('driver_auth/.'), /unsafe/);
  assert.throws(() => fs.encodePath('driver_auth//1'), /unsafe/, 'an empty segment is refused, not dropped');
  assert.throws(() => fs.encodePath('/driver_auth/1'), /unsafe/, 'leading slash');
  for (const bad of ['a/b', 'a\\b', 'a?x=1', 'a#frag', '', '.', '..']) {
    assert.throws(() => fs.assertSafeSegment(bad), /unsafe/, `segment ${JSON.stringify(bad)}`);
  }
});

test('every real path this app writes still encodes unchanged', () => {
  assert.equal(fs.encodePath('driver_auth/4471'), 'driver_auth/4471');
  assert.equal(fs.encodePath('nuvizz_load_scans/davis__2026-08-07__DAVIS000201463'), 'nuvizz_load_scans/davis__2026-08-07__DAVIS000201463');
  assert.equal(fs.encodePath('load_scan_unmatched_aliases/2026-08-07__4471'), 'load_scan_unmatched_aliases/2026-08-07__4471');
  assert.equal(fs.encodePath('nuvizz_stop_index/davis__2026-08-07/stops'), 'nuvizz_stop_index/davis__2026-08-07/stops');
  assert.equal(fs.encodePath('x/a b'), 'x/a%20b', 'ordinary characters are still percent-encoded');
});

test('getDoc refuses a traversal path before any request leaves the box', async () => {
  const before = fake.calls;
  await assert.rejects(fs.getDoc('driver_auth/../customer_notes/X'), /unsafe/);
  assert.equal(fake.calls, before, 'no Firestore round trip');
});

// ── B. driver-admin: ids, the bootstrap secret, and the bootstrap gate ───────

test('an id is 1-64 of [A-Za-z0-9_-], which every real credential and review-row id satisfies', () => {
  for (const good of ['4471', '1', '2026-08-07__4471', 'a_b-c', 'x'.repeat(64)]) assert.equal(admin.isValidId(good), true, good);
  for (const bad of ['', '../customer_notes/X', 'a/b', 'a b', 'x'.repeat(65), 'a.b', 'é', null, undefined]) {
    assert.equal(admin.isValidId(bad), false, JSON.stringify(bad));
  }
});

test('a dispatcher posting a traversal driverNumber gets 400, and nothing is read or written', async () => {
  fake.docs.clear();
  await seedDispatcher();
  const before = fake.calls;
  const res = await invoke(admin, { token: DISPATCHER_TOKEN, body: { action: 'clear-lockout', driverNumber: '../customer_notes/X' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /driverNumber/);
  // One read happened: the dispatcher's own credential re-check. Nothing after it.
  assert.equal(fake.calls, before + 1);
});

test('resolve-unmatched and add-alias refuse a traversal review-row id', async () => {
  fake.docs.clear();
  await seedDispatcher();
  await fs.setDoc('driver_auth/4471', { driverNumber: '4471', displayName: 'Brad Goodroe', role: 'driver', active: true, nuvizzAliases: [] });

  let res = await invoke(admin, { token: DISPATCHER_TOKEN, body: { action: 'resolve-unmatched', id: '../driver_auth/1' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /^id /);

  res = await invoke(admin, {
    token: DISPATCHER_TOKEN,
    body: { action: 'add-alias', driverNumber: '4471', alias: 'BRAD GOODROE', resolveId: '../driver_auth/1' },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /resolveId/);
  const cred = await fs.getDoc('driver_auth/4471');
  assert.deepEqual(cred.nuvizzAliases, [], 'the refusal left the alias untouched — nothing half-done');
});

test('the bootstrap secret is compared in constant time and a wrong one is a plain 401', async () => {
  assert.equal(http.secretMatches('abc', 'abc'), true);
  assert.equal(http.secretMatches('abc', 'abd'), false);
  assert.equal(http.secretMatches('abc', 'abcd'), false, 'different length');
  assert.equal(http.secretMatches('', ''), false, 'an empty secret never matches');
  assert.equal(http.secretMatches('abc', undefined), false);

  fake.docs.clear();
  const res = await invoke(admin, {
    headers: { 'x-bootstrap-secret': 'bootstrap-secret-that-is-long-enougH' },
    body: { action: 'bootstrap-dispatcher', driverNumber: '2', pin: '1234' },
  });
  assert.equal(res.status, 401);
});

test('hasActiveDispatcher: only an ACTIVE dispatcher counts', () => {
  assert.equal(auth.hasActiveDispatcher([]), false);
  assert.equal(auth.hasActiveDispatcher([{ role: 'driver', active: true }]), false);
  assert.equal(auth.hasActiveDispatcher([{ role: 'dispatcher', active: false }]), false, 'a deactivated dispatcher is not cover');
  assert.equal(auth.hasActiveDispatcher([{ role: 'dispatcher' }]), true, 'active defaults to true');
  assert.equal(auth.hasActiveDispatcher([{ role: 'dispatcher', active: true }]), true);
});

test('the bootstrap secret creates the FIRST dispatcher and is then refused, even if the env var stays set', async () => {
  fake.docs.clear();
  const bootstrap = (driverNumber) =>
    invoke(admin, {
      headers: { 'x-bootstrap-secret': process.env.LOADSCAN_ADMIN_BOOTSTRAP_SECRET },
      body: { action: 'bootstrap-dispatcher', driverNumber, pin: '1234' },
    });

  // Nobody yet: allowed.
  let res = await bootstrap('2');
  assert.equal(res.status, 200);
  assert.equal((await fs.getDoc('driver_auth/2')).role, 'dispatcher');

  // One active dispatcher exists: the secret is no longer a way in.
  res = await bootstrap('3');
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /dispatcher already exists/);
  assert.equal(await fs.getDoc('driver_auth/3'), null, 'no second dispatcher minted');

  // The only dispatcher was deactivated: recovery path opens again.
  await fs.patchDoc('driver_auth/2', { active: false });
  res = await bootstrap('3');
  assert.equal(res.status, 200, 'an inactive dispatcher is not cover — bootstrap is the recovery path');
});

// ── C. work-report reads the shape scan-session writes ───────────────────────

const inWindow = (shiftDay) => {
  const { start } = shift.shiftWindow(shiftDay);
  return new Date(Date.parse(start) + 3 * 3600_000).toISOString(); // 11pm ET the evening before
};

test('a session doc in scan-session\'s own shape (workedBy) is found for its shift', () => {
  const day = '2026-08-07';
  const at = inWindow(day);
  const doc = { date: '2026-08-06', loadNbr: 'STEVEN', workedBy: [{ driverNumber: '4471', role: 'loader', pieces: 12, firstAt: at, lastAt: at }] };
  assert.equal(workReport.sessionsOverlappingShift([doc], day).length, 1);
  const oldShape = { ...doc, workedBy: undefined, workers: doc.workedBy };
  assert.equal(workReport.sessionsOverlappingShift([oldShape], day).length, 0, 'the field nobody writes is not the one read');
});

test('deriveFromScans builds a derived session with the name off the credential', () => {
  const at = inWindow('2026-08-07');
  const doc = { loadNbr: 'STEVEN', closedAt: null, workedBy: [{ driverNumber: '4471', role: 'loader', pieces: 12, firstAt: at, lastAt: at }] };
  const creds = [{ driverNumber: '4471', displayName: 'Brad Goodroe' }];
  const out = workReport.deriveFromScans([], [doc], creds);
  assert.equal(out.length, 1);
  assert.equal(out[0].worker, '4471');
  assert.equal(out[0].workerName, 'Brad Goodroe', 'mergeWorker never stores a name; it comes from driver_auth');
  assert.equal(out[0].pieces, 12);
  assert.equal(out[0].source, 'derived');
  assert.equal(workReport.deriveFromScans([], [doc], [])[0].workerName, '4471', 'no credential: the number, never blank');
});

test('a truck scanned on the gun with no clock-in shows on the report as derived, not "no app activity at all"', async () => {
  fake.docs.clear();
  await seedDispatcher();
  await fs.setDoc('driver_auth/4471', { driverNumber: '4471', displayName: 'Brad Goodroe', role: 'driver', active: true });

  const push = await invoke(scanSession, {
    token: DRIVER_TOKEN,
    body: {
      loadNbr: 'DAVIS000201463',
      scans: [
        { og: 'OG6028479182', pro: '7152411', stopNbr: '1', engine: 'wedge' },
        { og: 'OG6028479183', pro: '7152412', stopNbr: '2', engine: 'wedge' },
      ],
    },
  });
  assert.equal(push.status, 200);
  assert.equal((await push.json()).added, 2);

  const day = shift.shiftDayString();
  const res = await invoke(workReport, { method: 'GET', token: DISPATCHER_TOKEN, query: `?shiftDay=${day}&days=1` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reports.length, 1);
  const row = body.reports[0].rows.find((r) => r.loadNbr === 'DAVIS000201463');
  assert.ok(row, 'the load the driver scanned is on the report');
  assert.equal(row.worker, '4471');
  assert.equal(row.workerName, 'Brad Goodroe');
  assert.equal(row.timing, 'derived');
  assert.equal(row.pieces, 2);
  assert.deepEqual(body.reports[0].offApp, [], 'not reported as loaded without the app');
});

test('?days=abc is one day, not NaN — and the CSV filename does not read "undefined"', async () => {
  fake.docs.clear();
  await seedDispatcher();
  let res = await invoke(workReport, { method: 'GET', token: DISPATCHER_TOKEN, query: '?shiftDay=2026-08-07&days=abc' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.days, 1);
  assert.equal(body.reports.length, 1);

  res = await invoke(workReport, { method: 'GET', token: DISPATCHER_TOKEN, query: '?shiftDay=2026-08-07&days=abc&format=csv' });
  assert.equal(res.status, 200);
  const disp = res.headers.get('content-disposition');
  assert.doesNotMatch(disp, /undefined/);
  assert.match(disp, /loadscan-2026-08-07_to_2026-08-07\.csv/);

  res = await invoke(workReport, { method: 'GET', token: DISPATCHER_TOKEN, query: '?shiftDay=2026-08-07&days=999' });
  assert.equal((await res.json()).days, 31, 'still clamped at the top');
});

// ── D. the scanner gun is recorded as the gun ────────────────────────────────

test('a gun (wedge) scan is stored as wedge, not as a hand-typed piece', async () => {
  assert.equal(scanSession.normalizeScan({ og: 'OG6028479182', pro: '7152411', engine: 'wedge' }).row.engine, 'wedge');
  assert.equal(scanSession.normalizeScan({ og: 'OG6028479182', pro: '7152411', engine: 'WEDGE' }).row.engine, 'wedge');
  assert.equal(scanSession.normalizeScan({ og: 'TYPED-7152411-1', pro: '7152411', engine: 'wedge' }).row.engine, 'manual', 'a typed piece is never a scan');
  assert.equal(scanSession.normalizeScan({ og: 'OG6028479182', pro: '7152411', engine: 'laser' }).row.engine, 'manual', 'unknown still falls back');

  fake.docs.clear();
  await invoke(scanSession, {
    token: DRIVER_TOKEN,
    body: { loadNbr: 'GUN', date: '2026-08-07', scans: [{ og: 'OG6028479182', pro: '7152411', engine: 'wedge' }] },
  });
  const doc = await fs.getDoc('nuvizz_load_scans/davis__2026-08-07__GUN');
  assert.equal(doc.scans[0].engine, 'wedge', 'survives ingest and storage');
});

// ── E. size caps ─────────────────────────────────────────────────────────────

test('checkPayloadCaps names the first breach: row count, stopNbr, reason, reconciliation text', () => {
  const okScan = { og: 'OG6028479182', pro: '7152411', stopNbr: '1' };
  assert.equal(scanSession.checkPayloadCaps({ scans: Array(500).fill(okScan) }), null, '500 rows is within the cap');
  assert.equal(scanSession.checkPayloadCaps({}), null);

  let v = scanSession.checkPayloadCaps({ scans: Array(501).fill(okScan) });
  assert.deepEqual([v.list, v.index], ['scans', null]);
  assert.match(v.detail, /501 rows, max 500/);

  v = scanSession.checkPayloadCaps({ handConfirms: Array(501).fill({ stopNbr: '1', pieces: 1 }) });
  assert.equal(v.list, 'handConfirms');

  v = scanSession.checkPayloadCaps({ scans: [okScan, { ...okScan, stopNbr: 'x'.repeat(33) }] });
  assert.deepEqual([v.list, v.index], ['scans', 1]);
  assert.match(v.detail, /stopNbr is 33 chars, max 32/);
  assert.equal(scanSession.checkPayloadCaps({ scans: [{ ...okScan, stopNbr: 'x'.repeat(32) }] }), null);

  v = scanSession.checkPayloadCaps({ handConfirms: [{ stopNbr: '1', pieces: 1, reason: 'r'.repeat(501) }] });
  assert.deepEqual([v.list, v.index], ['handConfirms', 0]);
  assert.match(v.detail, /reason is 501 chars/);

  v = scanSession.checkPayloadCaps({ reconciliation: { note: 'n'.repeat(501) } });
  assert.equal(v.list, 'reconciliation');
  v = scanSession.checkPayloadCaps({ reconciliation: { resolvedBy: 'n'.repeat(501) } });
  assert.match(v.detail, /resolvedBy/);
  assert.equal(scanSession.checkPayloadCaps({ reconciliation: { note: 'n'.repeat(500), resolvedBy: 'Brad' } }), null);
});

test('an oversized push is 413 with the offending row named, and costs no Firestore read', async () => {
  fake.docs.clear();
  const before = fake.calls;
  const res = await invoke(scanSession, {
    token: DRIVER_TOKEN,
    body: { loadNbr: 'BIG', date: '2026-08-07', scans: Array(501).fill({ og: 'OG6028479182', pro: '7152411' }) },
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'payload_too_large');
  assert.equal(body.list, 'scans');
  assert.match(body.detail, /max 500/);
  assert.equal(fake.calls, before, 'refused before the read');
  assert.equal(await fs.getDoc('nuvizz_load_scans/davis__2026-08-07__BIG'), null);
});

test('a rejected row keeps a 256-char excerpt, never the whole object', () => {
  const huge = { og: 'bad', junk: 'x'.repeat(10_000) };
  const kept = scanSession.rejectedExcerpt(huge);
  assert.equal(typeof kept, 'string');
  assert.equal(kept.length, 256);
  assert.ok(kept.startsWith('{"og":"bad"'), 'still readable as evidence');
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => scanSession.rejectedExcerpt(circular));
  assert.equal(scanSession.rejectedExcerpt(undefined), 'undefined');
});

test('the phone\'s slice size never exceeds the server cap, or a backlog could never drain', () => {
  assert.ok(api.PUSH_ROWS_MAX <= scanSession.CAPS.rows, `${api.PUSH_ROWS_MAX} > ${scanSession.CAPS.rows}`);
});

test('an ordinary push, and its replay, are unchanged for a legitimate driver', async () => {
  fake.docs.clear();
  const body = {
    loadNbr: 'STEVEN',
    date: '2026-08-07',
    scans: [{ og: 'OG6028479182', pro: '7152411', stopNbr: '1', engine: 'native' }, { og: 'nope', pro: '' }],
    handConfirms: [{ stopNbr: '2', pieces: 3, reason: 'averitt label' }],
  };
  let res = await invoke(scanSession, { token: DRIVER_TOKEN, body });
  assert.equal(res.status, 200);
  let out = await res.json();
  assert.equal(out.added, 1);
  assert.equal(out.handAdded, 1);
  assert.equal(out.rejected, 1, 'the bad row is still recorded, with its reason');
  assert.equal(typeof out.rejectedDetail[0].raw, 'string');

  res = await invoke(scanSession, { token: DRIVER_TOKEN, body });
  out = await res.json();
  assert.equal(out.duplicates, 1, 'replay is idempotent');
  assert.equal(out.handDuplicates, 1);
});

// ── F. the service worker never caches a broken page as the offline shell ────

async function runServiceWorker(fetchImpl) {
  const src = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const listeners = {};
  const puts = [];
  const cache = { put: async (k, v) => puts.push([k, v]), add: async () => {}, match: async () => undefined };
  const ctx = {
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: async () => undefined },
    fetch: fetchImpl,
    URL,
    Response,
    console,
  };
  ctx.self = {
    addEventListener: (type, fn) => (listeners[type] = fn),
    location: { origin: 'https://ddsloadout.netlify.app' },
    clients: { claim: async () => {} },
    skipWaiting: () => {},
  };
  vm.runInNewContext(src, ctx);
  let responded;
  listeners.fetch({
    request: { method: 'GET', url: 'https://ddsloadout.netlify.app/', mode: 'navigate' },
    respondWith: (p) => (responded = p),
  });
  const res = await responded;
  await new Promise((r) => setTimeout(r, 0)); // let the un-awaited cache.put settle
  return { res, puts };
}

test('a 5xx navigation response is served but NOT cached as the offline shell', async () => {
  const { res, puts } = await runServiceWorker(async () => new Response('bad gateway', { status: 503 }));
  assert.equal(res.status, 503, 'the driver still sees the real error');
  assert.equal(puts.length, 0, 'the yard does not get a 503 page as its app forever');
});

test('a good navigation response IS cached as the offline shell', async () => {
  const { puts } = await runServiceWorker(async () => new Response('<html>ok</html>', { status: 200 }));
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], '/index.html');
});

// ── G. the CSV export carries the token ──────────────────────────────────────

test('the CSV export is fetched with the bearer token and returns text plus the server filename', async () => {
  const saved = globalThis.fetch;
  let seen;
  globalThis.fetch = async (path, init) => {
    seen = { path, init };
    return new Response('a,b\n1,2\n', {
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="loadscan-2026-08-06_to_2026-08-07.csv"' },
    });
  };
  try {
    const r = await api.workReportCsv('tok', { shiftDay: '2026-08-07', days: 2 });
    assert.equal(seen.init.headers.Authorization, 'Bearer tok', 'a bare <a href> could never send this');
    assert.match(seen.path, /work-report\?shiftDay=2026-08-07&days=2&format=csv$/);
    assert.equal(r.text, 'a,b\n1,2\n');
    assert.equal(r.filename, 'loadscan-2026-08-06_to_2026-08-07.csv');
  } finally {
    globalThis.fetch = saved;
  }
});

test('an unauthorized CSV export is an error, not a file containing {"ok":false}', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(api.workReportCsv('bad', { shiftDay: '2026-08-07' }), (e) => e.status === 401 && /unauthorized/.test(e.message));
  } finally {
    globalThis.fetch = saved;
  }
});

// ── H. security headers on every response ────────────────────────────────────

test('netlify.toml sends HSTS, nosniff, referrer policy and frame denial on every path', async () => {
  const toml = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
  const block = /\[\[headers\]\]\s*\n\s*for = "\/\*"\s*\n\s*\[headers\.values\]([\s\S]*?)(?:\n\[\[|\s*$)/.exec(toml);
  assert.ok(block, 'a [[headers]] block for "/*"');
  const values = block[1];
  assert.match(values, /Strict-Transport-Security = "max-age=31536000; includeSubDomains"/);
  assert.match(values, /X-Content-Type-Options = "nosniff"/);
  assert.match(values, /Referrer-Policy = "strict-origin-when-cross-origin"/);
  assert.match(values, /X-Frame-Options = "DENY"/);
  assert.match(values, /Content-Security-Policy = "frame-ancestors 'none'"/);
  assert.doesNotMatch(values, /script-src|default-src/, 'no full CSP yet — Quagga loads from jsdelivr');
});

// ── I. lockout accounting ────────────────────────────────────────────────────

test('one wrong PIN after a lockout has EXPIRED is failure #1, not a fresh 15-minute lock', () => {
  const now = Date.parse('2026-07-29T12:00:00Z');
  const expired = { failedAttempts: 5, lockedUntil: new Date(now - 60_000).toISOString() };
  assert.deepEqual(auth.nextFailureState(expired, now), { failedAttempts: 1, lockedUntil: null });

  const stillLocked = { failedAttempts: 5, lockedUntil: new Date(now + 60_000).toISOString() };
  assert.equal(auth.nextFailureState(stillLocked, now).failedAttempts, 6, 'an unexpired lock keeps counting');

  assert.deepEqual(auth.nextFailureState({ failedAttempts: 2, lockedUntil: null }, now), { failedAttempts: 3, lockedUntil: null });
});

test('driver-login: a wrong PIN after the lockout has passed is a plain reject with the counter restarted', async () => {
  fake.docs.clear();
  await fs.setDoc('driver_auth/4471', {
    driverNumber: '4471', displayName: 'Brad Goodroe', role: 'driver', active: true,
    pinHash: await auth.hashPin('1234'), failedAttempts: 5, lockedUntil: new Date(Date.now() - 60_000).toISOString(),
  });
  const res = await invoke(login, { body: { driverNumber: '4471', pin: '0000' } });
  assert.equal(res.status, 401, 'not 423');
  const doc = await fs.getDoc('driver_auth/4471');
  assert.equal(doc.failedAttempts, 1);
  assert.equal(doc.lockedUntil, null);
});

test('driver-change-pin counts wrong current PINs and locks on the fifth, exactly like sign-in', async () => {
  fake.docs.clear();
  await fs.setDoc('driver_auth/4471', {
    driverNumber: '4471', displayName: 'Brad Goodroe', role: 'driver', active: true,
    pinHash: await auth.hashPin('1234'), failedAttempts: 0, lockedUntil: null,
  });
  const attempt = (currentPin, newPin = '9876') => invoke(changePin, { token: DRIVER_TOKEN, body: { currentPin, newPin } });

  for (let i = 1; i <= 4; i++) {
    const res = await attempt('0000');
    assert.equal(res.status, 401, `attempt ${i}`);
    assert.equal((await fs.getDoc('driver_auth/4471')).failedAttempts, i);
  }
  let res = await attempt('0000');
  assert.equal(res.status, 423, 'the fifth locks');
  const body = await res.json();
  assert.equal(body.error, 'locked');
  assert.ok(body.lockedUntil);

  res = await attempt('1234');
  assert.equal(res.status, 423, 'the RIGHT pin is refused while locked — no oracle');
  assert.equal(await auth.verifyPin('1234', (await fs.getDoc('driver_auth/4471')).pinHash), true, 'PIN unchanged');

  // Lockout passes; one more slip is failure #1, not a re-lock.
  await fs.patchDoc('driver_auth/4471', { lockedUntil: new Date(Date.now() - 1000).toISOString() });
  res = await attempt('0000');
  assert.equal(res.status, 401);
  assert.equal((await fs.getDoc('driver_auth/4471')).failedAttempts, 1);

  res = await attempt('1234');
  assert.equal(res.status, 200, 'the legitimate change goes through');
  const doc = await fs.getDoc('driver_auth/4471');
  assert.equal(await auth.verifyPin('9876', doc.pinHash), true);
  assert.equal(doc.failedAttempts, 0);
  assert.equal(doc.mustChangePin, false);
});

// ── J. two loaders on one truck ──────────────────────────────────────────────
//
// The dock case this exists for: two people load one trailer, both phones flush
// at once, and the handler read-merge-writes a single document. Before the
// compare-and-swap, the second write replaced the first — one loader's pieces
// vanished from the record while BOTH phones got a 200 and dropped their local
// copies. The freight was on the truck and nothing knew it.

/**
 * Run two pushes with a genuine interleave: hold the first conditional write
 * until the second push has fully landed. Without the hold the fake resolves
 * both in whatever order the scheduler picks, which is not the race we mean.
 */
async function racePushes(bodyA, bodyB, loadNbr) {
  const realFetch = globalThis.fetch;
  let release;
  const held = new Promise((r) => { release = r; });
  let heldTheFirstWrite = false;
  globalThis.fetch = async (input, init = {}) => {
    const isWrite = String(init.method || 'GET').toUpperCase() === 'PATCH' && String(input).includes(loadNbr);
    if (isWrite && !heldTheFirstWrite) {
      heldTheFirstWrite = true;
      await held;
    }
    return realFetch(input, init);
  };
  try {
    const a = invoke(scanSession, { token: DRIVER_TOKEN, body: bodyA });
    // Let A finish its read and arrive at the held write.
    await new Promise((r) => setTimeout(r, 20));
    const resB = await invoke(scanSession, { token: DISPATCHER_TOKEN, body: bodyB });
    release();
    return { resA: await a, resB };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const pieceScan = (og, stopNbr, at) => ({ og, pro: '0071576871', scannedAt: at, stopNbr, engine: 'wedge' });

test('two loaders pushing one load at the same moment: neither loader\'s pieces are lost', async () => {
  fake.docs.clear();
  const date = '2026-08-07';
  const loadNbr = 'DAVIS000201463';
  const { resA, resB } = await racePushes(
    { loadNbr, date, scans: [pieceScan('OG0000000001', '1', '2026-08-07T09:00:00.000Z')] },
    { loadNbr, date, scans: [pieceScan('OG0000000002', '2', '2026-08-07T09:00:05.000Z')] },
    loadNbr,
  );

  assert.equal(resB.status, 200, 'the loader who got there first is accepted');
  assert.equal(resA.status, 200, 'and so is the one who lost the race');

  const doc = await fs.getDoc(`nuvizz_load_scans/davis__${date}__${loadNbr}`);
  assert.deepEqual(
    doc.scans.map((s) => s.og).sort(),
    ['OG0000000001', 'OG0000000002'],
    'both pieces are on the load, not just the last writer\'s',
  );
  assert.equal(doc.scannedPieces, 2);
  assert.equal(doc.scannedCount, 2);

  const a = await resA.json();
  assert.equal(a.attempts, 2, 'the losing write was retried against the winner\'s document, not forced over it');
  assert.equal(a.added, 1, 'and it still reports only the piece it actually contributed');
});

test('both loaders are recorded in workedBy — the retry merges into the winner\'s row, not over it', async () => {
  fake.docs.clear();
  const date = '2026-08-07';
  const loadNbr = 'DAVIS000201464';
  await racePushes(
    { loadNbr, date, scans: [pieceScan('OG0000000011', '1', '2026-08-07T09:00:00.000Z')] },
    { loadNbr, date, scans: [pieceScan('OG0000000012', '2', '2026-08-07T09:00:05.000Z')] },
    loadNbr,
  );
  const doc = await fs.getDoc(`nuvizz_load_scans/davis__${date}__${loadNbr}`);
  const who = (doc.workedBy || []).map((w) => w.driverNumber).sort();
  assert.deepEqual(who, ['1', '4471'], 'the loader and the dispatcher both survive in the history');
});

test('a push that keeps losing the race is a 409, so the phone keeps the rows queued', async () => {
  fake.docs.clear();
  const date = '2026-08-07';
  const loadNbr = 'DAVIS000201465';
  await fs.setDoc(`nuvizz_load_scans/davis__${date}__${loadNbr}`, { loadNbr, scans: [] });

  // Every conditional write loses: someone else always got there first.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (String(init.method || 'GET').toUpperCase() === 'PATCH' && url.includes('currentDocument.updateTime')) {
      return new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  };
  let res;
  try {
    res = await invoke(scanSession, {
      token: DRIVER_TOKEN,
      body: { loadNbr, date, scans: [pieceScan('OG0000000021', '1', '2026-08-07T09:00:00.000Z')] },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.status, 409, 'not a 200 — a 200 would make the phone drop the only other copy');
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.retryable, true);
});

test('a conditional write is refused outright when the document changed, and never silently overwrites', async () => {
  fake.docs.clear();
  await fs.setDoc('nuvizz_load_scans/probe', { v: 1 });
  const { data, updateTime } = await fs.getDocWithMeta('nuvizz_load_scans/probe');
  assert.equal(data.v, 1);
  assert.ok(updateTime, 'the read carries the version the write will be judged against');

  assert.equal(await fs.setDocIfUnchanged('nuvizz_load_scans/probe', { v: 2 }, updateTime), true);
  assert.equal(await fs.setDocIfUnchanged('nuvizz_load_scans/probe', { v: 3 }, updateTime), false, 'a stale base version does not land');
  assert.equal((await fs.getDoc('nuvizz_load_scans/probe')).v, 2, 'and the winner\'s value is still there');

  assert.equal(await fs.setDocIfUnchanged('nuvizz_load_scans/probe', { v: 4 }, null), false, '"must not exist" fails once it exists');
  assert.equal(await fs.setDocIfUnchanged('nuvizz_load_scans/fresh', { v: 1 }, null), true, 'and succeeds when it truly does not');
});
