// src/performance/PerformancePhone.jsx — More → Performance, on a phone.
//
// ITS OWN VIEW, not the desktop one squeezed (CLAUDE.md: mobile and desktop are two views). The
// order is the order a phone is read in: first the one answer — ahead or behind, right now — then
// the tiles, the trend, and the rows as cards. Every control is a 44px target in its own right,
// not only once index.css lifts it, and everything that opens (the date range, the filters) opens
// IN FLOW under the header, so what is below it moves instead of being covered.
//
// Like the desktop view it draws and decides nothing: `vm` and `act` come from PerformanceScreen.
import React from 'react';
import { CalendarDays, CalendarRange, ChevronDown, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, RefreshCw, SlidersHorizontal, Truck, X } from 'lucide-react';
import { SANS } from './theme.js';
import { RANGE_PRESETS, fmtClock, fmtCount, rangeLabel, dayLabel } from '../lib/stop-pace.js';
import { PaceChart, PaceTable, TrendChart, OutcomeMeter, WeekdayBars } from './charts.jsx';
import { DateRangePicker, FilterPanel, KpiTile, SearchField, Segmented, Skeleton, StatusChip, Delta } from './controls.jsx';
import { DayCard, RouteCard } from './tables.jsx';
import {
  Banners, Card, ChartSkeleton, FirstLoadError, HistoryBody, OverlayChips, Toast, TrendTable, ViewToggle,
} from './parts.jsx';

/** The phone sorts from named orders, not column headers: what a dispatcher asks, in his words. */
const DAY_SORTS = [
  { id: 'new', label: 'Newest first', key: 'date', dir: 'desc' },
  { id: 'old', label: 'Oldest first', key: 'date', dir: 'asc' },
  { id: 'most', label: 'Most delivered', key: 'delivered', dir: 'desc' },
  { id: 'least', label: 'Fewest delivered', key: 'delivered', dir: 'asc' },
  { id: 'done', label: 'Lowest share done', key: 'completionRate', dir: 'asc' },
  { id: 'unable', label: 'Most unable', key: 'unable', dir: 'desc' },
];
const ROUTE_SORTS = [
  { id: 'behind', label: 'Furthest behind', key: 'share', dir: 'asc' },
  { id: 'ahead', label: 'Furthest ahead', key: 'share', dir: 'desc' },
  { id: 'open', label: 'Most still open', key: 'open', dir: 'desc' },
  { id: 'unable', label: 'Most unable', key: 'unable', dir: 'desc' },
  { id: 'slow', label: 'Slowest per hour', key: 'perHour', dir: 'asc' },
  { id: 'name', label: 'Route A–Z', key: 'route', dir: 'asc' },
];

