// test/osrm-truck-road-times.test.mjs — TRUCK ROAD TIMES, THE THIRD DRIVE-TIME SOURCE FOR A BUILD.
//
// A Build sequences on a straight-line estimate (1.3 x crow-flies at ~30 mph) unless it pays for
// Google. Our own OSRM service on Cloud Run gives real truck-road miles and minutes for free. These
// tests pin the rules that keep a bad answer from passing for a good one (lib/osrm-matrix.mts),
// the ID token that opens the private service (lib/google-id-token.mts), the fallback in
// resolveMatrix, the pipeline's report, and the status endpoint (osrm-status.mts).
//
// No test reaches the real service: globalThis.fetch is stubbed throughout, as in
// route-matrix-unroutable-leg.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// A real RSA key so the JWT is really signed (and verifiable) — set before any module reads it.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_EMAIL = 'firebase-adminsdk-fbsvc@davismarginiq.iam.gserviceaccount.com';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
process.env.FIREBASE_SA = JSON.stringify({ client_email: SA_EMAIL, private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: TOKEN_URI });

const { osrmBaseUrl, osrmTableUrl, osrmMatrixFromAnswer, OFF_MAP_SNAP_METERS, OsrmError } = await import('../netlify/functions/lib/osrm-matrix.mts');
const { idTokenFor, __resetIdTokenCache, REFRESH_MARGIN_MS } = await import('../netlify/functions/lib/google-id-token.mts');
const { resolveMatrix, haversineMatrix } = await import('../netlify/functions/google-route-matrix.mts');
const { runPipeline } = await import('../netlify/functions/lib/routing-pipeline.mts');
const { estimateMatrixCostUsd, DEFAULT_MATRIX_MODE } = await import('../netlify/functions/lib/routing-types.mts');
const statusHandler = (await import('../netlify/functions/osrm-status.mts')).default;

const BASE = 'https://osrm-truck-abc123-ue.a.run.app';
const BUFORD = { lat: 34.14838, lng: -83.95948 };          // the Buford terminal (DEPOT)
const A = { lat: 34.1530, lng: -83.9720 };
const B = { lat: 34.1390, lng: -83.9480 };

// The real three-point answer, measured on osrm-truck v26.9.0 (hints, names, locations trimmed).
const REAL = { code: 'Ok', durations: [[0, 162.7, 128.8], [234.8, 0, 131.6], [152, 175.4, 0]], distances: [[0, 1645.1, 1652.4], [2651.1, 0, 1787.8], [1717.6, 2332.4, 0]], sources: [{ distance: 24.06 }, { distance: 35.95 }, { distance: 16.49 }], destinations: [{ distance: 24.06 }, { distance: 35.95 }, { distance: 16.49 }] };

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fakeIdToken = (expSec, tag = 'x') => `${b64url({ alg: 'RS256' })}.${b64url({ exp: expSec, tag })}.sig-${tag}`;
const decodeJwt = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

