// test/flag-detail.test.mjs
//
// ONE FLAG, EXPLAINED — every rule pinned on a REAL stored row.
//
// Chad: "I want to be able to click on these rows and get details." The fixture is not
// invented: it is rows read back from the live eta-flag-history endpoint (Firestore only,
// zero NuVizz), including the four rows in the screenshot he sent on 2026-09-02.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  flagDetail, projection, margin, closeSource, anchorNote, sweepNote, outcomeNote, actionNotes, alertNote, durText, sighting,
  ASSUMED_CLOSE_MIN,
} from '../src/lib/flag-detail.js';
import { deliveredWhen } from '../src/lib/delivered-when.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/flag-detail-rows.json', import.meta.url), 'utf8'));
const shot = (name) => FX.screenshot[name].row;
const SHOT_DATE = '2026-09-02';
const kase = (k) => FX.cases[k];

// ── THE ROW CHAD WAS LOOKING AT ──────────────────────────────────────────────

test('WALKER SCHOOL, THE CRITICAL IN THE SCREENSHOT: projected four and a half hours late, delivered an hour and three quarters early — and the panel says so', () => {
  const d = flagDetail(shot('WALKER SCHOOL'), { boardDate: SHOT_DATE, dayState: 'live' });
  assert.equal(d.customer, 'WALKER SCHOOL (TEBARCO)');
  assert.equal(d.pro, 'SHP30935');
  assert.equal(d.outcome.key, 'made');
  assert.equal(d.margin.text, '1h 42m before the close');
  assert.equal(d.margin.inside, true);
  assert.equal(d.projection.firstText, '4h 30m past the close');
  assert.equal(d.projection.worstText, '4h 30m past the close');
  assert.equal(d.projection.lastText, '2h 1m past the close');
  // THE SENTENCE THE SCREEN HAS NEVER CARRIED. A green "Made it" pill cannot tell a dispatcher
  // whether the flag they emailed customer service about was worth the call.
  assert.ok(d.cautions.includes('It was projected 4h 30m past the close and delivered 1h 42m before the close — the projection was out by 6h 12m.'), JSON.stringify(d.cautions));
  assert.equal(d.actions[0].text, 'An urgent email went to customer service.');
  assert.equal(d.actions[1].text, 'The stop stayed on OWUSU 1.');
  assert.equal(d.warning.text, '9h 0m of warning before the close');
  assert.equal(d.close.source.key, 'auto');
  assert.equal(d.escalation, null, 'it was critical from the first sighting');
});

test('THE 5:00p CLOSE IS A HOUSE GUESS, AND THAT IS WHY THE ROW IS AMBER — seven rows in one screenshot share it', () => {
  const d = flagDetail(shot('MUST MINISTRIES'), { boardDate: SHOT_DATE, dayState: 'live' });
  assert.equal(d.close.min, ASSUMED_CLOSE_MIN);
  assert.equal(d.close.source.key, 'assumed');
  assert.match(d.close.source.text, /no recorded receiving hours/);
  assert.match(d.close.source.text, /never pass amber/);
  assert.ok(d.cautions.some((c) => /capped at amber/.test(c)), JSON.stringify(d.cautions));
  // Flagged at midnight on a three-minute projected overshoot; delivered at 8:51a.
  assert.equal(d.projection.firstText, '3m past the close');
  assert.equal(d.margin.text, '8h 9m before the close');
});

test('A MOVE IS THE ONE RECORDED SIGN A PERSON ACTED — named from and to, never claimed as the cause', () => {
  const d = flagDetail(shot('KRAIBURG TPE'), { boardDate: SHOT_DATE, dayState: 'live' });
  assert.equal(d.actions.at(-1).text, 'Moved from ALLEN C to BUFORD after we flagged it.');
  for (const c of [...d.cautions, ...d.actions.map((a) => a.text)]) {
    assert.ok(!/saved|because of the flag|thanks to/i.test(c), `causation claimed: ${c}`);
  }
});

test('STILL GRADING IS NOT UNGRADABLE: six of the thirteen rows had not delivered yet, and the pill said "Not gradable" for both', () => {
  const row = shot('DVA MECHANICS');
  assert.equal(row.outcome, 'unknown');
  const live = flagDetail(row, { boardDate: SHOT_DATE, dayState: 'live' });
  assert.equal(live.outcome.pending, true);
  assert.match(live.outcome.text, /^No delivery recorded yet — this day is still being graded\./);
  // The same row on a day the overnight join HAS run is a different statement.
  const settled = flagDetail(row, { boardDate: SHOT_DATE, dayState: 'scored' });
  assert.equal(settled.outcome.pending, undefined);
  assert.equal(settled.outcome.text, 'No delivery was recorded for this stop, so it could not be graded.');
  // A day nothing has graded yet is a THIRD state, and an unknown one never invents either.
  assert.equal(flagDetail(row, { boardDate: SHOT_DATE, dayState: 'none' }).outcome.text, 'This day has not been graded at all yet.');
  assert.equal(flagDetail(row, { boardDate: SHOT_DATE }).outcome.text, 'No delivery was recorded for this stop, so it could not be graded.');
  assert.equal(live.margin, null, 'nothing delivered, so there is no margin to state');
});

