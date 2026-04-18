// src/screens/MapScreen.jsx — Leaflet map of all today's stops
// Pins color-coded by status bucket. Route lines grouped by load/driver (one color per load).
// Tap a pin → slide-up detail panel with stop info + "Open Details" CTA.

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Filter, RefreshCw, User, ChevronRight, MapPin, Clock } from 'lucide-react';
import { fetchFleetStops, TENANTS } from '../lib/api';
import { fmtTime } from '../lib/normalize';
import { Loading, ErrorBox, StatusPill, Field } from '../components/UI';

// Distinct colors for load route lines (cycles if more loads than colors)
const ROUTE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#f43f5e', '#84cc16', '#6366f1', '#f97316'];

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

// Bridge the __fleetstops shape into what MapScreen expects
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
    addr1: s.addr1,
    city: s.city,
    state: s.state,
    zip: s.zip,
    fullAddress: [s.addr1, s.city, s.state, s.zip].filter(Boolean).join(', '),
    plannedEta: s.plannedEta,
    confirmedAt: s.confirmedDTTM,
    arrival: s.arrivalDTTM,
    etaCode: s.etaCode,
    hasException: !!s.exceptionPresent,
    // MapScreen uses s.seq for labels — use displaySeq if we ever add one, else the PRO
    seq: null,
  };
}

