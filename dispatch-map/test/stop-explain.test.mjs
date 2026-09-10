// test/stop-explain.test.mjs — "WHY DOES THE BOARD SHOW THIS STOP THE WAY IT DOES?" (v1.4.0)
//
// Chad, 2026-09-10: two orders in the Routing selection — AVRT-0170416694 (McDonough, DO) and
// RA5732712 (Forest Park, PU) — that NuVizz held on WILLIAM and JOE, while our board held them
// un-planned. There are seven ways that state arises and the board could not say which. These
// tests pin the explain that answers it for free: the pure sentences, the endpoint that gathers
// the documents, and — the important one — that the endpoint spends NO vendor call (the fake
// throws on any URL that is not Firestore).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
delete process.env.AUTH_REQUIRED;

const { explainStop, servedCopy, resolveRouteOnRoster, describe, sameNbr } = await import('../netlify/functions/lib/stop-explain.mts');
const { default: handler, stopIdCandidates, selectWriteRows, summarizeWriteOp } = await import('../netlify/functions/nuvizz-stop-explain.mts');
const { etDayString } = await import('../netlify/functions/lib/firestore.mts');

const today = etDayString();
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const D1 = addDays(today, -1);
const AVRT = 'AVRT-0170416694';
const RA = 'RA5732712';

const planned = (over = {}) => ({ stopNbr: AVRT, isPlanned: true, isUnplanned: false, status: '20', normalizedStatus: 'SCHEDULED', loadNbr: 'WILLIAM', routeName: 'WILLIAM', routeSeq: 11, driverName: 'William Kidd', boardDate: today, ...over });
const unplanned = (over = {}) => ({ stopNbr: AVRT, isPlanned: false, isUnplanned: true, status: '10', normalizedStatus: 'UNPLANNED', loadNbr: null, routeName: null, routeSeq: null, boardDate: today, ...over });
const base = (over = {}) => ({ stopNbr: AVRT, date: today, today, copies: [], pool: null, snapshot: null, retiredOn: null, override: null, verdicts: [], writes: [], roster: null, history: null, ...over });
const has = (findings, re) => assert.ok(findings.some((f) => re.test(f)), `expected a finding matching ${re}\n  got:\n  - ${findings.join('\n  - ')}`);
const hasNot = (findings, re) => assert.ok(!findings.some((f) => re.test(f)), `did not expect a finding matching ${re}\n  got:\n  - ${findings.join('\n  - ')}`);

// ── the pieces ──────────────────────────────────────────────────────────────

test('sameNbr: a typed number matches its stored form across case and leading zeros, never across numbers', () => {
  assert.equal(sameNbr('7174539', '007174539'), true);
  assert.equal(sameNbr('avrt-0170416694', 'AVRT-0170416694'), true);
  assert.equal(sameNbr('007174539', '007174540'), false);
  assert.equal(sameNbr('', ''), false, 'two blanks are not the same stop');
});

test('stopIdCandidates: as typed, upper-cased, and the 9-digit form for a short numeric PRO', () => {
  assert.deepEqual(stopIdCandidates('7174539'), ['7174539', '007174539']);
  assert.deepEqual(stopIdCandidates('avrt-0170416694'), ['avrt-0170416694', 'AVRT-0170416694']);
  assert.deepEqual(stopIdCandidates(' RA5732712 '), ['RA5732712']);
  assert.deepEqual(stopIdCandidates(''), []);
});

test('servedCopy: the day document wins; a finished row filed under an earlier day is stripped as the feed strips it; else the newest open un-planned prior copy is the carry-over', () => {
  const own = { day: today, row: unplanned() };
  assert.equal(servedCopy([own], today).source, 'day-doc');
  const stale = { day: today, row: { ...unplanned(), normalizedStatus: 'DELIVERED', status: '90', boardDate: D1 } };
  assert.equal(servedCopy([stale], today).source, 'none', 'a prior-day delivery on today\'s doc is not served');
  const prior = { day: D1, row: unplanned({ boardDate: D1 }) };
  const older = { day: addDays(today, -3), row: unplanned({ boardDate: addDays(today, -3) }) };
  const r = servedCopy([older, prior], today);
  assert.equal(r.source, 'carry-over');
  assert.equal(r.copy.day, D1, 'the NEWEST prior copy is the one the fold would offer');
  assert.equal(servedCopy([{ day: D1, row: planned({ boardDate: D1 }) }], today).source, 'none', 'a prior-day PLANNED copy never carries over');
});

