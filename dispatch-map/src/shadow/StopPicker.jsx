// StopPicker.jsx — THE MAP IN A DRAWER WHERE A SECTION'S STOPS ARE PICKED (v1.78.0).
//
// Chad, 2026-09-27: "instead of letting you do it all at once i would like the choice to do it in
// sections where i have a map in a drawer and can select the stops i want you to put the stops on."
//
// Every open delivery the plan would read, on one Google map (the reviewed loader, as the other shadow
// maps): tap a stop to pick it or take it off, "Add every stop in view" to take an area, and on a
// desktop, "Box select" to drag a box. A stop already on a load in NuVizz, or placed by the earlier
// section, is drawn but cannot be picked (stop-pick-core.js says which). The picks add up at the top.
// Two views: the whole screen on a phone, a drawer from the right on a desktop. It changes nothing
// anywhere — the picks are only what the next preview and plan will take.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, MapPinned, BoxSelect, ScanSearch, Trash2 } from 'lucide-react';
import { loadGoogleMaps } from '../lib/google-maps-loader.js';
import { pickable, stopState, toggleStop, addInBox, boxFrom, selTotals, boundsOf, pickGeo } from './stop-pick-core.js';

const QUIET = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];
const INDIGO = '#4338ca';
const EARLIER = '#0f766e';
const LEFTOFF = '#b45309';
const int = (v) => (typeof v === 'number' ? Math.round(v).toLocaleString('en-US') : '—');
const one = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1)) : '—');
const btn = (on = false) => `rounded-lg border px-3 text-xs font-semibold min-h-[44px] inline-flex items-center gap-1 ${on ? 'bg-indigo-700 text-white border-indigo-700' : 'bg-white text-slate-700'}`;

function styleFor(g, phone, boxOn, stateOf) {
  return (f) => {
    const st = stateOf(f.getProperty('n'));
    const clickable = !boxOn && (st === 'picked' || st === 'free' || st === 'leftoff');
    const title = f.getProperty('title');
    if (st === 'picked') return { icon: { path: g.maps.SymbolPath.CIRCLE, scale: phone ? 7 : 6, fillColor: INDIGO, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 1.5 }, zIndex: 300, clickable, title };
    if (st === 'earlier') return { icon: { path: g.maps.SymbolPath.CIRCLE, scale: 4, fillColor: EARLIER, fillOpacity: 0.6, strokeColor: '#0f172a', strokeWeight: 1 }, zIndex: 20, clickable: false, title };
    if (st === 'leftoff') return { icon: { path: g.maps.SymbolPath.CIRCLE, scale: phone ? 6.5 : 5.5, fillColor: '#ffffff', fillOpacity: 1, strokeColor: LEFTOFF, strokeWeight: 2.5 }, zIndex: 210, clickable, title };
    if (st === 'onload') return { icon: { path: g.maps.SymbolPath.CIRCLE, scale: 3.5, fillColor: '#94a3b8', fillOpacity: 0.9, strokeColor: '#ffffff', strokeWeight: 0.5 }, zIndex: 10, clickable: false, title };
    return { icon: { path: g.maps.SymbolPath.CIRCLE, scale: phone ? 6.5 : 5.5, fillColor: '#ffffff', fillOpacity: 1, strokeColor: INDIGO, strokeWeight: 2 }, zIndex: 200, clickable, title };
  };
}