// A stub network: the token endpoint and the OSRM service. `osrm(url)` returns a Response.
function stubNet({ osrm = () => new Response(JSON.stringify(REAL), { status: 200 }), token = () => new Response(JSON.stringify({ id_token: fakeIdToken(Math.floor(Date.now() / 1000) + 3600) }), { status: 200 }) } = {}) {
  const orig = globalThis.fetch;
  const calls = { token: [], osrm: [], other: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === TOKEN_URI) { calls.token.push({ url: u, init }); return token(init); }
    if (u.startsWith(BASE)) { calls.osrm.push({ url: u, init }); return osrm(u, init); }
    calls.other.push(u);
    throw new Error(`unexpected fetch ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
// An OSRM that never answers until aborted — a cold Cloud Run instance.
const hang = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e); }));
function captureErrors() {
  const orig = console.error;
  const lines = [];
  // Node's own ExperimentalWarning (MockTimers) is not a log line from the code under test.
  console.error = (...a) => { const l = a.join(' '); if (!/ExperimentalWarning/.test(l)) lines.push(l); };
  return { lines, restore: () => { console.error = orig; } };
}
function withEnv(v, fn) {
  const prev = process.env.OSRM_TRUCK_URL;
  if (v === undefined) delete process.env.OSRM_TRUCK_URL; else process.env.OSRM_TRUCK_URL = v;
  return Promise.resolve().then(fn).finally(() => { if (prev === undefined) delete process.env.OSRM_TRUCK_URL; else process.env.OSRM_TRUCK_URL = prev; });
}

// ── the address ─────────────────────────────────────────────────────────────────────────────

test('OSRM_TRUCK_URL pasted with a trailing slash or spaces still names the service; a path, http or junk means not configured', () => {
  assert.equal(osrmBaseUrl({ OSRM_TRUCK_URL: `  ${BASE}/ ` }), BASE);
  assert.equal(osrmBaseUrl({ OSRM_TRUCK_URL: `${BASE}///` }), BASE);
  assert.equal(osrmBaseUrl({ OSRM_TRUCK_URL: `${BASE}/table/v1` }), null, 'a path would break every table URL and the token audience');
  assert.equal(osrmBaseUrl({ OSRM_TRUCK_URL: BASE.replace('https', 'http') }), null);
  assert.equal(osrmBaseUrl({ OSRM_TRUCK_URL: `${BASE}?x=1` }), null);
  assert.equal(osrmBaseUrl({ OSRM_TRUCK_URL: 'osrm-truck' }), null);
  assert.equal(osrmBaseUrl({}), null);
});

test('longitude goes first: the Buford terminal reads -83.959480,34.148380 in the table URL, depot first', () => {
  const url = osrmTableUrl(BASE, BUFORD, [A, B]);
  assert.equal(url, `${BASE}/table/v1/driving/-83.959480,34.148380;-83.972000,34.153000;-83.948000,34.139000?annotations=duration,distance`);
});

// ── the answer ──────────────────────────────────────────────────────────────────────────────

test('the real three-point answer becomes whole seconds and metres, depot first, nothing estimated', () => {
  const { matrix, detail } = osrmMatrixFromAnswer(REAL, 2, haversineMatrix(BUFORD, [A, B]));
  assert.deepEqual(matrix.durationSec, [[0, 163, 129], [235, 0, 132], [152, 175, 0]]);
  assert.deepEqual(matrix.distanceMeters, [[0, 1645, 1652], [2651, 0, 1788], [1718, 2332, 0]]);
  assert.deepEqual(detail, { estimatedPairs: 0, noRoutePairs: 0, offMapStops: [] });
});

test('a pair with no truck route is priced at the straight-line road estimate, not as a free leg', () => {
  const ans = structuredClone(REAL);
  ans.durations[1][2] = null; ans.distances[1][2] = null;
  const est = haversineMatrix(BUFORD, [A, B]);
  const { matrix, detail } = osrmMatrixFromAnswer(ans, 2, est);
  assert.equal(matrix.durationSec[1][2], est.durationSec[1][2]);
  assert.equal(matrix.distanceMeters[1][2], est.distanceMeters[1][2]);
  assert.ok(matrix.durationSec[1][2] > 0 && matrix.distanceMeters[1][2] > 0, 'never a 0-cost leg');
  assert.equal(matrix.durationSec[2][1], 175, 'the other legs stay OSRM\'s');
  assert.deepEqual(detail, { estimatedPairs: 1, noRoutePairs: 1, offMapStops: [] });
});

