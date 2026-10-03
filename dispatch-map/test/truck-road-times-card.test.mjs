// test/truck-road-times-card.test.mjs — THE COMPARE CARD'S TRUCK-ROAD BOX, BESIDE GOOGLE'S.
//
// Chad: "In both places Google's 'real road distances / drive-times' checkbox appears, put 'Use
// truck road times (free)' on the same row, beside it, not stacked above." The second place is the
// Compare card under Re-sequence…. Its re-sequence must take the same OSRM-with-straight-line-
// fallback path a Build takes, and with the truck box unticked the card is exactly what it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cardMatrixMode, cardRoadWords } from '../src/lib/routing-select.js';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');
const between = (start, end) => { const a = code.indexOf(start); assert.ok(a >= 0, `anchor missing: ${start}`); const b = code.indexOf(end, a + start.length); assert.ok(b > a, `anchor missing: ${end}`); return code.slice(a, b); };

// ── the rule ────────────────────────────────────────────────────────────────────────────────

test('UNTICKED = UNCHANGED on the card: neither box asks for nothing; Google alone asks for google with the words it always used', () => {
  assert.equal(cardMatrixMode({}), null);
  assert.equal(cardMatrixMode({ roadMatrixOn: false, truckMatrixOn: false }), null);
  assert.equal(cardMatrixMode({ roadMatrixOn: true }), 'google');
  assert.deepEqual(cardRoadWords('google'), { applied: 'real road distances', name: 'road distances', suffix: 'road' });
});

test('the truck box asks for osrm and reports in truck-road words; Google wins if both ever arrive set', () => {
  assert.equal(cardMatrixMode({ truckMatrixOn: true }), 'osrm');
  assert.equal(cardMatrixMode({ roadMatrixOn: true, truckMatrixOn: true }), 'google');
  assert.deepEqual(cardRoadWords('osrm'), { applied: 'truck road times', name: 'truck road times', suffix: 'truck' });
});

// ── the server: the card's handler takes 'osrm' down the Build's own path ───────────────────

test('the road-box handler asked for osrm with OSRM_TRUCK_URL unset makes no call and answers haversine, so the card keeps its straight-line order', async () => {
  delete process.env.OSRM_TRUCK_URL;
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error('no network in this test'); };
  const err = console.error; const lines = []; console.error = (...a) => lines.push(a.join(' '));
  try {
    const handler = (await import('../netlify/functions/google-route-matrix.mts')).default;
    const res = await handler(new Request('https://x/.netlify/functions/google-route-matrix', { method: 'POST', body: JSON.stringify({ depot: { lat: 34.14838, lng: -83.95948 }, stops: [{ lat: 34.15, lng: -83.97 }, { lat: 34.14, lng: -83.95 }], mode: 'osrm' }) }));
    const j = await res.json();
    assert.equal(res.status, 200);
    assert.equal(j.source, 'haversine');
    assert.equal(j.detail, undefined);
    assert.equal(j.matrix.distanceMeters.length, 3);
    assert.equal(calls.length, 0);
    assert.match(lines.join('\n'), /mode=osrm — falling back to haversine/);
  } finally { globalThis.fetch = orig; console.error = err; }
});

test('the road-box handler: a body without mode, or with google, answers exactly as before (no detail key)', async () => {
  delete process.env.GOOGLE_ROUTES_API_KEY;
  const err = console.error; console.error = () => {};
  try {
    const handler = (await import('../netlify/functions/google-route-matrix.mts')).default;
    for (const mode of [undefined, 'google', 'bogus']) {
      const res = await handler(new Request('https://x/', { method: 'POST', body: JSON.stringify({ depot: { lat: 34, lng: -84 }, stops: [{ lat: 34.1, lng: -84.1 }], ...(mode ? { mode } : {}) }) }));
      const j = await res.json();
      assert.deepEqual(Object.keys(j).sort(), ['available', 'matrix', 'source']);
      assert.equal(j.source, 'haversine');
    }
  } finally { console.error = err; }
});

// ── the wiring ──────────────────────────────────────────────────────────────────────────────

const card = between('function RoutingWorkbenchCard(', '\nfunction ');

