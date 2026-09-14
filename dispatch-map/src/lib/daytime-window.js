// daytime-window.js
//
// "RH 1-5" IS ONE O'CLOCK IN THE AFTERNOON, AND WE READ IT AS ONE IN THE MORNING.
//
// Chad, 2026-09-14: "fix that rh 1-5 is always going to be pm as you have to imagine our
// delivery window for the most part is 8am - 5pm so no one is going to have those
// receiving hours."
//
// WHAT IT WAS DOING, MEASURED on v1.24.0 before this module existed:
//
//   RH 1-5                ->  01:00-05:00     (should be 13:00-17:00)
//   RECEIVING HOURS 2-4   ->  02:00-04:00     (should be 14:00-16:00)
//   RH 1-4 30             ->  01:00-04:30     (should be 13:00-16:30)
//
// Two independent parsers had the same hole, and both were verified by running them:
// signal-scanner's parseTimeRange (a fresh Uline order) and board-flags' dayReceivingWindow
// legacy-string branch (a range already sitting in Firestore as "1-5"). Each rescued only a
// DESCENDING pair — "7-3" correctly becomes 07:00-15:00 because the close cannot precede the
// open — and an ascending pair of small numbers sailed through as dawn.
//
// WHY A DAWN WINDOW IS THE EXPENSIVE KIND OF WRONG. A stored 01:00-05:00 says the customer is
// shut for the whole working day, so every stop there carries an hours_risk row forever. That
// is crying wolf, which is the precise complaint that opened the lunch-split fix a version
// earlier — and a dispatcher who learns to scroll past a flag has lost the flag. It is also
// read by the routing engine (netlify/functions/lib/routing-time-windows.mts, since v1.2x), so
// the solver would build against a window no truck can serve.
//
// THE RULE: PICK THE READING THAT OVERLAPS THE DELIVERY DAY. When NEITHER half of a range wrote
// a meridiem, both the morning and the afternoon reading are grammatically available, and the
// one that actually intersects 8am-5pm is the one a dock meant. Arithmetic, not vocabulary:
//
//   1-5   AM [01:00,05:00] overlaps 0 min   PM [13:00,17:00] overlaps 240 min  ->  PM
//   2-4   AM                        0       PM [14:00,16:00]           120     ->  PM
//   8-12  AM [08:00,12:00]        240       PM [20:00,24:00]             0     ->  AM (unchanged)
//   9-11  AM [09:00,11:00]        120       PM                           0     ->  AM (unchanged)
//   5-9   AM [05:00,09:00]         60       PM [17:00,21:00]             0     ->  AM (unchanged)
//   6-10  AM [06:00,10:00]        120       PM                           0     ->  AM (unchanged)
//
// A TIE KEEPS TODAY'S ANSWER, and the ties are the whole reason this is a comparison rather
// than a threshold. "6-7" and "7-8" overlap the delivery day in neither reading; a threshold
// like "shift anything that ends before 8am" would fling them to 6pm and 7pm on no evidence at
// all. A tie means we were told nothing, and the honest response to being told nothing is to
// change nothing.
//
// WHAT IT REFUSES TO TOUCH. A written meridiem is the customer speaking: "1AM-5AM" stays
// 01:00-05:00 even though no dock works then, because guessing over an explicit statement is
// how the v0.54.60 "CLOSES AT 4" regression happened. NOON counts as written — it names 12:00
// outright. A shift that would cross midnight is refused rather than wrapped.
//
// PUT BACK BY: HOURS_PM_SHIFT=off on the functions, VITE_HOURS_PM_SHIFT=off in the bundle (see
// daytimeShiftEnabled). One rule, imported by both parsers, so the scanner and the board can
// never disagree about what "1-5" means — and the switch reverts both sides at once.

// Chad's words: "our delivery window for the most part is 8am - 5pm".
export const DELIVERY_DAY_OPEN_MIN = 8 * 60;   // 08:00
export const DELIVERY_DAY_CLOSE_MIN = 17 * 60; // 17:00
const HALF_DAY_MIN = 12 * 60;
const MIDNIGHT_MIN = 24 * 60;

const OFF_WORDS = new Set(['off', '0', 'false', 'no']);

// The earliest a receiving dock opens, and it is not a new opinion: the scanner's bare-pair
// tier has gated on "opens 5:00a-12:00p" since Chad asked it to learn bare pairs, on the
// grounds that "most businesses we deliver to are normal day time hours as we don't run
// through the night". Reused here rather than re-decided.
export const DOCK_OPEN_EARLIEST_MIN = 5 * 60; // 05:00


