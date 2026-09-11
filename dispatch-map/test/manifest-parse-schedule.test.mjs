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

/** The cron's UTC firing hours, from `config.schedule = '10 0,1,2,3,5,6 * * *'`. */
const FIRING_HOURS_UTC = [0, 1, 2, 3, 5, 6];
const MINUTE = 10;

const etHourOf = (d) => Number(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', hour12: false,
}).formatToParts(d).find((x) => x.type === 'hour').value) % 24;

test('the ET hours are the three Chad named, plus the one that closes the night', () => {
  // 8:10p/9:10p/10:10p are his. 1:10a was added because Uline's last send is ~12:30a ET, so
  // the three he named could never see the biggest copies of the report.
  assert.deepEqual(PARSE_HOURS_ET, [1, 20, 21, 22]);
  for (const h of [1, 20, 21, 22]) assert.equal(isParseHour(h), true);
  for (const h of [0, 2, 7, 15, 19, 23]) assert.equal(isParseHour(h), false, `${h}:00 ET must stand down`);
});

test('PARSE_HOURS_ET stays ASCENDING — lastParseSlot reads it positionally', () => {
  // It filters the slots that have passed and takes the LAST, which is only the most recent
  // one when the array is sorted; and it reads the final entry as the previous ET day's last
  // pass, which is 10:10p. Putting 1 at the end would break both silently.
  assert.deepEqual([...PARSE_HOURS_ET].sort((a, b) => a - b), PARSE_HOURS_ET);
  assert.equal(PARSE_HOURS_ET[PARSE_HOURS_ET.length - 1], 22);
});

test('EVERY DAY OF THE YEAR gets exactly four passes: 1:10a, 8:10p, 9:10p and 10:10p ET', () => {
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

  // NEVER FEWER THAN FOUR. This is the half that matters: a missing pass is a night's
  // manifest not read, and a UTC-only cron would drop one every winter.
  const short = days.filter(([, hours]) => ![1, 20, 21, 22].every((h) => hours.includes(h)));
  assert.deepEqual(short.slice(0, 5), [], 'every ET day must get 1:10a, 8:10p, 9:10p and 10:10p');

  // AND EXACTLY FOUR, except the one night a year when 1:10a ET happens twice.
  //
  // On fall-back the clock runs 1:59a EDT -> 1:00a EST, so the ET hour 1 occurs TWICE and both
  // UTC firings that map to it are real passes. The duplicate is a no-op by construction —
  // the first pass marks every email it reads and the marker is what stops it ever being read
  // again, so the second costs one list call per mailbox and files nothing.
  //
  // It is allowed rather than designed out because every alternative is worse: ET hour 2 does
  // not EXIST on the spring-forward day (2:00a jumps to 3:00a), which would cost a whole
  // night's late pass, and 12:10a lands before Uline's ~12:30a last send, which is the entire
  // reason this pass exists. A free duplicate once a year beats a missed night once a year.
  const dstFallBack = new Set(days
    .filter(([, hours]) => hours.filter((h) => h === 1).length === 2)
    .map(([d]) => d));
  assert.ok(dstFallBack.size <= 3, `expected ~one duplicate per year, got ${dstFallBack.size}`);
  for (const d of dstFallBack) {
    const month = Number(d.slice(5, 7));
    const dom = Number(d.slice(8, 10));
    assert.equal(month, 11, `${d}: the duplicate may only fall on the November fall-back`);
    assert.ok(dom <= 7, `${d}: fall-back is the FIRST Sunday in November`);
  }

  const wrong = days.filter(([d, hours]) => !dstFallBack.has(d)
    && JSON.stringify([...hours].sort((a, b) => a - b)) !== '[1,20,21,22]');
  assert.deepEqual(wrong.slice(0, 5), [], 'every other ET day must get exactly four — no more, no fewer');
});

test('the spare firing stands down in the season it is not needed, rather than doubling up', () => {
  // EDT: 00:10 01:10 02:10 05:10 UTC are real; 03:10 is 11:10p and 06:10 is 2:10a — neither is a pass.
  // EST: 01:10 02:10 03:10 06:10 UTC are real; 00:10 is 7:10p and 05:10 is 12:10a — neither is a pass.
  const summer = (h) => etHourOf(new Date(Date.UTC(2026, 6, 15, h, MINUTE)));   // July, EDT
  const winter = (h) => etHourOf(new Date(Date.UTC(2026, 0, 15, h, MINUTE)));   // January, EST
  assert.equal(isParseHour(summer(3)), false, 'EDT: the 03:10 UTC firing is 11:10p ET');
  assert.equal(summer(0), 20, 'EDT: 00:10 UTC is the 8:10p ET first parse');
  assert.equal(isParseHour(winter(0)), false, 'EST: the 00:10 UTC firing is only 7:10p ET');
  assert.equal(winter(3), 22, 'EST: 03:10 UTC is the 10:10p ET last parse');
});
