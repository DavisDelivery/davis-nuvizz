// src/App.jsx — main shell & routing

import React, { useState, useEffect } from 'react';
import { Home, MapPin, Truck, Package, Users, ArrowLeft, Wifi, WifiOff, RefreshCw, ChevronLeft, ChevronRight, Calendar, Calculator } from 'lucide-react';
import { TENANTS, fetchHealth } from './lib/api';
import { todayInET } from './lib/date-util';
import { TenantSwitch, TabBtn } from './components/UI';

import Dashboard from './screens/Dashboard';
import MapScreen from './screens/MapScreen';
import LoadsScreen from './screens/LoadsScreen';
import StopsScreen from './screens/StopsScreen';
import DriversScreen from './screens/DriversScreen';
import LoadDetail from './screens/LoadDetail';
import StopDetail from './screens/StopDetail';
import QuoteScreen from './screens/QuoteScreen';

const APP_VERSION = '1.5.6';
// Injected by vite.config.js — bumps every build so the running app can prove which deploy is live.
// eslint-disable-next-line no-undef
const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
// eslint-disable-next-line no-undef
const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
const BUILD_STAMP = BUILD_TIME ? BUILD_TIME.slice(5, 16).replace('T', ' ') : '';

// Date helpers. "Today" is anchored on the America/New_York calendar day via
// todayInET() (matches dispatch-map and the ET-anchored board), so the app
// never jumps a day ahead overnight. The string-math helpers below operate on
// a fixed "YYYY-MM-DD" anchored at UTC midnight, which is timezone-stable for
// pure day arithmetic on an already-chosen date.
function ymd(d) { return d.toISOString().slice(0, 10); }
function parseYmd(s) { return new Date(s + 'T00:00:00Z'); }
function addDays(d, n) { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; }
function isWeekend(d) { const day = d.getUTCDay(); return day === 0 || day === 6; }

