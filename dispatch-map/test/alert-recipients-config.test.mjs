// WHO GETS TEXTED AND WHO GETS EMAILED — THE LIST CHAD CAN NOW EDIT.
//
// Chad, 2026-09-09: "We are sending texts alerts for different things and i think we need to
// build a ui in the diagnostics where i can add more numbers or remove numbers from who gets
// texted same thing for emails need to build a ui in same place so can control that as well."
//
// Five recipient lists lived in environment variables that nobody could see from the app and
// nobody could change without a redeploy. That is the same shape as the defect that cost an
// evening in September — Chad was not on the miss-window email, both emails had in fact been
// delivered, and from an inbox "the mailer is broken" and "you are not on the list" look
// identical. Making the list configurable did not make it READABLE.
//
// These tests pin the rules that make the screen trustworthy. The dangerous property of a
// recipient editor is not that it might refuse a good address — you find that out
// immediately. It is that it might accept one and then not use it, or drop one and not say
// so, and either failure is invisible until the night somebody needed the message.
//
// EVERY FIXTURE IS DERIVED OR FICTIONAL. Addresses compose role words onto the SHIPPED
// allowlist (never a person, never typed out), because Netlify's secrets scan greps the repo
// for env-var values as plain bytes and a lifelike company address has broken main's deploy
// four times — test/no-lifelike-addresses.test.mjs now fails the build for one. Phone numbers
// come from 555-01xx, the range reserved for fiction, so nothing here is anybody's phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECIPIENT_CHANNELS, CHANNEL_KEYS, MAX_PER_CHANNEL, ALERT_INTERNAL_SUFFIXES, COMPANY_CS_ADDRESS,
  splitEntries, normalizeEntry, parseRecipientList, clampAlertRecipients,
  resolveChannel, resolveAllChannels, recipientsFor, channelSpec, internalEmail,
} from '../netlify/functions/lib/alert-recipients.mts';
import { ALERT_TO } from '../netlify/functions/lib/flag-alert.mts';
import { CS_DEFAULT_TO } from '../netlify/functions/lib/cs-notify.mts';

const [PRIMARY_SUFFIX, ALT_SUFFIX] = ALERT_INTERNAL_SUFFIXES;
const at = (role, suffix = PRIMARY_SUFFIX) => `${role}${suffix}`;
const DISPATCH = at('dispatch');
const OPS = at('ops');
const WAREHOUSE = at('warehouse');
const OUTSIDE = 'someone@example.com';

// 555-01xx: reserved for fiction. Not anybody's phone, and it cannot collide with a real
// env-var value the secrets scan is looking for.
const P1 = '6785550101';
const P2 = '6785550102';
const P3 = '6785550103';

const spec = (k) => channelSpec(k);

// ── THE REGISTRY IS ONE REGISTRY ────────────────────────────────────────────

test('THE FLOORS ARE THE SAME ADDRESS THE SENDERS ALREADY USE — a second copy would drift', () => {
  // COMPANY_CS_ADDRESS is the floor under two channels and is printed on the screen as the
  // thing nobody can remove. If it ever stopped being the address flag-alert and cs-notify
  // actually send to, the screen would be describing a system that does not exist.
  assert.equal(COMPANY_CS_ADDRESS, ALERT_TO);
  assert.equal(CS_DEFAULT_TO, ALERT_TO, 'cs-notify and the miss-window email share one desk');
});

test('every channel declares the five things the screen has to say about it', () => {
  // A box of addresses with no answer to "when does this fire" is a box nobody can judge.
  assert.equal(RECIPIENT_CHANNELS.length, 5);
  for (const c of RECIPIENT_CHANNELS) {
    assert.ok(c.key && c.envVar && c.label, `${c.key} needs a key, an env var and a label`);
    assert.ok(['sms', 'email'].includes(c.kind), `${c.key} kind`);
    assert.ok(c.when.length > 20, `${c.key} must say WHEN it fires, in words a dispatcher uses`);
    assert.ok(c.emptyNote.length > 20, `${c.key} must say what happens when the list is empty`);
  }
  assert.deepEqual(CHANNEL_KEYS.length, new Set(CHANNEL_KEYS).size, 'keys are unique');
});

// ── WHAT AN ENTRY IS ────────────────────────────────────────────────────────

