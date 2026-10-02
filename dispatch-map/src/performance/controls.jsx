// src/performance/controls.jsx — the Performance screen's controls: the date range, the facets,
// the segmented toggles, the row menu, the pager, the tiles and the loading shapes.
//
// Standard UI, built from ordinary buttons and inputs, so the app's touch floor applies to every
// one of them untouched: on a coarse pointer index.css lifts every button, menu item, select and
// input to 44px, and nothing here opts out (no .tap-dense) — a dense desktop row is dense under a
// mouse and fingertip-sized on Chad's iPad, which verify-tablet-layout measures.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  CalendarRange, Check, ChevronDown, ChevronLeft, ChevronRight, Clock, Info, Minus, MoreHorizontal, Search,
  SlidersHorizontal, TrendingDown, TrendingUp, X, EyeOff, RotateCcw, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { RANGE_PRESETS, rangeLabel, dayLabel, WEEKDAY_SHORT, PACE_STATUS_LABEL } from '../lib/stop-pace.js';

/** True one frame after mount — the switch every enter transition here hangs off. */
export function useEntered() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return on;
}

/** Close a popover on a press outside it or on Escape. */
function useDismiss(open, ref, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open, ref, onClose]);
}

// ── buttons ───────────────────────────────────────────────────────────────────

