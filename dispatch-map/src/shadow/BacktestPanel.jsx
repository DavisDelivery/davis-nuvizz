// BacktestPanel.jsx — THE CLAUDE ROUTER, TRIED ON PAST DAYS: what it would have changed, in miles.
//
// Chad, 2026-09-25: "take everything that was delivered on the loads that was delivered and then
// seeing how the Claude router would have done it differently ... statistics about it being
// different, like how much more successful it was or the mileage that it reduced, the cost it
// reduced." This panel queues backtests (the scheduled worker runs them — see
// claude-shadow-worker-background.mts), shows each day's result and the total across days, and
// opens one day's load-by-load comparison.
//
// THREE COLUMNS, ONE YARDSTICK, always side by side: dispatch as driven, dispatch's own loads
// re-ordered by the engine's sequencer, and Claude. The middle one is there so a saving is never
// credited to Claude that a better stop ORDER alone would have found.
//
// Two views, per the house rule: a table on a desktop, stacked cards on a phone. Nothing here sends,
// saves or stages freight; the only money it can spend is at the model, capped per day, and every
// button that spends asks first and says the ceiling.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Route, Play, X, Settings2, ChevronDown, ChevronRight, TrendingDown, History, MapPinned } from 'lucide-react';
import { apiFetch } from '../lib/api.js';
import BacktestMap, { useBacktestDay } from './BacktestMap.jsx';
import { RoutesTable, RouteCards, RoutePanel } from './RouteCompare.jsx';
import { routeRows, sortRoutes, routeCompare, focusPicks, toggleTruck, pickTrucks, MAX_SELECTED } from './backtest-map-core.js';

const ENDPOINT = '/.netlify/functions/claude-shadow';
const BACKTESTS_URL = '/.netlify/functions/claude-shadow?view=backtests';
const ACTIVE = new Set(['queued', 'running']);

