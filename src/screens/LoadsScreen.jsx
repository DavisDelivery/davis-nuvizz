// src/screens/LoadsScreen.jsx — today's loads with search + filters
//
// Uses __fleet endpoint which scans NuVizz's load-number range. Shares the 60s
// in-memory cache with DriversScreen so tab-switching is fast.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Truck, Search, User, ChevronRight, RefreshCw, AlertTriangle, Package } from 'lucide-react';
import { fetchFleet, TENANTS } from '../lib/api';
import { ErrorBox, ProgressBar, EmptyState } from '../components/UI';

export default function LoadsScreen({ tenant, viewDate, onOpenLoad, initialFilter }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(initialFilter || 'active');
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

  // Bucket loads
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

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return loads.filter(l => {
      if (filter === 'active' && !(l.bucket === 'inProgress' || l.bucket === 'exception')) return false;
      if (filter !== 'all' && filter !== 'active' && l.bucket !== filter) return false;
      if (!q) return true;
      return [l.loadNbr, l.route, l.driver, l.driverUserName, l.vehicleType]
        .filter(Boolean).some(s => s.toString().toLowerCase().includes(q));
    });
  }, [loads, search, filter]);

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
          placeholder="Search load, route, or driver"
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

      {state.loading && (
        <div className="bg-white rounded-xl p-4 border text-center">
          <RefreshCw size={24} className="mx-auto text-slate-400 animate-spin mb-2" />
          <div className="text-sm text-slate-600">Scanning NuVizz for today's loads...</div>
          <div className="text-[10px] text-slate-400 mt-1">~13s first load, then cached</div>
        </div>
      )}
      {state.error && <ErrorBox error={state.error} onRetry={load} />}

      {!state.loading && !state.error && (
        filtered.length === 0 ? (
          <EmptyState icon={<Truck size={32} className="text-slate-300" />} title="No loads match" hint={search ? `Nothing matches "${search}"` : 'No loads in this filter'} />
        ) : (
          <div className="space-y-2">
            {filtered.map(l => (
              <LoadCard key={l.loadNbr} load={l} tenant={tenant} onClick={() => onOpenLoad(l.loadNbr)} />
            ))}
          </div>
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
          <div className="text-[11px] text-slate-500 mt-0.5 font-mono truncate">{l.loadNbr}</div>
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
          {l.vehicleType && <span className="text-[10px]">{l.vehicleType}</span>}
          <ChevronRight size={14} className="text-slate-300" />
        </div>
      </div>
    </button>
  );
}
