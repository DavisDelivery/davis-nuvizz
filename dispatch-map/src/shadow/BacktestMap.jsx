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
import { MapPinned, X, Route, SlidersHorizontal, Layers } from 'lucide-react';
import { apiFetch } from '../lib/api.js';
import { loadGoogleMaps } from '../lib/google-maps-loader.js';
import {
  PLAN_LABEL, ORDER_WORD, planGeo, coreBounds, focusBounds, storiesAt, orderNote,
  colorFor, MAP_FILTER_ROWS, MAP_FILTER_DEFAULTS, mapTypeFor, focusStatus, paneTitle,
} from './backtest-map-core.js';

const ENDPOINT = '/.netlify/functions/claude-shadow';
// Quiet base: no business pins or transit lines competing with the freight.
const QUIET = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];
// "Hide place labels" on the road map: every label off (on satellite it is the map type instead).
const NO_LABELS = [...QUIET, { elementType: 'labels', stylers: [{ visibility: 'off' }] }];
// Ring colours for an opened route's stops that changed hands.
const RING_OFF = '#e34948';   // dispatch's map: Claude took this stop off the truck
const RING_ON = '#008300';    // Claude's map: Claude brought this stop onto the truck
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

function styleFor(g, sel, phone, focus, filters, m, plan, standing) {
  const any = sel.size > 0;
  // A thumb needs a bigger target than a pointer: the phone's stops are drawn larger.
  const r = phone ? { on: 7, off: 5, num: 11, faint: 3.5 } : { on: 5.5, off: 3.5, num: 10, faint: 2.5 };
  return (f) => {
    const kind = f.getProperty('kind');
    const loadId = f.getProperty('loadId');
    const on = sel.get(loadId) !== undefined;
    // With nothing picked every truck wears its own colour; with picks, the picked ones wear the
    // eight and the rest go grey (colorFor). With a route OPEN, everything but that route and the
    // trucks you asked for fades right back.
    const color = colorFor(m, sel, loadId);
    if (kind === 'depot') {
      return { visible: !filters.hideTerminal, icon: { path: DEPOT_SQUARE, fillColor: '#111827', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2, scale: 1 }, zIndex: 1000, title: 'Buford terminal', clickable: false };
    }
    const focused = !!focus && loadId === focus;
    const faded = !!focus && !focused && !on;
    // A line is clickable: click it and its route opens. A picked or opened truck's line always
    // shows; the others only under "Show routes" (sixty coloured lines are a tangle), and faint.
    const lineOn = on || focused || filters.showRoutes;
    if (kind === 'casing') return { visible: lineOn, strokeColor: '#ffffff', strokeOpacity: on || focused ? 1 : 0, strokeWeight: on || focused ? (focused ? 9 : 7) : 0, zIndex: focused ? 190 : on ? 90 : 0, clickable: false };
    if (kind === 'route') return { visible: lineOn, strokeColor: faded ? '#9aa0ab' : color, strokeOpacity: on || focused ? 0.95 : faded || any ? 0.18 : 0.55, strokeWeight: focused ? 5 : on ? 4 : 2, zIndex: focused ? 195 : on ? 100 : 1, clickable: true, title: f.getProperty('title') };
    if (kind === 'unplanned') {
      // A hollow ring: on no truck at all, and not to be read as a grey (unpicked) one.
      return { icon: { path: g.maps.SymbolPath.CIRCLE, scale: r.on, fillColor: '#ffffff', fillOpacity: 1, strokeColor: '#111827', strokeWeight: 2.5 }, zIndex: 300, title: f.getProperty('title') };
    }
    if (filters.unplannedOnly) return { visible: false };
    if (focused) {
      // The opened route: every stop numbered in THIS plan's order, drawn over everything else, and
      // ringed by what happened to it — on dispatch's map, red when Claude took it off this truck
      // (hollow when Claude left it unplanned); on Claude's map, green when Claude brought it here.
      const st = standing?.[plan]?.get(f.getProperty('stopId'));
      const off = plan === 'driven' && (st === 'moved' || st === 'unplanned' || st === 'missing');
      const added = plan === 'claude' && st === 'added';
      const hollow = plan === 'driven' && st === 'unplanned';
      return {
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: r.num, fillColor: hollow ? '#ffffff' : color, fillOpacity: 1, strokeColor: off ? RING_OFF : added ? RING_ON : '#ffffff', strokeWeight: off || added ? 3.5 : 2 },
        label: { text: String(f.getProperty('seq')), color: hollow ? RING_OFF : '#ffffff', fontSize: '11px', fontWeight: '700' },
        zIndex: 400 + Number(f.getProperty('seq') || 0),
        title: f.getProperty('title'),
      };
    }
    if (faded) {
      return { icon: { path: g.maps.SymbolPath.CIRCLE, scale: r.faint, fillColor: '#9aa0ab', fillOpacity: 0.45, strokeColor: '#ffffff', strokeWeight: 0.5 }, zIndex: 5, title: f.getProperty('title') };
    }
    return {
      icon: { path: g.maps.SymbolPath.CIRCLE, scale: on ? r.on : any ? r.off : r.on - 1, fillColor: color, fillOpacity: on ? 1 : any ? 0.35 : 0.9, strokeColor: '#ffffff', strokeWeight: on ? 1.5 : 1 },
      zIndex: on ? 200 : 10,
      title: f.getProperty('title'),
    };
  };
}

