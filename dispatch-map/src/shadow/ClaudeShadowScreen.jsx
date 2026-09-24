// ClaudeShadowScreen.jsx — THE CLAUDE SHADOW TAB.
//
// Claude will plan tomorrow's loads beside the router, for comparison only. Nothing plans yet —
// this first cut is the plumbing: it shows whether the planner is switched on, which model it would use, whether the
// server holds an API key, and the one test call that proves the key reaches that model.
// v1.63.0: and the truck capacity the shadow has learned from the sealed history, per driver and
// per route, with a "Learn now" that runs the nightly learning on the spot, within a time budget,
// and shows what that run actually did (it returns the run record, not a promise to run).
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
import { Sparkles, Power, Cpu, KeyRound, FlaskConical, RefreshCw, CheckCircle2, XCircle, CircleDashed, Truck, Pencil } from 'lucide-react';
import { apiFetch } from '../lib/api.js';

const ENDPOINT = '/.netlify/functions/claude-shadow';

function fmtUsd(v) {
  if (typeof v !== 'number') return '—';
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}
function fmtDay(ymd) {
  if (!ymd) return '—';
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y || !m || !d) return String(ymd);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}
const spots = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : '—');

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
  // THE CALL THIS TAB JUST PAID FOR, straight from the POST. If writing its record fails, the
  // GET below still returns the PREVIOUS test call — so the card shows this one, marked "not
  // saved", instead of quietly showing an older verdict next to a fresh charge.
  const [fresh, setFresh] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await apiFetch(ENDPOINT);
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setStatus(j);
      return true;
    } catch (e) {
      setErr(String(e?.message || e));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runProbe = useCallback(async (ceilingUsd) => {
    const cost = typeof ceilingUsd === 'number' ? `at most about ${(ceilingUsd * 100).toFixed(1)}¢, usually well under 1¢` : 'cost not known for this model';
    const ok = window.confirm(`This makes ONE call to the model (${cost}). Run the test call?`);
    if (!ok) return;
    setProbing(true); setProbeMsg(null); setFresh(null);
    try {
      const r = await apiFetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'probe', confirm: true }),
      });
      const j = await r.json().catch(() => null);
      if (!j) setProbeMsg(`HTTP ${r.status} — no readable answer, so whether a call was made is unknown`);
      else if (j.calls === 1 && j.result) {
        const unsaved = !j.recorded?.last || !j.recorded?.log || j.recorded?.error;
        setFresh({ ...j.result, unsaved: !j.recorded?.last });
        if (unsaved) setProbeMsg(`The call was made, but its record was not fully written (${j.recorded?.error || [!j.recorded?.last && 'last-call record', !j.recorded?.log && 'call log'].filter(Boolean).join(' and ')}).`);
      } else setProbeMsg(j.error ? `No call was made: ${j.error}` : `No call was made (HTTP ${r.status}).`);
      await load();
    } catch (e) {
      setProbeMsg(`Whether a call was made is unknown: ${String(e?.message || e)}`);
    } finally {
      setProbing(false);
    }
  }, [load]);

  // LEARN NOW. The endpoint runs the learning itself, within a time budget, and answers with the
  // run record — so this reports what the run DID, never that one was merely started.
  const [learning, setLearning] = useState(false);
  const [learnMsg, setLearnMsg] = useState(null);
  const learnNow = useCallback(async () => {
    setLearning(true); setLearnMsg(null);
    try {
      const r = await apiFetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'learn' }),
      });
      const j = await r.json().catch(() => null);
      if (!j) setLearnMsg(`HTTP ${r.status} — no readable answer, so whether it learned anything is unknown.`);
      else if (!r.ok || j.refused || (j.error && !j.at)) setLearnMsg(`Not run: ${j.error || j.refused || `HTTP ${r.status}`}.`);
      else {
        const n = (a) => (Array.isArray(a) ? a.length : 0);
        const parts = [`${n(j.learned)} new day${n(j.learned) === 1 ? '' : 's'} learned`];
        if (n(j.failed)) parts.push(`${n(j.failed)} failed`);
        if (j.deferred) parts.push(`${j.deferred} left — press again, or tonight’s run finishes them`);
        if (j.error) parts.push(`stopped: ${j.error}`);
        setLearnMsg(`${parts.join('; ')}.`);
      }
      await load();
    } catch (e) {
      setLearnMsg(`Whether it learned anything is unknown: ${String(e?.message || e)}`);
    } finally {
      setLearning(false);
    }
  }, [load]);

  return { status, err, loading, load, probing, probeMsg, runProbe, fresh, learning, learnMsg, learnNow };
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

