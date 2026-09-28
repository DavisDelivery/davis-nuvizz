// src/lib/driver-snapshot-timeliness.js — the driver snapshot's on-time judgement (PURE).
//
// The snapshot (desktop sidebar and phone drawer share one body) marks each completed stop
// on-time / early / "N min late ⚠" and rolls those into an on-time rate. It judged against
// the stop's scheduledTime, which is the saved search's "Estimated Arrival" — on most loads
// ONE generic window stamped on every stop. Twelve consignees do not all book 8:00 AM, so a
// driver who ran a clean route read hours late on every stop after the first few. The route
// card already refuses to treat that window as an appointment (loadDefaultWindow); this is
// the same rule for the snapshot, applied per LOAD because a driver can run more than one.

import { loadDefaultWindow } from './route-stop-line.js';

// Arrival vs scheduled time, ±15 minutes counts as on time.
export function classifyTimeliness(scheduledIso, actualIso) {
  if (!scheduledIso || !actualIso) return null;
  const sched = new Date(scheduledIso).getTime();
  const act = new Date(actualIso).getTime();
  if (Number.isNaN(sched) || Number.isNaN(act)) return null;
  const deltaMin = Math.round((act - sched) / 60000);
  let kind = 'ontime';
  if (deltaMin > 15) kind = 'late';
  else if (deltaMin < -15) kind = 'early';
  return { deltaMin, kind };
}

/** PURE. loadNbr → the window that load's stops share (only loads that have one). */
export function snapshotSharedWindows(stops) {
  const byLoad = new Map();
  for (const s of Array.isArray(stops) ? stops : []) {
    const k = String(s?.loadNbr ?? '');
    if (!byLoad.has(k)) byLoad.set(k, []);
    byLoad.get(k).push({ scheduledFrom: s?.scheduledTime ?? null });
  }
  const out = new Map();
  for (const [k, list] of byLoad) {
    const ts = loadDefaultWindow(list);
    if (ts) out.set(k, ts);
  }
  return out;
}

/** PURE. The stop's verdict, or null when it had no appointment to meet (or no stamp). */
export function snapshotStopTimeliness(stop, sharedWindows) {
  const shared = sharedWindows?.get?.(String(stop?.loadNbr ?? ''));
  if (shared && stop?.scheduledTime === shared) return null;
  return classifyTimeliness(stop?.scheduledTime, stop?.actualArrival || stop?.actualCompletion);
}

/**
 * PURE. On-time rate over the completed stops that could be judged. A stop with no
 * appointment is not a miss — counting it as one is what put a clean route near 0%.
 * Null when nothing could be judged, so the screen shows "—" rather than an invented 0%.
 */
export function snapshotOnTime(stops, sharedWindows) {
  const judged = (Array.isArray(stops) ? stops : [])
    .filter((s) => s?.status === 'completed')
    .map((s) => snapshotStopTimeliness(s, sharedWindows))
    .filter(Boolean);
  if (!judged.length) return null;
  const onTime = judged.filter((t) => t.kind === 'ontime' || t.kind === 'early').length;
  return { onTime, total: judged.length, pct: Math.round((onTime / judged.length) * 100) };
}
