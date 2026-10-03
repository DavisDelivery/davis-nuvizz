// account-view.js — the judgements behind the Account & logins screen, as pure functions.
//
// Pure core, thin edges (CLAUDE.md): every sentence the screen says about a person's login —
// working? refused? untested? what happens to their writes? — is decided here and tested in
// test/account-view.test.mjs. The component only lays it out, twice (phone and desktop).
//
// THE SERVER IS THE AUTHORITY on everything here. These functions read what the server returned
// (auth-users, auth-nuvizz-login, auth-me) and never infer a fact it did not send: where the app
// genuinely cannot know something — the Firestore rules deploy is the one — the answer says so
// instead of guessing (CLAUDE.md: "When the code cannot answer it, say that plainly").

const ET = 'America/New_York';

/** "Sep 26, 2026, 8:41 PM" (Eastern) — the house date shape, never ISO. Null → 'never'. */
export function fmtWhen(iso) {
  if (iso == null || iso === '') return 'never';
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(t));
}

/** "Sep 26, 2026" — for places a time of day adds nothing. */
export function fmtDay(iso) {
  if (iso == null || iso === '') return 'never';
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(t));
}

// ── the switch, in words ─────────────────────────────────────────────────────

export const MODES = ['preferred', 'required', 'off'];

/** What NUVIZZ_PERSONAL_LOGINS means for a write, today. Unknown mode → a sentence that says so. */
export function modeSentence(mode) {
  if (mode === 'required') return 'Every change sent to NuVizz must go out under the person\'s own NuVizz login — without one, the change is refused.';
  if (mode === 'off') return 'Personal NuVizz logins are switched off: every change goes out under the shared login.';
  if (mode === 'preferred') return 'Changes go out under the person\'s own NuVizz login when they have a working one saved; otherwise under the shared login.';
  return 'Could not read how NuVizz logins are being used right now.';
}

// ── one person's NuVizz login, as a badge ───────────────────────────────────

const sideOk = (v) => v === 'ok' || v === 'skipped';

/**
 * { tone: 'ok' | 'warn' | 'bad' | 'none', label, detail } for a publicNuvizzLogin summary.
 *
 * `ok` only when NuVizz said yes to at least one side and no to neither — "saved" is not
 * "working", and a badge that says working for a login nobody has tested is the kind of claim
 * this repo keeps having to take back.
 */
export function nuvizzBadge(login, mode = 'preferred') {
  const off = mode === 'off';
  const strict = mode === 'required';
  if (!login || !login.saved) {
    return {
      tone: 'none',
      label: 'No NuVizz login saved',
      detail: off ? 'Personal logins are switched off — every change uses the shared login.'
        : strict ? 'Changes to NuVizz are refused until one is saved.'
          : 'Changes go out under the shared login until one is saved.',
    };
  }
  const who = login.username || 'this login';
  if (login.rejected) {
    const reason = login.rejected.reason ? `${login.rejected.reason}` : 'wrong username or password';
    return {
      tone: 'bad',
      label: 'NuVizz refused it',
      detail: `${reason} (${fmtWhen(login.rejected.at)}). Re-enter the password. ${strict ? 'Changes are refused until then.' : off ? '' : 'Changes are going out under the shared login until then.'}`.trim(),
    };
  }
  const c = login.check;
  if (!c) return { tone: 'warn', label: `Saved as ${who} — not tested`, detail: 'Press Test to confirm NuVizz accepts it.' };
  if (c.api === 'refused' || c.portal === 'refused') {
    return { tone: 'bad', label: 'NuVizz refused it', detail: `${c.portalDetail || c.apiDetail || 'wrong username or password'}. Re-enter the password.` };
  }
  const anyYes = c.api === 'ok' || c.portal === 'ok';
  if (anyYes && sideOk(c.api) && sideOk(c.portal)) {
    return { tone: 'ok', label: `Working · ${who}`, detail: off ? 'Tested OK — but personal logins are switched off right now, so changes use the shared login.' : `Tested OK ${fmtWhen(c.at)}.` };
  }
  const unsure = [c.portal !== 'ok' && c.portal !== 'skipped' ? 'the Route Workbench' : null, c.api !== 'ok' && c.api !== 'skipped' ? 'the API' : null].filter(Boolean).join(' and ');
  return { tone: 'warn', label: `Saved as ${who} — not confirmed`, detail: `NuVizz gave no clear answer for ${unsure || 'this login'} (${fmtWhen(c.at)}). Test again when NuVizz is answering.` };
}

