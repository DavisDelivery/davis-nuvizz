// test/sms-thread-write-refused.test.mjs — A TEXT THAT NEVER REACHED THE MESSAGES THREAD IS NOT
// REPORTED AS STORED.
//
// X-errors-4. recordSmsMessage swallowed a refused Firestore write and returned nothing, so:
//   • the SimpleTexting webhook counted a driver's inbound reply as `stored` when it was not —
//     the one log line that could have said "a driver's text is missing" said the opposite;
//   • send-sms could not tell the dispatcher that the text went out but will not show in the
//     conversation thread.
// Whether the webhook should also answer SimpleTexting with a non-2xx so the vendor RETRIES is a
// separate call (it reverses the handler's "always 200 so SimpleTexting doesn't retry-storm us"
// and depends on how SimpleTexting treats repeated failures) — it is left at 200 here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { recordSmsMessage } from '../netlify/functions/lib/sms-store.mts';
import webhook from '../netlify/functions/simpletexting-webhook.mts';
import sendSmsHandler from '../netlify/functions/send-sms.mts';

// Firestore refuses every write under sms_messages/ (a 503 from the backend); everything else is
// the ordinary in-memory fake. The SimpleTexting send is a stub that never leaves the process.
function install({ refuseSmsWrites }) {
  const vendorCalls = [];
  const fake = installFirestoreFake({}, (url, init) => {
    vendorCalls.push({ url, body: String(init?.body || '') });
    return new Response(JSON.stringify({ id: `st-${vendorCalls.length}` }), { status: 200 });
  });
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (refuseSmsWrites && (init.method || 'GET').toUpperCase() === 'PATCH' && url.includes('/documents/sms_messages/')) {
      return new Response('{"error":{"status":"UNAVAILABLE"}}', { status: 503 });
    }
    return inner(input, init);
  };
  return { fake, vendorCalls, restore: () => { globalThis.fetch = inner; fake.restore(); } };
}

test('recordSmsMessage says false when Firestore refuses the write, true when it lands', async () => {
  const bad = install({ refuseSmsWrites: true });
  try {
    assert.equal(await recordSmsMessage({ direction: 'in', contactPhone: '7705551212', text: 'running late', messageId: 'm-bad' }), false);
  } finally { bad.restore(); }
  const good = install({ refuseSmsWrites: false });
  try {
    assert.equal(await recordSmsMessage({ direction: 'in', contactPhone: '7705551212', text: 'running late', messageId: 'm-good' }), true);
    assert.equal(good.fake.store.get('sms_messages/m-good')?.text, 'running late');
  } finally { good.restore(); }
});

test('a driver\'s inbound reply that Firestore refused is NOT counted as stored by the webhook', async () => {
  delete process.env.SIMPLETEXTING_WEBHOOK_SECRET;
  const h = install({ refuseSmsWrites: true });
  const logs = [];
  const realLog = console.log, realWarn = console.warn;
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    const body = JSON.stringify({ type: 'INCOMING_MESSAGE', values: { messageId: 'in-1', text: 'dock closed, what now', contactPhone: '7705551212' } });
    const r = await webhook(new Request('https://x.netlify.app/.netlify/functions/simpletexting-webhook', { method: 'POST', body }));
    assert.equal(r.status, 200, 'still 200 — the retry question is Chad\'s');
    const j = await r.json();
    assert.equal(j.stored, 0, 'a refused write is not "stored"');
    assert.equal(j.failed, 1);
    assert.ok(logs.some((l) => /stored=0 failed=1/.test(l)), logs.join('\n'));
    assert.deepEqual(h.vendorCalls, [], 'the webhook made no vendor call');
  } finally { console.log = realLog; console.warn = realWarn; h.restore(); }
});

test('a driver\'s inbound reply that lands is counted as stored (unchanged)', async () => {
  delete process.env.SIMPLETEXTING_WEBHOOK_SECRET;
  const h = install({ refuseSmsWrites: false });
  const realLog = console.log, realWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    const body = JSON.stringify({ type: 'INCOMING_MESSAGE', values: { messageId: 'in-2', text: 'delivered', contactPhone: '7705551212' } });
    const r = await webhook(new Request('https://x.netlify.app/.netlify/functions/simpletexting-webhook', { method: 'POST', body }));
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.stored, 1);
    assert.equal(j.failed, 0);
    assert.equal(h.fake.store.get('sms_messages/in-2')?.direction, 'in');
  } finally { console.log = realLog; console.warn = realWarn; h.restore(); }
});

test('a dispatcher\'s text that went out but missed the thread comes back recorded:false', async () => {
  process.env.SIMPLETEXTING_API_KEY = 'test-key';
  const h = install({ refuseSmsWrites: true });
  const realWarn = console.warn; console.warn = () => {};
  try {
    const req = new Request('https://x.netlify.app/.netlify/functions/send-sms', {
      method: 'POST', body: JSON.stringify({ to: '7705551212', text: 'call dispatch' }),
    });
    const j = await (await sendSmsHandler(req)).json();
    assert.equal(j.sent, 1, 'the text itself went out');
    assert.equal(h.vendorCalls.length, 1);
    assert.equal(j.results[0].ok, true);
    assert.equal(j.results[0].recorded, false, 'the thread write failure is surfaced');
  } finally { console.warn = realWarn; h.restore(); delete process.env.SIMPLETEXTING_API_KEY; }
});

test('a dispatcher\'s text that went out AND landed in the thread comes back recorded:true', async () => {
  process.env.SIMPLETEXTING_API_KEY = 'test-key';
  const h = install({ refuseSmsWrites: false });
  try {
    const req = new Request('https://x.netlify.app/.netlify/functions/send-sms', {
      method: 'POST', body: JSON.stringify({ to: '7705551212', text: 'call dispatch' }),
    });
    const j = await (await sendSmsHandler(req)).json();
    assert.equal(j.sent, 1);
    assert.equal(j.results[0].recorded, true);
  } finally { h.restore(); delete process.env.SIMPLETEXTING_API_KEY; }
});