function PlanPane({ g, m, plan, sel, phone, focus, onStop, onOpenRoute, slot, register, height, label, filters, standing }) {
  const el = useRef(null);
  const [map, setMap] = useState(null);
  const handlers = useRef({ onStop, onOpenRoute, focus });
  handlers.current = { onStop, onOpenRoute, focus };
  // Made once per pane (see the header): the plan it shows is swapped below, not the map.
  useEffect(() => {
    if (!g || !el.current) return undefined;
    const mp = new g.maps.Map(el.current, {
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false,
      gestureHandling: 'cooperative', styles: QUIET,
    });
    // CLICK A ROUTE AND IT OPENS. A line, or any stop of a truck that is not the opened one, opens that
    // truck's route on both maps; a stop also shows where it rode under each plan.
    const click = mp.data.addListener('click', (e) => {
      const kind = e.feature.getProperty('kind');
      const loadId = e.feature.getProperty('loadId');
      if (kind === 'route') { if (loadId) handlers.current.onOpenRoute(loadId); return; }
      if (kind === 'stop' || kind === 'unplanned') {
        handlers.current.onStop(e.feature.getProperty('stopId'));
        if (kind === 'stop' && loadId && loadId !== handlers.current.focus) handlers.current.onOpenRoute(loadId);
      }
    });
    setMap(mp);
    register(slot, mp);
    return () => { click.remove(); register(slot, null); };
  }, [g, slot, register]);
  // The first drawing frames where the day actually is (coreBounds); drawing the other plan, or
  // taking the stem-out line off, keeps the view you zoomed to.
  const framed = useRef(null);
  useEffect(() => {
    if (!map || !m) return;
    const old = [];
    map.data.forEach((f) => old.push(f));
    for (const f of old) map.data.remove(f);
    map.data.addGeoJson(planGeo(m, plan, { stemOut: !filters.hideStemOut }));
    if (framed.current !== m) {
      const { bounds } = coreBounds(m);
      if (bounds) map.fitBounds(bounds, 24);
      framed.current = m;
    }
  }, [map, m, plan, filters.hideStemOut]);
  useEffect(() => { if (map) map.data.setStyle(styleFor(g, sel, phone, focus, filters, m, plan, standing)); }, [map, g, sel, phone, focus, m, plan, filters, standing]);
  // Satellite and place labels are the map itself: the type (hybrid = satellite with labels) and,
  // on the road map, a style that switches labels off.
  useEffect(() => {
    if (!map) return;
    map.setMapTypeId(mapTypeFor(filters));
    map.setOptions({ styles: filters.hideLabels ? NO_LABELS : QUIET });
  }, [map, filters.satellite, filters.hideLabels]);
  // The title over the map: the plan, and — with a route open — who, and that side's numbers.
  const title = focus ? paneTitle(m, focus, plan) : null;
  return (
    <div className="min-w-0">
      <div className="mb-1 min-h-[34px]">
        <div className={`text-xs font-semibold ${plan === 'claude' ? 'text-indigo-800' : 'text-slate-800'}`}>{label}{title ? `: ${title.who}` : ''}</div>
        {title && <div className="text-[11px] text-slate-600">{title.line}</div>}
      </div>
      <div ref={el} style={{ height }} className="w-full rounded-lg border bg-slate-100" aria-label={`${label || PLAN_LABEL[plan]} map`} />
    </div>
  );
}

function Swatch({ side, sel, m }) {
  const dim = sel.size > 0 && (!side?.loadId || sel.get(side.loadId) === undefined);
  return <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0 mt-1" style={{ background: side?.loadId ? colorFor(m, sel, side.loadId) : '#7b8190', opacity: dim ? 0.5 : 1 }} />;
}