test('a stop OSRM moved 19 km to reach a road (out to sea, or outside Georgia) is off the map: every leg to or from it is an estimate, and it is counted', () => {
  const ans = structuredClone(REAL);
  ans.sources[1].distance = 19056; ans.destinations[1].distance = 19056;  // what OSRM said for a point 19 km out to sea
  const est = haversineMatrix(BUFORD, [A, B]);
  const { matrix, detail } = osrmMatrixFromAnswer(ans, 2, est);
  for (const [i, j] of [[0, 1], [1, 0], [1, 2], [2, 1]]) {
    assert.equal(matrix.durationSec[i][j], est.durationSec[i][j], `leg ${i}->${j}`);
    assert.equal(matrix.distanceMeters[i][j], est.distanceMeters[i][j], `leg ${i}->${j}`);
  }
  assert.equal(matrix.durationSec[0][2], 129, 'legs between on-map points stay OSRM\'s');
  assert.deepEqual(detail, { estimatedPairs: 4, noRoutePairs: 0, offMapStops: [{ index: 0, snapMeters: 19056 }] });
  assert.equal(OFF_MAP_SNAP_METERS, 1000);
});

test('the depot off the map, an answer that is not Ok, the wrong size, or no snap distances is a failed call — never a partial matrix', () => {
  const est = haversineMatrix(BUFORD, [A, B]);
  const bad = [
    { ...structuredClone(REAL), sources: [{ distance: 5000 }, { distance: 1 }, { distance: 1 }] },
    { ...structuredClone(REAL), code: 'NoTable' },
    { code: 'Ok', durations: [[0, 1], [1, 0]], distances: [[0, 1], [1, 0]], sources: [{ distance: 1 }, { distance: 1 }] },
    { ...structuredClone(REAL), sources: undefined },
    null,
  ];
  for (const ans of bad) assert.throws(() => osrmMatrixFromAnswer(ans, 2, est), OsrmError);
});

// ── resolveMatrix: osrm, and every way it falls back ──────────────────────────────────────

test('a build asking for truck road times gets them: source osrm with its detail, one token and one GET with Bearer', async () => {
  __resetIdTokenCache();
  const net = stubNet();
  try {
    await withEnv(BASE, async () => {
      const r = await resolveMatrix(BUFORD, [A, B], 'osrm');
      assert.equal(r.source, 'osrm');
      assert.deepEqual(r.matrix.durationSec[0], [0, 163, 129]);
      assert.deepEqual(r.detail, { estimatedPairs: 0, noRoutePairs: 0, offMapStops: [] });
      assert.equal(net.calls.osrm.length, 1);
      assert.equal(net.calls.osrm[0].init.method, 'GET');
      assert.match(net.calls.osrm[0].init.headers.Authorization, /^Bearer \S+\.\S+\.\S+$/);
    });
  } finally { net.restore(); }
});

for (const [name, osrm] of [
  ['an answer that is not Ok', () => new Response(JSON.stringify({ code: 'TooBig', message: 'Too many table coordinates' }), { status: 200 })],
  ['an answer of the wrong size', () => new Response(JSON.stringify({ ...REAL, durations: [[0]], distances: [[0]] }), { status: 200 })],
  ['an answer that is not JSON', () => new Response('<html>502</html>', { status: 200 })],
  ['HTTP 401 (wrong audience)', () => new Response('Unauthorized', { status: 401 })],
  ['HTTP 403 (no Cloud Run Invoker)', () => new Response('Forbidden', { status: 403 })],
  ['HTTP 400 TooBig', () => new Response(JSON.stringify({ code: 'TooBig' }), { status: 400 })],
]) {
  test(`truck road times asked for, ${name}: the build falls back to the straight-line estimate (source haversine) and it is logged`, async () => {
    __resetIdTokenCache();
    const net = stubNet({ osrm });
    const log = captureErrors();
    try {
      await withEnv(BASE, async () => {
        const r = await resolveMatrix(BUFORD, [A, B], 'osrm');
        assert.equal(r.source, 'haversine');
        assert.equal(r.detail, undefined);
        assert.deepEqual(r.matrix, haversineMatrix(BUFORD, [A, B]));
      });
      assert.equal(log.lines.length, 1);
      assert.match(log.lines[0], /mode=osrm — falling back to haversine/);
    } finally { log.restore(); net.restore(); }
  });
}

