// AccountScreen.jsx — Account & logins.
//
// Chad, 2026-09-26: "I want to create logins for dispatch map to improve the security. I want
// to create logins for all the different users with their personal nuvizz login information
// instead of every dispatcher using mine." And, asked to go ahead: "yes build this with me as
// the admin."
//
// ONE SCREEN, THREE JOBS, in the order a person needs them:
//   1. WHO AM I HERE — sign in (or, the very first time, create the admin account with the
//      one-time setup code), change the password, sign out.
//   2. MY NuVizz LOGIN — the username and password this person uses at NuVizz, saved so the
//      changes they make on the board reach NuVizz under their own name. Tested with NuVizz
//      before it is kept; never shown again once saved.
//   3. EVERYONE (admins) — add a person, set their role, reset or unlock them, set their NuVizz
//      login, and a checklist that reads back how far the turn-on has got.
//
// NOTHING HERE DECIDES ANYTHING. The server (auth-*.mts, auth-nuvizz-login.mts) is the authority
// on every rule, and every sentence this screen says about a login — working, refused, untested,
// what happens to your changes — comes from src/lib/account-view.js, where it is tested.
//
// TWO VIEWS, NOT ONE RESPONSIVE ONE (CLAUDE.md). The phone is one column of cards with 16px
// inputs and full-width buttons under the thumb; the desktop is two columns — you on the left,
// the office on the right — with a sortable table, because a dispatcher's monitor is the working
// surface and a narrow column in the middle of it wastes the room the guard exists to protect.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  KeyRound, UserPlus, Users, ShieldCheck, LogOut, RefreshCw, Loader2, Check, AlertTriangle,
  Copy, Lock, Unlock, Mail, Info, CircleDashed, UserCog, Eye, EyeOff,
} from 'lucide-react';
import { getSession, subscribeSession } from '../lib/session.js';
import { signIn, signOut, changePassword, fetchMe, passwordProblem, PASSWORD_MIN } from '../lib/auth-client.js';
import {
  fetchNuvizzLogin, saveNuvizzLogin, testNuvizzLogin, removeNuvizzLogin, siteMode,
  fetchUsers, userAction, bootstrapFirstAdmin,
} from '../lib/account-client.js';
import {
  fmtWhen, modeSentence, nuvizzBadge, checkLine, readiness, rolloutSteps,
  newPersonProblem, nuvizzUsernameProblem, ROLE_CHOICES, resetAnswer,
  TYPED_PASSWORD_CHOICES, typedPasswordHint, setPasswordAnswer, typedPasswordAdded, passwordStatus,
  typedPasswordEdgeProblem, setPasswordWarning, tempPasswordHandover,
} from '../lib/account-view.js';
import { useSortable, SortableTh } from '../lib/useSortable.jsx';

// ── small pieces ─────────────────────────────────────────────────────────────

// DESKTOP CONTROLS ARE SIZED BY PADDING, NEVER BY A min-h UTILITY. index.css lifts every button
// and input to 44px under `pointer: coarse` — an iPad gets this desktop layout on a finger — and a
// `min-h-[36px]` class outranks that element rule and pins the control at 36px. The tablet guard
// caught exactly that on the first draft of this screen. The phone view sets its own 48px floor.
const inputCls = (m) => (m
  ? 'mt-1 w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-4 text-base text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:outline-none disabled:bg-slate-100'
  : 'mt-1 w-full py-2 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none disabled:bg-slate-100');

// THE NuVizz FIELDS ARE NOT A LOGIN FOR THIS SITE, and a browser that offers to save them as one
// would later autofill a NuVizz password into this site's sign-in box. So they sit OUTSIDE any
// <form> (Enter still saves — onEnter below), carry autocomplete="off", and the attributes the
// common password managers honour to stay out. No markup can force every browser to comply; this is
// the most a page can do. The sign-in, first-admin and change-password forms stay real forms:
// those ARE this site's login, and a password manager saving them is exactly right.
const NO_SAVE = { autoComplete: 'off', 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' };
// Enter in a FIELD saves; Enter on a BUTTON presses that button. These groups hold buttons too
// (Cancel, Hide, the two-way choices), and without the tagName check Enter on Cancel saved.
const onEnter = (fn) => (e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing && e.target?.tagName !== 'BUTTON') { e.preventDefault(); fn(); } };

const BTN = {
  primary: 'bg-sky-600 text-white hover:bg-sky-700 active:bg-sky-700 border border-sky-600',
  secondary: 'bg-white text-slate-800 hover:bg-slate-50 active:bg-slate-100 border border-slate-300',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-700 border border-rose-600',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 active:bg-slate-100 border border-transparent',
};

function Btn({ m, kind = 'secondary', busy = false, disabled = false, className = '', children, ...rest }) {
  const size = m ? 'min-h-[48px] px-4 rounded-xl text-[15px]' : 'px-3 py-1.5 rounded-lg text-sm';
  return (
    <button type="button" {...rest} disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 font-semibold disabled:opacity-40 ${size} ${BTN[kind] || BTN.secondary} ${className}`}>
      {busy && <Loader2 size={m ? 16 : 14} className="animate-spin shrink-0" />}
      {children}
    </button>
  );
}

function Field({ m, label, hint, children }) {
  return (
    <label className="block min-w-0">
      <span className={m ? 'text-[12px] font-semibold uppercase tracking-wide text-slate-500' : 'text-xs font-semibold text-slate-600'}>{label}</span>
      {children}
      {hint && <span className="block mt-1 text-[12px] text-slate-500">{hint}</span>}
    </label>
  );
}

const TONE = {
  ok: 'bg-emerald-50 text-emerald-900 border-emerald-200',
  warn: 'bg-amber-50 text-amber-900 border-amber-200',
  bad: 'bg-rose-50 text-rose-900 border-rose-200',
  none: 'bg-slate-50 text-slate-700 border-slate-200',
  info: 'bg-sky-50 text-sky-900 border-sky-200',
};

function Notice({ tone = 'info', children }) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2 text-[13px] leading-snug break-words ${TONE[tone] || TONE.info}`}>
      {children}
    </div>
  );
}

function ToneBox({ tone, title, detail }) {
  const Icon = tone === 'ok' ? Check : tone === 'bad' ? AlertTriangle : tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={`rounded-lg border px-3 py-2 ${TONE[tone] || TONE.none}`}>
      <div className="flex items-start gap-2 min-w-0">
        <Icon size={15} className="shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold break-words">{title}</div>
          {detail && <div className="text-[12px] leading-snug mt-0.5 break-words">{detail}</div>}
        </div>
      </div>
    </div>
  );
}