test('ONE SEPARATOR RULE, because there were four — a paste that worked in one var and broke in another', () => {
  // parseAlertCc split on comma/semicolon/newline; flag-sms, cs-notify and the comms test
  // allowlist each split on comma alone. The same pasted list therefore produced one garbage
  // recipient in three of the four, with no diagnostic anywhere.
  assert.deepEqual(splitEntries(`  ${DISPATCH} ;\n ${OPS},\t${WAREHOUSE}  `), [DISPATCH, OPS, WAREHOUSE]);
  for (const empty of [undefined, null, '', '   ', ',', ';;', '\n', ' , ; \n ']) {
    assert.deepEqual(splitEntries(empty), [], `${JSON.stringify(empty)} is nothing, not an entry`);
  }
});

test('A PHONE IS JUDGED BY THE SAME RULE THE SENDER USES — not a second, looser copy in the UI', () => {
  // normalizePhone/validUsPhone are lib/sms.mts's, the ones SimpleTexting is actually handed.
  // A field that accepts what the transport refuses is how you get a saved recipient that
  // fails at 9pm with nobody watching.
  assert.equal(normalizeEntry('678-555-0101', 'sms').value, P1, 'punctuation normalised');
  assert.equal(normalizeEntry('(678) 555 0101', 'sms').value, P1);
  assert.equal(normalizeEntry('+1 678 555 0101', 'sms').value, P1, 'country code stripped');
  assert.equal(normalizeEntry('16785550101', 'sms').value, P1);
  for (const bad of ['555', 'not a phone', '', '   ', '678555010', '00000000000000']) {
    assert.equal(normalizeEntry(bad, 'sms').value, null, `${JSON.stringify(bad)} must not be dialled`);
  }
  assert.match(normalizeEntry('555', 'sms').reason, /10-digit/, 'the refusal tells the typist what to do');
});

test('AN OUTSIDE ADDRESS IS REFUSED — this message names a customer and says we are about to miss them', () => {
  // The body carries the consignee's name, its PRO, its route and the fact that Davis is going
  // to blow their receiving window. One typo must not put that in a stranger's inbox.
  assert.equal(normalizeEntry(DISPATCH, 'email').value, DISPATCH);
  assert.equal(normalizeEntry(at('dispatch', ALT_SUFFIX), 'email').value, at('dispatch', ALT_SUFFIX));
  assert.equal(normalizeEntry(OUTSIDE, 'email').value, null);
  assert.match(normalizeEntry(OUTSIDE, 'email').reason, /outside/);
  // Typed in caps, stored in lower case: the same mailbox must not be able to appear twice on
  // one list because somebody's phone capitalised it.
  assert.equal(normalizeEntry(`  ${DISPATCH.toUpperCase()}  `, 'email').value, DISPATCH);
});

test('A LOOKALIKE DOMAIN IS NOT AN INTERNAL DOMAIN', () => {
  // endsWith() against a bare domain would have accepted every one of these. The shipped
  // suffixes carry the '@' for exactly this reason.
  const domain = PRIMARY_SUFFIX.slice(1);
  for (const bad of [
    `ops@not-${domain}`,              // a longer domain that merely ends with ours
    `${OPS}.example.net`,             // ours used as a subdomain of somebody else's
    domain,                           // no local part, no '@' at all
    `ops@${domain.slice(0, -1)}`,     // one character short of the real TLD
  ]) {
    assert.equal(internalEmail(bad), false, `${bad} must not be accepted`);
  }
});

test('NOBODY IS ON A LIST TWICE, AND A REFUSAL IS NAMED RATHER THAN SWALLOWED', () => {
  // A recipient who quietly disappears recreates the precise failure this whole area exists to
  // end: somebody who believes they are on the list and never gets mail.
  const r = parseRecipientList([DISPATCH, DISPATCH.toUpperCase(), OUTSIDE, 'ops at somewhere'], 'email');
  assert.deepEqual(r.accepted, [DISPATCH], 'deduped case-insensitively');
  assert.equal(r.rejected.length, 2);
  assert.ok(r.rejected.some((x) => x.value === OUTSIDE && /outside/.test(x.reason)));
  assert.ok(r.rejected.every((x) => x.reason), 'every refusal carries a reason a human can act on');
});

