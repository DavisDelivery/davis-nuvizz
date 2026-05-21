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
  MapPin, RefreshCw, LogOut, X, AlertTriangle, Filter, Truck, Save, Plus, Trash2,
  Activity, ChevronDown, ChevronUp, Eye, EyeOff,
} from 'lucide-react';
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from 'firebase/auth';
import {
  collection, doc, getDoc, onSnapshot, setDoc, serverTimestamp,
} from 'firebase/firestore';

import { auth, db, firebaseConfigured } from './lib/firebase.js';
import { normalizeMatchKey } from './lib/matchKey.js';
import { scanStop } from './lib/signal-scanner.ts';
import { applyScannerResults } from './lib/customer-notes-writer.ts';

// ---------- constants ----------

const APP_VERSION = '0.2.0';
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
      // Attach matchKey + run the M2.1 signal scanner so downstream consumers
      // (auto-writer, marker rendering, sidebar) all see the same per-stop hits.
      const decorated = (data.stops || []).map((s) => ({
        ...s,
        matchKey: normalizeMatchKey(s.businessName || '', s.addr1 || '', s.city || '', s.zip || ''),
        scanResults: scanStop(s),
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

// M2.1 — Auto-write detected flags into customer_notes. Runs once per stops
// payload identity (refresh button or initial fetch). Read-side respects the
// dispatcher's manual_overrides flag on each doc; never clobbers human edits.
function useAutoScanner(stops, notes, notesReady, user) {
  const lastWrittenForRef = useRef(null);
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    if (!db || !user || !notesReady || !stops.length) return;
    if (lastWrittenForRef.current === stops) return;
    lastWrittenForRef.current = stops;
    const scanned = stops
      .filter((s) => s.matchKey && Array.isArray(s.scanResults) && s.scanResults.length > 0)
      .map((s) => ({
        matchKey: s.matchKey,
        pro: s.pro,
        businessName: s.businessName,
        addr1: s.addr1,
        city: s.city,
        state: s.state,
        zip: s.zip,
        scanResults: s.scanResults,
      }));
    if (!scanned.length) {
      setSummary({ attempted: 0, written: 0, overrideSkips: 0, errors: [] });
      return;
    }
    applyScannerResults(db, scanned, notes)
      .then(setSummary)
      .catch((e) => console.error('auto-scanner write failed', e));
  }, [stops, notesReady, user]);
  return summary;
}

// Whether a stop should render with the "no tractor trailer" emphasis marker.
// We look at both human-set restrictions AND the live scan (so the marker
// turns red on the very first load, before the Firestore round-trip lands).
function hasNoTtSignal(stop, note) {
  if (note?.equipment_restrictions?.includes?.('no_tractor_trailer')) return true;
  if (Array.isArray(stop?.scanResults) && stop.scanResults.some((r) => r.flagValue === 'no_tractor_trailer')) return true;
  return false;
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

// M2.1: red marker with truck-with-slash overlay for stops carrying the
// no_tractor_trailer restriction. Bigger than the standard pin so it stands out
// against clustered colored pins.
function noTtPinSvg() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="42" viewBox="0 0 32 42">
      <path d="M16 1c-8 0-15 6-15 13 0 10 15 27 15 27s15-17 15-27c0-7-7-13-15-13z"
        fill="${FLAG_COLORS.red}" stroke="white" stroke-width="2.5"/>
      <g transform="translate(7,8)">
        <path d="M0 7h11v-5H0z" fill="white"/>
        <path d="M11 4h4l2 3v3H11z" fill="white"/>
        <circle cx="3" cy="9" r="1.5" fill="${FLAG_COLORS.red}"/>
        <circle cx="14" cy="9" r="1.5" fill="${FLAG_COLORS.red}"/>
        <line x1="-1" y1="13" x2="19" y2="-1" stroke="${FLAG_COLORS.red}" stroke-width="3"/>
        <line x1="-1" y1="13" x2="19" y2="-1" stroke="white" stroke-width="1.5"/>
      </g>
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

// ---------- components ----------

function LoginGate({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!auth) { setUser(null); return; }
    return onAuthStateChanged(auth, (u) => setUser(u));
  }, []);

  if (!firebaseConfigured) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
        <div className="max-w-md w-full bg-white border border-amber-300 rounded-lg p-6 shadow">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-amber-500 flex-shrink-0" size={24} />
            <div>
              <div className="font-semibold text-slate-900">Firebase not configured</div>
              <p className="text-sm text-slate-600 mt-1">
                Set the VITE_FIREBASE_* env vars (see <code className="px-1 bg-slate-100 rounded">.env.example</code>)
                before the app can authenticate. Once configured, you'll see the login screen.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (user === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500">
        <RefreshCw size={18} className="animate-spin mr-2" /> Loading…
      </div>
    );
  }

  if (!user) {
    const submit = async (e) => {
      e.preventDefault();
      setSubmitting(true);
      setError(null);
      try {
        await signInWithEmailAndPassword(auth, email, password);
      } catch (err) {
        setError(err.message);
      } finally {
        setSubmitting(false);
      }
    };
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-slate-100">
        <form onSubmit={submit} className="max-w-sm w-full bg-white rounded-xl shadow-lg p-6 space-y-4">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl text-white font-bold mb-2" style={{ background: BRAND }}>
              D
            </div>
            <div className="text-xl font-bold text-slate-900">Dispatch Map</div>
            <div className="text-xs text-slate-500">Davis Delivery Service</div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              autoComplete="email"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
              autoComplete="current-password"
            />
          </div>
          {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full text-white text-sm font-semibold py-2 rounded disabled:opacity-50"
            style={{ background: BRAND }}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    );
  }

  return children(user);
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

      <div className="pt-2 border-t">
        <div className="text-xs font-semibold text-slate-600 mb-1">Map legend</div>
        <ul className="text-[11px] text-slate-700 space-y-1">
          <li className="flex items-center gap-2">
            <img src={noTtPinSvg()} alt="" className="w-4 h-5" />
            <span>No tractor trailer (auto-detected or set)</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: RESTRICTION_TINT }} />
            <span>Has notes / other restrictions</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: UNFLAGGED_TINT }} />
            <span>No notes yet</span>
          </li>
        </ul>
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