function Card({ m, title, icon, right, children }) {
  return (
    <section className={m ? 'rounded-2xl bg-white border border-slate-200 p-4 flex flex-col gap-3 min-w-0' : 'rounded-xl bg-white border border-slate-200 shadow-sm p-5 flex flex-col gap-3 min-w-0'}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className={`${m ? 'text-base' : 'text-[15px]'} font-bold text-slate-900 inline-flex items-center gap-2 min-w-0`}>
            {icon}<span className="min-w-0 break-words">{title}</span>
          </h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

const ROLE_CHIP = {
  admin: 'bg-violet-100 text-violet-800',
  dispatcher: 'bg-sky-100 text-sky-800',
  viewer: 'bg-slate-100 text-slate-700',
};
function RoleChip({ role }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${ROLE_CHIP[role] || ROLE_CHIP.viewer}`}>{role || 'viewer'}</span>;
}

const TONE_DOT = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-rose-500', none: 'bg-slate-300' };
const TONE_RANK = { bad: 0, warn: 1, none: 2, ok: 3 };

// The one place a temporary password is shown — once, with who it is for and what happens next.
export function TempPasswordBox({ m, displayName, username, password, emailed, gated = true }) {
  const [copied, setCopied] = useState('');
  const copy = async () => {
    try { await navigator.clipboard.writeText(password); setCopied('Copied.'); }
    catch { setCopied('Could not copy — select it and copy by hand.'); }
  };
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 flex flex-col gap-2">
      <div className="text-[13px] text-amber-900 leading-snug">
        {emailed
          ? <>A link to set a password was emailed to {displayName}. If it does not arrive, give them this temporary password instead:</>
          : <>Give this to {displayName} — in person or by phone. It is shown <b>once</b>. They sign in as <b className="break-all">{username}</b> {tempPasswordHandover({ gated })}</>}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <code className={`${m ? 'text-lg' : 'text-base'} font-mono font-bold tracking-wider text-slate-900 bg-white border border-amber-200 rounded px-2 py-1 break-all`}>{password}</code>
        <Btn m={m} onClick={copy}><Copy size={14} /> Copy</Btn>
      </div>
      {copied && <div className="text-[12px] text-amber-900">{copied}</div>}
    </div>
  );
}

// A PASSWORD THE ADMIN TYPES FOR SOMEONE ELSE (Chad, 2026-10-03: "I want to be able to set their
// password, reset it"). Used where a person is added and where one is managed. Two things about it
// are deliberate.
//
// IT IS NOT THIS SITE'S LOGIN FOR THE PERSON AT THE KEYBOARD. In a <form>, or as an ordinary
// new-password field, the browser offers to save it — over the admin's OWN saved password for this
// site. So, exactly like the NuVizz fields, it sits outside any form and carries NO_SAVE.
//
// IT IS SHOWN AS TYPED. The admin has to read it to the person anyway, there is no second "again"
// field to catch a slip, and a password mistyped blind is one nobody can sign in with — eight tries
// later the account is locked. Hide is one tap away in a crowded office.
const sentenceOf = (p) => (p ? `${p.charAt(0).toUpperCase()}${p.slice(1)}.` : '');
// Everything the server will refuse about a password an admin types (auth-core adminSetPasswordPlan):
// the edge-space rule that applies only to a password somebody else is told, then the site's policy.
const typedProblem = (pw, username) => typedPasswordEdgeProblem(pw) || passwordProblem(pw, username);
const groupLabel = (m) => (m ? 'text-[12px] font-semibold uppercase tracking-wide text-slate-500' : 'text-xs font-semibold text-slate-600');

export function TypedPasswordFields({ m, label, username, value, onChange, mustChange, onMustChange, disabled, gated }) {
  const [hidden, setHidden] = useState(false);
  const problem = value ? typedProblem(value, username) : null;
  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="flex flex-col gap-1 min-w-0">
        <div className={m ? 'flex flex-col gap-2' : 'flex flex-wrap items-end gap-2'}>
          <div className={m ? 'min-w-0' : 'min-w-0 flex-1 max-w-[340px]'}>
            <Field m={m} label={label}>
              <input type={hidden ? 'password' : 'text'} name="person-typed-secret" {...NO_SAVE} autoCapitalize="none" autoCorrect="off" spellCheck="false"
                value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={`${inputCls(m)} font-mono`} />
            </Field>
          </div>
          <Btn m={m} onClick={() => setHidden((v) => !v)} aria-pressed={hidden} disabled={disabled}>
            {hidden ? <><Eye size={15} /> Show</> : <><EyeOff size={15} /> Hide</>}
          </Btn>
        </div>
        <span className="text-[12px] text-slate-500 leading-snug">At least {PASSWORD_MIN} characters. Not their username, not one repeated character.</span>
        {problem && <span role="status" className="text-[12px] font-semibold text-amber-800 leading-snug">{sentenceOf(problem)}</span>}
      </div>
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className={groupLabel(m)}>After they sign in with it</span>
        <div className="flex flex-wrap gap-2" role="group" aria-label="After they sign in with it">
          {TYPED_PASSWORD_CHOICES.map((c) => (
            <Btn key={String(c.mustChange)} m={m} kind={mustChange === c.mustChange ? 'primary' : 'secondary'} aria-pressed={mustChange === c.mustChange}
              disabled={disabled} onClick={() => onMustChange(c.mustChange)}>{c.label}</Btn>
          ))}
        </div>
        <span className="text-[12px] text-slate-500 leading-snug break-words">{typedPasswordHint({ mustChange, gated })}</span>
      </div>
    </div>
  );
}

// ── the site, in two sentences ───────────────────────────────────────────────

function SiteStatusCard({ m, loginMode, facts, mode }) {
  const gateOn = loginMode === 'server';
  const rows = [
    { k: 'Sign-in', tone: gateOn ? 'ok' : 'warn', v: gateOn ? 'On — everyone signs in to open the board.' : 'Not switched on yet — the board opens without signing in.' },
    ...(facts.authRequired === true ? [{ k: 'Server', tone: 'ok', v: 'Refuses anyone who is not signed in.' }] : []),
    ...(facts.configured === false ? [{ k: 'Server', tone: 'bad', v: 'Sign-in is not set up on the server yet (AUTH_SESSION_SECRET), so no password will work. Tell Chad.' }] : []),
    { k: 'NuVizz changes', tone: mode ? 'none' : 'warn', v: modeSentence(mode) },
  ];
  return (
    <Card m={m} title="This site" icon={<ShieldCheck size={16} className="text-slate-500" />}>
      <dl className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={i} className={m ? 'flex flex-col gap-0.5' : 'grid grid-cols-[120px_minmax(0,1fr)] gap-3'}>
            <dt className="text-[12px] font-semibold uppercase tracking-wide text-slate-500 inline-flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${TONE_DOT[r.tone] || TONE_DOT.none}`} />{r.k}
            </dt>
            <dd className="text-[13px] text-slate-800 leading-snug break-words">{r.v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

// ── signing in, and the very first admin ────────────────────────────────────

function SignInCard({ m }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  const [setup, setSetup] = useState(false);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    setErr(''); setWarn(''); setBusy(true);
    const r = await signIn(username, password);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    // Reported as it happened: the Firebase leg is what gives the database rules someone to
    // recognise, and a failure there is a board quietly missing data later (auth-client.js).
    if (r.firebase?.state === 'failed') setWarn('Signed in, but the database connection did not complete — parts of the board may be missing. Tell Chad.');
    setPassword('');
  };

  return (
    <Card m={m} title="Sign in" icon={<KeyRound size={16} className="text-slate-500" />}>
      <p className="text-[13px] text-slate-600 leading-snug">
        Signing in is not required on this site yet. Sign in now and, once your NuVizz login is saved below, the changes you make go to NuVizz under your own name.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field m={m} label="Username">
          <input type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck="false"
            value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} className={inputCls(m)} placeholder="your username" />
        </Field>
        <Field m={m} label="Password">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
            disabled={busy} className={inputCls(m)} />
        </Field>
        {err && <Notice tone="bad">{err}</Notice>}
        {warn && <Notice tone="warn">{warn}</Notice>}
        <Btn m={m} kind="primary" type="submit" busy={busy} disabled={!username.trim() || !password}>{busy ? 'Signing in…' : 'Sign in'}</Btn>
      </form>
      <div className="border-t border-slate-100 pt-3 flex flex-col gap-3">
        <Btn m={m} kind="ghost" onClick={() => setSetup((v) => !v)} aria-expanded={setup} className="self-start">
          <UserCog size={15} /> First-time setup: create the admin account
        </Btn>
        {setup && <BootstrapForm m={m} />}
      </div>
    </Card>
  );
}

function BootstrapForm({ m }) {
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  const problem = newPersonProblem({ username, email, role: 'admin' })
    || (password ? passwordProblem(password, username.trim().toLowerCase()) : 'Choose a password.')
    || (confirm !== password ? 'The two passwords do not match.' : null);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    if (!code.trim()) { setErr('Enter the setup code.'); return; }
    if (problem) { setErr(problem.charAt(0).toUpperCase() + problem.slice(1)); return; }
    setErr(''); setBusy(true);
    const u = username.trim().toLowerCase();
    const r = await bootstrapFirstAdmin({ secret: code.trim(), username: u, displayName: displayName.trim(), email: email.trim(), password });
    if (!r.ok) { setBusy(false); setErr(r.error); return; }
    // The account exists; sign straight in with it so the next thing on screen is the admin view.
    const s = await signIn(u, password);
    setBusy(false);
    setDone(s.ok ? 'Admin account created, and you are signed in.' : `Admin account created. Sign in with it above. (${s.error})`);
  };

  if (done) return <Notice tone="info">{done}</Notice>;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-[12px] text-slate-500 leading-snug">
        Only for the very first account, and only while no admin exists. The setup code is the one set on the site in Netlify (AUTH_BOOTSTRAP_SECRET).
      </p>
      <Field m={m} label="Setup code">
        <input type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} className={inputCls(m)} />
      </Field>
      <div className={m ? 'flex flex-col gap-3' : 'grid grid-cols-2 gap-3'}>
        <Field m={m} label="Username" hint="Lower-case letters, digits, - or _">
          <input type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck="false"
            value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} className={inputCls(m)} />
        </Field>
        <Field m={m} label="Your name">
          <input type="text" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={busy} className={inputCls(m)} />
        </Field>
      </div>
      <Field m={m} label="Email (optional — for password resets)">
        <input type="email" autoComplete="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} className={inputCls(m)} />
      </Field>
      <div className={m ? 'flex flex-col gap-3' : 'grid grid-cols-2 gap-3'}>
        <Field m={m} label="Password" hint="At least 10 characters">
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} className={inputCls(m)} />
        </Field>
        <Field m={m} label="Password again">
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} className={inputCls(m)} />
        </Field>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <Btn m={m} kind="primary" type="submit" busy={busy}>Create the admin account</Btn>
    </form>
  );
}

