// src/components/StopIntel.jsx — presentational layer for Stops Intelligence (Part A)
//
// Renders the parsed output of parseStopComments() as muted chips, a legend, the
// soft receiving-hours window, the appointment-reality marker, and Non-Uline revenue.
// All parsing lives in src/lib/parseStopComments.ts — this file is display only.

import React from 'react';
import { Clock } from 'lucide-react';
import {
  parseStopComments,
  activeChips,
  STOP_CHIPS,
  fmtReceivingHours,
  isPlaceholderWindow,
  fmt12h,
} from '../lib/parseStopComments.ts';

// Parse a stop's carried comment strings into structured intelligence.
// Accepts the flat fleet-stop shape ({ comments: string[], sealNbr, apptFrom, apptTo })
// or a normalized stop ({ comments, sealNbr, plannedFrom, plannedTo }).
export function intelForStop(stop) {
  const parsed = parseStopComments(stop?.comments || []);
  const apptFrom = stop?.apptFrom ?? stop?.plannedFrom ?? null;
  const apptTo = stop?.apptTo ?? stop?.plannedTo ?? null;
  const placeholder = isPlaceholderWindow(apptFrom, apptTo);
  // Non-Uline revenue: the parsed TOTAL-AMOUNT wins; otherwise the SealNbr field
  // (relabeled "Non-Uline Rev") is the billed amount when it reads as currency.
  const sealNum = toAmount(stop?.sealNbr);
  const revenue = parsed.totalAmount != null ? parsed.totalAmount : sealNum;
  return { parsed, apptFrom, apptTo, placeholder, revenue, sealNum };
}

function toAmount(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isNaN(n) ? null : n;
}

export function fmtCurrency(n) {
  if (n == null) return null;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// A single muted chip.
function Chip({ label, color }) {
  return (
    <span
      className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded"
      style={{ background: color + '1a', color }}
    >
      {label}
    </span>
  );
}

// Row of chips for a parsed stop. Renders nothing when no flags are set.
export function StopChips({ parsed }) {
  const chips = activeChips(parsed);
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {chips.map((c) => (
        <Chip key={c.key} label={c.label} color={c.color} />
      ))}
    </div>
  );
}

// Soft receiving-hours window — shown as text with a subtle "soft" marker.
export function ReceivingHours({ parsed }) {
  const rh = parsed.receivingHours;
  if (!rh) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-amber-700">
      <Clock size={9} />
      {fmtReceivingHours(rh)}
      <span
        className="text-[8px] uppercase tracking-wide text-amber-500 border border-amber-200 rounded px-1 leading-none py-px"
        title={rh.confidence === 'low' ? 'Advisory window — low confidence parse' : 'Advisory window — never a hard gate'}
      >
        soft
      </span>
    </span>
  );
}

// Appointment window or the "no appt" marker for placeholder windows.
export function AppointmentReality({ apptFrom, apptTo, placeholder }) {
  if (placeholder) {
    return (
      <span className="text-[10px] text-slate-400 italic">no appt</span>
    );
  }
  return (
    <span className="text-[10px] text-slate-600">
      {fmt12h(norm(apptFrom))}–{fmt12h(norm(apptTo))}
    </span>
  );
}

function norm(t) {
  if (!t) return '00:00';
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '00:00';
}

// Right-aligned Non-Uline revenue value.
export function NonUlineRev({ revenue, fromAmount }) {
  if (revenue == null) return <span className="text-[11px] text-slate-300">—</span>;
  return (
    <span className="text-[11px] font-semibold tabular-nums text-emerald-700">
      {fmtCurrency(revenue)}
      {fromAmount && <span className="ml-0.5 text-[8px] text-slate-400 align-top">amt</span>}
    </span>
  );
}

// Legend explaining the chip catalog. Collapsed by default via <details>.
export function ChipLegend() {
  return (
    <details className="bg-white rounded-xl border px-3 py-2 text-[11px] text-slate-600">
      <summary className="cursor-pointer font-semibold text-slate-500 select-none">
        Chip legend
      </summary>
      <div className="flex flex-wrap gap-2 mt-2">
        {STOP_CHIPS.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1">
            <Chip label={c.label} color={c.color} />
          </span>
        ))}
        <span className="inline-flex items-center gap-1 text-amber-700">
          <Clock size={10} /> soft = advisory receiving window
        </span>
      </div>
    </details>
  );
}