export function ToolbarButton({ children, active = false, className = '', ...rest }) {
  return (
    <button
      type="button"
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none
        ${active ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-100'}
        disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Two or three mutually exclusive choices. aria-pressed on each, so the state is read out. */
export function Segmented({ value, options, onChange, label, size = 'sm', className = '' }) {
  return (
    <div role="group" aria-label={label} className={`inline-flex items-center rounded-md border border-zinc-800 bg-zinc-900 p-0.5 ${className}`}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={`${size === 'lg' ? 'h-9 px-3.5 text-sm' : 'h-7 px-2.5 text-[12.5px]'} inline-flex items-center justify-center rounded-[5px] font-medium transition-colors duration-150 motion-reduce:transition-none
              ${on ? 'bg-zinc-700/80 text-zinc-50 shadow-sm shadow-black/30' : 'text-zinc-400 hover:text-zinc-100'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The search box. The clear button sits BESIDE the input inside one bordered frame rather than
 * on top of it: two controls on the same pixels is the defect verify-mobile-layout exists to
 * catch, and a clear button laid over the input's padding is exactly that.
 */
export function SearchField({ value, onChange, placeholder = 'Search', className = '', inputRef = null, hint = null }) {
  return (
    <div className={`flex min-h-[32px] items-center rounded-md border border-zinc-800 bg-zinc-900 transition-colors focus-within:border-zinc-600 ${className}`}>
      <Search size={14} className="ml-2.5 shrink-0 text-zinc-500" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange(''); } }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 min-w-0 flex-1 bg-transparent px-2 text-[13px] text-zinc-100 placeholder:text-zinc-500 outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search"
          className="mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
          <X size={13} />
        </button>
      ) : hint ? (
        <kbd className="mr-2 hidden shrink-0 rounded border border-zinc-700 px-1.5 font-mono text-[11px] leading-5 text-zinc-400 lg:inline-block" aria-hidden="true">{hint}</kbd>
      ) : null}
    </div>
  );
}

// ── the date range ────────────────────────────────────────────────────────────

/**
 * PRESETS AS ROWS, CUSTOM BEHIND A HAIRLINE. Nobody fights a calendar grid for "last 30 days";
 * the selected row carries a bold check; the two custom boxes are the browser's own date inputs.
 * `inline` renders the list in flow (the phone) instead of as a dropdown (the desktop): on a
 * phone, overlay furniture lives in one flow container, and what is below it MOVES.
 */
export function DateRangePicker({ selection, range, today, onChange, inline = false, open, onOpenChange }) {
  const ref = useRef(null);
  const [from, setFrom] = useState(selection?.custom?.from || range?.from || '');
  const [to, setTo] = useState(selection?.custom?.to || range?.to || '');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useDismiss(open && !inline, ref, close);
  useEffect(() => { if (open) { setFrom(range?.from || ''); setTo(range?.to || ''); } }, [open, range?.from, range?.to]);
  const current = RANGE_PRESETS.find((p) => p.id === selection?.id);
  const buttonText = current ? current.label : 'Custom range';

  const panel = (
    <DatePanel
      selection={selection} today={today} from={from} to={to} setFrom={setFrom} setTo={setTo}
      onPick={(sel) => { onChange(sel); onOpenChange(false); }} inline={inline}
    />
  );

  if (inline) return open ? panel : null;
  return (
    <div className="relative" ref={ref}>
      <ToolbarButton active={open} aria-haspopup="dialog" aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <CalendarRange size={14} className="text-zinc-400" aria-hidden="true" />
        <span className="text-zinc-100">{buttonText}</span>
        <span className="hidden font-mono text-[12px] text-zinc-400 lg:inline">{rangeLabel(range?.from, range?.to)}</span>
        <ChevronDown size={13} className={`text-zinc-500 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </ToolbarButton>
      {open && <div className="absolute left-0 top-full z-40 mt-1.5">{panel}</div>}
    </div>
  );
}

function DatePanel({ selection, today, from, to, setFrom, setTo, onPick, inline }) {
  const entered = useEntered();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
  return (
    <div
      role="dialog"
      aria-label="Date range"
      className={`${inline ? 'w-full' : 'w-[300px] shadow-xl shadow-black/50'} rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 transition duration-150 motion-reduce:transition-none
        ${entered ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'}`}
    >
      <ul>
        {RANGE_PRESETS.map((p) => {
          const on = selection?.id === p.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick({ id: p.id, custom: selection?.custom || {} })}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-zinc-200 transition-colors hover:bg-zinc-800/70"
              >
                <span className="inline-flex w-4 justify-center" aria-hidden="true">{on ? <Check size={16} strokeWidth={3} className="text-zinc-100" /> : null}</span>
                <span className={`flex-1 ${on ? 'font-semibold text-zinc-50' : ''}`}>{p.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mx-3 my-1.5 border-t border-zinc-800" />
      <form
        className="px-3 pb-1.5"
        onSubmit={(e) => { e.preventDefault(); if (valid) onPick({ id: 'custom', custom: { from, to } }); }}
      >
        <div className="mb-1.5 text-xs text-zinc-400">Custom range</div>
        <div className="flex items-center gap-2">
          <label className="flex-1">
            <span className="sr-only">From</span>
            <input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)}
              className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 font-mono text-[12.5px] text-zinc-100 [color-scheme:dark] outline-none focus:border-zinc-600" />
          </label>
          <span className="text-zinc-500" aria-hidden="true">–</span>
          <label className="flex-1">
            <span className="sr-only">To</span>
            <input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)}
              className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 font-mono text-[12.5px] text-zinc-100 [color-scheme:dark] outline-none focus:border-zinc-600" />
          </label>
        </div>
        <button type="submit" disabled={!valid}
          className="mt-2 inline-flex h-8 w-full items-center justify-center rounded-md bg-zinc-100 text-[13px] font-semibold text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400">
          Show this range
        </button>
      </form>
    </div>
  );
}

// ── the facets ────────────────────────────────────────────────────────────────

/**
 * Everything that changes WHICH days a number is made of, in one place and in the open: which
 * weekdays count, what "typical" means, whether pace is judged in stops or in share of the
 * board, and which days Chad has left out of the typical day (and the way to put each back).
 */
export function FilterPanel({ weekdays, onToggleWeekday, typical, onTypical, measure, onMeasure, leftOut, onPutBack, onPutAllBack, onReset, today, compact = false, typicalLabel }) {
  const entered = useEntered();
  const days = [...leftOut].sort().reverse();
  return (
    <section
      aria-label="Filters"
      className={`rounded-lg border border-zinc-800 bg-zinc-900/80 transition duration-200 motion-reduce:transition-none ${entered ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'}
        ${compact ? 'p-3' : 'p-4'}`}
    >
      <div className={`grid gap-4 ${compact ? 'grid-cols-1' : 'grid-cols-2 xl:grid-cols-4'}`}>
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-zinc-400">Weekdays in the trend and the table</legend>
          <div className="flex flex-wrap gap-1.5">
            {[1, 2, 3, 4, 5].map((w) => {
              const on = weekdays.has(w);
              return (
                <button key={w} type="button" aria-pressed={on} onClick={() => onToggleWeekday(w)}
                  className={`inline-flex h-7 min-w-[44px] items-center justify-center rounded-md border px-2 text-[12.5px] font-medium transition-colors
                    ${on ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-zinc-800 bg-transparent text-zinc-500 line-through decoration-zinc-600 hover:text-zinc-300'}`}>
                  {WEEKDAY_SHORT[w]}
                </button>
              );
            })}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-zinc-400">Typical day, for today's pace</legend>
          <Segmented label="Typical day" value={typical} onChange={onTypical}
            options={[{ value: 'weekday', label: typicalLabel || 'Same weekday' }, { value: 'recent', label: 'Last 20 weekdays' }]} />
          <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
            {typical === 'weekday' ? 'The last 8 of today’s weekday.' : 'The last 20 weekdays of any kind — for the week after a holiday.'}
          </p>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-zinc-400">Judge today's pace by</legend>
          <Segmented label="Judge pace by" value={measure} onChange={onMeasure}
            options={[{ value: 'stops', label: 'Stops' }, { value: 'share', label: 'Share of board' }]} />
          <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
            {measure === 'stops' ? 'Stops delivered so far, against the typical day at the same minute.' : 'The share of today’s own board done — fair on a heavy or a light day.'}
          </p>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-zinc-400">Left out of the typical day</legend>
          {days.length ? (
            <>
              <ul className="flex flex-wrap gap-1.5">
                {days.map((d) => (
                  <li key={d}>
                    <button type="button" onClick={() => onPutBack(d)} aria-label={`Put ${dayLabel(d, today)} back in the typical day`}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 font-mono text-[12px] text-zinc-300 hover:border-zinc-600 hover:text-zinc-100">
                      <EyeOff size={12} className="text-zinc-500" aria-hidden="true" /> {dayLabel(d, today)} <X size={12} className="text-zinc-500" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" onClick={onPutAllBack} className="mt-2 text-xs font-medium text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-zinc-100">Put them all back</button>
            </>
          ) : (
            <p className="text-xs leading-relaxed text-zinc-400">None. A holiday or a snow day can be left out from its row in the Days table.</p>
          )}
        </fieldset>
      </div>
      <div className="mt-3 flex justify-end border-t border-zinc-800 pt-3">
        <ToolbarButton onClick={onReset}><RotateCcw size={13} aria-hidden="true" /> Reset filters</ToolbarButton>
      </div>
    </section>
  );
}

// ── the row menu ──────────────────────────────────────────────────────────────

/**
 * A row's actions, in a menu PORTALED to the body. A table sits inside a horizontal scroller, and
 * a scroll container clips anything absolutely positioned inside it in BOTH directions — the
 * same trap v0.54.71 fell into with the desktop More menu. Fixed to the viewport, the menu can
 * never be cut off by the table it belongs to; it closes on scroll so it never floats away from it.
 */
export function RowMenu({ label, items }) {
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const anchorRef = useRef(null);
  const [pos, setPos] = useState(null);
  const open = !!pos;
  const close = useCallback(() => setPos(null), []);
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    anchorRef.current = { top: r.top, left: r.left };
    const w = 232;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    const below = window.innerHeight - r.bottom;
    const est = 44 * items.length + 12;
    setPos(below >= est || below > r.top ? { left, top: r.bottom + 4 } : { left, bottom: window.innerHeight - r.top + 4 });
  };
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!menuRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) close(); };
    const key = (e) => {
      if (e.key === 'Escape') { close(); btnRef.current?.focus(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const els = [...(menuRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])') || [])];
      if (!els.length) return;
      e.preventDefault();
      const i = els.indexOf(document.activeElement);
      els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length].focus({ preventScroll: true });
    };
    // CLOSE WHEN THE ROW MOVES, not on every scroll event. A scroll event can arrive a frame after
    // the tap that opened the menu (the browser finishing the scroll that brought the row into
    // view), and closing on that would shut the menu the moment it opened. What matters is whether
    // the menu would now float away from its row — so the row's position is the test.
    const moved = () => {
      const r = btnRef.current?.getBoundingClientRect();
      const a = anchorRef.current;
      if (!r || !a || Math.abs(r.top - a.top) > 4 || Math.abs(r.left - a.left) > 4) close();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);
  useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : place())}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 ${open ? 'bg-zinc-800 text-zinc-100' : ''}`}
      >
        <MoreHorizontal size={15} />
      </button>
      {open && createPortal(
        <MenuSurface ref={menuRef} pos={pos} label={label}>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => { close(); it.onSelect(); }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-zinc-200 outline-none transition-colors hover:bg-zinc-800 focus:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-500"
            >
              {it.icon ? <span className="inline-flex w-4 justify-center text-zinc-400" aria-hidden="true">{it.icon}</span> : null}
              <span className="flex-1">{it.label}</span>
            </button>
          ))}
        </MenuSurface>,
        document.body,
      )}
    </>
  );
}

const MenuSurface = React.forwardRef(function MenuSurface({ pos, label, children }, ref) {
  const entered = useEntered();
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={`fixed z-[70] w-[232px] rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl shadow-black/50 transition duration-150 motion-reduce:transition-none
        ${entered ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`}
      style={{ left: pos.left, ...(pos.top != null ? { top: pos.top, transformOrigin: 'top right' } : { bottom: pos.bottom, transformOrigin: 'bottom right' }) }}
    >
      {children}
    </div>
  );
});

// ── the pager ─────────────────────────────────────────────────────────────────

function pageWindow(page, pages) {
  const set = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
  const list = [...set].sort((a, b) => a - b);
  const out = [];
  list.forEach((p, i) => { if (i && p - list[i - 1] > 1) out.push('…'); out.push(p); });
  return out;
}

/** A server-style footer: rows per page, "26–50 of 63", and the pages. */
export function Pager({ page, pages, total, first, last, size, onPage, onSize, noun = 'rows' }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 px-3 py-2 text-xs text-zinc-400">
      <label className="inline-flex items-center gap-2">
        <span>Rows per page</span>
        <select value={size} onChange={(e) => onSize(Number(e.target.value))}
          className="h-7 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 font-mono text-[12px] text-zinc-100 outline-none focus:border-zinc-600">
          {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <span className="font-mono tabular-nums">{total ? `${first}–${last} of ${total}` : `0 ${noun}`}</span>
      <nav className="inline-flex items-center gap-1" aria-label="Pages">
        <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-800 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
          <ChevronLeft size={14} />
        </button>
        {pageWindow(page, pages).map((p, i) => (p === '…'
          ? <span key={`gap-${i}`} className="px-1 text-zinc-500">…</span>
          : (
            <button key={p} type="button" onClick={() => onPage(p)} aria-current={p === page ? 'page' : undefined}
              className={`inline-flex h-7 min-w-[28px] items-center justify-center rounded-md px-1.5 font-mono tabular-nums ${p === page ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100'}`}>
              {p}
            </button>
          )))}
        <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-800 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
          <ChevronRight size={14} />
        </button>
      </nav>
    </div>
  );
}

