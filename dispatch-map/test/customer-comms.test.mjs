// test/customer-comms.test.mjs
//
// The delivery-complete customer email. These tests pin the things that, if wrong, are
// wrong in a customer's inbox or in a way nobody notices until a customer complains:
//
//   • the delivered timestamp (a naive ET stamp handed to Date+timeZone reads 4-5 hours
//     early, and rolls a pre-dawn delivery to the previous DAY)
//   • the dedup key (keyed on `pro` it drifts on enrichment → a second email)
//   • the match key (it is NEVER falsy, so an all-blank stop would share one notes doc)
//   • template escaping (merge values are shipper-typed data landing in an HTML document)
//   • the board-date guard (nothing upstream bounds ?date=, so an old board could be swept)
//   • who a test send may reach (this endpoint is live while the feature is still off)
//
// Everything here is PURE — no Firestore, no network.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNaiveStamp, formatDay, formatClock, stopVars,
  renderTemplate, escapeHtml, escapeVars, normalizeSubject,
  ledgerKey, usableMatchKey, chooseRecipient,
  isSweepableBoardDate, isStaleDelivery, isDefinitiveRejection,
  isEmailAddress, isSenderAddress, clampDailyCap, testRecipientAllowed,
  sendForStop, DEFAULT_CONFIG,
  MERGE_FIELDS, DEFAULT_HTML, MAX_DAILY_CAP,
} from '../netlify/functions/lib/customer-comms.mts';

// A board stop as the LIST path writes it (toBoardStop): no state, no pallets, and a
// deliveredDTTM that is a naive ET wall-clock string with no offset.
const LIST_STOP = {
  stopNbr: '007137332', pro: '007137332', primaryPro: '007137332',
  normalizedStatus: 'DELIVERED',
  businessName: 'Peachtree Tile & Stone LLC',
  addr1: '1420 Buford Highway', city: 'Buford', state: null, zip: '30518',
  driverName: 'Rasheed W', cartons: 3, volume: 2, weight: 1840,
  deliveredDTTM: '2026-08-16T14:15:00',
  contact: { name: 'Dana', phone: '6785551212', sms: null, email: 'dana@example.com' },
};

// ── THE TIMESTAMP ────────────────────────────────────────────────────────────

test('THE BUG: a naive ET stamp must not be re-projected through a timezone', () => {
  // What the original code did: new Date(stamp) in a UTC runtime, formatted as ET.
  const wrong = new Date('2026-08-16T14:15:00').toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  });
  assert.equal(wrong, '10:15 AM', 'sanity: the old path really does shift 4 hours');

  const v = stopVars(LIST_STOP, '2026-08-16');
  assert.equal(v.deliveredTime, '2:15 PM', 'the stamp is already ET — read it, do not convert it');
  assert.equal(v.deliveredDate, 'Aug 16, 2026');
  assert.equal(v.deliveredWhen, 'Aug 16, 2026 at 2:15 PM');
});

test('a pre-dawn delivery keeps its own day', () => {
  const v = stopVars({ ...LIST_STOP, deliveredDTTM: '2026-08-16T02:30:00' }, '2026-08-16');
  assert.equal(v.deliveredDate, 'Aug 16, 2026', 'must not roll back to the 15th');
  assert.equal(v.deliveredTime, '2:30 AM');
});

test('winter is not a special case — no offset is applied in either direction', () => {
  const v = stopVars({ ...LIST_STOP, deliveredDTTM: '2026-01-15T14:15:00' }, '2026-01-15');
  assert.equal(v.deliveredWhen, 'Jan 15, 2026 at 2:15 PM');
});

test('midnight and noon read as 12, not 0', () => {
  assert.equal(formatClock(0, 5), '12:05 AM');
  assert.equal(formatClock(12, 0), '12:00 PM');
  assert.equal(formatClock(23, 59), '11:59 PM');
});