// ── THE OUTCOMES THAT ONLY EXIST ON OLDER DAYS ───────────────────────────────

test('A ROLL HAS NO MARGIN — a close on one day against a stamp on another is not a number', () => {
  const c = kase('ROLLED_DELIVERED');
  const d = flagDetail(c.row, { boardDate: c.date, dayState: 'scored' });
  assert.equal(d.outcome.key, 'rolled');
  assert.equal(d.outcome.delivered.tone, 'later');
  assert.match(d.outcome.delivered.note, /Aug 28/);
  assert.equal(d.margin, null, 'the margin must refuse a cross-day comparison');
  const open = kase('ROLLED_OPEN');
  const o = flagDetail(open.row, { boardDate: open.date, dayState: 'scored' });
  assert.equal(o.outcome.delivered.tone, 'open');
  assert.match(o.outcome.delivered.note, /still open/);
  assert.equal(o.margin, null);
});

test('A FLAG RAISED AFTER THE DOCK HAD ALREADY SHUT says so, rather than reporting negative warning', () => {
  const c = kase('TOO_LATE');
  assert.ok(c.row.leadMin < 0, 'the fixture really is a negative lead');
  const d = flagDetail(c.row, { boardDate: c.date, dayState: 'scored' });
  assert.equal(d.warning.tooLate, true);
  assert.equal(d.warning.text, 'flagged 20m after the close had already passed');
  assert.equal(d.outcome.key, 'undelivered');
  assert.equal(d.outcome.text, 'Never delivered.');
  assert.equal(d.margin, null);
});

test('AN ESCALATION IS PRINTED ONLY WHEN THE TIER ACTUALLY MOVED', () => {
  const c = kase('ESCALATED');
  const d = flagDetail(c.row, { boardDate: c.date, dayState: 'scored' });
  assert.equal(d.escalation.text, 'Escalated from amber to critical.');
  assert.equal(flagDetail(shot('MUST MINISTRIES'), { boardDate: SHOT_DATE }).escalation, null);
});

test('A ROW OLDER THAN A FIELD SAYS THE FIELD IS MISSING — it does not guess', () => {
  const c = kase('NO_HOURSTIER');
  assert.equal(c.row.hoursTier, null);
  const d = flagDetail(c.row, { boardDate: c.date, dayState: 'scored' });
  assert.equal(d.close.source.key, 'unknown');
  assert.match(d.close.source.text, /predates the field/);
  assert.ok(!d.cautions.some((x) => /capped at amber/.test(x)), 'an unknown source must not claim the amber cap');
});

test('TYPED HOURS ARE A DISPATCHER TAKING OWNERSHIP, and are named as such — 5 of the 206 rows on file', () => {
  const c = kase('TYPED');
  const d = flagDetail(c.row, { boardDate: c.date, dayState: 'scored' });
  assert.equal(d.close.source.key, 'typed');
  assert.match(d.close.source.text, /a dispatcher typed/);
});

// ── THE HONESTY RULES ────────────────────────────────────────────────────────

test('A PROJECTION IS ALWAYS A DURATION PAST THE CLOSE, never a wall-clock time — 5 of 206 roll past midnight', () => {
  // close 5:00p + 700 minutes is 4:40 the NEXT morning, and a bare "4:40a" is wrong by a day.
  const row = { closeMin: 17 * 60, firstEtaMin: 17 * 60 + 700, lastEtaMin: 17 * 60 + 700, worstLateBy: 700, leadMin: 60, sweeps: 1, outcome: 'unknown' };
  const p = projection(row);
  assert.equal(p.worstText, '11h 40m past the close');
  assert.equal(p.firstText, '11h 40m past the close');
  for (const t of [p.firstText, p.lastText, p.worstText]) assert.ok(!/[ap]$|:\d\d/.test(t), `a clock time leaked into a projection: ${t}`);
});

test('an ETA exactly ON the close is on the close, not "0m past" — it happens, 3 times in 206', () => {
  const p = projection({ closeMin: 17 * 60, firstEtaMin: 17 * 60, lastEtaMin: 17 * 60, worstLateBy: 0 });
  assert.equal(p.firstText, 'exactly on the close');
  assert.equal(p.worstText, 'never past the close');
  assert.equal(durText(0), 'on the close');
});

