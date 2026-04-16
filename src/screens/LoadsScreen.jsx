// src/screens/LoadsScreen.jsx — full list of today's loads with search & filters

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Truck, Search, User, Clock, Route, ChevronRight, RefreshCw } from 'lucide-react';
import { fetchToday } from '../lib/api';
import { normalizeLoad, fmtTime } from '../lib/normalize';
import { TENANTS } from '../lib/api';
import { Loading, ErrorBox, StatusPill, ProgressBar, EmptyState } from '../components/UI';

export default function LoadsScreen({ tenant, onOpenLoad }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const t = TENANTS[tenant];

  const load = useCallback(async () => {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await fetchToday(tenant);
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState({ loading: false, error: e.message, data: null });
    }
  }, [tenant]);

  useEffect(() => { load(); }, [load]);

  const loads = useMemo(() => (state.data?.loads || []).map(normalizeLoad), [state.data]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return loads.filter(l => {
      if (statusFilter !== 'all' && l.bucket !== statusFilter) return false;
      if (!q) return true;
      return [l.nbr, l.routeName, l.driverName, l.vehicleNbr, l.tractorNbr].filter(Boolean).some(s => s.toString().toLowerCase().includes(q));
    });
  }, [loads, search, statusFilter]);

  if (state.loading) return <Loading msg="Loading loads..." />;
  if (state.error) return <ErrorBox error={state.error} onRetry={load} />;

  return (
    <div className="p-4 space-y-3">
      {/* Search */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search load nbr, driver, vehicle..."
          className="w-full pl-9 pr-3 py-2.5 border rounded-lg text-sm bg-white"
        />
      </div>

      {/* Filter chips */}
      <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
        {[
          { k: 'all', l: `All (${loads.length})` },
          { k: 'inProgress', l: `Active (${loads.filter(x => x.bucket === 'inProgress').length})` },
          { k: 'completed', l: `Complete (${loads.filter(x => x.bucket === 'completed').length})` },
          { k: 'pending', l: `Pending (${loads.filter(x => x.bucket === 'pending').length})` },
        ].map(f => (
          <button
            key={f.k}
            onClick={() => setStatusFilter(f.k)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${statusFilter === f.k ? 'bg-slate-900 text-white' : 'bg-white border text-slate-700'}`}
          >
            {f.l}
          </button>
        ))}
        <button onClick={load} className="px-3 py-1.5 rounded-full bg-white border text-slate-500">
          <RefreshCw size={12} />
        </button>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <EmptyState icon={<Truck size={32} className="text-slate-300" />} title="No loads match" hint={search ? `Nothing matches "${search}"` : 'No loads in this filter'} />
      ) : (
        <div className="space-y-2">
          {filtered.map(l => (
            <button
              key={l.nbr}
              onClick={() => onOpenLoad(l.nbr)}
              className="w-full bg-white rounded-xl border p-3 text-left hover:bg-slate-50"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Truck size={14} className="text-slate-400 flex-shrink-0" />
                    <span className="font-mono text-sm font-semibold">{l.nbr}</span>
                    <StatusPill status={l.status} size="xs" />
                  </div>
                  {l.routeName && <div className="text-xs text-slate-500 mt-0.5 truncate">{l.routeName}</div>}
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-base font-bold" style={{ color: t.color }}>{l.pctComplete}%</div>
                  <div className="text-[10px] text-slate-500">{l.completed}/{l.total}</div>
                </div>
              </div>

              <ProgressBar value={l.completed} max={l.total} color={t.color} />

              <div className="flex items-center justify-between mt-2 text-[11px] text-slate-600">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="flex items-center gap-1 truncate">
                    <User size={11} className="text-slate-400" />
                    {l.driverName || 'Unassigned'}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {(l.actualMiles || l.plannedMiles) ? <span className="flex items-center gap-0.5"><Route size={11} />{Math.round(l.actualMiles || l.plannedMiles)}mi</span> : null}
                  {l.actualStart && <span className="flex items-center gap-0.5"><Clock size={11} />{fmtTime(l.actualStart)}</span>}
                  <ChevronRight size={14} className="text-slate-300" />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
