// test/customer-notes-edit-only-changed.test.mjs — A STOP LOOKUP SAVE WRITES WHAT THE REP
// CHANGED, NOT THE WHOLE DOCUMENT AS IT STOOD WHEN EDIT WAS PRESSED.
//
// Audit 2026-09-27 (app-A4-3): openEdit seeds the draft with { ...emptyNote(), ...snap.data() }
// and saveEdit wrote setDoc(ref, { ...draft, … }, { merge: true }). A merge only protects keys
// ABSENT from the payload, and that payload carried every key — so anything another writer
// changed while the form was open was written back with its open-time value. The panel's own
// comment promised the pin override, the comms opt-out and pro_history "cannot be erased by
// saving from here". Two real interleavings:
//   (a) the customer clicks unsubscribe while a rep types Friday hours; unsubscribe.mts patches
//       comms_opt_out:true; the rep's Save writes emptyNote's comms_opt_out:false back, and the
//       customer is silently re-subscribed to delivery-complete emails.
//   (b) a dispatcher drags the pin to the right door; the rep's Save writes the old
//       location_override back and the stops return to the wrong building.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liftFromApp } from './helpers/app-lift.mjs';
import { changedNoteFields } from '../src/lib/customer-note-edit.js';

const { emptyNote } = liftFromApp({ targets: ['emptyNote'], exercise: (l) => l.emptyNote({}) });
const base = () => emptyNote({ businessName: 'EARTHLY ALTERNATIVE', addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336', matchKey: 'k' });

// Firestore's setDoc(…, { merge: true }): nested maps merge key by key, everything else replaces.
const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
function mergeWrite(stored, payload) {
  const out = { ...stored };
  for (const [k, v] of Object.entries(payload)) out[k] = isMap(v) && isMap(out[k]) ? mergeWrite(out[k], v) : v;
  return out;
}
// What StopNotesEditor's setHours does to the draft when a rep types Friday's close.
const typeFridayHours = (d) => ({
  ...d,
  receiving_hours: { ...d.receiving_hours, fri: { open: '08:00', close: '12:00' } },
  manual_overrides: { ...(d.manual_overrides || {}), receiving_hours: true },
});

test('a customer who unsubscribes while a rep has the editor open stays unsubscribed after the rep saves Friday hours', () => {
  const stored = { match_key: 'k', dock_notes: 'Use the BACK dock' };      // no comms_opt_out yet
  const seed = { ...base(), ...stored };                                     // what openEdit seeds
  const draft = typeFridayHours(seed);
  const afterUnsubscribe = mergeWrite(stored, { comms_opt_out: true, comms_opt_out_source: 'customer' });
  const after = mergeWrite(afterUnsubscribe, changedNoteFields(draft, seed));
  assert.equal(after.comms_opt_out, true, 're-subscribed by a save that never touched the toggle');
  assert.equal(after.comms_opt_out_source, 'customer');
  assert.deepEqual(after.receiving_hours.fri, { open: '08:00', close: '12:00' }, 'the rep’s hours landed');
});

test('a pin a dispatcher moved while the form was open is not dragged back by the save', () => {
  const P0 = { lat: 33.7000, lng: -84.5000 };
  const P1 = { lat: 33.7105, lng: -84.5101 };
  const stored = { match_key: 'k', location_override: P0, location_override_at: { seconds: 1 } };
  const seed = { ...base(), ...stored };
  const draft = typeFridayHours(seed);
  const moved = mergeWrite(stored, { location_override: P1, location_override_at: { seconds: 2 } });
  const after = mergeWrite(moved, changedNoteFields(draft, seed));
  assert.deepEqual(after.location_override, P1);
  assert.deepEqual(after.location_override_at, { seconds: 2 });
});

test('only the keys the rep changed are in the write', () => {
  const seed = { ...base(), match_key: 'k', pro_history: [{ pro: '1', date: '2026-09-01' }], do_not_send: false };
  const draft = { ...typeFridayHours(seed), dock_notes: 'Ring the bell' };
  assert.deepEqual(Object.keys(changedNoteFields(draft, seed)).sort(), ['dock_notes', 'manual_overrides', 'receiving_hours']);
});

test('a field the rep toggled on and back off again is not written', () => {
  const seed = { ...base(), match_key: 'k' };
  const draft = { ...seed, do_not_send: !seed.do_not_send };
  const back = { ...draft, do_not_send: seed.do_not_send };
  assert.deepEqual(changedNoteFields(back, seed), {});
});

test('a toggle the rep DID press is written, including turning the opt-out off', () => {
  const seed = { ...base(), comms_opt_out: true };
  assert.deepEqual(changedNoteFields({ ...seed, comms_opt_out: false }, seed), { comms_opt_out: false });
});

test('a stored Timestamp the form never touched is not rewritten', () => {
  const ts = { seconds: 5, nanoseconds: 0, isEqual(o) { return !!o && o.seconds === 5 && o.nanoseconds === 0; } };
  const seed = { ...base(), last_updated: ts };
  const draft = { ...seed, last_updated: { ...ts } };   // a different object, the same instant
  assert.deepEqual(changedNoteFields(draft, seed), {});
});

test('an empty or absent draft writes nothing, never the seed', () => {
  assert.deepEqual(changedNoteFields(null, base()), {});
  assert.deepEqual(changedNoteFields(undefined, undefined), {});
});

// ── THE WIRING: the Stop lookup save sends the change set, not the draft ─────────────────────

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const SAVE = APP.slice(APP.indexOf('const saveEdit = useCallback'), APP.indexOf('/** The rep picked one of several matching businesses. */'));
const OPEN = APP.slice(APP.indexOf('const openEdit = useCallback'), APP.indexOf('const cancelEdit = useCallback'));

test('the Stop lookup save writes changedNoteFields(draft, seed), never ...draft', () => {
  const write = SAVE.slice(SAVE.indexOf('await setDoc(ref, {'), SAVE.indexOf('}, { merge: true })'));
  assert.doesNotMatch(write, /\.\.\.draft,/);
  assert.match(write, /\.\.\.changedNoteFields\(draft, editSeed\),/);
});

test('the seed the save diffs against is exactly what the form opened on', () => {
  assert.match(OPEN, /const seed = snap\.exists\(\) \? \{ \.\.\.base, \.\.\.snap\.data\(\) \} : base;/);
  assert.match(OPEN, /setEditDraft\(seed\);/);
  assert.match(OPEN, /setEditSeed\(seed\);/);
  // …and the no-database path diffs against the same base it opened on.
  assert.match(OPEN, /setEditSeed\(base\);/);
});
