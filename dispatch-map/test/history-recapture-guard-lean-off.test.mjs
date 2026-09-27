// With NUVIZZ_LEAN_DISCOVERY not on, EVERY history capture scans NuVizz — ~690 calls a day by the
// estimate history-core.mts states, on a 2,000/day ceiling. A hand-driven re-capture of a day that
// is already partly archived must be refused BEFORE that scan, not by the in-hand check after it.
//
// Its own file because history-core reads NUVIZZ_LEAN_DISCOVERY once, at import (the production
// shape); the sibling history-recapture-guard.test.mjs runs with it on. node --test runs each file
// in its own process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

delete process.env.NUVIZZ_LEAN_DISCOVERY;
delete process.env.HISTORY_RECAPTURE_GUARD;
delete process.env.HISTORY_WRITE_RETRY;
delete process.env.NUVIZZ_SCANS_ENABLED;
delete process.env.AUTH_REQUIRED;

const core = await import('../netlify/functions/lib/history-core.mts');
const R = await import('../netlify/functions/lib/history-recapture.mts');

// The scan's cost, as the one-line verdict now says it whenever a run would go ahead on the scan path.
const SCAN_COST = /This run would scan NuVizz: ~690 NuVizz calls \(the estimate history-core\.mts states for the nightly scan; not measured[^)]*\)\. Started by hand, that scan needs Chad's per-request permission \(CLAUDE\.md's NuVizz cost rule\), and what it returns for the day cannot be known without running it\./;
const ANY_SCAN_COST = /would scan NuVizz: ~690/;

const D = '2026-09-24';
const LAST_SCAN = '2026-09-25T03:55:11.545Z';
const row = (n) => ({ stopNbr: n, isPlanned: true, normalizedStatus: 'SCHEDULED', status: '20', loadNbr: 'CANNON', routeName: 'CANNON', driverName: 'Jessica Sage', driverUserName: 'jsage' });
const seed = () => ({
  // A perfectly usable index — with lean discovery off the capture scans anyway.
  [`nuvizz_stop_index/davis__${D}`]: { last_scanned_at: LAST_SCAN, scanState: null },
  [`nuvizz_stop_index/davis__${D}/stops/1`]: row('1'),
  [`nuvizz_stop_index/davis__${D}/stops/2`]: row('2'),
  // The partial nightly archive.
  [`history_days/davis__${D}/stops/1`]: { ...row('1'), capture_version: 1, captured_at: '2026-09-25T06:00:59.145Z' },
});
const writesOf = (log) => ({ sets: log.sets.length, patches: (log.patches || []).length, deletes: log.deletes.length, commits: log.commits.length });
const NO_WRITES = { sets: 0, patches: 0, deletes: 0, commits: 0 };

test('WITH LEAN DISCOVERY OFF, A RE-CAPTURE OF A DAY ALREADY PARTLY ARCHIVED IS REFUSED BEFORE THE NUVIZZ SCAN IT WOULD HAVE SPENT', async () => {
  const fake = installFirestoreFake(seed());
  try {
    let r, err;
    try { r = await core.captureDate(D, { manual: true }); } catch (e) { err = e; }
    assert.equal(err, undefined, `the capture went on toward the scan instead of refusing: ${err?.message}`);
    assert.equal(r.refused, 'recapture-guard');
    assert.equal(r.path, 'scan');
    assert.equal(r.archived_stops, 1);
    assert.match(r.reason, /this re-capture would scan NuVizz, and which of them a scan would overwrite cannot be known without running it/);
    assert.deepEqual(writesOf(fake.log), NO_WRITES, 'writes nothing, not even a failure record');
    assert.deepEqual(fake.log.other, [], 'reached nothing but Firestore');
  } finally { fake.restore(); }
});

test('with lean discovery off the exact re-run POST is refused through the handler, and its dry run names the scan and its estimate', async () => {
  const fake = installFirestoreFake(seed());
  try {
    const res = await core.runHistorySnapshot(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?date=${D}`, { method: 'POST' }));
    const body = await res.json();
    assert.equal(body.dates[0].refused, 'recapture-guard', JSON.stringify(body.dates[0]));
    assert.equal(body.dates[0].path, 'scan');
    const dry = await (await core.runHistorySnapshot(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?date=${D}&dryRun=1`, { method: 'POST' }))).json();
    const p = dry.dates[0];
    assert.equal(p.path, 'scan');
    assert.match(p.path_why, /NUVIZZ_LEAN_DISCOVERY is not on/);
    assert.match(String(p.nuvizz_calls_if_run), /^~690 NuVizz calls/);
    assert.equal(p.would_refuse, true);
    assert.equal(p.switches.NUVIZZ_LEAN_DISCOVERY, 'not on');
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    assert.deepEqual(fake.log.other, []);
  } finally { fake.restore(); }
});

