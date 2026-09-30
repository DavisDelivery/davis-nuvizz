// src/performance/charts.jsx — the Performance screen's charts, drawn in plain SVG.
//
// No chart library: the app carries none, and the three shapes here (a running-total line over a
// band, a column trend, a thin stacked meter) are a few hundred lines of SVG that can be read and
// tested, against a dependency and its bundle weight. Every chart:
//
//   • is drawn in PIXELS off the width it actually has (useWidth), so text, dots and 2px lines stay
//     crisp and round at any size — the stretched-viewBox trick turns circles into lozenges, which
//     is how the completion chart's worst-day marker first shipped (v0.68.2);
//   • has a hover layer — a crosshair that snaps to the nearest bucket on the line chart, the bar
//     itself as the target on the columns — and the same readout from the keyboard;
//   • has a table twin (PaceTable, and the Days table under the trend), because a tooltip may
//     never be the only way to read a value (dataviz: tooltips enhance, they never gate).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { C } from './theme.js';
import {
  BUCKETS, BUCKET_MIN, cumulative, fmtClock, fmtCount, fmtShare, lowerFirst, WEEKDAY_SHORT,
} from '../lib/stop-pace.js';

/** The rendered width of an element, kept current as the layout changes. */
export function useWidth(ref, fallback = 640) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setW(Math.max(160, Math.round(r.width)));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Clean axis ticks from 0 to at least `max`: 0 / 200 / 400 / 600, never 0 / 173 / 346. */
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const top = Math.ceil(max / step) * step;
  const out = [];
  for (let v = 0; v <= top + step / 1000; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

const pctTick = (v) => `${Math.round(v * 100)}%`;

/**
 * The left margin an axis needs for its OWN labels: 10.5px monospace is ~6.4px a character, plus the
 * 8px gap to the plot and a little air. A fixed margin clipped "1,500" to ",500" on a phone.
 */
const axisPad = (labels, floor) => Math.max(floor, Math.ceil(Math.max(0, ...labels.map((t) => String(t).length)) * 6.4) + 14);

// ── the day's pace: a running total against the typical band ───────────────────

function firstIndex(arr, pred) { for (let i = 0; i < arr.length; i++) if (pred(arr[i], i)) return i; return null; }
function lastIndex(arr, pred) { for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i], i)) return i; return null; }

/**
 * THE WINDOW OF THE DAY WORTH DRAWING — from the hour before anything typically starts to the
 * hour after it typically stops, widened to take in today and any overlay. A fixed 6a–8p would
 * cut off the evening hand-closes on one day and waste a third of the width on another.
 */
export function paceWindow(series) {
  let first = null; let last = null;
  for (const s of series) {
    if (!s) continue;
    const f = firstIndex(s, (v) => v > 0);
    const l = lastIndex(s, (v, i) => i > 0 && v > s[i - 1]);
    if (f != null) first = first == null ? f : Math.min(first, f);
    if (l != null) last = last == null ? l : Math.max(last, l);
  }
  const startMin = first == null ? 6 * 60 : Math.max(0, Math.floor((first * BUCKET_MIN - 30) / 60) * 60);
  let endMin = last == null ? 19 * 60 : Math.min(24 * 60, Math.ceil(((last + 1) * BUCKET_MIN + 30) / 60) * 60);
  if (endMin - startMin < 8 * 60) endMin = Math.min(24 * 60, startMin + 8 * 60);
  return { startMin, endMin };
}

/**
 * @param live       today's digest (curve, gradable) or null
 * @param bands      baselineBands(...) in the measure being drawn
 * @param share      true to draw each day as a share of its own board
 * @param overlays   [{ date, label, curve, gradable, color }] — at most two
 * @param asOfBucket the last whole bucket today's board knows (paceNow().bucket)
 * @param typicalLabel "Typical Tuesday"
 */