// ── status and tiles ──────────────────────────────────────────────────────────

const STATUS_STYLE = {
  ahead: { icon: TrendingUp, cls: 'border-emerald-400/30 bg-emerald-400/10', iconCls: 'text-emerald-400' },
  'on-pace': { icon: Minus, cls: 'border-zinc-600 bg-zinc-800/60', iconCls: 'text-zinc-300' },
  behind: { icon: TrendingDown, cls: 'border-amber-400/30 bg-amber-400/10', iconCls: 'text-amber-400' },
  'not-started': { icon: Clock, cls: 'border-zinc-700 bg-zinc-800/40', iconCls: 'text-zinc-400' },
  insufficient: { icon: Info, cls: 'border-zinc-700 bg-zinc-800/40', iconCls: 'text-zinc-400' },
  'no-board': { icon: Info, cls: 'border-zinc-700 bg-zinc-800/40', iconCls: 'text-zinc-400' },
  'no-clock': { icon: Info, cls: 'border-zinc-700 bg-zinc-800/40', iconCls: 'text-zinc-400' },
};

/** Today's verdict: an icon AND a word, never a colour alone. */
export function StatusChip({ status, size = 'sm' }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.insufficient;
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border ${s.cls} ${size === 'lg' ? 'px-2.5 py-1 text-[13px]' : 'px-2 py-0.5 text-xs'} font-medium text-zinc-100`}>
      <Icon size={size === 'lg' ? 14 : 12} className={s.iconCls} aria-hidden="true" />
      {PACE_STATUS_LABEL[status] || status}
    </span>
  );
}

/** A change, signed, with the direction's arrow and a tone that says whether that way is good. */
export function Delta({ text, tone = 'neutral', up = null }) {
  if (!text || text === '—') return <span className="font-mono text-xs text-zinc-500">—</span>;
  const cls = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-amber-300' : 'text-zinc-300';
  const Icon = up == null ? null : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 font-mono text-xs tabular-nums ${cls}`}>
      {Icon ? <Icon size={12} aria-hidden="true" /> : null}{text}
    </span>
  );
}