test('a cold service that does not answer inside the 15 s budget: the build falls back to the estimate, logged, and does not wait past it', async (t) => {
  __resetIdTokenCache();
  const { OSRM_TIMEOUT_MS } = await import('../netlify/functions/lib/osrm-matrix.mts');
  assert.equal(OSRM_TIMEOUT_MS, 15000);
  const net = stubNet({ osrm: hang });
  const log = captureErrors();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withEnv(BASE, async () => {
      const p = resolveMatrix(BUFORD, [A, B], 'osrm');
      for (let i = 0; i < 20 && net.calls.osrm.length === 0; i++) await new Promise((r) => setImmediate(r));
      assert.equal(net.calls.osrm.length, 1, 'the table call went out');
      t.mock.timers.tick(OSRM_TIMEOUT_MS);
      const r = await p;
      assert.equal(r.source, 'haversine');
    });
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /did not answer within 15000 ms/);
  } finally { t.mock.timers.reset(); log.restore(); net.restore(); }
});

test('a service that sends its headers and then stalls the body still falls back inside the budget, never holding the build to its watchdog', async () => {
  __resetIdTokenCache();
  const stalledBody = (u, init) => new Response(new ReadableStream({ start(c) { init.signal.addEventListener('abort', () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; c.error(e); }); } }), { status: 200 });
  const net = stubNet({ osrm: stalledBody });
  try {
    await withEnv(BASE, async () => {
      const { fetchOsrmTable } = await import('../netlify/functions/lib/osrm-matrix.mts');
      const t0 = Date.now();
      await assert.rejects(fetchOsrmTable(BUFORD, [A, B], { timeoutMs: 150 }), (e) => e.kind === 'timeout');
      assert.ok(Date.now() - t0 < 2000);
    });
  } finally { net.restore(); }
});

test('a token exchange that times out is a token problem, never read as a cold service waking', async () => {
  __resetIdTokenCache();
  const net = stubNet({ token: (init) => hang(null, init) });
  try {
    await withEnv(BASE, async () => {
      const { fetchOsrmTable } = await import('../netlify/functions/lib/osrm-matrix.mts');
      const { statusError } = await import('../netlify/functions/osrm-status.mts');
      const err = await fetchOsrmTable(BUFORD, [A], { timeoutMs: 100 }).catch((e) => e);
      assert.equal(err.kind, 'token');
      assert.match(err.message, /timed out/);
      assert.equal(statusError(err, SA_EMAIL).state, 'error');
    });
    assert.equal(net.calls.osrm.length, 0);
  } finally { net.restore(); }
});

test('a token exchange that fails: the build falls back to the estimate, logged, and the OSRM service is never called', async () => {
  __resetIdTokenCache();
  const net = stubNet({ token: () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) });
  const log = captureErrors();
  try {
    await withEnv(BASE, async () => {
      const r = await resolveMatrix(BUFORD, [A, B], 'osrm');
      assert.equal(r.source, 'haversine');
    });
    assert.equal(net.calls.osrm.length, 0);
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /HTTP 400 \(invalid_grant\)/);
  } finally { log.restore(); net.restore(); }
});

test('OSRM_TRUCK_URL unset: truck road times make no fetch at all and the build uses the straight-line estimate', async () => {
  __resetIdTokenCache();
  const net = stubNet();
  const log = captureErrors();
  try {
    await withEnv(undefined, async () => {
      const r = await resolveMatrix(BUFORD, [A, B], 'osrm');
      assert.equal(r.source, 'haversine');
    });
    assert.equal(net.calls.token.length + net.calls.osrm.length + net.calls.other.length, 0);
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /OSRM_TRUCK_URL not set/);
  } finally { log.restore(); net.restore(); }
});