// What the API did with the request, in the three ways it can go. A timeout is not a "no": the
// request left and may be billed, and the card says exactly that.
function answerLine(p) {
  const why = p.error ? ` — ${p.error}` : '';
  if (p.ok) return <Verdict good>yes (HTTP {p.httpStatus})</Verdict>;
  if (p.answered && p.httpStatus >= 200 && p.httpStatus < 300) return <Verdict good={false}>answered HTTP {p.httpStatus}, but the body could not be read{why} — it was likely billed; cost unknown</Verdict>;
  if (p.answered && p.httpStatus >= 500) return <Verdict good={false}>API error, HTTP {p.httpStatus}{why}</Verdict>;
  if (p.answered) return <Verdict good={false}>refused, HTTP {p.httpStatus}{why}</Verdict>;
  if (p.timedOut) return <Verdict good={false}>no answer in time{why} — the request was sent and may still be billed</Verdict>;
  return <Verdict good={false}>no answer{why} — whether it reached the API is not known</Verdict>;
}

function ProbeCard({ s, fresh, probing, probeMsg, onProbe }) {
  // This tab's own call until the server holds one at least as new — then the stored one, so a
  // Refresh never keeps showing an older verdict than the record.
  const stored = s.lastProbe;
  const p = fresh && !(stored && String(stored.at) >= String(fresh.at)) ? fresh : (stored || fresh);
  return (
    <section className="rounded-xl border bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800 inline-flex items-center gap-2"><FlaskConical size={14} /> Test call</h2>
      <p className="text-xs text-slate-500 mt-1">One small call that proves the key reaches the model with the request shape the planner will use: effort set explicitly, one strict tool, and the model left to choose it.</p>
      {!p && <p className="text-xs text-slate-600 mt-3">{s.lastProbeNote || 'No test call has been recorded yet.'}</p>}
      {p && (
        <div className="mt-2">
          <Row label="When">{fmtWhen(p.at)}{p.by ? ` · ${p.by}` : ''}{p.unsaved ? ' · not saved' : ''}</Row>
          <Row label="API answered">{answerLine(p)}</Row>
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
        onClick={() => onProbe(s.probe?.ceilingUsd)}
        disabled={probing || !s.enabled || !s.keyConfigured}
        className="mt-3 w-full sm:w-auto rounded-lg border px-3 py-2 min-h-[44px] text-xs font-semibold bg-white hover:bg-slate-50 disabled:opacity-50 inline-flex items-center justify-center gap-2"
      >
        {probing ? <RefreshCw size={12} className="animate-spin" /> : <FlaskConical size={12} />}
        {probing ? 'Calling…' : 'Run test call (1 call)'}
      </button>
    </section>
  );
}

// ── TRUCK CAPACITY, LEARNED ──────────────────────────────────────────────────
// What each driver and each route has actually carried, from the sealed history, in skid spots
// (skids + loose ÷ the loose-per-spot ratio), with the caps a dispatcher has typed over them.

function LearnRunLine({ last, refused, note }) {
  const off = refused ? <p className="text-[11px] text-amber-800">Learning is off here: {refused}.{last ? ' The numbers below are from an earlier run.' : ''}</p> : null;
  if (note) return <>{off}<p className="text-[11px] text-amber-800">{note}</p></>;
  if (!last) return off || <p className="text-[11px] text-slate-500">No learning run has been recorded yet.</p>;
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  const what = last.refused
    ? `refused — ${last.refused}`
    : [
      `${n(last.learned)} new day${n(last.learned) === 1 ? '' : 's'} learned`,
      n(last.refreshed) ? `${n(last.refreshed)} recent re-read` : null,
      n(last.failed) ? `${n(last.failed)} failed (${last.failed.map((f) => f.date).join(', ')})` : null,
      last.deferred ? `${last.deferred} left for the next run` : null,
    ].filter(Boolean).join(', ') + (last.error ? ` — stopped: ${last.error}` : '');
  return (
    <>
      {off}
      <p className={`text-[11px] ${last.ok ? 'text-slate-500' : 'text-amber-800'}`}>
        Last run {fmtWhen(last.at)} · {last.trigger}{last.by ? ` · ${last.by}` : ''} · {what}
      </p>
    </>
  );
}

function LearnSummary({ m }) {
  const sk = m.trips?.skipped || {};
  const rl = m.rowsLeftOut || {};
  const trips = [
    sk.shared ? `${sk.shared} were two loads under one route name` : null,
    sk.rosterUnknown ? `${sk.rosterUnknown} on days or names the load roster cannot vouch for${m.days?.noRoster ? ` (${m.days.noRoster} days have no roster, all of June among them)` : ''}` : null,
    sk.uncounted ? `${sk.uncounted} had stops with no skid or loose count` : null,
    sk.noFreight ? `${sk.noFreight} carried no count at all` : null,
    sk.noDriver ? `${sk.noDriver} had no driver` : null,
  ].filter(Boolean);
  const rows = [
    rl.openAtSeal ? `${rl.openAtSeal} still out-for-delivery or arrived when the day sealed` : null,
    rl.otherDay ? `${rl.otherDay} delivered on a different day than the one they were filed under` : null,
    rl.noStamp ? `${rl.noStamp} with no delivery stamp` : null,
  ].filter(Boolean);
  return (
    <div className="text-xs text-slate-600 space-y-0.5">
      <p>{m.days?.count || 0} sealed days ({fmtDay(m.days?.first)} – {fmtDay(m.days?.last)}) · {m.trips?.used || 0} of {m.trips?.total || 0} truck trips used · {m.loosePerSkid} loose pieces = 1 skid spot ({m.loosePerSkidSource === 'setting' ? 'your setting' : 'default'}) · built {fmtWhen(m.builtAt)}</p>
      {trips.length > 0 && <p className="text-[11px] text-slate-500">Trips left out of capacity: {trips.join('; ')}.</p>}
      {rows.length > 0 && <p className="text-[11px] text-slate-500">Stops not counted as carried: {rows.join('; ')}.</p>}
      {m.days?.stampGateOff > 0 && <p className="text-[11px] text-slate-500">On {m.days.stampGateOff} day{m.days.stampGateOff === 1 ? '' : 's'} most deliveries carried no same-day stamp, so every delivered stop counted.</p>}
      <p className="text-[11px] text-slate-500">Cap = the fuller end of what they have carried: the {Math.round((m.capQuantile || 0.95) * 100)}th percentile of their trips in skid spots. Needs {m.minTrips} trips — below that the 95th percentile is just the single fullest trip — so fewer shows none. Nothing plans with these numbers yet.</p>
    </div>
  );
}

function fullestLine(f) {
  if (!f) return '—';
  const parts = [f.skids ? `${spots(f.skids)} skids` : null, f.loose ? `${spots(f.loose)} loose` : null].filter(Boolean).join(' + ') || '0';
  return `${parts} · ${fmtDay(f.date)}`;
}

// "Cap in force" — yours when you set one, else the learned cap, else none; and which it is.
// It is not "what the planner uses": nothing plans with it yet, and which of a driver's cap and a
// route's cap a load will be held to is not decided.
function CapUsed({ r }) {
  if (r.capSource === 'unknown') return <span className="text-amber-700 text-xs">unknown</span>;
  if (r.capUsed == null) return <span className="text-slate-400 font-normal text-xs">none yet</span>;
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="font-semibold">{spots(r.capUsed)}</span>
      <span className={`text-[10px] ${r.capSource === 'yours' ? 'text-indigo-700' : 'text-slate-500'}`}>{r.capSource === 'yours' ? 'yours' : 'learned'}</span>
    </span>
  );
}
const setBy = (r) => (r.capSource === 'yours' && (r.yourCapBy || r.yourCapAt) ? `set by ${r.yourCapBy || 'unknown'} · ${fmtWhen(r.yourCapAt)}` : null);

// One cap box. Blank means "use the learned cap" and is sent as an explicit clear, never as 0.
function CapInput({ value, onChange, bad, label, phone, placeholder = 'learned' }) {
  return (
    <input type="text" inputMode="decimal" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className={`${phone ? 'w-24 min-h-[44px] text-sm' : 'w-20 py-1 text-xs'} rounded border px-2 text-right ${bad ? 'border-rose-400 bg-rose-50' : 'border-slate-300'}`} />
  );
}

function DesktopCapacityTable({ rows, kind, ed }) {
  const editing = ed.editing;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-slate-500 border-b">
            <th className="py-1.5 pr-3 font-medium">{kind === 'routes' ? 'Route' : 'Driver'}</th>
            <th className="py-1.5 pr-3 font-medium">{kind === 'routes' ? 'Usual drivers' : 'Usual routes'}</th>
            <th className="py-1.5 pr-3 font-medium text-right">Trips</th>
            <th className="py-1.5 pr-3 font-medium text-right">Typical</th>
            <th className="py-1.5 pr-3 font-medium text-right">Full (85%)</th>
            <th className="py-1.5 pr-3 font-medium text-right">Learned cap</th>
            <th className="py-1.5 pr-3 font-medium text-right">{editing ? 'Your cap' : 'Cap in force'}</th>
            <th className="py-1.5 pr-3 font-medium text-right">Most ever</th>
            <th className="py-1.5 font-medium">Fullest trip</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-slate-100 align-top">
              <td className="py-1.5 pr-3 font-medium text-slate-800">{r.name}{r.noHistory ? <span className="ml-1 text-[10px] text-slate-400">no history yet</span> : null}</td>
              <td className="py-1.5 pr-3 text-slate-600">{((kind === 'routes' ? r.drivers : r.routes) || []).map((x) => x.name).join(', ')}</td>
              <td className="py-1.5 pr-3 text-right">{r.trips}{r.lastDate ? <span className="block text-[10px] text-slate-400">last {fmtDay(r.lastDate)}</span> : null}</td>
              <td className="py-1.5 pr-3 text-right">{spots(r.p50)}</td>
              <td className="py-1.5 pr-3 text-right">{spots(r.p85)}</td>
              <td className="py-1.5 pr-3 text-right">{r.cap == null ? <span className="text-slate-400">none</span> : spots(r.cap)}</td>
              <td className="py-1.5 pr-3 text-right">
                {editing
                  ? <CapInput value={ed.boxFor(kind, r)} onChange={(v) => ed.setBox(kind, r.key, v)} bad={ed.plan.bad[kind].has(r.key)} label={`Your cap for ${r.name}`} />
                  : <><CapUsed r={r} />{setBy(r) ? <span className="block text-[10px] text-slate-400">{setBy(r)}</span> : null}</>}
              </td>
              <td className="py-1.5 pr-3 text-right">{spots(r.max)}</td>
              <td className="py-1.5 text-slate-600">{fullestLine(r.fullest)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PhoneCapacityList({ rows, kind, ed }) {
  return (
    <ul className="mt-3 divide-y divide-slate-100">
      {rows.map((r) => (
        <li key={r.key} className="py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-slate-800 min-w-0 break-words">{r.name}</span>
            <span className="text-sm shrink-0"><CapUsed r={r} /></span>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5 break-words">
            {r.noHistory ? 'no history yet' : `learned ${r.cap == null ? 'none' : spots(r.cap)} · ${r.trips} trips${r.lastDate ? `, last ${fmtDay(r.lastDate)}` : ''} · full ${spots(r.p85)} · most ${spots(r.max)} (${fullestLine(r.fullest)})`}
          </p>
          {setBy(r) && <p className="text-[11px] text-indigo-700 break-words">{setBy(r)}</p>}
          <p className="text-[11px] text-slate-400 break-words">{((kind === 'routes' ? r.drivers : r.routes) || []).map((x) => x.name).join(', ')}</p>
          {ed.editing && (
            <label className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-600">
              Your cap (skid spots)
              <CapInput phone value={ed.boxFor(kind, r)} onChange={(v) => ed.setBox(kind, r.key, v)} bad={ed.plan.bad[kind].has(r.key)} label={`Your cap for ${r.name}`} />
            </label>
          )}
        </li>
      ))}
    </ul>
  );
}

// THE EDITOR'S RULES, the same ones the server enforces: a cap box is blank (use the learned cap —
// sent as an explicit clear) or a number in range; the ratio box likewise, blank meaning the
// default. Nothing is sent while any box is wrong, and ONLY BOXES YOU TOUCHED are sent: a Refresh
// while editing brings in other people's saves, and an untouched box must never overwrite them.
const DECIMAL = /^\d+(\.\d+)?$/;
function readBox(text, [lo, hi]) {
  const t = String(text ?? '').trim();
  if (t === '') return { value: null };
  if (!DECIMAL.test(t)) return { error: true };
  const n = Number(t);
  if (n < lo || n > hi) return { error: true };
  return { value: Math.round(n * 10) / 10 };
}

// Lives in ClaudeShadowScreen, ABOVE the phone/desktop switch, so turning a phone sideways (which
// swaps the two views) does not throw away what was typed.
function useCapacityEditor(s, reload) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState('drivers');
  const [boxes, setBoxes] = useState({ drivers: {}, routes: {} });
  const [touched, setTouched] = useState({ drivers: {}, routes: {}, ratio: false });
  const [ratio, setRatioText] = useState('');
  const [adds, setAdds] = useState({ drivers: { name: '', cap: '' }, routes: { name: '', cap: '' } });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const bounds = s?.settings?.bounds || { cap: [1, 60], loosePerSkid: [1, 100] };
  const m = s?.learned;
  const start = () => {
    setBoxes({ drivers: {}, routes: {} });
    setTouched({ drivers: {}, routes: {}, ratio: false });
    setRatioText(s?.settings?.loosePerSkid == null ? '' : String(s.settings.loosePerSkid));
    setAdds({ drivers: { name: '', cap: '' }, routes: { name: '', cap: '' } });
    setSaveMsg(null);
    setEditing(true);
  };
  const cancel = () => { setEditing(false); setSaveMsg(null); };
  // A box shows what you typed, else what is saved now.
  const boxFor = (k, r) => (touched[k][r.key] ? boxes[k][r.key] ?? '' : (r.yourCap == null ? '' : String(r.yourCap)));
  const setBox = (k, key, v) => {
    setBoxes((b) => ({ ...b, [k]: { ...b[k], [key]: v } }));
    setTouched((t) => ({ ...t, [k]: { ...t[k], [key]: true } }));
  };
  const setRatio = (v) => { setRatioText(v); setTouched((t) => ({ ...t, ratio: true })); };
  const setAdd = (k, field, v) => setAdds((a) => ({ ...a, [k]: { ...a[k], [field]: v } }));

  const plan = (() => {
    const bad = { drivers: new Set(), routes: new Set() };
    const caps = [];
    for (const k of ['drivers', 'routes']) {
      const byKey = new Map((m?.[k] || []).map((r) => [r.key, r]));
      for (const key of Object.keys(touched[k])) {
        const r = byKey.get(key);
        if (!r) continue;
        const box = readBox(boxes[k][key], bounds.cap);
        if (box.error) { bad[k].add(key); continue; }
        if ((box.value ?? null) !== (r.yourCap ?? null)) caps.push({ kind: k === 'drivers' ? 'driver' : 'route', name: r.name, cap: box.value });
      }
    }
    // A new name (a new hire, a new route): both boxes, or neither.
    const addBad = { drivers: false, routes: false };
    for (const k of ['drivers', 'routes']) {
      const a = adds[k];
      const name = a.name.trim();
      if (!name && !a.cap.trim()) continue;
      const box = readBox(a.cap, bounds.cap);
      if (!name || box.error || box.value == null) { addBad[k] = true; continue; }
      caps.push({ kind: k === 'drivers' ? 'driver' : 'route', name, cap: box.value });
    }
    const rb = readBox(ratio, bounds.loosePerSkid);
    const change = { caps };
    if (touched.ratio && !rb.error && (rb.value ?? null) !== (s?.settings?.loosePerSkid ?? null)) change.loosePerSkid = rb.value;
    const count = caps.length + ('loosePerSkid' in change ? 1 : 0);
    const fix = bad.drivers.size + bad.routes.size + (touched.ratio && rb.error ? 1 : 0) + (addBad.drivers ? 1 : 0) + (addBad.routes ? 1 : 0);
    return { change, bad, addBad, ratioBad: touched.ratio && !!rb.error, count, fix };
  })();

  const save = async () => {
    if (plan.fix || !plan.count) return;
    setSaving(true); setSaveMsg(null);
    try {
      const r = await apiFetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'settings', change: plan.change }),
      });
      const j = await r.json().catch(() => null);
      if (!j) { setSaveMsg(`HTTP ${r.status} — no readable answer, so whether it saved is unknown. Refresh to check.`); return; }
      if (j.errors) { setSaveMsg(`Not saved: ${j.errors.join('; ')}.`); return; }
      const items = [...(j.results || []), ...(j.ratio ? [{ name: 'loose pieces per skid spot', ...j.ratio }] : [])];
      const bad = items.filter((x) => x.outcome === 'failed' || x.outcome === 'unknown');
      const parts = [];
      if (!j.results && !j.ratio && j.error) parts.push(`Not saved: ${j.error}.`);
      else if (bad.length) parts.push(`Saved ${items.length - bad.length} of ${items.length}. ${bad.map((x) => `${x.name}: ${x.outcome === 'unknown' ? 'not known whether it saved' : 'not saved'}${x.error ? ` (${x.error})` : ''}`).join('; ')}.`);
      else parts.push('Saved.');
      if (j.rebuilt) parts.push('The learned numbers were rebuilt at the new ratio.');
      if (j.rebuildError) parts.push(`${j.rebuildError}.`);
      if (j.logError) parts.push(`${j.logError}.`);
      const fresh = await reload();
      if (!fresh) parts.push('The screen could not reload — the rows below are from before the save; press Refresh.');
      setSaveMsg(parts.join(' '));
      if (!bad.length) setEditing(false);
    } catch (e) {
      setSaveMsg(`Whether it saved is unknown: ${String(e?.message || e)}. Refresh to check.`);
    } finally {
      setSaving(false);
    }
  };
  return { editing, start, cancel, kind, setKind, boxFor, setBox, ratio, setRatio, adds, setAdd, plan, save, saving, saveMsg, bounds };
}

