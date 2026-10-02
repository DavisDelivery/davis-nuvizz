// src/performance/parts.jsx — pieces both views draw the same way: the card frame, the banners,
// the toast, the history panel and the trend's table twin. Layout is each view's own business;
// these are the bricks, not the building.
import React from 'react';
import { AlertTriangle, Database, Hammer, Info, LineChart, Loader2, RefreshCw, PauseCircle, Table2, X } from 'lucide-react';
import { fmtClock, fmtCount, fmtShare, dayLabel, rangeLabel, MIN_BASELINE_DAYS } from '../lib/stop-pace.js';
import { Segmented, Skeleton, ToolbarButton } from './controls.jsx';

/** Chart | Table — every chart here has a table twin, one tap away. */
export function ViewToggle({ value, onChange, label, size = 'sm' }) {
  const icon = size === 'lg' ? 14 : 13;
  return (
    <Segmented
      label={label}
      value={value}
      onChange={onChange}
      size={size}
      options={[
        { value: 'chart', label: <span className="inline-flex items-center gap-1.5"><LineChart size={icon} aria-hidden="true" />Chart</span> },
        { value: 'table', label: <span className="inline-flex items-center gap-1.5"><Table2 size={icon} aria-hidden="true" />Table</span> },
      ]}
    />
  );
}

export function ChartSkeleton({ height = 260 }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      <div className="flex gap-4"><Skeleton className="h-3 w-24" /><Skeleton className="h-3 w-40" /><Skeleton className="h-3 w-32" /></div>
      <Skeleton className="w-full" style={{ height }} />
    </div>
  );
}

/**
 * THE DAYS DRAWN OVER TODAY. A ticked row in the Days table is drawn on the pace chart — the two
 * newest, because a third line in a colour the validator has not passed is a line nobody can tell
 * apart (theme.js). Each chip takes its day off again; the words say what ticking does before
 * anything is ticked, so the feature can be found from the chart it changes.
 */
export function OverlayChips({ vm, act, compact = false }) {
  const others = vm.selectedDates.filter((d) => d !== vm.today);
  const drawn = new Set(vm.overlays.map((o) => o.date));
  const waiting = others.slice(0, 2).filter((d) => !drawn.has(d));
  if (!others.length) {
    return (
      <p className={`mt-3 ${compact ? 'text-xs' : 'text-xs'} leading-relaxed text-slate-600`}>
        Tick a day in the {compact ? 'list' : 'table'} below to draw it over today — a heavy Monday, the day before a holiday. Two at a time.
      </p>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {vm.overlays.map((o) => (
        <button
          key={o.date}
          type="button"
          onClick={() => act.toggleRow(o.date)}
          aria-label={`Take ${o.label} off the pace chart`}
          className={`inline-flex ${compact ? 'h-11' : 'h-7'} items-center gap-2 rounded-full border border-slate-200 bg-white pl-2.5 pr-2 text-xs text-slate-800 transition-colors hover:border-slate-400 hover:bg-slate-100`}
        >
          <span className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: o.color }} aria-hidden="true" />
          {o.label}
          <X size={12} className="text-slate-600" aria-hidden="true" />
        </button>
      ))}
      {waiting.map((d) => (
        <span key={d} className="inline-flex items-center gap-1.5 text-xs text-slate-600">
          <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {dayLabel(d, vm.today)}
        </span>
      ))}
      {others.length > 2 ? <span className="text-xs text-slate-600">The newest two of the {others.length} ticked are drawn.</span> : null}
    </div>
  );
}

export function Card({ title, subtitle = null, actions = null, children, className = '', bodyClassName = 'p-4', as: Tag = 'section', id }) {
  return (
    <Tag id={id} className={`rounded-lg border border-slate-200 bg-white ${className}`} aria-label={typeof title === 'string' ? title : undefined}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-slate-900">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs leading-relaxed text-slate-600">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </Tag>
  );
}

/**
 * THE THINGS THAT CHANGE HOW FAR A NUMBER CAN BE TRUSTED, said above the numbers: a refresh that
 * failed (and how old the answer on screen is), and a scan that has stopped (so today's line
 * stops there too). A stale screen that looks fresh is the failure CLAUDE.md is written against.
 */