// ── you ──────────────────────────────────────────────────────────────────────

function YouCard({ m, me, loginMode }) {
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const out = async () => { setBusy(true); await signOut(); };
  return (
    <Card m={m} title="You" icon={<KeyRound size={16} className="text-slate-500" />}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-semibold text-slate-900 break-words">{me.displayName || me.username}</div>
          <div className="text-[13px] text-slate-500 break-all">{me.username}</div>
        </div>
        <RoleChip role={me.role} />
      </div>
      {loginMode !== 'server' && (
        <p className="text-[12px] text-slate-500 leading-snug">
          Signing in is not required here yet — you are signed in because you chose to be. Signing out puts this device back on the shared NuVizz login.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Btn m={m} onClick={() => setChanging((v) => !v)} aria-expanded={changing}>Change password</Btn>
        <Btn m={m} onClick={out} busy={busy}><LogOut size={15} /> Sign out</Btn>
      </div>
      {changing && <ChangePasswordForm m={m} me={me} onDone={() => setChanging(false)} />}
    </Card>
  );
}

function ChangePasswordForm({ m, me, onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    const p = passwordProblem(next, me.username) || (next !== again ? 'the two new passwords do not match' : null);
    if (p) { setErr(p.charAt(0).toUpperCase() + p.slice(1) + '.'); return; }
    setErr(''); setBusy(true);
    const r = await changePassword(current, next);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setOk('Password changed. Every other device you were signed in on has been signed out.');
    setCurrent(''); setNext(''); setAgain('');
  };
  if (ok) return <div className="flex flex-col gap-2"><Notice tone="info">{ok}</Notice><Btn m={m} kind="ghost" onClick={onDone} className="self-start">Close</Btn></div>;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field m={m} label="Current password">
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy} className={inputCls(m)} />
      </Field>
      <Field m={m} label="New password" hint="At least 10 characters">
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} disabled={busy} className={inputCls(m)} />
      </Field>
      <Field m={m} label="New password again">
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} disabled={busy} className={inputCls(m)} />
      </Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Btn m={m} kind="primary" type="submit" busy={busy} disabled={!current || !next}>Change password</Btn>
        <Btn m={m} kind="ghost" onClick={onDone}>Cancel</Btn>
      </div>
    </form>
  );
}

// ── a NuVizz login: yours, or (admin) someone else's ────────────────────────

