// lib/routing-time-windows.mts
//
// WHAT A STOP'S CLOCK SAYS TO THE BUILD — one rule, read for every stop.
//
// Chad: "we need them to be able to pay attention to time restrictions, whether or
// not it's a tractor friendly stop."
//
// THEY COULD NOT, AND HERE IS WHY, MEASURED. The pipeline read an appointment window
// off `scheduledFrom`/`scheduledTo` with a parser anchored at "HH:MM", and the board
// stores those as full naive stamps ("2026-09-14T13:00:00"). The parser returned 0,
// the window came back null, and every stop went into the solver as SOFT. A 1:00p–1:30p
// appointment went through a build with an ETA of 7:02a and no flag — run, not argued
// (scratch script window-blind.mjs, 2026-09-12). Receiving hours, which live on the
// customer note the SAME resolver already fetches for equipment, were never read at all.
//
// THE TRAP ON THE OTHER SIDE, which is why this is not a one-line parser fix: NuVizz
// stamps timeConstraint 'STRICT' on ~93% of stops and an 08:00–20:00 "window" on ~88%
// (src/lib/time-restrictions.js counted them). Accept those and nearly every stop gets
// a strict all-day window, the strategy the dispatcher picked is overridden by the
// window-aware order on every build, and nothing is gained. So this module reads the
// clock through the SAME tested rules the map and the PRO report use:
//   • orderWindow      — the order's own schedule, only when NARROWER than a working day
//                        and not the vendor's default 30-minute creation slot
//                        (detectDefaultSlots over the whole board says which those are);
//   • dayWindowMinutes — the customer's receiving hours for the BOARD day, typed or
//                        auto-scanned, legacy strings and the {open,close} shape alike;
//   • closedDayTier    — a customer shut on that weekday.
// The tightest combination wins; when an order's booked window and the dock's hours
// disagree outright, the order's window (the specific commitment) is kept and the
// disagreement is named so the dispatcher can see it.
//
// INDEPENDENT OF ELIGIBILITY BY CONSTRUCTION. Nothing here reads vehicle_eligibility,
// equipment restrictions, or a tractor mark — a test pins that a green stop and a red
// stop with the same hours get the same window.
//
// ROUTING_TIME_RESTRICTIONS=off puts the build back to the blind behaviour, one env var,
// all sides at once (the resolver simply attaches nothing). House shape: default ON, an
// explicit off-word turns it off, anything malformed leaves it ON.

import { orderWindow, detectDefaultSlots, weekdayKey } from '../../../src/lib/time-restrictions.js';
import { dayReceivingWindow, closedDayTier, fmtMin } from '../../../src/lib/board-flags.js';
import { dayWindowMinutes } from '../../../src/lib/time-marks.js';

export interface StopTimeRestriction {
  openMin: number | null;    // minutes since midnight, board day — earliest the dock takes freight
  closeMin: number | null;   // minutes since midnight — latest arrival that still delivers
  closedToday: boolean;      // the customer is shut on the board's weekday
  sources: string[];         // what produced it, in words, for the card and the risk flags
  label: string;             // "1:00p–1:30p", "8:00a–2:00p", "opens 10:00a", "closed Friday"
}

const OFF_WORDS = new Set(['off', '0', 'false', 'no']);
export function timeRestrictionsEnabled(env: Record<string, any> = process.env): boolean {
  return !OFF_WORDS.has(String(env.ROUTING_TIME_RESTRICTIONS ?? '').trim().toLowerCase());
}

/** Vendor default creation slots on this board (see time-restrictions.detectDefaultSlots). */
export function boardDefaultSlots(stops: any[]): Set<string> {
  return detectDefaultSlots(stops || []);
}

const DAY_NAME: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

function span(openMin: number | null, closeMin: number | null): string {
  if (openMin != null && closeMin != null) return `${fmtMin(openMin)}–${fmtMin(closeMin)}`;
  if (closeMin != null) return `by ${fmtMin(closeMin)}`;
  if (openMin != null) return `opens ${fmtMin(openMin)}`;
  return '';
}

/**
 * The clock constraint on one stop for one board day, or null when the clock says nothing.
 * @param stop         a board stop (scheduledFrom/To as the board stores them — stamps)
 * @param note         the customer_notes doc for the stop's place, or null
 * @param date         'YYYY-MM-DD' — the BOARD day, never today's
 * @param defaultSlots boardDefaultSlots(all stops) — suppresses the vendor's creation stamp
 */
export function stopTimeRestriction(
  { stop, note, date, defaultSlots }: { stop: any; note: any; date: string | undefined; defaultSlots?: Set<string> | null },
): StopTimeRestriction | null {
  const dayKey = weekdayKey(date);
  const sources: string[] = [];

  if (dayKey && closedDayTier(note, dayKey)) {
    const name = DAY_NAME[dayKey] || dayKey;
    return { openMin: null, closeMin: null, closedToday: true, sources: [`closed ${name}`], label: `closed ${name}` };
  }

  const ord = orderWindow(stop, defaultSlots || null);
  if (ord) sources.push(`${ord.kind === 'appointment' ? 'appointment' : 'order window'} ${span(ord.openMin, ord.closeMin)}`);

  let hrsOpen: number | null = null, hrsClose: number | null = null;
  if (dayKey) {
    const h = dayWindowMinutes(note, dayKey);
    hrsOpen = h.openMin ?? null; hrsClose = h.closeMin ?? null;
    if (hrsOpen != null || hrsClose != null) {
      const tier = dayReceivingWindow(note, dayKey)?.tier;
      sources.push(`receiving hours ${span(hrsOpen, hrsClose)}${tier === 'typed' ? ' (typed)' : tier === 'auto' ? ' (auto)' : ''}`);
    }
  }

  const opens = [ord?.openMin, hrsOpen].filter((v): v is number => typeof v === 'number');
  const closes = [ord?.closeMin, hrsClose].filter((v): v is number => typeof v === 'number');
  if (!opens.length && !closes.length) return null;
  let openMin: number | null = opens.length ? Math.max(...opens) : null;
  let closeMin: number | null = closes.length ? Math.min(...closes) : null;

  // The order's booked window and the dock's hours disagree outright (a 3pm appointment at
  // a dock whose hours say 2pm). The appointment is the specific commitment — somebody
  // arranged it — so it stands, and the disagreement is said out loud rather than resolved
  // into an empty window nothing could satisfy.
  if (ord && openMin != null && closeMin != null && closeMin <= openMin) {
    openMin = ord.openMin; closeMin = ord.closeMin;
    sources.push(`receiving hours disagree with the appointment (${span(hrsOpen, hrsClose)})`);
  }
  return { openMin, closeMin, closedToday: false, sources, label: span(openMin, closeMin) };
}
