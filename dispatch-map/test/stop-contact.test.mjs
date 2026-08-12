// test/stop-contact.test.mjs — the CUSTOMER # block on a stop card.
//
// Chad: "make a spot where the customer number is on normal orders — where if one of the
// orders doesn't have a customer name or number we can add it like we add notes."
//
// Orders we create carry a Phone field (New Order / Bulk Add). Orders that arrive from a
// carrier often carry nothing, and the card printed the contact line ONLY when a number
// already existed — so the one order that needed a number was the one with nowhere to put it.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDialable, samePhone, resolveStopContact, resolveStopPhone, orderContactAside, mergeSavedContact,
} from '../src/lib/stop-contact.js';

// ── what counts as a number ──────────────────────────────────────────────────

test('ten digits is the bar — a dock code is not a phone number', () => {
  assert.ok(isDialable('6788608099'));
  assert.ok(isDialable('(678) 860-8099'));
  assert.ok(isDialable('1-678-860-8099'));
  for (const junk of ['', null, undefined, 'N/A', '4412', '860-8099']) {
    assert.ok(!isDialable(junk), String(junk));
  }
});

test('the same number in different punctuation is the same number', () => {
  assert.ok(samePhone('6788608099', '(678) 860-8099'));
  assert.ok(samePhone('16788608099', '678.860.8099'), 'a leading 1 is not a different number');
  assert.ok(!samePhone('6788608099', '7705551212'));
  assert.ok(!samePhone('6788608099', ''), 'nothing is not equal to something');
});

// ── which contact the card prints ────────────────────────────────────────────

test('a saved number WINS over the order — that is why someone typed it', () => {
  const stop = { contact: { name: 'KAI WONG', phone: '6788608099' } };
  const note = { contacts: [{ name: 'RECEIVING', phone: '7705551212' }] };
  const c = resolveStopContact(stop, note);
  assert.equal(c.phone, '7705551212');
  assert.equal(c.name, 'RECEIVING');
  assert.equal(c.source, 'saved');
  assert.equal(resolveStopPhone(stop, note), '7705551212', 'Text and Call dial the same one');
});

test('NAME AND NUMBER COME FROM ONE SOURCE — no borrowed captions', () => {
  // The card used to print the ORDER's contact name beside whichever number won, so a
  // saved number appeared over the name of whoever NuVizz had on file. That attribution
  // was never in the data.
  const stop = { contact: { name: 'KAI WONG', phone: '6788608099' } };
  const note = { contacts: [{ name: '', phone: '7705551212' }] };
  const c = resolveStopContact(stop, note);
  assert.equal(c.phone, '7705551212');
  assert.equal(c.name, '', 'a saved number with no name is not attributed to KAI WONG');
});

test("the order's contact is used when nothing is saved", () => {
  const stop = { contact: { name: 'KAI WONG', phone: '6788608099' } };
  const c = resolveStopContact(stop, null);
  assert.equal(c.source, 'order');
  assert.equal(c.name, 'KAI WONG');
  assert.equal(c.dialable, true);
});

test('a saved contact with an UNDIALABLE number loses to the order’s real one', () => {
  const stop = { contact: { name: 'KAI WONG', phone: '6788608099' } };
  const note = { contacts: [{ name: 'DOCK', phone: '4412' }] };
  assert.equal(resolveStopContact(stop, note).phone, '6788608099');
  assert.equal(resolveStopPhone(stop, note), '6788608099');
});

test('a NAME with no number still prints — the missing part is the number', () => {
  const c = resolveStopContact({ contact: null }, { contacts: [{ name: 'ASK FOR MARIA', phone: '' }] });
  assert.equal(c.name, 'ASK FOR MARIA');
  assert.equal(c.dialable, false);
  assert.equal(c.source, 'saved');
  assert.equal(resolveStopPhone({ contact: null }, { contacts: [{ name: 'ASK FOR MARIA' }] }), '',
    'a name is not a number — Text still says "(add #)"');
});

test('THE CASE THE BLOCK EXISTS FOR: an order with no contact at all', () => {
  const c = resolveStopContact({ businessName: 'SHAPE INNOVATION' }, null);
  assert.deepEqual(c, { name: '', phone: '', role: '', source: null, dialable: false });
  assert.equal(resolveStopPhone({}, {}), '', 'and nothing to dial');
});

