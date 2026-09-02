// test/secure-compare.test.mjs — the three shared-secret gates compare in constant time and
// keep their documented "unset means open" behaviour (Chad's v0.54.79 call for the comms
// token; a deploy decision for the SMS webhook). The webhook also takes the secret from a
// header so it need not ride in the URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenMatches } from '../netlify/functions/lib/secure-compare.mts';
import { adminTokenOk } from '../netlify/functions/lib/customer-comms.mts';

delete process.env.FIREBASE_SA;
process.env.NUVIZZ_BASE_URL = '';
import webhook from '../netlify/functions/simpletexting-webhook.mts';

test('tokenMatches: equal → true; different, empty, different length, non-string → false; never throws', () => {
  assert.equal(tokenMatches('s3cret', 's3cret'), true);
  assert.equal(tokenMatches('s3cret', 's3cre7'), false);
  assert.equal(tokenMatches('s3cret', 's3cret-longer'), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches('', 'x'), false);
  assert.equal(tokenMatches(null, 'x'), false);
  assert.equal(tokenMatches(undefined, undefined), false);
  assert.equal(tokenMatches(42, '42'), false);
});

test('adminTokenOk: unset → open (unchanged); set → header or ?token= must match', () => {
  const req = (h = {}, q = '') => new Request('https://x.netlify.app/.netlify/functions/customer-comms-config' + q, { headers: h });
  delete process.env.COMMS_ADMIN_TOKEN;
  assert.equal(adminTokenOk(req()), true);
  process.env.COMMS_ADMIN_TOKEN = 'tok-1';
  try {
    assert.equal(adminTokenOk(req({ 'x-comms-token': 'tok-1' })), true);
    assert.equal(adminTokenOk(req({}, '?token=tok-1')), true);
    assert.equal(adminTokenOk(req({ 'x-comms-token': 'tok-2' })), false);
    assert.equal(adminTokenOk(req()), false);
  } finally { delete process.env.COMMS_ADMIN_TOKEN; }
});

test('simpletexting webhook: with the secret set, a wrong/missing token is 403; ?token= or x-webhook-token header opens it', async () => {
  const url = 'https://x.netlify.app/.netlify/functions/simpletexting-webhook';
  const body = JSON.stringify({ type: 'INCOMING_MESSAGE', values: { messageId: 'm1', text: 'hi', contactPhone: '7705551212' } });
  process.env.SIMPLETEXTING_WEBHOOK_SECRET = 'hook-secret';
  try {
    assert.equal((await webhook(new Request(url, { method: 'POST', body }))).status, 403);
    assert.equal((await webhook(new Request(url + '?token=nope', { method: 'POST', body }))).status, 403);
    assert.equal((await webhook(new Request(url + '?token=hook-secret', { method: 'POST', body }))).status, 200);
    assert.equal((await webhook(new Request(url, { method: 'POST', body, headers: { 'x-webhook-token': 'hook-secret' } }))).status, 200);
  } finally { delete process.env.SIMPLETEXTING_WEBHOOK_SECRET; }
});

test('simpletexting webhook: secret UNSET stays open (deploy decision) but warns once per invocation', async () => {
  delete process.env.SIMPLETEXTING_WEBHOOK_SECRET;
  const warns = [];
  const real = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    const r = await webhook(new Request('https://x.netlify.app/.netlify/functions/simpletexting-webhook', { method: 'POST', body: '{}' }));
    assert.equal(r.status, 200);
    assert.ok(warns.some((w) => /SIMPLETEXTING_WEBHOOK_SECRET is unset/.test(w)), warns.join('\n'));
  } finally { console.warn = real; }
});
