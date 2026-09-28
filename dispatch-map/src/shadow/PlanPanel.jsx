// PlanPanel.jsx — THE PLANNING AREA: Claude plans a board day onto the loads you pick (v1.76.0).
//
// Chad, 2026-09-26: "there should be a planning area of the shadow mode where I can tell it to build a
// certain number of routes and it take what it's learned from the engine and firestore data and
// propose how it would route the selected routes" — and: "you need to let me set the parameters for
// tomorrows board such as the date and how many days it looks back for unplanned orders."
//
// THE ORDER ON SCREEN IS THE ORDER OF THE DECISION: the day and its look-back (the Map's own carry-over
// rule, 0–14 days), which stops, which loads — then a PREVIEW that reads everything and spends nothing,
// saying what the picked trucks can carry against what there is to carry. Plan is offered only against
// a preview of exactly what is on screen, so the money is never spent on a day nobody looked at.
//
// A proposal, never a plan of record: nothing here sends, saves or stages freight. Two views, per the
// house rule: tables on a desktop, stacked cards on a phone. Choices last the visit only.
//
// SECTIONS (v1.78.0). Chad, 2026-09-27: "instead of letting you do it all at once i would like the choice
// to do it in sections where i have a map in a drawer and can select the stops i want you to put the
// stops on." "A section I pick on the map" opens the board's stops in a drawer (StopPicker.jsx); only the
// picked ones are planned. A finished plan offers "Plan the next section": the next one keeps what this
// one put on a truck picked again, carries the rest forward, and never offers a placed stop twice.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Play, X, Truck, Plus, Eye, MapPinned, AlertTriangle, Route } from 'lucide-react';
import { apiFetch } from '../lib/api.js';
import BacktestMap from './BacktestMap.jsx';
import StopPicker from './StopPicker.jsx';
import { truckColor } from './backtest-map-core.js';
import { pruneSel, selTotals } from './stop-pick-core.js';
import { asPick, pickKey, rebasePicks, nextSectionPicks } from './plan-pick-core.js';

const ENDPOINT = '/.netlify/functions/claude-shadow';
const PLANS_URL = '/.netlify/functions/claude-shadow?view=plans';
const ACTIVE = new Set(['queued', 'running']);
// The Map's own presets for "Carry-over unplanned" (App.jsx CarryoverControl): Off, 3d, 7d, 14d.
const LOOKBACK_PRESETS = [0, 3, 7, 14];

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
const minusDays = (ymd, n) => {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d - n, 12)).toISOString().slice(0, 10);
};
const usd = (v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—');
const int = (v) => (typeof v === 'number' ? Math.round(v).toLocaleString('en-US') : '—');
const one = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1)) : '—');
const hrs = (min) => (typeof min === 'number' ? `${(min / 60).toFixed(1)} h` : '—');
const clsWord = (c) => (c === 'tractor' ? 'tractor' : c === 'box_truck' ? 'box truck' : 'class unknown');
const btn = (phone, on = false) => `rounded-lg border px-3 text-xs font-semibold min-h-[44px] inline-flex items-center gap-1 ${on ? 'bg-indigo-700 text-white border-indigo-700' : 'bg-white text-slate-700'}`;

// ── the reads and writes ────────────────────────────────────────────────────

function usePlans() {
  const [view, setView] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const post = useCallback(async (payload) => {
    const r = await apiFetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => null);
    return { r, j };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch(PLANS_URL);
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setView(j); setErr(null);
      return j;
    } catch (e) { setErr(String(e?.message || e)); return null; }
  }, []);
  useEffect(() => { load(); }, [load]);
  const anyActive = !!view?.jobs?.some((j) => ACTIVE.has(j.status));
  useEffect(() => {
    if (!anyActive) return undefined;
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [anyActive, load]);

  const queue = useCallback(async (params, preview) => {
    // THE CEILING STATED IS THE ONE IN FORCE (audit 2026-09-27): the job is held to the settings as they
    // are when it is queued, and Router settings saved since this area last read them (on this screen or
    // another) would not be in `view` — so they are read again before the confirm says what it may spend.
    // Busy from the start, so a second press during that read cannot open a second confirm.
    setBusy(true);
    try {
      const now = await load();
      if (!now) { setMsg('Not queued: the spend ceiling in force could not be read — press Refresh and try again.'); return null; }
      const maxUsd = now.settings?.maxUsd;
      const daily = now.ceiling;
      const cap = typeof maxUsd === 'number' ? ` It spends at most ${usd(maxUsd)} at the model (no round starts that could pass it), usually less.${daily ? ` Plans and backtests together stop at ${usd(daily.usd)} per 24 hours.` : ''}` : '';
      const short = preview?.capacity?.short?.spots > 0 ? ` The picked loads are ${one(preview.capacity.short.spots)} skid spots short, so some stops will be left off, each with a reason.` : '';
      if (!window.confirm(`Plan ${fmtDay(params.date)} with Claude onto ${params.picks.length} load${params.picks.length === 1 ? '' : 's'}?${cap}${short} Nothing is sent to NuVizz.`)) return null;
      setMsg(null);
      const { r, j } = await post({ action: 'plan', plan: params, confirm: true, expectBoardAt: preview?.boardAt ?? null });
      if (!j) setMsg(`HTTP ${r.status} — no readable answer; press Refresh to see whether it was queued.`);
      else if (!r.ok || !j.ok) setMsg(`Not queued: ${j.error || (j.errors || []).join('; ') || `HTTP ${r.status}`}`);
      else {
        const when = j.waiting === 'ceiling' ? ` It waits while the 24-hour ceiling is spent (${usd(daily?.spent24h)} of ${usd(daily?.usd)} used) and starts when it rolls on.`
          : typeof j.ahead === 'number' && j.ahead > 0 ? ` It starts after the ${j.ahead} job${j.ahead === 1 ? '' : 's'} ahead of it, a few minutes each.`
          : ' It starts within about three minutes and takes a few more.';
        setMsg(`Queued${typeof j.stops === 'number' && typeof j.loads === 'number' ? `: ${j.stops} stops onto ${j.loads} loads` : ''}${typeof j.maxUsd === 'number' ? `, held to at most ${usd(j.maxUsd)} at the model` : ''}.${when}`);
      }
      await load();
      return j?.ok ? j.jobId : null;
    } catch (e) { setMsg(`Whether it was queued is unknown: ${String(e?.message || e)} — press Refresh.`); return null; }
    finally { setBusy(false); }
  }, [post, load]);

  const cancel = useCallback(async (jobId) => {
    if (!window.confirm('Stop this plan? A round already at the model still finishes and is billed.')) return;
    try {
      const { r, j } = await post({ action: 'backtest-cancel', jobId });
      setMsg(r.ok && j?.ok ? 'Stopped.' : `Not stopped: ${j?.error || `HTTP ${r.status}`}`);
    } catch (e) { setMsg(`Whether it stopped is unknown (${String(e?.message || e)}). Press Refresh, then Stop again if it is still running.`); }
    await load().catch(() => {});
  }, [post, load]);

  return { view, err, msg, busy, load, post, queue, cancel };
}