test('resolveRouteOnRoster: resolved / no such load / two loads share the name / no roster / no route', () => {
  const roster = { at: 'T', loads: [{ name: 'WILLIAM', loadNbr: 'DAVIS000203001', status: 'Dispatched' }, { name: 'JOE', loadNbr: 'DAVIS000203002', status: 'Draft' }, { name: 'JOE', loadNbr: 'DAVIS000203003', status: 'Draft' }] };
  assert.equal(resolveRouteOnRoster('William', roster).resolution, 'resolved', 'case-insensitive, as the verify matches');
  assert.equal(resolveRouteOnRoster('William', roster).loadNbr, 'DAVIS000203001');
  assert.equal(resolveRouteOnRoster('JOE', roster).resolution, 'ambiguous');
  assert.equal(resolveRouteOnRoster('TRAILER 1', roster).resolution, 'no-such-load');
  assert.equal(resolveRouteOnRoster('WILLIAM', null).resolution, 'no-roster');
  assert.equal(resolveRouteOnRoster(null, roster).resolution, 'no-route');
});

test('describe: one phrase per row, and an un-planned row that still carries a route name says so', () => {
  assert.match(describe(planned()), /PLANNED on WILLIAM \(stop 11\), William Kidd/);
  assert.match(describe(unplanned()), /UN-PLANNED \(UNPLANNED\)/);
  assert.match(describe(unplanned({ routeName: 'WILLIAM' })), /still carries the route name WILLIAM/);
  assert.match(describe({ normalizedStatus: 'DELIVERED', routeName: 'JOE' }), /DELIVERED on JOE/);
  assert.equal(describe(null), 'nothing');
});

// ── the sentences ───────────────────────────────────────────────────────────

