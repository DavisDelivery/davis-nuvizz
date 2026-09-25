// BacktestMap.jsx — CLAUDE'S PLAN AND DISPATCH'S, ON A REAL MAP, FOR ONE BACKTESTED DAY.
//
// Chad, 2026-09-25: "I want an interactive map to see Claude's vs my own dispatch" — and, offered a
// plain drawn map or real streets, "Google streets". It loads Google through the one reviewed loader
// the shadow screen may use (lib/google-maps-loader.js), reads the day through the shadow's own
// endpoint only, and changes nothing: it is a picture of a backtest, not a board.
//
// WHAT YOU DO WITH IT. Tap a truck in the list to colour it on both maps (up to eight at once) and see
// where that driver went under dispatch and where Claude would have sent them. Tap a stop to see its
// truck under each plan — and pick both trucks with one button. Side by side, the two maps move
// together. Two views: a phone gets one map with a Dispatch | Claude switch; a desktop gets both.
//
// The rules — which truck a stop is on, geometry, colour slots — live in backtest-map-core.js.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapPinned, Search, X } from 'lucide-react';
import { apiFetch } from '../lib/api.js';
import { loadGoogleMaps } from '../lib/google-maps-loader.js';
import {
  SELECT_COLORS, MAX_SELECTED, MUTED, PLAN_LABEL, planGeo, boundsOf, truckRows, stopStory, toggleTruck, pickTrucks,
} from './backtest-map-core.js';

const ENDPOINT = '/.netlify/functions/claude-shadow';
// Quiet base: no business pins or transit lines competing with the freight.
const QUIET = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];
const DEPOT_SQUARE = 'M -6 -6 L 6 -6 L 6 6 L -6 6 Z';

function styleFor(g, sel) {
  const any = sel.size > 0;
  return (f) => {
    const kind = f.getProperty('kind');
    const slot = sel.get(f.getProperty('loadId'));
    const on = slot !== undefined;
    const color = on ? SELECT_COLORS[slot] : MUTED;
    if (kind === 'depot') {
      return { icon: { path: DEPOT_SQUARE, fillColor: '#111827', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2, scale: 1 }, zIndex: 1000, title: 'Buford terminal' };
    }
    if (kind === 'casing') return { strokeColor: '#ffffff', strokeOpacity: on ? 1 : 0, strokeWeight: on ? 7 : 0, zIndex: on ? 90 : 0, clickable: false };
    if (kind === 'route') return { strokeColor: color, strokeOpacity: on ? 0.95 : any ? 0.18 : 0.5, strokeWeight: on ? 4 : 2, zIndex: on ? 100 : 1 };
    return {
      icon: { path: g.maps.SymbolPath.CIRCLE, scale: on ? 5.5 : 3.5, fillColor: color, fillOpacity: on ? 1 : any ? 0.35 : 0.85, strokeColor: '#ffffff', strokeWeight: on ? 1.5 : 1 },
      zIndex: on ? 200 : 10,
      title: `${f.getProperty('label')} — stop ${f.getProperty('seq')}`,
    };
  };
}

function PlanPane({ g, m, plan, sel, onStop, onTruck, register, height, label }) {
  const el = useRef(null);
  const mapRef = useRef(null);
  const handlers = useRef({ onStop, onTruck });
  handlers.current = { onStop, onTruck };
  useEffect(() => {
    if (!g || !m || !el.current) return undefined;
    const map = new g.maps.Map(el.current, {
      mapTypeControl: false, streetViewControl: false, fullscreenControl: true, clickableIcons: false,
      gestureHandling: 'greedy', styles: QUIET,
    });
    const b = boundsOf(m);
    if (b) map.fitBounds(b, 24);
    map.data.addGeoJson(planGeo(m, plan));
    const click = map.data.addListener('click', (e) => {
      const kind = e.feature.getProperty('kind');
      if (kind === 'stop') handlers.current.onStop(e.feature.getProperty('stopId'));
      else if (kind === 'route') handlers.current.onTruck(e.feature.getProperty('loadId'));
    });
    mapRef.current = map;
    register(plan, map);
    return () => { click.remove(); register(plan, null); mapRef.current = null; };
  }, [g, m, plan, register]);
  useEffect(() => { if (mapRef.current) mapRef.current.data.setStyle(styleFor(g, sel)); }, [g, sel, m, plan]);
  return (
    <div className="min-w-0">
      {label && <div className="text-xs font-semibold text-slate-700 mb-1">{label}</div>}
      <div ref={el} style={{ height }} className="w-full rounded-lg border bg-slate-100" aria-label={`${label || PLAN_LABEL[plan]} map`} />
    </div>
  );
}

