// A FIRESTORE HICCUP ON THE STACKER CLAIM MUST NOT ERASE THE RECORD OF AN URGENT EMAIL.
//
// The day sweep emails customer service about a stop that will miss its window, THEN runs the
// stacker alert, THEN writes flag history from what the send reported. The stacker claim
// (createDocIfAbsent) throws on any Firestore failure that is not "already exists", and it used
// to be awaited with nothing around it — so one 503 on that single commit sent the whole sweep
// to its outer catch: HTTP 500, flag history never written, and the stop's "Emailed CS" mark
// lost for good (the next sweep finds the urgent claim already taken and, correctly, does not
// re-claim credit for it).
//
// Run for real: the day handler over the in-memory Firestore fake, Resend intercepted, the
// failure injected on exactly one commit. No network — the fake throws on anything else.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { normalizeMatchKey } from '../src/lib/matchKey.js';
import { flagHistoryPath } from '../netlify/functions/lib/flag-history.mts';
import { runStackerAlert, stackerClaimPath } from '../netlify/functions/lib/stacker-alert.mts';

const DATE = '2026-09-01';                        // a Tuesday
const NOW = '2026-09-01T11:05:00Z';               // 7:05a EDT — the day sweep's first hour
const boardPath = `nuvizz_stop_index/davis__${DATE}`;
const STACKER_TEXT = 'ORDER CONTAINS HYDRAULIC STACKER';

// Ten stops on one route, spaced so stop 9 projects well over three hours past an 8:45a typed
// close — a CRITICAL row, which is what the urgent customer-service email is for.
const routeStop = (i) => ({
  stopNbr: `S${i}`, businessName: `CUST ${i}`, addr1: `${i} MAIN ST`, city: 'BUFORD', zip: '30518',
  loadNbr: 'TESTLOAD', routeName: 'TESTLOAD', routeSeq: i, stopType: 'DL',
  lat: 34.147791 + i * 0.08, lng: -83.960911,
  normalizedStatus: 'PLANNED', status: '10', driverName: 'TEST DRIVER', driverUserName: 'tdriver',
});
const stackerStop = {
  stopNbr: '007180089', primaryPro: '007180089', businessName: 'WEST RIDGE CHURCH', addr1: '1 RIDGE RD',
  city: 'DALLAS', zip: '30132', lat: 33.92, lng: -84.84, normalizedStatus: 'SCHEDULED', status: '20',
  isPlanned: false, stopType: 'DO', orderInstructions: STACKER_TEXT,
};
const keyOf = (s) => normalizeMatchKey(s.businessName, s.addr1, s.city, s.zip);

function seed() {
  const out = { [boardPath]: { last_scanned_at: '2026-09-01T11:00:00Z' } };
  for (let i = 1; i <= 10; i += 1) out[`${boardPath}/stops/S${i}`] = routeStop(i);
  out[`${boardPath}/stops/${stackerStop.stopNbr}`] = stackerStop;
  out[`customer_notes/${keyOf(routeStop(9))}`] = {
    receiving_hours: { tue: { open: '07:00', close: '08:45' } },
    manual_overrides: { receiving_hours: true },
  };
  return out;
}

async function runSweep(failStackerClaim) {
  const mail = [];
  const fake = installFirestoreFake(seed(), async (url, init) => {
    if (url.startsWith('https://api.resend.com/')) {
      mail.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: `m${mail.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  const fakeFetch = globalThis.fetch;
  // A transient Firestore failure on the stacker claim, and on nothing else.
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (failStackerClaim && url.includes('/documents:commit') && String(init.body || '').includes('stacker_alert/')) {
      return new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), { status: 503 });
    }
    return fakeFetch(input, init);
  };
  return { fake, mail, restore: () => { globalThis.fetch = fakeFetch; fake.restore(); } };
}

test('a Firestore 503 on the stacker claim still leaves "Emailed CS" on the stop customer service was told about', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM = 'Dispatch <no-reply@example.com>';
  mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const run = await runSweep(true);
  try {
    const { default: handler } = await import('../netlify/functions/eta-flag-alert-background.mts');
    const res = await handler(new Request('https://example.test/.netlify/functions/eta-flag-alert-background'));
    const body = await res.json();

    // THE FIXTURE IS THE CASE: customer service really was emailed about S9 this sweep.
    const urgent = run.mail.filter((m) => /Receiving window at risk/i.test(String(m.subject)));
    assert.equal(urgent.length, 1, `the urgent email went out: ${JSON.stringify(run.mail.map((m) => m.subject))}`);
    assert.match(String(urgent[0].subject), /CUST 9/);

    // The sweep finishes and says so.
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.sent, 1);

    // THE RECORD: flag history was written, and it says CS was emailed about S9.
    const hist = run.fake.store.get(flagHistoryPath('davis', DATE));
    assert.ok(hist, 'flag history was written despite the stacker claim failing');
    const s9 = Object.values(hist.rows || {}).find((r) => String(r?.stopNbr) === 'S9');
    assert.ok(s9, 'S9 is in the history');
    assert.equal(s9.emailed, true, 'Emailed CS is recorded for the stop customer service was told about');

    // The stacker failure is reported, not swallowed, and nothing was mailed about it this sweep.
    assert.equal(body.stacker.found, 1);
    assert.equal(body.stacker.claimFailed, 1, JSON.stringify(body.stacker));
    assert.equal(body.stacker.sent, 0);
    assert.ok(!run.fake.store.has(stackerClaimPath('davis', DATE, stackerStop.stopNbr)), 'no claim landed');
    assert.ok(!run.mail.some((m) => /tractor trailer/i.test(String(m.subject))), 'no stacker email this sweep');
  } finally {
    run.restore();
    mock.timers.reset();
  }
});

test('the stacker order whose claim failed is claimed and emailed on the next sweep', async () => {
  // Same claim-then-send ratchet, pure: a claim that throws for one order is counted, the
  // other orders on the board still go out, and the failed one is simply tried again later.
  const claims = new Set();
  const sent = [];
  let failNext = '007180089';
  const io = {
    createDocIfAbsent: async (p) => {
      if (failNext && p.endsWith(failNext)) { failNext = null; throw new Error(`createDocIfAbsent ${p} failed: 503`); }
      return claims.has(p) ? false : (claims.add(p), true);
    },
    send: async (a) => { sent.push(a); return { ok: true }; },
    to: 'cs@example.com',
  };
  const other = { ...stackerStop, stopNbr: '007180214', primaryPro: '007180214', businessName: 'ATLANTA VA CLINIC' };
  const first = await runStackerAlert([stackerStop, other], DATE, 'davis', io);
  assert.equal(first.found, 2);
  assert.equal(first.claimFailed, 1, 'the failed claim is counted');
  assert.equal(first.claimed, 1, 'the other order still claims');
  assert.deepEqual(first.orders, ['007180214'], 'and is emailed this sweep');
  assert.equal(sent.length, 1);

  const second = await runStackerAlert([stackerStop, other], DATE, 'davis', io);
  assert.equal(second.claimFailed, 0);
  assert.deepEqual(second.orders, ['007180089'], 'the one that failed goes out next sweep');
  assert.equal(sent.length, 2);
});