test('AVRT-0170416694 — dropped off WILLIAM by the verify on a lagging stop record, with a roster that had no WILLIAM: the explain names both', () => {
  const at = today + 'T14:31:00.000Z';
  const out = explainStop(base({
    copies: [{ day: today, row: unplanned({ absentFromPull: true }), scannedAt: at }],
    verdicts: [{ at, stopNbr: AVRT, route: 'WILLIAM', verdict: 'dropped', basis: 'record', absent: true, listStatus: null,
      detail: 'stop record: UNPLANNED, on no load', path: ['roster (25 loads): no load named WILLIAM', 'stop record: UNPLANNED, on no load'] }],
    roster: { at: today + 'T09:00:00.000Z', loads: [{ name: 'JOE', loadNbr: 'DAVIS000203002', status: 'Draft' }] },
    pool: { at, windowStart: addDays(today, -30), windowEnd: addDays(today, 30), thin: false, row: null },
  }));
  assert.equal(out.served.source, 'day-doc');
  assert.equal(out.plan.isPlanned, false);
  assert.equal(out.roster.resolution, 'no-such-load');
  has(out.findings, /did NOT get AVRT-0170416694 back from NuVizz's planned\/un-planned saved search/);
  has(out.findings, /took it OFF WILLIAM — stop record: UNPLANNED, on no load \(steps: roster \(25 loads\): no load named WILLIAM → stop record/);
  has(out.findings, /roster .* has NO load named WILLIAM: the verify cannot ask the load itself/);
  has(out.findings, /open-order pool .* does not list AVRT-0170416694 open at all/);
  hasNot(out.findings, /the list is the ONLY source/, 'a verified drop is not "the list said so and nothing checked"');
});

test('RA5732712 — never held planned; the list simply reported it un-planned: the explain says the list is the only promoter and no Save is on record', () => {
  const at = today + 'T14:31:00.000Z';
  const out = explainStop(base({
    stopNbr: RA,
    copies: [{ day: today, row: unplanned({ stopNbr: RA, stopType: 'PU' }), scannedAt: at }],
    pool: { at, windowStart: addDays(today, -30), windowEnd: addDays(today, 30), thin: false, row: { stopNbr: RA, day: today, isPlanned: false, isUnplanned: true, routeName: null } },
    snapshot: { at, windowStart: addDays(today, -30), thin: false, listed: true },
    roster: { at, loads: [{ name: 'JOE', loadNbr: 'DAVIS000203002', status: 'Draft' }] },
  }));
  has(out.findings, /reported it un-planned \(status 10\) and the board had never held it planned/);
  has(out.findings, /the list is the ONLY source that can put a stop on a route/);
  has(out.findings, /pool .* agrees: un-planned/);
  has(out.findings, /un-planned snapshot .* lists it/);
  assert.equal(out.roster.resolution, 'no-route', 'no route anywhere to resolve');
});

test('the pool and the day copy disagree — pool says planned on JOE under today, the served copy is a prior-day carry-over reading un-planned', () => {
  const at = today + 'T15:01:00.000Z';
  const out = explainStop(base({
    stopNbr: RA,
    copies: [{ day: D1, row: unplanned({ stopNbr: RA, boardDate: D1 }), scannedAt: D1 + 'T23:35:00.000Z' }],
    pool: { at, windowStart: addDays(today, -30), windowEnd: addDays(today, 30), thin: false, row: { stopNbr: RA, day: today, isPlanned: true, isUnplanned: false, routeName: 'JOE', loadNbr: 'JOE' } },
    roster: { at, loads: [{ name: 'JOE', loadNbr: 'DAVIS000203002', status: 'Draft' }] },
  }));
  assert.equal(out.served.source, 'carry-over');
  assert.equal(out.served.day, D1);
  has(out.findings, new RegExp(`is NOT on the ${today} board document. The Map reaches it only as a carry-over from ${D1}`));
  has(out.findings, /pool .* says planned on JOE under .*, while the served copy says un-planned: the two disagree/);
  has(out.findings, /roster .* resolves JOE to DAVIS000203002 \(Draft\)/);
});

test('a confirmed Save stamped it planned, and the scan later had NuVizz confirm it: the explain reports both stamps and nothing alarming', () => {
  const out = explainStop(base({
    copies: [{ day: today, row: planned({ board_write_at: today + 'T13:05:00.000Z', board_write_planned: true, plan_verified_at: today + 'T14:31:00.000Z' }), scannedAt: today + 'T14:31:00.000Z' }],
    roster: { at: today + 'T09:00:00.000Z', loads: [{ name: 'WILLIAM', loadNbr: 'DAVIS000203001', status: 'Dispatched' }] },
    writes: [{ at: today + 'T13:05:02.000Z', op: 'boardSync', status: 'succeeded', summary: 'WILLIAM on ' + today + ': 11 planned, 0 un-planned → patched 11, rescued 0, missing 0' }],
  }));
  assert.equal(out.plan.isPlanned, true);
  assert.equal(out.plan.route, 'WILLIAM');
  has(out.findings, /reads PLANNED on WILLIAM \(stop 11\), William Kidd/);
  has(out.findings, /A confirmed Save stamped it planned on WILLIAM at .* since had NuVizz confirm the plan/);
  has(out.findings, /Write journal: .* boardSync succeeded — WILLIAM/);
  hasNot(out.findings, /took it OFF/);
});

test('a struck-off stop: the Save un-planned it and the write grace defends that — the explain says so rather than blaming the list', () => {
  const out = explainStop(base({
    copies: [{ day: today, row: unplanned({ board_write_at: today + 'T13:05:00.000Z', board_write_planned: false }), scannedAt: today + 'T13:20:00.000Z' }],
  }));
  has(out.findings, /A confirmed Save UN-PLANNED it at .* struck off a Compare card/);
  hasNot(out.findings, /the list is the ONLY source/);
});

test('two records share the number: the explain says which id the board shows and that the plan may live on the other', () => {
  const out = explainStop(base({
    copies: [{ day: today, row: unplanned({ dupNbr: true, dupNbrOtherId: 'ffffffffffffffffffffffff', stopId: '6a63c5844524f7f7b8ab5410' }) }],
  }));
  has(out.findings, /Two NuVizz records share this number \(other record ffffffffffffffffffffffff\); the board is showing the copy with id 6a63c5844524f7f7b8ab5410/);
});

test('nowhere at all: the explain says so and lists the days that do hold a copy', () => {
  const out = explainStop(base({ copies: [{ day: addDays(today, 1), row: planned({ boardDate: addDays(today, 1) }) }] }));
  assert.equal(out.served.source, 'none');
  has(out.findings, /on NO board document for today/);
  has(out.findings, new RegExp(`It is filed on ${addDays(today, 1)} \\(PLANNED on WILLIAM`));
});

test('the ledger says HELD but the served copy is un-planned: a contradiction is reported as one, not smoothed over', () => {
  const at = today + 'T14:31:00.000Z';
  const out = explainStop(base({
    copies: [{ day: today, row: unplanned(), scannedAt: today + 'T15:01:00.000Z' }],
    verdicts: [{ at, stopNbr: AVRT, route: 'WILLIAM', verdict: 'held', basis: 'write-grace', absent: false, listStatus: '10', detail: 'a confirmed save at T outranks the list for 60 minutes', path: [] }],
  }));
  has(out.findings, /the scan HELD it on WILLIAM .* but the copy served now is un-planned, so a later write changed it/);
});

// ── the write journal selection ─────────────────────────────────────────────

test('selectWriteRows: rows that NAME the stop, plus board-sync rows for its route on that day — newest first, capped', () => {
  const all = [
    { at: '2026-09-10T13:05:02Z', op: 'boardSync', status: 'succeeded', result: { date: '2026-09-10', routeName: 'WILLIAM', ordered: 11, unplanned: 0, patched: 11, rescued: 0, missing: 0 } },
    { at: '2026-09-10T13:04:58Z', op: 'commitBoard', status: 'failed', result: { ok: false, loads: [{ loadNbr: 'DAVIS000203001', ok: false, error: 'commitBoard(rwb): stop AVRT-0170416694 is ALREADY PLANNED on JOE (DAVIS000203002)' }] } },
    { at: '2026-09-09T20:00:00Z', op: 'boardSync', status: 'succeeded', result: { date: '2026-09-09', routeName: 'WILLIAM', ordered: 9, unplanned: 0, patched: 9, rescued: 0, missing: 0 } },   // another day
    { at: '2026-09-10T12:00:00Z', op: 'setStopDate', status: 'succeeded', result: { ok: true, stopNbr: '007174539' } },   // another stop
  ];
  const rows = selectWriteRows(all, { candidates: ['AVRT-0170416694'], routes: ['WILLIAM'], date: '2026-09-10' });
  assert.deepEqual(rows.map((r) => r.op), ['boardSync', 'commitBoard']);
  assert.match(rows[0].summary, /WILLIAM on 2026-09-10: 11 planned, 0 un-planned → patched 11/);
  assert.match(rows[1].summary, /DAVIS000203001: FAILED — commitBoard\(rwb\): stop AVRT-0170416694 is ALREADY PLANNED on JOE/);
  assert.equal(selectWriteRows(all, { candidates: ['RA5732712'], routes: [], date: '2026-09-10' }).length, 0);
  assert.equal(summarizeWriteOp({ op: 'cancelOrder', result: { error: 'refused' } }), 'refused');
});

// ── the endpoint: gathers the documents, spends nothing ─────────────────────

async function withStore(seed, fn) {
  const fake = installFirestoreFake(seed);   // no onOther → any non-Firestore fetch THROWS
  try { return await fn(fake); } finally { fake.restore(); }
}
const GET = (qs) => new Request(`https://x.netlify.app/.netlify/functions/nuvizz-stop-explain${qs}`);
const stopPath = (d, n) => `nuvizz_stop_index/davis__${d}/stops/${n}`;

test('GET ?stop= — reads the day copies, the ledger, the roster and the pool, and answers in sentences; ZERO vendor calls', async () => {
  const at = today + 'T14:31:00.000Z';
  const ledger = [{ at, stopNbr: AVRT, route: 'WILLIAM', verdict: 'dropped', basis: 'record', absent: true, listStatus: null, detail: 'stop record: UNPLANNED, on no load', path: ['roster (1 load): no load named WILLIAM', 'stop record: UNPLANNED, on no load'] }];
  await withStore({
    [`nuvizz_stop_index/davis__${today}`]: { tenant: 'davis', date: today, last_scanned_at: at },
    [stopPath(today, AVRT)]: unplanned({ absentFromPull: true, last_scanned_at: at }),
    [stopPath(D1, AVRT)]: planned({ boardDate: D1, board_write_at: D1 + 'T22:10:00.000Z', board_write_planned: true }),
    [`nuvizz_ops/plan_verdicts__davis__${today}`]: { tenant: 'davis', date: today, count: 1, rowsJson: JSON.stringify(ledger) },
    [`nuvizz_load_roster/davis__${today}`]: { at: today + 'T09:00:00.000Z', loadsJson: JSON.stringify([{ loadId: 'L2', name: 'JOE', loadNbr: 'DAVIS000203002', status: 'Draft' }]) },
    'nuvizz_active_pool/davis': { at, windowStart: addDays(today, -30), windowEnd: addDays(today, 30), count: 1, chunks: 1 },
    'nuvizz_active_pool/davis/chunks/000': { at, rowsJson: JSON.stringify([{ stopNbr: RA, day: today, isPlanned: true, routeName: 'JOE', loadNbr: 'JOE' }]) },
    'nuvizz_active_set/davis': { at, windowStart: addDays(today, -30), stopNbrsJson: JSON.stringify(['007174539']) },
    'nuvizz_write_ops/davis__bsync_1': { clientOpId: 'bsync_1', op: 'boardSync', status: 'succeeded', at: D1 + 'T22:10:02.000Z', tenant: 'DAVIS', result: { date: D1, routeName: 'WILLIAM', ordered: 11, unplanned: 0, patched: 10, rescued: 0, missing: 1, missingNbrs: [AVRT] } },
  }, async (fake) => {
    const r = await handler(GET(`?stop=${AVRT}&date=${today}`));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.nuvizzCalls, 0);
    assert.equal(j.served.source, 'day-doc');
    assert.equal(j.plan.isPlanned, false);
    assert.equal(j.copies.length, 2, 'today\'s copy and yesterday\'s');
    assert.equal(j.copies.find((c) => c.day === D1).planned, true);
    assert.equal(j.copies.find((c) => c.day === today).absentFromPull, true);
    assert.equal(j.copies.find((c) => c.day === today).scannedAt, at, 'the day document\'s own scan stamp rides along');
    assert.equal(j.verdicts.length, 1);
    assert.equal(j.roster.resolution, 'no-such-load');
    assert.equal(j.pool.listed, false);
    assert.equal(j.writes.length, 1, 'the board-sync that could not find the stop (missingNbrs names it)');
    assert.match(j.writes[0].summary, /missing 1 \(AVRT-0170416694\)/);
    has(j.findings, /took it OFF WILLIAM — stop record: UNPLANNED, on no load/);
    has(j.findings, /roster .* has NO load named WILLIAM/);
    has(j.findings, new RegExp(`Another day's copy still holds it planned: ${D1} on WILLIAM`));
    assert.equal(fake.log.other.length, 0, 'no fetch left Firestore — the explain is free by construction');
  });
});

test('GET without ?stop= is a 400, and a bad date is a 400 — never a Firestore read', async () => {
  await withStore({}, async (fake) => {
    assert.equal((await handler(GET(''))).status, 400);
    assert.equal((await handler(GET(`?stop=${RA}&date=yesterday`))).status, 400);
    assert.equal(fake.log.gets.length, 0);
  });
});

test('a short numeric PRO finds its 9-digit copy, and a stop nowhere on any board says so', async () => {
  await withStore({
    [stopPath(today, '007174539')]: planned({ stopNbr: '007174539', routeName: 'WILLIAM', loadNbr: 'WILLIAM' }),
  }, async () => {
    const j = await (await handler(GET(`?stop=7174539&date=${today}`))).json();
    assert.equal(j.served.source, 'day-doc');
    assert.equal(j.plan.route, 'WILLIAM');
    const none = await (await handler(GET(`?stop=${RA}&date=${today}`))).json();
    assert.equal(none.served.source, 'none');
    has(none.findings, /on NO board document for today/);
  });
});
