// test/save-sent.test.mjs — WHICH STOPS EACH SAVE SENT, on its journal row (v1.87.3).
//
// Chad, 2026-09-28, 8:39 PM: BRIAN refused with "load has a non-DO stop in a delivery slot that
// this card is not sequencing". The journal said the 8:37 Save of BRIAN worked and the 8:38 and
// 8:39 Saves were refused, and could not say which stops any of them carried — it kept each
// Save's RESULT, never its payload. That the 8:37 card listed the LOCKHEED MARTIN pickup
// (RA58610778-1-1) had to be argued out of a board stamp. Chad: "maybe the journal should save
// this information."
//
// These pin the rule: a Save's row names the stops it sent, per load, in order, and the ones it
// struck off; a cap says it cut; nothing is invented for a payload with no loads; and the two
// readers (nuvizz-write-log, nuvizz-stop-explain) can answer "which Save went out without it".
import test from 'node:test';
import assert from 'node:assert/strict';
import { installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
delete process.env.AUTH_REQUIRED;

const { saveSent, boardSyncSent, sentPlace, sentNamesStop, rowIsForLoad, SENT_MAX_NBRS, SENT_MAX_LOADS } = await import('../netlify/functions/lib/save-sent.mts');
const { selectWriteOps, countWriteOps } = await import('../netlify/functions/lib/write-log-select.mts');
const { selectWriteRows, summarizeWriteOp } = await import('../netlify/functions/nuvizz-stop-explain.mts');

// BRIAN's rows on the 2026-09-29 board, read from nuvizz-pull-today-stops at 9:01 PM ET on 09-28
// (zero NuVizz calls): sixteen deliveries and the LOCKHEED MARTIN pickup at NuVizz stop 19.
const PICKUP = 'RA58610778-1-1';
const DELIVERIES = ['007183174', '007183608', '007183661', '007183224', 'PEACHTREE91426-1', '007183101', '007183391', '007183682',
  '007183221', '007183077', '007183686', '007183110', '007183394', '007183722', 'ARY249771', '007182945'];
const NON_DO = 'commitBoard(rwb): load has a non-DO stop in a delivery slot that this card is not sequencing — reorder skipped (verify in portal)';
const brian = (order, extra = {}) => ({ __key: 'BRIAN', loadNbr: 'DAVIS000204685', loadId: '6ab3f1195b97db56e47eb3c6', routeName: 'BRIAN', orderedStopNbrs: order, ...extra });
const owusu = { __key: 'OWUSU 1', loadNbr: 'DAVIS000204688', loadId: '6ab3f1195b97db56e47eb3c9', routeName: 'OWUSU 1', orderedStopNbrs: ['007183631'] };
// The Compare Save's payload shape (App.jsx onPanelSave → callWrite('commitBoard', …)).
const save = (loads, extra = {}) => ({ loads, date: '2026-09-29', origin: { name: 'DAVIS DELIVERY' }, useRwb: true, ...extra });

// Journal rows as the Save endpoint now writes them. The 8:37 list is ILLUSTRATIVE — the real
// payload was never kept, which is the point of this change — but its SHAPE is what the board
// stamp proves: the pickup was in it. The 8:38 card listed the sixteen deliveries without it.
const row837 = { at: '2026-09-29T00:37:46.415Z', op: 'commitBoard', status: 'succeeded',
  result: { ok: true, loads: [{ requestedLoadNbr: 'DAVIS000204685', loadNbr: 'DAVIS000204685', loadId: '6ab3f1195b97db56e47eb3c6', ok: true, boardSync: { patched: 14, rescued: 3, missing: 0 } }] },
  sent: saveSent(save([brian([...DELIVERIES, PICKUP])]), { createdBy: 'dispatcher' }) };
const bsync837 = { at: '2026-09-29T00:37:48.490Z', op: 'boardSync', status: 'succeeded',
  result: { date: '2026-09-29', routeName: 'BRIAN', ordered: 17, unplanned: 0, patched: 17, rescued: 0, missing: 0 },
  sent: boardSyncSent([...DELIVERIES, PICKUP], []) };
const row838 = { at: '2026-09-29T00:38:25.694Z', op: 'commitBoard', status: 'failed',
  result: { ok: false, loads: [
    { requestedLoadNbr: 'DAVIS000204685', loadNbr: 'DAVIS000204685', ok: false, error: NON_DO },
    { requestedLoadNbr: 'DAVIS000204688', loadNbr: 'DAVIS000204688', ok: true, boardSync: { patched: 1, rescued: 0, missing: 0 } },
  ] },
  sent: saveSent(save([brian(DELIVERIES), owusu]), { createdBy: 'dispatcher' }) };
// Written BEFORE this change — no `sent`, exactly like tonight's real 8:39 row.
const row839old = { at: '2026-09-29T00:39:21.509Z', op: 'commitBoard', status: 'failed',
  result: { ok: false, loads: [{ requestedLoadNbr: 'DAVIS000204685', loadNbr: 'DAVIS000204685', ok: false, error: NON_DO }] } };
// A Save of Monday's BRIAN — another day, another load of the same name.
const otherDay = { at: '2026-09-28T13:00:00.000Z', op: 'commitBoard', status: 'succeeded',
  result: { ok: true, loads: [{ requestedLoadNbr: 'DAVIS000204582', loadNbr: 'DAVIS000204582', ok: true }] },
  sent: saveSent({ loads: [{ loadNbr: 'DAVIS000204582', routeName: 'BRIAN', orderedStopNbrs: ['007181111'] }], date: '2026-09-28', useRwb: true }) };
const LEDGER = [otherDay, row839old, row838, bsync837, row837];

// ── what a Save's row now says ───────────────────────────────────────────────

test('BRIAN, 8:38 PM: the row says the card went out WITHOUT the pickup the 8:37 Save carried', () => {
  assert.deepEqual(sentPlace(row837.sent.loads[0], [PICKUP]), { at: 17, of: 17, removed: false });
  assert.deepEqual(sentPlace(row838.sent.loads[0], [PICKUP]), { at: null, of: 16, removed: false },
    'not in the order and not struck off — the exact state the non-DO guard refuses');
  assert.equal(sentNamesStop(row837, [PICKUP]), true);
  assert.equal(sentNamesStop(row838, [PICKUP]), false);
});

test('each load keeps its identity, its order as sent, and which screen built the Save', () => {
  const s = row838.sent;
  assert.equal(s.date, '2026-09-29');
  assert.equal(s.engine, 'rwb');
  assert.equal(s.source, 'dispatcher');
  assert.equal(s.loads.length, 2);
  assert.deepEqual(s.loads[0], { card: 'BRIAN', loadNbr: 'DAVIS000204685', loadId: '6ab3f1195b97db56e47eb3c6', routeName: 'BRIAN', ordered: DELIVERIES, removed: [] });
  assert.deepEqual(s.loads[1].ordered, ['007183631']);
  assert.equal(s.loads[1].routeName, 'OWUSU 1');
  assert.equal(saveSent(save([owusu], { useRwb: false, useImport: true })).engine, 'import');
  assert.equal(saveSent({ loads: [owusu] }).engine, null);
  assert.equal(saveSent({ loads: [owusu] }).date, null, 'no date sent → none recorded, never today by default');
});

test('a driver-only Save sent NO order (null); an emptied load sent an EMPTY one — two different facts', () => {
  const driverOnly = saveSent({ loads: [{ loadNbr: 'DAVIS000204685', routeName: 'BRIAN', driverId: 7, driverName: 'Brian Worley', dispatch: true }] }).loads[0];
  assert.equal(driverOnly.ordered, null);
  assert.equal(driverOnly.driver, 'Brian Worley');
  assert.equal(driverOnly.dispatch, true);
  assert.deepEqual(sentPlace(driverOnly, [PICKUP]), { at: null, of: null, removed: false });
  const emptied = saveSent({ loads: [{ loadNbr: 'DAVIS000204685', orderedStopNbrs: [], removeStopNbrs: DELIVERIES, emptyLoad: true }] }).loads[0];
  assert.deepEqual(emptied.ordered, []);
  assert.equal(emptied.emptyLoad, true);
  assert.equal(emptied.removed.length, 16);
});

test('a stop struck off the card is recorded as struck off, not as absent', () => {
  const s = saveSent(save([brian(DELIVERIES, { removeStopNbrs: [PICKUP] })]));
  assert.deepEqual(s.loads[0].removed, [PICKUP]);
  assert.deepEqual(sentPlace(s.loads[0], [PICKUP]), { at: null, of: 16, removed: true });
  assert.equal(sentNamesStop({ sent: s }, [PICKUP]), true);
});

test('a cap SAYS it cut — "sent 300" and "sent 300 of 400" are different facts', () => {
  const many = Array.from({ length: 400 }, (_, i) => `S${String(i).padStart(4, '0')}`);
  const s = saveSent({ loads: [{ loadNbr: 'X', orderedStopNbrs: many, removeStopNbrs: many }] }).loads[0];
  assert.equal(s.ordered.length, SENT_MAX_NBRS);
  assert.equal(s.orderedTotal, 400);
  assert.equal(s.removedTotal, 400);
  const loads = saveSent({ loads: Array.from({ length: 20 }, (_, i) => ({ loadNbr: `L${i}`, orderedStopNbrs: ['A'] })) });
  assert.equal(loads.loads.length, SENT_MAX_LOADS);
  assert.equal(loads.loadsTotal, 20);
  assert.equal(saveSent(save([brian(DELIVERIES)])).loads[0].orderedTotal, undefined, 'no cut → no total');
  const b = boardSyncSent(many, []);
  assert.equal(b.ordered.length, SENT_MAX_NBRS);
  assert.equal(b.orderedTotal, 400);
  assert.equal(b.unplannedTotal, undefined);
});

test('nothing to record → null, never a half-empty row that reads "this Save sent nothing"', () => {
  for (const p of [undefined, null, {}, 'loads', { loads: 'x' }, { loads: [] }, { loads: [null, 5, 'x'] }]) assert.equal(saveSent(p), null, JSON.stringify(p));
  // A single-stop op names its stop in its own result; it has no loads to record.
  assert.equal(saveSent({ stopNbr: '007183631', newDate: '2026-09-30' }), null);
});

test('hygiene: ids trimmed and stringified, blanks dropped, over-long values cut, a bad date refused', () => {
  const s = saveSent({ date: '9/29/2026', loads: [{ loadNbr: '  DAVIS000204685 ', routeName: 'x'.repeat(200), orderedStopNbrs: [' 007183174 ', '', null, 7183608, undefined] }] }, { createdBy: ` ${'d'.repeat(80)} ` });
  assert.equal(s.date, null);
  assert.equal(s.loads[0].loadNbr, 'DAVIS000204685');
  assert.equal(s.loads[0].routeName.length, 64);
  assert.deepEqual(s.loads[0].ordered, ['007183174', '7183608']);
  assert.equal(s.source.length, 40);
});

test('rowIsForLoad: a Save OF the load, by name, number, id or card key — and older rows by the number their result names', () => {
  for (const k of ['BRIAN', 'brian', 'DAVIS000204685', '6ab3f1195b97db56e47eb3c6']) assert.equal(rowIsForLoad(row838, k), true, k);
  assert.equal(rowIsForLoad(row839old, 'DAVIS000204685'), true, 'pre-`sent` row: found by its result');
  assert.equal(rowIsForLoad(row839old, 'BRIAN'), false, 'its result never named the route — said, not guessed');
  assert.equal(rowIsForLoad(bsync837, 'BRIAN'), true);
  assert.equal(rowIsForLoad(row838, 'OWUSU 1'), true);
  assert.equal(rowIsForLoad(row838, 'MARCUS'), false);
  assert.equal(rowIsForLoad(row838, ''), false);
});

// ── the write log (nuvizz-write-log ?stop= / ?load=) ─────────────────────────

test('write log ?stop=: the Saves that CARRIED the pickup, and not the ones that went out without it', () => {
  const rows = selectWriteOps(LEDGER, { stop: PICKUP, limit: 50 });
  assert.deepEqual(rows.map((r) => r.at), [bsync837.at, row837.at]);
  assert.equal(countWriteOps(LEDGER, { stop: 'ra58610778-1-1' }), 2, 'case-insensitive');
});

test('write log ?load=: every Save of BRIAN on its number — the refused ones included', () => {
  const rows = selectWriteOps(LEDGER, { load: 'DAVIS000204685', limit: 50 });
  assert.deepEqual(rows.map((r) => r.at), [row839old.at, row838.at, row837.at]);
  const byName = selectWriteOps(LEDGER, { load: 'BRIAN', limit: 50 });
  assert.deepEqual(byName.map((r) => r.at), [row838.at, bsync837.at, row837.at, otherDay.at], 'by name: every BRIAN, every day — narrow with since=');
  assert.deepEqual(selectWriteOps(LEDGER, { load: 'BRIAN', since: '2026-09-29', limit: 50 }).map((r) => r.at), [row838.at, bsync837.at, row837.at]);
});

test('write log ?stop= still finds a row written before `sent`, where the result names the stop', () => {
  const old = { at: '2026-09-10T13:04:58Z', op: 'commitBoard', status: 'failed', result: { ok: false, loads: [{ loadNbr: 'DAVIS000203001', ok: false, error: 'commitBoard(rwb): stop AVRT-0170416694 is ALREADY PLANNED on JOE (DAVIS000203002)' }] } };
  assert.equal(selectWriteOps([old], { stop: 'AVRT-0170416694', limit: 5 }).length, 1);
  assert.equal(selectWriteOps([old], { stop: 'AVRT-017041669', limit: 5 }).length, 0, 'a prefix is not the stop');
});

// ── stop-explain: "when did the card lose it" is a read ──────────────────────

test('stop-explain lists every Save of the stop\'s route that day and says which ones carried it', () => {
  const rows = selectWriteRows(LEDGER, { candidates: [PICKUP], routes: ['BRIAN'], date: '2026-09-29' });
  assert.deepEqual(rows.map((r) => r.at), [row838.at, bsync837.at, row837.at],
    'the 8:38 Save is listed although it never named the stop — that absence is the finding; Monday\'s BRIAN is not');
  assert.match(rows[0].summary, /^DAVIS000204685 \(BRIAN\): FAILED — commitBoard\(rwb\): load has a non-DO stop .* · sent 16 stops — NOT this one; DAVIS000204688 \(OWUSU 1\): ok \(board patched 1, rescued 0, missing 0\) · sent 1 stop — NOT this one$/);
  assert.match(rows[1].summary, /^BRIAN on 2026-09-29: 17 planned, 0 un-planned → patched 17, rescued 0, missing 0 · this one #17$/);
  assert.match(rows[2].summary, /^DAVIS000204685 \(BRIAN\): ok \(board patched 14, rescued 3, missing 0\) · sent 17 stops, this one #17$/);
});

test('stop-explain: a struck-off stop, a driver-only Save, and a cut list each say what they are', () => {
  const struck = { at: 'T1', op: 'commitBoard', status: 'succeeded', result: { ok: true, loads: [{ requestedLoadNbr: 'DAVIS000204685', loadNbr: 'DAVIS000204685', ok: true }] }, sent: saveSent(save([brian(DELIVERIES, { removeStopNbrs: [PICKUP] })])) };
  assert.match(summarizeWriteOp(struck, [PICKUP]), / · sent 16 stops and struck this one off$/);
  const driverOnly = { at: 'T2', op: 'commitBoard', status: 'succeeded', result: { ok: true, loads: [{ requestedLoadNbr: 'DAVIS000204685', loadNbr: 'DAVIS000204685', ok: true }] }, sent: saveSent({ loads: [{ loadNbr: 'DAVIS000204685', routeName: 'BRIAN', driverId: 7 }] }) };
  assert.match(summarizeWriteOp(driverOnly, [PICKUP]), / · sent no stop order$/);
  const many = Array.from({ length: 400 }, (_, i) => `S${i}`);
  const cut = { at: 'T3', op: 'commitBoard', status: 'succeeded', result: { ok: true, loads: [{ requestedLoadNbr: 'X', loadNbr: 'X', ok: true }] }, sent: saveSent({ loads: [{ loadNbr: 'X', orderedStopNbrs: many }] }) };
  assert.match(summarizeWriteOp(cut, [PICKUP]), /sent 400 stops \(list cut at 300; this one not in it\)$/, 'past the cap an absence is not proof');
  assert.match(summarizeWriteOp(row837), / · sent 17 stops$/, 'no stop asked about → just the count');
});

test('a row written before `sent` summarises exactly as it always did', () => {
  assert.equal(summarizeWriteOp(row839old, [PICKUP]), `DAVIS000204685: FAILED — ${NON_DO.slice(0, 160)}`);
  assert.equal(summarizeWriteOp({ op: 'boardSync', result: bsync837.result }, [PICKUP]), 'BRIAN on 2026-09-29: 17 planned, 0 un-planned → patched 17, rescued 0, missing 0');
});