export default function PerformancePhone({ vm, act }) {
  const stale = vm.stale;
  const failedCold = !vm.data && !vm.loading && !!vm.error;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-950 text-zinc-100 antialiased" style={{ fontFamily: SANS }}>
      <PhoneHeader vm={vm} act={act} />
      <div className="space-y-3 px-3 pb-10 pt-3">
        {vm.dateOpen ? (
          <DateRangePicker
            inline selection={vm.selection} range={vm.range} today={vm.today}
            onChange={act.setSelection} open={vm.dateOpen} onOpenChange={act.setDateOpen}
          />
        ) : null}
        {vm.filtersOpen ? (
          <div id="perf-filters">
            <FilterPanel
              compact
              weekdays={vm.weekdays} onToggleWeekday={act.toggleWeekday}
              typical={vm.typical} onTypical={act.setTypical} typicalLabel={vm.typicalLabel}
              measure={vm.measure} onMeasure={act.setMeasure}
              leftOut={vm.leftOut} onPutBack={act.putBack} onPutAllBack={act.putAllBack}
              onReset={act.resetFilters} today={vm.today}
            />
          </div>
        ) : null}

        {failedCold ? <FirstLoadError vm={vm} act={act} /> : (
          <>
            <Banners vm={vm} act={act} />
            <PaceHero vm={vm} act={act} dimmed={stale} />
            <div className="grid grid-cols-2 gap-3">
              <KpiTile {...vm.tiles.board} spark={null} compact loading={vm.firstLoad} />
              <KpiTile {...vm.tiles.perDay} spark={null} compact loading={vm.firstLoad} />
              <div className="col-span-2">
                <KpiTile {...vm.tiles.completion} spark={null} compact loading={vm.firstLoad} />
              </div>
            </div>
            <TrendCard vm={vm} act={act} dimmed={stale} />
            <Card title="Where the stops ended up" subtitle={`Closed days of ${rangeLabel(vm.range.from, vm.range.to)}`}>
              {vm.firstLoad ? <ChartSkeleton height={60} /> : vm.mix?.whole ? <OutcomeMeter mix={vm.mix} compact /> : <Empty text="No closed days in this range yet." />}
            </Card>
            <Card title="Delivered by weekday" subtitle="Average per closed day in the range">
              {vm.firstLoad ? <ChartSkeleton height={100} />
                : vm.profile.some((p) => p.n > 0) ? <WeekdayBars profile={vm.profile} todayWeekday={vm.todayWd} /> : <Empty text="No closed days in this range yet." />}
            </Card>
            <RowsCard vm={vm} act={act} />
            <Card title="History" subtitle="What every chart here is made of, and the days still to build">
              {vm.firstLoad ? <ChartSkeleton height={120} /> : <HistoryBody vm={vm} act={act} compact />}
            </Card>
          </>
        )}
      </div>
      <Toast text={vm.toast} />
    </div>
  );
}

// ── the header ────────────────────────────────────────────────────────────────

/**
 * Sticky: the range and the filters stay one tap away however far down the list Chad is. Two
 * rows — the name with its freshness line and a refresh, then the range and the filters — so
 * nothing in it has to shrink to fit 360px.
 */
