// src/performance/PerformanceDesktop.jsx — More → Performance, on a monitor.
//
// THE DESKTOP VIEW, AND THE iPAD'S. The app serves this layout from 768px up, and on a finger
// index.css lifts every control in it to 44px (verify-tablet-layout measures that), so nothing here
// opts out of the touch floor. The phone has its own view (PerformancePhone) — two views, never one
// layout patched to fit both (CLAUDE.md).
//
// Top to bottom, in the order the brief set: a sticky toolbar (the date range, the search, the
// filters and a refresh), the filter panel in flow when it is open, four KPI tiles, the charts
// split two-thirds / one-third, and the raw rows at the bottom with their bulk actions and pager.
//
// It DRAWS and decides nothing: every number arrives in `vm` from PerformanceScreen, which built it
// with the pure functions in src/lib/stop-pace.js, and every change goes back through `act`.
import React, { useEffect, useRef } from 'react';
import { Activity, Copy, Eye, EyeOff, RefreshCw, Truck, X, CalendarDays } from 'lucide-react';
import { SANS } from './theme.js';
import { fmtClock, fmtCount, fmtShare, rangeLabel, dayLabel, lowerFirst, WEEKDAY_LONG } from '../lib/stop-pace.js';
import { PaceChart, PaceTable, TrendChart, Sparkline, OutcomeMeter, WeekdayBars, ShareBullet } from './charts.jsx';
import {
  DateRangePicker, FilterPanel, FiltersButton, KpiTile, Pager, SearchField, Segmented, StatusChip, ToolbarButton, useEntered,
} from './controls.jsx';
import { DaysTable, RoutesTable } from './tables.jsx';
import {
  Banners, Card, ChartSkeleton, FirstLoadError, HistoryBody, OverlayChips, Toast, TrendTable, ViewToggle,
} from './parts.jsx';

