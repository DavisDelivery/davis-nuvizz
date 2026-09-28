// NuvizzLoginBar.jsx — "NuVizz refused your saved login", said where the dispatcher is looking.
//
// Raised by src/lib/nuvizz-login-notice.js from the answer to any write (the Route Workbench Save,
// a note, an assign, a new order). A whole-app bar, the same family as RoleRefusalBar and
// PermissionBanner in App.jsx: it sits above the header, it cannot be scrolled past, and it names
// the one thing to do — get the NuVizz login re-entered under Account & logins. Two views, like
// every bar in this app.
//
// WHO CAN DO IT (v1.82.2). Before sign-in goes live everyone can open Account & logins, so the bar
// carries a button that goes there. After it, that screen is admins-only (accountsTabVisible in
// lib/auth-gate.js) and Shell passes `onOpen={null}` for everyone else: a button into a screen the
// person cannot open would be a dead end at the worst moment, so the bar says who to ask instead.
import React from 'react';
import { KeyRound } from 'lucide-react';

export const ASK_ADMIN = 'Ask Chad or another admin to update it.';

export default function NuvizzLoginBar({ notice, isMobile, onOpen, onDismiss, atTop = true }) {
  if (!notice) return null;

  // ── PHONE ────────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div role="alert" className="shrink-0 flex flex-col gap-1.5 px-4 py-2 bg-amber-500 text-amber-950 text-[12px] font-semibold"
        style={atTop ? { paddingTop: 'calc(0.5rem + env(safe-area-inset-top))' } : undefined}>
        <div className="flex items-start gap-2 min-w-0">
          <KeyRound size={14} className="shrink-0 mt-0.5" />
          <span className="min-w-0 break-words">{notice.text}{onOpen ? null : <> {ASK_ADMIN}</>}</span>
        </div>
        <div className="pl-6 flex flex-wrap gap-2">
          {onOpen && <button type="button" onClick={onOpen} className="rounded bg-amber-950 px-2.5 py-1 text-[11px] font-bold text-amber-50 active:bg-amber-900">Open Account &amp; logins</button>}
          <button type="button" onClick={onDismiss} className="rounded bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-950 active:bg-amber-200">Dismiss</button>
        </div>
      </div>
    );
  }

  // ── DESKTOP ──────────────────────────────────────────────────────────────
  return (
    <div role="alert" className="shrink-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 px-4 py-1.5 bg-amber-500 text-amber-950 text-xs font-semibold"
      style={atTop ? { paddingTop: 'calc(0.375rem + env(safe-area-inset-top))' } : undefined}>
      <KeyRound size={13} className="shrink-0" />
      <span className="min-w-0">{notice.text}{onOpen ? null : <> {ASK_ADMIN}</>}</span>
      {onOpen && <button type="button" onClick={onOpen} className="shrink-0 rounded bg-amber-950 px-2.5 py-1 text-[11px] font-bold text-amber-50 hover:bg-amber-900">Open Account &amp; logins</button>}
      <button type="button" onClick={onDismiss} className="shrink-0 rounded bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-950 hover:bg-amber-200">Dismiss</button>
    </div>
  );
}
