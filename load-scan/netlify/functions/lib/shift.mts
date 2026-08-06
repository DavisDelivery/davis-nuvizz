// shift.mts — the operating day on this dock, which is NOT the calendar day.
//
// ── THE SHIFT ────────────────────────────────────────────────────────────────
//
// Loaders work 8:00 PM to 8:00 AM. The week runs:
//
//   Sunday   20:00 -> Monday    08:00
//   Monday   20:00 -> Tuesday   08:00
//   Tuesday  20:00 -> Wednesday 08:00
//   Wednesday20:00 -> Thursday  08:00
//   Thursday 20:00 -> Friday    08:00
//
// so a single shift straddles midnight and therefore straddles two calendar
// dates. Reporting on the calendar date would split every shift in half — the
// first four hours filed under one day, the last eight under the next — and
// every "how long did that load take" would be wrong for the trucks worked
// either side of midnight.
//
// ── THE RULE ─────────────────────────────────────────────────────────────────
//
// The day rolls over at 20:00 ET. A timestamp at or after 20:00 belongs to the
// NEXT calendar date; anything before belongs to the current one.
//
//   Sunday 19:59  ->  Sunday      (before rollover)
//   Sunday 20:00  ->  Monday      (the shift that ends Monday morning)
//   Monday 03:00  ->  Monday      (same shift, after midnight)
//   Monday 07:59  ->  Monday      (same shift, last minute of it)
//   Monday 09:00  ->  Monday      (daytime gap: still filed to Monday)
//   Monday 20:00  ->  Tuesday     (next shift begins)
//
// A shift is therefore LABELLED BY THE MORNING IT ENDS. That is deliberate and
// it is the choice a logistics reader would expect, for two reasons:
//
//   1. Freight loaded Sunday night goes out for MONDAY delivery. The label
//      matches the delivery date the rest of the business already uses.
//   2. It matches the manifest date the app already loads, so "the Monday
//      board" and "the Monday shift" are the same word for the same freight.
//
// ── CONFIRMED, NOT ASSUMED ───────────────────────────────────────────────────
//
// This was put to Chad directly and confirmed: the Sunday-night shift is called
// MONDAY. Do not "fix" it to label by the start date — that would silently
// re-date every historical report and put the numbers an operating day out of
// step with the rest of the business.
//
// ── DST ──────────────────────────────────────────────────────────────────────
//
// The boundary is read as ET WALL-CLOCK time via Intl, not as a fixed UTC
// offset, so it stays at 8pm local on both sides of a DST change. US changes
// happen at 02:00 local, never at 20:00, so the boundary itself is never inside
// a transition. In November the 01:00-01:59 hour occurs twice; both instances
// are before 20:00, so both file to the same shift day and no work is lost or
// duplicated. In March 02:00-02:59 does not exist, which the boundary never
// touches either.

/** The hour (ET, 24h) at which one operating day becomes the next. */
export const ROLLOVER_HOUR = 20;

const ET = 'America/New_York';

/** Wall-clock parts in ET. hour is 0-23 (hourCycle h23 so midnight is 0, not 24). */
function etParts(d: Date): { date: string; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/**
 * Add days to a YYYY-MM-DD string.
 *
 * Anchored at noon UTC on purpose: parsing a bare date gives midnight UTC, and
 * adding days to midnight can land on the wrong side of a DST shift once the
 * result is re-read in a zone behind UTC. Noon has 12 hours of slack either way.
 */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d, 12, 0, 0) + n * 86400000;
  const dt = new Date(t);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** The shift day a moment belongs to. See the rule at the top of this file. */
export function shiftDayString(d: Date = new Date()): string {
  const { date, hour } = etParts(d);
  return hour >= ROLLOVER_HOUR ? addDays(date, 1) : date;
}

/** Same, for an ISO string. Returns '' for anything unparseable. */
export function shiftDayOf(iso: any): string {
  const t = Date.parse(String(iso ?? ''));
  return Number.isNaN(t) ? '' : shiftDayString(new Date(t));
}

/**
 * The window a shift day covers, as ISO instants: [start, end).
 *
 * Start is 20:00 ET on the PREVIOUS calendar date, end is 20:00 ET on the shift
 * day itself. Computed by probing the actual UTC instant that reads as 20:00 ET,
 * so it is correct on both sides of a DST change rather than assuming -05:00.
 */
export function shiftWindow(shiftDay: string): { start: string; end: string } {
  return { start: etInstantAt(addDays(shiftDay, -1), ROLLOVER_HOUR), end: etInstantAt(shiftDay, ROLLOVER_HOUR) };
}

/**
 * The UTC instant at which the given ET date reads `hour` on the wall clock.
 *
 * ET is UTC-5 or UTC-4. Try both; keep the candidate that actually reads back as
 * the hour we asked for. That is a two-line search instead of a timezone table,
 * and it cannot drift when the DST rules change.
 */
function etInstantAt(dateStr: string, hour: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  for (const offset of [4, 5]) {
    const guess = new Date(Date.UTC(y, m - 1, d, hour + offset, 0, 0));
    const back = etParts(guess);
    if (back.date === dateStr && back.hour === hour) return guess.toISOString();
  }
  // Unreachable for real dates; fall back to the -05:00 reading rather than throw
  // on a report request.
  return new Date(Date.UTC(y, m - 1, d, hour + 5, 0, 0)).toISOString();
}

/**
 * Is this shift day one the dock actually runs?
 *
 * Shifts start Sunday night through Thursday night, so the shift days (labelled
 * by the morning they end) are Monday through Friday. A Saturday or Sunday label
 * means work happened outside the normal week — which is worth SHOWING in a
 * report, not hiding, so this only marks it.
 */
export function isScheduledShift(shiftDay: string): boolean {
  const [y, m, d] = shiftDay.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0 Sun … 6 Sat
  return dow >= 1 && dow <= 5;
}

/** Human label for a shift day: "Mon Aug 4 → Tue Aug 5 8am". */
export function shiftLabel(shiftDay: string): string {
  const fmt = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  };
  return `${fmt(addDays(shiftDay, -1))} 8pm → ${fmt(shiftDay)} 8am`;
}

/** The last N shift days ending at `endDay`, most recent first. */
export function recentShiftDays(endDay: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(1, n); i++) out.push(addDays(endDay, -i));
  return out;
}