test('THE LIST HAS A CEILING, AND GOING OVER IT IS REFUSED LOUDLY RATHER THAN TRUNCATED', () => {
  // The evening sweep sends one SimpleTexting call PER RECIPIENT per row, so a pasted
  // spreadsheet column is a bill. Silently keeping the first 25 would be the worse failure:
  // everyone past the cut believes they are on a list they are not on.
  const many = Array.from({ length: MAX_PER_CHANNEL + 3 }, (_, i) => `678555${String(1000 + i).padStart(4, '0')}`);
  const r = parseRecipientList(many, 'sms');
  assert.equal(r.accepted.length, MAX_PER_CHANNEL);
  assert.equal(r.rejected.length, 3);
  assert.match(r.rejected[0].reason, new RegExp(`${MAX_PER_CHANNEL}`));
});

// ── THE PROMISE: NOTHING SAVED, NOTHING CHANGES ─────────────────────────────

test('WITH NOTHING SAVED, EVERY CHANNEL ALERTS EXACTLY WHO IT ALERTED BEFORE THIS EXISTED', () => {
  // The whole feature is a liability if merely shipping it can change who gets mailed on a
  // site where nobody has opened the screen. Every shape of "no document" must read the same.
  const env = { FLAG_SMS_TO: P1, FLAG_SMS_TO_NIGHT: P2, ALERT_CC: DISPATCH, NOTIFY_CS_TO: OPS, DAY_REPORT_TO: WAREHOUSE };
  for (const stored of [null, undefined, {}, { updatedAt: 'x' }, 'not an object', 42]) {
    assert.deepEqual(recipientsFor('flagSmsTo', stored, env), [P1], `flagSmsTo with ${JSON.stringify(stored)}`);
    assert.deepEqual(recipientsFor('flagSmsToNight', stored, env), [P2]);
    assert.deepEqual(recipientsFor('alertCc', stored, env), [ALERT_TO, DISPATCH]);
    assert.deepEqual(recipientsFor('notifyCsTo', stored, env), [OPS]);
    assert.deepEqual(recipientsFor('dayReportTo', stored, env), [WAREHOUSE]);
  }
});

test('AN OUTSIDE ADDRESS ALREADY IN NOTIFY_CS_TO OR DAY_REPORT_TO KEEPS GETTING MAIL — AND IS FLAGGED', () => {
  // THIS IS THE CAREFUL ONE. Those two variables have never validated anything. Turning the
  // allowlist on over a value already sitting in the Netlify console would silently stop
  // mailing somebody who is being mailed today — a change nobody asked for, found out by
  // whoever stops getting the report. So they stay live and the screen says so instead.
  const env = { NOTIFY_CS_TO: OUTSIDE, DAY_REPORT_TO: OUTSIDE };
  for (const key of ['notifyCsTo', 'dayReportTo']) {
    const r = resolveChannel(spec(key), null, env);
    assert.deepEqual(r.recipients, [OUTSIDE], `${key} must not silently stop mailing an address it mails today`);
    assert.equal(r.envWarned.length, 1, `${key} must FLAG it`);
    assert.match(r.envWarned[0].reason, /outside/);
    assert.deepEqual(r.envRejected, [], 'flagged is not refused');
  }
  // ALERT_CC is the exception that proves the rule: it has enforced the allowlist since
  // 2026-09-03, so enforcing it here changes nothing at all.
  const cc = resolveChannel(spec('alertCc'), null, { ALERT_CC: OUTSIDE });
  assert.deepEqual(cc.recipients, [ALERT_TO], 'ALERT_CC already refused outside addresses');
  assert.equal(cc.envRejected.length, 1, 'and named the refusal');
});

test('AN ENV ENTRY THAT COULD NEVER BE SENT IS DROPPED EVERYWHERE — keeping it would poison the message', () => {
  // Resend refuses the WHOLE message when one recipient is malformed, so "preserving" a
  // garbage entry would take the valid recipients down with it. Same for a phone the
  // transport cannot dial.
  const bad = resolveChannel(spec('notifyCsTo'), null, { NOTIFY_CS_TO: `ops at somewhere, ${OPS}` });
  assert.deepEqual(bad.recipients, [OPS]);
  assert.equal(bad.envRejected.length, 1);
  const phone = resolveChannel(spec('flagSmsTo'), null, { FLAG_SMS_TO: `nope, ${P1}` });
  assert.deepEqual(phone.recipients, [P1]);
  assert.equal(phone.envRejected.length, 1);
});