export function Banners({ vm, act }) {
  const out = [];
  if (vm.error && vm.data) {
    out.push(
      <div key="err" role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-slate-900">
        <AlertTriangle size={14} className="shrink-0 text-amber-600" aria-hidden="true" />
        <span className="min-w-0 flex-1">The last refresh failed ({vm.error}). Showing the answer read at {vm.readAt || 'the last good read'}.</span>
        <ToolbarButton onClick={act.reload}><RefreshCw size={13} aria-hidden="true" /> Try again</ToolbarButton>
      </div>,
    );
  }
  // A range longer than the endpoint reads is cut to its limit, and the comparison period with it;
  // the endpoint says so (resolvePerformanceQuery's `clamped`) and so does the screen.
  if (vm.data?.range?.clamped === 'range-too-long') {
    out.push(
      <div key="clamp" role="status" className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-800">
        <Info size={14} className="shrink-0 text-slate-600" aria-hidden="true" />
        <span>That range and the period before it are longer than the screen reads at once, so the earliest days start at {rangeLabel(vm.data.range.from, vm.data.range.from)}. The % changes compare with what was read.</span>
      </div>,
    );
  }
  const halted = vm.live?.scanState?.halted;
  if (halted) {
    out.push(
      <div key="halt" role="status" className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-slate-900">
        <PauseCircle size={14} className="shrink-0 text-amber-600" aria-hidden="true" />
        <span>Scans are paused ({vm.live.scanState.reason === 'ceiling' ? 'the daily NuVizz ceiling was reached' : 'the kill switch is on'}). Today’s numbers stop at the last scan{vm.live.asOf ? `, ${fmtClock(vm.live.asOf.minute)}` : ''}.</span>
      </div>,
    );
  }
  return out.length ? <div className="space-y-2">{out}</div> : null;
}

export function Toast({ text }) {
  if (!text) return null;
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-[80] flex justify-center px-4">
      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-900 shadow-xl shadow-slate-900/10">{text}</div>
    </div>
  );
}

/** The whole screen when the one read has never come back. */
export function FirstLoadError({ vm, act }) {
  if (vm.switchedOff) {
    return (
      <div className="mx-auto mt-12 max-w-lg rounded-lg border border-slate-200 bg-white p-6 text-center">
        <Info size={20} className="mx-auto text-slate-600" aria-hidden="true" />
        <h2 className="mt-3 text-base font-semibold text-slate-900">The Performance screen is switched off</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">STOP_PACE=off is set on the site, which also stops the nightly digest. Remove it in Netlify and redeploy to turn the screen back on.</p>
      </div>
    );
  }
  return (
    <div className="mx-auto mt-12 max-w-lg rounded-lg border border-slate-200 bg-white p-6 text-center">
      <AlertTriangle size={20} className="mx-auto text-amber-600" aria-hidden="true" />
      <h2 className="mt-3 text-base font-semibold text-slate-900">The numbers could not be read</h2>
      <p className="mt-2 break-words text-sm leading-relaxed text-slate-600">{vm.error}</p>
      <div className="mt-4 flex justify-center"><ToolbarButton onClick={act.reload}><RefreshCw size={13} aria-hidden="true" /> Try again</ToolbarButton></div>
    </div>
  );
}

const SKIP_WORDS = {
  'left-out': 'left out by you',
  'no-curve': 'no times recorded',
  'nothing-delivered': 'nothing delivered',
  untimed: 'most deliveries carry no time',
};

/**
 * WHAT THE NUMBERS ARE MADE OF — which days the typical day is, which were skipped and why,
 * which days are not built yet (with the button that builds them), and which weekdays were never
 * captured at all. The judgement calls behind every chart, in one place and in words.
 */