export default function PerformanceDesktop({ vm, act }) {
  const searchRef = useRef(null);
  const entered = useEntered();
  const stale = vm.stale;
  const failedCold = !vm.data && !vm.loading && !!vm.error;

  // "/" puts the cursor in the search box, the way every tool with a search in its toolbar works —
  // unless the cursor is already in a field, where "/" is a character somebody is typing.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-950 text-zinc-100 antialiased" style={{ fontFamily: SANS }}>
      <Toolbar vm={vm} act={act} searchRef={searchRef} />
      <div
        className={`mx-auto max-w-[1760px] space-y-4 px-6 pb-12 pt-4 transition duration-300 ease-out motion-reduce:transition-none
          ${entered ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}
      >
        {vm.filtersOpen ? (
          <div id="perf-filters">
            <FilterPanel
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
            <KpiRow vm={vm} />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              <div className="min-w-0 space-y-4 xl:col-span-2">
                <PaceCard vm={vm} act={act} dimmed={stale} />
                <TrendCard vm={vm} act={act} dimmed={stale} />
              </div>
              <div className="min-w-0 space-y-4">
                <OutcomeCard vm={vm} />
                <WeekdayCard vm={vm} />
                <Card title="History" subtitle="What every chart here is made of, and the days still to build">
                  {vm.firstLoad ? <ChartSkeleton height={120} /> : <HistoryBody vm={vm} act={act} />}
                </Card>
              </div>
            </div>
            <TableCard vm={vm} act={act} dimmed={stale} />
          </>
        )}
      </div>
      <Toast text={vm.toast} />
    </div>
  );
}

// ── the toolbar ───────────────────────────────────────────────────────────────

/**
 * STICKY, and the only thing on the screen that is. The range, the search and the filters change
 * every number below them, so they stay in reach however far down the table Chad has scrolled.
 */
function Toolbar({ vm, act, searchRef }) {
  const live = !!vm.live?.asOf && !vm.live?.scanState?.halted;
  return (
    <div className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1760px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900" aria-hidden="true">
            <Activity size={16} className="text-zinc-300" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              {/* THE LITERAL "Stop performance" IS THE DESKTOP GUARD'S PROOF OF ARRIVAL
                  (verify-desktop-layout.mjs reads the body for it). Rename it there too. */}
              <h1 className="text-[15px] font-semibold tracking-tight text-zinc-50">Stop performance</h1>
              {live ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-px text-[11px] font-medium text-emerald-300">
                  <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  </span>
                  Live
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 truncate font-mono text-[11.5px] text-zinc-400">{vm.freshness}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker
            selection={vm.selection} range={vm.range} today={vm.today}
            onChange={act.setSelection} open={vm.dateOpen} onOpenChange={act.setDateOpen}
          />
          <SearchField
            className="w-64" value={vm.query} onChange={act.setQuery} inputRef={searchRef} hint="/"
            placeholder={vm.tableMode === 'routes' ? 'Search routes and drivers' : 'Search days'}
          />
          <FiltersButton open={vm.filtersOpen} count={vm.facetCount} onClick={() => act.setFiltersOpen((v) => !v)} />
          <ToolbarButton onClick={act.reload} disabled={vm.loading} aria-label="Refresh" title="Read the board again">
            <RefreshCw size={14} className={vm.loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
          </ToolbarButton>
        </div>
      </div>
    </div>
  );
}

// ── the four tiles ────────────────────────────────────────────────────────────

function KpiRow({ vm }) {
  const t = vm.tiles;
  const loading = vm.firstLoad;
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <KpiTile
        {...t.today} loading={loading}
        spark={<Sparkline values={t.today.spark} format={fmtCount} label="Delivered today, the last two hours" />}
      />
      <KpiTile
        {...t.board} loading={loading}
        spark={<ShareBullet value={vm.live && vm.live.gradable > 0 ? vm.live.delivered / vm.live.gradable : null} marker={vm.pace?.shareMedian ?? null} />}
      />
      <KpiTile
        {...t.perDay} loading={loading}
        spark={<Sparkline values={t.perDay.spark} format={fmtCount} label="Delivered per closed day in the range" />}
      />
      <KpiTile
        {...t.completion} loading={loading}
        spark={<Sparkline values={t.completion.spark} format={fmtShare} label="Share completed per closed day" />}
      />
    </div>
  );
}

// ── today's pace ──────────────────────────────────────────────────────────────

/**
 * THE ANSWER TO THE QUESTION THE SCREEN WAS BUILT FOR — behind or ahead, at the minute the board
 * actually knows up to — in a sentence, in four numbers, and as the running total over the day.
 */
function PaceCard({ vm, act, dimmed }) {
  const words = vm.words;
  const share = vm.measure === 'share';
  const when = vm.live?.asOf ? `as of the ${fmtClock(vm.live.asOf.minute)} scan` : vm.live ? 'no scan has landed today' : 'no board for today';
  return (
    <Card
      title="Today’s pace"
      subtitle={`${share ? 'Share of today’s board delivered' : 'Stops delivered'} through the day against ${lowerFirst(vm.typicalLabel)} — ${when}`}
      actions={(
        <>
          {vm.live && !vm.firstLoad ? <StatusChip status={vm.pace.status} size="lg" /> : null}
          <ViewToggle value={vm.paceView} onChange={act.setPaceView} label="Pace: chart or table" />
        </>
      )}
    >
      {vm.firstLoad ? <ChartSkeleton height={300} /> : (
        <>
          {words.head
            ? <p className="text-[15px] leading-snug text-zinc-100">{words.head}</p>
            : words.note ? <p className="text-sm leading-relaxed text-zinc-400">{words.note}</p> : null}
          {words.facts ? (
            <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-zinc-800 bg-zinc-800 lg:grid-cols-4">
              {words.facts.map((f) => (
                <div key={f.key} className="bg-zinc-900 px-3 py-2.5">
                  <dt className="truncate text-xs text-zinc-400">{f.label}</dt>
                  <dd className={`mt-1 font-mono text-lg font-semibold tabular-nums ${f.tone === 'good' ? 'text-emerald-300' : f.tone === 'bad' ? 'text-amber-300' : 'text-zinc-50'}`}>{f.value}</dd>
                  {f.sub ? <dd className="truncate text-[11.5px] text-zinc-400">{f.sub}</dd> : null}
                </div>
              ))}
            </dl>
          ) : null}
          <div className="mt-4">
            {vm.paceView === 'table' ? (
              <PaceTable live={vm.live} bands={vm.bands} share={share} overlays={vm.overlays} asOfBucket={vm.pace?.bucket ?? null} />
            ) : (
              <PaceChart
                live={vm.live} bands={vm.bands} share={share} overlays={vm.overlays} asOfBucket={vm.pace?.bucket ?? null}
                typicalLabel={vm.typicalLabel} height={300} dimmed={dimmed}
              />
            )}
          </div>
          <OverlayChips vm={vm} act={act} />
        </>
      )}
    </Card>
  );
}

// ── days, weeks, months ───────────────────────────────────────────────────────

function TrendCard({ vm, act, dimmed }) {
  const unit = vm.gran;
  const missing = vm.missingInRange.length;
  return (
    <Card
      title={`Delivered per ${unit}`}
      subtitle={`${rangeLabel(vm.range.from, vm.range.to)} · the line is the ${vm.averageLabel} · a hollow bar is still running`}
      actions={(
        <>
          <Segmented
            label="Group the trend by" value={vm.gran} onChange={act.setGran}
            options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]}
          />
          <ViewToggle value={vm.trendView} onChange={act.setTrendView} label="Trend: chart or table" />
        </>
      )}
    >
      {vm.firstLoad ? <ChartSkeleton height={240} />
        : !vm.trend.length ? <EmptyNote text="No days in this range and these weekdays yet." />
          : vm.trendView === 'table' ? <TrendTable vm={vm} />
            : <TrendChart buckets={vm.trend} average={vm.average} averageLabel={vm.averageLabel} height={240} dimmed={dimmed} unitLabel={unit} />}
      {missing ? (
        <p className="mt-3 text-xs leading-relaxed text-amber-300">
          {fmtCount(missing)} captured day{missing === 1 ? ' is' : 's are'} not built yet and {missing === 1 ? 'is' : 'are'} left out of these bars, not counted as zero — the History card builds {missing === 1 ? 'it' : 'them'}.
        </p>
      ) : null}
    </Card>
  );
}

function OutcomeCard({ vm }) {
  const n = vm.mix?.whole || 0;
  return (
    <Card title="Where the stops ended up" subtitle={`Planned stops on the closed days of ${rangeLabel(vm.range.from, vm.range.to)}`}>
      {vm.firstLoad ? <ChartSkeleton height={60} /> : n ? <OutcomeMeter mix={vm.mix} /> : <EmptyNote text="No closed days in this range yet." />}
    </Card>
  );
}

function WeekdayCard({ vm }) {
  const any = vm.profile.some((p) => p.n > 0);
  return (
    <Card title="Delivered by weekday" subtitle={`Average per closed day in the range${WEEKDAY_LONG[vm.todayWd] && vm.todayWd <= 5 ? ` · ${WEEKDAY_LONG[vm.todayWd]} is today` : ''}`}>
      {vm.firstLoad ? <ChartSkeleton height={100} /> : any ? <WeekdayBars profile={vm.profile} todayWeekday={vm.todayWd} /> : <EmptyNote text="No closed days in this range yet." />}
    </Card>
  );
}

function EmptyNote({ text }) {
  return <p className="py-6 text-center text-sm text-zinc-400">{text}</p>;
}

// ── the rows ──────────────────────────────────────────────────────────────────

function TableCard({ vm, act, dimmed }) {
  const days = vm.tableMode === 'days';
  const n = days ? vm.dayCount : vm.routeCount;
  const pg = vm.page;
  const routeDayLabel = vm.routeDate ? dayLabel(vm.routeDate, vm.today) : null;
  const footer = (
    <Pager
      page={pg.page} pages={pg.pages} total={pg.total} first={pg.first} last={pg.last} size={vm.pageSize}
      onPage={act.setPage} onSize={act.setPageSize} noun={days ? 'days' : 'routes'}
    />
  );
  const searching = !!vm.query.trim();
  return (
    <Card
      title={days ? 'Days' : `Routes${routeDayLabel ? ` · ${routeDayLabel}` : ''}`}
      subtitle={days
        ? `Every day in the range${vm.weekdays.size < 5 ? ' on the weekdays chosen' : ''} — tick a day to draw it on the pace chart or act on it`
        : vm.routeDate === vm.today
          ? 'Today’s board as it stands, lowest share done first — the route furthest behind is the first row'
          : 'That day as it was sealed, lowest share done first'}
      bodyClassName="p-0"
      actions={(
        <>
          <Segmented label="Rows" value={vm.tableMode} onChange={act.setTableMode}
            options={[{ value: 'days', label: <span className="inline-flex items-center gap-1.5"><CalendarDays size={13} aria-hidden="true" />Days</span> }, { value: 'routes', label: <span className="inline-flex items-center gap-1.5"><Truck size={13} aria-hidden="true" />Routes</span> }]} />
          {!days ? (
            <label className="inline-flex items-center gap-2 text-xs text-zinc-400">
              <span>Day</span>
              <select
                value={vm.routeDate || ''} onChange={(e) => act.setRoutesDay(e.target.value || null)}
                className="h-8 rounded-md border border-zinc-800 bg-zinc-900 px-2 font-mono text-[12.5px] text-zinc-100 outline-none focus:border-zinc-600"
              >
                {vm.routeDate && !vm.dayOptions.some((o) => o.date === vm.routeDate) ? <option value={vm.routeDate}>{routeDayLabel}</option> : null}
                {vm.dayOptions.map((o) => <option key={o.date} value={o.date}>{o.label}</option>)}
              </select>
            </label>
          ) : null}
          <span className="font-mono text-xs tabular-nums text-zinc-400">{fmtCount(n)} {days ? (n === 1 ? 'day' : 'days') : (n === 1 ? 'route' : 'routes')}{searching ? ' found' : ''}</span>
        </>
      )}
    >
      {days && vm.selected.size ? <BulkBar vm={vm} act={act} /> : null}
      {days ? (
        <DaysTable
          rows={pg.rows} sort={vm.sort} onSort={act.sortBy}
          selected={vm.selected} onToggle={act.toggleRow} onToggleAll={act.toggleRows}
          loading={vm.loading} dimmed={dimmed} onAction={act.onDayAction}
          emptyText={searching ? `No day matches “${vm.query.trim()}”.` : 'No days in this range and these weekdays yet.'}
          onReset={searching || vm.facetCount ? act.resetFilters : null}
          footer={footer}
        />
      ) : (
        <RoutesTable
          rows={pg.rows} sort={vm.sort} onSort={act.sortBy}
          loading={vm.routeLoading || (vm.loading && !vm.routeDigest)} dimmed={dimmed} onAction={act.onRouteAction}
          emptyText={vm.routeError ? `That day could not be read: ${vm.routeError}`
            : !vm.routeDate ? 'Pick a day to see its routes.'
              : searching ? `No route or driver matches “${vm.query.trim()}”.`
                : vm.routeDigest ? 'No routes on that day’s board.' : 'That day is not built yet — the History card builds it.'}
          onReset={searching ? () => act.setQuery('') : null}
          footer={footer}
        />
      )}
    </Card>
  );
}

/** What the ticked days can be DONE with, above the rows they are ticked in. */
function BulkBar({ vm, act }) {
  const n = vm.selected.size;
  const anyLeftOut = [...vm.selected].some((d) => vm.leftOut.has(d));
  const anyIn = [...vm.selected].some((d) => d !== vm.today && !vm.leftOut.has(d));
  return (
    <div role="region" aria-label="Ticked days" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 bg-indigo-400/[0.06] px-4 py-2 text-[13px]">
      <span className="font-medium text-zinc-100">{n} day{n === 1 ? '' : 's'} ticked</span>
      <span className="text-xs text-zinc-400">{n > 2 ? 'the newest two are drawn on the pace chart' : 'drawn on the pace chart'}</span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {anyIn ? <ToolbarButton onClick={act.leaveOutSelected}><EyeOff size={13} aria-hidden="true" /> Leave out of the typical day</ToolbarButton> : null}
        {anyLeftOut ? <ToolbarButton onClick={act.putBackSelected}><Eye size={13} aria-hidden="true" /> Put back</ToolbarButton> : null}
        <ToolbarButton onClick={act.copySelected}><Copy size={13} aria-hidden="true" /> Copy {n === 1 ? 'row' : 'rows'}</ToolbarButton>
        <ToolbarButton onClick={act.clearSelection}><X size={13} aria-hidden="true" /> Clear</ToolbarButton>
      </div>
    </div>
  );
}
