// ClaudeShadowScreen.jsx — THE CLAUDE SHADOW TAB.
//
// Claude plans tomorrow's loads beside the router, for comparison only. This first cut is the
// plumbing: it shows whether the planner is switched on, which model it would use, whether the
// server holds an API key, and the one test call that proves the key reaches that model.
//
// WHAT THIS SCREEN MAY TOUCH IS A CI RULE, NOT A HABIT. scripts/check-shadow-isolation.mjs
// walks this file's imports and fails the build if it reaches anything outside src/shadow/
// other than lib/api.js (the one place a session token gets onto a request) and lib/session.js
// — so no Route Workbench or Build Panel code, no Firestore client, no NuVizz writer. It has
// no send, save or stage control, and the only endpoint it calls is its own.
//
// TWO VIEWS (CLAUDE.md): the desktop view lays the three cards out side by side; the phone
// view is one column of cards with 44px targets. They share the data hook and the small
// presentational pieces, not the layout.
import React, { useCallback, useEffect, useState } from 'react';
import { Sparkles, Power, Cpu, KeyRound, FlaskConical, RefreshCw, CheckCircle2, XCircle, CircleDashed } from 'lucide-react';
import { apiFetch } from '../lib/api.js';

const ENDPOINT = '/.netlify/functions/claude-shadow';

function fmtUsd(v) {
  if (typeof v !== 'number') return '—';
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}
function fmtWhen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
  } catch { return iso; }
}

function useShadowStatus() {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await apiFetch(ENDPOINT);
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setStatus(j);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runProbe = useCallback(async () => {
    const ok = window.confirm('This makes ONE call to the model (well under 1¢ at list price). Run the test call?');
    if (!ok) return;
    setProbing(true); setProbeMsg(null);
    try {
      const r = await apiFetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'probe', confirm: true }),
      });
      const j = await r.json().catch(() => null);
      if (!j) setProbeMsg(`HTTP ${r.status} — no readable answer`);
      else if (j.calls === 0) setProbeMsg(j.error || 'No call was made.');
      else if (j.recorded && !j.recorded.last) setProbeMsg(`The call was made but its record was not written: ${j.recorded.error || 'unknown'}`);
      await load();
    } catch (e) {
      setProbeMsg(String(e?.message || e));
    } finally {
      setProbing(false);
    }
  }, [load]);

  return { status, err, loading, load, probing, probeMsg, runProbe };
}

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-t border-slate-100 first:border-t-0">
      <span className="text-xs text-slate-500 shrink-0">{label}</span>
      <span className="text-xs text-slate-800 text-right break-words min-w-0">{children}</span>
    </div>
  );
}

