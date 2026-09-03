// WHO THE MISS-WINDOW ALERT IS ADDRESSED TO.
//
// Chad, 2026-09-03: "Also I didn't get either email to customer service today. You need to
// test the email path."
//
// THE PATH WAS NOT BROKEN. Both of that day's alerts are in Resend's own record as
// DELIVERED — FABLE HOMEGOODS at 11:00:50a ET and VALVOLINE 0203 at 3:20:22p — the company
// customer-service address is not on the suppression list, and a test message sent from the
// same sender on the same account landed in his inbox within seconds. He did not receive the
// alerts because he was never a recipient: one hardcoded address, no CC, no override, passed
// to the send site as a bare string.
//
// These tests pin the list that replaced it. The point is not that a CC is possible; it is
// that every way of getting the list wrong fails loudly here instead of quietly in
// production, because "the mailer is broken" and "you are not on the list" are
// indistinguishable from an inbox and only one of them is a bug anyone can see.
//
// EVERY ADDRESS BELOW IS DERIVED, NEVER TYPED. Netlify's secrets scan greps the repository
// for env-var values as plain bytes, and a fixture built from a real person's name at the
// real domain has broken main's deploy four times. So the fixtures compose role words onto
// ALERT_INTERNAL_SUFFIXES — the shipped list itself — which is the same trick
// no-env-value-literals uses on OWNER_ROUTE_NAMES, and it has the second benefit that these
// tests track the allowlist instead of restating it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAlertCc, alertRecipients, sendAlerts, selectAlertable, ALERT_TO, ALERT_CC,
  ALERT_INTERNAL_SUFFIXES,
} from '../netlify/functions/lib/flag-alert.mts';

const [PRIMARY_SUFFIX, ALT_SUFFIX] = ALERT_INTERNAL_SUFFIXES;
const DOMAIN = PRIMARY_SUFFIX.slice(1);                     // the bare company domain
/** A role address on a company domain — never a person, so the scanner has nothing to hit. */
const at = (role, suffix = PRIMARY_SUFFIX) => `${role}${suffix}`;
const DISPATCH = at('dispatch');
const OPS = at('ops');
const WAREHOUSE = at('warehouse');

const DATE = '2026-09-03';
const row = (o) => ({
  rule: 'hours_risk', tier: 'critical', stopNbr: '007171759', customer: 'VALVOLINE 0203',
  routeName: 'TONY 1', closeMin: 15 * 60 + 30, etaMin: 16 * 60 + 21, lateBy: 51, anchored: true, ...o,
});

/** The claim-and-send harness the other alert tests use, with the sends captured. */
function harness() {
  const claims = new Set();
  const sends = [];
  return {
    sends,
    io: {
      createDocIfAbsent: async (p) => (claims.has(p) ? false : (claims.add(p), true)),
      send: async (a) => { sends.push(a); return { ok: true, id: 'x' }; },
    },
  };
}

// ── THE LIST ────────────────────────────────────────────────────────────────

test('WITH NOTHING CONFIGURED, NOTHING CHANGES — customer service, alone, exactly as before', () => {
  // The whole change is a liability if it can alter who gets mailed on a site where nobody
  // has set ALERT_CC. Every shape of "unset" has to read the same way.
  for (const raw of [undefined, null, '', '   ', ',', ';;', '\n', ' , ; \n ']) {
    const { cc, rejected } = parseAlertCc(raw);
    assert.deepEqual(cc, [], `cc for ${JSON.stringify(raw)}`);
    assert.deepEqual(rejected, [], `rejected for ${JSON.stringify(raw)}`);
    assert.deepEqual(alertRecipients(cc), [ALERT_TO]);
  }
});

test('CUSTOMER SERVICE IS ALWAYS FIRST — the addressee is the desk that makes the phone call', () => {
  // Not cosmetic. A receiving-window alert is acted on by whoever phones the consignee and
  // asks to be received late. Two names on the TO line is two people making that call, or
  // neither, because each assumed the other had. Everyone added is watching, not working it.
  const { cc } = parseAlertCc(`${DISPATCH}, ${OPS}`);
  assert.deepEqual(alertRecipients(cc), [ALERT_TO, DISPATCH, OPS]);
});

test('AN ENV VAR PASTED OUT OF A CHAT MESSAGE STILL PARSES — commas, semicolons, newlines, padding', () => {
  const { cc, rejected } = parseAlertCc(`  ${DISPATCH} ;\n ${OPS},\t${WAREHOUSE}  `);
  assert.deepEqual(cc, [DISPATCH, OPS, WAREHOUSE]);
  assert.deepEqual(rejected, []);
});

test('NOBODY IS MAILED TWICE — the primary in the CC, and a repeat in any case, are dropped', () => {
  // Putting the customer-service address into ALERT_CC is the obvious thing to try, and it
  // must not send that mailbox two copies of every miss.
  const { cc } = parseAlertCc(`${ALERT_TO.toUpperCase()}, ${DISPATCH}, ${DISPATCH.toUpperCase()}`);
  assert.deepEqual(cc, [DISPATCH]);
  assert.deepEqual(alertRecipients(cc), [ALERT_TO, DISPATCH]);
});

