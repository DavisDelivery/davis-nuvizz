// test/account-reset-email-failed.test.mjs
//
// A RESET EMAIL THAT DID NOT GO OUT WAS NEVER MENTIONED (audit 2026-09-27,
// client-lookup-account-libs-5).
//
// "Email a reset link" signs the person out everywhere and sets a new password to be chosen
// BEFORE the email is sent (auth-users.mts, the reset branch). When the mail provider refuses
// that send, the server still answers { ok: true, emailed: false, tempPassword: null }. The
// Account screen showed a note only for tempPassword or emailed — so the panel closed with no
// word at all, the admin told the person to check their inbox, and nothing ever arrived.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resetAnswer } from '../src/lib/account-view.js';

test('a reset email the mail provider refused is told to the admin, with the way round it', () => {
  const out = resetAnswer({ ok: true, emailed: false, tempPassword: null }, { email: 'jdoe@davis.example', asked: 'email' });
  assert.ok(out?.error, 'the admin is told something went wrong');
  assert.match(out.error, /jdoe@davis\.example/);
  assert.match(out.error, /did not go out/);
  assert.match(out.error, /signed out everywhere/, 'the sign-out already happened, so it is said');
  assert.match(out.error, /New temporary password/, 'names the button that gets them back in');
  assert.equal(out.note, undefined, 'never a success note beside it');
});

test('a reset email that went out says so, naming the address', () => {
  assert.deepEqual(resetAnswer({ ok: true, emailed: true, tempPassword: null }, { email: 'jdoe@davis.example', asked: 'email' }),
    { note: 'Reset link emailed to jdoe@davis.example.' });
});

test('a temporary password comes back as the password to show — whichever button was pressed', () => {
  // With no address on file (or mail switched off) the server hands back a temporary password
  // even for "Email a reset link"; the box that shows it is the right answer either way.
  assert.deepEqual(resetAnswer({ ok: true, emailed: false, tempPassword: 'Tmp-1234' }, { asked: 'temp' }), { temp: 'Tmp-1234' });
  assert.deepEqual(resetAnswer({ ok: true, emailed: false, tempPassword: 'Tmp-1234' }, { asked: 'email' }), { temp: 'Tmp-1234' });
});

test('a temporary-password reset that returned no password is not shown as done', () => {
  const out = resetAnswer({ ok: true, emailed: false }, { asked: 'temp' });
  assert.ok(out?.error);
  assert.doesNotMatch(out.error, /email/i, 'the admin asked for a password, not an email');
});

test('a refused call is left to the error the screen already shows', () => {
  assert.equal(resetAnswer(null, { asked: 'email' }), null);
  assert.equal(resetAnswer({ ok: false, error: 'x' }, { asked: 'email' }), null);
});

test('the Account screen shows every reset answer, the failed email included', () => {
  const src = readFileSync(new URL('../src/components/AccountScreen.jsx', import.meta.url), 'utf8');
  const at = src.indexOf("await act('reset'");
  assert.ok(at > 0, 'the reset button is where it was');
  const handler = src.slice(at, src.indexOf('}}>Yes, reset it</Btn>', at));
  assert.match(handler, /resetAnswer\(r, \{ email: user\.email, asked: confirm === 'reset' \? 'temp' : 'email' \}\)/);
  assert.match(handler, /setTemp\(out\.temp\)/);
  assert.match(handler, /setNote\(out\.note\)/);
  assert.match(handler, /setErr\(out\.error\)/, 'the failed send reaches the error line');
});
