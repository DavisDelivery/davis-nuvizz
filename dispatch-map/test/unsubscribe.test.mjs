// LETTING THE CUSTOMER OFF THE LIST.
//
// Chad: a customer replied "unsubscribe" to a delivery confirmation and he went and turned
// her emails off by hand. The suppression has been honoured since v0.54.78 — but only a
// dispatcher could set it, so every unsubscribe depended on a person reading a reply and
// remembering to act.
//
// These tests are mostly about the ways an unsubscribe link goes wrong: a forgeable token
// on a key derived from a public address, a link scanner clicking it for the customer, and
// a write that takes the customer's receiving hours down with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unsubSecret, unsubSecrets, unsubscribeReady, validKeyShape, signKey, verifyToken, unsubscribeUrl,
  signUndo, verifyUndo, UNDO_TTL_MS,
  optOutPatch, optInPatch, optOutRow, sortOptOuts, UNSUB_PATH,
} from '../netlify/functions/lib/unsubscribe.mts';
import {
  withUnsubscribeFooter, unsubscribeHeaders, MERGE_FIELDS, buildMessage, DEFAULT_CONFIG,
} from '../netlify/functions/lib/customer-comms.mts';

const SECRET = 'a-real-server-secret';
const KEY = 'acme_flooring__1_main_st__buford__30518';

// ── THE TOKEN ────────────────────────────────────────────────────────────────

test('a link for one customer does not unsubscribe another', () => {
  // matchKey is derived from a business's NAME + STREET + CITY + ZIP — all public, and
  // painted on the side of our own trucks. Unsigned, anyone could unsubscribe anyone.
  const t = signKey(KEY, SECRET);
  assert.equal(verifyToken(KEY, t, SECRET), true);
  assert.equal(verifyToken('other__2_oak_st__buford__30518', t, SECRET), false);
});

test('a token minted under a different secret is refused', () => {
  assert.equal(verifyToken(KEY, signKey(KEY, 'some-other-secret'), SECRET), false);
});

test('NO SECRET means nothing verifies — it must never fall back to a constant', () => {
  // A constant fallback would produce tokens that verify for everybody: the same as having
  // no signature, while looking like it has one.
  assert.equal(verifyToken(KEY, signKey(KEY, SECRET), null), false);
  assert.equal(unsubscribeUrl(KEY, 'https://x', null), '', 'no link rather than a broken one');
});

test('the secret comes from config, and a too-short one does not count', () => {
  assert.equal(unsubSecret({ COMMS_UNSUB_SECRET: 'longenoughsecret' }), 'longenoughsecret');
  assert.equal(unsubSecret({ COMMS_ADMIN_TOKEN: 'fallbacksecret' }), 'fallbacksecret',
    'falls back to the admin token so the feature works without new config');
  assert.equal(unsubSecret({ COMMS_UNSUB_SECRET: 'dedicated', COMMS_ADMIN_TOKEN: 'admin' }), 'dedicated',
    'a dedicated secret wins, so it can be rotated on its own');
  assert.equal(unsubSecret({ COMMS_ADMIN_TOKEN: 'short' }), null);
  assert.equal(unsubSecret({}), null);
});

test('a malformed or empty token is refused rather than throwing', () => {
  for (const bad of ['', null, undefined, 'x', 'z'.repeat(32), '../../etc']) {
    assert.equal(verifyToken(KEY, bad, SECRET), false, JSON.stringify(bad));
  }
});

test('the link is absolute and carries both the key and its signature', () => {
  const u = new URL(unsubscribeUrl(KEY, 'https://dd-dispatch-map.netlify.app/', SECRET));
  assert.equal(u.pathname, UNSUB_PATH, 'a trailing slash on the origin must not double up');
  assert.equal(u.searchParams.get('k'), KEY);
  assert.equal(verifyToken(KEY, u.searchParams.get('t'), SECRET), true);
});