test('NUMBER(NULL) IS 0 AND 0 IS FINITE: an absent field is absent, never a zero dressed as a measurement', () => {
  const empty = { stopNbr: 'X', customer: 'X', outcome: 'unknown' };
  const d = flagDetail(empty, { boardDate: '2026-09-02', dayState: 'scored' });
  assert.equal(d.close.min, null);
  assert.equal(d.warning, null, 'no leadMin is no warning line, not "0m of warning"');
  assert.equal(d.margin, null);
  assert.equal(d.sweeps, null);
  assert.equal(d.projection.worstText, null);
  assert.equal(d.projection.firstText, null);
  assert.equal(d.anchor.anchored, null);
  assert.equal(d.anchor.text, null);
  assert.deepEqual(d.cautions, []);
  for (const v of [null, undefined, 0, '', false, 'nope', []]) assert.equal(flagDetail(v), null);
  // A real zero survives where it is meaningful.
  assert.equal(flagDetail({ closeMin: 0, leadMin: 0, sweeps: 0, outcome: 'unknown' }, {}).warning.text, 'flagged exactly as the close passed — no warning at all');
  assert.equal(sweepNote({ sweeps: 0 }), null, 'zero sweeps is not a sighting');
});

test('the small helpers each refuse a value they cannot read', () => {
  // Number(null) is 0 and 0 is finite: this formatter returned "on the close" for a missing
  // value until the test above caught it.
  for (const v of [null, undefined, '', true, false, 'nope', {}, []]) assert.equal(durText(v), null, String(v));
  assert.equal(durText(90), '1h 30m');
  assert.equal(durText(-90), '1h 30m', 'sign is carried by the sentence, not by the duration');
  assert.equal(closeSource({}).key, 'unknown');
  assert.equal(closeSource(null).key, 'unknown');
  assert.equal(anchorNote({}).anchored, null);
  assert.equal(anchorNote(null).text, null);
  // Each anchor note is a WHOLE sentence — it used to be a fragment the card prefixed with
  // "The arrival estimate was", which rendered "…was no truck movement had been reported yet".
  for (const a of [anchorNote({ anchored: true }), anchorNote({ anchored: false })]) {
    assert.match(a.text, /^[A-Z].*\.$/, a.text);
  }
  assert.equal(sweepNote({ sweeps: 1 }).onceOnly, true);
  assert.equal(sweepNote({ sweeps: 11 }).text, 'seen in 11 sweeps');
  assert.equal(margin({ closeMin: null }, '2026-09-02'), null);
  assert.deepEqual(actionNotes({}).map((a) => a.key), ['none']);
  assert.equal(actionNotes({}).at(0).muted, true);
  // A route that only differs by padding or case is not a move — it stayed put.
  assert.deepEqual(actionNotes({ firstRoute: 'OWUSU 1', lastRoute: ' OWUSU 1' }).map((a) => a.key), ['none', 'stayed']);
  assert.equal(outcomeNote({ outcome: 'made' }, {}).key, 'made');
});

test('ONE SIGHTING AND GONE is called out — a third of every flag on file (68 of 206)', () => {
  const d = flagDetail({ ...shot('MUST MINISTRIES'), sweeps: 1 }, { boardDate: SHOT_DATE, dayState: 'live' });
  assert.equal(d.sweeps.onceOnly, true);
  assert.equal(d.sweeps.text, 'seen in one sweep and not again');
  assert.ok(d.cautions.includes('One sighting only — by the next sweep it was no longer flagged.'));
});

test('A FLAG FIRST SEEN THE NIGHT BEFORE SAYS SO — the shipped table printed 11:00a for 11pm, twelve hours out in the flattering direction', () => {
  // MCCORMICK ATLANTA PLANT, 2026-08-24, is stored with firstSeenMin -60: the evening sweep
  // records TOMORROW's board against tonight's clock as etMin - 1440. It is the only such row
  // in the 206 on file, and it is the column that claims how much warning we had.
  assert.deepEqual(sighting(-60), { min: -60, minOfDay: 1380, dayOffset: -1, suffix: 'the night before' });
  assert.deepEqual(sighting(-180), { min: -180, minOfDay: 1260, dayOffset: -1, suffix: 'the night before' });
  assert.deepEqual(sighting(1470), { min: 1470, minOfDay: 30, dayOffset: 1, suffix: 'the next day' });
  // An ordinary time is untouched and carries no suffix to render.
  for (const v of [0, 1, 600, 1439]) assert.equal(sighting(v).suffix, null, String(v));
  assert.equal(sighting(0).minOfDay, 0);
  assert.equal(sighting(1439).minOfDay, 1439);
  for (const v of [null, undefined, '', true, [], {}, 'nope']) assert.equal(sighting(v), null, String(v));
  // And the detail carries it through rather than flattening to a raw minute.
  const d = flagDetail({ ...shot('WALKER SCHOOL'), firstSeenMin: -60 }, { boardDate: SHOT_DATE });
  assert.equal(d.firstSeen.minOfDay, 1380);
  assert.equal(d.firstSeen.suffix, 'the night before');
});

