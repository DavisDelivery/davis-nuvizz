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
  Info, Settings, LayoutList, Sparkles, MessageSquare,
} from 'lucide-react';
import {
  collection, doc, getDoc, onSnapshot, setDoc, serverTimestamp,
  query, orderBy, updateDoc, deleteDoc,
} from 'firebase/firestore';

import { db } from './lib/firebase.js';
import { normalizeMatchKey } from './lib/matchKey.js';
import { haversineMiles, naiveEtaMinutes, formatEtaClockTime } from './lib/distance.js';
import { todayInET, isTodayET, formatDateForDisplay, formatDateLong } from './lib/date-util.js';
import { pointInPolygon, latLngInBounds, boxFromCorners, formatReceivingHours, lineItemDims, moveItem, recomputeRoute, resequence, fmtTime12, DEFAULT_SERVICE_SEC } from './lib/routing-select.js';
import { formatDateTime, tsToMillis, loadSummary, buildLoadAutoName } from './lib/routing-loads.js';
import { scanStop, scanStopFull } from './lib/signal-scanner';
import { applyScannerResults } from './lib/customer-notes-writer';
import { aiParse, aiChat, applyFilterSpec, summarizeSpec, buildTrimmedStops } from './lib/ai-search.js';
import ChatPanel, { ChatLauncher } from './components/ChatPanel.jsx';

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

const APP_VERSION = '0.25.6';

// No auth — see firebase.js. customer_notes writes are stamped with this
// hardcoded identity until we wire up a real per-user signal (out of scope
// for v0.3.0; Glory Bound Dispatch / MarginIQ don't track this either).
const NOTES_UPDATED_BY = 'dispatcher';
// eslint-disable-next-line no-undef
const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
// eslint-disable-next-line no-undef
const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
// eslint-disable-next-line no-undef
const BUILD_CONTEXT = typeof __BUILD_CONTEXT__ !== 'undefined' ? __BUILD_CONTEXT__ : 'dev';
// Short commit for the build badge: the real 7-char hash on a Netlify build, or
// 'local' in dev (the vite fallback is 'dev'). Never blank / 'undefined'.
const BUILD_SHORT = BUILD_COMMIT && BUILD_COMMIT !== 'dev' ? BUILD_COMMIT.slice(0, 7) : 'local';

// Beta version history — shown when the dispatcher taps the build badge, so it's
// easy to keep up with what changed. Newest first; APP_VERSION (top) is highlighted.
// Keep this curated + short (one line each); append a row on each release.
const VERSION_LOG = [
  ['0.25.6', 'Full Google Map controls (type/rotate/pegman/fullscreen/zoom) + 3D tilt-rotate via vector Map ID'],
  ['0.25.5', 'Click a stop in the list to center the map on it + Google Maps link alongside Street View on the stop card'],
  ['0.25.4', 'Stop card NuVizz instructions: strip SPL-INSTR-TEXT prefix + hide boilerplate DO NOT BREAKDOWN SKID'],
  ['0.25.3', '"Has receiving hours" filter matches raw NuVizz instructions directly (finds stops the scanner missed)'],
  ['0.25.2', 'Scheduled scan covers today + next business day (was today-only), so tomorrow’s board stays fresh'],
  ['0.25.1', 'Scanner load-number estimate: business-day anchor + self-calibration (fixes the scheduled scan missing a full day of loads)'],
  ['0.25.0', 'Single source of truth (staged): sole NuVizz scanner writes the canonical fleet index + shared daily-ceiling call counter & circuit breaker'],
  ['0.24.9', 'NuVizz call-volume fix: today-only refresh, */15 cron, narrower scan window'],
  ['0.24.8', 'Add NUVIZZ_SCANS_ENABLED kill switch for the scheduled stop-index scan'],
  ['0.24.7', 'Satellite view toggle + Street View link on stop card + raw NuVizz instructions on stop card'],
  ['0.24.6', 'Driver labels: drop misleading "No route assigned" (routes come from NuVizz, not Motive)'],
  ['0.24.5', 'Receiving-hours scan: strip SPL-INSTR-TEXT line prefixes so split RECEIVING HOURS + range parse'],
  ['0.24.4', 'Filter: "Has receiving hours" toggle — show every stop with receiving hours set'],
  ['0.24.3', 'Receiving hours: scan "RH"/"RECEIVING HOURS" Uline formats + chat reads raw order instructions'],
  ['0.24.2', 'AI chat: 12-hour AM/PM times + reads free-text dock/appointment notes for receiving hours'],
  ['0.24.1', 'Tractor Trailer Friendly — green positive equipment kind (manual; suppressed when No T/T set)'],
  ['0.24.0', 'AI Order Search — natural-language search box + chat panel over the loaded board'],
  ['0.23.1', 'Phase 3 growth-guard fix — no phantom spill / no criss-cross on dense builds'],
  ['0.23.0', 'Geographic truck assignment (no two-truck criss-cross) + green stop markers'],
  ['0.22.0', 'Strategy ordering fixed — placeholder windows no longer clobber Min-distance/Closest'],
  ['0.21.0', 'Appointment windows are advisory (flag, don’t spill)'],
  ['0.20.0', 'Build badge on the routing screen'],
  ['0.19.0', 'Drag-lasso, clickable PRO popups, per-load re-sequence, discard plan'],
  ['0.18.0', 'Shared live Loads — save / open / rename / dispatch across devices'],
  ['0.17.1', 'Route by skid count (deck length no longer blocks)'],
  ['0.17.0', 'Manual route reorder — drag + numbered stops, live map sync'],
  ['0.16.1', 'Build reliability — killed the hang, near-instant builds'],
  ['0.16.0', 'Desktop dispatch console (Setup · map · Stops/Loads/Result)'],
  ['0.15.0', 'Touch selection + per-stop intelligence + selected-stops list'],
  ['0.14.0', 'Routing (beta) tab + cheap-by-default engine'],
];

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

// M5.1 — stop execution-status visuals. Status is a SEPARATE channel from the
// note-flag pin colors (rule #3): SCHEDULED keeps the existing flag color, and
// every other state carries a distinguishing shape/glyph so it reads even where
// a status hue is close to a flag hue. `color: null` → fall back to flagColor.
//   glyph: null=white dot · 'check'=delivered · 'bang'=exception · 'arrow'=en route
const STATUS_META = {
  UNPLANNED:   { label: 'Unplanned',        color: '#64748b', hollow: true,  glyph: null,    badge: '#64748b' },
  SCHEDULED:   { label: 'Scheduled',        color: null,      hollow: false, glyph: null,    badge: '#1e5b92' },
  OUT_FOR_DEL: { label: 'Out for delivery', color: '#2563eb', hollow: false, glyph: 'arrow', badge: '#2563eb' },
  ARRIVED:     { label: 'Arrived',          color: '#d97706', hollow: false, glyph: null,    badge: '#d97706' },
  DELIVERED:   { label: 'Delivered',        color: '#15803d', hollow: false, glyph: 'check', badge: '#15803d' },
  EXCEPTION:   { label: 'Exception',        color: '#dc2626', hollow: false, glyph: 'bang',  badge: '#dc2626' },
};

// Mirrors classifyStopStatus() in netlify/functions/lib/nuvizz-scan.mts so the
// client works on Firestore-cached docs scanned before this field existed.
// Prefers the server-computed normalizedStatus when present.
// M5.2 — canonical "delivery order" comparator. Mirrors the polyline sort so the
// route detail list lines up 1:1 with what the line draws on the map.
function compareByPlannedEta(a, b) {
  const ae = a?.plannedEtaDTTM || a?.raw?.stopExecutionInfo?.to?.plannedEtaDTTM || null;
  const be = b?.plannedEtaDTTM || b?.raw?.stopExecutionInfo?.to?.plannedEtaDTTM || null;
  if (ae && be && ae !== be) return ae.localeCompare(be);
  if (ae && !be) return -1;
  if (!ae && be) return 1;
  const seqDiff = (a?.loadStopSeq ?? 0) - (b?.loadStopSeq ?? 0);
  if (seqDiff !== 0) return seqDiff;
  return String(a?.stopNbr || '').localeCompare(String(b?.stopNbr || ''));
}

function execArrivalTs(exec) {
  return exec.to?.arrivalDTTM || exec.to?.arrivalDttm || exec.arrivalDTTM || exec.arrivalDttm || exec.arrivedDttm || null;
}
function execDeliveredTs(exec) {
  return exec.to?.confirmedDTTM || exec.receiveDTTM || exec.confirmedDTTM || exec.completionDTTM || exec.completedDttm || exec.completionDttm || exec.confirmDTTM || exec.to?.completionDTTM || null;
}
// Mirrors classifyStopStatus() in netlify/functions/lib/nuvizz-scan.mts. Prefers
// the server-computed normalizedStatus when present. v0.11.8: bare status 50 with
// NO real exception signal + an arrivalDTTM is reclassified ARRIVED (parent-app
// normalize.js:80-89 precedent — driver-on-site paperwork issue, not a failure).
function classifyStopStatus(stop) {
  if (stop?.normalizedStatus && STATUS_META[stop.normalizedStatus]) return stop.normalizedStatus;
  const code = String(stop?.status ?? '').trim();
  const exec = (stop?.raw && stop.raw.stopExecutionInfo) || {};
  const arrival = stop?.arrivalDTTM || execArrivalTs(exec);
  const delivered = stop?.deliveredDTTM || execDeliveredTs(exec);
  const realException =
    exec.exceptionPresent === true ||
    (Array.isArray(exec.exceptions) && exec.exceptions.length > 0) ||
    !!(exec.cancellation && exec.cancellation.cancelDTTM);
  if (code === '90' || code === '91' || delivered) return 'DELIVERED';
  if (code === '80') return 'EXCEPTION';
  if (realException) return 'EXCEPTION';
  if (arrival) return 'ARRIVED';
  if (code === '40') return 'OUT_FOR_DEL';
  if (!stop?.isPlanned) return 'UNPLANNED';
  return 'SCHEDULED';
}

const EQUIPMENT_OPTIONS = [
  { value: 'no_tractor_trailer', label: 'No tractor trailer' },
  { value: 'uline_straight_truck', label: 'Uline: straight truck (advisory)' },
  { value: '26ft_max', label: '26ft max' },
  { value: 'no_53ft', label: 'No 53ft' },
  { value: 'box_truck_only', label: 'Box truck only' },
  { value: 'no_overhead_clearance', label: 'Low overhead clearance' },
  // Positive kind — set MANUALLY by the dispatcher (never auto-scanned). Renders
  // green to read as "this stop CAN take a tractor trailer".
  { value: 'tractor_trailer_friendly', label: 'Tractor trailer friendly' },
];

const DOCK_TYPES = [
  { value: 'dock_high', label: 'Dock high' },
  { value: 'ground', label: 'Ground level' },
  { value: 'either', label: 'Either works' },
];

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const MOCK_MODE = import.meta.env.VITE_USE_MOCK_NUVIZZ === 'true';
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
// Optional vector Map ID. When set, Google renders a VECTOR map which supports
// interactive 3D tilt + rotation (hold ⌘/Ctrl and drag to spin around a point)
// and 3D buildings. Unset → raster map (still gets the rotate control + 45°
// aerial in Satellite where Google has imagery). Create one in Google Cloud
// Console → Maps → Map Management (rendering: Vector, tilt + rotation enabled).
const MAP_ID = import.meta.env.VITE_GOOGLE_MAP_ID || undefined;

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
// M5 — Show Routes toggle persists; selectedDate intentionally does NOT
// (resets to today every load, per brief P2.2).
const LS_SHOW_ROUTES = 'dispatchMap.showRoutes';
const LS_ROUTE_LEGEND_EXPANDED = 'dispatchMap.routeLegendExpanded';

// M5 — Driver route polyline palette. 16 colors, distinct from brand colors
// (#1e5b92, #dc2626, #16a34a, #f59e0b, #6b7280) and from each other, all
// readable on Map + Satellite (no near-black). Assigned by stable djb2 hash of
// driverUserName % 16 — same driver → same color every session.
const ROUTE_PALETTE = [
  '#e11d48', '#7c3aed', '#0891b2', '#ca8a04',
  '#be123c', '#4338ca', '#0d9488', '#b45309',
  '#9333ea', '#2563eb', '#65a30d', '#c2410c',
  '#db2777', '#1d4ed8', '#15803d', '#a16207',
];

