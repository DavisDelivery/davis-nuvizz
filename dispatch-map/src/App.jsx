// Dispatch Map — Davis Delivery Service
// Single-file React app per build brief. Helpers (firebase init, match-key normalizer)
// live in src/lib/ since they're pure utilities, not React.
//
// Milestones live here:
//   M1: read-only map fed by /.netlify/functions/nuvizz-pull-today-stops
//   M2: customer_notes Firestore layer + edit form + colored markers + filter panel
//   M3: diagnostics page (STUB ONLY — see <DiagnosticsScreen/>)
//   M4: live Motive driver overlay (toggle)
//   M5: route polylines — not implemented this session, see HANDOFF.md

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Loader as GoogleMapsLoader } from '@googlemaps/js-api-loader';
import { MarkerClusterer } from '@googlemaps/markerclusterer';
import {
  MapPin, RefreshCw, X, Filter, Truck, Save, Plus, Trash2,
  Activity, ChevronDown, ChevronUp, Eye, EyeOff,
  Search, Tag, Tags, ArrowLeft, Gauge, Clock, MapPinned,
} from 'lucide-react';
import {
  collection, doc, getDoc, onSnapshot, setDoc, serverTimestamp,
} from 'firebase/firestore';

import { db } from './lib/firebase.js';
import { normalizeMatchKey } from './lib/matchKey.js';
import { haversineMiles, naiveEtaMinutes, formatEtaClockTime } from './lib/distance.js';

// ---------- constants ----------

const APP_VERSION = '0.4.0';

// No auth — see firebase.js. customer_notes writes are stamped with this
// hardcoded identity until we wire up a real per-user signal (out of scope
// for v0.3.0; Glory Bound Dispatch / MarginIQ don't track this either).
const NOTES_UPDATED_BY = 'dispatcher';
// eslint-disable-next-line no-undef
const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
// eslint-disable-next-line no-undef
const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';

const BUFORD = { lat: 33.9719, lng: -84.0008 };
const BRAND = '#1e5b92';

const FLAG_COLORS = {
  red: '#dc2626',
  yellow: '#eab308',
  green: '#16a34a',
};
const RESTRICTION_TINT = '#7c3aed';        // has restriction notes but no priority flag
const UNFLAGGED_TINT = '#1e5b92';          // no notes at all — brand blue
const DRIVER_TINT = '#0f172a';             // M4 Motive driver pins

const EQUIPMENT_OPTIONS = [
  { value: 'no_tractor_trailer', label: 'No tractor trailer' },
  { value: '26ft_max', label: '26ft max' },
  { value: 'no_53ft', label: 'No 53ft' },
  { value: 'box_truck_only', label: 'Box truck only' },
  { value: 'no_overhead_clearance', label: 'Low overhead clearance' },
];

const DOCK_TYPES = [
  { value: 'dock_high', label: 'Dock high' },
  { value: 'ground', label: 'Ground level' },
  { value: 'either', label: 'Either works' },
];

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const MOCK_MODE = import.meta.env.VITE_USE_MOCK_NUVIZZ === 'true';
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// M4.1 localStorage keys + sizing constants for the resizable left panel.
const LS_PANEL_WIDTH = 'dispatchMap.leftPanelWidth';
const LS_DRIVER_LABELS = 'dispatchMap.driverLabelsVisible';
const LS_SEARCH_HISTORY = 'dispatchMap.searchHistory';
const PANEL_DEFAULT_WIDTH = 320;
const PANEL_MIN_WIDTH = 240;
// Max width is computed at runtime as 60% of viewport — see useResizablePanel.
const MOBILE_BREAKPOINT = 768;

// ---------- hooks ----------

// Sortable hook + matching <SortableTh/> — column sort state for any table.
// Click toggles asc → desc → null. Returns sorted array + UI helpers.
function useSortable(rows, defaultKey = null, defaultDir = 'asc') {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState(defaultDir);

  const toggle = useCallback((key) => {
    setSortKey((prevKey) => {
      if (prevKey !== key) { setSortDir('asc'); return key; }
      // same key: asc → desc → clear
      setSortDir((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'));
      return key;
    });
  }, []);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a?.[sortKey], bv = b?.[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    });
    if (sortDir === 'desc') copy.reverse();
    return copy;
  }, [rows, sortKey, sortDir]);

  return { sorted, sortKey, sortDir, toggle };
}

