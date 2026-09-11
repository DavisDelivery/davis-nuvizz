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

import { parseClockMin, dayReceivingWindow, fmtMin } from './board-flags.js';

// ── the dials ────────────────────────────────────────────────────────────────
// Every one of these is a judgement about Davis's day, not a fact about the data, so they
// are named and gathered here to be argued with. The counts in the comments are from the
// 2026-08-21 board (755 stops, 93 with a full stated window) and are the reason each line
// sits where it does — these docks state hours on the hour, so each threshold is a STEP,
// not a slope, and moving one by a minute can double what the map draws.
export const SHUTS_EARLY_BEFORE = 12 * 60;   // 12:00p — closes by noon. 7 pins.
export const TIGHT_WINDOW_MAX   = 180;       // ≤3h of opening at all, whenever it falls.
export const EARLY_CLOSE_BEFORE = 15 * 60;   // 3:00p — 26 pins. Chad, asked and answered:
                                             // "leave anything closing before 3 as early."
                                             // The step here is the steepest on the board and
                                             // it is worth writing down, because a 3:00p dock
                                             // is a coin-flip rather than an oversight. At
                                             // 3:00p INCLUSIVE the mark goes to 45 and at
                                             // 4:00p to 48, since NINETEEN docks shut at
                                             // exactly three and only three more between
                                             // three and four. Measured whole-map cost of the
                                             // 4:00p line: 56 marks becomes 72. Sixteen of
                                             // those twenty-two are pins the map draws today
                                             // for the first time; the other six are already
                                             // lit, and four of THOSE are 6am docks that would
                                             // trade "extra room, go at dawn" for an amber
                                             // deadline — NEFAB, Dixie Seal, Space Pole, FBM.
                                             // Losing the dawn signal on a 6a-3p dock is a
                                             // worse trade than missing its close, because a
                                             // driver sent there first is never late anyway.
export const OPENS_LATE_FROM    = 9 * 60;    // 9:00a — 12 pins. At 9:30a only 4.
export const OPENS_EARLY_BY     = 6 * 60 + 30; // 6:30a — 10 pins. At 7:00a it jumps to 22.
export const OPEN_LATE_FROM     = 18 * 60;   // 6:00p — a dock still taking freight at six.

/**
 * 5:00p — WHEN A DOCK'S DAY COUNTS AS FINISHING EARLY, and the only new dial the two
 * both-edges marks below need.
 *
 * Chad named both edges of each: "a stop like this that opens after 8am and closes before 5"
 * (a 10:00a–4:00p dock) and "a customer like this that opens before 8 and closes before 5"
 * (a 6:00a–3:00p one). The OPEN half of each is already decided, and decided more strictly,
 * by the dials above — the first case can only be reached having passed OPENS_LATE_FROM
 * (9:00a, later than his 8:00a) and the second having passed OPENS_EARLY_BY (6:30a, earlier
 * than it). An 8:00a dial would therefore change not one pin and would be a second number to
 * keep in step with the first, so the close is the only thing stated here.
 *
 * NEITHER OF THESE MARKS A SINGLE STOP THE MAP WAS NOT ALREADY MARKING. Each one SPLITS a
 * mark already being drawn, so the board lights up exactly the pins it lit yesterday and only
 * the arrows change. That is deliberate and it is the whole reason this dial is not 8:00a for
 * the open as well: v0.65 cut 116 clock icons down to the ones worth looking at, and a change
 * about which way the arrows point must not quietly buy that noise back. An ordinary 8:00a–
 * 4:00p dock stays silent, exactly as it is today.
 */
export const EARLY_FINISH_BEFORE = 17 * 60;   // 5:00p