// ── THE POINT OF THE SCREEN: A SAVED LIST WINS ──────────────────────────────

test('A SAVED LIST BEATS THE ENVIRONMENT, per channel, without touching its neighbours', () => {
  const env = { FLAG_SMS_TO: P1, FLAG_SMS_TO_NIGHT: P2 };
  const stored = { flagSmsTo: [P3] };
  assert.deepEqual(recipientsFor('flagSmsTo', stored, env), [P3], 'the edited channel');
  assert.deepEqual(recipientsFor('flagSmsToNight', stored, env), [P2], 'the untouched one still reads env');
  assert.equal(resolveChannel(spec('flagSmsTo'), stored, env).source, 'saved');
  assert.equal(resolveChannel(spec('flagSmsToNight'), stored, env).source, 'env');
});

test('CLEARED MEANS CLEARED — a control that reverts to an env var when you empty it is a control that lies', () => {
  // This is decision 1, and it is the difference between a screen and a decoration. If Chad
  // deletes every number from the flag texts, the flag texts stop.
  const env = { FLAG_SMS_TO: P1, DAY_REPORT_TO: WAREHOUSE, ALERT_CC: DISPATCH };
  assert.deepEqual(recipientsFor('flagSmsTo', { flagSmsTo: [] }, env), []);
  assert.deepEqual(recipientsFor('dayReportTo', { dayReportTo: [] }, env), []);
  assert.deepEqual(recipientsFor('alertCc', { alertCc: [] }, env), [ALERT_TO], 'the TO line is not a member of the CC list');
  // "never set" and "set to nothing" are different documents and must stay different.
  assert.equal(resolveChannel(spec('flagSmsTo'), { flagSmsTo: [] }, env).source, 'saved');
  assert.equal(resolveChannel(spec('flagSmsTo'), {}, env).source, 'env');
});

test('EXCEPT WHERE EMPTY WOULD SWITCH OFF SOMEBODY ELSE\'S FEATURE — the CS notice keeps its floor', () => {
  // This notice is addressed TO the desk that acts on it. Emptying the box does not mean
  // "stop telling customer service"; it means somebody cleared a box. csRecipients() has
  // always had this floor and the screen prints it beside the list.
  const r = resolveChannel(spec('notifyCsTo'), { notifyCsTo: [] }, {});
  assert.deepEqual(r.recipients, [COMPANY_CS_ADDRESS]);
  assert.equal(r.floorApplied, true, 'and the screen is told the floor is what is carrying it');
  assert.deepEqual(r.list, [], 'the editable list is still empty — the floor is not a phantom row');
});

test('CUSTOMER SERVICE LEADS THE MISS-WINDOW EMAIL AND CANNOT BE DUPLICATED OFF THE CC', () => {
  // Not cosmetic. Two names on the TO line is two people phoning the consignee, or neither
  // because each assumed the other had. Putting customerservice@ in the CC is the obvious
  // thing to try and must not send that mailbox two copies of every miss.
  assert.deepEqual(recipientsFor('alertCc', { alertCc: [DISPATCH, OPS] }, {}), [ALERT_TO, DISPATCH, OPS]);
  assert.deepEqual(recipientsFor('alertCc', { alertCc: [ALERT_TO, DISPATCH] }, {}), [ALERT_TO, DISPATCH]);
  assert.equal(recipientsFor('alertCc', {}, {})[0], ALERT_TO, 'first, always');
});

test('A STORED DOCUMENT IS RE-VALIDATED ON EVERY READ — the write gate protects the path, not the document', () => {
  // Under the live firestore.rules every nuvizz_ops document is writable by anyone holding the
  // Firebase web config out of the public bundle. Validating only on write would let a
  // stranger put an outside address on an email that names a customer, its PRO and its route.
  const tampered = { alertCc: [OUTSIDE, DISPATCH], flagSmsTo: ['not-a-phone', P1] };
  assert.deepEqual(recipientsFor('alertCc', tampered, {}), [ALERT_TO, DISPATCH], 'the outside address never reaches a send');
  assert.deepEqual(recipientsFor('flagSmsTo', tampered, {}), [P1]);
  // And it is NAMED, not vanished — the screen shows what is on the document and unusable.
  const r = resolveChannel(spec('alertCc'), tampered, {});
  assert.equal(r.savedRejected.length, 1);
  assert.equal(r.savedRejected[0].value, OUTSIDE);
});

