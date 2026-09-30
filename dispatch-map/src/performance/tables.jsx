// src/performance/tables.jsx — the Performance screen's raw rows: the Days table and the Routes
// table on a desktop, and the same rows as cards on a phone (two views, never one layout patched
// to fit both — CLAUDE.md).
//
// The rows arrive already searched, sorted and cut to a page (src/lib/stop-pace.js); this file
// draws them. Every number is monospace and right-aligned so a column reads down; every blank is
// an em dash, never a 0.
import React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, EyeOff, Eye, Layers, Copy, Truck, Search } from 'lucide-react';
import { fmtClock, fmtCount, fmtShare, fmtPctChange, fmtPoints } from '../lib/stop-pace.js';
import { RowMenu, Skeleton, Delta } from './controls.jsx';

export const DAY_COLUMNS = [
  { key: 'date', label: 'Day', align: 'left', sortKey: 'date' },
  { key: 'planned', label: 'Planned', title: 'Planned stops on the board, cancelled orders left out — the 6:30 report’s denominator' },
  { key: 'delivered', label: 'Delivered', title: 'Scanned (90) and closed by hand (91)' },
  { key: 'completionRate', label: 'Done', title: 'Delivered out of planned' },
  { key: 'vsLastWeek', label: 'vs last wk', title: 'Delivered against the same weekday a week earlier' },
  { key: 'manual', label: 'By hand', title: 'Closed by hand in the portal (91) — a scanning signal, not a delivery one' },
  { key: 'unable', label: 'Unable', title: 'Unable to deliver (80)' },
  { key: 'open', label: 'Open', title: 'Planned and not finished when the day was sealed — or, today, not finished yet' },
  { key: 'firstMin', label: 'First', title: 'First delivery of the day' },
  { key: 'halfMin', label: 'Half done', title: 'By when half of the day’s timed deliveries were done' },
  { key: 'lastMin', label: 'Last', title: 'Last delivery of the day' },
];

export const ROUTE_COLUMNS = [
  { key: 'route', label: 'Route', align: 'left' },
  { key: 'driver', label: 'Driver', align: 'left' },
  { key: 'planned', label: 'Stops', title: 'Planned on this route, cancelled orders left out' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'open', label: 'Open' },
  { key: 'unable', label: 'Unable' },
  { key: 'share', label: 'Done', title: 'Delivered out of the route’s stops' },
  { key: 'vsFleet', label: 'vs fleet', title: 'The route’s share done against the whole board’s, in points' },
  { key: 'firstMin', label: 'First' },
  { key: 'lastMin', label: 'Last' },
  { key: 'perHour', label: 'Per hour', title: 'Deliveries an hour between the route’s first and last delivery — the drive out and back is not in it' },
];

function SortHeader({ col, sort, onSort }) {
  const on = sort.key === col.key;
  const Icon = !on ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`sticky top-0 z-10 whitespace-nowrap border-b border-zinc-800 bg-zinc-900 px-2.5 py-0 font-medium ${col.align === 'left' ? 'text-left' : 'text-right'}`}>
      <button type="button" onClick={() => onSort(col.key)} title={col.title}
        className={`inline-flex h-8 items-center gap-1 text-xs transition-colors ${on ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'} ${col.align === 'left' ? '' : 'flex-row-reverse'}`}>
        {col.label}
        <Icon size={12} className={on ? 'text-zinc-300' : 'text-zinc-600'} aria-hidden="true" />
      </button>
    </th>
  );
}

const cell = 'whitespace-nowrap px-2.5 py-1.5 text-right font-mono tabular-nums';

function SkeletonRows({ cols, rows = 8 }) {
  return Array.from({ length: rows }, (_, i) => (
    <tr key={`sk-${i}`} className="border-b border-zinc-800/70">
      {Array.from({ length: cols }, (__, j) => (
        <td key={j} className="px-2.5 py-2.5"><Skeleton className={`h-3 ${j === 1 ? 'w-24' : 'ml-auto w-10'}`} /></td>
      ))}
    </tr>
  ));
}

function EmptyRow({ cols, text, onReset }) {
  return (
    <tr>
      <td colSpan={cols} className="px-4 py-12 text-center">
        <Search size={18} className="mx-auto text-zinc-600" aria-hidden="true" />
        <p className="mt-2 text-sm text-zinc-300">{text}</p>
        {onReset ? <button type="button" onClick={onReset} className="mt-2 text-xs font-medium text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-zinc-100">Clear the search and filters</button> : null}
      </td>
    </tr>
  );
}

/**
 * THE DAYS TABLE. A checkbox selects a day for the pace chart (two at most are drawn — see
 * theme.js for why two) or for the bulk actions above the table; the row menu leaves a day out of
 * the typical day (a holiday, a snow day) or puts it back, and opens its routes.
 */
