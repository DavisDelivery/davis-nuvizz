// BacktestMap.jsx — CLAUDE'S PLAN AND DISPATCH'S, ON A REAL MAP, FOR ONE BACKTESTED DAY.
//
// Chad, 2026-09-25: "I want an interactive map to see Claude's vs my own dispatch" — and, offered a
// plain drawn map or real streets, "Google streets". It loads Google through the one reviewed loader
// the shadow screen may use (lib/google-maps-loader.js), draws the day the shadow's own endpoint
// returned (useBacktestDay, below), and changes nothing: it is a picture of a backtest, not a board.
//
// WHAT YOU DO WITH IT. Colour trucks from the routes table (up to eight at once) and see where that
// driver went under dispatch and where Claude would have sent them. Open a route (v1.73.0, Chad: "a
// way to pull up one route and see the differences on a route by route basis") and both maps zoom to
// that truck, number its stops in each plan's order and colour the trucks it traded with. Tap a stop
// to see its truck under each plan — every order at that address, not just the top marker. Side by
// side, the two maps move together. Two views: a phone gets one map with a Dispatch | Claude switch;
// a desktop gets both, or either one larger.
//
// ONE MAP PER PANE, MADE ONCE. Each new google.maps.Map is a billed map load and starts over at the
// whole day, so switching plans swaps what a pane DRAWS, never the pane: a phone costs one map load
// however often it flips, a desktop two. The maps sit inside a scrolling page, so they take the
// wheel and a one-finger drag only with Ctrl / two fingers ('cooperative') — the page keeps scrolling.
//
// The rules — which truck a stop is on, geometry, colour slots, routes — live in backtest-map-core.js.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MapPinned, X, Route } from 'lucide-react';
import { apiFetch } from '../lib/api.js';
import { loadGoogleMaps } from '../lib/google-maps-loader.js';
import {
  SELECT_COLORS, MUTED, PLAN_LABEL, ORDER_WORD, planGeo, boundsOf, focusBounds, storiesAt, orderNote,
} from './backtest-map-core.js';

const ENDPOINT = '/.netlify/functions/claude-shadow';
// Quiet base: no business pins or transit lines competing with the freight.
const QUIET = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];
const DEPOT_SQUARE = 'M -6 -6 L 6 -6 L 6 6 L -6 6 Z';

/**
 * The day's stored stops, trucks, both plans and every route's numbers (the 'backtest-map' read —
 * Firestore only, 0 NuVizz). It is a read, and reading twice changes nothing — so a server error
 * (seen once on a cold function: HTTP 502, then 200 in 0.7 s on every try after) is asked again
 * once, by itself, before the screen says anything; a second failure says so, and retry() asks again.
 */
export function useBacktestDay(date) {
  const [m, setM] = useState(null);
  const [err, setErr] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setM(null); setErr(null);
    const ask = () => apiFetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'backtest-map', date }) })
      .then(async (r) => ({ r, j: await r.json().catch(() => null) }));
    const pause = () => new Promise((res) => { setTimeout(res, 1500); });
    (async () => {
      let got = null, fail = null;
      for (let i = 0; i < 2; i++) {
        try {
          got = await ask();
          if (got.r.ok && got.j?.ok && got.j.map) { fail = null; break; }
          fail = got.j?.error || `HTTP ${got.r.status}`;
          if (got.r.status < 500) break;       // a 4xx is an answer (no backtest, stops not on file) — do not ask again
        } catch (e) { fail = String(e?.message || e); }
        if (i === 0) await pause();
        if (!live) return;
      }
      if (!live) return;
      if (fail) setErr(fail); else setM(got.j.map);
    })();
    return () => { live = false; };
  }, [date, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { m, err, retry };
}

