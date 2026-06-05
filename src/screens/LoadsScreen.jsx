// src/screens/LoadsScreen.jsx — today's loads, real grid (v0.2.0)
//
// Mirrors NuVizz's Loads columns within the app's mobile-first card paradigm:
// Load Name, Reference/PRO, Driver, Status, Stops, Cartons, Volume, Pallets,
// Latest Departure, Weight, Origin, Start. Sortable + quick-search + status filter
// + count header + pager. Reuses __fleet.
//
// READ-ONLY. There are intentionally NO assign / dispatch / tender / update actions
// anywhere on this screen. The row data model is, however, structured "write-ready":
// see writeReadyModel() below, which retains load id, status, and the structured fields
// a future POST /load/update or /load/assignanddispatch would require — as values, not
// display strings — with TODO markers where write actions will one day attach.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Truck, Search, User, ChevronRight, RefreshCw, AlertTriangle, Package, ArrowUpDown, MapPin, Clock, Hash } from 'lucide-react';
import { fetchFleet, TENANTS } from '../lib/api';
import { fmtTime } from '../lib/normalize';
import { ErrorBox, ProgressBar, EmptyState } from '../components/UI';

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// WRITE-READY ROW MODEL (Part C)
// Pure projection of a fleet load into the structured shape a future write would post.
// Nothing here performs a write — it just keeps the values typed and addressable so the
// write surface can be bolted on without reshaping the grid.
// ---------------------------------------------------------------------------
export function writeReadyModel(l) {
  return {
    // identity — required by every load write
    loadId: l.loadId ?? null,
    loadNbr: l.loadNbr ?? null,
    // status — raw NuVizz load status kept as a value (not the derived display bucket)
    loadStatus: l.loadStatus ?? null,
    // assignment — the structured inputs to POST /load/assignanddispatch
    assignment: {
      driverUserName: l.driverUserName ?? null,
      driverEmail: l.driverEmail ?? null,
      vehicleType: l.vehicleType ?? null,
    },
    // references a write would echo back
    pronbr: l.pronbr ?? null,
    reference: l.reference ?? null,
    // timing levers a /load/update would touch
    earliestStart: l.earliestStart ?? null,
    latestStart: l.latestStart ?? null,
    // TODO(write): POST /load/update        — edit timing / references on this load
    // TODO(write): POST /load/assignanddispatch — assign `assignment.driverUserName` + dispatch
    // Both are deliberately UNWIRED in v0.2.0 (read-only). The dispatcher confirms on NuVizz.
  };
}

const SORTS = [
  { k: 'route', l: 'Name' },
  { k: 'status', l: 'Status' },
  { k: 'stops', l: 'Stops' },
  { k: 'pallets', l: 'Pallets' },
  { k: 'start', l: 'Start' },
  { k: 'pro', l: 'PRO' },
];

const BUCKET_RANK = { exception: 0, inProgress: 1, pending: 2, completed: 3, empty: 4 };

