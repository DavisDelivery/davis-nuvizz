// src/screens/MapScreen.jsx — Leaflet map of all today's stops
// Pins color-coded by status bucket. Route lines grouped by load/driver (one color per load).
// Tap a pin → slide-up stop detail. Tap a route line → load detail.

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  X, RefreshCw, User, ChevronRight, MapPin, Clock, AlertCircle,
  Layers, Truck, Home, Filter, CheckSquare, Square,
} from 'lucide-react';
import { fetchFleetStops, TENANTS } from '../lib/api';
import { fmtTime } from '../lib/normalize';
import { StatusPill, Field } from '../components/UI';

const ROUTE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#f43f5e', '#84cc16', '#6366f1', '#f97316'];

const TILE_URLS = {
  streets: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  // Esri World Imagery — free, no API key. Attribution required by their TOS.
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
};

// Single in-flight promise so concurrent mounts / StrictMode share one CDN fetch.
let leafletLoadPromise = null;
function loadLeafletOnce() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.L && window.L.markerClusterGroup) return Promise.resolve();
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = (async () => {
    // 1. core CSS + JS
    if (!document.querySelector('link[data-leaflet]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
      css.setAttribute('data-leaflet', '1');
      document.head.appendChild(css);
    }
    if (!window.L) {
      await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-leaflet]');
        if (existing) { existing.addEventListener('load', () => resolve()); existing.addEventListener('error', reject); return; }
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
        s.setAttribute('data-leaflet', '1');
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('leaflet script failed'));
        document.head.appendChild(s);
      });
    }
    // 2. markercluster plugin CSS + JS
    if (!document.querySelector('link[data-leaflet-cluster]')) {
      const css1 = document.createElement('link');
      css1.rel = 'stylesheet';
      css1.href = 'https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/MarkerCluster.css';
      css1.setAttribute('data-leaflet-cluster', '1');
      document.head.appendChild(css1);
      const css2 = document.createElement('link');
      css2.rel = 'stylesheet';
      css2.href = 'https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css';
      css2.setAttribute('data-leaflet-cluster', '1');
      document.head.appendChild(css2);
    }
    if (!window.L.markerClusterGroup) {
      await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-leaflet-cluster]');
        if (existing) { existing.addEventListener('load', () => resolve()); existing.addEventListener('error', reject); return; }
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js';
        s.setAttribute('data-leaflet-cluster', '1');
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('markercluster script failed'));
        document.head.appendChild(s);
      });
    }
  })();
  return leafletLoadPromise;
}

// NuVizz status codes → our color buckets (match the rest of the app)
const BUCKET_FOR_STATUS = {
  '10': 'pending', '30': 'pending',
  '40': 'inProgress',
  '50': 'failed',
  '90': 'completed',
};
const BUCKET_COLORS = {
  completed: '#10b981',
  inProgress: '#f59e0b',
  pending: '#64748b',
  failed: '#ef4444',
  cancelled: '#94a3b8',
};
const BUCKET_LABELS = {
  completed: 'Delivered',
  inProgress: 'En Route',
  pending: 'Scheduled',
  failed: 'Exception',
  cancelled: 'Cancelled',
};

function toMapStop(s) {
  const bucket = s.exceptionPresent ? 'failed' : (BUCKET_FOR_STATUS[s.status] || 'pending');
  return {
    ...s,
    nbr: s.stopNbr,
    lat: s.latitude,
    lng: s.longitude,
    bucket,
    status: s.status,
    driverName: s.driver,
    loadNbr: s.loadNbr,
    routeName: s.route,
    fullAddress: [s.addr1, s.city, s.state, s.zip].filter(Boolean).join(', '),
    plannedEta: s.plannedEta,
    confirmedAt: s.confirmedDTTM,
    arrival: s.arrivalDTTM,
    etaCode: s.etaCode,
    hasException: !!s.exceptionPresent,
    seq: null, // filled in per-load below
  };
}