function styleFor(g, sel, phone, focus) {
  const any = sel.size > 0;
  // A thumb needs a bigger target than a pointer: the phone's stops are drawn larger.
  const r = phone ? { on: 7, off: 5, num: 11 } : { on: 5.5, off: 3.5, num: 10 };
  return (f) => {
    const kind = f.getProperty('kind');
    const loadId = f.getProperty('loadId');
    const slot = sel.get(loadId);
    const on = slot !== undefined;
    const color = on ? SELECT_COLORS[slot] : MUTED;
    if (kind === 'depot') {
      return { icon: { path: DEPOT_SQUARE, fillColor: '#111827', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2, scale: 1 }, zIndex: 1000, title: 'Buford terminal', clickable: false };
    }
    // Lines never take a tap: a missed stop must not silently re-colour a truck. Trucks are picked
    // in the routes table, and every stop's title names its truck.
    const focused = focus && loadId === focus;
    if (kind === 'casing') return { strokeColor: '#ffffff', strokeOpacity: on ? 1 : 0, strokeWeight: on ? (focused ? 9 : 7) : 0, zIndex: on ? (focused ? 190 : 90) : 0, clickable: false };
    if (kind === 'route') return { strokeColor: color, strokeOpacity: on ? 0.95 : any ? 0.18 : 0.5, strokeWeight: on ? (focused ? 5 : 4) : 2, zIndex: on ? (focused ? 195 : 100) : 1, clickable: false };
    if (kind === 'unplanned') {
      // A hollow ring: on no truck at all, and not to be read as a grey (unpicked) one.
      return { icon: { path: g.maps.SymbolPath.CIRCLE, scale: r.on, fillColor: '#ffffff', fillOpacity: 1, strokeColor: '#111827', strokeWeight: 2.5 }, zIndex: 300, title: f.getProperty('title') };
    }
    if (focused) {
      // The opened route: every stop numbered in THIS plan's order, drawn over everything else.
      return {
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: r.num, fillColor: color, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2 },
        label: { text: String(f.getProperty('seq')), color: '#ffffff', fontSize: '11px', fontWeight: '700' },
        zIndex: 400 + Number(f.getProperty('seq') || 0),
        title: f.getProperty('title'),
      };
    }
    return {
      icon: { path: g.maps.SymbolPath.CIRCLE, scale: on ? r.on : r.off, fillColor: color, fillOpacity: on ? 1 : any ? 0.35 : 0.85, strokeColor: '#ffffff', strokeWeight: on ? 1.5 : 1 },
      zIndex: on ? 200 : 10,
      title: f.getProperty('title'),
    };
  };
}

function PlanPane({ g, m, plan, sel, phone, focus, onStop, slot, register, height, label }) {
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
  useEffect(() => { if (map) map.data.setStyle(styleFor(g, sel, phone, focus)); }, [map, g, sel, phone, focus, m, plan]);
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
      <div className="text-slate-500">{[s.city, s.zip].filter(Boolean).join(' ')} · {s.skids ?? '—'} skids · {s.loose ?? '—'} loose · {s.spots} spots · {Number(s.lbs || 0).toLocaleString('en-US')} lb{s.noTractor ? ' · no-tractor' : ''} · #{s.n}</div>
      <div className="flex items-start gap-1.5"><Swatch side={d} sel={sel} /><span><span className="text-slate-500">Dispatch{dWord}:</span> {d ? on(d) : '—'}</span></div>
      <div className="flex items-start gap-1.5">
        {c?.unplanned
          ? <><span className="inline-block w-2.5 h-2.5 rounded-full shrink-0 mt-1 border-2 border-slate-900 bg-white" /><span><span className="text-indigo-700">Claude:</span> <b className="text-rose-700">left unplanned</b>{c.reason ? ` — ${c.reason}` : ''}</span></>
          : <><Swatch side={c} sel={sel} /><span><span className="text-indigo-700">Claude:</span> {c ? on(c) : '—'}{story.sameTruck ? ' (same truck)' : ''}</span></>}
      </div>
    </div>
  );
}

