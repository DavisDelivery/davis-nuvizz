// THE FIX FOR THE MISSED REPORT HAD NO WINTER, AND THE SEND WAS NEVER THE CLAIM.
//
// Chad, on the 6:30pm board that did not arrive on 2026-09-02: "This is critical why did no
// email fire?" The root cause is still undetermined — but the investigation into it found two
// defects in the mitigation itself, both proven by running the code rather than reading it:
//
//   1. The spare firing did not exist in winter. Two UTC slots gave summer a primary
//      (18:30 ET) and a spare (19:30 ET), but in EST the first lands at 17:30 ET and
//      correctly stands down — which makes the SECOND the primary, with nothing after it.
//      133 days a year, starting eight weeks after the fix shipped.
//   2. The spare guarded on the SNAPSHOT existing, so a run that recorded the day and then
//      failed to SEND sealed that evening for ever, with every status field reporting
//      success. A single Resend 429 was enough.
//
// These pin both, and the DST sweep is the test that would have caught (1) the first time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReportHour, isAfterReportTime, REPORT_HOUR_ET, REPORT_MINUTE_ET, config,
} from '../netlify/functions/day-completion-report-background.mts';
import {
  needsSending, firingKey, dayReportRunPath, dayCompletionPath,
} from '../netlify/functions/lib/day-completion-store.mts';

// THE SLOTS ARE READ OUT OF THE SHIPPED CRON, NOT COPIED BESIDE IT.
//
// The first version of this file hardcoded [[0,30],[22,30],[23,30]] — so deleting the winter
// slot from the source left every assertion below passing. A sweep that proves invariants
// about slots the TEST declares proves nothing about the job. Caught by mutating the cron
// and watching zero tests fail.
function slotsFromCron(schedule) {
  const [min, hr] = String(schedule).trim().split(/\s+/);
  const mins = min.split(',').map(Number);
  const hrs = hr.split(',').map(Number);
  const out = [];
  for (const h of hrs) for (const m of mins) out.push([h, m]);
  return out.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
}
const SLOTS = slotsFromCron(config.schedule);

test('the sweep is reading the cron the function actually ships', () => {
  // Guards the guard: if this ever reads zero slots, every sweep below passes vacuously.
  assert.ok(SLOTS.length >= 2, `parsed ${SLOTS.length} slots from ${config.schedule}`);
  for (const [h, m] of SLOTS) {
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 23, `bad hour in ${config.schedule}`);
    assert.ok(Number.isInteger(m) && m >= 0 && m <= 59, `bad minute in ${config.schedule}`);
  }
});

/** The ET wall clock and calendar day a given UTC instant lands on — the same Intl path the
 *  handler's etParts/etDayString use, so the sweep exercises the real DST rules. */
function etAt(utcISO) {
  const d = new Date(utcISO);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (k) => p.find((x) => x.type === k).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24, minute: Number(g('minute')) };
}

/** Every firing that reports ON a given ET calendar day, in the order they occur. The 00:30
 *  UTC slot belongs to the PREVIOUS UTC day, which is why this is computed by ET date rather
 *  than assumed. */
