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
  Info, Settings, LayoutList,
} from 'lucide-react';
import {
  collection, doc, getDoc, onSnapshot, setDoc, serverTimestamp,
} from 'firebase/firestore';

import { db } from './lib/firebase.js';
import { normalizeMatchKey } from './lib/matchKey.js';
import { haversineMiles, naiveEtaMinutes, formatEtaClockTime } from './lib/distance.js';
import { scanStop, scanStopFull } from './lib/signal-scanner';
import { applyScannerResults } from './lib/customer-notes-writer';

// Vite's tree-shaker considers function-only imports from .ts files to be
// pure; it eliminates them even though they're called from useAutoScanner's
// useEffect (which only fires after notesReady + stops load). Exposing the
// entry points on window keeps the import chain observed so the bundle
// retains the scanner + writer. Doubles as a QA hook —
// window.__DD_SCANNER__.scanStop(...) lets QA test patterns in DevTools.
if (typeof window !== 'undefined') {
  window.__DD_SCANNER__ = { scanStop, scanStopFull, applyScannerResults };
}

// ---------- constants ----------

const APP_VERSION = '0.7.1';

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
  { value: 'uline_straight_truck', label: 'Uline: straight truck (advisory)' },
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
const LS_LEGEND_EXPANDED = 'dispatchMap.legendExpanded';
const LS_TABLE_COLUMNS = 'dispatchMap.tableColumns';
// M4.4 — Filter toolbar persistence. mapFilters is the full toggle state object;
// toolbarCollapsed is just the open/closed UI state of the toolbar itself.
const LS_MAP_FILTERS = 'dispatchMap.mapFilters';
const LS_FILTER_TOOLBAR_COLLAPSED = 'dispatchMap.filterToolbarCollapsed';
// M4.5 — Mobile drawer last-active tab (Stops/Filters/Drivers). Drawer height
// intentionally NOT persisted — it always opens at the default size.
const LS_MOBILE_DRAWER_TAB = 'dispatchMap.mobileDrawerTab';
const PANEL_DEFAULT_WIDTH = 320;
const PANEL_MIN_WIDTH = 240;
// Max width is computed at runtime as 60% of viewport — see useResizablePanel.
const MOBILE_BREAKPOINT = 768;

// Stops-table column visibility defaults. PRO and Flag are off by default —
// dispatchers turn them on via the Columns gear when they need PRO search or
// flag-only triage. Persisted to LS_TABLE_COLUMNS.
const DEFAULT_TABLE_COLUMNS = {
  flag: false,
  customer: true,
  city: true,
  pro: false,
  priority: true,
};

// M4.4 — Map filter toolbar. 5 toggles, persisted as a single object so adding
// a 6th later doesn't churn separate LS keys. Defaults match the brief:
// terminal/stem-out hidden = OFF (markers visible), unplanned/vehicles/clustering = ON.
const DEFAULT_MAP_FILTERS = {
  hideTerminal: false,
  hideStemOut: false,
  showUnplanned: true,
  showVehicleLocation: true,
  showClustered: true,
};
const TABLE_COLUMN_DEFS = [
  { key: 'flag',     label: 'Flag' },
  { key: 'customer', label: 'Customer' },
  { key: 'city',     label: 'City' },
  { key: 'pro',      label: 'PRO' },
  { key: 'priority', label: 'Priority' },
];

// Restriction icon library — single source of truth used by:
//   1. The M4.1.5 14×14 badge (`glyph`, `bg`) — rendered inside the sidebar
//      restriction chips and the Legend per-icon list. White-on-colored-bg.
//   2. The M4.1.6 22×22 marker icon (`markerGlyph`, `accent`) — rendered as
//      the marker itself when a stop has restrictions (replacing the pin).
//      Monochrome `currentColor` so the parent <g style="color:..."> tints
//      both stroke and fill in one place.
// `prohibition: true` adds the diagonal slash in the marker rendering
// (slash is baked into the 14×14 glyph but applied programmatically for the
// 22×22 marker version). Aliases live in RESTRICTION_ALIASES below.
const RESTRICTION_ICONS = {
  no_tractor_trailer: {
    label: 'No tractor trailer',
    short: 'No T/T',
    bg: '#dc2626',
    accent: '#dc2626',
    glyph: '<rect x="2" y="6.5" width="7" height="3.5" fill="white"/><rect x="9" y="5" width="3" height="5" fill="white"/><circle cx="4" cy="10.5" r="1" fill="#dc2626"/><circle cx="10.5" cy="10.5" r="1" fill="#dc2626"/>',
    // 22x22: tractor (right) + trailer (left), 3 wheels. currentColor.
    markerGlyph: `
      <rect x="2" y="9" width="11" height="6.5" rx="0.5" fill="currentColor"/>
      <rect x="13" y="7" width="6" height="8.5" rx="0.5" fill="currentColor"/>
      <circle cx="5" cy="17" r="1.7" fill="white"/>
      <circle cx="10" cy="17" r="1.7" fill="white"/>
      <circle cx="16" cy="17" r="1.7" fill="white"/>
      <circle cx="5" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="10" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="16" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
    `,
    prohibition: true,
  },
  // M2.1 — Uline SPL-INSTR-TEXT advisory: "STRAIGHT TRUCK ONLY" etc. detected
  // in orderInstructions. Same shape as no_tractor_trailer but amber to signal
  // "verify before relying" (Uline sometimes over-broadcasts this constraint).
  uline_straight_truck: {
    label: 'Uline: straight truck only (advisory)',
    short: 'ST only',
    bg: '#f59e0b',
    accent: '#f59e0b',
    glyph: '<rect x="2" y="6.5" width="7" height="3.5" fill="white"/><rect x="9" y="5" width="3" height="5" fill="white"/><circle cx="4" cy="10.5" r="1" fill="#f59e0b"/><circle cx="10.5" cy="10.5" r="1" fill="#f59e0b"/>',
    markerGlyph: `
      <rect x="2" y="9" width="11" height="6.5" rx="0.5" fill="currentColor"/>
      <rect x="13" y="7" width="6" height="8.5" rx="0.5" fill="currentColor"/>
      <circle cx="5" cy="17" r="1.7" fill="white"/>
      <circle cx="10" cy="17" r="1.7" fill="white"/>
      <circle cx="16" cy="17" r="1.7" fill="white"/>
      <circle cx="5" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="10" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="16" cy="17" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
    `,
    prohibition: true,
  },
  liftgate_required: {
    label: 'Liftgate required',
    short: 'Liftgate',
    bg: '#7c3aed',
    accent: '#1e5b92',
    glyph: '<path d="M2 11 L12 11" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M7 9 L7 3 M4.5 5.5 L7 3 L9.5 5.5" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/>',
    // 22x22: platform bar at bottom + up-arrow.
    markerGlyph: `
      <line x1="2" y1="18" x2="20" y2="18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="11" y1="15" x2="11" y2="5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M5.5 9 L11 3.5 L16.5 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    `,
  },
  '26ft_max': {
    label: '26 ft max',
    short: '26ft max',
    bg: '#ea580c',
    accent: '#dc2626',
    label_text: '26',
    // 22x22: big "26" + tiny "FT MAX" caption below.
    markerGlyph: `
      <text x="11" y="14.5" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="800" fill="currentColor" text-anchor="middle">26</text>
      <text x="11" y="20" font-family="system-ui, -apple-system, sans-serif" font-size="4.5" font-weight="700" fill="currentColor" text-anchor="middle">FT MAX</text>
    `,
  },
  no_53ft: {
    label: 'No 53 ft',
    short: 'No 53ft',
    bg: '#dc2626',
    accent: '#dc2626',
    label_text: '53',
    prohibition: true,
    // 22x22: big "53" — slash applied via prohibition.
    markerGlyph: `
      <text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="800" fill="currentColor" text-anchor="middle">53</text>
    `,
  },
  appointment_required: {
    label: 'Appointment required',
    short: 'Appt',
    bg: '#0891b2',
    accent: '#f59e0b',
    glyph: '<circle cx="7" cy="7" r="3.5" fill="none" stroke="white" stroke-width="1.3"/><path d="M7 4.5 L7 7 L8.8 8" stroke="white" stroke-width="1.3" stroke-linecap="round" fill="none"/>',
    // 22x22: clock face with hands at ~10 o'clock.
    markerGlyph: `
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/>
      <line x1="11" y1="11" x2="11" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <line x1="11" y1="11" x2="14.5" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    `,
  },
  box_truck_only: {
    label: 'Box truck only',
    short: 'Box only',
    bg: '#475569',
    accent: '#dc2626',
    glyph: '<rect x="3" y="6" width="6" height="4" fill="white"/><path d="M9 7 L9 10 L12 10 L12 8 L10.5 7 Z" fill="white"/><circle cx="4.5" cy="10.5" r="1" fill="#475569"/><circle cx="10.5" cy="10.5" r="1" fill="#475569"/>',
    // 22x22: box truck — large box body + smaller cab + 2 wheels.
    markerGlyph: `
      <rect x="2" y="8" width="11" height="7.5" rx="0.5" fill="currentColor"/>
      <path d="M13 9.5 L13 15.5 L19 15.5 L19 12 L16.5 9.5 Z" fill="currentColor"/>
      <circle cx="5.5" cy="17.5" r="1.7" fill="white"/>
      <circle cx="16" cy="17.5" r="1.7" fill="white"/>
      <circle cx="5.5" cy="17.5" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="16" cy="17.5" r="1.7" fill="none" stroke="currentColor" stroke-width="0.7"/>
    `,
  },
  no_overhead_clearance: {
    label: 'Low overhead clearance',
    short: 'Low clear',
    bg: '#a16207',
    accent: '#a16207',
    glyph: '<path d="M2 11 L2 6 Q7 2 12 6 L12 11" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M5 11 L5 9 M9 11 L9 9" stroke="white" stroke-width="1.3"/>',
    // 22x22: bridge arch + truck silhouette under it.
    markerGlyph: `
      <path d="M2 17 L2 11 Q11 3 20 11 L20 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      <rect x="6" y="13" width="9" height="4" rx="0.4" fill="currentColor"/>
      <circle cx="8" cy="17.5" r="1.3" fill="white"/>
      <circle cx="13" cy="17.5" r="1.3" fill="white"/>
    `,
  },
  // M4.4 — receiving hours present. Amber clock; not a prohibition. Synthesized
  // from customer_notes.receiving_hours having any non-empty per-day value,
  // OR from a scanner-detected hours range.
  receiving_hours: {
    label: 'Receiving hours',
    short: 'Hours',
    bg: '#f59e0b',
    accent: '#f59e0b',
    // 14×14 badge: clock face + hour/minute hands.
    glyph: '<circle cx="7" cy="7" r="4.5" fill="none" stroke="white" stroke-width="1.3"/><path d="M7 4 L7 7 L9.5 8.5" stroke="white" stroke-width="1.3" stroke-linecap="round" fill="none"/>',
    // 22×22 marker: clock face with bold hands at ~8 o'clock.
    markerGlyph: `
      <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/>
      <line x1="11" y1="11" x2="11" y2="5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <line x1="11" y1="11" x2="15" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    `,
  },
  // M4.4 — closed Monday. Red circle + letter "M" + diagonal slash. Prohibition
  // flag handles the slash via the marker-rendering pipeline (renderMarkerGlyph).
  closed_monday: {
    label: 'Closed Monday',
    short: 'Closed Mon',
    bg: '#dc2626',
    accent: '#dc2626',
    label_text: 'M',
    prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="9" font-weight="bold" fill="white" text-anchor="middle">M</text>',
    markerGlyph: `
      <text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="800" fill="currentColor" text-anchor="middle">M</text>
    `,
  },
  // M4.4 — closed Friday. Same template as Monday, letter F.
  closed_friday: {
    label: 'Closed Friday',
    short: 'Closed Fri',
    bg: '#dc2626',
    accent: '#dc2626',
    label_text: 'F',
    prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="9" font-weight="bold" fill="white" text-anchor="middle">F</text>',
    markerGlyph: `
      <text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="800" fill="currentColor" text-anchor="middle">F</text>
    `,
  },
  // Other closed days — same template, brief listed them as low-priority cheap
  // additions. Letters Tu/W/Th/Sa/Su (2-char where needed for legibility).
  closed_tuesday:  { label: 'Closed Tuesday',  short: 'Closed Tue',  bg: '#dc2626', accent: '#dc2626', prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="7" font-weight="bold" fill="white" text-anchor="middle">Tu</text>',
    markerGlyph: '<text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="800" fill="currentColor" text-anchor="middle">Tu</text>',
  },
  closed_wednesday: { label: 'Closed Wednesday', short: 'Closed Wed', bg: '#dc2626', accent: '#dc2626', prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="9" font-weight="bold" fill="white" text-anchor="middle">W</text>',
    markerGlyph: '<text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="800" fill="currentColor" text-anchor="middle">W</text>',
  },
  closed_thursday: { label: 'Closed Thursday', short: 'Closed Thu', bg: '#dc2626', accent: '#dc2626', prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="7" font-weight="bold" fill="white" text-anchor="middle">Th</text>',
    markerGlyph: '<text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="800" fill="currentColor" text-anchor="middle">Th</text>',
  },
  closed_saturday: { label: 'Closed Saturday', short: 'Closed Sat', bg: '#dc2626', accent: '#dc2626', prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="7" font-weight="bold" fill="white" text-anchor="middle">Sa</text>',
    markerGlyph: '<text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="800" fill="currentColor" text-anchor="middle">Sa</text>',
  },
  closed_sunday: { label: 'Closed Sunday', short: 'Closed Sun', bg: '#dc2626', accent: '#dc2626', prohibition: true,
    glyph: '<text x="7" y="10" font-family="sans-serif" font-size="7" font-weight="bold" fill="white" text-anchor="middle">Su</text>',
    markerGlyph: '<text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="800" fill="currentColor" text-anchor="middle">Su</text>',
  },
};
// Recognized aliases — straight_truck_only is sometimes used as a synonym
// for box_truck_only in TMS systems.
const RESTRICTION_ALIASES = {
  straight_truck_only: 'box_truck_only',
};
const UNKNOWN_RESTRICTION = {
  label: 'Unknown restriction',
  short: 'Unknown',
  bg: '#eab308',
  accent: '#6b7280',
  // 14x14 badge fallback
  glyph: '<text x="7" y="10" font-family="sans-serif" font-size="9" font-weight="bold" fill="white" text-anchor="middle">!</text>',
  // 22x22 marker fallback
  markerGlyph: `
    <text x="11" y="16" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="800" fill="currentColor" text-anchor="middle">!</text>
  `,
};

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