export function Skeleton({ className = '', style }) {
  return <div className={`animate-pulse rounded bg-zinc-800/70 motion-reduce:animate-none ${className}`} style={style} aria-hidden="true" />;
}

/**
 * A KPI tile: label, value, a signed change against a NAMED comparison, a line of context and a
 * small trend. The value is proportional figures (a big 1,084 in tabular digits looks loose);
 * the delta and the context are monospace so they line up across the row.
 */
export function KpiTile({ label, value, unit = null, delta = null, sub = null, spark = null, status = null, loading = false, compact = false }) {
  if (loading) {
    return (
      <div className={`rounded-lg border border-zinc-800 bg-zinc-900 ${compact ? 'p-3' : 'p-4'}`}>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-7 w-28" />
        <Skeleton className="mt-3 h-3 w-40" />
      </div>
    );
  }
  return (
    <div className={`group rounded-lg border border-zinc-800 bg-zinc-900 transition-colors duration-150 hover:border-zinc-700 ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 className={`${compact ? 'text-xs' : 'text-[13px]'} font-medium text-zinc-400`}>{label}</h3>
        {status ? <StatusChip status={status} /> : null}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className={`${compact ? 'text-[22px]' : 'text-[28px]'} font-semibold leading-none tracking-tight text-zinc-50`}>
            {value}{unit ? <span className={`${compact ? 'text-sm' : 'text-base'} ml-1 font-medium text-zinc-400`}>{unit}</span> : null}
          </div>
          {delta ? <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5"><Delta {...delta} />{delta.against ? <span className="text-xs text-zinc-400">{delta.against}</span> : null}</div> : null}
        </div>
        {spark && !compact ? <div className="shrink-0 opacity-90 transition-opacity group-hover:opacity-100">{spark}</div> : null}
      </div>
      {sub ? <p className={`mt-2 ${compact ? 'text-[11.5px]' : 'text-xs'} leading-relaxed text-zinc-400`}>{sub}</p> : null}
    </div>
  );
}

/** Filter button with its count — the number of facets away from the defaults. */
export function FiltersButton({ open, count, onClick }) {
  return (
    <ToolbarButton active={open} aria-expanded={open} aria-controls="perf-filters" onClick={onClick}>
      <SlidersHorizontal size={14} className="text-zinc-400" aria-hidden="true" />
      Filters
      {count > 0 && <span className="ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-zinc-100 px-1 font-mono text-[10px] font-semibold text-zinc-900">{count}</span>}
    </ToolbarButton>
  );
}
