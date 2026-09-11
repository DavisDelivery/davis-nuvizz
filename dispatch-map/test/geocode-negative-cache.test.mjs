// test/geocode-negative-cache.test.mjs — only a real ANSWER from Google is cached forever.
// ZERO_RESULTS is an answer (negative marker, never retried). A throttle, a denied key, an
// HTTP 5xx or a network failure is NOT an answer about the address, and caching it as one
// pinned every new address on the board with no coordinates permanently after one bad scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

process.env.GOOGLE_GEOCODE_API_KEY = 'test-key';   // read at module load
const { resolveCoords, addrKey, legacyAddrKey, classifyGeocodeResponse } = await import('../netlify/functions/lib/geocode.mts');

test('classifyGeocodeResponse: found / none / error', () => {
  assert.deepEqual(classifyGeocodeResponse(true, 200, { status: 'OK', results: [{ geometry: { location: { lat: 34.1, lng: -83.7 } } }] }), { status: 'found', pt: { lat: 34.1, lng: -83.7 } });
  assert.deepEqual(classifyGeocodeResponse(true, 200, { status: 'ZERO_RESULTS', results: [] }), { status: 'none' });
  for (const s of ['OVER_QUERY_LIMIT', 'REQUEST_DENIED', 'UNKNOWN_ERROR', 'INVALID_REQUEST']) {
    assert.deepEqual(classifyGeocodeResponse(true, 200, { status: s, results: [] }), { status: 'error', reason: s });
  }
  assert.deepEqual(classifyGeocodeResponse(false, 503, null), { status: 'error', reason: 'http_503' });
  assert.deepEqual(classifyGeocodeResponse(true, 200, null), { status: 'error', reason: 'no_result' });
});

const addr = (n) => ({ addr1: `${n} Test St`, city: 'Braselton', state: 'GA', zip: '30517' });
const cachePath = (a) => `nuvizz_geocode/${addrKey(a)}`;

async function run(googleResponder, items) {
  const fake = installFirestoreFake({}, async (url) => {
    assert.ok(url.startsWith('https://maps.googleapis.com/maps/api/geocode/json'), url);
    return googleResponder(url);
  });
  const realWarn = console.warn; console.warn = () => {};
  try { const out = await resolveCoords(items); return { out, fake }; }
  finally { console.warn = realWarn; fake.restore(); }
}

test('OVER_QUERY_LIMIT / REQUEST_DENIED / UNKNOWN_ERROR / HTTP 500 / network failure: NOTHING is written to the cache', async () => {
  const cases = [
    () => new Response(JSON.stringify({ status: 'OVER_QUERY_LIMIT', results: [] }), { status: 200 }),
    () => new Response(JSON.stringify({ status: 'REQUEST_DENIED', results: [] }), { status: 200 }),
    () => new Response(JSON.stringify({ status: 'UNKNOWN_ERROR', results: [] }), { status: 200 }),
    () => new Response('<html>500</html>', { status: 500 }),
    () => { throw new Error('ECONNRESET'); },
  ];
  for (const responder of cases) {
    const a = addr(1);
    const { out, fake } = await run(responder, [a]);
    assert.equal(out.size, 0);
    assert.deepEqual(fake.log.sets, [], 'no negative marker — the next scan retries');
    // TWO reads, not one, and deliberately: the new normalised key, then the legacy
    // exact-string key. A miss under the new key is not a miss — every address geocoded
    // before addrKey started normalising is filed under the old hash, and reading it costs
    // one Firestore get to avoid one Google geocode. It only happens on a miss; a warm
    // cache still answers in one.
    assert.equal(fake.log.gets.length, 2, 'new key, then the legacy key, before spending Google');
  }
});

test('ZERO_RESULTS is an answer: negative-cached so the address is never retried', async () => {
  const a = addr(2);
  const { out, fake } = await run(() => new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }), { status: 200 }), [a]);
  assert.equal(out.size, 0);
  assert.equal(fake.log.sets.length, 1);
  assert.equal(fake.log.sets[0].path, cachePath(a));
  assert.equal(fake.log.sets[0].doc.failed, true);
});

