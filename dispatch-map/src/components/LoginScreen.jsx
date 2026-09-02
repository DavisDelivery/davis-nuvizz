// LoginScreen.jsx — the one screen a dispatcher sees before the board.
//
// USERNAME AND PASSWORD, NOT EMAIL. This screen used to sign in against Firebase
// Authentication with an email address. The system that the Netlify Functions actually
// verify is the app_users store (netlify/functions/auth-*.mts) and it is keyed by a
// USERNAME — lower-case, 2–40 characters, no '@'. Pointing this at the other one meant
// the login worked and every gated endpoint still answered 401, which is the worst of
// both: a screen that says you are in and a board that behaves as if you are not.
//
// TWO VIEWS, NOT ONE RESPONSIVE ONE. Chad: "mobile and desktop should be treated as 2
// different views and quit trying to take the easy way out and make screens work for
// both." A phone at 6am in a truck cab and a desktop at the dispatch station want
// different things from this screen, so they are written separately below:
//
//   PHONE   — full-bleed, one column, 16px inputs (anything smaller makes iOS zoom the
//             page on focus, which is how a login screen becomes unusable one-handed),
//             48px+ targets, the primary action under the thumb.
//   DESKTOP — a centred card on a calm background, the branding line intact, keyboard
//             order that lets someone tab straight through it.
//
// Both are driven by the same submit handlers, so the two views can never disagree about
// what signing in DOES — only about how it looks.
import React, { useState } from 'react';
import { signIn, requestPasswordReset } from '../lib/auth-client.js';

/**
 * `mode` is local state, not a route: the forgot-password step is one field and a
 * confirmation, and pushing it through the URL would give a half-finished reset a
 * bookmarkable address for no gain.
 */
export default function LoginScreen({ isMobile, appVersion, notice }) {
  const [mode, setMode] = useState('signin');
  if (mode === 'forgot') {
    return <ForgotPassword isMobile={isMobile} appVersion={appVersion} onBack={() => setMode('signin')} />;
  }
  return <SignIn isMobile={isMobile} appVersion={appVersion} notice={notice} onForgot={() => setMode('forgot')} />;
}

// ═══ SIGN IN ════════════════════════════════════════════════════════════════