function PhoneHeader({ vm, act }) {
  const preset = RANGE_PRESETS.find((p) => p.id === vm.selection?.id);
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="flex items-center gap-2 px-3 pt-2">
        <div className="min-w-0 flex-1">
          {/* "Stop performance" is the phone guard's heading for this screen too. */}
          <h1 className="text-[17px] font-semibold tracking-tight text-zinc-50">Stop performance</h1>
          <p className="truncate font-mono text-[11px] text-zinc-400">{vm.freshness}</p>
        </div>
        <button
          type="button" onClick={act.reload} disabled={vm.loading} aria-label="Refresh"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 transition-colors active:bg-zinc-800 disabled:opacity-60"
        >
          <RefreshCw size={16} className={vm.loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
        </button>
      </div>
      <div className="flex items-center gap-2 px-3 pb-2.5 pt-2">
        <button
          type="button" onClick={() => act.setDateOpen(!vm.dateOpen)} aria-expanded={vm.dateOpen}
          className={`inline-flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 text-left text-[13.5px] transition-colors
            ${vm.dateOpen ? 'border-zinc-600 bg-zinc-800' : 'border-zinc-800 bg-zinc-900 active:bg-zinc-800'}`}
        >
          <CalendarRange size={15} className="shrink-0 text-zinc-400" aria-hidden="true" />
          <span className="shrink-0 font-medium text-zinc-100">{preset ? preset.label : 'Custom'}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-400">{rangeLabel(vm.range.from, vm.range.to)}</span>
          <ChevronDown size={15} className={`shrink-0 text-zinc-500 transition-transform duration-150 ${vm.dateOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
        <button
          type="button" onClick={() => act.setFiltersOpen((v) => !v)} aria-expanded={vm.filtersOpen} aria-controls="perf-filters"
          className={`inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[13.5px] font-medium transition-colors
            ${vm.filtersOpen ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-zinc-800 bg-zinc-900 text-zinc-300 active:bg-zinc-800'}`}
        >
          <SlidersHorizontal size={15} className="text-zinc-400" aria-hidden="true" />
          Filters
          {vm.facetCount > 0 ? <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-zinc-100 px-1 font-mono text-[10px] font-semibold text-zinc-900">{vm.facetCount}</span> : null}
        </button>
      </div>
    </header>
  );
}

// ── the one answer ────────────────────────────────────────────────────────────

/** Ahead or behind, now: the count, the change against a typical day, the sentence and the curve. */
function PaceHero({ vm, act, dimmed }) {
  const t = vm.tiles.today;
  const words = vm.words;
  const share = vm.measure === 'share';
  if (vm.firstLoad) {
    return (
      <section aria-label="Today’s pace" className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="mt-3 h-9 w-32" />
        <Skeleton className="mt-3 h-3 w-48" />
        <Skeleton className="mt-4 h-[200px] w-full" />
      </section>
    );
  }
  return (
    <section aria-label="Today’s pace" className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xs font-medium text-zinc-400">{t.label}</h2>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-[34px] font-semibold leading-none tracking-tight text-zinc-50">{t.value}</span>
            {vm.live ? <span className="font-mono text-[13px] text-zinc-400">of {fmtCount(vm.live.gradable)}</span> : null}
          </div>
        </div>
        <StatusChip status={t.status} size="lg" />
      </div>
      {t.delta ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <Delta {...t.delta} />
          <span className="text-xs text-zinc-400">{t.delta.against}</span>
        </div>
      ) : null}
      {words.head
        ? <p className="mt-3 text-[13.5px] leading-snug text-zinc-200">{words.head}</p>
        : words.note ? <p className="mt-3 text-[13px] leading-relaxed text-zinc-400">{words.note}</p> : null}
      {words.facts ? (
        <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-zinc-800 bg-zinc-800">
          {words.facts.map((f) => (
            <div key={f.key} className="min-w-0 bg-zinc-900 px-2.5 py-2">
              <dt className="text-[11px] leading-tight text-zinc-400">{f.label}</dt>
              <dd className={`mt-0.5 font-mono text-[15px] font-semibold tabular-nums ${f.tone === 'good' ? 'text-emerald-300' : f.tone === 'bad' ? 'text-amber-300' : 'text-zinc-50'}`}>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-400">{vm.live?.asOf ? `As of the ${fmtClock(vm.live.asOf.minute)} scan` : 'Through the day'}</span>
        <ViewToggle value={vm.paceView} onChange={act.setPaceView} label="Pace: chart or table" size="lg" />
      </div>
      <div className="mt-2">
        {vm.paceView === 'table' ? (
          <PaceTable live={vm.live} bands={vm.bands} share={share} overlays={vm.overlays} asOfBucket={vm.pace?.bucket ?? null} />
        ) : (
          <PaceChart
            compact live={vm.live} bands={vm.bands} share={share} overlays={vm.overlays} asOfBucket={vm.pace?.bucket ?? null}
            typicalLabel={vm.typicalLabel} height={220} dimmed={dimmed}
          />
        )}
      </div>
      <OverlayChips vm={vm} act={act} compact />
      {t.sub ? <p className="mt-3 border-t border-zinc-800 pt-3 text-xs leading-relaxed text-zinc-400">{t.sub}</p> : null}
    </section>
  );
}

// ── days, weeks, months ───────────────────────────────────────────────────────

function TrendCard({ vm, act, dimmed }) {
  const missing = vm.missingInRange.length;
  return (
    <Card title={`Delivered per ${vm.gran}`} subtitle={`${rangeLabel(vm.range.from, vm.range.to)} · a hollow bar is still running`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          size="lg" label="Group the trend by" value={vm.gran} onChange={act.setGran}
          options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]}
        />
        <ViewToggle value={vm.trendView} onChange={act.setTrendView} label="Trend: chart or table" size="lg" />
      </div>
      <div className="mt-3">
        {vm.firstLoad ? <ChartSkeleton height={190} />
          : !vm.trend.length ? <Empty text="No days in this range and these weekdays yet." />
            : vm.trendView === 'table' ? <TrendTable vm={vm} />
              : <TrendChart compact buckets={vm.trend} average={vm.average} averageLabel={vm.averageLabel} height={190} dimmed={dimmed} unitLabel={vm.gran} />}
      </div>
      {missing ? (
        <p className="mt-3 text-xs leading-relaxed text-amber-300">
          {fmtCount(missing)} captured day{missing === 1 ? ' is' : 's are'} not built yet — left out, not counted as zero. The History card, at the bottom, builds {missing === 1 ? 'it' : 'them'}.
        </p>
      ) : null}
    </Card>
  );
}

// ── the rows, as cards ────────────────────────────────────────────────────────

function RowsCard({ vm, act }) {
  const days = vm.tableMode === 'days';
  const sorts = days ? DAY_SORTS : ROUTE_SORTS;
  const current = sorts.find((o) => o.key === vm.sort.key && o.dir === vm.sort.dir);
  const pg = vm.page;
  const n = days ? vm.dayCount : vm.routeCount;
  const searching = !!vm.query.trim();
  const loading = days ? vm.loading && !pg.rows.length : (vm.routeLoading || (vm.loading && !vm.routeDigest));
  const emptyText = days
    ? (searching ? `No day matches “${vm.query.trim()}”.` : 'No days in this range and these weekdays yet.')
    : vm.routeError ? `That day could not be read: ${vm.routeError}`
      : !vm.routeDate ? 'Pick a day to see its routes.'
        : searching ? `No route or driver matches “${vm.query.trim()}”.`
          : vm.routeDigest ? 'No routes on that day’s board.' : 'That day is not built yet — the History card, at the bottom, builds it.';
  return (
    <Card
      title={days ? 'Days' : `Routes${vm.routeDate ? ` · ${dayLabel(vm.routeDate, vm.today)}` : ''}`}
      subtitle={days ? 'Tick a day to draw it over today, or to leave it out of the typical day' : 'Lowest share done first — the route furthest behind is the first card'}
      bodyClassName="p-3"
    >
      <Segmented
        size="lg" label="Rows" value={vm.tableMode} onChange={act.setTableMode} className="w-full [&>button]:flex-1"
        options={[
          { value: 'days', label: <span className="inline-flex items-center gap-1.5"><CalendarDays size={14} aria-hidden="true" />Days</span> },
          { value: 'routes', label: <span className="inline-flex items-center gap-1.5"><Truck size={14} aria-hidden="true" />Routes</span> },
        ]}
      />
      {!days ? (
        <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
          <span className="shrink-0">Day</span>
          <select
            value={vm.routeDate || ''} onChange={(e) => act.setRoutesDay(e.target.value || null)}
            className="h-11 min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-2 font-mono text-[13px] text-zinc-100 outline-none focus:border-zinc-600"
          >
            {vm.routeDate && !vm.dayOptions.some((o) => o.date === vm.routeDate) ? <option value={vm.routeDate}>{dayLabel(vm.routeDate, vm.today)}</option> : null}
            {vm.dayOptions.map((o) => <option key={o.date} value={o.date}>{o.label}</option>)}
          </select>
        </label>
      ) : null}
      <SearchField
        className="mt-2 min-h-[44px] w-full" value={vm.query} onChange={act.setQuery}
        placeholder={days ? 'Search days' : 'Search routes and drivers'}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="font-mono text-xs tabular-nums text-zinc-400">{fmtCount(n)} {days ? (n === 1 ? 'day' : 'days') : (n === 1 ? 'route' : 'routes')}</span>
        <label className="flex min-w-0 items-center gap-2 text-xs text-zinc-400">
          <span className="shrink-0">Sort</span>
          <select
            value={current?.id || ''} onChange={(e) => { const o = sorts.find((x) => x.id === e.target.value); if (o) act.setSort(o.key, o.dir); }}
            className="h-11 min-w-0 rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-[13px] text-zinc-100 outline-none focus:border-zinc-600"
          >
            {!current ? <option value="">As chosen</option> : null}
            {sorts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
      </div>
      {days && vm.selected.size ? <PhoneBulk vm={vm} act={act} /> : null}

      {loading ? (
        <ul className="mt-3 space-y-2" aria-busy="true" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <li key={i} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <Skeleton className="h-4 w-32" /><Skeleton className="mt-2 h-3 w-48" /><Skeleton className="mt-3 h-8 w-full" />
            </li>
          ))}
        </ul>
      ) : !pg.rows.length ? (
        <div className="mt-3 rounded-lg border border-dashed border-zinc-800 px-4 py-8 text-center">
          <p className="text-sm text-zinc-300">{emptyText}</p>
          {searching ? (
            <button type="button" onClick={() => act.setQuery('')} className="mt-2 inline-flex h-11 items-center px-3 text-xs font-medium text-zinc-300 underline decoration-zinc-600 underline-offset-2">
              Clear the search
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {days
            ? pg.rows.map((r) => <DayCard key={r.id} r={r} selected={vm.selected.has(r.id)} onToggle={act.toggleRow} onAction={act.onDayAction} />)
            : pg.rows.map((r) => <RouteCard key={r.id} r={r} onAction={act.onRouteAction} />)}
        </ul>
      )}
      {pg.pages > 1 ? (
        <nav className="mt-3 flex items-center justify-between gap-2" aria-label="Pages">
          <button
            type="button" onClick={() => act.setPage(pg.page - 1)} disabled={pg.page <= 1}
            className="inline-flex h-11 items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-[13px] text-zinc-200 disabled:opacity-40"
          >
            <ChevronLeft size={15} aria-hidden="true" /> Previous
          </button>
          <span className="font-mono text-xs tabular-nums text-zinc-400">{pg.first}–{pg.last} of {pg.total}</span>
          <button
            type="button" onClick={() => act.setPage(pg.page + 1)} disabled={pg.page >= pg.pages}
            className="inline-flex h-11 items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-[13px] text-zinc-200 disabled:opacity-40"
          >
            Next <ChevronRight size={15} aria-hidden="true" />
          </button>
        </nav>
      ) : null}
    </Card>
  );
}

function PhoneBulk({ vm, act }) {
  const n = vm.selected.size;
  const anyLeftOut = [...vm.selected].some((d) => vm.leftOut.has(d));
  const anyIn = [...vm.selected].some((d) => d !== vm.today && !vm.leftOut.has(d));
  const btn = 'inline-flex h-11 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-[13px] font-medium text-zinc-200 active:bg-zinc-800';
  return (
    <div role="region" aria-label="Ticked days" className="mt-3 rounded-lg border border-indigo-400/30 bg-indigo-400/[0.06] p-2.5">
      <p className="px-0.5 text-[13px] text-zinc-100">
        <span className="font-medium">{n} day{n === 1 ? '' : 's'} ticked</span>
        <span className="text-zinc-400"> — {n > 2 ? 'the newest two are drawn over today' : 'drawn over today'}</span>
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {anyIn ? <button type="button" onClick={act.leaveOutSelected} className={btn}><EyeOff size={14} aria-hidden="true" /> Leave out</button> : null}
        {anyLeftOut ? <button type="button" onClick={act.putBackSelected} className={btn}><Eye size={14} aria-hidden="true" /> Put back</button> : null}
        <button type="button" onClick={act.copySelected} className={btn}><Copy size={14} aria-hidden="true" /> Copy</button>
        <button type="button" onClick={act.clearSelection} className={btn}><X size={14} aria-hidden="true" /> Clear</button>
      </div>
    </div>
  );
}

function Empty({ text }) {
  return <p className="py-5 text-center text-sm text-zinc-400">{text}</p>;
}