function NuvizzLoginPanel({ m, target, targetName, login, mode, site, onUpdated }) {
  const self = !target;
  const [editing, setEditing] = useState(!login?.saved);
  const [nvUser, setNvUser] = useState(login?.username || '');
  const [nvPass, setNvPass] = useState('');
  const [busy, setBusy] = useState(null);           // 'save' | 'test' | 'remove'
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  // A login that goes away (removed here, or elsewhere) reopens the form; one that arrives closes it.
  const saved = !!login?.saved;
  useEffect(() => { setEditing(!saved); }, [saved]);

  const badge = nuvizzBadge(login, mode);
  const keyReady = site?.keyReady !== false;
  const cost = Number(site?.checkCalls) || null;
  const costTxt = cost ? ` (${cost} NuVizz call${cost === 1 ? '' : 's'})` : '';

  const save = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    const p = nuvizzUsernameProblem(nvUser);
    if (p) { setErr(p); return; }
    if (!nvPass) { setErr('Enter the NuVizz password.'); return; }
    setBusy('save'); setErr(''); setNote('');
    const r = await saveNuvizzLogin({ username: target || undefined, nuvizzUsername: nvUser.trim(), nuvizzPassword: nvPass });
    setBusy(null);
    if (!r.ok) {
      setErr(r.error);
      if (r.data?.check) setNote(checkLine(r.data.check));
      return;
    }
    setNvPass('');
    setNote(`Saved. ${checkLine(r.check)}`);
    onUpdated?.(r.login);
  };
  const test = async () => {
    if (busy) return;
    setBusy('test'); setErr(''); setNote('');
    const r = await testNuvizzLogin({ username: target || undefined });
    setBusy(null);
    if (!r.ok) { setErr(r.error); return; }
    setNote(checkLine(r.check));
    onUpdated?.(r.login);
  };
  const remove = async () => {
    if (busy) return;
    setBusy('remove'); setErr(''); setNote('');
    const r = await removeNuvizzLogin({ username: target || undefined });
    setBusy(null); setConfirmRemove(false);
    if (!r.ok) { setErr(r.error); return; }
    setNvUser(''); setNote('Removed. Changes go out under the shared login until a new one is saved.');
    onUpdated?.(r.login);
  };

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <ToneBox tone={badge.tone} title={badge.label} detail={badge.detail} />
      {saved && (
        <p className="text-[12px] text-slate-500 leading-snug break-words">
          Saved {login.savedBy ? `by ${login.savedBy} ` : ''}{fmtWhen(login.savedAt)}. Last test: {checkLine(login.check)}
        </p>
      )}
      {!keyReady && <Notice tone="bad">This site cannot store NuVizz logins yet — it has no key to seal them with. Tell Chad.</Notice>}
      {saved && !editing && (
        <div className="flex flex-wrap gap-2">
          <Btn m={m} onClick={test} busy={busy === 'test'}>{busy === 'test' ? 'Asking NuVizz…' : `Test${costTxt}`}</Btn>
          <Btn m={m} onClick={() => { setEditing(true); setNvUser(login.username || ''); setNote(''); }}>Replace</Btn>
          {confirmRemove
            ? (<>
              <Btn m={m} kind="danger" onClick={remove} busy={busy === 'remove'}>Yes, remove it</Btn>
              <Btn m={m} kind="ghost" onClick={() => setConfirmRemove(false)}>Keep it</Btn>
            </>)
            : <Btn m={m} kind="ghost" onClick={() => setConfirmRemove(true)}>Remove</Btn>}
        </div>
      )}
      {editing && (
        <div onKeyDown={onEnter(save)} className="flex flex-col gap-3">
          <p className="text-[12px] text-slate-500 leading-snug">
            {self ? 'The username and password you use to sign in to NuVizz.' : `${targetName || target}'s NuVizz username and password.`}{' '}
            Stored encrypted and never shown again — not even to an admin. Saving asks NuVizz first{costTxt}; a login NuVizz refuses is not saved.
          </p>
          <div className={m ? 'flex flex-col gap-3' : 'grid grid-cols-2 gap-3'}>
            <Field m={m} label="NuVizz username">
              <input type="text" name="nuvizz-login-user" {...NO_SAVE} autoCapitalize="none" autoCorrect="off" spellCheck="false"
                value={nvUser} onChange={(e) => setNvUser(e.target.value)} disabled={!!busy || !keyReady} className={inputCls(m)} />
            </Field>
            <Field m={m} label="NuVizz password">
              <input type="password" name="nuvizz-login-secret" {...NO_SAVE}
                value={nvPass} onChange={(e) => setNvPass(e.target.value)} disabled={!!busy || !keyReady} className={inputCls(m)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn m={m} kind="primary" onClick={save} busy={busy === 'save'} disabled={!keyReady || !nvUser.trim() || !nvPass}>
              {busy === 'save' ? 'Asking NuVizz…' : `Save & test${costTxt}`}
            </Btn>
            {saved && <Btn m={m} kind="ghost" onClick={() => { setEditing(false); setNvPass(''); setErr(''); }}>Cancel</Btn>}
          </div>
        </div>
      )}
      {err && <Notice tone="bad">{err}</Notice>}
      {note && !err && <Notice tone="info">{note}</Notice>}
      <p className="text-[11px] text-slate-400 leading-snug">
        Repeated wrong passwords can lock a NuVizz account, so this app never retries a password NuVizz refused. Change it in NuVizz? Change it here too.
      </p>
    </div>
  );
}