export default function MapScreen({ tenant, viewDate, onOpenStop, onOpenLoad }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [selectedStop, setSelectedStop] = useState(null);
  const [selectedLoad, setSelectedLoad] = useState(null);

  // Filter / display state
  const [basemap, setBasemap] = useState('streets'); // 'streets' | 'satellite'
  const [showRoutes, setShowRoutes] = useState(true);
  const [showStemOut, setShowStemOut] = useState(false);
  const [showTerminals, setShowTerminals] = useState(true);
  const [showClusters, setShowClusters] = useState(true);
  const [dimUnselected, setDimUnselected] = useState(true); // NuVizz's "Show Unselected Routes"
  const [bucketFilter, setBucketFilter] = useState(null);
  const [driverFilter, setDriverFilter] = useState(null);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);

  const [mapReady, setMapReady] = useState(false);
  const [leafletReady, setLeafletReady] = useState(() => typeof window !== 'undefined' && !!(window.L && window.L.markerClusterGroup));

  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const tileLayerRef = useRef(null);
  const overlayRef = useRef(null); // polylines + terminals (non-clustered)
  const markerLayerRef = useRef(null); // either a clusterGroup or a plain layerGroup

  const load = useCallback(async () => {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await fetchFleetStops(tenant, viewDate);
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState({ loading: false, error: e.message, data: null });
    }
  }, [tenant, viewDate]);

  useEffect(() => { load(); }, [load]);

  const { normalizedStops, loadsByNbr, stopsWithCoords, loadColorMap, drivers, terminals } = useMemo(() => {
    if (!state.data) return { normalizedStops: [], loadsByNbr: {}, stopsWithCoords: [], loadColorMap: {}, drivers: [], terminals: [] };
    const ns = (state.data.stops || []).map(toMapStop);

    // Per-load chronological sequence (the cached payload doesn't carry stopSeq).
    const byLoadForSeq = {};
    ns.forEach(s => {
      if (!s.loadNbr) return;
      (byLoadForSeq[s.loadNbr] ||= []).push(s);
    });
    Object.values(byLoadForSeq).forEach(group => {
      group.sort((a, b) => (a.plannedEta || '').localeCompare(b.plannedEta || ''));
      group.forEach((s, i) => { s.seq = i + 1; });
    });

    // Load metadata (from backend if available, else derived from stops)
    const lbn = {};
    (state.data.loads || []).forEach(l => { if (l.nbr) lbn[l.nbr] = l; });
    ns.forEach(s => {
      if (s.loadNbr && !lbn[s.loadNbr]) {
        lbn[s.loadNbr] = { nbr: s.loadNbr, route: s.routeName, driver: s.driverName, origin: null };
      }
    });

    // Stable color per load
    const lcm = {};
    Object.keys(lbn).sort().forEach((nbr, i) => { lcm[nbr] = ROUTE_COLORS[i % ROUTE_COLORS.length]; });

    const withCoords = ns.filter(s => s.lat && s.lng && !isNaN(parseFloat(s.lat)) && !isNaN(parseFloat(s.lng)));
    const driverList = Array.from(new Set(ns.map(s => s.driverName).filter(Boolean))).sort();

    // Dedupe terminals by lat,lng — multiple loads can share one origin.
    const termByKey = {};
    Object.values(lbn).forEach(l => {
      const o = l.origin;
      if (!o || !o.latitude || !o.longitude) return;
      const key = `${o.latitude},${o.longitude}`;
      if (!termByKey[key]) {
        termByKey[key] = {
          name: o.name || 'Terminal',
          addr: [o.addr1, o.city, o.state, o.zip].filter(Boolean).join(', '),
          lat: o.latitude, lng: o.longitude,
          loadNbrs: [],
        };
      }
      termByKey[key].loadNbrs.push(l.nbr);
    });

    return {
      normalizedStops: ns,
      loadsByNbr: lbn,
      stopsWithCoords: withCoords,
      loadColorMap: lcm,
      drivers: driverList,
      terminals: Object.values(termByKey),
    };
  }, [state.data]);

  // Load Leaflet + markercluster from CDN.
  useEffect(() => {
    if (leafletReady) return;
    let cancelled = false;
    loadLeafletOnce()
      .then(() => { if (!cancelled) setLeafletReady(true); })
      .catch(err => { if (!cancelled) setState(s => ({ ...s, error: 'Failed to load map library: ' + err.message })); });
    return () => { cancelled = true; };
  }, [leafletReady]);

  // Attach Leaflet to the container — container is always mounted (no early returns).
  useEffect(() => {
    if (!leafletReady || mapInstanceRef.current || !mapRef.current || !window.L) return;
    const L = window.L;
    const map = L.map(mapRef.current, { zoomControl: false, attributionControl: true }).setView([34.12, -84.00], 9);
    tileLayerRef.current = L.tileLayer(TILE_URLS[basemap], { maxZoom: 19, attribution: basemap === 'satellite' ? 'Esri, Maxar, Earthstar Geographics' : '© OpenStreetMap, © CARTO' }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    mapInstanceRef.current = map;
    overlayRef.current = L.layerGroup().addTo(map);
    markerLayerRef.current = L.markerClusterGroup
      ? L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50, disableClusteringAtZoom: 14 })
      : L.layerGroup();
    map.addLayer(markerLayerRef.current);
    requestAnimationFrame(() => { try { map.invalidateSize(); } catch {} });
    setMapReady(true);
  }, [leafletReady, basemap]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (mapInstanceRef.current) {
      try { mapInstanceRef.current.remove(); } catch {}
      mapInstanceRef.current = null;
      tileLayerRef.current = null;
      overlayRef.current = null;
      markerLayerRef.current = null;
    }
  }, []);

  // Swap tile layer when basemap changes
  useEffect(() => {
    if (!mapInstanceRef.current || !window.L) return;
    const L = window.L;
    if (tileLayerRef.current) {
      try { mapInstanceRef.current.removeLayer(tileLayerRef.current); } catch {}
    }
    tileLayerRef.current = L.tileLayer(TILE_URLS[basemap], {
      maxZoom: 19,
      attribution: basemap === 'satellite' ? 'Esri, Maxar, Earthstar Geographics' : '© OpenStreetMap, © CARTO',
    }).addTo(mapInstanceRef.current);
    // Satellite imagery is dark — bump pin border to stay visible. (No-op: pins re-render below.)
  }, [basemap]);

  // Swap clustering mode when toggle changes
  useEffect(() => {
    if (!mapInstanceRef.current || !window.L) return;
    const L = window.L;
    if (markerLayerRef.current) {
      try { mapInstanceRef.current.removeLayer(markerLayerRef.current); } catch {}
    }
    markerLayerRef.current = showClusters && L.markerClusterGroup
      ? L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50, disableClusteringAtZoom: 14 })
      : L.layerGroup();
    mapInstanceRef.current.addLayer(markerLayerRef.current);
  }, [showClusters]);

  // Render markers + route lines + terminals whenever data, filters, or display toggles change.
  useEffect(() => {
    if (!mapReady || !mapInstanceRef.current || !window.L || !overlayRef.current || !markerLayerRef.current) return;
    const L = window.L;
    const map = mapInstanceRef.current;
    overlayRef.current.clearLayers();
    if (markerLayerRef.current.clearLayers) markerLayerRef.current.clearLayers();

    // Apply bucket filter as a HARD filter; driver filter is hard if dimUnselected=false, else soft.
    const isInDriver = (s) => !driverFilter || s.driverName === driverFilter;
    const visibleByBucket = stopsWithCoords.filter(s => !bucketFilter || s.bucket === bucketFilter);
    const visible = dimUnselected ? visibleByBucket : visibleByBucket.filter(isInDriver);
    if (visible.length === 0) return;

    // Group stops by load for routes + stem-out
    const byLoad = {};
    visible.forEach(s => {
      if (!s.loadNbr) return;
      (byLoad[s.loadNbr] ||= []).push(s);
    });

    const opacityFor = (loadNbr) => {
      if (!driverFilter || !dimUnselected) return 1;
      const sampleStop = byLoad[loadNbr]?.[0];
      return sampleStop && sampleStop.driverName === driverFilter ? 1 : 0.2;
    };

    // Route polylines (clickable → load detail)
    if (showRoutes) {
      Object.entries(byLoad).forEach(([loadNbr, stops]) => {
        const sorted = [...stops].sort((a, b) => (a.seq || 0) - (b.seq || 0));
        const coords = sorted.map(s => [parseFloat(s.lat), parseFloat(s.lng)]);
        if (coords.length < 2) return;
        const op = opacityFor(loadNbr);
        const poly = L.polyline(coords, {
          color: loadColorMap[loadNbr] || '#64748b',
          weight: 3.5, opacity: op * 0.75, dashArray: '6, 8',
        });
        poly.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          const meta = loadsByNbr[loadNbr] || {};
          setSelectedLoad({
            nbr: loadNbr,
            route: meta.route,
            driver: meta.driver,
            driverUserName: meta.driverUserName,
            vehicleType: meta.vehicleType,
            color: loadColorMap[loadNbr],
            stops: sorted,
            origin: meta.origin,
            totalStops: meta.totalStops ?? stops.length,
            delivered: meta.delivered ?? sorted.filter(s => s.bucket === 'completed').length,
            pctComplete: meta.pctComplete,
          });
          setSelectedStop(null);
        });
        poly.addTo(overlayRef.current);
      });
    }

    // Stem-out: terminal → first stop and last stop → terminal (dotted, lighter)
    if (showStemOut) {
      Object.entries(byLoad).forEach(([loadNbr, stops]) => {
        const meta = loadsByNbr[loadNbr];
        const origin = meta?.origin;
        if (!origin || !origin.latitude || !origin.longitude) return;
        const sorted = [...stops].sort((a, b) => (a.seq || 0) - (b.seq || 0));
        const first = sorted[0], last = sorted[sorted.length - 1];
        const op = opacityFor(loadNbr);
        const stemOpts = { color: loadColorMap[loadNbr] || '#64748b', weight: 2, opacity: op * 0.5, dashArray: '2, 6' };
        L.polyline([[parseFloat(origin.latitude), parseFloat(origin.longitude)], [parseFloat(first.lat), parseFloat(first.lng)]], stemOpts).addTo(overlayRef.current);
        if (last !== first) {
          L.polyline([[parseFloat(last.lat), parseFloat(last.lng)], [parseFloat(origin.latitude), parseFloat(origin.longitude)]], stemOpts).addTo(overlayRef.current);
        }
      });
    }

    // Terminal markers
    if (showTerminals) {
      terminals.forEach(t => {
        const iconHtml = `<div style="width:24px;height:24px;border-radius:6px;background:#0f172a;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:white;font-size:13px;">⌂</div>`;
        const icon = L.divIcon({ html: iconHtml, className: 'dn-terminal', iconSize: [24, 24], iconAnchor: [12, 12] });
        const m = L.marker([parseFloat(t.lat), parseFloat(t.lng)], { icon, zIndexOffset: 1000 });
        m.bindTooltip(`<strong>${escapeHtml(t.name)}</strong><br/>${escapeHtml(t.addr)}<br/><span style="color:#64748b">${t.loadNbrs.length} load${t.loadNbrs.length === 1 ? '' : 's'}</span>`, { direction: 'top' });
        m.addTo(overlayRef.current);
      });
    }

    // Stop markers — into clusterGroup or plain group based on showClusters
    visible.forEach(s => {
      const op = opacityFor(s.loadNbr);
      const color = BUCKET_COLORS[s.bucket];
      const iconHtml = `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2.5px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:white;font-size:10px;font-weight:700;opacity:${op};">${s.seq || ''}</div>`;
      const icon = L.divIcon({ html: iconHtml, className: 'dn-pin', iconSize: [22, 22], iconAnchor: [11, 11] });
      const m = L.marker([parseFloat(s.lat), parseFloat(s.lng)], { icon, opacity: op });
      m.on('click', () => { setSelectedStop(s); setSelectedLoad(null); });
      markerLayerRef.current.addLayer(m);
    });

    // Fit bounds to visible stops + terminals
    try {
      const points = visible.map(s => [parseFloat(s.lat), parseFloat(s.lng)]);
      if (showTerminals) terminals.forEach(t => points.push([parseFloat(t.lat), parseFloat(t.lng)]));
      const bounds = L.latLngBounds(points);
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    } catch {}
  }, [mapReady, stopsWithCoords, terminals, loadsByNbr, loadColorMap, showRoutes, showStemOut, showTerminals, showClusters, dimUnselected, bucketFilter, driverFilter]);

  const noCoords = !state.loading && normalizedStops.length > 0 && stopsWithCoords.length === 0;
  const showOverlays = !state.loading && !state.error && normalizedStops.length > 0;
  const visibleStopCount = stopsWithCoords.filter(s => {
    if (bucketFilter && s.bucket !== bucketFilter) return false;
    if (driverFilter && !dimUnselected && s.driverName !== driverFilter) return false;
    return true;
  }).length;

  return (
    <div className="relative h-full w-full">
      <div ref={mapRef} className="absolute inset-0 bg-slate-100" style={{ minHeight: 'calc(100vh - 130px)' }} />

      {(state.loading || !mapReady) && !state.error && (
        <div className="absolute inset-0 z-[450] bg-slate-100/80 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-lg shadow-md px-4 py-3 flex items-center gap-2 text-sm text-slate-700">
            <RefreshCw size={16} className="animate-spin text-slate-500" />
            {state.loading ? 'Loading stops…' : 'Loading map…'}
          </div>
        </div>
      )}

      {state.error && (
        <div className="absolute inset-0 z-[450] bg-slate-100/90 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-md p-4 max-w-sm w-full">
            <div className="flex items-center gap-2 text-red-600 font-semibold mb-2">
              <AlertCircle size={18} /> Map error
            </div>
            <div className="text-sm text-slate-700 mb-3 break-words">{state.error}</div>
            <button onClick={load} className="w-full py-2 bg-slate-900 text-white rounded text-sm font-medium">Retry</button>
          </div>
        </div>
      )}

      {showOverlays && (
        <>
          {/* Legend (top-left) */}
          <div className="absolute top-3 left-3 z-[400] pointer-events-none">
            <div className="bg-white/95 backdrop-blur rounded-lg shadow-md px-3 py-2 pointer-events-auto">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                Stops · {visibleStopCount}
              </div>
              <div className="flex flex-col gap-1">
                {Object.entries(BUCKET_COLORS).map(([bucket, color]) => {
                  const count = normalizedStops.filter(s => s.bucket === bucket).length;
                  if (count === 0) return null;
                  const active = bucketFilter === bucket;
                  return (
                    <button
                      key={bucket}
                      onClick={() => setBucketFilter(active ? null : bucket)}
                      className={`flex items-center gap-1.5 text-[11px] transition ${active ? 'font-bold' : ''}`}
                      style={{ opacity: (!bucketFilter || active) ? 1 : 0.4 }}
                    >
                      <span className="w-3 h-3 rounded-full" style={{ background: color }} />
                      <span>{BUCKET_LABELS[bucket]}</span>
                      <span className="ml-auto text-slate-500">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Filter button (top-right) */}
          <div className="absolute top-3 right-14 z-[400] flex flex-col items-end gap-2">
            <button
              onClick={() => setFilterPanelOpen(o => !o)}
              className={`bg-white/95 backdrop-blur rounded-lg shadow-md px-3 py-2 text-xs font-medium flex items-center gap-1.5 ${filterPanelOpen ? 'text-blue-600' : 'text-slate-700'}`}
            >
              <Filter size={14} /> Filters
              {(driverFilter || bucketFilter) && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
            </button>

            {filterPanelOpen && (
              <FilterPanel
                basemap={basemap} setBasemap={setBasemap}
                showRoutes={showRoutes} setShowRoutes={setShowRoutes}
                showStemOut={showStemOut} setShowStemOut={setShowStemOut}
                showTerminals={showTerminals} setShowTerminals={setShowTerminals}
                showClusters={showClusters} setShowClusters={setShowClusters}
                dimUnselected={dimUnselected} setDimUnselected={setDimUnselected}
                drivers={drivers}
                driverFilter={driverFilter} setDriverFilter={setDriverFilter}
              />
            )}
          </div>

          {noCoords && (
            <div className="absolute bottom-24 left-3 right-3 z-[400] bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900">
              <div className="font-semibold">{normalizedStops.length} stops loaded, but none have lat/lng coordinates.</div>
              <div className="mt-0.5">Stops need geocoded addresses in NuVizz to appear on the map.</div>
            </div>
          )}

          <button onClick={load} className="absolute bottom-24 right-3 z-[400] bg-white rounded-full shadow-lg p-3 text-slate-700">
            <RefreshCw size={18} />
          </button>
        </>
      )}

      {selectedStop && (
        <StopBottomSheet
          stop={selectedStop}
          onClose={() => setSelectedStop(null)}
          onOpenDetails={() => onOpenStop(selectedStop.nbr)}
          loadColor={loadColorMap[selectedStop.loadNbr]}
        />
      )}

      {selectedLoad && (
        <LoadBottomSheet
          load={selectedLoad}
          onClose={() => setSelectedLoad(null)}
          onOpenDetails={() => onOpenLoad && onOpenLoad(selectedLoad.nbr)}
        />
      )}
    </div>
  );
}

function FilterPanel({
  basemap, setBasemap,
  showRoutes, setShowRoutes,
  showStemOut, setShowStemOut,
  showTerminals, setShowTerminals,
  showClusters, setShowClusters,
  dimUnselected, setDimUnselected,
  drivers, driverFilter, setDriverFilter,
}) {
  return (
    <div className="bg-white/95 backdrop-blur rounded-lg shadow-lg p-3 w-60 text-sm pointer-events-auto">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">Basemap</div>
      <div className="grid grid-cols-2 gap-1 mb-3">
        {['streets', 'satellite'].map(b => (
          <button
            key={b}
            onClick={() => setBasemap(b)}
            className={`px-2 py-1.5 rounded text-xs font-medium border ${basemap === b ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200'}`}
          >
            {b === 'streets' ? 'Streets' : 'Satellite'}
          </button>
        ))}
      </div>

      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">Layers</div>
      <div className="flex flex-col gap-0.5 mb-3">
        <Toggle label="Routes" checked={showRoutes} onChange={setShowRoutes} icon={<Truck size={13} />} />
        <Toggle label="Stem out" checked={showStemOut} onChange={setShowStemOut} hint="Terminal ↔ first/last stop" />
        <Toggle label="Terminals" checked={showTerminals} onChange={setShowTerminals} icon={<Home size={13} />} />
        <Toggle label="Cluster pins" checked={showClusters} onChange={setShowClusters} icon={<Layers size={13} />} />
      </div>

      {drivers.length > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">Driver</div>
          <select
            value={driverFilter || ''}
            onChange={e => setDriverFilter(e.target.value || null)}
            className="w-full px-2 py-1.5 rounded text-xs font-medium text-slate-700 border border-slate-200 bg-white mb-2"
          >
            <option value="">All drivers</option>
            {drivers.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          {driverFilter && (
            <Toggle
              label="Show others (dimmed)"
              checked={dimUnselected}
              onChange={setDimUnselected}
              hint="Off = hide unselected drivers"
            />
          )}
        </>
      )}
    </div>
  );
}

function Toggle({ label, checked, onChange, icon, hint }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex items-start gap-2 px-1 py-1 rounded hover:bg-slate-100 text-left"
    >
      <div className="mt-0.5 text-slate-700">
        {checked ? <CheckSquare size={14} className="text-blue-600" /> : <Square size={14} className="text-slate-300" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 text-xs font-medium text-slate-700">
          {icon}
          <span>{label}</span>
        </div>
        {hint && <div className="text-[10px] text-slate-400 leading-tight">{hint}</div>}
      </div>
    </button>
  );
}

function StopBottomSheet({ stop, onClose, onOpenDetails, loadColor }) {
  return (
    <div className="absolute bottom-0 inset-x-0 z-[500] bg-white rounded-t-2xl shadow-2xl border-t" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex items-center justify-center pt-2 pb-1">
        <div className="w-10 h-1 bg-slate-300 rounded-full" />
      </div>
      <div className="px-4 pt-1 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-slate-500">#{stop.seq}</span>
              <span className="font-mono text-xs font-semibold">{stop.nbr}</span>
              <StatusPill status={stop.status} size="xs" />
            </div>
            <div className="text-base font-semibold mt-1 truncate">{stop.name || stop.customerName || '—'}</div>
            <div className="text-xs text-slate-500 truncate">{stop.fullAddress || '—'}</div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 -mt-1">
            <X size={20} />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t">
          <Field label="Type" value={stop.stopType === 'PU' ? 'Pickup' : stop.stopType === 'DO' ? 'Delivery' : (stop.stopType || '—')} />
          <Field label="Planned" value={fmtTime(stop.plannedEta)} />
          <Field label="Arrival" value={fmtTime(stop.arrival)} />
        </div>

        {stop.driverName && (
          <div className="mt-3 flex items-center gap-2 text-xs">
            <div className="w-2 h-2 rounded-full" style={{ background: loadColor || '#64748b' }} />
            <User size={12} className="text-slate-400" />
            <span>{stop.driverName}</span>
            {stop.loadNbr && <span className="text-slate-500">· Load {stop.loadNbr}</span>}
          </div>
        )}

        <button onClick={onOpenDetails} className="w-full mt-3 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-1">
          Open Stop Details <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

function LoadBottomSheet({ load, onClose, onOpenDetails }) {
  const pct = load.pctComplete ?? (load.totalStops ? Math.round((load.delivered / load.totalStops) * 100) : 0);
  return (
    <div className="absolute bottom-0 inset-x-0 z-[500] bg-white rounded-t-2xl shadow-2xl border-t" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex items-center justify-center pt-2 pb-1">
        <div className="w-10 h-1 bg-slate-300 rounded-full" />
      </div>
      <div className="px-4 pt-1 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ background: load.color }} />
              <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Load</span>
              <span className="font-mono text-xs font-semibold">{load.nbr}</span>
            </div>
            <div className="text-base font-semibold mt-1 truncate">{load.route || '—'}</div>
            <div className="text-xs text-slate-500 truncate flex items-center gap-1">
              <User size={11} /> {load.driver || 'Unassigned'}
              {load.vehicleType && <span>· {load.vehicleType}</span>}
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 -mt-1">
            <X size={20} />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t">
          <Field label="Stops" value={load.totalStops} />
          <Field label="Delivered" value={load.delivered} />
          <Field label="Complete" value={`${pct}%`} />
        </div>

        {load.origin && load.origin.name && (
          <div className="mt-3 flex items-start gap-2 text-xs text-slate-600">
            <Home size={12} className="text-slate-400 mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">{load.origin.name}</div>
              <div className="text-slate-500 truncate">{[load.origin.city, load.origin.state].filter(Boolean).join(', ')}</div>
            </div>
          </div>
        )}

        {onOpenDetails && (
          <button onClick={onOpenDetails} className="w-full mt-3 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-1">
            Open Load Details <ChevronRight size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
