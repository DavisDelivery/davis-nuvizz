// src/screens/StopsScreen.jsx — list every stop today with multi-filter

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Package, MapPin, User, ChevronRight, RefreshCw, Clock, AlertTriangle } from 'lucide-react';
import { fetchToday } from '../lib/api';
import { normalizeStop, fmtTime, BUCKET_COLORS, BUCKET_LABELS } from '../lib/normalize';
import { TENANTS } from '../lib/api';
import { Loading, ErrorBox, StatusPill, EmptyState } from '../components/UI';

export default function StopsScreen({ tenant, onOpenStop }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [search, setSearch] = useState('');
  const [bucket, setBucket] = useState('all');
  const [driver, setDriver] = useState('all');
  const [customer, setCustomer] = useState('all');

  const load = useCallback(async () => {
    setState({ loading: true, error: null, data: null });
    try {
      const data = await fetchToday(tenant);
      setState({ loading: false, error: null, data });
    } catch (e) { setState({ loading: false, error: e.message, data: null }); }
  }, [tenant]);

  useEffect(() => { load(); }, [load]);

  const stops = useMemo(() => (state.data?.stops || []).map(normalizeStop), [state.data]);

  const drivers = useMemo(() => Array.from(new Set(stops.map(s => s.driverName).filter(Boolean))).sort(), [stops]);
  const customers = useMemo(() => Array.from(new Set(stops.map(s => s.customerName).filter(Boolean))).sort(), [stops]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return stops.filter(s => {
      if (bucket !== 'all' && s.bucket !== bucket) return false;
      if (driver !== 'all' && s.driverName !== driver) return false;
      if (customer !== 'all' && s.customerName !== customer) return false;
      if (!q) return true;
      return [s.nbr, s.txnRef, s.name, s.customerName, s.city, s.zip, s.proNumber].filter(Boolean).some(x => x.toString().toLowerCase().includes(q));
    });
  }, [stops, search, bucket, driver, customer]);

  if (state.loading) return <Loading msg="Loading stops..." />;
  if (state.error) return <ErrorBox error={state.error} onRetry={load} />;

  return (
    <div className="p-4 space-y-3">
      {/* Search */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="PRO / stop nbr / address / customer..."
          className="w-full pl-9 pr-3 py-2.5 border rounded-lg text-sm bg-white"
        />
      </div>

      {/* Status bucket chips */}
      <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1">
        {[
          { k: 'all', l: `All (${stops.length})`, c: null },
          ...Object.entries(BUCKET_COLORS).map(([k, c]) => ({ k, l: `${BUCKET_LABELS[k]} (${stops.filter(s => s.bucket === k).length})`, c })),
        ].map(f => (
          <button
            key={f.k}
            onClick={() => setBucket(f.k)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap flex items-center gap-1.5 ${bucket === f.k ? 'bg-slate-900 text-white' : 'bg-white border text-slate-700'}`}
          >
            {f.c && <span className="w-2 h-2 rounded-full" style={{ background: f.c }} />}
            {f.l}
          </button>
        ))}
      </div>

      {/* Driver + customer filters */}
      <div className="grid grid-cols-2 gap-2">
        <select value={driver} onChange={e => setDriver(e.target.value)} className="px-2 py-2 border rounded-lg text-xs bg-white">
          <option value="all">All drivers ({drivers.length})</option>
          {drivers.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={customer} onChange={e => setCustomer(e.target.value)} className="px-2 py-2 border rounded-lg text-xs bg-white">
          <option value="all">All customers ({customers.length})</option>
          {customers.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Count + refresh */}
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{filtered.length} stop{filtered.length !== 1 ? 's' : ''}</span>
        <button onClick={load} className="flex items-center gap-1 text-blue-600"><RefreshCw size={10} /> Refresh</button>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <EmptyState icon={<Package size={32} className="text-slate-300" />} title="No stops match" hint={search ? `Nothing matches "${search}"` : 'Try changing filters.'} />
      ) : (
        <div className="bg-white rounded-xl border divide-y overflow-hidden">
          {filtered.map(s => (
            <button
              key={s.id || s.nbr}
              onClick={() => onOpenStop(s.nbr)}
              className="w-full flex items-start gap-3 p-3 hover:bg-slate-50 text-left"
            >
              <div className="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-xs flex-shrink-0" style={{ background: BUCKET_COLORS[s.bucket] + '22', color: BUCKET_COLORS[s.bucket] }}>
                {s.seq || s.type?.slice(0, 1) || '?'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-slate-500">{s.nbr}</span>
                  <StatusPill status={s.status} size="xs" />
                  {s.hasException && <AlertTriangle size={10} className="text-amber-500" />}
                </div>
                <div className="text-sm font-medium truncate mt-0.5">{s.name || s.customerName || '—'}</div>
                <div className="text-[11px] text-slate-500 truncate flex items-center gap-2">
                  <span><MapPin size={9} className="inline mr-0.5" />{[s.city, s.state].filter(Boolean).join(', ') || '—'}</span>
                  {s.driverName && <span>· <User size={9} className="inline mr-0.5" />{s.driverName}</span>}
                  {s.arrival && <span>· <Clock size={9} className="inline mr-0.5" />{fmtTime(s.arrival)}</span>}
                </div>
              </div>
              <ChevronRight size={14} className="text-slate-300 mt-1 flex-shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
