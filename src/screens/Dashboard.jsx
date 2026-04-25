// src/screens/Dashboard.jsx — home screen
// NuVizz tenants (davis/uline): PRO lookup search + full fleet summary from __fleet.
// Glory Bound tenant: pulls today's manifest from Firestore via fetchToday.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Truck, AlertTriangle, RefreshCw, ChevronRight, Clock, MapPin, User, Package, CheckCircle2, XCircle, Search, Users, Calendar, ChevronLeft } from 'lucide-react';
import { fetchToday, fetchFleet, refreshFleet, normalizePro, TENANTS } from '../lib/api';
import { normalizeLoad, normalizeStop, fmtTime, fmtDate, BUCKET_COLORS } from '../lib/normalize';
import { KPI, Loading, ErrorBox, SectionHeader, ProgressBar, StatusPill, EmptyState } from '../components/UI';

export default function Dashboard({ tenant, viewDate, isToday, goToPrevBusinessDay, onOpenLoad, onOpenStop, onOpenMap, onOpenStops, onOpenLoads, onOpenDrivers }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [proInput, setProInput] = useState('');
  const [recentPros, setRecentPros] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('dn_recent_pros') || '[]');
      return Array.isArray(stored) ? stored.slice(0, 8) : [];
    } catch { return []; }
  });
  const t = TENANTS[tenant];
  const isNuvizz = tenant === 'davis' || tenant === 'uline';
  const dayLabel = new Date(viewDate + 'T00:00:00Z').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });

  const load = useCallback(async () => {
    setState({ loading: true, error: null, data: null });
    try {
      // NuVizz tenants get real fleet data via __fleet; Glory Bound still uses Firestore via fetchToday
      const data = isNuvizz ? await fetchFleet(tenant, viewDate) : await fetchToday(tenant);
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState({ loading: false, error: e.message, data: null });
    }
  }, [tenant, isNuvizz, viewDate]);

  // Hard refresh: trigger a fresh NuVizz scan + Firestore rewrite, then reload data.
  // Used by the explicit refresh button (vs `load` which just reads from cache).
  const hardRefresh = useCallback(async () => {
    if (!isNuvizz) return load(); // Glory Bound has no live scan, just re-fetch
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      await refreshFleet(tenant, viewDate); // ~10-12s — full scan + Firestore write
      const data = await fetchFleet(tenant, viewDate); // now reads from Firestore — fast
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState({ loading: false, error: e.message, data: null });
    }
  }, [tenant, isNuvizz, viewDate, load]);

  useEffect(() => { load(); }, [load]);

  const addRecent = (pro) => {
    const next = [pro, ...recentPros.filter(p => p !== pro)].slice(0, 8);
    setRecentPros(next);
    try { localStorage.setItem('dn_recent_pros', JSON.stringify(next)); } catch {}
  };

  const submitPro = () => {
    const pro = normalizePro(proInput);
    if (!pro) return;
    addRecent(pro);
    setProInput('');
    onOpenStop(pro);
  };

  const openRecent = (pro) => {
    addRecent(pro); // refresh to top
    onOpenStop(pro);
  };

  // Data shape: fetchFleet returns {loads, summary} with fleet-style fields;
  // fetchToday (Glory Bound) returns {stops, loads, summary} with old shape.
  const fleetData = isNuvizz ? state.data : null;
  const gloryData = !isNuvizz ? state.data : null;
  const summary = fleetData?.summary || gloryData?.summary || {};
  const fleetLoads = fleetData?.loads || [];
  const normalizedLoads = (gloryData?.loads || []).map(normalizeLoad);
  const normalizedStops = (gloryData?.stops || []).map(normalizeStop);
  const exceptions = normalizedStops.filter(s => s.bucket === 'failed' || s.bucket === 'cancelled' || s.etaCode === 'LATE' || s.hasException);

  // Fleet-tenant exception loads (for the "Issues" tile in NuVizz dashboards)
  const exceptionLoads = fleetLoads.filter(l => l.exceptions > 0);

  return (
    <div className="p-4 space-y-4 pb-4">
      {/* Header just shows "Today" or the date label — App owns the date picker */}
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
            {isToday ? 'Today' : 'Fleet Overview'}
          </div>
          <div className="text-lg font-bold truncate">{dayLabel}</div>
        </div>
        <button onClick={hardRefresh} disabled={state.loading} className="p-2 rounded-lg hover:bg-slate-100 text-slate-600 disabled:opacity-50" title="Refresh from NuVizz">
          <RefreshCw size={18} className={state.loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* PRO lookup bar — always visible, primary action for NuVizz tenants */}
      <div className="bg-white rounded-xl p-3 border">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5 flex items-center gap-1.5">
          <Search size={11} /> Lookup PRO / Stop
        </div>
        <div className="flex gap-2">
          <input
            type="tel"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder={isNuvizz ? 'PRO number (e.g. 7100000)' : 'Enter stop #'}
            value={proInput}
            onChange={(e) => setProInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitPro()}
            className="flex-1 px-3 py-2.5 border rounded-lg text-base font-mono"
            style={{ minWidth: 0 }}
          />
          <button
            onClick={submitPro}
            disabled={!normalizePro(proInput)}
            className="px-4 py-2.5 rounded-lg text-white font-semibold text-sm disabled:opacity-40 flex items-center gap-1 flex-shrink-0"
            style={{ background: t.color }}
          >
            <Search size={15} /> Look up
          </button>
        </div>
        {proInput && normalizePro(proInput) && normalizePro(proInput) !== proInput.trim() && (
          <div className="text-[10px] text-slate-500 mt-1.5 font-mono">
            → {normalizePro(proInput)} <span className="text-slate-400">(padded to 9 digits)</span>
          </div>
        )}
        {recentPros.length > 0 && (
          <div className="mt-3 pt-2.5 border-t">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">Recent</div>
            <div className="flex flex-wrap gap-1.5">
              {recentPros.map((p) => (
                <button
                  key={p}
                  onClick={() => openRecent(p)}
                  className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded-md text-[11px] font-mono"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Loading / error */}
      {state.loading && (
        <div className="bg-white rounded-xl p-4 border text-center">
          <RefreshCw size={24} className="mx-auto text-slate-400 animate-spin mb-2" />
          <div className="text-sm text-slate-600">
            {isNuvizz ? 'Scanning NuVizz for today\'s fleet...' : 'Loading today\'s dispatch...'}
          </div>
          {isNuvizz && <div className="text-[10px] text-slate-400 mt-1">~13s first load, then cached</div>}
        </div>
      )}
      {state.error && <ErrorBox error={state.error} onRetry={load} />}

      {/* NUVIZZ FLEET VIEW — tappable tiles */}
      {!state.loading && !state.error && isNuvizz && summary.totalLoads != null && summary.totalLoads > 0 && (
        <>
          <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl p-4 text-white">
            <div className="text-[10px] uppercase tracking-wider opacity-70 font-semibold">Today's Fleet</div>
            <div className="grid grid-cols-4 gap-2 mt-2">
              <TappableStat label="Loads" value={summary.totalLoads} sub={`${summary.assignedLoads} assigned`} onClick={() => onOpenLoads && onOpenLoads('active')} />
              <TappableStat label="Drivers" value={summary.uniqueDrivers} sub="on route" onClick={onOpenDrivers} />
              <TappableStat label="Stops" value={summary.totalStops} sub={`${summary.pctComplete}% done`} onClick={() => onOpenStops && onOpenStops('active')} />
              <TappableStat label="Issues" value={summary.totalExceptions} sub={summary.totalExceptions > 0 ? 'tap to triage' : 'none'} danger={summary.totalExceptions > 0} onClick={summary.totalExceptions > 0 ? () => onOpenStops && onOpenStops('exceptions') : undefined} />
            </div>
          </div>

          {/* Completion progress — tappable to show delivered stops; chips filter by status */}
          <button
            onClick={() => onOpenStops && onOpenStops('delivered')}
            className="w-full bg-white rounded-xl p-4 border text-left hover:bg-slate-50 active:scale-[0.99] transition"
          >
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="font-semibold text-slate-700 flex items-center gap-1.5">
                Day Progress
                <ChevronRight size={12} className="text-slate-400" />
              </span>
              <span className="text-slate-500">{summary.totalDelivered}/{summary.totalStops} stops</span>
            </div>
            <ProgressBar value={summary.totalDelivered} max={summary.totalStops} color="#10b981" height={10} />
            <div className="flex gap-1.5 mt-3 text-[11px]">
              <FilterChip
                count={summary.totalDelivered}
                label="Delivered"
                color="#10b981"
                onClick={(e) => { e.stopPropagation(); onOpenStops && onOpenStops('delivered'); }}
              />
              <FilterChip
                count={summary.totalInProgress}
                label="Active"
                color="#f59e0b"
                onClick={(e) => { e.stopPropagation(); onOpenStops && onOpenStops('inTransit'); }}
              />
              {summary.totalExceptions > 0 && (
                <FilterChip
                  count={summary.totalExceptions}
                  label="Issues"
                  color="#ef4444"
                  onClick={(e) => { e.stopPropagation(); onOpenStops && onOpenStops('exceptions'); }}
                />
              )}
            </div>
          </button>

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

          {/* Exception loads */}
          {exceptionLoads.length > 0 && (
            <div>
              <SectionHeader title={`Loads with Issues (${exceptionLoads.length})`} />
              <div className="bg-white rounded-xl border divide-y overflow-hidden">
                {exceptionLoads.slice(0, 5).map((l) => (
                  <button
                    key={l.loadNbr}
                    onClick={() => onOpenLoad(l.loadNbr)}
                    className="w-full p-3 flex items-start gap-3 hover:bg-slate-50 text-left"
                  >
                    <AlertTriangle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm truncate">{l.route}</span>
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full text-white bg-red-500">
                          {l.exceptions} {l.exceptions === 1 ? 'issue' : 'issues'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {l.driver || 'Unassigned'} · {l.delivered}/{l.totalStops} done
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-slate-300 mt-1 flex-shrink-0" />
                  </button>
                ))}
                {exceptionLoads.length > 5 && (
                  <button onClick={() => onOpenLoads && onOpenLoads('exception')} className="w-full p-2.5 text-center text-xs text-blue-600 hover:bg-slate-50">
                    See all {exceptionLoads.length} loads with issues →
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Drivers teaser */}
          <button onClick={onOpenDrivers} className="w-full bg-white rounded-xl border p-4 flex items-center justify-between hover:bg-slate-50">
            <div className="flex items-center gap-3">
              <Users size={22} className="text-slate-400" />
              <div className="text-left">
                <div className="font-semibold text-sm">Drivers</div>
                <div className="text-xs text-slate-500">{summary.uniqueDrivers} on route · find by name</div>
              </div>
            </div>
            <ChevronRight size={18} className="text-slate-300" />
          </button>
        </>
      )}

      {/* NuVizz: no loads today (common on Saturdays — Davis doesn't dispatch weekends) */}
      {!state.loading && !state.error && isNuvizz && summary.totalLoads === 0 && (
        <div className="bg-white rounded-xl border p-5 text-center">
          <Truck size={28} className="mx-auto text-slate-300 mb-2" />
          <div className="text-sm font-semibold text-slate-700 mb-1">No loads on {dayLabel.split(',')[0]}</div>
          <div className="text-xs text-slate-500 max-w-xs mx-auto leading-relaxed mb-3">
            Davis typically doesn't run routes on Saturdays and Sundays. Use the date arrows above to check another day, or look up a specific PRO.
          </div>
          <div className="flex gap-2 justify-center flex-wrap">
            <button
              onClick={goToPrevBusinessDay}
              className="px-3 py-1.5 bg-slate-800 text-white rounded-lg text-xs font-semibold"
            >
              ← Previous business day
            </button>
          </div>
        </div>
      )}

      {/* GLORY BOUND VIEW — existing KPI + exceptions + loads (unchanged) */}
      {!state.loading && !state.error && !isNuvizz && summary.totalStops > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <KPI label="Stops" value={summary.totalStops || 0} sub={`${summary.pctComplete || 0}% complete`} accent={t.color} onClick={() => onOpenStops && onOpenStops()} />
            <KPI label="Loads" value={summary.totalLoads || 0} sub={`${normalizedLoads.filter(l => l.bucket === 'inProgress').length} active`} accent={t.color} />
            <KPI label="Miles" value={summary.totalMiles || 0} sub="planned today" />
            <KPI label="Avg Dwell" value={`${summary.avgDwellMin || 0}m`} sub="per stop" />
          </div>

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
                    </div>
                    <ChevronRight size={16} className="text-slate-300 mt-1 flex-shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <SectionHeader title={`Active Loads (${normalizedLoads.length})`} />
            <div className="space-y-2">
              {normalizedLoads.map((l) => (
                <LoadCard key={l.nbr} load={l} tenant={tenant} onClick={() => onOpenLoad(l.nbr)} />
              ))}
            </div>
          </div>
        </>
      )}

      {/* Empty state for Glory Bound with no data */}
      {!state.loading && !state.error && !isNuvizz && !(summary.totalStops > 0) && (
        <EmptyState icon={<Truck size={32} className="text-slate-300" />} title="No stops today" hint="Nothing has been dispatched yet today." />
      )}
    </div>
  );
}

function TappableStat({ label, value, sub, danger, onClick }) {
  const clickable = !!onClick;
  return (
    <button
      onClick={onClick}
      disabled={!clickable}
      className={`text-left ${clickable ? 'active:scale-95 transition' : 'cursor-default'}`}
    >
      <div className="text-[9px] uppercase tracking-wider opacity-70">{label}</div>
      <div className={`text-xl font-bold ${danger ? 'text-red-400' : ''}`}>{value ?? 0}</div>
      <div className="text-[9px] opacity-60">{sub}</div>
    </button>
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

// Tappable variant — pill-shaped, used in Day Progress card so user can jump
// straight to Stops tab pre-filtered to that status
function FilterChip({ count, label, color, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-1 rounded-full hover:bg-slate-100 active:bg-slate-200 transition"
    >
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      <span className="text-slate-700 font-medium">{count} {label}</span>
    </button>
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