test('unticked is unchanged: haversine and google modes never touch the truck service, even with OSRM_TRUCK_URL set', async () => {
  __resetIdTokenCache();
  const net = stubNet();
  const prevKey = process.env.GOOGLE_ROUTES_API_KEY;
  delete process.env.GOOGLE_ROUTES_API_KEY;
  const log = captureErrors();
  try {
    await withEnv(BASE, async () => {
      const h = await resolveMatrix(BUFORD, [A, B]);
      assert.deepEqual(h, { matrix: haversineMatrix(BUFORD, [A, B]), source: 'haversine' });
      const g = await resolveMatrix(BUFORD, [A, B], 'google');
      assert.equal(g.source, 'haversine');
    });
    assert.equal(net.calls.token.length + net.calls.osrm.length, 0);
  } finally { log.restore(); net.restore(); if (prevKey !== undefined) process.env.GOOGLE_ROUTES_API_KEY = prevKey; }
});

test('a 151-node selection (150 stops + depot) goes out as one table call; 151 stops is refused before any call', async () => {
  __resetIdTokenCache();
  const stops150 = Array.from({ length: 150 }, (_, i) => ({ lat: 34 + i * 0.001, lng: -84 + i * 0.001 }));
  const n = 151;
  const sq = () => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : 100)));
  const net = stubNet({ osrm: () => new Response(JSON.stringify({ code: 'Ok', durations: sq(), distances: sq(), sources: Array.from({ length: n }, () => ({ distance: 5 })) }), { status: 200 }) });
  try {
    await withEnv(BASE, async () => {
      const r = await resolveMatrix(BUFORD, stops150, 'osrm');
      assert.equal(r.source, 'osrm');
      assert.equal(net.calls.osrm[0].url.split('?')[0].split('/').pop().split(';').length, 151);
      await assert.rejects(resolveMatrix(BUFORD, [...stops150, A], 'osrm'), /selection too large/);
    });
    assert.equal(net.calls.osrm.length, 1);
  } finally { net.restore(); }
});

// ── the ID token ────────────────────────────────────────────────────────────────────────────

test('the ID token is a signed jwt-bearer grant whose target_audience is the service address', async () => {
  __resetIdTokenCache();
  const net = stubNet();
  try {
    await idTokenFor(BASE);
    assert.equal(net.calls.token.length, 1);
    const form = new URLSearchParams(net.calls.token[0].init.body);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion');
    const claims = decodeJwt(assertion);
    assert.equal(claims.target_audience, BASE);
    assert.equal(claims.iss, SA_EMAIL);
    assert.equal(claims.sub, SA_EMAIL);
    assert.equal(claims.aud, TOKEN_URI);
    assert.ok(claims.exp > claims.iat);
    const [h, p, s] = assertion.split('.');
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')), 'signed with the service account key');
  } finally { net.restore(); }
});

test('the ID token is fetched once and reused across builds, then refetched inside 5 minutes of its expiry', async () => {
  __resetIdTokenCache();
  let n = 0;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const net = stubNet({ token: () => new Response(JSON.stringify({ id_token: fakeIdToken(exp, `t${++n}`) }), { status: 200 }) });
  try {
    const t1 = await idTokenFor(BASE);
    const t2 = await idTokenFor(BASE);
    assert.equal(t1, t2);
    assert.equal(net.calls.token.length, 1);
    const nearExpiry = () => exp * 1000 - REFRESH_MARGIN_MS + 1000;
    const t3 = await idTokenFor(BASE, { nowMs: nearExpiry });
    assert.notEqual(t3, t1);
    assert.equal(net.calls.token.length, 2);
  } finally { net.restore(); }
});

test('a failed token exchange caches nothing: the next build tries again instead of reusing a failure', async () => {
  __resetIdTokenCache();
  let fail = true;
  const net = stubNet({ token: () => (fail ? new Response('{"error":"invalid_grant"}', { status: 400 }) : new Response(JSON.stringify({ id_token: fakeIdToken(Math.floor(Date.now() / 1000) + 3600, 'ok') }), { status: 200 })) });
  try {
    await assert.rejects(idTokenFor(BASE), /HTTP 400/);
    fail = false;
    const t = await idTokenFor(BASE);
    assert.match(t, /sig-ok$/);
    assert.equal(net.calls.token.length, 2);
  } finally { net.restore(); }
});