test('no matchKey means no link — a bare /unsubscribe would suppress nobody', () => {
  assert.equal(unsubscribeUrl('', 'https://x', SECRET), '');
  assert.equal(unsubscribeUrl(null, 'https://x', SECRET), '');
});

// ── THE FOOTER, WHICH MUST NOT DEPEND ON THE SAVED TEMPLATE ─────────────────

test('every email gets a way off the list, even though the live template is in Firestore', () => {
  // DEFAULT_HTML is only the fallback; the template customers actually receive is stored in
  // Firestore and predates this. Putting the footer solely in the default would have shipped
  // it to exactly zero real emails.
  const url = 'https://x/unsubscribe?k=a&t=b';
  const out = withUnsubscribeFooter('<p>delivered</p>', url);
  assert.ok(out.includes(url));
  assert.ok(out.includes('Unsubscribe'));
});

test('a template that places the link itself keeps control of where it sits', () => {
  const url = 'https://x/unsubscribe?k=a&t=b';
  const tpl = `<p>delivered</p><a href="${url}">stop these</a>`;
  assert.equal(withUnsubscribeFooter(tpl, url), tpl, 'nothing appended');
});

test('appending twice does not stack two footers', () => {
  const url = 'https://x/unsubscribe?k=a&t=b';
  const once = withUnsubscribeFooter('<p>hi</p>', url);
  assert.equal(withUnsubscribeFooter(once, url), once);
});

test('with no working link the footer asks them to reply instead of linking nowhere', () => {
  const out = withUnsubscribeFooter('<p>hi</p>', '');
  assert.ok(/reply/i.test(out));
  assert.ok(!out.includes('href="'), 'no dead link');
});

test('unsubscribeUrl is an advertised merge field, so it can be placed by hand', () => {
  assert.ok(MERGE_FIELDS.includes('unsubscribeUrl'));
});

// ── THE HEADERS ──────────────────────────────────────────────────────────────

test('one-click unsubscribe is only claimed when there is a URL to click', () => {
  // List-Unsubscribe-Post is honoured alongside an https URL. Advertising one-click with
  // only a mailto: would promise Gmail something we cannot deliver.
  const h = unsubscribeHeaders('https://x/u?k=a&t=b', 'inbox@example.com');
  assert.match(h['List-Unsubscribe'], /^<https:\/\/x\/u\?k=a&t=b>/);
  assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  const mailtoOnly = unsubscribeHeaders('', 'inbox@example.com');
  assert.match(mailtoOnly['List-Unsubscribe'], /^<mailto:/);
  assert.equal(mailtoOnly['List-Unsubscribe-Post'], undefined, 'no one-click without a URL');

  assert.deepEqual(unsubscribeHeaders('', ''), {}, 'nothing to advertise, no header');
});

// ── THE RECORD ───────────────────────────────────────────────────────────────

test('the patch sets ONLY the opt-out fields — the notes doc is not ours to rewrite', () => {
  // customer_notes carries the dispatcher's receiving hours, which the flag engine reads to
  // predict a missed window. setDoc in this repo REPLACES a document, so a whole-document
  // write here would delete those hours and silently stop flagging that customer.
  const p = optOutPatch({ source: 'customer', at: '2026-08-19T18:00:00Z', email: 'her@co.com', via: 'email-link' });
  assert.deepEqual(Object.keys(p).sort(), [
    'comms_opt_out', 'comms_opt_out_at', 'comms_opt_out_email', 'comms_opt_out_source', 'comms_opt_out_via',
  ]);
  assert.equal(p.comms_opt_out, true);
  assert.equal(p.comms_opt_out_source, 'customer');
});

test('who turned it off is recorded, because the two are different facts', () => {
  assert.equal(optOutPatch({ source: 'customer', at: 'T' }).comms_opt_out_source, 'customer');
  assert.equal(optOutPatch({ source: 'dispatcher', at: 'T' }).comms_opt_out_source, 'dispatcher');
});

