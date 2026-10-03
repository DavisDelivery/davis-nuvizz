// test/admin-set-password-screen.test.mjs — the SCREEN half of "an admin types a person's password".
//
// Chad, 2026-10-03: "I want to be able to set their password, reset it …". The server half is
// test/admin-set-password.test.mjs. This file pins what the admin is TOLD and what the screen
// SENDS — the sentences (src/lib/account-view.js) and the real components, bundled and rendered.
//
// Each test names the morning it prevents:
//   • an admin told "they will be asked to choose their own" about a site where nothing asks —
//     the forced change lives on the sign-in gate, and before go-live there is no gate;
//   • a success note that repeats what the admin ASKED for instead of what the server STORED;
//   • a browser offering to save a dispatcher's new password over the admin's own login;
//   • an admin changing their own password from a signed-in screen without the current one;
//   • Enter on Cancel saving the password.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

import {
  typedPasswordHint, setPasswordAnswer, typedPasswordAdded, passwordStatus, TYPED_PASSWORD_CHOICES,
  typedPasswordEdgeProblem, setPasswordWarning, tempPasswordHandover,
} from '../src/lib/account-view.js';
import { typedPasswordEdgeProblem as serverEdgeProblem } from '../netlify/functions/lib/auth-core.mts';

// ── the sentences ────────────────────────────────────────────────────────────

test('the choice is two-way and the button the form opens on is "They keep it"', () => {
  assert.deepEqual(TYPED_PASSWORD_CHOICES.map((c) => [c.mustChange, c.label]), [[false, 'They keep it'], [true, 'They choose their own']]);
});

test('before the admin commits: what each choice does — and before go-live, that nothing forces a change', () => {
  assert.equal(typedPasswordHint({ mustChange: false, gated: true }), 'It is their password until someone changes it.');
  assert.equal(typedPasswordHint({ mustChange: false, gated: false }), 'It is their password until someone changes it.');
  assert.match(typedPasswordHint({ mustChange: true, gated: true }), /the board does not open until they have chosen their own/);
  const early = typedPasswordHint({ mustChange: true, gated: false });
  assert.match(early, /Sign-in is not switched on yet, so nothing asks them to choose their own until it is/);
  assert.match(early, /keeps working until then/);
  assert.doesNotMatch(early, /board does not open/, 'never the promise that only the gate can keep');
  assert.match(typedPasswordHint({ mustChange: true }), /board does not open/, '`gated` defaults to true, like accountsTabVisible');
});

test('after the save: who it was for, that they were signed out, and how they sign in', () => {
  const said = setPasswordAnswer({ ok: true, mustChange: false, user: { mustChangePassword: false } }, { name: 'Dee', username: 'dee', gated: false });
  assert.equal(said, 'Password set for Dee. They were signed out everywhere, and sign in as dee with the password you typed.');
});

test('after the save: whether they must replace it is what the SERVER stored, not what was asked for', () => {
  // The request said "keep it"; the row the server re-read says temporary. The row wins.
  const stored = setPasswordAnswer({ ok: true, mustChange: false, user: { mustChangePassword: true } }, { name: 'Dee', username: 'dee', gated: true });
  assert.match(stored, /They will be asked to choose their own before the board opens\.$/);
  // No row came back at all: the server's own mustChange is the next best word.
  assert.match(setPasswordAnswer({ ok: true, mustChange: true }, { name: 'Dee', username: 'dee', gated: true }), /asked to choose their own before the board opens/);
  assert.doesNotMatch(setPasswordAnswer({ ok: true }, { name: 'Dee', username: 'dee', gated: true }), /choose their own/);
  // Before go-live the promise is the one that is true.
  assert.match(setPasswordAnswer({ ok: true, mustChange: true }, { name: 'Dee', username: 'dee', gated: false }), /once sign-in is switched on; it keeps working until then\.$/);
});