function StopCard({ stories, sel, onPick, onOpenRoute, onClose }) {
  if (!stories?.length) return null;
  const trucks = [...new Set(stories.flatMap((x) => [x.driven?.loadId, x.claude?.loadId]).filter(Boolean))];
  const first = stories[0];
  const opens = [first.driven, first.claude].filter((x) => x?.loadId).filter((x, i, a) => a.findIndex((y) => y.loadId === x.loadId) === i);
  return (
    <div className="rounded-lg border bg-white p-2 text-xs space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] text-slate-500 pt-1">{stories.length > 1 ? `${stories.length} stops at this address` : 'Stop'}</div>
        <button onClick={onClose} aria-label="Close the stop" className="rounded-lg border bg-white min-h-[44px] min-w-[44px] inline-flex items-center justify-center shrink-0"><X size={14} /></button>
      </div>
      {stories.map((x) => <StoryRows key={x.stop.id} story={x} sel={sel} />)}
      <div className="flex flex-wrap gap-2">
        {trucks.length > 0 && <button onClick={() => onPick(trucks)} className="rounded-lg border border-indigo-200 bg-white px-3 text-indigo-700 font-semibold min-h-[44px]">{trucks.length === 1 ? 'Show this truck' : `Show ${trucks.length === 2 ? 'both' : `all ${trucks.length}`} trucks`}</button>}
        {opens.map((x) => <button key={x.loadId} onClick={() => onOpenRoute(x.loadId)} className="rounded-lg border bg-white px-3 text-slate-700 min-h-[44px] inline-flex items-center gap-1"><Route size={12} /> Open {x.route}</button>)}
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

export default function BacktestMap({ m, phone, sel, onPick, onClearPicks, focus, zoomTick = 0, onOpenRoute, note }) {
  const [g, setG] = useState(null);
  const [gErr, setGErr] = useState(null);
  const [mode, setMode] = useState(phone ? 'claude' : 'both');
  const [stories, setStories] = useState(null);
  const maps = useRef({ a: null, b: null });
  const [paneTick, setPaneTick] = useState(0);

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

  // OPENING A ROUTE ZOOMS BOTH MAPS TO THAT TRUCK — its stops under dispatch and under Claude, so
  // the two versions of the route are framed the same way and compared at a glance.
  useEffect(() => {
    if (!focus || !m) return;
    const b = focusBounds(m, focus);
    if (!b) return;
    for (const mp of [maps.current.a, maps.current.b]) if (mp) mp.fitBounds(b, 48);
  }, [focus, zoomTick, m, paneTick]);

  const oddOrder = m ? orderNote(m) : null;
  const onStop = useCallback((stopId) => setStories(m ? storiesAt(m, stopId) : null), [m]);

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-slate-700 inline-flex items-center gap-1"><MapPinned size={13} /> Map</span>
      {!phone && <ModeButton value="both" label="Side by side" mode={mode} setMode={setMode} />}
      <ModeButton value="driven" label="Dispatch" mode={mode} setMode={setMode} />
      <ModeButton value="claude" label="Claude" mode={mode} setMode={setMode} />
      {sel.size > 0 && <button onClick={onClearPicks} className="rounded-lg border bg-white px-3 text-xs min-h-[44px]">Clear {sel.size} coloured</button>}
    </div>
  );
  const hint = <p className="text-[11px] text-slate-500">Grey is every truck. Colour trucks with the dots in the routes list (up to {SELECT_COLORS.length}), or open a route to zoom both maps to it with its stops numbered. Tap a stop to see its truck under each plan. A hollow ring on Claude’s map is a stop Claude left unplanned. Lines run from Buford (black square) in each plan’s stop order; miles are the engine’s estimate, not these lines. Ctrl + scroll (two fingers on a phone) moves the map.</p>;
  const noteLine = <div role="status" aria-live="polite">{note && <p className="text-xs text-amber-800">{note}</p>}</div>;
  const orderLine = oddOrder && <p className="text-[11px] text-slate-600">{oddOrder}</p>;

  if (gErr) return <div className="space-y-2">{header}<div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">The map could not load: {gErr}</div></div>;
  if (!m || !g) return <div className="space-y-2">{header}<div className="text-xs text-slate-500">Loading the map…</div></div>;

  // Fixed slots: pane a always exists; pane b (desktop only) is Claude, shown only side by side.
  const planA = mode === 'both' ? 'driven' : mode;
  const height = phone ? 420 : mode === 'both' ? 460 : 540;
  const paneProps = { g, m, sel, phone, focus, onStop, register, height };
  const card = <StopCard stories={stories} sel={sel} onPick={onPick} onOpenRoute={onOpenRoute} onClose={() => setStories(null)} />;
  return (
    <div className="space-y-2">
      {header}
      {orderLine}
      <div className={!phone && mode === 'both' ? 'grid grid-cols-2 gap-2' : ''}>
        <PlanPane {...paneProps} slot="a" plan={planA} label={PLAN_LABEL[planA]} />
        {!phone && <div className={mode === 'both' ? 'min-w-0' : 'hidden'}><PlanPane {...paneProps} slot="b" plan="claude" label={PLAN_LABEL.claude} /></div>}
      </div>
      {noteLine}
      {stories?.length ? card : !phone && <p className="text-[11px] text-slate-500">Tap a stop on either map to see where it rode under each plan.</p>}
      {hint}
    </div>
  );
}
