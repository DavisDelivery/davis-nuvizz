// src/screens/DriversScreen.jsx — Davis fleet dispatch board + driver search
//
// UNIFIED driver view: pick a driver by name, see their whole day across all loads.
// Data from __fleet endpoint (scans NuVizz load-number range for a date since there's
// no native list endpoint). Includes both dispatched (assigned) and registered drivers.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { User, Phone, RefreshCw, ChevronRight, Truck, Search, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { fetchFleet, fetchDriver, DAVIS_DRIVERS, TENANTS } from '../lib/api';
import { fmtTime } from '../lib/normalize';
import { Loading, ErrorBox, ProgressBar, EmptyState, SectionHeader } from '../components/UI';

const STATUS_LABEL = { '10': 'Created', '30': 'Scheduled', '40': 'In Transit', '50': 'Exception', '90': 'Delivered' };
const STATUS_COLOR = { '10': '#64748b', '30': '#64748b', '40': '#f59e0b', '50': '#ef4444', '90': '#10b981' };

export default function DriversScreen({ tenant, viewDate, onOpenLoad, onOpenStop }) {
  const [view, setView] = useState('fleet');
  const [search, setSearch] = useState('');
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [fleetState, setFleetState] = useState({ loading: true, error: null, data: null });
  const [driverState, setDriverState] = useState({ loading: false, error: null, data: null });
  const t = TENANTS[tenant];

  const loadFleet = useCallback(async () => {
    setFleetState({ loading: true, error: null, data: null });
    try {
      const data = await fetchFleet(tenant, viewDate);
      setFleetState({ loading: false, error: null, data });
    } catch (e) {
      setFleetState({ loading: false, error: e.message, data: null });
    }
  }, [tenant, viewDate]);

  const loadDriver = useCallback(async (userName) => {
    setDriverState({ loading: true, error: null, data: null });
    try {
      const data = await fetchDriver(tenant, userName, viewDate);
      setDriverState({ loading: false, error: null, data });
    } catch (e) {
      setDriverState({ loading: false, error: e.message, data: null });
    }
  }, [tenant, viewDate]);

  useEffect(() => {
    if (view === 'fleet') loadFleet();
  }, [view, loadFleet]);

  // Merge registry + live fleet data; filter by search
  const driverList = useMemo(() => {
    const byUser = {};
    for (const l of (fleetState.data?.loads || [])) {
      const key = l.driverUserName || l.driver;
      if (!key) continue;
      if (!byUser[key]) byUser[key] = { loads: [], totalStops: 0, delivered: 0, inProgress: 0 };
      byUser[key].loads.push(l);
      byUser[key].totalStops += l.totalStops;
      byUser[key].delivered += l.delivered;
      byUser[key].inProgress += l.inProgress;
    }

    const enabled = DAVIS_DRIVERS.filter(d => d.status === 'ENABLED');
    const list = enabled.map(d => {
      const live = byUser[d.userName] || byUser[d.name.toUpperCase()] || null;
      return {
        ...d,
        active: !!live,
        loads: live?.loads || [],
        totalStops: live?.totalStops || 0,
        delivered: live?.delivered || 0,
        inProgress: live?.inProgress || 0,
      };
    });

    // Include drivers discovered in fleet but not in registry
    for (const [un, info] of Object.entries(byUser)) {
      if (!enabled.find(d => d.userName === un) && info.loads[0]?.driver) {
        list.push({
          userName: un,
          name: info.loads[0].driver,
          status: 'ENABLED',
          active: true,
          loads: info.loads,
          totalStops: info.totalStops,
          delivered: info.delivered,
          inProgress: info.inProgress,
        });
      }
    }

    const q = search.trim().toUpperCase();
    const filtered = q
      ? list.filter(d => d.userName.includes(q) || d.name.toUpperCase().includes(q))
      : list;

    return filtered.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [fleetState.data, search]);

  const openDriver = (d) => {
    setSelectedDriver(d);
    setView('driver');
    loadDriver(d.userName);
  };

  if (view === 'driver' && selectedDriver) {
    return (
      <DriverDetailView
        driver={selectedDriver}
        state={driverState}
        tenant={tenant}
        onBack={() => { setView('fleet'); setSelectedDriver(null); }}
        onRefresh={() => loadDriver(selectedDriver.userName)}
        onOpenLoad={onOpenLoad}
        onOpenStop={onOpenStop}
      />
    );
  }

  const summary = fleetState.data?.summary;
  const activeCount = driverList.filter(d => d.active).length;

  return (
    <div className="p-4 space-y-3 pb-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Fleet · Drivers</div>
          <div className="text-lg font-bold">{new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</div>
        </div>
        <button onClick={loadFleet} disabled={fleetState.loading} className="p-2 rounded-lg hover:bg-slate-100 text-slate-600 disabled:opacity-50">
          <RefreshCw size={18} className={fleetState.loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {summary && (
        <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl p-4 text-white">
          <div className="text-[10px] uppercase tracking-wider opacity-70 font-semibold">Today's Fleet</div>
          <div className="grid grid-cols-4 gap-2 mt-2">
            <SummaryStat label="Loads" value={summary.totalLoads} sub={`${summary.assignedLoads} assigned`} />
            <SummaryStat label="Drivers" value={summary.uniqueDrivers} sub="on route" />
            <SummaryStat label="Stops" value={summary.totalStops} sub={`${summary.pctComplete}% done`} />
            <SummaryStat label="Issues" value={summary.totalExceptions} sub={summary.totalExceptions > 0 ? 'flagged' : 'none'} danger={summary.totalExceptions > 0} />
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl p-3 border">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5 flex items-center gap-1.5">
          <Search size={11} /> Find Driver
        </div>
        <input
          type="text"
          placeholder="Type a name (e.g. Jim, Pallette, Vincent)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2.5 border rounded-lg text-base"
        />
        <div className="text-[10px] text-slate-500 mt-1.5">
          {activeCount > 0
            ? `${activeCount} active · ${driverList.length} shown`
            : `${driverList.length} drivers`}
        </div>
      </div>

      {fleetState.loading && (
        <div className="bg-white rounded-xl p-4 border text-center">
          <RefreshCw size={24} className="mx-auto text-slate-400 animate-spin mb-2" />
          <div className="text-sm text-slate-600">Scanning NuVizz for today's loads...</div>
          <div className="text-[10px] text-slate-400 mt-1">Takes ~15 seconds (no list endpoint, probing ranges)</div>
        </div>
      )}
      {fleetState.error && <ErrorBox error={fleetState.error} onRetry={loadFleet} />}

      <div className="space-y-2">
        {driverList.map(d => (
          <DriverCard key={d.userName} driver={d} tenant={tenant} onClick={() => openDriver(d)} />
        ))}
      </div>

      {driverList.length === 0 && !fleetState.loading && (
        <EmptyState icon={<User size={32} className="text-slate-300" />} title="No matches" hint="Try a different search or clear the search." />
      )}
    </div>
  );
}

function SummaryStat({ label, value, sub, danger }) {
  return (
    <div className="text-left">
      <div className="text-[9px] uppercase tracking-wider opacity-70">{label}</div>
      <div className={`text-xl font-bold ${danger ? 'text-red-400' : ''}`}>{value}</div>
      <div className="text-[9px] opacity-60">{sub}</div>
    </div>
  );
}

function DriverCard({ driver: d, tenant, onClick }) {
  const t = TENANTS[tenant];
  return (
    <button onClick={onClick} className={`w-full bg-white rounded-xl border p-3 text-left hover:bg-slate-50 ${d.active ? '' : 'opacity-60'}`}>
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-white flex-shrink-0 text-sm"
          style={{ background: d.active ? t.color : '#cbd5e1' }}
        >
          {d.name.split(/\s+/).filter(Boolean).map(n => n[0]).slice(0, 2).join('')}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold text-sm truncate">{d.name}</div>
            {d.active && (
              <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                Active
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2">
            <span className="font-mono">{d.userName}</span>
            {d.active ? (
              <>
                <span>·</span>
                <span>{d.loads.length} load{d.loads.length !== 1 ? 's' : ''}</span>
                <span>·</span>
                <span>{d.totalStops} stop{d.totalStops !== 1 ? 's' : ''}</span>
              </>
            ) : (
              <>
                <span>·</span>
                <span>No load today</span>
              </>
            )}
          </div>

          {d.active && d.totalStops > 0 && (
            <>
              <div className="mt-2">
                <ProgressBar value={d.delivered} max={d.totalStops} color={t.color} height={4} />
              </div>
              <div className="flex gap-3 mt-1 text-[10px]">
                <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 size={10} /> {d.delivered}</span>
                {d.inProgress > 0 && <span className="flex items-center gap-1 text-amber-600"><Truck size={10} /> {d.inProgress}</span>}
                <span className="ml-auto text-slate-500">{Math.round((d.delivered / d.totalStops) * 100)}%</span>
              </div>
              {d.loads.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {d.loads.slice(0, 3).map(l => (
                    <span key={l.loadNbr} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 font-mono">
                      {l.route}
                    </span>
                  ))}
                  {d.loads.length > 3 && <span className="text-[10px] text-slate-500">+{d.loads.length - 3}</span>}
                </div>
              )}
            </>
          )}
        </div>
        <ChevronRight size={16} className="text-slate-300 mt-2 flex-shrink-0" />
      </div>
    </button>
  );
}

function DriverDetailView({ driver, state, tenant, onBack, onRefresh, onOpenLoad, onOpenStop }) {
  const t = TENANTS[tenant];

  return (
    <div className="p-4 space-y-4">
      <button onClick={onBack} className="text-sm text-blue-600 flex items-center gap-1">
        ← All Drivers
      </button>

      <div className="bg-white rounded-xl border p-4">
        <div className="flex items-start gap-3">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center font-bold text-white text-lg flex-shrink-0"
            style={{ background: t.color }}
          >
            {driver.name.split(/\s+/).filter(Boolean).map(n => n[0]).slice(0, 2).join('')}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-lg font-bold">{driver.name}</div>
            <div className="text-[11px] text-slate-500 font-mono">{driver.userName} · id {driver.userId}</div>
            {state.data?.driverProfile?.email && (
              <div className="text-[11px] text-slate-500">{state.data.driverProfile.email}</div>
            )}
          </div>
          <button onClick={onRefresh} disabled={state.loading} className="p-2 rounded-lg hover:bg-slate-100 text-slate-600 disabled:opacity-50">
            <RefreshCw size={16} className={state.loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {state.loading && (
        <div className="bg-white rounded-xl p-6 border text-center">
          <RefreshCw size={24} className="mx-auto text-slate-400 animate-spin mb-2" />
          <div className="text-sm text-slate-600">Loading {driver.name.split(' ')[0]}'s day...</div>
          <div className="text-[10px] text-slate-400 mt-1">Scanning fleet + fetching each load's stops</div>
        </div>
      )}
      {state.error && <ErrorBox error={state.error} onRetry={onRefresh} />}

      {state.data?.summary && (
        <div className="grid grid-cols-4 gap-2">
          <StatTile label="Stops" value={state.data.summary.totalStops} color="#1e5b92" />
          <StatTile label="Delivered" value={state.data.summary.delivered} color="#10b981" />
          <StatTile label="Active" value={state.data.summary.inProgress} color="#f59e0b" />
          <StatTile label="Issues" value={state.data.summary.exceptions} color="#ef4444" />
        </div>
      )}

      {state.data?.loads && state.data.loads.length > 0 && (
        <div>
          <SectionHeader title={`Loads (${state.data.loads.length})`} />
          <div className="space-y-2">
            {state.data.loads.map(l => (
              <button
                key={l.loadNbr}
                onClick={() => onOpenLoad(l.loadNbr)}
                className="w-full bg-white rounded-xl border p-3 text-left hover:bg-slate-50"
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <Truck size={14} className="text-slate-400" />
                    <span className="text-sm font-semibold">{l.route}</span>
                  </div>
                  <span className="text-xs font-bold" style={{ color: t.color }}>{l.pctComplete}%</span>
                </div>
                <div className="text-[11px] text-slate-500 font-mono mb-1.5">{l.loadNbr}</div>
                <ProgressBar value={l.delivered} max={l.totalStops} color={t.color} height={5} />
                <div className="flex gap-3 mt-1.5 text-[10px] text-slate-600">
                  <span>{l.delivered}/{l.totalStops} stops</span>
                  {l.inProgress > 0 && <span className="text-amber-600">{l.inProgress} active</span>}
                  {l.exceptions > 0 && <span className="text-red-600 flex items-center gap-0.5"><AlertTriangle size={9} /> {l.exceptions}</span>}
                  {l.vehicleType && <span className="ml-auto text-slate-400">{l.vehicleType}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {state.data?.stops && state.data.stops.length > 0 && (
        <div>
          <SectionHeader title={`All Stops Today (${state.data.stops.length})`} />
          <div className="bg-white rounded-xl border divide-y overflow-hidden">
            {state.data.stops.map((s, i) => (
              <button
                key={`${s.loadNbr}-${s.stopNbr}-${i}`}
                onClick={() => onOpenStop(s.stopNbr)}
                className="w-full p-3 flex items-start gap-3 hover:bg-slate-50 text-left"
              >
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                  style={{ background: STATUS_COLOR[s.status] || '#64748b' }}
                >
                  {s.displaySeq || s.stopSeq || i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: STATUS_COLOR[s.status] }}>
                      {STATUS_LABEL[s.status] || s.status}
                    </span>
                    <span className="font-mono text-[10px] text-slate-400">{s.stopNbr}</span>
                    {s.exceptionPresent && <AlertTriangle size={11} className="text-amber-500" />}
                  </div>
                  <div className="text-sm font-medium truncate">{s.name || '—'}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {[s.city, s.state].filter(Boolean).join(', ')}
                    {s.route && ` · ${s.route}`}
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
                <ChevronRight size={14} className="text-slate-300 mt-2 flex-shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {state.data && (!state.data.loads || state.data.loads.length === 0) && !state.loading && (
        <EmptyState
          icon={<User size={32} className="text-slate-300" />}
          title={`${driver.name.split(' ')[0]} isn't dispatched today`}
          hint="No loads assigned for this date."
        />
      )}
    </div>
  );
}

function StatTile({ label, value, color }) {
  return (
    <div className="bg-white rounded-xl border p-2.5 text-center">
      <div className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
      <div className="text-xl font-bold" style={{ color }}>{value}</div>
    </div>
  );
}