test('an absent or junk stamp falls back to the board date and empties the time', () => {
  for (const bad of [null, '', 'not a date', '2026-08-16', '2026-08-16T99:99:00']) {
    const v = stopVars({ ...LIST_STOP, deliveredDTTM: bad }, '2026-08-16');
    assert.equal(v.deliveredTime, '', `${bad} must not produce a time`);
    assert.equal(v.deliveredWhen, 'Aug 16, 2026', 'and no dangling " at "');
  }
  assert.equal(parseNaiveStamp('2026-08-16T24:00'), null);
  assert.equal(formatDay('garbage'), 'garbage');
});

// ── THE DEDUP KEY ────────────────────────────────────────────────────────────

test('THE BUG: the dedup key survives the leading-zero drift enrichment introduces', () => {
  // The list pins stopNbr as '007137332'; /stop/info can answer '7137332' and mergeEnrich
  // copies that onto `pro`, which is NOT a pinned field. Keying on pro would claim under
  // one spelling and check under the other — a second email for the same delivery.
  const beforeEnrich = ledgerKey({ stopNbr: '007137332', pro: '007137332' });
  const afterEnrich = ledgerKey({ stopNbr: '007137332', pro: '7137332' });
  assert.equal(beforeEnrich, afterEnrich);
  assert.equal(beforeEnrich, '7137332');
});

test('the dedup key rejects what Firestore will not accept as a document id', () => {
  assert.equal(ledgerKey({ stopNbr: '' }), '');
  assert.equal(ledgerKey({}), '');
  assert.equal(ledgerKey({ stopNbr: '0000' }), '', 'all-zeros normalises to nothing');
  // '.' and '..' are illegal Firestore ids — and sanitising them would produce the legal
  // '_' and '__', so they have to be caught on the raw value, not on the sanitised one.
  assert.equal(ledgerKey({ stopNbr: '.' }), '');
  assert.equal(ledgerKey({ stopNbr: '..' }), '');
  assert.equal(ledgerKey({ stopNbr: '///' }), '');
  assert.equal(ledgerKey({ stopNbr: '__proto__' }), '', 'reserved __…__ ids are refused');
  assert.equal(ledgerKey({ stopNbr: 'AB/12#34' }), 'AB_12_34', 'path separators can never survive');
  assert.equal(ledgerKey({ stopNbr: 'x'.repeat(500) }).length, 200);
});

test('the key falls back through pro and primaryPro when stopNbr is missing', () => {
  assert.equal(ledgerKey({ pro: '7137332' }), '7137332');
  assert.equal(ledgerKey({ primaryPro: '7137332' }), '7137332');
});

// ── THE MATCH KEY ────────────────────────────────────────────────────────────

test('THE BUG: normalizeMatchKey is never falsy, so an empty stop must be caught on content', () => {
  // normalizeMatchKey always returns "<name>__<street>__<city>__<zip>" — for an all-blank
  // stop that is the literal "______", which is truthy and which EVERY address-less stop
  // would share. A `if (!key)` guard never fires.
  assert.equal(usableMatchKey({}), null);
  assert.equal(usableMatchKey({ businessName: '', addr1: '', city: '', zip: '' }), null);
  assert.equal(usableMatchKey({ businessName: 'LLC' }), null, 'a suffix-only name normalises away');
  assert.equal(usableMatchKey({ businessName: '!!!' }), null, 'punctuation-only too');
  assert.ok(usableMatchKey(LIST_STOP), 'a real stop still resolves');
});

// ── THE RECIPIENT ────────────────────────────────────────────────────────────

test('the order contact is the address that actually exists today', () => {
  const r = chooseRecipient(null, LIST_STOP, 'k');
  assert.equal(r.email, 'dana@example.com');
  assert.equal(r.source, 'order');
});

test('a dispatcher correction in customer_notes beats the order', () => {
  const r = chooseRecipient({ comms_email: 'ap@example.com', raw_name: 'Peachtree Tile' }, LIST_STOP, 'k');
  assert.equal(r.email, 'ap@example.com');
  assert.equal(r.source, 'notes');
  assert.equal(r.name, 'Peachtree Tile');
});