export default function App() {
  const [tenant, setTenantState] = useState(() => {
    try { return localStorage.getItem('dn_tenant') || 'davis'; } catch { return 'davis'; }
  });
  const setTenant = (t) => {
    setTenantState(t);
    try { localStorage.setItem('dn_tenant', t); } catch {}
  };
  const [tab, setTab] = useState('dashboard');
  const [tabFilter, setTabFilter] = useState(null); // {tab: 'stops', filter: 'exceptions'} etc
  const [detail, setDetail] = useState(null);
  const [quotePrefill, setQuotePrefill] = useState(null); // {zip,weight,skids,loose} seeded from a selected stop
  const [health, setHealth] = useState('checking');
  const [online, setOnline] = useState(navigator.onLine);

  // Shared date state — used across all tabs so clicking around doesn't reset
  const [viewDate, setViewDate] = useState(() => todayInET());
  const isToday = viewDate === todayInET();

  const shiftDate = (days) => {
    setViewDate(ymd(addDays(parseYmd(viewDate), days)));
  };
  const goToToday = () => setViewDate(todayInET());
  const goToPrevBusinessDay = () => {
    let d = addDays(parseYmd(viewDate), -1);
    while (isWeekend(d)) d = addDays(d, -1);
    setViewDate(ymd(d));
  };

  const goToTab = (targetTab, filter = null) => {
    setTab(targetTab);
    setTabFilter(filter ? { tab: targetTab, filter } : null);
  };

  // Open the Quote tab, optionally seeded from a selected stop's freight.
  const goToQuote = (prefill = null) => {
    setQuotePrefill(prefill);
    setDetail(null);
    setTab('quote');
  };

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(e => setHealth({ davis: { ok: false, error: e.message }, uline: { ok: false, error: e.message } }));
  }, []);

  const t = TENANTS[tenant];

  const openLoad = (nbr) => setDetail({ type: 'load', id: nbr });
  const openStop = (nbr) => setDetail({ type: 'stop', id: nbr });
  const closeDetail = () => setDetail(null);

  const titleText = () => {
    if (detail) return detail.type === 'load' ? `Load ${detail.id}` : `Stop ${detail.id}`;
    switch (tab) {
      case 'dashboard': return `${t.label} · Today`;
      case 'map': return 'Map';
      case 'loads': return 'Loads';
      case 'stops': return 'Stops';
      case 'drivers': return 'Drivers';
      case 'quote': return 'Quote';
      default: return t.label;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b bg-white/95 backdrop-blur" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            {detail ? (
              <button onClick={closeDetail} className="p-1 -ml-1 rounded hover:bg-slate-100 flex-shrink-0">
                <ArrowLeft size={22} />
              </button>
            ) : (
              <div className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold text-sm flex-shrink-0" style={{ background: t.color }}>
                {t.label.slice(0, 1)}
              </div>
            )}
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 leading-none font-semibold">Davis NuVizz</div>
              <div className="text-base font-bold leading-tight truncate">{titleText()}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {online ? <Wifi size={14} className="text-emerald-600" /> : <WifiOff size={14} className="text-red-500" />}
            <TenantSwitch tenant={tenant} onChange={(tnt) => { setTenant(tnt); setDetail(null); }} />
          </div>
        </div>
      </header>

      {/* Date bar — sticky, visible on all tabs, hidden when drilling into detail */}
      {!detail && tenant !== 'glorybound' && (
        <div className="sticky z-30 bg-white border-b" style={{ top: 'calc(env(safe-area-inset-top) + 52px)' }}>
          <div className="flex items-center justify-between px-3 py-2 gap-2">
            <button
              onClick={() => shiftDate(-1)}
              className="p-2 rounded-lg hover:bg-slate-100 active:bg-slate-200 text-slate-600 flex-shrink-0"
              aria-label="Previous day"
            >
              <ChevronLeft size={20} />
            </button>
            <div className="flex-1 flex items-center justify-center gap-2 min-w-0">
              <Calendar size={14} className="text-slate-400 flex-shrink-0" />
              <div className="text-center min-w-0">
                <div className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold leading-none">
                  {isToday ? 'Today' : isWeekend(parseYmd(viewDate)) ? 'Weekend' : 'Viewing'}
                </div>
                <div className="text-sm font-bold leading-tight">
                  {parseYmd(viewDate).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}
                </div>
              </div>
              {!isToday && (
                <button
                  onClick={goToToday}
                  className="text-[10px] font-semibold text-blue-600 px-2 py-1 rounded hover:bg-blue-50 flex-shrink-0"
                >
                  Today
                </button>
              )}
            </div>
            <button
              onClick={() => shiftDate(1)}
              className="p-2 rounded-lg hover:bg-slate-100 active:bg-slate-200 text-slate-600 flex-shrink-0"
              aria-label="Next day"
            >
              <ChevronRight size={20} />
            </button>
          </div>
        </div>
      )}

      {/* Health banner — only relevant for NuVizz tenants */}
      {health === 'checking' && tenant !== 'glorybound' && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs text-amber-800 flex items-center gap-2">
          <RefreshCw size={12} className="animate-spin" /> Verifying NuVizz API credentials...
        </div>
      )}
      {health && health !== 'checking' && tenant !== 'glorybound' && !health[tenant]?.ok && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2 text-xs text-red-800">
          <div className="font-semibold">Auth failed for {t.label}</div>
          <div className="mt-0.5 break-words">{(health[tenant]?.error || '').slice(0, 250)}</div>
          <div className="mt-1 text-red-600">Check Netlify env: NUVIZZ_{tenant.toUpperCase()}_USER / _PASS / _COMPANY_CODE</div>
        </div>
      )}

      {/* Content */}
      <main className={`flex-1 overflow-y-auto ${tab === 'map' && !detail ? '' : 'pb-20'}`} style={{ WebkitOverflowScrolling: 'touch' }}>
        {detail ? (
          detail.type === 'load' ? (
            <LoadDetail tenant={tenant} loadNbr={detail.id} onOpenStop={openStop} />
          ) : (
            <StopDetail tenant={tenant} stopNbr={detail.id} onOpenLoad={openLoad} onQuote={goToQuote} />
          )
        ) : tab === 'dashboard' ? (
          <Dashboard
            tenant={tenant}
            viewDate={viewDate}
            isToday={isToday}
            goToPrevBusinessDay={goToPrevBusinessDay}
            onOpenLoad={openLoad}
            onOpenStop={openStop}
            onOpenMap={() => setTab('map')}
            onOpenStops={(filter) => goToTab('stops', filter)}
            onOpenLoads={(filter) => goToTab('loads', filter)}
            onOpenDrivers={() => setTab('drivers')}
          />
        ) : tab === 'map' ? (
          <MapScreen tenant={tenant} viewDate={viewDate} onOpenStop={openStop} onOpenLoad={openLoad} />
        ) : tab === 'loads' ? (
          <LoadsScreen tenant={tenant} viewDate={viewDate} onOpenLoad={openLoad} initialFilter={tabFilter?.tab === 'loads' ? tabFilter.filter : null} />
        ) : tab === 'stops' ? (
          <StopsScreen tenant={tenant} viewDate={viewDate} onOpenStop={openStop} initialFilter={tabFilter?.tab === 'stops' ? tabFilter.filter : null} />
        ) : tab === 'quote' ? (
          <QuoteScreen prefill={quotePrefill} />
        ) : (
          <DriversScreen tenant={tenant} viewDate={viewDate} onOpenLoad={openLoad} onOpenStop={openStop} />
        )}
      </main>

      {/* Bottom nav */}
      {!detail && (
        <nav className="fixed bottom-0 inset-x-0 z-40 bg-white border-t grid grid-cols-6">
          <TabBtn active={tab === 'dashboard'} icon={<Home size={20} />} label="Home" onClick={() => setTab('dashboard')} color={t.color} />
          <TabBtn active={tab === 'map'} icon={<MapPin size={20} />} label="Map" onClick={() => setTab('map')} color={t.color} />
          <TabBtn active={tab === 'loads'} icon={<Truck size={20} />} label="Loads" onClick={() => setTab('loads')} color={t.color} />
          <TabBtn active={tab === 'stops'} icon={<Package size={20} />} label="Stops" onClick={() => setTab('stops')} color={t.color} />
          <TabBtn active={tab === 'drivers'} icon={<Users size={20} />} label="Drivers" onClick={() => setTab('drivers')} color={t.color} />
          <TabBtn active={tab === 'quote'} icon={<Calculator size={20} />} label="Quote" onClick={() => goToQuote()} color={t.color} />
        </nav>
      )}

      {/* Version footer — APP_VERSION + per-deploy stamp so you can tell if the latest deploy is live */}
      <div className="fixed bottom-[70px] right-2 text-[9px] text-slate-400 pointer-events-none text-right leading-tight">
        <div>v{APP_VERSION} · {BUILD_COMMIT}</div>
        {BUILD_STAMP && <div className="text-[8px] opacity-70">{BUILD_STAMP}Z</div>}
      </div>
    </div>
  );
}
