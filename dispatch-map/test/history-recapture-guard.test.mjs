// A hand-driven re-capture of a past day must not seal LATER outcomes into it.
//
// The Sep 24 capture failed at 02:01 ET on the 25th (Firestore 429) with 588 of 849 stops on
// disk. By the time anyone offered to re-run it, the frozen-day heal had patched 82 of that
// day's index rows with what happened on Sep 25 — stop 007181067 (Jessica Sage, CANNON) went
// from SCHEDULED to DELIVERED 2026-09-25T07:29 at 11:40:17Z on the 25th, after the day's last
// scan at 03:55:11Z. A re-capture copies the index as it stands and REPLACES archived stops, so
// it would have sealed that delivery onto Sep 24 as well as Sep 25, and overwritten the correct
// nightly-time record. These tests pin the guard that stops it, the dry run that shows it, and
// that the scheduled nightly capture is unchanged apart from recording the count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

// history-core reads NUVIZZ_LEAN_DISCOVERY once, at import — the production shape.
process.env.NUVIZZ_LEAN_DISCOVERY = 'on';
delete process.env.HISTORY_RECAPTURE_GUARD;
delete process.env.HISTORY_WRITE_RETRY;
delete process.env.NUVIZZ_SCANS_ENABLED;
delete process.env.AUTH_REQUIRED;

const R = await import('../netlify/functions/lib/history-recapture.mts');
const core = await import('../netlify/functions/lib/history-core.mts');
const health = (await import('../netlify/functions/history-capture-health.mts')).default;
const store = await import('../netlify/functions/lib/history-store.mts');

const LAST_SCAN = '2026-09-25T03:55:11.545Z';   // nuvizz_stop_index/davis__2026-09-24 last_scanned_at
const HEAL_AT = '2026-09-25T11:40:17.853Z';     // frozen_heal_at on 007181067

// ── pure: the count ─────────────────────────────────────────────────────────────────────────

test('a row the frozen-day heal changed after the day\'s last scan is counted; one changed before it is not', () => {
  const rows = [
    { stopNbr: '007181067', frozen_heal_at: HEAL_AT, normalizedStatus: 'DELIVERED' },   // the real one
    { stopNbr: '1', frozen_heal_at: '2026-09-24T20:00:00.000Z' },                       // healed before the scan
    { stopNbr: '2', board_write_at: '2026-09-25T13:00:00.000Z' },                       // dispatcher Save after
    { stopNbr: '3', board_write_at: '2026-09-24T18:00:00.000Z' },                       // Save before
    { stopNbr: '4', frozen_heal_at: HEAL_AT, board_write_at: '2026-09-25T12:00:00.000Z' }, // both late: ONE row
    { stopNbr: '5' },                                                                   // never touched
    { stopNbr: '6', frozen_heal_at: '' , board_write_at: null },                        // empty stamps are absent
    { stopNbr: '7', frozen_heal_at: 'yesterday-ish' },                                  // present, not a time
    // EXACTLY the last scan: stamped by that same scan run (the list-discovery run stamps the
    // day's meta and its heals with one scannedAt — refresh-stops-core.mts:1302, :1734, :2140),
    // so the nightly capture, which reads after it, holds this row too. Not "after".
    { stopNbr: '8', frozen_heal_at: LAST_SCAN },
    { frozen_heal_at: HEAL_AT },                                                        // no stopNbr: never written
    null,
  ];
  const c = R.patchedAfterLastScan(rows, LAST_SCAN);
  assert.equal(c.rows, 9, 'rows without a stopNbr are not written, so not counted');
  assert.equal(c.known, true);
  assert.equal(c.patched, 3, '007181067, 2 and 4');
  assert.equal(c.byFrozenHeal, 2);
  assert.equal(c.byBoardWrite, 2);
  assert.equal(c.unreadable, 1, 'a stamp that is not a time is never read as "before"');
  assert.deepEqual(c.sample, ['007181067', '2', '4']);
});

test('no readable last-scan time means the count cannot be told — it is not zero', () => {
  for (const scan of [null, undefined, '', 'not a time']) {
    const c = R.patchedAfterLastScan([{ stopNbr: '1', frozen_heal_at: HEAL_AT }], scan);
    assert.equal(c.known, false, JSON.stringify(scan));
    assert.equal(c.patched, 0);
  }
  const v = R.recaptureVerdict('2026-09-24', { patched: R.patchedAfterLastScan([{ stopNbr: '1' }], null), archivedStops: 0, wouldOverwrite: 0 });
  assert.equal(v.refuse, true, 'rows with no knowable scan time refuse');
  assert.equal(R.patchedAfterLastScan([], null).rows, 0);
  assert.equal(R.recaptureVerdict('2026-09-24', { patched: R.patchedAfterLastScan([], null), archivedStops: 0, wouldOverwrite: 0 }).refuse, false, 'an empty index has nothing to be unsure about');
});

test('archived stops a re-capture would replace are counted by the key the stop writer uses', () => {
  assert.equal(R.archivedOverwrites([{ stopNbr: '1' }, { stopNbr: '2' }, { stopNbr: 'A/B' }, { stopNbr: '9' }], ['1', 'A_B', '5']), 2);
  assert.equal(R.archivedOverwrites([{ stopNbr: '1' }, { stopNbr: '1' }], ['1']), 1, 'a duplicate row is one document');
  assert.equal(R.archivedOverwrites([], ['1']), 0);
  assert.equal(R.archivedOverwrites(null, null), 0);
});

