// src/screens/StopsScreen.jsx — today's stops with filters + search
//
// Uses __fleetstops endpoint which returns flat stop data across all loads.
// Cached server-side 60s; shares scan with __fleet/__driver when possible.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Package, Search, MapPin, User, ChevronRight, RefreshCw, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { fetchFleetStops, TENANTS } from '../lib/api';
import { fmtTime } from '../lib/normalize';
import { ErrorBox, EmptyState } from '../components/UI';

const STATUS_LABEL = { '10': 'Created', '30': 'Scheduled', '40': 'En Route', '50': 'Exception', '90': 'Delivered' };
const STATUS_COLOR = { '10': '#64748b', '30': '#64748b', '40': '#f59e0b', '50': '#ef4444', '90': '#10b981' };

export default function StopsScreen({ tenant, onOpenStop, initialFilter }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(initialFilter || 'active'); // active = in-transit + scheduled + exceptions
  const t = TENANTS[tenant];

  // React to changes in initialFilter (e.g. jumping from Home tile)
  useEffect(() => {
    if (initialFilter) setFilter(initialFilter);
  }, [initialFilter]);

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

  const stops = state.data?.stops || [];
  const summary = state.data?.summary;

  const counts = useMemo(() => ({
    all: stops.length,
    active: stops.filter(s => s.status === '40' || s.status === '30' || s.status === '10' || s.exceptionPresent).length,
    delivered: stops.filter(s => s.status === '90').length,
    inTransit: stops.filter(s => s.status === '40').length,
    exceptions: stops.filter(s => s.exceptionPresent || s.status === '50').length,
    scheduled: stops.filter(s => s.status === '30' || s.status === '10').length,
  }), [stops]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return stops.filter(s => {
      if (filter === 'active' && !(s.status === '40' || s.status === '30' || s.status === '10' || s.exceptionPresent)) return false;
      if (filter === 'delivered' && s.status !== '90') return false;
      if (filter === 'inTransit' && s.status !== '40') return false;
      if (filter === 'exceptions' && !(s.exceptionPresent || s.status === '50')) return false;
      if (filter === 'scheduled' && !(s.status === '30' || s.status === '10')) return false;
      if (!q) return true;
      return [s.stopNbr, s.name, s.city, s.state, s.bol, s.driver, s.route, s.loadNbr]
        .filter(Boolean).some(x => x.toString().toLowerCase().includes(q));
    });
  }, [stops, search, filter]);

  return (
    <div className="p-4 space-y-3 pb-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Today's Stops</div>
          <div className="text-lg font-bold">{new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</div>
        </div>
        <button onClick={load} disabled={state.loading} className="p-2 rounded-lg hover:bg-slate-100 text-slate-600 disabled:opacity-50">
          <RefreshCw size={18} className={state.loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {summary && (
        <div className="bg-white rounded-xl border p-3 grid grid-cols-4 gap-2">
          <StatTile label="Total" value={summary.totalStops} color="#1e5b92" />
          <StatTile label="Delivered" value={summary.delivered} color="#10b981" />
          <StatTile label="Active" value={summary.inProgress} color="#f59e0b" />
          <StatTile label="Issues" value={summary.exceptions} color="#ef4444" />
        </div>
      )}

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search PRO, customer, city, or driver"
          className="w-full pl-9 pr-3 py-2.5 border rounded-lg text-base bg-white"
        />
      </div>

      <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
        {[
          { k: 'active', l: 'Active', n: counts.active, color: '#f59e0b' },
          { k: 'exceptions', l: 'Issues', n: counts.exceptions, color: '#ef4444' },
          { k: 'inTransit', l: 'En Route', n: counts.inTransit, color: '#f59e0b' },
          { k: 'scheduled', l: 'Scheduled', n: counts.scheduled, color: '#64748b' },
          { k: 'delivered', l: 'Delivered', n: counts.delivered, color: '#10b981' },
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
          <div className="text-sm text-slate-600">Loading today's stops...</div>
          <div className="text-[10px] text-slate-400 mt-1">~15s first load, cached after</div>
        </div>
      )}
      {state.error && <ErrorBox error={state.error} onRetry={load} />}

      {!state.loading && !state.error && (
        filtered.length === 0 ? (
          <EmptyState icon={<Package size={32} className="text-slate-300" />} title="No stops" hint={search ? `Nothing matches "${search}"` : 'No stops in this filter'} />
        ) : (
          <div className="bg-white rounded-xl border divide-y overflow-hidden">
            {filtered.slice(0, 200).map((s, i) => (
              <StopRow key={`${s.loadNbr}-${s.stopNbr}-${i}`} stop={s} onClick={() => onOpenStop(s.stopNbr)} />
            ))}
            {filtered.length > 200 && (
              <div className="p-3 text-center text-xs text-slate-500">
                Showing 200 of {filtered.length}. Narrow the search to see more.
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

function StatTile({ label, value, color }) {
  return (
    <div className="text-center">
      <div className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
      <div className="text-xl font-bold" style={{ color }}>{value}</div>
    </div>
  );
}

function StopRow({ stop: s, onClick }) {
  const statusLabel = STATUS_LABEL[s.status] || s.status || '?';
  const statusColor = STATUS_COLOR[s.status] || '#64748b';

  return (
    <button onClick={onClick} className="w-full p-3 flex items-start gap-3 hover:bg-slate-50 text-left">
      <div
        className="w-2 h-2 rounded-full mt-2 flex-shrink-0"
        style={{ background: statusColor }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: statusColor }}>
            {statusLabel}
          </span>
          <span className="font-mono text-[10px] text-slate-400">{s.stopNbr}</span>
          {s.exceptionPresent && <AlertTriangle size={11} className="text-amber-500" />}
        </div>
        <div className="text-sm font-medium truncate">{s.name || '—'}</div>
        <div className="text-[11px] text-slate-500 truncate flex items-center gap-1">
          <MapPin size={9} />
          <span className="truncate">{[s.city, s.state].filter(Boolean).join(', ')}</span>
          {s.driver && (
            <>
              <span className="mx-0.5">·</span>
              <User size={9} />
              <span className="truncate">{s.driver}</span>
            </>
          )}
        </div>
        {s.confirmedDTTM ? (
          <div className="text-[10px] text-emerald-700 mt-0.5 flex items-center gap-1">
            <CheckCircle2 size={10} /> Delivered {fmtTime(s.confirmedDTTM)}
          </div>
        ) : s.plannedEta ? (
          <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1">
            <Clock size={10} /> ETA {fmtTime(s.plannedEta)}
          </div>
        ) : null}
      </div>
      <ChevronRight size={14} className="text-slate-300 mt-1 flex-shrink-0" />
    </button>
  );
}