function StopCard({ story, onPickBoth, onClose }) {
  if (!story) return null;
  const s = story.stop;
  const side = (x) => (x ? `${x.route} · ${x.driver} · stop ${x.seq} of ${x.of}` : '—');
  return (
    <div className="rounded-lg border bg-white p-2 text-xs space-y-1">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-slate-800 truncate">{s.name || s.n}</div>
          <div className="text-slate-500">{[s.city, s.zip].filter(Boolean).join(' ')} · {s.spots} spots · {Number(s.lbs || 0).toLocaleString('en-US')} lb{s.noTractor ? ' · no-tractor' : ''} · #{s.n}</div>
        </div>
        <button onClick={onClose} aria-label="Close the stop" className="rounded-lg border bg-white min-h-[44px] min-w-[44px] inline-flex items-center justify-center shrink-0"><X size={14} /></button>
      </div>
      <div><span className="text-slate-500">Dispatch:</span> {side(story.driven)}</div>
      <div><span className="text-indigo-700">Claude:</span> {side(story.claude)}{story.sameTruck ? ' (same truck)' : ''}</div>
      <button onClick={onPickBoth} className="rounded-lg border border-indigo-200 bg-white px-3 text-indigo-700 font-semibold min-h-[44px]">Show both trucks</button>
    </div>
  );
}