// ── WHAT THE ENDPOINT MAY STORE ─────────────────────────────────────────────

test('A BODY NAMING ONE CHANNEL EDITS ONE CHANNEL — a partial save must not clear the others', () => {
  // The write is field-masked for this reason. Two people editing two lists in two tabs is an
  // ordinary Tuesday, and the second save must not delete the first person's phone numbers.
  const { config } = clampAlertRecipients({ flagSmsTo: [P1] });
  assert.deepEqual(Object.keys(config), ['flagSmsTo']);
  assert.deepEqual(config.flagSmsTo, [P1]);
});

test('AN EMPTY ARRAY IS AN EDIT; null AND ABSENT ARE NOT', () => {
  assert.deepEqual(clampAlertRecipients({ flagSmsTo: [] }).config, { flagSmsTo: [] }, 'send to nobody is a thing you can say');
  assert.deepEqual(clampAlertRecipients({ flagSmsTo: null }).config, {}, 'null means leave it alone');
  assert.deepEqual(clampAlertRecipients({}).config, {});
  for (const junk of [null, undefined, 'a string', 42, []]) {
    assert.deepEqual(clampAlertRecipients(junk).config, {}, `${JSON.stringify(junk)} is not a body`);
  }
});

test('AN UNKNOWN KEY IS IGNORED — the body cannot write fields nobody declared', () => {
  const { config } = clampAlertRecipients({ flagSmsTo: [P1], updatedBy: 'x', someoneElse: ['a'], __proto__: ['b'] });
  assert.deepEqual(Object.keys(config), ['flagSmsTo']);
});

test('WHAT THE SAVE REFUSED COMES BACK PER CHANNEL, so the screen can point at the field', () => {
  const { config, rejected } = clampAlertRecipients({ flagSmsTo: [P1, 'nope'], alertCc: [OUTSIDE] });
  assert.deepEqual(config.flagSmsTo, [P1]);
  assert.deepEqual(config.alertCc, []);
  assert.equal(rejected.flagSmsTo.length, 1);
  assert.equal(rejected.alertCc.length, 1);
  assert.equal(rejected.flagSmsTo[0].value, 'nope');
});

test('A PASTED BLOCK IS ACCEPTED AS A LIST — people paste, they do not type one per box', () => {
  const { config } = clampAlertRecipients({ alertCc: [`${DISPATCH}, ${OPS}\n${WAREHOUSE}`] });
  assert.deepEqual(config.alertCc, [DISPATCH, OPS, WAREHOUSE]);
});

// ── THE PAYLOAD THE SCREEN RENDERS ──────────────────────────────────────────

test('EVERY CHANNEL RESOLVES TO SOMETHING THE SCREEN CAN PRINT, on an empty document and an empty env', () => {
  // A blank panel would read as "nobody is alerted", which is a different claim from "nothing
  // is configured" and only one of them is true.
  const all = resolveAllChannels({}, {});
  assert.equal(all.length, 5);
  for (const c of all) {
    assert.ok(Array.isArray(c.recipients) && Array.isArray(c.list));
    assert.ok(['saved', 'env', 'unset'].includes(c.source));
    assert.ok(typeof c.floorApplied === 'boolean');
  }
  // With nothing anywhere, only the two floored/always channels reach a mailbox.
  assert.deepEqual(all.find((c) => c.key === 'alertCc').recipients, [ALERT_TO]);
  assert.deepEqual(all.find((c) => c.key === 'notifyCsTo').recipients, [COMPANY_CS_ADDRESS]);
  assert.deepEqual(all.find((c) => c.key === 'flagSmsTo').recipients, []);
});

test('THE SCREEN AND THE SENDER READ THE SAME FUNCTION — a number displayed by one path and enforced by another is a number nobody can trust', () => {
  // The daily ceiling learned this the hard way, three times: a Diagnostics field that took one
  // number and enforced another. `recipients` on the payload IS what the sender addresses.
  const stored = { flagSmsTo: [P1, P2], alertCc: [DISPATCH], notifyCsTo: [] };
  for (const c of resolveAllChannels(stored, { FLAG_SMS_TO: P3 })) {
    assert.deepEqual(c.recipients, recipientsFor(c.key, stored, { FLAG_SMS_TO: P3 }), `${c.key} must not have two answers`);
  }
});
