// scan-schedule.mts
//
// Single source of truth for WHEN the NuVizz scan fires and WHICH feeds it scans.
// Used by both the scheduled background writer and the manual-scan endpoint so the
// cadence/gates can never drift between them. The cron stays */15 * * * *; all the
// scheduling intelligence is here, computed from ET local time (DST-robust).
//
// Lifecycle this encodes (all ET):
//   - Orders for a day arrive ~10am the DAY BEFORE (status-10 unplanned).
//   - They get planned onto loads starting ~8pm the day before.
//   - They're executed the NEXT day ~5am-7pm.
// So: today's board = TODAY load scan; incoming orders = UNPLANNED descent
// (10am-midnight); tomorrow's loads exist only after 8pm = TOMORROW load scan.
//
// Cadence (ET), by TIME ELAPSED since the last successful load scan — NOT the
// wall-clock minute. Netlify */15 fires are best-effort and rarely land on
// :00/:15/:30/:45; a minute-gate (minute===0) silently no-ops a fire that lands
// at :01, so the board only refreshed on the 4-7am window or manual scans. Gating
// on elapsed time makes the on-cadence fire scan even when it lands a few minutes
// late.
//   target interval: 4-7am → 15m · 7am-1pm → 30m · 1pm-4am (incl. overnight) → 60m
//   act = elapsed >= interval - TOLERANCE   (tolerance absorbs cron jitter)
// Feeds when a fire ACTS: TODAY loads ALWAYS · TODAY unplanned 10:00-24:00 ·
// TOMORROW loads 20:00-24:00 · TOMORROW unplanned 10:00-24:00 (orders for tomorrow
// arrive from ~10am the day before, so they must be descended through the day).

import { MIN_SCAN_INTERVAL_MS } from './nuvizz-request.mts';

// ~half the */15 cron period: lets an on-cadence fire that lands a minute or two
// late still scan, without letting an off-cadence fire scan early.
const TOLERANCE_MIN = 7;
// Hard floor (skip if a scan ran more recently than this) — bypassed only by manual.
const FLOOR_MIN = MIN_SCAN_INTERVAL_MS / 60000;

export interface ScanDecision {
  act: boolean;
  scanTodayUnplanned: boolean;
  scanTomorrowLoads: boolean;
  scanTomorrowUnplanned: boolean;
  // Diagnostics (surfaced in the [scan] log line):
  etHour: number;
  etMin: number;
  intervalMin: number;
  elapsedMin: number;            // Infinity when no prior load scan
  skip: 'none' | 'cadence' | 'floor';
  reason: string;
}

// Target interval (minutes) between scans for the given ET hour.
export function intervalForHour(hour: number): number {
  if (hour >= 4 && hour < 7) return 15;
  if (hour >= 7 && hour < 13) return 30;
  return 60; // 13:00-03:59 incl. overnight
}

// ET wall-clock hour (0-23) + minute. ET is a whole-hour UTC offset, so the
// minute is identical to UTC's — the cron's :00/:15/:30/:45 align with ET.
export function nowET(d: Date = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const hour = Number(get('hour')) % 24; // guards Intl's "24" at midnight
  const minute = Number(get('minute'));
  return { hour, minute };
}

export function scanDecision(
  d: Date = new Date(),
  isManual = false,
  lastLoadScanAt: string | null = null,
): ScanDecision {
  const { hour, minute } = nowET(d);
  const intervalMin = intervalForHour(hour);
  const lastMs = lastLoadScanAt ? new Date(lastLoadScanAt).getTime() : NaN;
  const elapsedMin = Number.isFinite(lastMs) ? (d.getTime() - lastMs) / 60000 : Infinity;

  // Manual: always a full scan of today + tomorrow (loads + orders), floor bypassed.
  if (isManual) {
    return {
      act: true, scanTodayUnplanned: true, scanTomorrowLoads: true, scanTomorrowUnplanned: true,
      etHour: hour, etMin: minute, intervalMin, elapsedMin, skip: 'none', reason: 'manual',
    };
  }

  const base = { scanTodayUnplanned: false, scanTomorrowLoads: false, scanTomorrowUnplanned: false, etHour: hour, etMin: minute, intervalMin, elapsedMin };

  // Hard floor — a scan ran very recently (e.g. a manual a moment ago); skip.
  if (elapsedMin < FLOOR_MIN) {
    return { act: false, ...base, skip: 'floor', reason: `floor elapsed=${Math.round(elapsedMin)}<${FLOOR_MIN}` };
  }
  // Cadence — not enough time elapsed for this hour's interval (minus tolerance).
  if (elapsedMin < intervalMin - TOLERANCE_MIN) {
    return { act: false, ...base, skip: 'cadence', reason: `cadence elapsed=${Math.round(elapsedMin)}<${intervalMin}-${TOLERANCE_MIN}` };
  }

  // Acting fire — which feeds run depends on the ET hour.
  return {
    act: true,
    scanTodayUnplanned: hour >= 10 && hour < 24,
    scanTomorrowLoads: hour >= 20 && hour < 24,
    scanTomorrowUnplanned: hour >= 10 && hour < 24,
    etHour: hour, etMin: minute, intervalMin, elapsedMin, skip: 'none',
    reason: `act h=${hour} elapsed=${elapsedMin === Infinity ? 'inf' : Math.round(elapsedMin)}>=${intervalMin}-${TOLERANCE_MIN}`,
  };
}