test('the undo clears the flag AND its provenance', () => {
  // Leaving a stale "unsubscribed by customer on the 3rd" behind would make the list lie
  // about somebody who is back on it.
  const p = optInPatch('2026-08-20T09:00:00Z');
  assert.equal(p.comms_opt_out, false);
  assert.equal(p.comms_opt_out_at, null);
  assert.equal(p.comms_opt_out_source, null);
  assert.equal(p.comms_opt_in_at, '2026-08-20T09:00:00Z');
});

// ── THE LIST ─────────────────────────────────────────────────────────────────

test('a pre-existing opt-out reports NO source rather than being credited to the customer', () => {
  // The one Chad set by hand today was written before any of this existed, so nothing
  // recorded who did it. Guessing "customer" would invent a request that may never have
  // happened — the exact class of mistake this session has spent the day undoing.
  const r = optOutRow({ _id: KEY, raw_name: 'ACME FLOORING', comms_opt_out: true });
  assert.equal(r.source, null);
  assert.equal(r.customer, 'ACME FLOORING');
  assert.equal(r.at, null);
});

test('the list is newest first, with the undated pre-tracking ones last', () => {
  const rows = sortOptOuts([
    { customer: 'B', at: '2026-08-18T10:00:00Z' },
    { customer: 'Zeta', at: null },
    { customer: 'A', at: '2026-08-19T10:00:00Z' },
    { customer: 'Alpha', at: null },
  ]);
  assert.deepEqual(rows.map((r) => r.customer), ['A', 'B', 'Alpha', 'Zeta']);
});

// ── ROTATING THE SECRET MUST NOT BREAK LINKS ALREADY IN INBOXES ─────────────

test('a link signed with the previous secret still works after rotation', () => {
  // Delivery confirmations get dug out of an archive months later. The day the secret is
  // rotated, every link already sent would start answering "not valid" — and a customer who
  // clicks unsubscribe and gets an error does not write in about it, they mark the next one
  // as spam. This cannot be retro-fitted after the first rotation, because by then the old
  // signatures are unverifiable.
  const env = { COMMS_UNSUB_SECRET: 'the-new-secret', COMMS_UNSUB_SECRET_PREV: 'the-old-secret' };
  const { sign, accept } = unsubSecrets(env);
  assert.equal(sign, 'the-new-secret', 'new links are signed with the new key');
  assert.equal(verifyToken(KEY, signKey(KEY, 'the-old-secret'), accept), true, 'old links still honoured');
  assert.equal(verifyToken(KEY, signKey(KEY, 'a-third-secret'), accept), false, 'but not just any key');
});

test('moving off the admin token keeps links minted under it working', () => {
  const env = { COMMS_UNSUB_SECRET: 'dedicated-secret', COMMS_ADMIN_TOKEN: 'legacy-admin-token' };
  assert.equal(verifyToken(KEY, signKey(KEY, 'legacy-admin-token'), unsubSecrets(env).accept), true);
});

test('readiness is a fact the app can report, not something to hope for', () => {
  // With no secret the footer degrades to "reply to this email" — honest, but indistinguishable
  // from working, so a program sending hundreds a day would run with no unsubscribe and
  // nobody would know. The Communications screen reads this.
  assert.equal(unsubscribeReady({ COMMS_UNSUB_SECRET: 'longenoughsecret' }), true);
  assert.equal(unsubscribeReady({}), false);
  assert.equal(unsubscribeReady({ COMMS_ADMIN_TOKEN: 'tiny' }), false);
});

// ── THE PATH ─────────────────────────────────────────────────────────────────

test('a key that could walk out of the collection is refused before Firestore sees it', () => {
  // The key is interpolated into `customer_notes/${key}`. The signature gates it, but a path
  // built by concatenation should never be ABLE to leave, signature or not.
  assert.equal(validKeyShape(KEY), true);
  for (const bad of ['../../nuvizz_ops/customer_comms_config', 'a/b', '', null, undefined, 'x'.repeat(400), 'a b', 'a-b']) {
    assert.equal(validKeyShape(bad), false, JSON.stringify(bad));
  }
});

// ── UNDO IS A DIFFERENT PERMISSION ───────────────────────────────────────────