/** The one map. Made once per drawer and kept while the plan area is open: a map is a billed load. */
function PickMap({ g, stops, sel, scope, phone, onToggle, boxOn, onBoxDone, frameTick, mapRef, height }) {
  const el = useRef(null);
  const [map, setMap] = useState(null);
  const handlers = useRef({ onToggle, onBoxDone });
  handlers.current = { onToggle, onBoxDone };
  useEffect(() => {
    if (!g || !el.current) return undefined;
    const mp = new g.maps.Map(el.current, {
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false,
      // The drawer is the whole task here: one finger moves the map on a phone (the list and the
      // header around it still scroll the drawer); a desktop keeps the page's wheel with Ctrl.
      gestureHandling: phone ? 'greedy' : 'cooperative', styles: QUIET,
    });
    const click = mp.data.addListener('click', (e) => handlers.current.onToggle(e.feature.getProperty('n')));
    setMap(mp);
    mapRef.current = mp;
    return () => { click.remove(); mapRef.current = null; };
  }, [g, phone, mapRef]);
  // THE STOPS, drawn when they are read — and FRAMED each time a read lands with stops in it, and when
  // "Show them all" is pressed (review: the first read lands after the map is made, and a map framed on
  // nothing has no view at all). Picking redraws the style only, so the view you zoomed to stays.
  const framed = useRef({ stops: null, tick: -1 });
  useEffect(() => {
    if (!map) return;
    const old = [];
    map.data.forEach((f) => old.push(f));
    for (const f of old) map.data.remove(f);
    map.data.addGeoJson(pickGeo(stops));
    if (framed.current.stops === stops && framed.current.tick === frameTick) return;
    const b = boundsOf(stops);
    if (!b) return;
    if (b.north > b.south || b.east > b.west) map.fitBounds(new g.maps.LatLngBounds({ lat: b.south, lng: b.west }, { lat: b.north, lng: b.east }), 24);
    else { map.setCenter({ lat: b.north, lng: b.east }); map.setZoom(12); }
    framed.current = { stops, tick: frameTick };
  }, [map, g, stops, frameTick]);
  // What each stop is — picked, free, on a load, placed earlier — set on the feature, then styled.
  const byN = useMemo(() => new Map((stops || []).map((s) => [s.n, s])), [stops]);
  useEffect(() => {
    if (!map) return;
    const stateOf = (n) => { const s = byN.get(n); return s ? stopState(s, sel, scope) : 'free'; };
    map.data.setStyle(styleFor(g, phone, boxOn, stateOf));
  }, [map, g, byN, sel, scope, phone, boxOn]);
  // BOX SELECT (desktop): with it on, the map does not pan; a drag draws a box, and letting go adds
  // every pickable stop inside it.
  useEffect(() => {
    if (!map) return undefined;
    if (!boxOn) { map.setOptions({ draggable: true, gestureHandling: phone ? 'greedy' : 'cooperative', draggableCursor: null }); return undefined; }
    map.setOptions({ draggable: false, gestureHandling: 'none', draggableCursor: 'crosshair' });
    let start = null, rect = null;
    const at = (e) => (e?.latLng ? { lat: e.latLng.lat(), lng: e.latLng.lng() } : null);
    const down = map.addListener('mousedown', (e) => {
      start = at(e);
      if (!start) return;
      rect = new g.maps.Rectangle({ map, bounds: boxFrom(start, start), clickable: false, strokeColor: INDIGO, strokeWeight: 2, fillColor: INDIGO, fillOpacity: 0.08 });
    });
    const move = map.addListener('mousemove', (e) => { const b = start && boxFrom(start, at(e)); if (rect && b) rect.setBounds(b); });
    const finish = (e) => {
      if (!start) return;
      const b = boxFrom(start, at(e) || start);
      start = null;
      if (rect) { rect.setMap(null); rect = null; }
      if (b) handlers.current.onBoxDone(b);
    };
    const up = map.addListener('mouseup', finish);
    const out = map.addListener('mouseout', finish);
    return () => { down.remove(); move.remove(); up.remove(); out.remove(); if (rect) rect.setMap(null); };
  }, [map, g, boxOn, phone]);
  return <div ref={el} style={{ height }} className="w-full rounded-lg border bg-slate-100" aria-label="Section stops map" />;
}