function StoryRows({ story, sel, m }) {
  const s = story.stop;
  const d = story.driven, c = story.claude;
  const on = (x) => `${x.route} · ${x.driver} · stop ${x.seq} of ${x.of}`;
  const dWord = d?.orderSource && d.orderSource !== 'driven' ? ` (${ORDER_WORD[d.orderSource] || d.orderSource})` : '';
  return (
    <div className="space-y-0.5">
      <div className="font-semibold text-slate-800 truncate">{s.name || s.n}</div>
      <div className="text-slate-500">{[s.city, s.zip].filter(Boolean).join(' ')} · {s.skids ?? '—'} skids · {s.loose ?? '—'} loose · {s.spots} spots · {Number(s.lbs || 0).toLocaleString('en-US')} lb{s.noTractor ? ' · no-tractor' : ''} · #{s.n}</div>
      <div className="flex items-start gap-1.5"><Swatch side={d} sel={sel} m={m} /><span><span className="text-slate-500">Dispatch{dWord}:</span> {d ? on(d) : '—'}</span></div>
      <div className="flex items-start gap-1.5">
        {c?.unplanned
          ? <><span className="inline-block w-2.5 h-2.5 rounded-full shrink-0 mt-1 border-2 border-slate-900 bg-white" /><span><span className="text-indigo-700">Claude:</span> <b className="text-rose-700">left unplanned</b>{c.reason ? ` — ${c.reason}` : ''}</span></>
          : <><Swatch side={c} sel={sel} m={m} /><span><span className="text-indigo-700">Claude:</span> {c ? on(c) : '—'}{story.sameTruck ? ' (same truck)' : ''}</span></>}
      </div>
    </div>
  );
}

function StopCard({ stories, sel, m, onPick, onOpenRoute, onClose }) {
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
      {stories.map((x) => <StoryRows key={x.stop.id} story={x} sel={sel} m={m} />)}
      <div className="flex flex-wrap gap-2">
        {trucks.length > 0 && <button onClick={() => onPick(trucks)} className="rounded-lg border border-indigo-200 bg-white px-3 text-indigo-700 font-semibold min-h-[44px]">{trucks.length === 1 ? 'Show this truck' : `Show ${trucks.length === 2 ? 'both' : `all ${trucks.length}`} trucks`}</button>}
        {opens.map((x) => <button key={x.loadId} onClick={() => onOpenRoute(x.loadId)} className="rounded-lg border bg-white px-3 text-slate-700 min-h-[44px] inline-flex items-center gap-1"><Route size={12} /> Open {x.route}</button>)}
      </div>
    </div>
  );
}

function FiltersPanel({ filters, setFilters }) {
  return (
    <div className="rounded-lg border bg-slate-50 p-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
      {MAP_FILTER_ROWS.map(([k, label]) => (
        <label key={k} className="flex items-center justify-between gap-3 min-h-[44px] text-xs text-slate-700 cursor-pointer">
          <span>{label}</span>
          <input type="checkbox" role="switch" aria-checked={filters[k]} checked={filters[k]} onChange={(e) => setFilters({ ...filters, [k]: e.target.checked })} className="h-5 w-5 accent-indigo-700 shrink-0" />
        </label>
      ))}
      <p className="sm:col-span-2 lg:col-span-3 text-[11px] text-slate-500 py-1">Shiplify data is not on this map: the shadow screen reaches only its own endpoint.</p>
    </div>
  );
}

function ModeButton({ value, label, mode, setMode }) {
  return (
    <button onClick={() => setMode(value)} aria-pressed={mode === value}
      className={`rounded-lg px-3 text-xs font-semibold min-h-[44px] border ${mode === value ? 'bg-indigo-700 text-white border-indigo-700' : 'bg-white text-slate-700'}`}>{label}</button>
  );
}