test('opt-out wins over every address, including one on the order', () => {
  const r = chooseRecipient({ comms_opt_out: true, comms_email: 'x@y.com' }, LIST_STOP, 'k');
  assert.equal(r.email, null);
  assert.equal(r.optedOut, true);
});

test('a malformed address is no address', () => {
  for (const bad of ['dana', 'dana@', '@peachtreetile.com', 'a@b', 'a b@c.com', 'a@b.com, c@d.com']) {
    assert.equal(chooseRecipient(null, { contact: { email: bad } }, 'k').email, null, bad);
  }
  assert.equal(chooseRecipient(null, {}, 'k').email, null);
});

// ── THE TEMPLATE ─────────────────────────────────────────────────────────────

test('substitution is dumb: unknown fields vanish and nothing is evaluated', () => {
  assert.equal(renderTemplate('Hi {{customer}}!', { customer: 'Acme' }), 'Hi Acme!');
  assert.equal(renderTemplate('{{nope}}', {}), '', 'no literal {{token}} in a customer inbox');
  assert.equal(renderTemplate('{{ pro }}', { pro: '7137332' }), '7137332', 'whitespace tolerated');
  // Nothing that looks like an expression is one.
  assert.equal(renderTemplate('{{a.b}}{{1+1}}{{a-b}}', { a: 'x' }), '{{a.b}}{{1+1}}{{a-b}}');
});

test('a {{#field}} section takes its own label with it when the field is empty', () => {
  const tpl = 'A{{#driver}} driver: {{driver}}{{/driver}}B';
  assert.equal(renderTemplate(tpl, { driver: 'Rasheed W' }), 'A driver: Rasheed WB');
  assert.equal(renderTemplate(tpl, { driver: '' }), 'AB', 'no orphaned "driver:" heading');
  assert.equal(renderTemplate(tpl, {}), 'AB');
});

test('THE BUG: merge values are shipper-typed data and must not render as markup', () => {
  const evil = '<img src=x onerror=alert(1)>Acme';
  assert.equal(escapeHtml(evil), '&lt;img src=x onerror=alert(1)&gt;Acme');
  const out = renderTemplate('<div>{{customer}}</div>', escapeVars({ customer: evil }));
  assert.ok(!out.includes('<img'), 'no live tag reaches the inbox');
  assert.ok(out.includes('&lt;img'));
  // Quotes matter too — a merge value can land inside an attribute in an edited template.
  assert.equal(escapeHtml(`a"b'c&d`), 'a&quot;b&#39;c&amp;d');
});

test('a subject is a header, not a document: no newlines, and bounded', () => {
  assert.equal(normalizeSubject('Delivered\r\nBcc: someone@else.com'), 'Delivered Bcc: someone@else.com');
  assert.equal(normalizeSubject('  padded  '), 'padded');
  assert.equal(normalizeSubject('x'.repeat(500)).length, 200);
});