export function HistoryBody({ vm, act, compact = false }) {
  const cov = vm.coverage || {};
  const missing = cov.missing || [];
  const uncaptured = cov.uncaptured || [];
  const total = (cov.sealed || 0);
  const built = Math.min(total, cov.built || 0);
  const pct = total ? built / total : null;
  const b = vm.build;
  return (
    <div className={`space-y-4 ${compact ? 'text-[13px]' : 'text-[13px]'}`}>
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-slate-700"><Database size={13} className="text-slate-500" aria-hidden="true" />Days built</span>
          <span className="font-mono tabular-nums text-slate-900">{fmtCount(built)} <span className="text-slate-600">of {fmtCount(total)} captured</span></span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
          <div className="h-full rounded-full bg-slate-400 transition-[width] duration-500" style={{ width: `${Math.round((pct || 0) * 100)}%` }} />
        </div>
        {missing.length ? (
          <div className="mt-2 space-y-2">
            <p className="leading-relaxed text-slate-600">
              {fmtCount(missing.length)} captured day{missing.length === 1 ? ' has' : 's have'} no pace digest yet ({missing.length <= 3
                ? missing.map((d) => dayLabel(d, vm.today)).join(', ')
                : `${dayLabel(missing[0], vm.today)} to ${dayLabel(missing[missing.length - 1], vm.today)}`}). They are gaps on the charts, never zeros.
            </p>
            {vm.canBuild ? (
              <div className="flex flex-wrap items-center gap-2">
                <ToolbarButton onClick={act.buildHistory} disabled={b?.running}>
                  {b?.running ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Hammer size={13} aria-hidden="true" />}
                  {b?.running ? 'Building…' : `Build ${missing.length === 1 ? 'it' : `all ${fmtCount(missing.length)}`} now`}
                </ToolbarButton>
                <span className="text-xs text-slate-600">Firestore only, 0 NuVizz calls, ten days a step.</span>
              </div>
            ) : (
              <p className="text-xs text-slate-600">An admin can build them from this panel.</p>
            )}
            {b ? (
              <p role="status" className={`text-xs ${b.error ? 'text-amber-700' : 'text-slate-600'}`}>
                {b.error ? `Stopped: ${b.error} ` : ''}
                {`Built ${fmtCount(b.built)} day${b.built === 1 ? '' : 's'}`}
                {b.remaining != null ? `, ${fmtCount(b.remaining)} left` : ''}
                {b.failed ? `, ${fmtCount(b.failed)} failed (they stay listed)` : ''}.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 leading-relaxed text-slate-600">Every captured day in view is built. Each night’s capture builds the day it seals.</p>
        )}
        {uncaptured.length ? (
          <p className="mt-2 leading-relaxed text-slate-600">
            <span className="text-amber-700">{fmtCount(uncaptured.length)} weekday{uncaptured.length === 1 ? ' was' : 's were'} never captured</span> ({uncaptured.slice(0, 3).map((d) => dayLabel(d, vm.today)).join(', ')}{uncaptured.length > 3 ? '…' : ''}). Diagnostics → Capture health says why.
          </p>
        ) : null}
      </div>

      <div>
        <div className="text-slate-700">{vm.typicalLabel} is made of</div>
        {vm.base.days.length ? (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {vm.base.days.map((d) => (
              <li key={d.date} className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11.5px] text-slate-700">{dayLabel(d.date, vm.today).replace(/^\w+ /, '')}</li>
            ))}
          </ul>
        ) : <p className="mt-1 text-slate-600">No days yet.</p>}
        {vm.base.days.length > 0 && vm.base.days.length < MIN_BASELINE_DAYS ? (
          <p className="mt-1.5 text-xs text-amber-700">{MIN_BASELINE_DAYS} are needed before today is called ahead or behind.</p>
        ) : null}
        {vm.base.skipped.length ? (
          <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
            {vm.base.skipped.slice(0, 6).map((s) => (
              <li key={s.date}><span className="font-mono text-slate-700">{dayLabel(s.date, vm.today)}</span> skipped — {SKIP_WORDS[s.reason] || s.reason}{s.reason === 'untimed' && s.share != null ? ` (${fmtShare(s.share)} timed)` : ''}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <p className="border-t border-slate-200 pt-3 text-xs leading-relaxed text-slate-600">
        Counted exactly as the 6:30 report counts: planned stops only, 90 and 91 both delivered, cancelled orders out of the total
        {vm.excludedRoutes.length ? `, and ${vm.excludedRoutes.join(', ')} and every appointment route left out` : ''}. 0 NuVizz calls.
      </p>
    </div>
  );
}

/** The trend's table twin: the same buckets, as rows. */
export function TrendTable({ vm }) {
  const unit = vm.gran;
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="w-full min-w-[460px] text-xs">
        <caption className="sr-only">Delivered per {unit}</caption>
        <thead className="bg-white text-slate-600">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">{unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month'}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Delivered</th>
            {unit !== 'day' ? <th scope="col" className="px-3 py-2 text-right font-medium">Per day</th> : null}
            <th scope="col" className="px-3 py-2 text-right font-medium">Done</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Unable</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Note</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 font-mono tabular-nums text-slate-800">
          {[...vm.trend].reverse().map((b) => (
            <tr key={b.key}>
              <td className="whitespace-nowrap px-3 py-1.5 font-sans text-slate-700">{b.label}</td>
              <td className="px-3 py-1.5 text-right">{fmtCount(b.delivered)}</td>
              {unit !== 'day' ? <td className="px-3 py-1.5 text-right">{b.perDay != null ? fmtCount(b.perDay) : '—'}</td> : null}
              <td className="px-3 py-1.5 text-right">{fmtShare(b.completionRate)}</td>
              <td className="px-3 py-1.5 text-right">{fmtCount(b.unable)}</td>
              <td className="px-3 py-1.5 font-sans text-slate-600">{[b.partial ? 'still running' : null, b.gaps ? `${b.gaps} day${b.gaps === 1 ? '' : 's'} not built` : null].filter(Boolean).join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