function TruckList({ rows, sel, onToggle, phone }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? rows.filter((r) => `${r.route} ${r.driver}`.toLowerCase().includes(t)) : rows;
  }, [rows, q]);
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 rounded-lg border bg-white px-2 min-h-[44px]">
        <Search size={13} className="text-slate-400 shrink-0" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a truck or driver" className="w-full text-xs outline-none bg-transparent min-h-[40px]" aria-label="Find a truck or driver" />
      </label>
      <div className={`overflow-y-auto ${phone ? 'max-h-[260px]' : 'max-h-[240px] grid grid-cols-2 xl:grid-cols-3 gap-x-2'}`}>
        {shown.map((r) => {
          const slot = sel.get(r.id);
          const on = slot !== undefined;
          return (
            <button key={r.id} onClick={() => onToggle(r.id)} aria-pressed={on}
              className={`w-full text-left flex items-center gap-2 rounded-lg px-2 min-h-[44px] text-xs ${on ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
              <span className="inline-block w-3 h-3 rounded-full shrink-0 border border-white" style={{ background: on ? SELECT_COLORS[slot] : MUTED, opacity: on ? 1 : 0.5 }} />
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-slate-800 truncate block">{r.route}</span>
                <span className="text-[11px] text-slate-500 truncate block">{r.driver} · {r.cls === 'tractor' ? 'tractor' : 'box'}</span>
              </span>
              <span className="text-[11px] text-slate-600 tabular-nums shrink-0">{r.driven} → <b className={r.claude ? 'text-indigo-800' : 'text-slate-400'}>{r.claude || 'unused'}</b></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function BacktestMap({ date, phone }) {
  const [m, setM] = useState(null);
  const [err, setErr] = useState(null);
  const [g, setG] = useState(null);
  const [gErr, setGErr] = useState(null);
  const [mode, setMode] = useState(phone ? 'claude' : 'both');
  const [sel, setSel] = useState(() => new Map());
  const [story, setStory] = useState(null);
  const [note, setNote] = useState(null);
  const maps = useRef({ driven: null, claude: null });
  const [paneTick, setPaneTick] = useState(0);

  useEffect(() => {
    let live = true;
    setM(null); setErr(null);
    apiFetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'backtest-map', date }) })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!live) return;
        if (!r.ok || !j?.ok || !j.map) setErr(j?.error || `HTTP ${r.status}`);
        else setM(j.map);
      })
      .catch((e) => { if (live) setErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [date]);

  useEffect(() => {
    let live = true;
    loadGoogleMaps().then((x) => { if (live) setG(x); }).catch((e) => { if (live) setGErr(String(e?.message || e)); });
    return () => { live = false; };
  }, []);

  const register = useCallback((plan, map) => { maps.current[plan] = map; setPaneTick((t) => t + 1); }, []);

  // SIDE BY SIDE, THE TWO MAPS MOVE TOGETHER: whichever one you move, the other follows.
  useEffect(() => {
    const a = maps.current.driven, b = maps.current.claude;
    if (mode !== 'both' || !a || !b) return undefined;
    let following = false;
    const follow = (from, to) => () => {
      if (following) return;
      const c = from.getCenter(), z = from.getZoom();
      const tc = to.getCenter();
      if (to.getZoom() === z && tc && Math.abs(tc.lat() - c.lat()) < 1e-6 && Math.abs(tc.lng() - c.lng()) < 1e-6) return;
      following = true;
      to.setZoom(z);
      to.setCenter(c);
      following = false;
    };
    const l1 = a.addListener('idle', follow(a, b));
    const l2 = b.addListener('idle', follow(b, a));
    return () => { l1.remove(); l2.remove(); };
  }, [mode, paneTick]);

  const rows = useMemo(() => (m ? truckRows(m) : []), [m]);
  const toggle = useCallback((id) => {
    setSel((s) => {
      const r = toggleTruck(s, id);
      setNote(r.refused ? `Up to ${MAX_SELECTED} trucks at a time — tap one to clear it first.` : null);
      return r.next;
    });
  }, []);
  const onStop = useCallback((stopId) => setStory(m ? stopStory(m, stopId) : null), [m]);
  const pickBoth = useCallback(() => {
    if (!story) return;
    setSel((s) => {
      const r = pickTrucks(s, [story.driven?.loadId, story.claude?.loadId]);
      setNote(r.refused ? `Up to ${MAX_SELECTED} trucks at a time — tap one to clear it first.` : null);
      return r.next;
    });
  }, [story]);

  const problem = err || gErr;
  const Toggle = ({ value, label }) => (
    <button onClick={() => setMode(value)} aria-pressed={mode === value}
      className={`rounded-lg px-3 text-xs font-semibold min-h-[44px] border ${mode === value ? 'bg-indigo-700 text-white border-indigo-700' : 'bg-white text-slate-700'}`}>{label}</button>
  );
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-slate-700 inline-flex items-center gap-1"><MapPinned size={13} /> Map</span>
      {!phone && <Toggle value="both" label="Side by side" />}
      <Toggle value="driven" label="Dispatch" />
      <Toggle value="claude" label="Claude" />
      {sel.size > 0 && <button onClick={() => setSel(new Map())} className="rounded-lg border bg-white px-3 text-xs min-h-[44px]">Clear {sel.size} picked</button>}
    </div>
  );
  const hint = <p className="text-[11px] text-slate-500">Grey is every truck. Tap trucks in the list (up to {MAX_SELECTED}) to colour them on both plans; tap a stop to see its truck under each. Lines run from Buford (black square) in each plan’s stop order; miles on the scorecard are the engine’s estimate, not these lines.</p>;

  if (problem) return <div className="space-y-2">{header}<div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">The map could not load: {problem}</div></div>;
  if (!m || !g) return <div className="space-y-2">{header}<div className="text-xs text-slate-500">Loading the map…</div></div>;

  const height = phone ? 420 : mode === 'both' ? 460 : 540;
  const panes = mode === 'both'
    ? (
      <div className="grid grid-cols-2 gap-2">
        <PlanPane g={g} m={m} plan="driven" sel={sel} onStop={onStop} onTruck={toggle} register={register} height={height} label={PLAN_LABEL.driven} />
        <PlanPane g={g} m={m} plan="claude" sel={sel} onStop={onStop} onTruck={toggle} register={register} height={height} label={PLAN_LABEL.claude} />
      </div>
    )
    : <PlanPane key={mode} g={g} m={m} plan={mode} sel={sel} onStop={onStop} onTruck={toggle} register={register} height={height} label={PLAN_LABEL[mode]} />;

  if (phone) {
    return (
      <div className="space-y-2">
        {header}
        {panes}
        {note && <p className="text-xs text-amber-800">{note}</p>}
        <StopCard story={story} onPickBoth={pickBoth} onClose={() => setStory(null)} />
        <details className="rounded-lg border bg-white px-2" open>
          <summary className="text-xs font-semibold text-slate-700 min-h-[44px] flex items-center cursor-pointer">Trucks ({rows.length}) — dispatch → Claude stops</summary>
          <TruckList rows={rows} sel={sel} onToggle={toggle} phone />
        </details>
        {hint}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {header}
      {panes}
      {note && <p className="text-xs text-amber-800">{note}</p>}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,320px)] gap-3 items-start">
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-1">Trucks ({rows.length}) — stops under dispatch → Claude</div>
          <TruckList rows={rows} sel={sel} onToggle={toggle} />
        </div>
        <div>{story ? <StopCard story={story} onPickBoth={pickBoth} onClose={() => setStory(null)} /> : <p className="text-[11px] text-slate-500">Tap a stop on either map to see where it rode under each plan.</p>}</div>
      </div>
      {hint}
    </div>
  );
}
