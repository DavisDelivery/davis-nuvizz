// src/screens/StopDetail.jsx — detail view for a single stop

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, MapPin, User, Clock, Package, Phone, FileText, AlertTriangle, Truck, ChevronRight } from 'lucide-react';
import { fetchStop, fetchStopETA, fetchStopEvents } from '../lib/api';
import { normalizeStop, fmtTime, fmtDateTime, stripLeadingZeros, BUCKET_COLORS } from '../lib/normalize';
import { TENANTS } from '../lib/api';
import { Loading, ErrorBox, StatusPill, Field, SectionHeader } from '../components/UI';

export default function StopDetail({ tenant, stopNbr, onOpenLoad }) {
  const [state, setState] = useState({ loading: true, error: null, stop: null, eta: null, events: null });
  const t = TENANTS[tenant];

  const load = useCallback(async () => {
    setState({ loading: true, error: null, stop: null, eta: null, events: null });
    try {
      const [stopR, etaR, evR] = await Promise.allSettled([
        fetchStop(tenant, stopNbr, t.companyCode),
        fetchStopETA(tenant, stopNbr, t.companyCode),
        fetchStopEvents(tenant, stopNbr, t.companyCode),
      ]);
      setState({
        loading: false,
        error: stopR.status === 'rejected' ? stopR.reason?.message : null,
        stop: stopR.status === 'fulfilled' ? normalizeStop(stopR.value?.Stop || stopR.value) : null,
        eta: etaR.status === 'fulfilled' ? etaR.value : null,
        events: evR.status === 'fulfilled' ? evR.value : null,
      });
    } catch (e) { setState({ loading: false, error: e.message, stop: null, eta: null, events: null }); }
  }, [tenant, stopNbr, t.companyCode]);

  useEffect(() => { load(); }, [load]);

  if (state.loading) return <Loading msg={`Loading ${stopNbr}...`} />;
  if (state.error && !state.stop) return <ErrorBox error={state.error} onRetry={load} />;

  const s = state.stop;
  if (!s) return <ErrorBox error="Stop not found" onRetry={load} />;

  const etaInfo = state.eta?.etaInfo?.deliveryETA || state.eta?.etaInfo?.pickupETA || state.eta?.etaInfo;
  const events = state.events?.events || state.events?.eventList || [];

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="bg-white rounded-xl border p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              Stop
              {s.type && <span className="px-1.5 py-0.5 bg-slate-100 rounded normal-case">{s.type === 'PU' ? 'Pickup' : s.type === 'DO' ? 'Delivery' : s.type}</span>}
              {s.seq && <span>· #{s.seq}</span>}
            </div>
            <div className="text-xl font-bold font-mono break-all">{s.nbr}</div>
            {s.txnRef && (
              <div className="text-xs text-slate-500 mt-0.5">
                PRO: <span className="font-mono">{s.txnRef}</span>
                <span className="text-slate-400 ml-1">/ <span className="font-mono">{stripLeadingZeros(s.txnRef)}</span></span>
              </div>
            )}
          </div>
          <StatusPill status={s.status} />
        </div>

        {/* Address */}
        <div className="mt-4 flex items-start gap-2">
          <MapPin size={16} className="text-slate-400 mt-0.5 flex-shrink-0" />
          <div className="text-sm flex-1 min-w-0">
            <div className="font-semibold">{s.name || '—'}</div>
            <div className="text-slate-600">
              {s.addr1}{s.addr2 ? `, ${s.addr2}` : ''}<br/>
              {[s.city, s.state, s.zip].filter(Boolean).join(', ')}
            </div>
            {s.addr1 && (
              <div className="flex gap-3 mt-1 text-xs">
                <a href={`https://maps.apple.com/?q=${encodeURIComponent(s.fullAddress)}`} className="text-blue-600">Apple Maps →</a>
                <a href={`https://www.google.com/maps?q=${encodeURIComponent(s.fullAddress)}`} className="text-blue-600">Google →</a>
              </div>
            )}
          </div>
        </div>

        {/* Contact */}
        {(s.contactName || s.phone) && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <Phone size={14} className="text-slate-400" />
            <span>{s.contactName || '—'}</span>
            {s.phone && <a href={`tel:${s.phone}`} className="text-blue-600 ml-auto font-medium">{s.phone}</a>}
          </div>
        )}

        {/* Window */}
        {(s.plannedFrom || s.plannedTo) && (
          <div className="mt-2 flex items-center gap-2 text-sm">
            <Clock size={14} className="text-slate-400" />
            <span>Window: {fmtTime(s.plannedFrom)} – {fmtTime(s.plannedTo)}</span>
          </div>
        )}

        <button onClick={load} className="mt-3 text-xs text-blue-600 flex items-center gap-1"><RefreshCw size={12} /> Refresh</button>
      </div>

      {/* ETA card */}
      {(s.plannedEta || s.arrival || s.departure) && (
        <div className="bg-white rounded-xl border p-4">
          <SectionHeader title="Timing" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Planned ETA" value={fmtTime(s.plannedEta)} />
            <Field label="Actual ETA" value={fmtTime(s.actualEta)} />
            <Field label="Arrived" value={fmtTime(s.arrival)} />
            <Field label="Departed" value={fmtTime(s.departure)} />
            {s.dwellMin != null && <Field label="Dwell" value={`${s.dwellMin}m`} />}
            {s.etaCode && <Field label="ETA Status" value={s.etaCode} />}
          </div>
        </div>
      )}

      {/* Freight counts */}
      {(s.cartons || s.pallets || s.weight) && (
        <div className="bg-white rounded-xl border p-4">
          <SectionHeader title="Freight" />
          <div className="grid grid-cols-3 gap-3">
            {s.cartons != null && <Field label="Cartons" value={s.cartons} />}
            {s.pallets != null && <Field label="Pallets" value={s.pallets} />}
            {s.weight != null && <Field label="Weight" value={`${s.weight} ${s.weightUOM || 'lbs'}`} />}
            {s.sealNbr && <Field label="Seal" value={s.sealNbr} mono />}
            {s.shipmentNbr && <Field label="Shipment" value={s.shipmentNbr} mono />}
          </div>
        </div>
      )}

      {/* Load reference */}
      {s.loadNbr && (
        <button onClick={() => onOpenLoad(s.loadNbr)} className="w-full bg-white rounded-xl border p-3 flex items-center gap-3 hover:bg-slate-50">
          <Truck size={18} className="text-slate-400" />
          <div className="flex-1 text-left">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">On Load</div>
            <div className="text-sm font-mono font-semibold">{s.loadNbr}</div>
            {s.driverName && <div className="text-xs text-slate-500">{s.driverName}</div>}
          </div>
          <ChevronRight size={16} className="text-slate-300" />
        </button>
      )}

      {/* Exceptions */}
      {s.exceptions && s.exceptions.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <SectionHeader title={`Exceptions (${s.exceptions.length})`} />
          <div className="space-y-2">
            {s.exceptions.map((e, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <AlertTriangle size={14} className="text-amber-600 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium">{e.exceptionDesc || e.exceptionCode}</div>
                  {e.exceptionComment && <div className="text-xs text-slate-600">{e.exceptionComment}</div>}
                  {e.addedOn && <div className="text-[10px] text-slate-500 mt-0.5">{fmtDateTime(e.addedOn)}{e.addedByName ? ` · ${e.addedByName}` : ''}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Events timeline */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-slate-50">
          <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Activity ({events.length})</div>
        </div>
        {events.length === 0 ? (
          <div className="p-4 text-sm text-slate-500">No activity yet.</div>
        ) : (
          <div className="divide-y">
            {events.map((e, i) => (
              <div key={i} className="p-3 flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5" />
                  {i < events.length - 1 && <div className="w-px flex-1 bg-slate-200 mt-1 min-h-[20px]" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{e.eventType || e.eventCode || 'Event'}</div>
                  <div className="text-xs text-slate-500">{fmtDateTime(e.eventDTTM || e.timestamp)}</div>
                  {(e.comments || e.note) && <div className="text-xs mt-1 text-slate-700">{e.comments || e.note}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