function SignIn({ isMobile, appVersion, notice, onForgot }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');

  // ONE handler for both views. Reports what actually happened — a failed sign-in says
  // why in words a person can act on, and never silently leaves the button spinning.
  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    setErr(''); setWarn(''); setBusy(true);
    const res = await signIn(username, password);
    if (!res.ok) { setErr(res.error); setBusy(false); return; }
    // THE SECOND LEG, REPORTED HONESTLY. The password check is only half of signing in:
    // the session is also redeemed for a Firebase custom token, and that is the ONLY
    // thing that gives the Firestore rules a request.auth to read. If it fails, the board
    // will load and be silently missing every receiving hour — so it is said out loud
    // here rather than assumed. 'skipped' means Firebase is not configured in this build
    // at all, which is a legitimate preview deploy and not a warning.
    if (res.firebase?.state === 'failed') {
      setWarn('Signed in, but the database connection did not complete — parts of the board may be missing. Tell Chad.');
    }
    // On success the session observer swaps this screen for the board; leave `busy` true
    // so the button cannot be double-fired during the swap.
  };

  const canSubmit = !!username.trim() && !!password && !busy;

  // ── PHONE ──────────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="min-h-[100dvh] bg-slate-900 flex flex-col px-5 pt-16 pb-8">
        <div className="mb-8">
          <div className="text-[11px] font-bold tracking-[0.18em] text-sky-400 uppercase">Davis Delivery</div>
          <h1 className="text-2xl font-bold text-white mt-1">Dispatch</h1>
          <p className="text-[13px] text-slate-400 mt-2 leading-snug">Sign in once — this device stays signed in.</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Username</span>
            {/* text-base (16px) is deliberate: iOS zooms the whole page when a focused
                input is smaller, and a zoomed login screen on a phone is a bad morning.
                autoCapitalize off because usernames are lower-case and iOS capitalises
                the first letter of every field it is not told about. */}
            <input type="text" inputMode="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck="false"
              value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[48px] rounded-xl bg-slate-800 border border-slate-700 px-4 text-base text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              placeholder="your username" />
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Password</span>
            <input type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[48px] rounded-xl bg-slate-800 border border-slate-700 px-4 text-base text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              placeholder="••••••••" />
          </label>

          {notice && <div role="status" className="rounded-xl bg-slate-800 border border-slate-700 px-4 py-3 text-[13px] text-slate-300">{notice}</div>}
          {err && <div role="alert" className="rounded-xl bg-rose-950 border border-rose-800 px-4 py-3 text-[13px] text-rose-200">{err}</div>}
          {warn && <div role="alert" className="rounded-xl bg-amber-950 border border-amber-800 px-4 py-3 text-[13px] text-amber-200">{warn}</div>}

          <button type="submit" disabled={!canSubmit}
            className="mt-2 w-full min-h-[52px] rounded-xl bg-sky-600 text-white text-base font-semibold disabled:opacity-40 active:bg-sky-700">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <button type="button" onClick={onForgot} disabled={busy}
            className="w-full min-h-[48px] rounded-xl text-sky-400 text-[15px] font-semibold active:bg-slate-800">
            Forgot my password
          </button>
        </form>

        <div className="mt-auto pt-8 text-[11px] text-slate-600">
          <div>No account? Ask Chad. · v{appVersion}</div>
        </div>
      </div>
    );
  }

  // ── DESKTOP ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-[420px]">
        <div className="text-center mb-6">
          <div className="text-[11px] font-bold tracking-[0.2em] text-sky-700 uppercase">Davis Delivery</div>
          <h1 className="text-3xl font-bold text-slate-900 mt-1">Dispatch</h1>
          <p className="text-sm text-slate-500 mt-2">Sign in to open the board.</p>
        </div>

        <form onSubmit={submit} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">Username</span>
            <input type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck="false" autoFocus
              value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
              placeholder="your username" />
          </label>

          <label className="block">
            <span className="text-xs font-semibold text-slate-600">Password</span>
            <input type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
              placeholder="••••••••" />
          </label>

          {notice && <div role="status" className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-[13px] text-slate-600">{notice}</div>}
          {err && <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[13px] text-rose-700">{err}</div>}
          {warn && <div role="alert" className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[13px] text-amber-800">{warn}</div>}

          <button type="submit" disabled={!canSubmit}
            className="w-full min-h-[42px] rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-40">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <button type="button" onClick={onForgot} disabled={busy}
            className="text-[13px] text-sky-700 font-semibold hover:underline self-center">
            Forgot my password
          </button>
        </form>

        <div className="text-center mt-4 text-[11px] text-slate-400">
          <div className="mt-0.5">No account? Ask Chad. · v{appVersion}</div>
        </div>
      </div>
    </div>
  );
}

// ═══ FORGOT PASSWORD ════════════════════════════════════════════════════════
//
// THE ANSWER IS THE SAME WHETHER OR NOT THE ACCOUNT EXISTS. auth-reset-request.mts
// deliberately returns one generic success for every input so this page cannot be used to
// find out who works here, and the screen must not undo that by being more helpful. The
// wording therefore says "if that account exists" and never "we sent it".

function ForgotPassword({ isMobile, appVersion, onBack }) {
  const [identifier, setIdentifier] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState('');

  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    setErr(''); setBusy(true);
    const res = await requestPasswordReset(identifier);
    setBusy(false);
    if (!res.ok) { setErr(res.error); return; }
    setSent(res.message);
  };

  const canSubmit = !!identifier.trim() && !busy;

  // ── PHONE ──────────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="min-h-[100dvh] bg-slate-900 flex flex-col px-5 pt-16 pb-8">
        <div className="mb-8">
          <div className="text-[11px] font-bold tracking-[0.18em] text-sky-400 uppercase">Davis Delivery</div>
          <h1 className="text-2xl font-bold text-white mt-1">Reset your password</h1>
          <p className="text-[13px] text-slate-400 mt-2 leading-snug">
            Enter your username or the email on your account. If we have it, a reset link goes to that address.
          </p>
        </div>

        {sent ? (
          <div className="flex flex-col gap-3">
            <div role="status" className="rounded-xl bg-emerald-950 border border-emerald-800 px-4 py-3 text-[13px] text-emerald-200">{sent}</div>
            <p className="text-[12px] text-slate-500 leading-snug">
              The link lasts one hour. If nothing arrives, check junk mail — then ask Chad, because the account may
              have no email address on it.
            </p>
            <button type="button" onClick={onBack}
              className="mt-2 w-full min-h-[52px] rounded-xl bg-sky-600 text-white text-base font-semibold active:bg-sky-700">
              Back to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Username or email</span>
              <input type="text" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck="false"
                value={identifier} onChange={(e) => setIdentifier(e.target.value)} disabled={busy}
                className="mt-1 w-full min-h-[48px] rounded-xl bg-slate-800 border border-slate-700 px-4 text-base text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                placeholder="your username" />
            </label>

            {err && <div role="alert" className="rounded-xl bg-rose-950 border border-rose-800 px-4 py-3 text-[13px] text-rose-200">{err}</div>}

            <button type="submit" disabled={!canSubmit}
              className="mt-2 w-full min-h-[52px] rounded-xl bg-sky-600 text-white text-base font-semibold disabled:opacity-40 active:bg-sky-700">
              {busy ? 'Sending…' : 'Send the reset link'}
            </button>
            <button type="button" onClick={onBack} disabled={busy}
              className="w-full min-h-[48px] rounded-xl text-slate-400 text-[15px] font-semibold active:bg-slate-800">
              Back to sign in
            </button>
          </form>
        )}

        <div className="mt-auto pt-8 text-[11px] text-slate-600">v{appVersion}</div>
      </div>
    );
  }

  // ── DESKTOP ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-[420px]">
        <div className="text-center mb-6">
          <div className="text-[11px] font-bold tracking-[0.2em] text-sky-700 uppercase">Davis Delivery</div>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">Reset your password</h1>
          <p className="text-sm text-slate-500 mt-2">
            Enter your username or the email on your account.
          </p>
        </div>

        {sent ? (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-3">
            <div role="status" className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-[13px] text-emerald-800">{sent}</div>
            <p className="text-[12px] text-slate-500 leading-snug">
              The link lasts one hour. If nothing arrives, check junk mail — then ask Chad, because the account may
              have no email address on it.
            </p>
            <button type="button" onClick={onBack}
              className="w-full min-h-[42px] rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700">
              Back to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
            <label className="block">
              <span className="text-xs font-semibold text-slate-600">Username or email</span>
              <input type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck="false" autoFocus
                value={identifier} onChange={(e) => setIdentifier(e.target.value)} disabled={busy}
                className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
                placeholder="your username" />
            </label>

            {err && <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[13px] text-rose-700">{err}</div>}

            <button type="submit" disabled={!canSubmit}
              className="w-full min-h-[42px] rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-40">
              {busy ? 'Sending…' : 'Send the reset link'}
            </button>
            <button type="button" onClick={onBack} disabled={busy}
              className="text-[13px] text-slate-500 font-semibold hover:underline self-center">
              Back to sign in
            </button>
          </form>
        )}

        <div className="text-center mt-4 text-[11px] text-slate-400">v{appVersion}</div>
      </div>
    </div>
  );
}
