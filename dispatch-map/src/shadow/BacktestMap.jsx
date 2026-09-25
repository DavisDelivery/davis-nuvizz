// BacktestMap.jsx — CLAUDE'S PLAN AND DISPATCH'S, ON A REAL MAP, FOR ONE BACKTESTED DAY.
//
// Chad, 2026-09-25: "I want an interactive map to see Claude's vs my own dispatch" — and, offered a
// plain drawn map or real streets, "Google streets". It loads Google through the one reviewed loader
// the shadow screen may use (lib/google-maps-loader.js), reads the day through the shadow's own
// endpoint only, and changes nothing: it is a picture of a backtest, not a board.
//
// WHAT YOU DO WITH IT. Tap a truck in the list to colour it on both maps (up to eight at once) and see
// where that driver went under dispatch and where Claude would have sent them. Tap a stop to see its
// truck under each plan — every order at that address, not just the top marker — and pick their
// trucks with one button. Side by side, the two maps move together. Two views: a phone gets one map
// with a Dispatch | Claude switch; a desktop gets both, or either one larger.
//
// ONE MAP PER PANE, MADE ONCE. Each new google.maps.Map is a billed map load and starts over at the
// whole day, so switching plans swaps what a pane DRAWS, never the pane: a phone costs one map load
// however often it flips, a desktop two. The maps sit inside a scrolling page, so they take the
// wheel and a one-finger drag only with Ctrl / two fingers ('cooperative') — the page keeps scrolling.
//
// The rules — which truck a stop is on, geometry, colour slots — live in backtest-map-core.js.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapPinned, Search, X } from 'lucide-react';
import { apiFetch } from '../lib/api.js';
import { loadGoogleMaps } from '../lib/google-maps-loader.js';
import {
  SELECT_COLORS, MAX_SELECTED, MUTED, PLAN_LABEL, ORDER_WORD, planGeo, boundsOf, truckRows, storiesAt, orderNote, toggleTruck, pickTrucks,
} from './backtest-map-core.js';

const ENDPOINT = '/.netlify/functions/claude-shadow';
// Quiet base: no business pins or transit lines competing with the freight.
const QUIET = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];
const DEPOT_SQUARE = 'M -6 -6 L 6 -6 L 6 6 L -6 6 Z';
const TOO_MANY = `Up to ${MAX_SELECTED} trucks at a time — tap one to clear it first.`;

function styleFor(g, sel, phone) {
  const any = sel.size > 0;
  // A thumb needs a bigger target than a pointer: the phone's stops are drawn larger.
  const r = phone ? { on: 7, off: 5 } : { on: 5.5, off: 3.5 };
  return (f) => {
    const kind = f.getProperty('kind');
    const slot = sel.get(f.getProperty('loadId'));
    const on = slot !== undefined;
    const color = on ? SELECT_COLORS[slot] : MUTED;
    if (kind === 'depot') {
      return { icon: { path: DEPOT_SQUARE, fillColor: '#111827', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2, scale: 1 }, zIndex: 1000, title: 'Buford terminal', clickable: false };
    }
    // Lines never take a tap: a missed stop must not silently re-colour a truck. Trucks are picked
    // in the list, and every stop's title names its truck.
    if (kind === 'casing') return { strokeColor: '#ffffff', strokeOpacity: on ? 1 : 0, strokeWeight: on ? 7 : 0, zIndex: on ? 90 : 0, clickable: false };
    if (kind === 'route') return { strokeColor: color, strokeOpacity: on ? 0.95 : any ? 0.18 : 0.5, strokeWeight: on ? 4 : 2, zIndex: on ? 100 : 1, clickable: false };
    if (kind === 'unplanned') {
      // A hollow ring: on no truck at all, and not to be read as a grey (unpicked) one.
      return { icon: { path: g.maps.SymbolPath.CIRCLE, scale: r.on, fillColor: '#ffffff', fillOpacity: 1, strokeColor: '#111827', strokeWeight: 2.5 }, zIndex: 300, title: f.getProperty('title') };
    }
    return {
      icon: { path: g.maps.SymbolPath.CIRCLE, scale: on ? r.on : r.off, fillColor: color, fillOpacity: on ? 1 : any ? 0.35 : 0.85, strokeColor: '#ffffff', strokeWeight: on ? 1.5 : 1 },
      zIndex: on ? 200 : 10,
      title: f.getProperty('title'),
    };
  };
}