// djb2 string hash → stable palette index. Deterministic, no storage needed.
function routeColorFor(driverUserName) {
  const s = String(driverUserName || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return ROUTE_PALETTE[h % ROUTE_PALETTE.length];
}
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
  // POSITIVE kind (manual-only). Green tractor-trailer with a check — signals the
  // stop CAN take a tractor trailer. NOT a prohibition (no slash). Mutually
  // exclusive with no_tractor_trailer (suppressed in getRestrictionBadgeKeys).
  tractor_trailer_friendly: {
    label: 'Tractor trailer friendly',
    short: 'T/T OK',
    bg: '#16a34a',
    accent: '#16a34a',
    glyph: '<rect x="1.5" y="6.5" width="6.5" height="3.5" fill="white"/><rect x="8" y="5" width="2.8" height="5" fill="white"/><circle cx="3.5" cy="10.5" r="0.9" fill="#16a34a"/><circle cx="9.5" cy="10.5" r="0.9" fill="#16a34a"/><path d="M9.3 4 L10.8 5.6 L13.2 2.6" stroke="white" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    // 22×22: tractor + trailer (currentColor) with a check mark above. No slash.
    markerGlyph: `
      <rect x="1" y="9" width="10" height="6.5" rx="0.5" fill="currentColor"/>
      <rect x="11" y="7" width="6" height="8.5" rx="0.5" fill="currentColor"/>
      <circle cx="4" cy="17" r="1.6" fill="white"/>
      <circle cx="8.5" cy="17" r="1.6" fill="white"/>
      <circle cx="14" cy="17" r="1.6" fill="white"/>
      <circle cx="4" cy="17" r="1.6" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="8.5" cy="17" r="1.6" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <circle cx="14" cy="17" r="1.6" fill="none" stroke="currentColor" stroke-width="0.7"/>
      <path d="M14 5.5 L16.5 8 L21 3" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    `,
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
// for box_truck_only in TMS systems. tractor_trailer_friendly (a positive kind,
// set manually) accepts a few natural synonyms.
const RESTRICTION_ALIASES = {
  straight_truck_only: 'box_truck_only',
  tt_friendly: 'tractor_trailer_friendly',
  tractor_trailer_ok: 'tractor_trailer_friendly',
  semi_friendly: 'tractor_trailer_friendly',
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

// Fetch JSON from a Netlify Function with one automatic retry on 5xx.
// Surfaces a useful error message on iOS Safari, which throws "The string did
// not match the expected pattern" if you call Response.json() on a non-JSON
// (e.g. empty 502) body. Checking resp.ok BEFORE parsing avoids that path and
// gives us a real HTTP-status error message in its place.
async function fetchJsonWithRetry(url, { retries = 1, backoffMs = 1500 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        // Always-empty 502s from Netlify Functions when the upstream timed
        // out — surface the status, retry on 5xx.
        const bodyText = await resp.text().catch(() => '');
        const detail = bodyText ? ` — ${bodyText.slice(0, 120)}` : '';
        const msg = `HTTP ${resp.status}${detail}`;
        if (resp.status >= 500 && attempt < retries) {
          lastErr = new Error(msg);
          await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        throw new Error(msg);
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
      // Only retry transient (5xx) network errors; bail immediately on
      // explicit non-5xx errors (already thrown above).
      if (attempt < retries && /HTTP 5\d\d|Failed to fetch|Load failed|NetworkError/.test(e.message || '')) {
        await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('fetchJsonWithRetry: unknown error');
}

// Pull stops for a given date (YYYY-MM-DD) from the proxy function.
function useStops(date) {
  const [stops, setStops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [lastScannedAt, setLastScannedAt] = useState(null);
  const [source, setSource] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = MOCK_MODE ? '?mock=1' : (date ? `?date=${encodeURIComponent(date)}` : '');
      const url = '/.netlify/functions/nuvizz-pull-today-stops' + params;
      const data = await fetchJsonWithRetry(url);
      if (!data.ok) throw new Error(data.error || 'NuVizz function returned ok:false');
      // Attach the match key now so every consumer downstream can hit it.
      const decorated = (data.stops || []).map((s) => ({
        ...s,
        matchKey: normalizeMatchKey(s.businessName || '', s.addr1 || '', s.city || '', s.zip || ''),
      }));
      setStops(decorated);
      setSource(data.source || 'nuvizz');
      setLastScannedAt(data.lastScannedAt || null);
      setLastRefreshed(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { refresh(); }, [refresh]);
  return { stops, loading, error, lastRefreshed, lastScannedAt, source, refresh };
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

// Track the *visible* viewport height in CSS pixels. The shell is laid out with
// overflow-hidden (the page itself never scrolls), so on iOS Safari the static
// `100vh` extends behind the dynamic toolbars and hides the bottom of the app —
// most painfully the stop sidebar's Save bar. Sizing the shell to live
// innerHeight keeps it within the visible area on every device. We deliberately
// use a definite pixel height (not `dvh`) so the Google Maps container always
// resolves a real, non-zero height — `dvh` collapsed the map in some webviews.
function useViewportHeight() {
  const read = () => {
    if (typeof window === 'undefined') return 0;
    return window.visualViewport?.height || window.innerHeight || 0;
  };
  const [h, setH] = useState(read);
  useEffect(() => {
    const onResize = () => setH(read());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, []);
  return h;
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
        const data = await fetchJsonWithRetry('/.netlify/functions/motive-driver-positions');
        if (cancelled) return;
        if (data.ok) {
          setDrivers(data.drivers || []);
          setError(null);
          setLastRefreshed(new Date());
        } else {
          setError(data.error || 'Motive function returned ok:false');
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

// True if a stop has structured receiving hours OR references receiving hours in
// its raw free text (NuVizz order instructions, addr2, dock/appointment notes).
// The structured scanner is unreliable on some Uline formats, so the "Has
// receiving hours" filter matches the raw text directly — this finds every loaded
// stop that mentions receiving hours regardless of whether hours were parsed.
// Matches Uline shapes: "RECEIVING HOURS", "RH 7-11AM", "REC HRS".
const RECEIVING_REF = /\bRECEIVING\b|\bRH\b|\bREC\s*HRS?\b/i;
function referencesReceivingHours(stop, note) {
  if (hasReceivingHours(note)) return true;
  const text = [
    stop?.signalSources?.orderInstructions,
    stop?.addr2,
    note?.dock_notes,
    note?.appointment_notes,
  ].filter(Boolean).join(' \n ');
  return RECEIVING_REF.test(text);
}

// Display-clean the raw NuVizz order instructions for the stop card: drop the
// "SPL-INSTR-TEXT:" prefix on each line and hide boilerplate that rides on every
// Uline order ("DO NOT BREAKDOWN SKID"). Returns '' when nothing meaningful is
// left so the section hides entirely.
function cleanInstructions(text) {
  if (!text) return '';
  return String(text)
    .split('\n')
    .map((l) => l.replace(/^\s*SPL-INSTR-TEXT\s*:?\s*/i, '').trim())
    .filter((l) => l && !/do\s*not\s*break\s*down\s*skid/i.test(l))
    .join('\n');
}

// True if the note carries receiving hours for ONE specific weekday key
// ('mon'..'sun'). Same legacy-string / {open,close} tolerance as above.
function hasReceivingHoursForDay(note, dayKey) {
  const v = note?.receiving_hours?.[dayKey];
  if (!v) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return !!(v.open || v.close);
}

// Map a "YYYY-MM-DD" date string to a receiving-hours day key ('mon'..'sun').
// Parsed at local noon so DST/UTC never shifts the weekday (matches date-util).
// JS getDay() is 0=Sun..6=Sat; we re-key into our Mon-first DAYS vocabulary.
function weekdayKeyFromDate(dateString) {
  if (!dateString) return null;
  const [y, m, d] = String(dateString).split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  if (Number.isNaN(dt.getTime())) return null;
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dt.getDay()];
}

// Build the list of restriction badge keys for a note. Includes equipment
// restrictions, liftgate, appointment-required (M2-M4), and M4.4 additions:
// receiving_hours (clock), closed_<day> per entry in note.closed_days.
// Display order per brief P3.2: equipment first, then receiving hours, then
// closed Monday, then closed Friday, then other closed days.
// `opts.day` ('mon'..'sun') makes the receiving-hours clock DAY-AWARE: the
// clock badge is included only when that weekday actually has hours set, so a
// customer with Friday-only hours shows the clock on Fridays and nowhere else.
// Omit `opts.day` (legend, counts, sidebar badge row) to keep the old behavior
// where any day's hours light the clock.
let __ttFriendlyConflictLogged = false;
function getRestrictionBadgeKeys(note, opts = {}) {
  if (!note) return [];
  const keys = [];
  for (const r of note.equipment_restrictions || []) {
    const resolved = resolveRestrictionKey(r);
    if (resolved && !keys.includes(resolved)) keys.push(resolved);
  }
  // Mutual exclusion: a real "no tractor trailer" restriction always wins over the
  // positive "tractor trailer friendly" kind. Suppress friendly from render and
  // warn once so the conflicting data is discoverable but never shown together.
  if (keys.includes('no_tractor_trailer') && keys.includes('tractor_trailer_friendly')) {
    const i = keys.indexOf('tractor_trailer_friendly');
    keys.splice(i, 1);
    if (!__ttFriendlyConflictLogged) {
      __ttFriendlyConflictLogged = true;
      // eslint-disable-next-line no-console
      console.warn('[restriction-icons] stop has both no_tractor_trailer and tractor_trailer_friendly — suppressing the positive kind (the restriction wins)');
    }
  }
  if (note.liftgate_required && !keys.includes('liftgate_required')) keys.push('liftgate_required');
  if (note.appointment_required && !keys.includes('appointment_required')) keys.push('appointment_required');
  const showHours = opts.day ? hasReceivingHoursForDay(note, opts.day) : hasReceivingHours(note);
  if (showHours) keys.push('receiving_hours');
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

// M5.1 — same 28×36 pin as pinSvgClassic but status-aware: `hollow` draws an
// outlined (gray) pin for UNPLANNED, and `glyph` swaps the center white dot for
// a status mark (check=delivered, bang=exception, arrow=en route). Anchor is
// unchanged (14, 34) so it's a drop-in for the classic pin.
function pinSvgStatus(color, opts = {}) {
  const { hollow = false, glyph = null } = opts;
  const bodyFill = hollow ? '#ffffff' : color;
  const bodyStroke = hollow ? color : '#ffffff';
  const strokeW = hollow ? 2.5 : 2;
  let center;
  if (glyph === 'check') {
    center = '<path d="M9.5 13.2l2.8 2.8 5.2-6" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
  } else if (glyph === 'bang') {
    center = '<text x="14" y="17.5" font-family="system-ui, sans-serif" font-size="12" font-weight="800" fill="white" text-anchor="middle">!</text>';
  } else if (glyph === 'arrow') {
    center = '<path d="M9.5 13h6m-2.5-2.6l2.8 2.6-2.8 2.6" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  } else {
    center = `<circle cx="14" cy="13" r="4.5" fill="${hollow ? color : 'white'}"/>`;
  }
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 1c-7 0-13 5.4-13 12 0 9 13 22 13 22s13-13 13-22c0-6.6-6-12-13-12z"
        fill="${bodyFill}" stroke="${bodyStroke}" stroke-width="${strokeW}"/>
      ${center}
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

// M5.2 — data now comes from the pre-scanned Firestore stop index, refreshed by a
// background scan every ~5 min. The meaningful freshness is when that scan ran
// (lastScannedAt), not when the client fetched. Surface it so dispatchers know
// how current the board is.
function fmtStopFreshness(source, lastScannedAt) {
  if (source === 'fixture') return 'MOCK DATA';
  if (source === 'index-empty') return 'No scan yet';
  if (source === 'live-scan') return 'Live scan';
  if (lastScannedAt) {
    const d = new Date(lastScannedAt);
    if (!isNaN(d.getTime())) {
      return `Stops as of ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
  }
  return 'NuVizz';
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
function SearchBar({
  value, onChange, onSubmit, history, inputRef, resultCount, totalCount,
  // M6 — AI search props. When aiAvailable, a sparkle toggle switches the box
  // into "Ask AI" mode; Enter (or the button) then runs a natural-language parse.
  aiAvailable, aiMode, setAiMode, onAskAi, aiBusy, aiSummary, aiError, onClearAi,
}) {
  const [focused, setFocused] = useState(false);
  const showHistory = focused && !value && history.length > 0;
  const aiActive = !!aiSummary;
  return (
    <div className="px-3 pt-3 pb-1 relative">
      <div className="relative">
        {aiMode
          ? <Sparkles size={13} className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: '#1e5b92' }} />
          : <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (aiMode && value.trim()) { onAskAi(value); }
              else { onSubmit(value); }
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') { onChange(''); e.currentTarget.blur(); }
          }}
          placeholder={aiMode ? 'Ask AI to filter (e.g. closed Fridays, liftgate)…' : 'Search customer, PRO, city, address...'}
          className={'w-full border rounded pl-7 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200 ' +
            (aiAvailable ? 'pr-14 ' : 'pr-7 ') +
            (aiMode ? 'border-blue-400 bg-blue-50/40' : 'border-slate-300 focus:border-blue-400')}
          aria-label="Search stops"
        />
        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {value && (
            <button
              onClick={() => onChange('')}
              className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700"
              aria-label="Clear search"
              tabIndex={-1}
            >
              <X size={13} />
            </button>
          )}
          {aiAvailable && (
            <button
              onClick={() => setAiMode(!aiMode)}
              className={'px-1.5 py-0.5 rounded text-[10px] font-semibold inline-flex items-center gap-1 ' +
                (aiMode ? 'text-white' : 'text-slate-500 hover:bg-slate-100')}
              style={aiMode ? { background: '#1e5b92' } : undefined}
              title="Toggle natural-language AI search"
              aria-pressed={aiMode}
            >
              <Sparkles size={11} /> AI
            </button>
          )}
        </div>
      </div>
      {aiActive ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-800">
            <Sparkles size={10} /> {aiSummary}
          </span>
          <button onClick={onClearAi} className="text-slate-500 hover:text-slate-800 underline">Clear</button>
        </div>
      ) : aiBusy ? (
        <div className="mt-1 text-[10px] text-slate-500 inline-flex items-center gap-1"><Sparkles size={10} className="animate-pulse" /> Asking AI…</div>
      ) : value && !aiMode ? (
        <div className="mt-1 text-[10px] text-slate-500">
          {resultCount > 0
            ? <>Showing <span className="font-semibold text-slate-700">{resultCount}</span> of {totalCount} stops</>
            : <>No stops match "<span className="font-semibold">{value}</span>"</>
          }
        </div>
      ) : null}
      {aiError && <div className="mt-1 text-[10px] text-amber-700">{aiError}</div>}
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
              {Object.entries(RESTRICTION_ICONS)
                .filter(([key]) => key !== 'tractor_trailer_friendly')
                .map(([key, def]) => (
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
          <div>
            <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1">Allowed (green)</div>
            <div className="flex items-center gap-2">
              <RestrictionIcon kind="tractor_trailer_friendly" size={16} />
              <span>{RESTRICTION_ICONS.tractor_trailer_friendly.label} — stop can take a tractor trailer</span>
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
function MapFilterToggle({ label, checked, onChange, warning, disabled, disabledHint }) {
  return (
    <div className={`flex items-center justify-between gap-3 py-1.5 ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-xs text-slate-700" title={disabled ? disabledHint : undefined}>{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`flex-shrink-0 relative w-9 h-5 rounded-full transition-colors ${disabled ? 'cursor-not-allowed' : ''}`}
        style={{ background: checked && !disabled ? '#16a34a' : '#cbd5e1' }}
        title={disabled ? disabledHint : undefined}
      >
        <span
          className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform"
          style={{ left: checked && !disabled ? 'calc(100% - 18px)' : '2px' }}
        />
      </button>
      {warning && (
        <span className="absolute right-0 -bottom-4 text-[9px] text-amber-700 italic">{warning}</span>
      )}
    </div>
  );
}

// M5 — Date picker. Native <input type="date"> for accessibility + native
// mobile pickers. Shows the long date when not today, "Today" chip otherwise.
// A "Today" reset button appears only when the selected date isn't today.
function DatePicker({ selectedDate, onChange, onToday, compact }) {
  const today = isTodayET(selectedDate);
  return (
    <div className={`flex items-center gap-1.5 ${compact ? '' : 'bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow px-2 py-1.5'}`}>
      <input
        type="date"
        value={selectedDate}
        onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
        className="text-xs border border-slate-300 rounded px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
        aria-label="Select delivery date"
      />
      <span className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">
        {today ? 'Today' : formatDateLong(selectedDate)}
      </span>
      {!today && (
        <button
          onClick={onToday}
          className="text-[10px] font-semibold py-1 px-2 rounded border border-blue-300 text-blue-700 bg-white hover:bg-blue-50 whitespace-nowrap"
          title="Jump back to today"
        >
          Today
        </button>
      )}
    </div>
  );
}

// Opens Google Street View for a stop — by coordinates when we have them (drops
// the pano right at the dock), else a Maps search on the address. New tab.
function StreetViewLink({ stop, className }) {
  const addr = [stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', ');
  const url = (stop.lat != null && stop.lng != null)
    ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${stop.lat},${stop.lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className || 'inline-flex items-center gap-1 text-xs text-blue-700 hover:underline mt-1'}
      style={{ minHeight: 44, alignItems: 'center' }}
    >
      <MapPinned size={13} /> Street View
    </a>
  );
}

// Opens the stop in Google Maps (regular map / directions target) — by
// coordinates when available, else an address search. New tab.
function GoogleMapsLink({ stop, className }) {
  const addr = [stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', ');
  const q = (stop.lat != null && stop.lng != null) ? `${stop.lat},${stop.lng}` : addr;
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className || 'inline-flex items-center gap-1 text-xs text-blue-700 hover:underline mt-1'}
      style={{ minHeight: 44, alignItems: 'center' }}
    >
      <MapPin size={13} /> Google Maps
    </a>
  );
}

// M5 — Show Routes toggle. Sits adjacent to the filter toolbar (top-right),
// same visual treatment, but a standalone control (not in the 5-toggle group).
// M5 — Driver route legend. Collapsible (same pattern as the restriction
// legend). One row per driver: color swatch + display name + stop count.
function DriverRouteLegend({ legend, expanded, setExpanded }) {
  if (!legend.length) return null;
  return (
    <div className="border-t">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs font-semibold text-slate-600 hover:bg-slate-50"
        aria-expanded={expanded}
      >
        <span className="inline-flex items-center gap-1.5"><Truck size={13} /> Routes ({legend.length} drivers)</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1 max-h-48 overflow-y-auto">
          {legend.map((d) => (
            <div key={d.driverUserName} className="flex items-center gap-2 text-[11px]">
              <span className="w-3 h-1.5 rounded-sm flex-shrink-0" style={{ background: d.color }} />
              <span className="flex-1 truncate">{d.driverName || d.driverUserName}</span>
              <span className="text-slate-400">{d.stopCount}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterToolbar({ filters, setFilters, collapsed, setCollapsed, stopCount, vehicleDisabled, showRoutes, setShowRoutes }) {
  const set = (key) => (v) => setFilters((prev) => ({ ...prev, [key]: v }));
  const clusterWarning = !filters.showClustered && stopCount > 200
    ? `Rendering ${stopCount} markers individually may be slow`
    : null;
  return (
    <div
      className="bg-white rounded-lg shadow-md border border-slate-200"
      style={{ width: 240, opacity: 0.97 }}
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
            disabled={vehicleDisabled}
            disabledHint="Live drivers only available for today's date."
          />
          {vehicleDisabled && (
            <div className="text-[10px] text-slate-500 italic -mt-1 mb-1 leading-tight">Live drivers only available for today.</div>
          )}
          <MapFilterToggle
            label="Show clustered markers"
            checked={filters.showClustered}
            onChange={set('showClustered')}
          />
          {clusterWarning && (
            <div className="text-[10px] text-amber-700 italic mt-1 leading-tight">{clusterWarning}</div>
          )}
          <MapFilterToggle
            label="Satellite view"
            checked={filters.satellite}
            onChange={set('satellite')}
          />
          {setShowRoutes && (
            <MapFilterToggle
              label="Show routes"
              checked={showRoutes}
              onChange={setShowRoutes}
            />
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
          label="Has receiving hours"
          checked={!!F.hasHours}
          onChange={(b) => setFilters({ ...F, hasHours: b || undefined })}
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
    if (filters.hasHours && !referencesReceivingHours(s, n)) return false;
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

function StopSidebar({ stop, note, onClose, onSave, saving, saveError, onOpenRoute, mobile = false }) {
  const [draft, setDraft] = useState(() => note || emptyNote(stop));
  const [editing, setEditing] = useState(!note);
  useEffect(() => {
    setDraft(note || emptyNote(stop));
    setEditing(!note);
  }, [stop?.stopNbr, note?.id]);

  if (!stop) return null;
  const sidebarStatusKind = classifyStopStatus(stop);
  const sidebarArrivedAt = (sidebarStatusKind === 'ARRIVED' || sidebarStatusKind === 'DELIVERED')
    ? fmtClockShort(stop.arrivalDTTM || execArrivalTs(stop.raw?.stopExecutionInfo || {})) : null;
  const sidebarDeliveredAt = sidebarStatusKind === 'DELIVERED'
    ? fmtClockShort(stop.deliveredDTTM || execDeliveredTs(stop.raw?.stopExecutionInfo || {})) : null;
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

      {/* M5.1 — execution-status badge bar */}
      <div className="px-4 py-2 border-b bg-slate-50 flex items-center gap-2 flex-wrap">
        <StatusBadge kind={sidebarStatusKind} />
        {sidebarDeliveredAt && <span className="text-[11px] text-slate-500">Delivered {sidebarDeliveredAt}</span>}
        {sidebarArrivedAt && <span className="text-[11px] text-slate-500">Arrived {sidebarArrivedAt}</span>}
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
            <div className="flex items-center gap-4">
              <StreetViewLink stop={stop} />
              <GoogleMapsLink stop={stop} />
            </div>
          </div>
          {cleanInstructions(stop.signalSources?.orderInstructions) && (
            <div className="pt-1">
              <div className="text-xs uppercase font-semibold text-slate-500">NuVizz instructions</div>
              <div className="text-xs text-slate-700 whitespace-pre-wrap leading-snug">{cleanInstructions(stop.signalSources.orderInstructions)}</div>
            </div>
          )}
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
          {/* M5.2 — Route section: load + driver + jump to the full route */}
          <div className="pt-2 mt-2 border-t">
            <div className="text-xs uppercase font-semibold text-slate-500 mb-1">Route</div>
            {stop.loadNbr ? (
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <div className="font-semibold text-slate-900 truncate">{stop.routeName || stop.loadNbr}</div>
                  {stop.driverName && <div className="text-xs text-slate-500 truncate">{stop.driverName}</div>}
                  {stop.routeName && <div className="text-[10px] text-slate-400 font-mono">{stop.loadNbr}</div>}
                </div>
                {onOpenRoute && (
                  <button
                    onClick={() => onOpenRoute(stop.loadNbr)}
                    className="flex-shrink-0 px-2 py-1 text-xs font-semibold text-blue-700 border border-blue-300 rounded hover:bg-blue-50 active:bg-blue-100"
                  >
                    View full route
                  </button>
                )}
              </div>
            ) : (
              <div className="text-xs text-slate-500 italic">Not yet assigned</div>
            )}
          </div>
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
        <div className="flex-shrink-0 border-t px-4 py-2 flex items-center justify-between gap-2 bg-slate-50">
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
  return (
    <aside
      className={mobile
        ? "absolute inset-0 bg-white shadow-lg flex flex-col overflow-hidden z-40"
        : "w-[380px] flex-shrink-0 bg-white border-l shadow-lg flex flex-col h-full overflow-hidden"
      }
      style={mobile ? { paddingBottom: 'env(safe-area-inset-bottom)' } : undefined}
    >
      <DriverSnapshotHeader driver={driver} snapshot={snapshot} onClose={onClose} />
      <DriverSnapshotBody
        driver={driver}
        snapshot={snapshot}
        loading={loading}
        error={error}
        onPanToStop={onPanToStop}
      />
    </aside>
  );
}

function DriverSnapshotHeader({ driver, snapshot, onClose }) {
  const truckLabel = driver.vehicleNumber || `(truck ${driver.vehicleId || '?'})`;
  const driverName = driver.driverName || '(no driver)';
  const hos = snapshot?.hos || null;
  return (
    <div className="px-4 py-3 border-b flex-shrink-0" style={{ background: BRAND, color: 'white' }}>
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
  );
}

function DriverSnapshotBody({ driver, snapshot, loading, error, onPanToStop }) {
  const route = snapshot?.route || null;
  const stops = Array.isArray(snapshot?.stops) ? snapshot.stops : [];

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
  // Display in 12-hour am/pm (e.g. "8:00a–3:00p"), matching the rest of the app
  // (formatReceivingHours). Stored values are 24h from <input type="time">;
  // fmtTime12 also passes legacy free-text through untouched.
  const renderDayHours = (d) => {
    if (closedSet.has(d)) return 'Closed';
    const v = note.receiving_hours?.[d];
    if (!v) return '—';
    if (typeof v === 'string') return fmtTime12(v) || v;
    if (v.open && v.close) return `${fmtTime12(v.open)}–${fmtTime12(v.close)}`;
    return fmtTime12(v.open || v.close) || '—';
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
      if (this.line2) div.appendChild(l2);
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
            {ROUTING_FLAG && (
              <button
                className="w-full text-left px-3 py-2 hover:bg-slate-50 inline-flex items-center gap-2"
                onClick={() => onSelectMenu('routing')}
                role="menuitem"
              >
                <MapPinned size={12} /> Routing (beta)
              </button>
            )}
            <button
              className={`w-full text-left px-3 py-2 hover:bg-slate-50 inline-flex items-center gap-2${ROUTING_FLAG ? ' border-t border-slate-100' : ''}`}
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

// Shared bottom-sheet primitive. Owns the slide-up animation, the drag handle,
// the snap behavior (3 height stops), the backdrop dim, and the close-on-fling.
// Consumers compose their own header + body inside. Each drawer can specify
// its preferred default height + an optional onDragHandle on top of children
// (e.g. the StopDetail drawer puts a customer-name header above its tabs).
//
// Touch handling uses native events (no library) — vertical pointer drags on
// the handle adjust height; release snaps to nearest of the snap stops, with
// a downward fling past the smallest stop closing the sheet.
const SHEET_HEIGHTS = { mini: 0.30, default: 0.60, expanded: 0.95 };
const STOP_DETAIL_HEIGHTS = { mini: 0.30, default: 0.80, expanded: 0.95 };

function BottomSheet({ open, onClose, heights = SHEET_HEIGHTS, children, ariaLabel }) {
  const [heightFrac, setHeightFrac] = useState(heights.default);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef({ startY: 0, startFrac: heights.default });

  // Reset to default each time the sheet opens.
  useEffect(() => {
    if (open) setHeightFrac(heights.default);
  }, [open, heights.default]);

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
      const next = Math.max(0.15, Math.min(0.97, dragRef.current.startFrac - delta / vh));
      setHeightFrac(next);
    };
    const up = (ev) => {
      const y = ev.changedTouches ? ev.changedTouches[0].clientY : ev.clientY;
      const delta = y - dragRef.current.startY;
      const vh = window.innerHeight || 1;
      const finalFrac = Math.max(0.15, Math.min(0.97, dragRef.current.startFrac - delta / vh));
      // Close if dragged below the smallest snap stop with sufficient velocity.
      if (finalFrac < (heights.mini - 0.08) && delta > 60) {
        setDragging(false);
        onClose();
        return;
      }
      const candidates = Object.values(heights);
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

  const drawerHeight = `${(heightFrac * 100).toFixed(1)}vh`;

  return (
    <>
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
        aria-label={ariaLabel}
      >
        <div
          onMouseDown={onPointerDown}
          onTouchStart={onPointerDown}
          className="flex-shrink-0 py-2 flex items-center justify-center cursor-grab active:cursor-grabbing select-none"
          style={{ touchAction: 'none' }}
        >
          <div className="w-8 h-1 rounded-full bg-slate-300" />
        </div>
        {children}
      </div>
    </>
  );
}

function MobileDrawer({ open, onClose, activeTab, setActiveTab, children }) {
  return (
    <BottomSheet open={open} onClose={onClose} heights={SHEET_HEIGHTS} ariaLabel="Stops, Filters, Drivers">
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
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {children}
      </div>
    </BottomSheet>
  );
}

// Stops tab content. Search input + count + list of cards (one tap = pick stop).
function MobileStopsTab({
  stops, notes, searchInput, setSearchInput,
  resultCount, totalCount, onPickStop,
  aiAvailable, onAskAi, aiBusy, aiSummary, aiError, onClearAi,
}) {
  return (
    <div className="flex flex-col">
      <div className="p-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && aiAvailable && searchInput.trim()) { e.preventDefault(); onAskAi(searchInput); } }}
              placeholder="Customer, PRO, city, address…"
              className="w-full pl-8 pr-3 border border-slate-300 rounded-lg text-sm"
              style={{ minHeight: 44 }}
            />
          </div>
          {aiAvailable && (
            <button
              onClick={() => searchInput.trim() && onAskAi(searchInput)}
              disabled={aiBusy || !searchInput.trim()}
              className="rounded-lg text-white inline-flex items-center gap-1 px-3 text-xs font-semibold disabled:opacity-40"
              style={{ background: '#1e5b92', minHeight: 44, minWidth: 44 }}
              aria-label="Ask AI to filter"
            >
              <Sparkles size={14} /> AI
            </button>
          )}
        </div>
        {aiSummary ? (
          <div className="mt-2 flex items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-800">
              <Sparkles size={11} /> {aiSummary}
            </span>
            <button onClick={onClearAi} className="text-slate-500 underline">Clear</button>
          </div>
        ) : aiBusy ? (
          <div className="mt-2 text-[11px] text-slate-500">Asking AI…</div>
        ) : (
          <div className="text-[11px] text-slate-500 mt-1.5 px-0.5">
            Showing <span className="font-semibold text-slate-700">{resultCount}</span> of {totalCount} stops
          </div>
        )}
        {aiError && <div className="mt-1 text-[11px] text-amber-700">{aiError}</div>}
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
  showRoutes, setShowRoutes, vehicleDisabled,
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
            disabled={vehicleDisabled}
            disabledHint="Live drivers only available for today's date."
          />
          {vehicleDisabled && (
            <div className="text-[10px] text-slate-500 italic -mt-1 leading-tight">Live drivers only available for today.</div>
          )}
          {/* M5 — Show Routes lives in the mobile filters drawer (P3.7). */}
          <MapFilterToggle
            label="Show routes"
            checked={showRoutes}
            onChange={setShowRoutes}
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

// ---------- M4.5 PR 2: stop-detail + driver-snapshot drawers ----------

// Mobile stop-detail drawer. Replaces the full-screen StopSidebar overlay
// from PR 1 with a proper bottom-sheet that has its own header + Info /
// Notes / Hours / PROs tabs. Draft state spans all tabs so editing Notes
// then switching to Hours preserves changes; one Save commits everything.
function MobileStopDetailDrawer({ stop, note, onClose, onSave, saving, saveError, onOpenRoute }) {
  const [activeTab, setActiveTab] = useState('info');
  const [draft, setDraft] = useState(() => note || emptyNote(stop));
  const [editing, setEditing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Reset draft + tab when a different stop opens.
  useEffect(() => {
    setDraft(note || emptyNote(stop));
    setEditing(false);
    setActiveTab('info');
    setConfirmDiscard(false);
  }, [stop?.stopNbr, note?.id]);

  if (!stop) return null;
  const D = draft;
  const setD = (patch) => setDraft({ ...D, ...patch });

  const hasUnsaved = editing && JSON.stringify(draft) !== JSON.stringify(note || emptyNote(stop));

  const tryClose = () => {
    if (hasUnsaved) { setConfirmDiscard(true); return; }
    onClose();
  };

  const switchTab = (next) => {
    // No confirm needed for switching tabs; draft is preserved.
    setActiveTab(next);
  };

  return (
    <BottomSheet open onClose={tryClose} heights={STOP_DETAIL_HEIGHTS} ariaLabel={`Stop details: ${stop.businessName || stop.pro || ''}`}>
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-1 pb-2 border-b border-slate-200">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">PRO {stop.pro || '—'}</div>
            <div className="font-bold text-base text-slate-900 truncate">{stop.businessName || '(no name)'}</div>
            <div className="text-[12px] text-slate-500 truncate">{stop.addr1 || '—'}</div>
          </div>
          <button
            onClick={tryClose}
            className="flex-shrink-0 p-2 -mr-1 rounded-full hover:bg-slate-100 active:bg-slate-200"
            style={{ minWidth: 44, minHeight: 44 }}
            aria-label="Close stop details"
          >
            <X size={20} />
          </button>
        </div>
      </div>
      {/* Tabs */}
      <div className="flex-shrink-0 flex border-b border-slate-200">
        {[
          { id: 'info', label: 'Info' },
          { id: 'notes', label: 'Notes' },
          { id: 'hours', label: 'Hours' },
          { id: 'pros', label: 'PROs' },
        ].map((t) => {
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => switchTab(t.id)}
              className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${active ? '' : 'text-slate-500'}`}
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
        {activeTab === 'info' && <StopInfoTabContent stop={stop} onOpenRoute={onOpenRoute} />}
        {activeTab === 'notes' && (
          <StopNotesTabContent
            stop={stop}
            note={note}
            draft={D}
            setDraft={setD}
            editing={editing}
            setEditing={setEditing}
          />
        )}
        {activeTab === 'hours' && (
          <StopHoursTabContent
            draft={D}
            setDraft={setD}
            editing={editing}
            setEditing={setEditing}
          />
        )}
        {activeTab === 'pros' && <StopProsTabContent stop={stop} />}
      </div>
      {/* Sticky save bar — visible while editing on Notes or Hours tabs */}
      {editing && (activeTab === 'notes' || activeTab === 'hours') && (
        <div className="flex-shrink-0 border-t bg-white px-4 py-2 flex items-center justify-between gap-2"
             style={{ paddingBottom: `calc(0.5rem + env(safe-area-inset-bottom))` }}>
          {saveError && <span className="text-[11px] text-red-600 truncate">{saveError}</span>}
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => { setDraft(note || emptyNote(stop)); setEditing(false); }}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded"
              style={{ minHeight: 44 }}
            >
              Cancel
            </button>
            <button
              onClick={() => onSave(D)}
              disabled={saving}
              className="px-4 py-2 text-sm text-white font-semibold rounded inline-flex items-center gap-1.5 disabled:opacity-50"
              style={{ background: BRAND, minHeight: 44 }}
            >
              {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        </div>
      )}
      {/* Discard confirm dialog */}
      {confirmDiscard && (
        <div
          className="absolute inset-0 flex items-center justify-center px-6"
          style={{ background: 'rgba(0,0,0,0.45)', zIndex: 50 }}
        >
          <div className="bg-white rounded-lg shadow-lg max-w-sm w-full p-4">
            <div className="font-semibold text-slate-900 mb-1">Discard changes?</div>
            <div className="text-xs text-slate-600 mb-4">You have unsaved edits to this stop. Closing will lose them.</div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDiscard(false)}
                className="px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded"
                style={{ minHeight: 44 }}
              >
                Keep editing
              </button>
              <button
                onClick={() => { setConfirmDiscard(false); onClose(); }}
                className="px-3 py-2 text-sm text-white font-semibold rounded"
                style={{ background: '#dc2626', minHeight: 44 }}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

// M5.1 — status pill for the stop-detail sidebar. Color matches the marker
// hue; UNPLANNED renders as an outlined chip to echo its hollow pin.
function StatusBadge({ kind }) {
  const meta = STATUS_META[kind] || STATUS_META.SCHEDULED;
  const c = meta.badge;
  const outlined = kind === 'UNPLANNED';
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={
        outlined
          ? { color: c, border: `1px solid ${c}`, background: '#fff' }
          : { color: '#fff', background: c }
      }
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: outlined ? c : '#fff' }} />
      {meta.label}
    </span>
  );
}

// M5.2 — Route detail body, shared between the desktop sidebar and mobile drawer.
// Shows the load's stops in compareByPlannedEta order (== polyline order) with status
// badge + delivery/arrival/ETA time. Tap a row → onPickStop closes route + opens stop.
function RouteDetailBody({ stops, onPickStop }) {
  const sorted = [...stops].sort(compareByPlannedEta);
  const driverName = sorted[0]?.driverName || sorted[0]?.driverUserName || '—';
  const delivered = sorted.filter((s) => classifyStopStatus(s) === 'DELIVERED').length;
  return (
    <>
      <div className="px-4 py-2 border-b bg-slate-50 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase font-semibold text-slate-500">Driver</div>
          <div className="text-sm font-semibold text-slate-900 truncate">{driverName}</div>
        </div>
        <div className="text-[11px] text-slate-500">{delivered}/{sorted.length} delivered</div>
      </div>
      <ol className="divide-y divide-slate-100">
        {sorted.map((s, i) => {
          const kind = classifyStopStatus(s);
          const exec = s.raw?.stopExecutionInfo || {};
          const time = kind === 'DELIVERED' ? fmtClockShort(s.deliveredDTTM || execDeliveredTs(exec))
                     : kind === 'ARRIVED' ? fmtClockShort(s.arrivalDTTM || execArrivalTs(exec))
                     : fmtClockShort(s.plannedEtaDTTM || exec.to?.plannedEtaDTTM);
          return (
            <li key={(s.stopNbr || '') + ':' + i}>
              <button
                onClick={() => onPickStop && onPickStop(s)}
                className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-slate-50 active:bg-slate-100"
                style={{ minHeight: 56 }}
              >
                <span className="text-[10px] font-mono text-slate-400 w-5 flex-shrink-0 text-right">{i + 1}</span>
                <StatusBadge kind={kind} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900 truncate">{s.businessName || '(no name)'}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {s.pro && <span className="font-mono mr-1">{s.pro}</span>}
                    {time && <span>{time}</span>}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function RouteDetailSidebar({ loadNbr, stops, onClose, onPickStop, mobile = false }) {
  // M5.2.1 — lead with the human route name (e.g. "DULUTH"); load # stays as fine
  // print so the dispatcher can still grep for the internal identifier.
  const routeName = stops.find((s) => s.routeName)?.routeName || null;
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
          <div className="text-[10px] uppercase tracking-wider opacity-75">Route</div>
          <div className="font-bold truncate">{routeName || loadNbr}</div>
          {routeName && <div className="text-[10px] font-mono opacity-75">{loadNbr}</div>}
        </div>
        <button onClick={onClose} className="p-1 hover:bg-white/20 rounded" aria-label="Close route"><X size={20} /></button>
      </div>
      <div className="overflow-y-auto flex-1">
        <RouteDetailBody stops={stops} onPickStop={onPickStop} />
      </div>
    </aside>
  );
}

function MobileRouteDetailDrawer({ loadNbr, stops, onClose, onPickStop }) {
  const routeName = stops.find((s) => s.routeName)?.routeName || null;
  return (
    <BottomSheet open onClose={onClose} heights={SHEET_HEIGHTS} ariaLabel={`Route ${routeName || loadNbr}`}>
      <div className="flex-shrink-0 px-4 py-2 flex items-center justify-between border-b">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Route</div>
          <div className="font-bold truncate">{routeName || loadNbr}</div>
          {routeName && <div className="text-[10px] font-mono text-slate-400">{loadNbr}</div>}
        </div>
        <button onClick={onClose} className="p-2 -mr-2" aria-label="Close route"><X size={20} /></button>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <RouteDetailBody stops={stops} onPickStop={onPickStop} />
      </div>
    </BottomSheet>
  );
}

function StopInfoTabContent({ stop, onOpenRoute }) {
  const cityLine = [stop.city, stop.state, stop.zip].filter(Boolean).join(', ').replace(/, ([A-Z]{2}) (\d)/, ', $1 $2');
  const statusKind = classifyStopStatus(stop);
  const arrivedAt = (statusKind === 'ARRIVED' || statusKind === 'DELIVERED') ? fmtClockShort(stop.arrivalDTTM || execArrivalTs(stop.raw?.stopExecutionInfo || {})) : null;
  const deliveredAt = statusKind === 'DELIVERED' ? fmtClockShort(stop.deliveredDTTM || execDeliveredTs(stop.raw?.stopExecutionInfo || {})) : null;
  return (
    <div className="px-4 py-3 space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <StatusBadge kind={statusKind} />
        {deliveredAt && <span className="text-[11px] text-slate-500">Delivered {deliveredAt}</span>}
        {arrivedAt && <span className="text-[11px] text-slate-500">Arrived {arrivedAt}</span>}
      </div>
      <div>
        <div className="text-[10px] uppercase font-semibold text-slate-500 mb-0.5">Address</div>
        <div className="text-slate-900">{stop.addr1 || '—'}</div>
        {stop.addr2 && (
          <div className="mt-1 px-2 py-1 text-[12px] bg-amber-50 border border-amber-200 rounded text-amber-900">
            <span className="font-semibold">addr2:</span> {stop.addr2}
          </div>
        )}
        <div className="text-slate-600">{cityLine || '—'}</div>
        <div className="flex items-center gap-5 mt-1">
          <StreetViewLink stop={stop} className="inline-flex items-center gap-1 text-[13px] text-blue-700" />
          <GoogleMapsLink stop={stop} className="inline-flex items-center gap-1 text-[13px] text-blue-700" />
        </div>
      </div>
      {cleanInstructions(stop.signalSources?.orderInstructions) && (
        <div>
          <div className="text-[10px] uppercase font-semibold text-slate-500 mb-0.5">NuVizz instructions</div>
          <div className="text-[12px] text-slate-700 whitespace-pre-wrap leading-snug">{cleanInstructions(stop.signalSources.orderInstructions)}</div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase font-semibold text-slate-500">Window</div>
          <div>{stop.scheduledFrom || '—'} – {stop.scheduledTo || '—'}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase font-semibold text-slate-500">Items</div>
          <div>{stop.itemsSummary || '—'}</div>
        </div>
      </div>
      {/* M5.2 — Route section */}
      <div className="pt-2 border-t">
        <div className="text-[10px] uppercase font-semibold text-slate-500 mb-0.5">Route</div>
        {stop.loadNbr ? (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-slate-900 font-semibold text-sm truncate">{stop.routeName || stop.loadNbr}</div>
              {stop.driverName && <div className="text-xs text-slate-500 truncate">{stop.driverName}</div>}
              {stop.routeName && <div className="text-[10px] text-slate-400 font-mono">{stop.loadNbr}</div>}
            </div>
            {onOpenRoute && (
              <button
                onClick={() => onOpenRoute(stop.loadNbr)}
                className="flex-shrink-0 px-2 py-1 text-xs font-semibold text-blue-700 border border-blue-300 rounded active:bg-blue-100"
                style={{ minHeight: 32 }}
              >
                View full route
              </button>
            )}
          </div>
        ) : (
          <div className="text-xs text-slate-500 italic">Not yet assigned</div>
        )}
      </div>
    </div>
  );
}

function StopNotesTabContent({ stop, note, draft, setDraft, editing, setEditing }) {
  const D = draft;
  const setD = (patch) => setDraft(patch);
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

  if (!editing) {
    return (
      <div className="px-4 py-3 space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase font-semibold text-slate-500">Customer notes</div>
          <button
            onClick={() => setEditing(true)}
            className="px-3 py-1.5 text-xs text-white font-semibold rounded"
            style={{ background: BRAND, minHeight: 36 }}
          >
            Edit
          </button>
        </div>
        {!note ? (
          <div className="text-xs text-slate-500 italic">No notes yet. Tap Edit to add.</div>
        ) : (
          <ReadOnlyNoteView note={note} />
        )}
      </div>
    );
  }

  return (
    <div className="px-4 py-3 space-y-4 text-sm">
      {/* Priority flag */}
      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Priority flag</div>
        <div className="flex flex-wrap gap-1.5">
          {[null, 'red', 'yellow', 'green'].map((v) => {
            const active = D.priority_flag === v;
            const swatch = v ? FLAG_COLORS[v] : '#e2e8f0';
            return (
              <button
                key={String(v)}
                onClick={() => setD({ priority_flag: v })}
                className={`px-3 py-2 rounded border flex items-center gap-1.5 ${active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-300 text-slate-700'}`}
                style={{ minHeight: 44 }}
              >
                <span className="w-3 h-3 rounded-full" style={{ background: swatch }} />
                <span className="text-xs">{v || 'none'}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Toggles */}
      <div className="space-y-2">
        <MobileToggleRow
          label="Appointment required"
          checked={!!D.appointment_required}
          onChange={(b) => setD({ appointment_required: b })}
        />
        <MobileToggleRow
          label="Liftgate required"
          checked={!!D.liftgate_required}
          onChange={(b) => setD({ liftgate_required: b })}
        />
      </div>

      {/* Equipment restriction chips */}
      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Equipment restrictions</div>
        <div className="flex flex-wrap gap-1.5">
          {EQUIPMENT_OPTIONS.map((o) => {
            const active = (D.equipment_restrictions || []).includes(o.value);
            return (
              <button
                key={o.value}
                onClick={() => toggleRestriction(o.value)}
                className={`px-3 py-2 rounded-full text-xs border inline-flex items-center gap-1.5 ${active ? 'bg-purple-600 text-white border-purple-600' : 'bg-white border-slate-300 text-slate-700'}`}
                style={{ minHeight: 44 }}
              >
                <RestrictionIcon kind={o.value} size={14} />
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Dock type */}
      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Dock type</div>
        <div className="flex flex-wrap gap-1.5">
          {[...DOCK_TYPES, { value: null, label: 'unknown' }].map((o) => {
            const active = (D.dock_type ?? null) === o.value;
            return (
              <button
                key={String(o.value)}
                onClick={() => setD({ dock_type: o.value })}
                className={`px-3 py-2 rounded border text-xs ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
                style={{ minHeight: 44 }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Dock notes */}
      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Dock notes</div>
        <textarea
          value={D.dock_notes || ''}
          onChange={(e) => setD({ dock_notes: e.target.value })}
          rows={3}
          className="w-full border border-slate-300 rounded px-2 py-2 text-sm"
        />
      </div>

      {/* Appointment notes */}
      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1">Appointment notes</div>
        <input
          value={D.appointment_notes || ''}
          onChange={(e) => setD({ appointment_notes: e.target.value })}
          className="w-full border border-slate-300 rounded px-2 text-sm"
          style={{ minHeight: 44 }}
        />
      </div>

      {/* Contacts */}
      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1 flex items-center justify-between">
          <span>Contacts</span>
          <button onClick={addContact} className="text-xs text-blue-600 inline-flex items-center gap-0.5"
                  style={{ minHeight: 36, minWidth: 44 }}>
            <Plus size={13} /> Add
          </button>
        </div>
        <div className="space-y-2">
          {(D.contacts || []).map((c, i) => (
            <div key={i} className="space-y-1.5 p-2 border border-slate-200 rounded">
              <input
                value={c.name || ''}
                onChange={(e) => setContact(i, { name: e.target.value })}
                placeholder="Name"
                className="w-full border border-slate-300 rounded px-2 text-sm"
                style={{ minHeight: 44 }}
              />
              <div className="grid grid-cols-[1fr_1fr_44px] gap-1.5 items-center">
                <input
                  value={c.phone || ''}
                  onChange={(e) => setContact(i, { phone: e.target.value })}
                  placeholder="Phone"
                  type="tel"
                  className="border border-slate-300 rounded px-2 text-sm"
                  style={{ minHeight: 44 }}
                />
                <input
                  value={c.role || ''}
                  onChange={(e) => setContact(i, { role: e.target.value })}
                  placeholder="Role"
                  className="border border-slate-300 rounded px-2 text-sm"
                  style={{ minHeight: 44 }}
                />
                <button
                  onClick={() => removeContact(i)}
                  className="text-slate-400 hover:text-red-600 flex items-center justify-center"
                  style={{ minWidth: 44, minHeight: 44 }}
                  aria-label="Remove contact"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
          {(!D.contacts || !D.contacts.length) && (
            <div className="text-xs text-slate-400 italic">No contacts yet</div>
          )}
        </div>
      </div>
    </div>
  );
}

function StopHoursTabContent({ draft, setDraft, editing, setEditing }) {
  const D = draft;
  const setD = (patch) => setDraft(patch);

  const isClosed = (day) => Array.isArray(D.closed_days) && D.closed_days.includes(day);
  const toggleClosed = (day) => {
    const current = Array.isArray(D.closed_days) ? D.closed_days : [];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    setD({
      closed_days: next,
      manual_overrides: { ...(D.manual_overrides || {}), closed_days: true },
    });
  };
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
  const getOpen = (day) => {
    const v = D.receiving_hours?.[day];
    if (!v || typeof v === 'string') return '';
    return v.open || '';
  };
  const getClose = (day) => {
    const v = D.receiving_hours?.[day];
    if (!v || typeof v === 'string') return '';
    return v.close || '';
  };

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

  if (!editing) {
    // View mode: compact list of each day.
    return (
      <div className="px-4 py-3 space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase font-semibold text-slate-500">Receiving hours</div>
          <button
            onClick={() => setEditing(true)}
            className="px-3 py-1.5 text-xs text-white font-semibold rounded"
            style={{ background: BRAND, minHeight: 36 }}
          >
            Edit
          </button>
        </div>
        <div className="divide-y divide-slate-100 border border-slate-200 rounded overflow-hidden">
          {DAYS.map((d) => {
            const closed = isClosed(d);
            const v = D.receiving_hours?.[d];
            let label = '—';
            if (closed) label = 'Closed';
            else if (v) {
              if (typeof v === 'string') label = fmtTime12(v) || v;
              else if (v.open && v.close) label = `${fmtTime12(v.open)} – ${fmtTime12(v.close)}`;
              else label = fmtTime12(v.open || v.close) || '—';
            }
            return (
              <div key={d} className="px-3 py-2 flex items-center justify-between">
                <span className="text-[11px] uppercase font-semibold text-slate-500">{d}</span>
                <span className={`text-sm ${closed ? 'text-red-600 font-semibold' : 'text-slate-900'}`}>{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 space-y-3 text-sm">
      {/* Day open/closed toggle row — 44x44 buttons */}
      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-2">Open / Closed</div>
        <div className="grid grid-cols-7 gap-1">
          {DAYS.map((d) => {
            const closed = isClosed(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => toggleClosed(d)}
                className={`uppercase font-semibold rounded border text-[11px] ${closed ? 'bg-red-100 border-red-300 text-red-700' : 'bg-white border-slate-300 text-slate-700'}`}
                style={{ minHeight: 44, minWidth: 0 }}
                aria-pressed={!closed}
                title={closed ? `${d.toUpperCase()} closed — tap to open` : `${d.toUpperCase()} open — tap to mark closed`}
              >
                {d}
              </button>
            );
          })}
        </div>
      </div>

      {/* Copy-to-weekdays */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={copyMondayToWeekdays}
          disabled={!isClosed('mon') && !(D.receiving_hours?.mon && (
            typeof D.receiving_hours.mon === 'string'
              ? D.receiving_hours.mon
              : (D.receiving_hours.mon.open || D.receiving_hours.mon.close)
          ))}
          className="px-3 py-2 text-xs rounded border border-slate-300 text-slate-700 disabled:opacity-50"
          style={{ minHeight: 44 }}
        >
          Copy Mon → Tue-Fri
        </button>
        {copyToast && <span className="text-xs text-emerald-600">Copied</span>}
      </div>

      {/* Per-day rows */}
      <div className="space-y-2">
        {DAYS.map((d) => {
          const closed = isClosed(d);
          return (
            <div key={d} className="flex items-center gap-2">
              <div className="w-10 text-[11px] uppercase font-semibold text-slate-500">{d}</div>
              {closed ? (
                <div className="flex-1 flex items-center justify-between gap-2 px-2 py-2 rounded bg-red-50 border border-red-200">
                  <span className="text-sm font-semibold text-red-700">Closed</span>
                  <button
                    type="button"
                    onClick={() => toggleClosed(d)}
                    className="text-xs text-blue-600"
                    style={{ minHeight: 36 }}
                  >
                    Open
                  </button>
                </div>
              ) : (
                <div className="flex-1 flex items-center gap-1.5">
                  <input
                    type="time"
                    value={getOpen(d)}
                    onChange={(e) => setHours(d, { open: e.target.value })}
                    className="flex-1 border border-slate-300 rounded px-2 text-sm"
                    style={{ minHeight: 44 }}
                    aria-label={`${d} open time`}
                  />
                  <span className="text-slate-400">–</span>
                  <input
                    type="time"
                    value={getClose(d)}
                    onChange={(e) => setHours(d, { close: e.target.value })}
                    className="flex-1 border border-slate-300 rounded px-2 text-sm"
                    style={{ minHeight: 44 }}
                    aria-label={`${d} close time`}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StopProsTabContent({ stop }) {
  const pros = stop.pros || (stop.pro ? [stop.pro] : []);
  const [toast, setToast] = useState(null);
  const copy = (pro) => {
    try {
      navigator.clipboard.writeText(pro);
      setToast(pro);
      setTimeout(() => setToast(null), 2000);
    } catch { /* clipboard blocked */ }
  };
  return (
    <div className="px-4 py-3 text-sm relative">
      <div className="text-[10px] uppercase font-semibold text-slate-500 mb-2">
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
              className="w-full text-left font-mono text-sm text-slate-700 hover:bg-slate-100 active:bg-slate-200 px-3 rounded"
              style={{ minHeight: 48 }}
              title="Tap to copy"
            >
              {p}
            </button>
          ))}
        </div>
      )}
      {toast && (
        <div
          className="absolute left-1/2 -translate-x-1/2 px-3 py-1.5 rounded shadow-lg text-xs text-white"
          style={{ top: 8, background: '#16a34a', zIndex: 60 }}
        >
          Copied “{toast}”
        </div>
      )}
    </div>
  );
}

function MobileToggleRow({ label, checked, onChange }) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer" style={{ minHeight: 44 }}>
      <span className="text-sm text-slate-700">{label}</span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex-shrink-0 relative w-11 h-6 rounded-full transition-colors"
        style={{ background: checked ? '#16a34a' : '#cbd5e1' }}
      >
        <span
          className="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
          style={{ left: checked ? 'calc(100% - 22px)' : '2px' }}
        />
      </button>
    </label>
  );
}

// Mobile driver-snapshot drawer. Replaces the full-screen DriverSnapshotSidebar
// overlay on mobile with a slide-up bottom sheet that re-uses the desktop
// snapshot header + body subcomponents. Tap a stop row → drawer closes, map
// pans, and the caller can open the stop detail drawer.
function MobileDriverSnapshotDrawer({ driver, snapshot, loading, error, onClose, onPickStopFromSnapshot }) {
  if (!driver) return null;
  return (
    <BottomSheet open onClose={onClose} heights={STOP_DETAIL_HEIGHTS} ariaLabel={`Driver snapshot: ${driver.driverName || ''}`}>
      <DriverSnapshotHeader driver={driver} snapshot={snapshot} onClose={onClose} />
      <DriverSnapshotBody
        driver={driver}
        snapshot={snapshot}
        loading={loading}
        error={error}
        onPanToStop={onPickStopFromSnapshot}
      />
    </BottomSheet>
  );
}

function MapScreen() {
  // M5 — selectedDate drives every fetch. Defaults to today (ET) and is NOT
  // persisted: every page load resets to today (brief P2.2).
  const [selectedDate, setSelectedDate] = useState(() => todayInET());
  const dateIsToday = isTodayET(selectedDate);

  const { stops, loading, error, lastRefreshed, lastScannedAt, source, refresh } = useStops(selectedDate);
  const { notes, ready: notesReady } = useCustomerNotes();
  useAutoScanner(stops, notes, notesReady);
  const { google, error: mapsError } = useGoogleMaps();
  const viewportWidth = useViewportWidth();
  const isMobile = viewportWidth < MOBILE_BREAKPOINT;

  const [selectedStop, setSelectedStop] = useState(null);
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [selectedRoute, setSelectedRoute] = useState(null); // M5.2 — loadNbr of opened route, or null
  // M5 — Show Routes toggle (persisted). Polylines render only when ON.
  const [showRoutes, setShowRoutes] = useState(() => safeReadJSON(LS_SHOW_ROUTES, false));
  const [filters, setFilters] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  // M4.5 P3.3 — Driver marker labels are hidden by default on mobile to reduce
  // visual clutter; tapping a marker temporarily reveals the label as a side
  // effect of opening the driver-snapshot drawer (the labels stay visible while
  // the toggle is on; defaulting it off keeps the small viewport readable).
  const [showDriverLabels, setShowDriverLabels] = useState(() => {
    const stored = safeReadJSON(LS_DRIVER_LABELS, null);
    if (typeof stored === 'boolean') return stored;
    const w = typeof window === 'undefined' ? 1280 : window.innerWidth;
    return w >= MOBILE_BREAKPOINT;
  });
  const [legendExpanded, setLegendExpanded] = useState(() => safeReadJSON(LS_LEGEND_EXPANDED, false));
  const [routeLegendExpanded, setRouteLegendExpanded] = useState(() => safeReadJSON(LS_ROUTE_LEGEND_EXPANDED, true));
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
  // M5 — live drivers (Motive) only meaningful for today. On any other date the
  // overlay is forced off regardless of the toggle's stored value.
  const showDrivers = mapFilters.showVehicleLocation && dateIsToday;
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 200);
  const { history, remember } = useSearchHistory();

  // M6 — AI Order Search state. aiMode flips the search box into NL parse mode;
  // aiResult holds the AI-derived match set (from search OR chat) that overrides
  // the literal keyword filter. aiAvailable gates the affordance on the key being
  // configured server-side (probed once via the function's GET endpoint).
  const [aiMode, setAiMode] = useState(false);
  const [aiResult, setAiResult] = useState(null); // { set:Set<stopNbr>, summary, source }
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/.netlify/functions/ai-search')
      .then((r) => r.json())
      .then((d) => { if (alive) setAiAvailable(!!d?.available); })
      .catch(() => { /* leave optimistic; POST surfaces ai_key_missing if needed */ });
    return () => { alive = false; };
  }, []);

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
  const routePolylinesRef = useRef([]);

  // Persist label-toggle preference whenever it changes.
  useEffect(() => { safeWriteJSON(LS_DRIVER_LABELS, showDriverLabels); }, [showDriverLabels]);
  useEffect(() => { safeWriteJSON(LS_LEGEND_EXPANDED, legendExpanded); }, [legendExpanded]);
  useEffect(() => { safeWriteJSON(LS_TABLE_COLUMNS, tableColumns); }, [tableColumns]);
  useEffect(() => { safeWriteJSON(LS_MAP_FILTERS, mapFilters); }, [mapFilters]);
  useEffect(() => { safeWriteJSON(LS_FILTER_TOOLBAR_COLLAPSED, toolbarCollapsed); }, [toolbarCollapsed]);
  useEffect(() => { safeWriteJSON(LS_MOBILE_DRAWER_TAB, mobileDrawerTab); }, [mobileDrawerTab]);
  useEffect(() => { safeWriteJSON(LS_SHOW_ROUTES, showRoutes); }, [showRoutes]);
  useEffect(() => { safeWriteJSON(LS_ROUTE_LEGEND_EXPANDED, routeLegendExpanded); }, [routeLegendExpanded]);

  // M5 — date change side effects: close any open sidebars (their data was for
  // the previous day) and surface a one-shot note if live drivers were on for a
  // now-non-today date. Stops + routes refetch automatically (date is a dep of
  // useStops + the routes memo). The auto-scanner re-runs when new stops land.
  const [driverGateNote, setDriverGateNote] = useState(false);
  const prevDateRef = useRef(selectedDate);
  useEffect(() => {
    if (prevDateRef.current === selectedDate) return;
    prevDateRef.current = selectedDate;
    setSelectedStop(null);
    setSelectedDriver(null);
    if (!dateIsToday && mapFilters.showVehicleLocation) {
      setDriverGateNote(true);
      setTimeout(() => setDriverGateNote(false), 4000);
    }
  }, [selectedDate, dateIsToday, mapFilters.showVehicleLocation]);

  const goToToday = useCallback(() => setSelectedDate(todayInET()), []);

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
    if (aiMode) return null;                       // AI mode: literal keyword filter suspended
    if (!debouncedSearch.trim()) return null;      // null sentinel = no search active
    const set = new Set();
    for (const s of filteredStops) {
      if (stopMatchesSearch(s, notes.get(s.matchKey), debouncedSearch)) set.add(s.stopNbr);
    }
    return set;
  }, [filteredStops, notes, debouncedSearch, aiMode]);

  // M6 — an active AI result (search parse or chat highlight) takes precedence
  // over the literal keyword set. Everything downstream (list + map dim/fit) reads
  // effectiveMatchSet so both surfaces share one filter mechanism.
  const effectiveMatchSet = aiResult ? aiResult.set : searchMatchSet;

  const visibleStops = useMemo(() => {
    if (!effectiveMatchSet) return filteredStops;
    return filteredStops.filter((s) => effectiveMatchSet.has(s.stopNbr));
  }, [filteredStops, effectiveMatchSet]);

  // M6 — AI search/chat handlers. runAiSearch parses the NL query and applies the
  // returned spec locally; runChat builds the trimmed context and asks the model.
  const runAiSearch = useCallback(async (q) => {
    const query = (q || '').trim();
    if (!query) return;
    setAiBusy(true); setAiError(null);
    try {
      const { spec } = await aiParse(query);
      const set = applyFilterSpec(filteredStops, notes, spec);
      const empty = !spec || ((spec.predicates || []).length === 0 && !spec.text_match);
      if (empty || set.size === 0) {
        // Nothing parseable / no matches → fall back to literal keyword search.
        setAiResult(null);
        setAiMode(false);
        setSearchInput(query);
        setAiError(empty ? 'Couldn’t turn that into a filter — showing keyword matches.' : 'No stops matched that — showing keyword matches.');
        return;
      }
      setAiResult({ set, summary: summarizeSpec(spec, set.size), source: 'search' });
      remember(query);
    } catch (e) {
      setAiError(e?.code === 'ai_key_missing'
        ? 'AI search isn’t configured yet (missing API key).'
        : 'AI search is unavailable right now.');
    } finally {
      setAiBusy(false);
    }
  }, [filteredStops, notes, remember]);

  const clearAi = useCallback(() => { setAiResult(null); setAiError(null); }, []);

  const handleChatSend = useCallback(async (q) => {
    const { stops: ctx, truncated, sent, total } = buildTrimmedStops(filteredStops, notes, 400);
    const res = await aiChat(q, ctx);
    return { ...res, truncated, sent, total };
  }, [filteredStops, notes]);

  const handleChatHighlight = useCallback((proIds) => {
    const wanted = new Set((proIds || []).map((p) => String(p).trim()));
    const set = new Set();
    for (const s of filteredStops) if (wanted.has(String(s.stopNbr))) set.add(s.stopNbr);
    setAiResult({ set, summary: `${set.size} stop${set.size === 1 ? '' : 's'} from chat`, source: 'chat' });
  }, [filteredStops]);

  // M5 — route grouping (client-side, mirrors parent app src/screens/MapScreen.jsx).
  // Group positioned stops by loadNbr (sequence restarts per load, so one
  // polyline per load keeps order correct). Color by DRIVER so a driver's
  // multiple loads share a color (brief P3.1). Legend aggregates per driver.
  const routeData = useMemo(() => {
    if (!showRoutes) return { byLoad: [], legend: [] };
    const positioned = stops.filter((s) => s.lat != null && s.lng != null && s.loadNbr && s.driverUserName);
    const loadGroups = new Map();
    for (const s of positioned) {
      if (!loadGroups.has(s.loadNbr)) {
        loadGroups.set(s.loadNbr, {
          loadNbr: s.loadNbr,
          driverUserName: s.driverUserName,
          driverName: s.driverName || s.driverUserName,
          stops: [],
        });
      }
      loadGroups.get(s.loadNbr).stops.push(s);
    }
    const byLoad = [];
    const driverAgg = new Map();
    for (const g of loadGroups.values()) {
      // M5.2 — order by plannedEtaDTTM (compareByPlannedEta). NuVizz's stopSeq is
      // unreliable (parent app audit §7) and loadStopSeq is just the array index
      // from NuVizz's load.stops (creation order, NOT delivery order) — sorting by
      // it produced the anchor-style chaos. Same comparator backs the route detail
      // list, so polyline order == list order.
      const ordered = [...g.stops].sort(compareByPlannedEta);
      const color = routeColorFor(g.driverUserName);
      if (ordered.length >= 2) {
        byLoad.push({ loadNbr: g.loadNbr, driverUserName: g.driverUserName, color, path: ordered });
      }
      const agg = driverAgg.get(g.driverUserName)
        || { driverUserName: g.driverUserName, driverName: g.driverName, color, stopCount: 0 };
      agg.stopCount += g.stops.length;
      driverAgg.set(g.driverUserName, agg);
    }
    const legend = [...driverAgg.values()].sort((a, b) => a.driverUserName.localeCompare(b.driverUserName));
    return { byLoad, legend };
  }, [showRoutes, stops]);

  // M5.2 — the stops on the currently-opened route, kept separate from routeData
  // (which depends on showRoutes). The route detail must render even when the
  // polyline layer is hidden, so derive directly from `stops`.
  const selectedRouteStops = useMemo(() => {
    if (!selectedRoute) return [];
    return stops.filter((s) => s.loadNbr === selectedRoute);
  }, [stops, selectedRoute]);

  // Init map once google + container are ready.
  useEffect(() => {
    if (!google || !mapDiv.current || mapRef.current) return;
    mapRef.current = new google.maps.Map(mapDiv.current, {
      center: BUFORD,
      zoom: 10,
      // Full Google control set + 3D. A vector mapId (VITE_GOOGLE_MAP_ID) unlocks
      // interactive tilt/heading — hold ⌘/Ctrl + drag to tilt and spin around a
      // location; without it the map is raster (rotate control + 45° aerial still
      // work in Satellite where imagery exists).
      ...(MAP_ID ? { mapId: MAP_ID } : {}),
      mapTypeControl: true,
      mapTypeControlOptions: {
        position: google.maps.ControlPosition.LEFT_BOTTOM,
        mapTypeIds: ['roadmap', 'satellite', 'hybrid', 'terrain'],
      },
      streetViewControl: true,
      streetViewControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
      fullscreenControl: true,
      fullscreenControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
      zoomControl: true,
      zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
      rotateControl: true,
      rotateControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
      scaleControl: true,
      tiltInteractionEnabled: true,
      headingInteractionEnabled: true,
      gestureHandling: 'greedy',
    });
    labelOverlayClassRef.current = makeDriverLabelOverlayClass(google);
  }, [google]);

  // M4.4 — satellite/roadmap toggle. 'hybrid' = satellite imagery + road labels,
  // which is most useful for spotting docks/yards while keeping street names.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    mapRef.current.setMapTypeId(mapFilters.satellite ? 'hybrid' : 'roadmap');
  }, [google, mapFilters.satellite]);

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

    // Day-aware receiving-hours clock: only light the clock on the weekday the
    // map is showing. A Friday-only customer's clock appears on Fridays only.
    const selectedDayKey = weekdayKeyFromDate(selectedDate);
    const positioned = filteredStops.filter((s) => s.lat != null && s.lng != null);
    const newMarkers = positioned.map((s) => {
      const note = notes.get(s.matchKey);
      const restrictions = getRestrictionBadgeKeys(note, { day: selectedDayKey });
      const dim = effectiveMatchSet && !effectiveMatchSet.has(s.stopNbr);
      // M4.1.6 — no restrictions → classic pin (State A). 1+ restrictions →
      // the pin disappears and the icon(s) become the marker (States B/C).
      // iconMarkerSvg returns size + anchor based on icon count.
      let icon;
      if (restrictions.length === 0) {
        // M5.1 — status drives the pin. SCHEDULED keeps the note-flag color
        // (no regression); other states use their status hue + shape/glyph.
        const meta = STATUS_META[classifyStopStatus(s)] || STATUS_META.SCHEDULED;
        const color = meta.color || flagColor(note);
        icon = {
          url: pinSvgStatus(color, { hollow: meta.hollow, glyph: meta.glyph }),
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
  }, [google, filteredStops, notes, effectiveMatchSet, mapFilters.showClustered, selectedDate]);

  // M5 — route polylines. One straight-line Polyline per load, ordered by
  // loadStopSeq, colored by driver. zIndex 1 keeps them below markers so pins
  // stay clickable. Google redraws on pan/zoom itself — we only rebuild when
  // routeData changes (toggle, refresh, or selectedDate change all flow through
  // routeData via the stops dependency).
  useEffect(() => {
    if (!google || !mapRef.current) return;
    routePolylinesRef.current.forEach((p) => p.setMap(null));
    routePolylinesRef.current = [];
    if (!showRoutes) return;
    for (const route of routeData.byLoad) {
      const path = route.path
        .filter((s) => s.lat != null && s.lng != null)
        .map((s) => ({ lat: s.lat, lng: s.lng }));
      if (path.length < 2) continue;
      // M5.2 — highlight the open route (thicker, on top, full opacity); when ANY
      // route is open, dim the rest so the dispatcher's eye locks onto the path
      // they're inspecting. No selection → all routes render at normal weight.
      const isSelected = selectedRoute && route.loadNbr === selectedRoute;
      const anySelected = !!selectedRoute;
      const poly = new google.maps.Polyline({
        path,
        strokeColor: route.color,
        strokeOpacity: isSelected ? 1 : (anySelected ? 0.25 : 0.7),
        strokeWeight: isSelected ? 6 : 3,
        geodesic: false,
        zIndex: isSelected ? 3 : 1,
        map: mapRef.current,
      });
      routePolylinesRef.current.push(poly);
    }
  }, [google, showRoutes, routeData, selectedRoute]);

  // Auto-zoom on search results: 1 match → center + open sidebar, 2-10 → fit bounds.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    if (!effectiveMatchSet) return;
    const matched = filteredStops.filter((s) => effectiveMatchSet.has(s.stopNbr) && s.lat != null && s.lng != null);
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
  }, [google, effectiveMatchSet]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Build the driver-status line2 text. Route assignment is managed in NuVizz,
  // not Motive, so we do NOT show a "No route assigned" line on the Motive driver
  // tag — only movement status (en route / stopped / stale). If Motive ever does
  // carry route progress we surface it, but its absence is not reported.
  const driverStatusLine = useCallback((d) => {
    let base = '';
    if (d.routeAssigned && d.routeProgress) {
      base = `Stop ${d.routeProgress.completed} of ${d.routeProgress.total}`;
    } else if (d.routeAssigned && d.routeId) {
      base = `Route ${d.routeId} · ${d.routeTotalStops ?? '?'} stops`;
    }
    const suffix = [];
    if (d.speedMph != null && d.speedMph > 5) suffix.push('en route');
    else if (d.speedMph != null && d.speedMph <= 5 && d.stoppedMinutes != null && d.stoppedMinutes > 5) suffix.push('stopped');
    if (d.locatedAt) {
      const ageMin = (Date.now() - new Date(d.locatedAt).getTime()) / 60000;
      if (ageMin > 30) suffix.push('stale');
    }
    return [base, ...suffix].filter(Boolean).join(' · ');
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
        {/* M5 — date chip at top-left of the mobile map (P2.7): core control,
            visible without opening the drawer. */}
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1 bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow px-1.5 py-1">
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => { if (e.target.value) setSelectedDate(e.target.value); }}
            className="text-[11px] border-0 p-0 focus:outline-none bg-transparent max-w-[112px]"
            aria-label="Select delivery date"
          />
          {!dateIsToday && (
            <button
              onClick={goToToday}
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-blue-300 text-blue-700 active:bg-blue-50"
              title="Today"
            >
              Today
            </button>
          )}
        </div>
        {driverGateNote && (
          <div className="absolute top-12 left-1/2 -translate-x-1/2 z-20 bg-amber-50 border border-amber-300 rounded shadow px-2 py-1 text-[10px] text-amber-800">
            Live drivers only available for today.
          </div>
        )}
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
            <div className="text-slate-500 text-[10px]">{fmtStopFreshness(source, lastScannedAt)}</div>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="p-1 rounded hover:bg-slate-100 active:bg-slate-200 disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          {/* v0.11.3 — explicit Filters entry on mobile. The FAB also opens the
              drawer, but its generic list icon wasn't read as "filters"; this puts
              a labeled control right beside the status pill where dispatchers look. */}
          <span className="w-px self-stretch bg-slate-200" aria-hidden />
          <button
            onClick={() => { setMobileDrawerTab('filters'); setMobileDrawerOpen(true); }}
            className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-slate-100 active:bg-slate-200 font-semibold text-slate-700"
            aria-label="Open filters"
          >
            <Filter size={14} /> Filters
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
        {!selectedStop && !selectedDriver && !selectedRoute && (
          <MobileFAB
            open={mobileDrawerOpen}
            onToggle={() => setMobileDrawerOpen((v) => !v)}
          />
        )}

        {/* M6 — AI chat launcher (mobile). Bottom-left so it never overlaps the
            FAB. Hidden while the panel or an overlay is open. */}
        {aiAvailable && !chatOpen && !selectedStop && !selectedDriver && !selectedRoute && !mobileDrawerOpen && (
          <div className="absolute left-3 z-[39]" style={{ bottom: `calc(20px + env(safe-area-inset-bottom))` }}>
            <ChatLauncher onClick={() => setChatOpen(true)} active={aiResult?.source === 'chat'} />
          </div>
        )}
        <ChatPanel
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          onSend={handleChatSend}
          onHighlight={handleChatHighlight}
          onClear={clearAi}
          highlightActive={aiResult?.source === 'chat'}
          stopCount={filteredStops.length}
        />

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
              aiAvailable={aiAvailable}
              onAskAi={runAiSearch}
              aiBusy={aiBusy}
              aiSummary={aiResult?.source === 'search' ? aiResult.summary : null}
              aiError={aiError}
              onClearAi={clearAi}
            />
          )}
          {mobileDrawerTab === 'filters' && (
            <MobileFiltersTab
              filters={filters}
              setFilters={setFilters}
              counts={{ visible: visibleStops.length, total: stops.length }}
              mapFilters={mapFilters}
              setMapFilters={setMapFilters}
              showRoutes={showRoutes}
              setShowRoutes={setShowRoutes}
              vehicleDisabled={!dateIsToday}
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

        {/* Stop detail drawer — slides up over the map. Tabs Info / Notes /
            Hours / PROs. Editing on Notes or Hours pins a sticky Save bar. */}
        {!selectedDriver && !selectedRoute && selectedStop && (
          <MobileStopDetailDrawer
            stop={selectedStop}
            note={notes.get(selectedStop.matchKey)}
            onClose={() => setSelectedStop(null)}
            onOpenRoute={(loadNbr) => { setSelectedStop(null); setSelectedRoute(loadNbr); }}
            onSave={async (draft) => {
              await handleSave(draft);
              // handleSave clears saveError on success; close the drawer if
              // there was no error this cycle. (saveError is checked on the
              // next render, so we read the post-save state via a setTimeout
              // tick — but simplest: leave the drawer open on save so the
              // user can confirm the green state, and rely on the X to dismiss.)
            }}
            saving={saving}
            saveError={saveError}
          />
        )}

        {/* M5.2 — route detail drawer (mobile). Same bottom-sheet pattern as the
            stop detail; opened from the stop detail's "View full route" button. */}
        {!selectedDriver && selectedRoute && (
          <MobileRouteDetailDrawer
            loadNbr={selectedRoute}
            stops={selectedRouteStops}
            onClose={() => setSelectedRoute(null)}
            onPickStop={(s) => {
              setSelectedRoute(null);
              setSelectedStop(s);
              if (google && mapRef.current && s.lat != null && s.lng != null) {
                mapRef.current.panTo({ lat: s.lat, lng: s.lng });
                mapRef.current.setZoom(Math.max(mapRef.current.getZoom() || 10, 14));
              }
            }}
          />
        )}

        {/* Driver snapshot drawer — slides up over the map. Tap a stop row in
            the snapshot to dismiss the drawer, pan the map, and open the stop
            detail drawer for that stop. */}
        {selectedDriver && (
          <MobileDriverSnapshotDrawer
            driver={selectedDriver}
            snapshot={snapshot}
            loading={snapshotLoading}
            error={snapshotError}
            onClose={() => setSelectedDriver(null)}
            onPickStopFromSnapshot={(snapshotStop) => {
              // Try to resolve the snapshot stop (which has its own row shape)
              // back to a live stop from today's map so we can open the full
              // stop detail drawer. Match on the primary PRO; fall back to any
              // PRO in the stop.pros array. If no match, just pan the map.
              const targetPros = new Set();
              if (snapshotStop.primaryPro) targetPros.add(snapshotStop.primaryPro);
              if (snapshotStop.pro) targetPros.add(snapshotStop.pro);
              if (Array.isArray(snapshotStop.pros)) {
                for (const p of snapshotStop.pros) targetPros.add(p);
              }
              const liveMatch = targetPros.size
                ? stops.find((s) => {
                    if (s.pro && targetPros.has(s.pro)) return true;
                    if (Array.isArray(s.pros)) {
                      for (const p of s.pros) if (targetPros.has(p)) return true;
                    }
                    return false;
                  })
                : null;
              setSelectedDriver(null);
              if (liveMatch) {
                setSelectedStop(liveMatch);
                if (google && mapRef.current && liveMatch.lat != null && liveMatch.lng != null) {
                  mapRef.current.panTo({ lat: liveMatch.lat, lng: liveMatch.lng });
                  mapRef.current.setZoom(Math.max(mapRef.current.getZoom() || 10, 14));
                }
              } else {
                handlePanToStop(snapshotStop);
              }
            }}
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
          aiAvailable={aiAvailable}
          aiMode={aiMode}
          setAiMode={(v) => { setAiMode(v); if (!v) clearAi(); }}
          onAskAi={runAiSearch}
          aiBusy={aiBusy}
          aiSummary={aiResult?.source === 'search' ? aiResult.summary : null}
          aiError={aiError}
          onClearAi={clearAi}
        />
        <FilterPanel
          filters={filters}
          setFilters={setFilters}
          counts={{ visible: visibleStops.length, total: stops.length }}
        />
        <Legend expanded={legendExpanded} setExpanded={setLegendExpanded} />
        {showRoutes && (
          <DriverRouteLegend legend={routeData.legend} expanded={routeLegendExpanded} setExpanded={setRouteLegendExpanded} />
        )}
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
          onPick={(s) => { setSelectedDriver(null); setSelectedStop(s); handlePanToStop(s); }}
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
        {/* M5 — date picker, top-left of the map canvas. */}
        {!isMobile && (
          <div className="absolute top-3 left-3 z-[6]">
            <DatePicker selectedDate={selectedDate} onChange={setSelectedDate} onToday={goToToday} />
          </div>
        )}
        {/* M5.1 — top-right controls live in ONE right-aligned vertical column:
            status pill (row), then the filter toolbar. Stacking them in-flow
            (instead of absolute offsets) means the toolbar can never be buried
            under the pill regardless of the pill's height — the overlap bug
            that hid the toolbar. "Show routes" now lives inside the toolbar. */}
        {!isMobile && (
          <div className="absolute top-3 right-3 z-[6] flex flex-col items-end gap-2">
            <div className="bg-white/95 backdrop-blur border border-slate-200 rounded-lg shadow px-3 py-2 flex items-center gap-3 text-xs">
              <div>
                <div className="font-semibold">{stops.length} stops</div>
                <div className="text-slate-500">{fmtStopFreshness(source, lastScannedAt)}</div>
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
            <FilterToolbar
              filters={mapFilters}
              setFilters={setMapFilters}
              collapsed={toolbarCollapsed}
              setCollapsed={setToolbarCollapsed}
              stopCount={filteredStops.length}
              vehicleDisabled={!dateIsToday}
              showRoutes={showRoutes}
              setShowRoutes={setShowRoutes}
            />
            {/* M6 — AI chat launcher. Sits at the bottom of the right control
                column; hidden while the panel is open (the panel has its own X). */}
            {aiAvailable && !chatOpen && (
              <ChatLauncher onClick={() => setChatOpen(true)} active={aiResult?.source === 'chat'} />
            )}
          </div>
        )}
        {/* M6 — chat panel (fixed; renders as a card on desktop). */}
        <ChatPanel
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          onSend={handleChatSend}
          onHighlight={handleChatHighlight}
          onClear={clearAi}
          highlightActive={aiResult?.source === 'chat'}
          stopCount={filteredStops.length}
        />
        {/* M5 — one-shot note when live drivers were auto-disabled for a past/future date. */}
        {driverGateNote && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[7] bg-amber-50 border border-amber-300 rounded shadow px-3 py-1.5 text-xs text-amber-800">
            Live drivers only available for today's date.
          </div>
        )}
        {mapsError && (
          <div className="absolute top-4 left-4 right-4 bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800 z-[8]">
            <div className="font-semibold">Google Maps failed to load</div>
            <div className="text-xs mt-1">{mapsError}</div>
            <div className="text-xs mt-1 text-red-600">Set VITE_GOOGLE_MAPS_API_KEY in your .env / Netlify env.</div>
          </div>
        )}
        {!visibleStops.length && !loading && !mapsError && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-white border border-slate-200 rounded shadow px-3 py-1.5 text-xs text-slate-600 z-[5] text-center max-w-xs">
            {debouncedSearch
              ? `No stops match "${debouncedSearch}"`
              : dateIsToday
                ? 'No stops match the current filters.'
                : 'No loads are built for this date yet.'}
          </div>
        )}

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
      {!selectedDriver && !selectedRoute && selectedStop && (
        <StopSidebar
          stop={selectedStop}
          note={notes.get(selectedStop.matchKey)}
          onClose={() => setSelectedStop(null)}
          onSave={handleSave}
          saving={saving}
          saveError={saveError}
          onOpenRoute={(loadNbr) => { setSelectedStop(null); setSelectedRoute(loadNbr); }}
        />
      )}
      {!selectedDriver && selectedRoute && (
        <RouteDetailSidebar
          loadNbr={selectedRoute}
          stops={selectedRouteStops}
          onClose={() => setSelectedRoute(null)}
          onPickStop={(s) => {
            setSelectedRoute(null);
            setSelectedStop(s);
            if (google && mapRef.current && s.lat != null && s.lng != null) {
              mapRef.current.panTo({ lat: s.lat, lng: s.lng });
              mapRef.current.setZoom(Math.max(mapRef.current.getZoom() || 10, 14));
            }
          }}
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
    <div className="flex-1 overflow-y-auto p-3 sm:p-6 space-y-4 sm:space-y-6 max-w-4xl mx-auto w-full">
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

// ============================================================================
// Phase 2 (PR 2/2) — Routing (beta) tab. Inline per the single-file rule.
// CHEAP BY DEFAULT (Appendix B): builds run free haversine unless the dispatcher
// explicitly opts into Google live drive-times, and the per-build cost is shown.
// Wires to the merged engine via the routing_jobs job-doc lifecycle; renders
// exactly what the engine returns (no client-side feasibility/sequencing).
// ============================================================================

// Feature flag — Chad turned the Routing (beta) tab ON for all dispatchers
// (v0.14.2). It is now VISIBLE BY DEFAULT. A kill switch remains so it can be
// hidden again without a revert: set env VITE_ROUTING_BETA='false', or append
// ?routing=0 to the URL. Cheap-by-default still holds (free estimate unless the
// Google toggle is used), so exposing it carries no automatic cost.
const ROUTING_FLAG = (() => {
  try {
    if (import.meta.env.VITE_ROUTING_BETA === 'false') return false;
    if (typeof window !== 'undefined' && /[?&]routing=0\b/.test(window.location.search)) return false;
  } catch { /* ignore */ }
  return true;
})();

const ROUTING_DEPOT = { name: 'Buford Terminal', lat: 34.14838, lng: -83.95948 };
const ROUTING_STRATEGIES = [
  ['MIN_DISTANCE', 'Min distance'],
  ['MIN_TIME', 'Min time'],
  ['CLOSEST_FIRST', 'Closest first'],
  ['FARTHEST_FIRST', 'Farthest first'],
];
const ROUTING_MAX_SELECTION = 150; // matrix cost is quadratic (Appendix B)
const BASIC_RATE_PER_1K_USD = 5.0; // mirror of routing-types BASIC_MATRIX_RATE (display only)

// Client-side mirror of the server seed profiles (truck-profiles.mts). Used only
// to seed the truck_profiles collection on first run; the server remains the
// source of truth for a build (it reads truck_profiles by id).
const CLIENT_DEFAULT_TRUCKS = [
  { id: 'box_26', label: '26ft Box', truckClass: 'BOX_26', maxSkids: 14, maxWeightLbs: 10000, deckLengthIn: 312, deckWidthIn: 96, capabilities: { liftgate: true, tractor: false, lengthClassFt: 26, overheadClearance: true }, active: true },
  { id: 'tractor_53', label: '53ft Trailer', truckClass: 'TRACTOR_53', maxSkids: 28, maxWeightLbs: 44000, deckLengthIn: 636, deckWidthIn: 100, capabilities: { liftgate: false, tractor: true, lengthClassFt: 53, overheadClearance: true }, active: true },
];

// ETAs are epoch-seconds anchored to the planning clock (date + depart in UTC),
// so format in UTC to show the intended wall-clock time (e.g. 8:00 AM depart).
function formatRoutingEta(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  return new Date(sec * 1000).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
}

// A selected stop "looks oversize" for the live tally if any line item is NuVizz
// category L. (The authoritative geometry is computed server-side at build time.)
function stopLooksOversize(s) {
  return Array.isArray(s?.stopDetails) && s.stopDetails.some((d) => String(d?.productCategory || '').toUpperCase() === 'L');
}

// Live truck_profiles, seeded on first run. Returns profiles + a persist helper.
function useTruckProfiles() {
  const [profiles, setProfiles] = useState([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!db) { setReady(true); return; }
    const unsub = onSnapshot(collection(db, 'truck_profiles'), async (snap) => {
      if (snap.empty) {
        // Seed defaults once; the snapshot will re-fire with them.
        try { await Promise.all(CLIENT_DEFAULT_TRUCKS.map((p) => setDoc(doc(db, 'truck_profiles', p.id), p))); } catch { /* ignore */ }
        return;
      }
      setProfiles(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setReady(true);
    }, () => setReady(true));
    return () => unsub();
  }, []);
  const saveProfile = useCallback(async (p) => {
    if (!db) return;
    await setDoc(doc(db, 'truck_profiles', p.id), p, { merge: true });
  }, []);
  return { profiles, ready, saveProfile };
}

// Shared, live-synced saved loads. Subscribes to routing_routes (created_at desc)
// so a save/rename/delete/dispatch on ANY device shows here within seconds, no
// refresh. Clean teardown on unmount. Surfaces loading + error explicitly (never
// a silent catch). Each load carries its own `result` (the saved plan).
function useSavedLoads() {
  const [loads, setLoads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!db) { setLoading(false); setError('Firestore not configured'); return; }
    let active = true;
    const q = query(collection(db, 'routing_routes'), orderBy('created_at', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      if (!active) return;
      setLoads(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
      setError(null);
    }, (err) => {
      if (!active) return;
      console.error('routing_routes snapshot error', err);
      setError(err?.message || 'failed to load saved loads');
      setLoading(false);
    });
    return () => { active = false; unsub(); };
  }, []);
  return { loads, loading, error };
}

// Load-vs-capacity bar (one dimension). Amber ≥90%, red >100% (shouldn't happen).
function CapacityBar({ label, used, cap, unit }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const over = used > cap;
  const tight = !over && used > cap * 0.9;
  const color = over ? '#dc2626' : tight ? '#f59e0b' : '#16a34a';
  return (
    <div className="text-[11px]">
      <div className="flex justify-between text-slate-600">
        <span>{label}</span>
        <span>{Math.round(used).toLocaleString()} / {Math.round(cap).toLocaleString()} {unit}</span>
      </div>
      <div className="h-1.5 bg-slate-200 rounded overflow-hidden">
        <div style={{ width: `${pct}%`, background: color }} className="h-full" />
      </div>
    </div>
  );
}

// Drill-in detail for one selected stop. Reuses the parent app's customer_notes
// helpers (getRestrictionBadgeKeys / RESTRICTION_ICONS / formatReceivingHours)
// so a routing stop shows the SAME intelligence as the map markers, plus the
// per-line products from stopDetails[]. Degrades cleanly: a stop with no note
// shows no false flags, and an empty stopDetails[] shows "No line items".
// A stop's PRO / order number as a clickable link that opens the detail popup.
// Falls back to plain text when there's no opener (e.g. inside the popup itself)
// or no number. Never a dead link.
function ProLink({ stop, onOpen, className = '' }) {
  const pro = stop?.pro || stop?.stopNbr || stop?.primaryPro || null;
  if (!pro) return null;
  if (!onOpen) return <span className={className}>#{pro}</span>;
  return (
    <button onClick={(e) => { e.stopPropagation(); onOpen(stop); }} className={`text-blue-700 underline hover:text-blue-900 ${className}`} title="Open stop details">#{pro}</button>
  );
}

// Appointment window label from a stop's scheduled times, e.g. "8:00a–8:05a".
function apptWindowLabel(stop) {
  const from = stop?.scheduledFrom, to = stop?.scheduledTo;
  if (!from && !to) return null;
  return `${from ? fmtTime12(from) : '?'}–${to ? fmtTime12(to) : '?'}`;
}

function RoutingStopDetail({ stop, note, onOpen, windowViolated }) {
  const keys = getRestrictionBadgeKeys(note);
  const oversize = stopLooksOversize(stop);
  const hoursStr = formatReceivingHours(note);
  const lines = Array.isArray(stop.stopDetails) ? stop.stopDetails : [];
  const addr = [stop.addr1, [stop.city, stop.state].filter(Boolean).join(', '), stop.zip].filter(Boolean).join(' · ');
  const contact = (stop.contact && (stop.contact.name || stop.contact.phone)) ? stop.contact
    : (note?.contacts && note.contacts[0]) || null;
  const Cap = ({ children }) => <div className="text-[9px] uppercase font-semibold text-slate-500 tracking-wide">{children}</div>;
  const pro = stop.pro || stop.stopNbr || stop.primaryPro || null;
  return (
    <div className="rounded bg-slate-50 border border-slate-200 p-2 space-y-1.5 text-[11px]">
      <div className="flex gap-6 flex-wrap">
        <div><Cap>Order / PRO</Cap><div className="text-slate-800"><ProLink stop={stop} onOpen={onOpen} className="font-medium" /> {!pro && '—'}</div></div>
        {stop.loadNbr && <div><Cap>Load</Cap><div className="text-slate-800">{stop.loadNbr}</div></div>}
        {stop.bol && <div><Cap>BOL</Cap><div className="text-slate-800">{stop.bol}</div></div>}
        {stop.customerAccount && <div><Cap>Account</Cap><div className="text-slate-800">{stop.customerAccount}</div></div>}
      </div>
      <div><Cap>Business</Cap><div className="text-slate-800 font-medium">{stop.businessName || '—'}</div></div>
      <div><Cap>Address</Cap><div className="text-slate-800">{addr || '—'}</div></div>
      {contact && (
        <div><Cap>Contact</Cap><div className="text-slate-800">{[contact.name, contact.phone].filter(Boolean).join(' · ') || '—'}</div></div>
      )}
      <div className="flex gap-6">
        <div><Cap>Skids</Cap><div className="text-slate-800">{Number(stop.pallets) || 0}</div></div>
        <div><Cap>Loose pcs</Cap><div className="text-slate-800">{Number(stop.cartons) || 0}</div></div>
        <div><Cap>Weight</Cap><div className="text-slate-800">{(Number(stop.weight) || 0).toLocaleString()} lb</div></div>
      </div>
      {(keys.length > 0 || oversize) && (
        <div>
          <Cap>Restrictions</Cap>
          <ul className="mt-0.5">
            {keys.map((k) => (
              <li key={k} className="inline-flex items-center gap-1.5 mr-2 mb-0.5 align-middle">
                <RestrictionIcon kind={k} size={14} /><span>{RESTRICTION_ICONS[k]?.label || k}</span>
              </li>
            ))}
            {oversize && (
              <li className="inline-flex items-center gap-1.5 mr-2 mb-0.5 align-middle">
                <span className="text-[9px] font-bold text-amber-700 border border-amber-400 rounded px-1">OS</span><span>Oversize freight</span>
              </li>
            )}
          </ul>
        </div>
      )}
      {note?.appointment_required && (
        <div><Cap>Appointment</Cap><div className="text-slate-800">Required{note.appointment_notes ? ` — ${note.appointment_notes}` : ''}</div></div>
      )}
      {(apptWindowLabel(stop) || windowViolated) && (
        <div>
          <Cap>Appointment window</Cap>
          <div className="text-slate-800">
            {apptWindowLabel(stop) || '—'}{String(stop.timeConstraint || '').toUpperCase() === 'STRICT' ? ' (strict)' : ''}
            {windowViolated && <span className="ml-1 text-amber-700 font-semibold">⚠ outside appointment window</span>}
          </div>
        </div>
      )}
      {hoursStr && <div><Cap>Receiving hours</Cap><div className="text-slate-800">{hoursStr}</div></div>}
      <div>
        <Cap>Products / line items</Cap>
        {lines.length === 0 ? (
          <div className="text-slate-400 italic">No line items</div>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {lines.map((d, i) => {
              const name = d.product || d.sku || 'Item';
              const sku = d.sku && d.product ? ` (${d.sku})` : '';
              const qty = d.quantity != null ? `${d.quantity}${d.quantityUOM ? ` ${d.quantityUOM}` : ''}` : null;
              const wt = d.weight != null ? `${Number(d.weight).toLocaleString()}${d.weightUOM ? ` ${d.weightUOM}` : ''}` : null;
              const dims = lineItemDims(d);
              const meta = [qty, wt, dims].filter(Boolean).join(' · ');
              return (
                <li key={i} className="text-slate-800">
                  {name}{sku}{String(d.productCategory || '').toUpperCase() === 'L' && <span className="ml-1 text-[9px] font-bold text-amber-700">·OS</span>}
                  {meta && <span className="text-slate-500"> — {meta}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// Full-detail popup for a stop, opened from any PRO/order-number link. Body reuses
// RoutingStopDetail (the single detail view). Closes via X, backdrop, or Esc.
// Never opens empty — guards a null stop.
function RoutingStopModal({ stop, notes, onClose, windowViolatedSet }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!stop) return null;
  const note = notes?.get?.(stop.matchKey) || null;
  const pro = stop.pro || stop.stopNbr || stop.primaryPro || '';
  const windowViolated = !!(windowViolatedSet && windowViolatedSet.has(String(stop.stopNbr || stop.pro)));
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md max-h-[85vh] flex flex-col" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
          <div className="min-w-0">
            <div className="font-bold text-slate-800 truncate">{stop.businessName || `Stop ${pro}`}</div>
            {pro && <div className="text-[11px] text-slate-500">Order / PRO #{pro}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-1 shrink-0">×</button>
        </div>
        <div className="overflow-y-auto p-3">
          <RoutingStopDetail stop={stop} note={note} windowViolated={windowViolated} />
        </div>
      </div>
    </div>
  );
}

// The selected-stops list — the source of truth for "what is actually selected".
// Mobile: collapsed by default, tap the header to expand. Desktop: persistent
// (parent opens it by default). Each row taps open an inline detail accordion;
// the × removes the stop from the selection (two-way sync via onRemove). Columns
// are sortable via the shared useSortable hook.
function RoutingSelectedList({ selectedStops, notes, onRemove, open, setOpen, onOpenStop }) {
  const [detailId, setDetailId] = useState(null);
  const rows = useMemo(() => selectedStops.map((s) => {
    const note = notes.get(s.matchKey) || null;
    return {
      id: String(s.stopNbr), stop: s, note,
      keys: getRestrictionBadgeKeys(note),
      oversize: stopLooksOversize(s),
      customer: s.businessName || String(s.stopNbr),
      city: s.city || '',
      skids: Number(s.pallets) || 0,
      pieces: Number(s.cartons) || 0,
      weight: Number(s.weight) || 0,
    };
  }), [selectedStops, notes]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, 'customer', 'asc');
  const SortBtn = ({ label, k }) => (
    <button onClick={() => toggle(k)} className="inline-flex items-center gap-0.5 hover:text-slate-700">
      {label}{sortKey === k ? (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}
    </button>
  );
  return (
    <div className="border rounded">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-2 py-1.5 text-[12px] font-semibold text-slate-700">
        <span>Selected stops ({rows.length})</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (rows.length === 0 ? (
        <div className="px-2 pb-2 text-[11px] text-slate-400">No stops selected yet. Tap a stop on the map, or use Add in view / Box / Lasso.</div>
      ) : (
        <div className="border-t">
          <div className="flex items-center gap-3 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500 border-b bg-slate-50">
            <SortBtn label="Customer" k="customer" /><SortBtn label="City" k="city" /><SortBtn label="Skids" k="skids" /><SortBtn label="Pcs" k="pieces" /><SortBtn label="Wt" k="weight" />
          </div>
          <div className="max-h-[42vh] overflow-y-auto divide-y">
            {sorted.map((r) => (
              <div key={r.id}>
                <div className="flex items-start gap-2 px-2 py-1.5">
                  <button onClick={() => setDetailId((d) => (d === r.id ? null : r.id))} className="flex-1 text-left min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium truncate">{r.customer}</span>
                      {detailId === r.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">{[r.city, `${r.skids} skid${r.skids === 1 ? '' : 's'}`, `${r.pieces} pc${r.pieces === 1 ? '' : 's'}`, `${r.weight.toLocaleString()} lb`].filter(Boolean).join(' · ')}</div>
                    {(r.keys.length > 0 || r.oversize) && (
                      <div className="flex flex-wrap items-center gap-1 mt-0.5">
                        {r.keys.map((k) => <RestrictionIcon key={k} kind={k} size={14} />)}
                        {r.oversize && <span className="text-[9px] font-bold text-amber-700 border border-amber-400 rounded px-1" title="Oversize freight">OS</span>}
                      </div>
                    )}
                  </button>
                  <span className="text-[11px] shrink-0"><ProLink stop={r.stop} onOpen={onOpenStop} /></span>
                  <button onClick={() => onRemove(r.id)} aria-label={`Remove ${r.customer} from selection`} className="text-slate-400 hover:text-red-600 px-1 leading-none text-lg shrink-0">×</button>
                </div>
                {detailId === r.id && <div className="px-2 pb-2"><RoutingStopDetail stop={r.stop} note={r.note} onOpen={onOpenStop} /></div>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Desktop right-rail variant of the selected-stops list: a full, always-visible
// sortable table with live map<->list hover linkage (hovering a row emphasizes
// its marker and vice-versa via the shared hoverId), a per-row remove, and a
// docked detail panel below the table. Reuses RoutingStopDetail + the same
// customer_notes / stopDetails helpers. The selection is the single source of
// truth (rows derive from selectedStops; remove flows back through onRemove).
function RoutingStopsPanel({ selectedStops, notes, onRemove, hoverId, setHoverId, onOpenStop }) {
  const [detailId, setDetailId] = useState(null);
  const rowRefs = useRef(new Map());
  const rows = useMemo(() => selectedStops.map((s) => {
    const note = notes.get(s.matchKey) || null;
    return {
      id: String(s.stopNbr), stop: s, note,
      keys: getRestrictionBadgeKeys(note), oversize: stopLooksOversize(s),
      customer: s.businessName || String(s.stopNbr), city: s.city || '',
      skids: Number(s.pallets) || 0, pieces: Number(s.cartons) || 0, weight: Number(s.weight) || 0,
    };
  }), [selectedStops, notes]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, 'customer', 'asc');
  // Keep the hovered row visible. block:'nearest' is a no-op when the row is
  // already on screen (pointer hover), so this only scrolls for map-driven hover.
  useEffect(() => {
    if (hoverId) rowRefs.current.get(hoverId)?.scrollIntoView({ block: 'nearest' });
  }, [hoverId]);
  // The active detail stop may have been removed from the selection.
  const detailRow = rows.find((r) => r.id === detailId) || null;

  if (rows.length === 0) {
    return <div className="p-4 text-[12px] text-slate-400">No stops selected yet. Click a stop on the map, drag a box, lasso, or use “Add stops in view”.</div>;
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-slate-50 sticky top-0 z-10">
            <tr>
              <SortableTh label="Customer" k="customer" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="City" k="city" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="Skids" k="skids" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="Pcs" k="pieces" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="Wt" k="weight" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <th className="px-1" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const active = detailId === r.id, hot = hoverId === r.id;
              return (
                <tr
                  key={r.id}
                  ref={(el) => { if (el) rowRefs.current.set(r.id, el); else rowRefs.current.delete(r.id); }}
                  onMouseEnter={() => setHoverId(r.id)}
                  onMouseLeave={() => setHoverId((h) => (h === r.id ? null : h))}
                  onClick={() => setDetailId((d) => (d === r.id ? null : r.id))}
                  className={`border-t cursor-pointer ${active ? 'bg-blue-50 ring-1 ring-inset ring-blue-300' : hot ? 'bg-amber-50' : 'hover:bg-slate-50'}`}
                >
                  <td className="px-2 py-1.5 max-w-[180px]">
                    <div className="truncate font-medium" title={r.customer}>{r.customer}</div>
                    {(r.keys.length > 0 || r.oversize) && (
                      <div className="flex flex-wrap items-center gap-1 mt-0.5">
                        {r.keys.map((k) => <RestrictionIcon key={k} kind={k} size={13} />)}
                        {r.oversize && <span className="text-[9px] font-bold text-amber-700 border border-amber-400 rounded px-1" title="Oversize freight">OS</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-slate-600 max-w-[110px] truncate" title={r.city}>{r.city}</td>
                  <td className="px-2 py-1.5 tabular-nums">{r.skids}</td>
                  <td className="px-2 py-1.5 tabular-nums">{r.pieces}</td>
                  <td className="px-2 py-1.5 tabular-nums">{r.weight.toLocaleString()}</td>
                  <td className="px-1 py-1.5 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <ProLink stop={r.stop} onOpen={onOpenStop} className="text-[11px] mr-1" />
                    <button onClick={(e) => { e.stopPropagation(); onRemove(r.id); }} aria-label={`Remove ${r.customer} from selection`} className="text-slate-400 hover:text-red-600 leading-none text-lg">×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {detailRow && (
        <div className="shrink-0 border-t bg-white max-h-[42%] overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-1.5 border-b bg-slate-50">
            <div className="font-semibold text-[13px] truncate">{detailRow.customer}</div>
            <button onClick={() => setDetailId(null)} className="text-slate-400 hover:text-slate-700 text-lg leading-none" aria-label="Close detail">×</button>
          </div>
          <div className="p-3"><RoutingStopDetail stop={detailRow.stop} note={detailRow.note} onOpen={onOpenStop} /></div>
        </div>
      )}
    </div>
  );
}

// Persistent build badge for the Routing surface (the map-view chip + desktop
// footer don't reach here). Sits in the map's top-right corner — visible on every
// routing tab (Stops/Loads/Result) at both widths since the map is always shown.
// pointer-events-none so it never blocks map drag/selection. Shows app version +
// short commit + deploy context; degrades to "local · dev" with no Netlify env.
function RoutingBuildBadge({ onClick }) {
  const built = BUILD_TIME ? ` · built ${BUILD_TIME.slice(5, 16).replace('T', ' ')}Z` : '';
  return (
    <button
      onClick={onClick}
      className="absolute top-2 right-2 z-20 select-none bg-white/85 hover:bg-white border border-slate-200 rounded px-1.5 py-0.5 text-[10px] leading-none text-slate-500 shadow-sm"
      title={`Dispatch Map v${APP_VERSION} · ${BUILD_SHORT} · ${BUILD_CONTEXT}${built} — tap for version history`}
    >
      v{APP_VERSION} · {BUILD_SHORT} · {BUILD_CONTEXT}
    </button>
  );
}

// Beta version history popup (opened from the build badge).
function VersionLogModal({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-sm max-h-[85vh] flex flex-col" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
          <div className="font-bold text-slate-800">Beta version history</div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-1">×</button>
        </div>
        <div className="overflow-y-auto p-2">
          <div className="px-1 pb-2 text-[10px] text-slate-400">Build {BUILD_SHORT} · {BUILD_CONTEXT}</div>
          <ul className="divide-y">
            {VERSION_LOG.map(([v, note]) => {
              const current = v === APP_VERSION;
              return (
                <li key={v} className={`flex gap-2 px-1 py-1.5 text-[12px] ${current ? 'bg-emerald-50 rounded' : ''}`}>
                  <span className="font-bold tabular-nums shrink-0" style={{ color: current ? '#16a34a' : '#334155' }}>v{v}</span>
                  <span className="text-slate-600">{note}{current ? ' — current' : ''}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

function RoutingScreen() {
  const [selectedDate, setSelectedDate] = useState(() => todayInET());
  const { stops, loading, error: stopsError } = useStops(selectedDate);
  const { notes } = useCustomerNotes();
  const { profiles, saveProfile } = useTruckProfiles();
  const { google, error: mapsError } = useGoogleMaps();
  const viewportWidth = useViewportWidth();
  const isMobile = viewportWidth < MOBILE_BREAKPOINT;

  const mapDiv = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const polylinesRef = useRef([]);
  const [mapReady, setMapReady] = useState(0);

  // Touch-native selection. No DrawingManager (its drag-to-draw never worked on
  // a phone and its async load could silently no-op): Box = tap two corners,
  // Lasso = tap vertices then Done — both driven by plain map click listeners,
  // so every tool works identically on touch and mouse. Refs hold the in-flight
  // geometry + preview overlays; state drives the prompts.
  const [selectMode, setSelectMode] = useState(null);   // null | 'box' | 'lasso'
  const [boxStep, setBoxStep] = useState(0);             // corners placed so far
  const [lassoCount, setLassoCount] = useState(0);       // vertices placed so far
  const [lastAction, setLastAction] = useState(null);    // visible "N added" feedback
  const selectModeRef = useRef(null);
  const boxCornersRef = useRef([]);
  const lassoVtxRef = useRef([]);
  const tempMarkersRef = useRef([]);   // corner/vertex dots
  const tempShapeRef = useRef(null);   // lasso preview polyline
  const handleSelectPointRef = useRef(() => {});
  useEffect(() => { selectModeRef.current = selectMode; }, [selectMode]);

  // Live map<->list linkage: the hovered stop id is shared between the markers
  // and the desktop stop table, so emphasis is two-directional.
  const [hoverId, setHoverId] = useState(null);
  const hoverIdRef = useRef(null);
  useEffect(() => { hoverIdRef.current = hoverId; }, [hoverId]);
  const markerByIdRef = useRef(new Map());  // stopId -> { marker, sel, routed }
  const lastEmphRef = useRef(null);

  // Desktop click-drag rubber-band box. The overlay (rendered over the map only
  // while Box mode is armed on desktop) captures the drag so it doesn't pan the
  // map; mouseup converts the two pixel corners to LatLng via the map projection
  // and reuses the proven boxFromCorners + latLngInBounds geometry.
  const overlayRef = useRef(null);         // google.maps.OverlayView for px->latlng
  const dragStartRef = useRef(null);
  const [dragRect, setDragRect] = useState(null);

  // Desktop freehand drag-lasso: a pointer-captured SVG path (NOT DrawingManager).
  // While lasso mode is armed the overlay intercepts pointer events so the map
  // can't pan; pointer-up converts the pixel path to LatLng and selects via
  // pointInPolygon. (Touch keeps the tap-vertices lasso — no overlay on mobile.)
  const lassoDrawingRef = useRef(false);
  const lassoPxRef = useRef([]);
  const [lassoPath, setLassoPath] = useState([]);

  // PRO-number detail popup — the stop being shown, or null.
  const [detailModalStop, setDetailModalStop] = useState(null);
  const [versionLogOpen, setVersionLogOpen] = useState(false);
  const openStop = useCallback((s) => setDetailModalStop(s || null), []);

  // Desktop right rail: Stops | Result. Persisted as a view pref (localStorage ok).
  const [desktopRail, setDesktopRail] = useState(() => {
    try { return localStorage.getItem('routing.rail') === 'result' ? 'result' : 'stops'; } catch { return 'stops'; }
  });
  useEffect(() => { try { localStorage.setItem('routing.rail', desktopRail); } catch { /* ignore */ } }, [desktopRail]);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedTruckIds, setSelectedTruckIds] = useState(() => new Set());
  const [intent, setIntent] = useState('');
  const [strategy, setStrategy] = useState('MIN_DISTANCE');
  const [useGoogle, setUseGoogle] = useState(false);
  const [job, setJob] = useState(null);     // { status, result, error }
  const [building, setBuilding] = useState(false);
  const [saveState, setSaveState] = useState(null); // null | 'saving' | 'saved' | error string
  const [lastRequest, setLastRequest] = useState(null);

  const positioned = useMemo(() => stops.filter((s) => s.lat != null && s.lng != null), [stops]);
  const stopById = useMemo(() => new Map(positioned.map((s) => [String(s.stopNbr), s])), [positioned]);
  const positionedRef = useRef(positioned);
  useEffect(() => { positionedRef.current = positioned; }, [positioned]);

  // Default trucks selected once profiles load.
  useEffect(() => {
    if (profiles.length && selectedTruckIds.size === 0) setSelectedTruckIds(new Set(profiles.map((p) => p.id)));
  }, [profiles]); // eslint-disable-line

  const result = job?.status === 'done' ? job.result : null;

  // ── Shared loads (live) + "view a saved load" mode ──
  // Viewing a saved load NEVER touches the live build state (selectedIds /
  // routeState / job / selectedDate). It only swaps what's RENDERED: baseResult +
  // the effective stop map. "Back to build" clears it and the in-progress build is
  // exactly as it was.
  const { loads, loading: loadsLoading, error: loadsError } = useSavedLoads();
  const [viewedLoad, setViewedLoad] = useState(null);
  const [manageError, setManageError] = useState(null);
  const viewing = !!viewedLoad;
  const baseResult = viewedLoad ? viewedLoad.result : result;

  // A saved load carries its own stop snapshot so it renders on the map on any day
  // (names + coords), independent of today's live cache. Old saves without it fall
  // back to the live stopById (same-day loads still work).
  const snapStopById = useMemo(() => {
    const snap = viewedLoad?.stops_snapshot;
    if (!snap) return null;
    const m = new Map();
    for (const [id, v] of Object.entries(snap)) {
      m.set(String(id), { stopNbr: String(id), businessName: v.name ?? id, lat: v.lat, lng: v.lng, pallets: v.pallets ?? null, cartons: v.cartons ?? null, weight: v.weight ?? null });
    }
    return m;
  }, [viewedLoad]);

  // ── Manual route reorder (client-side override of the engine's order) ──
  // routeState holds the CURRENT order per truck (the panel is the source of
  // truth) plus a `reordered` flag. It seeds from the engine result and the
  // dispatcher drags / moves stops to mutate it; the map + panel + recompute all
  // read from here. The engine is never called to reorder.
  const [routeState, setRouteState] = useState(null);
  useEffect(() => {
    if (result && Array.isArray(result.routes)) {
      const init = {};
      for (const r of result.routes) init[r.truckId] = { order: [...r.orderedStopIds], reordered: false };
      setRouteState(init);
    } else {
      setRouteState(null);
    }
  }, [result]);

  const reorderStop = useCallback((truckId, from, to) => {
    setRouteState((prev) => {
      if (!prev || !prev[truckId]) return prev;
      const order = moveItem(prev[truckId].order, from, to);
      if (order === prev[truckId].order || order.length !== prev[truckId].order.length) return prev;
      // moveItem returns a new array even on no-op; detect a real change:
      const changed = order.some((id, i) => id !== prev[truckId].order[i]);
      if (!changed) return prev;
      return { ...prev, [truckId]: { order, reordered: true } };
    });
  }, []);
  const moveStop = useCallback((truckId, index, dir) => reorderStop(truckId, index, index + dir), [reorderStop]);

  // Effective stop map / list — the saved load's snapshot when viewing one
  // (renders any day), else today's live stops. Selection/build always use the
  // live stopById; only the RESULT rendering switches.
  const vStopById = (viewing && snapStopById && snapStopById.size) ? snapStopById : stopById;
  const vPositioned = useMemo(
    () => (viewing ? [...vStopById.values()].filter((s) => s.lat != null && s.lng != null) : positioned),
    [viewing, vStopById, positioned],
  );

  // Per-route display: the CURRENT order, plus legs/ETAs/totals. Live build = the
  // engine's order or a haversine recompute after a manual reorder (read/write).
  // Viewing a saved load = render exactly as saved (read-only); its honesty flags
  // (manualReorder / matrixSource) carry through from the doc.
  const routesView = useMemo(() => {
    const res = baseResult;
    if (!res || !Array.isArray(res.routes)) return [];
    if (!viewing && !routeState) return [];
    const depot = res.meta?.depot || ROUTING_DEPOT;
    const departSec = Number(res.meta?.departEpochSec) || 0;
    const serviceSec = Number(res.meta?.serviceMin) > 0 ? Number(res.meta.serviceMin) * 60 : DEFAULT_SERVICE_SEC;
    const sum = (legs, k) => (Array.isArray(legs) ? legs.reduce((a, l) => a + (Number(l?.[k]) || 0), 0) : null);
    return res.routes.map((r, i) => {
      const color = ROUTE_PALETTE[i % ROUTE_PALETTE.length];
      if (viewing) {
        const reordered = !!(r.manualReorder || res.manualReorder);
        return { truckId: r.truckId, color, order: r.orderedStopIds || [], reordered, etas: r.etas, legs: r.legs,
          totalDistanceMeters: sum(r.legs, 'distanceMeters'), totalDurationSec: sum(r.legs, 'durationSec'), route: r };
      }
      const st = routeState[r.truckId] || { order: r.orderedStopIds, reordered: false };
      if (!st.reordered) {
        return { truckId: r.truckId, color, order: st.order, reordered: false, etas: r.etas, legs: r.legs,
          totalDistanceMeters: sum(r.legs, 'distanceMeters'), totalDurationSec: sum(r.legs, 'durationSec'), route: r };
      }
      const orderedStops = st.order.map((id) => { const s = stopById.get(String(id)); return s ? { id: String(id), lat: s.lat, lng: s.lng } : null; }).filter(Boolean);
      const rc = recomputeRoute(orderedStops, depot, departSec, serviceSec);
      return { truckId: r.truckId, color, order: st.order, reordered: true, etas: rc.etas, legs: rc.legs,
        totalDistanceMeters: rc.totalDistanceMeters, totalDurationSec: rc.totalDurationSec, route: r };
    });
  }, [baseResult, viewing, routeState, stopById]);

  // stopId -> { color, seq } for the numbered route markers (panel & map match).
  const routeInfo = useMemo(() => {
    const m = new Map();
    routesView.forEach((rv) => rv.order.forEach((id, idx) => m.set(String(id), { color: rv.color, seq: idx + 1 })));
    return m;
  }, [routesView]);

  // The plan to persist on Save — engine result with any manual order applied.
  const editedResultForSave = useMemo(() => {
    if (!result) return null;
    const anyReordered = routeState && Object.values(routeState).some((s) => s.reordered);
    if (!anyReordered) return result;
    const byTruck = new Map(routesView.map((rv) => [rv.truckId, rv]));
    return {
      ...result,
      manualReorder: true,
      routes: result.routes.map((r) => {
        const rv = byTruck.get(r.truckId);
        if (!rv || !rv.reordered) return r;
        return { ...r, orderedStopIds: rv.order, etas: rv.etas, legs: rv.legs, manualReorder: true, drivenEstimate: 'haversine' };
      }),
    };
  }, [result, routeState, routesView]);

  // Selection tally + a SPECIFIC per-restriction summary (replaces the old vague
  // "equipment restriction in selection" line). Counts each restriction key and
  // oversize across the selected stops, resolved through the same helpers the
  // map markers use.
  const tally = useMemo(() => {
    let skids = 0, pieces = 0, weight = 0;
    const counts = {};
    let oversize = 0;
    for (const id of selectedIds) {
      const s = stopById.get(String(id));
      if (!s) continue;
      skids += Number(s.pallets) || 0;
      pieces += Number(s.cartons) || 0;
      weight += Number(s.weight) || 0;
      if (stopLooksOversize(s)) oversize += 1;
      const note = notes.get(s.matchKey);
      for (const k of getRestrictionBadgeKeys(note || null)) counts[k] = (counts[k] || 0) + 1;
    }
    const summary = Object.entries(counts).map(([k, n]) => `${n} ${RESTRICTION_ICONS[k]?.short || k}`);
    if (oversize) summary.push(`${oversize} oversize`);
    return { count: selectedIds.size, skids, pieces, weight, summary };
  }, [selectedIds, stopById, notes]);

  const selectedStops = useMemo(
    () => [...selectedIds].map((id) => stopById.get(String(id))).filter(Boolean),
    [selectedIds, stopById],
  );

  const toggleStop = useCallback((id) => {
    setSelectedIds((prev) => { const n = new Set(prev); const k = String(id); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }, []);
  const removeStop = useCallback((id) => {
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(String(id)); return n; });
  }, []);
  const clearSelection = useCallback(() => { setSelectedIds(new Set()); setLastAction('Cleared selection'); }, []);

  // The selected-stops list: persistent on desktop, collapsed by default on mobile.
  const [listOpen, setListOpen] = useState(!isMobile);
  useEffect(() => { setListOpen(!isMobile); }, [isMobile]);

  // ── Touch-native selection primitives ──
  const clearTemp = useCallback(() => {
    tempMarkersRef.current.forEach((m) => m.setMap(null));
    tempMarkersRef.current = [];
    if (tempShapeRef.current) { tempShapeRef.current.setMap(null); tempShapeRef.current = null; }
  }, []);
  const addTempMarker = useCallback((latLng) => {
    if (!google || !mapRef.current) return;
    const m = new google.maps.Marker({
      position: latLng, map: mapRef.current, clickable: false, zIndex: 60,
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: '#f59e0b', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5 },
    });
    tempMarkersRef.current.push(m);
  }, [google]);
  const redrawLasso = useCallback(() => {
    if (!google || !mapRef.current) return;
    if (tempShapeRef.current) tempShapeRef.current.setMap(null);
    tempShapeRef.current = new google.maps.Polyline({
      path: lassoVtxRef.current.map((v) => ({ lat: v.lat, lng: v.lng })),
      strokeColor: BRAND, strokeWeight: 2, strokeOpacity: 0.9, map: mapRef.current, zIndex: 55,
    });
  }, [google]);
  const cancelMode = useCallback(() => {
    clearTemp();
    boxCornersRef.current = []; lassoVtxRef.current = [];
    lassoDrawingRef.current = false; lassoPxRef.current = []; setLassoPath([]);
    selectModeRef.current = null;
    setSelectMode(null); setBoxStep(0); setLassoCount(0);
  }, [clearTemp]);
  const beginMode = useCallback((mode) => {
    clearTemp();
    boxCornersRef.current = []; lassoVtxRef.current = [];
    selectModeRef.current = mode;
    setSelectMode(mode); setBoxStep(0); setLassoCount(0); setLastAction(null);
  }, [clearTemp]);
  const addEnclosed = useCallback((arr) => {
    if (!arr.length) { setLastAction('No stops in that area'); return; }
    setSelectedIds((prev) => { const n = new Set(prev); for (const s of arr) n.add(String(s.stopNbr)); return n; });
    setLastAction(`Added ${arr.length} stop${arr.length === 1 ? '' : 's'}`);
  }, []);
  const addInView = useCallback(() => {
    if (!google || !mapRef.current) { setLastAction('Map not ready'); return; }
    const b = mapRef.current.getBounds();
    if (!b) { setLastAction('Map not ready'); return; }
    const ne = b.getNorthEast(), sw = b.getSouthWest();
    const box = { north: ne.lat(), south: sw.lat(), east: ne.lng(), west: sw.lng() };
    addEnclosed(positionedRef.current.filter((s) => latLngInBounds(s.lat, s.lng, box)));
  }, [google, addEnclosed]);
  const finishLasso = useCallback(() => {
    const verts = lassoVtxRef.current;
    if (verts.length < 3) { setLastAction('Tap at least 3 points first'); return; }
    const poly = verts.map((v) => [v.lat, v.lng]);
    const enclosed = positionedRef.current.filter((s) => pointInPolygon(s.lat, s.lng, poly));
    addEnclosed(enclosed);
    cancelMode();
  }, [addEnclosed, cancelMode]);
  // A tap on the map (or a marker) while a draw mode is active places a corner /
  // vertex. The once-bound map listener calls the latest version via a ref.
  const handleSelectPoint = useCallback((latLng) => {
    const mode = selectModeRef.current;
    if (!mode || !google || !mapRef.current || !latLng) return;
    if (mode === 'box') {
      boxCornersRef.current.push({ lat: latLng.lat(), lng: latLng.lng() });
      addTempMarker(latLng);
      if (boxCornersRef.current.length >= 2) {
        const box = boxFromCorners(boxCornersRef.current[0], boxCornersRef.current[1]);
        addEnclosed(positionedRef.current.filter((s) => latLngInBounds(s.lat, s.lng, box)));
        cancelMode();
      } else {
        setBoxStep(1);
      }
    } else if (mode === 'lasso') {
      lassoVtxRef.current.push({ lat: latLng.lat(), lng: latLng.lng() });
      addTempMarker(latLng);
      redrawLasso();
      setLassoCount(lassoVtxRef.current.length);
    }
  }, [google, addTempMarker, addEnclosed, redrawLasso, cancelMode]);
  useEffect(() => { handleSelectPointRef.current = handleSelectPoint; }, [handleSelectPoint]);

  // Base marker icon. Routed (`numbered`) stops are GREEN + slightly larger for
  // legibility (truck distinction is the per-truck route LINE color, not the dot);
  // a RESTRICTED routed stop keeps its signal via a red ring. Selection-phase dots
  // (pre-build) are unchanged (gray unselected / brand-blue selected). Hover emphasis
  // is layered on via emphIcon (keeps the label + ring).
  const ROUTED_GREEN = '#16a34a';
  const makeMarkerIcon = useCallback((sel, routed, numbered, restricted) => ({
    path: google?.maps.SymbolPath.CIRCLE,
    scale: numbered ? 14 : (sel || routed ? 7 : 4.5),
    fillColor: numbered ? ROUTED_GREEN : (routed || (sel ? BRAND : '#94a3b8')),
    fillOpacity: 0.95,
    strokeColor: numbered && restricted ? '#dc2626' : '#fff',
    strokeWeight: numbered && restricted ? 3 : 1.5,
  }), [google]);
  const emphIcon = useCallback((base) => ({ ...base, scale: base.scale + 2.5, strokeColor: '#0f172a', strokeWeight: 2 }), []);

  // Desktop drag-box: convert a container-pixel point to LatLng via the overlay
  // projection (exact, unlike interpolating viewport bounds).
  const pxToLatLng = useCallback((px, py) => {
    const proj = overlayRef.current?.getProjection();
    if (!proj || !google) return null;
    return proj.fromContainerPixelToLatLng(new google.maps.Point(px, py));
  }, [google]);
  const relPoint = (e) => { const r = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onBoxDown = useCallback((e) => { const p = relPoint(e); dragStartRef.current = p; setDragRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }, []);
  const onBoxMove = useCallback((e) => { if (!dragStartRef.current) return; const p = relPoint(e); setDragRect({ x0: dragStartRef.current.x, y0: dragStartRef.current.y, x1: p.x, y1: p.y }); }, []);
  const onBoxUp = useCallback((e) => {
    const start = dragStartRef.current;
    dragStartRef.current = null; setDragRect(null);
    if (!start) return;
    const p = relPoint(e);
    if (Math.abs(p.x - start.x) < 4 && Math.abs(p.y - start.y) < 4) { cancelMode(); return; } // a click, not a drag
    const a = pxToLatLng(start.x, start.y), b = pxToLatLng(p.x, p.y);
    if (a && b) {
      const box = boxFromCorners({ lat: a.lat(), lng: a.lng() }, { lat: b.lat(), lng: b.lng() });
      addEnclosed(positionedRef.current.filter((s) => latLngInBounds(s.lat, s.lng, box)));
    }
    cancelMode();
  }, [pxToLatLng, addEnclosed, cancelMode]);

  // Desktop freehand drag-lasso (pointer-captured; stays armed for repeat draws —
  // the Cancel button / Esc exits). pointInPolygon over the drawn pixel path
  // mapped to LatLng, reusing the proven selection geometry.
  const onLassoDown = useCallback((e) => { const p = relPoint(e); lassoDrawingRef.current = true; lassoPxRef.current = [p]; setLassoPath([p]); }, []);
  const onLassoMove = useCallback((e) => {
    if (!lassoDrawingRef.current) return;
    const p = relPoint(e);
    const arr = lassoPxRef.current;
    const last = arr[arr.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 3) return; // throttle by distance
    arr.push(p); setLassoPath([...arr]);
  }, []);
  const onLassoUp = useCallback(() => {
    if (!lassoDrawingRef.current) return;
    lassoDrawingRef.current = false;
    const pts = lassoPxRef.current;
    lassoPxRef.current = []; setLassoPath([]);
    if (pts.length < 3) { setLastAction('Draw a longer shape around the stops'); return; }
    const poly = pts.map((p) => { const ll = pxToLatLng(p.x, p.y); return ll ? [ll.lat(), ll.lng()] : null; }).filter(Boolean);
    if (poly.length >= 3) addEnclosed(positionedRef.current.filter((s) => pointInPolygon(s.lat, s.lng, poly)));
    // stay in lasso mode so the dispatcher can draw more; Cancel/Esc exits.
  }, [pxToLatLng, addEnclosed]);

  // Re-sequence ONE route client-side (Min distance / Closest / Farthest / Reverse),
  // writing into routeState exactly like a manual drag so the map + ETAs update live
  // and it carries the "Manual order / straight-line estimate" treatment.
  const onResequence = useCallback((truckId, strategy) => {
    if (!strategy) return;
    const depot = result?.meta?.depot || ROUTING_DEPOT;
    const engineRoute = (result?.routes || []).find((r) => r.truckId === truckId);
    setRouteState((prev) => {
      // Seed from routeState if present, else from the freshly-built engine route —
      // so the dropdown reorders a route even before any manual edit (don't no-op).
      const curOrder = (prev && prev[truckId]) ? prev[truckId].order
        : (engineRoute ? engineRoute.orderedStopIds.map(String) : null);
      if (!curOrder) return prev;
      const stops = curOrder.map((id) => { const s = stopById.get(String(id)); return s ? { id: String(id), lat: s.lat, lng: s.lng } : null; }).filter(Boolean);
      if (stops.length < 2) return prev;
      const newOrder = resequence(stops, depot, strategy).map((s) => s.id);
      const resolved = new Set(newOrder);
      const tail = curOrder.map(String).filter((id) => !resolved.has(id)); // keep any unresolvable ids (no silent drops)
      return { ...(prev || {}), [truckId]: { order: [...newOrder, ...tail], reordered: true } };
    });
    setLastAction(`Re-sequenced ${truckId} · ${({ min: 'Min distance', closest: 'Closest first', farthest: 'Farthest first', reverse: 'Reverse' })[strategy] || strategy}`);
  }, [stopById, result]);

  // Esc cancels any armed selection mode.
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e) => { if (e.key === 'Escape') cancelMode(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectMode, cancelMode]);

  // Auto-surface the Result in the desktop right rail when a build completes
  // (Stops stays one click away).
  useEffect(() => { if (job?.status === 'done') setDesktopRail('result'); }, [job?.status]);

  // (Re)init the map into the CURRENT container. Re-runs when the viewport crosses
  // the mobile/desktop breakpoint (the map div is then a different DOM node), so
  // the markers + click listener rebind to the live map via the mapReady signal.
  useEffect(() => {
    if (!google || !mapDiv.current) return;
    // Any in-flight draw belongs to the old map node; reset it on re-init.
    clearTemp();
    boxCornersRef.current = []; lassoVtxRef.current = [];
    selectModeRef.current = null; setSelectMode(null); setBoxStep(0); setLassoCount(0);
    mapRef.current = new google.maps.Map(mapDiv.current, {
      center: ROUTING_DEPOT, zoom: 9, mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
      gestureHandling: 'greedy', // one-finger pan/zoom on touch (no two-finger requirement)
    });
    // Single click listener drives Box/Lasso. Empty-map taps place points; the
    // latest handler is read via a ref so the listener is bound only once per map.
    mapRef.current.addListener('click', (e) => { if (e.latLng) handleSelectPointRef.current(e.latLng); });
    // Invisible overlay → exact container-pixel ↔ LatLng projection for drag-box.
    const ov = new google.maps.OverlayView();
    ov.onAdd = ov.draw = ov.onRemove = () => {};
    ov.setMap(mapRef.current);
    overlayRef.current = ov;
    setMapReady((n) => n + 1);
  }, [google, isMobile]); // eslint-disable-line

  // Render stop markers — gray unselected, blue selected, route-colored + NUMBERED
  // (sequence 1..N matching the panel) once a result exists. Click toggles
  // selection; hover drives the map<->list linkage. Numbers/colors track routeInfo
  // so a manual reorder updates the labels live.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    markersRef.current.forEach((m) => m.setMap(null));
    const byId = new Map();
    markersRef.current = vPositioned.map((s) => {
      const id = String(s.stopNbr);
      const sel = !viewing && selectedIds.has(id);
      const ri = routeInfo.get(id);              // { color, seq } when on a route
      const routed = ri?.color;
      const numbered = !!ri;
      // Restricted = equipment restriction or oversize → keep the visual signal as a
      // red ring on the green routed marker.
      const restricted = numbered && (getRestrictionBadgeKeys(notes.get(s.matchKey) || null).length > 0 || stopLooksOversize(s));
      const hovered = hoverIdRef.current === id;
      const baseIcon = makeMarkerIcon(sel, routed, numbered, restricted);
      const baseZ = sel || routed ? 30 : 10;
      const marker = new google.maps.Marker({
        position: { lat: s.lat, lng: s.lng },
        title: s.businessName || s.stopNbr,
        icon: hovered ? emphIcon(baseIcon) : baseIcon,
        label: numbered ? { text: String(ri.seq), color: '#fff', fontSize: '11px', fontWeight: '700' } : undefined,
        zIndex: hovered ? 50 : baseZ,
      });
      marker.addListener('click', () => {
        if (viewing) return;                     // saved load is read-only
        if (selectModeRef.current) handleSelectPointRef.current(marker.getPosition());
        else toggleStop(s.stopNbr);
      });
      marker.addListener('mouseover', () => setHoverId(id));
      marker.addListener('mouseout', () => setHoverId((h) => (h === id ? null : h)));
      marker.setMap(mapRef.current);
      byId.set(id, { marker, baseIcon, baseZ });
      return marker;
    });
    markerByIdRef.current = byId;
    lastEmphRef.current = hoverIdRef.current; // markers were built already-emphasized
  }, [google, vPositioned, viewing, selectedIds, routeInfo, notes, toggleStop, mapReady, makeMarkerIcon, emphIcon]);

  // Hover emphasis — touch only the two affected markers, not all of them. Keeps
  // the sequence label intact (only the icon scale/ring change).
  useEffect(() => {
    const byId = markerByIdRef.current;
    const setEmph = (id, on) => {
      const e = byId.get(id); if (!e) return;
      e.marker.setIcon(on ? emphIcon(e.baseIcon) : e.baseIcon);
      e.marker.setZIndex(on ? 50 : e.baseZ);
    };
    if (lastEmphRef.current && lastEmphRef.current !== hoverId) setEmph(lastEmphRef.current, false);
    if (hoverId) setEmph(hoverId, true);
    lastEmphRef.current = hoverId;
  }, [hoverId, emphIcon]);

  // Route polylines (one per truck, depot-anchored). Drawn in the CURRENT order
  // (routesView), so a manual reorder redraws the path live.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    polylinesRef.current.forEach((p) => p.setMap(null));
    polylinesRef.current = [];
    if (!routesView.length) return;
    routesView.forEach((rv) => {
      const path = [{ lat: ROUTING_DEPOT.lat, lng: ROUTING_DEPOT.lng }];
      for (const id of rv.order) { const s = vStopById.get(String(id)); if (s && s.lat != null && s.lng != null) path.push({ lat: s.lat, lng: s.lng }); }
      const pl = new google.maps.Polyline({ path, strokeColor: rv.color, strokeWeight: 3, strokeOpacity: 0.85, zIndex: 5 });
      pl.setMap(mapRef.current);
      polylinesRef.current.push(pl);
    });
  }, [google, routesView, vStopById, mapReady]);

  const selectedTrucks = useMemo(() => profiles.filter((p) => selectedTruckIds.has(p.id)), [profiles, selectedTruckIds]);
  const canBuild = selectedIds.size >= 1 && selectedTrucks.length >= 1 && selectedIds.size <= ROUTING_MAX_SELECTION && !building;
  const wouldBeElements = (selectedIds.size + 1) ** 2;
  const wouldBeCost = Math.round((wouldBeElements / 1000) * BASIC_RATE_PER_1K_USD * 100) / 100;

  const runBuild = useCallback(async () => {
    if (!db) { setJob({ status: 'error', error: 'Firestore not configured' }); return; }
    setBuilding(true); setJob({ status: 'queued' }); setSaveState(null);
    const jobId = `job_${(crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))}`;
    const request = {
      tenant: 'davis', date: selectedDate,
      selectedStopIds: [...selectedIds],
      truckProfileIds: selectedTrucks.map((t) => t.id),
      truckSnapshots: selectedTrucks,
      intent: intent.trim(), strategy,
      matrixMode: useGoogle ? 'google' : 'haversine',
    };
    setLastRequest(request);
    try {
      await setDoc(doc(db, 'routing_jobs', jobId), { id: jobId, status: 'queued', created_at: serverTimestamp(), created_by: 'dispatcher', app_version: APP_VERSION, request });
      // Fire the background build; it returns 202 and we watch the doc.
      fetch('/.netlify/functions/routing-build-background', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) }).catch(() => {});
      const unsub = onSnapshot(doc(db, 'routing_jobs', jobId), (snap) => {
        const d = snap.data();
        if (!d) return;
        setJob(d);
        if (d.status === 'done' || d.status === 'error') { setBuilding(false); unsub(); }
      }, (e) => { setJob({ status: 'error', error: e.message }); setBuilding(false); });
    } catch (e) {
      setJob({ status: 'error', error: e.message }); setBuilding(false);
    }
  }, [selectedDate, selectedIds, selectedTrucks, intent, strategy, useGoogle]);

  // Save panel — a name (prefilled with a sensible auto-name per build) + optional
  // free-text initials. No native prompt(); no auth.
  const [saveName, setSaveName] = useState('');
  const [savedBy, setSavedBy] = useState('');
  useEffect(() => { if (result) setSaveName(buildLoadAutoName(editedResultForSave || result, Date.now())); }, [result]); // eslint-disable-line

  const savePlan = useCallback(async () => {
    if (!db || !result) return;
    setSaveState('saving');
    const id = `routeset_${(crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))}`;
    const plan = editedResultForSave || result;
    const name = (saveName && saveName.trim()) || buildLoadAutoName(plan, Date.now());
    // Self-contained stop snapshot (name + coords + counts) so the load renders on
    // the map on any day, independent of today's live cache.
    const stops_snapshot = {};
    const ids = new Set();
    for (const r of plan.routes || []) for (const sid of r.orderedStopIds || []) ids.add(String(sid));
    for (const u of plan.unassigned || []) ids.add(String(u.stopId));
    for (const sid of ids) {
      const s = stopById.get(sid);
      if (s) stops_snapshot[sid] = { name: s.businessName || sid, lat: s.lat ?? null, lng: s.lng ?? null, pallets: Number(s.pallets) || 0, cartons: Number(s.cartons) || 0, weight: Number(s.weight) || 0 };
    }
    try {
      await setDoc(doc(db, 'routing_routes', id), {
        id, name, status: 'saved', dispatched: false,
        created_at: serverTimestamp(), updated_at: serverTimestamp(),
        created_by: 'dispatcher', saved_by: (savedBy && savedBy.trim()) || null,
        app_version: APP_VERSION, request: lastRequest, result: plan,
        manual_reorder: !!(editedResultForSave && editedResultForSave.manualReorder),
        stops_snapshot,
      });
      // Verify by readback (convention: never trust the write alone).
      const back = await getDoc(doc(db, 'routing_routes', id));
      if (!back.exists() || back.data().name !== name) throw new Error('save not confirmed by readback');
      setSaveState('saved');
    } catch (e) { setSaveState(e.message || 'save failed'); }
  }, [result, lastRequest, editedResultForSave, saveName, savedBy, stopById]);

  // Manage a saved load (rename / dispatched / delete) — every write verified by
  // readback; the live onSnapshot reflects the change everywhere.
  const renameLoad = useCallback(async (id, name) => {
    setManageError(null);
    if (!db || !name || !name.trim()) return;
    try {
      await updateDoc(doc(db, 'routing_routes', id), { name: name.trim(), updated_at: serverTimestamp() });
      const back = await getDoc(doc(db, 'routing_routes', id));
      if (!back.exists() || back.data().name !== name.trim()) throw new Error('rename not confirmed');
    } catch (e) { setManageError(e.message || 'rename failed'); }
  }, []);
  const toggleDispatched = useCallback(async (id, next) => {
    setManageError(null);
    if (!db) return;
    try {
      await updateDoc(doc(db, 'routing_routes', id), { dispatched: !!next, status: next ? 'dispatched' : 'saved', updated_at: serverTimestamp() });
      const back = await getDoc(doc(db, 'routing_routes', id));
      if (!back.exists() || back.data().dispatched !== !!next) throw new Error('dispatch toggle not confirmed');
    } catch (e) { setManageError(e.message || 'update failed'); }
  }, []);
  const deleteLoad = useCallback(async (id) => {
    setManageError(null);
    if (!db) return;
    try {
      await deleteDoc(doc(db, 'routing_routes', id));
      const back = await getDoc(doc(db, 'routing_routes', id));
      if (back.exists()) throw new Error('delete not confirmed');
      setViewedLoad((v) => (v && v.id === id ? null : v));
    } catch (e) { setManageError(e.message || 'delete failed'); }
  }, []);

  // Keep the viewed load live: track edits from any device, close if deleted.
  // Only swap when the doc actually changed (updated_at) so unrelated snapshot
  // churn doesn't re-render the whole view.
  useEffect(() => {
    if (!viewedLoad) return;
    const fresh = loads.find((l) => l.id === viewedLoad.id);
    if (!fresh) { setViewedLoad(null); return; }
    if (tsToMillis(fresh.updated_at) !== tsToMillis(viewedLoad.updated_at)) setViewedLoad(fresh);
  }, [loads]); // eslint-disable-line

  // Frame the map to a saved load's stops when it's opened (not on every refresh).
  useEffect(() => {
    if (!google || !mapRef.current || !viewing) return;
    const pts = vPositioned.filter((s) => s.lat != null && s.lng != null);
    if (!pts.length) return;
    const b = new google.maps.LatLngBounds();
    pts.forEach((s) => b.extend({ lat: s.lat, lng: s.lng }));
    b.extend(ROUTING_DEPOT);
    mapRef.current.fitBounds(b, 60);
  }, [viewing, viewedLoad?.id, mapReady, google]); // eslint-disable-line

  // Stops kept on a route but outside their appointment window (advisory flag from
  // the engine result). Used to flag rows + the detail popup.
  const windowViolatedSet = useMemo(() => {
    const s = new Set();
    for (const r of (baseResult?.routes || [])) for (const id of (r.windowViolatedIds || [])) s.add(String(id));
    return s;
  }, [baseResult]);

  const meta = baseResult?.meta || {};
  const usedGoogle = meta.matrixSource === 'google';

  // Responsive: desktop = three side rails; mobile = full map + a collapsible
  // bottom sheet that toggles between the Setup controls and the Result.
  const [mobilePanel, setMobilePanel] = useState('setup');
  const [sheetOpen, setSheetOpen] = useState(true);
  useEffect(() => { if (job?.status === 'done') { setMobilePanel('result'); setSheetOpen(true); } }, [job?.status]);

  // Discard the BUILT plan (output), keeping the selection + trucks (inputs) so the
  // dispatcher can adjust and rebuild without re-selecting. Purely local — no
  // Firestore write, saved Loads untouched. `planEdited` (a manual reorder or P3
  // re-sequence) gates a one-tap confirm so hand-tuning isn't lost by accident.
  const planEdited = !!(routeState && Object.values(routeState).some((s) => s.reordered));
  const discardPlan = useCallback(() => {
    setJob(null); setRouteState(null); setSaveState(null); setBuilding(false); setLastRequest(null);
    setLastAction('Discarded plan — selection kept');
    setMobilePanel('setup');
  }, []);

  const controlsContent = (
    <>
      <div className="flex items-center justify-between">
        <div className="font-bold text-slate-800">Routing <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">beta</span></div>
        <DatePicker selectedDate={selectedDate} onChange={setSelectedDate} onToday={() => setSelectedDate(todayInET())} compact />
      </div>
      <div className="text-[11px] text-slate-500">{loading ? 'Loading stops…' : `${positioned.length} stops on ${formatDateLong(selectedDate)}`}{stopsError ? ` · ${stopsError}` : ''}</div>

      {/* Selection tools — all touch-native (no drag-to-draw). */}
      <div className="border rounded p-2 space-y-2">
        <div className="font-semibold text-slate-700">1 · Select stops</div>
        {selectMode ? (
          <div className="rounded border border-amber-300 bg-amber-50 p-2 text-[12px] space-y-2">
            {selectMode === 'box' ? (
              isMobile
                ? <div>📦 <b>Tap two corners</b> on the map to box a group ({boxStep === 0 ? '1 of 2' : '2 of 2'}).</div>
                : <div>📦 <b>Drag a box</b> around the stops on the map. Esc or Cancel to stop.</div>
            ) : (
              isMobile
                ? <div>⬠ <b>Tap points</b> around the stops, then <b>Done</b> ({lassoCount} {lassoCount === 1 ? 'point' : 'points'}; need ≥3).</div>
                : <div>⬠ <b>Hold and draw</b> a shape around the stops (release to select). Esc or Cancel to stop.</div>
            )}
            <div className="flex gap-1">
              {selectMode === 'lasso' && isMobile && (
                <button onClick={finishLasso} disabled={lassoCount < 3} className="flex-1 px-2 py-2 text-xs rounded text-white font-semibold disabled:opacity-40" style={{ background: BRAND }}>Done</button>
              )}
              <button onClick={cancelMode} className="flex-1 px-2 py-2 text-xs rounded border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100">Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <button onClick={addInView} className="w-full px-2 py-2 text-xs rounded border-2 font-semibold hover:bg-blue-50 active:bg-blue-100" style={{ borderColor: BRAND, color: BRAND }}>＋ Add stops in view</button>
            <div className="flex gap-1">
              <button onClick={() => beginMode('box')} className="flex-1 px-2 py-2 text-xs rounded border border-slate-300 hover:bg-slate-50 active:bg-slate-100">▱ Box</button>
              <button onClick={() => beginMode('lasso')} className="flex-1 px-2 py-2 text-xs rounded border border-slate-300 hover:bg-slate-50 active:bg-slate-100">⬠ Lasso</button>
              <button onClick={clearSelection} className="flex-1 px-2 py-2 text-xs rounded border border-slate-300 hover:bg-slate-50 active:bg-slate-100">Clear</button>
            </div>
            <div className="text-[11px] text-slate-600">{isMobile ? 'Tap' : 'Click'} a stop to toggle it. Or pan/zoom, then <b>Add stops in view</b>, <b>Box</b> ({isMobile ? 'tap two corners' : 'drag'}), or <b>Lasso</b> ({isMobile ? 'tap points' : 'hold & draw'}).</div>
          </>
        )}
        {lastAction && <div className="text-[11px] text-slate-500">{lastAction}</div>}
        <div className="bg-slate-50 rounded p-2 text-[12px] space-y-0.5">
          <div className="flex justify-between"><span>Selected</span><b>{tally.count}</b></div>
          <div className="flex justify-between"><span>Skids</span><b>{tally.skids}</b></div>
          <div className="flex justify-between"><span>Loose pieces</span><b>{tally.pieces}</b></div>
          <div className="flex justify-between"><span>Weight</span><b>{tally.weight.toLocaleString()} lb</b></div>
          {tally.summary.length > 0 && (
            <div className="text-[11px] text-amber-700 pt-1">⚠ {tally.summary.join(' · ')}</div>
          )}
          {tally.count > ROUTING_MAX_SELECTION && <div className="text-[11px] text-red-600 pt-1">Over {ROUTING_MAX_SELECTION}-stop limit — narrow the selection (matrix cost is quadratic).</div>}
        </div>

        {/* On mobile the selected-stops list lives here in the Setup sheet (the #41
            pattern). On desktop it is the right rail's Stops tab instead. */}
        {isMobile && <RoutingSelectedList selectedStops={selectedStops} notes={notes} onRemove={removeStop} open={listOpen} setOpen={setListOpen} onOpenStop={openStop} />}
      </div>

      {/* Trucks */}
      <div className="border rounded p-2 space-y-2">
        <div className="font-semibold text-slate-700">2 · Trucks <span className="text-[11px] text-slate-400">({selectedTrucks.length} in play)</span></div>
        {profiles.map((p) => (
          <div key={p.id} className="border rounded p-1.5">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={selectedTruckIds.has(p.id)} onChange={() => setSelectedTruckIds((prev) => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })} />
              <span className="font-medium">{p.label}</span>
            </label>
            <div className="grid grid-cols-3 gap-1 mt-1 text-[10px] text-slate-500">
              <label className="flex flex-col">Skids
                <input type="number" defaultValue={p.maxSkids} onBlur={(e) => saveProfile({ ...p, maxSkids: Number(e.target.value) })} className="border rounded px-1 py-0.5 text-slate-800" />
              </label>
              <label className="flex flex-col">Weight
                <input type="number" defaultValue={p.maxWeightLbs} onBlur={(e) => saveProfile({ ...p, maxWeightLbs: Number(e.target.value) })} className="border rounded px-1 py-0.5 text-slate-800" />
              </label>
              <label className="flex flex-col">Deck in
                <input type="number" defaultValue={p.deckLengthIn} onBlur={(e) => saveProfile({ ...p, deckLengthIn: Number(e.target.value) })} className="border rounded px-1 py-0.5 text-slate-800" />
              </label>
            </div>
            <label className="flex items-center gap-1 text-[11px] mt-1">
              <input type="checkbox" defaultChecked={!!p.capabilities?.liftgate} onChange={(e) => saveProfile({ ...p, capabilities: { ...p.capabilities, liftgate: e.target.checked } })} /> liftgate
            </label>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="border rounded p-2 space-y-2">
        <div className="font-semibold text-slate-700">3 · Plan</div>
        <textarea value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Optional: tell the engine what you want (e.g. 'tight appointments first, keep the trailer off downtown')" rows={2} className="w-full border rounded p-1.5 text-[12px]" />
        <label className="flex items-center justify-between text-[12px]">Strategy
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="border rounded px-1 py-1">
            {ROUTING_STRATEGIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className={`flex items-start gap-2 text-[12px] rounded p-1.5 ${useGoogle ? 'bg-amber-50 border border-amber-300' : 'bg-slate-50'}`}>
          <input type="checkbox" checked={useGoogle} onChange={(e) => setUseGoogle(e.target.checked)} className="mt-0.5" />
          <span>Use live Google drive-times <b>(costs money)</b><br /><span className="text-[11px] text-slate-500">Default is a free straight-line estimate. {selectedIds.size > 0 && <>This build ≈ {wouldBeElements} elements ≈ <b>${wouldBeCost.toFixed(2)}</b>.</>}</span></span>
        </label>
        <button onClick={runBuild} disabled={!canBuild} className="w-full py-2 rounded text-white font-semibold disabled:opacity-40" style={{ background: BRAND }}>
          {building ? 'Building…' : useGoogle ? 'Build with Google drive-times' : 'Build (free estimate)'}
        </button>
        {!canBuild && !building && <div className="text-[11px] text-slate-400">Select ≥1 stop and ≥1 truck to build.</div>}
      </div>
    </>
  );

  const resultContent = (
    <RoutingResultPanel job={job} result={baseResult} meta={meta} usedGoogle={usedGoogle} stopById={vStopById}
      onSave={savePlan} saveState={saveState} saveName={saveName} setSaveName={setSaveName} savedBy={savedBy} setSavedBy={setSavedBy}
      onDiscard={discardPlan} planEdited={planEdited}
      routesView={routesView} onReorder={reorderStop} onMove={moveStop} onResequence={onResequence} readOnly={viewing}
      hoverId={hoverId} setHoverId={setHoverId} onOpenStop={openStop}
      savedLoad={viewedLoad} onCloseLoad={() => setViewedLoad(null)}
      onRename={renameLoad} onToggleDispatch={toggleDispatched} onDelete={deleteLoad} manageError={manageError} />
  );

  const loadsContent = (
    <RoutingLoadsPanel loads={loads} loading={loadsLoading} error={loadsError}
      viewedId={viewedLoad?.id || null}
      onOpen={(l) => { setViewedLoad(l); setMobilePanel('result'); setSheetOpen(true); }}
      onRename={renameLoad} onToggleDispatch={toggleDispatched} onDelete={deleteLoad} manageError={manageError} />
  );

  // ── Mobile: map + collapsible bottom sheet (Setup / Result) ──
  if (isMobile) {
    const tabCls = (on) => `flex-1 py-1.5 text-xs font-semibold rounded ${on ? 'text-white' : 'text-slate-600 bg-slate-100'}`;
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 relative min-w-0">
          <div ref={mapDiv} className="absolute inset-0" />
          <RoutingBuildBadge onClick={() => setVersionLogOpen(true)} />
          {mapsError && <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-red-50 border border-red-300 text-red-700 text-[11px] rounded px-2 py-1">{mapsError}</div>}
          {viewing
            ? <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 bg-indigo-600 text-white text-[11px] rounded shadow px-3 py-1.5 flex items-center gap-2 max-w-[92%]"><span className="truncate">👁 {viewedLoad?.name || viewedLoad?.id}</span><button onClick={() => setViewedLoad(null)} className="underline shrink-0">Back</button></div>
            : <div className="absolute top-2 left-2 bg-white/95 border border-slate-200 rounded shadow px-2 py-1 text-[11px]">{tally.count} selected · {tally.skids} skids · {tally.pieces} pcs</div>}
        </div>
        <div className="border-t bg-white flex flex-col shrink-0" style={{ height: sheetOpen ? '50vh' : 'auto' }}>
          <div className="flex items-center gap-2 px-2 py-1.5 border-b">
            <button onClick={() => setSheetOpen((o) => !o)} className="text-xs px-2 py-1 rounded border border-slate-300" aria-label={sheetOpen ? 'Collapse' : 'Expand'}>{sheetOpen ? '▾' : '▴'}</button>
            <div className="flex-1 flex gap-1">
              <button onClick={() => { setMobilePanel('setup'); setSheetOpen(true); }} className={tabCls(mobilePanel === 'setup')} style={mobilePanel === 'setup' ? { background: BRAND } : {}}>Setup{tally.count ? ` (${tally.count})` : ''}</button>
              <button onClick={() => { setMobilePanel('loads'); setSheetOpen(true); }} className={tabCls(mobilePanel === 'loads')} style={mobilePanel === 'loads' ? { background: BRAND } : {}}>Loads{loads.length ? ` (${loads.length})` : ''}</button>
              <button onClick={() => { setMobilePanel('result'); setSheetOpen(true); }} className={tabCls(mobilePanel === 'result')} style={mobilePanel === 'result' ? { background: BRAND } : {}}>Result{baseResult ? ` (${baseResult.routes.length})` : job?.status === 'running' || job?.status === 'queued' ? ' …' : ''}</button>
            </div>
          </div>
          {sheetOpen && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3 text-sm" style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}>
              {mobilePanel === 'setup' ? controlsContent : mobilePanel === 'loads' ? loadsContent : resultContent}
            </div>
          )}
        </div>
        {detailModalStop && <RoutingStopModal stop={detailModalStop} notes={notes} windowViolatedSet={windowViolatedSet} onClose={() => setDetailModalStop(null)} />}
        {versionLogOpen && <VersionLogModal onClose={() => setVersionLogOpen(false)} />}
      </div>
    );
  }

  // ── Desktop: the dispatch console — Setup (left) · large map (center) ·
  //    Stops/Result (right). ──
  const railTab = (id, label) => (
    <button
      onClick={() => setDesktopRail(id)}
      className={`flex-1 py-2 text-[13px] font-semibold border-b-2 ${desktopRail === id ? 'text-slate-900' : 'text-slate-500 border-transparent hover:text-slate-700'}`}
      style={desktopRail === id ? { borderColor: BRAND, color: BRAND } : {}}
    >{label}</button>
  );
  return (
    <div className="flex-1 flex min-h-0">
      {/* Left: Setup stack */}
      <div className="w-[340px] shrink-0 border-r bg-white overflow-y-auto p-3 space-y-3 text-sm">
        {controlsContent}
      </div>

      {/* Center: the map canvas */}
      <div className="flex-1 relative min-w-0">
        <div ref={mapDiv} className="absolute inset-0" />
        <RoutingBuildBadge onClick={() => setVersionLogOpen(true)} />
        {mapsError && <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-red-50 border border-red-300 text-red-700 text-[11px] rounded px-2 py-1">{mapsError}</div>}
        {viewing && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 bg-indigo-600 text-white text-[12px] rounded shadow px-3 py-1.5 flex items-center gap-3 max-w-[80%]">
            <span className="truncate">👁 Viewing saved load: <b>{viewedLoad?.name || viewedLoad?.id}</b></span>
            <button onClick={() => setViewedLoad(null)} className="underline shrink-0 font-semibold">Back to build</button>
          </div>
        )}
        {/* Drag-box capture overlay — active only while Box mode is armed on desktop. */}
        {selectMode === 'box' && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair"
            onMouseDown={onBoxDown} onMouseMove={onBoxMove} onMouseUp={onBoxUp} onMouseLeave={onBoxUp}
          >
            <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-slate-900/85 text-white text-[11px] rounded px-2 py-1 pointer-events-none">Drag a box around the stops · Esc to cancel</div>
            {dragRect && (
              <div className="absolute border-2 bg-blue-400/10 pointer-events-none" style={{
                borderColor: BRAND,
                left: Math.min(dragRect.x0, dragRect.x1), top: Math.min(dragRect.y0, dragRect.y1),
                width: Math.abs(dragRect.x1 - dragRect.x0), height: Math.abs(dragRect.y1 - dragRect.y0),
              }} />
            )}
          </div>
        )}
        {/* Freehand drag-lasso capture overlay — desktop, while Lasso mode is armed.
            Pointer-captured so the map can't pan; an SVG path previews the shape. */}
        {selectMode === 'lasso' && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair"
            onMouseDown={onLassoDown} onMouseMove={onLassoMove} onMouseUp={onLassoUp} onMouseLeave={onLassoUp}
          >
            <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-slate-900/85 text-white text-[11px] rounded px-2 py-1 pointer-events-none">Hold and draw a shape around the stops · Esc to cancel</div>
            {lassoPath.length > 1 && (
              <svg className="absolute inset-0 w-full h-full pointer-events-none">
                <polyline points={lassoPath.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(30,91,146,0.10)" stroke={BRAND} strokeWidth="2" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        )}
      </div>

      {/* Right: Stops | Result */}
      <div className="w-[380px] shrink-0 border-l bg-white flex flex-col min-h-0">
        <div className="flex border-b shrink-0">
          {railTab('stops', `Stops${tally.count ? ` (${tally.count})` : ''}`)}
          {railTab('loads', `Loads${loads.length ? ` (${loads.length})` : ''}`)}
          {railTab('result', `Result${baseResult ? ` (${baseResult.routes.length})` : (job?.status === 'running' || job?.status === 'queued') ? ' …' : ''}`)}
        </div>
        {desktopRail === 'stops' ? (
          <RoutingStopsPanel selectedStops={selectedStops} notes={notes} onRemove={removeStop} hoverId={hoverId} setHoverId={setHoverId} onOpenStop={openStop} />
        ) : desktopRail === 'loads' ? (
          <RoutingLoadsPanel loads={loads} loading={loadsLoading} error={loadsError}
            viewedId={viewedLoad?.id || null}
            onOpen={(l) => { setViewedLoad(l); setDesktopRail('result'); }}
            onRename={renameLoad} onToggleDispatch={toggleDispatched} onDelete={deleteLoad} manageError={manageError} />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-sm">{resultContent}</div>
        )}
      </div>
      {detailModalStop && <RoutingStopModal stop={detailModalStop} notes={notes} windowViolatedSet={windowViolatedSet} onClose={() => setDetailModalStop(null)} />}
        {versionLogOpen && <VersionLogModal onClose={() => setVersionLogOpen(false)} />}
    </div>
  );
}

function RoutingResultPanel({ job, result, meta, usedGoogle, stopById, onSave, saveState, saveName, setSaveName, savedBy, setSavedBy, onDiscard, planEdited, routesView, onReorder, onMove, onResequence, readOnly, hoverId, setHoverId, onOpenStop, savedLoad, onCloseLoad, onRename, onToggleDispatch, onDelete, manageError }) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [riskOpen, setRiskOpen] = useState(false); // risk flags are a collapsed disclosure; never auto-expand
  useEffect(() => { setConfirmDiscard(false); setRiskOpen(false); }, [job, savedLoad]);
  // Live-build status gates only apply when NOT viewing a saved load.
  if (!savedLoad) {
    if (!job) return <div className="text-[12px] text-slate-400">Build a plan to see routes, ETAs, load, spill, and cost here.</div>;
    if (job.status === 'queued' || job.status === 'running') return <div className="text-[12px] text-slate-600">⏳ Building plan… ({job.stage || job.status})</div>;
    if (job.status === 'error') return <div className="text-[12px] text-red-600">Build failed: {job.error || 'unknown error'}</div>;
    if (!result) return <div className="text-[12px] text-slate-400">No result.</div>;
  }
  if (!result || !Array.isArray(result.routes)) {
    return (
      <div className="space-y-3">
        {savedLoad && <SavedLoadManageBar load={savedLoad} onClose={onCloseLoad} onRename={onRename} onToggleDispatch={onToggleDispatch} onDelete={onDelete} manageError={manageError} />}
        <div className="text-[12px] text-slate-400">This load has no routes to show.</div>
      </div>
    );
  }

  const cost = meta.estimatedCostUsd || 0;
  const ai = result.aiAssist || {};
  return (
    <div className="space-y-3">
      {savedLoad ? (
        <SavedLoadManageBar load={savedLoad} onClose={onCloseLoad} onRename={onRename} onToggleDispatch={onToggleDispatch} onDelete={onDelete} manageError={manageError} />
      ) : (
        <div className="rounded border border-slate-300 bg-slate-50 p-2 text-[11px] text-slate-600">
          This is a <b>plan saved in our system only</b>. It has <b>NOT</b> been sent to NuVizz or dispatched to any driver.
        </div>
      )}

      {/* Cost / quality readout */}
      <div className={`rounded border p-2 text-[12px] ${usedGoogle ? 'border-amber-300 bg-amber-50' : 'border-green-300 bg-green-50'}`}>
        <div className="font-semibold">{usedGoogle ? 'Google live drive-times' : 'Free estimate (straight-line)'}</div>
        <div className="flex justify-between"><span>Matrix elements</span><b>{meta.googleElementCount ?? '—'}</b></div>
        <div className="flex justify-between"><span>Estimated cost</span><b>${Number(cost).toFixed(2)}</b></div>
        <div className="flex justify-between"><span>AI assist</span><b>{result.aiConfigured ? `${[ai.intent && 'intent', ai.explain && 'rationale', ai.geometry && 'geometry'].filter(Boolean).join(', ') || 'available, not needed'}` : 'off'}</b></div>
      </div>

      {!readOnly && <div className="text-[11px] text-slate-500">Drag a stop (or use ▲▼) to reorder a route. The map and ETAs update live.</div>}

      {/* Rationale + risk */}
      {result.rationale && <div className="text-[12px] text-slate-700"><b>Rationale.</b> {result.rationale}</div>}
      {Array.isArray(result.riskFlags) && result.riskFlags.length > 0 && (
        <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded">
          <button onClick={() => setRiskOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 px-2 py-1.5 font-semibold text-left" aria-expanded={riskOpen}>
            <span>⚠ {result.riskFlags.length} risk flag{result.riskFlags.length === 1 ? '' : 's'}</span>
            {riskOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {riskOpen && <ul className="list-disc ml-5 pr-2 pb-2 space-y-0.5">{result.riskFlags.map((f, i) => <li key={i}>{f}</li>)}</ul>}
        </div>
      )}

      {/* Routes (numbered; reorderable unless viewing a saved load) */}
      {(routesView || []).map((rv) => (
        <RoutingRouteCard key={rv.truckId} rv={rv} stopById={stopById} usedGoogle={usedGoogle} readOnly={readOnly}
          onReorder={onReorder} onMove={onMove} onResequence={onResequence} hoverId={hoverId} setHoverId={setHoverId} onOpenStop={onOpenStop} />
      ))}

      {/* Spill */}
      {result.unassigned && result.unassigned.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-[12px]">
          <div className="font-semibold text-red-700 mb-1">Could not place ({result.unassigned.length})</div>
          {result.unassigned.map((u) => {
            const s = stopById.get(String(u.stopId));
            return (
              <div key={u.stopId} className="mb-1">
                <div className="flex items-center gap-1.5"><b>{s?.businessName || u.stopId}</b>{s && <ProLink stop={s} onOpen={onOpenStop} className="text-[11px]" />}</div>
                <div className="text-[11px] text-red-600">{u.reasons.join('; ')}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Save panel (live build only) */}
      {!savedLoad && (
        <div className="border-t pt-2 space-y-1.5">
          <label className="block text-[11px] font-semibold text-slate-600">Save as
            <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Load name" className="mt-0.5 w-full border rounded px-2 py-1 text-[12px] font-normal text-slate-800" />
          </label>
          <input value={savedBy} onChange={(e) => setSavedBy(e.target.value)} placeholder="Saved by (initials, optional)" className="w-full border rounded px-2 py-1 text-[12px] text-slate-800" />
          <div className="flex gap-2">
            <button onClick={onSave} disabled={saveState === 'saving'} className="flex-1 py-2 rounded text-white font-semibold disabled:opacity-40" style={{ background: BRAND }}>
              {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved — shared' : 'Save load'}
            </button>
            {onDiscard && (
              confirmDiscard ? (
                <button onClick={() => { setConfirmDiscard(false); onDiscard(); }} className="shrink-0 px-3 py-2 rounded bg-red-600 text-white text-[12px] font-semibold">Discard hand-tuned plan?</button>
              ) : (
                <button
                  onClick={() => (planEdited ? setConfirmDiscard(true) : onDiscard())}
                  title="Throw away this built plan and start over (keeps your stop + truck selection)"
                  className="shrink-0 px-3 py-2 rounded border border-red-300 text-red-700 text-[12px] font-semibold hover:bg-red-50"
                >Discard plan</button>
              )
            )}
          </div>
          {saveState && saveState !== 'saving' && saveState !== 'saved' && <div className="text-[11px] text-red-600">{saveState}</div>}
          <div className="text-[10px] text-slate-400">Discard clears the routes (keeps your selection); it doesn’t touch any saved load.</div>
        </div>
      )}
    </div>
  );
}

// Saved-load header + manage row: rename (inline, no native prompt), toggle
// Dispatched, Delete (explicit confirm), and "Back to build".
function SavedLoadManageBar({ load, onClose, onRename, onToggleDispatch, onDelete, manageError }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(load?.name || '');
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => { setDraft(load?.name || ''); setEditing(false); setConfirmDel(false); }, [load?.id]);
  const dispatched = !!load?.dispatched;
  const created = formatDateTime(tsToMillis(load?.created_at));
  return (
    <div className="rounded border border-indigo-300 bg-indigo-50 p-2 text-[12px] space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase font-bold tracking-wide text-indigo-700">Viewing saved load</span>
        <button onClick={onClose} className="text-[11px] underline text-indigo-700 font-semibold shrink-0">← Back to build</button>
      </div>
      {editing ? (
        <div className="flex items-center gap-1">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} className="flex-1 border rounded px-2 py-1 text-[12px]" />
          <button onClick={() => { onRename(load.id, draft); setEditing(false); }} className="px-2 py-1 text-[11px] rounded text-white font-semibold" style={{ background: BRAND }}>Save</button>
          <button onClick={() => { setDraft(load.name || ''); setEditing(false); }} className="px-2 py-1 text-[11px] rounded border border-slate-300">Cancel</button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-800 truncate flex-1" title={load?.name}>{load?.name || load?.id}</span>
          <button onClick={() => setEditing(true)} className="text-[11px] underline text-slate-600 shrink-0">Rename</button>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap text-[10px] text-slate-500">
        <span className={`px-1.5 py-0.5 rounded font-bold uppercase ${dispatched ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>{dispatched ? 'Dispatched' : 'Saved'}</span>
        {load?.manual_reorder && <span className="px-1.5 py-0.5 rounded font-bold uppercase bg-amber-100 text-amber-700">Manual order</span>}
        {created && <span>{created}</span>}
        {load?.saved_by && <span>· by {load.saved_by}</span>}
        {load?.app_version && <span>· v{load.app_version}</span>}
      </div>
      <div className="flex items-center gap-1 pt-0.5">
        <button onClick={() => onToggleDispatch(load.id, !dispatched)} className="flex-1 px-2 py-1 text-[11px] rounded border border-slate-300 bg-white hover:bg-slate-50">
          {dispatched ? 'Mark not dispatched' : 'Mark dispatched'}
        </button>
        {confirmDel ? (
          <>
            <button onClick={() => onDelete(load.id)} className="px-2 py-1 text-[11px] rounded bg-red-600 text-white font-semibold">Confirm delete</button>
            <button onClick={() => setConfirmDel(false)} className="px-2 py-1 text-[11px] rounded border border-slate-300">Cancel</button>
          </>
        ) : (
          <button onClick={() => setConfirmDel(true)} className="px-2 py-1 text-[11px] rounded border border-red-300 text-red-700 hover:bg-red-50">Delete</button>
        )}
      </div>
      {manageError && <div className="text-[11px] text-red-600">{manageError}</div>}
    </div>
  );
}

// The live, shared Loads list — fed by useSavedLoads (onSnapshot). Sortable;
// explicit loading / empty / error. Each row opens the load on the map.
function RoutingLoadsPanel({ loads, loading, error, viewedId, onOpen, onRename, onToggleDispatch, onDelete, manageError }) {
  const rows = useMemo(() => (loads || []).map((l) => ({
    id: l.id, doc: l,
    name: l.name || l.id,
    trucks: Array.isArray(l.result?.routes) ? l.result.routes.length : 0,
    stops: Array.isArray(l.result?.routes) ? l.result.routes.reduce((a, r) => a + (r.orderedStopIds?.length || 0), 0) : 0,
    status: l.dispatched ? 'Dispatched' : 'Saved',
    created: tsToMillis(l.created_at) || 0,
  })), [loads]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, 'created', 'desc');

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-2 text-[11px] text-slate-500 border-b shrink-0">Saved loads are <b>shared live</b> — a save on any device shows here within seconds.{manageError && <span className="text-red-600"> · {manageError}</span>}</div>
      {error ? (
        <div className="p-4 text-[12px] text-red-600">Couldn’t load saved loads: {error}</div>
      ) : loading ? (
        <div className="p-4 text-[12px] text-slate-500">Loading saved loads…</div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-[12px] text-slate-400">No saved loads yet. Build a plan and use <b>Save load</b>.</div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="flex items-center gap-3 px-3 py-1 text-[10px] uppercase tracking-wide text-slate-500 border-b bg-slate-50 sticky top-0">
            <button onClick={() => toggle('name')} className="flex-1 text-left inline-flex items-center gap-0.5">Name{sortKey === 'name' ? (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}</button>
            <button onClick={() => toggle('status')} className="inline-flex items-center gap-0.5">Status{sortKey === 'status' ? (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}</button>
            <button onClick={() => toggle('stops')} className="inline-flex items-center gap-0.5">Stops{sortKey === 'stops' ? (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}</button>
            <button onClick={() => toggle('created')} className="inline-flex items-center gap-0.5">Created{sortKey === 'created' ? (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />) : null}</button>
          </div>
          <div className="divide-y">
            {sorted.map((r) => (
              <LoadRow key={r.id} row={r} active={viewedId === r.id} onOpen={onOpen} onRename={onRename} onToggleDispatch={onToggleDispatch} onDelete={onDelete} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LoadRow({ row, active, onOpen, onRename, onToggleDispatch, onDelete }) {
  const l = row.doc;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(l.name || '');
  const [confirmDel, setConfirmDel] = useState(false);
  const created = formatDateTime(row.created);
  return (
    <div className={`px-3 py-2 ${active ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
      {editing ? (
        <div className="flex items-center gap-1 mb-1">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} className="flex-1 border rounded px-2 py-1 text-[12px]" />
          <button onClick={() => { onRename(l.id, draft); setEditing(false); }} className="px-2 py-1 text-[11px] rounded text-white font-semibold" style={{ background: BRAND }}>Save</button>
          <button onClick={() => { setDraft(l.name || ''); setEditing(false); }} className="px-2 py-1 text-[11px] rounded border border-slate-300">Cancel</button>
        </div>
      ) : (
        <button onClick={() => onOpen(l)} className="w-full text-left">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-[12px] truncate flex-1" title={row.name}>{row.name}</span>
            {active && <span className="text-[9px] font-bold text-indigo-700">VIEWING</span>}
          </div>
          <div className="text-[11px] text-slate-500 flex items-center gap-1.5 flex-wrap mt-0.5">
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${l.dispatched ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>{row.status}</span>
            {l.manual_reorder && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-amber-100 text-amber-700">Manual order</span>}
            <span>{row.trucks} truck{row.trucks === 1 ? '' : 's'} · {row.stops} stop{row.stops === 1 ? '' : 's'}</span>
            {created && <span>· {created}</span>}
            {l.saved_by && <span>· {l.saved_by}</span>}
            {l.app_version && <span>· v{l.app_version}</span>}
          </div>
        </button>
      )}
      <div className="flex items-center gap-2 mt-1 text-[11px]">
        <button onClick={() => onOpen(l)} className="underline text-blue-700">Open</button>
        <button onClick={() => setEditing((e) => !e)} className="underline text-slate-600">Rename</button>
        <button onClick={() => onToggleDispatch(l.id, !l.dispatched)} className="underline text-slate-600">{l.dispatched ? 'Un-dispatch' : 'Dispatch'}</button>
        {confirmDel ? (
          <span className="inline-flex items-center gap-1">
            <button onClick={() => onDelete(l.id)} className="underline text-red-700 font-semibold">Confirm</button>
            <button onClick={() => setConfirmDel(false)} className="underline text-slate-500">Cancel</button>
          </span>
        ) : (
          <button onClick={() => setConfirmDel(true)} className="underline text-red-600 ml-auto">Delete</button>
        )}
      </div>
    </div>
  );
}

function fmtRouteDur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// One truck's route — NUMBERED stops in the CURRENT sequence (matching the map
// markers). On a live build: drag-and-drop or ▲▼ to reorder. When viewing a
// saved load (readOnly), the reorder affordances are hidden (view-only this PR).
function RoutingRouteCard({ rv, stopById, usedGoogle, readOnly, onReorder, onMove, onResequence, hoverId, setHoverId, onOpenStop }) {
  const route = rv.route;
  const rows = rv.order.map((id, idx) => {
    const s = stopById.get(String(id));
    return { seq: idx + 1, stopId: String(id), stop: s, customer: s?.businessName || id, eta: rv.etas?.[idx] ?? null,
      skids: Number(s?.pallets) || 0, pieces: Number(s?.cartons) || 0, weight: Number(s?.weight) || 0 };
  });
  const piecesTotal = rows.reduce((a, r) => a + r.pieces, 0);
  const miles = rv.totalDistanceMeters != null ? rv.totalDistanceMeters / 1609.34 : null;
  const lastIdx = rows.length - 1;
  const winViolated = new Set((route?.windowViolatedIds || []).map(String)); // advisory window flags

  const dragFrom = useRef(null);
  const [overIdx, setOverIdx] = useState(null);
  const onDragStart = (i) => (e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* some browsers */ } };
  const onDragOver = (i) => (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overIdx !== i) setOverIdx(i); };
  const onDrop = (i) => (e) => { e.preventDefault(); const from = dragFrom.current; dragFrom.current = null; setOverIdx(null); if (from != null && from !== i) onReorder(rv.truckId, from, i); };
  const onDragEnd = () => { dragFrom.current = null; setOverIdx(null); };

  return (
    <div className="rounded border border-slate-200">
      <div className="px-2 py-1.5 flex items-center gap-2 border-b flex-wrap" style={{ borderLeft: `4px solid ${rv.color}` }}>
        <span className="font-semibold">{route.truckId}</span>
        <span className="text-[11px] text-slate-500">{rows.length} stops · {piecesTotal} loose pc{piecesTotal === 1 ? '' : 's'}{miles != null ? ` · ~${miles.toFixed(1)} mi · ~${fmtRouteDur(rv.totalDurationSec)}` : ''}</span>
        {rv.reordered && <span className="text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Manual order</span>}
        {!readOnly && onResequence && rows.length > 1 && (
          <select
            value=""
            onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) onResequence(rv.truckId, v); }}
            title="Re-sequence this route"
            className="ml-auto text-[11px] border border-slate-300 rounded px-1 py-0.5 bg-white"
          >
            <option value="">Re-sequence…</option>
            <option value="min">Min distance</option>
            <option value="closest">Closest first</option>
            <option value="farthest">Farthest first</option>
            <option value="reverse">Reverse</option>
          </select>
        )}
      </div>
      <div className="p-2 space-y-1.5">
        <CapacityBar label="Skids" used={route.load.skids} cap={route.capacity.skids} unit="" />
        <CapacityBar label="Weight" used={route.load.weightLbs} cap={route.capacity.weightLbs} unit="lb" />
        <CapacityBar label="Deck" used={route.load.linearFeetIn} cap={route.capacity.linearFeetIn} unit="in" />
      </div>
      {rv.reordered && (
        <div className="px-2 pb-1 text-[10px] text-amber-700">
          Sequence edited — drive times are straight-line estimates{usedGoogle ? ' (original Google road times no longer apply to this order)' : ''}.
        </div>
      )}
      <ul className="divide-y">
        {rows.map((row, i) => {
          const hot = hoverId === row.stopId;
          return (
            <li
              key={row.stopId}
              draggable={!readOnly}
              onDragStart={readOnly ? undefined : onDragStart(i)} onDragOver={readOnly ? undefined : onDragOver(i)} onDrop={readOnly ? undefined : onDrop(i)} onDragEnd={readOnly ? undefined : onDragEnd}
              onMouseEnter={() => setHoverId && setHoverId(row.stopId)}
              onMouseLeave={() => setHoverId && setHoverId((h) => (h === row.stopId ? null : h))}
              className={`flex items-center gap-2 px-2 py-1.5 ${overIdx === i ? 'border-t-2 border-t-blue-500' : ''} ${hot ? 'bg-amber-50' : 'hover:bg-slate-50'}`}
            >
              {!readOnly && <span className="cursor-grab text-slate-400 select-none text-sm leading-none" title="Drag to reorder" aria-hidden>⋮⋮</span>}
              <span className="w-5 h-5 shrink-0 rounded-full text-white text-[10px] font-bold flex items-center justify-center" style={{ background: rv.color }}>{row.seq}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate font-medium text-[12px]" title={row.customer}>{row.customer}</span>
                  {row.stop && <span className="shrink-0 text-[10px]"><ProLink stop={row.stop} onOpen={onOpenStop} /></span>}
                </div>
                <div className="text-[10px] text-slate-500">{formatRoutingEta(row.eta)} · {row.skids} sk · {row.pieces} pc · {row.weight.toLocaleString()} lb</div>
                {winViolated.has(row.stopId) && <div className="text-[10px] text-amber-700 font-semibold">⚠ outside appointment window{apptWindowLabel(row.stop) ? ` (${apptWindowLabel(row.stop)})` : ''}</div>}
              </div>
              {!readOnly && (
                <div className="flex flex-col shrink-0">
                  <button onClick={() => onMove(rv.truckId, i, -1)} disabled={i === 0} aria-label={`Move ${row.customer} up`} className="text-slate-500 hover:text-slate-900 disabled:opacity-25 leading-none text-[11px]">▲</button>
                  <button onClick={() => onMove(rv.truckId, i, +1)} disabled={i === lastIdx} aria-label={`Move ${row.customer} down`} className="text-slate-500 hover:text-slate-900 disabled:opacity-25 leading-none text-[11px]">▼</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- shell ----------

function Shell() {
  const [tab, setTab] = useState('map');
  const viewportWidth = useViewportWidth();
  const viewportHeight = useViewportHeight();
  const isMobile = viewportWidth < MOBILE_BREAKPOINT;
  const [chipMenuOpen, setChipMenuOpen] = useState(false);

  // Close chip menu on any tab change or click outside the bar.
  useEffect(() => { setChipMenuOpen(false); }, [tab]);

  const onSelectMenu = (next) => {
    setChipMenuOpen(false);
    setTab(next === 'diagnostics' ? 'diag' : next === 'routing' ? 'routing' : 'map');
  };

  return (
    // h-screen is the SSR/first-paint fallback; once mounted we pin the shell to
    // the live visible viewport height (pixels) so iOS Safari toolbars can't hide
    // the bottom Save bar. Pixel height keeps the map container non-zero.
    <div className="h-screen flex flex-col" style={viewportHeight ? { height: viewportHeight } : undefined}>
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
            {ROUTING_FLAG && <TabBtn label="Routing (beta)" icon={<MapPinned size={14} />} active={tab === 'routing'} onClick={() => setTab('routing')} />}
            <TabBtn label="Diagnostics" icon={<Activity size={14} />} active={tab === 'diag'} onClick={() => setTab('diag')} />
          </nav>
          {/* Right side intentionally empty — no auth in v0.3.0 (matches Glory Bound / MarginIQ). */}
          <div />
        </header>
      )}

      {tab === 'map' ? <MapScreen /> : (tab === 'routing' && ROUTING_FLAG) ? <RoutingScreen /> : <DiagnosticsRoute />}

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