// Icon keys, most binding first. This array IS the precedence.
export const TIME_MARK_KEYS = [
  'hours_shuts_early',   // 1 — rose.  Closes by noon, or open ≤3h. First stop or nothing.
  'hours_early_close',   // 2 — amber. Closes before 3pm. A deadline inside the day.
  'hours_narrow_window', // 3 — teal.  Opens 9am+ AND shuts before 5pm. It has to land mid-day.
  'hours_runs_late',     // 4 — teal.  Opens 9am+ AND still open at 6pm. The day runs late.
  'hours_opens_late',    // 5 — teal.  Opens 9am+. Cannot be your first stop.
  'hours_runs_early',    // 6 — sky.   Open by 6:30a AND shut before 5pm. The day runs early.
  'hours_extra_room',    // 7 — sky.   Opens ≤6:30a or open past 6pm. Good news.
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
  // 3 — nothing binds hard at the close, so the open is the story: too late to lead a route.
  //     BOTH EDGES, OR ONE? A dock that opens at ten and stays open till six has one edge to
  //     plan around and the arrow says which. One that opens at ten and shuts at four has
  //     two, and the second is not a detail: it is the difference between a stop you can put
  //     anywhere after mid-morning and a stop that has to land INSIDE a six-hour box, which
  //     constrains what you put either side of it as well. Drawing them the same pin threw
  //     that away — Chad, on a 10:00a–4:00p dock wearing the single arrow: "the better icon
  //     for a stop like this ... would be arrows pointing inward towards the icon on both
  //     sides not just the one."
  if (o != null && o >= OPENS_LATE_FROM) {
    if (c != null && c < EARLY_FINISH_BEFORE) return 'hours_narrow_window';
    // THE FOURTH CORNER, and it was missing. Chad, having seen the other three: "did you use
    // same logic for opening late and closing late, 2 parallel right facing arrows." He is
    // right that it follows, and right that it was not there — a 10:00a–7:00p dock was drawn
    // with the SAME single arrow as a 10:00a–5:00p one, and on a route those are opposites.
    // Both start late; only one of them is somewhere you can still be at six o'clock, which
    // makes it the stop you push to the END when the day slips. That is the most useful
    // single fact a pin can carry about a late dock, and the map was throwing it away.
    //
    // THE LATE EDGE IS OPEN_LATE_FROM (6:00p), NOT the 5:00p pivot the other two marks use.
    // 5:00p is where a day stops being SHORT; it is not where one starts being LATE — a dock
    // shutting at five is the most ordinary close on the board. OPEN_LATE_FROM is the dial
    // this repo already measured for "still taking freight at six", and hours_extra_room has
    // always used it for exactly this claim. Reusing it keeps one meaning of "late" instead
    // of inventing a second.
    if (c != null && c >= OPEN_LATE_FROM) return 'hours_runs_late';
    return 'hours_opens_late';
  }
  // 4 — room at one end or the other. The only mark that reports GOOD news.
  //     AN EARLY START PAID FOR BY AN EARLY FINISH IS NOT ROOM. A 6:00a–3:00p dock was
  //     drawn with the same outward span as a 6:00a–7:00p one, and they are not the same
  //     stop: the first has no slack at all, its whole day has simply been moved forward.
  //     Chad, on SCOTT LITHOGRAPHING at 6:00a–3:00p: "for a customer like this that opens
  //     before 8 and closes before 5 should be 2 parallel left facing arrows." The dawn
  //     signal survives — which the dials above deliberately protect, see EARLY_CLOSE_BEFORE
  //     — and the pin stops promising slack the dock does not have.
  if (o != null && o <= OPENS_EARLY_BY) {
    return c != null && c < EARLY_FINISH_BEFORE ? 'hours_runs_early' : 'hours_extra_room';
  }
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

// ── THE ROW-SIZED MARK ───────────────────────────────────────────────────────
//
// Chad, looking at a Compare card: "i think there is enough space there to fit our clock
// icons if one applies to a given stop."
//
// WHY THE ICON ALONE IS NOT ENOUGH, and it is this repo's own lesson rather than a
// preference: a value reachable only through a title= tooltip does not exist on a phone
// (v0.54.83 found four of them). A clock face that says "this dock has an edge" without
// saying WHICH edge or WHEN cannot be routed against — the router would have to open every
// marked stop to find out, which is more work than the mark saves. So the chip carries the
// BINDING TIME in words, and the icon carries which kind of edge it is.
//
// The mark itself is classifyTimeMark's, unchanged: the same rule, the same four keys and
// the same silence the map draws by. A dock with ordinary hours gets nothing HERE too — two
// surfaces disagreeing about one rule is this repo's most expensive recurring defect, and
// the way to not have that argument is to not have a second rule.
/**
 * @param note    the customer_notes doc, or null
 * @param dayKey  'mon'..'sun' — the BOARD's day, not today's
 * @returns {{kind, text, title, openMin, closeMin}|null} — null for a dock that constrains
 *   nothing, exactly as timeMarkForDay would return null.
 */
export function timeMarkChip(note, dayKey) {
  const { openMin, closeMin } = dayWindowMinutes(note, dayKey);
  const kind = classifyTimeMark(openMin, closeMin);
  if (!kind) return null;
  const o = Number.isFinite(openMin) ? openMin : null;
  const c = Number.isFinite(closeMin) ? closeMin : null;
  // WHICH EDGE THE MARK IS ABOUT DECIDES WHICH CLOCK THE ROW PRINTS. classifyTimeMark's
  // precedence guarantees the edge it chose is the one that exists — a shuts-early or
  // early-close mark cannot be reached without a close, opens-late cannot be reached
  // without an open — so no branch here can print a clock for a time nobody stated.
  let text;
  if (kind === 'hours_shuts_early' || kind === 'hours_early_close') text = `closes ${fmtMin(c)}`;
  // BOTH-EDGE MARKS PRINT BOTH EDGES. These two are the only kinds whose whole point is that
  // neither edge alone describes the stop, and the branches above guarantee both times exist
  // — each is reachable only with an open AND a close on file — so the chip can state the
  // window without inventing half of one.
  else if (kind === 'hours_narrow_window' || kind === 'hours_runs_early'
    || kind === 'hours_runs_late') text = `${fmtMin(o)}–${fmtMin(c)}`;
  else if (kind === 'hours_opens_late') text = `opens ${fmtMin(o)}`;
  else if (o != null && o <= OPENS_EARLY_BY) text = `opens ${fmtMin(o)}`;
  else text = `open to ${fmtMin(c)}`;
  // The tooltip states the WHOLE window rather than repeating the edge, and states only the
  // half that is on file: "6:00a–" for a dock that never said when it shuts would be a
  // window we invented.
  const window = o != null && c != null ? `${fmtMin(o)}–${fmtMin(c)}`
    : o != null ? `opens ${fmtMin(o)}`
      : `closes ${fmtMin(c)}`;
  return { kind, text, openMin: o, closeMin: c, title: `Receiving ${window}` };
}
