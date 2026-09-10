// THE PARSE RUNS AT 8:10p, 9:10p AND 10:10p ET — EVERY DAY OF THE YEAR.
//
// Chad: "We need to do our first parse at 8:10 pm 9:10 10:10".
//
// It used to poll every 30 minutes around the clock, which is how a 3:00pm check on a report
// Uline had not sent yet ended up on screen saying it could not reconcile against its own
// printed totals. Three passes in the window the report actually lands in is the ask.
//
// THE REASON THIS FILE EXISTS RATHER THAN A COMMENT: the cron is UTC and ET is not, so a fixed
// UTC time is the wrong ET time for 133 days a year. day-completion-report-background carries
// the scar — two UTC slots gave summer a primary and a spare and left WINTER with no cover at
// all, "found by sweeping both firings across 730 calendar days, not by reading the cron".
// So this sweeps too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isParseHour, PARSE_HOURS_ET } from '../netlify/functions/manifest-email-ingest-background.mts';

/** The cron's UTC firing hours, from `config.schedule = '10 0,1,2,3 * * *'`. */
const FIRING_HOURS_UTC = [0, 1, 2, 3];
const MINUTE = 10;

const etHourOf = (d) => Number(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', hour12: false,
}).formatToParts(d).find((x) => x.type === 'hour').value) % 24;

test('the three ET hours are the ones Chad named', () => {
  assert.deepEqual(PARSE_HOURS_ET, [20, 21, 22]);
  for (const h of [20, 21, 22]) assert.equal(isParseHour(h), true);
  for (const h of [0, 7, 15, 19, 23]) assert.equal(isParseHour(h), false, `${h}:00 ET must stand down`);
});

test('EVERY DAY OF THE YEAR gets exactly three passes, at 8:10p, 9:10p and 10:10p ET', () => {
  // 730 days, both DST transitions, both directions. A UTC-only cron would silently drift an
  // hour in winter and this is the assertion that would catch it.
  const start = Date.UTC(2026, 0, 1);
  const byEtDay = new Map();
  for (let day = 0; day < 730; day += 1) {
    for (const h of FIRING_HOURS_UTC) {
      const at = new Date(start + day * 86400000 + h * 3600000 + MINUTE * 60000);
      const etHour = etHourOf(at);
      if (!isParseHour(etHour)) continue;
      // Key by the ET calendar day this firing lands on, so a UTC day boundary cannot smear
      // one night's passes across two rows.
      const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(at);
      if (!byEtDay.has(etDay)) byEtDay.set(etDay, []);
      byEtDay.get(etDay).push(etHour);
    }
  }
  // Drop the first and last ET days: the sweep window clips them, not the schedule.
  const days = [...byEtDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).slice(1, -1);
  assert.ok(days.length > 700, `expected a full sweep, got ${days.length} days`);

  const wrong = days.filter(([, hours]) => JSON.stringify([...hours].sort((a, b) => a - b)) !== '[20,21,22]');
  assert.deepEqual(wrong.slice(0, 5), [], 'every ET day must get 8:10p, 9:10p and 10:10p — no more, no fewer');
});

test('the spare firing stands down in the season it is not needed, rather than doubling up', () => {
  // EDT: 00:10 01:10 02:10 UTC are the real ones and 03:10 is 11:10p ET — too late.
  // EST: 01:10 02:10 03:10 UTC are the real ones and 00:10 is 7:10p ET — too early.
  const summer = (h) => etHourOf(new Date(Date.UTC(2026, 6, 15, h, MINUTE)));   // July, EDT
  const winter = (h) => etHourOf(new Date(Date.UTC(2026, 0, 15, h, MINUTE)));   // January, EST
  assert.equal(isParseHour(summer(3)), false, 'EDT: the 03:10 UTC firing is 11:10p ET');
  assert.equal(summer(0), 20, 'EDT: 00:10 UTC is the 8:10p ET first parse');
  assert.equal(isParseHour(winter(0)), false, 'EST: the 00:10 UTC firing is only 7:10p ET');
  assert.equal(winter(3), 22, 'EST: 03:10 UTC is the 10:10p ET last parse');
});
