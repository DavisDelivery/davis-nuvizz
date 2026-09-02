// PasswordScreens.jsx — the two screens that SET a password.
//
//   ChangePasswordScreen — the forced change. An admin created the account with a
//     temporary password; the board is not shown until it is replaced. A temporary
//     password a person is allowed to postpone changing is a permanent password, and
//     this is a fleet where the same three passwords end up on the same whiteboard.
//   ResetPasswordScreen  — arrived from the emailed /reset-password?u=..&t=.. link.
//     Succeeding here signs the person straight in; making them type the new password
//     again on a login screen is a step that teaches nothing and loses people.
//
// TWO VIEWS EACH, written out separately — phone first, then desktop. Chad: "mobile and
// desktop should be treated as 2 different views." The phone keeps 16px inputs (iOS zooms
// the page on anything smaller) and 48px+ targets; the desktop is a centred card.
//
// THE RULE IS SHOWN BEFORE IT IS ENFORCED. The policy line sits under the field from the
// first keystroke, and the local check (lib/auth-client.passwordProblem, a mirror of the
// server's) refuses before the round trip. The server still decides — this only stops the
// form from teaching by rejection.
import React, { useMemo, useState } from 'react';
import { changePassword, confirmPasswordReset, passwordProblem, PASSWORD_MIN } from '../lib/auth-client.js';

const POLICY = `At least ${PASSWORD_MIN} characters. Not your username, not one repeated character.`;

/** PURE-ish: what is wrong with this pair right now, or '' when it is ready to send. */
function pairProblem(next, confirm, username) {
  if (!next) return '';
  const p = passwordProblem(next, username);
  if (p) return p.charAt(0).toUpperCase() + p.slice(1);
  if (confirm && next !== confirm) return 'The two passwords do not match.';
  return '';
}

// ═══ FORCED PASSWORD CHANGE ═════════════════════════════════════════════════

export function ChangePasswordScreen({ isMobile, appVersion, user, onSignOut }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const username = user?.username || '';
  const localProblem = useMemo(() => pairProblem(next, confirm, username), [next, confirm, username]);
  const canSubmit = !!current && !!next && next === confirm && !localProblem && !busy;

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!canSubmit) return;
    setErr(''); setBusy(true);
    const res = await changePassword(current, next);
    if (!res.ok) { setErr(res.error); setBusy(false); return; }
    if (res.firebase?.state === 'failed') {
      // The password changed and the new session is stored — but the Firebase leg that
      // gives the Firestore rules a request.auth did not complete, and a board missing
      // every receiving hour must never be handed over silently.
      setErr('Password changed, but the database connection did not complete. Reload the page; tell Chad if it happens again.');
      setBusy(false);
      return;
    }
    // On success the gate re-reads the session (mustChangePassword is now false) and
    // mounts the board; `busy` stays true through the swap.
  };

  // ── PHONE ──────────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="min-h-[100dvh] bg-slate-900 flex flex-col px-5 pt-16 pb-8">
        <div className="mb-6">
          <div className="text-[11px] font-bold tracking-[0.18em] text-sky-400 uppercase">Davis Delivery</div>
          <h1 className="text-2xl font-bold text-white mt-1">Choose a password</h1>
          <p className="text-[13px] text-slate-400 mt-2 leading-snug">
            {username ? <><span className="font-semibold text-slate-300">{username}</span> was set up with a temporary password. </> : null}
            Pick your own before the board opens.
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Temporary password</span>
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[48px] rounded-xl bg-slate-800 border border-slate-700 px-4 text-base text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none" />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">New password</span>
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[48px] rounded-xl bg-slate-800 border border-slate-700 px-4 text-base text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none" />
            <span className="block mt-1 text-[11px] text-slate-500">{POLICY}</span>
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">New password again</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[48px] rounded-xl bg-slate-800 border border-slate-700 px-4 text-base text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none" />
          </label>

          {localProblem && <div role="status" className="rounded-xl bg-slate-800 border border-slate-700 px-4 py-3 text-[13px] text-amber-200">{localProblem}</div>}
          {err && <div role="alert" className="rounded-xl bg-rose-950 border border-rose-800 px-4 py-3 text-[13px] text-rose-200">{err}</div>}

          <button type="submit" disabled={!canSubmit}
            className="mt-2 w-full min-h-[52px] rounded-xl bg-sky-600 text-white text-base font-semibold disabled:opacity-40 active:bg-sky-700">
            {busy ? 'Saving…' : 'Save and open the board'}
          </button>
          <button type="button" onClick={onSignOut} disabled={busy}
            className="w-full min-h-[48px] rounded-xl text-slate-400 text-[15px] font-semibold active:bg-slate-800">
            Sign out
          </button>
        </form>

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
          <h1 className="text-2xl font-bold text-slate-900 mt-1">Choose a password</h1>
          <p className="text-sm text-slate-500 mt-2">
            {username ? <><span className="font-semibold text-slate-700">{username}</span> was set up with a temporary password. </> : null}
            Pick your own before the board opens.
          </p>
        </div>

        <form onSubmit={submit} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">Temporary password</span>
            <input type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none" />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">New password</span>
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none" />
            <span className="block mt-1 text-[11px] text-slate-500">{POLICY}</span>
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">New password again</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none" />
          </label>

          {localProblem && <div role="status" className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[13px] text-amber-800">{localProblem}</div>}
          {err && <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[13px] text-rose-700">{err}</div>}

          <button type="submit" disabled={!canSubmit}
            className="w-full min-h-[42px] rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-40">
            {busy ? 'Saving…' : 'Save and open the board'}
          </button>
          <button type="button" onClick={onSignOut} disabled={busy}
            className="text-[13px] text-slate-500 font-semibold hover:underline self-center">
            Sign out
          </button>
        </form>

        <div className="text-center mt-4 text-[11px] text-slate-400">v{appVersion}</div>
      </div>
    </div>
  );
}