// ── the parameters ──────────────────────────────────────────────────────────

function DatePick({ date, setDate, days, phone }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-slate-700 inline-flex items-center gap-1" htmlFor="plan-date"><CalendarDays size={13} /> Board day</label>
      <div className="flex flex-wrap items-center gap-2">
        <input id="plan-date" type="date" value={date || ''} onChange={(e) => setDate(e.target.value || null)}
          className={`rounded border border-slate-300 px-2 ${phone ? 'min-h-[44px] text-sm' : 'min-h-[44px] text-xs'}`} />
        {(days || []).slice(0, phone ? 3 : 6).map((d) => (
          <button key={d.date} onClick={() => setDate(d.date)} className={btn(phone, d.date === date)}>
            {fmtDay(d.date)}{typeof d.unplanned === 'number' ? ` · ${d.unplanned} unplanned` : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

function LookbackPick({ value, setValue, date, phone }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const since = value > 0 ? minusDays(date, value) : null;
  const typed = (v) => {
    setText(v);
    if (/^\d{1,2}$/.test(v.trim()) && Number(v) <= 14) setValue(Number(v));
  };
  const bad = !/^\d{1,2}$/.test(text.trim()) || Number(text) > 14;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-700">Look back for unplanned orders</span>
        <span className="text-[11px] text-amber-700">{value > 0 ? `since ${fmtDay(since)} · ${value}d back` : 'this day only'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {LOOKBACK_PRESETS.map((d) => <button key={d} onClick={() => setValue(d)} aria-pressed={value === d} className={btn(phone, value === d)}>{d === 0 ? 'Off' : `${d}d`}</button>)}
        <label className="text-xs text-slate-600 inline-flex items-center gap-1">or
          <input value={text} onChange={(e) => typed(e.target.value)} inputMode="numeric" aria-label="Days to look back, 0 to 14"
            className={`w-16 min-h-[44px] rounded border px-2 text-right ${bad ? 'border-rose-400 bg-rose-50' : 'border-slate-300'}`} /> days
        </label>
      </div>
      <p className="text-[11px] text-slate-500">The Map’s own Carry-over rule, 0 to 14 days: a still-open unplanned order from an earlier day is folded in; one closed or moved since is not.</p>
      {bad && <p className="text-[11px] text-rose-700">A whole number from 0 to 14. Using {value}.</p>}
    </div>
  );
}

function ScopePick({ scope, setScope, phone }) {
  const opt = (v, title, sub) => (
    <button onClick={() => setScope(v)} aria-pressed={scope === v}
      className={`text-left rounded-lg border px-3 py-2 min-h-[44px] ${scope === v ? 'border-indigo-700 bg-indigo-50' : 'bg-white'} ${phone ? 'w-full' : ''}`}>
      <span className="block text-xs font-semibold text-slate-800">{title}</span>
      <span className="block text-[11px] text-slate-600">{sub}</span>
    </button>
  );
  return (
    <div className="space-y-1">
      <span className="text-xs font-semibold text-slate-700">Which stops</span>
      <div className={phone ? 'flex flex-col gap-2' : 'grid grid-cols-2 gap-2'}>
        {opt('unplanned', 'Unplanned only', 'Stops already on a load stay there. On a load you pick, they are kept on it and count against its room.')}
        {opt('open', 'Every open stop', 'A full re-plan: stops already on loads are moved too, including off loads you do not pick.')}
      </div>
    </div>
  );
}

/** All of it at once, or a section picked on the map (v1.78.0) — and, for a section, what is picked. */
function SectionPick({ area, phone }) {
  const { sectionMode, setSectionMode, section, setSection, stopsRead, openPicker, pickerBtn, after, afterInfo, startFresh, scope } = area;
  const totals = selTotals(stopsRead.data?.stops || [], section);
  const opt = (v, title, sub) => (
    <button onClick={() => setSectionMode(v)} aria-pressed={sectionMode === v}
      className={`text-left rounded-lg border px-3 py-2 min-h-[44px] ${sectionMode === v ? 'border-indigo-700 bg-indigo-50' : 'bg-white'} ${phone ? 'w-full' : ''}`}>
      <span className="block text-xs font-semibold text-slate-800">{title}</span>
      <span className="block text-[11px] text-slate-600">{sub}</span>
    </button>
  );
  return (
    <div className="space-y-2">
      <span className="text-xs font-semibold text-slate-700">How much at once</span>
      <div className={phone ? 'flex flex-col gap-2' : 'grid grid-cols-2 gap-2'}>
        {opt(false, 'All of them', `Every ${scope === 'open' ? 'open' : 'unplanned'} stop on the day, in one plan.`)}
        {opt(true, 'A section I pick on the map', 'Pick the stops on a map; only those are planned. Then plan the next section on top of it.')}
      </div>
      {after && (
        <div className="rounded border border-teal-300 bg-teal-50 px-3 py-2 text-xs text-teal-900 flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">
            {afterInfo?.pending
              ? <>Next section: builds on the plan just queued{area.afterJob ? ` (${area.afterJob.status})` : ''}. {area.afterJob?.status === 'failed' || area.afterJob?.status === 'cancelled' ? 'That plan did not finish, so there is nothing to build on — press Start fresh.' : area.afterJob?.status === 'done' ? 'It is done: pick this section’s stops.' : 'This section can be previewed once that plan is done.'} </>
              : <>Next section: builds on the plan of {fmtWhen(afterInfo?.at)}{typeof afterInfo?.placed === 'number' ? ` (${afterInfo.placed} stops placed so far)` : ''}. </>}
            Its stops on a truck you pick again stay on it (that truck’s stop order is worked out afresh); the rest are carried forward; none is offered again. Keep {afterInfo?.scope === 'open' ? 'every open stop' : 'unplanned only'} and a look-back of {afterInfo?.lookbackDays ?? 0} day{afterInfo?.lookbackDays === 1 ? '' : 's'} or more.
          </span>
          <button onClick={startFresh} className={btn(phone)}>Start fresh</button>
        </div>
      )}
      {sectionMode && (
        <div className={`flex ${phone ? 'flex-col' : 'flex-wrap items-center'} gap-2`}>
          <button ref={pickerBtn} onClick={openPicker} disabled={!area.date} className={btn(phone, true)}><MapPinned size={13} /> Pick stops on the map{section.size ? ` (${section.size} picked)` : ''}</button>
          <span className="text-[11px] text-slate-600">{section.size ? `${section.size} picked${stopsRead.data ? ` · ${one(totals.spots)} skid spots · ${int(totals.lbs)} lb` : ' · reading the board…'}` : 'Nothing picked yet.'}</span>
          {section.size > 0 && <button onClick={() => setSection(new Set())} className={btn(phone)}>Clear the picks</button>}
        </div>
      )}
      {sectionMode && area.secNote && <p className="text-[11px] text-amber-800" role="status">{area.secNote}</p>}
    </div>
  );
}

// ── the loads ───────────────────────────────────────────────────────────────

function LoadPicker({ opts, picks, setPicks, phone }) {
  const roster = opts?.roster?.loads || [];
  const drivers = opts?.drivers || [];
  const [q, setQ] = useState('');
  const [addDriver, setAddDriver] = useState('');
  const has = (k) => picks.has(k);
  const toggle = (p) => setPicks((cur) => { const n = new Map(cur); const k = pickKey(p); if (n.has(k)) n.delete(k); else n.set(k, p); return n; });
  const setCls = (k, cls) => setPicks((cur) => { const n = new Map(cur); const p = n.get(k); if (p) n.set(k, { ...p, cls }); return n; });
  const shown = roster.filter((l) => !q.trim() || `${l.route} ${l.driver || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const pickAll = (withDriver) => setPicks((cur) => { const n = new Map(cur); for (const l of roster) if (!withDriver || l.driver) n.set(pickKey(asPick(l)), asPick(l)); return n; });
  const clearRoster = () => setPicks((cur) => new Map([...cur].filter(([k]) => !k.startsWith('r:'))));
  const trucks = [...picks.values()].filter((p) => p.kind === 'truck');
  const addTruck = (cls) => {
    const base = cls === 'tractor' ? 'SPARE TRACTOR' : 'SPARE BOX';
    let i = 1; while (picks.has(`t:${base} ${i}`)) i++;
    const p = { kind: 'truck', route: `${base} ${i}`, driver: null, cls, loadNbr: null };
    setPicks((cur) => new Map(cur).set(pickKey(p), p));
  };
  const driverRow = drivers.find((d) => d.driver === addDriver) || null;
  const addPickedDriver = () => {
    if (!driverRow) return;
    const p = { kind: 'driver', route: driverRow.route || driverRow.driver, driver: driverRow.driver, cls: null, loadNbr: null, cap: driverRow.cap, capSource: driverRow.source, shownCls: driverRow.cls };
    setPicks((cur) => new Map(cur).set(pickKey(p), p));
    setAddDriver('');
  };
  const rosterPicked = roster.filter((l) => has(pickKey(asPick(l)))).length;
  const others = [...picks.values()].filter((p) => p.kind !== 'roster');

  const rosterRow = (l) => {
    const p = asPick(l), k = pickKey(p), on = has(k);
    const cls = on ? picks.get(k).cls : p.cls;
    const clsSel = !l.driver && on && (
      <select value={cls || 'box_truck'} onChange={(e) => setCls(k, e.target.value)} aria-label={`Truck for ${l.route}`} className="rounded border border-slate-300 px-1 min-h-[44px] text-xs">
        <option value="box_truck">box truck</option><option value="tractor">tractor</option>
      </select>
    );
    if (phone) {
      return (
        <li key={k} className={`rounded-lg border px-3 py-2 ${on ? 'border-indigo-300 bg-indigo-50' : 'bg-white'}`}>
          <label className="flex items-start gap-3 min-h-[44px]">
            <input type="checkbox" checked={on} onChange={() => toggle(p)} className="mt-1 h-5 w-5" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-slate-800 truncate">{l.route}</span>
              <span className="block text-[11px] text-slate-600">{l.driver || 'no driver yet'} · {l.driver ? clsWord(l.cls) : 'pick its truck'} · cap {one(l.cap)} spots{l.onBoard ? ` · ${l.onBoard} stops already on it` : ''}</span>
            </span>
          </label>
          {clsSel}
        </li>
      );
    }
    return (
      <tr key={k} className={`border-t ${on ? 'bg-indigo-50' : ''}`}>
        <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => toggle(p)} aria-label={`Pick ${l.route}`} className="h-4 w-4" /></td>
        <td className="px-2 py-1 font-semibold text-slate-800">{l.route}</td>
        <td className="px-2 py-1">{l.driver || <span className="text-slate-500">no driver yet</span>}</td>
        <td className="px-2 py-1 whitespace-nowrap">{l.driver ? clsWord(l.cls) : (clsSel || <span className="text-slate-500">set once picked</span>)}</td>
        <td className="px-2 py-1 text-right tabular-nums" title={l.source}>{one(l.cap)}</td>
        <td className="px-2 py-1 text-slate-500 text-[11px]">{l.source}</td>
        <td className="px-2 py-1 text-right tabular-nums">{l.onBoard || ''}</td>
      </tr>
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-700 inline-flex items-center gap-1"><Truck size={13} /> Loads to plan onto</span>
        <span className="text-[11px] text-slate-600">{picks.size} picked ({rosterPicked} from the roster{others.length ? `, ${others.length} added` : ''})</span>
      </div>
      {!opts?.roster && <p className="text-[11px] text-amber-800">No load roster is on file for this day — add drivers or trucks below.</p>}
      {opts && opts.classesKnown === false && <p className="text-[11px] text-amber-800">The employee roster could not be read, so no driver’s truck class is known right now; the preview and Plan will refuse until it can be. Press Refresh.</p>}
      {roster.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => pickAll(true)} className={btn(phone)}>Pick every load with a driver</button>
            <button onClick={() => pickAll(false)} className={btn(phone)}>Pick all {roster.length}</button>
            {rosterPicked > 0 && <button onClick={clearRoster} className={btn(phone)}>Clear roster picks</button>}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a route or driver" aria-label="Find a route or driver"
              className={`rounded border border-slate-300 px-2 min-h-[44px] text-xs ${phone ? 'w-full' : 'w-56'}`} />
          </div>
          <p className="text-[11px] text-slate-500">The roster’s loads for {fmtDay(opts?.date)}{opts?.roster?.at ? `, as read ${fmtWhen(opts.roster.at)}` : ''}. Each is held to the cap shown: {opts?.hardCaps === false ? 'yours, else the learned one (hard caps are off, so no ceiling holds it), else the truck’s rating' : `a cap you typed on the driver, else the learned one (or a route cap) held to its class ceiling (box ${opts?.ceilings?.box_truck}, tractor ${opts?.ceilings?.tractor}), else the truck’s rating`}.</p>
          {phone
            ? <ul className="space-y-2 max-h-[420px] overflow-y-auto">{shown.map(rosterRow)}</ul>
            : (
              <div className="max-h-[380px] overflow-y-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-600 sticky top-0"><tr>
                    <th className="px-2 py-1 w-8" /><th className="px-2 py-1 text-left">Route</th><th className="px-2 py-1 text-left">Driver</th><th className="px-2 py-1 text-left">Truck</th>
                    <th className="px-2 py-1 text-right">Cap (spots)</th><th className="px-2 py-1 text-left">Where the cap comes from</th><th className="px-2 py-1 text-right">Already on it</th>
                  </tr></thead>
                  <tbody>{shown.map(rosterRow)}</tbody>
                </table>
              </div>
            )}
        </>
      )}
      <div className={`flex ${phone ? 'flex-col' : 'flex-wrap items-center'} gap-2`}>
        <label className="text-xs text-slate-700 inline-flex items-center gap-2">
          Add a driver
          <select value={addDriver} onChange={(e) => setAddDriver(e.target.value)} className={`rounded border border-slate-300 px-2 min-h-[44px] text-xs ${phone ? 'flex-1 min-w-0' : 'w-56'}`}>
            <option value="">— choose —</option>
            {drivers.map((d) => <option key={d.driver} value={d.driver} disabled={!!d.onRoster || has(`d:${d.driver}`)}>{d.driver}{d.onRoster ? ` (has ${d.onRoster} on the roster)` : ''} · cap {one(d.cap)}</option>)}
          </select>
        </label>
        <button onClick={addPickedDriver} disabled={!driverRow} className={btn(phone)}><Plus size={13} /> Add driver</button>
        <button onClick={() => addTruck('box_truck')} className={btn(phone)}><Plus size={13} /> Box truck, no driver</button>
        <button onClick={() => addTruck('tractor')} className={btn(phone)}><Plus size={13} /> Tractor, no driver</button>
      </div>
      <p className="text-[11px] text-slate-500">A driver already on the roster is greyed: pick their load above, so the stops already on it are kept and they are not given a second, empty truck. A truck with no driver is held to its class rating.</p>
      {others.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {others.map((p) => (
            <li key={pickKey(p)} className="rounded-lg border bg-white px-2 text-xs inline-flex items-center gap-2 min-h-[44px]">
              <span><b>{p.route}</b>{p.driver ? ` · ${p.driver}` : ''} · {clsWord(p.cls || p.shownCls)}{typeof p.cap === 'number' ? ` · cap ${one(p.cap)}` : ''}</span>
              <button onClick={() => toggle(p)} aria-label={`Remove ${p.route}`} className="rounded border px-2 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"><X size={13} /></button>
            </li>
          ))}
        </ul>
      )}
      {trucks.length === 0 && picks.size === 0 && <p className="text-[11px] text-slate-600">Pick at least one load.</p>}
    </div>
  );
}

// ── the preview ─────────────────────────────────────────────────────────────

function Need({ label, need, have, short, fmt = one, unit = '', phone }) {
  const pct = have > 0 ? Math.min(100, Math.round((need / have) * 100)) : 100;
  return (
    <div className="space-y-0.5">
      <div className={`${phone ? 'flex flex-col' : 'flex items-baseline justify-between gap-2'} text-xs`}>
        <span className="text-slate-700">{label}</span>
        <span className={`tabular-nums ${short ? 'text-rose-700 font-semibold' : 'text-slate-700'}`}>{fmt(need)}{unit} needed · {fmt(have)}{unit} on the picked loads{short ? ` · ${fmt(short)}${unit} short` : ''}</span>
      </div>
      <div className="h-2 rounded bg-slate-100 overflow-hidden" aria-hidden="true"><div className={`h-2 ${short ? 'bg-rose-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function PreviewCard({ pv, phone }) {
  const c = pv.counts, cap = pv.capacity;
  const days = Object.entries(c.byDay || {}).sort(([a], [b]) => b.localeCompare(a));
  const short = cap.short || {};
  const anyShort = short.spots > 0 || short.lbs > 0 || short.noTractor > 0 || short.time > 0;
  return (
    <div className="rounded-lg border bg-slate-50 p-3 space-y-2" role="region" aria-label="Preview">
      <p className="text-sm text-slate-800"><b>{c.toPlan}</b> stop{c.toPlan === 1 ? '' : 's'} for Claude to place{days.length > 1 ? ` (${days.map(([d, n]) => `${n} filed ${fmtDay(d)}`).join(', ')})` : ''}{c.kept ? <>, and <b>{c.kept}</b> already on the picked loads in NuVizz, kept there</> : ''}{c.earlierKept ? <>, and <b>{c.earlierKept}</b> placed by the earlier section on loads picked again, kept there</> : ''}.</p>
      {c.section != null && <p className="text-[11px] text-slate-700">Section: {c.section} picked on the map{c.leftForLater ? ` · ${c.leftForLater} other open stop${c.leftForLater === 1 ? '' : 's'} left for another section` : ''}{c.sectionAlreadyPlaced ? ` · ${c.sectionAlreadyPlaced} already placed by the earlier section` : ''}{c.sectionMissing ? ` · ${c.sectionMissing} picked but not plannable now (no longer open, on a load not picked, or with no map point)` : ''}.</p>}
      {pv.params?.after && <p className="text-[11px] text-slate-700">Builds on the earlier section: {c.earlierKept || 0} of its stops stay on the loads picked again · {c.earlierCarried || 0} ride loads not picked here and are carried forward as placed{c.earlierNoLocation ? ` · ${c.earlierNoLocation} lost ${c.earlierNoLocation === 1 ? 'its' : 'their'} map point and ${c.earlierNoLocation === 1 ? 'is' : 'are'} carried forward, room held back` : ''}{c.earlierDropped ? ` · ${c.earlierDropped} dropped: no longer open${pv.params.scope === 'unplanned' ? ', or now on a load in NuVizz (NuVizz outranks a section)' : ''}` : ''}.</p>}
      <p className="text-[11px] text-slate-600">Not planned here: {[
        c.planned ? `${c.planned} on loads you did not pick (they stay where they are)` : null,
        c.pickups ? `${c.pickups} pickup${c.pickups === 1 ? '' : 's'}` : null,
        c.finished ? `${c.finished} finished` : null,
        c.cancelled ? `${c.cancelled} cancelled` : null,
        c.noLocation ? `${c.noLocation} with no map point` : null,
        c.ambiguous ? `${c.ambiguous} on a picked route name the roster gives to more than one load (which of them carries each cannot be told)` : null,
      ].filter(Boolean).join(' · ') || 'nothing'}.{c.corrected ? ` ${c.corrected} placed at a pin a dispatcher corrected, as the Map draws them.` : ''}{pv.carry ? ` Look-back: ${pv.carry.added} carried in${pv.carry.unverified ? ` (${pv.carry.unverified} older than any scan can confirm is still open)` : ''}, ${pv.carry.pruned} dropped as closed or moved (judged by ${pv.carry.basis === 'pool' ? 'the open-order pool' : pv.carry.basis === 'snapshot' ? 'the unplanned snapshot' : 'nothing — every earlier unplanned row folded in'}).` : ''} Board as scanned {fmtWhen(pv.boardAt)}.</p>
      <div className="space-y-2">
        <Need phone={phone} label="Skid spots" need={cap.spots} have={cap.capSpots} short={short.spots} />
        <Need phone={phone} label="Pounds" need={cap.lbs} have={cap.capLbs} short={short.lbs} fmt={int} unit=" lb" />
        {cap.noTractorStops > 0 && <Need phone={phone} label={`No-tractor stops (${cap.noTractorStops}) on box trucks`} need={cap.noTractorSpots} have={cap.boxCapSpots} short={short.noTractor} />}
        <Need phone={phone} label="Time on site alone (before any driving)" need={cap.serviceMin / 60} have={cap.dayMin / 60} short={short.time / 60} unit=" h" />
      </div>
      {pv.infeasible && <div className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 inline-flex gap-2" role="alert"><AlertTriangle size={14} className="shrink-0 mt-0.5" /><span>Plan is off: {pv.infeasible}.</span></div>}
      {pv.nothingToPlace && <div className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 inline-flex gap-2" role="alert"><AlertTriangle size={14} className="shrink-0 mt-0.5" /><span>Plan is off: {pv.nothingToPlace}.</span></div>}
      {anyShort
        ? <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 inline-flex gap-2"><AlertTriangle size={14} className="shrink-0 mt-0.5" /><span>The picked loads cannot carry all of this. Claude places what fits and leaves the rest off, each with its reason — and may not leave a stop off a truck that has room for it. Pick more loads to place more.</span></div>
        : <p className="text-[11px] text-emerald-800">The picked loads have the room on paper. Driving time is not counted above; Claude’s plan is held to each driver’s full day.</p>}
      <details>
        <summary className="text-xs font-semibold text-indigo-700 min-h-[44px] flex items-center cursor-pointer">▸&nbsp;The {pv.loads.length} loads, and what they are held to</summary>
        {phone
          ? <ul className="space-y-1">{pv.loads.map((l) => <li key={l.id} className="text-[11px] text-slate-700"><b>{l.id} {l.route}</b> · {l.driver} · {clsWord(l.cls)} · cap {one(l.cap)} · ≤{int(l.maxLbs)} lb · {hrs(l.maxMin)} day{l.capNote ? ` — ${l.capNote}` : ''}</li>)}</ul>
          : (
            <table className="w-full text-xs">
              <thead className="text-slate-600"><tr><th className="text-left px-1">Load</th><th className="text-left px-1">Route</th><th className="text-left px-1">Driver</th><th className="text-left px-1">Truck</th><th className="text-right px-1">Cap</th><th className="text-right px-1">Max lb</th><th className="text-right px-1">Day</th><th className="text-left px-1">Cap from</th></tr></thead>
              <tbody>{pv.loads.map((l) => <tr key={l.id} className="border-t"><td className="px-1">{l.id}</td><td className="px-1 font-semibold">{l.route}</td><td className="px-1">{l.driver}</td><td className="px-1">{clsWord(l.cls)}</td><td className="px-1 text-right tabular-nums">{one(l.cap)}</td><td className="px-1 text-right tabular-nums">{int(l.maxLbs)}</td><td className="px-1 text-right">{hrs(l.maxMin)}</td><td className="px-1 text-[11px] text-slate-500">{l.capSource}{l.capNote ? ` — ${l.capNote}` : ''}</td></tr>)}</tbody>
            </table>
          )}
      </details>
      <details>
        <summary className="text-xs font-semibold text-indigo-700 min-h-[44px] flex items-center cursor-pointer">▸&nbsp;What this plan assumes</summary>
        <ul className="list-disc pl-5 space-y-1">{(pv.approximations || []).map((a) => <li key={a} className="text-[11px] text-slate-600">{a}</li>)}</ul>
      </details>
    </div>
  );
}

// ── the jobs and a result ───────────────────────────────────────────────────

// Where a queued plan stands: the worker takes the oldest job first, backtests and plans alike, and
// holds new work while the 24-hour ceiling is spent — so "queued" alone would promise too much.
function queuedWord(j, view) {
  if (j.status !== 'queued') return j.status;
  if (view?.ceiling?.holding) return 'queued · waiting for the 24-hour ceiling';
  const ahead = typeof view?.ahead?.[j._id] === 'number' ? view.ahead[j._id] : null;
  return ahead ? `queued · ${ahead} job${ahead === 1 ? '' : 's'} ahead` : 'queued · next';
}

function JobList({ jobs, onOpen, onStop, openId, phone, view }) {
  if (!jobs?.length) return <p className="text-[11px] text-slate-500">No plans yet.</p>;
  return (
    <ul className="space-y-1">
      {jobs.map((j) => {
        const p = j.params || {};
        const h = j.headline;
        return (
          <li key={j._id} className={`rounded-lg border px-3 py-2 ${openId === j._id ? 'border-indigo-700 bg-indigo-50' : 'bg-white'} flex ${phone ? 'flex-col' : 'flex-wrap items-center'} gap-2`}>
            <span className="text-xs text-slate-800 min-w-0 flex-1">
              <b>{fmtDay(p.date || j.date)}</b> · {(p.picks || []).length} loads · {p.scope === 'open' ? 'every open stop' : 'unplanned only'} · look back {p.lookbackDays || 0}d{p.sectionSize ? ` · a section of ${p.sectionSize}` : ''}{p.after ? ' · builds on an earlier section' : ''}
              <span className="block text-[11px] text-slate-600">{queuedWord(j, view)}{j.rounds ? ` · ${j.rounds} rounds` : ''} · {usd(j.usd)} · {j.by || '—'} · {fmtWhen(j.createdAt)}{h ? ` · ${h.placed} placed${h.kept ? ` (+${h.kept} kept)` : ''}, ${h.unplanned} left off, ${h.trucks} trucks, ${one(h.miles)} mi` : ''}{j.error ? ` · ${j.error}` : ''}</span>
            </span>
            <span className="flex gap-2">
              {j.status === 'done' && <button onClick={() => onOpen(j._id)} aria-pressed={openId === j._id} className={btn(phone, openId === j._id)}><Eye size={13} /> {openId === j._id ? 'Hide' : 'Open'}</button>}
              {ACTIVE.has(j.status) && !j.cancelRequested && <button onClick={() => onStop(j._id)} className={btn(phone)}><X size={13} /> Stop</button>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function usePlanResult(id, post) {
  const [res, setRes] = useState(null);
  const [map, setMap] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setRes(null); setMap(null); setErr(null);
    if (!id) return undefined;
    (async () => {
      try {
        const [a, b] = await Promise.all([post({ action: 'plan-result', id }), post({ action: 'plan-map', id })]);
        if (!live) return;
        if (!a.r.ok || !a.j?.ok) throw new Error(a.j?.error || `HTTP ${a.r.status}`);
        setRes(a.j.result);
        if (b.r.ok && b.j?.ok) setMap(b.j.map); else setErr(`the map could not be read: ${b.j?.error || `HTTP ${b.r.status}`}`);
      } catch (e) { if (live) setErr(String(e?.message || e)); }
    })();
    return () => { live = false; };
  }, [id, post]);
  return { res, map, err };
}

function ResultView({ res, map, phone, onNext }) {
  const [focus, setFocus] = useState(null);
  const [zoomTick, setZoomTick] = useState(0);
  // The map's picked trucks: a Map (truck id → colour slot), as BacktestMap reads it. Empty: every truck in its own colour.
  const sel = useMemo(() => new Map(), []);
  const t = res.columns?.claude || {};
  const used = (res.loads || []).filter((l) => l.claude && l.claude.stops > 0);
  const open = (id) => { setFocus(id); setZoomTick((z) => z + 1); };
  const colorOf = (id) => (map ? truckColor(map, id) : '#64748b');
  return (
    <div className="space-y-3">
      <div className={`grid ${phone ? 'grid-cols-2' : 'grid-cols-7'} gap-2`}>
        {[
          ['Stops placed by Claude', int(typeof t.stops === 'number' ? t.stops - (res.kept || 0) : null)], ['Already on the loads, kept', int(res.kept || 0)], ['Left off', int(res.unplanned?.length ?? 0)], ['Trucks used', `${used.length} of ${res.loads?.length ?? 0}`],
          ['Miles (est.)', one(t.miles)], ['Drive time', hrs(t.driveMin)], ['Model spend', usd(res.usd)],
        ].map(([k, v]) => <div key={k} className="rounded-lg border bg-white px-3 py-2"><div className="text-[11px] text-slate-500">{k}</div><div className="text-sm font-semibold text-slate-800 tabular-nums">{v}</div></div>)}
      </div>
      <p className="text-[11px] text-slate-600">{res.planFrom === 'submitted' ? 'Claude’s submitted plan' : `Claude’s ${res.planFrom}`}, {fmtWhen(res.at)}. A proposal for {fmtDay(res.date)} only — nothing was sent to NuVizz.</p>
      {(res.section?.carried?.length > 0) && <p className="text-[11px] text-slate-600">Carried forward from the earlier sections, on loads not picked in this one: {res.section.carried.length} stop{res.section.carried.length === 1 ? '' : 's'} ({[...new Set(res.section.carried.map((c) => c.route))].slice(0, 8).join(', ')}{new Set(res.section.carried.map((c) => c.route)).size > 8 ? ', …' : ''}).</p>}
      {Array.isArray(res.placements) && (res.section?.after || res.section?.carried?.length > 0) && (() => {
        // THE DAY SO FAR (review): what Claude has placed across every section of the chain, by truck —
        // this section's trucks and the ones carried forward. A proposal: nothing is in NuVizz.
        const byRoute = new Map();
        const add = (route, driver, n, now) => { const k = `${route}|${driver}`; const x = byRoute.get(k) || { route, driver, n: 0, now: 0 }; x.n += n; x.now += now; byRoute.set(k, x); };
        const loadById = new Map((res.loads || []).map((l) => [l.id, l]));
        const perLoad = new Map();
        for (const x of res.placements) perLoad.set(x.load, (perLoad.get(x.load) || 0) + 1);
        for (const [id, n] of perLoad) { const l = loadById.get(id); if (l) add(l.route, l.driver, n, n - (l.earlier || 0)); }
        for (const c of res.section?.carried || []) add(c.route, c.driver, 1, 0);
        const rowsDay = [...byRoute.values()].sort((a, b) => a.route.localeCompare(b.route));
        const total = rowsDay.reduce((a, x) => a + x.n, 0);
        return (
          <details>
            <summary className="text-xs font-semibold text-indigo-700 min-h-[44px] flex items-center cursor-pointer">▸&nbsp;The day so far, across the sections: {total} stops placed on {rowsDay.length} trucks</summary>
            <ul className="space-y-1">{rowsDay.map((x) => <li key={`${x.route}|${x.driver}`} className="text-[11px] text-slate-700"><b>{x.route}</b> · {x.driver} · {x.n} stop{x.n === 1 ? '' : 's'}{x.now ? ` (${x.now} in this section)` : ' (earlier sections)'}</li>)}</ul>
            <p className="text-[11px] text-slate-500">Claude’s placements only, not the stops NuVizz already has on these trucks. A proposal: nothing is in NuVizz.</p>
          </details>
        );
      })()}
      {Array.isArray(res.placements) && onNext && (
        <div className={`flex ${phone ? 'flex-col' : 'flex-wrap items-center'} gap-2`}>
          <button onClick={() => onNext(res)} className={btn(phone, true)}><MapPinned size={13} /> Plan the next section</button>
          <span className="text-[11px] text-slate-600">Pick more stops on the map. What this plan put on a truck stays on it when you pick that truck again, and is carried forward when you do not.</span>
        </div>
      )}
      {phone
        ? (
          <ul className="space-y-2">
            {(res.loads || []).map((l) => (
              <li key={l.id} className="rounded-lg border bg-white px-3 py-2">
                <button onClick={() => open(l.id)} className="w-full text-left min-h-[44px]">
                  <span className="text-sm font-semibold text-slate-800 inline-flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-full" style={{ background: colorOf(l.id) }} />{l.route} · {l.driver}</span>
                  <span className="block text-[11px] text-slate-600">{clsWord(l.cls)} · {l.claude ? `${l.claude.stops} stops${l.kept ? ` (${l.kept} kept${l.earlier ? `, ${l.earlier} from the earlier section` : ''})` : ''} · ${one(l.claude.spots)}/${one(l.cap)} spots · ${int(l.claude.weight)} lb · ${one(l.claude.miles)} mi · day ${hrs(l.claude.driverMin)} of ${hrs(l.maxMin)}` : 'not used'}</span>
                  {l.why && <span className="block text-[11px] text-slate-500">{l.why}</span>}
                </button>
              </li>
            ))}
          </ul>
        )
        : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600"><tr>
                <th className="px-2 py-1 text-left">Route</th><th className="px-2 py-1 text-left">Driver</th><th className="px-2 py-1 text-left">Truck</th>
                <th className="px-2 py-1 text-right">Stops</th><th className="px-2 py-1 text-right">Spots / cap</th><th className="px-2 py-1 text-right">Lb / max</th>
                <th className="px-2 py-1 text-right">Miles</th><th className="px-2 py-1 text-right">Driver’s day</th><th className="px-2 py-1 text-left">Claude’s reason</th>
              </tr></thead>
              <tbody>
                {(res.loads || []).map((l) => (
                  <tr key={l.id} onClick={() => open(l.id)} className={`border-t cursor-pointer ${focus === l.id ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
                    <td className="px-2 py-1 font-semibold"><span className="inline-flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-full" style={{ background: colorOf(l.id) }} />{l.route}</span></td>
                    <td className="px-2 py-1">{l.driver}</td><td className="px-2 py-1">{clsWord(l.cls)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{l.claude ? `${l.claude.stops}${l.kept ? ` (${l.kept} kept${l.earlier ? `, ${l.earlier} earlier` : ''})` : ''}` : 'not used'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{l.claude ? `${one(l.claude.spots)} / ${one(l.cap)}` : `— / ${one(l.cap)}`}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{l.claude ? `${int(l.claude.weight)} / ${int(l.maxLbs)}` : '—'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{l.claude ? one(l.claude.miles) : '—'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{l.claude ? `${hrs(l.claude.driverMin)} of ${hrs(l.maxMin)}` : '—'}</td>
                    <td className="px-2 py-1 text-[11px] text-slate-600">{l.why || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {(res.unplanned || []).length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-1">
          <p className="text-xs font-semibold text-amber-900">Left off: {res.unplanned.length} stop{res.unplanned.length === 1 ? '' : 's'}, each with Claude’s reason. The evaluator refused any it could have fit on a picked truck.</p>
          <ul className="space-y-1 max-h-72 overflow-y-auto">
            {res.unplanned.map((u) => <li key={u.stop} className="text-[11px] text-amber-900"><b>{u.name || u.n}</b>{u.city ? `, ${u.city}` : ''}{u.day && u.day !== res.date ? ` (filed ${fmtDay(u.day)})` : ''} · {one(u.spots)} spots · {int(u.lbs)} lb — {u.reason}</li>)}
          </ul>
        </div>
      )}
      {map
        ? <BacktestMap only="claude" m={map} phone={phone} sel={sel} onPick={() => {}} onClearPicks={() => {}} focus={focus} zoomTick={zoomTick} onOpenRoute={open} onAllRoutes={() => setFocus(null)} />
        : <p className="text-[11px] text-slate-500 inline-flex items-center gap-1"><MapPinned size={12} /> Loading the map…</p>}
      <details>
        <summary className="text-xs font-semibold text-indigo-700 min-h-[44px] flex items-center cursor-pointer">▸&nbsp;What this plan assumed</summary>
        <ul className="list-disc pl-5 space-y-1">{(res.approximations || []).map((a) => <li key={a} className="text-[11px] text-slate-600">{a}</li>)}</ul>
      </details>
    </div>
  );
}

/**
 * THE STOP MAP'S READ (v1.78.0): the board's open deliveries for the day, look-back, scope and earlier
 * section on screen — read when a section is being picked, again whenever one of those changes, and on
 * Refresh. A read that is under way for other settings never lands on the new ones.
 */
function useSectionStops(post, q, on) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);
  const key = on && q.date ? JSON.stringify({ date: q.date, lookbackDays: q.lookbackDays, scope: q.scope, after: q.after || null }) : null;
  useEffect(() => {
    setData(null);
    if (!key) return undefined;
    let live = true;
    setLoading(true); setErr(null);
    post({ action: 'plan-stops', plan: JSON.parse(key) }).then(({ r, j }) => {
      if (!live) return;
      if (!r.ok || !j?.ok) setErr(j?.error || (j?.errors || []).join('; ') || `HTTP ${r.status}`);
      else setData(j);
    }).catch((e) => { if (live) setErr(String(e?.message || e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [key, post, tick]);
  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, err, retry };
}

// ── the panel ───────────────────────────────────────────────────────────────

/**
 * The planning area's state. Held by ClaudeShadowScreen ABOVE the phone/desktop switch, so a phone
 * turned sideways keeps its day, look-back, picks, preview and open plan.
 */
export function usePlanArea() {
  const pl = usePlans();
  const [date, setDate] = useState(null);
  const [lookback, setLookback] = useState(0);
  const [scope, setScope] = useState('unplanned');
  const [picks, setPicks] = useState(() => new Map());
  const [opts, setOpts] = useState(null);
  const [optsErr, setOptsErr] = useState(null);
  const [pv, setPv] = useState(null);
  const [pvKey, setPvKey] = useState(null);
  const [pvErr, setPvErr] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [openId, setOpenId] = useState(null);
  const result = usePlanResult(openId, pl.post);
  // SECTIONS (v1.78.0): the stops picked on the map, and the finished plan this section builds on.
  const [sectionMode, setSectionMode] = useState(false);
  const [section, setSection] = useState(() => new Set());
  const [after, setAfter] = useState(null);
  const [afterInfo, setAfterInfo] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [secNote, setSecNote] = useState(null);
  const pickerBtn = useRef(null);
  const stopsRead = useSectionStops(pl.post, { date, lookbackDays: lookback, scope, after }, sectionMode);
  // The plan a section builds on, as the jobs list has it — a queued one is waited for, and when it is
  // done the stop map is read again so its placements show (review).
  const afterJob = useMemo(() => (after ? (pl.view?.jobs || []).find((j) => j._id === after) || null : null), [after, pl.view]);
  const afterStatus = afterJob?.status || null;
  useEffect(() => { if (afterStatus === 'done' && sectionMode) stopsRead.retry(); }, [afterStatus]);   // eslint-disable-line react-hooks/exhaustive-deps
  // A pick the board no longer offers (now on a load, placed by the earlier section, gone) comes off —
  // and the screen says how many did, rather than planning fewer stops than it shows.
  useEffect(() => {
    if (!stopsRead.data) return;
    const r = pruneSel(section, stopsRead.data.stops, scope);
    if (r.dropped) { setSection(r.next); setSecNote(`${r.dropped} picked stop${r.dropped === 1 ? ' is' : 's are'} no longer offered for this section (now on a load, placed by the earlier section, or gone from the board) and ${r.dropped === 1 ? 'was' : 'were'} taken off.`); }
    else setSecNote(null);
  }, [stopsRead.data]);   // eslint-disable-line react-hooks/exhaustive-deps
  // A new day by hand is a new start: the picks and the plan to build on belong to the day they were made on.
  // Re-tapping the day already on screen changes nothing (review: it wiped the picks and the chain).
  const changeDate = useCallback((d) => { if (d === date) return; setDate(d); setAfter(null); setAfterInfo(null); setSection(new Set()); }, [date]);
  const startFresh = useCallback(() => { setAfter(null); setAfterInfo(null); }, []);
  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => { setPickerOpen(false); requestAnimationFrame(() => pickerBtn.current?.focus()); }, []);

  // The picker's read for the day: the board days, the roster, every driver with the cap a plan holds.
  // The first read asks for no day and is answered for the latest board day; that answer is kept, not
  // asked for again when the day is set from it.
  const readFor = useRef(undefined);
  // Refresh re-reads the picker too (review): a late roster, a failed read, a roster that could not be read.
  const [optsTick, setOptsTick] = useState(0);
  const lastTick = useRef(0);
  useEffect(() => {
    const forced = optsTick !== lastTick.current;
    lastTick.current = optsTick;
    if (!forced && date && readFor.current === date) return undefined;
    let live = true;
    setOptsErr(null);
    pl.post({ action: 'plan-options', date }).then(({ r, j }) => {
      if (!live) return;
      if (!r.ok || !j?.ok) { setOptsErr(j?.error || `HTTP ${r.status}`); return; }
      readFor.current = j.date || date;
      setOpts(j);
      if (!date && j.date) setDate(j.date);
      // Roster picks belong to their day: a new day keeps added drivers and trucks, not old roster loads —
      // and not a driver who has a load of their own on the new day's roster (one driver, one truck; review).
      // A roster load still on it is rebuilt from the row just read, so the plan carries the driver and
      // class now on screen and the preview goes stale (audit 2026-09-27).
      setPicks((cur) => rebasePicks(cur, j.roster?.loads || []));
    }).catch((e) => { if (live) setOptsErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [date, pl.post, optsTick]);

  const params = useMemo(() => ({
    date, lookbackDays: lookback, scope,
    picks: [...picks.values()].map((p) => ({ kind: p.kind, route: p.route, driver: p.driver ?? null, cls: p.cls ?? null, loadNbr: p.loadNbr ?? null })),
    section: sectionMode ? [...section].sort() : null,
    after: after || null,
  }), [date, lookback, scope, picks, sectionMode, section, after]);
  const key = JSON.stringify(params);
  const fresh = pv && pvKey === key;

  const preview = async () => {
    setPreviewing(true); setPvErr(null);
    try {
      const { r, j } = await pl.post({ action: 'plan-preview', plan: params });
      if (!r.ok || !j?.ok) { setPv(null); setPvErr(j?.error || (j?.errors || []).join('; ') || `HTTP ${r.status}`); }
      else { setPv(j); setPvKey(key); }
    } catch (e) { setPvErr(String(e?.message || e)); }
    finally { setPreviewing(false); }
  };
  // A QUEUED SECTION IS THE BASE OF THE NEXT ONE (review): building on the older plan again would put a
  // second truck's worth on a truck already used and drop this section from the chain. The picks are
  // spent; the next section can be previewed once this one is done.
  const run = async () => {
    const id = await pl.queue(params, pv);
    if (!id) return;
    setOpenId(null);
    if (sectionMode || after) {
      setAfter(id);
      setAfterInfo({ at: null, placed: null, pending: true, lookbackDays: lookback, scope });
      setSection(new Set());
      setPv(null);
    }
  };
  const refresh = () => { pl.load(); setOptsTick((n) => n + 1); if (sectionMode) stopsRead.retry(); };
  // PLAN THE NEXT SECTION (v1.78.0): the same day, look-back, scope and loads as the finished plan, built
  // on it, with nothing picked yet — and the map opens to pick.
  const nextSection = useCallback((res) => {
    const p = res?.params || {};
    if (res?.date) setDate(res.date);
    setLookback(Number.isInteger(p.lookbackDays) ? p.lookbackDays : 0);
    setScope(p.scope === 'open' ? 'open' : 'unplanned');
    // Held to the roster on screen when it is that day's, as a Refresh holds them (review, audit 2026-09-27).
    setPicks(nextSectionPicks(p.picks, opts, res?.date || date));
    setSectionMode(true);
    setSection(new Set());
    setAfter(res.jobId);
    setAfterInfo({ at: res.at ?? null, placed: (res.placements?.length || 0) + (res.section?.carried?.length || 0), lookbackDays: Number.isInteger(p.lookbackDays) ? p.lookbackDays : 0, scope: p.scope === 'open' ? 'open' : 'unplanned' });
    setPv(null);
    setOpenId(null);
    setPickerOpen(true);
  }, [opts, date]);
  return {
    pl, date, setDate: changeDate, lookback, setLookback, scope, setScope, picks, setPicks, opts, optsErr,
    pv, pvErr, previewing, fresh, preview, run, openId, setOpenId, result, refresh,
    sectionMode, setSectionMode, section, setSection, after, afterInfo, afterJob, startFresh, stopsRead,
    pickerOpen, openPicker, closePicker, pickerBtn, secNote, nextSection,
  };
}

export default function PlanPanel({ phone = false, area }) {
  const {
    pl, date, setDate, lookback, setLookback, scope, setScope, picks, setPicks, opts, optsErr,
    pv, pvErr, previewing, fresh, preview, run, openId, setOpenId, result, refresh,
    sectionMode, section, stopsRead, pickerOpen, closePicker, nextSection,
  } = area;
  const needPicks = sectionMode && section.size === 0;
  const v = pl.view;
  const refused = v?.refused;
  return (
    <section className="rounded-xl border bg-white p-4 space-y-4" aria-labelledby="plan-h">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="plan-h" className="text-sm font-semibold text-slate-800 inline-flex items-center gap-2"><Route size={14} /> Plan a day with Claude</h2>
          <p className="text-xs text-slate-600 mt-0.5">Pick a board day, how far back to reach for unplanned orders, and the loads. Claude proposes which stops ride which truck, held to the caps, weight limits and drivers’ days it learned. A proposal only: nothing is sent to NuVizz.</p>
        </div>
        <button onClick={refresh} className={btn(phone)}>Refresh</button>
      </div>
      {refused && <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">Plans cannot run here: {refused}. The preview still works.</div>}
      {pl.err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{pl.err}</div>}

      <div className={phone ? 'space-y-3' : 'grid grid-cols-2 gap-4'}>
        <DatePick date={date} setDate={setDate} days={opts?.boardDays} phone={phone} />
        <LookbackPick value={lookback} setValue={setLookback} date={date} phone={phone} />
      </div>
      {opts?.board && date === opts.date && <p className="text-[11px] text-slate-600">{fmtDay(opts.date)}: {int(opts.board.count)} stops on the board, {int(opts.board.unplanned)} unplanned, {int(opts.board.planned)} on loads · scanned {fmtWhen(opts.board.scannedAt)}.</p>}
      {opts && !opts.board && date && <p className="text-[11px] text-amber-800">No board is on file for {fmtDay(date)} yet: the scans have not written that day.</p>}
      {optsErr && <p className="text-[11px] text-rose-700">The loads could not be read: {optsErr}</p>}
      <ScopePick scope={scope} setScope={setScope} phone={phone} />
      <SectionPick area={area} phone={phone} />
      <LoadPicker opts={opts} picks={picks} setPicks={setPicks} phone={phone} />

      <div className={`flex ${phone ? 'flex-col' : 'flex-wrap items-center'} gap-2`}>
        <button onClick={preview} disabled={!date || !picks.size || previewing || needPicks} className={btn(phone)}><Eye size={13} /> {previewing ? 'Reading the board…' : 'Preview (free)'}</button>
        <button onClick={run} disabled={!fresh || !!refused || pl.busy || !!pv?.infeasible || !!pv?.nothingToPlace} className={btn(phone, fresh && !refused && !pv?.infeasible && !pv?.nothingToPlace)}><Play size={13} /> {pl.busy ? 'Queuing…' : `Plan with Claude${typeof v?.settings?.maxUsd === 'number' ? ` (≤ ${usd(v.settings.maxUsd)})` : ''}`}</button>
        <span className="text-[11px] text-slate-500">{needPicks ? 'Pick at least one stop on the map for this section.' : !pv ? 'Preview first: it reads the board and says what the loads can carry, and spends nothing.' : fresh ? 'The preview matches what is picked.' : 'Something changed since the preview — preview again before planning.'}</span>
      </div>
      {pvErr && <p className="text-[11px] text-rose-700">Preview refused: {pvErr}</p>}
      {pv && <div className={fresh ? '' : 'opacity-60'}><PreviewCard pv={pv} phone={phone} /></div>}
      {pl.msg && <p className="text-xs text-slate-700" role="status">{pl.msg}</p>}

      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-slate-700">Plans{v?.spend ? ` · ${usd(v.spend.usd)} across ${v.spend.runs} run${v.spend.runs === 1 ? '' : 's'}` : ''}{v?.ceiling ? ` · plans and backtests ≤ ${usd(v.ceiling.usd)} per 24 h (${usd(v.ceiling.spent24h)} used)` : ''}</h3>
        <JobList jobs={v?.jobs} onOpen={(id) => setOpenId((cur) => (cur === id ? null : id))} onStop={pl.cancel} openId={openId} phone={phone} view={v} />
      </div>
      {openId && (
        result.res
          ? <ResultView res={result.res} map={result.map} phone={phone} onNext={nextSection} />
          : <p className="text-[11px] text-slate-500">{result.err ? `The plan could not be read: ${result.err}` : 'Reading the plan…'}</p>
      )}
      {openId && result.res && result.err && <p className="text-[11px] text-amber-800">{result.err}</p>}
      <StopPicker open={pickerOpen} phone={phone} onClose={closePicker} board={stopsRead.data} loading={stopsRead.loading} err={stopsRead.err} onRetry={stopsRead.retry}
        sel={section} setSel={area.setSection} scope={scope} note={area.secNote} />
    </section>
  );
}

