// Map time marks — which END of the day does this dock constrain, if any?
//
// WHY THIS REPLACES THE OLD CLOCK. The map used to draw one amber clock whenever a
// customer had ANY receiving hours on file. That answers a question about our records —
// "do we know this customer's hours?" — and not the dispatcher's question, which is
// "is this stop going to bite me, and at which end of the day?" On the 2026-08-21 board
// it put 116 clock-type icons on 755 stops, and 67 of them were docks open a full working
// day. Chad, looking at it: "I want to get rid of the noise."
//
// THE IDEA. A dock's hours have two edges, and each is independently a constraint or a
// gift. Opening at 9am means it cannot be your first stop. Opening at 6am means it CAN —
// which is worth more to a route than most of what the map showed. Shutting at 11am is a
// deadline; staying open past 6pm is slack you can spend. Flattening all four into "has
// hours" throws away the only part that matters.
//
// ONE MARK PER PIN — THE BINDING EDGE WINS. Two icons on one pin is how the map got
// cluttered in the first place. The precedence below falls out of the freight rather than
// out of convenience: when a dock shuts early you are going in the morning regardless, so
// its open edge is not news. Only when nothing binds at the CLOSE does the OPEN become
// the story — which is exactly how a 6am dock that stays open till five surfaces as
// "extra room" instead of vanishing.
//
// A dock with ordinary hours — 7am to 4pm — gets NO mark. Silence is the feature: it is
// what makes the remaining marks worth looking at.

import { parseClockMin, dayReceivingWindow } from './board-flags.js';

// ── the dials ────────────────────────────────────────────────────────────────
// Every one of these is a judgement about Davis's day, not a fact about the data, so they
// are named and gathered here to be argued with. The counts in the comments are from the
// 2026-08-21 board (755 stops, 93 with a full stated window) and are the reason each line
// sits where it does — these docks state hours on the hour, so each threshold is a STEP,
// not a slope, and moving one by a minute can double what the map draws.
export const SHUTS_EARLY_BEFORE = 12 * 60;   // 12:00p — closes by noon. 7 pins.
export const TIGHT_WINDOW_MAX   = 180;       // ≤3h of opening at all, whenever it falls.
export const EARLY_CLOSE_BEFORE = 15 * 60;   // 3:00p — 26 pins. At 3:00p INCLUSIVE it is 45:
                                             // nineteen docks shut at exactly three.
export const OPENS_LATE_FROM    = 9 * 60;    // 9:00a — 12 pins. At 9:30a only 4.
export const OPENS_EARLY_BY     = 6 * 60 + 30; // 6:30a — 10 pins. At 7:00a it jumps to 22.
export const OPEN_LATE_FROM     = 18 * 60;   // 6:00p — a dock still taking freight at six.

// Icon keys, most binding first. This array IS the precedence.
export const TIME_MARK_KEYS = [
  'hours_shuts_early',   // 1 — rose.  Closes by noon, or open ≤3h. First stop or nothing.
  'hours_early_close',   // 2 — amber. Closes before 3pm. A deadline inside the day.
  'hours_opens_late',    // 3 — teal.  Opens 9am+. Cannot be your first stop.
  'hours_extra_room',    // 4 — sky.   Opens ≤6:30a or open past 6pm. Good news.
];

/**
 * Classify one day's receiving window into a single map mark.
 *
 * Both edges are optional, and that is deliberate rather than defensive: "RECEIVING AFTER
 * 10AM" gives an open with no close and is still a real constraint, while "CLOSES AT 3 30
 * PM" gives the reverse. Only a stop with NEITHER edge has nothing to say.
 *
 * @param openMin  minutes since midnight, or null when the dock states no opening time
 * @param closeMin minutes since midnight, or null when it states no closing time
 * @returns one of TIME_MARK_KEYS, or null for a dock that constrains nothing
 */
export function classifyTimeMark(openMin, closeMin) {
  const o = Number.isFinite(openMin) ? openMin : null;
  const c = Number.isFinite(closeMin) ? closeMin : null;
  if (o == null && c == null) return null;

  // 1 — the dock shuts while the day is still young, or barely opens at all.
  if (c != null && c < SHUTS_EARLY_BEFORE) return 'hours_shuts_early';
  if (o != null && c != null && c - o <= TIGHT_WINDOW_MAX) return 'hours_shuts_early';
  // 2 — a real deadline inside the working day.
  if (c != null && c < EARLY_CLOSE_BEFORE) return 'hours_early_close';
  // 3 — nothing binds at the close, so the open is the story: too late to lead a route.
  if (o != null && o >= OPENS_LATE_FROM) return 'hours_opens_late';
  // 4 — room at one end or the other. The only mark that reports GOOD news.
  if (o != null && o <= OPENS_EARLY_BY) return 'hours_extra_room';
  if (c != null && c >= OPEN_LATE_FROM) return 'hours_extra_room';
  return null;                                   // ordinary hours. Say nothing.
}

/**
 * The open/close a customer keeps on ONE weekday, in minutes.
 *
 * dayReceivingWindow is the authority and is used first — it already handles the legacy
 * "6AM-2PM" string form, the {open, close} form, and the business-hours correction that
 * reads "8-3" as an afternoon close rather than a 3am one. But it returns null whenever
 * there is no parseable CLOSE, because everything that consumed it until now was measuring
 * a deadline. A dock that states only "opens 10am" would therefore be invisible here, and
 * that is a genuine routing constraint, so we fall back to reading the open on its own.
 */
export function dayWindowMinutes(note, dayKey) {
  if (!note || !dayKey) return { openMin: null, closeMin: null };
  const w = dayReceivingWindow(note, dayKey);
  if (w && w.closeMin != null) return { openMin: w.openMin ?? null, closeMin: w.closeMin };
  const v = note.receiving_hours?.[dayKey];
  if (!v || typeof v === 'string') return { openMin: null, closeMin: null };
  return { openMin: parseClockMin(v.open), closeMin: null };
}

/** The mark for a customer on a given weekday, or null. Convenience over the two above. */
export function timeMarkForDay(note, dayKey) {
  const { openMin, closeMin } = dayWindowMinutes(note, dayKey);
  return classifyTimeMark(openMin, closeMin);
}