function MyNuvizzCard({ m, mine, mode, onUpdated }) {
  return (
    <Card m={m} title="Your NuVizz login" icon={<Lock size={16} className="text-slate-500" />}>
      {!mine && <div className="text-[13px] text-slate-500 inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
      {mine?.error && <Notice tone="bad">{mine.error}</Notice>}
      {mine && !mine.error && <NuvizzLoginPanel m={m} login={mine.login} mode={mode} site={mine} onUpdated={onUpdated} />}
    </Card>
  );
}

// ── everyone (admins) ────────────────────────────────────────────────────────

export function AddPersonForm({ m, mailConfigured, mode, site, gated, onCreated, onClose }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('dispatcher');
  const [how, setHow] = useState('temp');           // 'temp' | 'typed' | 'invite' — how they get a password
  const [pw, setPw] = useState('');
  const [pwMust, setPwMust] = useState(false);
  const [nvUser, setNvUser] = useState('');
  const [nvPass, setNvPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);

  const reset = () => { setUsername(''); setDisplayName(''); setEmail(''); setRole('dispatcher'); setHow('temp'); setPw(''); setPwMust(false); setNvUser(''); setNvPass(''); setErr(''); setResult(null); };
  const canInvite = !!email.trim() && mailConfigured;
  // An emailed link needs an address to go to: with the email box emptied again, the choice falls
  // back to the temporary password rather than sending a request the server cannot honour.
  const way = how === 'invite' && !canInvite ? 'temp' : how;
  // A typed password lives only while "I type their password" is the chosen way. Picking another
  // drops it — otherwise coming back would show, in clear, a password that had been hidden.
  useEffect(() => { if (way !== 'typed') { setPw(''); setPwMust(false); } }, [way]);
  const cost = Number(site?.checkCalls) || null;

  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    const u = username.trim().toLowerCase();
    const typed = way === 'typed';
    const p = newPersonProblem({ username, email, role })
      || (typed ? (pw ? sentenceOf(typedProblem(pw, u)) : 'Type their password, or pick another way for them to get one.') : null)
      || (nvUser.trim() || nvPass ? (nuvizzUsernameProblem(nvUser) || (!nvPass ? 'Enter their NuVizz password too, or leave both NuVizz fields empty.' : null)) : null);
    if (p) { setErr(p); return; }
    setErr(''); setBusy(true);
    const name = displayName.trim() || u;
    const r = await userAction({
      action: 'create', username: u, displayName: name, email: email.trim() || undefined, role, sendInvite: way === 'invite',
      ...(typed ? { password: pw, mustChange: pwMust } : {}),
    });
    if (!r.ok) { setBusy(false); setErr(r.error); return; }
    // Whether they must replace it is what the SERVER stored (the row it sent back), not which
    // button was lit when this was pressed.
    const out = {
      username: u, displayName: name, tempPassword: r.tempPassword || null, invited: !!r.invited, nuvizz: null,
      typed, mustChange: r.user?.mustChangePassword === true,
    };
    if (nvUser.trim() && nvPass) {
      const n = await saveNuvizzLogin({ username: u, nuvizzUsername: nvUser.trim(), nuvizzPassword: nvPass });
      out.nuvizz = n.ok ? { ok: true, line: checkLine(n.check) } : { ok: false, error: n.error };
    }
    setBusy(false);
    setNvPass('');
    setPw('');
    setResult(out);
    onCreated?.();
  };

  if (result) {
    return (
      <Card m={m} title={`${result.displayName} added`} icon={<Check size={16} className="text-emerald-600" />}>
        {result.tempPassword && <TempPasswordBox m={m} displayName={result.displayName} username={result.username} password={result.tempPassword} emailed={result.invited} gated={gated} />}
        {result.typed && !result.tempPassword && <Notice tone="info">{typedPasswordAdded({ name: result.displayName, username: result.username, mustChange: result.mustChange, gated })}</Notice>}
        {result.nuvizz?.ok && <Notice tone="info">NuVizz login saved and tested: {result.nuvizz.line}</Notice>}
        {result.nuvizz && !result.nuvizz.ok && <Notice tone="bad">The account was created, but their NuVizz login was not saved: {result.nuvizz.error} Set it from their row below.</Notice>}
        {!result.nuvizz && <Notice tone="none">No NuVizz login saved yet — they can add their own under Account &amp; logins, or you can from their row below.</Notice>}
        <div className="flex flex-wrap gap-2">
          <Btn m={m} kind="primary" onClick={reset}><UserPlus size={15} /> Add another</Btn>
          <Btn m={m} kind="ghost" onClick={onClose}>Done</Btn>
        </div>
      </Card>
    );
  }

  return (
    <Card m={m} title="Add a person" icon={<UserPlus size={16} className="text-slate-500" />}>
      <div onKeyDown={onEnter(submit)} className="flex flex-col gap-3">
        <div className={m ? 'flex flex-col gap-3' : 'grid grid-cols-2 gap-3'}>
          <Field m={m} label="Username" hint="What they type to sign in. Lower-case letters, digits, - or _">
            <input type="text" name="new-person-username" {...NO_SAVE} autoCapitalize="none" autoCorrect="off" spellCheck="false"
              value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} className={inputCls(m)} />
          </Field>
          <Field m={m} label="Name" hint="How they show on screen">
            <input type="text" autoComplete="off" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={busy} className={inputCls(m)} />
          </Field>
          <Field m={m} label="Email (optional)" hint="Lets them reset their own password">
            <input type="email" autoComplete="off" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} className={inputCls(m)} />
          </Field>
          <Field m={m} label="Role" hint={ROLE_CHOICES.find((r) => r.value === role)?.hint}>
            <select value={role} onChange={(e) => setRole(e.target.value)} disabled={busy} className={inputCls(m)}>
              {ROLE_CHOICES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="flex flex-col gap-3 min-w-0">
          <div className="flex flex-col gap-1.5">
            <span className={groupLabel(m)}>How they get a password</span>
            <div className="flex flex-wrap gap-2" role="group" aria-label="How they get a password">
              <Btn m={m} kind={way === 'temp' ? 'primary' : 'secondary'} aria-pressed={way === 'temp'} disabled={busy} onClick={() => setHow('temp')}>I give them a temporary one</Btn>
              <Btn m={m} kind={way === 'typed' ? 'primary' : 'secondary'} aria-pressed={way === 'typed'} disabled={busy} onClick={() => setHow('typed')}><KeyRound size={15} /> I type their password</Btn>
              {canInvite && <Btn m={m} kind={way === 'invite' ? 'primary' : 'secondary'} aria-pressed={way === 'invite'} disabled={busy} onClick={() => setHow('invite')}><Mail size={15} /> Email them a link</Btn>}
            </div>
          </div>
          {way === 'typed' && (
            <TypedPasswordFields m={m} label="Their password" username={username.trim().toLowerCase()}
              value={pw} onChange={setPw} mustChange={pwMust} onMustChange={setPwMust} disabled={busy} gated={gated} />
          )}
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 flex flex-col gap-3">
          <div className="text-[13px] text-slate-700 leading-snug">
            <b>Their NuVizz login</b> (optional — they can add it themselves). Saved only if NuVizz accepts it{cost ? `; ${cost} NuVizz calls` : ''}.
          </div>
          <div className={m ? 'flex flex-col gap-3' : 'grid grid-cols-2 gap-3'}>
            <Field m={m} label="NuVizz username">
              <input type="text" name="nuvizz-login-user" {...NO_SAVE} autoCapitalize="none" autoCorrect="off" spellCheck="false"
                value={nvUser} onChange={(e) => setNvUser(e.target.value)} disabled={busy} className={inputCls(m)} />
            </Field>
            <Field m={m} label="NuVizz password">
              <input type="password" name="nuvizz-login-secret" {...NO_SAVE} value={nvPass} onChange={(e) => setNvPass(e.target.value)} disabled={busy} className={inputCls(m)} />
            </Field>
          </div>
        </div>
        {err && <Notice tone="bad">{err}</Notice>}
        <div className="flex flex-wrap gap-2">
          <Btn m={m} kind="primary" onClick={submit} busy={busy} disabled={!username.trim()}>{busy ? 'Adding…' : 'Add this person'}</Btn>
          <Btn m={m} kind="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Card>
  );
}