function PlanPane({ g, m, plan, sel, phone, onStop, slot, register, height, label }) {
  const el = useRef(null);
  const [map, setMap] = useState(null);
  const handlers = useRef({ onStop });
  handlers.current = { onStop };
  // Made once per pane (see the header): the plan it shows is swapped below, not the map.
  useEffect(() => {
    if (!g || !el.current) return undefined;
    const mp = new g.maps.Map(el.current, {
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false,
      gestureHandling: 'cooperative', styles: QUIET,
    });
    const click = mp.data.addListener('click', (e) => {
      const kind = e.feature.getProperty('kind');
      if (kind === 'stop' || kind === 'unplanned') handlers.current.onStop(e.feature.getProperty('stopId'));
    });
    setMap(mp);
    register(slot, mp);
    return () => { click.remove(); register(slot, null); };
  }, [g, slot, register]);
  // The first drawing frames the whole day; drawing the other plan keeps the view you zoomed to.
  const framed = useRef(null);
  useEffect(() => {
    if (!map || !m) return;
    const old = [];
    map.data.forEach((f) => old.push(f));
    for (const f of old) map.data.remove(f);
    map.data.addGeoJson(planGeo(m, plan));
    if (framed.current !== m) {
      const b = boundsOf(m);
      if (b) map.fitBounds(b, 24);
      framed.current = m;
    }
  }, [map, m, plan]);
  useEffect(() => { if (map) map.data.setStyle(styleFor(g, sel, phone)); }, [map, g, sel, phone, m, plan]);
  return (
    <div className="min-w-0">
      {label && <div className="text-xs font-semibold text-slate-700 mb-1">{label}</div>}
      <div ref={el} style={{ height }} className="w-full rounded-lg border bg-slate-100" aria-label={`${label || PLAN_LABEL[plan]} map`} />
    </div>
  );
}

function Swatch({ side, sel }) {
  const slot = side?.loadId ? sel.get(side.loadId) : undefined;
  return <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0 mt-1" style={{ background: slot !== undefined ? SELECT_COLORS[slot] : MUTED, opacity: slot !== undefined ? 1 : 0.5 }} />;
}

function StoryRows({ story, sel }) {
  const s = story.stop;
  const d = story.driven, c = story.claude;
  const on = (x) => `${x.route} · ${x.driver} · stop ${x.seq} of ${x.of}`;
  const dWord = d?.orderSource && d.orderSource !== 'driven' ? ` (${ORDER_WORD[d.orderSource] || d.orderSource})` : '';
  return (
    <div className="space-y-0.5">
      <div className="font-semibold text-slate-800 truncate">{s.name || s.n}</div>
      <div className="text-slate-500">{[s.city, s.zip].filter(Boolean).join(' ')} · {s.spots} spots · {Number(s.lbs || 0).toLocaleString('en-US')} lb{s.noTractor ? ' · no-tractor' : ''} · #{s.n}</div>
      <div className="flex items-start gap-1.5"><Swatch side={d} sel={sel} /><span><span className="text-slate-500">Dispatch{dWord}:</span> {d ? on(d) : '—'}</span></div>
      <div className="flex items-start gap-1.5">
        {c?.unplanned
          ? <><span className="inline-block w-2.5 h-2.5 rounded-full shrink-0 mt-1 border-2 border-slate-900 bg-white" /><span><span className="text-indigo-700">Claude:</span> <b className="text-rose-700">left unplanned</b>{c.reason ? ` — ${c.reason}` : ''}</span></>
          : <><Swatch side={c} sel={sel} /><span><span className="text-indigo-700">Claude:</span> {c ? on(c) : '—'}{story.sameTruck ? ' (same truck)' : ''}</span></>}
      </div>
    </div>
  );
}