// Review r4. On the scan path the capture writes scanDate's rows and copies nothing from the index
// (history-core.mts, `stops = scan.stops`), so the changed-rows reason may not say the run "would
// seal those rows as they stand now" — it said exactly that beside "this re-capture would scan
// NuVizz", and Chad reads this text to decide whether to spend ~690 NuVizz calls. Sep 24's shape
// (the reviewer's probe): stop 007181067 healed after the last scan; with and without an archive
// (without one, the changed rows are the ONLY reason given).
const HEAL_AT = '2026-09-25T11:40:17.853Z';
const SCAN_WORDING = /1 of the day's 3 index row\(s\) were changed after that day's last scan \(2026-09-25T03:55:11\.545Z\) — 1 by the frozen-day heal \(the stop as a later day's scan saw it\), 0 by a dispatcher board write made after that scan; this re-capture would scan NuVizz instead of copying the index, and whether that scan returns those stops as they stand now or as they stood at the last scan cannot be known without running it/;
const SEAL_WORDING = /would seal those rows into .* as they stand now/;
for (const archived of [false, true]) {
  test(`ON THE SCAN PATH${archived ? ', WITH STOPS ARCHIVED' : ', WITH NOTHING ARCHIVED'}, THE REFUSAL, THE DRY RUN AND THE GUARD-OFF FORECAST NEVER SAY THE RUN WOULD SEAL THE INDEX ROWS AS THEY STAND NOW`, async () => {
    const s = {
      [`nuvizz_stop_index/davis__${D}`]: { last_scanned_at: LAST_SCAN, scanState: null, count: 3 },
      [`nuvizz_stop_index/davis__${D}/stops/007181067`]: { ...row('007181067'), normalizedStatus: 'DELIVERED', frozen_heal_at: HEAL_AT },
      [`nuvizz_stop_index/davis__${D}/stops/2`]: row('2'),
      [`nuvizz_stop_index/davis__${D}/stops/3`]: row('3'),
    };
    if (archived) for (const n of ['2', '3']) s[`history_days/davis__${D}/stops/${n}`] = { ...row(n), capture_version: 1, captured_at: '2026-09-25T06:00:59.145Z' };
    const fake = installFirestoreFake(s);
    try {
      let r, err;
      try { r = await core.captureDate(D, { manual: true }); } catch (e) { err = e; }
      assert.equal(err, undefined, `the capture went on toward the scan instead of refusing: ${err?.message}`);
      assert.equal(r.refused, 'recapture-guard', 'the count still refuses on the scan path');
      assert.equal(r.path, 'scan');
      assert.doesNotMatch(r.reason, SEAL_WORDING);
      assert.match(r.reason, SCAN_WORDING);
      assert.equal(/already archived/.test(r.reason), archived);

      const dry = (await (await core.runHistorySnapshot(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?date=${D}&dryRun=1`, { method: 'POST' }))).json()).dates[0];
      assert.equal(dry.path, 'scan');
      assert.match(String(dry.nuvizz_calls_if_run), /^~690 NuVizz calls/);
      assert.equal(dry.would_refuse, true);
      assert.match(dry.verdict, /^DRY RUN — a hand-driven re-capture of 2026-09-24 WOULD BE REFUSED, before any write: /);
      assert.doesNotMatch(dry.verdict, SEAL_WORDING);
      assert.match(dry.verdict, SCAN_WORDING);
      assert.doesNotMatch(dry.verdict, ANY_SCAN_COST, 'a refusal stops before the scan and spends nothing');

      process.env.HISTORY_RECAPTURE_GUARD = 'off';
      try {
        const off = (await (await core.runHistorySnapshot(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?date=${D}&dryRun=1`, { method: 'POST' }))).json()).dates[0];
        assert.equal(off.would_refuse, false);
        assert.match(off.verdict, /^DRY RUN — HISTORY_RECAPTURE_GUARD is off, so a hand-driven re-capture of 2026-09-24 would NOT be refused: it would write despite /);
        assert.doesNotMatch(off.verdict, SEAL_WORDING);
        assert.match(off.verdict, SCAN_WORDING);
        assert.match(off.verdict, SCAN_COST, 'with the guard off this run goes ahead, and on this path it spends the scan');
      } finally { delete process.env.HISTORY_RECAPTURE_GUARD; }

      assert.deepEqual(writesOf(fake.log), NO_WRITES);
      assert.deepEqual(fake.log.other, [], 'reached nothing but Firestore');
    } finally { fake.restore(); }
  });
}