// ═══ RESET FROM THE EMAILED LINK ════════════════════════════════════════════

export function ResetPasswordScreen({ isMobile, appVersion, link, onDone }) {
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const username = link?.username || '';
  const localProblem = useMemo(() => pairProblem(next, confirm, username), [next, confirm, username]);
  const canSubmit = !!next && next === confirm && !localProblem && !busy;

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!canSubmit) return;
    setErr(''); setNote(''); setBusy(true);
    const res = await confirmPasswordReset(link.username, link.token, next);
    if (!res.ok) { setErr(res.error); setBusy(false); return; }
    if (!res.signedIn) {
      // The password IS set, but AUTH_SESSION_SECRET is not configured so no session can
      // be minted. Retrying will not help, so it is said plainly instead of looking like
      // a failure the person could fix by trying again.
      setNote(res.note);
      setBusy(false);
      return;
    }
    onDone?.();
  };

  // ── PHONE ──────────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="min-h-[100dvh] bg-slate-900 flex flex-col px-5 pt-16 pb-8">
        <div className="mb-6">
          <div className="text-[11px] font-bold tracking-[0.18em] text-sky-400 uppercase">Davis Delivery</div>
          <h1 className="text-2xl font-bold text-white mt-1">Set a new password</h1>
          <p className="text-[13px] text-slate-400 mt-2 leading-snug">
            For <span className="font-semibold text-slate-300">{username}</span>. This link works once and expires an hour after it was sent.
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">New password</span>
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[48px] rounded-xl bg-slate-800 border border-slate-700 px-4 text-base text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none" />
            <span className="block mt-1 text-[11px] text-slate-500">{POLICY}</span>
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">New password again</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[48px] rounded-xl bg-slate-800 border border-slate-700 px-4 text-base text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none" />
          </label>

          {localProblem && <div role="status" className="rounded-xl bg-slate-800 border border-slate-700 px-4 py-3 text-[13px] text-amber-200">{localProblem}</div>}
          {note && <div role="status" className="rounded-xl bg-emerald-950 border border-emerald-800 px-4 py-3 text-[13px] text-emerald-200">{note}</div>}
          {err && <div role="alert" className="rounded-xl bg-rose-950 border border-rose-800 px-4 py-3 text-[13px] text-rose-200">{err}</div>}

          <button type="submit" disabled={!canSubmit}
            className="mt-2 w-full min-h-[52px] rounded-xl bg-sky-600 text-white text-base font-semibold disabled:opacity-40 active:bg-sky-700">
            {busy ? 'Saving…' : 'Set password and sign in'}
          </button>
          <button type="button" onClick={onDone} disabled={busy}
            className="w-full min-h-[48px] rounded-xl text-slate-400 text-[15px] font-semibold active:bg-slate-800">
            Back to sign in
          </button>
        </form>

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
          <h1 className="text-2xl font-bold text-slate-900 mt-1">Set a new password</h1>
          <p className="text-sm text-slate-500 mt-2">
            For <span className="font-semibold text-slate-700">{username}</span>. This link works once and expires an hour after it was sent.
          </p>
        </div>

        <form onSubmit={submit} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">New password</span>
            <input type="password" autoComplete="new-password" autoFocus value={next} onChange={(e) => setNext(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none" />
            <span className="block mt-1 text-[11px] text-slate-500">{POLICY}</span>
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">New password again</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy}
              className="mt-1 w-full min-h-[42px] rounded-lg border border-slate-300 px-3 text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none" />
          </label>

          {localProblem && <div role="status" className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[13px] text-amber-800">{localProblem}</div>}
          {note && <div role="status" className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-[13px] text-emerald-800">{note}</div>}
          {err && <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[13px] text-rose-700">{err}</div>}

          <button type="submit" disabled={!canSubmit}
            className="w-full min-h-[42px] rounded-lg bg-sky-600 text-white text-sm font-semibold hover:bg-sky-700 disabled:opacity-40">
            {busy ? 'Saving…' : 'Set password and sign in'}
          </button>
          <button type="button" onClick={onDone} disabled={busy}
            className="text-[13px] text-slate-500 font-semibold hover:underline self-center">
            Back to sign in
          </button>
        </form>

        <div className="text-center mt-4 text-[11px] text-slate-400">v{appVersion}</div>
      </div>
    </div>
  );
}