export default function MapScreen({ tenant, onOpenStop }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [selected, setSelected] = useState(null); // a normalized stop
  const [showRoutes, setShowRoutes] = useState(true);
  const [bucketFilter, setBucketFilter] = useState(null); // null = all
  const [driverFilter, setDriverFilter] = useState(null);
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const layerRef = useRef(null);
  const leafletLoadedRef = useRef(false);

  const load = useCallback(async () => {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await fetchFleetStops(tenant);
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState({ loading: false, error: e.message, data: null });
    }
  }, [tenant]);

  useEffect(() => { load(); }, [load]);

  const { normalizedStops, normalizedLoads, stopsWithCoords, loadColorMap, drivers } = useMemo(() => {
    if (!state.data) return { normalizedStops: [], normalizedLoads: [], stopsWithCoords: [], loadColorMap: {}, drivers: [] };
    const ns = (state.data.stops || []).map(toMapStop);
    // Derive unique loads from stops (since __fleetstops is stop-flat)
    const loadMap = {};
    ns.forEach(s => {
      if (s.loadNbr && !loadMap[s.loadNbr]) {
        loadMap[s.loadNbr] = { nbr: s.loadNbr, routeName: s.routeName, driverName: s.driverName };
      }
    });
    const nl = Object.values(loadMap);

    // Assign a distinct color to each load (stable by loadNbr)
    const lcm = {};
    nl.forEach((l, i) => { lcm[l.nbr] = ROUTE_COLORS[i % ROUTE_COLORS.length]; });

    const withCoords = ns.filter(s => s.lat && s.lng && !isNaN(parseFloat(s.lat)) && !isNaN(parseFloat(s.lng)));
    const driverList = Array.from(new Set(ns.map(s => s.driverName).filter(Boolean))).sort();

    return { normalizedStops: ns, normalizedLoads: nl, stopsWithCoords: withCoords, loadColorMap: lcm, drivers: driverList };
  }, [state.data]);

  // Load Leaflet from CDN (once)
  useEffect(() => {
    if (leafletLoadedRef.current || typeof window === 'undefined') return;

    const loadLeaflet = async () => {
      if (window.L) { leafletLoadedRef.current = true; initMap(); return; }
      // CSS
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      // JS
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      leafletLoadedRef.current = true;
      initMap();
    };
    loadLeaflet();
  }, []);

  const initMap = useCallback(() => {
    if (!mapRef.current || mapInstanceRef.current || !window.L) return;
    const L = window.L;
    // Default view = Buford, GA (Davis HQ)
    const map = L.map(mapRef.current, { zoomControl: false, attributionControl: false }).setView([34.12, -84.00], 9);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    mapInstanceRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
  }, []);

  // Render markers + route lines whenever data or filters change
  useEffect(() => {
    if (!mapInstanceRef.current || !window.L || !layerRef.current) return;
    const L = window.L;
    const map = mapInstanceRef.current;
    layerRef.current.clearLayers();

    // Filter
    const stopsToShow = stopsWithCoords.filter(s => {
      if (bucketFilter && s.bucket !== bucketFilter) return false;
      if (driverFilter && s.driverName !== driverFilter) return false;
      return true;
    });

    if (stopsToShow.length === 0) return;

    // Route lines — connect stops in sequence per load
    if (showRoutes) {
      const byLoad = {};
      stopsToShow.forEach(s => {
        if (!s.loadNbr) return;
        if (!byLoad[s.loadNbr]) byLoad[s.loadNbr] = [];
        byLoad[s.loadNbr].push(s);
      });
      Object.entries(byLoad).forEach(([loadNbr, stops]) => {
        const sorted = [...stops].sort((a, b) => (a.seq || 0) - (b.seq || 0));
        const coords = sorted.map(s => [parseFloat(s.lat), parseFloat(s.lng)]);
        if (coords.length > 1) {
          L.polyline(coords, {
            color: loadColorMap[loadNbr] || '#64748b',
            weight: 2.5, opacity: 0.6, dashArray: '6, 8'
          }).addTo(layerRef.current);
        }
      });
    }

    // Markers
    stopsToShow.forEach(s => {
      const color = BUCKET_COLORS[s.bucket];
      const iconHtml = `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:2.5px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:white;font-size:10px;font-weight:700;">${s.seq || ''}</div>`;
      const icon = L.divIcon({ html: iconHtml, className: 'dn-pin', iconSize: [22, 22], iconAnchor: [11, 11] });
      const m = L.marker([parseFloat(s.lat), parseFloat(s.lng)], { icon });
      m.on('click', () => setSelected(s));
      m.addTo(layerRef.current);
    });

    // Fit to bounds
    try {
      const bounds = L.latLngBounds(stopsToShow.map(s => [parseFloat(s.lat), parseFloat(s.lng)]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    } catch {}
  }, [stopsWithCoords, showRoutes, bucketFilter, driverFilter, loadColorMap]);

  if (state.loading) return <Loading msg="Loading map..." />;
  if (state.error) return <ErrorBox error={state.error} onRetry={load} />;

  const noCoords = normalizedStops.length > 0 && stopsWithCoords.length === 0;

  return (
    <div className="relative h-full w-full">
      {/* Map container */}
      <div ref={mapRef} className="absolute inset-0 bg-slate-100" style={{ minHeight: 'calc(100vh - 130px)' }} />

      {/* Top overlay - legend + filters */}
      <div className="absolute top-3 left-3 right-3 z-[400] pointer-events-none flex items-start justify-between gap-2">
        <div className="bg-white/95 backdrop-blur rounded-lg shadow-md px-3 py-2 pointer-events-auto">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Stops</div>
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

        <div className="flex flex-col gap-2 pointer-events-auto">
          <button
            onClick={() => setShowRoutes(!showRoutes)}
            className={`bg-white/95 backdrop-blur rounded-lg shadow-md px-3 py-2 text-xs font-medium ${showRoutes ? 'text-blue-600' : 'text-slate-500'}`}
          >
            Routes {showRoutes ? 'ON' : 'OFF'}
          </button>
          {drivers.length > 0 && (
            <select
              value={driverFilter || ''}
              onChange={e => setDriverFilter(e.target.value || null)}
              className="bg-white/95 backdrop-blur rounded-lg shadow-md px-2 py-2 text-xs font-medium text-slate-700 max-w-[150px]"
            >
              <option value="">All drivers</option>
              {drivers.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* No-coords banner */}
      {noCoords && (
        <div className="absolute bottom-24 left-3 right-3 z-[400] bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900">
          <div className="font-semibold">{normalizedStops.length} stops loaded, but none have lat/lng coordinates.</div>
          <div className="mt-0.5">Stops need geocoded addresses in NuVizz to appear on the map.</div>
        </div>
      )}

      {/* Bottom refresh button */}
      <button onClick={load} className="absolute bottom-24 right-3 z-[400] bg-white rounded-full shadow-lg p-3 text-slate-700">
        <RefreshCw size={18} />
      </button>

      {/* Stop detail bottom sheet */}
      {selected && (
        <StopBottomSheet
          stop={selected}
          onClose={() => setSelected(null)}
          onOpenDetails={() => onOpenStop(selected.nbr)}
          loadColor={loadColorMap[selected.loadNbr]}
        />
      )}
    </div>
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
          <Field label="Type" value={stop.type === 'PU' ? 'Pickup' : stop.type === 'DO' ? 'Delivery' : stop.type} />
          <Field label="Planned" value={fmtTime(stop.plannedEta || stop.plannedFrom)} />
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
          Open Details <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