export function PaceChart({ live, bands, share = false, overlays = [], asOfBucket = null, typicalLabel = 'Typical day', height = 280, compact = false, dimmed = false }) {
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef, compact ? 340 : 760);
  const [hover, setHover] = useState(null);   // bucket index under the pointer / keyboard

  const todayCum = useMemo(() => (live ? cumulative(live.curve) : null), [live]);
  const overlaySeries = useMemo(() => overlays.map((o) => ({ ...o, cum: cumulative(o.curve) })), [overlays]);
  const todayVals = useMemo(
    () => (todayCum ? todayCum.map((v) => (share ? (live?.gradable > 0 ? v / live.gradable : null) : v)) : null),
    [todayCum, live, share],
  );
  const overlayVals = useMemo(
    () => overlaySeries.map((o) => ({ ...o, vals: o.cum.map((v) => (share ? (o.gradable > 0 ? v / o.gradable : null) : v)) })),
    [overlaySeries, share],
  );

  const { startMin, endMin } = useMemo(
    () => paceWindow([bands?.p75, bands?.median, todayVals && asOfBucket != null ? todayVals.slice(0, asOfBucket + 1) : null, ...overlayVals.map((o) => o.vals)]),
    [bands, todayVals, asOfBucket, overlayVals],
  );

  const startB = Math.max(0, Math.floor(startMin / BUCKET_MIN) - 1);
  const endB = Math.min(BUCKETS - 1, Math.ceil(endMin / BUCKET_MIN) - 1);

  let yMax = share ? 1 : 0;
  if (!share) {
    const at = (arr) => (arr ? Math.max(0, ...arr.slice(startB, endB + 1).map((v) => v || 0)) : 0);
    yMax = Math.max(at(bands?.p75), at(todayVals && asOfBucket != null ? todayVals.slice(0, asOfBucket + 1) : null), ...overlayVals.map((o) => at(o.vals)), 10);
  }
  const ticks = share ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(yMax, 5);
  const top = ticks[ticks.length - 1];
  const tickText = (t) => (share ? pctTick(t) : fmtCount(t));

  const pad = { l: axisPad(ticks.map(tickText), compact ? 30 : 40), r: compact ? 14 : 58, t: 14, b: 24 };
  const W = width; const H = height;
  const iw = Math.max(40, W - pad.l - pad.r);
  const ih = Math.max(40, H - pad.t - pad.b);

  // A bucket's running total is reached at the END of the bucket.
  const xOfMin = (m) => pad.l + ((m - startMin) / (endMin - startMin)) * iw;
  const xOfB = (b) => xOfMin((b + 1) * BUCKET_MIN);
  const y = (v) => pad.t + (1 - Math.min(1, Math.max(0, (v || 0) / top))) * ih;

  const pathOf = (vals, from, to) => {
    if (!vals) return '';
    let d = '';
    for (let b = from; b <= to; b++) {
      const v = vals[b];
      if (v == null || !Number.isFinite(v)) continue;
      d += `${d ? 'L' : 'M'}${xOfB(b).toFixed(1)},${y(v).toFixed(1)}`;
    }
    return d;
  };
  let bandPath = '';
  if (bands?.n) {
    let up = ''; let down = '';
    for (let b = startB; b <= endB; b++) {
      if (bands.p75[b] == null) continue;
      up += `${up ? 'L' : 'M'}${xOfB(b).toFixed(1)},${y(bands.p75[b]).toFixed(1)}`;
    }
    for (let b = endB; b >= startB; b--) {
      if (bands.p25[b] == null) continue;
      down += `L${xOfB(b).toFixed(1)},${y(bands.p25[b]).toFixed(1)}`;
    }
    bandPath = up ? `${up}${down}Z` : '';
  }

  const todayTo = asOfBucket != null ? Math.min(asOfBucket, endB) : null;
  const todayPath = todayVals && todayTo != null && todayTo >= startB ? pathOf(todayVals, startB, todayTo) : '';
  const todayArea = todayPath ? `${todayPath}L${xOfB(todayTo).toFixed(1)},${y(0).toFixed(1)}L${xOfB(startB).toFixed(1)},${y(0).toFixed(1)}Z` : '';
  const todayEnd = todayVals && todayTo != null && todayTo >= startB ? todayVals[todayTo] : null;

  const hourTicks = [];
  const stepH = compact ? 3 : (endMin - startMin) > 12 * 60 ? 2 : 1;
  for (let m = Math.ceil(startMin / 60) * 60; m <= endMin; m += stepH * 60) hourTicks.push(m);

  const fmtV = (v) => (v == null ? '—' : share ? fmtShare(v) : fmtCount(v));

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const m = startMin + ((px - pad.l) / iw) * (endMin - startMin);
    const b = Math.round(m / BUCKET_MIN) - 1;
    setHover(Math.max(startB, Math.min(endB, b)));
  };
  const onKey = (e) => {
    const step = e.shiftKey ? 12 : 1;
    const cur = hover ?? (todayTo ?? startB);
    if (e.key === 'ArrowRight') { e.preventDefault(); setHover(Math.min(endB, cur + step)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setHover(Math.max(startB, cur - step)); }
    else if (e.key === 'Home') { e.preventDefault(); setHover(startB); }
    else if (e.key === 'End') { e.preventDefault(); setHover(endB); }
    else if (e.key === 'Escape') setHover(null);
  };

  const hv = hover != null ? {
    b: hover,
    minute: (hover + 1) * BUCKET_MIN - 1,
    today: todayVals && todayTo != null && hover <= todayTo ? todayVals[hover] : null,
    median: bands?.median?.[hover] ?? null,
    lo: bands?.p25?.[hover] ?? null,
    hi: bands?.p75?.[hover] ?? null,
    overlays: overlayVals.map((o) => ({ label: o.label, color: o.color, v: o.vals[hover] })),
  } : null;
  const tipLeft = hv ? xOfB(hv.b) : 0;
  const tipOnLeft = hv && tipLeft > W - 190;

  const summary = [
    todayEnd != null ? `Today ${fmtV(todayEnd)} by ${fmtClock((todayTo + 1) * BUCKET_MIN - 1)}` : 'No deliveries recorded today yet',
    todayTo != null && bands?.median?.[todayTo] != null ? `${lowerFirst(typicalLabel)} ${fmtV(bands.median[todayTo])}, middle half ${fmtV(bands.p25[todayTo])} to ${fmtV(bands.p75[todayTo])}` : null,
  ].filter(Boolean).join('; ');

  return (
    <div className={`transition-opacity duration-300 ${dimmed ? 'opacity-60' : 'opacity-100'}`}>
      <PaceLegend typicalLabel={typicalLabel} n={bands?.n || 0} overlays={overlays} hasToday={!!todayPath} compact={compact} />
      <div
        ref={wrapRef}
        className="relative mt-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 touch-pan-y"
        style={{ height: H }}
        tabIndex={0}
        role="group"
        aria-label={`Delivered stops by time of day. ${summary}. Arrow keys move along the day.`}
        onPointerMove={onMove}
        onPointerDown={onMove}
        // A FINGER LIFTING is a pointerleave too, and clearing on it would hide the readout the tap
        // just asked for. On touch the readout stays until the next tap elsewhere (onBlur).
        onPointerLeave={(e) => { if (e.pointerType !== 'touch') setHover(null); }}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <svg width={W} height={H} className="block" role="img" aria-label={summary}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? C.axis : C.hairline} strokeWidth="1" shapeRendering="crispEdges" />
              <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10.5" fill={C.ink2} className="font-mono tabular-nums">{tickText(t)}</text>
            </g>
          ))}
          {hourTicks.map((m) => (
            <text key={m} x={xOfMin(m)} y={H - 6} textAnchor="middle" fontSize="10.5" fill={C.ink2} className="font-mono tabular-nums">{fmtClock(m).replace(':00', '')}</text>
          ))}
          {bandPath && <path d={bandPath} fill={C.band} stroke="none" />}
          {bands?.n > 0 && <path d={pathOf(bands.median, startB, endB)} fill="none" stroke={C.typical} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />}
          {overlayVals.map((o) => (
            <path key={o.date} d={pathOf(o.vals, startB, endB)} fill="none" stroke={o.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {todayArea && <path d={todayArea} fill={C.todayWash} stroke="none" />}
          {todayPath && <path d={todayPath} fill="none" stroke={C.today} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
          {todayTo != null && todayTo >= startB && (
            <g>
              <line x1={xOfB(todayTo)} x2={xOfB(todayTo)} y1={pad.t} y2={H - pad.b} stroke={C.axis} strokeWidth="1" shapeRendering="crispEdges" />
              <circle cx={xOfB(todayTo)} cy={y(todayEnd)} r="4.5" fill={C.today} stroke={C.surface} strokeWidth="2" />
              {!compact && (
                <text x={xOfB(todayTo) + 9} y={y(todayEnd)} dy="0.32em" fontSize="11.5" fontWeight="600" fill={C.ink} className="font-mono tabular-nums">{fmtV(todayEnd)}</text>
              )}
            </g>
          )}
          {hv && (
            <g pointerEvents="none">
              <line x1={xOfB(hv.b)} x2={xOfB(hv.b)} y1={pad.t} y2={H - pad.b} stroke={C.ink2} strokeWidth="1" shapeRendering="crispEdges" />
              {hv.median != null && <circle cx={xOfB(hv.b)} cy={y(hv.median)} r="4" fill={C.typical} stroke={C.surface} strokeWidth="2" />}
              {hv.overlays.map((o) => (o.v != null ? <circle key={o.label} cx={xOfB(hv.b)} cy={y(o.v)} r="4" fill={o.color} stroke={C.surface} strokeWidth="2" /> : null))}
              {hv.today != null && <circle cx={xOfB(hv.b)} cy={y(hv.today)} r="4.5" fill={C.today} stroke={C.surface} strokeWidth="2" />}
            </g>
          )}
        </svg>
        {hv && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[168px] rounded-md border border-zinc-700 bg-zinc-950/95 px-3 py-2 text-xs shadow-lg shadow-black/40"
            style={tipOnLeft ? { right: W - tipLeft + 12 } : { left: tipLeft + 12 }}
          >
            <div className="text-zinc-400">by <span className="font-mono tabular-nums text-zinc-300">{fmtClock(hv.minute)}</span></div>
            <TipRow color={C.today} value={hv.today != null ? fmtV(hv.today) : '—'} label="Today" />
            <TipRow color={C.typical} value={fmtV(hv.median)} label={typicalLabel} />
            <TipRow band value={hv.lo != null ? `${fmtV(hv.lo)}–${fmtV(hv.hi)}` : '—'} label="Middle half" />
            {hv.overlays.map((o) => <TipRow key={o.label} color={o.color} value={fmtV(o.v)} label={o.label} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function TipRow({ color, band = false, value, label }) {
  return (
    <div className="mt-1 flex items-center gap-2">
      {band
        ? <span className="inline-block h-2.5 w-3 rounded-sm" style={{ background: 'rgba(161,161,170,0.35)' }} aria-hidden="true" />
        : <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: color }} aria-hidden="true" />}
      <span className="font-mono tabular-nums font-semibold text-zinc-100">{value}</span>
      <span className="truncate text-zinc-400">{label}</span>
    </div>
  );
}

function PaceLegend({ typicalLabel, n, overlays, hasToday, compact }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${compact ? 'text-[11px]' : 'text-xs'} text-zinc-400`}>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: C.today }} aria-hidden="true" />
        <span className="text-zinc-300">Today{hasToday ? '' : ' (nothing yet)'}</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: C.typical }} aria-hidden="true" />
        <span>{typicalLabel}{n ? `, median of ${n} day${n === 1 ? '' : 's'}` : ''}</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: 'rgba(161,161,170,0.3)' }} aria-hidden="true" />
        <span>Middle half of those days</span>
      </span>
      {overlays.map((o) => (
        <span key={o.date} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: o.color }} aria-hidden="true" />
          <span className="text-zinc-300">{o.label}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * THE PACE CHART'S TABLE TWIN — the same numbers on the hour, so nothing on the chart is only
 * readable by hovering it.
 */
export function PaceTable({ live, bands, share = false, overlays = [], asOfBucket = null }) {
  const todayCum = useMemo(() => (live ? cumulative(live.curve) : null), [live]);
  const overlayCum = useMemo(() => overlays.map((o) => ({ ...o, cum: cumulative(o.curve) })), [overlays]);
  const val = (v, g) => (v == null ? null : share ? (g > 0 ? v / g : null) : v);
  const fmtV = (v) => (v == null ? '—' : share ? fmtShare(v) : fmtCount(v));
  const { startMin, endMin } = paceWindow([bands?.p75, todayCum, ...overlayCum.map((o) => o.cum)]);
  const rows = [];
  for (let m = Math.ceil(startMin / 60) * 60 + 60; m <= endMin; m += 60) {
    const b = m / BUCKET_MIN - 1;
    rows.push({
      m,
      today: todayCum && asOfBucket != null && b <= asOfBucket ? val(todayCum[b], live.gradable) : null,
      median: bands?.median?.[b] ?? null, lo: bands?.p25?.[b] ?? null, hi: bands?.p75?.[b] ?? null,
      ov: overlayCum.map((o) => val(o.cum[b], o.gradable)),
    });
  }
  return (
    <div className="mt-2 overflow-x-auto rounded-md border border-zinc-800">
      <table className="w-full min-w-[420px] text-xs">
        <caption className="sr-only">Delivered by each hour — today, the typical day, and any day overlaid</caption>
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">By</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Today</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Typical</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Middle half</th>
            {overlays.map((o) => <th key={o.date} scope="col" className="px-3 py-2 text-right font-medium">{o.label}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800 font-mono tabular-nums text-zinc-200">
          {rows.map((r) => (
            <tr key={r.m}>
              <td className="px-3 py-1.5 text-zinc-400">{fmtClock(r.m)}</td>
              <td className="px-3 py-1.5 text-right">{fmtV(r.today)}</td>
              <td className="px-3 py-1.5 text-right">{fmtV(r.median)}</td>
              <td className="px-3 py-1.5 text-right text-zinc-400">{r.lo != null ? `${fmtV(r.lo)}–${fmtV(r.hi)}` : '—'}</td>
              {r.ov.map((v, i) => <td key={overlays[i].date} className="px-3 py-1.5 text-right">{fmtV(v)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── the trend: columns per day / week / month ─────────────────────────────────

/**
 * @param buckets   aggregateDays(...) rows
 * @param average   movingAverage(...) aligned to buckets, or null
 * @param unitLabel 'day' | 'week' | 'month' — words for the tooltip
 */
export function TrendChart({ buckets, average = null, averageLabel = null, height = 220, compact = false, dimmed = false, unitLabel = 'day' }) {
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef, compact ? 340 : 760);
  const [hover, setHover] = useState(null);
  const n = buckets.length;
  const max = Math.max(10, ...buckets.map((b) => b.delivered || 0), ...(average || []).map((v) => v || 0));
  const ticks = niceTicks(max, compact ? 4 : 5);
  const top = ticks[ticks.length - 1];
  const pad = { l: axisPad(ticks.map(fmtCount), compact ? 30 : 40), r: 12, t: 12, b: 24 };
  const W = width; const H = height;
  const iw = Math.max(40, W - pad.l - pad.r);
  const ih = Math.max(40, H - pad.t - pad.b);
  const band = n ? iw / n : iw;
  const barW = Math.max(2, Math.min(24, band * 0.66));
  const xc = (i) => pad.l + band * i + band / 2;
  const y = (v) => pad.t + (1 - Math.min(1, Math.max(0, (v || 0) / top))) * ih;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / (compact ? 52 : 64)))));

  // A 4px rounded data-end, square at the baseline.
  const barPath = (x, yTop, w, yBase) => {
    const h = yBase - yTop;
    if (h <= 0.5) return '';
    const r = Math.min(4, w / 2, h);
    return `M${x},${yBase}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBase}Z`;
  };

  let avgPath = '';
  if (average) {
    let pen = false;
    average.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) { pen = false; return; }
      avgPath += `${pen ? 'L' : 'M'}${xc(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
  }
  const hb = hover != null ? buckets[hover] : null;
  const tipLeft = hover != null ? xc(hover) : 0;
  const tipOnLeft = hover != null && tipLeft > W - 200;

  const onKey = (e) => {
    if (!n) return;
    const cur = hover ?? n - 1;
    if (e.key === 'ArrowRight') { e.preventDefault(); setHover(Math.min(n - 1, cur + 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setHover(Math.max(0, cur - 1)); }
    else if (e.key === 'Escape') setHover(null);
  };

  return (
    <div className={`transition-opacity duration-300 ${dimmed ? 'opacity-60' : 'opacity-100'}`}>
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${compact ? 'text-[11px]' : 'text-xs'} text-zinc-400`}>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: C.today }} aria-hidden="true" /><span className="text-zinc-300">Delivered</span></span>
        {averageLabel && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded-full" style={{ background: C.average }} aria-hidden="true" /><span>{averageLabel}</span></span>}
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm border" style={{ borderColor: C.today }} aria-hidden="true" /><span>Still running</span></span>
      </div>
      <div
        ref={wrapRef}
        className="relative mt-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
        style={{ height: H }}
        tabIndex={n ? 0 : -1}
        role="group"
        aria-label={`Delivered stops per ${unitLabel}, ${n} ${unitLabel}${n === 1 ? '' : 's'}. Arrow keys move between them.`}
        onKeyDown={onKey}
        // A FINGER LIFTING is a pointerleave too, and clearing on it would hide the readout the tap
        // just asked for. On touch the readout stays until the next tap elsewhere (onBlur).
        onPointerLeave={(e) => { if (e.pointerType !== 'touch') setHover(null); }}
        onBlur={() => setHover(null)}
      >
        <svg width={W} height={H} className="block" role="img" aria-label={`Delivered per ${unitLabel}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? C.axis : C.hairline} strokeWidth="1" shapeRendering="crispEdges" />
              <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10.5" fill={C.ink2} className="font-mono tabular-nums">{fmtCount(t)}</text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const x = xc(i) - barW / 2;
            const lit = hover === i;
            const d = barPath(x, y(b.delivered), barW, y(0));
            return (
              <g key={b.key}>
                {b.partial
                  ? (d ? <path d={d} fill="none" stroke={C.today} strokeWidth="1.5" opacity={lit ? 1 : 0.85} /> : null)
                  : (d ? <path d={d} fill={C.today} opacity={hover == null || lit ? 1 : 0.55} /> : null)}
                {b.days === 0 && b.gaps > 0 && (
                  <line x1={x} x2={x + barW} y1={y(0) - 2} y2={y(0) - 2} stroke={C.ink2} strokeWidth="2" strokeDasharray="2 2" />
                )}
                {i % labelEvery === 0 && (
                  <text x={xc(i)} y={H - 6} textAnchor="middle" fontSize="10.5" fill={C.ink2} className="font-mono">{shortTick(b, unitLabel)}</text>
                )}
                <rect
                  x={pad.l + band * i} y={pad.t} width={band} height={ih}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                  onPointerDown={() => setHover(i)}
                />
              </g>
            );
          })}
          {avgPath && <path d={avgPath} fill="none" stroke={C.average} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />}
        </svg>
        {hb && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[180px] rounded-md border border-zinc-700 bg-zinc-950/95 px-3 py-2 text-xs shadow-lg shadow-black/40"
            style={tipOnLeft ? { right: W - tipLeft + 14 } : { left: tipLeft + 14 }}
          >
            <div className="text-zinc-300">{hb.label}{hb.partial ? <span className="text-zinc-400"> · still running</span> : null}</div>
            <div className="mt-1 flex items-baseline gap-2"><span className="font-mono tabular-nums text-sm font-semibold text-zinc-100">{fmtCount(hb.delivered)}</span><span className="text-zinc-400">delivered</span></div>
            {unitLabel !== 'day' && <div className="mt-0.5 flex items-baseline gap-2"><span className="font-mono tabular-nums text-zinc-200">{hb.perDay != null ? fmtCount(hb.perDay) : '—'}</span><span className="text-zinc-400">a day, over {hb.days - (hb.partial ? 1 : 0)} closed day{hb.days - (hb.partial ? 1 : 0) === 1 ? '' : 's'}</span></div>}
            <div className="mt-0.5 flex items-baseline gap-2"><span className="font-mono tabular-nums text-zinc-200">{fmtShare(hb.completionRate)}</span><span className="text-zinc-400">completed</span></div>
            {average && average[hover] != null && <div className="mt-0.5 flex items-baseline gap-2"><span className="font-mono tabular-nums text-zinc-200">{fmtCount(average[hover])}</span><span className="text-zinc-400">{averageLabel}</span></div>}
            {hb.gaps > 0 && <div className="mt-1 text-amber-300">{hb.gaps} day{hb.gaps === 1 ? '' : 's'} not built yet — not counted</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function shortTick(b, unit) {
  if (unit === 'month') return b.label.split(' ')[0];
  if (unit === 'week') return b.label.split(/\s[–-]\s/)[0];
  // "Tue Sep 29" → "9/29"
  return `${Number(b.key.slice(5, 7))}/${Number(b.key.slice(8, 10))}`;
}

// ── small multiples of the summary ────────────────────────────────────────────

/** A tile's trend: the de-emphasis line, the latest point in the accent. Values carry no axis. */
export function Sparkline({ values, height = 32, width = 112, accent = C.today, format = null, label = 'trend' }) {
  const pts = (values || []).map((v, i) => ({ v, i })).filter((p) => p.v != null && Number.isFinite(p.v));
  if (pts.length < 2) return <div style={{ width, height }} aria-hidden="true" />;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const span = hi - lo || 1;
  const n = values.length;
  const x = (i) => 2 + (i / Math.max(1, n - 1)) * (width - 6);
  const y = (v) => 3 + (1 - (v - lo) / span) * (height - 6);
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} className="block shrink-0" role="img" aria-label={`${label}: ${format ? format(pts[0].v) : pts[0].v} to ${format ? format(last.v) : last.v}`}>
      <path d={d} fill="none" stroke="#71717a" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.i)} cy={y(last.v)} r="3" fill={accent} stroke={C.surface} strokeWidth="1.5" />
    </svg>
  );
}

/**
 * The board tile's picture: how much of today's board is done (the bar) and where a typical day
 * stood by the same minute (the tick). A bullet, because the only useful question about a share
 * done at 11am is "against what?".
 */
export function ShareBullet({ value, marker = null, width = 112, height = 32, label = 'Today’s board done' }) {
  if (value == null || !Number.isFinite(value)) return <div style={{ width, height }} aria-hidden="true" />;
  const v = Math.max(0, Math.min(1, value));
  const m = marker != null && Number.isFinite(marker) ? Math.max(0, Math.min(1, marker)) : null;
  const barH = 8;
  const y = (height - barH) / 2;
  const x = (s) => 1 + s * (width - 2);
  return (
    <svg width={width} height={height} className="block shrink-0" role="img"
      aria-label={`${label}: ${fmtShare(v)}${m != null ? `; a typical day by now ${fmtShare(m)}` : ''}`}>
      <rect x="1" y={y} width={width - 2} height={barH} rx="4" fill={C.hairline} />
      {v > 0 && <rect x="1" y={y} width={Math.max(barH, x(v) - 1)} height={barH} rx="4" fill={C.today} />}
      {m != null && <line x1={x(m)} x2={x(m)} y1={y - 5} y2={y + barH + 5} stroke={C.ink} strokeWidth="2" strokeLinecap="round" />}
    </svg>
  );
}

const STATUS_COLOR = { good: C.good, warning: C.warning, critical: C.critical };

/** Where the stops ended up: one thin part-to-whole bar, then the rows it is made of. */
export function OutcomeMeter({ mix, compact = false }) {
  const rows = mix?.rows || [];
  const whole = mix?.whole || 0;
  return (
    <div>
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-zinc-800" role="img"
        aria-label={rows.map((r) => `${r.label} ${fmtCount(r.count)} (${fmtShare(r.share)})`).join(', ')}>
        {whole > 0 && rows.filter((r) => r.count > 0).map((r) => (
          <span key={r.key} className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${Math.max(0.6, (r.count / whole) * 100)}%`, background: STATUS_COLOR[r.status], opacity: r.key === 'hand' ? 0.55 : 1 }} />
        ))}
      </div>
      <ul className={`mt-3 space-y-1.5 ${compact ? 'text-[13px]' : 'text-[13px]'}`}>
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: STATUS_COLOR[r.status], opacity: r.key === 'hand' ? 0.55 : 1 }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-zinc-300">{r.label}</span>
            <span className="font-mono tabular-nums text-zinc-100">{fmtCount(r.count)}</span>
            <span className="w-12 text-right font-mono tabular-nums text-zinc-400">{fmtShare(r.share)}</span>
          </li>
        ))}
      </ul>
      {(mix?.cancelled > 0 || mix?.unaccounted) ? (
        <p className="mt-2 text-xs leading-relaxed text-zinc-400">
          {mix.cancelled > 0 ? `${fmtCount(mix.cancelled)} cancelled — pulled orders, not counted as work. ` : ''}
          {mix.unaccounted ? `${fmtCount(Math.abs(mix.unaccounted))} ${mix.unaccounted > 0 ? 'not in any row above' : 'counted twice'} — see the Days table.` : ''}
        </p>
      ) : null}
    </div>
  );
}

/** Average delivered per weekday; today's weekday in the accent, the rest grey. */
export function WeekdayBars({ profile, todayWeekday = null }) {
  const max = Math.max(1, ...profile.map((p) => p.avg || 0));
  return (
    <ul className="space-y-2" aria-label="Average delivered by weekday">
      {profile.map((p) => {
        const on = p.weekday === todayWeekday;
        return (
          <li key={p.weekday} className="flex items-center gap-3 text-[13px]">
            <span className={`w-9 shrink-0 ${on ? 'text-zinc-100' : 'text-zinc-400'}`}>{WEEKDAY_SHORT[p.weekday]}</span>
            <span className="relative h-2 flex-1 rounded-r bg-zinc-800/60">
              {p.avg != null && (
                <span className="absolute inset-y-0 left-0 rounded-r"
                  style={{ width: `${(p.avg / max) * 100}%`, background: on ? C.today : C.mutedBar }} />
              )}
            </span>
            <span className="w-14 text-right font-mono tabular-nums text-zinc-100">{p.avg != null ? fmtCount(p.avg) : '—'}</span>
            <span className="w-10 text-right font-mono tabular-nums text-xs text-zinc-400">{p.n ? `×${p.n}` : ''}</span>
          </li>
        );
      })}
    </ul>
  );
}
