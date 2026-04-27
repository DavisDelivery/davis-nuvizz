// src/screens/StopDetail.jsx — detail view for a single stop
//
// Uses __lookup endpoint which returns stop+load+stopsAway in one call.
// Falls back to fetchStop for Glory Bound tenant (no lookup path available there).
// Per NuVizz guide: uses confirmedDTTM as the real delivery time (NOT createdDTTM
// on docs, which reflects BOL generation 1-3 days before delivery).

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, MapPin, User, Clock, Package, Phone, FileText, AlertTriangle, Truck, ChevronRight, Image as ImageIcon, Download } from 'lucide-react';
import { lookupPro, fetchStop, fetchStopETA, fetchStopEvents, fetchDoc } from '../lib/api';
import { normalizeStop, fmtTime, fmtDateTime, stripLeadingZeros, BUCKET_COLORS } from '../lib/normalize';
import { TENANTS } from '../lib/api';
import { Loading, ErrorBox, StatusPill, Field, SectionHeader } from '../components/UI';

// NuVizz status codes (from integration guide)
const STATUS_LABELS = {
  '10': 'Created',
  '30': 'Scheduled',
  '40': 'Out for Delivery',
  '50': 'Exception',
  '90': 'Delivered',
};

// Format ETA as 1-hour window per guide's recommendation (NuVizz ETAs are often optimistic)
function fmtEtaWindow(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    const start = new Date(d);
    start.setMinutes(0, 0, 0);
    const end = new Date(start);
    end.setHours(start.getHours() + 1);
    const fmt = (t) => t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${fmt(start)} – ${fmt(end)}`;
  } catch { return null; }
}

export default function StopDetail({ tenant, stopNbr, onOpenLoad }) {
  const [state, setState] = useState({ loading: true, error: null, stop: null, load: null, stopsAway: null, raw: null });
  const [docs, setDocs] = useState({}); // { guid: { loading, dataUri, error } }
  const t = TENANTS[tenant];
  const isNuvizz = tenant === 'davis' || tenant === 'uline';

  const load = useCallback(async () => {
    setState({ loading: true, error: null, stop: null, load: null, stopsAway: null, raw: null });
    try {
      if (isNuvizz) {
        const data = await lookupPro(tenant, stopNbr, { includeLoad: true });
        setState({
          loading: false,
          error: null,
          stop: normalizeStop(data.stop),
          load: data.load || null,
          stopsAway: data.stopsAway,
          raw: data,
        });
      } else {
        // Glory Bound path — use raw fetchStop
        const stopData = await fetchStop(tenant, stopNbr, t.companyCode);
        setState({
          loading: false,
          error: null,
          stop: normalizeStop(stopData?.Stop || stopData),
          load: null,
          stopsAway: null,
          raw: stopData,
        });
      }
    } catch (e) {
      setState({ loading: false, error: e.message, stop: null, load: null, stopsAway: null, raw: null });
    }
  }, [tenant, stopNbr, isNuvizz, t.companyCode]);

  useEffect(() => { load(); }, [load]);

  // Load a document (dual-credential fallback happens server-side)
  const loadDoc = useCallback(async (guid, ext) => {
    if (docs[guid]) return; // already loading/loaded
    setDocs((d) => ({ ...d, [guid]: { loading: true } }));
    try {
      const result = await fetchDoc(tenant, guid, ext);
      setDocs((d) => ({ ...d, [guid]: { loading: false, ...result } }));
    } catch (e) {
      setDocs((d) => ({ ...d, [guid]: { loading: false, error: e.message } }));
    }
  }, [tenant, docs]);

  if (state.loading) return <Loading msg={`Looking up ${stopNbr}...`} />;
  if (state.error && !state.stop) return <ErrorBox error={state.error} onRetry={load} />;

  const s = state.stop;
  if (!s) return <ErrorBox error="Stop not found" onRetry={load} />;

  // Extract documents from the raw NuVizz response
  // They live at: raw.stop.to.documents, raw.stop.stopExecutionInfo.to.podDoc
  const rawStop = state.raw?.stop?.stop || state.raw?.Stop?.stop || {};
  const rawExec = state.raw?.stop?.stopExecutionInfo || state.raw?.Stop?.stopExecutionInfo || {};
  const toDocs = rawStop?.to?.documents || [];
  const podDocs = rawExec?.to?.podDoc || [];
  const allDocs = [
    ...podDocs.map(d => ({ ...d, kind: 'POD' })),
    ...toDocs.filter(td => !podDocs.some(pd => pd.documentGuid === td.documentGuid)).map(d => ({ ...d, kind: 'Doc' })),
  ];

  // Status — NuVizz quirk: stopStatus=50 doesn't always mean "exception."
  // It can also mean "needs attention" (e.g. driver took photo but didn't tap Complete).
  // Look at exceptions[] / exceptionPresent — if both are empty, it's not really an
  // exception, it's just incomplete paperwork. Show clearer language to dispatchers.
  const statusCode = rawExec?.stopStatus;
  const realExceptionsArr = rawExec?.exceptions || [];
  const realExceptionPresent = !!rawExec?.exceptionPresent;
  const hasArrival = !!rawExec?.to?.arrivalDTTM;
  const hasPodPhoto = !!(rawExec?.to?.podDoc?.length);
  const isUnconfirmed = statusCode === '50' && !realExceptionPresent && realExceptionsArr.length === 0;

  // Override the label and color when we detect "unconfirmed delivery" vs "real exception"
  let statusLabel = STATUS_LABELS[statusCode] || s.status;
  let statusColor = '#64748b';
  if (statusCode === '90') {
    statusColor = '#10b981';
  } else if (statusCode === '50') {
    if (isUnconfirmed && hasArrival) {
      statusLabel = hasPodPhoto ? 'Photo · Not Closed' : 'Arrived · Not Closed';
      statusColor = '#f59e0b'; // amber, not red — this isn't a real problem
    } else if (realExceptionsArr.length > 0 || realExceptionPresent) {
      statusLabel = 'Exception';
      statusColor = '#ef4444';
    } else {
      statusLabel = 'Needs Attention';
      statusColor = '#f59e0b';
    }
  } else if (statusCode === '40') {
    statusColor = '#f59e0b';
  }

  // confirmedDTTM from the guide is the real delivery time
  const confirmedDTTM = rawExec?.to?.confirmedDTTM;
  const receiveDTTM = rawExec?.receiveDTTM;
  const etaWindow = fmtEtaWindow(s.actualEta || s.plannedEta);

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
            {rawStop.bol && (
              <div className="text-xs text-slate-500 mt-0.5">
                BOL: <span className="font-mono">{rawStop.bol}</span>
              </div>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{statusCode}</div>
            <div className="text-sm font-bold" style={{ color: statusColor }}>{statusLabel}</div>
          </div>
        </div>

        {/* Stops-away (if on route) */}
        {state.stopsAway != null && state.stopsAway > 0 && (
          <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm flex items-center gap-2">
            <Truck size={14} className="text-amber-600" />
            <span><strong>{state.stopsAway}</strong> stop{state.stopsAway === 1 ? '' : 's'} away</span>
          </div>
        )}
        {state.stopsAway === 0 && statusCode !== '90' && (
          <div className="mt-3 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-sm flex items-center gap-2">
            <Truck size={14} className="text-green-600" />
            <span className="font-semibold">Next stop</span>
          </div>
        )}

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

        <button onClick={load} className="mt-3 text-xs text-blue-600 flex items-center gap-1"><RefreshCw size={12} /> Refresh</button>
      </div>

      {/* Timing card — uses confirmedDTTM per guide */}
      {(confirmedDTTM || s.plannedEta || s.arrival || s.departure) && (
        <div className="bg-white rounded-xl border p-4">
          <SectionHeader title="Timing" />
          <div className="grid grid-cols-2 gap-3">
            {confirmedDTTM && <Field label="Delivered" value={fmtDateTime(confirmedDTTM)} />}
            {!confirmedDTTM && etaWindow && <Field label="ETA Window" value={etaWindow} />}
            {s.arrival && <Field label="Arrived" value={fmtTime(s.arrival)} />}
            {s.departure && <Field label="Departed" value={fmtTime(s.departure)} />}
            {receiveDTTM && !confirmedDTTM && <Field label="System Received" value={fmtDateTime(receiveDTTM)} />}
            {s.dwellMin != null && <Field label="Dwell" value={`${s.dwellMin}m`} />}
            {s.plannedEta && confirmedDTTM && <Field label="Planned ETA" value={fmtTime(s.plannedEta)} />}
          </div>
        </div>
      )}

      {/* Freight counts */}
      {(s.cartons != null || s.pallets != null || s.weight != null || rawStop.stopDetails?.length) && (
        <div className="bg-white rounded-xl border p-4">
          <SectionHeader title="Freight" />
          <div className="grid grid-cols-3 gap-3">
            {s.cartons != null && <Field label="Cartons" value={s.cartons} />}
            {s.pallets != null && <Field label="Pallets" value={s.pallets} />}
            {s.weight != null && <Field label="Weight" value={`${s.weight} ${s.weightUOM || 'lbs'}`} />}
            {s.sealNbr && <Field label="Seal" value={s.sealNbr} mono />}
            {s.shipmentNbr && <Field label="Shipment" value={s.shipmentNbr} mono />}
          </div>
          {rawStop.stopDetails?.length > 0 && (
            <div className="mt-3 pt-3 border-t space-y-1">
              {rawStop.stopDetails.map((d, i) => (
                <div key={i} className="text-xs text-slate-600 flex justify-between gap-2">
                  <span className="truncate flex-1">{d.product}</span>
                  <span className="flex-shrink-0 font-mono">{d.quantity} {d.quantityUOM}</span>
                </div>
              ))}
            </div>
          )}
          {rawStop.stopAccessorials?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {rawStop.stopAccessorials.map((a, i) => (
                <span key={i} className="px-2 py-0.5 bg-blue-50 text-blue-800 rounded text-[11px] font-medium" title={a.code}>
                  {a.comments || a.code}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Documents (photos, PODs, signatures) */}
      {allDocs.length > 0 && (
        <div className="bg-white rounded-xl border p-4">
          <SectionHeader title={`Documents (${allDocs.length})`} />
          <div className="space-y-2">
            {allDocs.map((d, i) => {
              const guid = d.documentGuid;
              const ext = (d.documentExtType || d.extension || 'jpg').toLowerCase();
              const name = d.documentName || `Document ${i + 1}`;
              const isPdf = ext === 'pdf';
              const docState = docs[guid] || {};
              return (
                <div key={guid || i} className="border rounded-lg overflow-hidden">
                  <div className="p-2.5 bg-slate-50 flex items-center gap-2 text-sm">
                    {isPdf ? <FileText size={14} className="text-red-500" /> : <ImageIcon size={14} className="text-blue-500" />}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{name}</div>
                      <div className="text-[10px] text-slate-500">
                        {d.kind} · {ext.toUpperCase()} {d.createdTime || d.createdDTTM ? `· ${fmtDateTime(d.createdTime || d.createdDTTM)}` : ''}
                      </div>
                    </div>
                    {!docState.dataUri && !docState.loading && (
                      <button onClick={() => loadDoc(guid, ext)} className="px-2.5 py-1.5 bg-blue-600 text-white rounded text-xs font-semibold">
                        View
                      </button>
                    )}
                    {docState.loading && <RefreshCw size={14} className="animate-spin text-slate-400" />}
                  </div>
                  {docState.error && (
                    <div className="p-2 text-xs text-red-700 bg-red-50">{docState.error}</div>
                  )}
                  {docState.dataUri && (
                    <div className="p-2">
                      {isPdf ? (
                        <a href={docState.dataUri} download={`${name}.pdf`} className="flex items-center gap-2 text-blue-600 text-sm font-semibold p-3 border rounded">
                          <Download size={14} /> Download PDF
                        </a>
                      ) : (
                        <img src={docState.dataUri} alt={name} className="w-full rounded" />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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
    </div>
  );
}