export function PersonManage({ m, me, user, mailConfigured, mode, site, gated, onChanged, onReload }) {
  const isSelf = user.username === me.username;
  const [role, setRole] = useState(user.role);
  const [displayName, setDisplayName] = useState(user.displayName || '');
  const [email, setEmail] = useState(user.email || '');
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null);     // 'set' | 'reset' | 'reset-email' | 'logout' | 'deactivate'
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [temp, setTemp] = useState(null);
  const [pw, setPw] = useState('');                 // the password being typed for them — never kept past a save
  const [pwMust, setPwMust] = useState(false);
  // The list reloads after every action; the fields follow what the SERVER now holds rather than
  // keeping the values this panel opened with (a role saved from another tab would otherwise
  // show as unsaved here, and "Save role" would quietly put the old one back).
  useEffect(() => { setRole(user.role); }, [user.role]);
  useEffect(() => { setDisplayName(user.displayName || ''); setEmail(user.email || ''); }, [user.displayName, user.email]);
  // A typed password lives only while its form is open: saved, cancelled, or closed by another
  // action in this panel, it is dropped. (A REFUSED save leaves the form — and what was typed — open.)
  useEffect(() => { if (confirm !== 'set') { setPw(''); setPwMust(false); } }, [confirm]);

  const act = async (key, body, success) => {
    if (busy) return;
    setBusy(key); setErr(''); setNote(''); setConfirm(null);
    const r = await userAction({ username: user.username, ...body });
    setBusy(null);
    if (!r.ok) { setErr(r.error); return null; }
    if (success) setNote(typeof success === 'function' ? success(r) : success);
    onReload?.();
    return r;
  };

  const name = user.displayName || user.username;
  const section = 'flex flex-col gap-2 min-w-0';
  const heading = 'text-[12px] font-semibold uppercase tracking-wide text-slate-500';
  const pwStatus = passwordStatus(user, { gated });

  // Not through act(): that closes the open panel before the answer is in, and a password the
  // server refuses (too short, contains their username) has to leave the form open with what was
  // typed still in it. On success the form closes — which drops the typed password (the effect
  // above) — and so does a temporary one still on show from an earlier reset: it no longer works.
  const savePassword = async () => {
    if (busy) return;
    const p = typedProblem(pw, user.username);
    if (p) { setErr(sentenceOf(p)); return; }
    setBusy('set'); setErr(''); setNote('');
    const r = await userAction({ username: user.username, action: 'set-password', password: pw, mustChange: pwMust });
    setBusy(null);
    if (!r.ok) { setErr(r.error); return; }
    setConfirm(null); setTemp(null);
    setNote(setPasswordAnswer(r, { name, username: user.username, gated }));
    onReload?.();
  };

  return (
    <div className={m ? 'flex flex-col gap-4 pt-3 border-t border-slate-100' : 'grid grid-cols-2 gap-5 p-4 bg-slate-50 rounded-lg border border-slate-200'}>
      <div className={section}>
        <div className={heading}>NuVizz login</div>
        <NuvizzLoginPanel m={m} target={user.username} targetName={name} login={user.nuvizz} mode={mode} site={site}
          onUpdated={(login) => onChanged?.({ ...user, nuvizz: login })} />
      </div>

      <div className="flex flex-col gap-4 min-w-0">
        <div className={section}>
          <div className={heading}>Role</div>
          {isSelf
            ? <p className="text-[13px] text-slate-600">You cannot change your own role — another admin has to.</p>
            : (
              <div className="flex flex-wrap items-end gap-2">
                <select value={role} onChange={(e) => setRole(e.target.value)} disabled={!!busy} className={`${inputCls(m)} ${m ? '' : 'max-w-[220px]'}`} aria-label={`Role for ${name}`}>
                  {ROLE_CHOICES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <Btn m={m} kind="primary" disabled={role === user.role} busy={busy === 'role'}
                  onClick={() => act('role', { action: 'update', role }, `${name} is now ${role === 'admin' ? 'an admin' : `a ${role}`}. Their sessions were signed out so the change takes effect now.`)}>
                  Save role
                </Btn>
              </div>
            )}
        </div>

        <div className={section}>
          <div className={heading}>Name &amp; email</div>
          <div className={m ? 'flex flex-col gap-2' : 'grid grid-cols-2 gap-2'}>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={!!busy} className={inputCls(m)} aria-label={`Name for ${name}`} />
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!busy} className={inputCls(m)} placeholder="no email" aria-label={`Email for ${name}`} />
          </div>
          <Btn m={m} className="self-start" busy={busy === 'details'}
            disabled={displayName.trim() === (user.displayName || '') && email.trim() === (user.email || '')}
            onClick={() => act('details', { action: 'update', displayName: displayName.trim(), email: email.trim() || null }, 'Saved.')}>
            Save name &amp; email
          </Btn>
        </div>

        <div className={section}>
          <div className={heading}>Password &amp; access</div>
          {pwStatus && <p className={`text-[12px] leading-snug break-words ${pwStatus.tone === 'warn' ? 'text-amber-800' : 'text-slate-500'}`}>{pwStatus.text}</p>}
          {temp && <TempPasswordBox m={m} displayName={name} username={user.username} password={temp} emailed={false} gated={gated} />}
          {user.locked && <Notice tone="warn">Locked until {fmtWhen(user.lockedUntil)} after too many wrong passwords. Unlock lets them try again now.</Notice>}
          {confirm === 'set' ? (
            <div onKeyDown={onEnter(savePassword)} className="flex flex-col gap-3 min-w-0">
              <TypedPasswordFields m={m} label="New password" username={user.username} value={pw} onChange={setPw}
                mustChange={pwMust} onMustChange={setPwMust} disabled={!!busy} gated={gated} />
              <Notice tone="warn">{setPasswordWarning(user)}</Notice>
              <div className="flex flex-wrap gap-2">
                {/* Off while ANY action in this panel is in flight, not only its own: savePassword
                    returns on `busy`, and a Save that is pressable and does nothing is the worst kind. */}
                <Btn m={m} kind="primary" busy={busy === 'set'} disabled={!!busy || !pw || !!typedProblem(pw, user.username)} onClick={savePassword}>Save password</Btn>
                <Btn m={m} kind="ghost" disabled={busy === 'set'} onClick={() => { setConfirm(null); setErr(''); }}>Cancel</Btn>
              </div>
            </div>
          ) : confirm === 'reset' || confirm === 'reset-email' ? (
            <div className="flex flex-col gap-2">
              <Notice tone="warn">This signs {name} out everywhere{confirm === 'reset-email' ? ' and emails them a link to set a new password.' : ' and gives them a new temporary password.'}</Notice>
              <div className="flex flex-wrap gap-2">
                <Btn m={m} kind="danger" busy={busy === 'reset'} onClick={async () => {
                  const r = await act('reset', { action: 'reset', ...(confirm === 'reset' ? { tempPassword: true } : {}) });
                  const out = resetAnswer(r, { email: user.email, asked: confirm === 'reset' ? 'temp' : 'email' });
                  if (out?.temp) setTemp(out.temp);
                  else if (out?.note) setNote(out.note);
                  else if (out?.error) setErr(out.error);
                }}>Yes, reset it</Btn>
                <Btn m={m} kind="ghost" onClick={() => setConfirm(null)}>Cancel</Btn>
              </div>
            </div>
          ) : confirm === 'logout' ? (
            <div className="flex flex-col gap-2">
              <Notice tone="warn">Sign {name} out on every device?</Notice>
              <div className="flex flex-wrap gap-2">
                <Btn m={m} kind="danger" busy={busy === 'logout'} onClick={() => act('logout', { action: 'logout-all' }, `${name} was signed out everywhere.`)}>Yes, sign them out</Btn>
                <Btn m={m} kind="ghost" onClick={() => setConfirm(null)}>Cancel</Btn>
              </div>
            </div>
          ) : confirm === 'deactivate' ? (
            <div className="flex flex-col gap-2">
              <Notice tone="warn">Turn off {name}'s account? They are signed out at once and cannot sign back in until it is turned on again.</Notice>
              <div className="flex flex-wrap gap-2">
                <Btn m={m} kind="danger" busy={busy === 'active'} onClick={() => act('active', { action: 'update', active: false }, `${name}'s account is off.`)}>Yes, turn it off</Btn>
                <Btn m={m} kind="ghost" onClick={() => setConfirm(null)}>Cancel</Btn>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!isSelf && <Btn m={m} onClick={() => { setErr(''); setNote(''); setConfirm('set'); }}><KeyRound size={15} /> Set a password</Btn>}
              <Btn m={m} onClick={() => setConfirm('reset')}>New temporary password</Btn>
              {user.email && mailConfigured && <Btn m={m} onClick={() => setConfirm('reset-email')}><Mail size={15} /> Email a reset link</Btn>}
              {user.locked && <Btn m={m} busy={busy === 'unlock'} onClick={() => act('unlock', { action: 'unlock' }, `${name} is unlocked.`)}><Unlock size={15} /> Unlock</Btn>}
              <Btn m={m} onClick={() => setConfirm('logout')}><LogOut size={15} /> Sign out everywhere</Btn>
              {!isSelf && (user.active === false
                ? <Btn m={m} busy={busy === 'active'} onClick={() => act('active', { action: 'update', active: true }, `${name}'s account is on again.`)}>Turn account back on</Btn>
                : <Btn m={m} kind="ghost" className="text-rose-700" onClick={() => setConfirm('deactivate')}>Turn account off</Btn>)}
            </div>
          )}
          {isSelf && <p className="text-[12px] text-slate-500 leading-snug">Your own password: use Change password under You — it asks for your current one.</p>}
        </div>
        {err && <Notice tone="bad">{err}</Notice>}
        {note && !err && <Notice tone="info">{note}</Notice>}
      </div>
    </div>
  );
}

