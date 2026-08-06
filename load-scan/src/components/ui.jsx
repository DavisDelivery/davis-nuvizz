// ui.jsx — the chrome every screen is built out of.
//
// Header, Banner, BigButton, Modal and ConfirmAction were defined in App.jsx and
// used from one end of it to the other. They hold no app state and know nothing
// about loads, scans or drivers, so they were the clearest seam in the file:
// moving them changes nothing about how the app behaves and takes a chunk of
// scrolling out of the way of the code that does.
//
// Behaviour is byte-for-byte what it was; only the location changed.

import React, { useEffect, useState } from 'react';
import { PackageCheck, XCircle } from 'lucide-react';

import { APP_VERSION, BUILD_COMMIT } from '../lib/build.js';

export function Header({ title, subtitle, right }) {
  return (
    <div className="bg-[#1e5b92] px-4 py-3 text-white flex items-center gap-3 sticky top-0 z-20">
      <PackageCheck className="w-6 h-6 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h1 className="text-base font-semibold leading-tight truncate">{title}</h1>
        {subtitle ? <p className="text-xs text-white/70 leading-tight truncate">{subtitle}</p> : null}
      </div>
      {right}
      {/* Version, far right on every screen. Bumped on every merged PR, so
          "which build is that phone on" is answered by looking at it rather
          than by asking the driver to describe what they see. */}
      <span className="text-[11px] font-mono text-white/70 shrink-0 tabular-nums" title={`build ${BUILD_COMMIT}`}>
        v{APP_VERSION}
      </span>
    </div>
  );
}

export function Banner({ kind, children }) {
  const tone = {
    info: 'bg-slate-50 ring-slate-200 text-slate-700',
    warn: 'bg-amber-50 ring-amber-300 text-amber-900',
    error: 'bg-rose-50 ring-rose-300 text-rose-900',
    good: 'bg-emerald-50 ring-emerald-300 text-emerald-900',
  }[kind || 'info'];
  return <div className={`rounded-xl px-3 py-2 text-sm ring-1 ${tone}`}>{children}</div>;
}

export const BigButton = ({ children, onClick, disabled, tone = 'primary', type = 'button' }) => {
  const cls = {
    primary: 'bg-[#1e5b92] hover:bg-[#194b78] active:bg-[#153f64] text-white',
    ghost: 'bg-white ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50',
    danger: 'bg-rose-600 hover:bg-rose-700 text-white',
  }[tone];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      // 48px min target: gloves, 5am, one hand.
      className={`w-full rounded-xl px-4 py-3 text-base font-medium transition-colors disabled:opacity-50 ${cls}`}
    >
      {children}
    </button>
  );
};

/**
 * A centred overlay. The dispatcher screen used to render its editor at the
 * BOTTOM of a fifty-row table, so clicking "edit" populated a form three
 * thousand pixels below the click and the button looked broken. An editor that
 * cannot be off-screen cannot have that bug.
 */
export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // Stop the table scrolling behind the dialog on touch.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-start sm:items-center justify-center p-3 overflow-y-auto"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg my-auto rounded-2xl bg-white shadow-xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 sticky top-0 bg-white rounded-t-2xl">
          <div className="font-semibold text-slate-800 flex-1 truncate">{title}</div>
          <button type="button" onClick={onClose} className="p-1 -mr-1 text-slate-500" aria-label="Close">
            <XCircle className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
      </div>
    </div>
  );
}

/** Destructive actions get a deliberate second click, never a lone one. */
export function ConfirmAction({ label, confirmLabel, onConfirm, disabled, tone = 'danger' }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed) {
    return (
      <button type="button" className="text-xs underline" disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setArmed(false); onConfirm(); }}
        className={`text-xs rounded px-2 py-0.5 text-white ${tone === 'danger' ? 'bg-rose-600' : 'bg-[#1e5b92]'}`}
      >
        {confirmLabel}
      </button>
      <button type="button" className="text-xs underline text-slate-500" onClick={() => setArmed(false)}>
        cancel
      </button>
    </span>
  );
}
