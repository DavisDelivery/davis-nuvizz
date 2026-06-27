// Centralized "today" derivation for the root app. Mirrors
// dispatch-map/src/lib/date-util.js so both front-end apps agree on the
// calendar day. "Today" is the America/New_York (Buford GA) calendar day,
// never UTC — `new Date().toISOString().slice(0,10)` is wrong overnight
// (after ~8pm ET, UTC has already rolled to tomorrow and the board would
// jump a day ahead of the dispatcher's wall clock).

const ET_TZ = 'America/New_York';

// "YYYY-MM-DD" for the current calendar day in America/New_York.
// en-CA formats as YYYY-MM-DD, which is exactly the shape our APIs want.
export function todayInET() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// True if the given "YYYY-MM-DD" string is today in ET.
export function isTodayET(dateString) {
  return dateString === todayInET();
}
