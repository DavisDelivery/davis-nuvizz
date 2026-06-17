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
// Cadence (ET): 4-7am every 15m · 7am-1pm every 30m · 1pm-4am every 60m (incl. overnight).
// Gates on a firing that ACTS: TODAY loads ALWAYS · UNPLANNED only 10:00-24:00 ·
// TOMORROW loads only 20:00-24:00 · TOMORROW unplanned NEVER.

export interface ScanDecision {
  act: boolean;
  scanUnplanned: boolean;
  scanTomorrowLoads: boolean;
  reason: string;
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

export function scanDecision(d: Date = new Date(), isManual = false): ScanDecision {
  if (isManual) {
    return { act: true, scanUnplanned: true, scanTomorrowLoads: true, reason: 'manual' };
  }
  const { hour, minute } = nowET(d);
  let act: boolean;
  if (hour >= 4 && hour < 7) act = true;                 // every 15 min
  else if (hour >= 7 && hour < 13) act = (minute % 30 === 0); // :00, :30
  else act = (minute === 0);                              // top of hour (1pm-4am incl. overnight)
  const scanUnplanned = act && (hour >= 10 && hour < 24);
  const scanTomorrowLoads = act && (hour >= 20 && hour < 24);
  return { act, scanUnplanned, scanTomorrowLoads, reason: `auto h=${hour} m=${minute}` };
}
