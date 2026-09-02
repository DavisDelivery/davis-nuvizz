// test/uline-forecast-ingest.test.mjs
//
// THE FORECAST INGEST, AGAINST A FAKE MAILBOX AND A MAP — every write it makes, counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { ingestForecastEmails, backfillForecasts, backfillWindow, buildVersionDoc, contentDigest, isSpreadsheetAttachment, makeRecorder } from '../netlify/functions/lib/uline-forecast-ingest.mts';
import { VERSION_LIST_MASK, markerPath, versionPath, STATUS_DOC, VERSIONS_COLLECTION } from '../netlify/functions/lib/uline-forecast-store.mts';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/uline-forecast-2026-08-04.json', import.meta.url), 'utf8'));
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A real xlsx from the real Aug-04 rows, optionally altered. */
function sheet(days = FIX.days, { warehouse = 'G', via = 'DA' } = {}) {
  const rows = [['date', 'warehouse', 'via', 'viatype', 'estimate', 'upperest']];
  for (const d of Object.keys(days).sort()) { const [y, m, dd] = d.split('-'); rows.push([`${Number(m)}/${Number(dd)}/${y.slice(2)}`, warehouse, via, via, days[d][0], days[d][1]]); }
  const ws = XLSX.utils.aoa_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'ULINEForecast');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
const AUG_AT = 1785874602000;   // 2026-08-04 20:16Z
const msg = (id, buf, over = {}) => ({ id, from: 'David.Luo@uline.com', subject: 'DA - G - Uline Forecast', receivedAt: AUG_AT, attachments: [{ id: `att-${id}`, filename: 'ULINE_Forecast.xlsx', contentType: XLSX_MIME }], _buf: buf, ...over });

/** A fake MailSource that counts calls, and a Map-backed Firestore with a digest query. */
function world(messages, { failDownload = null, listThrows = null } = {}) {
  const docs = new Map(); const blobs = new Map(); const calls = { list: 0, download: 0 };
  const source = {
    name: 'gmail',
    async list() { calls.list += 1; if (listThrows) throw new Error(listThrows); return messages; },
    async download(m) { calls.download += 1; if (failDownload === m.id) throw new Error('boom'); return m._buf ?? null; },
  };
  const deps = {
    source,
    getDoc: async (p) => docs.get(p) ?? null,
    setDoc: async (p, d) => { docs.set(p, structuredClone(d)); return true; },
    updateDocFields: async (p, d) => { docs.set(p, { ...(docs.get(p) || {}), ...structuredClone(d) }); return true; },
    createDocIfAbsent: async (p, d) => { if (docs.has(p)) return false; docs.set(p, structuredClone(d)); return true; },
    runQuery: async (q) => { const digest = q.where.fieldFilter.value.stringValue; return [...docs.entries()].filter(([p, d]) => p.startsWith(`${VERSIONS_COLLECTION}/`) && d.contentDigest === digest).map(([p, d]) => ({ _id: p.split('/').pop(), ...d })); },
    putBlob: async (k, b) => { blobs.set(k, b.length); return { ok: true, error: null }; },
    now: () => '2026-09-02T12:00:00.000Z', nowMs: () => 1000, tenant: 'davis',
  };
  return { deps, docs, blobs, calls, source };
}
const versions = (docs) => [...docs.entries()].filter(([p]) => p.startsWith(`${VERSIONS_COLLECTION}/`)).map(([, d]) => d);
const markers = (docs) => [...docs.entries()].filter(([p]) => p.includes('uline_forecast_email__')).map(([p, d]) => ({ path: p, ...d }));

test('A FORECAST EMAIL IS FILED: blob, then version, then marker — and the version is what the scorer needs', async () => {
  const w = world([msg('m1', sheet())]);
  const order = []; const orig = { putBlob: w.deps.putBlob, setDoc: w.deps.setDoc, createDocIfAbsent: w.deps.createDocIfAbsent };
  w.deps.putBlob = async (...a) => { order.push('blob'); return orig.putBlob(...a); };
  w.deps.setDoc = async (...a) => { order.push('version'); return orig.setDoc(...a); };
  w.deps.createDocIfAbsent = async (...a) => { order.push('marker'); return orig.createDocIfAbsent(...a); };
  const r = await ingestForecastEmails(w.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['blob', 'version', 'marker']);
  assert.equal(r.outcomes[0].outcome, 'filed');
  const v = versions(w.docs)[0];
  assert.equal(v.sentDate, '2026-08-04');
  assert.equal(v.ok, true);
  assert.equal(v.rowsUsed, 332);
  assert.deepEqual(v.days['2026-09-01'], [702, 773]);
  assert.equal(v.versionId, `davis__2026-08-04__${v.contentDigest.slice(0, 8)}`);
  assert.equal(v.xlsxStored, true, 'the REAL put outcome, not an intent');
  assert.equal(v.blobKey, `davis/forecasts/${v.versionId}.xlsx`);
  assert.deepEqual(v.emailIds, ['m1']);
  const m = markers(w.docs)[0];
  assert.equal(m.path, markerPath('gmail', 'm1'));
  assert.equal(m.outcome, 'filed');
  assert.equal(m.versionId, v.versionId);
  assert.match(r.summary, /1 new forecast filed/);
  assert.equal(w.docs.get(STATUS_DOC).lastSuccessAt, '2026-09-02T12:00:00.000Z');
  assert.equal(w.docs.get(STATUS_DOC).latestSentDate, '2026-08-04');
});