// M2.1 — Auto-scan today's stops for SPL-INSTR-TEXT + addressLine2 signals
// and enrich customer_notes accordingly. Source-locked (see signal-scanner.ts):
//   addressLine2     → no_tractor_trailer  (Davis-curated, red)
//   orderInstructions → uline_straight_truck (Uline advisory, amber)
// Runs once per load+notes-ready combo; subsequent re-renders are no-ops.
function useAutoScanner(stops, notes, notesReady) {
  const lastSignatureRef = useRef(null);
  useEffect(() => {
    if (!db || !notesReady || !stops.length) return;
    // Skip if we've already scanned this stop set. Signature = stop count +
    // first/last pro, cheap and stable for a given session's load.
    const sig = `${stops.length}|${stops[0]?.pro || ''}|${stops[stops.length - 1]?.pro || ''}`;
    if (lastSignatureRef.current === sig) return;
    lastSignatureRef.current = sig;

    const scanned = stops
      .map((s) => {
        if (!s.matchKey) return null;
        const full = scanStopFull({
          signalSources: s.signalSources,
          addr2: s.addr2,
        });
        const hasAny = full.restrictions.length || full.hours || full.closedDays.length;
        if (!hasAny) return null;
        return {
          matchKey: s.matchKey,
          pro: s.pro,
          businessName: s.businessName,
          addr1: s.addr1,
          city: s.city,
          state: s.state,
          zip: s.zip,
          scanResults: full.restrictions,
          hoursResult: full.hours,
          closedDaysResult: full.closedDays,
        };
      })
      .filter(Boolean);

    if (!scanned.length) return;

    applyScannerResults(db, scanned, notes).then((res) => {
      if (res.errors.length) {
        console.warn('Scanner write errors:', res.errors.slice(0, 3));
      }
      console.log(`Auto-scanner: attempted ${res.attempted}, wrote ${res.written}, override-skips ${res.overrideSkips}, migrations ${res.legacyMigrations}`);
    }).catch((err) => {
      console.error('Auto-scanner failed:', err);
    });
  }, [stops, notes, notesReady]);
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
// Snapshot shape is whatever /nuvizz-driver-route returns; the function scans
// today's load-number range and filters by driverUserName (preferred) or by
// whitespace-normalized driverName (fallback).
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

// Resolve a stored restriction string to a canonical key in RESTRICTION_ICONS.
// Unknown values pass through untouched so the caller can detect them.
function resolveRestrictionKey(raw) {
  if (!raw) return null;
  return RESTRICTION_ALIASES[raw] || raw;
}

// True if customer_notes carries any non-empty receiving_hours value. Old
// schema stored per-day as a single string ("6AM-2PM"); M4.4 schema stores
// per-day as {open, close}. Either truthy form qualifies.
function hasReceivingHours(note) {
  const hrs = note?.receiving_hours;
  if (!hrs) return false;
  for (const k of Object.keys(hrs)) {
    const v = hrs[k];
    if (!v) continue;
    if (typeof v === 'string' && v.trim()) return true;
    if (typeof v === 'object' && (v.open || v.close)) return true;
  }
  return false;
}

// Build the list of restriction badge keys for a note. Includes equipment
// restrictions, liftgate, appointment-required (M2-M4), and M4.4 additions:
// receiving_hours (clock), closed_<day> per entry in note.closed_days.
// Display order per brief P3.2: equipment first, then receiving hours, then
// closed Monday, then closed Friday, then other closed days.
function getRestrictionBadgeKeys(note) {
  if (!note) return [];
  const keys = [];
  for (const r of note.equipment_restrictions || []) {
    const resolved = resolveRestrictionKey(r);
    if (resolved && !keys.includes(resolved)) keys.push(resolved);
  }
  if (note.liftgate_required && !keys.includes('liftgate_required')) keys.push('liftgate_required');
  if (note.appointment_required && !keys.includes('appointment_required')) keys.push('appointment_required');
  if (hasReceivingHours(note)) keys.push('receiving_hours');
  const closed = Array.isArray(note.closed_days) ? note.closed_days : [];
  const closedOrder = ['mon', 'fri', 'tue', 'wed', 'thu', 'sat', 'sun'];
  for (const day of closedOrder) {
    if (closed.includes(day)) {
      const key = `closed_${({mon:'monday', tue:'tuesday', wed:'wednesday', thu:'thursday', fri:'friday', sat:'saturday', sun:'sunday'})[day]}`;
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

// Raw SVG fragment for a single 14×14 badge (used inside the marker SVG
// data URL AND inside the React <RestrictionIcon/>). Logs unknown kinds
// once to the console so they're discoverable rather than silent.
const __unknownRestrictionsLogged = new Set();
function badgeInnerSvg(kind) {
  let def = RESTRICTION_ICONS[kind];
  if (!def) {
    if (!__unknownRestrictionsLogged.has(kind)) {
      __unknownRestrictionsLogged.add(kind);
      // eslint-disable-next-line no-console
      console.warn(`[restriction-icons] unknown restriction kind: "${kind}" — rendering generic warning badge`);
    }
    def = UNKNOWN_RESTRICTION;
  }
  const slash = def.prohibition
    ? '<line x1="2.5" y1="2.5" x2="11.5" y2="11.5" stroke="white" stroke-width="2" stroke-linecap="round"/>'
    : '';
  const labelText = def.label_text
    ? `<text x="7" y="9.5" font-family="system-ui, sans-serif" font-size="6" font-weight="700" fill="white" text-anchor="middle">${def.label_text}</text>`
    : '';
  return `
    <circle cx="7" cy="7" r="7" fill="${def.bg}" stroke="white" stroke-width="1.5"/>
    ${def.glyph || ''}
    ${labelText}
    ${slash}
  `;
}

// M4.1.6 — marker rendering split into two functions:
//
//   pinSvgClassic(color): the historical 28×36 pin. Used for State A (stop
//     has no restrictions). No behavior change vs. M4.1 / M4.1.5 in this
//     case — same SVG, same anchor (14, 34).
//
//   iconMarkerSvg(restrictions): the icon-only marker that replaces the pin
//     entirely when 1+ restrictions are present. Returns { url, width,
//     height, anchor: [x, y] } so the marker effect can size and anchor
//     correctly. State B (1 restriction): single 36-diameter circle. State
//     C (2+): 32-diameter circles side-by-side, capped at 3 elements (4+
//     becomes "first 2 + overflow '+N' badge"). Geographic anchor is the
//     bottom-center of the marker group in both states.

function pinSvgClassic(color) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 1c-7 0-13 5.4-13 12 0 9 13 22 13 22s13-13 13-22c0-6.6-6-12-13-12z"
        fill="${color}" stroke="white" stroke-width="2"/>
      <circle cx="14" cy="13" r="4.5" fill="white"/>
    </svg>`;
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
}

// Resolve a restriction kind to its accent color + 22×22 glyph fragment.
// Substitutes `currentColor` in the template with the accent so the glyph
// renders standalone (works in any SVG renderer, no CSS cascade required).
// Returns the rendered glyph string plus the optional prohibition slash.
function renderMarkerGlyph(restrictionKey, glyphX, glyphY) {
  const resolved = resolveRestrictionKey(restrictionKey);
  const def = RESTRICTION_ICONS[resolved] || UNKNOWN_RESTRICTION;
  const color = def.accent || def.bg || '#6b7280';
  const glyph = (def.markerGlyph || UNKNOWN_RESTRICTION.markerGlyph || '')
    .replace(/currentColor/g, color);
  const slash = def.prohibition
    ? `<line x1="2" y1="2" x2="20" y2="20" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`
    : '';
  return `<g transform="translate(${glyphX},${glyphY})">${glyph}${slash}</g>`;
}

function iconMarkerSvg(restrictions) {
  if (!restrictions || restrictions.length === 0) return null;

  // State B: single 36-diameter circle.
  if (restrictions.length === 1) {
    const r = restrictions[0];
    const def = RESTRICTION_ICONS[resolveRestrictionKey(r)] || UNKNOWN_RESTRICTION;
    const accent = def.accent || def.bg || '#6b7280';
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="44" viewBox="0 0 40 44">
        <ellipse cx="20" cy="40" rx="12" ry="1.8" fill="black" opacity="0.18"/>
        <circle cx="20" cy="20" r="18" fill="white" fill-opacity="0.95" stroke="${accent}" stroke-width="2"/>
        ${renderMarkerGlyph(r, 9, 9)}
      </svg>`;
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      width: 40,
      height: 44,
      anchor: [20, 38],
    };
  }

  // State C: side-by-side 32-diameter circles. 2 or 3 raw restrictions
  // render as-is; 4+ collapses to first 2 + "+N" overflow.
  const elements = restrictions.length <= 3
    ? restrictions.slice()
    : [restrictions[0], restrictions[1], { __overflow: restrictions.length - 2 }];
  const n = elements.length;
  const slotW = 32;
  const gap = 2;
  const totalW = n * slotW + (n - 1) * gap;
  const totalH = 40;

  let elementsMarkup = '';
  for (let i = 0; i < n; i++) {
    const cx = i * (slotW + gap) + slotW / 2;
    const cy = 18;
    const el = elements[i];
    if (el && typeof el === 'object' && '__overflow' in el) {
      elementsMarkup += `
        <circle cx="${cx}" cy="${cy}" r="15" fill="white" fill-opacity="0.95" stroke="#6b7280" stroke-width="2"/>
        <text x="${cx}" y="${cy + 4}" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="800" fill="#374151" text-anchor="middle">+${el.__overflow}</text>
      `;
    } else {
      const def = RESTRICTION_ICONS[resolveRestrictionKey(el)] || UNKNOWN_RESTRICTION;
      const accent = def.accent || def.bg || '#6b7280';
      elementsMarkup += `
        <circle cx="${cx}" cy="${cy}" r="15" fill="white" fill-opacity="0.95" stroke="${accent}" stroke-width="2"/>
        ${renderMarkerGlyph(el, cx - 11, cy - 11)}
      `;
    }
  }

  const shadowRx = Math.max(8, totalW / 2 - 6);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">
      <ellipse cx="${totalW / 2}" cy="36" rx="${shadowRx}" ry="1.8" fill="black" opacity="0.15"/>
      ${elementsMarkup}
    </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    width: totalW,
    height: totalH,
    anchor: [totalW / 2, 34],
  };
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
    // M4.4 — receiving_hours uses {open, close} per day. Empty strings keep
    // <input type="time"> controls controlled without showing a placeholder.
    receiving_hours: {
      mon: { open: '', close: '' },
      tue: { open: '', close: '' },
      wed: { open: '', close: '' },
      thu: { open: '', close: '' },
      fri: { open: '', close: '' },
      sat: { open: '', close: '' },
      sun: { open: '', close: '' },
    },
    closed_days: [],
    manual_overrides: {},
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

// Part 9: render a single restriction icon at the given size. The inner SVG
// is identical to what the marker embeds, so legend/sidebar/marker stay
// visually consistent. Uses dangerouslySetInnerHTML inside an <svg> — the
// browser preserves SVG namespace because the parent is svg, so the inner
// nodes parse correctly.
function RestrictionIcon({ kind, size = 16, title }) {
  const resolved = resolveRestrictionKey(kind);
  const def = RESTRICTION_ICONS[resolved] || UNKNOWN_RESTRICTION;
  const titleText = title || def.label;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      role="img"
      aria-label={titleText}
    >
      <title>{titleText}</title>
      <g dangerouslySetInnerHTML={{ __html: badgeInnerSvg(resolved || 'unknown') }} />
    </svg>
  );
}

