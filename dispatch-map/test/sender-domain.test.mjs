// test/sender-domain.test.mjs
//
// The sender-domain panel on the Communications tab. It used to be a HARDCODED amber
// warning — "DNS is not verified yet, every send is rejected" — written while that was
// true and still saying it long after the domain verified. Chad, on a live program that
// had just delivered 25 of 25: "What is this yellow window for?"
//
// The property worth pinning is not "does it parse JSON". It is that the thing NEVER again
// asserts a failure it has not established:
//
//   • a missing key / a dead API / a thrown fetch → verified NULL ("could not check"),
//     never false. Dressing an unknown as a failure is the exact bug being replaced.
//   • a domain Resend does not hold → verified FALSE, which IS a real finding
//   • a verified domain → true, and no warning at all
//
// PURE — fetch is injected, nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';

import { senderDomain, readDomainStatus } from '../netlify/functions/lib/customer-comms.mts';

const KEY = 'test-key-not-a-secret';
const reply = (body, ok = true, status = 200) => async () => ({
  ok, status, json: async () => body,
});

// ── THE DOMAIN OUT OF A SENDER ───────────────────────────────────────────────

test('the domain is read from either sender form', () => {
  assert.equal(senderDomain('Davis Delivery <notifications@example.com>'), 'example.com');
  assert.equal(senderDomain('notifications@example.com'), 'example.com');
  assert.equal(senderDomain('  Ops <BOX@Example.COM>  '), 'example.com', 'lower-cased');
  assert.equal(senderDomain('a@b.co.uk'), 'b.co.uk');
});

test('a sender that is not an address yields no domain', () => {
  for (const bad of ['', null, undefined, 'nobody', 'no@domain', '@example.com', 'a@b']) {
    assert.equal(senderDomain(bad), null, JSON.stringify(bad));
  }
});

// ── "I COULD NOT CHECK" IS NOT "IT IS BROKEN" ────────────────────────────────

test('THE POINT: an unknown never reports itself as a failure', async () => {
  const noKey = await readDomainStatus('a@example.com', null, reply({}));
  assert.equal(noKey.verified, null, 'no API key is not evidence of bad DNS');
  assert.match(noKey.error, /RESEND_API_KEY/);

  const apiDown = await readDomainStatus('a@example.com', KEY, reply({}, false, 503));
  assert.equal(apiDown.verified, null, 'a 503 is not evidence of bad DNS');
  assert.match(apiDown.error, /503/);

  const threw = await readDomainStatus('a@example.com', KEY, async () => { throw new Error('socket hang up'); });
  assert.equal(threw.verified, null, 'a thrown fetch must not become a DNS verdict');
  assert.match(threw.error, /socket hang up/);

  const noSender = await readDomainStatus('', KEY, reply({}));
  assert.equal(noSender.verified, null);

  const garbage = await readDomainStatus('a@example.com', KEY, reply(null));
  assert.equal(garbage.verified, false, 'a readable answer with no such domain IS a finding');
  assert.equal(garbage.status, 'not_registered');
});

// ── THE THREE REAL ANSWERS ───────────────────────────────────────────────────

test('a verified domain reports verified, with nothing pending', async () => {
  const d = await readDomainStatus('Davis <notifications@example.com>', KEY, reply({
    data: [{ name: 'example.com', status: 'verified', records: [
      { type: 'TXT', name: 'resend._domainkey', status: 'verified', value: 'p=AAA' },
      { type: 'MX', name: 'send', status: 'verified', value: 'feedback-smtp.example.net' },
    ] }],
  }));
  assert.equal(d.verified, true);
  assert.equal(d.domain, 'example.com');
  assert.deepEqual(d.pending, [], 'nothing outstanding to nag about');
});

test('a partly-published domain names ONLY the records still failing', async () => {
  const d = await readDomainStatus('notifications@example.com', KEY, reply({
    data: [{ name: 'example.com', status: 'pending', records: [
      { type: 'TXT', name: 'resend._domainkey', status: 'verified', value: 'p=AAA' },
      { type: 'MX', name: 'send', status: 'pending', value: 'feedback-smtp.example.net' },
      { type: 'TXT', name: 'send', status: 'not_started', value: 'v=spf1 include:example.net ~all' },
    ] }],
  }));
  assert.equal(d.verified, false);
  assert.equal(d.status, 'pending');
  assert.deepEqual(d.pending.map((r) => `${r.type} ${r.name}`), ['MX send', 'TXT send'],
    'the already-verified DKIM record must not be listed as outstanding');
});

test('a domain Resend does not hold is a finding, not an unknown', async () => {
  const d = await readDomainStatus('notifications@example.com', KEY, reply({
    data: [{ name: 'someone-else.example', status: 'verified', records: [] }],
  }));
  assert.equal(d.verified, false, 'nothing will send — that is established, not guessed');
  assert.equal(d.status, 'not_registered');
});

test('the match is on the sender domain, case-insensitively', async () => {
  const d = await readDomainStatus('Ops <BOX@Example.COM>', KEY, reply({
    data: [{ name: 'EXAMPLE.com', status: 'verified', records: [] }],
  }));
  assert.equal(d.verified, true);
});

test('a domain with no records array does not throw', async () => {
  const d = await readDomainStatus('a@example.com', KEY, reply({ data: [{ name: 'example.com', status: 'verified' }] }));
  assert.equal(d.verified, true);
  assert.deepEqual(d.pending, []);
});
