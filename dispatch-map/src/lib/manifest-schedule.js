// manifest-schedule.js
//
// WHEN THE NIGHTLY MANIFEST PARSE RUNS — one source of truth for the job and the screen.
//
// Chad, 2026-09-09: "We need to do our first parse at 8:10 pm 9:10 10:10".
//
// This module exists because the change that narrowed the schedule left the Manifest check
// tab still saying "Checked automatically every 30 minutes" in two places. The job ran three
// times a night and the screen promised forty-eight, which is the same class of failure as
// the alert wired to `critical` while the operator had been told "we want every red": the
// code did exactly what it was told and the screen described a different system. The cure is
// not a more careful edit next time — it is that there is now only one place to edit.
//
// The netlify function imports PARSE_HOURS_ET/isParseHour from here; the React card imports
// the label and the staleness check. Functions already import from src/lib (the Uline
// forecast store reads davis-calendar.js this way), so the direction is the house one.
const ET_TZ = 'America/New_York';

/**
 * The ET hours a parse pass is real. The cron fires the UNION of the UTC slots that could be
 * one of these in either season and the handler stands the wrong ones down — see the
 * function's own header.
 *
 * WHY THERE IS A 1:10a PASS. Chad set 8:10p/9:10p/10:10p on 2026-09-09, and that was right
 * about where Uline's report lands and wrong about when it STOPS. Read out of the mailbox
 * rather than assumed, Uline sends the night's report hourly from 8:00p and then once more at
 * about 12:30a — measured on two consecutive nights:
 *
 *   9/9 night   10:51a · 8:00p 9:00p 10:00p 11:00p 12:00a 12:30a   (7 sends)
 *   9/10 night  10:51a · 8:00p 9:01p 10:00p 11:01p …               (still sending at 11p)
 *
 * So the last pass at 10:10p could never see the 11p, midnight and 12:30a copies — and those
 * are the COMPLETE ones, because the manifest is append-only and each send is a superset of
 * the last. They waited until 8:10p the FOLLOWING night, which is how the 9/9 night's reports
 * #5, #6 and #7 came to be filed twenty hours late, and how they then ate the whole of the
 * 9/10 8:10p pass under the per-run cap. One pass at 1:10a — forty minutes after Uline's last
 * send — closes the night it belongs to. Reports still file under the night their ROWS name
 * (manifest-archive reads the ship date off the paper), so a 1:10a pass files to the evening
 * that just ended, not to the new calendar day.
 *
 * KEEP THIS ARRAY ASCENDING. lastParseSlot maps it to "HH:MM" strings, filters the ones that
 * have passed and takes the LAST — which is only the most recent slot if the array is sorted.
 * It also reads the final entry as the last pass of the PREVIOUS ET day, which is 22:10 and
 * is why 1 sits at the front rather than the end.
 */
export const PARSE_HOURS_ET = [1, 20, 21, 22];

/** Ten past, on every one of them. */
export const PARSE_MINUTE_ET = 10;

/** What the screen says out loud. Written once so the card and the tab agree. */
export const PARSE_SCHEDULE_LABEL = '8:10p, 9:10p, 10:10p and 1:10a ET';

/** PURE. Is this ET hour one of the passes? The minute is deliberately not tested: the
 *  cron fires once an hour at :10, so the hour alone identifies the firing, and testing the
 *  minute would make the job miss its slot on a platform that runs it a minute late. */
export function isParseHour(hour) {
  return PARSE_HOURS_ET.includes(Number(hour));
}

/**
 * "YYYY-MM-DDTHH:MM" for an instant, on the ET wall clock. Null for anything unusable.
 *
 * Emptiness is rejected BEFORE the coercion, exactly as roster-freshness.js does and for the
 * same reason: `new Date(null)` is the epoch, a perfectly valid Date, so a NaN-only guard
 * turns a missing stamp into 1969 — which then reads as "ancient" and paints a warning on a
 * card that simply never carried a timestamp.
 *
 * EVERY COMPARISON IN THIS FILE IS A STRING COMPARE OF TWO OF THESE, which is what makes it
 * DST-proof without arithmetic. Both sides are rendered through the same formatter, so
 * "did this poll happen after that slot" never has to know how many real minutes a night was.
 */
export function etStamp(d) {
  if (d === null || d === undefined || d === '') return null;
  const t = d instanceof Date ? d : new Date(d);
  if (!(t instanceof Date) || Number.isNaN(t.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(t).reduce((a, x) => (a[x.type] = x.value, a), {});
  // en-CA renders midnight as "24" in some engines; normalise so the string sorts.
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}`;
}

/**
 * The most recent parse slot that has already fired, as an ET stamp — or null when the clock
 * is unusable. `graceMin` is subtracted from `now` first, so a card rendered at 8:10:30p does
 * not call the 8:10p pass late while the background function is still fetching the mailbox.
 */
export function lastParseSlot(now = new Date(), graceMin = 20) {
  const at = etStamp(new Date((now instanceof Date ? now : new Date(now)).getTime() - graceMin * 60000));
  if (!at) return null;
  const day = at.slice(0, 10);
  const hhmm = at.slice(11);
  const passed = PARSE_HOURS_ET
    .map((h) => `${String(h).padStart(2, '0')}:${String(PARSE_MINUTE_ET).padStart(2, '0')}`)
    .filter((s) => s <= hhmm);
  // Nothing tonight yet: the last real pass was the 10:10p one on the previous ET day. The
  // date is stepped in UTC and then re-rendered in ET, so a spring-forward night cannot land
  // it on the wrong calendar day.
  if (!passed.length) {
    const prev = etStamp(new Date(`${day}T12:00:00Z`).getTime() - 24 * 3600 * 1000);
    if (!prev) return null;
    return `${prev.slice(0, 10)}T${String(PARSE_HOURS_ET[PARSE_HOURS_ET.length - 1]).padStart(2, '0')}:${String(PARSE_MINUTE_ET).padStart(2, '0')}`;
  }
  return `${day}T${passed[passed.length - 1]}`;
}

/**
 * Has the mailbox gone unread through a pass that should have read it?
 *
 * THIS IS THE HEALTH SIGNAL THE OLD CADENCE GAVE AWAY FOR FREE and this one does not. Polling
 * every thirty minutes, a lapsed Gmail token showed "Last poll 4h ago" by mid-afternoon and
 * anybody looking could see it. Polling three times a night, a dead token reads "Last poll
 * 26h ago" — barely distinguishable from the 22h a perfectly healthy system shows all day.
 * So the comparison is against THE SCHEDULE, not against a clock: a pass has fired and the
 * mailbox has not been read since. That is a fact, not an invented staleness threshold.
 *
 * No stamp at all is NOT overdue — a mailbox connected this afternoon has never polled and is
 * not broken. The card says "No poll has run yet" for that, which is the honest sentence.
 */
export function parsePollOverdue(lastRunAt, now = new Date(), graceMin = 20) {
  const ran = etStamp(lastRunAt);
  if (!ran) return false;
  const slot = lastParseSlot(now, graceMin);
  if (!slot) return false;
  return ran < slot;
}