test('a token whose expiry cannot be read is never cached, so it can never be used past its expiry', async () => {
  __resetIdTokenCache();
  const net = stubNet({ token: () => new Response(JSON.stringify({ id_token: 'not-a-jwt' }), { status: 200 }) });
  try {
    await idTokenFor(BASE);
    await idTokenFor(BASE);
    assert.equal(net.calls.token.length, 2);
  } finally { net.restore(); }
});

// ── the pipeline ────────────────────────────────────────────────────────────────────────────

const pstops = [
  { stopNbr: 'S1', lat: 0, lng: 1, pallets: 1, weight: 100, weightUOM: 'LB', stopDetails: [] },
  { stopNbr: 'S2', lat: 0, lng: 2, pallets: 1, weight: 100, weightUOM: 'LB', stopDetails: [] },
];
const truck = { id: 'BOX', maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26 } };
const dep = (source, detail) => async (depot, pts) => {
  const nodes = [depot, ...pts];
  const d = nodes.map((a) => nodes.map((b) => Math.round(Math.hypot(a.lat - b.lat, a.lng - b.lng) * 1000)));
  return { matrix: { distanceMeters: d, durationSec: d }, source, ...(detail ? { detail } : {}) };
};

test('a truck-road build reports matrixMode osrm, the source it was handed, its detail, and costs $0', async () => {
  const detail = { estimatedPairs: 2, noRoutePairs: 0, offMapStops: [{ index: 1, snapMeters: 4200 }] };
  const plan = await runPipeline({ stops: pstops, trucks: [truck], depot: { lat: 0, lng: 0 }, date: '2026-06-10', matrixMode: 'osrm' }, { buildMatrix: dep('osrm', detail) });
  assert.equal(plan.meta.matrixMode, 'osrm');
  assert.equal(plan.meta.matrixSource, 'osrm');
  assert.deepEqual(plan.meta.matrixDetail, detail);
  assert.equal(plan.meta.estimatedCostUsd, 0);
  assert.equal(estimateMatrixCostUsd(100, 'osrm'), 0);
});

test('a truck-road build whose service did not answer says so: matrixMode osrm, matrixSource haversine, no detail', async () => {
  const plan = await runPipeline({ stops: pstops, trucks: [truck], depot: { lat: 0, lng: 0 }, date: '2026-06-10', matrixMode: 'osrm' }, { buildMatrix: dep('haversine') });
  assert.equal(plan.meta.matrixMode, 'osrm');
  assert.equal(plan.meta.matrixSource, 'haversine');
  assert.equal(plan.meta.matrixDetail, null);
});

test('the default stays the straight-line estimate, and an unknown mode falls to it', async () => {
  assert.equal(DEFAULT_MATRIX_MODE, 'haversine');
  const plan = await runPipeline({ stops: pstops, trucks: [truck], depot: { lat: 0, lng: 0 }, date: '2026-06-10', matrixMode: 'bogus' }, { buildMatrix: dep('haversine') });
  assert.equal(plan.meta.matrixMode, 'haversine');
  assert.equal(plan.meta.matrixDetail, null);
});

// ── osrm-status ────────────────────────────────────────────────────────────────────────────

const statusReq = (q = '') => new Request(`https://dd-dispatch-map.netlify.app/.netlify/functions/osrm-status${q}`);
async function status(q, envUrl, netOpts) {
  __resetIdTokenCache();
  const net = stubNet(netOpts);
  const log = captureErrors();
  try {
    return await withEnv(envUrl, async () => {
      const res = await statusHandler(statusReq(q));
      const text = await res.text();
      return { res, text, body: JSON.parse(text), net, log };
    });
  } finally { log.restore(); net.restore(); }
}