/**
 * House shape: default ON, an explicit off-word turns it off, anything malformed leaves it ON.
 * A typo in an env var must never silently disable a rule.
 *
 * READ ON BOTH SIDES ON PURPOSE. The scanner runs in a Netlify function and writes the note;
 * board-flags runs in the browser and reads it. A switch that reverted only one of them would
 * leave the two disagreeing about the same dock, which is a new bug wearing the old feature's
 * name. So: HOURS_PM_SHIFT server-side, VITE_HOURS_PM_SHIFT in the bundle (Vite only exposes
 * VITE_-prefixed vars to the client), and either one turns the rule off everywhere it is read.
 * Vite injects import.meta.env at build time; in Node (the unit suite) it is simply absent.
 */
export function daytimeShiftEnabled(env) {
  let raw = env;
  if (!raw) {
    const bag = {};
    try { Object.assign(bag, import.meta.env ?? {}); } catch { /* not a Vite bundle */ }
    try { Object.assign(bag, typeof process !== 'undefined' ? process.env ?? {} : {}); } catch { /* not Node */ }
    raw = bag;
  }
  const v = String(raw.HOURS_PM_SHIFT ?? raw.VITE_HOURS_PM_SHIFT ?? '').trim().toLowerCase();
  return !OFF_WORDS.has(v);
}

/** Minutes two closed intervals share. Never negative. */
export function overlapMinutes(aOpen, aClose, bOpen, bClose) {
  return Math.max(0, Math.min(aClose, bClose) - Math.max(aOpen, bOpen));
}

/** How much of a window falls inside the delivery day. */
export function deliveryDayOverlap(openMin, closeMin) {
  return overlapMinutes(openMin, closeMin, DELIVERY_DAY_OPEN_MIN, DELIVERY_DAY_CLOSE_MIN);
}

/**
 * Resolve a receiving window whose halves carried no written meridiem.
 *
 * @param {number} openMin              minutes since midnight, as parsed under the AM reading
 * @param {number} closeMin             minutes since midnight, as parsed under the AM reading
 * @param {boolean} hadWrittenMeridiem  true when EITHER half wrote AM/PM/A/P or NOON
 * @returns {{ openMin: number, closeMin: number, shifted: boolean }}
 */
export function resolveDaytimeWindow(openMin, closeMin, hadWrittenMeridiem, env) {
  const unchanged = { openMin, closeMin, shifted: false };
  if (hadWrittenMeridiem) return unchanged;
  if (!Number.isFinite(openMin) || !Number.isFinite(closeMin)) return unchanged;
  if (closeMin <= openMin) return unchanged;           // not a forward window; the caller's own rescue owns it
  if (!daytimeShiftEnabled(env)) return unchanged;

  const pmOpen = openMin + HALF_DAY_MIN;
  const pmClose = closeMin + HALF_DAY_MIN;
  if (pmClose > MIDNIGHT_MIN) return unchanged;        // would cross midnight — not a daytime window

  const amOverlap = deliveryDayOverlap(openMin, closeMin);
  const pmOverlap = deliveryDayOverlap(pmOpen, pmClose);
  // Strictly greater: a tie means no evidence, and no evidence means no change.
  if (pmOverlap > amOverlap) return { openMin: pmOpen, closeMin: pmClose, shifted: true };
  return unchanged;
}

/**
 * Resolve an OPEN-ONLY time whose text carried no meridiem — "OPENS AT 1", "RECEIVING AFTER 1",
 * "NO DELIVERIES BEFORE 1".
 *
 * A RANGE has a second number to reason from; a lone open does not, so the comparison above
 * cannot help and this is a floor instead. The asymmetry with the close-only rule is real and
 * deliberate: a dock that OPENS early is ordinary (5am, 6am and 7am docks all exist), while a
 * dock that CLOSES at 5am does not, which is why the close-only branch reads 1-7 as afternoon
 * and this one only reads 1-4 that way.
 *
 * WHY IT MATTERS MORE THAN A WRONG CARD. routing-time-windows takes Math.max of the available
 * opens, so an open parsed as 01:00 is no constraint at all: the solver schedules the stop first
 * thing and the truck reaches a dock that does not open until one in the afternoon. That is a
 * refused delivery, the expensive direction — unlike a bad close, which merely cries wolf.
 * "OPENS AT 12" was worse still: the AM rule turned 12 into hour 0, so the window opened at
 * MIDNIGHT.
 *
 * @param {number} openMin              minutes since midnight, as parsed under the AM reading
 * @param {boolean} hadWrittenMeridiem  true when the piece wrote AM/PM/A/P or NOON
 * @returns {{ openMin: number, shifted: boolean }}
 */
export function resolveDaytimeOpen(openMin, hadWrittenMeridiem, env) {
  const unchanged = { openMin, shifted: false };
  if (hadWrittenMeridiem) return unchanged;
  if (!Number.isFinite(openMin)) return unchanged;
  if (openMin >= DOCK_OPEN_EARLIEST_MIN) return unchanged;
  if (!daytimeShiftEnabled(env)) return unchanged;
  return { openMin: openMin + HALF_DAY_MIN, shifted: true };
}