export default function LoadsScreen({ tenant, viewDate, onOpenLoad, initialFilter }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(initialFilter || 'active');
  const [sortKey, setSortKey] = useState('route');
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(0);
  const t = TENANTS[tenant];

  useEffect(() => {
    if (initialFilter) setFilter(initialFilter);
  }, [initialFilter]);

  const load = useCallback(async () => {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await fetchFleet(tenant, viewDate);
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState({ loading: false, error: e.message, data: null });
    }
  }, [tenant, viewDate]);

  useEffect(() => { load(); }, [load]);

  // Reset to first page whenever the result set changes.
  useEffect(() => { setPage(0); }, [search, filter, sortKey, sortDir, state.data]);

  // Bucket loads (derived from stop progress — more accurate than NuVizz's static loadStatus).
  const loads = useMemo(() => {
    const raw = state.data?.loads || [];
    return raw.map(l => {
      let bucket;
      if (l.exceptions > 0) bucket = 'exception';
      else if (l.totalStops === 0) bucket = 'empty';
      else if (l.delivered === l.totalStops && l.totalStops > 0) bucket = 'completed';
      else if (l.inProgress > 0 || l.delivered > 0) bucket = 'inProgress';
      else bucket = 'pending';
      return { ...l, bucket };
    });
  }, [state.data]);

  const counts = useMemo(() => ({
    all: loads.length,
    active: loads.filter(l => l.bucket === 'inProgress' || l.bucket === 'exception').length,
    inProgress: loads.filter(l => l.bucket === 'inProgress').length,
    completed: loads.filter(l => l.bucket === 'completed').length,
    exception: loads.filter(l => l.bucket === 'exception').length,
    pending: loads.filter(l => l.bucket === 'pending').length,
    empty: loads.filter(l => l.bucket === 'empty').length,
  }), [loads]);

  const filteredAll = useMemo(() => {
    const q = search.toLowerCase().trim();
    let list = loads.filter(l => {
      if (filter === 'active' && !(l.bucket === 'inProgress' || l.bucket === 'exception')) return false;
      if (filter !== 'all' && filter !== 'active' && l.bucket !== filter) return false;
      if (!q) return true;
      return [l.loadNbr, l.route, l.driver, l.driverUserName, l.vehicleType, l.pronbr, l.reference]
        .filter(Boolean).some(s => s.toString().toLowerCase().includes(q));
    });
    const dir = sortDir === 'asc' ? 1 : -1;
    list = [...list].sort((a, b) => {
      switch (sortKey) {
        case 'status': return ((BUCKET_RANK[a.bucket] ?? 9) - (BUCKET_RANK[b.bucket] ?? 9)) * dir;
        case 'stops': return ((a.totalStops || 0) - (b.totalStops || 0)) * dir;
        case 'pallets': return ((a.totalPallets || 0) - (b.totalPallets || 0)) * dir;
        case 'start': return ((a.earliestStart || '').localeCompare(b.earliestStart || '')) * dir;
        case 'pro': return ((a.pronbr || '').localeCompare(b.pronbr || '')) * dir;
        case 'route':
        default: return ((a.route || 'zzz').localeCompare(b.route || 'zzz')) * dir;
      }
    });
    return list;
  }, [loads, search, filter, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(filteredAll.length / PAGE_SIZE));
  const filtered = filteredAll.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="p-4 space-y-3 pb-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Loads</div>
          <div className="text-sm font-semibold text-slate-700">{counts.all} total · {counts.active} active</div>
        </div>
        <button onClick={load} disabled={state.loading} className="p-2 rounded-lg hover:bg-slate-100 text-slate-600 disabled:opacity-50">
          <RefreshCw size={18} className={state.loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search load, route, driver, PRO, or reference"
          className="w-full pl-9 pr-3 py-2.5 border rounded-lg text-base bg-white"
        />
      </div>

      <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
        {[
          { k: 'active', l: 'Active', n: counts.active, color: '#f59e0b' },
          { k: 'exception', l: 'Issues', n: counts.exception, color: '#ef4444' },
          { k: 'completed', l: 'Complete', n: counts.completed, color: '#10b981' },
          { k: 'pending', l: 'Pending', n: counts.pending, color: '#64748b' },
          { k: 'empty', l: 'Empty', n: counts.empty, color: '#94a3b8' },
          { k: 'all', l: 'All', n: counts.all, color: '#0f172a' },
        ].map(f => (
          <button
            key={f.k}
            onClick={() => setFilter(f.k)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition ${filter === f.k ? 'text-white' : 'bg-white border text-slate-700'}`}
            style={filter === f.k ? { background: f.color } : {}}
          >
            {f.l} {f.n}
          </button>
        ))}
      </div>

      {/* Sort control */}
      <div className="flex items-center gap-2 flex-wrap">
        <ArrowUpDown size={13} className="text-slate-400" />
        {SORTS.map((s) => (
          <button
            key={s.k}
            onClick={() => {
              if (sortKey === s.k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
              else { setSortKey(s.k); setSortDir('asc'); }
            }}
            className={`text-[11px] font-semibold px-2 py-1 rounded ${sortKey === s.k ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {s.l}{sortKey === s.k ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
        ))}
      </div>

      {state.loading && (
        <div className="bg-white rounded-xl p-4 border text-center">
          <RefreshCw size={24} className="mx-auto text-slate-400 animate-spin mb-2" />
          <div className="text-sm text-slate-600">Scanning NuVizz for today's loads...</div>
          <div className="text-[10px] text-slate-400 mt-1">~13s first load, then cached</div>
        </div>
      )}
      {state.error && <ErrorBox error={state.error} onRetry={load} />}

      {!state.loading && !state.error && (
        filteredAll.length === 0 ? (
          <EmptyState icon={<Truck size={32} className="text-slate-300" />} title="No loads match" hint={search ? `Nothing matches "${search}"` : 'No loads in this filter'} />
        ) : (
          <>
            <div className="space-y-2">
              {filtered.map(l => (
                <LoadCard key={l.loadNbr} load={l} tenant={tenant} onClick={() => onOpenLoad(l.loadNbr)} />
              ))}
            </div>
            {pageCount > 1 && (
              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border bg-white disabled:opacity-40"
                >
                  ← Prev
                </button>
                <span className="text-[11px] text-slate-500">
                  Page {page + 1} of {pageCount} · {filteredAll.length} loads
                </span>
                <button
                  onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border bg-white disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

function LoadCard({ load: l, tenant, onClick }) {
  const t = TENANTS[tenant];
  const statusColor = l.bucket === 'completed' ? '#10b981'
    : l.bucket === 'inProgress' ? '#f59e0b'
    : l.bucket === 'exception' ? '#ef4444'
    : '#64748b';
  const statusLabel = l.bucket === 'completed' ? 'Complete'
    : l.bucket === 'inProgress' ? 'Active'
    : l.bucket === 'exception' ? 'Issue'
    : l.bucket === 'empty' ? 'Empty'
    : 'Pending';

  return (
    <button onClick={onClick} className="w-full bg-white rounded-xl border p-3 text-left hover:bg-slate-50">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Truck size={14} className="text-slate-400 flex-shrink-0" />
            <span className="font-semibold text-sm truncate">{l.route || 'Unnamed'}</span>
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full text-white whitespace-nowrap" style={{ background: statusColor }}>
              {statusLabel}
            </span>
            {l.exceptions > 0 && (
              <span className="text-[9px] font-semibold text-red-700 flex items-center gap-0.5">
                <AlertTriangle size={10} /> {l.exceptions}
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5 font-mono truncate flex items-center gap-2">
            <span>{l.loadNbr}</span>
            {l.pronbr && <span className="flex items-center gap-0.5"><Hash size={9} />{l.pronbr}</span>}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-base font-bold" style={{ color: t.color }}>{l.pctComplete}%</div>
          <div className="text-[10px] text-slate-500">{l.delivered}/{l.totalStops}</div>
        </div>
      </div>

      {l.totalStops > 0 && <ProgressBar value={l.delivered} max={l.totalStops} color={t.color} />}

      <div className="flex items-center justify-between mt-2 text-[11px]">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <User size={11} className="text-slate-400 flex-shrink-0" />
          <span className="truncate text-slate-700">{l.driver || 'Unassigned'}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 text-slate-500">
          {l.totalPallets > 0 && <span className="flex items-center gap-0.5"><Package size={10} /> {l.totalPallets}</span>}
          {l.totalCartons > 0 && <span>{l.totalCartons} ctn</span>}
          {l.vehicleType && <span className="text-[10px]">{l.vehicleType}</span>}
          <ChevronRight size={14} className="text-slate-300" />
        </div>
      </div>

      {/* Grid detail row: origin · start · latest departure · volume · weight */}
      <div className="flex items-center flex-wrap gap-x-3 gap-y-0.5 mt-1.5 pt-1.5 border-t text-[10px] text-slate-500">
        {l.origin?.city && (
          <span className="flex items-center gap-0.5"><MapPin size={9} />{[l.origin.city, l.origin.state].filter(Boolean).join(', ')}</span>
        )}
        {l.earliestStart && <span className="flex items-center gap-0.5"><Clock size={9} />Start {fmtTime(l.earliestStart)}</span>}
        {l.latestStart && <span>Latest dep {fmtTime(l.latestStart)}</span>}
        {l.volume > 0 && <span>{l.volume}{l.volumeUOM ? ` ${l.volumeUOM.toLowerCase()}` : ''}</span>}
        {l.weight > 0 && <span>{l.weight}{l.weightUOM ? ` ${l.weightUOM.toLowerCase()}` : ' lb'}</span>}
      </div>
    </button>
  );
}
