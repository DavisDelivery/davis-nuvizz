// src/screens/DriversScreen.jsx — leaderboard of drivers with stats

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Trophy, User, Phone, Clock, CheckCircle2, RefreshCw, ChevronRight, Truck } from 'lucide-react';
import { fetchToday } from '../lib/api';
import { normalizeStop, normalizeLoad, fmtTime } from '../lib/normalize';
import { TENANTS } from '../lib/api';
import { Loading, ErrorBox, ProgressBar, EmptyState } from '../components/UI';

export default function DriversScreen({ tenant, onOpenLoad }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const t = TENANTS[tenant];

  const load = useCallback(async () => {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await fetchToday(tenant);
      setState({ loading: false, error: null, data });
    } catch (e) { setState({ loading: false, error: e.message, data: null }); }
  }, [tenant]);

  useEffect(() => { load(); }, [load]);

  const drivers = useMemo(() => {
    if (!state.data) return [];
    const stops = (state.data.stops || []).map(normalizeStop);
    const loads = (state.data.loads || []).map(normalizeLoad);

    // Aggregate per driver
    const byDriver = {};
    for (const s of stops) {
      if (!s.driverName) continue;
      if (!byDriver[s.driverName]) {
        byDriver[s.driverName] = {
          name: s.driverName, phone: s.driverPhone,
          stops: [], loadNbrs: new Set(),
          completed: 0, failed: 0, inProgress: 0,
          onTime: 0, late: 0, dwellSum: 0, dwellCount: 0,
        };
      }
      const d = byDriver[s.driverName];
      d.stops.push(s);
      if (s.loadNbr) d.loadNbrs.add(s.loadNbr);
      if (s.bucket === 'completed') d.completed++;
      else if (s.bucket === 'failed') d.failed++;
      else if (s.bucket === 'inProgress') d.inProgress++;
      if (s.etaCode === 'ONTIME') d.onTime++;
      else if (s.etaCode === 'LATE' || s.etaCode === 'DELAYED') d.late++;
      if (s.dwellMin) { d.dwellSum += s.dwellMin; d.dwellCount++; }
    }

    return Object.values(byDriver).map(d => ({
      ...d,
      loadNbrs: Array.from(d.loadNbrs),
      totalStops: d.stops.length,
      pctComplete: d.stops.length ? Math.round((d.completed / d.stops.length) * 100) : 0,
      onTimePct: (d.onTime + d.late) > 0 ? Math.round((d.onTime / (d.onTime + d.late)) * 100) : null,
      avgDwell: d.dwellCount ? Math.round(d.dwellSum / d.dwellCount) : null,
    })).sort((a, b) => {
      // Rank by: completed desc, then on-time desc, then dwell asc
      if (b.completed !== a.completed) return b.completed - a.completed;
      if ((b.onTimePct || 0) !== (a.onTimePct || 0)) return (b.onTimePct || 0) - (a.onTimePct || 0);
      return (a.avgDwell || 999) - (b.avgDwell || 999);
    });
  }, [state.data]);

  if (state.loading) return <Loading msg="Loading drivers..." />;
  if (state.error) return <ErrorBox error={state.error} onRetry={load} />;

  if (drivers.length === 0) {
    return <EmptyState icon={<User size={32} className="text-slate-300" />} title="No drivers today" hint="Driver stats appear once loads are assigned." />;
  }

  const top = drivers[0];

  return (
    <div className="p-4 space-y-4">
      {/* Top of leaderboard - hero card */}
      {top && top.completed > 0 && (
        <div className="bg-gradient-to-br from-amber-400 to-amber-600 rounded-2xl p-4 text-white shadow-lg">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold opacity-90">
            <Trophy size={14} /> Top Driver · Today
          </div>
          <div className="text-xl font-bold mt-1">{top.name}</div>
          <div className="grid grid-cols-3 gap-2 mt-3">
            <HeroStat label="Stops Done" value={top.completed} />
            <HeroStat label="Complete" value={`${top.pctComplete}%`} />
            <HeroStat label="On-Time" value={top.onTimePct == null ? '—' : `${top.onTimePct}%`} />
          </div>
        </div>
      )}

      {/* Refresh */}
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-700">{drivers.length} drivers dispatched</div>
        <button onClick={load} className="text-xs text-blue-600 flex items-center gap-1"><RefreshCw size={12} /> Refresh</button>
      </div>

      {/* Leaderboard list */}
      <div className="space-y-2">
        {drivers.map((d, i) => (
          <DriverCard key={d.name} driver={d} rank={i + 1} tenant={tenant} onOpenLoad={onOpenLoad} />
        ))}
      </div>
    </div>
  );
}

function HeroStat({ label, value }) {
  return (
    <div className="bg-white/20 rounded-lg px-2 py-1.5 text-center backdrop-blur">
      <div className="text-[9px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-lg font-bold">{value}</div>
    </div>
  );
}

function DriverCard({ driver: d, rank, tenant, onOpenLoad }) {
  const t = TENANTS[tenant];
  const medalColor = rank === 1 ? '#f59e0b' : rank === 2 ? '#94a3b8' : rank === 3 ? '#b45309' : '#e2e8f0';
  return (
    <div className="bg-white rounded-xl border p-3">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-white flex-shrink-0" style={{ background: medalColor }}>
          {rank <= 3 ? rank : rank}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold text-sm truncate">{d.name}</div>
            {d.phone && <a href={`tel:${d.phone}`} className="text-blue-600 flex-shrink-0" onClick={e => e.stopPropagation()}><Phone size={14} /></a>}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {d.totalStops} stops · {d.loadNbrs.length} load{d.loadNbrs.length !== 1 ? 's' : ''}
            {d.avgDwell != null && ` · ${d.avgDwell}m avg dwell`}
          </div>

          <ProgressBar value={d.completed} max={d.totalStops} color={t.color} height={5} />

          <div className="flex gap-3 mt-1.5 text-[10px]">
            <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 size={10} /> {d.completed} done</span>
            {d.inProgress > 0 && <span className="flex items-center gap-1 text-amber-600"><Truck size={10} /> {d.inProgress} active</span>}
            {d.failed > 0 && <span className="text-red-600">{d.failed} failed</span>}
            {d.onTimePct != null && <span className="ml-auto text-slate-600">{d.onTimePct}% on-time</span>}
          </div>

          {/* Loads chips */}
          {d.loadNbrs.length > 0 && (
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {d.loadNbrs.slice(0, 4).map(ln => (
                <button key={ln} onClick={() => onOpenLoad(ln)} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 hover:bg-slate-200">
                  {ln}
                </button>
              ))}
              {d.loadNbrs.length > 4 && <span className="text-[10px] text-slate-500 px-1 py-0.5">+{d.loadNbrs.length - 4}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