// M4.1 — case-insensitive contains-match across business name, every PRO on
// the stop, address1, city, ZIP, and either of the customer-notes prose
// fields. Returns true for empty queries (no filter applied).
function stopMatchesSearch(stop, note, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const fields = [
    stop.businessName,
    stop.addr1,
    stop.city,
    stop.zip,
    note?.dock_notes,
    note?.appointment_notes,
  ];
  for (const f of fields) {
    if (f && String(f).toLowerCase().includes(needle)) return true;
  }
  for (const pro of stop.pros || (stop.pro ? [stop.pro] : [])) {
    if (String(pro).toLowerCase().includes(needle)) return true;
  }
  return false;
}

// Return the PRO from a stop's pros list that matches the search needle.
// Used so the table cell shows the matched PRO first (then "+N" others).
function matchedPro(stop, q) {
  if (!q) return null;
  const needle = q.toLowerCase();
  const list = stop.pros || (stop.pro ? [stop.pro] : []);
  for (const pro of list) {
    if (String(pro).toLowerCase().includes(needle)) return pro;
  }
  return null;
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

// M4.1.6: render the same iconMarkerSvg output as an <img> for the legend
// examples. This guarantees the legend preview is byte-identical to what
// the map renders, so if the marker visual changes the legend stays in sync.
function LegendMarkerExample({ restrictions, label }) {
  const spec = useMemo(() => iconMarkerSvg(restrictions), [restrictions]);
  if (!spec) return null;
  return (
    <div className="flex items-center gap-2">
      <img
        src={spec.url}
        alt=""
        width={spec.width}
        height={spec.height}
        style={{ display: 'block' }}
      />
      <span className="text-slate-600">{label}</span>
    </div>
  );
}

// Part 9: collapsible legend that explains both the priority-flag color
// language and the restriction icons. Default collapsed; expanded state
// persists to localStorage. Lives directly under <FilterPanel/>.
function Legend({ expanded, setExpanded }) {
  return (
    <div className="border-t">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-slate-600 hover:bg-slate-50"
        aria-expanded={expanded}
      >
        <span className="inline-flex items-center gap-1.5">
          <Info size={13} /> Legend
        </span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-3 text-[11px]">
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Priority flag</div>
            <div className="space-y-1">
              {['red', 'yellow', 'green'].map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: FLAG_COLORS[k] }} />
                  <span className="capitalize">{k}</span>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: RESTRICTION_TINT }} />
                <span>Restricted (no flag set)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: UNFLAGGED_TINT }} />
                <span>No notes</span>
              </div>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Restricted stops</div>
            <p className="text-slate-600 mb-2 leading-snug">
              When a stop has equipment restrictions, the pin is replaced by the restriction icon(s) for quick visual scanning.
            </p>
            <div className="space-y-2">
              <LegendMarkerExample
                restrictions={['no_tractor_trailer']}
                label="Single restriction"
              />
              <LegendMarkerExample
                restrictions={['no_tractor_trailer', 'liftgate_required']}
                label="Multiple restrictions"
              />
              <LegendMarkerExample
                restrictions={['no_tractor_trailer', 'liftgate_required', 'appointment_required', 'no_overhead_clearance']}
                label="Four or more — first 2 + overflow"
              />
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Restriction icons</div>
            <div className="space-y-1">
              {Object.entries(RESTRICTION_ICONS).map(([key, def]) => (
                <div key={key} className="flex items-center gap-2">
                  <RestrictionIcon kind={key} size={16} />
                  <span>{def.label}</span>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-white text-[8px] font-bold" style={{ background: '#0f172a' }}>+N</span>
                <span className="text-slate-500">Three or more restrictions</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// M4.4 — Filter Toolbar. Floats over the map canvas at top-right with 5
// toggles. Collapsible. State persists to localStorage. Pure presentation;
// the parent applies filters to stops in applyMapFilters().
function MapFilterToggle({ label, checked, onChange, warning }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-slate-700">{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex-shrink-0 relative w-9 h-5 rounded-full transition-colors"
        style={{ background: checked ? '#16a34a' : '#cbd5e1' }}
      >
        <span
          className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform"
          style={{ left: checked ? 'calc(100% - 18px)' : '2px' }}
        />
      </button>
      {warning && (
        <span className="absolute right-0 -bottom-4 text-[9px] text-amber-700 italic">{warning}</span>
      )}
    </div>
  );
}

function FilterToolbar({ filters, setFilters, collapsed, setCollapsed, stopCount }) {
  const set = (key) => (v) => setFilters((prev) => ({ ...prev, [key]: v }));
  const clusterWarning = !filters.showClustered && stopCount > 200
    ? `Rendering ${stopCount} markers individually may be slow`
    : null;
  return (
    <div
      className="absolute top-4 right-4 bg-white rounded-lg shadow-md border border-slate-200"
      style={{ width: 240, zIndex: 5, opacity: 0.95 }}
    >
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-slate-700 hover:bg-slate-50 rounded-t-lg"
        aria-expanded={!collapsed}
      >
        <span className="inline-flex items-center gap-1.5">
          <Filter size={13} /> Filters
        </span>
        {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
      {!collapsed && (
        <div className="px-3 pb-2 border-t">
          <MapFilterToggle
            label="Hide terminal markers"
            checked={filters.hideTerminal}
            onChange={set('hideTerminal')}
          />
          <MapFilterToggle
            label="Hide stem out"
            checked={filters.hideStemOut}
            onChange={set('hideStemOut')}
          />
          <MapFilterToggle
            label="Show unplanned stops"
            checked={filters.showUnplanned}
            onChange={set('showUnplanned')}
          />
          <MapFilterToggle
            label="Show vehicle location"
            checked={filters.showVehicleLocation}
            onChange={set('showVehicleLocation')}
          />
          <MapFilterToggle
            label="Show clustered markers"
            checked={filters.showClustered}
            onChange={set('showClustered')}
          />
          {clusterWarning && (
            <div className="text-[10px] text-amber-700 italic mt-1 leading-tight">{clusterWarning}</div>
          )}
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
function ProsSection({ stop }) {
  const pros = stop.pros || (stop.pro ? [stop.pro] : []);
  const [copied, setCopied] = useState(null);
  const copy = (pro) => {
    try {
      navigator.clipboard.writeText(pro);
      setCopied(pro);
      setTimeout(() => setCopied((c) => (c === pro ? null : c)), 1200);
    } catch { /* clipboard blocked */ }
  };
  return (
    <div className="px-4 py-3 border-b">
      <div className="text-xs uppercase font-semibold text-slate-500 mb-1.5">
        PROs ({pros.length})
      </div>
      {pros.length === 0 ? (
        <div className="text-xs italic text-slate-400">— No PROs —</div>
      ) : (
        <div className="space-y-0.5">
          {pros.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => copy(p)}
              className="block w-full text-left font-mono text-xs text-slate-700 hover:bg-slate-100 px-1 py-0.5 rounded"
              title="Click to copy"
            >
              {p}
              {copied === p && <span className="ml-2 text-[10px] text-emerald-600 font-sans">copied</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StopSidebar({ stop, note, onClose, onSave, saving, saveError, mobile = false }) {
  const [draft, setDraft] = useState(() => note || emptyNote(stop));
  const [editing, setEditing] = useState(!note);
  useEffect(() => {
    setDraft(note || emptyNote(stop));
    setEditing(!note);
  }, [stop?.stopNbr, note?.id]);

  if (!stop) return null;
  const D = draft;
  const setD = (patch) => setDraft({ ...D, ...patch });
  // M4.4 — receiving_hours is now {open, close} per day. The setter accepts a
  // partial {open?, close?} so the two time inputs can update independently.
  // manual_overrides.receiving_hours is set to true on any per-day edit so
  // the scanner stops auto-populating after dispatcher touched it.
  const setHours = (day, partial) => {
    const existing = D.receiving_hours?.[day] || { open: '', close: '' };
    const merged = typeof existing === 'string'
      ? { open: '', close: '', ...partial }
      : { open: existing.open || '', close: existing.close || '', ...partial };
    setD({
      receiving_hours: { ...D.receiving_hours, [day]: merged },
      manual_overrides: { ...(D.manual_overrides || {}), receiving_hours: true },
    });
  };
  // Closed-day toggle. Switches whether `day` is in closed_days; sets the
  // matching manual_override so the scanner respects the dispatcher's choice.
  const toggleClosed = (day) => {
    const current = Array.isArray(D.closed_days) ? D.closed_days : [];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    setD({
      closed_days: next,
      manual_overrides: { ...(D.manual_overrides || {}), closed_days: true },
    });
  };
  const isClosed = (day) => Array.isArray(D.closed_days) && D.closed_days.includes(day);
  // Copy Monday's hours to Tue-Fri. If Monday is closed, weekdays inherit the
  // closed state too. No-op if Monday has no hours set AND isn't closed.
  const [copyToast, setCopyToast] = useState(false);
  const copyMondayToWeekdays = () => {
    const monClosed = isClosed('mon');
    const monHours = D.receiving_hours?.mon;
    const monHasHours = monHours && (typeof monHours === 'object' ? (monHours.open || monHours.close) : monHours);
    if (!monClosed && !monHasHours) return;
    const weekdays = ['tue', 'wed', 'thu', 'fri'];
    const patch = {
      receiving_hours: { ...(D.receiving_hours || {}) },
      closed_days: Array.isArray(D.closed_days) ? [...D.closed_days] : [],
      manual_overrides: {
        ...(D.manual_overrides || {}),
        receiving_hours: true,
        closed_days: true,
      },
    };
    for (const d of weekdays) {
      if (monClosed) {
        if (!patch.closed_days.includes(d)) patch.closed_days.push(d);
      } else {
        patch.closed_days = patch.closed_days.filter((x) => x !== d);
        patch.receiving_hours[d] = typeof monHours === 'string'
          ? monHours
          : { open: monHours.open || '', close: monHours.close || '' };
      }
    }
    setD(patch);
    setCopyToast(true);
    setTimeout(() => setCopyToast(false), 1500);
  };
  // Read helpers for the hours inputs — gracefully handle both legacy string
  // format and new {open, close} format so unmigrated docs still render.
  const getOpen = (day) => {
    const v = D.receiving_hours?.[day];
    if (!v) return '';
    if (typeof v === 'string') return '';
    return v.open || '';
  };
  const getClose = (day) => {
    const v = D.receiving_hours?.[day];
    if (!v) return '';
    if (typeof v === 'string') return '';
    return v.close || '';
  };
  const getLegacyString = (day) => {
    const v = D.receiving_hours?.[day];
    return typeof v === 'string' ? v : '';
  };
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
    <aside
      className={mobile
        ? "absolute inset-0 bg-white shadow-lg flex flex-col overflow-hidden z-40"
        : "w-[380px] flex-shrink-0 bg-white border-l shadow-lg flex flex-col h-full overflow-hidden"
      }
      style={mobile ? { paddingBottom: 'env(safe-area-inset-bottom)' } : undefined}
    >
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

        {/* PROs section — click any to copy */}
        <ProsSection stop={stop} />

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
                {/* M4.4 — Per-day Open/Closed toggle row. Clicking a day flips
                whether it's in closed_days. Closed days hide their time inputs
                below and show "Closed" + Re-open link. */}
                <div className="grid grid-cols-7 gap-1 mb-2">
                  {DAYS.map((d) => {
                    const closed = isClosed(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => toggleClosed(d)}
                        className={`text-[10px] uppercase font-semibold py-1 rounded border ${closed ? 'bg-red-100 border-red-300 text-red-700' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'}`}
                        title={closed ? `${d.toUpperCase()} closed — click to open` : `${d.toUpperCase()} open — click to mark closed`}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
                {/* Copy-to-weekdays helper. */}
                <div className="flex items-center gap-2 mb-2">
                  <button
                    type="button"
                    onClick={copyMondayToWeekdays}
                    disabled={!isClosed('mon') && !(D.receiving_hours?.mon && (
                      typeof D.receiving_hours.mon === 'string'
                        ? D.receiving_hours.mon
                        : (D.receiving_hours.mon.open || D.receiving_hours.mon.close)
                    ))}
                    className="text-[10px] py-1 px-2 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Apply Monday's hours/closed state to Tuesday-Friday"
                  >
                    Copy to all weekdays (Mon-Fri)
                  </button>
                  {copyToast && <span className="text-[10px] text-emerald-600">Copied</span>}
                </div>
                {/* Per-day rows. Closed days show "Closed" label + an inline
                re-open button so dispatcher doesn't have to scroll back up. */}
                <div className="space-y-1">
                  {DAYS.map((d) => {
                    const closed = isClosed(d);
                    const legacy = getLegacyString(d);
                    return (
                      <div key={d} className="flex items-center gap-2">
                        <div className="w-10 text-[10px] uppercase font-semibold text-slate-500">{d}</div>
                        {closed ? (
                          <div className="flex-1 flex items-center justify-between gap-2 px-2 py-1 rounded bg-red-50 border border-red-200">
                            <span className="text-[11px] font-semibold text-red-700">Closed</span>
                            <button
                              type="button"
                              onClick={() => toggleClosed(d)}
                              className="text-[10px] text-blue-600 hover:underline"
                            >
                              Edit
                            </button>
                          </div>
                        ) : (
                          <div className="flex-1 flex items-center gap-1">
                            <input
                              type="time"
                              value={getOpen(d)}
                              onChange={(e) => setHours(d, { open: e.target.value })}
                              className="flex-1 border border-slate-300 rounded px-1 py-1 text-[11px]"
                              aria-label={`${d} open time`}
                            />
                            <span className="text-[10px] text-slate-400">–</span>
                            <input
                              type="time"
                              value={getClose(d)}
                              onChange={(e) => setHours(d, { close: e.target.value })}
                              className="flex-1 border border-slate-300 rounded px-1 py-1 text-[11px]"
                              aria-label={`${d} close time`}
                            />
                          </div>
                        )}
                        {legacy && !closed && (
                          <div className="text-[9px] text-amber-700 italic" title={`Legacy free-text value: ${legacy}`}>(legacy)</div>
                        )}
                      </div>
                    );
                  })}
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
                        className={`px-2 py-0.5 rounded-full text-[11px] border inline-flex items-center gap-1.5 ${active ? 'bg-purple-600 text-white border-purple-600' : 'bg-white border-slate-300 text-slate-700'}`}
                      >
                        <RestrictionIcon kind={o.value} size={14} />
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

function DriverSnapshotSidebar({ driver, snapshot, loading, error, onClose, onPanToStop, mobile = false }) {
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
    <aside
      className={mobile
        ? "absolute inset-0 bg-white shadow-lg flex flex-col overflow-hidden z-40"
        : "w-[380px] flex-shrink-0 bg-white border-l shadow-lg flex flex-col h-full overflow-hidden"
      }
      style={mobile ? { paddingBottom: 'env(safe-area-inset-bottom)' } : undefined}
    >
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
                        {(s.primaryPro || s.pro) && (
                          <span
                            className="font-mono text-[10px] text-slate-400"
                            title={(s.pros || (s.pro ? [s.pro] : [])).join('\n')}
                          >
                            {s.primaryPro || s.pro}
                            {((s.proCount ?? (s.pros?.length || 0)) > 1) && (
                              <span className="text-slate-300"> +{(s.proCount ?? s.pros.length) - 1}</span>
                            )}
                          </span>
                        )}
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
  if (note.appointment_required) {
    items.push({
      k: 'Appointment',
      v: (
        <span className="inline-flex items-center gap-1.5">
          <RestrictionIcon kind="appointment_required" size={14} />
          Required{note.appointment_notes ? ` — ${note.appointment_notes}` : ''}
        </span>
      ),
    });
  }
  if (note.liftgate_required) {
    items.push({
      k: 'Liftgate',
      v: (
        <span className="inline-flex items-center gap-1.5">
          <RestrictionIcon kind="liftgate_required" size={14} />
          Required
        </span>
      ),
    });
  }
  if (note.dock_type) items.push({ k: 'Dock', v: note.dock_type.replace('_', ' ') });
  if (note.equipment_restrictions?.length) {
    items.push({
      k: 'Restrictions',
      v: (
        <ul className="space-y-1 mt-0.5">
          {note.equipment_restrictions.map((r) => {
            const key = resolveRestrictionKey(r);
            const label = RESTRICTION_ICONS[key]?.label
              || EQUIPMENT_OPTIONS.find((o) => o.value === r)?.label
              || r;
            return (
              <li key={r} className="inline-flex items-center gap-1.5 mr-2">
                <RestrictionIcon kind={r} size={14} />
                <span>{label}</span>
              </li>
            );
          })}
        </ul>
      ),
    });
  }
  // M4.4 — receiving_hours can be legacy strings or {open, close} objects.
  // Display: "8AM-2PM" style for legacy, "08:00-14:00" for structured, or "Closed"
  // if the day is in note.closed_days. "—" means no hours set.
  const closedSet = new Set(Array.isArray(note.closed_days) ? note.closed_days : []);
  const hoursAny = Object.entries(note.receiving_hours || {}).some(([d, v]) => {
    if (closedSet.has(d)) return true;
    if (!v) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    return !!(v.open || v.close);
  }) || closedSet.size > 0;
  const renderDayHours = (d) => {
    if (closedSet.has(d)) return 'Closed';
    const v = note.receiving_hours?.[d];
    if (!v) return '—';
    if (typeof v === 'string') return v;
    if (v.open && v.close) return `${v.open}–${v.close}`;
    return v.open || v.close || '—';
  };
  if (hoursAny) {
    items.push({
      k: 'Hours',
      v: (
        <div className="grid grid-cols-7 gap-1 mt-1">
          {DAYS.map((d) => (
            <div key={d} className="text-center">
              <div className="text-[9px] uppercase text-slate-500">{d}</div>
              <div className={`text-[10px] ${closedSet.has(d) ? 'text-red-600 font-semibold' : ''}`}>{renderDayHours(d)}</div>
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

// ---------- M4.5 mobile (<768px) layout primitives ----------
// Compact 48px brand-blue top bar that replaces the desktop header below
// MOBILE_BREAKPOINT. Renders the "D" mark, "Dispatch" label, and a tap-able
// version chip on the right. Tapping the chip toggles a small overflow menu
// the parent owns (Diagnostics access lives here, per brief P5.1).
function MobileAppBar({ version, onChipMenu, chipMenuOpen, onSelectMenu }) {
  return (
    <header
      className="flex-shrink-0 flex items-center justify-between px-3 text-white relative"
      style={{
        background: BRAND,
        height: 48,
        paddingTop: 'env(safe-area-inset-top)',
      }}
    >
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded flex items-center justify-center bg-white/15 text-white font-bold text-[11px]">D</div>
        <span className="font-semibold text-[14px] leading-none">Dispatch</span>
      </div>
      <div className="relative">
        <button
          onClick={onChipMenu}
          className="text-[10px] px-1.5 py-1 rounded bg-white/15 text-white/80 active:bg-white/25"
          aria-haspopup="menu"
          aria-expanded={chipMenuOpen}
          title="Version menu"
        >
          v{version}
        </button>
        {chipMenuOpen && (
          <div
            className="absolute top-full right-0 mt-1 bg-white text-slate-800 rounded shadow-lg border border-slate-200 text-xs min-w-[140px] z-50"
            role="menu"
          >
            <button
              className="w-full text-left px-3 py-2 hover:bg-slate-50 inline-flex items-center gap-2"
              onClick={() => onSelectMenu('diagnostics')}
              role="menuitem"
            >
              <Activity size={12} /> Diagnostics
            </button>
            <button
              className="w-full text-left px-3 py-2 hover:bg-slate-50 inline-flex items-center gap-2 border-t border-slate-100"
              onClick={() => onSelectMenu('map')}
              role="menuitem"
            >
              <MapPin size={12} /> Map
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

// Floating action button. 56px circle, bottom-right above safe area. Rotates 45°
// to act as an × close button when the drawer is open. Caller owns the open
// state.
function MobileFAB({ open, onToggle }) {
  return (
    <button
      onClick={onToggle}
      aria-label={open ? 'Close drawer' : 'Open drawer'}
      className="absolute rounded-full text-white flex items-center justify-center transition-transform"
      style={{
        background: BRAND,
        width: 56,
        height: 56,
        right: 16,
        bottom: `calc(16px + env(safe-area-inset-bottom))`,
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        transform: open ? 'rotate(45deg)' : 'rotate(0deg)',
        zIndex: 30,
      }}
    >
      {open ? <X size={24} /> : <LayoutList size={22} />}
    </button>
  );
}

// Drawer that slides up from the bottom edge. Three sizes (mini/default/expanded);
// the drag handle moves between them. Default 60vh, mini 30vh, expanded 95vh.
// Backdrop dims behind the drawer and dismisses on tap.
//
// Touch handling is implemented with native events (no library) — vertical
// pointer drags on the handle adjust the height; release snaps to the nearest
// of the three preset stops, with a downward fling past the mini stop closing
// the drawer.
const DRAWER_HEIGHTS = { mini: 0.30, default: 0.60, expanded: 0.95 };

function MobileDrawer({ open, onClose, activeTab, setActiveTab, children }) {
  const [heightFrac, setHeightFrac] = useState(DRAWER_HEIGHTS.default);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef({ startY: 0, startFrac: DRAWER_HEIGHTS.default });

  // Reset height to default each time the drawer opens.
  useEffect(() => {
    if (open) setHeightFrac(DRAWER_HEIGHTS.default);
  }, [open]);

  const onPointerDown = (e) => {
    e.preventDefault();
    setDragging(true);
    dragRef.current = {
      startY: e.touches ? e.touches[0].clientY : e.clientY,
      startFrac: heightFrac,
    };
    const move = (ev) => {
      const y = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const delta = y - dragRef.current.startY;
      const vh = window.innerHeight || 1;
      // Drag down increases y → smaller height; drag up → larger height.
      const next = Math.max(0.15, Math.min(0.97, dragRef.current.startFrac - delta / vh));
      setHeightFrac(next);
    };
    const up = (ev) => {
      const y = ev.changedTouches ? ev.changedTouches[0].clientY : ev.clientY;
      const delta = y - dragRef.current.startY;
      const vh = window.innerHeight || 1;
      const finalFrac = Math.max(0.15, Math.min(0.97, dragRef.current.startFrac - delta / vh));
      // Snap to nearest preset; close if dragged below the mini stop.
      if (finalFrac < 0.22 && delta > 60) {
        setDragging(false);
        onClose();
        return;
      }
      const candidates = Object.values(DRAWER_HEIGHTS);
      const snapped = candidates.reduce((best, c) =>
        Math.abs(c - finalFrac) < Math.abs(best - finalFrac) ? c : best,
        candidates[0],
      );
      setHeightFrac(snapped);
      setDragging(false);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up);
  };

  // Always render to allow the slide-up animation. Translates fully offscreen
  // when closed.
  const drawerHeight = `${(heightFrac * 100).toFixed(1)}vh`;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="absolute inset-0 transition-opacity"
        style={{
          background: 'rgba(0,0,0,0.30)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          zIndex: 20,
        }}
      />
      <div
        className="absolute left-0 right-0 bottom-0 bg-white rounded-t-2xl shadow-2xl flex flex-col"
        style={{
          height: drawerHeight,
          transform: open ? 'translateY(0)' : 'translateY(100%)',
          transition: dragging ? 'none' : 'transform 220ms ease-out, height 180ms ease-out',
          paddingBottom: 'env(safe-area-inset-bottom)',
          zIndex: 25,
        }}
        role="dialog"
        aria-modal="true"
      >
        {/* Drag handle */}
        <div
          onMouseDown={onPointerDown}
          onTouchStart={onPointerDown}
          className="flex-shrink-0 py-2 flex items-center justify-center cursor-grab active:cursor-grabbing select-none"
          style={{ touchAction: 'none' }}
        >
          <div className="w-8 h-1 rounded-full bg-slate-300" />
        </div>
        {/* Tab header */}
        <div className="flex-shrink-0 flex border-b border-slate-200">
          {[
            { id: 'stops', label: 'Stops' },
            { id: 'filters', label: 'Filters' },
            { id: 'drivers', label: 'Drivers' },
          ].map((t) => {
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`flex-1 py-3 text-sm font-semibold transition-colors ${active ? '' : 'text-slate-500'}`}
                style={{
                  color: active ? BRAND : undefined,
                  borderBottom: active ? `2px solid ${BRAND}` : '2px solid transparent',
                  minHeight: 44,
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {/* Tab content */}
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
      </div>
    </>
  );
}

// Stops tab content. Search input + count + list of cards (one tap = pick stop).
function MobileStopsTab({
  stops, notes, searchInput, setSearchInput,
  resultCount, totalCount, onPickStop,
}) {
  return (
    <div className="flex flex-col">
      <div className="p-3 border-b border-slate-100">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Customer, PRO, city, address…"
            className="w-full pl-8 pr-3 border border-slate-300 rounded-lg text-sm"
            style={{ minHeight: 44 }}
          />
        </div>
        <div className="text-[11px] text-slate-500 mt-1.5 px-0.5">
          Showing <span className="font-semibold text-slate-700">{resultCount}</span> of {totalCount} stops
        </div>
      </div>
      <div className="divide-y divide-slate-100">
        {stops.length === 0 && (
          <div className="text-xs text-slate-400 italic px-4 py-6 text-center">
            No stops match the current filters.
          </div>
        )}
        {stops.map((s) => (
          <MobileStopCard
            key={s.stopNbr}
            stop={s}
            note={notes.get(s.matchKey)}
            onPick={() => onPickStop(s)}
          />
        ))}
      </div>
    </div>
  );
}

function MobileStopCard({ stop, note, onPick }) {
  const flag = note?.priority_flag;
  const restricted = !!(note && note.equipment_restrictions?.length);
  const swatch = flag ? FLAG_COLORS[flag] : (restricted ? RESTRICTION_TINT : '#cbd5e1');
  return (
    <button
      onClick={onPick}
      className="w-full flex items-center gap-3 px-4 text-left active:bg-slate-100"
      style={{ minHeight: 64 }}
    >
      <span
        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
        style={{ background: swatch }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-900 truncate">
          {stop.businessName || '(no name)'}
        </div>
        <div className="text-[11px] text-slate-500 truncate">
          {stop.city || '—'}{stop.state ? `, ${stop.state}` : ''}
        </div>
      </div>
      {stop.pro && (
        <span className="font-mono text-[10px] text-slate-500 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5 flex-shrink-0">
          {stop.pro}
        </span>
      )}
    </button>
  );
}

// Filters tab. Re-uses the desktop FilterPanel's behavior (everything is just
// props on the same filters object) and adds the M4.4 map-toolbar toggles
// stacked underneath. Clustering toggle is forced ON + warning shown.
function MobileFiltersTab({
  filters, setFilters, counts,
  mapFilters, setMapFilters,
}) {
  const setMF = (key) => (v) => setMapFilters((prev) => ({ ...prev, [key]: v }));
  return (
    <div className="flex flex-col">
      <FilterPanel filters={filters} setFilters={setFilters} counts={counts} />
      <div className="border-t px-3 py-3">
        <div className="text-xs font-semibold text-slate-600 mb-2">Map display</div>
        <div className="space-y-1.5">
          <MapFilterToggle
            label="Hide terminal markers"
            checked={mapFilters.hideTerminal}
            onChange={setMF('hideTerminal')}
          />
          <MapFilterToggle
            label="Hide stem out"
            checked={mapFilters.hideStemOut}
            onChange={setMF('hideStemOut')}
          />
          <MapFilterToggle
            label="Show unplanned stops"
            checked={mapFilters.showUnplanned}
            onChange={setMF('showUnplanned')}
          />
          <MapFilterToggle
            label="Show vehicle location"
            checked={mapFilters.showVehicleLocation}
            onChange={setMF('showVehicleLocation')}
          />
          {/* Clustering required on mobile — see brief P3.4. */}
          <div className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-xs text-slate-700">Show clustered markers</span>
            <span className="text-[10px] uppercase text-amber-700 italic">required on mobile</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Drivers tab. Tap a driver row → caller centers the map and opens the
// driver-snapshot UI (in PR 1 that's still the existing right-side sidebar;
// PR 2 will replace it with a drawer).
function MobileDriversTab({ drivers, error, onPickDriver }) {
  if (error) {
    return (
      <div className="px-4 py-6 text-xs text-red-600">⚠ {error}</div>
    );
  }
  if (!drivers || drivers.length === 0) {
    return (
      <div className="px-4 py-6 text-xs text-slate-400 italic text-center">
        No active drivers.
      </div>
    );
  }
  return (
    <div className="divide-y divide-slate-100">
      {drivers.map((d) => (
        <button
          key={d.id || d.truckNumber}
          onClick={() => onPickDriver(d)}
          className="w-full flex items-center gap-3 px-4 text-left active:bg-slate-100"
          style={{ minHeight: 56 }}
        >
          <Truck size={18} className="text-slate-500 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-slate-900 truncate">
              <span className="font-semibold">{d.truckNumber || '—'}</span>
              {d.driverName ? <span className="text-slate-600"> · {d.driverName}</span> : null}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {d.status || (d.lastSeenAgo ? `last seen ${d.lastSeenAgo}` : 'unknown')}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function MapScreen() {
  const { stops, loading, error, lastRefreshed, source, refresh } = useStops();
  const { notes, ready: notesReady } = useCustomerNotes();
  useAutoScanner(stops, notes, notesReady);
  const { google, error: mapsError } = useGoogleMaps();
  const viewportWidth = useViewportWidth();
  const isMobile = viewportWidth < MOBILE_BREAKPOINT;

  const [selectedStop, setSelectedStop] = useState(null);
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [filters, setFilters] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [showDriverLabels, setShowDriverLabels] = useState(() => safeReadJSON(LS_DRIVER_LABELS, true));
  const [legendExpanded, setLegendExpanded] = useState(() => safeReadJSON(LS_LEGEND_EXPANDED, false));
  const [tableColumns, setTableColumns] = useState(() => ({
    ...DEFAULT_TABLE_COLUMNS,
    ...safeReadJSON(LS_TABLE_COLUMNS, {}),
  }));
  // M4.4 — Map filter toolbar state. The "Show vehicle location" toggle is the
  // same Motive driver overlay that previously lived in the left panel; the
  // duplicate left-panel toggle is removed.
  const [mapFilters, setMapFilters] = useState(() => ({
    ...DEFAULT_MAP_FILTERS,
    ...safeReadJSON(LS_MAP_FILTERS, {}),
  }));
  const [toolbarCollapsed, setToolbarCollapsed] = useState(() => safeReadJSON(LS_FILTER_TOOLBAR_COLLAPSED, false));
  // M4.5 — Mobile drawer is closed by default on every load; active tab is
  // restored from localStorage so repeat dispatchers land where they left off.
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [mobileDrawerTab, setMobileDrawerTab] = useState(() => {
    const t = safeReadJSON(LS_MOBILE_DRAWER_TAB, 'stops');
    return ['stops', 'filters', 'drivers'].includes(t) ? t : 'stops';
  });
  const showDrivers = mapFilters.showVehicleLocation;
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
  useEffect(() => { safeWriteJSON(LS_LEGEND_EXPANDED, legendExpanded); }, [legendExpanded]);
  useEffect(() => { safeWriteJSON(LS_TABLE_COLUMNS, tableColumns); }, [tableColumns]);
  useEffect(() => { safeWriteJSON(LS_MAP_FILTERS, mapFilters); }, [mapFilters]);
  useEffect(() => { safeWriteJSON(LS_FILTER_TOOLBAR_COLLAPSED, toolbarCollapsed); }, [toolbarCollapsed]);
  useEffect(() => { safeWriteJSON(LS_MOBILE_DRAWER_TAB, mobileDrawerTab); }, [mobileDrawerTab]);

  // M4.4 — Compute stem-out set client-side. Stem-out = first non-terminal stop
  // in each load (i.e. the outbound leg from terminal to first customer).
  // Stops without a load assignment can't be marked stem-out.
  const stemOutKeys = useMemo(() => {
    const firstSeqByLoad = new Map();
    for (const s of stops) {
      if (!s.loadNbr || s.isTerminal || s.loadStopSeq == null) continue;
      const prev = firstSeqByLoad.get(s.loadNbr);
      if (prev == null || s.loadStopSeq < prev.seq) {
        firstSeqByLoad.set(s.loadNbr, { seq: s.loadStopSeq, key: s.stopNbr });
      }
    }
    const out = new Set();
    for (const v of firstSeqByLoad.values()) if (v.key) out.add(v.key);
    return out;
  }, [stops]);

  // M4.4 — Apply filter toolbar toggles after the existing flag/restriction
  // filter pipeline. Each toggle is a simple inclusion/exclusion test.
  const applyMapFilters = useCallback((rows) => {
    return rows.filter((s) => {
      if (mapFilters.hideTerminal && s.isTerminal) return false;
      if (mapFilters.hideStemOut && stemOutKeys.has(s.stopNbr)) return false;
      if (!mapFilters.showUnplanned && s.isUnplanned) return false;
      return true;
    });
  }, [mapFilters.hideTerminal, mapFilters.hideStemOut, mapFilters.showUnplanned, stemOutKeys]);

  // Filter pipeline: filters → mapFilters → search. Memoized so we don't recompute on each render.
  const filteredStops = useMemo(
    () => applyMapFilters(applyFilters(stops, notes, filters)),
    [stops, notes, filters, applyMapFilters],
  );
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
      const restrictions = getRestrictionBadgeKeys(note);
      const dim = searchMatchSet && !searchMatchSet.has(s.stopNbr);
      // M4.1.6 — no restrictions → classic pin (State A). 1+ restrictions →
      // the pin disappears and the icon(s) become the marker (States B/C).
      // iconMarkerSvg returns size + anchor based on icon count.
      let icon;
      if (restrictions.length === 0) {
        const color = flagColor(note);
        icon = {
          url: pinSvgClassic(color),
          scaledSize: new google.maps.Size(28, 36),
          anchor: new google.maps.Point(14, 34),
        };
      } else {
        const spec = iconMarkerSvg(restrictions);
        icon = {
          url: spec.url,
          scaledSize: new google.maps.Size(spec.width, spec.height),
          anchor: new google.maps.Point(spec.anchor[0], spec.anchor[1]),
        };
      }
      const marker = new google.maps.Marker({
        position: { lat: s.lat, lng: s.lng },
        icon,
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
    // M4.4 — when clustering is disabled, attach markers directly to the map
    // instead of routing through MarkerClusterer. Skipping clustering on 600+
    // pins is intentionally slow at zoom-out; the toolbar surfaces a warning.
    if (mapFilters.showClustered) {
      clustererRef.current = new MarkerClusterer({ map: mapRef.current, markers: newMarkers });
    } else {
      newMarkers.forEach((m) => m.setMap(mapRef.current));
    }
  }, [google, filteredStops, notes, searchMatchSet, mapFilters.showClustered]);

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

  // Per brief width tiers (still used for the customer-name truncation cutoff):
  //   240-300px: compact (names truncate)
  //   300px+:    extended names
  // Column visibility itself is user-controlled via the Columns gear (persisted
  // to LS_TABLE_COLUMNS).
  const useExtendedNames = !isMobile && panel.width >= 300;

  // Mobile path: map fills the area, FAB + drawer surface the lists/filters,
  // and the existing stop/driver sidebars switch to absolute full-screen
  // overlay mode. PR 2 of M4.5 will swap those overlays for proper drawers.
  if (isMobile) {
    const pickStopFromMobile = (s) => {
      setSelectedDriver(null);
      setSelectedStop(s);
      setMobileDrawerOpen(false);
      if (google && mapRef.current && s.lat != null && s.lng != null) {
        mapRef.current.panTo({ lat: s.lat, lng: s.lng });
        mapRef.current.setZoom(Math.max(mapRef.current.getZoom() || 10, 14));
      }
    };
    const pickDriverFromMobile = (d) => {
      setSelectedStop(null);
      setSelectedDriver(d);
      setMobileDrawerOpen(false);
      if (google && mapRef.current && d.lat != null && d.lng != null) {
        mapRef.current.panTo({ lat: d.lat, lng: d.lng });
        mapRef.current.setZoom(Math.max(mapRef.current.getZoom() || 10, 13));
      }
    };
    return (
      <div className="flex-1 relative min-w-0 overflow-hidden">
        <div ref={mapDiv} className="absolute inset-0" />
        {mapsError && (
          <div className="absolute top-2 left-2 right-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-800 z-10">
            <div className="font-semibold">Google Maps failed to load</div>
            <div className="mt-0.5">{mapsError}</div>
          </div>
        )}
        {!visibleStops.length && !loading && !mapsError && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-white border border-slate-200 rounded shadow px-3 py-1 text-[11px] text-slate-600 z-10">
            {debouncedSearch ? `No stops match "${debouncedSearch}"` : 'No stops match filters'}
          </div>
        )}

        {/* Compact status pill — top-right, below the app bar */}
        <div className="absolute top-2 right-2 bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow px-2.5 py-1.5 flex items-center gap-2 text-[11px] z-10">
          <div className="leading-tight">
            <div className="font-semibold">{stops.length} stops</div>
            <div className="text-slate-500 text-[10px]">{source === 'fixture' ? 'MOCK' : 'NuVizz'} · {fmtTimeAgo(lastRefreshed)}</div>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="p-1 rounded hover:bg-slate-100 active:bg-slate-200 disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {error && (
          <div className="absolute bottom-24 left-2 right-2 bg-red-50 border border-red-200 rounded px-2 py-1 text-[11px] text-red-700 z-10">
            ⚠ {error}
          </div>
        )}

        {/* APP_VERSION chip — above the FAB so they don't overlap.
            Brief P3.5: 11px gray, white background. */}
        <div
          className="absolute right-3 text-[11px] text-slate-500 bg-white/95 rounded px-1.5 py-0.5 z-10 border border-slate-200"
          style={{ bottom: `calc(80px + env(safe-area-inset-bottom))` }}
        >
          v{APP_VERSION}
        </div>

        {/* FAB (hidden when stop/driver overlay is showing — the overlay's
            own Close button is the primary way out at that point). */}
        {!selectedStop && !selectedDriver && (
          <MobileFAB
            open={mobileDrawerOpen}
            onToggle={() => setMobileDrawerOpen((v) => !v)}
          />
        )}

        <MobileDrawer
          open={mobileDrawerOpen}
          onClose={() => setMobileDrawerOpen(false)}
          activeTab={mobileDrawerTab}
          setActiveTab={setMobileDrawerTab}
        >
          {mobileDrawerTab === 'stops' && (
            <MobileStopsTab
              stops={visibleStops}
              notes={notes}
              searchInput={searchInput}
              setSearchInput={setSearchInput}
              resultCount={visibleStops.length}
              totalCount={filteredStops.length}
              onPickStop={pickStopFromMobile}
            />
          )}
          {mobileDrawerTab === 'filters' && (
            <MobileFiltersTab
              filters={filters}
              setFilters={setFilters}
              counts={{ visible: visibleStops.length, total: stops.length }}
              mapFilters={mapFilters}
              setMapFilters={setMapFilters}
            />
          )}
          {mobileDrawerTab === 'drivers' && (
            <MobileDriversTab
              drivers={drivers}
              error={driverErr}
              onPickDriver={pickDriverFromMobile}
            />
          )}
        </MobileDrawer>

        {/* Stop/driver detail overlays — temporary full-screen renders of the
            existing sidebars until PR 2 of M4.5 replaces them with drawers. */}
        {selectedDriver && (
          <DriverSnapshotSidebar
            driver={selectedDriver}
            snapshot={snapshot}
            loading={snapshotLoading}
            error={snapshotError}
            onClose={() => setSelectedDriver(null)}
            onPanToStop={handlePanToStop}
            mobile
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
            mobile
          />
        )}
      </div>
    );
  }

  // Desktop / tablet (≥768px): existing layout unchanged.
  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left filter rail */}
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
        <Legend expanded={legendExpanded} setExpanded={setLegendExpanded} />
        {/* M4.4 — Vehicle visibility moved to the map filter toolbar. This
        block keeps only the driver-status text + label-toggle, which are
        secondary to the visibility decision. Hidden entirely when vehicles
        are off. */}
        {showDrivers && (
          <div className="border-t p-3 space-y-2">
            <button
              onClick={() => setShowDriverLabels((v) => !v)}
              className="w-full text-xs py-1 rounded inline-flex items-center justify-center gap-1.5 bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
              title="Toggle truck/driver labels"
            >
              {showDriverLabels ? <Tags size={12} /> : <Tag size={12} />}
              {showDriverLabels ? 'Hide labels' : 'Show labels'}
            </button>
            <div className="text-[10px] text-slate-500">
              {driverErr ? <span className="text-red-600">⚠ {driverErr}</span> : `${drivers.length} drivers · refresh 60s${driversAt ? ` · ${fmtTimeAgo(driversAt)}` : ''}`}
            </div>
          </div>
        )}

        <StopMiniTable
          stops={visibleStops}
          notes={notes}
          onPick={(s) => { setSelectedDriver(null); setSelectedStop(s); }}
          columns={tableColumns}
          onColumnsChange={setTableColumns}
          searchQuery={debouncedSearch}
          truncateNames={!useExtendedNames}
        />
      </div>

      {/* Resize handle — desktop only */}
      <ResizeHandle onMouseDown={panel.onMouseDown} onDoubleClick={panel.onDoubleClick} />

      {/* Map */}
      <div className="flex-1 relative min-w-0">
        <div ref={mapDiv} className="absolute inset-0" />
        <FilterToolbar
          filters={mapFilters}
          setFilters={setMapFilters}
          collapsed={toolbarCollapsed}
          setCollapsed={setToolbarCollapsed}
          stopCount={filteredStops.length}
        />
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

// Render the PRO cell content per brief: matched PRO first when a search is
// active; "+N" suffix when proCount > 1; em dash when empty. Returns a
// fragment so the parent <td> stays the layout boundary.
function renderProCell(stop, searchQuery) {
  const pros = stop.pros || (stop.pro ? [stop.pro] : []);
  if (pros.length === 0) return <span>—</span>;
  const matched = searchQuery ? matchedPro(stop, searchQuery) : null;
  const head = matched || pros[0];
  const rest = pros.length - 1;
  const tooltip = pros.length > 1 ? pros.join('\n') : undefined;
  return (
    <span title={tooltip} tabIndex={pros.length > 1 ? 0 : -1}>
      {head}{rest > 0 ? <span className="text-slate-400"> +{rest}</span> : null}
    </span>
  );
}

// Columns gear menu — anchored to the top-right of the StopMiniTable header.
// Click toggles a checkbox; localStorage persistence is handled by parent.
function ColumnsMenu({ columns, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="p-1 rounded hover:bg-slate-100 text-slate-500"
        title="Toggle table columns"
        aria-label="Toggle table columns"
      >
        <Settings size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-10 bg-white border border-slate-200 rounded shadow-md py-1 min-w-[140px]">
          {TABLE_COLUMN_DEFS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={!!columns[key]}
                onChange={(e) => onChange({ ...columns, [key]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function StopMiniTable({ stops, notes, onPick, columns, onColumnsChange, searchQuery = '', truncateNames = true }) {
  const cols = columns || DEFAULT_TABLE_COLUMNS;
  // Decorate rows with flag for sorting. _proSort puts empty PROs last for asc.
  const rows = useMemo(() => stops.map((s) => {
    const n = notes.get(s.matchKey);
    return {
      ...s,
      _flag: n?.priority_flag || 'none',
      _hasNote: !!n,
      _priorityRank: n?.priority_flag === 'red' ? 0 : n?.priority_flag === 'yellow' ? 1 : n?.priority_flag === 'green' ? 2 : 3,
      _proSort: s.primaryPro || s.pro || '￿',
    };
  }), [stops, notes]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, 'businessName', 'asc');
  // Horizontal scroll if columns exceed panel width.
  return (
    <div className="border-t">
      <div className="px-3 py-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-600">Stops ({rows.length})</div>
        {onColumnsChange && <ColumnsMenu columns={cols} onChange={onColumnsChange} />}
      </div>
      <div className="max-h-[40vh] overflow-y-auto overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 sticky top-0">
            <tr>
              {cols.flag && <SortableTh label="Flag" k="_flag" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
              {cols.customer && <SortableTh label="Customer" k="businessName" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
              {cols.city && <SortableTh label="City" k="city" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
              {cols.pro && <SortableTh label="PRO" k="_proSort" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
              {cols.priority && <SortableTh label="Pri" k="_priorityRank" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />}
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.stopNbr} onClick={() => onPick(s)} className="cursor-pointer hover:bg-blue-50 border-t">
                {cols.flag && (
                  <td className="px-2 py-1">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: s._flag !== 'none' ? FLAG_COLORS[s._flag] : (s._hasNote ? RESTRICTION_TINT : '#cbd5e1') }} />
                  </td>
                )}
                {cols.customer && (
                  <td
                    className={`px-2 py-1 ${truncateNames ? 'truncate max-w-[160px]' : ''}`}
                    title={s.businessName}
                    style={!truncateNames ? { maxWidth: 320 } : undefined}
                  >
                    {s.businessName}
                  </td>
                )}
                {cols.city && <td className="px-2 py-1 text-slate-600 whitespace-nowrap">{s.city}</td>}
                {cols.pro && (
                  <td className="px-2 py-1 font-mono text-[10px] text-slate-500 whitespace-nowrap">
                    {renderProCell(s, searchQuery)}
                  </td>
                )}
                {cols.priority && (
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
  const viewportWidth = useViewportWidth();
  const isMobile = viewportWidth < MOBILE_BREAKPOINT;
  const [chipMenuOpen, setChipMenuOpen] = useState(false);

  // Close chip menu on any tab change or click outside the bar.
  useEffect(() => { setChipMenuOpen(false); }, [tab]);

  const onSelectMenu = (next) => {
    setChipMenuOpen(false);
    setTab(next === 'diagnostics' ? 'diag' : 'map');
  };

  return (
    <div className="h-screen flex flex-col">
      {isMobile ? (
        <MobileAppBar
          version={APP_VERSION}
          chipMenuOpen={chipMenuOpen}
          onChipMenu={() => setChipMenuOpen((v) => !v)}
          onSelectMenu={onSelectMenu}
        />
      ) : (
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
      )}

      {tab === 'map' ? <MapScreen /> : <DiagnosticsRoute />}

      {/* Footer is desktop/tablet only on mobile; the in-map version chip
          and the top-bar chip cover the same info on small screens. */}
      {!isMobile && (
        <footer className="border-t bg-white px-4 py-1 text-[10px] text-slate-400 flex items-center justify-between">
          <div>Dispatch Map v{APP_VERSION} · {BUILD_COMMIT}{BUILD_TIME ? ` · built ${BUILD_TIME.slice(5, 16).replace('T', ' ')}Z` : ''}</div>
          <div className="hidden sm:block">© Davis Delivery Service</div>
        </footer>
      )}
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