function StopCard({ stories, sel, onPick, onClose }) {
  if (!stories?.length) return null;
  const trucks = new Set(stories.flatMap((x) => [x.driven?.loadId, x.claude?.loadId]).filter(Boolean));
  return (
    <div className="rounded-lg border bg-white p-2 text-xs space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] text-slate-500 pt-1">{stories.length > 1 ? `${stories.length} stops at this address` : 'Stop'}</div>
        <button onClick={onClose} aria-label="Close the stop" className="rounded-lg border bg-white min-h-[44px] min-w-[44px] inline-flex items-center justify-center shrink-0"><X size={14} /></button>
      </div>
      {stories.map((x) => <StoryRows key={x.stop.id} story={x} sel={sel} />)}
      {trucks.size > 0 && <button onClick={() => onPick([...trucks])} className="rounded-lg border border-indigo-200 bg-white px-3 text-indigo-700 font-semibold min-h-[44px]">{trucks.size === 1 ? 'Show this truck' : `Show ${trucks.size === 2 ? 'both' : `all ${trucks.size}`} trucks`}</button>}
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
          const odd = r.orderSource && r.orderSource !== 'driven' ? ` · ${ORDER_WORD[r.orderSource] || r.orderSource}` : '';
          return (
            <button key={r.id} onClick={() => onToggle(r.id)} aria-pressed={on}
              className={`w-full text-left flex items-center gap-2 rounded-lg px-2 min-h-[44px] text-xs ${on ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
              <span className="inline-block w-3 h-3 rounded-full shrink-0 border border-white" style={{ background: on ? SELECT_COLORS[slot] : MUTED, opacity: on ? 1 : 0.5 }} />
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-slate-800 truncate block">{r.route}</span>
                <span className="text-[11px] text-slate-500 truncate block">{r.driver} · {r.cls === 'tractor' ? 'tractor' : 'box'}{odd}</span>
              </span>
              <span className="text-[11px] text-slate-600 tabular-nums shrink-0">{r.driven} → <b className={r.claude ? 'text-indigo-800' : 'text-slate-400'}>{r.claude || 'unused'}</b></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModeButton({ value, label, mode, setMode }) {
  return (
    <button onClick={() => setMode(value)} aria-pressed={mode === value}
      className={`rounded-lg px-3 text-xs font-semibold min-h-[44px] border ${mode === value ? 'bg-indigo-700 text-white border-indigo-700' : 'bg-white text-slate-700'}`}>{label}</button>
  );
}

export default function BacktestMap({ date, at, phone }) {
  const [m, setM] = useState(null);
  const [err, setErr] = useState(null);
  const [g, setG] = useState(null);
  const [gErr, setGErr] = useState(null);
  const [mode, setMode] = useState(phone ? 'claude' : 'both');
  const [sel, setSel] = useState(() => new Map());
  const [stories, setStories] = useState(null);
  const [note, setNote] = useState(null);
  const maps = useRef({ a: null, b: null });
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

  const register = useCallback((slot, map) => { maps.current[slot] = map; setPaneTick((t) => t + 1); }, []);

  // SIDE BY SIDE, THE TWO MAPS MOVE TOGETHER: whichever one you move, the other follows. A move WE
  // made is remembered on the map it was made on, and that map's own 'idle' is then swallowed — so
  // a follower settling late can never drag the map under your hand back to where it was.
  useEffect(() => {
    const a = maps.current.a, b = maps.current.b;
    if (mode !== 'both' || !a || !b) return undefined;
    const expected = new Map();
    const viewOf = (mp) => { const c = mp.getCenter(); return c ? { lat: c.lat(), lng: c.lng(), z: mp.getZoom() } : null; };
    const same = (v, w) => !!v && !!w && v.z === w.z && Math.abs(v.lat - w.lat) < 1e-6 && Math.abs(v.lng - w.lng) < 1e-6;
    const push = (from, to) => {
      const v = viewOf(from);
      if (!v || same(viewOf(to), v)) return;
      expected.set(to, v);
      to.setZoom(v.z);
      to.setCenter({ lat: v.lat, lng: v.lng });
    };
    const onIdle = (from, to) => () => {
      const e = expected.get(from);
      if (e) { expected.delete(from); if (same(viewOf(from), e)) return; }
      push(from, to);
    };
    push(a, b); // line the right-hand map up with the left as side-by-side begins
    const l1 = a.addListener('idle', onIdle(a, b));
    const l2 = b.addListener('idle', onIdle(b, a));
    return () => { l1.remove(); l2.remove(); };
  }, [mode, paneTick]);

  const rows = useMemo(() => (m ? truckRows(m) : []), [m]);
  const oddOrder = useMemo(() => (m ? orderNote(m) : null), [m]);
  const toggle = useCallback((id) => {
    setSel((s) => {
      const r = toggleTruck(s, id);
      setNote(r.refused ? TOO_MANY : null);
      return r.next;
    });
  }, []);
  const onStop = useCallback((stopId) => setStories(m ? storiesAt(m, stopId) : null), [m]);
  const pick = useCallback((ids) => {
    setSel((s) => {
      const r = pickTrucks(s, ids);
      setNote(r.refused ? TOO_MANY : null);
      return r.next;
    });
  }, []);

  // The scorecard above was read when the day opened; if the day has been backtested again since,
  // this map would draw the NEW run under the OLD numbers. Say so rather than draw a mismatch.
  const stale = !!(m && at && m.at && m.at !== at);
  const problem = err || gErr;
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-slate-700 inline-flex items-center gap-1"><MapPinned size={13} /> Map</span>
      {!phone && <ModeButton value="both" label="Side by side" mode={mode} setMode={setMode} />}
      <ModeButton value="driven" label="Dispatch" mode={mode} setMode={setMode} />
      <ModeButton value="claude" label="Claude" mode={mode} setMode={setMode} />
      {sel.size > 0 && <button onClick={() => setSel(new Map())} className="rounded-lg border bg-white px-3 text-xs min-h-[44px]">Clear {sel.size} picked</button>}
    </div>
  );
  const hint = <p className="text-[11px] text-slate-500">Grey is every truck. Pick trucks in the list (up to {MAX_SELECTED}) to colour them on both plans; tap a stop to see its truck under each. A hollow ring on Claude’s map is a stop Claude left unplanned. Lines run from Buford (black square) in each plan’s stop order; miles on the scorecard are the engine’s estimate, not these lines. Ctrl + scroll (two fingers on a phone) moves the map.</p>;
  const noteLine = <div role="status" aria-live="polite">{note && <p className="text-xs text-amber-800">{note}</p>}</div>;
  const orderLine = oddOrder && <p className="text-[11px] text-slate-600">{oddOrder}</p>;

  if (problem) return <div className="space-y-2">{header}<div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">The map could not load: {problem}</div></div>;
  if (stale) return <div className="space-y-2">{header}<div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">This day was backtested again after you opened it, so the map would not match the numbers below. Close the day and open it again.</div></div>;
  if (!m || !g) return <div className="space-y-2">{header}<div className="text-xs text-slate-500">Loading the map…</div></div>;

  // Fixed slots: pane a always exists; pane b (desktop only) is Claude, shown only side by side.
  const planA = mode === 'both' ? 'driven' : mode;
  const height = phone ? 420 : mode === 'both' ? 460 : 540;
  const paneProps = { g, m, sel, phone, onStop, register, height };
  const panes = (
    <div className={!phone && mode === 'both' ? 'grid grid-cols-2 gap-2' : ''}>
      <PlanPane {...paneProps} slot="a" plan={planA} label={PLAN_LABEL[planA]} />
      {!phone && <div className={mode === 'both' ? 'min-w-0' : 'hidden'}><PlanPane {...paneProps} slot="b" plan="claude" label={PLAN_LABEL.claude} /></div>}
    </div>
  );
  const card = <StopCard stories={stories} sel={sel} onPick={pick} onClose={() => setStories(null)} />;

  if (phone) {
    return (
      <div className="space-y-2">
        {header}
        {orderLine}
        {panes}
        {noteLine}
        {card}
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
      {orderLine}
      {panes}
      {noteLine}
      {stories?.length ? card : <p className="text-[11px] text-slate-500">Tap a stop on either map to see where it rode under each plan.</p>}
      <div>
        <div className="text-xs font-semibold text-slate-700 mb-1">Trucks ({rows.length}) — stops under dispatch → Claude</div>
        <TruckList rows={rows} sel={sel} onToggle={toggle} />
      </div>
      {hint}
    </div>
  );
}
