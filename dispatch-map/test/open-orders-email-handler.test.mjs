// The 5:30p open-orders email, end to end over the in-memory Firestore: it waits for the 5:25
// scan, sends once to customer service, stamps the day only on a confirmed send, and makes
// ZERO NuVizz calls (the fake throws on any fetch that is not Firestore or Resend).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { openOrdersPath } from '../netlify/functions/lib/open-orders.mts';
import { COMPANY_CS_ADDRESS } from '../netlify/functions/lib/alert-recipients.mts';

const DATE = '2026-09-29';   // a Tuesday, EDT
const utc = (hhmm) => `2026-09-29T${hhmm}:00-04:00`;

function seed({ scannedAt }) {
  const s = { [`nuvizz_stop_index/davis__${DATE}`]: { tenant: 'davis', date: DATE } };
  const rows = [
    { stopNbr: '1001', pro: '1001', routeName: 'MARCUS', loadNbr: 'MARCUS', isPlanned: true, status: '90', businessName: 'DONE CO' },
    { stopNbr: '1002', pro: '1002', routeName: 'MARCUS', loadNbr: 'MARCUS', isPlanned: true, status: '20', businessName: 'OPEN CO', city: 'BUFORD' },
    { stopNbr: '1003', pro: '1003', routeName: 'ULINE APPT', loadNbr: 'ULINE APPT', isPlanned: true, status: '20', businessName: 'HELD CO' },
  ];
  for (const r of rows) s[`nuvizz_stop_index/davis__${DATE}/stops/${r.stopNbr}`] = r;
  if (scannedAt) s['nuvizz_ops/scan_kinds'] = { planned: new Date(scannedAt).toISOString(), completed: new Date(scannedAt).toISOString() };
  return s;
}

async function fire(hhmm, store, resend = () => new Response('{"id":"em_1"}', { status: 200 })) {
  const keep = { RESEND_API_KEY: process.env.RESEND_API_KEY, RESEND_FROM: process.env.RESEND_FROM, OPEN_ORDERS_TO: process.env.OPEN_ORDERS_TO };
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_FROM = 'Reports <no-reply@example.com>';
  delete process.env.OPEN_ORDERS_TO;
  const sent = [];
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  const fake = installFirestoreFake(store, async (url, init) => {
    if (url.startsWith('https://api.resend.com/')) { sent.push(JSON.parse(init.body)); return resend(); }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  mock.timers.enable({ apis: ['Date'], now: new Date(utc(hhmm)) });
  try {
    const handler = (await import('../netlify/functions/open-orders-email-background.mts')).default;
    const r = await handler();
    return { body: await r.json(), sent, errs, store: fake.store };
  } finally {
    mock.timers.reset();
    console.error = origErr;
    fake.restore();
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('5:30p after the 5:25 scan: one email to customer service with the one open planned order', async () => {
  const { body, sent, store } = await fire('17:30', seed({ scannedAt: utc('17:26') }));
  assert.equal(body.emailed, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, [COMPANY_CS_ADDRESS]);
  assert.match(sent[0].subject, /1 planned delivery not delivered yet/);
  assert.match(sent[0].text, /1002\s+OPEN CO/);
  assert.doesNotMatch(sent[0].text, /HELD CO|DONE CO/);
  assert.match(sent[0].text, /Board last scanned 5:26p ET/);
  assert.ok(store.get(openOrdersPath(DATE))?.sentAt, 'stamped only after the mailer confirmed');
});

test('a second firing the same evening does not send again', async () => {
  const store = seed({ scannedAt: utc('17:26') });
  const first = await fire('17:30', store);
  const second = await fire('17:35', Object.fromEntries(first.store));
  assert.equal(second.sent.length, 0);
  assert.equal(second.body.decision.reason, 'already sent today');
});

test('5:30p with no scan since 5:20: waits, sends nothing, reads no board', async () => {
  const { body, sent } = await fire('17:30', seed({ scannedAt: utc('17:05') }));
  assert.equal(body.decision.action, 'wait');
  assert.equal(sent.length, 0);
  assert.equal(body.report, undefined);
});

test('a refused send is recorded and NOT stamped as sent, so the next firing retries', async () => {
  const { body, store, errs } = await fire('17:30', seed({ scannedAt: utc('17:26') }), () => new Response('{"message":"nope"}', { status: 429 }));
  assert.equal(body.emailed, false);
  const rec = store.get(openOrdersPath(DATE));
  assert.equal(rec?.sentAt, undefined);
  assert.match(String(rec?.lastFailure), /429|nope/);
  assert.ok(errs.some((l) => l.includes('[open-orders]')));
  assert.ok(!errs.some((l) => l.includes(COMPANY_CS_ADDRESS)), 'the log never carries an address');
});

test('outside 5:30–6:00p ET it returns before touching Firestore', async () => {
  const { body, sent } = await fire('17:05', seed({ scannedAt: utc('17:00') }));
  assert.match(body.note, /outside/);
  assert.equal(sent.length, 0);
});