test('osrm-status with OSRM_TRUCK_URL unset answers off and calls nothing', async () => {
  const { body, net } = await status('', undefined);
  assert.equal(body.state, 'off');
  assert.equal(body.caller, SA_EMAIL);
  assert.equal(net.calls.token.length + net.calls.osrm.length, 0);
});

test('osrm-status ?check=config answers off or set and makes no fetch, so opening the panel never wakes the service', async () => {
  const off = await status('?check=config', undefined);
  assert.deepEqual(off.body, { state: 'off' });
  const set = await status('?check=config', BASE);
  assert.deepEqual(set.body, { state: 'set' });
  assert.equal(set.net.calls.token.length + set.net.calls.osrm.length + set.net.calls.other.length, 0);
});

test('osrm-status ready: Buford to Lawrenceville in miles and minutes, the host and the caller — and never the token', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const tok = fakeIdToken(exp, 'SECRET-TOKEN-VALUE');
  const answer = { code: 'Ok', durations: [[0, 1500], [1480, 0]], distances: [[0, 24140.2], [24000, 0]], sources: [{ distance: 20 }, { distance: 30 }] };
  const { body, text, net } = await status('', BASE, { token: () => new Response(JSON.stringify({ id_token: tok }), { status: 200 }), osrm: () => new Response(JSON.stringify(answer), { status: 200 }) });
  assert.equal(body.state, 'ready');
  assert.equal(body.host, new URL(BASE).host);
  assert.equal(body.caller, SA_EMAIL);
  assert.equal(body.httpStatus, 200);
  assert.deepEqual(body.sample, { miles: 15, minutes: 25 });
  assert.equal(typeof body.ms, 'number');
  assert.match(net.calls.osrm[0].url, /-83\.959480,34\.148380;-83\.988000,33\.956200/);
  assert.ok(!text.includes('SECRET-TOKEN-VALUE') && !text.includes(tok), 'the token is never in the body');
  assert.ok(!text.includes('PRIVATE KEY'), 'nor the key');
});

test('osrm-status waking: a cold Cloud Run instance that does not answer in time reads waking, not broken', async (t) => {
  const mod = await import('../netlify/functions/lib/osrm-matrix.mts');
  // The real check waits 20 s; drive the same path through a short budget.
  __resetIdTokenCache();
  const net = stubNet({ osrm: hang });
  try {
    await withEnv(BASE, async () => {
      const err = await mod.fetchOsrmTable(BUFORD, [A], { timeoutMs: 100 }).catch((e) => e);
      const { statusError } = await import('../netlify/functions/osrm-status.mts');
      const out = statusError(err, SA_EMAIL);
      assert.equal(out.state, 'waking');
    });
  } finally { net.restore(); }
});

test('osrm-status 401 says token or audience; 403 says the caller lacks Cloud Run Invoker on osrm-truck and names the account', async () => {
  const r401 = await status('', BASE, { osrm: () => new Response('Unauthorized', { status: 401 }) });
  assert.equal(r401.body.state, 'error');
  assert.equal(r401.body.httpStatus, 401);
  assert.match(r401.body.error, /token or its audience/);
  const r403 = await status('', BASE, { osrm: () => new Response('Forbidden', { status: 403 }) });
  assert.equal(r403.body.state, 'error');
  assert.equal(r403.body.httpStatus, 403);
  assert.match(r403.body.error, /lacks Cloud Run Invoker on osrm-truck/);
  assert.ok(r403.body.error.includes(SA_EMAIL));
  for (const r of [r401, r403]) assert.ok(!/sig-x|Bearer/.test(r.text), 'no token in an error body');
});

test('osrm-status refuses anything but GET', async () => {
  const res = await statusHandler(new Request('https://x/.netlify/functions/osrm-status', { method: 'POST' }));
  assert.equal(res.status, 405);
});