export default function BacktestMap({ m, phone, sel, onPick, onClearPicks, focus, zoomTick = 0, onOpenRoute, onAllRoutes, partners = 0, partnersShown = false, onShowPartners, onHidePartners, note }) {
  const [g, setG] = useState(null);
  const [gErr, setGErr] = useState(null);
  const [mode, setMode] = useState(phone ? 'claude' : 'both');
  const [stories, setStories] = useState(null);
  // The filters last the visit: the shadow screen keeps nothing in the page.
  const [filters, setFilters] = useState({ ...MAP_FILTER_DEFAULTS });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersOn = MAP_FILTER_ROWS.filter(([k]) => filters[k]).length;
  const standing = focus && m ? focusStatus(m, focus) : null;
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
      {focus && <button onClick={onAllRoutes} className="rounded-lg border bg-white px-3 text-xs font-semibold min-h-[44px] inline-flex items-center gap-1"><Layers size={13} /> All routes</button>}
      {focus && partners > 0 && (partnersShown
        ? <button onClick={onHidePartners} className="rounded-lg border border-indigo-200 bg-white px-3 text-xs font-semibold text-indigo-700 min-h-[44px]">Hide the {partners} truck{partners === 1 ? '' : 's'} it traded with</button>
        : <button onClick={onShowPartners} className="rounded-lg border border-indigo-200 bg-white px-3 text-xs font-semibold text-indigo-700 min-h-[44px]">Show the {partners} truck{partners === 1 ? '' : 's'} Claude traded with</button>)}
      {!focus && sel.size > 0 && <button onClick={onClearPicks} className="rounded-lg border bg-white px-3 text-xs min-h-[44px]">Clear {sel.size} picked</button>}
      <button onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} aria-controls="claude-map-filters"
        className={`rounded-lg px-3 text-xs font-semibold min-h-[44px] border inline-flex items-center gap-1 ${filtersOpen || filtersOn ? 'border-indigo-700 text-indigo-700 bg-white' : 'bg-white text-slate-700'}`}>
        <SlidersHorizontal size={13} /> Filters{filtersOn ? ` (${filtersOn} on)` : ''}
      </button>
    </div>
  );
  const outside = m ? coreBounds(m).outside : 0;
  // What the marks mean, for the view that is up — under the maps, always.
  const legend = focus
    ? <p className="text-[11px] text-slate-600"><b>This route only.</b> Numbered dots are its stops in that plan’s order. On Dispatch’s map a <span style={{ color: RING_OFF }} className="font-semibold">red ring</span> is a stop Claude took off this truck (hollow: left unplanned); on Claude’s map a <span style={{ color: RING_ON }} className="font-semibold">green ring</span> is a stop Claude brought here. Faint grey dots are every other truck — click one, or its line, to open that route.</p>
    : <p className="text-[11px] text-slate-600"><b>Every truck in its own colour</b>, the same on both maps. Click any stop or line to open that route; the dot beside each route in the list is its colour. A hollow ring on Claude’s map is a stop left unplanned.</p>;
  const hint = <p className="text-[11px] text-slate-500">Lines run from Buford (black square) in each plan’s stop order; miles are the engine’s estimate, not these lines. Filters: satellite, the terminal marker, unplanned only, place labels, every truck’s line, the stem-out leg. Ctrl + scroll (two fingers on a phone) moves the map.</p>;
  const outsideLine = !focus && outside > 0 && <p className="text-[11px] text-slate-600">The map opens on where the stops are; {outside} stop{outside === 1 ? ' lies' : 's lie'} beyond that view — zoom out to see {outside === 1 ? 'it' : 'them'}.</p>;
  const noteLine = <div role="status" aria-live="polite">{note && <p className="text-xs text-amber-800">{note}</p>}</div>;
  const orderLine = oddOrder && <p className="text-[11px] text-slate-600">{oddOrder}</p>;

  if (gErr) return <div className="space-y-2">{header}<div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">The map could not load: {gErr}</div></div>;
  if (!m || !g) return <div className="space-y-2">{header}<div className="text-xs text-slate-500">Loading the map…</div></div>;

  // Fixed slots: pane a always exists; pane b (desktop only) is Claude, shown only side by side.
  const planA = mode === 'both' ? 'driven' : mode;
  const height = phone ? 420 : mode === 'both' ? 460 : 540;
  const paneProps = { g, m, sel, phone, focus, onStop, onOpenRoute, register, height, filters, standing };
  const card = <StopCard stories={stories} sel={sel} m={m} onPick={onPick} onOpenRoute={onOpenRoute} onClose={() => setStories(null)} />;
  return (
    <div className="space-y-2">
      {header}
      {filtersOpen && <div id="claude-map-filters"><FiltersPanel filters={filters} setFilters={setFilters} /></div>}
      {orderLine}
      {outsideLine}
      <div className={!phone && mode === 'both' ? 'grid grid-cols-2 gap-2' : ''}>
        <PlanPane {...paneProps} slot="a" plan={planA} label={PLAN_LABEL[planA]} />
        {!phone && <div className={mode === 'both' ? 'min-w-0' : 'hidden'}><PlanPane {...paneProps} slot="b" plan="claude" label={PLAN_LABEL.claude} /></div>}
      </div>
      {legend}
      {noteLine}
      {stories?.length ? card : null}
      {hint}
    </div>
  );
}