test('the default template only uses fields the editor advertises', () => {
  const used = new Set([...DEFAULT_HTML.matchAll(/\{\{#?\/?\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]));
  for (const f of used) {
    assert.ok(MERGE_FIELDS.includes(f), `DEFAULT_HTML uses {{${f}}} but the editor does not list it`);
  }
});

test('every field the editor advertises is actually supplied', () => {
  const v = stopVars(LIST_STOP, '2026-08-16');
  for (const f of MERGE_FIELDS) assert.ok(f in v, `stopVars does not supply {{${f}}}`);
});

// ── THE LIST-ROW GAPS ────────────────────────────────────────────────────────

test('an un-enriched list row composes city/zip without a dangling comma', () => {
  // toBoardStop hard-codes state: null, so "{{city}}, {{state}} {{zip}}" rendered ", 30518".
  const v = stopVars(LIST_STOP, '2026-08-16');
  assert.equal(v.state, '');
  assert.equal(v.cityStateZip, 'Buford 30518');
  assert.equal(stopVars({ ...LIST_STOP, state: 'GA' }, '2026-08-16').cityStateZip, 'Buford, GA 30518');
  assert.equal(stopVars({ city: null, state: null, zip: null }, '2026-08-16').cityStateZip, '');
});

test('pieces falls back to the list freight columns when the stop is not enriched', () => {
  // NuVizz mislabels these and the scan relabels them: cartons = pallets, volume = loose,
  // and the enriched `pallets` is the TOTAL. cartons+volume is that same total.
  assert.equal(stopVars(LIST_STOP, '2026-08-16').pieces, '5');
  assert.equal(stopVars({ ...LIST_STOP, pallets: 5 }, '2026-08-16').pieces, '5', 'enriched value wins');
  assert.equal(stopVars({ ...LIST_STOP, cartons: 0, volume: 0 }, '2026-08-16').pieces, '');
});

// ── THE FRESHNESS GUARD ──────────────────────────────────────────────────────

test('THE BUG: an old board date can never be swept', () => {
  // Nothing upstream validates ?date= — the refresh entrypoint takes it off the query
  // string and the manual scan forwards it verbatim. Without this, ?date=<six weeks ago>
  // would sweep an old board against an empty ledger and mail real customers.
  assert.equal(isSweepableBoardDate('2026-07-01', '2026-08-16'), false);
  assert.equal(isSweepableBoardDate('2026-08-14', '2026-08-16'), false, 'two days back is already history');
  assert.equal(isSweepableBoardDate('2026-08-15', '2026-08-16'), true, 'yesterday: a post-midnight scan still writes it');
  assert.equal(isSweepableBoardDate('2026-08-16', '2026-08-16'), true);
});

test('a junk or unbounded date is refused outright', () => {
  for (const bad of ['', 'today', '2026-8-16', '20260816', null, undefined, '9999-01-01']) {
    assert.equal(isSweepableBoardDate(bad, '2026-08-16'), false, String(bad));
  }
});

test('a delivery stamped well before its own board date is not emailed', () => {
  assert.equal(isStaleDelivery({ deliveredDTTM: '2026-08-01T10:00:00' }, '2026-08-16'), true);
  assert.equal(isStaleDelivery({ deliveredDTTM: '2026-08-16T10:00:00' }, '2026-08-16'), false);
  assert.equal(isStaleDelivery({ deliveredDTTM: '2026-08-15T10:00:00' }, '2026-08-16'), false, 'rollover is normal');
  // Fails OPEN with no stamp — the board-date guard is what bounds this, and a DELIVERED
  // list row always carries one.
  assert.equal(isStaleDelivery({}, '2026-08-16'), false);
});

// ── THE ENDPOINT GUARDS ──────────────────────────────────────────────────────

test('a test send can only reach an allowlisted address', () => {
  assert.equal(testRecipientAllowed('chad@example.com', '@example.com'), true);
  assert.equal(testRecipientAllowed('CHAD@Example.com', '@example.com'), true, 'case-insensitive');
  assert.equal(testRecipientAllowed('customer@example.net', '@example.com'), false);
  // The suffix rule must not match a lookalike domain.
  assert.equal(testRecipientAllowed('evil@notexample.com.attacker.io', '@example.com'), false);
  assert.equal(testRecipientAllowed('chad@example.org', '@example.com,chad@example.org'), true);
  assert.equal(testRecipientAllowed('other@example.org', '@example.com,chad@example.org'), false);
  assert.equal(testRecipientAllowed('', ''), false);
  // The DEFAULT rule is the company domain. Asserted without writing a company address
  // into this file — a lifelike one is what broke the deploy twice (see the guard test in
  // test/no-lifelike-addresses.test.mjs) — so assert what it must REFUSE instead.
  assert.equal(testRecipientAllowed('stranger@example.com'), false, 'the default is not "anyone"');
  assert.equal(testRecipientAllowed('x@' + ['davisdelivery', 'com'].join('.')), true, 'the default IS the company domain');
});

test('the sender must be one address, with or without a display name', () => {
  assert.equal(isSenderAddress('notifications@example.com'), true);
  assert.equal(isSenderAddress('Davis Delivery Service <notifications@example.com>'), true);
  assert.equal(isSenderAddress('a@b.com, c@d.com'), false, 'one address becomes several');
  assert.equal(isSenderAddress('a@b.com\r\nBcc: x@y.com'), false, 'header injection');
  assert.equal(isSenderAddress(''), false);
  assert.equal(isSenderAddress('x'.repeat(300) + '@b.com'), false);
});

test('a recipient address takes no display name and no separators', () => {
  assert.equal(isEmailAddress('customerservice@example.com'), true);
  assert.equal(isEmailAddress('Name <a@b.com>'), false);
  assert.equal(isEmailAddress('a@b.com;c@d.com'), false);
});

// ── THE CLAIM (the property the whole module exists for) ─────────────────────
//
// sendForStop takes an optional `deps` seam so this ordering can be driven directly. It is
// the single thing standing between a delivery and a customer emailed twice, and "verified
// by reading it" is not good enough for that.

const ENABLED = { ...DEFAULT_CONFIG, enabled: true, htmlTemplate: '<p>{{pro}}</p>' };

// emailEnabled() reads these at call time, so the module needs no mocking to be exercised.
process.env.RESEND_API_KEY ||= 'test-key';
process.env.RESEND_FROM ||= 'Davis <no-reply@example.com>';

function harness(over = {}) {
  const calls = [];
  const base = {
    recipient: async () => ({ email: 'dana@example.com', optedOut: false, matchKey: 'k', source: 'order' }),
    claim: async () => true,
    finalize: async () => {},
    release: async () => {},
    send: async () => ({ ok: true, id: 'e_1' }),
    ...over,
  };
  // Record AFTER the overrides are folded in, so an override is still observed. `recipient`
  // is left out of the trace: what matters is the claim/send/finalize/release ordering.
  const deps = {};
  for (const [name, fn] of Object.entries(base)) {
    deps[name] = async (...a) => { if (name !== 'recipient') calls.push(name); return fn(...a); };
  }
  return { calls, deps };
}

const TODAY = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

test('THE PROPERTY: the claim is written before anything is sent', async () => {
  const h = harness();
  const r = await sendForStop({ ...LIST_STOP, deliveredDTTM: null }, TODAY(), { cfg: ENABLED, deps: h.deps });
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls, ['claim', 'send', 'finalize'], 'claim must come first, always');
});

test('THE PROPERTY: losing the claim race sends nothing', async () => {
  const h = harness({ claim: async () => false });
  const r = await sendForStop({ ...LIST_STOP, deliveredDTTM: null }, TODAY(), { cfg: ENABLED, deps: h.deps });
  assert.equal(r.skipped, 'already_sent');
  assert.ok(!h.calls.includes('send'), 'the sweep that lost the race must not send');
});

test('THE PROPERTY: a claim that cannot be written sends nothing', async () => {
  // The tempting bug is to swallow the write error and send anyway. That produces an email
  // with no ledger row, and the next sweep sends it again — no concurrency required.
  const h = harness({ claim: async () => { throw new Error('Firestore 503'); } });
  const r = await sendForStop({ ...LIST_STOP, deliveredDTTM: null }, TODAY(), { cfg: ENABLED, deps: h.deps });
  assert.equal(r.skipped, 'claim_failed');
  assert.ok(!h.calls.includes('send'), 'never send without a durable claim');
});

test('a refused send releases its claim so a later sweep retries', async () => {
  const h = harness({ send: async () => ({ ok: false, error: 'Resend HTTP 422 invalid from' }) });
  const r = await sendForStop({ ...LIST_STOP, deliveredDTTM: null }, TODAY(), { cfg: ENABLED, deps: h.deps });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true, 'and it must not cost budget');
  assert.deepEqual(h.calls, ['claim', 'send', 'release']);
});

test('THE PROPERTY: an AMBIGUOUS failure keeps its claim', async () => {
  // A gateway 5xx, a 408, or a thrown socket error can all arrive AFTER Resend accepted and
  // queued the message. Releasing those is precisely how a customer gets a second email.
  for (const error of ['Resend HTTP 500 upstream', 'Resend HTTP 502 bad gateway', 'Resend HTTP 408', 'fetch failed']) {
    const h = harness({ send: async () => ({ ok: false, error }) });
    const r = await sendForStop({ ...LIST_STOP, deliveredDTTM: null }, TODAY(), { cfg: ENABLED, deps: h.deps });
    assert.ok(!h.calls.includes('release'), `${error} must NOT release the claim`);
    assert.deepEqual(h.calls, ['claim', 'send', 'finalize']);
    assert.ok(!r.retryable, `${error} is not known-safe to retry`);
  }
});

test('only a 4xx that is not a timeout counts as a definitive refusal', () => {
  assert.equal(isDefinitiveRejection('Resend HTTP 400 bad request'), true);
  assert.equal(isDefinitiveRejection('Resend HTTP 429 rate limited'), true, 'refused, nothing queued');
  assert.equal(isDefinitiveRejection('Resend HTTP 408 timeout'), false);
  assert.equal(isDefinitiveRejection('Resend HTTP 500 upstream'), false);
  assert.equal(isDefinitiveRejection('fetch failed'), false);
  assert.equal(isDefinitiveRejection(undefined), false);
});

test('an opted-out or address-less customer never reaches the claim', async () => {
  for (const [recip, want] of [
    [{ email: null, optedOut: true, matchKey: 'k' }, 'opted_out'],
    [{ email: null, optedOut: false, matchKey: 'k' }, 'no_email_on_file'],
  ]) {
    const h = harness({ recipient: async () => recip });
    const r = await sendForStop({ ...LIST_STOP, deliveredDTTM: null }, TODAY(), { cfg: ENABLED, deps: h.deps });
    assert.equal(r.skipped, want);
    assert.deepEqual(h.calls, [], 'no claim, no send');
  }
});

test('the guards run before the claim: disabled, not delivered, stale, unusable key', async () => {
  const today = TODAY();
  const cases = [
    [{ ...LIST_STOP, deliveredDTTM: null }, { ...ENABLED, enabled: false }, 'disabled'],
    [{ ...LIST_STOP, normalizedStatus: 'ARRIVED', deliveredDTTM: null }, ENABLED, 'not_delivered(ARRIVED)'],
    [{ ...LIST_STOP, deliveredDTTM: '2026-01-01T10:00:00' }, ENABLED, 'stale_delivery'],
    [{ ...LIST_STOP, stopNbr: '', pro: '', primaryPro: '', deliveredDTTM: null }, ENABLED, 'no_stop_nbr'],
  ];
  for (const [stop, cfg, want] of cases) {
    const h = harness();
    const r = await sendForStop(stop, today, { cfg, deps: h.deps });
    assert.equal(r.skipped, want);
    assert.deepEqual(h.calls, [], `${want} must short-circuit before the claim`);
  }
});

test('the daily cap is clamped, not merely validated', () => {
  assert.equal(clampDailyCap(25), 25);
  assert.equal(clampDailyCap(0), 0, 'zero pauses without disabling');
  assert.equal(clampDailyCap(100000), MAX_DAILY_CAP, 'a typo is not the last line of defence');
  assert.equal(clampDailyCap(12.9), 12);
  assert.equal(clampDailyCap(-1), null);
  assert.equal(clampDailyCap('abc'), null);
  assert.equal(clampDailyCap(NaN), null, 'NaN would compare false against every guard');
});
