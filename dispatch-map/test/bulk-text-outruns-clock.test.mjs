// test/bulk-text-outruns-clock.test.mjs — A BULK TEXT THAT CANNOT FINISH IN TIME SAYS WHO WAS
// TEXTED AND WHO WAS NOT, INSTEAD OF DYING MID-LIST.
//
// A5-S29-11. "Text N drivers" sends one SimpleTexting call plus one Firestore write per driver,
// one after another, and send-sms ran on Netlify's 10s default. A long list was killed partway:
// the dispatcher got an HTML 502 ("Unexpected token '<'") with no way to tell which drivers had
// the text — so a resend doubles up on the first half — and the daily-cap counter, written once
// after the loop, never counted the texts that DID go out.
//
// Now: send-sms gets the 26s ceiling the other long functions take, and the handler stops
// STARTING sends at a 20s budget, reports every recipient it did not reach by name, and still
// writes the cap for what it sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFirestoreFake } from './_firestore-fake.mjs';
import sendSmsHandler, { SEND_BUDGET_MS } from '../netlify/functions/send-sms.mts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('send-sms runs with the 26s ceiling, not the 10s default', () => {
  const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  assert.match(toml, /\[functions\."send-sms"\]\s*\n\s*timeout = 26/);
});

test('the send budget leaves headroom under 26s for the last send, its thread write and the cap write', () => {
  assert.ok(Number.isFinite(SEND_BUDGET_MS) && SEND_BUDGET_MS > 0 && SEND_BUDGET_MS <= 22_000, String(SEND_BUDGET_MS));
});

test('a bulk text to 12 drivers at 3s a send stops cleanly at the budget, names the 5 not texted, and charges the cap for the 7 sent', async () => {
  process.env.SIMPLETEXTING_API_KEY = 'test-key';
  delete process.env.SMS_DAILY_CAP;
  const realNow = Date.now;
  let clock = realNow.call(Date);
  Date.now = () => clock;
  const vendorCalls = [];
  const fake = installFirestoreFake({}, (url, init) => {
    vendorCalls.push(JSON.parse(String(init?.body || '{}')).contactPhone);
    clock += 3000; // every SimpleTexting send takes three seconds on a bad day
    return new Response(JSON.stringify({ id: `st-${vendorCalls.length}` }), { status: 200 });
  });
  try {
    const recipients = Array.from({ length: 12 }, (_, i) => ({ to: `40455501${String(i).padStart(2, '0')}`, label: `Driver ${i + 1}` }));
    const req = new Request('https://x.netlify.app/.netlify/functions/send-sms', {
      method: 'POST', body: JSON.stringify({ text: 'yard closes at 6', recipients }),
    });
    const res = await sendSmsHandler(req);
    assert.equal(res.status, 200, 'a clean JSON answer, not a platform kill');
    const j = await res.json();
    assert.equal(j.sent, 7);
    assert.equal(vendorCalls.length, 7, 'no send was started past the budget');
    assert.equal(j.ok, false);
    const notSent = j.results.filter((r) => !r.ok);
    assert.deepEqual(notSent.map((r) => r.label), ['Driver 8', 'Driver 9', 'Driver 10', 'Driver 11', 'Driver 12']);
    for (const r of notSent) assert.match(r.error, /not sent/i);
    assert.equal(j.failed, 5, 'the unsent drivers show in the failed count the modal prints');
    const capDoc = [...fake.store.entries()].find(([k]) => k.startsWith('nuvizz_ops/sms__'));
    assert.equal(capDoc?.[1]?.count, 7, 'the daily cap counts every text that went out');
  } finally {
    Date.now = realNow;
    fake.restore();
    delete process.env.SIMPLETEXTING_API_KEY;
  }
});

test('a short bulk text inside the budget sends to everyone (unchanged)', async () => {
  process.env.SIMPLETEXTING_API_KEY = 'test-key';
  const vendorCalls = [];
  const fake = installFirestoreFake({}, (url, init) => {
    vendorCalls.push(1);
    return new Response(JSON.stringify({ id: `st-${vendorCalls.length}` }), { status: 200 });
  });
  try {
    const recipients = Array.from({ length: 4 }, (_, i) => ({ to: `40455502${String(i).padStart(2, '0')}`, label: `Driver ${i + 1}` }));
    const req = new Request('https://x.netlify.app/.netlify/functions/send-sms', {
      method: 'POST', body: JSON.stringify({ text: 'yard closes at 6', recipients }),
    });
    const j = await (await sendSmsHandler(req)).json();
    assert.equal(j.sent, 4);
    assert.equal(j.failed, 0);
    assert.equal(j.ok, true);
  } finally { fake.restore(); delete process.env.SIMPLETEXTING_API_KEY; }
});