test('THE SAME SHEET FORWARDED A WEEK LATER IS THE SAME VERSION SEEN TWICE — not a version with a later date', async () => {
  const w = world([msg('m1', sheet()), msg('m2', sheet(), { receivedAt: AUG_AT + 7 * 86400000, from: 'ryan@example.com' })]);
  const r = await ingestForecastEmails(w.deps);
  assert.deepEqual(r.outcomes.map((o) => o.outcome), ['filed', 'duplicate']);
  const vs = versions(w.docs);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].seen, 2);
  assert.deepEqual(vs[0].emailIds, ['m1', 'm2']);
  assert.equal(vs[0].sentDate, '2026-08-04', 'the date is the FIRST receipt');
  assert.equal(markers(w.docs).find((m) => m.path.endsWith('m2')).outcome, 'duplicate');
  assert.match(r.summary, /1 sent again \(identical\)/);
});

test('A CORRECTED SHEET THE SAME AFTERNOON IS A SECOND VERSION', async () => {
  const fixed = { ...FIX.days, '2026-09-01': [740, 810] };
  const w = world([msg('m1', sheet()), msg('m2', sheet(fixed), { receivedAt: AUG_AT + 3 * 3600000 })]);
  const r = await ingestForecastEmails(w.deps);
  assert.deepEqual(r.outcomes.map((o) => o.outcome), ['filed', 'filed']);
  const vs = versions(w.docs);
  assert.equal(vs.length, 2);
  assert.notEqual(vs[0].versionId, vs[1].versionId);
  assert.ok(vs.every((v) => v.sentDate === '2026-08-04'));
});

test('CRASH-RESUME: the version was written but the marker was not — the retry writes the marker and touches nothing else', async () => {
  const w = world([msg('m1', sheet())]);
  // First run dies after the version write.
  const orig = w.deps.createDocIfAbsent;
  w.deps.createDocIfAbsent = async () => { throw new Error('function timed out'); };
  await assert.rejects(ingestForecastEmails(w.deps));
  assert.equal(versions(w.docs).length, 1);
  assert.equal(markers(w.docs).length, 0);
  // Second run.
  w.deps.createDocIfAbsent = orig;
  const r = await ingestForecastEmails(w.deps);
  assert.equal(r.outcomes[0].outcome, 'filed');
  assert.match(r.outcomes[0].reason, /resumed/);
  const v = versions(w.docs)[0];
  assert.equal(v.seen, 1, 'not "sent again ×2" for a file Uline sent once');
  assert.deepEqual(v.emailIds, ['m1']);
  assert.equal(markers(w.docs)[0].outcome, 'filed');
  assert.equal(markers(w.docs)[0].resumed, true);
});

test('AN UNREADABLE FILE IS KEPT AS EVIDENCE — ok:false, its headers, its xlsx — and never re-read', async () => {
  const ws = XLSX.utils.aoa_to_sheet([['pro', 'lbs'], ['x', 1]]); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
  const w = world([msg('m1', Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })))]);
  const r = await ingestForecastEmails(w.deps);
  assert.equal(r.outcomes[0].outcome, 'unreadable');
  const v = versions(w.docs)[0];
  assert.equal(v.ok, false);
  assert.deepEqual(v.headers, ['pro', 'lbs']);
  assert.match(v.reason, /0 G\/DA rows \(need 20\)/);
  assert.equal(v.xlsxStored, true);
  assert.equal(markers(w.docs)[0].outcome, 'unreadable');
  // A second run costs a list and nothing else.
  const r2 = await ingestForecastEmails(w.deps);
  assert.equal(r2.alreadyMarked, 1);
  assert.equal(w.calls.download, 1);
});

