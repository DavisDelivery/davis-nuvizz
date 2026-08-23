// LoginScreen.jsx — the one screen a dispatcher sees before the board.
//
// TWO VIEWS, NOT ONE RESPONSIVE ONE. Chad: "mobile and desktop should be treated as 2
// different views and quit trying to take the easy way out and make screens work for
// both." A phone at 6am in a truck cab and a desktop at the dispatch station want
// different things from this screen, so they are written separately below:
//
//   PHONE   — full-bleed, one column, 16px inputs (anything smaller makes iOS zoom the
//             page on focus, which is how a login screen becomes unusable one-handed),
//             48px targets, the primary action under the thumb.
//   DESKTOP — a centred card on a calm background, the branding line intact, keyboard
//             order that lets someone tab straight through it.
//
// Both are driven by the same submit handler, so the two views can never disagree about
// what signing in DOES — only about how it looks.
import React, { useState } from 'react';
import { signInWithPassword, signInWithGoogle, allowedDomains } from '../lib/auth.js';

const GOOGLE_MARK = (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
    <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
    <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
    <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
  </svg>
);

export default function LoginScreen({ isMobile, appVersion }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const domains = allowedDomains();

  // ONE handler for both views. Reports what actually happened — a failed sign-in says
  // why in words a person can act on (see auth-gate.friendlyAuthError), and never
  // silently leaves the button spinning.
  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    setErr(''); setBusy(true);
    const res = await signInWithPassword(email, password);
    if (!res.ok) { setErr(res.message); setBusy(false); }
    // On success the auth observer swaps this screen for the board; leave `busy` true so
    // the button cannot be double-fired during the swap.
  };

  const google = async () => {
    if (busy) return;
    setErr(''); setBusy(true);
    const res = await signInWithGoogle();
    if (!res.ok) { setErr(res.message); setBusy(false); }
  };

  const canSubmit = !!email.trim() && !!password && !busy;

  // ── PHONE ────────────────────────────────────────────────────────────────
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
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Email</span>
            {/* text-base (16px) is deliberate: iOS zooms the whole page when a focused
                input is smaller, and a zoomed login screen on a phone is a bad morning. */}
            <input type="email" inputMode="email" autoComplete="username" autoCapitalize="none"
              value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[48px] rounded-xl bg-slate-800 border border-slate-700 px-4 text-base text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              placeholder="you@company.com" />
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Password</span>
            <input type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[48px] rounded-xl bg-slate-800 border border-slate-700 px-4 text-base text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
              placeholder="••••••••" />
          </label>

          {err && <div role="alert" className="rounded-xl bg-rose-950 border border-rose-800 px-4 py-3 text-[13px] text-rose-200">{err}</div>}

          <button type="submit" disabled={!canSubmit}
            className="mt-2 w-full min-h-[52px] rounded-xl bg-sky-600 text-white text-base font-semibold disabled:opacity-40 active:bg-sky-700">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="flex items-center gap-3 my-1">
            <div className="h-px flex-1 bg-slate-700" />
            <span className="text-[11px] text-slate-500">or</span>
            <div className="h-px flex-1 bg-slate-700" />
          </div>

          <button type="button" onClick={google} disabled={busy}
            className="w-full min-h-[52px] rounded-xl bg-white text-slate-800 text-base font-semibold inline-flex items-center justify-center gap-2.5 disabled:opacity-40">
            {GOOGLE_MARK} Sign in with Google
          </button>
        </form>

        <div className="mt-auto pt-8 text-[11px] text-slate-600">
          {domains ? <div className="mb-1">Accounts on {domains}</div> : null}
          <div>No account? Ask Chad. · v{appVersion}</div>
        </div>
      </div>
    );
  }

  // ── DESKTOP ──────────────────────────────────────────────────────────────
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
            <span className="text-xs font-semibold text-slate-600">Email</span>
            <input type="email" autoComplete="username" autoFocus
              value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
              placeholder="you@company.com" />
          </label>

          <label className="block">
            <span className="text-xs font-semibold text-slate-600">Password</span>
            <input type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none"
              placeholder="••••••••" />
          </label>

          {err && <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[13px] text-rose-700">{err}</div>}

          <button type="submit" disabled={!canSubmit}
            className="w-full min-h-[42px] rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-40">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-[11px] text-slate-400">or</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <button type="button" onClick={google} disabled={busy}
            className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-semibold inline-flex items-center justify-center gap-2 hover:bg-slate-50 disabled:opacity-40">
            {GOOGLE_MARK} Sign in with Google
          </button>
        </form>

        <div className="text-center mt-4 text-[11px] text-slate-400">
          {domains ? <div>Accounts on {domains}</div> : null}
          <div className="mt-0.5">No account? Ask Chad. · v{appVersion}</div>
        </div>
      </div>
    </div>
  );
}