function SortableTh({ label, k, sortKey, sortDir, onToggle, className = '' }) {
  const active = sortKey === k;
  return (
    <th
      onClick={() => onToggle(k)}
      className={`px-2 py-1 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 cursor-pointer select-none hover:bg-slate-100 ${className}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : null}
      </span>
    </th>
  );
}

// Lazy-load Google Maps JS API. Returns google namespace once loaded.
function useGoogleMaps() {
  const [google, setGoogle] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!MAPS_KEY) {
      setError('VITE_GOOGLE_MAPS_API_KEY is not set');
      return;
    }
    let cancelled = false;
    const loader = new GoogleMapsLoader({ apiKey: MAPS_KEY, version: 'weekly' });
    loader.load().then((g) => {
      if (!cancelled) setGoogle(g);
    }).catch((e) => {
      if (!cancelled) setError(e.message || String(e));
    });
    return () => { cancelled = true; };
  }, []);
  return { google, error };
}

// Pull today's stops from the proxy function.
function useStops() {
  const [stops, setStops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [source, setSource] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = '/.netlify/functions/nuvizz-pull-today-stops' + (MOCK_MODE ? '?mock=1' : '');
      const resp = await fetch(url);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      // Attach the match key now so every consumer downstream can hit it.
      const decorated = (data.stops || []).map((s) => ({
        ...s,
        matchKey: normalizeMatchKey(s.businessName || '', s.addr1 || '', s.city || '', s.zip || ''),
      }));
      setStops(decorated);
      setSource(data.source || 'nuvizz');
      setLastRefreshed(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { stops, loading, error, lastRefreshed, source, refresh };
}

// Subscribe to ALL customer_notes docs and expose as a Map<match_key, note>.
// Two-step: live subscribe so edits in another tab/dispatcher appear instantly.
function useCustomerNotes() {
  const [notes, setNotes] = useState(new Map());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!db) { setReady(true); return; }
    const unsub = onSnapshot(collection(db, 'customer_notes'), (snap) => {
      const next = new Map();
      snap.forEach((d) => next.set(d.id, { id: d.id, ...d.data() }));
      setNotes(next);
      setReady(true);
    }, (err) => {
      console.error('customer_notes snapshot error', err);
      setReady(true);
    });
    return unsub;
  }, []);
  return { notes, ready };
}

// --- M4.1 hooks ---

function safeReadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ }
}

// Track viewport width so we can disable resize and switch the panel to a
// drawer on mobile. Cheap — one resize listener.
function useViewportWidth() {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

// Left-panel width with mouse-drag handler. Caller spreads handleProps onto
// the drag strip and reads width for the panel. Width is clamped to
// [PANEL_MIN_WIDTH, 60vw] on every change so URL/localStorage tampering can't
// hide the map.
function useResizablePanel(viewportWidth) {
  const maxWidth = Math.max(PANEL_MIN_WIDTH + 50, Math.round(viewportWidth * 0.6));
  const clamp = useCallback((px) => Math.max(PANEL_MIN_WIDTH, Math.min(maxWidth, px)), [maxWidth]);

  const [width, setWidthState] = useState(() => {
    const stored = safeReadJSON(LS_PANEL_WIDTH, null);
    const initial = typeof stored === 'number' ? stored : PANEL_DEFAULT_WIDTH;
    return Math.max(PANEL_MIN_WIDTH, Math.min(initial, Math.round((typeof window === 'undefined' ? 1280 : window.innerWidth) * 0.6)));
  });

  // Re-clamp whenever the max drops (window narrowed).
  useEffect(() => {
    setWidthState((w) => Math.min(w, maxWidth));
  }, [maxWidth]);

  const isDraggingRef = useRef(false);
  const lastWriteRef = useRef(width);

  const setWidth = useCallback((next) => {
    const clamped = clamp(next);
    setWidthState(clamped);
  }, [clamp]);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    let raf = null;
    const onMove = (ev) => {
      if (raf) return; // ~1 frame debounce
      raf = requestAnimationFrame(() => {
        raf = null;
        const next = ev.clientX;
        setWidth(next);
      });
    };
    const onUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (raf) cancelAnimationFrame(raf);
      // Persist on release only — no localStorage thrash mid-drag.
      const w = clamp(lastWriteRef.current);
      safeWriteJSON(LS_PANEL_WIDTH, w);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [clamp, setWidth]);

  const onDoubleClick = useCallback(() => {
    setWidth(PANEL_DEFAULT_WIDTH);
    safeWriteJSON(LS_PANEL_WIDTH, PANEL_DEFAULT_WIDTH);
  }, [setWidth]);

  // Track latest width for the on-release localStorage write.
  useEffect(() => { lastWriteRef.current = width; }, [width]);

  return { width, setWidth, onMouseDown, onDoubleClick, maxWidth, isDragging: isDraggingRef };
}

// Debounce any value. Used by the search bar (200ms) so we don't re-filter on
// every keystroke.
function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

// Search state + history. The query itself is local to the bar; history is a
// 5-deep list of recent committed searches kept in localStorage.
function useSearchHistory() {
  const [history, setHistory] = useState(() => {
    const arr = safeReadJSON(LS_SEARCH_HISTORY, []);
    return Array.isArray(arr) ? arr.slice(0, 5) : [];
  });
  const remember = useCallback((q) => {
    const trimmed = (q || '').trim();
    if (!trimmed) return;
    setHistory((prev) => {
      const dedup = [trimmed, ...prev.filter((x) => x.toLowerCase() !== trimmed.toLowerCase())].slice(0, 5);
      safeWriteJSON(LS_SEARCH_HISTORY, dedup);
      return dedup;
    });
  }, []);
  const clear = useCallback(() => {
    setHistory([]);
    safeWriteJSON(LS_SEARCH_HISTORY, []);
  }, []);
  return { history, remember, clear };
}

// Per-driver day-snapshot fetch with 30s in-memory cache keyed by truck number.
// Snapshot shape is whatever /nuvizz-driver-route returns (NuVizz endpoint
// discovery happens in nuvizz-debug-driver-routes.mts — until then this returns
// a "no route assigned" stub so the rest of the UI keeps working).
const __snapshotCache = new Map(); // truck# -> { storedAt, data }
const SNAPSHOT_TTL_MS = 30 * 1000;

function useDriverSnapshot(driver) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!driver) { setSnapshot(null); setError(null); return; }
    const key = driver.vehicleNumber || `id:${driver.vehicleId}`;
    const cached = __snapshotCache.get(key);
    if (cached && Date.now() - cached.storedAt < SNAPSHOT_TTL_MS) {
      setSnapshot(cached.data);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSnapshot(null);
    setError(null);
    (async () => {
      try {
        const url = `/.netlify/functions/nuvizz-driver-route?truck=${encodeURIComponent(driver.vehicleNumber || '')}&driver=${encodeURIComponent(driver.driverName || '')}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (cancelled) return;
        if (!data || data.ok === false) {
          setError(data?.error || `HTTP ${resp.status}`);
          // Still set a minimal snapshot so the UI shows telemetry sections.
          const minimal = { route: null, stops: [], hos: null, dailyMiles: null };
          __snapshotCache.set(key, { storedAt: Date.now(), data: minimal });
          setSnapshot(minimal);
        } else {
          __snapshotCache.set(key, { storedAt: Date.now(), data });
          setSnapshot(data);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message);
          const minimal = { route: null, stops: [], hos: null, dailyMiles: null };
          setSnapshot(minimal);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [driver?.vehicleId, driver?.vehicleNumber]);

  return { snapshot, loading, error };
}

// M4: poll Motive every 60s while enabled.
function useDriverPositions(enabled) {
  const [drivers, setDrivers] = useState([]);
  const [error, setError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const resp = await fetch('/.netlify/functions/motive-driver-positions');
        const data = await resp.json();
        if (cancelled) return;
        if (data.ok) {
          setDrivers(data.drivers || []);
          setError(null);
          setLastRefreshed(new Date());
        } else {
          setError(data.error || `HTTP ${resp.status}`);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };
    pull();
    const id = setInterval(pull, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);
  return { drivers, error, lastRefreshed };
}

// ---------- helpers ----------

function flagColor(note) {
  if (note?.priority_flag && FLAG_COLORS[note.priority_flag]) return FLAG_COLORS[note.priority_flag];
  if (note && (note.equipment_restrictions?.length || note.liftgate_required || note.appointment_required)) {
    return RESTRICTION_TINT;
  }
  return UNFLAGGED_TINT;
}

function pinSvg(color) {
  // Compact map pin in the given color. data: URI works as a Marker icon src.
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 1c-7 0-13 5.4-13 12 0 9 13 22 13 22s13-13 13-22c0-6.6-6-12-13-12z"
        fill="${color}" stroke="white" stroke-width="2"/>
      <circle cx="14" cy="13" r="4.5" fill="white"/>
    </svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

function truckSvg(color) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
      <circle cx="20" cy="20" r="18" fill="${color}" stroke="white" stroke-width="2"/>
      <path d="M9 22h13v-7H9zM22 18h5l3 4v3h-8z" fill="white"/>
      <circle cx="13" cy="27" r="2.5" fill="${color}" stroke="white" stroke-width="1"/>
      <circle cx="26" cy="27" r="2.5" fill="${color}" stroke="white" stroke-width="1"/>
    </svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

function fmtTimeAgo(d) {
  if (!d) return '—';
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

// Empty/default note template — used when opening a stop that has no Firestore doc yet.
function emptyNote(stop) {
  return {
    raw_name: stop.businessName || '',
    raw_address: [stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', '),
    match_key: stop.matchKey,
    receiving_hours: { mon: '', tue: '', wed: '', thu: '', fri: '', sat: '', sun: '' },
    appointment_required: false,
    appointment_notes: '',
    equipment_restrictions: [],
    liftgate_required: false,
    dock_type: null,
    contacts: [],
    dock_notes: '',
    priority_flag: null,
    photo_urls: [],
    pro_history: [],
  };
}

// Append today's PRO to pro_history if not already the most-recent entry.
// Returns a new history array (max 20, FIFO). Pure — caller writes if changed.
function bumpProHistory(existing, pro) {
  const arr = Array.isArray(existing) ? existing : [];
  const today = todayYmd();
  const last = arr[arr.length - 1];
  if (last && last.pro === pro && last.date === today) return arr;
  const next = [...arr, { pro, date: today }];
  return next.slice(-20);
}

// M4.1 — case-insensitive contains-match across business name, PRO,
// address1, city, ZIP, and either of the customer-notes prose fields.
// Returns true for empty queries (no filter applied).
function stopMatchesSearch(stop, note, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const fields = [
    stop.businessName,
    stop.pro,
    stop.addr1,
    stop.city,
    stop.zip,
    note?.dock_notes,
    note?.appointment_notes,
  ];
  for (const f of fields) {
    if (f && String(f).toLowerCase().includes(needle)) return true;
  }
  return false;
}

// ---------- components ----------

// 6-px visible bar centered in a 12-px hit area. The wider hit zone makes the
// handle easier to grab; the visible bar is the affordance the dispatcher sees.
function ResizeHandle({ onMouseDown, onDoubleClick }) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  return (
    <div
      onMouseDown={(e) => { setActive(true); onMouseDown(e); const up = () => { setActive(false); document.removeEventListener('mouseup', up); }; document.addEventListener('mouseup', up); }}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex-shrink-0 cursor-col-resize select-none"
      style={{
        width: 12,
        marginLeft: -3,
        marginRight: -3,
        zIndex: 5,
        position: 'relative',
        background: 'transparent',
      }}
      title="Drag to resize. Double-click to reset."
    >
      <div
        className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2"
        style={{
          width: 6,
          background: active
            ? `rgba(30,91,146,0.30)`
            : hover
            ? 'rgba(148,163,184,0.25)'
            : 'transparent',
          transition: 'background 80ms linear',
        }}
      />
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-0.5 pointer-events-none"
        aria-hidden
      >
        <span className="block w-0.5 h-0.5 rounded-full bg-slate-400" />
        <span className="block w-0.5 h-0.5 rounded-full bg-slate-400" />
        <span className="block w-0.5 h-0.5 rounded-full bg-slate-400" />
      </div>
    </div>
  );
}

// SearchBar — controlled input + recent-history dropdown. Owns its own draft
// string; commits to parent (via onChange) immediately so the parent can
// debounce + filter. onSubmit is called when Enter is pressed (used to commit
// to localStorage history).
function SearchBar({ value, onChange, onSubmit, history, inputRef, resultCount, totalCount }) {
  const [focused, setFocused] = useState(false);
  const showHistory = focused && !value && history.length > 0;
  return (
    <div className="px-3 pt-3 pb-1 relative">
      <div className="relative">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { onSubmit(value); e.currentTarget.blur(); }
            if (e.key === 'Escape') { onChange(''); e.currentTarget.blur(); }
          }}
          placeholder="Search customer, PRO, city, address..."
          className="w-full border border-slate-300 rounded pl-7 pr-7 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
          aria-label="Search stops"
        />
        {value && (
          <button
            onClick={() => onChange('')}
            className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700"
            aria-label="Clear search"
            tabIndex={-1}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {value && (
        <div className="mt-1 text-[10px] text-slate-500">
          {resultCount > 0
            ? <>Showing <span className="font-semibold text-slate-700">{resultCount}</span> of {totalCount} stops</>
            : <>No stops match "<span className="font-semibold">{value}</span>"</>
          }
        </div>
      )}
      {showHistory && (
        <div className="absolute left-3 right-3 top-full mt-1 bg-white border border-slate-200 rounded shadow-md z-10 max-h-56 overflow-y-auto">
          <div className="px-2 py-1 text-[9px] uppercase tracking-wide text-slate-400 border-b">Recent searches</div>
          {history.map((h, i) => (
            <button
              key={i}
              onMouseDown={(e) => { e.preventDefault(); onChange(h); onSubmit(h); }}
              className="block w-full text-left px-2 py-1 text-xs hover:bg-blue-50"
            >
              {h}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPanel({ filters, setFilters, counts }) {
  const F = filters;
  return (
    <div className="p-3 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="font-semibold flex items-center gap-2"><Filter size={14} /> Filters</div>
        <button
          onClick={() => setFilters({})}
          className="text-xs text-slate-500 hover:text-slate-800"
        >
          Reset
        </button>
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-600 mb-1">Priority flag</div>
        <div className="flex flex-wrap gap-1.5">
          {['red', 'yellow', 'green', 'none'].map((v) => {
            const active = (F.flag || []).includes(v);
            const swatch = v === 'none' ? '#cbd5e1' : FLAG_COLORS[v];
            return (
              <button
                key={v}
                onClick={() => {
                  const cur = F.flag || [];
                  const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
                  setFilters({ ...F, flag: next.length ? next : undefined });
                }}
                className={`px-2 py-0.5 rounded-full text-[11px] border flex items-center gap-1 ${active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300 text-slate-700'}`}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: swatch }} />
                {v}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Toggle
          label="Appointment required"
          checked={!!F.apptRequired}
          onChange={(b) => setFilters({ ...F, apptRequired: b || undefined })}
        />
        <Toggle
          label="Liftgate required"
          checked={!!F.liftgate}
          onChange={(b) => setFilters({ ...F, liftgate: b || undefined })}
        />
        <Toggle
          label="Has any restriction"
          checked={!!F.hasRestriction}
          onChange={(b) => setFilters({ ...F, hasRestriction: b || undefined })}
        />
        <Toggle
          label="Unflagged only (no notes)"
          checked={!!F.unflagged}
          onChange={(b) => setFilters({ ...F, unflagged: b || undefined })}
        />
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-600 mb-1">Equipment restriction</div>
        <select
          value={F.equipment || ''}
          onChange={(e) => setFilters({ ...F, equipment: e.target.value || undefined })}
          className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
        >
          <option value="">Any</option>
          {EQUIPMENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      <div className="text-xs text-slate-500 pt-2 border-t">
        Showing <span className="font-semibold text-slate-800">{counts.visible}</span> of {counts.total} stops
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-slate-300"
      />
      <span className="text-xs text-slate-700">{label}</span>
    </label>
  );
}

function applyFilters(stops, notesByKey, filters) {
  return stops.filter((s) => {
    const n = notesByKey.get(s.matchKey);
    if (filters.unflagged && n) return false;
    if (filters.flag && filters.flag.length) {
      const f = n?.priority_flag || 'none';
      if (!filters.flag.includes(f)) return false;
    }
    if (filters.apptRequired && !n?.appointment_required) return false;
    if (filters.liftgate && !n?.liftgate_required) return false;
    if (filters.hasRestriction) {
      const has = !!(n && (
        n.equipment_restrictions?.length || n.liftgate_required || n.appointment_required || n.priority_flag
      ));
      if (!has) return false;
    }
    if (filters.equipment) {
      if (!n?.equipment_restrictions?.includes(filters.equipment)) return false;
    }
    return true;
  });
}

// Right-side sidebar showing stop + metadata + edit form.
function StopSidebar({ stop, note, onClose, onSave, saving, saveError }) {
  const [draft, setDraft] = useState(() => note || emptyNote(stop));
  const [editing, setEditing] = useState(!note);
  useEffect(() => {
    setDraft(note || emptyNote(stop));
    setEditing(!note);
  }, [stop?.stopNbr, note?.id]);

  if (!stop) return null;
  const D = draft;
  const setD = (patch) => setDraft({ ...D, ...patch });
  const setHours = (day, v) => setD({ receiving_hours: { ...D.receiving_hours, [day]: v } });
  const toggleRestriction = (val) => {
    const cur = D.equipment_restrictions || [];
    const next = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val];
    setD({ equipment_restrictions: next });
  };
  const addContact = () => setD({ contacts: [...(D.contacts || []), { name: '', phone: '', role: '' }] });
  const setContact = (i, patch) => {
    const next = [...(D.contacts || [])];
    next[i] = { ...next[i], ...patch };
    setD({ contacts: next });
  };
  const removeContact = (i) => setD({ contacts: (D.contacts || []).filter((_, idx) => idx !== i) });

  return (
    <aside className="w-[380px] flex-shrink-0 bg-white border-l shadow-lg flex flex-col h-full overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center justify-between" style={{ background: BRAND, color: 'white' }}>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider opacity-75">PRO {stop.pro || '—'}</div>
          <div className="font-bold truncate">{stop.businessName || '(no name)'}</div>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-white/20 rounded"><X size={20} /></button>
      </div>

      <div className="overflow-y-auto flex-1">
        {/* Raw stop data section */}
        <div className="px-4 py-3 border-b text-sm space-y-1">
          <div>
            <div className="text-xs uppercase font-semibold text-slate-500">Address</div>
            <div>{stop.addr1}</div>
            {stop.addr2 && (
              <div className="text-xs px-2 py-1 mt-1 bg-amber-50 border border-amber-200 rounded text-amber-900">
                <span className="font-semibold">addr2:</span> {stop.addr2}
              </div>
            )}
            <div className="text-slate-600">{stop.city}, {stop.state} {stop.zip}</div>
          </div>
          <div className="grid grid-cols-2 gap-3 pt-2">
            <div>
              <div className="text-xs uppercase font-semibold text-slate-500">Window</div>
              <div className="text-sm">{stop.scheduledFrom || '—'} – {stop.scheduledTo || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase font-semibold text-slate-500">Items</div>
              <div className="text-sm">{stop.itemsSummary}</div>
            </div>
          </div>
          {stop.driverName && (
            <div className="pt-2 text-xs text-slate-500">
              Load <span className="font-mono">{stop.loadNbr}</span> · {stop.driverName}
            </div>
          )}
        </div>

        {/* Metadata / edit form */}
        <div className="px-4 py-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase font-semibold text-slate-500">Customer notes</div>
            {note && !editing && (
              <button onClick={() => setEditing(true)} className="text-xs text-blue-600 hover:underline">Edit</button>
            )}
          </div>

          {!editing && !note && (
            <div className="text-xs text-slate-500 italic">No notes yet. Click Edit to add.</div>
          )}

          {editing && (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-xs font-semibold text-slate-600 mb-1">Priority flag</div>
                <div className="flex gap-1.5">
                  {[null, 'red', 'yellow', 'green'].map((v) => {
                    const active = D.priority_flag === v;
                    const swatch = v ? FLAG_COLORS[v] : '#e2e8f0';
                    return (
                      <button
                        key={String(v)}
                        onClick={() => setD({ priority_flag: v })}
                        className={`px-2 py-1 rounded border text-xs flex items-center gap-1 ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
                      >
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: swatch }} />
                        {v || 'none'}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-600 mb-1">Receiving hours</div>
                <div className="grid grid-cols-7 gap-1">
                  {DAYS.map((d) => (
                    <div key={d}>
                      <div className="text-[10px] uppercase text-slate-500 text-center">{d}</div>
                      <input
                        value={D.receiving_hours?.[d] || ''}
                        onChange={(e) => setHours(d, e.target.value)}
                        placeholder="—"
                        className="w-full border border-slate-300 rounded px-1 py-1 text-[11px] text-center"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Toggle label="Appointment required" checked={!!D.appointment_required} onChange={(b) => setD({ appointment_required: b })} />
                <Toggle label="Liftgate required" checked={!!D.liftgate_required} onChange={(b) => setD({ liftgate_required: b })} />
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-600 mb-1">Appointment notes</div>
                <input
                  value={D.appointment_notes || ''}
                  onChange={(e) => setD({ appointment_notes: e.target.value })}
                  className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
                />
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-600 mb-1">Equipment restrictions</div>
                <div className="flex flex-wrap gap-1.5">
                  {EQUIPMENT_OPTIONS.map((o) => {
                    const active = (D.equipment_restrictions || []).includes(o.value);
                    return (
                      <button
                        key={o.value}
                        onClick={() => toggleRestriction(o.value)}
                        className={`px-2 py-0.5 rounded-full text-[11px] border ${active ? 'bg-purple-600 text-white border-purple-600' : 'bg-white border-slate-300 text-slate-700'}`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-600 mb-1">Dock type</div>
                <div className="flex gap-1.5">
                  {[...DOCK_TYPES, { value: null, label: 'unknown' }].map((o) => {
                    const active = (D.dock_type ?? null) === o.value;
                    return (
                      <button
                        key={String(o.value)}
                        onClick={() => setD({ dock_type: o.value })}
                        className={`px-2 py-1 rounded border text-xs ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-600 mb-1">Dock notes</div>
                <textarea
                  value={D.dock_notes || ''}
                  onChange={(e) => setD({ dock_notes: e.target.value })}
                  rows={3}
                  className="w-full border border-slate-300 rounded px-2 py-1 text-xs"
                />
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-600 mb-1 flex items-center justify-between">
                  <span>Contacts</span>
                  <button onClick={addContact} className="text-xs text-blue-600 inline-flex items-center gap-0.5 hover:underline">
                    <Plus size={11} /> add
                  </button>
                </div>
                <div className="space-y-1.5">
                  {(D.contacts || []).map((c, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1 items-center">
                      <input value={c.name || ''} onChange={(e) => setContact(i, { name: e.target.value })} placeholder="Name" className="border border-slate-300 rounded px-1.5 py-1 text-xs" />
                      <input value={c.phone || ''} onChange={(e) => setContact(i, { phone: e.target.value })} placeholder="Phone" className="border border-slate-300 rounded px-1.5 py-1 text-xs" />
                      <input value={c.role || ''} onChange={(e) => setContact(i, { role: e.target.value })} placeholder="Role" className="border border-slate-300 rounded px-1.5 py-1 text-xs" />
                      <button onClick={() => removeContact(i)} className="text-slate-400 hover:text-red-600"><Trash2 size={14} /></button>
                    </div>
                  ))}
                  {(!D.contacts || !D.contacts.length) && <div className="text-xs text-slate-400 italic">none</div>}
                </div>
              </div>
            </div>
          )}

          {!editing && note && (
            <ReadOnlyNoteView note={note} />
          )}

          {note?.pro_history?.length > 0 && (
            <div className="pt-2 border-t">
              <div className="text-xs font-semibold text-slate-600 mb-1">Recent PROs at this customer</div>
              <div className="flex flex-wrap gap-1">
                {[...note.pro_history].reverse().slice(0, 10).map((h, i) => (
                  <span key={i} className="text-[10px] bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">
                    {h.pro} · {h.date}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div className="border-t px-4 py-2 flex items-center justify-between gap-2 bg-slate-50">
          {saveError && <span className="text-xs text-red-600 truncate">{saveError}</span>}
          <div className="ml-auto flex gap-2">
            {note && (
              <button onClick={() => { setDraft(note); setEditing(false); }} className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200 rounded">
                Cancel
              </button>
            )}
            <button
              onClick={() => onSave(D)}
              disabled={saving}
              className="px-3 py-1.5 text-xs text-white font-semibold rounded inline-flex items-center gap-1 disabled:opacity-50"
              style={{ background: BRAND }}
            >
              {saving ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
              Save
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

// ---------- M4.1 driver day-snapshot sidebar ----------

function fmtClockShort(ts) {
  if (!ts) return null;
  try {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return null; }
}

function fmtDurationHm(secs) {
  if (secs == null) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function classifyTimeliness(scheduledIso, actualIso) {
  if (!scheduledIso || !actualIso) return null;
  const sched = new Date(scheduledIso).getTime();
  const act = new Date(actualIso).getTime();
  if (Number.isNaN(sched) || Number.isNaN(act)) return null;
  const deltaMin = Math.round((act - sched) / 60000);
  let kind = 'ontime';
  if (deltaMin > 15) kind = 'late';
  else if (deltaMin < -15) kind = 'early';
  return { deltaMin, kind };
}

function StopStatusIcon({ status }) {
  if (status === 'completed') return <span style={{ color: '#16a34a' }}>✓</span>;
  if (status === 'en_route' || status === 'current')
    return <span style={{ color: '#1e5b92' }} className="inline-block animate-pulse">▶</span>;
  return <span style={{ color: '#94a3b8' }}>○</span>;
}

function DriverSnapshotSidebar({ driver, snapshot, loading, error, onClose, onPanToStop }) {
  if (!driver) return null;
  const truckLabel = driver.vehicleNumber || `(truck ${driver.vehicleId || '?'})`;
  const driverName = driver.driverName || '(no driver)';
  const route = snapshot?.route || null;
  const stops = Array.isArray(snapshot?.stops) ? snapshot.stops : [];
  const hos = snapshot?.hos || null;

  const nextStop = useMemo(() => {
    if (!stops.length) return null;
    return stops.find((s) => s.status !== 'completed') || null;
  }, [stops]);

  const eta = useMemo(() => {
    if (!nextStop || nextStop.lat == null || nextStop.lng == null) return null;
    if (driver.lat == null || driver.lng == null) return null;
    const mins = naiveEtaMinutes(
      { lat: driver.lat, lng: driver.lng },
      { lat: nextStop.lat, lng: nextStop.lng },
    );
    return { minutes: mins, clock: formatEtaClockTime(mins) };
  }, [driver?.lat, driver?.lng, nextStop?.lat, nextStop?.lng]);

  const onTimePct = useMemo(() => {
    const completed = stops.filter((s) => s.status === 'completed');
    if (!completed.length) return null;
    const onTime = completed.filter((s) => {
      const t = classifyTimeliness(s.scheduledTime, s.actualArrival || s.actualCompletion);
      return t?.kind === 'ontime' || t?.kind === 'early';
    }).length;
    return { onTime, total: completed.length, pct: Math.round((onTime / completed.length) * 100) };
  }, [stops]);

  return (
    <aside className="w-[380px] flex-shrink-0 bg-white border-l shadow-lg flex flex-col h-full overflow-hidden">
      <div className="px-4 py-3 border-b" style={{ background: BRAND, color: 'white' }}>
        <button
          onClick={onClose}
          className="text-[10px] uppercase tracking-wider opacity-75 hover:opacity-100 inline-flex items-center gap-1 mb-1"
        >
          <ArrowLeft size={11} /> Back to stops
        </button>
        <div className="font-bold">Truck {truckLabel} · {driverName}</div>
        {hos && (
          <div className="text-[11px] opacity-80 mt-0.5">
            {hos.loggedInAt && <>Logged in {fmtClockShort(hos.loggedInAt)}</>}
            {hos.loggedInAt && hos.onDutySeconds != null && ' · '}
            {hos.onDutySeconds != null && <>{fmtDurationHm(hos.onDutySeconds)} on duty</>}
          </div>
        )}
      </div>

      <div className="overflow-y-auto flex-1 text-sm">
        {loading && <SnapshotSkeleton />}

        {error && !loading && (
          <div className="m-3 px-3 py-2 text-xs bg-amber-50 border border-amber-200 rounded text-amber-900">
            {error}
          </div>
        )}

        {!loading && (
          <>
            <SnapshotSection title="Route Summary">
              {route ? (
                <>
                  <div className="font-semibold text-slate-900">
                    Route {route.id || '—'} · {route.totalStops ?? stops.length} stops today
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    Completed: <span className="font-semibold text-slate-900">{route.completed ?? stops.filter((s) => s.status === 'completed').length}</span>
                    {'   '}Remaining: <span className="font-semibold text-slate-900">{route.remaining ?? stops.filter((s) => s.status !== 'completed').length}</span>
                  </div>
                </>
              ) : (
                <div className="text-xs italic text-slate-500">No route assigned today</div>
              )}

              {nextStop && (
                <div className="mt-2 pt-2 border-t">
                  <div className="text-[10px] uppercase font-semibold text-slate-500">Next stop</div>
                  <div className="text-sm font-semibold text-slate-900">{nextStop.businessName || nextStop.name || '—'}</div>
                  <div className="text-xs text-slate-600">
                    {[nextStop.addr1, nextStop.city, nextStop.state].filter(Boolean).join(', ') || '—'}
                  </div>
                  {eta?.minutes != null && (
                    <div className="text-xs text-slate-700 mt-0.5">
                      ETA: <span className="font-semibold">{eta.clock}</span>
                      {eta.minutes != null && <> ({Math.round(eta.minutes)} min away)</>}
                    </div>
                  )}
                </div>
              )}
            </SnapshotSection>

            <SnapshotSection title="Today's Stops">
              {stops.length === 0 ? (
                <div className="text-xs italic text-slate-500">No stops loaded</div>
              ) : (
                <ul className="space-y-0.5">
                  {stops.map((s, i) => {
                    const timeliness = classifyTimeliness(s.scheduledTime, s.actualArrival || s.actualCompletion);
                    const late = timeliness?.kind === 'late';
                    const isClickable = s.lat != null && s.lng != null && onPanToStop;
                    return (
                      <li
                        key={s.pro || s.stopNbr || i}
                        onClick={isClickable ? () => onPanToStop(s) : undefined}
                        className={`flex items-center gap-2 text-xs px-1 py-0.5 rounded ${isClickable ? 'cursor-pointer hover:bg-blue-50' : ''}`}
                      >
                        <span className="w-3 text-center"><StopStatusIcon status={s.status} /></span>
                        <span className="w-12 font-mono text-[10px] text-slate-500">{fmtClockShort(s.scheduledTime) || '—'}</span>
                        <span className="flex-1 truncate">{s.businessName || s.name || s.pro || '—'}</span>
                        <span className="text-[10px] text-slate-500">
                          {s.status === 'completed' && timeliness && (
                            timeliness.kind === 'ontime'
                              ? <span className="text-emerald-600">on-time</span>
                              : timeliness.kind === 'early'
                              ? <span className="text-slate-500">{Math.abs(timeliness.deltaMin)} min early</span>
                              : <span className="text-red-600">{timeliness.deltaMin} min late ⚠</span>
                          )}
                          {(s.status === 'en_route' || s.status === 'current') && <span className="text-blue-700">en route</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SnapshotSection>

            <SnapshotSection title="Live Telemetry">
              <div className="grid grid-cols-[16px_1fr] gap-x-2 gap-y-1 items-center text-xs">
                <Gauge size={12} className="text-slate-400" />
                <div>Speed: <span className="font-semibold">{driver.speedMph != null ? `${Math.round(driver.speedMph)} mph` : '—'}</span></div>
                <Clock size={12} className="text-slate-400" />
                <div>
                  Last ping: <span className="font-semibold">{fmtClockShort(driver.locatedAt) || '—'}</span>
                  {driver.locatedAt && <span className="text-slate-500"> ({fmtTimeAgo(new Date(driver.locatedAt))})</span>}
                </div>
                <MapPinned size={12} className="text-slate-400" />
                <div className="truncate" title={driver.address || ''}>
                  Location: <span className="font-semibold">{driver.address || '—'}</span>
                </div>
              </div>
            </SnapshotSection>

            <SnapshotSection title="Performance Today">
              <div className="text-xs space-y-1">
                <div>
                  On-time stops:{' '}
                  {onTimePct
                    ? <span className="font-semibold">{onTimePct.onTime} of {onTimePct.total} ({onTimePct.pct}%)</span>
                    : <span className="text-slate-500">—</span>
                  }
                </div>
                <div>Avg dwell: <span className="text-slate-500">—</span></div>
                <div>
                  Miles driven:{' '}
                  {snapshot?.dailyMiles != null
                    ? <span className="font-semibold">{Number(snapshot.dailyMiles).toFixed(1)}</span>
                    : <span className="text-slate-500">—</span>}
                </div>
              </div>
            </SnapshotSection>
          </>
        )}
      </div>
    </aside>
  );
}

function SnapshotSection({ title, children }) {
  return (
    <section className="px-4 py-3 border-b">
      <div className="text-[10px] uppercase font-semibold text-slate-500 tracking-wide mb-1.5">{title}</div>
      {children}
    </section>
  );
}

function SnapshotSkeleton() {
  return (
    <div className="p-4 space-y-3">
      <div className="h-3 bg-slate-200 rounded w-3/4 animate-pulse" />
      <div className="h-3 bg-slate-200 rounded w-1/2 animate-pulse" />
      <div className="h-3 bg-slate-200 rounded w-2/3 animate-pulse" />
      <div className="h-3 bg-slate-200 rounded w-1/3 animate-pulse" />
    </div>
  );
}

function ReadOnlyNoteView({ note }) {
  const items = [];
  if (note.priority_flag) items.push({ k: 'Flag', v: <span style={{ color: FLAG_COLORS[note.priority_flag] }} className="font-semibold capitalize">{note.priority_flag}</span> });
  if (note.appointment_required) items.push({ k: 'Appointment', v: 'Required' + (note.appointment_notes ? ` — ${note.appointment_notes}` : '') });
  if (note.liftgate_required) items.push({ k: 'Liftgate', v: 'Required' });
  if (note.dock_type) items.push({ k: 'Dock', v: note.dock_type.replace('_', ' ') });
  if (note.equipment_restrictions?.length) {
    items.push({
      k: 'Restrictions',
      v: note.equipment_restrictions.map(r => EQUIPMENT_OPTIONS.find(o => o.value === r)?.label || r).join(', '),
    });
  }
  const hoursAny = Object.values(note.receiving_hours || {}).some(Boolean);
  if (hoursAny) {
    items.push({
      k: 'Hours',
      v: (
        <div className="grid grid-cols-7 gap-1 mt-1">
          {DAYS.map((d) => (
            <div key={d} className="text-center">
              <div className="text-[9px] uppercase text-slate-500">{d}</div>
              <div className="text-[10px]">{note.receiving_hours?.[d] || '—'}</div>
            </div>
          ))}
        </div>
      ),
    });
  }
  if (note.dock_notes) items.push({ k: 'Dock notes', v: note.dock_notes });
  if (note.contacts?.length) {
    items.push({
      k: 'Contacts',
      v: (
        <ul className="text-xs space-y-0.5 mt-1">
          {note.contacts.map((c, i) => (
            <li key={i}>{c.name}{c.role ? ` (${c.role})` : ''} — {c.phone}</li>
          ))}
        </ul>
      ),
    });
  }
  return (
    <dl className="space-y-1.5 text-sm">
      {items.map((it, i) => (
        <div key={i}>
          <dt className="text-[10px] uppercase font-semibold text-slate-500">{it.k}</dt>
          <dd>{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------- map screen ----------

// Lazily create a custom OverlayView class for driver labels. Must be invoked
// after `google` is loaded since OverlayView is provided by the Maps script.
function makeDriverLabelOverlayClass(google) {
  return class DriverLabelOverlay extends google.maps.OverlayView {
    constructor(position, line1, line2, opts = {}) {
      super();
      this.position = position;
      this.line1 = line1;
      this.line2 = line2;
      this.stale = opts.stale || false;
      this.div = null;
    }
    onAdd() {
      const div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.transform = 'translate(-50%, 28px)';
      div.style.pointerEvents = 'none';
      div.style.background = 'rgba(255,255,255,0.85)';
      div.style.border = '1px solid rgba(0,0,0,0.1)';
      div.style.borderRadius = '4px';
      div.style.padding = '2px 6px';
      div.style.fontFamily = 'system-ui, -apple-system, sans-serif';
      div.style.fontSize = '11px';
      div.style.lineHeight = '1.25';
      div.style.whiteSpace = 'nowrap';
      div.style.textAlign = 'center';
      div.style.boxShadow = '0 1px 2px rgba(0,0,0,0.08)';
      div.style.opacity = this.stale ? '0.6' : '1';

      const l1 = document.createElement('div');
      l1.style.color = '#1e5b92';
      l1.style.fontWeight = '600';
      l1.textContent = this.line1 || '';

      const l2 = document.createElement('div');
      l2.style.color = '#555';
      l2.style.fontSize = '10px';
      l2.textContent = this.line2 || '';

      div.appendChild(l1);
      div.appendChild(l2);
      this.div = div;
      const panes = this.getPanes();
      panes.floatPane.appendChild(div);
    }
    draw() {
      if (!this.div) return;
      const proj = this.getProjection();
      if (!proj) return;
      const px = proj.fromLatLngToDivPixel(this.position);
      if (!px) return;
      this.div.style.left = `${px.x}px`;
      this.div.style.top = `${px.y}px`;
    }
    onRemove() {
      if (this.div && this.div.parentNode) this.div.parentNode.removeChild(this.div);
      this.div = null;
    }
    setVisible(v) {
      if (this.div) this.div.style.display = v ? '' : 'none';
    }
  };
}

function MapScreen() {
  const { stops, loading, error, lastRefreshed, source, refresh } = useStops();
  const { notes } = useCustomerNotes();
  const { google, error: mapsError } = useGoogleMaps();
  const viewportWidth = useViewportWidth();
  const isMobile = viewportWidth < MOBILE_BREAKPOINT;

  const [selectedStop, setSelectedStop] = useState(null);
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [filters, setFilters] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [showDrivers, setShowDrivers] = useState(false);
  const [showDriverLabels, setShowDriverLabels] = useState(() => safeReadJSON(LS_DRIVER_LABELS, true));
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 200);
  const { history, remember } = useSearchHistory();

  const { drivers, error: driverErr, lastRefreshed: driversAt } = useDriverPositions(showDrivers);
  const { snapshot, loading: snapshotLoading, error: snapshotError } = useDriverSnapshot(selectedDriver);
  const panel = useResizablePanel(viewportWidth);

  const searchInputRef = useRef(null);
  const mapRef = useRef(null);
  const mapDiv = useRef(null);
  const clustererRef = useRef(null);
  const markersRef = useRef([]);
  const driverMarkersRef = useRef([]);
  const driverLabelsRef = useRef([]);
  const labelOverlayClassRef = useRef(null);

  // Persist label-toggle preference whenever it changes.
  useEffect(() => { safeWriteJSON(LS_DRIVER_LABELS, showDriverLabels); }, [showDriverLabels]);

  // Filter pipeline: filters → search. Memoized so we don't recompute on each render.
  const filteredStops = useMemo(() => applyFilters(stops, notes, filters), [stops, notes, filters]);
  const searchMatchSet = useMemo(() => {
    if (!debouncedSearch.trim()) return null; // null sentinel = no search active
    const set = new Set();
    for (const s of filteredStops) {
      if (stopMatchesSearch(s, notes.get(s.matchKey), debouncedSearch)) set.add(s.stopNbr);
    }
    return set;
  }, [filteredStops, notes, debouncedSearch]);

  const visibleStops = useMemo(() => {
    if (!searchMatchSet) return filteredStops;
    return filteredStops.filter((s) => searchMatchSet.has(s.stopNbr));
  }, [filteredStops, searchMatchSet]);

  // Init map once google + container are ready.
  useEffect(() => {
    if (!google || !mapDiv.current || mapRef.current) return;
    mapRef.current = new google.maps.Map(mapDiv.current, {
      center: BUFORD,
      zoom: 10,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
    });
    labelOverlayClassRef.current = makeDriverLabelOverlayClass(google);
  }, [google]);

  // Tell Google Maps to redraw as soon as the panel width changes — otherwise
  // the map tiles leave a gap until the next interaction.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    google.maps.event.trigger(mapRef.current, 'resize');
  }, [google, panel.width]);

  // M4.1: render stop markers with full set + search opacity. We render ALL
  // filteredStops as markers but dim non-matches when a search is active so
  // the dispatcher keeps spatial context. Faded pins still cluster — at
  // zoomed-out levels cluster counts include all in view; at zoom-in the
  // 30%-opacity pins are obviously deprioritized.
  useEffect(() => {
    if (!google || !mapRef.current) return;

    if (clustererRef.current) clustererRef.current.clearMarkers();
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    const positioned = filteredStops.filter((s) => s.lat != null && s.lng != null);
    const newMarkers = positioned.map((s) => {
      const note = notes.get(s.matchKey);
      const color = flagColor(note);
      const dim = searchMatchSet && !searchMatchSet.has(s.stopNbr);
      const marker = new google.maps.Marker({
        position: { lat: s.lat, lng: s.lng },
        icon: {
          url: pinSvg(color),
          scaledSize: new google.maps.Size(28, 36),
          anchor: new google.maps.Point(14, 34),
        },
        title: s.businessName || '',
        opacity: dim ? 0.3 : 1,
      });
      marker.addListener('click', () => {
        setSelectedDriver(null);
        setSelectedStop(s);
      });
      return marker;
    });

    markersRef.current = newMarkers;
    clustererRef.current = new MarkerClusterer({ map: mapRef.current, markers: newMarkers });
  }, [google, filteredStops, notes, searchMatchSet]);

  // Auto-zoom on search results: 1 match → center + open sidebar, 2-10 → fit bounds.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    if (!searchMatchSet) return;
    const matched = filteredStops.filter((s) => searchMatchSet.has(s.stopNbr) && s.lat != null && s.lng != null);
    if (matched.length === 1) {
      const s = matched[0];
      mapRef.current.panTo({ lat: s.lat, lng: s.lng });
      mapRef.current.setZoom(Math.max(mapRef.current.getZoom() || 10, 14));
      // Don't auto-open if user already navigated away from search results.
      if (!selectedDriver) setSelectedStop(s);
    } else if (matched.length >= 2 && matched.length <= 10) {
      const bounds = new google.maps.LatLngBounds();
      matched.forEach((s) => bounds.extend({ lat: s.lat, lng: s.lng }));
      mapRef.current.fitBounds(bounds, 60);
    }
  }, [google, searchMatchSet]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Build the driver-status line2 text per brief rules.
  const driverStatusLine = useCallback((d) => {
    let base;
    if (d.routeAssigned && d.routeProgress) {
      base = `Stop ${d.routeProgress.completed} of ${d.routeProgress.total}`;
    } else if (d.routeAssigned && d.routeId) {
      base = `Route ${d.routeId} · ${d.routeTotalStops ?? '?'} stops`;
    } else {
      base = 'No route assigned';
    }
    const suffix = [];
    if (d.speedMph != null && d.speedMph > 5) suffix.push('en route');
    else if (d.speedMph != null && d.speedMph <= 5 && d.stoppedMinutes != null && d.stoppedMinutes > 5) suffix.push('stopped');
    if (d.locatedAt) {
      const ageMin = (Date.now() - new Date(d.locatedAt).getTime()) / 60000;
      if (ageMin > 30) suffix.push('stale');
    }
    return suffix.length ? `${base} · ${suffix.join(' · ')}` : base;
  }, []);

  // M4: driver markers + M4.1 labels — separate layer, larger truck icon.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    driverMarkersRef.current.forEach((m) => m.setMap(null));
    driverMarkersRef.current = [];
    driverLabelsRef.current.forEach((l) => l.setMap(null));
    driverLabelsRef.current = [];
    if (!showDrivers) return;

    const positioned = drivers.filter((d) => d.lat != null && d.lng != null);

    driverMarkersRef.current = positioned.map((d) => {
      const ageMin = d.locatedAt ? (Date.now() - new Date(d.locatedAt).getTime()) / 60000 : 0;
      const stale = ageMin > 30;
      const marker = new google.maps.Marker({
        position: { lat: d.lat, lng: d.lng },
        map: mapRef.current,
        icon: {
          url: truckSvg(DRIVER_TINT),
          scaledSize: new google.maps.Size(40, 40),
          anchor: new google.maps.Point(20, 20),
        },
        title: `${d.driverName || 'Driver'} · ${d.vehicleNumber || ''}`,
        opacity: stale ? 0.55 : 1,
        zIndex: 1000,
      });
      marker.addListener('click', () => {
        setSelectedStop(null);
        setSelectedDriver(d);
      });
      return marker;
    });

    if (showDriverLabels && labelOverlayClassRef.current) {
      const Klass = labelOverlayClassRef.current;
      driverLabelsRef.current = positioned.map((d) => {
        const ageMin = d.locatedAt ? (Date.now() - new Date(d.locatedAt).getTime()) / 60000 : 0;
        const stale = ageMin > 30;
        const first = d.driverFirstName || (d.driverName ? d.driverName.split(/\s+/)[0] : null);
        const lastInit = d.driverLastInitial || (d.driverName ? (d.driverName.split(/\s+/).slice(-1)[0]?.[0] || '') : '');
        const driverPart = d.driverName ? `${first}${lastInit ? ' ' + lastInit + '.' : ''}` : '(no driver)';
        const line1 = `${d.vehicleNumber || '?'} · ${driverPart}`;
        const line2 = driverStatusLine(d);
        const overlay = new Klass(
          new google.maps.LatLng(d.lat, d.lng),
          line1,
          line2,
          { stale },
        );
        overlay.setMap(mapRef.current);
        return overlay;
      });
    }
  }, [google, drivers, showDrivers, showDriverLabels, driverStatusLine]);

  // Keyboard shortcuts: `/` focuses search; Escape clears + blurs (handled in input).
  useEffect(() => {
    const onKey = (e) => {
      // Don't hijack `/` if user is already typing in any input/textarea.
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Trigger map resize once after mount so the initial fit isn't clipped.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    const id = setTimeout(() => google.maps.event.trigger(mapRef.current, 'resize'), 50);
    return () => clearTimeout(id);
  }, [google]);

  const handleSave = async (draft) => {
    if (!db || !selectedStop) return;
    setSaving(true);
    setSaveError(null);
    try {
      const key = selectedStop.matchKey;
      const existing = notes.get(key);
      const pro = selectedStop.pro;
      const proHistory = pro ? bumpProHistory(existing?.pro_history, pro) : (existing?.pro_history || []);
      const payload = {
        ...draft,
        match_key: key,
        raw_name: draft.raw_name || selectedStop.businessName || '',
        raw_address: draft.raw_address || [selectedStop.addr1, selectedStop.city, selectedStop.state, selectedStop.zip].filter(Boolean).join(', '),
        pro_history: proHistory,
        last_updated: serverTimestamp(),
        updated_by: NOTES_UPDATED_BY,
      };
      await setDoc(doc(db, 'customer_notes', key), payload, { merge: true });
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handlePanToStop = (stopFromSnapshot) => {
    if (!google || !mapRef.current) return;
    if (stopFromSnapshot.lat == null || stopFromSnapshot.lng == null) return;
    mapRef.current.panTo({ lat: stopFromSnapshot.lat, lng: stopFromSnapshot.lng });
    mapRef.current.setZoom(Math.max(mapRef.current.getZoom() || 10, 14));
  };

  // On mobile we drop the resize handle and let the panel be a top-edge sheet.
  // Stretch goal per brief — we ship the simple desktop-only resize and
  // collapse the panel by default on mobile; see HANDOFF.md.
  const panelStyle = isMobile
    ? { width: '100%', maxHeight: '40vh' }
    : { width: panel.width, minWidth: PANEL_MIN_WIDTH, maxWidth: panel.maxWidth };

  // Per brief width tiers:
  //   240-300px: compact (names truncate, city shown)
  //   300-450px: extended names, city shown
  //   450px+:    add priority-flag column
  const showCity = true;
  const showExtraPriority = !isMobile && panel.width >= 450;
  const useExtendedNames = !isMobile && panel.width >= 300;

  return (
    <div className={`flex flex-1 overflow-hidden ${isMobile ? 'flex-col' : ''}`}>
      {/* Left filter rail (top sheet on mobile) */}
      <div
        className="flex-shrink-0 bg-white border-r overflow-y-auto"
        style={panelStyle}
      >
        <SearchBar
          value={searchInput}
          onChange={setSearchInput}
          onSubmit={(v) => { if (v.trim()) remember(v.trim()); }}
          history={history}
          inputRef={searchInputRef}
          resultCount={visibleStops.length}
          totalCount={filteredStops.length}
        />
        <FilterPanel
          filters={filters}
          setFilters={setFilters}
          counts={{ visible: visibleStops.length, total: stops.length }}
        />
        <div className="border-t p-3 space-y-2">
          <button
            onClick={() => setShowDrivers((v) => !v)}
            className={`w-full text-xs font-semibold py-1.5 rounded inline-flex items-center justify-center gap-1.5 ${showDrivers ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 text-slate-700'}`}
          >
            {showDrivers ? <Eye size={13} /> : <EyeOff size={13} />}
            {showDrivers ? 'Hide live drivers' : 'Show live drivers'}
          </button>
          {showDrivers && (
            <button
              onClick={() => setShowDriverLabels((v) => !v)}
              className="w-full text-xs py-1 rounded inline-flex items-center justify-center gap-1.5 bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
              title="Toggle truck/driver labels"
            >
              {showDriverLabels ? <Tags size={12} /> : <Tag size={12} />}
              {showDriverLabels ? 'Hide labels' : 'Show labels'}
            </button>
          )}
          {showDrivers && (
            <div className="text-[10px] text-slate-500">
              {driverErr ? <span className="text-red-600">⚠ {driverErr}</span> : `${drivers.length} drivers · refresh 60s${driversAt ? ` · ${fmtTimeAgo(driversAt)}` : ''}`}
            </div>
          )}
        </div>

        <StopMiniTable
          stops={visibleStops}
          notes={notes}
          onPick={(s) => { setSelectedDriver(null); setSelectedStop(s); }}
          showCity={showCity}
          showPriorityColumn={showExtraPriority}
          truncateNames={!useExtendedNames}
        />
      </div>

      {/* Resize handle — desktop only */}
      {!isMobile && (
        <ResizeHandle onMouseDown={panel.onMouseDown} onDoubleClick={panel.onDoubleClick} />
      )}

      {/* Map */}
      <div className="flex-1 relative min-w-0">
        <div ref={mapDiv} className="absolute inset-0" />
        {mapsError && (
          <div className="absolute top-4 left-4 right-4 bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">
            <div className="font-semibold">Google Maps failed to load</div>
            <div className="text-xs mt-1">{mapsError}</div>
            <div className="text-xs mt-1 text-red-600">Set VITE_GOOGLE_MAPS_API_KEY in your .env / Netlify env.</div>
          </div>
        )}
        {!visibleStops.length && !loading && !mapsError && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-white border border-slate-200 rounded shadow px-3 py-1.5 text-xs text-slate-600">
            {debouncedSearch ? `No stops match "${debouncedSearch}"` : 'No stops match the current filters.'}
          </div>
        )}

        {/* Top-right status pill */}
        <div className="absolute top-3 right-3 bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow px-3 py-2 flex items-center gap-3 text-xs">
          <div>
            <div className="font-semibold">{stops.length} stops</div>
            <div className="text-slate-500">{source === 'fixture' ? 'MOCK DATA' : 'NuVizz'} · {fmtTimeAgo(lastRefreshed)}</div>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="p-1.5 rounded hover:bg-slate-100 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {error && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-red-50 border border-red-200 rounded px-3 py-1.5 text-xs text-red-700">
            ⚠ {error}
          </div>
        )}
      </div>

      {/* Right sidebar — driver snapshot takes priority when a driver is selected. */}
      {selectedDriver && (
        <DriverSnapshotSidebar
          driver={selectedDriver}
          snapshot={snapshot}
          loading={snapshotLoading}
          error={snapshotError}
          onClose={() => setSelectedDriver(null)}
          onPanToStop={handlePanToStop}
        />
      )}
      {!selectedDriver && selectedStop && (
        <StopSidebar
          stop={selectedStop}
          note={notes.get(selectedStop.matchKey)}
          onClose={() => setSelectedStop(null)}
          onSave={handleSave}
          saving={saving}
          saveError={saveError}
        />
      )}
    </div>
  );
}

function StopMiniTable({ stops, notes, onPick, showCity = true, showPriorityColumn = false, truncateNames = true }) {
  // Decorate rows with flag for sorting.
  const rows = useMemo(() => stops.map((s) => {
    const n = notes.get(s.matchKey);
    return {
      ...s,
      _flag: n?.priority_flag || 'none',
      _hasNote: !!n,
      _priorityRank: n?.priority_flag === 'red' ? 0 : n?.priority_flag === 'yellow' ? 1 : n?.priority_flag === 'green' ? 2 : 3,
    };
  }), [stops, notes]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, 'businessName', 'asc');
  // Horizontal scroll if columns exceed panel width.
  return (
    <div className="border-t">
      <div className="px-3 py-2 text-xs font-semibold text-slate-600">Stops ({rows.length})</div>
      <div className="max-h-[40vh] overflow-y-auto overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 sticky top-0">
            <tr>
              <SortableTh label="Flag" k="_flag" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="Customer" k="businessName" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              {showCity && <SortableTh label="City" k="city" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
              <SortableTh label="PRO" k="pro" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              {showPriorityColumn && <SortableTh label="Pri" k="_priorityRank" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.stopNbr} onClick={() => onPick(s)} className="cursor-pointer hover:bg-blue-50 border-t">
                <td className="px-2 py-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: s._flag !== 'none' ? FLAG_COLORS[s._flag] : (s._hasNote ? RESTRICTION_TINT : '#cbd5e1') }} />
                </td>
                <td
                  className={`px-2 py-1 ${truncateNames ? 'truncate max-w-[160px]' : ''}`}
                  title={s.businessName}
                  style={!truncateNames ? { maxWidth: 320 } : undefined}
                >
                  {s.businessName}
                </td>
                {showCity && <td className="px-2 py-1 text-slate-600 whitespace-nowrap">{s.city}</td>}
                <td className="px-2 py-1 font-mono text-[10px] text-slate-500 whitespace-nowrap">{s.pro}</td>
                {showPriorityColumn && (
                  <td className="px-2 py-1 text-[10px] uppercase">
                    {s._flag !== 'none' ? (
                      <span style={{ color: FLAG_COLORS[s._flag] }} className="font-semibold">{s._flag.charAt(0)}</span>
                    ) : (s._hasNote ? <span className="text-purple-600 font-semibold">R</span> : <span className="text-slate-300">—</span>)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- M3 stub ----------

function DiagnosticsScreen({ stops, notes }) {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-4xl mx-auto">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Diagnostics</h2>
        <p className="text-sm text-slate-600 mt-1">M3 — stub. Each panel below has a TODO describing what to build.</p>
      </div>

      <Panel title="Unmatched Stops Today">
        {/*
          TODO (M3-A):
          Walk through `stops` and surface rows that have NO matching customer_notes doc
          (notes.get(stop.matchKey) is undefined). Render as a sortable table with
          columns: business, address, PRO, count-today. Add a "Create notes" button per
          row that pre-fills the sidebar form (lift selectedStop state up if needed).
          This is the dispatcher's daily "what's new?" view.
        */}
        <Placeholder count={stops.filter((s) => !notes.get(s.matchKey)).length} hint="unmatched today" />
      </Panel>

      <Panel title="Stale Customers (90+ days)">
        {/*
          TODO (M3-B):
          Iterate notes and filter where last_updated (Firestore Timestamp) is older
          than 90 days. Render sortable table: customer, last_updated date, days-since.
          Add a "Review" button that opens the customer in the editor even if they
          don't appear in today's stops. Need to handle the "not on today's map" case —
          maybe a separate compact editor modal that doesn't depend on a selected stop.
        */}
        <Placeholder count={0} hint="stale customers" />
      </Panel>

      <Panel title="Address Line 2 Migration">
        {/*
          TODO (M3-C):
          Group today's stops by addr2 (non-empty), then for each unique addr2 string
          show: text, list of business names that use it, "Promote to Notes" action.
          Promotion = create or update customer_notes for each customer with the
          appropriate field set (e.g. addr2 says "Liftgate" → set liftgate_required=true).
          This is the cleanup pass to drain Chad's addr2 dumping ground into structured fields.
          Heuristic ideas: regex for "liftgate", "appt", "no tractor", "26ft", "ground only".
        */}
        <Placeholder count={stops.filter((s) => (s.addr2 || '').trim()).length} hint="addr2 fields populated today" />
      </Panel>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b bg-slate-50">
        <h3 className="font-semibold text-slate-900">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Placeholder({ count, hint }) {
  return (
    <div className="flex items-center gap-3 text-sm text-slate-500 italic">
      <Activity size={16} />
      <span>{count} {hint} · not implemented (see TODO)</span>
    </div>
  );
}

// ---------- shell ----------

function Shell() {
  const [tab, setTab] = useState('map');
  // Diagnostics tab needs the same data — keep a single hook source by fetching here
  // would force a duplicate. For simplicity each screen fetches its own; the
  // useStops hook is cheap (memoized network call + react state). M3 will probably
  // promote this to context once it actually does something useful.
  return (
    <div className="h-screen flex flex-col">
      <header className="flex items-center justify-between px-4 py-2 border-b bg-white" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-sm" style={{ background: BRAND }}>D</div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold leading-none">Davis Delivery</div>
            <div className="font-bold leading-tight">Dispatch Map</div>
          </div>
        </div>
        <nav className="flex items-center gap-1 text-sm">
          <TabBtn label="Map" icon={<MapPin size={14} />} active={tab === 'map'} onClick={() => setTab('map')} />
          <TabBtn label="Diagnostics" icon={<Activity size={14} />} active={tab === 'diag'} onClick={() => setTab('diag')} />
        </nav>
        {/* Right side intentionally empty — no auth in v0.3.0 (matches Glory Bound / MarginIQ). */}
        <div />
      </header>

      {tab === 'map' ? <MapScreen /> : <DiagnosticsRoute />}

      <footer className="border-t bg-white px-4 py-1 text-[10px] text-slate-400 flex items-center justify-between">
        <div>Dispatch Map v{APP_VERSION} · {BUILD_COMMIT}{BUILD_TIME ? ` · built ${BUILD_TIME.slice(5, 16).replace('T', ' ')}Z` : ''}</div>
        <div className="hidden sm:block">© Davis Delivery Service</div>
      </footer>
    </div>
  );
}

// Tiny diagnostics wrapper so the screen has its own data fetch
// (rather than threading the map's state through props).
function DiagnosticsRoute() {
  const { stops } = useStops();
  const { notes } = useCustomerNotes();
  return <DiagnosticsScreen stops={stops} notes={notes} />;
}

function TabBtn({ label, icon, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded inline-flex items-center gap-1.5 font-medium ${active ? 'text-white' : 'text-slate-600 hover:bg-slate-100'}`}
      style={active ? { background: BRAND } : {}}
    >
      {icon}{label}
    </button>
  );
}

export default function App() {
  return <Shell />;
}
