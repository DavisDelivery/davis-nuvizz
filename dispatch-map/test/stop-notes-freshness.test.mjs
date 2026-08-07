// test/stop-notes-freshness.test.mjs
//
// Chad: "Notes should be updated with every scan planned unplanned and completed
// deliveries."
//
// The scans CAN now keep the list's note text current for free. What they cannot
// do is produce the rich notes the card renders (author/type/timestamp) — those
// live only in /stop/info, and an order is enriched exactly once, when its PRO
// first appears. So the list text becomes a tripwire for "the notes you are
// looking at are behind", and these tests pin it to fire on real changes and
// stay quiet otherwise. A stale-notes warning on every stop would be ignored
// within a day.
import test from 'node:test';
import assert from 'node:assert/strict';

import { noteTextChanged, noteFreshness, storedNoteText } from '../src/lib/stop-notes-freshness.js';

const cmt = (text) => ({ text, type: 'ORD_IN', typeDesc: 'Order Instructions', addedBy: 'INTG ULINE', addedOn: '2026-08-06T18:20:00' });

test('a note the list has and we do not is FLAGGED', () => {
  const stop = {
    allComments: [cmt('TOTAL-AMOUNT : 84.21')],
    orderInstructions: 'TOTAL-AMOUNT : 84.21 LIFT GATE NEEDED INSIDE DELIVERY',
  };
  assert.equal(noteTextChanged(stop), true, 'new instructions must surface');
  assert.equal(noteFreshness(stop).stale, true);
});

test('notes we already have are NOT flagged', () => {
  const stop = {
    allComments: [cmt('TOTAL-AMOUNT : 84.21'), cmt('LIFT GATE NEEDED')],
    orderInstructions: 'TOTAL-AMOUNT : 84.21 LIFT GATE NEEDED',
  };
  assert.equal(noteTextChanged(stop), false);
});

test('the list holding LESS than we do is never a change', () => {
  // The list collapses every comment into one string, so it routinely carries
  // less. Flagging that would mark nearly every stop stale and the warning would
  // be worthless inside a day.
  const stop = {
    allComments: [cmt('TOTAL-AMOUNT : 84.21'), cmt('DO NOT DELIVER DOUBLE STACKED'), cmt('INSIDE DELIVERY')],
    orderInstructions: 'TOTAL-AMOUNT : 84.21',
  };
  assert.equal(noteTextChanged(stop), false);
});

test('punctuation and spacing drift is not a change', () => {
  const stop = {
    allComments: [cmt('LIFT-GATE NEEDED;  INSIDE DELIVERY')],
    orderInstructions: 'LIFT-GATE NEEDED INSIDE DELIVERY',
  };
  assert.equal(noteTextChanged(stop), false);
});

test('one stray token is noise, not a new instruction', () => {
  const stop = {
    allComments: [cmt('DO NOT DELIVER DOUBLE STACKED INSIDE DELIVERY LIFT GATE NEEDED')],
    orderInstructions: 'DO NOT DELIVER DOUBLE STACKED INSIDE DELIVERY LIFT GATE NEEDED X7',
  };
  assert.equal(noteTextChanged(stop), false, 'a single unseen token must not cry wolf');
});

test('a stop we have NO notes for but the list does is flagged', () => {
  assert.equal(noteTextChanged({ allComments: [], orderInstructions: 'LIFT GATE NEEDED' }), true);
});

test('no list text means no claim either way', () => {
  assert.equal(noteTextChanged({ allComments: [cmt('LIFT GATE')], orderInstructions: null }), false);
  assert.equal(noteTextChanged({}), false);
  assert.equal(noteTextChanged(null), false);
  assert.equal(noteFreshness(null).stale, false);
});

test('storedNoteText reads both note sources', () => {
  const stop = { allComments: [cmt('A'), cmt('B')], signalSources: { orderInstructions: 'C' } };
  const t = storedNoteText(stop);
  for (const x of ['A', 'B', 'C']) assert.ok(t.includes(x), x);
});

test('noteFreshness carries the live text and the last write-back stamp', () => {
  const f = noteFreshness({ allComments: [], orderInstructions: 'LIFT GATE NEEDED', notes_refreshed_at: '2026-08-07T13:00:00Z' });
  assert.equal(f.liveText, 'LIFT GATE NEEDED');
  assert.equal(f.refreshedAt, '2026-08-07T13:00:00Z');
});