export default function StopPicker({ open, phone, onClose, board, loading, err, onRetry, sel, setSel, scope, note }) {
  const data = board;
  const drawerRef = useRef(null);
  const mapRef = useRef(null);
  const [made, setMade] = useState(open);
  const [g, setG] = useState(null);
  const [gErr, setGErr] = useState(null);
  const [boxOn, setBoxOn] = useState(false);
  const [frameTick, setFrameTick] = useState(0);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (open) setMade(true); }, [open]);
  // The map is loaded the first time the drawer opens, not before: nothing is billed for a plan of every stop.
  useEffect(() => {
    if (!made) return undefined;
    let live = true;
    loadGoogleMaps().then((x) => { if (live) setG(x); }).catch((e) => { if (live) setGErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [made]);
  // Keyboard focus goes into the drawer when it opens.
  useEffect(() => { if (open) requestAnimationFrame(() => drawerRef.current?.focus({ preventScroll: true })); else setBoxOn(false); }, [open]);

  const stops = data?.stops || [];
  const byN = useMemo(() => new Map(stops.map((s) => [s.n, s])), [stops]);
  const totals = useMemo(() => selTotals(stops, sel), [stops, sel]);
  const onToggle = useCallback((n) => { const s = byN.get(n); if (s) { setSel((cur) => toggleStop(cur, s, scope)); setMsg(null); } }, [byN, setSel, scope]);
  // The count is taken from the picks as they are now, not from inside a state update React runs later.
  const onBoxDone = useCallback((b) => {
    const r = addInBox(sel, stops, b, scope);
    setSel(r.next);
    setMsg(r.added ? `${r.added} stop${r.added === 1 ? '' : 's'} added.` : 'No stop that can be picked is in that area.');
  }, [sel, setSel, stops, scope]);
  const addInView = () => {
    const bb = mapRef.current?.getBounds?.();
    const ne = bb?.getNorthEast?.(), sw = bb?.getSouthWest?.();
    const b = ne && sw ? boxFrom({ lat: Number(ne.lat()), lng: Number(ne.lng()) }, { lat: Number(sw.lat()), lng: Number(sw.lng()) }) : null;
    if (!b) { setMsg('The map has not settled yet — try again in a moment.'); return; }
    onBoxDone(b);
  };
  // A control that takes itself off the screen (Clear, a picked row's X) hands the keyboard to the drawer,
  // so Esc and Tab keep working (review).
  const refocus = () => requestAnimationFrame(() => drawerRef.current?.focus({ preventScroll: true }));
  const clear = () => { setSel(new Set()); setMsg(null); refocus(); };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const root = drawerRef.current;
    const f = root ? [...root.querySelectorAll('button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null) : [];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (e.target === first || e.target === root)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (e.target === last || e.target === root)) { e.preventDefault(); first.focus(); }
  };
  const found = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    return stops.filter((s) => `${s.name || ''} ${s.city || ''} ${s.zip || ''} ${s.n}`.toLowerCase().includes(t)).slice(0, 12);
  }, [q, stops]);
  const picked = useMemo(() => stops.filter((s) => sel.has(s.n)).sort((a, b) => String(a.name || a.n).localeCompare(String(b.name || b.n))), [stops, sel]);
  const c = data?.counts;
  if (!made) return null;

  const stopRow = (s, withToggle) => {
    const can = pickable(s, scope);
    const on = sel.has(s.n);
    return (
      <li key={s.n} className="flex items-center gap-2 border-t first:border-t-0 py-1">
        <span className="min-w-0 flex-1 text-[11px] text-slate-700">
          <b className="text-slate-800">{s.name || s.n}</b>{s.city ? `, ${s.city}` : ''} · {one(s.spots)} spots · {int(s.lbs)} lb{s.noTractor ? ' · no-tractor' : ''}
          {s.onLoad && <span className="text-slate-500"> · on {s.onLoad} in NuVizz</span>}
          {s.earlier && <span className="text-teal-800"> · placed on {s.earlier.route} earlier</span>}
          {s.leftOff && !s.earlier && <span className="text-amber-800"> · left off earlier: {s.leftOff}</span>}
        </span>
        {withToggle && (can
          ? <button onClick={() => onToggle(s.n)} className={btn(on)} aria-pressed={on} aria-label={`${on ? 'Take off' : 'Pick'} ${s.name || s.n}`}>{on ? 'Picked' : 'Pick'}</button>
          : <span className="text-[11px] text-slate-500 shrink-0">cannot be picked</span>)}
        {!withToggle && <button onClick={() => { onToggle(s.n); refocus(); }} aria-label={`Take ${s.name || s.n} off`} className="rounded-lg border bg-white min-h-[44px] min-w-[44px] inline-flex items-center justify-center shrink-0"><X size={14} /></button>}
      </li>
    );
  };

  const legend = (
    <p className="text-[11px] text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full" style={{ background: INDIGO }} /> picked</span>
      <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full border-2 bg-white" style={{ borderColor: INDIGO }} /> can be picked</span>
      {scope !== 'open' && <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-slate-400" /> on a load in NuVizz — stays there (plan every open stop to move it)</span>}
      {c?.placed > 0 && <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: EARLIER, opacity: 0.7 }} /> placed by the earlier section (a proposal — nothing is in NuVizz)</span>}
      {stops.some((s) => s.leftOff) && <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-full border-2 bg-white" style={{ borderColor: LEFTOFF }} /> left off by an earlier section — can be picked again</span>}
    </p>
  );

  return (
    <div className={open ? '' : 'hidden'}>
      <div className={phone ? '' : 'fixed inset-0 z-50 bg-slate-900/25'} onMouseDown={phone ? undefined : (e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div ref={drawerRef} role="dialog" aria-modal="true" aria-label="Pick the stops for this section" tabIndex={-1} data-overlay-layer onKeyDown={onKeyDown}
          className={`fixed z-50 bg-white overflow-y-auto outline-none ${phone ? 'inset-0 px-3 pb-3 space-y-3' : 'inset-y-0 right-0 w-[min(1100px,82vw)] border-l shadow-2xl px-4 pb-4 space-y-3'}`}>
          <div className={`sticky top-0 z-10 bg-white border-b pt-3 pb-2 flex ${phone ? 'flex-col gap-2' : 'items-start justify-between gap-3'}`}>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">This section</div>
              <div className="text-base font-semibold text-slate-900">{sel.size} stop{sel.size === 1 ? '' : 's'} picked</div>
              <div className="text-xs text-slate-700">{data ? `${one(totals.spots)} skid spots · ${int(totals.lbs)} lb${totals.noTractor ? ` · ${totals.noTractor} no-tractor` : ''}` : 'reading the board…'}</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {sel.size > 0 && <button onClick={clear} className={btn()}><Trash2 size={13} /> Clear</button>}
              <button onClick={onClose} aria-label="Done picking stops" className={btn(true)}><X size={14} /> Done</button>
            </div>
          </div>
          {err && <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">The stops could not be read: {err} <button onClick={onRetry} className="underline min-h-[44px]">Try again</button></div>}
          {loading && !data && <p className="text-xs text-slate-500 inline-flex items-center gap-1"><MapPinned size={12} /> Reading the board…</p>}
          {c && <p className="text-[11px] text-slate-600">{int(c.open)} open deliveries on the map{c.onLoad ? `, ${int(c.onLoad)} of them on loads in NuVizz` : ''}{c.placed ? `, ${int(c.placed)} placed by the earlier section` : ''}.{c.noLocation ? ` ${int(c.noLocation)} more on the board have no map point: they are not shown and cannot be picked.` : ''}{data?.truncated ? ` Only the first ${int(stops.length)} are drawn.` : ''}</p>}
          {note && <p className="text-xs text-amber-800" role="status">{note}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={addInView} disabled={!g || !stops.length} className={btn()}><ScanSearch size={13} /> Add every stop in view</button>
            {!phone && <button onClick={() => setBoxOn((b) => !b)} aria-pressed={boxOn} disabled={!g} className={btn(boxOn)}><BoxSelect size={13} /> {boxOn ? 'Box select is on — drag on the map' : 'Box select'}</button>}
            <button onClick={() => setFrameTick((t) => t + 1)} disabled={!g || !stops.length} className={btn()}>Show them all</button>
          </div>
          <div role="status" aria-live="polite">{msg && <p className="text-xs text-slate-700">{msg}</p>}</div>
          {gErr
            ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">The map could not load: {gErr}. Stops can still be found by name below.</div>
            : g ? <PickMap g={g} stops={stops} sel={sel} scope={scope} phone={phone} onToggle={onToggle} boxOn={boxOn} onBoxDone={onBoxDone} frameTick={frameTick} mapRef={mapRef} height={phone ? '52vh' : 'min(540px, 62vh)'} />
              : <p className="text-xs text-slate-500">Loading the map…</p>}
          {legend}
          <p className="text-[11px] text-slate-500">{phone ? 'Tap a stop to pick it or take it off; move the map to an area and add every stop in view.' : 'Click a stop to pick it or take it off; add every stop in view, or turn on Box select and drag a box. Ctrl + scroll zooms.'} Picking changes nothing anywhere — it is only what the preview and the plan will take.</p>
          <div className={phone ? 'space-y-3' : 'grid grid-cols-2 gap-4'}>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-700" htmlFor="section-find">Find a stop by name, city or ZIP</label>
              <input id="section-find" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Uline, Buford, 30518" className="w-full rounded border border-slate-300 px-2 min-h-[44px] text-xs" />
              {q.trim().length >= 2 && (found.length ? <ul>{found.map((s) => stopRow(s, true))}</ul> : <p className="text-[11px] text-slate-500">No open delivery matches.</p>)}
            </div>
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-700">Picked ({picked.length})</div>
              {picked.length ? <ul className="max-h-64 overflow-y-auto">{picked.map((s) => stopRow(s, false))}</ul> : <p className="text-[11px] text-slate-500">Nothing picked yet.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