test('an unsubscribe token can NEVER put somebody back on the list', () => {
  // The escalation that matters. Anyone holding the URL — a forward, a gateway log, a link
  // scanner replaying it — could otherwise re-subscribe a customer who asked to be left
  // alone, and Davis would go on mailing someone who opted out.
  const now = Date.now();
  assert.equal(verifyUndo(KEY, now, signKey(KEY, SECRET), [SECRET], now), false);
});

test('the undo works right after opting out, and not much later', () => {
  const now = Date.now();
  const t = signUndo(KEY, now, SECRET);
  assert.equal(verifyUndo(KEY, now, t, [SECRET], now), true);
  assert.equal(verifyUndo(KEY, now, t, [SECRET], now + UNDO_TTL_MS - 1000), true);
  assert.equal(verifyUndo(KEY, now, t, [SECRET], now + UNDO_TTL_MS + 1000), false, 'expired');
});

test('an undo token minted for one customer does not re-subscribe another', () => {
  const now = Date.now();
  assert.equal(verifyUndo('someone__else__x__1', now, signUndo(KEY, now, SECRET), [SECRET], now), false);
});

test('a back-dated or future-dated undo is refused', () => {
  const now = Date.now();
  // Replaying with a fresh-looking timestamp must not work without the matching signature.
  assert.equal(verifyUndo(KEY, now, signUndo(KEY, now - 60 * 60 * 1000, SECRET), [SECRET], now), false);
  assert.equal(verifyUndo(KEY, now + 10 * 60 * 1000, signUndo(KEY, now + 10 * 60 * 1000, SECRET), [SECRET], now), false);
  assert.equal(verifyUndo(KEY, NaN, 'x', [SECRET], now), false);
});

// ── TWO FOOTERS IS A DEFECT, NOT A BELT AND BRACES ──────────────────────────

test('a template placing the link ESCAPED still suppresses the appended footer', () => {
  // The template is rendered through escapeVars, so {{unsubscribeUrl}} emits the escaped URL
  // (& becomes &amp;). Comparing only the raw form never matched, and the email went out
  // with the template's link AND an appended one — two unsubscribe links, in exactly the
  // case the guard exists to prevent.
  const url = 'https://x/unsubscribe?k=abc&t=def';
  const escaped = url.replace(/&/g, '&amp;');
  const tpl = `<p>delivered</p><a href="${escaped}">stop these emails</a>`;
  assert.equal(withUnsubscribeFooter(tpl, url), tpl, 'nothing appended');
});

// ── A TEST SEND MUST NOT BE ABLE TO SUPPRESS A REAL CUSTOMER ────────────────

test('a [TEST] send carries no working unsubscribe link', () => {
  // The test message is built from a REAL delivered stop and sent to a Davis inbox. With a
  // live footer, anyone on our side clicking Unsubscribe in a preview would opt out an
  // actual customer — and the confirmation page would greet them with that customer's name.
  const stop = {
    stopNbr: '007164290', businessName: 'ACME FLOORING', addr1: '1 Main St',
    city: 'Buford', zip: '30518', deliveredDTTM: '2026-08-19 14:05', contact: { email: 'a@b.com' },
  };
  const real = buildMessage(stop, '2026-08-19', DEFAULT_CONFIG);
  const test = buildMessage(stop, '2026-08-19', DEFAULT_CONFIG, { neutralizeUnsubscribe: true });

  assert.equal(test.vars.unsubscribeUrl, '', 'no link minted for a test');
  assert.ok(!/href="[^"]*\/unsubscribe/.test(test.html), 'and none rendered');
  assert.ok(/reply/i.test(test.html), 'it falls back to asking them to reply');
  // The real path is unaffected — this must not have quietly disabled the feature.
  assert.notEqual(real.vars.unsubscribeUrl, undefined);
});

test('the headers a test send would carry cannot unsubscribe anyone either', () => {
  assert.deepEqual(unsubscribeHeaders('', ''), {});
});
