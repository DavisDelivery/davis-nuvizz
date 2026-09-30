// src/performance/PerformanceScreen.jsx — More → Performance.
//
// Chad, 2026-09-30: "I wanted to build a stock performance UI under the more tab in the dispatch
// map. And I wanted to track performance over days, weeks, months … to see how we're performing
// and also like interday to track the number of stops that we've done compared to other days or
// like the daily average at that point in time to let us know if we're behind or ahead of
// schedule."
//
// THIS FILE HOLDS THE STATE AND THE ONE READ; it draws nothing itself. It asks
// stop-performance for the days, the typical-day pool and today's board, turns them into a view
// model with the pure functions in src/lib/stop-pace.js, and hands that to one of TWO views —
// PerformanceDesktop and PerformancePhone — because mobile and desktop are two views here, never
// one layout patched to fit both (CLAUDE.md).
//
// ZERO NuVizz calls, on every path: the endpoint reads Firestore only, and this screen reads the
// endpoint. It is lazy-loaded (App.jsx), so none of it is in the start-up file.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import apiFetch from '../lib/api.js';
import {
  presetRange, previousRange, rangeLabel, periodTotals, pctChange, aggregateDays, movingAverage, chooseBaseline,
  baselineBands, paceNow, outcomeMix, weekdayProfile, dayRows, routeRows, searchRows, sortRows, paginate,
  weekdayOf, dayLabel, parseLeftOut, cumulative, fmtClock, fmtCount, fmtShare, fmtSigned, fmtPctChange, fmtPoints,
  paceWords, freshnessLine, rangeIsStale, etMinuteOf, lowerFirst, WEEKDAY_LONG,
} from '../lib/stop-pace.js';
import { C } from './theme.js';
import PerformanceDesktop from './PerformanceDesktop.jsx';
import PerformancePhone from './PerformancePhone.jsx';

const ENDPOINT = '/.netlify/functions/stop-performance';
const REBUILD = '/.netlify/functions/stop-pace-rebuild';
/** Today's deliveries reach the board with each completed pull — every 15 minutes through the
 *  delivery day in the default scan plan (lib/scan-plan.mts, 'done-run'). Three minutes keeps the
 *  screen within one pull of the board without asking for the same answer twenty times an hour.
 *  Every read is Firestore; none of them is a NuVizz call. */
const REFRESH_MS = 3 * 60 * 1000;

const LS = {
  range: 'dd_perf_range', gran: 'dd_perf_granularity', measure: 'dd_perf_measure', typical: 'dd_perf_typical',
  leftOut: 'dd_perf_left_out', pageSize: 'dd_perf_page_size', weekdays: 'dd_perf_weekdays',
};
const readLS = (k, fallback) => { try { const v = window.localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
const writeLS = (k, v) => { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: the setting lasts for this visit */ } };

function etToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The ONE read. Keeps the last good answer while a refresh is in flight, so the frame never blanks. */
function usePerformanceData(from, to) {
  const [state, setState] = useState({ data: null, error: null, loading: true, loadedAt: null, switchedOff: false });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const r = await apiFetch(`${ENDPOINT}?from=${from}&to=${to}&pool=40`);
      const body = await r.json().catch(() => null);
      if (my !== seq.current) return;
      if (!r.ok || !body?.ok) {
        setState((s) => ({ ...s, loading: false, error: body?.error || `The server answered ${r.status}.`, switchedOff: !!body?.switchedOff }));
        return;
      }
      setState({ data: body, error: null, loading: false, loadedAt: new Date(), switchedOff: false });
    } catch (e) {
      if (my !== seq.current) return;
      setState((s) => ({ ...s, loading: false, error: String(e?.message || e) }));
    }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);
  return { ...state, reload: load };
}