// ── THE LEAK GUARD ──────────────────────────────────────────────────────────

test('AN OUTSIDE ADDRESS IS REFUSED — this message names a customer and says we are about to miss them', () => {
  // The body carries the consignee's name, its PRO, its route and the fact that Davis is
  // going to blow their receiving window. One typo in a console env var must not put that in
  // a stranger's inbox, and "it was only a config mistake" is not a defence the customer
  // cares about. Internal domains only.
  const { cc, rejected } = parseAlertCc(`${DISPATCH}, someone@example.com, buyer@example.net`);
  assert.deepEqual(cc, [DISPATCH]);
  assert.deepEqual(rejected, ['someone@example.com', 'buyer@example.net']);
});

test('A LOOKALIKE DOMAIN IS NOT AN INTERNAL DOMAIN', () => {
  // endsWith() against a bare domain would have accepted every one of these. The shipped
  // suffixes carry the '@' for exactly this reason.
  const lookalikes = [
    `ops@not${DOMAIN}`,                 // a longer domain that ends with ours
    `${OPS}.example.net`,               // ours as a subdomain of someone else's
    DOMAIN,                             // no local part, no '@' at all
    `ops@${DOMAIN.slice(0, -1)}`,       // one character short of the real TLD
  ];
  for (const bad of lookalikes) {
    const { cc, rejected } = parseAlertCc(bad);
    assert.deepEqual(cc, [], `${bad} must not be accepted`);
    assert.deepEqual(rejected, [bad]);
  }
  // And the second company domain IS accepted — Uline addresses Davis at both of them.
  assert.deepEqual(parseAlertCc(at('dispatch', ALT_SUFFIX)).cc, [at('dispatch', ALT_SUFFIX)]);
});

test('A MALFORMED ENTRY IS NAMED, NOT SWALLOWED', () => {
  // A recipient that disappears in silence recreates the exact failure this change exists to
  // end: someone who believes they are on the list and never gets mail.
  const { cc, rejected } = parseAlertCc(`ops at ${DOMAIN} | ${DISPATCH}`);
  assert.deepEqual(cc, []);
  assert.equal(rejected.length, 1, 'the whole malformed run is reported as one refusal');
  assert.match(rejected[0], /ops at /);
});

// ── THE SEND ────────────────────────────────────────────────────────────────

test('A BARE STRING STILL ADDRESSES ONE MAILBOX — a spread string would have emailed nobody', async () => {
  // Every caller and every test before this change passed one string. Spreading it into an
  // array gives ['c','u','s','t',...], which Resend rejects — so the change that adds a CC
  // would have silently stopped all alerting. This is the regression that mattered.
  const h = harness();
  const r = await sendAlerts(selectAlertable([row({})], 10 * 60), DATE, 'davis', h.io, ALERT_TO);
  assert.equal(r.sent, 1);
  assert.deepEqual(h.sends[0].to, [ALERT_TO]);
});

test('A LIST ADDRESSES EVERYONE IN ONE MESSAGE, NOT ONE MESSAGE EACH', async () => {
  // One miss is one event. Sending it n times would also spend n claims against the runaway
  // ceiling and quietly change what every alert count means.
  const h = harness();
  const r = await sendAlerts(selectAlertable([row({})], 10 * 60), DATE, 'davis', h.io, alertRecipients([DISPATCH]));
  assert.equal(r.sent, 1);
  assert.equal(h.sends.length, 1, 'one event, one email');
  assert.deepEqual(h.sends[0].to, [ALERT_TO, DISPATCH]);
});

test('IT NEVER SENDS TO NOBODY — an empty list falls back to customer service', async () => {
  // An empty `to` makes Resend refuse every message while `failed` ticks up somewhere nobody
  // reads: the feature goes silent while looking healthy, which is the worse of the two
  // failures. Customer service is the floor because an alert reaching only them is the old
  // behaviour, and the old behaviour is recoverable.
  for (const empty of [[], ['', '   '], [null, undefined]]) {
    const h = harness();
    const r = await sendAlerts(selectAlertable([row({})], 10 * 60), DATE, 'davis', h.io, empty);
    assert.equal(r.sent, 1, `sent with ${JSON.stringify(empty)}`);
    assert.deepEqual(h.sends[0].to, [ALERT_TO]);
  }
});

test('THE DEPLOYED DEFAULT IS READ FROM THE ENVIRONMENT AND IS A LIST OF STRINGS', () => {
  // ALERT_CC binds at module load like the other alert knobs. This asserts its SHAPE, not its
  // contents — the contents are a deployment decision, and a test that pinned them would go
  // red the moment Chad set the variable.
  assert.ok(Array.isArray(ALERT_CC));
  for (const a of ALERT_CC) assert.equal(typeof a, 'string');
  assert.equal(alertRecipients()[0], ALERT_TO, 'customer service leads the real list too');
});