function statusChips(u) {
  const out = [];
  if (u.active === false) out.push({ k: 'off', label: 'Account off', cls: 'bg-slate-200 text-slate-700' });
  // Just the word: the pill sits in a narrow table column, and the time it lifts is said in full
  // in the Manage panel, beside the Unlock button that is the thing to do about it.
  if (u.locked) out.push({ k: 'locked', label: 'Locked', title: `Locked until ${fmtWhen(u.lockedUntil)}`, cls: 'bg-rose-100 text-rose-800' });
  if (u.mustChangePassword) out.push({ k: 'temp', label: 'Temporary password', cls: 'bg-amber-100 text-amber-900' });
  return out;
}

function PeopleSection({ m, me, people, mode, site, loginMode, facts, onReload }) {
  const [users, setUsers] = useState(people?.users || []);
  useEffect(() => { setUsers(people?.users || []); }, [people]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const r = readiness(users, mode);

  const rows = useMemo(() => users.map((u) => {
    const badge = nuvizzBadge(u.nuvizz, mode);
    return { ...u, _name: (u.displayName || u.username || '').toLowerCase(), _nv: TONE_RANK[badge.tone] ?? 2, _last: u.lastLoginAt || '', _badge: badge };
  }), [users, mode]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, '_name', 'asc');
  const replace = (next) => setUsers((list) => list.map((u) => (u.username === next.username ? next : u)));

  const summary = `${r.total} ${r.total === 1 ? 'person' : 'people'} · ${r.nuvizzOk} of ${r.writers} NuVizz logins working${r.neverSignedIn ? ` · ${r.neverSignedIn} never signed in` : ''}${r.locked ? ` · ${r.locked} locked` : ''}`;

  // Whether this build puts the sign-in screen in front of the board: the forced password change
  // lives on that gate, so every sentence about a temporary password depends on it.
  const gated = loginMode === 'server';
  const manage = (u) => (
    <PersonManage m={m} me={me} user={u} mailConfigured={!!people?.mailConfigured} mode={mode} site={site} gated={gated}
      onChanged={replace} onReload={onReload} />
  );

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <Card m={m} title="Everyone" icon={<Users size={16} className="text-slate-500" />}
        right={<Btn m={m} kind="primary" onClick={() => setAdding((v) => !v)} aria-expanded={adding}><UserPlus size={15} /> Add a person</Btn>}>
        <p className="text-[13px] text-slate-600 break-words">{summary}</p>
        {people?.error && (
          <Notice tone="bad">
            {people.error}
            {/* Its own line: the server's sentence may or may not end in a full stop. */}
            {people.stale && <span className="block mt-1">The list below is as it last loaded. Press Refresh to read it again.</span>}
          </Notice>
        )}
        {adding && <AddPersonForm m={m} mailConfigured={!!people?.mailConfigured} mode={mode} site={site} gated={gated} onCreated={onReload} onClose={() => setAdding(false)} />}

        {m ? (
          <div className="flex flex-col gap-3">
            {sorted.map((u) => (
              <div key={u.username} className="rounded-xl border border-slate-200 p-3 flex flex-col gap-2 min-w-0">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 break-words">{u.displayName || u.username}{u.username === me.username ? ' (you)' : ''}</div>
                    <div className="text-[13px] text-slate-500 break-all">{u.username}</div>
                  </div>
                  <RoleChip role={u.role} />
                </div>
                <div className="flex items-start gap-2 text-[13px] text-slate-700 min-w-0">
                  <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${TONE_DOT[u._badge.tone]}`} />
                  <span className="min-w-0 break-words">{u._badge.label}</span>
                </div>
                <div className="text-[12px] text-slate-500">Last signed in: {fmtWhen(u.lastLoginAt)}</div>
                {statusChips(u).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {statusChips(u).map((c) => <span key={c.k} title={c.title} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${c.cls}`}>{c.label}</span>)}
                  </div>
                )}
                <Btn m={m} onClick={() => setOpen(open === u.username ? null : u.username)} aria-expanded={open === u.username}>
                  {open === u.username ? 'Close' : 'Manage'}
                </Btn>
                {open === u.username && manage(u)}
              </div>
            ))}
          </div>
        ) : (
          <div className="min-w-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-y border-slate-200">
                <tr>
                  <SortableTh label="Person" k="_name" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Role" k="role" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <SortableTh label="NuVizz login" k="_nv" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Last signed in" k="_last" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <th className="px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">Account</th>
                  <th className="px-2 py-1" aria-label="Manage" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((u) => (
                  <React.Fragment key={u.username}>
                    <tr className={`border-b border-slate-100 align-top ${open === u.username ? 'bg-sky-50/60' : ''}`}>
                      <td className="px-2 py-2 min-w-0">
                        <div className="font-semibold text-slate-900 break-words">{u.displayName || u.username}{u.username === me.username ? ' (you)' : ''}</div>
                        <div className="text-[12px] text-slate-500 break-all">{u.username}</div>
                        {u.email && <div className="text-[12px] text-slate-500 break-all">{u.email}</div>}
                      </td>
                      <td className="px-2 py-2"><RoleChip role={u.role} /></td>
                      <td className="px-2 py-2">
                        <div className="flex items-start gap-2 min-w-0">
                          <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${TONE_DOT[u._badge.tone]}`} />
                          <span className="min-w-0 break-words text-slate-800">{u._badge.label}</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-slate-700 whitespace-nowrap">{fmtWhen(u.lastLoginAt)}</td>
                      <td className="px-2 py-2">
                        <div className="flex flex-wrap gap-1">
                          {statusChips(u).length
                            ? statusChips(u).map((c) => <span key={c.k} title={c.title} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${c.cls}`}>{c.label}</span>)
                            : <span className="text-[12px] text-slate-500">On</span>}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <Btn onClick={() => setOpen(open === u.username ? null : u.username)} aria-expanded={open === u.username}>
                          {open === u.username ? 'Close' : 'Manage'}
                        </Btn>
                      </td>
                    </tr>
                    {open === u.username && (
                      <tr className="border-b border-slate-200">
                        <td colSpan={6} className="px-2 py-3">{manage(u)}</td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            {!sorted.length && !people?.error && <p className="text-[13px] text-slate-500 py-3">Loading people…</p>}
          </div>
        )}
      </Card>
      <RolloutCard m={m} loginMode={loginMode} facts={facts} mode={mode} users={users} />
    </div>
  );
}

