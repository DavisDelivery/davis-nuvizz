// test/ceiling-end-to-end.test.mjs
//
// THE WHOLE CHAIN, DRIVEN FOR REAL: Diagnostics save → Firestore → the code that spends.
//
// Chad: "Wire up correctly test your work." The unit tests around this feature all inject a
// stub where the stored setting should be, which proves the arithmetic and proves nothing
// about the wiring — and the wiring is exactly what was broken twice. v0.70.2 had a gauge
// reading one number while the breaker enforced another; v0.98.4 had a Diagnostics field
// saving 3,000 into a document no non-scanner process ever read. Both would have passed
// every stub-fed test in the suite.
//
// So this drives the REAL POST handler, through the REAL firestore.mts helpers, into the
// REAL production requester singleton, and asserts the breaker trips on the number that was
// typed. The only thing stubbed is the vendor socket itself.
//
// ZERO NuVizz calls: the fake THROWS on any fetch it does not recognise, so a call escaping
// to a real host fails the test rather than silently costing money.
//
// Own file on purpose: getNuvizzRequester() is a warm-instance singleton with a 5s breaker
// memo and a module-level resolved ceiling. node --test gives each file a fresh process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
delete process.env.NUVIZZ_DAILY_CEILING;   // no ambient proposal — the saved value is the only input
delete process.env.AUTH_REQUIRED;          // the admin gate ships inert

const VENDOR = 'https://vendor.invalid/load/info/1/DAVIS';

// The shared fake answers documents:commit with empty writeResults, so incrementCallCounter
// reads back NaN and the breaker can never trip. Production returns the new total in
// transformResults[0], and the trip is `total >= ceiling` — so without this the one thing
// this file exists to prove would be untestable. Layered here rather than changed in the
// shared fake, which other suites depend on.
function installWithLiveCounter(seed, onVendor) {
  const h = installFirestoreFake(seed, onVendor);
  const inner = globalThis.fetch;
  let counter = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (url.includes('firestore.googleapis.com') && url.includes('/documents:commit')) {
      counter += 1;
      return new Response(JSON.stringify({ writeResults: [{ transformResults: [{ integerValue: String(counter) }] }] }), { status: 200 });
    }
    return inner(input, init);
  };
  return { ...h, seedCounter: (n) => { counter = n; }, counted: () => counter };
}

test('END TO END: a saved 5,000 is stored, resolved, reported and ENFORCED at 5,000', async () => {
  let vendorCalls = 0;
  const h = installWithLiveCounter({}, async () => { vendorCalls++; return new Response('{}', { status: 200 }); });
  try {
    const scanConfig = (await import('../netlify/functions/nuvizz-scan-config.mts')).default;
    const nvreq = await import('../netlify/functions/lib/nuvizz-request.mts');
    nvreq.__resetDailyCeilingCache();

    // ── 1. THE SAVE. The real endpoint, the payload the Diagnostics field sends. 5,000 is
    // above the old hard cap on purpose: before this change it was stored as 3,000.
    const saved = await scanConfig(new Request('https://x.netlify.app/.netlify/functions/nuvizz-scan-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailyCeiling: 5000, updatedBy: 'end-to-end-test' }),
    }));
    const savedBody = await saved.json();
    assert.equal(saved.status, 200);
    assert.equal(savedBody.ok, true);

    // ── 2. WHAT LANDED IN FIRESTORE. Read the document itself, not the endpoint's echo — an
    // endpoint that reports what it MEANT to write is the failure mode this repo calls
    // "never report an intent as an outcome".
    assert.equal(h.store.get('nuvizz_ops/scan_config')?.dailyCeiling, 5000, 'his number reached the document');

    // ── 3. WHAT THE SCREEN WILL SAY. The same endpoint's read path, which is what the
    // Diagnostics gauge and the Map status card are built from.
    assert.equal(savedBody.config.dailyCeiling, 5000, 'the editor reads back what it saved');
    const got = await scanConfig(new Request('https://x.netlify.app/.netlify/functions/nuvizz-scan-config'));
    const gotBody = await got.json();
    assert.equal(gotBody.config.dailyCeiling, 5000, 'and a fresh load of the page agrees');
    assert.equal(gotBody.bounds.dailyCeiling[1], 1_000_000, 'the editor no longer caps him at 3,000');

    // ── 4. WHAT THE SPENDING CODE RESOLVES, through the real readScanConfig → getDoc path in
    // a process that never called the setter. This is precisely where v0.98.4 broke.
    assert.equal(await nvreq.resolveDailyCeiling(), 5000, 'a non-scanner process resolves his number');
    assert.equal(nvreq.effectiveDailyCeiling(), 5000);
    assert.equal(nvreq.reportedDailyCeiling(5000, {}), 5000, 'gauge and breaker agree');

    // ── 5. THE BREAKER, on the real production singleton. Park the shared counter just under
    // the number he typed and walk it over the line.
    const r = nvreq.getNuvizzRequester();
    h.seedCounter(4997);
    await r.request(VENDOR, {}, { route: '/load/info', tenant: 'DAVIS' });   // 4,998
    assert.equal(h.store.get('nuvizz_ops/circuit'), undefined, 'nothing tripped at 2,000');
    await r.request(VENDOR, {}, { route: '/load/info', tenant: 'DAVIS' });   // 4,999
    assert.equal(h.store.get('nuvizz_ops/circuit'), undefined, 'nor at 3,000, the old hard cap');
    assert.equal(r.getStats().ceiling, 5000, 'it reports the number it is enforcing');

    await r.request(VENDOR, {}, { route: '/load/info', tenant: 'DAVIS' });   // 5,000 — the line
    const circuit = h.store.get('nuvizz_ops/circuit');
    assert.ok(circuit?.open, 'the breaker tripped');
    assert.match(String(circuit.reason), /5000/, `it tripped on HIS number: ${circuit?.reason}`);
    assert.match(String(circuit.reason), /count=5000/);

    // ── 6. AND THE CALLS ACTUALLY END. The next one is refused before the socket opens.
    const before = vendorCalls;
    await assert.rejects(
      () => r.request(VENDOR, {}, { route: '/load/info', tenant: 'DAVIS' }),
      /circuit breaker open/i,
      'the 5,001st call is refused',
    );
    assert.equal(vendorCalls, before, 'and it never reached the vendor');
  } finally { h.restore?.(); }
});
