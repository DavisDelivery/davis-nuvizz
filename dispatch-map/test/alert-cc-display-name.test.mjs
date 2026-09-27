// A NAMED ENTRY IN ALERT_CC ("Dispatch Desk <address>") IS ONE RECIPIENT EVERYWHERE.
//
// The resolver the sweeps use (alert-recipients resolveChannel) strips an RFC 5322 display
// name and mails the address. The older module-load parser in flag-alert (ALERT_CC /
// ALERT_CC_REJECTED) did not, and refused the entry. Two places still read the old one:
//   * the day sweep's fallback when the saved-list read fails — which silently dropped that
//     person from a miss-window email that sweep;
//   * eta-flag-check's ccRejected — which listed the same person as a recipient AND refused.
//
// Both now read the one resolver. Real handlers over the in-memory Firestore fake, Resend
// intercepted; no network. Role addresses on the company domain are DERIVED, never typed —
// see no-lifelike-addresses.test.mjs for why a typed one can stop a production deploy.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const SUFFIX = `@${['davisdelivery', 'com'].join('.')}`;
const DISPATCH = `dispatch${SUFFIX}`;
const OPS = `ops${SUFFIX}`;
// Set BEFORE flag-alert loads: its ALERT_CC / ALERT_CC_REJECTED are parsed at module load.
process.env.ALERT_CC = `Dispatch Desk <${DISPATCH}>; ${OPS}`;

const { installFirestoreFake } = await import('./_firestore-fake.mjs');
const { normalizeMatchKey } = await import('../src/lib/matchKey.js');
const { ALERT_TO } = await import('../netlify/functions/lib/flag-alert.mts');

const DATE = '2026-09-01';                        // a Tuesday
const NOW = '2026-09-01T11:05:00Z';               // 7:05a EDT
const boardPath = `nuvizz_stop_index/davis__${DATE}`;

// Stop 9 of ten projects over three hours past an 8:45a typed close: a critical row, which
// earns the urgent customer-service email.
const routeStop = (i) => ({
  stopNbr: `S${i}`, businessName: `CUST ${i}`, addr1: `${i} MAIN ST`, city: 'BUFORD', zip: '30518',
  loadNbr: 'TESTLOAD', routeName: 'TESTLOAD', routeSeq: i, stopType: 'DL',
  lat: 34.147791 + i * 0.08, lng: -83.960911,
  normalizedStatus: 'PLANNED', status: '10', driverName: 'TEST DRIVER', driverUserName: 'tdriver',
});
const keyOf = (s) => normalizeMatchKey(s.businessName, s.addr1, s.city, s.zip);
function seed() {
  const out = { [boardPath]: { last_scanned_at: '2026-09-01T11:00:00Z' } };
  for (let i = 1; i <= 10; i += 1) out[`${boardPath}/stops/S${i}`] = routeStop(i);
  out[`customer_notes/${keyOf(routeStop(9))}`] = {
    receiving_hours: { tue: { open: '07:00', close: '08:45' } },
    manual_overrides: { receiving_hours: true },
  };
  return out;
}
const EXPECTED = [ALERT_TO, DISPATCH, OPS];

test('when the saved-list read fails, the miss-window email still reaches a named ALERT_CC entry', async () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM = 'Dispatch <no-reply@example.com>';
  const mail = [];
  mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const fake = installFirestoreFake(seed(), async (url, init) => {
    if (url.startsWith('https://api.resend.com/')) {
      mail.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  const fakeFetch = globalThis.fetch;
  // The saved recipient list cannot be read this sweep.
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (url.includes('/documents/nuvizz_ops/alert_recipients')) return new Response('{"error":{"status":"UNAVAILABLE"}}', { status: 503 });
    return fakeFetch(input, init);
  };
  try {
    const { default: handler } = await import('../netlify/functions/eta-flag-alert-background.mts');
    const body = await (await handler(new Request('https://example.test/.netlify/functions/eta-flag-alert-background'))).json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.match(String(body.ccStore), /unavailable — fell back to ALERT_CC/, 'THE FIXTURE IS THE CASE: the fallback path ran');
    const urgent = mail.filter((m) => /Receiving window at risk/i.test(String(m.subject)));
    assert.equal(urgent.length, 1, 'the urgent email went out');
    assert.deepEqual(urgent[0].to, EXPECTED, 'the named entry is on it, by address');
    assert.deepEqual(body.ccRejected, [], 'and nobody is reported refused');
  } finally {
    globalThis.fetch = fakeFetch;
    fake.restore();
    mock.timers.reset();
  }
});

test('the eta-flag-check dry run never lists the same person as a recipient and as refused', async () => {
  const fake = installFirestoreFake(seed());
  try {
    const { default: handler } = await import('../netlify/functions/eta-flag-check.mts');
    const body = await (await handler(new Request(`https://example.test/.netlify/functions/eta-flag-check?date=${DATE}&now=425`))).json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.ccSource, 'env');
    assert.deepEqual(body.recipients, EXPECTED);
    assert.deepEqual(body.ccRejected, [], 'a named entry is a recipient, not a refusal');
  } finally {
    fake.restore();
  }
});

test('an ALERT_CC entry that really is refused is still named by the dry run', async () => {
  const before = process.env.ALERT_CC;
  process.env.ALERT_CC = `${OPS}, someone@example.com`;
  const fake = installFirestoreFake(seed());
  try {
    const { default: handler } = await import('../netlify/functions/eta-flag-check.mts');
    const body = await (await handler(new Request(`https://example.test/.netlify/functions/eta-flag-check?date=${DATE}&now=425`))).json();
    assert.deepEqual(body.recipients, [ALERT_TO, OPS]);
    assert.deepEqual(body.ccRejected, ['someone@example.com']);
  } finally {
    fake.restore();
    process.env.ALERT_CC = before;
  }
});
