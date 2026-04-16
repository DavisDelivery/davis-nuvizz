// src/screens/Dashboard.jsx — home screen
// Top: KPI cards (total / completed / in progress / on-time / miles / avg dwell)
// Middle: Exceptions feed (failed, cancelled, late)
// Bottom: Today's loads with progress bars

import React, { useState, useEffect, useCallback } from 'react';
import { Truck, AlertTriangle, RefreshCw, ChevronRight, Clock, MapPin, User, Package, CheckCircle2, XCircle } from 'lucide-react';
import { fetchToday } from '../lib/api';
import { normalizeLoad, normalizeStop, fmtTime, fmtDate, BUCKET_COLORS } from '../lib/normalize';
import { TENANTS } from '../lib/api';
import { KPI, Loading, ErrorBox, SectionHeader, ProgressBar, StatusPill, EmptyState } from '../components/UI';

export default function Dashboard({ tenant, onOpenLoad, onOpenStop, onOpenMap, onOpenStops }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
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

  if (state.loading) return <Loading msg="Loading today's dispatch..." />;
  if (state.error) return <ErrorBox error={state.error} onRetry={load} />;

  const { stops = [], loads = [], summary = {} } = state.data || {};

  const normalizedStops = stops.map(normalizeStop);
  const normalizedLoads = loads.map(normalizeLoad);

  const exceptions = normalizedStops.filter(s => s.bucket === 'failed' || s.bucket === 'cancelled' || s.etaCode === 'LATE' || s.hasException);

  return (
    <div className="p-4 space-y-4 pb-4">
      {/* Header with date + refresh */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Today</div>
          <div className="text-lg font-bold">{new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</div>
        </div>
        <button onClick={load} className="p-2 rounded-lg hover:bg-slate-100 text-slate-600">
          <RefreshCw size={18} />
        </button>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 gap-2">
        <KPI label="Stops" value={summary.totalStops || 0} sub={`${summary.pctComplete || 0}% complete`} accent={t.color} onClick={onOpenStops} />
        <KPI label="Loads" value={summary.totalLoads || 0} sub={`${normalizedLoads.filter(l => l.bucket === 'inProgress').length} active`} accent={t.color} />
        <KPI label="Miles" value={summary.totalMiles || 0} sub="planned today" />
        <KPI label="Avg Dwell" value={`${summary.avgDwellMin || 0}m`} sub="per stop" />
      </div>

      {/* Completion progress bar */}
      {summary.totalStops > 0 && (
        <div className="bg-white rounded-xl p-4 border">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="font-semibold text-slate-700">Day Progress</span>
            <span className="text-slate-500">{summary.completed}/{summary.totalStops} stops</span>
          </div>
          <ProgressBar value={summary.completed} max={summary.totalStops} color="#10b981" height={10} />
          <div className="flex gap-3 mt-3 text-[11px]">
            <StatusChip count={summary.completed} label="Complete" color="#10b981" />
            <StatusChip count={summary.inProgress} label="Active" color="#f59e0b" />
            <StatusChip count={summary.pending} label="Pending" color="#64748b" />
            {summary.failed > 0 && <StatusChip count={summary.failed} label="Failed" color="#ef4444" />}
          </div>
        </div>
      )}

      {/* Map teaser */}
      <button onClick={onOpenMap} className="w-full bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl p-4 flex items-center justify-between text-white">
        <div className="flex items-center gap-3">
          <MapPin size={22} />
          <div className="text-left">
            <div className="font-semibold">Map View</div>
            <div className="text-xs text-slate-300">See all {summary.totalStops} stops + routes</div>
          </div>
        </div>
        <ChevronRight size={20} />
      </button>

      {/* Exceptions feed */}
      {exceptions.length > 0 && (
        <div>
          <SectionHeader title={`Exceptions (${exceptions.length})`} />
          <div className="bg-white rounded-xl border divide-y overflow-hidden">
            {exceptions.slice(0, 5).map((s) => (
              <button
                key={s.id || s.nbr}
                onClick={() => onOpenStop(s.nbr)}
                className="w-full p-3 flex items-start gap-3 hover:bg-slate-50 text-left"
              >
                <div className="mt-0.5">
                  {s.bucket === 'failed' ? <XCircle size={18} className="text-red-500" /> : s.bucket === 'cancelled' ? <XCircle size={18} className="text-rose-600" /> : <AlertTriangle size={18} className="text-amber-500" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-mono text-[11px] text-slate-500">{s.nbr}</span>
                    <StatusPill status={s.status} size="xs" />
                  </div>
                  <div className="text-sm font-medium truncate">{s.name || s.customerName || '—'}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {s.city}{s.state ? `, ${s.state}` : ''} · {s.driverName || 'Unassigned'}
                  </div>
                  {s.exceptions?.[0] && (
                    <div className="text-[11px] text-red-700 mt-0.5 truncate">
                      {s.exceptions[0].exceptionDesc || s.exceptions[0].exceptionCode}
                    </div>
                  )}
                </div>
                <ChevronRight size={16} className="text-slate-300 mt-1 flex-shrink-0" />
              </button>
            ))}
            {exceptions.length > 5 && (
              <div className="p-2 text-center text-xs text-slate-500">+{exceptions.length - 5} more exceptions</div>
            )}
          </div>
        </div>
      )}

      {/* Today's loads */}
      <div>
        <SectionHeader
          title={`Active Loads (${normalizedLoads.length})`}
          action={normalizedLoads.length > 0 && <button onClick={() => {}} className="text-[11px] text-slate-500">All →</button>}
        />
        {normalizedLoads.length === 0 ? (
          <EmptyState icon={<Truck size={32} className="text-slate-300" />} title="No loads dispatched yet" hint="Loads will appear here as they're assigned." />
        ) : (
          <div className="space-y-2">
            {normalizedLoads.map((l) => (
              <LoadCard key={l.nbr} load={l} tenant={tenant} onClick={() => onOpenLoad(l.nbr)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusChip({ count, label, color }) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      <span className="text-slate-600">{count} {label}</span>
    </div>
  );
}

function LoadCard({ load, tenant, onClick }) {
  const t = TENANTS[tenant];
  return (
    <button onClick={onClick} className="w-full bg-white rounded-xl border p-3 text-left hover:bg-slate-50 transition">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Truck size={14} className="text-slate-400 flex-shrink-0" />
            <span className="font-mono text-sm font-semibold truncate">{load.nbr}</span>
            <StatusPill status={load.status} size="xs" />
          </div>
          {load.routeName && <div className="text-xs text-slate-500 mt-0.5 truncate">{load.routeName}</div>}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm font-bold" style={{ color: t.color }}>{load.pctComplete}%</div>
          <div className="text-[10px] text-slate-500">{load.completed}/{load.total}</div>
        </div>
      </div>

      <ProgressBar value={load.completed} max={load.total} color={t.color} />

      <div className="flex items-center justify-between mt-2 text-[11px] text-slate-600">
        <div className="flex items-center gap-1 min-w-0">
          <User size={11} className="text-slate-400 flex-shrink-0" />
          <span className="truncate">{load.driverName || 'Unassigned'}</span>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {load.actualMiles || load.plannedMiles ? <span>{Math.round(load.actualMiles || load.plannedMiles)}mi</span> : null}
          {load.actualStart && <span className="flex items-center gap-1"><Clock size={11} />{fmtTime(load.actualStart)}</span>}
        </div>
      </div>
    </button>
  );
}