test('an account that is turned off is never told "they sign in with it" — the password is set, the account still has to go on', () => {
  const off = setPasswordAnswer({ ok: true, mustChange: false, user: { mustChangePassword: false, active: false } }, { name: 'Office Viewer', username: 'viewer1', gated: false });
  assert.equal(off, 'Password set for Office Viewer. Their account is off, so they cannot sign in with it until the account is turned back on.');
  assert.doesNotMatch(off, /sign in as viewer1/);
  // Only an explicit false is "off" — a row the server did not send is not an account turned off.
  assert.match(setPasswordAnswer({ ok: true, mustChange: false }, { name: 'Dee', username: 'dee' }), /sign in as dee with the password you typed/);
  assert.match(setPasswordAnswer({ ok: true, user: { active: true } }, { name: 'Dee', username: 'dee' }), /sign in as dee/);
});

test('above Save: what pressing it does to THIS account — signed out, unlocked, or still off', () => {
  assert.equal(setPasswordWarning({ username: 'dee', displayName: 'Dee', active: true, locked: false }), 'Saving this signs Dee out everywhere.');
  assert.equal(setPasswordWarning({ username: 'dee', displayName: 'Dee', active: true, locked: true }), 'Saving this signs Dee out everywhere and unlocks the account.');
  assert.equal(setPasswordWarning({ username: 'viewer1', displayName: 'Office Viewer', active: false, locked: false }),
    'This account is off. Saving sets the password, but Office Viewer cannot sign in until the account is turned back on.');
  assert.match(setPasswordWarning(null), /signs this person out everywhere/);
});

test('a generated temporary password: "pick their own straight away" is only said where something makes them', () => {
  assert.equal(tempPasswordHandover({ gated: true }), 'and pick their own password straight away.');
  assert.equal(tempPasswordHandover({ gated: false }), 'with it. Sign-in is not switched on yet, so nothing asks them to pick their own until it is.');
  assert.equal(tempPasswordHandover(), tempPasswordHandover({ gated: true }));
});

test('the edge-space rule on the screen is the server\'s, input for input', () => {
  const table = ['Dock-door-9-at-5am', 'Dock-door-9-at-5am ', ' Dock-door-9-at-5am', '\tDock-door-9-at-5am', 'Dock-door-9-at-5am\n', 'four words at 5am', ' ', '', null, undefined, 12, {}];
  for (const pw of table) assert.equal(typedPasswordEdgeProblem(pw), serverEdgeProblem(pw), JSON.stringify(pw));
  assert.equal(typedPasswordEdgeProblem('Dock-door-9-at-5am '), 'password cannot start or end with a space');
});

test('a refused save says nothing here — the screen already has the server\'s error on its error line', () => {
  assert.equal(setPasswordAnswer(null, { name: 'Dee', username: 'dee' }), null);
  assert.equal(setPasswordAnswer({ ok: false, error: 'password is too common' }, { name: 'Dee', username: 'dee' }), null);
});

test('a person added with a typed password: how they sign in, and the same honest tail', () => {
  assert.equal(typedPasswordAdded({ name: 'Dee', username: 'dee', mustChange: false, gated: false }), 'Dee signs in as dee with the password you typed.');
  assert.match(typedPasswordAdded({ name: 'Dee', username: 'dee', mustChange: true, gated: true }), /asked to choose their own before the board opens\.$/);
  assert.match(typedPasswordAdded({ name: 'Dee', username: 'dee', mustChange: true, gated: false }), /once sign-in is switched on; it keeps working until then\.$/);
});

test('the password line: "temporary" is the server\'s flag, and before go-live it says nothing asks them to change it', () => {
  const temp = { username: 'dee', displayName: 'Dee', mustChangePassword: true, passwordChangedAt: '2026-10-03T19:53:00.000Z' };
  assert.deepEqual(passwordStatus(temp, { gated: true }), {
    tone: 'warn', text: 'Temporary password: Dee has to choose their own before the board opens. Password last changed Oct 3, 2026, 3:53 PM.',
  });
  assert.deepEqual(passwordStatus(temp, { gated: false }), {
    tone: 'warn', text: 'Temporary password. Sign-in is not switched on yet, so nothing asks Dee to choose their own until it is. Password last changed Oct 3, 2026, 3:53 PM.',
  });
});

test('the password line: a password nobody has to replace says when it was put there, in Eastern time', () => {
  assert.deepEqual(passwordStatus({ username: 'dee', mustChangePassword: false, passwordChangedAt: '2026-10-03T20:12:00.000Z' }, { gated: false }),
    { tone: 'none', text: 'Password last changed Oct 3, 2026, 4:12 PM.' });
});

