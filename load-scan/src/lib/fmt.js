// fmt.js — display formatting.
//
// House rule: dates read "Jul 29, 2026" / "Jul 2026". Never ISO, never bare
// numeric. A driver reading 07/29 vs 29/07 at 5am should not have to guess.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07-29" or a Date -> "Jul 29, 2026". Returns '' for anything unparseable. */
export function fmtDate(v) {
  if (!v) return '';
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
  const d = v instanceof Date ? v : new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "Jul 2026". */
export function fmtMonth(v) {
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Clock time in the dock's timezone: "5:12a". */
export function fmtTime(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('hour')}:${get('minute')}${get('dayPeriod').toLowerCase().startsWith('a') ? 'a' : 'p'}`;
}

/** "Jul 29, 2026 5:12a" — used in the dispatcher tables. */
export function fmtDateTime(v) {
  const d = fmtDate(v);
  const t = fmtTime(v);
  return d && t ? `${d} ${t}` : d || '';
}

/** ET calendar day, matching the server's etDayString. */
export function etToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
