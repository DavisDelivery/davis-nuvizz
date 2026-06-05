// src/components/UI.jsx — shared presentational components

import React, { useState } from 'react';
import { AlertCircle, RefreshCw, Building2, ChevronDown } from 'lucide-react';
import { BUCKET_COLORS, BUCKET_LABELS, statusBucket } from '../lib/normalize';
import { TENANTS } from '../lib/api';

export function StatusPill({ status, bucket: bucketProp, size = 'sm' }) {
  // Callers can pass an explicit `bucket` (e.g. a load status derived from its stops) or a
  // raw `status` code/string that we bucket here. Explicit bucket wins.
  const bucket = bucketProp || (status != null ? statusBucket(status) : null);
  if (!bucket) return null;
  const color = BUCKET_COLORS[bucket];
  const label = BUCKET_LABELS[bucket];
  const pad = size === 'xs' ? 'text-[9px] px-1.5 py-0.5' : 'text-[10px] px-2 py-0.5';
  return (
    <span
      className={`${pad} rounded-full font-semibold uppercase tracking-wide whitespace-nowrap`}
      style={{ backgroundColor: color + '22', color }}
    >
      {label}
    </span>
  );
}

export function KPI({ label, value, sub, accent, onClick }) {
  const clickable = !!onClick;
  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-xl p-3 border ${clickable ? 'active:scale-95 cursor-pointer' : ''} transition`}
    >
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
      <div className="text-2xl font-bold mt-0.5" style={{ color: accent || '#0f172a' }}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export function ProgressBar({ value, max, color = '#10b981', height = 6 }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="w-full bg-slate-100 rounded-full overflow-hidden" style={{ height }}>
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function Loading({ msg, inline }) {
  if (inline) {
    return (
      <div className="flex items-center gap-2 text-slate-500 text-xs py-2">
        <RefreshCw size={12} className="animate-spin" /> {msg}
      </div>
    );
  }
  return (
    <div className="p-8 flex flex-col items-center justify-center text-slate-500 gap-2">
      <RefreshCw size={24} className="animate-spin" />
      <div className="text-sm">{msg}</div>
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  return (
    <div className="p-4">
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm">
        <div className="flex items-start gap-2">
          <AlertCircle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-red-900">Request failed</div>
            <div className="text-red-800 text-xs mt-1 break-words">{error}</div>
            {onRetry && <button onClick={onRetry} className="mt-2 text-xs text-red-700 underline">Retry</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, hint }) {
  return (
    <div className="p-8 flex flex-col items-center justify-center text-center gap-2 text-slate-500">
      {icon}
      <div className="text-sm font-medium text-slate-700">{title}</div>
      {hint && <div className="text-xs text-slate-500 max-w-xs">{hint}</div>}
    </div>
  );
}

export function TenantSwitch({ tenant, onChange }) {
  const [open, setOpen] = useState(false);
  const t = TENANTS[tenant];
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-medium">
        <Building2 size={14} /> {t.label} <ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border py-1 min-w-[160px] z-40">
            {Object.entries(TENANTS).map(([key, tnt]) => (
              <button key={key} onClick={() => { onChange(key); setOpen(false); }} className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 ${tenant === key ? 'font-semibold' : ''}`}>
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: tnt.color }} />
                {tnt.label}
                <span className="ml-auto text-[10px] text-slate-400">{tnt.companyCode}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function TabBtn({ active, icon, label, onClick, color }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-0.5 py-2.5 transition" style={{ color: active ? color : '#64748b' }}>
      {icon}
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

export function Field({ label, value, mono }) {
  return (
    <div>
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-medium truncate ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</div>
    </div>
  );
}

export function SectionHeader({ title, action }) {
  return (
    <div className="flex items-center justify-between px-1 mb-2">
      <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide">{title}</div>
      {action}
    </div>
  );
}