test('a message with no spreadsheet is marked ignored; a download that throws leaves NO marker and is retried', async () => {
  const w = world([msg('m1', null, { attachments: [{ id: 'a', filename: 'notes.pdf', contentType: 'application/pdf' }] }), msg('m2', sheet())], { failDownload: 'm2' });
  const r = await ingestForecastEmails(w.deps);
  assert.deepEqual(r.outcomes.map((o) => o.outcome), ['ignored', 'retry']);
  assert.equal(markers(w.docs).length, 1);
  assert.equal(markers(w.docs)[0].outcome, 'ignored');
  assert.match(r.summary, /1 to retry/);
  // The retry succeeds next cycle.
  const w2 = world([msg('m2', sheet())]);
  w2.docs.set(markerPath('gmail', 'm1'), { outcome: 'ignored' });
  const r2 = await ingestForecastEmails(w2.deps);
  assert.equal(r2.outcomes[0].outcome, 'filed');
});

test('DRY RUN: downloads and parses, writes NOTHING, and lists every path it would have written', async () => {
  const w = world([msg('m1', sheet())]);
  const r = await ingestForecastEmails({ ...w.deps, dry: true });
  assert.equal(r.dry, true);
  assert.equal(r.outcomes[0].outcome, 'filed');
  assert.equal(r.outcomes[0].parse.rowsUsed, 332);
  assert.equal(w.docs.size, 0, 'no document written');
  assert.equal(w.blobs.size, 0, 'no blob written');
  assert.deepEqual(r.wouldWrite.map((x) => x.op), ['putBlob', 'setDoc', 'createDocIfAbsent']);
  assert.ok(r.wouldWrite[1].path.startsWith(`${VERSIONS_COLLECTION}/davis__2026-08-04__`));
  assert.equal(w.calls.download, 1, 'it really read the file');
});

test('a cycle with nothing new costs one list and NO downloads', async () => {
  const w = world([msg('m1', sheet())]);
  await ingestForecastEmails(w.deps);
  const r = await ingestForecastEmails(w.deps);
  assert.equal(r.alreadyMarked, 1);
  assert.equal(w.calls.list, 2);
  assert.equal(w.calls.download, 1, 'the second cycle downloaded nothing');
  assert.match(r.summary, /nothing new \(1 already judged\)/);
});

test('invalid_grant sets needsReconnect and lastError, and leaves lastSuccessAt alone', async () => {
  const w = world([], { listThrows: 'auth failed: invalid_grant' });
  w.docs.set(STATUS_DOC, { lastSuccessAt: '2026-09-01T00:00:00.000Z' });
  const r = await ingestForecastEmails(w.deps);
  assert.equal(r.ok, false);
  assert.equal(r.needsReconnect, true);
  const st = w.docs.get(STATUS_DOC);
  assert.equal(st.lastSuccessAt, '2026-09-01T00:00:00.000Z');
  assert.equal(st.lastOk, false);
  assert.match(st.lastError, /invalid_grant/);
});

test('OLDEST FIRST, so a same-day correction supersedes within one batch; the batch cap and the time budget stop cleanly', async () => {
  const fixed = { ...FIX.days, '2026-09-01': [740, 810] };
  const w = world([msg('m2', sheet(fixed), { receivedAt: AUG_AT + 3600000 }), msg('m1', sheet())]);
  const r = await ingestForecastEmails(w.deps);
  assert.deepEqual(r.outcomes.map((o) => o.id), ['m1', 'm2']);
  const cap = world([msg('a', sheet()), msg('b', sheet(fixed), { receivedAt: AUG_AT + 1 }), msg('c', sheet({ ...fixed, '2026-09-02': [1, 2] }), { receivedAt: AUG_AT + 2 })]);
  const rc = await ingestForecastEmails({ ...cap.deps, maxPerRun: 2 });
  assert.equal(rc.processed, 2); assert.equal(rc.partial, true); assert.match(rc.stoppedBecause, /batch cap/);
  let t = 0;
  const slow = world([msg('a', sheet()), msg('b', sheet(fixed), { receivedAt: AUG_AT + 1 })]);
  const rt = await ingestForecastEmails({ ...slow.deps, nowMs: () => (t += 10_000), deadlineMs: 15_000 });
  assert.equal(rt.processed, 1); assert.equal(rt.partial, true); assert.equal(rt.stoppedBecause, 'time budget');
});

test('a message with no receive time cannot be dated and is retried, not filed under 1969', async () => {
  const w = world([msg('m1', sheet(), { receivedAt: null })]);
  const r = await ingestForecastEmails(w.deps);
  assert.equal(r.outcomes[0].outcome, 'retry');
  assert.match(r.outcomes[0].reason, /no receive time/);
  assert.equal(versions(w.docs).length, 0);
});

