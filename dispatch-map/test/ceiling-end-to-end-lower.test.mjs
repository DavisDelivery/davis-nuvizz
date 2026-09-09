// test/ceiling-end-to-end-lower.test.mjs
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
// Own file on purpose, and this is the reason rather than tidiness: getNuvizzRequester() is a
// warm-instance singleton whose breaker state is memoised for 5s, so a sibling test that
// tripped it pins this one OPEN before it begins. node --test gives each file a fresh process.
// (Found by writing both cases in one file and watching the second fail on the first one's
// leftover state — the harness lying, not the product.)
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

test('END TO END: a saved 800 ends the calls at 800 — the setting turns both ways', async () => {
  // The same wiring, below the 2,000 default rather than above the old cap, because a switch
  // that only opens is half a switch — and a dispatcher pulling spend back mid-day is the
  // case that actually matters on a bad morning.
  const h = installWithLiveCounter({}, async () => new Response('{}', { status: 200 }));
  try {
    const scanConfig = (await import('../netlify/functions/nuvizz-scan-config.mts')).default;
    const nvreq = await import('../netlify/functions/lib/nuvizz-request.mts');
    nvreq.__resetDailyCeilingCache();

    await scanConfig(new Request('https://x.netlify.app/.netlify/functions/nuvizz-scan-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailyCeiling: 800 }),
    }));
    assert.equal(h.store.get('nuvizz_ops/scan_config')?.dailyCeiling, 800);
    assert.equal(await nvreq.resolveDailyCeiling(), 800, 'not floored to the old 100 minimum or the 2,000 default');

    const r = nvreq.getNuvizzRequester();
    h.seedCounter(798);
    await r.request(VENDOR, {}, { route: '/load/info', tenant: 'DAVIS' });   // 799
    assert.equal(h.store.get('nuvizz_ops/circuit'), undefined, 'still running under his number');
    await r.request(VENDOR, {}, { route: '/load/info', tenant: 'DAVIS' });   // 800
    assert.match(String(h.store.get('nuvizz_ops/circuit')?.reason), /800/, 'and ends at it');
  } finally { h.restore?.(); }
});
