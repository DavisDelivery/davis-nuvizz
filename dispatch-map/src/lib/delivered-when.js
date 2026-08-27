// src/lib/delivered-when.js — WHICH DAY DID IT ACTUALLY DELIVER? (PURE)
//
// Chad, looking at the Flag history table for 2026-08-26: "Want this to show date it
// actually delivered."
//
// The column could not. It rendered `arrivalMin` — minutes past midnight — which is a number
// between 0 and 1439 and structurally cannot carry a date. `3:09p` on a row graded "Rolled to
// next day" is a time with no day attached, and a reader has no way to tell whether it means
// that afternoon, the next morning, or nothing at all.
//
// AND FOR THE ROWS WHERE THE DATE IS THE WHOLE ANSWER, THERE WAS NO DATE TO SHOW. Measured
// over the six scored days on file (110 rows): all 56 `made` and all 37 `missed` rows carry a
// deliveredAt whose date is the board's own day — so for those the date is redundant but
// harmless. All 11 `rolled` rows carry NO stamp whatsoever. The one outcome that by
// definition delivers on a DIFFERENT day was the only one with no delivery date recorded,
// because the scorer fetched the later day's board and reduced it to a Set of stop numbers
// before reading anything off it. That is fixed upstream (see flag-history.mts
// `rolledDeliveredAt`); this module is what puts the answer on screen.
//
// ── TWO RULES THIS FILE EXISTS TO HOLD ───────────────────────────────────────
//
// 1. NEVER PARSE THE STAMP AS A DATE. deliveredDTTM/arrivalDTTM are NAIVE wall-clock strings
//    with no offset — nuvizz-list says so in as many words, and customer-comms.mts learned it
//    the expensive way: Netlify runs UTC, so `new Date(stamp)` read in Eastern shifts every
//    delivery 4-5 hours BACKWARDS and anything before ~5am lands on the previous DAY. A
//    column whose entire job is the correct date must not be the third place that bug ships.
//    Read the digits.
//
// 2. NEVER INVENT A DAY. A row with a time but no stamp (every row scored before this
//    shipped) says "date not recorded" — it does not borrow the board's date and present it
//    as observed. A rolled stop seen on a later board but not yet delivered there says "still
//    open", not a delivery. Present on a board is not delivered off it.
//
// Returns the MINUTES rather than a formatted time, so the cell keeps using the table's own
// fmtMinOfDay and two clock formats cannot drift apart.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Digits out of a naive "YYYY-MM-DDTHH:MM" stamp. Null for anything else. Never Date.parse. */
export function stampParts(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v ?? '').trim());
  if (!m) return null;
  const hh = Number(m[4]), mm = Number(m[5]);
  if (!(hh >= 0 && hh <= 23) || !(mm >= 0 && mm <= 59)) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, hh, mm, minutes: hh * 60 + mm };
}

/** "Aug 27", or "Jan 2, 2027" when the year is not the one the reader is looking at. */
export function dayLabel(ymd, refYmd = null) {
  const m = YMD.exec(String(ymd ?? '').trim());
  if (!m) return null;
  const mon = MONTHS[Number(m[2]) - 1];
  if (!mon) return null;
  const ref = YMD.exec(String(refYmd ?? '').trim());
  const sameYear = ref ? ref[1] === m[1] : true;
  return sameYear ? `${mon} ${Number(m[3])}` : `${mon} ${Number(m[3])}, ${m[1]}`;
}

/** Whole days from `a` to `b` on the digits, so no timezone can roll it. Null if either is junk. */
export function dayGap(a, b) {
  const x = YMD.exec(String(a ?? '').trim());
  const y = YMD.exec(String(b ?? '').trim());
  if (!x || !y) return null;
  const ms = Date.UTC(+y[1], +y[2] - 1, +y[3]) - Date.UTC(+x[1], +x[2] - 1, +x[3]);
  return Math.round(ms / 86400000);
}

/**
 * "Aug 27 (next day)" — the gap spelled out, because "+1" is not what a dispatcher says.
 *
 * Parenthesised rather than separated by a middle dot: this column is ~90px wide on a phone,
 * the note wraps, and a trailing " · " left the separator dangling at the end of a line with
 * nothing after it. Rendered and looked at on a 390px screen before choosing.
 */
function laterNote(boardDate, ymd) {
  const label = dayLabel(ymd, boardDate);
  if (!label) return null;
  const gap = dayGap(boardDate, ymd);
  if (gap == null || gap <= 0) return label;
  return gap === 1 ? `${label} (next day)` : `${label} (${gap} days later)`;
}

/**
 * deliveredWhen(row, { boardDate }) → what the Delivered cell should say, or null for "—".
 *
 *   { minutes, tone, note }
 *     minutes  ET minutes past midnight to print, or null when there is no time to print.
 *     tone     'same'    delivered on the board's own day — the ordinary case.
 *              'later'   delivered on a DIFFERENT day. The one the column was hiding.
 *              'open'    rolled onto a later board and had not delivered there when scored.
 *              'missing' we have a time or a roll but no date on file for it.
 *     note     the sub-line under the time. Never null when tone is not 'same'.
 *
 * `row` is a flag-history row. An absent or malformed row is null — the cell prints "—",
 * which is what "we have nothing" should look like.
 */
export function deliveredWhen(row, { boardDate = null } = {}) {
  if (!row || typeof row !== 'object') return null;
  const board = YMD.test(String(boardDate ?? '').trim()) ? String(boardDate).trim() : null;

  // A ROLL DELIVERS SOMEWHERE ELSE. classifyOutcome only reaches 'rolled' when the flag's own
  // day has no stamp at all, so the answer is never on this row's deliveredAt — it is on the
  // later board, and until v0.81.2 nothing carried it here.
  if (row.outcome === 'rolled') {
    const p = stampParts(row.rolledDeliveredAt);
    if (p) {
      const same = board != null && p.date === board;
      return {
        minutes: p.minutes,
        tone: same ? 'same' : 'later',
        note: same ? dayLabel(p.date, board) : laterNote(board, p.date),
      };
    }
    const seen = dayLabel(row.rolledOnDate, board);
    // On a later board, not delivered off it. Saying "still open" is the difference between a
    // late delivery and freight that is still sitting there.
    if (seen) return { minutes: null, tone: 'open', note: `still open ${seen}` };
    // Scored before the roll date was recorded. Every rolled row on file today is this one.
    return { minutes: null, tone: 'missing', note: 'roll date not recorded' };
  }

  const p = stampParts(row.deliveredAt);
  if (p) {
    const same = board == null || p.date === board;
    return {
      minutes: p.minutes,
      tone: same ? 'same' : 'later',
      note: same ? dayLabel(p.date, board) : laterNote(board, p.date),
    };
  }

  // A graded time with no stamp behind it. Show the time, and say plainly that the DAY is not
  // something we recorded — rather than quietly captioning it with the day being viewed.
  const min = Number(row.arrivalMin);
  if (row.arrivalMin != null && Number.isFinite(min)) {
    return { minutes: min, tone: 'missing', note: 'date not recorded' };
  }
  return null;
}
