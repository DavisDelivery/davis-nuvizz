// src/components/UatModeBar.jsx — THE UAT SITE'S LIVE / PLANNING SWITCH, ON EVERY SCREEN.
//
// Mounted by the shell only on a UAT host (isUatHost, src/lib/mirror-site.js), so production never
// renders it. What the two modes mean and why planning is a server-side VIEW of the stored board
// rather than a rewrite: netlify/functions/lib/uat-planning-mode.mts. The words: lib/uat-mode-bar.js.
//
// Flipping it reloads the page. Every screen's board, loads and solver answers are served through
// the switch, and a reload is the one way to be sure nothing on screen is still the other mode's.
//
// TWO VIEWS (CLAUDE.md). The phone stacks the sentence over the button and carries the notch inset
// when it is the top bar; the desktop is one line. Both sit in the shell's flow stack, never pinned.
import React, { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Radio, AlertTriangle, Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/api.js';
import { uatModeView } from '../lib/uat-mode-bar.js';

const FN = '/.netlify/functions/uat-planning-mode';

const TONE = {
  planning: 'bg-violet-700 text-white',
  live: 'bg-emerald-50 text-emerald-900 border-b border-emerald-200',
  off: 'bg-emerald-50 text-emerald-900 border-b border-emerald-200',
  unknown: 'bg-amber-50 text-amber-900 border-b border-amber-200',
};
const BUTTON = {
  planning: 'bg-white text-violet-800 hover:bg-violet-50',
  live: 'bg-violet-700 text-white hover:bg-violet-800',
};

export default function UatModeBar({ isMobile = false, atTop = false }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    apiFetch(FN, { cache: 'no-store' })
      .then((r) => r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` })))
      .then((j) => { if (alive) setState(j); })
      .catch((e) => { if (alive) setState({ ok: false, error: e?.message || 'unreachable' }); });
    return () => { alive = false; };
  }, []);

  const view = uatModeView(state);

  const flip = useCallback(async () => {
    if (view.next === null || busy) return;
    setBusy(true); setError('');
    try {
      const r = await apiFetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planning: view.next }) });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      // The server answers with the switch as READ BACK. Reload only when it says what was asked.
      if (j?.ok && j.planning === view.next) { window.location.reload(); return; }
      setError(j?.error || `HTTP ${r.status}`);
    } catch (e) {
      setError(e?.message || 'could not reach the switch');
    }
    setBusy(false);
  }, [view.next, busy]);

  const Icon = view.mode === 'planning' ? FlaskConical : view.mode === 'unknown' ? AlertTriangle : Radio;
  const tone = TONE[view.mode] || TONE.unknown;
  const button = view.action ? (
    <button type="button" onClick={flip} disabled={busy} data-uat-mode-action={view.next ? 'planning' : 'live'}
      className={`shrink-0 inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-bold disabled:opacity-60 ${BUTTON[view.mode] || BUTTON.live}`}>
      {busy && <Loader2 size={11} className="animate-spin" />}
      {busy ? 'Switching…' : view.action}
    </button>
  ) : null;

  if (isMobile) {
    return (
      <div data-uat-mode={view.mode} className={`shrink-0 flex flex-col gap-1 px-4 py-2 text-[12px] ${tone}`}
        style={atTop ? { paddingTop: 'calc(0.5rem + env(safe-area-inset-top))' } : undefined}>
        <div className="flex items-start gap-2 min-w-0">
          <Icon size={14} className="shrink-0 mt-0.5" />
          <span className="min-w-0"><b>{view.title}</b> — {view.detail}</span>
        </div>
        {(button || error) && (
          <div className="flex flex-wrap items-center gap-2 pl-6">
            {button}
            {error && <span className="font-semibold">{error}</span>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-uat-mode={view.mode} className={`shrink-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 px-4 py-1 text-xs ${tone}`}
      style={atTop ? { paddingTop: 'calc(0.25rem + env(safe-area-inset-top))' } : undefined}>
      <Icon size={13} className="shrink-0" />
      <span className="min-w-0"><b>{view.title}</b> — {view.detail}</span>
      {button}
      {error && <span className="font-semibold">{error}</span>}
    </div>
  );
}