/** One line for the last test: what each side said, what it cost, when. */
export function checkLine(c) {
  if (!c) return 'Not tested yet.';
  const word = (v) => (v === 'ok' ? 'accepted' : v === 'refused' ? 'refused' : v === 'skipped' ? 'not asked' : 'no clear answer');
  const calls = Number.isFinite(Number(c.calls)) && c.calls !== null ? ` · ${c.calls} NuVizz call${Number(c.calls) === 1 ? '' : 's'}` : '';
  return `Route Workbench ${word(c.portal)} · API ${word(c.api)}${c.apiStatus ? ` (HTTP ${c.apiStatus})` : ''}${calls} · ${fmtWhen(c.at)}`;
}

// ── the whole office, at a glance ────────────────────────────────────────────

/**
 * Counts for the admin's summary line and the rollout checklist. Only ACTIVE accounts count
 * toward readiness — a deactivated account is not somebody the lock has to wait for — and
 * viewers are left out of the NuVizz count, because a viewer cannot change anything in NuVizz.
 */
export function readiness(users, mode = 'preferred') {
  const list = Array.isArray(users) ? users.filter((u) => u && u.active !== false) : [];
  const writers = list.filter((u) => u.role === 'dispatcher' || u.role === 'admin');
  const tone = (u) => nuvizzBadge(u.nuvizz, mode === 'off' ? 'preferred' : mode).tone;
  return {
    total: list.length,
    writers: writers.length,
    nuvizzOk: writers.filter((u) => tone(u) === 'ok').length,
    nuvizzBad: writers.filter((u) => tone(u) === 'bad').length,
    nuvizzMissing: writers.filter((u) => tone(u) === 'none').length,
    neverSignedIn: list.filter((u) => !u.lastLoginAt).length,
    locked: list.filter((u) => u.locked).length,
  };
}

/**
 * The turn-on checklist, in the order the switches must be flipped (auth-gate.js and
 * firestore.rules both say it: accounts first, then the lock). Each step reads its state from
 * something the server or this build actually reported; a step nothing here can read says
 * 'unknown' and why, rather than a tick nobody earned.
 *
 *   loginMode     'server' when this build shows the sign-in screen (VITE_LOGIN_ENABLED)
 *   configured    auth-me: AUTH_SESSION_SECRET is set (true / false / null = no answer)
 *   authRequired  auth-me: AUTH_REQUIRED is set (true / false / null)
 *   mode          NUVIZZ_PERSONAL_LOGINS as the server reports it
 *   users         the admin list (auth-users)
 */
export function rolloutSteps({ loginMode, configured, authRequired, mode, users } = {}) {
  const r = readiness(users, mode);
  const tri = (v) => (v === true ? 'done' : v === false ? 'todo' : 'unknown');
  return [
    {
      key: 'secret', state: tri(configured),
      label: 'Sign-in is set up on the server',
      detail: configured === false ? 'Set AUTH_SESSION_SECRET (32+ random characters) in Netlify, then redeploy.' : configured == null ? 'The server did not say.' : 'AUTH_SESSION_SECRET is set.',
    },
    {
      key: 'rules', state: 'unknown',
      label: 'Database rules deployed',
      detail: 'The app cannot read this. firestore.rules says that until its live block is deployed, a browser can write the user store directly — deploy it before relying on these logins.',
    },
    {
      key: 'accounts', state: r.total > 1 ? 'done' : 'todo',
      label: 'An account for everyone who uses the board',
      detail: `${r.total} active account${r.total === 1 ? '' : 's'}.`,
    },
    {
      key: 'nuvizz', state: r.writers > 0 && r.nuvizzOk === r.writers ? 'done' : 'todo',
      label: 'Each dispatcher\'s NuVizz login saved and working',
      detail: `${r.nuvizzOk} of ${r.writers} working${r.nuvizzBad ? ` · ${r.nuvizzBad} refused` : ''}${r.nuvizzMissing ? ` · ${r.nuvizzMissing} not saved` : ''}.`,
    },
    {
      key: 'signedin', state: r.total > 0 && r.neverSignedIn === 0 ? 'done' : 'todo',
      label: 'Everyone has signed in once',
      detail: r.neverSignedIn ? `${r.neverSignedIn} never signed in.` : 'All have.',
    },
    {
      key: 'gate', state: loginMode === 'server' ? 'done' : 'todo',
      label: 'The sign-in screen is switched on',
      // What the flip does to THIS screen is said here, where the admin decides to flip it:
      // from then on only admins see Account & logins (lib/auth-gate.js accountsTabVisible).
      detail: loginMode === 'server'
        ? 'VITE_LOGIN_ENABLED is on in this build. Only admins see this screen now; everyone else signs out from the menu.'
        : 'Set VITE_LOGIN_ENABLED=true in Netlify and redeploy — it is a build-time switch. After that only admins see this screen; everyone else signs out from the menu.',
    },
    {
      key: 'enforce', state: tri(authRequired),
      label: 'The server refuses anyone not signed in',
      detail: authRequired === true ? 'AUTH_REQUIRED is on.' : authRequired === false ? 'Set AUTH_REQUIRED=true in Netlify — only after the step above, or the board answers nothing.' : 'The server did not say.',
    },
    {
      key: 'required', state: mode === 'required' ? 'done' : 'optional',
      label: 'Optional: no change reaches NuVizz without a personal login',
      detail: mode === 'required' ? 'NUVIZZ_PERSONAL_LOGINS is required.' : 'Set NUVIZZ_PERSONAL_LOGINS=required once every dispatcher\'s login is working. Until then, anyone without one uses the shared login.',
    },
  ];
}