function AddNameRow({ ed, kind, phone }) {
  const a = ed.adds[kind];
  const label = kind === 'routes' ? 'route' : 'driver';
  return (
    <div className={`mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600 ${ed.plan.addBad[kind] ? 'text-rose-700' : ''}`}>
      <span>Cap a {label} with no history yet:</span>
      <input type="text" aria-label={`New ${label} name`} value={a.name} onChange={(e) => ed.setAdd(kind, 'name', e.target.value)} placeholder={`${label} name`}
        className={`${phone ? 'min-h-[44px] text-sm flex-1 min-w-0' : 'py-1 text-xs w-48'} rounded border px-2 ${ed.plan.addBad[kind] ? 'border-rose-400 bg-rose-50' : 'border-slate-300'}`} />
      <CapInput phone={phone} value={a.cap} onChange={(v) => ed.setAdd(kind, 'cap', v)} bad={ed.plan.addBad[kind]} label={`New ${label} cap`} placeholder="spots" />
    </div>
  );
}

function CapacityCard({ s, phone, learning, learnMsg, onLearn, ed }) {
  const m = s.learned;
  const kind = ed.kind;
  const picked = m ? (kind === 'routes' ? m.routes : m.drivers) : null;
  const rows = Array.isArray(picked) ? picked : [];
  const off = !!s.learnRefused;
  const unreadable = !!s.settingsNote;
  const st = s.settings || {};
  const tabFix = (k) => ed.plan.bad[k].size + (ed.plan.addBad[k] ? 1 : 0);
  return (
    <section className="rounded-xl border bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-800 inline-flex items-center gap-2"><Truck size={14} /> Truck capacity, learned</h2>
        <div className="flex flex-wrap justify-end gap-2 shrink-0">
          {!ed.editing && (
            <button onClick={ed.start} disabled={off || unreadable} title={unreadable ? 'The settings could not be read, so they cannot be edited safely' : undefined}
              className="rounded-lg border px-3 py-2 min-h-[44px] text-xs font-semibold bg-white hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-2">
              <Pencil size={12} /> Edit caps
            </button>
          )}
          {!ed.editing && (
            <button onClick={onLearn} disabled={learning || off}
              className="rounded-lg border px-3 py-2 min-h-[44px] text-xs font-semibold bg-white hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-2">
              <RefreshCw size={12} className={learning ? 'animate-spin' : ''} /> Learn now
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-slate-500 mt-1">What each driver and route has actually carried out of the dock, from every sealed day of history, in skid spots. Pickups, rolled orders and cancellations are not counted. Where you set a cap it replaces the learned one; when a driver and a route both have a cap, which one a load is held to is not decided yet — nothing plans with either yet. 0 NuVizz calls.</p>
      <div className="mt-2 space-y-0.5"><LearnRunLine last={s.learnLast} refused={s.learnRefused} note={s.learnLastNote} /></div>
      {s.settingsNote && <p className="mt-1 text-[11px] text-amber-800">{s.settingsNote}</p>}
      {st.ratioPending && m && <p className="mt-1 text-[11px] text-amber-800">Your setting is {st.loosePerSkid ?? st.defaultLoosePerSkid} loose pieces per skid spot; the numbers below are still at {m.loosePerSkid} until they are rebuilt — Learn now, or tonight’s run.</p>}
      {learnMsg && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{learnMsg}</p>}
      {ed.saveMsg && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{ed.saveMsg}</p>}
      {!m && <p className="text-xs text-slate-600 mt-3">{s.learnedNote || 'Nothing has been learned yet.'}</p>}
      {m && <div className="mt-3"><LearnSummary m={m} /></div>}
      {(st.loosePerSkidAt || st.loosePerSkidBy) && !ed.editing && <p className="mt-1 text-[11px] text-slate-500">Loose-per-spot setting {st.loosePerSkid == null ? 'put back to the default' : `set to ${st.loosePerSkid}`} by {st.loosePerSkidBy || 'unknown'} · {fmtWhen(st.loosePerSkidAt)}.</p>}
      {ed.editing && (
        <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3 space-y-2">
          <label className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700">
            <span>Loose pieces that take the room of one skid spot, on every truck <span className="text-slate-500">(blank = default {st.defaultLoosePerSkid ?? 10}; changing it rebuilds every learned number)</span></span>
            <input type="text" inputMode="decimal" aria-label="Loose pieces per skid spot" value={ed.ratio} onChange={(e) => ed.setRatio(e.target.value)} placeholder={String(st.defaultLoosePerSkid ?? 10)}
              className={`w-24 min-h-[44px] rounded border px-2 text-right text-sm ${ed.plan.ratioBad ? 'border-rose-400 bg-rose-50' : 'border-slate-300'}`} />
          </label>
          <p className="text-[11px] text-slate-600">Type a cap in skid spots ({ed.bounds.cap[0]}–{ed.bounds.cap[1]}) beside any driver or route to replace the learned one; clear it to go back to the learned cap. Only the boxes you change are saved. Red boxes are not a number in range, and nothing is saved until they are fixed.</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={ed.save} disabled={ed.saving || !!ed.plan.fix || !ed.plan.count}
              className="rounded-lg px-3 py-2 min-h-[44px] text-xs font-semibold bg-slate-800 text-white disabled:opacity-50">
              {ed.saving ? 'Saving…' : ed.plan.fix ? `Fix ${ed.plan.fix} box${ed.plan.fix === 1 ? '' : 'es'} first` : ed.plan.count ? `Save ${ed.plan.count} change${ed.plan.count === 1 ? '' : 's'}` : 'No changes'}
            </button>
            <button onClick={ed.cancel} disabled={ed.saving}
              className="rounded-lg border px-3 py-2 min-h-[44px] text-xs font-semibold bg-white hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      )}
      {(m || ed.editing) && (
        <div className="mt-3">
          <div className="inline-flex rounded-lg border overflow-hidden" role="tablist">
            {[['drivers', 'Drivers'], ['routes', 'Routes']].map(([k, label]) => (
              <button key={k} role="tab" aria-selected={kind === k} onClick={() => ed.setKind(k)}
                className={`px-3 min-h-[44px] text-xs font-semibold ${kind === k ? 'bg-slate-800 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
                {label} ({((m && m[k]) || []).length}){ed.editing && tabFix(k) ? <span className={kind === k ? 'text-rose-200' : 'text-rose-700'}> · {tabFix(k)} to fix</span> : null}
              </button>
            ))}
          </div>
          {kind === 'routes' && <p className="mt-2 text-[11px] text-slate-500">A route’s numbers pool every driver who ran it, and the shadow does not yet know which truck ran each day — a box-truck day and a tractor day under one name are mixed here.</p>}
          {ed.editing && <AddNameRow ed={ed} kind={kind} phone={phone} />}
          {phone ? <PhoneCapacityList rows={rows} kind={kind} ed={ed} /> : <DesktopCapacityTable rows={rows} kind={kind} ed={ed} />}
        </div>
      )}
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
        <p className="text-xs text-slate-500 mt-0.5">Claude will plan tomorrow’s loads beside the router, for comparison only — nothing plans yet; this is the plumbing and one test call. It can never send, save or stage anything.</p>
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
            <ProbeCard s={h.status} fresh={h.fresh} probing={h.probing} probeMsg={h.probeMsg} onProbe={h.runProbe} />
            <PlanCard s={h.status} />
          </div>
        )}
        {h.status && <CapacityCard s={h.status} learning={h.learning} learnMsg={h.learnMsg} onLearn={h.learnNow} ed={h.ed} />}
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
            <CapacityCard s={h.status} phone learning={h.learning} learnMsg={h.learnMsg} onLearn={h.learnNow} ed={h.ed} />
            <ProbeCard s={h.status} fresh={h.fresh} probing={h.probing} probeMsg={h.probeMsg} onProbe={h.runProbe} />
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
  const ed = useCapacityEditor(h.status, h.load);
  return isMobile ? <PhoneView {...h} ed={ed} /> : <DesktopView {...h} ed={ed} />;
}