/** One day's whole digest (curve + route rows), fetched once and remembered for the visit. */
function useDayDetails() {
  const cache = useRef(new Map());
  const [version, setVersion] = useState(0);
  const ensure = useCallback(async (date) => {
    if (!date || cache.current.has(date)) return;
    cache.current.set(date, { loading: true });
    setVersion((v) => v + 1);
    try {
      const r = await apiFetch(`${ENDPOINT}?detailOnly=1&day=${date}`);
      const body = await r.json().catch(() => null);
      cache.current.set(date, r.ok && body?.ok ? { detail: body.detail || null } : { error: body?.error || `The server answered ${r.status}.` });
    } catch (e) {
      cache.current.set(date, { error: String(e?.message || e) });
    }
    setVersion((v) => v + 1);
  }, []);
  const get = useCallback((date) => cache.current.get(date) || null, []);
  const forget = useCallback(() => { cache.current.clear(); setVersion((v) => v + 1); }, []);
  return { ensure, get, forget, version };
}

const DEFAULT_SORT = { days: { key: 'date', dir: 'desc' }, routes: { key: 'share', dir: 'asc' } };

export default function PerformanceScreen({ isMobile = false, canBuild = false }) {
  // ── what Chad chose ───────────────────────────────────────────────────────
  const [selection, setSelection] = useState(() => {
    const v = readLS(LS.range, null);
    return v && typeof v.id === 'string' ? v : { id: '30d', custom: {} };
  });
  const [gran, setGran] = useState(() => (['day', 'week', 'month'].includes(readLS(LS.gran, 'day')) ? readLS(LS.gran, 'day') : 'day'));
  const [measure, setMeasure] = useState(() => (readLS(LS.measure, 'stops') === 'share' ? 'share' : 'stops'));
  const [typical, setTypical] = useState(() => (readLS(LS.typical, 'weekday') === 'recent' ? 'recent' : 'weekday'));
  const [leftOut, setLeftOut] = useState(() => parseLeftOut(JSON.stringify(readLS(LS.leftOut, []))));
  const [weekdays, setWeekdays] = useState(() => {
    const v = readLS(LS.weekdays, [1, 2, 3, 4, 5]);
    const s = new Set((Array.isArray(v) ? v : []).filter((w) => w >= 1 && w <= 5));
    return s.size ? s : new Set([1, 2, 3, 4, 5]);
  });
  const [pageSize, setPageSize] = useState(() => ([10, 25, 50, 100].includes(readLS(LS.pageSize, 25)) ? readLS(LS.pageSize, 25) : 25));
  const [query, setQuery] = useState('');
  const [tableMode, setTableMode] = useState('days');
  const [routesDay, setRoutesDay] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [sorts, setSorts] = useState(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [paceView, setPaceView] = useState('chart');
  const [trendView, setTrendView] = useState('chart');
  const [toast, setToast] = useState(null);
  const [build, setBuild] = useState(null);   // { running, built, remaining, failed, error }

  useEffect(() => { writeLS(LS.range, selection); }, [selection]);
  useEffect(() => { writeLS(LS.gran, gran); }, [gran]);
  useEffect(() => { writeLS(LS.measure, measure); }, [measure]);
  useEffect(() => { writeLS(LS.typical, typical); }, [typical]);
  useEffect(() => { writeLS(LS.leftOut, [...leftOut].sort()); }, [leftOut]);
  useEffect(() => { writeLS(LS.weekdays, [...weekdays].sort()); }, [weekdays]);
  useEffect(() => { writeLS(LS.pageSize, pageSize); }, [pageSize]);
  useEffect(() => { setPage(1); }, [query, tableMode, routesDay, pageSize, selection, weekdays, sorts]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // ── the read ──────────────────────────────────────────────────────────────
  const clientToday = etToday();
  const range = presetRange(selection.id, clientToday, selection.custom) || presetRange('30d', clientToday);
  const prev = previousRange(range.from, range.to);
  const { data, error, loading, loadedAt, switchedOff, reload } = usePerformanceData(prev.from, range.to);
  const details = useDayDetails();
  const today = data?.today || clientToday;

  // ── the view model ────────────────────────────────────────────────────────
  const vm = useMemo(() => {
    const days = Array.isArray(data?.days) ? data.days : [];
    const wdOf = (d) => d.weekday ?? weekdayOf(d.date);
    const facet = (d) => weekdays.has(wdOf(d));
    const inRange = days.filter((d) => d.date >= range.from && d.date <= range.to && facet(d));
    const closed = inRange.filter((d) => d.source !== 'live');
    const inPrev = days.filter((d) => d.date >= prev.from && d.date <= prev.to && facet(d) && d.source !== 'live');
    const cur = periodTotals(closed);
    const before = periodTotals(inPrev);
    const coverage = data?.coverage || { missing: [], uncaptured: [], noBoard: [], sealed: 0, built: 0 };
    const missingInRange = (coverage.missing || []).filter((d) => d >= range.from && d <= range.to && weekdays.has(weekdayOf(d)));
    const trend = aggregateDays(inRange, gran, { today, missing: missingInRange });
    const avgWindow = gran === 'day' ? 5 : gran === 'week' ? 4 : 3;
    const average = movingAverage(trend.map((b) => (b.partial || b.gaps ? null : b.delivered)), avgWindow);

    const live = data?.live || null;
    const todayWd = weekdayOf(today);
    const base = chooseBaseline(data?.pool || [], { today, weekday: todayWd, mode: typical, excluded: leftOut });
    const bands = baselineBands(base.days);
    const shareBands = baselineBands(base.days, { share: true });
    const pace = paceNow(live, bands, { asOfMinute: live?.asOf?.minute ?? null, nowMinute: data?.now?.minute ?? null, measure, shareBands });
    const typicalLabel = typical === 'weekday' ? `Typical ${WEEKDAY_LONG[todayWd] || 'day'}` : 'Typical weekday';
    const words = paceWords({ pace, measure, typical, typicalLabel, todayWd });

    const poolBy = new Map((data?.pool || []).map((d) => [d.date, d]));
    const selectedDates = [...selected].sort().reverse();
    const overlays = [];
    for (const date of selectedDates) {
      if (overlays.length >= 2) break;
      if (date === today) continue;
      const src = poolBy.get(date) || details.get(date)?.detail;
      if (src?.curve) overlays.push({ date, label: dayLabel(date, today), curve: src.curve, gradable: src.gradable, color: C.overlays[overlays.length] });
    }

    // Tiles
    const liveShare = live && live.gradable > 0 ? live.delivered / live.gradable : null;
    const counted = pace.bucket != null && pace.bucket >= 0 && live ? cumulative(live.curve)[pace.bucket] : null;
    const sparkToday = live ? (() => {
      const cum = cumulative(live.curve);
      const to = pace.bucket != null && pace.bucket >= 0 ? pace.bucket : -1;
      const out = [];
      for (let b = Math.max(0, to - 23 * 6); b <= to; b += 6) out.push(cum[b]);
      return out;
    })() : [];
    const judged = ['ahead', 'on-pace', 'behind'].includes(pace.status);
    const tiles = {
      today: {
        label: 'Delivered today',
        value: live ? fmtCount(live.delivered) : '—',
        status: live ? pace.status : 'no-board',
        delta: judged && pace.delta != null
          ? { text: `${fmtSigned(pace.delta)} (${fmtPctChange(pace.deltaPct)})`, tone: pace.delta >= 0 ? 'good' : 'bad', up: pace.delta >= 0, against: `vs ${lowerFirst(typicalLabel)} by ${fmtClock(pace.atMinute)}` }
          : null,
        sub: !live ? (data?.liveNote === 'no board for today' ? 'No board for today.' : null)
          : pace.status === 'insufficient' ? words.note
            : `${fmtCount(live.gradable)} planned${counted != null ? ` · ${fmtCount(counted)} by ${fmtClock(pace.atMinute)}, the minute the pace is judged at` : ''}${live.untimed ? ` · ${fmtCount(live.untimed)} with no time` : ''}`,
        spark: sparkToday,
      },
      board: {
        label: 'Today’s board done',
        value: liveShare != null ? fmtShare(liveShare).replace('%', '') : '—',
        unit: liveShare != null ? '%' : null,
        delta: judged && pace.shareDelta != null
          ? { text: fmtPoints(pace.shareDelta), tone: pace.shareDelta >= 0 ? 'good' : 'bad', up: pace.shareDelta >= 0, against: `vs ${fmtShare(pace.shareMedian)} typical by ${fmtClock(pace.atMinute)}` }
          : null,
        sub: live ? `${fmtCount(live.open)} open · ${fmtCount(live.counts?.in_flight)} on the road or on site · ${fmtCount(live.counts?.unable)} unable` : null,
      },
      perDay: {
        label: 'Delivered per day',
        value: cur.perDay != null ? fmtCount(cur.perDay) : '—',
        delta: cur.perDay != null && before.perDay != null
          ? { text: fmtPctChange(pctChange(cur.perDay, before.perDay)), tone: cur.perDay >= before.perDay ? 'good' : 'bad', up: cur.perDay >= before.perDay, against: `vs ${rangeLabel(prev.from, prev.to)}` }
          : null,
        sub: cur.days ? `${fmtCount(cur.delivered)} over ${cur.days} closed day${cur.days === 1 ? '' : 's'}${inRange.some((d) => d.source === 'live') ? ' — today not counted until it closes' : ''}` : 'No closed days in this range yet.',
        spark: closed.map((d) => d.delivered),
      },
      completion: {
        label: 'Completed',
        value: cur.completionRate != null ? fmtShare(cur.completionRate).replace('%', '') : '—',
        unit: cur.completionRate != null ? '%' : null,
        delta: cur.completionRate != null && before.completionRate != null
          ? { text: fmtPoints(cur.completionRate - before.completionRate), tone: cur.completionRate >= before.completionRate ? 'good' : 'bad', up: cur.completionRate >= before.completionRate, against: `vs ${rangeLabel(prev.from, prev.to)}` }
          : null,
        sub: cur.days ? `${fmtShare(cur.manualRate)} closed by hand · ${fmtCount(cur.unable)} unable · ${fmtCount(cur.open)} left open` : null,
        spark: closed.map((d) => d.completionRate),
      },
    };

    // Tables
    const dayAll = dayRows(inRange, { excluded: leftOut, today });
    const dayFound = searchRows(dayAll.map((r) => ({ ...r, weekdayName: WEEKDAY_LONG[r.weekday] || '' })), query, ['label', 'date', 'weekdayName']);
    const daySorted = sortRows(dayFound, sorts.days.key, sorts.days.dir);
    const routeDate = routesDay || (live ? today : [...inRange].reverse().find((d) => d.source !== 'live')?.date || null);
    const routeSrc = routeDate === today ? { detail: live, loading: false } : details.get(routeDate);
    const routeDigest = routeSrc?.detail || null;
    const fleetShare = routeDigest && routeDigest.gradable > 0 ? routeDigest.delivered / routeDigest.gradable : null;
    const routeAll = routeRows(routeDigest, { fleetShare });
    const routeFound = searchRows(routeAll, query, ['route', 'driver']);
    const routeSorted = sortRows(routeFound, sorts.routes.key, sorts.routes.dir);
    const activeRows = tableMode === 'days' ? daySorted : routeSorted;
    // The phone lists CARDS, ten to a page, whatever the desktop's rows-per-page is set to: 25 cards is
    // four thousand pixels of thumb before the next section.
    const pg = paginate(activeRows, page, isMobile ? Math.min(pageSize, 10) : pageSize);
    const readAt = loadedAt ? fmtClock(etMinuteOf(loadedAt)) : null;

    const facetCount = (weekdays.size < 5 ? 1 : 0) + (typical !== 'weekday' ? 1 : 0) + (measure !== 'stops' ? 1 : 0) + (leftOut.size ? 1 : 0);

    return {
      today, range, prev, selection, gran, measure, typical, weekdays, leftOut, query, tableMode, routeDate, selected,
      sort: sorts[tableMode], page: pg, pageSize, filtersOpen, dateOpen, paceView, trendView, facetCount,
      data, loading, error, loadedAt, switchedOff, firstLoad: loading && !data,
      live, pace, bands: measure === 'share' ? shareBands : bands, base, typicalLabel, overlays, selectedDates,
      words,
      readAt,
      freshness: freshnessLine({ live, hasData: !!data, readAt, short: isMobile }),
      stale: rangeIsStale({ loading, served: data?.range || null, range, prev }),
      tiles, trend, average, averageLabel: `${avgWindow}-${gran} average`, mix: outcomeMix(closed),
      profile: weekdayProfile(closed).filter((p) => weekdays.has(p.weekday)), todayWd,
      coverage, missingInRange, dayCount: dayFound.length, routeCount: routeFound.length,
      routeLoading: !!routeSrc?.loading, routeError: routeSrc?.error || null, routeDigest,
      dayOptions: [...inRange].reverse().map((d) => ({ date: d.date, label: dayLabel(d.date, today) + (d.source === 'live' ? ' (today)' : '') })),
      excludedRoutes: data?.excludedRoutes || [],
      canBuild, build, toast,
    };
  }, [data, loading, error, loadedAt, switchedOff, range.from, range.to, prev.from, prev.to, selection, gran, measure, typical, weekdays,
    leftOut, query, tableMode, routesDay, selected, sorts, page, pageSize, filtersOpen, dateOpen, paceView, trendView, details.version, today, canBuild, build, toast, isMobile]);

  // Fetch what the view needs and does not have: a past day's routes, an overlay older than the pool.
  const ensureDetail = details.ensure;
  useEffect(() => {
    if (tableMode === 'routes' && vm.routeDate && vm.routeDate !== today) ensureDetail(vm.routeDate);
  }, [tableMode, vm.routeDate, today, ensureDetail]);
  useEffect(() => {
    const poolBy = new Set((data?.pool || []).map((d) => d.date));
    for (const d of [...selected].sort().reverse().slice(0, 2)) if (d !== today && !poolBy.has(d)) ensureDetail(d);
  }, [selected, data, today, ensureDetail]);

  // ── what Chad does ────────────────────────────────────────────────────────
  const copy = useCallback(async (text, what) => {
    try { await navigator.clipboard.writeText(text); setToast(`Copied ${what}`); } catch { setToast('This browser would not let the page copy'); }
  }, []);
  const tsvOfDays = (rows) => [
    ['Day', 'Planned', 'Delivered', 'Done', 'By hand', 'Unable', 'Open', 'First', 'Half done', 'Last'].join('\t'),
    ...rows.map((r) => [r.date, r.planned ?? '', r.delivered ?? '', fmtShare(r.completionRate), r.manual, r.unable, r.open ?? '', fmtClock(r.firstMin), fmtClock(r.halfMin), fmtClock(r.lastMin)].join('\t')),
  ].join('\n');

  const actions = {
    setSelection: (s) => { setSelection(s); setSelected(new Set()); },
    setGran, setMeasure, setTypical, setQuery, setPageSize,
    setPage,
    setTableMode: (m) => { setTableMode(m); },
    setRoutesDay: (d) => { setRoutesDay(d); },
    setFiltersOpen: (v) => { setFiltersOpen(typeof v === 'function' ? v(filtersOpen) : v); setDateOpen(false); },
    setDateOpen: (v) => { setDateOpen(v); if (v) setFiltersOpen(false); },
    setPaceView, setTrendView,
    reload: () => { details.forget(); reload(); },
    toggleWeekday: (w) => setWeekdays((s) => { const n = new Set(s); if (n.has(w)) { if (n.size > 1) n.delete(w); } else n.add(w); return n; }),
    putBack: (d) => setLeftOut((s) => { const n = new Set(s); n.delete(d); return n; }),
    putAllBack: () => setLeftOut(new Set()),
    resetFilters: () => { setWeekdays(new Set([1, 2, 3, 4, 5])); setTypical('weekday'); setMeasure('stops'); setLeftOut(new Set()); setQuery(''); },
    sortBy: (key) => setSorts((s) => {
      const curS = s[tableMode];
      const dir = curS.key === key ? (curS.dir === 'asc' ? 'desc' : 'asc') : (key === 'date' || key === 'delivered' ? 'desc' : 'asc');
      return { ...s, [tableMode]: { key, dir } };
    }),
    // The phone sorts from one list of named orders ("Furthest behind"), so it sets both halves at once.
    setSort: (key, dir) => setSorts((s) => ({ ...s, [tableMode]: { key, dir: dir === 'desc' ? 'desc' : 'asc' } })),
    toggleRow: (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    toggleRows: (ids, on) => setSelected((s) => { const n = new Set(s); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; }),
    clearSelection: () => setSelected(new Set()),
    leaveOutSelected: () => {
      const n = [...selected].filter((d) => d !== today);
      setLeftOut((s) => new Set([...s, ...n]));
      setToast(`${n.length} day${n.length === 1 ? '' : 's'} left out of the typical day`);
    },
    putBackSelected: () => setLeftOut((s) => { const n = new Set(s); for (const d of selected) n.delete(d); return n; }),
    copySelected: () => {
      const rows = dayRows((data?.days || []).filter((d) => selected.has(d.date)), { today });
      copy(tsvOfDays(sortRows(rows, 'date', 'desc')), `${rows.length} day${rows.length === 1 ? '' : 's'}`);
    },
    onDayAction: (action, r) => {
      if (action === 'toggle-select') setSelected((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; });
      else if (action === 'routes') { setRoutesDay(r.date); setTableMode('routes'); setQuery(''); }
      else if (action === 'leave-out') { setLeftOut((s) => new Set([...s, r.date])); setToast(`${r.label} left out of the typical day`); }
      else if (action === 'put-back') setLeftOut((s) => { const n = new Set(s); n.delete(r.date); return n; });
      else if (action === 'copy') copy(tsvOfDays([r]), r.label);
    },
    onRouteAction: (action, r) => {
      if (action === 'search') setQuery(r.driver || r.route);
      else if (action === 'copy') {
        copy([
          ['Route', 'Driver', 'Stops', 'Delivered', 'Open', 'Unable', 'Done', 'First', 'Last', 'Per hour'].join('\t'),
          [r.route, r.driver || '', r.planned, r.delivered, r.open, r.unable, fmtShare(r.share), fmtClock(r.firstMin), fmtClock(r.lastMin), r.perHour != null ? r.perHour.toFixed(1) : ''].join('\t'),
        ].join('\n'), r.route);
      }
    },
    // BUILD HISTORY — the rebuild endpoint, ten days a call, until nothing is left or nothing moves.
    buildHistory: async () => {
      setBuild({ running: true, built: 0, remaining: null, failed: 0, error: null });
      let built = 0; let failed = 0; let remaining = null;
      try {
        for (let i = 0; i < 40; i++) {
          const r = await apiFetch(`${REBUILD}?missing=1`);
          const body = await r.json().catch(() => null);
          if (!r.ok && !body?.built?.length) throw new Error(body?.error || `The rebuild answered ${r.status}.`);
          const n = (body?.built || []).length;
          built += n; failed += (body?.failed || []).length; remaining = body?.remaining ?? null;
          setBuild({ running: true, built, remaining, failed, error: null });
          if (!body?.planned?.length || remaining === 0 || n === 0) break;
        }
        setBuild({ running: false, built, remaining, failed, error: null });
        // SAID FROM THE ANSWER, never from the press: the count is what the endpoint reports it wrote.
        setToast(built ? `Built ${built} day${built === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}` : 'Nothing was left to build');
        details.forget();
        reload();
      } catch (e) {
        setBuild({ running: false, built, remaining, failed, error: String(e?.message || e) });
      }
    },
  };

  return isMobile ? <PerformancePhone vm={vm} act={actions} /> : <PerformanceDesktop vm={vm} act={actions} />;
}