const fmtDay = (ymd) => {
  if (!ymd) return '—';
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y || !m || !d) return String(ymd);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
};
const fmtWhen = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'; } catch { return iso; }
};
const usd = (v) => (typeof v === 'number' ? (Math.abs(v) < 0.01 && v !== 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`) : '—');
const int = (v) => (typeof v === 'number' ? Math.round(v).toLocaleString('en-US') : '—');
const one = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1)) : '—');
const hrs = (min) => (typeof min === 'number' ? `${(min / 60).toFixed(1)} h` : '—');

// A change, coloured by whether it is a saving. For miles, minutes, trucks and cost, DOWN is good.
function Delta({ d, unit = '', pct = true, money = false }) {
  if (!d || typeof d.abs !== 'number') return <span className="text-slate-400">—</span>;
  const good = d.abs < 0, zero = d.abs === 0;
  const cls = zero ? 'text-slate-500' : good ? 'text-emerald-700' : 'text-rose-700';
  const sign = d.abs > 0 ? '+' : d.abs < 0 ? '−' : '';
  const mag = money ? `$${Math.abs(d.abs).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${one(Math.abs(d.abs))}${unit}`;
  return <span className={`${cls} font-semibold tabular-nums`}>{sign}{mag}{pct && typeof d.pct === 'number' ? ` (${d.pct > 0 ? '+' : ''}${d.pct.toFixed(1)}%)` : ''}</span>;
}
function TruckDelta({ n }) {
  if (typeof n !== 'number') return <span className="text-slate-400">—</span>;
  const cls = n === 0 ? 'text-slate-500' : n < 0 ? 'text-emerald-700' : 'text-rose-700';
  return <span className={`${cls} font-semibold tabular-nums`}>{n > 0 ? '+' : ''}{n} truck{Math.abs(n) === 1 ? '' : 's'}</span>;
}

function useBacktests() {
  const [view, setView] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch(BACKTESTS_URL);
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setView(j); setErr(null);
    } catch (e) { setErr(String(e?.message || e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // While anything is queued or running, look again every 20 s; the worker moves a few rounds a tick.
  const anyActive = !!view?.jobs?.some((j) => ACTIVE.has(j.status));
  useEffect(() => {
    if (!anyActive) return undefined;
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [anyActive, load]);

  const post = useCallback(async (payload) => {
    const r = await apiFetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => null);
    return { r, j };
  }, []);

  const queue = useCallback(async (dates, maxUsd, daily) => {
    if (!dates.length) return false;
    const ceiling = typeof maxUsd === 'number' ? ` It spends at most ${usd(maxUsd * dates.length)} at the model (${usd(maxUsd)} a day — no round starts that could pass it), usually much less.${daily ? ` All backtests together stop at ${usd(daily.usd)} per 24 hours; days past that wait.` : ''}` : '';
    if (!window.confirm(`Backtest ${dates.length} day${dates.length === 1 ? '' : 's'} with Claude?${ceiling} The worker runs them one at a time, a few minutes each.`)) return false;
    setBusy(true); setMsg(null);
    let queued = false;
    try {
      const { r, j } = await post({ action: 'backtest', dates, confirm: true });
      if (!j) setMsg(`HTTP ${r.status} — no readable answer; reload to see what was queued.`);
      else if (!r.ok || !j.ok) setMsg(`Not queued: ${j.error || (j.errors || []).join('; ') || `HTTP ${r.status}`}`);
      else { queued = true; setMsg(`Queued ${j.queued.length} day${j.queued.length === 1 ? '' : 's'}${j.skipped.length ? `; ${j.skipped.length} already queued or running` : ''}. The first starts within about three minutes.`); }
      await load();
    } catch (e) { setMsg(`Whether anything was queued is unknown: ${String(e?.message || e)}`); }
    finally { setBusy(false); }
    return queued;
  }, [post, load]);

  const cancel = useCallback(async (jobId) => {
    if (!window.confirm('Stop this backtest? A round already at the model still finishes and is billed.')) return;
    try {
      const { r, j } = await post({ action: 'backtest-cancel', jobId });
      setMsg(r.ok && j?.ok ? 'Stopped.' : `Not stopped: ${j?.error || `HTTP ${r.status}`}`);
    } catch (e) { setMsg(`Whether it stopped is unknown — the request failed (${String(e?.message || e)}). Press Refresh, then Stop again if it is still running.`); }
    await load().catch(() => {});
  }, [post, load]);

  const saveSettings = useCallback(async (change) => {
    try {
      const { r, j } = await post({ action: 'router-settings', change });
      if (!r.ok || !j?.ok) return { ok: false, error: (j?.errors || [j?.error || `HTTP ${r.status}`]).join('; ') };
    } catch (e) { return { ok: false, error: `the request failed (${String(e?.message || e)}); whether it saved is unknown — press Refresh` }; }
    await load().catch(() => {});
    return { ok: true };
  }, [post, load]);

  const loadResult = useCallback(async (date) => {
    const { r, j } = await post({ action: 'backtest-result', date });
    if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    return j.result;
  }, [post]);

  return { view, err, busy, msg, load, queue, cancel, saveSettings, loadResult };
}

// ── totals across every day backtested ──────────────────────────────────────

// Dollars are re-priced here at the rates in settings NOW, from each day's miles and minutes — so
// every day is on one rate, and entering a rate prices days that finished before it existed.
const priced = (col, rates) => (rates.perMile == null && rates.perDriveHour == null ? null
  : (rates.perMile ?? 0) * (col?.miles || 0) + (rates.perDriveHour ?? 0) * ((col?.driveMin || 0) / 60));

// One day's result with its dollars re-priced at today's rates (see `priced`).
function withRates(r, rates) {
  if (!r?.columns) return r;
  const c = { driven: priced(r.columns.driven, rates), reseq: priced(r.columns.reseq, rates), claude: priced(r.columns.claude, rates) };
  const cost = c.claude === null ? null : { abs: Math.round((c.claude - c.driven) * 100) / 100, pct: c.driven > 0 ? ((c.claude - c.driven) / c.driven) * 100 : null };
  return { ...r, costs: c.claude === null ? { driven: null, reseq: null, claude: null } : c, vsDriven: { ...(r.vsDriven || {}), cost } };
}

function totalsOf(days, rates) {
  const done = days.map((d) => d.result).filter((r) => r?.columns);
  if (!done.length) return null;
  const sum = (col, k) => done.reduce((a, r) => a + (r.columns[col]?.[k] || 0), 0);
  const miles = { driven: sum('driven', 'miles'), reseq: sum('reseq', 'miles'), claude: sum('claude', 'miles') };
  const min = { driven: sum('driven', 'driveMin'), reseq: sum('reseq', 'driveMin'), claude: sum('claude', 'driveMin') };
  const trucks = { driven: sum('driven', 'trucks'), claude: sum('claude', 'trucks') };
  const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);
  const costs = priced(null, rates) === null ? null
    : { driven: done.reduce((a, r) => a + priced(r.columns.driven, rates), 0), claude: done.reduce((a, r) => a + priced(r.columns.claude, rates), 0) };
  return {
    days: done.length,
    miles, min, trucks, costs,
    milesDelta: { abs: miles.claude - miles.driven, pct: pct(miles.claude, miles.driven) },
    minDelta: { abs: min.claude - min.driven, pct: pct(min.claude, min.driven) },
    seqMilesDelta: { abs: miles.reseq - miles.driven, pct: pct(miles.reseq, miles.driven) },
    costDelta: costs ? { abs: costs.claude - costs.driven, pct: pct(costs.claude, costs.driven) } : null,
    unplanned: done.reduce((a, r) => a + (r.columns.claude?.unplanned || 0), 0),
    moved: done.reduce((a, r) => a + (r.agreement?.stopsMoved || 0), 0),
    stops: done.reduce((a, r) => a + (r.stats?.stops || 0), 0),
  };
}

function Totals({ t, phone, spend }) {
  if (!t) return <p className="text-xs text-slate-500">No day has been backtested yet. Pick days below and press Backtest.</p>;
  const Item = ({ label, children }) => (
    <div className={`rounded-lg bg-slate-50 border px-3 py-2 ${phone ? '' : 'min-w-[150px]'}`}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
  return (
    <div className={phone ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap gap-2'}>
      <Item label={`Road miles, ${t.days} day${t.days === 1 ? '' : 's'}`}><Delta d={t.milesDelta} unit=" mi" /></Item>
      <Item label="Drive time"><Delta d={{ abs: t.minDelta.abs / 60, pct: t.minDelta.pct }} unit=" h" /></Item>
      <Item label="Trucks used"><TruckDelta n={t.trucks.claude - t.trucks.driven} /></Item>
      <Item label="Cost (today’s rates)">{t.costDelta ? <Delta d={t.costDelta} money /> : <span className="text-slate-400 text-xs">enter $/mile or $/drive-hour in settings</span>}</Item>
      <Item label="Stops moved to another truck">{int(t.moved)} of {int(t.stops)}</Item>
      <Item label="Stop order alone (same loads)"><Delta d={t.seqMilesDelta} unit=" mi" /></Item>
      <Item label={`Model spend, ${spend?.runs ?? 0} run${spend?.runs === 1 ? '' : 's'}`}>{usd(spend?.usd)}</Item>
      {t.unplanned > 0 && <Item label="Stops Claude left unplanned"><span className="text-rose-700 font-semibold">{int(t.unplanned)} — their miles are not in Claude’s column</span></Item>}
    </div>
  );
}

// ── settings ────────────────────────────────────────────────────────────────

function RouterSettings({ v, onSave }) {
  const s = v.settings;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(null);
  const [note, setNote] = useState(null);
  // Filled from the saved settings when the form OPENS — not on every poll, which hands back a new
  // settings object every 20 s while a job runs and would wipe what is being typed.
  const openForm = () => {
    setForm({ capRule: s.capRule, costPerMile: s.costPerMile ?? '', costPerDriveHour: s.costPerDriveHour ?? '', effort: s.effort, maxRounds: String(s.maxRounds), maxUsd: String(s.maxUsd) });
    setOpen(true);
  };
  const save = async () => {
    const change = {
      capRule: form.capRule, effort: form.effort, maxRounds: form.maxRounds, maxUsd: form.maxUsd,
      costPerMile: String(form.costPerMile).trim() === '' ? null : form.costPerMile,
      costPerDriveHour: String(form.costPerDriveHour).trim() === '' ? null : form.costPerDriveHour,
    };
    const r = await onSave(change);
    setNote(r.ok ? 'Saved. New backtests use these; finished days keep the settings they ran with.' : `Not saved: ${r.error}`);
    if (r.ok) setOpen(false);
  };
  const field = 'rounded border px-2 py-1 text-xs min-h-[44px] w-full bg-white';
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2">
        <button onClick={() => (open ? setOpen(false) : openForm())} className="text-xs text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 min-h-[44px] shrink-0">
          <Settings2 size={13} /> Router settings {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className="text-xs text-slate-400">cap rule {s.capRule} · effort {s.effort} · ≤{s.maxRounds} rounds · ≤{usd(s.maxUsd)}/day{s.costPerMile != null ? ` · ${usd(s.costPerMile)}/mi` : ''}{s.costPerDriveHour != null ? ` · ${usd(s.costPerDriveHour)}/drive-h` : ''}{v.ceiling ? ` · all backtests ≤${usd(v.ceiling.usd)} per 24 h (${usd(v.ceiling.spent24h)} used)` : ''}</span>
      </div>
      {note && <p className="text-[11px] text-slate-600">{note}</p>}
      {open && form && (
        <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2 rounded-lg border bg-slate-50 p-3">
          <label className="text-[11px] text-slate-600">When a driver and a route both have a cap
            <select className={field} value={form.capRule} onChange={(e) => setForm({ ...form, capRule: e.target.value })}>
              <option value="tighter">the tighter one binds</option>
              <option value="driver">the driver’s binds</option>
              <option value="route">the route’s binds</option>
            </select>
          </label>
          <label className="text-[11px] text-slate-600">Cost per road mile ($, blank = none)
            <input className={field} inputMode="decimal" value={form.costPerMile} onChange={(e) => setForm({ ...form, costPerMile: e.target.value })} placeholder="none" />
          </label>
          <label className="text-[11px] text-slate-600">Cost per drive hour ($, blank = none)
            <input className={field} inputMode="decimal" value={form.costPerDriveHour} onChange={(e) => setForm({ ...form, costPerDriveHour: e.target.value })} placeholder="none" />
          </label>
          <label className="text-[11px] text-slate-600">Model effort
            <select className={field} value={form.effort} onChange={(e) => setForm({ ...form, effort: e.target.value })}>
              {v.efforts.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-slate-600">Most rounds per day ({v.bounds.maxRounds[0]}–{v.bounds.maxRounds[1]})
            <input className={field} inputMode="numeric" value={form.maxRounds} onChange={(e) => setForm({ ...form, maxRounds: e.target.value })} />
          </label>
          <label className="text-[11px] text-slate-600">Most $ per day ({v.bounds.maxUsd[0]}–{v.bounds.maxUsd[1]})
            <input className={field} inputMode="decimal" value={form.maxUsd} onChange={(e) => setForm({ ...form, maxUsd: e.target.value })} />
          </label>
          <div className="col-span-2 md:col-span-3 flex gap-2">
            <button onClick={save} className="rounded-lg bg-slate-900 text-white px-3 text-xs font-semibold min-h-[44px]">Save</button>
            <button onClick={() => setOpen(false)} className="rounded-lg border bg-white px-3 text-xs min-h-[44px]">Cancel</button>
          </div>
          <p className="col-span-2 md:col-span-3 text-[11px] text-slate-500">Cost is left blank until you enter a rate: nothing in the app says what a mile or a driver-hour costs Davis, so no dollar saving is shown until you do.</p>
        </div>
      )}
    </div>
  );
}

// ── one day, in full ────────────────────────────────────────────────────────

function Scorecard({ r, phone }) {
  const c = r.columns;
  if (!c?.driven || !c?.reseq || !c?.claude) return <div className="text-xs text-slate-500">This result has no scorecard.</div>;
  const rows = [
    ['Trucks used', (x) => int(x.trucks)],
    ['Road miles (est.)', (x) => one(x.miles)],
    ['Drive time (est.)', (x) => hrs(x.driveMin)],
    ['Skid spots carried', (x) => one(x.spots)],
    ['Avg truck fill', (x) => (typeof x.util === 'number' ? `${x.util}%` : '—')],
    ['Loads over cap', (x) => int(x.overCap)],
    ['No-tractor stops on a tractor', (x) => int(x.blocked)],
    ['Drivers past their day', (x) => int(x.overTime)],
    ['Loads over weight', (x) => int(x.overWeight)],
    ['Stops left unplanned', (x) => int(x.unplanned)],
  ];
  const costRow = r.costs && typeof r.costs.driven === 'number';
  if (phone) {
    return (
      <div className="space-y-2">
        {[['Dispatch — as driven', 'driven'], ['Dispatch — re-sequenced', 'reseq'], ['Claude', 'claude']].map(([label, k]) => (
          <div key={k} className={`rounded-lg border p-2 ${k === 'claude' ? 'border-indigo-300 bg-indigo-50/40' : 'bg-white'}`}>
            <div className="text-xs font-semibold text-slate-800">{label}</div>
            <div className="grid grid-cols-2 gap-x-3 text-[11px] text-slate-600 mt-1">
              {rows.map(([l, f]) => <React.Fragment key={l}><span>{l}</span><span className="text-right text-slate-900 tabular-nums">{f(c[k])}</span></React.Fragment>)}
              {costRow && <><span>Cost</span><span className="text-right text-slate-900">{usd(r.costs[k])}</span></>}
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead><tr className="text-slate-500 text-left">
        <th className="py-1.5 pr-3 font-medium" />
        <th className="py-1.5 pr-3 font-medium text-right">Dispatch — as driven</th>
        <th className="py-1.5 pr-3 font-medium text-right">Dispatch — re-sequenced</th>
        <th className="py-1.5 pr-3 font-medium text-right text-indigo-700">Claude</th>
      </tr></thead>
      <tbody>
        {rows.map(([l, f]) => (
          <tr key={l} className="border-t border-slate-100">
            <td className="py-1.5 pr-3 text-slate-600">{l}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{f(c.driven)}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{f(c.reseq)}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums font-semibold text-indigo-800">{f(c.claude)}</td>
          </tr>
        ))}
        {costRow && (
          <tr className="border-t border-slate-100"><td className="py-1.5 pr-3 text-slate-600">Cost (today’s rates)</td>
            <td className="py-1.5 pr-3 text-right">{usd(r.costs.driven)}</td><td className="py-1.5 pr-3 text-right">{usd(r.costs.reseq)}</td><td className="py-1.5 pr-3 text-right font-semibold text-indigo-800">{usd(r.costs.claude)}</td></tr>
        )}
      </tbody>
    </table>
  );
}

function LoadRows({ r, phone }) {
  const [open, setOpen] = useState(null);
  const loads = [...(Array.isArray(r.loads) ? r.loads : [])].sort((a, b) => (b.driven?.miles || 0) - (a.driven?.miles || 0));
  const cell = (m, k, f = one) => (m ? f(m[k]) : '—');
  if (phone) {
    return (
      <div className="space-y-2">
        {loads.map((l) => (
          <div key={l.id} className="rounded-lg border bg-white">
            <button onClick={() => setOpen(open === l.id ? null : l.id)} className="w-full text-left px-3 py-2 min-h-[44px] flex items-center justify-between gap-2">
              <span className="min-w-0"><span className="text-xs font-semibold text-slate-800">{l.route}</span> <span className="text-[11px] text-slate-500">{l.driver} · {l.cls === 'tractor' ? 'tractor' : 'box'} · cap {one(l.cap)}</span></span>
              <span className="text-[11px] text-slate-600 shrink-0">{cell(l.driven, 'miles')} → <b className="text-indigo-800">{cell(l.claude, 'miles')}</b> mi</span>
            </button>
            {open === l.id && (
              <div className="px-3 pb-2 text-[11px] text-slate-600 space-y-0.5">
                <div>Dispatch: {cell(l.driven, 'stops', int)} stops · {cell(l.driven, 'spots')} spots · {cell(l.driven, 'miles')} mi · {hrs(l.driven?.driveMin)}</div>
                <div>Re-sequenced: {cell(l.reseq, 'miles')} mi · {hrs(l.reseq?.driveMin)}</div>
                <div className="text-indigo-800">Claude: {cell(l.claude, 'stops', int)} stops · {cell(l.claude, 'spots')} spots · {cell(l.claude, 'miles')} mi · {hrs(l.claude?.driveMin)}{!l.claude ? ' (truck not used)' : ''}</div>
                {l.why && <div className="italic">“{l.why}”</div>}
                <div className="text-slate-400">cap: {l.capSource}{l.capNote ? ` — ${l.capNote}` : ''}</div>
                {l.orderSource && l.orderSource !== 'driven' && <div className="text-slate-400">“as driven” order: {l.orderSource === 'planned' ? 'the planned order (not every stop had a delivery time)' : 'stop number (no delivery times or plan)'}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-slate-500 text-left">
          <th className="py-1.5 pr-3 font-medium">Load</th><th className="py-1.5 pr-3 font-medium">Driver · truck</th><th className="py-1.5 pr-3 font-medium text-right">Cap</th>
          <th className="py-1.5 pr-3 font-medium text-right">Dispatch stops</th><th className="py-1.5 pr-3 font-medium text-right">spots</th><th className="py-1.5 pr-3 font-medium text-right">miles</th>
          <th className="py-1.5 pr-3 font-medium text-right">re-seq miles</th>
          <th className="py-1.5 pr-3 font-medium text-right text-indigo-700">Claude stops</th><th className="py-1.5 pr-3 font-medium text-right text-indigo-700">spots</th><th className="py-1.5 pr-3 font-medium text-right text-indigo-700">miles</th>
          <th className="py-1.5 font-medium">Claude’s reason</th>
        </tr></thead>
        <tbody>
          {loads.map((l) => (
            <tr key={l.id} className="border-t border-slate-100 align-top">
              <td className="py-1.5 pr-3 font-medium text-slate-800">{l.route}</td>
              <td className="py-1.5 pr-3 text-slate-600">{l.driver}<div className="text-[10px] text-slate-400">{l.cls === 'tractor' ? 'tractor' : 'box truck'}{l.clsSource === 'default' ? ' (no roster class)' : ''}</div></td>
              <td className="py-1.5 pr-3 text-right tabular-nums" title={`${l.capSource}${l.capNote ? ` — ${l.capNote}` : ''}`}>{one(l.cap)}{l.capNote ? '*' : ''}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{cell(l.driven, 'stops', int)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{cell(l.driven, 'spots')}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{cell(l.driven, 'miles')}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">{cell(l.reseq, 'miles')}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-indigo-800">{l.claude ? int(l.claude.stops) : 'unused'}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-indigo-800">{cell(l.claude, 'spots')}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-indigo-800 font-semibold">{cell(l.claude, 'miles')}</td>
              <td className="py-1.5 text-slate-500 max-w-[320px]">{l.why || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-400 mt-1">* the cap was adjusted for this day — raised to what dispatch delivered on that route and driver, and/or less room held for stops with no map point (hover a cap for why).</p>
    </div>
  );
}

function DayDetail({ date, loadResult, phone, onClose, rates, showMap, setShowMap, route }) {
  const [raw, setR] = useState(null);
  const r = raw ? withRates(raw, rates) : null;
  const [err, setErr] = useState(null);
  useEffect(() => { let live = true; setR(null); setErr(null); loadResult(date).then((x) => live && setR(x)).catch((e) => live && setErr(String(e?.message || e))); return () => { live = false; }; }, [date, loadResult]);
  // THE DAY IN FULL (v1.73.0): every stop, both plans and every route's numbers, read once (Firestore
  // only) and shared by the map, the opened route and the routes list. The map itself is opened on
  // purpose: each opening is a billed Google map load — one on a phone, two on a desktop — and
  // switching plans or routes inside it costs nothing more (BacktestMap keeps its panes).
  const day = useBacktestDay(date);
  const m = day.m;
  // The scorecard and the routes must be one run: if the day was backtested again between the two
  // reads, say so rather than show the new run's routes under the old run's numbers.
  const stale = !!(m && r && m.at && r.at && m.at !== r.at);
  const { sel, setSel, focus, setFocus, q, setQ, sortBy, setSortBy } = route;
  const [note, setNote] = useState(null);
  // Every explicit open re-frames the maps, even of the route already open (a counter, not the id).
  const [zoomTick, setZoomTick] = useState(0);
  const panelRef = useRef(null);
  const mapRef = useRef(null);
  const rows = useMemo(() => (m && !stale ? routeRows(m) : []), [m, stale]);
  // The search narrows the list AND what ◀ ▶ walks — one list, so "4 of 9" means the nine you see.
  const sorted = useMemo(() => {
    const t = q.trim().toLowerCase();
    const all = sortRoutes(rows, sortBy);
    return t ? all.filter((x) => `${x.route} ${x.driver}`.toLowerCase().includes(t)) : all;
  }, [rows, sortBy, q]);
  const cmp = useMemo(() => (m && focus && !stale ? routeCompare(m, focus) : null), [m, focus, stale]);
  const TOO_MANY = `Up to ${MAX_SELECTED} trucks can be coloured at once — clear one first.`;
  const toggle = useCallback((id) => setSel((s0) => { const x = toggleTruck(s0, id); setNote(x.refused ? TOO_MANY : null); return x.next; }), [TOO_MANY, setSel]);
  const pick = useCallback((ids) => setSel((s0) => { const x = pickTrucks(s0, ids); setNote(x.refused ? TOO_MANY : null); return x.next; }), [TOO_MANY, setSel]);
  // Opening a route colours it and the trucks it traded with, and the maps zoom to it.
  const openRoute = useCallback((id) => {
    if (!m) return;
    const c = routeCompare(m, id);
    if (!c) return;
    const f = focusPicks(c);
    setSel(f.next);
    setNote(null);
    setFocus(id);
    setZoomTick((n) => n + 1);
    // With the maps open, bring the MAPS into view — they are what just zoomed to this route, and the
    // route sits right under them; without them, the route itself. Keyboard focus goes to the route.
    requestAnimationFrame(() => {
      (showMap && mapRef.current ? mapRef.current : panelRef.current)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      panelRef.current?.querySelector('section[aria-label^="Route "]')?.focus({ preventScroll: true });
    });
  }, [m, showMap, setSel, setFocus]);
  const at = cmp ? sorted.findIndex((x) => x.id === cmp.load.id) : -1;
  const colourNote = cmp ? (() => { const left = focusPicks(cmp).left; return left ? `${left} more truck${left === 1 ? '' : 's'} traded with this route and ${left === 1 ? 'is' : 'are'} not coloured — ${MAX_SELECTED} colours at a time.` : null; })() : null;
  const routesProps = { rows: sorted, total: rows.length, sel, onToggle: toggle, onOpen: openRoute, focus, q, setQ, sortBy, setSortBy, serviceMin: m?.serviceMin ?? 15 };
  return (
    <div className="rounded-xl border-2 border-indigo-200 bg-white p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-900">{fmtDay(date)} — Claude vs dispatch</div>
          {r && <div className="text-[11px] text-slate-500">{r.stats?.stops} stops on {r.stats?.loads} loads · {r.model} at {r.effort} effort · {r.rounds} round{r.rounds === 1 ? '' : 's'} · {usd(r.usd)} · {r.submitted ? 'plan submitted' : r.planFrom} · {fmtWhen(r.at)}</div>}
        </div>
        <button onClick={onClose} aria-label="Close the day" className="rounded-lg border bg-white px-2 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"><X size={14} /></button>
      </div>
      {err && <div className="text-xs text-rose-700">{err}</div>}
      {!r && !err && <div className="text-xs text-slate-500">Loading…</div>}
      {r && (
        <>
          <div className={phone ? 'grid grid-cols-1 gap-1 text-xs' : 'flex flex-wrap gap-x-6 gap-y-1 text-xs'}>
            <span>Claude vs as driven: <Delta d={r.vsDriven?.miles} unit=" mi" /> · <Delta d={r.vsDriven?.driveMin ? { abs: r.vsDriven.driveMin.abs / 60, pct: r.vsDriven.driveMin.pct } : null} unit=" h" /> · <TruckDelta n={r.vsDriven?.trucks} />{r.vsDriven?.cost && <> · <Delta d={r.vsDriven.cost} money /></>}</span>
            <span className="text-slate-600">of which stop order alone: <Delta d={r.sequencingOnly?.miles} unit=" mi" /> · truck assignment: <Delta d={r.assignmentOnly?.miles} unit=" mi" /></span>
            <span className="text-slate-600">{int(r.agreement?.stopsMoved)} stops moved to another truck · stops riding together agree {typeof r.agreement?.coLoadRecall === 'number' ? `${r.agreement.coLoadRecall}%` : '—'}</span>
          </div>
          <Scorecard r={r} phone={phone} />
          {r.unplanned?.length > 0 && <div className="text-xs text-rose-700">Claude left {r.unplanned.length} stop{r.unplanned.length === 1 ? '' : 's'} unplanned: {r.unplanned.slice(0, 8).map((u) => `${u.n ? `#${u.n}${u.name ? ` ${u.name}` : ''}` : `backtest stop ${u.stop}`} (${u.reason})`).join('; ')}</div>}
          {stale && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">This day was backtested again after you opened it, so its routes would not match the numbers above. Close the day and open it again.</div>}
          <button onClick={() => setShowMap((x) => !x)} aria-expanded={showMap} disabled={!m || stale}
            className={`rounded-lg border px-3 text-xs font-semibold min-h-[44px] inline-flex items-center gap-1 disabled:opacity-50 ${showMap ? 'bg-indigo-700 text-white border-indigo-700' : 'bg-white text-indigo-700 border-indigo-200'}`}>
            <MapPinned size={13} /> {showMap ? (phone ? 'Hide the map' : 'Hide the maps') : phone ? 'Map: yours and Claude’s' : 'Maps: yours and Claude’s, side by side'}
          </button>
          <div ref={mapRef} className="scroll-mt-2">
            {showMap && m && !stale && <BacktestMap m={m} phone={phone} sel={sel} onPick={pick} onClearPicks={() => { setSel(new Map()); setNote(null); }} focus={focus} zoomTick={zoomTick} onOpenRoute={openRoute} note={note} />}
          </div>
          <div ref={panelRef} className="scroll-mt-2">
            {cmp && <RoutePanel cmp={cmp} phone={phone} sel={sel} onOpen={openRoute} onClose={() => setFocus(null)}
              prevId={at > 0 ? sorted[at - 1].id : null} nextId={at >= 0 && at < sorted.length - 1 ? sorted[at + 1].id : null}
              position={at >= 0 ? at + 1 : null} total={sorted.length} colourNote={colourNote} />}
          </div>
          {m && !stale && note && <p className="text-xs text-amber-800" role="status">{note}</p>}
          {m && !stale && (phone ? <RouteCards {...routesProps} /> : <RoutesTable {...routesProps} />)}
          {!m && !day.err && <div className="text-xs text-slate-500">Loading the routes…</div>}
          {day.err && (
            <div className="space-y-2">
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 flex flex-wrap items-center justify-between gap-2">
                <span>The day’s routes could not load: {day.err}</span>
                <button onClick={day.retry} className="rounded-lg border border-rose-300 bg-white px-3 font-semibold min-h-[44px]">Try again</button>
              </div>
              <LoadRows r={r} phone={phone} />
            </div>
          )}
          <details className="text-[11px] text-slate-500">
            <summary className="cursor-pointer min-h-[44px] flex items-center">What this measures, and what it cannot see</summary>
            <ul className="list-disc pl-4 space-y-0.5 mt-1">
              {(r.approximations || []).map((a) => <li key={a}>{a}</li>)}
              <li>“Dispatch — as driven” keeps each truck’s stops in the order they were delivered; “re-sequenced” keeps dispatch’s trucks and lets the engine order the stops; Claude chooses the trucks and the engine orders the stops. All three use the same miles and minutes estimate.</li>
              <li>Capacity for the day was learned from {r.stats?.capModelDays ?? 0} earlier days only, at {r.loosePerSkid} loose pieces per skid spot; cap rule: {r.capRule}.</li>
              <li>{r.stats?.excludedNoCoords || 0} stop{r.stats?.excludedNoCoords === 1 ? '' : 's'} had no map point and were left out of every column (their room on the truck was held back).</li>
              {r.orderSources && <li>“As driven” order came from delivery times on {int(r.orderSources.driven || 0)} truck{r.orderSources.driven === 1 ? '' : 's'}{r.orderSources.planned ? `, the planned order on ${r.orderSources.planned}` : ''}{r.orderSources['stop number'] ? `, stop number on ${r.orderSources['stop number']} (no times or plan)` : ''}.</li>}
              <li>An “order” is one stop number; “addresses” counts the places a driver stops, so two orders for one customer at one dock are one address. Skids and loose pieces are as recorded on the day — an order with no count recorded reads 0.</li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

// ── the days ────────────────────────────────────────────────────────────────

function statusOf(day, jobsByDate, held = false) {
  const job = jobsByDate.get(day.date);
  if (job && ACTIVE.has(job.status)) {
    if (job.status === 'queued') return { k: 'queued', text: held ? 'queued · waiting on the 24-hour ceiling' : 'queued', job };
    return { k: 'running', text: `running · round ${job.rounds || 0} · ${usd(job.usd || 0)}`, job };
  }
  if (day.result) {
    const u = day.result.columns?.claude?.unplanned || 0;
    return { k: 'done', text: `${day.result.submitted ? 'done' : 'done (not submitted)'}${u ? ` · ${u} unplanned` : ''}`, job };
  }
  if (job && job.status === 'failed') return { k: 'failed', text: `failed: ${String(job.error || job.endNote || '').slice(0, 80)}`, job };
  if (job && job.status === 'cancelled') return { k: 'cancelled', text: 'stopped', job };
  return { k: 'none', text: 'not run', job: null };
}

/**
 * Which day is open, and whether its map is. Held ABOVE the phone/desktop switch (ClaudeShadowScreen)
 * so turning a large phone sideways — which crosses into the desktop view — keeps the day open.
 */
export function useOpenDay() {
  const [openDay, setDay] = useState(null);
  const [showMap, setShowMap] = useState(false);
  // The opened route, the trucks coloured, the search and the order travel with the day, so turning
  // a phone sideways keeps the route you were looking at, not just the day.
  const [focus, setFocus] = useState(null);
  const [sel, setSel] = useState(() => new Map());
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState('triage');
  const setOpenDay = useCallback((d) => { setDay(d); setShowMap(false); setFocus(null); setSel(new Map()); setQ(''); setSortBy('triage'); }, []);
  return { openDay, setOpenDay, showMap, setShowMap, focus, setFocus, sel, setSel, q, setQ, sortBy, setSortBy };
}

export default function BacktestPanel({ phone, day }) {
  const b = useBacktests();
  const [picked, setPicked] = useState(() => new Set());
  const own = useOpenDay();
  const dayState = day || own;
  const { openDay, setOpenDay, showMap, setShowMap } = dayState;
  const [showAll, setShowAll] = useState(false);
  // A view missing a part (an older server, a guard's stub) still renders: defaults fill the gaps.
  const v = b.view ? {
    ...b.view,
    days: Array.isArray(b.view.days) ? b.view.days : [],
    jobs: Array.isArray(b.view.jobs) ? b.view.jobs : [],
    settings: b.view.settings || { capRule: 'tighter', costPerMile: null, costPerDriveHour: null, effort: 'high', maxRounds: 8, maxUsd: 5 },
    bounds: b.view.bounds || { maxRounds: [2, 20], maxUsd: [0.5, 50] },
    efforts: Array.isArray(b.view.efforts) ? b.view.efforts : ['high'],
  } : null;
  const jobsByDate = useMemo(() => {
    const m = new Map();
    for (const j of v?.jobs || []) { const prev = m.get(j.date); if (!prev || String(j.createdAt) > String(prev.createdAt)) m.set(j.date, j); }
    return m;
  }, [v]);
  const days = v?.days || [];
  const rates = { perMile: v?.settings?.costPerMile ?? null, perDriveHour: v?.settings?.costPerDriveHour ?? null };
  const totals = useMemo(() => totalsOf(days, rates), [days, rates.perMile, rates.perDriveHour]);
  const shown = showAll ? days : days.slice(0, phone ? 10 : 20);
  const toggle = (d) => setPicked((p) => { const n = new Set(p); if (n.has(d)) n.delete(d); else n.add(d); return n; });
  const pickRecent = (n) => setPicked(new Set(days.filter((d) => statusOf(d, jobsByDate).k === 'none').slice(0, n).map((d) => d.date)));

  return (
    <section className="rounded-xl border-2 border-indigo-200 bg-white p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-800 inline-flex items-center gap-2"><Route size={14} /> Claude router — tried on past days</h2>
          <p className="text-xs text-slate-600 mt-1">Each backtest takes a sealed day’s delivered freight and the trucks that ran, lets Claude re-plan it, and measures dispatch and Claude the same way: road miles, drive time, trucks. It changes nothing on the board. 0 NuVizz calls.</p>
        </div>
        <button onClick={b.load} className="rounded-lg border px-3 text-xs font-semibold bg-white hover:bg-slate-50 min-h-[44px] shrink-0 inline-flex items-center gap-1"><History size={13} /> Refresh</button>
      </div>
      {b.err && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{b.err}</div>}
      {!v && !b.err && <div className="text-xs text-slate-500">Loading…</div>}
      {v && (
        <>
          {v.refused && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Backtests cannot run here: {v.refused}.</div>}
          <div>
            <div className="text-xs font-semibold text-slate-700 mb-1 inline-flex items-center gap-1"><TrendingDown size={13} /> Across every day backtested — Claude against dispatch as driven</div>
            <Totals t={totals} phone={phone} spend={v.spend} />
          </div>
          <RouterSettings v={v} onSave={b.saveSettings} />
          {openDay && <DayDetail key={`${openDay}|${days.find((d) => d.date === openDay)?.result?.at || ''}`} date={openDay} loadResult={b.loadResult} phone={phone} rates={rates} showMap={showMap} setShowMap={setShowMap} route={dayState} onClose={() => setOpenDay(null)} />}
          <div className="flex flex-wrap items-center gap-2">
            <button disabled={!picked.size || b.busy || !!v.refused} onClick={async () => { if (await b.queue([...picked], v.settings.maxUsd, v.ceiling)) setPicked(new Set()); }}
              className="rounded-lg bg-indigo-700 text-white px-3 text-xs font-semibold min-h-[44px] disabled:opacity-50 inline-flex items-center gap-1">
              <Play size={13} /> Backtest {picked.size || ''} day{picked.size === 1 ? '' : 's'}{picked.size ? ` (at most ${usd(picked.size * v.settings.maxUsd)})` : ''}
            </button>
            <button onClick={() => pickRecent(5)} className="rounded-lg border bg-white px-3 text-xs min-h-[44px]">Pick the 5 latest not run</button>
            {picked.size > 0 && <button onClick={() => setPicked(new Set())} className="rounded-lg border bg-white px-3 text-xs min-h-[44px]">Clear</button>}
          </div>
          {b.msg && <p className="text-xs text-slate-700">{b.msg}</p>}
          <div className={phone ? 'space-y-2' : ''}>
            {!phone && (
              <div className="grid grid-cols-[40px_104px_minmax(0,1fr)_128px_96px_84px_64px] xl:grid-cols-[40px_118px_minmax(0,1fr)_128px_104px_96px_84px_96px_64px] gap-2 text-[11px] text-slate-500 px-1 pb-1 border-b">
                <span /><span>Day</span><span>Status</span><span /><span className="text-right">Miles</span><span className="hidden xl:block text-right">Drive time</span><span className="text-right">Trucks</span><span className="hidden xl:block text-right">Cost</span><span className="text-right">Spend</span>
              </div>
            )}
            {shown.map((d) => {
              const st = statusOf(d, jobsByDate, !!v.ceiling?.holding);
              const r = withRates(d.result, rates);
              const canPick = st.k === 'none' || st.k === 'failed' || st.k === 'cancelled' || st.k === 'done';
              const open = () => r && setOpenDay(d.date);
              const chip = { none: 'text-slate-400', queued: 'text-amber-700', running: 'text-indigo-700', done: 'text-emerald-700', failed: 'text-rose-700', cancelled: 'text-slate-500' }[st.k];
              if (phone) {
                return (
                  <div key={d.date} className="rounded-lg border bg-white p-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="inline-flex items-center gap-2 min-h-[44px]">
                        <input type="checkbox" className="w-5 h-5" disabled={!canPick} checked={picked.has(d.date)} onChange={() => toggle(d.date)} aria-label={`Pick ${d.date}`} />
                        <span className="text-xs font-semibold text-slate-800">{fmtDay(d.date)}</span>
                      </label>
                      <span className={`text-[11px] ${chip}`}>{st.text}</span>
                    </div>
                    {r?.vsDriven && (
                      <button onClick={open} className="w-full text-left text-[11px] text-slate-600 min-h-[44px]">
                        <Delta d={r.vsDriven.miles} unit=" mi" /> · <TruckDelta n={r.vsDriven.trucks} /> · {usd(r.usd)} — open
                      </button>
                    )}
                    {st.job && ACTIVE.has(st.job.status) && <button onClick={() => b.cancel(st.job._id)} className="text-[11px] text-rose-700 min-h-[44px]">Stop</button>}
                  </div>
                );
              }
              return (
                <div key={d.date} className="grid grid-cols-[40px_104px_minmax(0,1fr)_128px_96px_84px_64px] xl:grid-cols-[40px_118px_minmax(0,1fr)_128px_104px_96px_84px_96px_64px] gap-2 items-center text-xs px-1 border-b border-slate-100 min-h-[44px]">
                  <input type="checkbox" className="w-5 h-5 justify-self-center" disabled={!canPick} checked={picked.has(d.date)} onChange={() => toggle(d.date)} aria-label={`Pick ${d.date}`} />
                  <span className="font-medium text-slate-800">{fmtDay(d.date)}</span>
                  <span className={`${chip} truncate`} title={st.text}>{st.text}</span>
                  <span className="flex gap-1 justify-end">
                    {st.job && ACTIVE.has(st.job.status) && <button onClick={() => b.cancel(st.job._id)} className="rounded-lg border border-rose-200 bg-white px-2 text-rose-700 min-h-[44px] min-w-[52px]">Stop</button>}
                    {r && <button onClick={open} className="rounded-lg border border-indigo-200 bg-white px-2 text-indigo-700 font-semibold min-h-[44px] min-w-[52px]">Open</button>}
                  </span>
                  <span className="text-right">{r?.vsDriven ? <Delta d={r.vsDriven.miles} unit="" /> : ''}</span>
                  <span className="hidden xl:block text-right">{r?.vsDriven?.driveMin ? <Delta d={{ abs: r.vsDriven.driveMin.abs / 60, pct: r.vsDriven.driveMin.pct }} unit=" h" /> : ''}</span>
                  <span className="text-right">{r?.vsDriven ? <TruckDelta n={r.vsDriven.trucks} /> : ''}</span>
                  <span className="hidden xl:block text-right">{r?.vsDriven?.cost ? <Delta d={r.vsDriven.cost} pct={false} money /> : ''}</span>
                  <span className="text-right text-slate-500">{r ? usd(r.usd) : st.job?.usd ? usd(st.job.usd) : ''}</span>
                </div>
              );
            })}
            {days.length > shown.length && <button onClick={() => setShowAll(true)} className="text-xs text-slate-600 underline min-h-[44px]">Show all {days.length} sealed days</button>}
          </div>
        </>
      )}
    </section>
  );
}