// Review r5. With both counts at zero a named-day re-capture on the scan path GOES AHEAD — and
// spends the scan. The verdict said "WOULD PROCEED" and left the ~690 calls to a field
// (nuvizz_calls_if_run); the one-line answer is what a person reads before deciding, so it says
// the cost itself now, and the permission it needs. The same for the nightly / no-query forecast
// on that path (a no-query POST is the 2 AM run to the code). The index path never names a scan,
// and a refusal never does: it stops before the scan and spends nothing.
test('A RUN THAT WOULD GO AHEAD ON THE SCAN PATH SAYS IN ITS ONE-LINE ANSWER THAT IT SPENDS THE ~690-CALL NUVIZZ SCAN — the index path and a refusal never do', async () => {
  // A clean day, nothing archived, lean discovery off: nothing refuses it, so it would scan.
  const clean = {
    [`nuvizz_stop_index/davis__${D}`]: { last_scanned_at: LAST_SCAN, scanState: null, count: 2 },
    [`nuvizz_stop_index/davis__${D}/stops/1`]: row('1'),
    [`nuvizz_stop_index/davis__${D}/stops/2`]: row('2'),
  };
  const fake = installFirestoreFake(clean);
  try {
    const p = (await (await core.runHistorySnapshot(new Request(`https://x.netlify.app/.netlify/functions/nuvizz-history-snapshot-background?date=${D}&dryRun=1`, { method: 'POST' }))).json()).dates[0];
    assert.equal(p.path, 'scan');
    assert.equal(p.would_refuse, false);
    assert.match(String(p.nuvizz_calls_if_run), /^~690 NuVizz calls/);
    assert.match(p.verdict, /^DRY RUN — a hand-driven re-capture of 2026-09-24 WOULD PROCEED: no index row carries a frozen-day-heal or board-write stamp later than the last scan, and no archived stop would be overwritten\. This run would scan NuVizz: ~690/);
    assert.match(p.verdict, SCAN_COST);
    assert.deepEqual(writesOf(fake.log), NO_WRITES);
    assert.deepEqual(fake.log.other, [], 'reached nothing but Firestore');
  } finally { fake.restore(); }

  // The same day read the other ways, with injected reads (no Firestore at all).
  const io = (idx) => ({ readIndex: async () => idx, listArchivedStopIds: async () => [], getManifest: async () => null });
  const IDX = { meta: { last_scanned_at: LAST_SCAN, count: 2 }, stops: [{ stopNbr: '1' }, { stopNbr: '2' }] };
  const LEAN = { NUVIZZ_LEAN_DISCOVERY: 'on' };
  const plan = (manual, env, idx = IDX) => R.planRecapture(D, { tenant: 'davis', manual, firestoreOn: true, scansOn: true, env, io: io(idx) });
  // Index path, named day: proceeds at 0 NuVizz calls and names no scan.
  const idxRun = await plan(true, LEAN);
  assert.equal(idxRun.path, 'firestore-index');
  assert.match(idxRun.verdict, /WOULD PROCEED/);
  assert.doesNotMatch(idxRun.verdict, ANY_SCAN_COST);
  // An EMPTY or HALTED index sends a lean deploy to the scan too, and the answer says so.
  for (const idx of [{ meta: null, stops: [] }, { meta: { ...IDX.meta, scanState: { halted: true } }, stops: IDX.stops }]) {
    const p = await plan(true, LEAN, idx);
    assert.equal(p.path, 'scan');
    assert.match(p.verdict, SCAN_COST);
  }
  // The nightly / no-query forecast: the scan named on the scan path, never on the index path.
  const nightScan = await plan(false, {});
  assert.equal(nightScan.path, 'scan');
  assert.match(nightScan.verdict, /^DRY RUN — the scheduled nightly capture is not refused by this guard, and neither is a POST with no query string, which the code cannot tell from it\. It records patched_after_last_scan on the manifest\. This run would scan NuVizz: ~690/);
  assert.match(nightScan.verdict, SCAN_COST);
  const nightIdx = await plan(false, LEAN);
  assert.equal(nightIdx.path, 'firestore-index');
  assert.doesNotMatch(nightIdx.verdict, ANY_SCAN_COST);
});
