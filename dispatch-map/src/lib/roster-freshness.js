// src/lib/roster-freshness.js — HOW OLD IS THE LOAD ROSTER, AND CAN THE DISPATCHER TELL? (PURE)
//
// Chad, 2026-09-05, looking at Tue Sep 8 from a Saturday: "Where are all my empty loads."
// Then, after the rail's Loads tab was fixed to show exactly those: "even on the bottom panel
// the empty loads are missing."
//
// He was right that they were missing and wrong about the cause, and NOTHING on the screen
// could have told him which. Measured on the shipped bundle: given a roster of 100 empty
// Drafts the bottom grid renders all 100 — on v0.93.0, on v0.93.1 and on v0.93.2 alike. So
// the grid was not dropping them. The roster it was handed for that day had three loads in
// it, and all three carry stops.
//
// ── WHY A THREE-DAY-OUT ROSTER CAN BE WRONG AND STAY WRONG ──────────────────
// The roster the app reads is a CACHE (nuvizz_load_roster/<tenant>__<date>), and for a FUTURE
// date the scanner captures it ONCE per ET scan day — refresh-stops-core's
// futureRosterCaptured, written on a premise Chad gave about TOMORROW: "the shells are
// generated up front, the set doesn't change through the day." That holds for tomorrow. It
// does not hold for a day two or three out, and this weekend is the case that proves it:
// from Saturday the horizon reaches Tuesday, Monday is Labor Day, and Tuesday's empty
// trailers are not created yet. Whatever the first capture of the day saw is what the board
// shows until the next scan day — and nuvizz-loads-roster's documented `?live=1` escape
// hatch, the one thing that would fix it in a second, HAD NO CALLER ANYWHERE IN THE CLIENT.
// Three fetch sites, none of them passing it. A switch whose position cannot be read is not a
// switch; an override nothing can reach is not an override.
//
// So this module answers the question the screen could not: what is this roster, how old is
// it, and is that age a normal one. It is deliberately POOR at guessing. There is no invented
// staleness threshold — "over 90 minutes is stale" would be a private invisible bar of exactly
// the kind that has bitten this repo before. The one staleness signal here is a FACT with a
// meaning: a capture taken on an EARLIER ET day means today's scanner has not refreshed it,
// which is the code's own rule, not an opinion about minutes.

const ET_TZ = 'America/New_York';

/**
 * "YYYY-MM-DD" for a Date in ET. Injectable clock — the app's todayInET() is not.
 *
 * The emptiness is rejected BEFORE the coercion, and that is not defensive padding: `new
 * Date(null)` is the epoch, a perfectly valid Date, so the obvious NaN guard let a missing
 * stamp through as 1969-12-31 — which then reads as "captured before today" and paints a
 * stale warning on a roster that simply never carried a timestamp. Same shape as the
 * Number(null) === 0 bug that once emailed a customer a midnight deadline for a stop with no
 * deadline at all.
 */
export function etDay(d) {
  if (d === null || d === undefined || d === '') return null;
  const t = d instanceof Date ? d : new Date(d);
  if (!(t instanceof Date) || Number.isNaN(t.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}

/**
 * "just now" / "12m ago" / "3h ago" / "2d ago" / "Jun 12" — null when there is no usable stamp.
 *
 * Lifted verbatim from App.jsx's fmtRosterAge (which now calls this) so the driver roster and
 * the load roster cannot drift into describing the same age two different ways. The rounding
 * is kept exactly as it was; changing it would silently move a label the driver panel ships.
 */
export function ageLabel(iso, now = new Date()) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (Number.isNaN(nowMs)) return null;
  const mins = Math.round((nowMs - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * rosterFreshness(meta, now) → what the Loads surfaces say about the roster they are showing.
 *
 * `meta` is the load-roster endpoint's own envelope: { ok, source, at, count }. Anything else
 * — null, a rejected fetch, ok:false, a 502 — is ABSENT, and absent is not zero: "NuVizz has
 * no empty loads for this day" and "we never pulled this day's roster" produce an identical
 * empty list and call for opposite actions.
 *
 * Returns { known, live, stale, count, age, label, tone }:
 *   known  — did we get a roster at all
 *   live   — it came straight from NuVizz on this fetch (the ?live=1 path)
 *   stale  — it is a cache captured on an EARLIER ET day (see the header: the scanner takes
 *            one capture per day for a future date, so a yesterday stamp means nothing today
 *            has refreshed it). Never a guess about minutes.
 *   age    — ageLabel of the capture, or null
 *   label  — one line a dispatcher can act on
 *   tone   — 'absent' | 'stale' | 'cached' | 'live', for the caller's colours
 */
export function rosterFreshness(meta, now = new Date()) {
  // `source: 'none'` is the endpoint saying "I hold nothing for this date, and I did not spend
  // a call to find out" — an automatic read never reaches NuVizz any more. It answers ok:true
  // because nothing went wrong, and it must still read as ABSENT here: a date we have never
  // captured is not a date with no loads, and the two call for opposite actions.
  const ok = !!(meta && meta.ok === true) && meta.source !== 'none';
  if (!ok) {
    return { known: false, live: false, stale: false, count: 0, age: null, tone: 'absent',
      label: 'Load roster not pulled for this day' };
  }
  const raw = Number(meta.count);
  const count = Number.isFinite(raw) ? raw : (Array.isArray(meta.loads) ? meta.loads.length : 0);
  const live = meta.source === 'live';
  const age = ageLabel(meta.at, now);
  const capturedDay = meta.at ? etDay(meta.at) : null;
  const today = etDay(now);
  // Only a CACHE can be stale, and only against a day boundary we can actually name. A
  // capture with no readable stamp is reported as unknown-age, never asserted to be stale.
  const stale = !live && !!capturedDay && !!today && capturedDay !== today;
  const loads = `${count} load${count === 1 ? '' : 's'}`;
  if (live) return { known: true, live: true, stale: false, count, age, tone: 'live', label: `${loads} · straight from NuVizz` };
  if (!age) return { known: true, live: false, stale, count, age: null, tone: stale ? 'stale' : 'cached', label: `${loads} · cached, time unknown` };
  return { known: true, live: false, stale, count, age, tone: stale ? 'stale' : 'cached',
    label: `${loads} · cached ${age}${stale ? ' (before today)' : ''}` };
}