export function DaysTable({ rows, sort, onSort, selected, onToggle, onToggleAll, loading, dimmed, onAction, emptyText, onReset, footer }) {
  const pageIds = rows.map((r) => r.id);
  const allOn = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOn = pageIds.some((id) => selected.has(id));
  const cols = DAY_COLUMNS.length + 2;
  return (
    <div className={`transition-opacity duration-300 ${dimmed ? 'opacity-60' : 'opacity-100'}`}>
      <div className="max-h-[640px] overflow-auto">
        <table className="w-full min-w-[980px] border-separate border-spacing-0 text-[13px]">
          <caption className="sr-only">Delivered stops by day</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky top-0 z-10 w-10 border-b border-zinc-800 bg-zinc-900 px-1.5 text-left">
                {/* The LABEL is the target, not the 14px box: 32px wide here, and index.css makes it
                    44px tall on a finger — verify-tablet-layout measures it on four iPads. */}
                <label className="inline-flex h-8 w-8 cursor-pointer items-center justify-center">
                  <input type="checkbox" checked={allOn} ref={(el) => { if (el) el.indeterminate = !allOn && someOn; }}
                    onChange={() => onToggleAll(pageIds, !allOn)} aria-label="Select every day on this page"
                    className="h-3.5 w-3.5 cursor-pointer accent-indigo-400" />
                </label>
              </th>
              {DAY_COLUMNS.map((c) => <SortHeader key={c.key} col={c} sort={sort} onSort={onSort} />)}
              <th scope="col" className="sticky top-0 z-10 w-10 border-b border-zinc-800 bg-zinc-900"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="text-zinc-200">
            {loading && !rows.length ? <SkeletonRows cols={cols} /> : null}
            {!loading && !rows.length ? <EmptyRow cols={cols} text={emptyText} onReset={onReset} /> : null}
            {rows.map((r) => {
              const on = selected.has(r.id);
              return (
                <tr key={r.id} className={`group border-b border-zinc-800/70 transition-colors ${on ? 'bg-indigo-400/[0.06]' : 'hover:bg-zinc-800/40'}`}>
                  <td className={`border-b border-zinc-800/70 px-1.5 ${r.live ? 'shadow-[inset_2px_0_0_0_#9085e9]' : ''}`}>
                    <label className="inline-flex h-7 w-8 cursor-pointer items-center justify-center">
                      <input type="checkbox" checked={on} onChange={() => onToggle(r.id)} aria-label={`Select ${r.label}`}
                        className="h-3.5 w-3.5 cursor-pointer accent-indigo-400" />
                    </label>
                  </td>
                  <td className="whitespace-nowrap border-b border-zinc-800/70 px-2.5 py-1.5 text-left">
                    <span className="font-medium text-zinc-100">{r.label}</span>
                    {r.live ? <span className="ml-2 rounded border border-indigo-400/40 px-1.5 py-px text-[10.5px] font-medium text-indigo-200">so far</span> : null}
                    {r.leftOut ? <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-zinc-400" title="Left out of the typical day"><EyeOff size={11} aria-hidden="true" />left out</span> : null}
                  </td>
                  <td className={`${cell} border-b border-zinc-800/70 text-zinc-400`}>{fmtCount(r.planned)}</td>
                  <td className={`${cell} border-b border-zinc-800/70 font-semibold text-zinc-100`}>{fmtCount(r.delivered)}</td>
                  <td className={`${cell} border-b border-zinc-800/70`}>{fmtShare(r.completionRate)}</td>
                  <td className={`${cell} border-b border-zinc-800/70`}>
                    <Delta text={r.vsLastWeek == null ? null : fmtPctChange(r.vsLastWeek)} tone={r.vsLastWeek == null ? 'neutral' : r.vsLastWeek >= 0 ? 'good' : 'bad'} up={r.vsLastWeek == null ? null : r.vsLastWeek >= 0} />
                  </td>
                  <td className={`${cell} border-b border-zinc-800/70 text-zinc-400`}>{fmtCount(r.manual)}</td>
                  <td className={`${cell} border-b border-zinc-800/70 ${r.unable ? 'text-rose-300' : 'text-zinc-400'}`}>{fmtCount(r.unable)}</td>
                  <td className={`${cell} border-b border-zinc-800/70 text-zinc-400`}>{fmtCount(r.open)}</td>
                  <td className={`${cell} border-b border-zinc-800/70 text-zinc-400`}>{fmtClock(r.firstMin)}</td>
                  <td className={`${cell} border-b border-zinc-800/70`}>{fmtClock(r.halfMin)}</td>
                  <td className={`${cell} border-b border-zinc-800/70 text-zinc-400`}>{fmtClock(r.lastMin)}</td>
                  <td className="border-b border-zinc-800/70 px-1.5 text-right">
                    <RowMenu label={`Actions for ${r.label}`} items={dayActions(r, onAction, on)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}

export function dayActions(r, onAction, selected) {
  return [
    { id: 'overlay', label: selected ? 'Take off the pace chart' : 'Draw on the pace chart', icon: <Layers size={14} />, onSelect: () => onAction('toggle-select', r) },
    { id: 'routes', label: 'Show this day’s routes', icon: <Truck size={14} />, onSelect: () => onAction('routes', r) },
    r.live
      ? { id: 'leave', label: 'Today is never in the typical day', icon: <EyeOff size={14} />, disabled: true, onSelect: () => {} }
      : r.leftOut
        ? { id: 'putback', label: 'Put back in the typical day', icon: <Eye size={14} />, onSelect: () => onAction('put-back', r) }
        : { id: 'leave', label: 'Leave out of the typical day', icon: <EyeOff size={14} />, onSelect: () => onAction('leave-out', r) },
    { id: 'copy', label: 'Copy this row', icon: <Copy size={14} />, onSelect: () => onAction('copy', r) },
  ];
}

/**
 * THE ROUTES TABLE for one day. Sorted by share done, lowest first, by default: the route at 20%
 * when the fleet is at 60% is the phone call, and it should be the first row, not the fortieth.
 */
export function RoutesTable({ rows, sort, onSort, loading, dimmed, onAction, emptyText, onReset, footer }) {
  const cols = ROUTE_COLUMNS.length + 1;
  return (
    <div className={`transition-opacity duration-300 ${dimmed ? 'opacity-60' : 'opacity-100'}`}>
      <div className="max-h-[640px] overflow-auto">
        <table className="w-full min-w-[980px] border-separate border-spacing-0 text-[13px]">
          <caption className="sr-only">Routes for the selected day</caption>
          <thead>
            <tr>
              {ROUTE_COLUMNS.map((c) => <SortHeader key={c.key} col={c} sort={sort} onSort={onSort} />)}
              <th scope="col" className="sticky top-0 z-10 w-10 border-b border-zinc-800 bg-zinc-900"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="text-zinc-200">
            {loading && !rows.length ? <SkeletonRows cols={cols} /> : null}
            {!loading && !rows.length ? <EmptyRow cols={cols} text={emptyText} onReset={onReset} /> : null}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-zinc-800/70 transition-colors hover:bg-zinc-800/40">
                <td className="whitespace-nowrap border-b border-zinc-800/70 px-2.5 py-1.5 font-medium text-zinc-100">{r.route}</td>
                <td className="max-w-[200px] truncate border-b border-zinc-800/70 px-2.5 py-1.5 text-zinc-300">{r.driver || <span className="text-zinc-500">no driver</span>}</td>
                <td className={`${cell} border-b border-zinc-800/70 text-zinc-400`}>{fmtCount(r.planned)}</td>
                <td className={`${cell} border-b border-zinc-800/70 font-semibold text-zinc-100`}>{fmtCount(r.delivered)}</td>
                <td className={`${cell} border-b border-zinc-800/70 text-zinc-400`}>{fmtCount(r.open)}</td>
                <td className={`${cell} border-b border-zinc-800/70 ${r.unable ? 'text-rose-300' : 'text-zinc-400'}`}>{fmtCount(r.unable)}</td>
                <td className={`${cell} border-b border-zinc-800/70`}>
                  <span className="inline-flex items-center gap-2">
                    <span className="relative hidden h-1.5 w-14 overflow-hidden rounded-full bg-zinc-800 xl:inline-block" aria-hidden="true">
                      <span className="absolute inset-y-0 left-0 rounded-full bg-zinc-400" style={{ width: `${Math.round((r.share || 0) * 100)}%` }} />
                    </span>
                    {fmtShare(r.share)}
                  </span>
                </td>
                <td className={`${cell} border-b border-zinc-800/70`}>
                  <Delta text={r.vsFleet == null ? null : fmtPoints(r.vsFleet, 0)} tone={r.vsFleet == null ? 'neutral' : r.vsFleet >= 0 ? 'good' : 'bad'} up={r.vsFleet == null ? null : r.vsFleet >= 0} />
                </td>
                <td className={`${cell} border-b border-zinc-800/70 text-zinc-400`}>{fmtClock(r.firstMin)}</td>
                <td className={`${cell} border-b border-zinc-800/70 text-zinc-400`}>{fmtClock(r.lastMin)}</td>
                <td className={`${cell} border-b border-zinc-800/70`}>{r.perHour != null ? r.perHour.toFixed(1) : '—'}</td>
                <td className="border-b border-zinc-800/70 px-1.5 text-right">
                  <RowMenu label={`Actions for ${r.route}`} items={routeActions(r, onAction)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}

export function routeActions(r, onAction) {
  return [
    { id: 'driver', label: r.driver ? `Show only ${r.driver}` : 'Show only this route', icon: <Search size={14} />, onSelect: () => onAction('search', r) },
    { id: 'copy', label: 'Copy this row', icon: <Copy size={14} />, onSelect: () => onAction('copy', r) },
  ];
}

// ── the phone's cards ─────────────────────────────────────────────────────────

/** One day, as a card. The checkbox and the menu are full 44px targets; the numbers stay dense. */
export function DayCard({ r, selected, onToggle, onAction }) {
  return (
    <li className={`rounded-lg border ${r.live ? 'border-indigo-400/40' : 'border-zinc-800'} ${selected ? 'bg-indigo-400/[0.06]' : 'bg-zinc-900'} p-3`}>
      <div className="flex items-center gap-2">
        <label className="-ml-1 inline-flex h-11 w-11 shrink-0 items-center justify-center">
          <input type="checkbox" checked={selected} onChange={() => onToggle(r.id)} aria-label={`Select ${r.label}`} className="h-4 w-4 accent-indigo-400" />
        </label>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[15px] font-semibold text-zinc-100">{r.label}</span>
            {r.live ? <span className="rounded border border-indigo-400/40 px-1.5 py-px text-[10.5px] font-medium text-indigo-200">so far</span> : null}
            {r.leftOut ? <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400"><EyeOff size={11} aria-hidden="true" />left out</span> : null}
          </div>
          <div className="mt-0.5 font-mono text-xs tabular-nums text-zinc-400">
            first {fmtClock(r.firstMin)} · half {fmtClock(r.halfMin)} · last {fmtClock(r.lastMin)}
          </div>
        </div>
        <RowMenuPhone label={`Actions for ${r.label}`} items={dayActions(r, onAction, selected)} />
      </div>
      <dl className="mt-2 grid grid-cols-4 gap-2 text-right">
        <Stat label="Delivered" value={fmtCount(r.delivered)} strong />
        <Stat label="Planned" value={fmtCount(r.planned)} />
        <Stat label="Done" value={fmtShare(r.completionRate)} />
        <Stat label="vs last wk" value={r.vsLastWeek == null ? '—' : fmtPctChange(r.vsLastWeek)} tone={r.vsLastWeek == null ? null : r.vsLastWeek >= 0 ? 'good' : 'bad'} />
      </dl>
      {(r.unable || r.open || r.manual) ? (
        <p className="mt-1.5 font-mono text-xs tabular-nums text-zinc-400">
          {fmtCount(r.open)} open · <span className={r.unable ? 'text-rose-300' : ''}>{fmtCount(r.unable)} unable</span> · {fmtCount(r.manual)} by hand
        </p>
      ) : null}
    </li>
  );
}

export function RouteCard({ r, onAction }) {
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-zinc-100">{r.route}</div>
          <div className="truncate text-xs text-zinc-400">{r.driver || 'no driver'}</div>
        </div>
        <RowMenuPhone label={`Actions for ${r.route}`} items={routeActions(r, onAction)} />
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800" aria-hidden="true">
        <div className="h-full rounded-full bg-zinc-400" style={{ width: `${Math.round((r.share || 0) * 100)}%` }} />
      </div>
      <dl className="mt-2 grid grid-cols-4 gap-2 text-right">
        <Stat label="Delivered" value={`${fmtCount(r.delivered)}/${fmtCount(r.planned)}`} strong />
        <Stat label="Done" value={fmtShare(r.share)} />
        <Stat label="vs fleet" value={r.vsFleet == null ? '—' : fmtPoints(r.vsFleet, 0).replace(' pts', '')} tone={r.vsFleet == null ? null : r.vsFleet >= 0 ? 'good' : 'bad'} />
        <Stat label="Per hour" value={r.perHour != null ? r.perHour.toFixed(1) : '—'} />
      </dl>
      <p className="mt-1.5 font-mono text-xs tabular-nums text-zinc-400">first {fmtClock(r.firstMin)} · last {fmtClock(r.lastMin)} · {fmtCount(r.open)} open{r.unable ? ` · ${fmtCount(r.unable)} unable` : ''}</p>
    </li>
  );
}

function Stat({ label, value, strong = false, tone = null }) {
  const color = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-amber-300' : strong ? 'text-zinc-50' : 'text-zinc-200';
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] text-zinc-400">{label}</dt>
      <dd className={`truncate font-mono text-sm tabular-nums ${strong ? 'font-semibold' : ''} ${color}`}>{value}</dd>
    </div>
  );
}

/** The phone's row menu: the same portaled menu, behind a full 44px button. */
function RowMenuPhone({ label, items }) {
  return (
    <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center">
      <RowMenu label={label} items={items} />
    </span>
  );
}
