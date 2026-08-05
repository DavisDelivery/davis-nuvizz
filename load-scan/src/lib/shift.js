// shift.js — the client's copy of the operating-day rule.
//
// The SERVER is authoritative: every work event is filed under the shift day
// derived from its own timestamp, server-side, so a phone with a wrong clock can
// never misfile work. This copy exists only so the app can show the right shift
// and ask for the right assignments before any event is written.
//
// The rule, in full, lives in netlify/functions/lib/shift.mts. In short: the day
// rolls over at 20:00 ET, so a shift is labelled by the MORNING IT ENDS.

export const ROLLOVER_HOUR = 20;

const ET = 'America/New_York';

function etParts(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

export function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12) + n * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** The shift day this moment belongs to. */
export function shiftDayString(d = new Date()) {
  const { date, hour } = etParts(d);
  return hour >= ROLLOVER_HOUR ? addDays(date, 1) : date;
}

/** "Sun Aug 2 8pm → Mon Aug 3 8am" — so nobody has to decode the date key. */
export function shiftLabel(shiftDay) {
  const fmt = (s) => {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  };
  return `${fmt(addDays(shiftDay, -1))} 8pm → ${fmt(shiftDay)} 8am`;
}

/** Minutes as "1h 20m" / "45m" — a duration a person reads, not a number. */
export function fmtMinutes(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** An ISO instant as an ET clock time — the only form that means anything on a dock. */
export function fmtClock(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(t));
}