test('THE ASSUMED-HOURS CAUTION NAMES THE FIX, because that is the one thing a reader can act on', () => {
  const d = flagDetail(shot('MUST MINISTRIES'), { boardDate: SHOT_DATE, dayState: 'live' });
  const c = d.cautions.find((x) => /capped at amber/.test(x));
  assert.match(c, /recording this customer’s real receiving hours/);
});

test('"NO EMAIL" IS USUALLY THE RULE WORKING, AND THE PANEL SAYS WHICH RULE — 170 of 206 flags were never emailed', () => {
  // selectAlertable refuses in exactly this order, and the first two account for 160 of the
  // 170: an assumed close is skipped ABOVE the amber gate on purpose, and since 2026-09-02
  // only CRITICAL reaches customer service (Chad: "We are only emailing on critical").
  assert.equal(alertNote({ emailed: true }).text, 'An urgent email went to customer service.');
  assert.match(alertNote({ hoursTier: 'assumed', worstTier: 'amber' }).text, /the hours were assumed/);
  assert.match(alertNote({ hoursTier: 'auto', worstTier: 'amber' }).text, /never reached critical/);
  // RED STOPS HERE NOW TOO — the rung that changed, and the reason this test exists twice.
  assert.equal(alertNote({ hoursTier: 'auto', worstTier: 'red', leadMin: 300 }).key, 'below_floor');
  assert.match(alertNote({ hoursTier: 'typed', worstTier: 'red', leadMin: 480 }).text, /only critical emails customer service/);
  // The tier gate sits ABOVE the shut-door rule in selectAlertable, so a red row past its
  // close reports the tier — the first thing that refused it, which is what the code does.
  assert.equal(alertNote(kase('TOO_LATE').row).key, 'below_floor', 'red, so the floor stops it first');
  // …and the shut-door rung still fires for the tier that CAN email. PURPLE INNOVATION LLC,
  // 2026-08-27: critical, real hours, first seen 20 minutes after its 3:00p close. It missed.
  const late = kase('CRITICAL_TOO_LATE');
  assert.equal(late.row.emailed, false);
  assert.equal(late.row.worstTier, 'critical');
  assert.equal(alertNote(late.row).key, 'too_late');
  assert.match(alertNote(late.row).text, /already shut when we first saw it/);
  // Assumed is checked FIRST, matching the code — a row that is both must not report the tier.
  assert.equal(alertNote({ hoursTier: 'assumed', worstTier: 'amber' }).key, 'assumed');
  // AND A ROW WITH NO RECORDED TIER MUST NOT BE TOLD IT "never reached critical" — undefined
  // !== 'critical' is true, and that would be a measurement reported for a thing nobody
  // measured. It falls through to the rung that claims nothing.
  for (const a of [alertNote({}), alertNote(null), alertNote({ worstTier: '  ' })]) {
    assert.equal(a.muted, true);
    assert.equal(a.key, 'none', 'no tier on file — say nothing more than "no email went out"');
  }
});

test('A STOP THAT DID NOT MOVE SAYS SO AS A FACT, not as an accusation — only 4 of 206 ever moved', () => {
  const d = flagDetail(shot('WALKER SCHOOL'), { boardDate: SHOT_DATE, dayState: 'live' });
  assert.equal(d.actions.at(-1).text, 'The stop stayed on OWUSU 1.');
  assert.equal(d.actions.at(-1).muted, true);
  assert.ok(!d.actions.some((a) => /nobody|no route change recorded/i.test(a.text)));
  const moved = flagDetail(shot('KRAIBURG TPE'), { boardDate: SHOT_DATE, dayState: 'live' });
  assert.equal(moved.actions.at(-1).text, 'Moved from ALLEN C to BUFORD after we flagged it.');
});

test('A DELIVERY WHOSE DAY WAS NEVER RECORDED HAS NO MARGIN — deliveredWhen says "date not recorded", so subtracting would borrow the board day', () => {
  // Cannot occur in today's corpus (176/176 carry arrivalMin and deliveredAt together), which
  // is exactly why the guard is written now rather than discovered later.
  const row = { closeMin: 600, arrivalMin: 498, deliveredAt: null, outcome: 'made' };
  assert.equal(deliveredWhen(row, { boardDate: '2026-09-02' }).tone, 'missing');
  assert.equal(margin(row, '2026-09-02'), null);
});