function firingsForEtDay(etDate) {
  const out = [];
  for (const offset of [0, 1]) {                       // this UTC day and the next
    const base = new Date(`${etDate}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + offset);
    const ymd = base.toISOString().slice(0, 10);
    for (const [h, m] of SLOTS) {
      const iso = `${ymd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:05Z`;
      const et = etAt(iso);
      if (et.date !== etDate) continue;
      out.push({ utc: iso, ...et, primary: isReportHour(et.hour, et.minute), covers: isAfterReportTime(et.hour, et.minute) });
    }
  }
  return out.sort((a, b) => (a.hour - b.hour) || (a.minute - b.minute));
}

test('THE DEFECT: with only two slots, winter had no spare at all', () => {
  // Reconstructing the shipped-and-wrong version. In EST the 22:30 firing is 17:30 ET and
  // stands down, so 23:30 is the primary and nothing follows it. This is the assertion that
  // was missing, and it is why 133 days of the year had no cover.
  const TWO_SLOTS = [[22, 30], [23, 30]];   // deliberately the OLD cron, not config.schedule
  const jan = '2027-01-13';
  const shapes = TWO_SLOTS.map(([h, m]) => etAt(`${jan}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:05Z`))
    .map((et) => ({ ...et, primary: isReportHour(et.hour, et.minute), covers: isAfterReportTime(et.hour, et.minute) }));
  assert.deepEqual(shapes.map((s) => `${s.hour}:${s.minute}`), ['17:30', '18:30']);
  assert.equal(shapes[0].covers, false, '17:30 ET may never stand in for 6:30');
  assert.equal(shapes[1].primary, true);
  const sparesAfterPrimary = shapes.filter((s) => !s.primary && s.covers).length;
  assert.equal(sparesAfterPrimary, 0, 'this is the gap: no spare exists in winter with two slots');
});

test('THE FIX: every ET day of 2026 and 2027 gets exactly one primary and at least one spare', () => {
  // The sweep that would have caught the winter gap before it shipped. 730 days, both DST
  // transitions in each direction, no exceptions carved out.
  const shapes = new Map();
  let days = 0;
  for (const year of [2026, 2027]) {
    const cur = new Date(Date.UTC(year, 0, 1));
    while (cur.getUTCFullYear() === year) {
      const etDate = cur.toISOString().slice(0, 10);
      const f = firingsForEtDay(etDate);
      const primaries = f.filter((x) => x.primary);
      const spares = f.filter((x) => !x.primary && x.covers);
      const early = f.filter((x) => !x.primary && !x.covers);

      assert.equal(primaries.length, 1, `${etDate}: expected exactly one primary, got ${primaries.length}`);
      assert.ok(spares.length >= 1, `${etDate}: NO SPARE — this is the winter gap`);
      // A spare must never run before the report is due, or it mails a half-finished board.
      for (const s of spares) {
        assert.ok(s.hour > REPORT_HOUR_ET || (s.hour === REPORT_HOUR_ET && s.minute >= REPORT_MINUTE_ET),
          `${etDate}: a spare fired at ${s.hour}:${s.minute}, before the report is due`);
      }
      // Every spare must come AFTER the primary, or it would claim the day first.
      const pMin = primaries[0].hour * 60 + primaries[0].minute;
      for (const s of spares) assert.ok(s.hour * 60 + s.minute > pMin, `${etDate}: spare precedes the primary`);
      // Every firing counted for this day must actually BE this day in ET, or the snapshot
      // and the reconciliation would key to the wrong date.
      for (const x of f) assert.equal(x.date, etDate, `${etDate}: firing ${x.utc} landed on ${x.date}`);

      shapes.set(f.map((x) => `${x.hour}:${String(x.minute).padStart(2, '0')}${x.primary ? '*' : x.covers ? '+' : '-'}`).join(' '),
        (shapes.get(f.map((x) => `${x.hour}:${String(x.minute).padStart(2, '0')}${x.primary ? '*' : x.covers ? '+' : '-'}`).join(' ')) || 0) + 1);
      days += 1;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  assert.equal(days, 730);
  // Exactly two day-shapes exist, and both carry a primary and at least one spare.
  assert.equal(shapes.size, 2, `expected 2 day shapes, got ${[...shapes.keys()].join(' | ')}`);
  for (const [shape] of shapes) {
    assert.ok(shape.includes('*'), `${shape} has no primary`);
    assert.ok(shape.includes('+'), `${shape} has no spare`);
  }
});

test('the winter day that had nothing now has a 7:30pm spare', () => {
  const f = firingsForEtDay('2027-01-13');
  assert.deepEqual(f.map((x) => `${x.hour}:${String(x.minute).padStart(2, '0')}`), ['17:30', '18:30', '19:30']);
  assert.equal(f[0].covers, false, '5:30pm still stands down — the half-finished-board guard');
  assert.equal(f[1].primary, true);
  assert.equal(f[2].covers, true, 'the new 00:30 UTC slot is winter’s spare');
  assert.equal(f[2].primary, false, 'and it must not be a second primary');
});

test('a summer day now has two spares, not one', () => {
  const f = firingsForEtDay('2026-09-03');
  assert.deepEqual(f.map((x) => `${x.hour}:${String(x.minute).padStart(2, '0')}`), ['18:30', '19:30', '20:30']);
  assert.equal(f[0].primary, true);
  assert.equal(f.filter((x) => !x.primary && x.covers).length, 2);
});

test('the DST transition days themselves hold', () => {
  // 2027-03-14 springs forward, 2026-11-01 falls back. A day that gained or lost an hour is
  // exactly where an hour-arithmetic bug shows up.
  for (const d of ['2026-11-01', '2027-03-14', '2026-03-08', '2027-11-07']) {
    const f = firingsForEtDay(d);
    assert.equal(f.filter((x) => x.primary).length, 1, `${d}: not exactly one primary`);
    assert.ok(f.filter((x) => !x.primary && x.covers).length >= 1, `${d}: no spare`);
  }
});

// ── THE SEND IS THE CLAIM, NOT THE SNAPSHOT ─────────────────────────────────
test('a day nobody was mailed about still needs sending, snapshot or not', () => {
  // The live hole: snapshot written, Resend 429, spare stands down because it sees a
  // snapshot, and that evening is unmailable for ever while every field says success.
  assert.equal(needsSending(null), true, 'no document at all');
  assert.equal(needsSending({}), true, 'document with nothing on it');
  assert.equal(needsSending({ snapshot: { open: 31 } }), true, 'SNAPSHOT WRITTEN BUT NEVER SENT — the hole');
  assert.equal(needsSending({ snapshot: { open: 31 }, sent: {} }), true, 'a sent object with no stamp is not a send');
  assert.equal(needsSending({ snapshot: { open: 31 }, sent: { at: null } }), true);
  assert.equal(needsSending({ snapshot: { open: 31 }, sent: { at: '' } }), true);
});

test('a day somebody WAS mailed about is finished — no second email', () => {
  assert.equal(needsSending({ snapshot: { open: 31 }, sent: { at: '2026-09-03T22:31:00Z', to: 'x@y.com' } }), false);
  // And it stands down even with no snapshot on file, which is the honest reading: somebody
  // was told, so nothing is owed.
  assert.equal(needsSending({ sent: { at: '2026-09-03T22:31:00Z' } }), false);
});

test('the heartbeat keys one field per firing and cannot collide', () => {
  assert.equal(firingKey(18, 30), 'et1830');
  assert.equal(firingKey(19, 30), 'et1930');
  assert.equal(firingKey(20, 30), 'et2030');
  assert.equal(firingKey(0, 5), 'et0005');
  // Three firings on one day must produce three distinct keys, or the row overwrites itself
  // and the diagnostic it exists for is lost.
  assert.equal(new Set([firingKey(18, 30), firingKey(19, 30), firingKey(20, 30)]).size, 3);
  // Field paths must stay digit-only — a colon or dot would be read as a nested path.
  for (const [h, m] of [[18, 30], [0, 0], [23, 59]]) assert.match(firingKey(h, m), /^et\d{4}$/);
  // Junk is clamped rather than producing a malformed path.
  assert.match(firingKey(99, 99), /^et\d{4}$/);
  assert.match(firingKey(-1, -1), /^et\d{4}$/);
});

test('the heartbeat lives in its own collection, away from the atomic create guard', () => {
  // Writing it onto the day_completion document would make writeDaySnapshot see an existing
  // record and take its field-masked path instead of createDocIfAbsent — losing the only
  // thing that stops two racing firings both claiming the evening and both mailing.
  assert.notEqual(dayReportRunPath('davis', '2026-09-02'), dayCompletionPath('davis', '2026-09-02'));
  assert.match(dayReportRunPath('davis', '2026-09-02'), /^day_report_runs\/davis__2026-09-02$/);
});