// CHANGED ON PURPOSE in v1.116.0. Chad: "I don't need a big description for them. I just need a
// label for them because I want them side by side on the same row in the compare panel." The row no
// longer wraps, the labels are short, and the applied note moved out of the labels to its own line.
test('the card shows Google roads ($price) and Truck roads (free) side by side, Google first, Google priced and the truck box not', () => {
  const row = card.slice(card.indexOf('data-card-road-boxes'), card.indexOf('data-card-road-applied'));
  const g = row.indexOf('Google roads <b>(');
  const t = row.indexOf('<span>Truck roads <b>(free)</b></span>');
  assert.ok(g >= 0 && t > g, 'both boxes are not in the one row, Google first');
  assert.ok(/<span>Google roads <b>\(\{rows\.length > 1 \? `\$\$\{\(\(\(rows\.length \+ 1\) \*\* 2\) \/ 1000 \* BASIC_RATE_PER_1K_USD\)\.toFixed\(2\)\}` : '\$'\}\)<\/b><\/span>/.test(row), 'Google lost its per-pick price, or the ($) with one stop or none');
  const truck = row.slice(row.lastIndexOf('<label', t), row.indexOf('</label>', t));
  assert.ok(!/BASIC_RATE|\$\{\(/.test(truck.replace(/title=\{[^}]*\}/, '')), 'the truck box shows a cost line');
  assert.ok(!/Use real road distances|Use truck road times|costs money/.test(row), 'the long labels are back on the card');
});

test('the card row never wraps, and the long wording lives in each label\'s hover title', () => {
  const head = card.slice(card.indexOf('data-card-road-boxes') - 160, card.indexOf('data-card-road-boxes'));
  assert.ok(/flex flex-nowrap items-center/.test(head) && /whitespace-nowrap/.test(head), 'the row can wrap');
  assert.ok(!/flex-wrap /.test(head), 'flex-wrap is back');
  assert.ok(/title=\{`Re-sequence on Google driving distances\. Costs about /.test(card));
  assert.ok(/title=\{truckMatrixOff \? 'The truck routing service is not set up on this site yet\.' : 'Re-sequence on our own truck routing service: truck-legal roads, no traffic, no cost\.'\}/.test(card));
});

test('the applied note sits outside both labels, on its own line under the row, with the same words and conditions', () => {
  const rowStart = card.indexOf('data-card-road-boxes');
  const rowEnd = card.indexOf('</div>', rowStart);
  const rowHtml = card.slice(rowStart, rowEnd);
  assert.ok(!/roads applied/.test(rowHtml), 'an applied note is still inside the row');
  const applied = card.slice(card.indexOf('{route.roadSequenced && ('), card.indexOf('data-card-road-applied') + 400);
  assert.ok(card.indexOf('data-card-road-applied') > rowEnd, 'the note is not below the row');
  assert.ok(/\{!route\.truckSequenced && <span className="font-semibold text-green-700">· roads applied<\/span>\}/.test(applied));
  assert.ok(/\{route\.truckSequenced && <span className="font-semibold text-green-700">· truck roads applied<\/span>\}/.test(applied));
});

test('the Google box on the card keeps its checkbox exactly, and the truck box its disabled state', () => {
  assert.ok(/<input type="checkbox" className="mt-0\.5" checked=\{roadMatrixOn\} onChange=\{\(e\) => onToggleRoadMatrix\(e\.target\.checked\)\} \/>/.test(card));
  assert.ok(/checked=\{truckMatrixOn\} disabled=\{truckMatrixOff\} onChange=\{\(e\) => onToggleTruckMatrix\(e\.target\.checked\)\}/.test(card));
});

test('each card box unticks the other, both default unticked, and both screens pass the same wiring', () => {
  assert.ok(/const toggleRoadMatrix = useCallback\(\(on\) => \{ setRoadMatrixOn\(on\); if \(on\) setTruckMatrixOn\(false\); \}, \[\]\);/.test(code));
  assert.ok(/const toggleTruckMatrix = useCallback\(\(on\) => \{ setTruckMatrixOn\(on\); if \(on\) setRoadMatrixOn\(false\); \}, \[\]\);/.test(code));
  assert.ok(/const \[truckMatrixOn, setTruckMatrixOn\] = useState\(\(\) => safeReadJSON\(LS_ROUTE_TRUCK_MATRIX, false\) === true && safeReadJSON\(LS_ROUTE_ROAD_MATRIX, false\) !== true\);/.test(code), 'both remembered boxes can come back ticked');
  const sites = code.match(/roadMatrixOn=\{roadMatrixOn\} onToggleRoadMatrix=\{toggleRoadMatrix\} truckMatrixOn=\{truckMatrixOn\} onToggleTruckMatrix=\{toggleTruckMatrix\} truckMatrixOff=\{truckRoadStatus\.state === 'off'\}/g) || [];
  assert.equal(sites.length, 2, 'the phone and the desktop workbench must both carry it');
  assert.ok(!/onToggleRoadMatrix=\{setRoadMatrixOn\}/.test(code), 'a site still ticks Google without unticking truck roads');
});

test('the re-sequence asks the server for cardMatrixMode, trusts only the source it asked for, and stays silent when neither box is ticked', () => {
  const rs = between('const wbResequence = useCallback(', '  const wbMoveStop = useCallback(');
  assert.ok(/const matrixMode = cardMatrixMode\(\{ roadMatrixOn, truckMatrixOn \}\);\n\s+if \(!matrixMode \|\| strategy === 'reverse'\) return;/.test(rs));
  assert.ok(/mode: matrixMode \}\)/.test(rs), 'the request does not send the mode');
  assert.ok(/if \(j\?\.source !== matrixMode \|\|/.test(rs), 'a fallback would be applied as roads');
  assert.ok(/applyOrder\(roadOrder, words\.suffix\);/.test(rs));
  assert.ok(/\}, \[wbRoutes, stopById, stops, roadMatrixOn, truckMatrixOn, notes,/.test(rs), 'missing dependency');
});

test('a card order from Google or the straight line carries no truckSequenced key at all', () => {
  const rs = between('const applyOrder = (ids, suffix) =>', '    }));');
  assert.ok(/const \{ truckSequenced: _wasTruck, \.\.\.rest \} = x;/.test(rs));
  assert.ok(/\.\.\.\(suffix === 'truck' \? \{ truckSequenced: true \} : \{\}\)/.test(rs));
});

test('a cold truck-road service on the card gives up inside the function\'s 10 s limit, so the straight-line fallback answers instead of an HTML 502', async (t) => {
  const m = await import('../netlify/functions/google-route-matrix.mts');
  assert.ok(m.ROAD_BOX_OSRM_TIMEOUT_MS < 10000 - 1500, 'no room left for the fallback under Netlify\'s 10 s default');
  process.env.OSRM_TRUCK_URL = 'https://osrm-truck-abc-ue.a.run.app';
  const orig = globalThis.fetch;
  const hang = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
  globalThis.fetch = async (u, init = {}) => {
    if (String(u).startsWith('https://oauth2.googleapis.com/')) return new Response(JSON.stringify({ id_token: 'a.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.s' }), { status: 200 });
    return hang(u, init);
  };
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIREBASE_SA = JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const err = console.error; const lines = []; console.error = (...a) => { const l = a.join(' '); if (!/ExperimentalWarning/.test(l)) lines.push(l); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = m.default(new Request('https://x/', { method: 'POST', body: JSON.stringify({ depot: { lat: 34.14838, lng: -83.95948 }, stops: [{ lat: 34.15, lng: -83.97 }, { lat: 34.14, lng: -83.95 }], mode: 'osrm' }) }));
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(m.ROAD_BOX_OSRM_TIMEOUT_MS);
    const j = await (await p).json();
    assert.equal(j.source, 'haversine');
    assert.match(lines.join('\n'), new RegExp(`did not answer within ${m.ROAD_BOX_OSRM_TIMEOUT_MS} ms`));
  } finally { t.mock.timers.reset(); globalThis.fetch = orig; console.error = err; delete process.env.OSRM_TRUCK_URL; }
});