test('OK is cached with coordinates and returned', async () => {
  const a = addr(3);
  const { out, fake } = await run(() => new Response(JSON.stringify({ status: 'OK', results: [{ geometry: { location: { lat: 34.1, lng: -83.7 } } }] }), { status: 200 }), [a]);
  assert.deepEqual(out.get(addrKey(a)), { lat: 34.1, lng: -83.7 });
  assert.equal(fake.log.sets[0].path, cachePath(a));
  assert.equal(fake.log.sets[0].doc.lat, 34.1);
});

test('a cached negative marker is honoured — Google is not called again', async () => {
  const a = addr(4);
  let googleCalls = 0;
  const fake = installFirestoreFake({ [cachePath(a)]: { failed: true, addr: 'x' } }, async () => { googleCalls++; throw new Error('should not be called'); });
  try {
    const out = await resolveCoords([a]);
    assert.equal(out.size, 0); assert.equal(googleCalls, 0);
  } finally { fake.restore(); }
});

// ── THE KEY CHANGE MUST NOT RE-BUY ANSWERS WE ALREADY OWN ────────────────────

test('an address cached under the LEGACY key is carried forward, not re-geocoded', async () => {
  // addrKey now normalises (one dock, one geocode). Every entry written before that is
  // filed under the exact-string hash. Without the fallback this change would re-geocode
  // the entire book of addresses at Google's price for answers already in Firestore.
  const a = addr(7);
  const legacy = `nuvizz_geocode/${legacyAddrKey(a)}`;
  let googleCalls = 0;
  const fake = installFirestoreFake({ [legacy]: { lat: 34.5, lng: -83.9, addr: 'x' } },
    async () => { googleCalls++; throw new Error('should not be called'); });
  try {
    const out = await resolveCoords([a]);
    assert.equal(googleCalls, 0, 'the legacy answer was reused — no Google call');
    assert.deepEqual(out.get(addrKey(a)), { lat: 34.5, lng: -83.9 });
    // and it is copied forward, so the next scan answers on the first read
    const written = fake.log.sets.find((w) => w.path === `nuvizz_geocode/${addrKey(a)}`);
    assert.ok(written, 'carried forward under the new key');
    assert.equal(written.doc.lat, 34.5);
    assert.equal(written.doc.migratedFrom, legacyAddrKey(a), 'says where it came from');
  } finally { fake.restore(); }
});

test('a legacy NEGATIVE marker is carried forward too — an un-geocodable address stays un-retried', async () => {
  // Otherwise the key change would resurrect every address Google has already refused and
  // retry it on every scan, forever.
  const a = addr(8);
  let googleCalls = 0;
  const fake = installFirestoreFake({ [`nuvizz_geocode/${legacyAddrKey(a)}`]: { failed: true, addr: 'x' } },
    async () => { googleCalls++; throw new Error('should not be called'); });
  try {
    const out = await resolveCoords([a]);
    assert.equal(googleCalls, 0, 'still not retried');
    assert.equal(out.size, 0);
  } finally { fake.restore(); }
});

test('one dock, one cache entry: two spellings of the same address geocode ONCE', async () => {
  // The bug Chad reported, at its source. "5640 LOGISTICS DRIVE" and "5640 LOGISTICS DR"
  // are one building; keyed by the raw string they were two, geocoded twice, and pinned in
  // two places on the board while NuVizz showed them together.
  const spelled = { addr1: '5640 LOGISTICS DRIVE', city: 'ALPHARETTA', state: 'GA', zip: '30004' };
  const abbrev  = { addr1: '5640 Logistics Dr',    city: 'Alpharetta', state: 'GA', zip: '30004-1234' };
  assert.equal(addrKey(spelled), addrKey(abbrev), 'one dock, one key');
  let googleCalls = 0;
  const fake = installFirestoreFake({}, async () => {
    googleCalls++;
    return new Response(JSON.stringify({ status: 'OK', results: [{ geometry: { location: { lat: 34.07, lng: -84.29 } } }] }), { status: 200 });
  });
  try {
    const out = await resolveCoords([spelled, abbrev]);
    assert.equal(googleCalls, 1, 'geocoded once, not twice');
    assert.deepEqual(out.get(addrKey(spelled)), { lat: 34.07, lng: -84.29 });
    assert.deepEqual(out.get(addrKey(abbrev)),  { lat: 34.07, lng: -84.29 }, 'both orders get the SAME pin');
  } finally { fake.restore(); }
});