test('THE LIST MASK NAMES EVERY VERSION FIELD BUT days — a field left out would silently vanish from the panel', () => {
  const doc = buildVersionDoc({ tenant: 'davis', versionId: 'v', email: msg('m1', null), att: { id: 'a', filename: 'f.xlsx', contentType: XLSX_MIME }, buf: Buffer.from('x'),
    read: { sheet: 'S' }, lane: { ok: true, reason: null, headers: [], warnings: [], rowsTotal: 1, rowsUsed: 1, rowsDropped: {}, seen: {}, from: 'a', to: 'b', days: {}, unreadableDates: [], weekdayMeans: {}, medianBand: 1 },
    digest: 'd', blobKey: 'k', stored: { ok: true, error: null }, at: 'now', filedBy: 'schedule' });
  for (const k of Object.keys(doc)) { if (k === 'days') continue; assert.ok(VERSION_LIST_MASK.includes(k), `mask is missing "${k}"`); }
  assert.ok(!VERSION_LIST_MASK.includes('days'));
  for (const k of VERSION_LIST_MASK) assert.ok(k in doc, `mask names "${k}" which the doc does not carry`);
});

test('the digest is the content, not the bytes', () => {
  assert.equal(contentDigest({ '2026-07-16': [630, 702], '2026-07-15': [671, 745] }), contentDigest({ '2026-07-15': [671, 745], '2026-07-16': [630, 702] }));
  assert.notEqual(contentDigest({ '2026-07-15': [671, 745] }), contentDigest({ '2026-07-15': [672, 745] }));
  assert.ok(isSpreadsheetAttachment({ filename: 'ULINE_Forecast.xlsx', contentType: XLSX_MIME }));
  assert.ok(isSpreadsheetAttachment({ filename: 'f.xls', contentType: 'application/vnd.ms-excel' }));
  assert.ok(!isSpreadsheetAttachment({ filename: 'report.pdf', contentType: 'application/pdf' }));
});

// ── BACKFILL ──────────────────────────────────────────────────────────────────

test('backfill walks calendar quarters and refuses to run for real without confirm', async () => {
  assert.deepEqual(backfillWindow('2022-06-01'), { start: '2022-06-01', end: '2022-09-01', query: 'subject:"Uline Forecast" has:attachment after:2022/06/01 before:2022/09/01' });
  assert.equal(backfillWindow('2026-11-01').end, '2027-02-01', 'across the year end');
  const w = world([]);
  const r = await backfillForecasts({ ...w.deps, sourceFor: async () => w.source, cursor: null, today: '2026-09-02' });
  assert.equal(r.refused, true);
});

test('A WINDOW AT THE CAP IS REPORTED TRUNCATED AND THE CURSOR DOES NOT ADVANCE; a normal window advances', async () => {
  const many = Array.from({ length: 100 }, (_, i) => msg(`m${i}`, sheet({ ...FIX.days, '2026-09-01': [700 + i, 800] }), { receivedAt: AUG_AT + i }));
  const w = world(many);
  const r = await backfillForecasts({ ...w.deps, sourceFor: async () => w.source, cursor: { windowStart: '2026-07-01' }, today: '2026-09-02', confirm: true, maxResults: 100, maxPerRun: 200 });
  assert.equal(r.truncated, true);
  assert.equal(r.advanced, false);
  assert.match(r.held, /at the cap/);
  assert.equal(r.cursor.windowStart, '2026-07-01');
  const ok = world([msg('m1', sheet())]);
  const r2 = await backfillForecasts({ ...ok.deps, sourceFor: async () => ok.source, cursor: { windowStart: '2026-07-01' }, today: '2026-09-02', confirm: true });
  assert.equal(r2.advanced, true);
  assert.equal(r2.cursor.windowStart, '2026-10-01');
  assert.equal(r2.cursor.filed, 1);
  assert.equal(ok.docs.get(STATUS_DOC).backfill.windowStart, '2026-10-01');
});

test('AN EMPTY WINDOW IS HELD FOR A SECOND LOOK, then passed — a forecast whose fetch failed must not be skipped for good', async () => {
  const w = world([]);
  const args = { ...w.deps, sourceFor: async () => w.source, today: '2026-09-02', confirm: true };
  const r1 = await backfillForecasts({ ...args, cursor: { windowStart: '2023-01-01' } });
  assert.equal(r1.advanced, false);
  assert.match(r1.held, /listed nothing — held for one more look/);
  assert.equal(r1.cursor.emptySeenFor, '2023-01-01');
  const r2 = await backfillForecasts({ ...args, cursor: r1.cursor });
  assert.equal(r2.advanced, true);
  assert.equal(r2.cursor.windowStart, '2023-04-01');
  // Past today: done.
  const r3 = await backfillForecasts({ ...args, cursor: { windowStart: '2026-10-01' } });
  assert.equal(r3.done, true);
  // Dry: nothing written, the plan reported.
  const wd = world([msg('m1', sheet())]);
  const rd = await backfillForecasts({ ...wd.deps, sourceFor: async () => wd.source, cursor: { windowStart: '2026-07-01' }, today: '2026-09-02', dry: true });
  assert.equal(rd.dry, true); assert.equal(wd.docs.size, 0); assert.equal(rd.wouldAdvanceTo, '2026-10-01');
});