// Resolve the human label for an equipment-restriction flag value.
function flagLabel(flagValue) {
  return EQUIPMENT_OPTIONS.find((o) => o.value === flagValue)?.label || flagValue;
}

// Detection Source — discloses to the dispatcher whether each equipment
// restriction was auto-detected, manually set, or both. Also fronts the
// "Override Auto-Detection" button when scanner output is currently driving
// the equipment_restrictions value.
function DetectionSourceSection({ stop, note, onOverrideAuto, saving }) {
  const autoSources = note?.auto_sources || {};
  const autoMatches = note?.auto_matches || {};
  const manualOverride = note?.manual_overrides?.equipment_restrictions === true;

  // Build the set of flags we want to disclose: anything currently set on the
  // doc plus anything the live scan turned up (covers first-paint before the
  // Firestore write lands).
  const flagsToShow = new Set();
  for (const f of note?.equipment_restrictions || []) flagsToShow.add(f);
  for (const f of Object.keys(autoSources)) flagsToShow.add(f);
  for (const r of stop?.scanResults || []) flagsToShow.add(r.flagValue);

  if (!flagsToShow.size) return null;

  const liveScanByFlag = {};
  for (const r of stop?.scanResults || []) {
    (liveScanByFlag[r.flagValue] = liveScanByFlag[r.flagValue] || []).push(r);
  }

  return (
    <div className="px-4 py-3 border-b bg-slate-50/60 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase font-semibold text-slate-500">Detection source</div>
        {manualOverride && (
          <span className="text-[10px] font-semibold text-slate-700 bg-slate-200 rounded px-1.5 py-0.5">
            override on
          </span>
        )}
      </div>
      <ul className="space-y-2">
        {[...flagsToShow].map((flag) => {
          const inNote = (note?.equipment_restrictions || []).includes(flag);
          const sources = autoSources[flag] || [];
          const matches = autoMatches[flag] || [];
          // If the persisted note has no auto trail yet, fall back to the live
          // scan so we still surface "Auto-detected" on first paint.
          const liveSources = (liveScanByFlag[flag] || []).map((r) => r.matchedSource);
          const liveMatches = (liveScanByFlag[flag] || []).map((r) => ({
            source: r.matchedSource, text: r.matchedText, pattern: r.matchedPattern,
          }));
          const effectiveSources = sources.length ? sources : liveSources;
          const effectiveMatches = matches.length ? matches : liveMatches;
          const autoDetected = effectiveSources.length > 0;
          const tag = manualOverride
            ? (autoDetected ? 'Override · auto also detected' : 'Manually set')
            : (autoDetected && inNote ? 'Auto + manual' : autoDetected ? 'Auto-detected' : 'Manually set');
          return (
            <li key={flag} className="text-xs">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-slate-800">{flagLabel(flag)}</div>
                <span className="text-[10px] uppercase tracking-wide text-slate-500">{tag}</span>
              </div>
              {effectiveMatches.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[11px] text-slate-600 pl-3 border-l-2 border-amber-300">
                  {effectiveMatches.map((m, i) => (
                    <li key={i}>
                      <span className="font-mono text-[10px] uppercase text-slate-400">{m.source}</span>{' '}
                      <span className="text-slate-700">"{m.text}"</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {!manualOverride && Object.keys(autoSources).length > 0 && onOverrideAuto && (
        <button
          onClick={onOverrideAuto}
          disabled={saving}
          className="mt-1 w-full text-xs font-semibold border border-slate-300 bg-white text-slate-700 rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-50"
          title="Stop the auto-scanner from touching equipment_restrictions on this customer"
        >
          Override auto-detection
        </button>
      )}
    </div>
  );
}

// Right-side sidebar showing stop + metadata + edit form.
function StopSidebar({ stop, note, onClose, onSave, onOverrideAuto, saving, saveError }) {
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

        {/* M2.1 — disclose where each restriction came from */}
        <DetectionSourceSection stop={stop} note={note} onOverrideAuto={onOverrideAuto} saving={saving} />

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

function MapScreen({ user }) {
  const { stops, loading, error, lastRefreshed, source, refresh } = useStops();
  const { notes, ready: notesReady } = useCustomerNotes();
  const { google, error: mapsError } = useGoogleMaps();
  const [selectedStop, setSelectedStop] = useState(null);
  const [filters, setFilters] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [showDrivers, setShowDrivers] = useState(false);
  const { drivers, error: driverErr, lastRefreshed: driversAt } = useDriverPositions(showDrivers);
  // M2.1 — fire-and-forget auto-population of customer_notes from scanner hits.
  const scanSummary = useAutoScanner(stops, notes, notesReady, user);

  const mapRef = useRef(null);
  const mapDiv = useRef(null);
  const clustererRef = useRef(null);
  const markersRef = useRef([]);
  const driverMarkersRef = useRef([]);

  const visibleStops = useMemo(() => applyFilters(stops, notes, filters), [stops, notes, filters]);
  const visibleSet = useMemo(() => new Set(visibleStops.map((s) => s.stopNbr)), [visibleStops]);

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
  }, [google]);

  // Re-render stop markers whenever visibility / notes change.
  useEffect(() => {
    if (!google || !mapRef.current) return;

    if (clustererRef.current) clustererRef.current.clearMarkers();
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    const newMarkers = visibleStops
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => {
        const note = notes.get(s.matchKey);
        const noTt = hasNoTtSignal(s, note);
        const iconCfg = noTt
          ? {
              url: noTtPinSvg(),
              scaledSize: new google.maps.Size(32, 42),
              anchor: new google.maps.Point(16, 40),
            }
          : {
              url: pinSvg(flagColor(note)),
              scaledSize: new google.maps.Size(28, 36),
              anchor: new google.maps.Point(14, 34),
            };
        const marker = new google.maps.Marker({
          position: { lat: s.lat, lng: s.lng },
          icon: iconCfg,
          title: noTt
            ? `${s.businessName || ''} — NO TRACTOR TRAILER`
            : (s.businessName || ''),
          zIndex: noTt ? 500 : undefined,
        });
        marker.addListener('click', () => setSelectedStop(s));
        return marker;
      });

    markersRef.current = newMarkers;
    clustererRef.current = new MarkerClusterer({ map: mapRef.current, markers: newMarkers });
  }, [google, visibleStops, notes]);

  // M4: driver markers — separate layer, not clustered, larger truck icon.
  useEffect(() => {
    if (!google || !mapRef.current) return;
    driverMarkersRef.current.forEach((m) => m.setMap(null));
    driverMarkersRef.current = [];
    if (!showDrivers) return;
    driverMarkersRef.current = drivers
      .filter((d) => d.lat != null && d.lng != null)
      .map((d) => new google.maps.Marker({
        position: { lat: d.lat, lng: d.lng },
        map: mapRef.current,
        icon: {
          url: truckSvg(DRIVER_TINT),
          scaledSize: new google.maps.Size(40, 40),
          anchor: new google.maps.Point(20, 20),
        },
        title: `${d.driverName || 'Driver'} · ${d.vehicleNumber || ''}`,
        zIndex: 1000,
      }));
  }, [google, drivers, showDrivers]);

  const handleSave = async (draft) => {
    if (!db || !selectedStop) return;
    setSaving(true);
    setSaveError(null);
    try {
      const key = selectedStop.matchKey;
      const existing = notes.get(key);
      const pro = selectedStop.pro;
      const proHistory = pro ? bumpProHistory(existing?.pro_history, pro) : (existing?.pro_history || []);
      // M2.1: any dispatcher edit to equipment_restrictions locks the field
      // against the auto-scanner. We compare draft vs existing as sets so that
      // re-ordering or re-saving the same content doesn't flip the override.
      const draftSet = new Set(draft.equipment_restrictions || []);
      const existSet = new Set(existing?.equipment_restrictions || []);
      const restrictionsChanged =
        draftSet.size !== existSet.size ||
        [...draftSet].some((x) => !existSet.has(x));
      const manualOverrides = {
        ...(existing?.manual_overrides || {}),
        ...(restrictionsChanged ? { equipment_restrictions: true } : {}),
      };
      const payload = {
        ...draft,
        match_key: key,
        raw_name: draft.raw_name || selectedStop.businessName || '',
        raw_address: draft.raw_address || [selectedStop.addr1, selectedStop.city, selectedStop.state, selectedStop.zip].filter(Boolean).join(', '),
        pro_history: proHistory,
        manual_overrides: manualOverrides,
        last_updated: serverTimestamp(),
        updated_by: user?.email || 'unknown',
      };
      await setDoc(doc(db, 'customer_notes', key), payload, { merge: true });
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  // Explicit override toggle — flips manual_overrides.equipment_restrictions
  // without requiring the dispatcher to edit any specific value first.
  const handleOverrideAuto = async () => {
    if (!db || !selectedStop) return;
    setSaving(true);
    setSaveError(null);
    try {
      const key = selectedStop.matchKey;
      const existing = notes.get(key) || {};
      await setDoc(doc(db, 'customer_notes', key), {
        match_key: key,
        raw_name: existing.raw_name || selectedStop.businessName || '',
        raw_address: existing.raw_address || [selectedStop.addr1, selectedStop.city, selectedStop.state, selectedStop.zip].filter(Boolean).join(', '),
        manual_overrides: { ...(existing.manual_overrides || {}), equipment_restrictions: true },
        last_updated: serverTimestamp(),
        updated_by: user?.email || 'unknown',
      }, { merge: true });
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left filter rail */}
      <div className="w-64 flex-shrink-0 bg-white border-r overflow-y-auto">
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
            <div className="text-[10px] text-slate-500">
              {driverErr ? <span className="text-red-600">⚠ {driverErr}</span> : `${drivers.length} drivers · refresh 60s${driversAt ? ` · ${fmtTimeAgo(driversAt)}` : ''}`}
            </div>
          )}
        </div>

        {/* Visible-stops mini table — sortable per dev rule */}
        <StopMiniTable stops={visibleStops} notes={notes} onPick={setSelectedStop} />
      </div>

      {/* Map */}
      <div className="flex-1 relative">
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
            No stops match the current filters.
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

      {/* Right sidebar */}
      {selectedStop && (
        <StopSidebar
          stop={selectedStop}
          note={notes.get(selectedStop.matchKey)}
          onClose={() => setSelectedStop(null)}
          onSave={handleSave}
          onOverrideAuto={handleOverrideAuto}
          saving={saving}
          saveError={saveError}
        />
      )}
    </div>
  );
}

function StopMiniTable({ stops, notes, onPick }) {
  // Decorate rows with flag for sorting.
  const rows = useMemo(() => stops.map((s) => {
    const n = notes.get(s.matchKey);
    return {
      ...s,
      _flag: n?.priority_flag || 'none',
      _hasNote: !!n,
    };
  }), [stops, notes]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, 'businessName', 'asc');
  return (
    <div className="border-t">
      <div className="px-3 py-2 text-xs font-semibold text-slate-600">Stops ({rows.length})</div>
      <div className="max-h-[40vh] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 sticky top-0">
            <tr>
              <SortableTh label="Flag" k="_flag" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="Customer" k="businessName" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="City" k="city" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
              <SortableTh label="PRO" k="pro" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.stopNbr} onClick={() => onPick(s)} className="cursor-pointer hover:bg-blue-50 border-t">
                <td className="px-2 py-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: s._flag !== 'none' ? FLAG_COLORS[s._flag] : (s._hasNote ? RESTRICTION_TINT : '#cbd5e1') }} />
                </td>
                <td className="px-2 py-1 truncate max-w-[120px]" title={s.businessName}>{s.businessName}</td>
                <td className="px-2 py-1 text-slate-600">{s.city}</td>
                <td className="px-2 py-1 font-mono text-[10px] text-slate-500">{s.pro}</td>
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

function Shell({ user }) {
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
        <div className="flex items-center gap-3 text-xs">
          <span className="text-slate-500 hidden sm:inline">{user?.email}</span>
          <button onClick={() => signOut(auth)} className="text-slate-500 hover:text-slate-800 inline-flex items-center gap-1">
            <LogOut size={14} /> sign out
          </button>
        </div>
      </header>

      {tab === 'map' ? <MapScreen user={user} /> : <DiagnosticsRoute />}

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
  return (
    <LoginGate>
      {(user) => <Shell user={user} />}
    </LoginGate>
  );
}
