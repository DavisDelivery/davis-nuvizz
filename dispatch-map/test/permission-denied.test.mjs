// test/permission-denied.test.mjs — THE BOARD MUST NOT LIE WHEN A RULE SAYS NO.
//
// The real-world event every test here is named for: a dispatcher opens the board at 6am,
// it looks completely normal, and every receiving hour, closed day, equipment restriction
// and SMS thread is missing because a Firestore rule refused the read and the handler
// returned an empty Map. Nothing on the screen disagrees with an empty Map. It is found
// when a truck arrives at a dock that shut at 2pm.
//
// The other half is the opposite mistake: a bar that lights every time a phone crosses a
// dead spot on the yard is wallpaper inside a week, and then it hides the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFirestoreError, isPermissionDenied, reportDenied, deniedSurfaces,
  subscribeDenied, clearDenied, surfaceLabel, SURFACE_LABELS,
} from '../src/lib/permission-denied.js';

const err = (code, message = '') => Object.assign(new Error(message || code), { code, name: 'FirebaseError' });

test('A TRUCK AT A CLOSED DOCK: a refused customer_notes read is reported, not swallowed', () => {
  clearDenied();
  assert.equal(reportDenied('customer_notes', err('permission-denied')), true);
  const [row] = deniedSurfaces();
  assert.equal(row.key, 'customer_notes');
  assert.equal(row.mode, 'read');
  assert.match(row.label, /receiving hours/i, 'and it says what is missing in freight words');
});

test('A DEAD SPOT ON THE YARD IS NOT AN ALARM — offline errors stay silent', () => {
  // onSnapshot reconnects by itself; a bar for every dropped connection is wallpaper, and
  // wallpaper is what hides the denial that actually matters.
  clearDenied();
  for (const c of ['unavailable', 'cancelled', 'deadline-exceeded', 'aborted', 'internal', 'resource-exhausted', 'unknown']) {
    assert.equal(classifyFirestoreError(err(c)), 'transient', c);
    assert.equal(reportDenied('customer_notes', err(c)), false, c);
  }
  assert.deepEqual(deniedSurfaces(), [], 'nothing reached the bar');
});

test('"unauthenticated" is a denial too — nobody signed in is a person who can act', () => {
  // It reads differently from a rules refusal in the console, but the remedy on screen is
  // the same one: sign in. Treating it as transient would wait forever for a reconnection
  // that fixes nothing.
  assert.equal(classifyFirestoreError(err('unauthenticated')), 'denied');
  assert.equal(isPermissionDenied(err('firestore/permission-denied')), true, 'product prefix tolerated');
  assert.equal(isPermissionDenied(err('PERMISSION-DENIED')), true, 'case tolerated');
});

test('A RE-WRAPPED ERROR THAT LOST ITS CODE IS STILL CAUGHT BY ITS SENTENCE', () => {
  // Promise.all and batch.commit both re-wrap; losing the classification there would put us
  // straight back in the silent-board failure. "Missing or insufficient permissions." is the
  // exact sentence the Firestore Web SDK writes on a rules refusal.
  assert.equal(isPermissionDenied(new Error('Missing or insufficient permissions.')), true);
  // But ONLY as a second signal. A real code always wins, so a transient error whose message
  // happens to quote that phrase is not promoted into an alarm.
  assert.equal(classifyFirestoreError(err('unavailable', 'missing or insufficient permissions')), 'transient');
});

test('nothing unusual is treated as a denial — not-found, invalid-argument, a bare Error', () => {
  for (const c of ['not-found', 'invalid-argument', 'failed-precondition', 'already-exists']) {
    assert.equal(classifyFirestoreError(err(c)), 'other', c);
    assert.equal(isPermissionDenied(err(c)), false, c);
  }
  assert.equal(isPermissionDenied(new Error('boom')), false);
  assert.equal(isPermissionDenied(null), false, 'and no error at all is not a denial');
  assert.equal(isPermissionDenied(undefined), false);
  assert.equal(isPermissionDenied({}), false);
});

test('A RETRYING LISTENER REPORTS ONCE, NOT ONCE A SECOND', () => {
  // onSnapshot re-fires its error handler on every reconnection attempt. Without this, a
  // denied collection re-renders the whole app in a loop while the board is already broken.
  clearDenied();
  let notifications = 0;
  const off = subscribeDenied(() => { notifications += 1; });
  const before = notifications;                       // subscribe fires once immediately
  for (let i = 0; i < 25; i += 1) reportDenied('sms_messages', err('permission-denied'));
  assert.equal(deniedSurfaces().length, 1);
  assert.equal(notifications - before, 1, 'exactly one re-render for twenty-five refusals');
  off();
});

test('A FAILED SAVE OUTRANKS A MISSING READ', () => {
  // Ordering is not decoration. "The board is missing X" is a standing condition; "the pin
  // you just dragged onto the right door did NOT save" is a thing the dispatcher believes
  // happened and did not. It goes first.
  clearDenied();
  reportDenied('customer_notes', err('permission-denied'), 'read');
  reportDenied('sms_messages', err('permission-denied'), 'read');
  reportDenied('customer_notes:location_override', err('permission-denied'), 'write');
  const rows = deniedSurfaces();
  assert.equal(rows[0].mode, 'write');
  assert.equal(rows[0].key, 'customer_notes:location_override');
  assert.equal(rows.filter((r) => r.mode === 'read').length, 2);
});

test('the same collection denied for READ and for WRITE is two separate reports', () => {
  // They are two different sentences to the dispatcher — "you cannot see it" and "your edit
  // did not save" — and collapsing them would drop one of them.
  clearDenied();
  reportDenied('customer_notes', err('permission-denied'), 'read');
  reportDenied('customer_notes', err('permission-denied'), 'write');
  assert.equal(deniedSurfaces().length, 2);
});

test('every surface the app reports has a sentence a dispatcher can act on', () => {
  // A bar reading "routing_customer_drivers is denied" teaches nobody anything at 6am.
  for (const [key, label] of Object.entries(SURFACE_LABELS)) {
    assert.ok(label.length > 8, key);
    assert.ok(!/_/.test(label), `${key}: no collection names in the words a person reads`);
  }
  // And an UNLISTED surface still reports rather than disappearing — a new collection going
  // dark is exactly the case where a silent fallback hides the next one of these.
  clearDenied();
  reportDenied('some_new_collection', err('permission-denied'));
  assert.equal(deniedSurfaces().length, 1);
  assert.equal(surfaceLabel('some_new_collection'), 'some_new_collection');
});

test('signing in clears the previous person’s refusals', () => {
  // A viewer who could not read the SMS threads signs out; a dispatcher signs in on the same
  // machine and must not inherit a bar about a collection they can read perfectly well.
  clearDenied();
  reportDenied('sms_messages', err('permission-denied'));
  assert.equal(deniedSurfaces().length, 1);
  clearDenied();
  assert.deepEqual(deniedSurfaces(), []);
});

test('a listener that throws cannot stop the others being told', () => {
  clearDenied();
  let reached = false;
  const offBad = subscribeDenied(() => { throw new Error('bad listener'); });
  const offGood = subscribeDenied(() => { reached = true; });
  reached = false;
  reportDenied('truck_profiles', err('permission-denied'));
  assert.equal(reached, true);
  offBad(); offGood(); clearDenied();
});