// ── resetting a password ─────────────────────────────────────────────────────

/**
 * What the admin is told after a reset: { temp } to show, { note } for a link that went out, or
 * { error } — and null for a refused call, which the screen has already put on its error line.
 *
 * The reset email is sent AFTER the server has signed the person out everywhere and set a new
 * password to be chosen (auth-users.mts, the reset branch). When the mail provider refuses the
 * send, the answer is still ok — { ok: true, emailed: false, tempPassword: null } — and the
 * screen used to say nothing at all, so the admin told the person to check an inbox that never
 * got anything. `asked` is which button was pressed: 'temp' or 'email'.
 */
export function resetAnswer(r, { email, asked } = {}) {
  if (!r?.ok) return null;
  if (r.tempPassword) return { temp: r.tempPassword };
  if (r.emailed) return { note: `Reset link emailed to ${email}.` };
  if (asked === 'temp') return { error: 'The server did not send back a temporary password. Try again.' };
  return { error: `The reset email to ${email || 'them'} did not go out, so no link was sent. They are already signed out everywhere — use New temporary password to give them one instead.` };
}

// ── a password the admin types for someone ───────────────────────────────────
//
// Chad, 2026-10-03: "I want to be able to set their password, reset it …". The admin types the
// password (auth-users.mts 'set-password', or `password` on 'create') and says whether the person
// keeps it. Every sentence about what that does is decided here.
//
// `gated` — in all four functions — is whether THIS BUILD puts the sign-in screen in front of the
// board (App.jsx LOGIN_MODE === 'server'). The screen that makes a person replace a one-time
// password lives on that gate (lib/auth-gate.js 'must-change'), so before sign-in is switched on
// NOTHING makes them replace it. A sentence promising it will would be a guess.

/**
 * A password the admin types and then TELLS someone cannot start or end with a space — the
 * server's rule (netlify/functions/lib/auth-core.mts typedPasswordEdgeProblem), mirrored so the
 * form can say it while it is being typed. A box that shows the password does not show a trailing
 * space. test/admin-set-password-screen.test.mjs pins the two against each other.
 */
export function typedPasswordEdgeProblem(pw) {
  return typeof pw === 'string' && pw.length > 0 && /^\s|\s$/.test(pw) ? 'password cannot start or end with a space' : null;
}

/** The two things a typed password can be, in the words on the buttons. */
export const TYPED_PASSWORD_CHOICES = [
  { mustChange: false, label: 'They keep it' },
  { mustChange: true, label: 'They choose their own' },
];

/** Said under the choice, before the admin commits to it. */
export function typedPasswordHint({ mustChange, gated = true } = {}) {
  if (!mustChange) return 'It is their password until someone changes it.';
  return gated
    ? 'It gets them in once: the board does not open until they have chosen their own.'
    : 'Sign-in is not switched on yet, so nothing asks them to choose their own until it is. This password keeps working until then.';
}

const chooseTheirOwn = (must, gated) => (!must ? ''
  : gated ? ' They will be asked to choose their own before the board opens.'
    : ' They will be asked to choose their own once sign-in is switched on; it keeps working until then.');

/**
 * What the admin is told once the SERVER has stored a typed password — or null for a refused
 * call, which the screen has already put on its error line. Whether the person must replace it is
 * read from what the server sent back (the row it re-read after the write), never from which
 * button was lit when Save was pressed.
 */