const STEP_ICON = {
  done: <Check size={15} className="text-emerald-600" />,
  todo: <CircleDashed size={15} className="text-amber-600" />,
  unknown: <Info size={15} className="text-slate-500" />,
  optional: <CircleDashed size={15} className="text-slate-400" />,
};

function RolloutCard({ m, loginMode, facts, mode, users }) {
  const steps = rolloutSteps({ loginMode, configured: facts.configured, authRequired: facts.authRequired, mode, users });
  return (
    <Card m={m} title="Turning sign-in on" icon={<ShieldCheck size={16} className="text-slate-500" />}>
      <p className="text-[13px] text-slate-600 leading-snug">In this order — accounts first, then the lock. Each line reads its state back from the server or this build; the one the app cannot read says so.</p>
      <ol className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <li key={s.key} className="flex items-start gap-2 min-w-0">
            <span className="shrink-0 mt-0.5">{STEP_ICON[s.state] || STEP_ICON.unknown}</span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-slate-900 break-words">{i + 1}. {s.label}</div>
              <div className="text-[12px] text-slate-600 leading-snug break-words">{s.detail}</div>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function AboutCard({ m, mode }) {
  return (
    <Card m={m} title="Why everyone has their own login" icon={<Info size={16} className="text-slate-500" />}>
      <ul className="flex flex-col gap-2 text-[13px] text-slate-700 leading-snug list-disc pl-5">
        <li>Every change you make that reaches NuVizz — a route saved from the Route Workbench, a driver assigned, a load dispatched, a note, a new order, an address fix — goes to NuVizz under <b>your</b> NuVizz login once it is saved here, so NuVizz's history shows who made it.</li>
        <li>Your NuVizz password is stored encrypted on the server and is never shown again — not to you, not to an admin.</li>
        <li>If NuVizz stops accepting it (you changed it in NuVizz, say), the app stops using it straight away instead of trying again, so NuVizz does not lock your account. Re-enter it here.</li>
        <li>The overnight scans and other automatic reads are nobody's action, so they keep using the shared login.</li>
        <li>Once signing in is required on this site, this screen is for admins only. From then on an admin changes your password or NuVizz login for you, and you sign out from the menu.</li>
        <li>{modeSentence(mode)}</li>
      </ul>
    </Card>
  );
}

// ── the screen ───────────────────────────────────────────────────────────────

/**
 * `loginMode` — App.jsx's LOGIN_MODE: 'server' when this build puts the sign-in screen in front of
 * the board (VITE_LOGIN_ENABLED), 'off' otherwise. With it off this screen is still where people
 * sign in and set their logins up, which is the whole point: the accounts must exist and work
 * BEFORE the lock goes on, or the lock is a password box nobody can pass on a 700-stop morning.
 */
export default function AccountScreen({ isMobile, loginMode = 'off' }) {
  const m = !!isMobile;
  const [session, setSession] = useState(() => getSession());
  useEffect(() => subscribeSession(setSession), []);
  const me = session?.user?.username ? session.user : null;
  const meName = me?.username || null;
  const isAdmin = me?.role === 'admin';

  const [facts, setFacts] = useState({ configured: null, authRequired: null });
  const [mine, setMine] = useState(null);
  const [mode, setMode] = useState(null);
  const [people, setPeople] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // What the SERVER is enforcing, read back — never assumed. `null` is "it did not say", which is
  // different from false and is shown differently (account-view.js rolloutSteps).
  const loadFacts = useCallback(async () => {
    const f = await fetchMe();
    const answered = f.ok || f.status === 401;
    setFacts({
      configured: typeof f.configured === 'boolean' ? f.configured : null,
      authRequired: answered ? f.authRequired === true : null,
    });
  }, []);

  const loadMine = useCallback(async () => {
    if (!meName) { setMine(null); setMode(await siteMode()); return; }
    const r = await fetchNuvizzLogin();
    if (r.ok) { setMine(r); setMode(r.mode ?? null); }
    else setMine({ error: r.error });
  }, [meName]);

  const loadPeople = useCallback(async () => {
    if (!isAdmin) { setPeople(null); return; }
    const r = await fetchUsers();
    // A FAILED RE-READ KEEPS THE ROWS ALREADY ON SCREEN and says the read failed. Emptying the list
    // here unmounts every open Manage panel — and with it the answer to whichever action asked for
    // the re-read: a temporary password that is shown once, or "Password set for …". The admin would
    // be left with "no connection" straight after a change that had in fact landed.
    setPeople((prev) => (r.ok
      ? { users: Array.isArray(r.users) ? r.users : [], mailConfigured: !!r.mailConfigured }
      : { users: prev?.users || [], mailConfigured: !!prev?.mailConfigured, error: r.error, stale: (prev?.users?.length || 0) > 0 }));
  }, [isAdmin]);

  useEffect(() => { loadFacts(); }, [loadFacts, meName]);
  useEffect(() => { loadMine(); }, [loadMine]);
  useEffect(() => { loadPeople(); }, [loadPeople]);

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([loadFacts(), loadMine(), loadPeople()]);
    setRefreshing(false);
  };

  const onMyLogin = (login) => setMine((prev) => (prev && !prev.error ? { ...prev, login } : prev));
  // An admin changing their own row in the table keeps the "Your NuVizz login" card in step.
  const reloadPeopleAndMine = async () => { await Promise.all([loadPeople(), loadMine()]); };

  const header = (
    <div className={m ? 'flex items-start justify-between gap-3' : 'flex items-end justify-between gap-4'}>
      <div className="min-w-0">
        <h1 className={`${m ? 'text-xl' : 'text-2xl'} font-bold text-slate-900`}>Account &amp; logins</h1>
        <p className="text-[13px] text-slate-500 mt-0.5">
          {isAdmin ? 'Your sign-in and NuVizz login — and everyone else\'s.' : 'Your sign-in and your NuVizz login.'}
        </p>
      </div>
      <Btn m={m} onClick={refreshAll} busy={refreshing} aria-label="Refresh"><RefreshCw size={15} />{m ? '' : ' Refresh'}</Btn>
    </div>
  );

  const left = (
    <>
      <SiteStatusCard m={m} loginMode={loginMode} facts={facts} mode={mode} />
      {me ? <YouCard m={m} me={me} loginMode={loginMode} /> : <SignInCard m={m} />}
      {me && <MyNuvizzCard m={m} mine={mine} mode={mode} onUpdated={(login) => { onMyLogin(login); if (isAdmin) loadPeople(); }} />}
    </>
  );
  const right = isAdmin
    ? <PeopleSection m={m} me={me} people={people} mode={mode} site={mine && !mine.error ? mine : null} loginMode={loginMode} facts={facts} onReload={reloadPeopleAndMine} />
    : <AboutCard m={m} mode={mode} />;

  if (m) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50">
        <div className="px-4 py-4 flex flex-col gap-4">
          {header}
          {left}
          {right}
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50">
      <div className="px-6 py-5 flex flex-col gap-5">
        {header}
        <div className="grid grid-cols-[minmax(340px,420px)_minmax(0,1fr)] gap-6 items-start">
          <div className="flex flex-col gap-5 min-w-0">{left}</div>
          <div className="flex flex-col gap-5 min-w-0">{right}</div>
        </div>
      </div>
    </div>
  );
}
