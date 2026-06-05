// src/screens/LoadDetail.jsx — detail view for a single load

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, MapPin, User, Clock, Route, Package, Phone, ChevronRight, Truck } from 'lucide-react';
import { fetchLoad } from '../lib/api';
import { normalizeLoad, fmtTime, fmtDateTime, minutesBetween, BUCKET_COLORS } from '../lib/normalize';
import { TENANTS } from '../lib/api';
import { Loading, ErrorBox, StatusPill, ProgressBar, Field, SectionHeader } from '../components/UI';

export default function LoadDetail({ tenant, loadNbr, onOpenStop }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const t = TENANTS[tenant];

  const load = useCallback(async () => {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await fetchLoad(tenant, loadNbr, t.companyCode);
      setState({ loading: false, error: null, data: normalizeLoad(data) });
    } catch (e) { setState({ loading: false, error: e.message, data: null }); }
  }, [tenant, loadNbr, t.companyCode]);

  useEffect(() => { load(); }, [load]);

  if (state.loading) return <Loading msg={`Loading ${loadNbr}...`} />;
  if (state.error) return <ErrorBox error={state.error} onRetry={load} />;

  const l = state.data;
  if (!l) return <ErrorBox error="Load not found" onRetry={load} />;

  const durationActual = l.actualStart && l.actualEnd ? minutesBetween(l.actualStart, l.actualEnd) : null;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="bg-white rounded-xl border p-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Load</div>
            <div className="text-xl font-bold font-mono">{l.nbr}</div>
            {l.routeName && <div className="text-xs text-slate-500 mt-0.5">{l.routeName}</div>}
          </div>
          <StatusPill bucket={l.bucket} />
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="font-semibold">Progress</span>
            <span className="text-slate-500">{l.completed}/{l.total} stops · {l.pctComplete}%</span>
          </div>
          <ProgressBar value={l.completed} max={l.total} color={t.color} height={8} />
        </div>

        {/* Driver */}
        {l.driverName && (
          <div className="mt-4 pt-4 border-t flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold" style={{ background: t.color }}>
              {l.driverName.split(' ').map(n => n[0]).join('').slice(0, 2)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate">{l.driverName}</div>
              <div className="text-xs text-slate-500">{l.vehicleType || '—'}{l.tractorNbr ? ` · ${l.tractorNbr}` : ''}</div>
            </div>
            {l.driverPhone && <a href={`tel:${l.driverPhone}`} className="p-2 rounded-full bg-blue-50 text-blue-600"><Phone size={16} /></a>}
          </div>
        )}

        <button onClick={load} className="mt-3 text-xs text-blue-600 flex items-center gap-1"><RefreshCw size={12} /> Refresh</button>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Actual Start" value={fmtTime(l.actualStart)} sub={fmtDateTime(l.actualStart).split(' ').slice(0, 2).join(' ')} />
        <StatCard label="Actual End" value={fmtTime(l.actualEnd)} sub={l.actualEnd ? 'completed' : 'in progress'} />
        <StatCard label="Miles" value={Math.round(l.actualMiles || l.plannedMiles || 0)} sub={l.actualMiles ? 'actual' : 'planned'} />
        <StatCard label="Duration" value={durationActual ? `${Math.floor(durationActual / 60)}h ${durationActual % 60}m` : '—'} sub={l.plannedDuration ? `planned ${Math.floor(l.plannedDuration / 60)}h` : ''} />
        {l.totalCartons > 0 && <StatCard label="Cartons" value={l.totalCartons} />}
        {l.totalPallets > 0 && <StatCard label="Pallets" value={l.totalPallets} />}
      </div>

      {/* Origin */}
      {l.origin?.name && (
        <div className="bg-white rounded-xl border p-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Origin</div>
          <div className="flex items-start gap-2 mt-1">
            <MapPin size={14} className="text-slate-400 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium">{l.origin.name}</div>
              <div className="text-xs text-slate-500">{[l.origin.addr1, l.origin.city, l.origin.state].filter(Boolean).join(', ')}</div>
            </div>
          </div>
        </div>
      )}

      {/* Stops sequence */}
      <div>
        <SectionHeader title={`Stops (${l.stops.length})`} />
        <div className="bg-white rounded-xl border divide-y overflow-hidden">
          {l.stops.length === 0 && <div className="p-4 text-sm text-slate-500">No stops on this load.</div>}
          {l.stops.map((s, i) => (
            <button
              key={s.id || s.nbr}
              onClick={() => s.nbr && onOpenStop(s.nbr)}
              className="w-full flex items-start gap-3 p-3 hover:bg-slate-50 text-left"
            >
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={{ background: BUCKET_COLORS[s.bucket] + '22', color: BUCKET_COLORS[s.bucket] }}>
                  {s.routeSeq || i + 1}
                </div>
                {i < l.stops.length - 1 && <div className="w-px flex-1 bg-slate-200 mt-1 min-h-[20px]" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-slate-500">{s.nbr}</span>
                  <StatusPill status={s.status} size="xs" />
                  {s.type && <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{s.type}</span>}
                </div>
                <div className="text-sm font-medium truncate mt-0.5">{s.name || s.customerName || '—'}</div>
                <div className="text-[11px] text-slate-500 truncate flex items-center gap-2">
                  <span>{[s.city, s.state].filter(Boolean).join(', ') || '—'}</span>
                  {s.plannedEta && <span>· ETA {fmtTime(s.plannedEta)}</span>}
                  {/* Only show actual timestamps when we trust them.
                      NuVizz sometimes leaves stale arrivalDTTM values on stops the driver
                      hasn't actually visited yet. We trust:
                       - confirmed time on delivered stops (status 90) — that's the true delivery
                       - arrival on stop that has a confirmed time (driver was there even if delivery's edge-case)
                       - arrival on stop status 50 IFF the arrival is after the planned ETA
                         minus 2 hours (filters out NuVizz's garbage initialization timestamps
                         like 04:51 AM on a stop with 3:40 PM ETA) */}
                  {s.status === '90' && s.confirmed && (
                    <span>· delivered {fmtTime(s.confirmed)}</span>
                  )}
                  {s.status !== '90' && s.confirmed && (
                    <span>· arrived {fmtTime(s.confirmed)}</span>
                  )}
                  {s.status === '50' && !s.confirmed && s.arrival && s.plannedEta &&
                   (new Date(s.arrival).getTime() > new Date(s.plannedEta).getTime() - 2*60*60*1000) && (
                    <span>· arrived {fmtTime(s.arrival)}</span>
                  )}
                </div>
              </div>
              <ChevronRight size={14} className="text-slate-300 mt-1 flex-shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-white rounded-xl border p-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}