test('resolveStopPhone keeps its old contract exactly', () => {
  // Pinned because the Text/Call buttons and the SMS compose box all read it.
  assert.equal(resolveStopPhone({ contact: { phone: ' 6788608099 ' } }, null), '6788608099', 'trimmed');
  assert.equal(resolveStopPhone({ contact: { phone: '4412' } }, null), '', 'too short is no number');
  assert.equal(resolveStopPhone(null, null), '');
  assert.equal(
    resolveStopPhone({ contact: { phone: '6788608099' } }, { contacts: [{ phone: '' }, { phone: '7705551212' }] }),
    '7705551212',
    'the FIRST dialable saved contact wins, blanks skipped',
  );
});

// ── keeping the carrier's number visible ─────────────────────────────────────

test("overriding a number does not hide what the order says", () => {
  const stop = { contact: { name: 'KAI WONG', phone: '6788608099' } };
  const note = { contacts: [{ name: 'RECEIVING', phone: '7705551212' }] };
  const aside = orderContactAside(stop, resolveStopContact(stop, note));
  assert.deepEqual(aside, { name: 'KAI WONG', phone: '6788608099' });
});

test('no aside when there is nothing extra to say', () => {
  const stop = { contact: { name: 'KAI WONG', phone: '6788608099' } };
  assert.equal(orderContactAside(stop, resolveStopContact(stop, null)), null,
    'the order IS the shown contact');
  const same = { contacts: [{ name: 'KAI WONG', phone: '(678) 860-8099' }] };
  assert.equal(orderContactAside(stop, resolveStopContact(stop, same)), null,
    're-saving the same number is not a disagreement');
  assert.equal(orderContactAside({ contact: null }, resolveStopContact({}, same)), null);
});

// ── saving from the card ─────────────────────────────────────────────────────

test('adding a number to an order that had none creates the contact', () => {
  const next = mergeSavedContact(undefined, { name: 'ASK FOR MARIA', phone: '770 555 1212' });
  assert.deepEqual(next, [{ name: 'ASK FOR MARIA', phone: '770 555 1212', role: '' }]);
});

test('editing on the card edits the contact the card is SHOWING', () => {
  const contacts = [
    { name: 'RECEIVING', phone: '7705551212', role: 'dock' },
    { name: 'AFTER HOURS', phone: '4045550000', role: 'cell' },
  ];
  const next = mergeSavedContact(contacts, { name: 'RECEIVING DESK', phone: '7705559999' });
  assert.equal(next.length, 2);
  assert.deepEqual(next[0], { name: 'RECEIVING DESK', phone: '7705559999', role: 'dock' },
    'the role the notes editor saved survives the write');
  assert.deepEqual(next[1], contacts[1], 'the other contacts are left where they are');
  assert.equal(contacts[0].phone, '7705551212', 'the caller’s array is never mutated');
});

test('a name-only contact is filled in rather than duplicated', () => {
  const next = mergeSavedContact([{ name: 'ASK FOR MARIA', phone: '' }], { name: 'MARIA', phone: '7705551212' });
  assert.deepEqual(next, [{ name: 'MARIA', phone: '7705551212' }]);
});

test('an undialable saved row is the one edited, not skipped over', () => {
  const next = mergeSavedContact([{ name: 'DOCK', phone: '4412' }], { name: 'DOCK', phone: '7705551212' });
  assert.equal(next.length, 1, 'no second row for the same contact');
  assert.equal(next[0].phone, '7705551212');
});

test('clearing both fields removes the entry instead of saving a blank row', () => {
  const next = mergeSavedContact([{ name: 'RECEIVING', phone: '7705551212' }, { name: 'X', phone: '4045550000' }],
    { name: '  ', phone: '' });
  assert.deepEqual(next, [{ name: 'X', phone: '4045550000' }]);
  assert.deepEqual(mergeSavedContact([], { name: '', phone: '' }), [], 'clearing nothing is a no-op');
});

test('values are stored trimmed', () => {
  assert.deepEqual(mergeSavedContact([], { name: '  MARIA ', phone: ' 7705551212 ' }),
    [{ name: 'MARIA', phone: '7705551212', role: '' }]);
});