export function setPasswordAnswer(r, { name, username, gated = true } = {}) {
  if (!r?.ok) return null;
  const must = (r.user ? r.user.mustChangePassword : r.mustChange) === true;
  // An account that is turned off is refused at sign-in whatever its password (auth-login.mts),
  // so "they sign in with it" would be false. The password is set; the account still has to go on.
  if (r.user?.active === false) {
    return `Password set for ${name || username}. Their account is off, so they cannot sign in with it until the account is turned back on.${chooseTheirOwn(must, gated)}`;
  }
  return `Password set for ${name || username}. They were signed out everywhere, and sign in as ${username} with the password you typed.${chooseTheirOwn(must, gated)}`;
}

/** Said above the Save button: what pressing it does to this particular account. */
export function setPasswordWarning(user) {
  const name = user?.displayName || user?.username || 'this person';
  if (user?.active === false) return `This account is off. Saving sets the password, but ${name} cannot sign in until the account is turned back on.`;
  return `Saving this signs ${name} out everywhere${user?.locked ? ' and unlocks the account' : ''}.`;
}

/**
 * How a GENERATED temporary password is handed over. Until this was written the box said the
 * person would "pick their own password straight away" on every build — true only where the
 * sign-in screen is in front of the board.
 */
export function tempPasswordHandover({ gated = true } = {}) {
  return gated
    ? 'and pick their own password straight away.'
    : 'with it. Sign-in is not switched on yet, so nothing asks them to pick their own until it is.';
}

/** The same, for a person just added with a typed password. */
export function typedPasswordAdded({ name, username, mustChange, gated = true } = {}) {
  return `${name || username} signs in as ${username} with the password you typed.${chooseTheirOwn(mustChange === true, gated)}`;
}

/**
 * { tone, text } for the password an account holds, from what the server sent — or null when it
 * sent nothing worth a line (no stamp, on a password nobody has to replace).
 *
 * "Temporary" is the server's mustChangePassword and nothing else. The date is the last time the
 * password itself changed (auth-store PublicUser.passwordChangedAt): an emailed reset link that
 * has not been used yet does not move it.
 */
export function passwordStatus(user, { gated = true } = {}) {
  if (!user) return null;
  const name = user.displayName || user.username || 'This person';
  // A stamp that is not a date is treated as no stamp: "last changed —" tells nobody anything.
  const stamped = user.passwordChangedAt && Number.isFinite(Date.parse(String(user.passwordChangedAt)));
  const changed = stamped ? ` Password last changed ${fmtWhen(user.passwordChangedAt)}.` : '';
  if (user.mustChangePassword === true) {
    return {
      tone: 'warn',
      text: `${gated
        ? `Temporary password: ${name} has to choose their own before the board opens.`
        : `Temporary password. Sign-in is not switched on yet, so nothing asks ${name} to choose their own until it is.`}${changed}`,
    };
  }
  return changed ? { tone: 'none', text: changed.trim() } : null;
}

// ── creating a person ────────────────────────────────────────────────────────

// The server's own rule (netlify/functions/lib/auth-core.mts USERNAME_RE), mirrored so the form
// can say it while someone is typing. The server re-checks; test/account-view.test.mjs pins the
// two against each other.
export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
export const ROLE_CHOICES = [
  { value: 'dispatcher', label: 'Dispatcher', hint: 'Runs the board: routing, notes, NuVizz changes, texts' },
  { value: 'viewer', label: 'Viewer', hint: 'Sees the board and reports; changes nothing' },
  { value: 'admin', label: 'Admin', hint: 'Everything, plus managing people and the switches that spend money' },
];

/** A problem with a new person's details, or null. */
export function newPersonProblem({ username, email, role } = {}) {
  const u = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(u)) return 'Username: 2–40 characters, lower-case letters, digits, - or _, starting with a letter or digit.';
  const e = String(email || '').trim();
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'That email does not look like an address.';
  if (!ROLE_CHOICES.some((r) => r.value === role)) return 'Pick a role.';
  return null;
}

/** The NuVizz username field's rule — lib/nuvizz-identity.mts normalizeNuvizzUsername, mirrored. */
export function nuvizzUsernameProblem(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'Enter the NuVizz username.';
  if (s.length > 120) return 'NuVizz username is too long.';
  if (/[\s:]/.test(s)) return 'NuVizz username cannot contain spaces or a colon.';
  return null;
}