test('the password line: nothing to say is said as nothing — absent, empty and malformed stamps are not dates', () => {
  assert.equal(passwordStatus(null), null);
  assert.equal(passwordStatus({ username: 'dee', mustChangePassword: false }), null);
  assert.equal(passwordStatus({ username: 'dee', mustChangePassword: false, passwordChangedAt: null }), null);
  assert.equal(passwordStatus({ username: 'dee', mustChangePassword: false, passwordChangedAt: '' }), null);
  assert.equal(passwordStatus({ username: 'dee', mustChangePassword: false, passwordChangedAt: 'not-a-date' }), null);
  // A temporary password with no usable stamp still says it is temporary — just without a date.
  assert.equal(passwordStatus({ username: 'dee', mustChangePassword: true, passwordChangedAt: 'not-a-date' }, { gated: true }).text,
    'Temporary password: dee has to choose their own before the board opens.');
  // Only the boolean true is "temporary".
  assert.equal(passwordStatus({ username: 'dee', mustChangePassword: 'true' }), null);
});

// ── the real components, bundled and rendered ────────────────────────────────

const SRC_URL = new URL('../src/components/AccountScreen.jsx', import.meta.url);
const SRC = readFileSync(SRC_URL, 'utf8');
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// The same compiler vite uses, over the real file and everything it imports — so what renders
// here is the screen, not a copy of it. React and the icons stay external so there is one React.
const screen = (() => {
  const out = buildSync({
    entryPoints: [fileURLToPath(SRC_URL)], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
    external: ['react', 'react-dom', 'lucide-react', 'firebase', 'firebase/*'],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
})();

const OWNER = { username: 'owner', displayName: 'The Owner', role: 'admin' };
const NV_NONE = { saved: false, username: null, savedAt: null, savedBy: null, check: null, rejected: null };
const DEE = {
  username: 'dee', displayName: 'Dee', email: null, role: 'dispatcher', active: true, mustChangePassword: true,
  locked: false, lockedUntil: null, lastLoginAt: null, passwordChangedAt: '2026-10-03T19:53:00.000Z', nuvizz: NV_NONE,
};
const manage = (props) => renderToStaticMarkup(React.createElement(screen.PersonManage, {
  me: OWNER, mailConfigured: false, mode: 'preferred', site: { keyReady: true, checkCalls: 5 }, gated: false, onChanged() {}, onReload() {}, ...props,
}));
const fields = (props) => renderToStaticMarkup(React.createElement(screen.TypedPasswordFields, {
  label: 'New password', username: 'dee', value: '', onChange() {}, mustChange: false, onMustChange() {}, disabled: false, gated: false, ...props,
}));

test('the temporary-password box no longer contradicts the line above it on a site with sign-in off', () => {
  for (const m of [true, false]) {
    const box = (props) => renderToStaticMarkup(React.createElement(screen.TempPasswordBox, { m, displayName: 'Dee', username: 'dee', password: 'TempPass23xyzAB', emailed: false, ...props }));
    const early = box({ gated: false });
    assert.ok(early.includes('nothing asks them to pick their own until it is.'));
    assert.doesNotMatch(early, /straight away/);
    assert.match(box({ gated: true }), /and pick their own password straight away\./);
    assert.match(box({}), /straight away/, 'a caller that says nothing keeps the sentence it always had');
    assert.match(box({ emailed: true, gated: false }), /A link to set a password was emailed to Dee/, 'the emailed wording is untouched');
  }
});

test('someone else\'s Manage panel offers Set a password first, beside the reset that was already there — phone and desktop', () => {
  for (const m of [true, false]) {
    const html = manage({ m, user: DEE });
    const set = html.indexOf('Set a password</button>');
    const temp = html.indexOf('New temporary password</button>');
    assert.ok(set > 0, `Set a password is offered (m=${m})`);
    assert.ok(temp > set, 'ahead of New temporary password');
    assert.doesNotMatch(html, /Your own password/);
  }
});

test('the panel says what state the password is in, read from the row — and on this site, that nothing forces a change yet', () => {
  for (const m of [true, false]) {
    assert.ok(manage({ m, user: DEE }).includes('Temporary password. Sign-in is not switched on yet, so nothing asks Dee to choose their own until it is. Password last changed Oct 3, 2026, 3:53 PM.'));
    assert.ok(manage({ m, user: DEE, gated: true }).includes('Temporary password: Dee has to choose their own before the board opens.'));
    const kept = manage({ m, user: { ...DEE, mustChangePassword: false, passwordChangedAt: '2026-10-03T20:12:00.000Z' } });
    assert.ok(kept.includes('Password last changed Oct 3, 2026, 4:12 PM.'));
    assert.doesNotMatch(kept, /Temporary password/);
  }
});

test('an admin\'s own row has no Set a password, and says where their own is changed', () => {
  for (const m of [true, false]) {
    const html = manage({ m, user: { ...OWNER, email: null, active: true, mustChangePassword: false, locked: false, nuvizz: NV_NONE } });
    assert.doesNotMatch(html, /Set a password/);
    assert.ok(html.includes('Your own password: use Change password under You — it asks for your current one.'));
    assert.match(html, /New temporary password<\/button>/, 'the reset that was already there is untouched');
  }
});

test('the typed field is not this site\'s login for the admin: no form, no save, and shown as typed', () => {
  for (const m of [true, false]) {
    const html = fields({ m });
    const input = /<input[^>]*name="person-typed-secret"[^>]*>/.exec(html)?.[0] || '';
    assert.ok(input, 'the field is there');
    assert.match(input, /type="text"/, 'shown as typed: there is no second field to catch a slip');
    assert.match(input, /autoComplete="off"/i);
    for (const keepOut of ['data-1p-ignore="true"', 'data-lpignore="true"', 'data-bwignore="true"', 'data-form-type="other"']) assert.ok(input.includes(keepOut), keepOut);
    assert.doesNotMatch(input, /new-password|current-password/);
    assert.match(html, /aria-pressed="false"[^>]*>(<svg[\s\S]*?<\/svg>)? ?Hide<\/button>/, 'Hide is one press away');
  }
});

test('the rule is on screen before it is enforced, and a password the server would refuse is named while it is typed', () => {
  for (const m of [true, false]) {
    assert.ok(fields({ m }).includes('At least 10 characters. Not their username, not one repeated character.'));
    assert.doesNotMatch(fields({ m }), /role="status"/, 'nothing typed, nothing to complain about');
    assert.ok(fields({ m, value: 'short' }).includes('Password must be at least 10 characters.'));
    assert.ok(fields({ m, value: 'dee-is-on-dock-9' }).includes('Password cannot contain the username.'));
    assert.doesNotMatch(fields({ m, value: 'Dock-door-9-at-5am' }), /role="status"/);
    // The one slip a field that SHOWS the password still hides.
    assert.ok(fields({ m, value: 'Dock-door-9-at-5am ' }).includes('Password cannot start or end with a space.'));
  }
});

test('neither place the field lives is inside a <form> — a form is what makes a browser offer to save it over the admin\'s own login', () => {
  // On the SOURCE of the two components that host it: rendering the field alone cannot show a
  // form wrapped around it (the review proved that assertion vacuous).
  for (const [name, src] of [['Manage', MANAGE], ['Add a person', ADD]]) {
    assert.ok(src.includes('<TypedPasswordFields'), `${name} hosts the typed field`);
    assert.doesNotMatch(src, /<form\b/, `${name} has no form element`);
  }
  // …while this site's OWN login forms stay real forms, as the file's comment says they must.
  assert.match(SRC, /<form onSubmit=\{submit\} className="flex flex-col gap-3">/);
});

test('the two-way choice shows which is lit and says what it does', () => {
  for (const m of [true, false]) {
    const keep = fields({ m, mustChange: false });
    assert.match(keep, /aria-pressed="true"[^>]*>They keep it<\/button>/);
    assert.match(keep, /aria-pressed="false"[^>]*>They choose their own<\/button>/);
    assert.ok(keep.includes('It is their password until someone changes it.'));
    const once = fields({ m, mustChange: true, gated: true });
    assert.match(once, /aria-pressed="true"[^>]*>They choose their own<\/button>/);
    assert.ok(once.includes('the board does not open until they have chosen their own'));
    // The same choice on a site with sign-in off: the component passes `gated` through.
    const early = fields({ m, mustChange: true, gated: false });
    assert.ok(early.includes('nothing asks them to choose their own until it is'));
    assert.doesNotMatch(early, /board does not open/);
  }
});

test('two views: the phone gets 48px controls in a column, the desktop a row sized by padding', () => {
  const phone = fields({ m: true });
  const desk = fields({ m: false });
  assert.match(phone, /min-h-\[48px\]/);
  assert.doesNotMatch(desk, /min-h-\[/, 'a min-h utility would pin a desktop control under the 44px tablet floor');
  assert.match(desk, /flex flex-wrap items-end gap-2/);
});

// ── the wiring a static render cannot reach ──────────────────────────────────

const MANAGE = SRC.slice(SRC.indexOf('export function PersonManage('), SRC.indexOf('function statusChips('));
const ADD = SRC.slice(SRC.indexOf('export function AddPersonForm('), SRC.indexOf('export function PersonManage('));

test('wired: Save sends the typed password to auth-users as set-password, with the choice as a boolean', () => {
  assert.match(MANAGE, /userAction\(\{ username: user\.username, action: 'set-password', password: pw, mustChange: pwMust \}\)/);
  assert.match(MANAGE, /const \[pwMust, setPwMust\] = useState\(false\);/, 'the form opens on "They keep it"');
});

test('wired: a refusal leaves the form open with what was typed; a success closes it and drops the password', () => {
  const save = MANAGE.slice(MANAGE.indexOf('const savePassword = async'), MANAGE.indexOf('return (', MANAGE.indexOf('const savePassword = async')));
  const refused = save.indexOf('if (!r.ok) { setErr(r.error); return; }');
  const closed = save.indexOf('setConfirm(null); setTemp(null);');
  assert.ok(refused > 0 && closed > refused, 'the refusal returns before anything closes');
  assert.match(save, /setNote\(setPasswordAnswer\(r, \{ name, username: user\.username, gated \}\)\)/, 'the note is built from the server\'s answer');
  assert.match(save, /onReload\?\.\(\)/, 'and the row is read back');
  assert.match(MANAGE, /useEffect\(\(\) => \{ if \(confirm !== 'set'\) \{ setPw\(''\); setPwMust\(false\); \} \}, \[confirm\]\);/, 'a closed form forgets the password');
  // A temporary password still on show from an earlier reset no longer works once this saves.
  assert.match(save, /setTemp\(null\)/);
});

test('wired: Set a password is not offered on your own row, and Enter on a button presses that button', () => {
  assert.match(MANAGE, /\{!isSelf && <Btn m=\{m\} onClick=\{\(\) => \{ setErr\(''\); setNote\(''\); setConfirm\('set'\); \}\}>/);
  assert.match(SRC, /const onEnter = \(fn\) => \(e\) => \{ if \(e\.key === 'Enter' && !e\.nativeEvent\?\.isComposing && e\.target\?\.tagName !== 'BUTTON'\) \{ e\.preventDefault\(\); fn\(\); \} \};/);
  assert.match(MANAGE, /<div onKeyDown=\{onEnter\(savePassword\)\}/);
});

test('wired: "is sign-in switched on" reaches every sentence from this build\'s login mode — not a constant', () => {
  const PEOPLE = SRC.slice(SRC.indexOf('function PeopleSection('), SRC.indexOf('const STEP_ICON'));
  assert.match(PEOPLE, /const gated = loginMode === 'server';/);
  assert.match(PEOPLE, /<PersonManage [^>]*gated=\{gated\}/);
  assert.match(PEOPLE, /<AddPersonForm [^>]*gated=\{gated\}/);
  assert.match(SRC, /<PeopleSection [^>]*loginMode=\{loginMode\}/);
  assert.match(MANAGE, /const pwStatus = passwordStatus\(user, \{ gated \}\);/);
  assert.match(MANAGE, /<TypedPasswordFields [^>]*\s[^>]*gated=\{gated\} \/>/);
  assert.match(MANAGE, /<TempPasswordBox [^>]*gated=\{gated\} \/>/);
  assert.match(ADD, /<TypedPasswordFields [^>]*\s[^>]*gated=\{gated\} \/>/);
  assert.match(ADD, /<TempPasswordBox [^>]*gated=\{gated\} \/>/);
  assert.match(ADD, /typedPasswordAdded\(\{ name: result\.displayName, username: result\.username, mustChange: result\.mustChange, gated \}\)/);
  assert.match(SRC, /typedPasswordHint\(\{ mustChange, gated \}\)/);
});

test('wired: one rule decides a typed password everywhere it is checked — the amber line, both Save buttons, both submits', () => {
  assert.match(SRC, /const typedProblem = \(pw, username\) => typedPasswordEdgeProblem\(pw\) \|\| passwordProblem\(pw, username\);/);
  assert.match(SRC, /const problem = value \? typedProblem\(value, username\) : null;/);
  assert.match(MANAGE, /const p = typedProblem\(pw, user\.username\);/);
  assert.match(MANAGE, /disabled=\{!!busy \|\| !pw \|\| !!typedProblem\(pw, user\.username\)\} onClick=\{savePassword\}>Save password/);
  assert.match(ADD, /sentenceOf\(typedProblem\(pw, u\)\)/);
});

test('wired: nothing in the panel can be pressed into a silent no-op while another action is in flight', () => {
  // savePassword returns on `busy`; a Save that is pressable and does nothing is the worst kind.
  assert.match(MANAGE, /mustChange=\{pwMust\} onMustChange=\{setPwMust\} disabled=\{!!busy\} gated=\{gated\}/);
  assert.match(MANAGE, /disabled=\{!!busy \|\| !pw/);
});

test('wired: a failed re-read of the list keeps the rows — and the answer just given — on screen', () => {
  const LOAD = SRC.slice(SRC.indexOf('const loadPeople = useCallback'), SRC.indexOf('useEffect(() => { loadFacts(); }'));
  assert.match(LOAD, /users: prev\?\.users \|\| \[\], mailConfigured: !!prev\?\.mailConfigured, error: r\.error, stale: \(prev\?\.users\?\.length \|\| 0\) > 0/);
  assert.doesNotMatch(LOAD, /: \{ users: \[\], error: r\.error \}/, 'the list is never emptied by a failed read');
  assert.match(SRC, /\{people\.stale && <span className="block mt-1">The list below is as it last loaded\. Press Refresh to read it again\.<\/span>\}/);
});

test('wired: adding a person sends a typed password only when that way was chosen, and forgets it afterwards', () => {
  assert.match(ADD, /const \[how, setHow\] = useState\('temp'\);/, 'the temporary password stays the default');
  assert.match(ADD, /\.\.\.\(typed \? \{ password: pw, mustChange: pwMust \} : \{\}\),/);
  assert.match(ADD, /sendInvite: way === 'invite',/);
  assert.match(ADD, /const way = how === 'invite' && !canInvite \? 'temp' : how;/, 'an emailed link with no address falls back');
  assert.match(ADD, /setPw\(''\);\s*setResult\(out\);/);
  // Choosing another way drops it too — coming back must not show, in clear, a password that was hidden.
  assert.match(ADD, /useEffect\(\(\) => \{ if \(way !== 'typed'\) \{ setPw\(''\); setPwMust\(false\); \} \}, \[way\]\);/);
  assert.match(ADD, /typed, mustChange: r\.user\?\.mustChangePassword === true,/, 'the result reads what the server stored');
});

test('the add form offers the three ways, the email one only when a link can be sent', () => {
  for (const m of [true, false]) {
    const html = renderToStaticMarkup(React.createElement(screen.AddPersonForm, { m, mailConfigured: true, mode: 'preferred', site: { checkCalls: 5 }, gated: false, onCreated() {}, onClose() {} }));
    assert.match(html, /aria-pressed="true"[^>]*>I give them a temporary one<\/button>/);
    assert.match(html, /aria-pressed="false"[^>]*>(<svg[\s\S]*?<\/svg>)? ?I type their password<\/button>/);
    assert.doesNotMatch(html, /Email them a link/, 'no address typed yet');
    assert.doesNotMatch(html, /person-typed-secret/, 'the password field appears only once that way is chosen');
  }
});