test('the verdict refuses on either count, names both, and leaves the policy to Chad', () => {
  const patched = R.patchedAfterLastScan([{ stopNbr: '1', frozen_heal_at: HEAL_AT }, { stopNbr: '2' }], LAST_SCAN);
  const a = R.recaptureVerdict('2026-09-24', { patched, archivedStops: 588, wouldOverwrite: 588 });
  assert.equal(a.refuse, true);
  assert.match(a.message, /^Re-capture of 2026-09-24 REFUSED — nothing was written\./);
  assert.match(a.message, /1 of the day's 2 index row\(s\) were changed after that day's last scan \(2026-09-25T03:55:11\.545Z\) — 1 by the frozen-day heal \(the stop as a later day's scan saw it\), 0 by a dispatcher board write made after that scan; a re-capture would seal those rows into 2026-09-24 as they stand now, not as they stood at the last scan/);
  // A dispatcher's late Save is a change after the scan, not proven to be a later day's outcome.
  assert.doesNotMatch(a.message, /later outcomes/);
  assert.match(a.message, /588 of the 588 stop\(s\) already archived for 2026-09-24 would be overwritten/);
  assert.match(a.message, /What to do with those rows is Chad's decision/);
  const clean = R.patchedAfterLastScan([{ stopNbr: '1' }], LAST_SCAN);
  const go = R.recaptureVerdict('2026-09-24', { patched: clean, archivedStops: 0, wouldOverwrite: 0 });
  assert.equal(go.refuse, false);
  // "Would proceed" says what was CHECKED — two stamps and the archive — never "nothing changed".
  assert.equal(go.message, 'Re-capture of 2026-09-24 would proceed: no index row carries a frozen-day-heal or board-write stamp later than the last scan, and no archived stop would be overwritten.');
  assert.doesNotMatch(go.message, /no index row was changed/);
  assert.equal(R.recaptureVerdict('2026-09-24', { patched: clean, archivedStops: 3, wouldOverwrite: 1 }).refuse, true, 'overwrite alone refuses');
  // A scan cannot be previewed without spending it, so every archived stop is at risk.
  const scan = R.recaptureVerdict('2026-09-24', { patched: null, archivedStops: 3, wouldOverwrite: null });
  assert.equal(scan.refuse, true);
  assert.match(scan.message, /this re-capture would scan NuVizz, and which of them a scan would overwrite cannot be known without running it/);
  assert.equal(R.recaptureVerdict('2026-09-24', { patched: null, archivedStops: 0, wouldOverwrite: null }).refuse, false);
});

test('a heal or board-write stamp that is not a readable time REFUSES the re-capture — it is never read as "before the scan"', () => {
  const p = R.patchedAfterLastScan([{ stopNbr: '1', frozen_heal_at: 'yesterday-ish' }, { stopNbr: '2' }], LAST_SCAN);
  assert.equal(p.patched, 0, 'it is not counted as a late patch…');
  assert.equal(p.unreadable, 1, '…and not as a clean row either');
  const v = R.recaptureVerdict('2026-09-24', { patched: p, archivedStops: 0, wouldOverwrite: 0 });
  assert.equal(v.refuse, true, 'nothing else is wrong with this day: the unreadable stamp alone refuses');
  assert.match(v.message, /1 index row\(s\) carry a heal or board-write stamp that is not a readable time/);
  // "Sept 25" is the trap: Date.parse reads it as 2001-09-25, i.e. BEFORE the scan. It is not a
  // stamp any writer produces, so it is unreadable — never "earlier, so clean".
  const bw = R.patchedAfterLastScan([{ stopNbr: '1', board_write_at: 'Sept 25' }, { stopNbr: '2', frozen_heal_at: 1790000000000 }], LAST_SCAN);
  assert.equal(bw.unreadable, 2, 'a loosely-parseable string and a bare number are both unreadable');
  assert.equal(R.recaptureVerdict('2026-09-24', { patched: bw, archivedStops: 0, wouldOverwrite: 0 }).refuse, true, 'a board-write stamp the same');
  // What the writers really store still reads as a time, with or without Firestore's longer fraction.
  assert.equal(R.isoTimeMs(HEAL_AT), Date.parse(HEAL_AT));
  assert.equal(R.isoTimeMs('2026-09-25T11:40:17.853000Z'), Date.parse('2026-09-25T11:40:17.853Z'));
  assert.equal(R.isoTimeMs('2026-09-25T07:40:17-04:00'), Date.parse('2026-09-25T11:40:17Z'));
  assert.ok(Number.isNaN(R.isoTimeMs('Sept 25')));
  assert.equal(R.patchedAfterLastScan([{ stopNbr: '1', frozen_heal_at: HEAL_AT }], 'Sept 25').known, false, 'a mangled last-scan time is not a time either');
});

test('the changed rows split by the archive: a correct record a re-run would REPLACE vs a stop it would write for the first time', () => {
  assert.deepEqual(R.splitPatchedByArchive(['1', '2', '3', 'A/B', '1'], ['1', 'A_B', '9']), { alreadyArchived: 2, notArchived: 2 }, 'keyed like the stop writer; a stop twice is one document');
  assert.deepEqual(R.splitPatchedByArchive([], ['1']), { alreadyArchived: 0, notArchived: 0 });
  assert.deepEqual(R.splitPatchedByArchive(null, null), { alreadyArchived: 0, notArchived: 0 });
  assert.deepEqual(R.splitPatchedByArchive(['', null, '4'], []), { alreadyArchived: 0, notArchived: 1 }, 'an empty stop number is no document');
  const c = R.patchedAfterLastScan([{ stopNbr: '1', frozen_heal_at: HEAL_AT }, { stopNbr: '2', board_write_at: HEAL_AT }, { stopNbr: '3' }], LAST_SCAN);
  assert.deepEqual(c.ids, ['1', '2'], 'every patched stop, not a sample');
});

test('HISTORY_RECAPTURE_GUARD has the house shape: on unless off/0/false/no, and a typo leaves it ON', () => {
  for (const v of [undefined, '', 'on', 'true', '1', 'yes', 'of', 'offf', 'disable']) assert.equal(R.recaptureGuardEnabled({ HISTORY_RECAPTURE_GUARD: v }), true, JSON.stringify(v));
  for (const v of ['off', 'OFF', ' off ', '0', 'false', 'no', 'No']) assert.equal(R.recaptureGuardEnabled({ HISTORY_RECAPTURE_GUARD: v }), false, JSON.stringify(v));
  assert.equal(R.recaptureGuardEnabled(null), true);
});

test('the path the dry run names is the capture\'s own rule, lean discovery exactly "on"', () => {
  assert.equal(R.leanHistoryOn({ NUVIZZ_LEAN_DISCOVERY: 'on' }), true);
  assert.equal(R.leanHistoryOn({ NUVIZZ_LEAN_DISCOVERY: 'ON' }), true);
  for (const v of [undefined, '', 'true', '1', ' on']) assert.equal(R.leanHistoryOn({ NUVIZZ_LEAN_DISCOVERY: v }), false, JSON.stringify(v));
  const meta = { last_scanned_at: LAST_SCAN };
  assert.equal(R.indexUsable({ meta, stops: [{}] }), true);
  assert.equal(R.indexUsable({ meta, stops: [] }), false);
  assert.equal(R.indexUsable({ meta: {}, stops: [{}] }), false);
  assert.equal(R.indexUsable({ meta: { ...meta, scanState: { halted: true } }, stops: [{}] }), false);
  assert.equal(R.indexUsable(null), false);
});

// ── planRecapture with injected reads ─────────────────────────────────────────────────────────
const io = (idx, archived = [], manifest = null) => ({
  readIndex: async () => idx, listArchivedStopIds: async () => archived, getManifest: async () => manifest,
});
const IDX = { meta: { last_scanned_at: LAST_SCAN }, stops: [{ stopNbr: '1', frozen_heal_at: HEAL_AT }, { stopNbr: '2' }, { stopNbr: '3' }] };

test('the dry run names the index path at 0 NuVizz calls, both counts, and a refusal for a hand-driven run', async () => {
  const p = await R.planRecapture('2026-09-24', { tenant: 'davis', manual: true, firestoreOn: true, env: { NUVIZZ_LEAN_DISCOVERY: 'on' }, io: io(IDX, ['1', '2', '99']) });
  assert.equal(p.writes, 0); assert.equal(p.nuvizz_calls, 0);
  assert.equal(p.path, 'firestore-index');
  assert.equal(p.nuvizz_calls_if_run, 0);
  assert.equal(p.index.patched_after_last_scan, 1);
  assert.equal(p.archive.stops_archived, 3);
  assert.equal(p.archive.would_overwrite, 2);
  assert.equal(p.would_refuse, true);
  assert.equal(p.would_skip, null, 'this caller did not check the scans switch, so it cannot say');
  assert.match(p.verdict, /Chad's decision/);
  assert.deepEqual(p.switches, { HISTORY_RECAPTURE_GUARD: 'on', HISTORY_WRITE_RETRY: 'on', NUVIZZ_LEAN_DISCOVERY: 'on' });
});

test('with lean discovery off the dry run says the capture would SCAN, and states the file\'s estimate rather than zero', async () => {
  const p = await R.planRecapture('2026-09-24', { tenant: 'davis', manual: true, firestoreOn: true, env: {}, io: io(IDX, []) });
  assert.equal(p.path, 'scan');
  assert.match(p.path_why, /NUVIZZ_LEAN_DISCOVERY is not on/);
  assert.match(String(p.nuvizz_calls_if_run), /^~690 NuVizz calls/);
  assert.equal(p.archive.would_overwrite, null, 'unknowable without the scan');
  const halted = await R.planRecapture('2026-09-24', { tenant: 'davis', manual: true, firestoreOn: true, env: { NUVIZZ_LEAN_DISCOVERY: 'on' }, io: io({ meta: { last_scanned_at: LAST_SCAN, scanState: { halted: true } }, stops: [{ stopNbr: '1' }] }) });
  assert.equal(halted.path, 'scan'); assert.match(halted.path_why, /halted/);
});

test('the nightly run is never refused by the guard, and switching the guard off is reported, not hidden', async () => {
  const nightly = await R.planRecapture('2026-09-24', { tenant: 'davis', manual: false, firestoreOn: true, env: { NUVIZZ_LEAN_DISCOVERY: 'on' }, io: io(IDX, ['1']) });
  assert.equal(nightly.would_refuse, false);
  assert.match(nightly.verdict, /scheduled nightly capture is not refused/);
  const off = await R.planRecapture('2026-09-24', { tenant: 'davis', manual: true, firestoreOn: true, env: { NUVIZZ_LEAN_DISCOVERY: 'on', HISTORY_RECAPTURE_GUARD: 'off' }, io: io(IDX, ['1']) });
  assert.equal(off.would_refuse, false);
  assert.match(off.verdict, /^DRY RUN — HISTORY_RECAPTURE_GUARD is off, so a hand-driven re-capture of 2026-09-24 would NOT be refused: it would write despite/);
  assert.doesNotMatch(off.verdict, /would scan NuVizz: ~690/, 'the index path spends no scan');
});

test('the dry run reports the split directly, so the numbers Chad chooses on come from the live data', async () => {
  // IDX: row 1 healed after the scan, rows 2 and 3 untouched. Archive: 1, 2 and a stop the index no longer holds.
  const p = await R.planRecapture('2026-09-24', { tenant: 'davis', manual: true, firestoreOn: true, env: { NUVIZZ_LEAN_DISCOVERY: 'on' }, io: io(IDX, ['1', '2', '99']) });
  assert.equal(p.index.patched_already_archived, 1, 'row 1: its correct nightly record would be replaced');
  assert.equal(p.index.patched_not_archived, 0);
  assert.equal(p.archive.would_overwrite, 2);
  assert.equal(p.archive.would_overwrite_unflagged, 1, 'row 2 would be rewritten from a row the count does not flag');
  const fresh = await R.planRecapture('2026-09-24', { tenant: 'davis', manual: true, firestoreOn: true, env: { NUVIZZ_LEAN_DISCOVERY: 'on' }, io: io(IDX, ['2']) });
  assert.equal(fresh.index.patched_already_archived, 0);
  assert.equal(fresh.index.patched_not_archived, 1, 'row 1 would be written for the first time, with the later outcome');
  const scan = await R.planRecapture('2026-09-24', { tenant: 'davis', manual: true, firestoreOn: true, env: {}, io: io(IDX, ['1']) });
  assert.equal(scan.archive.would_overwrite_unflagged, null, 'a scan cannot be previewed');
  assert.equal(scan.index.patched_already_archived, 1, 'still a fact about the index and the archive');
  assert.equal(scan.would_refuse, true, 'lean off + an archive: refused');
  const blind = await R.planRecapture('2026-09-24', { tenant: 'davis', manual: true, firestoreOn: true, env: { NUVIZZ_LEAN_DISCOVERY: 'on' }, io: io({ meta: {}, stops: [{ stopNbr: '1', frozen_heal_at: HEAL_AT }] }, ['1']) });
  assert.equal(blind.index.patched_already_archived, null, 'no readable last scan: the split cannot be told');
  assert.equal(blind.index.patched_not_archived, null);
});

// ── end to end, against the in-memory Firestore ──────────────────────────────────────────────
const D = '2026-09-24';
const row = (n, extra = {}) => ({
  stopNbr: n, isPlanned: true, isUnplanned: false, normalizedStatus: 'SCHEDULED', status: '20',
  loadNbr: 'CANNON', routeName: 'CANNON', routeSeq: 1, driverName: 'Jessica Sage', driverUserName: 'jsage',
  deliveredDTTM: null, consigneeName: `Customer ${n}`, addr1: `${n} Main St`, city: 'Buford', state: 'GA', zip: '30518', ...extra,
});
const DELIVERED_NEXT_DAY = { normalizedStatus: 'DELIVERED', status: '90', deliveredDTTM: '2026-09-25T07:29:00', frozen_heal_at: HEAL_AT, frozen_heal_reason: 'finished', closedOnBoard: '2026-09-25' };

function sep24Seed({ archived = true } = {}) {
  const seed = { [`nuvizz_stop_index/davis__${D}`]: { tenant: 'davis', date: D, last_scanned_at: LAST_SCAN, count: 20, scanState: null } };
  const nbrs = Array.from({ length: 20 }, (_, k) => String(7181060 + k).padStart(9, '0'));
  nbrs.forEach((n, k) => {
    const late = k < 5 ? DELIVERED_NEXT_DAY : k === 5 ? { board_write_at: '2026-09-25T13:00:00.000Z' } : k === 6 ? { board_write_at: '2026-09-24T18:00:00.000Z' } : {};
    seed[`nuvizz_stop_index/davis__${D}/stops/${n}`] = row(n, late);
    // The partial nightly archive: the first 12 stops, as they stood at 06:00:59Z on the 25th.
    if (archived && k < 12) seed[`history_days/davis__${D}/stops/${n}`] = { ...row(n), tenant: 'davis', date: D, capture_version: 1, captured_at: '2026-09-25T06:00:59.145Z' };
  });
  return { seed, nbrs };
}
const writesOf = (log) => ({ sets: log.sets.length, patches: (log.patches || []).length, deletes: log.deletes.length, commits: log.commits.length });
const NO_WRITES = { sets: 0, patches: 0, deletes: 0, commits: 0 };

test('THE SEP 24 RE-CAPTURE IS REFUSED: 6 rows changed after the last scan, 12 archived stops, nothing written, no NuVizz call', async () => {
  const { seed, nbrs } = sep24Seed();
  const fake = installFirestoreFake(seed);
  try {
    const r = await core.captureDate(D, { manual: true });
    assert.equal(r.ok, false);
    assert.equal(r.refused, 'recapture-guard');
    assert.equal(r.patched_after_last_scan, 6, '5 heals + 1 dispatcher Save after the scan; the Save before it is not counted');
    assert.equal(r.archived_stops, 12);
    assert.equal(r.would_overwrite, 12);
    assert.equal(r.patched_already_archived, 6, 'all six changed rows are in the partial archive');
    assert.equal(r.patched_not_archived, 0);
    assert.equal(r.path, 'firestore-index');
    // The REAL run's text, after it stopped — past tense is true here, and only here.
    assert.match(r.reason, /^Re-capture of 2026-09-24 REFUSED — nothing was written\. /);
    assert.doesNotMatch(r.reason, /^DRY RUN/);
    assert.match(r.reason, /6 of the day's 20 index row\(s\) were changed after that day's last scan \(2026-09-25T03:55:11\.545Z\) — 5 by the frozen-day heal \(the stop as a later day's scan saw it\), 1 by a dispatcher board write made after that scan/);
    assert.match(r.reason, /Chad's decision/);
    assert.deepEqual(writesOf(fake.log), NO_WRITES, 'writes NOTHING — not even a failure record');
    assert.deepEqual(fake.log.other, [], 'reached nothing but Firestore');
    assert.equal(fake.store.get(`history_days/davis__${D}/stops/${nbrs[0]}`).normalizedStatus, 'SCHEDULED', 'the nightly-time record is untouched');
    assert.equal(fake.store.has(`history_days/davis__${D}`), false, 'no manifest');
    // The guard read masked rows, not the raw NuVizz blob.
    const idxList = fake.log.listMasks.find((l) => l.path === `nuvizz_stop_index/davis__${D}/stops`);
    assert.deepEqual(idxList.mask.sort(), ['board_write_at', 'frozen_heal_at', 'stopNbr']);
  } finally { fake.restore(); }
});

test('an archive alone refuses: a day with no late rows but stops already archived is not overwritten', async () => {
  const seed = { [`nuvizz_stop_index/davis__${D}`]: { last_scanned_at: LAST_SCAN, scanState: null }, [`nuvizz_stop_index/davis__${D}/stops/1`]: row('1'), [`history_days/davis__${D}/stops/1`]: row('1') };
  const fake = installFirestoreFake(seed);
  try {
    const r = await core.captureDate(D, { manual: true });
    assert.equal(r.refused, 'recapture-guard');
    assert.equal(r.patched_after_last_scan, 0);
    assert.equal(r.would_overwrite, 1);
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
  } finally { fake.restore(); }
});

test('?dryRun=1 on the background function: the same report, zero writes, zero NuVizz calls', async () => {
  const { seed } = sep24Seed();
  const fake = installFirestoreFake(seed);
  try {
    const res = await core.runHistorySnapshot(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?date=${D}&dryRun=1`, { method: 'POST' }));
    const body = await res.json();
    assert.equal(body.dry_run, true);
    assert.equal(body.manual, true);
    const p = body.dates[0];
    assert.equal(p.date, D);
    assert.equal(p.path, 'firestore-index');
    assert.equal(p.nuvizz_calls_if_run, 0);
    assert.equal(p.index.patched_after_last_scan, 6);
    assert.equal(p.index.by_frozen_heal, 5);
    assert.equal(p.index.by_board_write, 1);
    assert.equal(p.archive.stops_archived, 12);
    assert.equal(p.archive.would_overwrite, 12);
    assert.equal(p.would_refuse, true);
    assert.equal(p.scans_enabled, true);
    assert.equal(p.would_skip, false, 'scans are on: the run is not skipped, so would_refuse is what it would do');
    // A FORECAST, not a report of a refusal that never happened.
    assert.match(p.verdict, /^DRY RUN — a hand-driven re-capture of 2026-09-24 WOULD BE REFUSED, before any write: 6 of the day's 20 index row/);
    assert.doesNotMatch(p.verdict, /REFUSED — nothing was written/);
    // "WOULD BE REFUSED" is the answer for a run that NAMES the day; it must not read as covering
    // the no-query POST, which the code cannot tell from the 2 AM run and does not check.
    assert.match(p.verdict, / Only a run that names its day \(\?date=\) is checked: a POST with no query string is the 2 AM run as far as the code can tell, and it is not\.$/);
    // A refusal stops before any scan, so it names no scan cost.
    assert.doesNotMatch(p.verdict, /would scan NuVizz: ~690/);
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    assert.deepEqual(fake.log.other, []);
  } finally { fake.restore(); }
});

test('a malformed ?dryRun is still a dry run — only an explicit 0/false/no/off runs for real', () => {
  const req = (q) => new Request(`https://x.test/f?date=${D}${q}`);
  for (const q of ['&dryRun=1', '&dryRun=true', '&dryRun=', '&dryRun', '&dryRun=yes please']) assert.equal(core.isDryRun(req(q)), true, q);
  for (const q of ['', '&dryRun=0', '&dryRun=false', '&dryRun=no', '&dryRun=OFF']) assert.equal(core.isDryRun(req(q)), false, q);
  // A MISTYPED NAME IS STILL A LOOK, never a real capture (on the scan path a real one is the ~690-call scan).
  for (const q of ['&dryrun=1', '&DryRun=1', '&dry_run=1', '&dry-run=1', '&dry=1', '&DRY', '&dryrun=0&dry=1']) assert.equal(core.isDryRun(req(q)), true, q);
  for (const q of ['&dryrun=0', '&dry=off', '&dryer=1', '&dryRunX=1']) assert.equal(core.isDryRun(req(q)), false, q);
  assert.equal(core.isManualCapture(req('')), true);
  assert.equal(core.isManualCapture(new Request('https://x.test/f?from=2026-09-10&to=2026-09-11')), true);
  assert.equal(core.isManualCapture(new Request('https://x.test/f')), false, 'the cron sends no query');
});

test('history-capture-health?recapture= answers the dry run synchronously (the background function\'s answer is discarded by Netlify)', async () => {
  const { seed } = sep24Seed();
  const fake = installFirestoreFake(seed);
  try {
    const res = await health(new Request(`https://x.netlify.app/.netlify/functions/history-capture-health?recapture=${D}`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.path, 'firestore-index');
    assert.equal(body.index.patched_after_last_scan, 6);
    assert.equal(body.archive.would_overwrite, 12);
    assert.equal(body.would_refuse, true);
    assert.match(body.verdict, /^DRY RUN — a hand-driven re-capture of 2026-09-24 WOULD BE REFUSED, before any write:/);
    assert.doesNotMatch(body.verdict, /nothing was written/, 'nothing ran, so nothing may be reported as having happened');
    assert.equal(body.scans_enabled, true, 'the readout checks the scans switch itself');
    assert.equal(body.would_skip, false);
    // Row count from the meta it already read: 20 at the last scan, 20 now.
    assert.equal(body.index.rows_at_last_scan, 20);
    assert.equal(body.index.rows_now, 20);
    assert.equal(body.index.rows_difference_since_last_scan, 0);
    assert.ok(body.not_counted.some((t) => /moveBoardStopDay/.test(t)), 'a removed row is named as not counted');
    assert.ok(body.not_counted.some((t) => /writeStopNotes/.test(t)), 'note refreshes are named as not counted');
    assert.ok(body.not_counted.some((t) => /recordFinishedHolder/.test(t)));
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    assert.deepEqual(fake.log.other, []);
    const bad = await health(new Request('https://x.netlify.app/.netlify/functions/history-capture-health?recapture=sept24'));
    assert.equal(bad.status, 400);
  } finally { fake.restore(); }
});

test('the scheduled nightly capture is not refused, seals as before, and records how many rows were patched after the last scan', async () => {
  const { seed } = sep24Seed({ archived: false });
  const fake = installFirestoreFake(seed);
  try {
    const r = await core.captureDate(D);   // no opts: the cron path
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.sealed, true);
    assert.equal(r.patched_after_last_scan, 6);
    const m = fake.store.get(`history_days/davis__${D}`);
    assert.equal(m.verified, true);
    assert.equal(m.patched_after_last_scan, 6);
    assert.equal(m.write_retries, 0);
    assert.equal(m.write_pushed_back, false);
    const lineage = fake.store.get(`history_days/davis__${D}/captures/v1`);
    assert.equal(lineage.patched_after_last_scan, 6);
    assert.equal(lineage.write_retries, 0);
    assert.ok(fake.store.has(`history_driver_days/davis__JSAGE/days/${D}`), 'the driver-day pointer still lands where it always did');
    assert.equal(fake.log.other.filter((o) => /nuvizz/i.test(o.url)).length, 0, 'no NuVizz call');
  } finally { fake.restore(); }
});

test('a nightly that Firestore pushes back on still seals, and its manifest and lineage say how many retries it took', async () => {
  const { seed, nbrs } = sep24Seed({ archived: false });
  const fake = installFirestoreFake(seed);
  const inner = globalThis.fetch;
  let refused = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const patch = (init.method || 'GET').toUpperCase() === 'PATCH';
    // One stop and the driver-day pointer are each pushed back once. The pointer used to be a
    // bare PATCH fired with every other pointer at once: a 429 there failed the night.
    if (patch && ((url.includes(`history_days/davis__${D}/stops/${nbrs[3]}`) && refused < 1) || (url.includes(`history_driver_days/davis__JSAGE/days/${D}`) && refused === 1))) {
      refused++;
      return new Response('{"error":{"code":429,"message":"This database has exceeded their maximum bandwidth for writes, please retry with exponential backoff"}}', { status: 429 });
    }
    return inner(input, init);
  };
  try {
    const r = await core.captureDate(D);
    assert.equal(r.sealed, true, JSON.stringify(r));
    assert.equal(refused, 2);
    assert.equal(r.write_retries, 2);
    assert.equal(r.write_pushed_back, true);
    const m = fake.store.get(`history_days/davis__${D}`);
    assert.equal(m.write_retries, 2);
    assert.equal(m.write_pushed_back, true);
    assert.equal(fake.store.get(`history_days/davis__${D}/captures/v1`).write_retries, 2);
    assert.ok(fake.store.has(`history_driver_days/davis__JSAGE/days/${D}`));
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('a hand-driven capture of a clean, never-archived day proceeds and seals', async () => {
  const seed = { [`nuvizz_stop_index/davis__${D}`]: { last_scanned_at: LAST_SCAN, scanState: null } };
  for (const n of ['1', '2', '3']) seed[`nuvizz_stop_index/davis__${D}/stops/${n}`] = row(n);
  const fake = installFirestoreFake(seed);
  try {
    const r = await core.captureDate(D, { manual: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.sealed, true);
    assert.equal(fake.store.get(`history_days/davis__${D}`).patched_after_last_scan, 0);
  } finally { fake.restore(); }
});

test('HISTORY_RECAPTURE_GUARD=off puts back the old re-capture — and this is exactly the overwrite the guard exists to stop', async () => {
  const { seed, nbrs } = sep24Seed();
  const fake = installFirestoreFake(seed);
  process.env.HISTORY_RECAPTURE_GUARD = 'off';
  try {
    const r = await core.captureDate(D, { manual: true });
    assert.equal(r.refused, undefined);
    assert.equal(r.sealed, true, JSON.stringify(r));
    const s = fake.store.get(`history_days/davis__${D}/stops/${nbrs[0]}`);
    assert.equal(s.normalizedStatus, 'DELIVERED', 'the Sep 25 delivery is now sealed onto Sep 24');
    assert.equal(s.deliveredDTTM, '2026-09-25T07:29:00');
  } finally { delete process.env.HISTORY_RECAPTURE_GUARD; fake.restore(); }
});

test('past the run\'s retry deadline the capture stops and the FAILURE RECORD LANDS, leading with the retry count', async () => {
  const { seed, nbrs } = sep24Seed({ archived: false });
  const fake = installFirestoreFake(seed);
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if ((init.method || 'GET').toUpperCase() === 'PATCH' && url.includes(`history_days/davis__${D}/stops/${nbrs[2]}`)) {
      return new Response('{"error":{"code":429}}', { status: 429 });
    }
    return inner(input, init);
  };
  try {
    // A run already at its deadline: the first push-back is not retried.
    await assert.rejects(() => core.captureDate(D, { deadlineAt: Date.now() - 1 }), /retry deadline/);
    const f = fake.store.get(`history_capture_failures/davis__${D}`);
    assert.ok(f, 'the failure record landed');
    assert.equal(f.stage, 'upsert');
    assert.match(f.error, /^stopped retrying at the run's 10-minute retry deadline; write retries this run: 0 — setDoc .* failed: 429/);
    assert.equal(fake.store.has(`history_days/davis__${D}`), false, 'no manifest');
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('a refusal that is not a push-back is thrown at once, and its failure text still says how many retries the night took', async () => {
  const { seed, nbrs } = sep24Seed({ archived: false });
  const fake = installFirestoreFake(seed);
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if ((init.method || 'GET').toUpperCase() === 'PATCH' && url.includes(`history_days/davis__${D}/stops/${nbrs[1]}`)) {
      return new Response('{"error":{"code":403}}', { status: 403 });
    }
    return inner(input, init);
  };
  try {
    await assert.rejects(() => core.captureDate(D), /failed: 403/);
    const f = fake.store.get(`history_capture_failures/davis__${D}`);
    assert.match(f.error, /^write retries this run: 0 — setDoc .* failed: 403/);
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('a heal that lands between the guard\'s look and the first write is still caught — nothing written', async () => {
  const seed = { [`nuvizz_stop_index/davis__${D}`]: { last_scanned_at: LAST_SCAN, scanState: null } };
  for (const n of ['1', '2', '3']) seed[`nuvizz_stop_index/davis__${D}/stops/${n}`] = row(n);
  const fake = installFirestoreFake(seed);
  const inner = globalThis.fetch;
  let healed = false;
  globalThis.fetch = async (input, init = {}) => {
    const res = await inner(input, init);
    const url = String(input?.url ?? input);
    // The guard's MASKED read of the index goes first and sees a clean day; the heal lands right after it.
    if (!healed && url.includes(`nuvizz_stop_index/davis__${D}/stops`) && url.includes('mask.fieldPaths')) {
      healed = true;
      fake.store.set(`nuvizz_stop_index/davis__${D}/stops/2`, row('2', DELIVERED_NEXT_DAY));
    }
    return res;
  };
  try {
    const r = await core.captureDate(D, { manual: true });
    assert.equal(healed, true);
    assert.equal(r.refused, 'recapture-guard', JSON.stringify(r));
    assert.match(r.reason, /1 of the day's 3 index row\(s\) were changed after that day's last scan/);
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('POST nuvizz-history-snapshot-background?date=2026-09-24 — the exact re-run that was offered — is refused through the handler, nothing written', async () => {
  const { seed } = sep24Seed();
  const fake = installFirestoreFake(seed);
  try {
    const res = await core.runHistorySnapshot(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?date=${D}`, { method: 'POST' }));
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.dates[0].refused, 'recapture-guard');
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    assert.deepEqual(fake.log.other, []);
  } finally { fake.restore(); }
});

// ── review round: the guard's own failure modes, each pinned end to end ─────────────────────────
const cleanDay = (dates = [D]) => {
  const seed = {};
  for (const d of dates) {
    seed[`nuvizz_stop_index/davis__${d}`] = { last_scanned_at: LAST_SCAN, scanState: null };
    for (const n of ['1', '2', '3']) seed[`nuvizz_stop_index/davis__${d}/stops/${n}`] = row(n);
  }
  return seed;
};

test('A RE-CAPTURE THAT WOULD SCAN NUVIZZ (halted index) OF A DAY ALREADY PARTLY ARCHIVED IS REFUSED BEFORE A SINGLE VENDOR CALL', async () => {
  // The expensive path: a halted index sends the capture to scanDate (~690 calls by the file's own
  // estimate). The refusal must come from the pre-flight, not from the in-hand check after the scan.
  const seed = {
    [`nuvizz_stop_index/davis__${D}`]: { last_scanned_at: LAST_SCAN, scanState: { halted: true, reason: 'ceiling' } },
    [`nuvizz_stop_index/davis__${D}/stops/1`]: row('1'),
    [`nuvizz_stop_index/davis__${D}/stops/2`]: row('2'),
    [`history_days/davis__${D}/stops/1`]: { ...row('1'), capture_version: 1, captured_at: '2026-09-25T06:00:59.145Z' },
  };
  const fake = installFirestoreFake(seed);
  try {
    let r, err;
    try { r = await core.captureDate(D, { manual: true }); } catch (e) { err = e; }
    // Reaching scanDate in this test throws (no vendor credentials, or the fake refuses the URL):
    // the message then says how far it got.
    assert.equal(err, undefined, `the capture went on toward the scan instead of refusing: ${err?.message}`);
    assert.equal(r.refused, 'recapture-guard');
    assert.equal(r.path, 'scan');
    assert.equal(r.archived_stops, 1);
    assert.equal(r.would_overwrite, null, 'a scan cannot be previewed without spending it');
    assert.match(r.reason, /1 stop\(s\) are already archived for 2026-09-24; this re-capture would scan NuVizz/);
    assert.deepEqual(writesOf(fake.log), NO_WRITES, 'writes nothing, not even a failure record');
    assert.deepEqual(fake.log.other, [], 'reached nothing but Firestore');
  } finally { fake.restore(); }
});

test('a guard that cannot read what the run would overwrite REFUSES — it never captures blind, and spends nothing', async () => {
  // A clean, never-archived day that would otherwise capture and seal: the refusal here comes from
  // the failed read alone.
  const fake = installFirestoreFake(cleanDay());
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (url.includes(`nuvizz_stop_index/davis__${D}/stops`) && url.includes('mask.fieldPaths')) {
      return new Response('{"error":{"code":500,"message":"internal"}}', { status: 500 });
    }
    return inner(input, init);
  };
  try {
    const r = await core.captureDate(D, { manual: true });
    assert.equal(r.refused, 'recapture-guard', JSON.stringify(r));
    assert.match(r.reason, /^re-capture guard could not read what this run would overwrite \(listDocs nuvizz_stop_index\/davis__2026-09-24\/stops failed: 500/);
    assert.match(r.reason, /refusing, nothing written$/);
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    assert.deepEqual(fake.log.other, []);
    assert.equal(fake.store.has(`history_days/davis__${D}`), false, 'no manifest');
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('a stop archived between the guard\'s look and the first write (a second capture running at once) is still caught — nothing written', async () => {
  const fake = installFirestoreFake(cleanDay());
  const inner = globalThis.fetch;
  let archived = false;
  const theirs = { ...row('2'), capture_version: 1, captured_at: '2026-09-25T06:00:59.145Z' };
  globalThis.fetch = async (input, init = {}) => {
    const res = await inner(input, init);
    const url = String(input?.url ?? input);
    // The guard's MASKED read of the archive sees nothing; another capture's stop lands right after it.
    if (!archived && url.includes(`history_days/davis__${D}/stops`) && url.includes('mask.fieldPaths')) {
      archived = true;
      fake.store.set(`history_days/davis__${D}/stops/2`, theirs);
    }
    return res;
  };
  try {
    const r = await core.captureDate(D, { manual: true });
    assert.equal(archived, true);
    assert.equal(r.refused, 'recapture-guard', JSON.stringify(r));
    assert.match(r.reason, /1 of the 1 stop\(s\) already archived for 2026-09-24 would be overwritten/);
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    assert.deepEqual(fake.store.get(`history_days/davis__${D}/stops/2`), theirs, 'the other capture\'s record is untouched');
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('the capture lineage is retried when Firestore pushes back on it, and it counts its own retry', async () => {
  const fake = installFirestoreFake(cleanDay());
  const inner = globalThis.fetch;
  let refused = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if ((init.method || 'GET').toUpperCase() === 'PATCH' && url.includes(`history_days/davis__${D}/captures/v1`) && refused === 0) {
      refused++;
      return new Response('{"error":{"code":429,"message":"This database has exceeded their maximum bandwidth for writes, please retry with exponential backoff"}}', { status: 429 });
    }
    return inner(input, init);
  };
  try {
    const r = await core.captureDate(D);   // the nightly path
    assert.equal(r.sealed, true, JSON.stringify(r));
    assert.equal(refused, 1);
    const lineage = fake.store.get(`history_days/davis__${D}/captures/v1`);
    assert.ok(lineage, 'the lineage landed after the push-back');
    assert.equal(lineage.write_retries, 1, 'the lineage counts the retry it took itself');
    assert.equal(lineage.write_pushed_back, true);
    assert.equal(r.write_retries, 1);
    assert.equal(fake.store.get(`history_days/davis__${D}`).write_retries, 0, 'the manifest was sealed before the push-back');
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('THE RETRY DEADLINE IS THE RUN\'S: in a ?from=&to= range a later day gets what is left of the ten minutes, not a fresh ten', async () => {
  // The platform's limit (15 minutes, by the function's own header) covers the whole invocation.
  // Day one takes the run past its ten-minute retry deadline (the clock is moved on when its
  // manifest lands); day two is then pushed back once — and must NOT wait and retry, because the
  // run has no retry time left.
  const D2 = '2026-09-25';
  assert.equal(store.WRITE_RETRY_DEADLINE_MS, 10 * 60 * 1000);
  const fake = installFirestoreFake(cleanDay([D, D2]));
  const inner = globalThis.fetch;
  const realNow = Date.now;
  let offset = 0, moved = false, refused = 0;
  Date.now = () => realNow() + offset;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const patch = (init.method || 'GET').toUpperCase() === 'PATCH';
    if (patch && url.includes(`history_days/davis__${D2}/stops/2`) && refused === 0) {
      refused++;
      return new Response('{"error":{"code":429}}', { status: 429 });
    }
    const res = await inner(input, init);
    if (patch && !moved && new RegExp(`/documents/history_days/davis__${D}(\\?|$)`).test(url)) {
      moved = true;
      offset += store.WRITE_RETRY_DEADLINE_MS + 1000;
    }
    return res;
  };
  try {
    const res = await core.runHistorySnapshot(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?from=${D}&to=${D2}`, { method: 'POST' }));
    const body = await res.json();
    assert.equal(moved, true, 'day one sealed and the clock moved past the run\'s deadline');
    assert.equal(body.dates[0].date, D);
    assert.equal(body.dates[0].sealed, true, JSON.stringify(body.dates[0]));
    assert.equal(body.dates[1].date, D2);
    assert.equal(body.dates[1].ok, false, `day two must not get a fresh ten minutes: ${JSON.stringify(body.dates[1])}`);
    assert.match(body.dates[1].error, /^stopped retrying at the run's 10-minute retry deadline; write retries this run: 0 — setDoc .*stops\/2 failed: 429/);
    assert.equal(refused, 1, 'one attempt, no retry');
    const f = fake.store.get(`history_capture_failures/davis__${D2}`);
    assert.ok(f, 'the failure record landed');
    assert.equal(f.stage, 'upsert');
    assert.equal(fake.store.has(`history_days/davis__${D2}`), false, 'day two has no manifest');
  } finally { Date.now = realNow; globalThis.fetch = inner; fake.restore(); }
});

// ── what the readout can and cannot see (review r3) ──────────────────────────────────────────
test('ROWS ADDED OR REMOVED SINCE THE LAST SCAN are read off the meta count the last scan wrote — and an unreadable count is "cannot tell", never 0', () => {
  const rows = (n) => Array.from({ length: n }, (_, k) => ({ stopNbr: String(k + 1) }));
  assert.deepEqual(R.rowCountSinceLastScan({ count: 849 }, rows(849)), { atLastScan: 849, now: 849, difference: 0 });
  // A confirmed date move deletes the row from its old day: the index is one short of the scan.
  assert.deepEqual(R.rowCountSinceLastScan({ count: 849 }, rows(848)), { atLastScan: 849, now: 848, difference: -1 });
  assert.deepEqual(R.rowCountSinceLastScan({ count: 3 }, rows(4)), { atLastScan: 3, now: 4, difference: 1 });
  // Firestore's REST form of an integer is a string.
  assert.equal(R.rowCountSinceLastScan({ count: '849' }, rows(849)).difference, 0);
  // Number(null) is 0 and 0 is finite — none of these may read as "the last scan left 0 rows".
  for (const count of [undefined, null, '', '  ', 'abc', -1, 1.5, true, {}, NaN]) {
    assert.deepEqual(R.rowCountSinceLastScan({ count }, rows(2)), { atLastScan: null, now: 2, difference: null }, `count ${JSON.stringify(count)}`);
  }
  assert.deepEqual(R.rowCountSinceLastScan(null, null), { atLastScan: null, now: 0, difference: null });
});

test('A STOP MOVED OFF THE DAY AFTER ITS LAST SCAN (moveBoardStopDay deletes it) — the readout still proceeds, but says the day is a row short and never that "nothing changed"', async () => {
  // Stop 3 was on Sep 24 at the last scan (count 3) and was moved to another day afterwards: its
  // row is gone from Sep 24 and nothing on Sep 24 is stamped. The stamp count cannot see it.
  const seed = { [`nuvizz_stop_index/davis__${D}`]: { last_scanned_at: LAST_SCAN, scanState: null, count: 3 } };
  for (const n of ['1', '2']) seed[`nuvizz_stop_index/davis__${D}/stops/${n}`] = row(n);
  const fake = installFirestoreFake(seed);
  try {
    const b = await (await health(new Request(`https://x/.netlify/functions/history-capture-health?recapture=${D}`))).json();
    assert.equal(b.would_refuse, false, 'a row-count difference is reported, never refused on');
    assert.equal(b.index.rows_at_last_scan, 3);
    assert.equal(b.index.rows_now, 2);
    assert.equal(b.index.rows_difference_since_last_scan, -1);
    assert.equal(b.verdict, 'DRY RUN — a hand-driven re-capture of 2026-09-24 WOULD PROCEED: no index row carries a frozen-day-heal or board-write stamp later than the last scan, and no archived stop would be overwritten. The index holds 2 row(s) where the day\'s last scan left 3: 1 fewer since, which the stamp count cannot see (a confirmed date move deletes the row from its old day and stamps nothing there). That difference is reported here, not refused on.');
    assert.doesNotMatch(b.verdict, /no index row was changed/);
    assert.ok(b.not_counted.some((t) => /moveBoardStopDay/.test(t)));
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    // The count costs no extra read: the same four reads as before (meta, rows, archive, manifest).
    assert.deepEqual(b.firestore_reads, { index_meta: 1, index_rows: 2, archived_stop_ids: 0, manifest: 1 });
  } finally { fake.restore(); }
  // …and a meta with no count says so rather than inventing a zero.
  const blind = R.recaptureVerdict(D, { patched: R.patchedAfterLastScan([{ stopNbr: '1' }], LAST_SCAN), archivedStops: 0, wouldOverwrite: 0, rowCount: R.rowCountSinceLastScan({}, [{ stopNbr: '1' }]) });
  assert.match(blind.forecast, /carries no readable row count, so rows added to or removed from the day since its last scan cannot be told/);
});

test('WITH SCANS SWITCHED OFF ON THE DEPLOY the forecast says the run would be SKIPPED — and ?dryRun=1 still answers instead of being skipped with it', async () => {
  const { seed } = sep24Seed();
  const fake = installFirestoreFake(seed);
  process.env.NUVIZZ_SCANS_ENABLED = 'false';
  try {
    const b = await (await health(new Request(`https://x/.netlify/functions/history-capture-health?recapture=${D}`))).json();
    assert.equal(b.scans_enabled, false);
    // A SCRIPT READING THE FIELDS GETS WHAT A RUN WOULD DO: skipped first. would_refuse stays the
    // guard's answer for a run that gets that far (with scans on), which this one would not.
    assert.equal(b.would_skip, true);
    assert.equal(b.would_refuse, true, 'the guard\'s own answer, kept beside it');
    assert.match(b.verdict, /^DRY RUN — scans are switched off on this deploy \(NUVIZZ_SCANS_ENABLED=false, or a mirror deploy\), so a run now would be SKIPPED before it reads or writes anything\. With scans on: a hand-driven re-capture of 2026-09-24 WOULD BE REFUSED/);
    const res = await core.runHistorySnapshot(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?date=${D}&dryRun=1`, { method: 'POST' }));
    const body = await res.json();
    assert.equal(body.dry_run, true, `the dry run answers with scans off: ${JSON.stringify(body)}`);
    assert.equal(body.dates[0].scans_enabled, false);
    assert.equal(body.dates[0].would_skip, true);
    assert.match(body.dates[0].verdict, /would be SKIPPED/);
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    assert.deepEqual(fake.log.other, []);
  } finally { delete process.env.NUVIZZ_SCANS_ENABLED; fake.restore(); }
});

// The other way scans are off: a MIRROR (UAT) deploy, keyed on FIRESTORE_DATABASE, never scans
// (nuvizz-scan.mts scansEnabled, mirror-guard.mts scanBlockReason) — so the 2 AM run there is
// skipped before it reads anything, and the readout has to say so. Reading only the kill switch
// would forecast a refusal or a capture on UAT that never happens.
test('ON A MIRROR (UAT) DEPLOY the readout says a run would be SKIPPED, and the run itself is skipped — the forecast and the run agree', async () => {
  const { seed } = sep24Seed();
  const fake = installFirestoreFake(seed);   // (clears FIRESTORE_DATABASE; set after it)
  process.env.FIRESTORE_DATABASE = 'uat-mirror';
  try {
    const b = await (await health(new Request(`https://x/.netlify/functions/history-capture-health?recapture=${D}`))).json();
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.scans_enabled, false, 'a mirror deploy does not scan');
    assert.equal(b.would_skip, true, 'a script reading the field is told the run would be skipped');
    assert.match(b.verdict, /^DRY RUN — scans are switched off on this deploy \(NUVIZZ_SCANS_ENABLED=false, or a mirror deploy\), so a run now would be SKIPPED before it reads or writes anything\./);
    // …and it is: the real run stops at the scans check, before the guard or the capture.
    const run = await (await core.runHistorySnapshot(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?date=${D}`, { method: 'POST' }))).json();
    assert.equal(run.skipped, 'scans-disabled', JSON.stringify(run));
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    assert.deepEqual(fake.log.other, [], 'reached nothing but Firestore');
  } finally { delete process.env.FIRESTORE_DATABASE; fake.restore(); }
});

test('patched_after_last_scan is decided by where the rows came from: a count on the index path, NULL on the scan path — never a 0 about rows nobody looked at', () => {
  const late = [{ stopNbr: '1', frozen_heal_at: HEAL_AT }, { stopNbr: '2', board_write_at: '2026-09-25T13:00:00.000Z' }, { stopNbr: '3' }];
  const idx = R.patchedForCapture('firestore-index', late, LAST_SCAN);
  assert.equal(idx.count, 2);
  assert.equal(idx.patched.byFrozenHeal, 1);
  // The scan path: the rows are NuVizz's, not the index's. Even rows carrying late stamps give null.
  assert.deepEqual(R.patchedForCapture('scan', late, LAST_SCAN), { patched: null, count: null });
  assert.deepEqual(R.patchedForCapture('scan', [{ stopNbr: '1' }], LAST_SCAN), { patched: null, count: null }, 'a clean scan is null too, not 0');
  // No readable scan time on the index path: cannot tell — null, not 0.
  const blind = R.patchedForCapture('firestore-index', late, null);
  assert.equal(blind.count, null);
  assert.equal(blind.patched.known, false);
});

// ── HISTORY_WRITE_RETRY=off, end to end: the pre-#1030 shape on EVERY side (review r3) ───────
test('HISTORY_WRITE_RETRY=off, a 429 on one stop: the night fails at once and its failure record says what Firestore said — no retry count in front', async () => {
  const { seed, nbrs } = sep24Seed({ archived: false });
  const fake = installFirestoreFake(seed);
  const inner = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if ((init.method || 'GET').toUpperCase() === 'PATCH' && url.includes(`history_days/davis__${D}/stops/${nbrs[2]}`)) {
      hits++;
      return new Response('{"error":{"code":429,"message":"This database has exceeded their maximum bandwidth for writes, please retry with exponential backoff"}}', { status: 429 });
    }
    return inner(input, init);
  };
  process.env.HISTORY_WRITE_RETRY = 'off';
  try {
    await assert.rejects(() => core.captureDate(D), /failed: 429/);
    assert.equal(hits, 1, 'one attempt — no retry with the switch off');
    const f = fake.store.get(`history_capture_failures/davis__${D}`);
    assert.ok(f, 'the failure record landed');
    assert.equal(f.stage, 'upsert');
    assert.match(f.error, /^setDoc history_days\/davis__2026-09-24\/stops\/.* failed: 429/);
    assert.doesNotMatch(f.error, /write retries this run/);
  } finally { delete process.env.HISTORY_WRITE_RETRY; globalThis.fetch = inner; fake.restore(); }
});

test('HISTORY_WRITE_RETRY=off, a clean night: the manifest, the lineage and the run result carry no retry fields — the pre-#1030 shape', async () => {
  const { seed } = sep24Seed({ archived: false });
  const fake = installFirestoreFake(seed);
  process.env.HISTORY_WRITE_RETRY = 'off';
  try {
    const r = await core.captureDate(D);
    assert.equal(r.sealed, true, JSON.stringify(r));
    for (const [what, doc] of [['run result', r], ['manifest', fake.store.get(`history_days/davis__${D}`)], ['lineage', fake.store.get(`history_days/davis__${D}/captures/v1`)]]) {
      assert.ok(doc, `${what} exists`);
      assert.equal('write_retries' in doc, false, `${what} has no write_retries`);
      assert.equal('write_pushed_back' in doc, false, `${what} has no write_pushed_back`);
    }
    // The count this change adds for the nightly run is not a retry field; it stays.
    assert.equal(fake.store.get(`history_days/davis__${D}`).patched_after_last_scan, 6);
  } finally { delete process.env.HISTORY_WRITE_RETRY; fake.restore(); }
});

// ── review r4: the run's budget reaches the ROUTES and the DRIVERS too ───────────────────────────
// The stops and the pointers were pinned; the route and driver writes were not, so either could be
// handed a fresh ten-minute budget (or ignore the one it was given) with every test green. That
// loses both headline rules for two of the four write phases: a night already past its deadline
// retries on and can be killed by Netlify before its failure record lands, and a night that
// survived a push-back there seals with write_retries 0 — "clean".
for (const [label, frag, doc] of [
  ['a ROUTE document', `history_days/davis__${D}/routes/`, 'routes'],
  ['a DRIVER document', `history_days/davis__${D}/drivers/`, 'drivers'],
]) {
  const pushBackOnce = () => {
    const inner = globalThis.fetch;
    const hits = { n: 0 };
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input?.url ?? input);
      if ((init.method || 'GET').toUpperCase() === 'PATCH' && url.includes(frag)) {
        hits.n++;
        if (hits.n === 1) return new Response('{"error":{"code":429,"message":"This database has exceeded their maximum bandwidth for writes, please retry with exponential backoff"}}', { status: 429 });
      }
      return inner(input, init);
    };
    return { hits, restore: () => { globalThis.fetch = inner; } };
  };

  test(`A NIGHT ALREADY PAST ITS RETRY DEADLINE, PUSHED BACK ON ${label.toUpperCase()}: no retry, the capture stops, and the failure record lands`, async () => {
    const { seed } = sep24Seed({ archived: false });
    const fake = installFirestoreFake(seed);
    const net = pushBackOnce();
    try {
      await assert.rejects(() => core.captureDate(D, { deadlineAt: Date.now() - 1 }), (e) => {
        assert.match(e.message, new RegExp(`^stopped retrying at the run's 10-minute retry deadline; write retries this run: 0 — setDoc history_days/davis__${D}/${doc}/\\S+ failed: 429`));
        return true;
      });
      assert.equal(net.hits.n, 1, `the ${doc} write was made exactly once — not retried on a fresh ten minutes`);
      const f = fake.store.get(`history_capture_failures/davis__${D}`);
      assert.ok(f, 'the failure record landed');
      assert.equal(f.stage, 'upsert');
      assert.match(f.error, new RegExp(`^stopped retrying at the run's 10-minute retry deadline; write retries this run: 0 — setDoc history_days/davis__${D}/${doc}/`));
      assert.equal(fake.store.has(`history_days/davis__${D}`), false, 'no manifest');
    } finally { net.restore(); fake.restore(); }
  });

  test(`a push-back on ${label} inside the deadline is retried ON THE RUN'S BUDGET: the night seals, and the manifest, the lineage and the result say it took one retry`, async () => {
    const { seed } = sep24Seed({ archived: false });
    const fake = installFirestoreFake(seed);
    const net = pushBackOnce();
    try {
      const r = await core.captureDate(D);
      assert.equal(r.sealed, true, JSON.stringify(r));
      assert.equal(net.hits.n, 2, 'refused once, landed on the retry');
      assert.equal(r.write_retries, 1);
      assert.equal(r.write_pushed_back, true);
      const m = fake.store.get(`history_days/davis__${D}`);
      assert.equal(m.write_retries, 1, 'the manifest does not call a night that was pushed back clean');
      assert.equal(m.write_pushed_back, true);
      const lineage = fake.store.get(`history_days/davis__${D}/captures/v1`);
      assert.equal(lineage.write_retries, 1);
      assert.equal(lineage.write_pushed_back, true);
    } finally { net.restore(); fake.restore(); }
  });
}

// ── review r4: a dry run with NO date is the 2 AM run's own day, and says what that run does ─────
test('?dryRun=1 (or ?dry=1) WITH NO DATE forecasts the scheduled 2 AM capture — which the guard does not refuse — even on a day a hand-driven re-run would be refused, and says what it would write over', async () => {
  // Sep 24's shape: 6 rows changed after the last scan and 12 stops archived — a hand-driven
  // re-capture of it WOULD BE REFUSED. The cron sends no query, so its day is ET-yesterday, read off
  // new Date() (resolveDates). Pin that clock to 06:00 ET on Fri Sep 25, so the cron's day is Thu
  // Sep 24 whatever day this test runs on (on a weekend morning the real clock gives no day at all).
  const { seed } = sep24Seed();
  const fake = installFirestoreFake(seed);
  const RealDate = Date;
  const pinned = RealDate.parse('2026-09-25T10:00:00.000Z');
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(pinned); } };
  try {
    assert.equal(core.etYesterday(), D, 'the pinned clock makes the cron\'s day Sep 24');
    for (const q of ['dryRun=1', 'dry=1']) {
      const body = await (await core.runHistorySnapshot(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?${q}`, { method: 'POST' }))).json();
      assert.equal(body.dry_run, true, q);
      assert.equal(body.manual, false, `${q}: no ?date= is the cron's own run, not a hand-driven one`);
      assert.equal(body.dates.length, 1, q);
      const p = body.dates[0];
      assert.equal(p.date, D);
      assert.equal(p.manual, false);
      assert.equal(p.would_refuse, false, `${q}: the 2 AM run is never refused by this guard`);
      // A no-query POST is this same run to the code, so the forecast says so — and, since neither
      // is checked, it says what the run would WRITE OVER (the reasons a named-day run is refused
      // on), not leave it to the fields.
      assert.match(p.verdict, /^DRY RUN — the scheduled nightly capture is not refused by this guard, and neither is a POST with no query string, which the code cannot tell from it: either would write despite 6 of the day's 20 index row\(s\) were changed after that day's last scan \(2026-09-25T03:55:11\.545Z\) — 5 by the frozen-day heal/);
      assert.match(p.verdict, /; 12 of the 12 stop\(s\) already archived for 2026-09-24 would be overwritten\. It records patched_after_last_scan on the manifest\.$/);
      assert.doesNotMatch(p.verdict, /WOULD BE REFUSED/);
      assert.doesNotMatch(p.verdict, /would scan NuVizz: ~690/, 'the index path spends no scan');
      // The counts are still reported — they are what the 2 AM run records on the manifest.
      assert.equal(p.index.patched_after_last_scan, 6);
      assert.equal(p.archive.stops_archived, 12);
    }
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    assert.deepEqual(fake.log.other, []);
  } finally { globalThis.Date = RealDate; fake.restore(); }
  // A clean day at 2 AM: nothing to write over, so only the no-query sentence is added.
  const quiet = await R.planRecapture(D, { tenant: 'davis', manual: false, firestoreOn: true, env: { NUVIZZ_LEAN_DISCOVERY: 'on' }, io: io({ meta: { last_scanned_at: LAST_SCAN }, stops: [{ stopNbr: '1' }] }) });
  assert.equal(quiet.verdict, 'DRY RUN — the scheduled nightly capture is not refused by this guard, and neither is a POST with no query string, which the code cannot tell from it. It records patched_after_last_scan on the manifest.');
});

// ── review r5: a POST with NO query string is the 2 AM run to the code, and is not checked ──────
// The function's runbook lists it ("No query string → captures ET-yesterday"), and every text in
// this package now says what it does. This pins that those texts are true of the code: sent the
// morning after a failed night, it re-captures the failed day unchecked — the morning's heals
// sealed into it, the saved nightly-time records overwritten. Whether it should be checked too is
// Chad's call (it would apply to the real 2 AM run as well); until then this is the behaviour.
test('A POST WITH NO QUERY STRING IS THE 2 AM RUN TO THE CODE: the morning after a failed night it is NOT checked — it seals the morning\'s heals into the failed day over its saved stops, which is why a failed night is re-run only with ?date=', async () => {
  const { seed, nbrs } = sep24Seed();
  const fake = installFirestoreFake(seed);
  const bg = (await import('../netlify/functions/nuvizz-history-snapshot-background.mts')).default;
  const RealDate = Date;
  const pinned = RealDate.parse('2026-09-25T16:00:00.000Z');   // noon ET Fri Sep 25, after the 11:40Z heals
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(pinned); } };
  try {
    assert.equal(core.etYesterday(), D, 'the pinned clock makes ET-yesterday the failed Sep 24');
    // Named, the same re-run is refused and writes nothing…
    const named = await (await bg(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?date=${D}`, { method: 'POST' }))).json();
    assert.equal(named.dates[0].refused, 'recapture-guard');
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    assert.equal(fake.store.get(`history_days/davis__${D}/stops/${nbrs[0]}`).normalizedStatus, 'SCHEDULED');
    // …with no query string it is not checked at all.
    const body = await (await bg(new Request('https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background', { method: 'POST' }))).json();
    assert.equal(body.dates.length, 1);
    assert.equal(body.dates[0].date, D, 'it captures ET-yesterday, the failed day');
    assert.equal(body.dates[0].refused, undefined, 'not refused: the guard never ran');
    assert.equal(body.dates[0].sealed, true, JSON.stringify(body.dates[0]));
    assert.equal(body.dates[0].patched_after_last_scan, 6, 'it sealed the six rows changed after the last scan');
    const s = fake.store.get(`history_days/davis__${D}/stops/${nbrs[0]}`);
    assert.equal(s.normalizedStatus, 'DELIVERED', 'the saved nightly-time record now carries the Sep 25 delivery');
    assert.equal(s.deliveredDTTM, '2026-09-25T07:29:00');
    assert.equal(fake.log.other.filter((o) => /nuvizz/i.test(o.url)).length, 0, 'the index path: no NuVizz call');
  } finally { globalThis.Date = RealDate; fake.restore(); }
});

// ── review r4: the changed-rows reason may only claim what the path does ─────────────────────────
test('THE CHANGED-ROWS REASON FOLLOWS THE PATH: "would seal those rows as they stand now" on the index path only; on the scan path it says the scan cannot be previewed — and it refuses on both', () => {
  const patched = R.patchedAfterLastScan([{ stopNbr: '1', frozen_heal_at: HEAL_AT }, { stopNbr: '2' }], LAST_SCAN);
  const SEAL = /a re-capture would seal those rows into 2026-09-24 as they stand now, not as they stood at the last scan/;
  const SCAN = /1 of the day's 2 index row\(s\) were changed after that day's last scan \(2026-09-25T03:55:11\.545Z\) — 1 by the frozen-day heal \(the stop as a later day's scan saw it\), 0 by a dispatcher board write made after that scan; this re-capture would scan NuVizz instead of copying the index, and whether that scan returns those stops as they stand now or as they stood at the last scan cannot be known without running it/;
  const idx = R.recaptureVerdict('2026-09-24', { path: 'firestore-index', patched, archivedStops: 0, wouldOverwrite: 0 });
  assert.equal(idx.refuse, true);
  assert.match(idx.message, SEAL);
  assert.doesNotMatch(idx.message, /would scan NuVizz/);
  // The path the caller names decides, even with a count in hand (captureDate's check after its scan).
  const scan = R.recaptureVerdict('2026-09-24', { path: 'scan', patched, archivedStops: 0, wouldOverwrite: 0 });
  assert.equal(scan.refuse, true, 'the refusal on the count stands on the scan path');
  for (const t of [scan.message, scan.forecast, scan.reasons.join('. ')]) {
    assert.doesNotMatch(t, /would seal those rows into .* as they stand now/);
    assert.match(t, SCAN);
  }
  // No path named: read the way wouldOverwrite already says it — null is the scan path.
  const unnamed = R.recaptureVerdict('2026-09-24', { patched, archivedStops: 2, wouldOverwrite: null });
  assert.doesNotMatch(unnamed.message, /would seal those rows into .* as they stand now/);
  assert.match(unnamed.message, SCAN);
  assert.match(unnamed.message, /2 stop\(s\) are already archived for 2026-09-24; this re-capture would scan NuVizz/);
  assert.match(R.recaptureVerdict('2026-09-24', { patched, archivedStops: 0, wouldOverwrite: 0 }).message, SEAL, 'a count in hand and no path named: the index path');
});

// ── final check: the readout reads the scans switch without the NuVizz request code ──────────────
// history-capture-health is Firestore-only, and it used to import nuvizz-scan.mts for one env read
// (scansEnabled), which put the NuVizz requester in its bundle. It now reads the same switch from
// lib/mirror-guard.mts, which imports nothing. That is only safe while both reads agree, because
// the readout forecasts "skipped" from its read and the 2 AM run decides from nuvizz-scan's.
test('THE FREE READOUT AND THE 2 AM RUN READ THE SCANS SWITCH THE SAME WAY — every mix of the kill switch and a mirror database', async () => {
  const { scansEnabled } = await import('../netlify/functions/lib/nuvizz-scan.mts');
  const { scanBlockReason } = await import('../netlify/functions/lib/mirror-guard.mts');
  const KEYS = ['FIRESTORE_DATABASE', 'NUVIZZ_SCANS_ENABLED'];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let offSeen = 0, onSeen = 0;
  try {
    for (const db of [undefined, '', ' ', '(default)', 'uat-mirror']) {
      for (const sw of [undefined, '', 'false', 'FALSE', ' false ', 'False', 'true', 'off', '0', 'no', 'fals']) {
        for (const k of KEYS) delete process.env[k];
        if (db !== undefined) process.env.FIRESTORE_DATABASE = db;
        if (sw !== undefined) process.env.NUVIZZ_SCANS_ENABLED = sw;
        const run = scansEnabled();
        assert.equal(scanBlockReason() === null, run, `FIRESTORE_DATABASE=${JSON.stringify(db)} NUVIZZ_SCANS_ENABLED=${JSON.stringify(sw)}`);
        if (run) onSeen++; else offSeen++;
      }
    }
  } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  assert.ok(onSeen > 0 && offSeen > 0, 'the grid covers both answers');
});

test('THE FREE RE-CAPTURE READOUT CARRIES NO NUVIZZ REQUEST CODE — its bundle takes the scans switch from a module that imports nothing', async () => {
  const { build } = await import('esbuild');
  const entry = new URL('../netlify/functions/history-capture-health.mts', import.meta.url).pathname;
  const r = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent', packages: 'external' });
  const inputs = Object.keys(r.metafile.inputs);
  assert.ok(inputs.some((f) => f.endsWith('lib/history-recapture.mts')), 'the walk reached the readout\'s own module');
  assert.ok(inputs.some((f) => f.endsWith('lib/mirror-guard.mts')), 'the switch is read from mirror-guard');
  assert.deepEqual(inputs.filter((f) => /lib\/nuvizz-(request|scan)\.mts$/.test(f)), [], 'no NuVizz module anywhere in the bundle');
});