function Verdict({ good, children }) {
  return (
    <span className={`inline-flex items-center gap-1 ${good ? 'text-emerald-700' : 'text-rose-700'}`}>
      {good ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {children}
    </span>
  );
}

function SwitchCard({ s }) {
  return (
    <section className="rounded-xl border bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800 inline-flex items-center gap-2"><Power size={14} /> Switches</h2>
      <div className="mt-2">
        <Row label="CLAUDE_SHADOW"><Verdict good={s.enabled}>{s.enabled ? 'on' : 'off — no model calls'}</Verdict></Row>
        <Row label="Model">
          <span className="inline-flex items-center gap-1"><Cpu size={12} /> {s.model}</span>
          <span className="block text-[11px] text-slate-500">{s.modelSource === 'env' ? 'from CLAUDE_SHADOW_MODEL' : 'default'}{s.modelRejected ? ` (ignored malformed value “${s.modelRejected}”)` : ''}</span>
        </Row>
        <Row label="API key"><span className="inline-flex items-center gap-1"><KeyRound size={12} /> {s.keyConfigured ? 'set on the server' : 'not set'}</span></Row>
        <Row label="Writes go to">{s.prefix}* only</Row>
        <Row label="NuVizz calls">0, on every path</Row>
      </div>
    </section>
  );
}

function ProbeCard({ s, probing, probeMsg, onProbe }) {
  const p = s.lastProbe;
  return (
    <section className="rounded-xl border bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800 inline-flex items-center gap-2"><FlaskConical size={14} /> Test call</h2>
      <p className="text-xs text-slate-500 mt-1">One small call that proves the key reaches the model with the request shape the planner will use: effort set explicitly, one strict tool, and the model left to choose it.</p>
      {!p && <p className="text-xs text-slate-600 mt-3">{s.lastProbeNote || 'No test call has been recorded yet.'}</p>}
      {p && (
        <div className="mt-2">
          <Row label="When">{fmtWhen(p.at)}{p.by ? ` · ${p.by}` : ''}</Row>
          <Row label="Reached the API"><Verdict good={p.reached}>{p.reached ? `yes (HTTP ${p.httpStatus})` : `no — ${p.error || `HTTP ${p.httpStatus ?? '—'}`}`}</Verdict></Row>
          <Row label="Model asked / served">{p.requestedModel} / {p.servedModel || '—'}</Row>
          <Row label="Called the tool"><Verdict good={p.toolCalled}>{p.toolCalled ? 'yes' : 'no'}</Verdict></Row>
          <Row label="Stop reason">{p.stopReason || '—'}</Row>
          <Row label="Tokens in / out">{p.cost ? `${p.cost.tokens.input} / ${p.cost.tokens.output}` : '—'}</Row>
          <Row label="Cost">{fmtUsd(p.cost?.usd)}<span className="block text-[11px] text-slate-500">{p.cost?.basis || ''}</span></Row>
          <Row label="Took">{typeof p.ms === 'number' ? `${(p.ms / 1000).toFixed(1)}s` : '—'}</Row>
        </div>
      )}
      {probeMsg && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{probeMsg}</p>}
      <button
        onClick={onProbe}
        disabled={probing || !s.enabled || !s.keyConfigured}
        className="mt-3 w-full sm:w-auto rounded-lg border px-3 py-2 min-h-[44px] text-xs font-semibold bg-white hover:bg-slate-50 disabled:opacity-50 inline-flex items-center justify-center gap-2"
      >
        {probing ? <RefreshCw size={12} className="animate-spin" /> : <FlaskConical size={12} />}
        {probing ? 'Calling…' : 'Run test call (1 call)'}
      </button>
    </section>
  );
}

function PlanCard({ s }) {
  return (
    <section className="rounded-xl border bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800 inline-flex items-center gap-2"><CircleDashed size={14} /> Nightly plan</h2>
      <p className="text-xs text-slate-600 mt-1">Nothing plans yet. This tab proves the plumbing first; each piece below lands in its own release.</p>
      <ul className="mt-2 space-y-1">
        {(s.built || []).map((b) => <li key={b} className="text-xs text-emerald-700 inline-flex items-center gap-1 w-full"><CheckCircle2 size={12} /> {b}</li>)}
        {(s.notBuilt || []).map((b) => <li key={b} className="text-xs text-slate-500 inline-flex items-center gap-1 w-full"><CircleDashed size={12} /> {b}</li>)}
      </ul>
    </section>
  );
}

function Header({ onRefresh, loading }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-bold text-slate-900 inline-flex items-center gap-2"><Sparkles size={18} /> Claude shadow</h1>
        <p className="text-xs text-slate-500 mt-0.5">Claude plans tomorrow’s loads beside the router, for comparison only. It cannot send, save or stage anything.</p>
      </div>
      <button onClick={onRefresh} disabled={loading}
        className="rounded-lg border px-3 py-1.5 text-xs font-semibold bg-white hover:bg-slate-50 min-h-[44px] shrink-0">Refresh</button>
    </div>
  );
}

function DesktopView(h) {
  return (
    <div className="flex-1 overflow-y-auto bg-slate-50">
      <div className="w-full mx-auto max-w-4xl xl:max-w-[1500px] p-6 space-y-4">
        <Header onRefresh={h.load} loading={h.loading} />
        {h.err && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{h.err}</div>}
        {h.loading && !h.status && <div className="text-xs text-slate-500">Loading…</div>}
        {h.status && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
            <SwitchCard s={h.status} />
            <ProbeCard s={h.status} probing={h.probing} probeMsg={h.probeMsg} onProbe={h.runProbe} />
            <PlanCard s={h.status} />
          </div>
        )}
      </div>
    </div>
  );
}

function PhoneView(h) {
  return (
    <div className="flex-1 overflow-y-auto bg-slate-50">
      <div className="w-full p-3 space-y-3">
        <Header onRefresh={h.load} loading={h.loading} />
        {h.err && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{h.err}</div>}
        {h.loading && !h.status && <div className="text-xs text-slate-500">Loading…</div>}
        {h.status && (
          <div className="flex flex-col gap-3">
            <ProbeCard s={h.status} probing={h.probing} probeMsg={h.probeMsg} onProbe={h.runProbe} />
            <SwitchCard s={h.status} />
            <PlanCard s={h.status} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function ClaudeShadowScreen({ isMobile }) {
  const h = useShadowStatus();
  return isMobile ? <PhoneView {...h} /> : <DesktopView {...h} />;
}
