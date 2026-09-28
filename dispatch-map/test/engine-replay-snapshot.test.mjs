// test/engine-replay-snapshot.test.mjs — the READ-ONLY "before" snapshot of the engine's
// stored replay numbers (scripts/engine-replay-snapshot.mjs). Everything runs against a fake
// Firestore REST server held in memory: no test here reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  takeSnapshot, runCli, webConfigFromBundle, decodeValue, describeSnapshot,
  SEQUENCE_FIELDS, PLAN_FIELDS, MANIFEST_FIELDS, SNAPSHOT_KIND,
} from '../scripts/engine-replay-snapshot.mjs';

const PROJECT = 'demo-project';
const KEY = 'AIzaFAKE_KEY_FOR_TESTS_ONLY_0123456789';

// JS value → Firestore REST typed value (what the server's toFirestoreValue writes).
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}
const docOf = (coll, id, obj) => ({
  name: `projects/${PROJECT}/databases/(default)/documents/${coll}/${id}`,
  fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)])),
});

/** A fake Firestore: collections of {id: obj}, served page by page, every request recorded. */
function fakeFirestore(collections, { pageSize = 2, refuse = null } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method ?? 'GET', body: init.body });
    const u = new URL(url);
    const prefix = `/v1/projects/${PROJECT}/databases/(default)/documents/`;
    assert.ok(u.pathname.startsWith(prefix), `unexpected path ${u.pathname}`);
    const rest = decodeURIComponent(u.pathname.slice(prefix.length));
    const parts = rest.split('/');
    if (refuse && parts[0] === refuse) return new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } }), { status: 403 });
    const coll = collections[parts[0]] || {};
    if (parts.length === 2) {
      const obj = coll[parts[1]];
      if (!obj) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
      return new Response(JSON.stringify(docOf(parts[0], parts[1], obj)), { status: 200 });
    }
    const mask = u.searchParams.getAll('mask.fieldPaths');
    const ids = Object.keys(coll).sort();
    const start = Number(u.searchParams.get('pageToken') || 0);
    const page = ids.slice(start, start + pageSize).map((id) => {
      const obj = coll[id];
      const kept = mask.length ? Object.fromEntries(Object.entries(obj).filter(([k]) => mask.includes(k))) : obj;
      return docOf(parts[0], id, kept);
    });
    const body = page.length ? { documents: page } : {};
    if (start + pageSize < ids.length) body.nextPageToken = String(start + pageSize);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetchImpl, requests };
}

const seqDay = (date, o = {}) => ({
  tenant: 'davis', date, engine_version: '2.13.0', computed_at: `${date}T07:31:00.000Z`,
  routes_scored: 40, routes_skipped: 2, unguided_count: 4, mean_score: 0.1164, median_score: 0.1, mean_score_guided: 0.11,
  median_score_guided: 0.09, mean_score_unguided: 0.17, mean_seq_dev_guided: 0.2, mean_erp_per_edit_guided: 0.5,
  mean_travel_delta_min: -3.4, ...o,
});
const planDay = (date, o = {}) => ({
  tenant: 'davis', date, engine_version: '2.13.0', computed_at: `${date}T07:33:00.000Z`,
  drivers: 30, trips_engine: 44, trips_actual: 41, planned_stops: 700, unassigned_count: 3,
  stop_agreement_pct: 33.2, coload_agreement_pct: 40.1, coload_precision_pct: 38.5, stop_agreement_known_pct: 37.8,
  stop_agreement_fallback_pct: 12.5, candidate_containment_pct: 81.2, est_travel_engine_min: 9000, est_travel_actual_min: 8400,
  matched_load_sequence_score: 0.14, tie_margin: { stops: 300, mean: 1.25, p50: 0.9, share_lt_05: 0.21, share_lt_1: 0.44 },
  // a big field the snapshot must NOT pull down: the mask keeps it on the server
  per_driver: [{ driver: 'X' }],
  ...o,
});
function world(extra = {}) {
  return {
    route_proposals_daily: {
      'davis__2026-09-01': seqDay('2026-09-01'),
      'davis__2026-09-02': seqDay('2026-09-02', { mean_score: 0.2 }),
      'davis__2026-09-03': seqDay('2026-09-03'),
      'other__2026-09-01': seqDay('2026-09-01', { tenant: 'other', mean_score: 9 }),
    },
    plan_proposals_daily: {
      'davis__2026-09-01': planDay('2026-09-01'),
      'davis__2026-09-02': planDay('2026-09-02'),
    },
    plan_version_rollups: {
      'davis__2.13.0': { tenant: 'davis', engine_version: '2.13.0', days_scored: 2, stop_agreement_wmean: 33.2 },
      'davis__2.12.1': { tenant: 'davis', engine_version: '2.12.1', days_scored: 9, stop_agreement_wmean: 26.5 },
    },
    history_days: {
      'davis__2026-09-01': { captured_at: '2026-09-02T06:01:00.000Z', capture_version: 1, checksum: 'a', verified: true, complete: true, counts: { stops: 700 } },
      'davis__2026-09-02': { captured_at: '2026-09-03T06:01:00.000Z', capture_version: 1, checksum: 'b', verified: true, complete: true },
    },
    routing_engine_config: { davis: { w_candidate_rank: 2, updated_at: '2026-08-25T00:00:00.000Z' } },
    plan_replay_cursor: { davis: { tenant: 'davis', stopped_at: null, engine_version: '2.13.0' } },
    ...extra,
  };
}

test('the snapshot only ever reads: every request is a GET to Firestore\'s documents tree, with the key, and every list is field-masked', async () => {
  const fs = fakeFirestore(world());
  await takeSnapshot({ fetchImpl: fs.fetchImpl, key: KEY, project: PROJECT, now: () => new Date('2026-09-28T12:00:00Z') });
  assert.ok(fs.requests.length >= 6);
  for (const r of fs.requests) {
    assert.equal(r.method, 'GET', `a ${r.method} was sent: ${r.url}`);
    assert.equal(r.body, undefined, 'a read carries no body');
    const u = new URL(r.url);
    assert.equal(u.host, 'firestore.googleapis.com');
    assert.ok(u.pathname.startsWith(`/v1/projects/${PROJECT}/databases/(default)/documents/`), u.pathname);
    assert.ok(!/:(commit|batchWrite|runQuery|runAggregationQuery|beginTransaction)/.test(u.pathname), `not a plain read: ${u.pathname}`);
    assert.equal(u.searchParams.get('key'), KEY);
  }
  const listsOf = (coll) => fs.requests.filter((r) => new URL(r.url).pathname.endsWith(`/documents/${coll}`));
  assert.deepEqual(new URL(listsOf('route_proposals_daily')[0].url).searchParams.getAll('mask.fieldPaths'), SEQUENCE_FIELDS);
  assert.deepEqual(new URL(listsOf('plan_proposals_daily')[0].url).searchParams.getAll('mask.fieldPaths'), PLAN_FIELDS);
  assert.deepEqual(new URL(listsOf('history_days')[0].url).searchParams.getAll('mask.fieldPaths'), MANIFEST_FIELDS);
  assert.ok(listsOf('plan_version_rollups')[0].url.includes('mask.fieldPaths='));
});

test('each stored day is saved under its date: numbers decoded, another tenant\'s days dropped, every page followed', async () => {
  const fs = fakeFirestore(world(), { pageSize: 2 });
  const s = await takeSnapshot({ fetchImpl: fs.fetchImpl, key: KEY, project: PROJECT, now: () => new Date('2026-09-28T12:00:00Z') });
  assert.equal(s.kind, SNAPSHOT_KIND);
  assert.equal(s.taken_at, '2026-09-28T12:00:00.000Z');
  // 4 sequencing docs over two pages of 2 — 2026-09-03 is only on the second page — davis only.
  assert.deepEqual(Object.keys(s.sequence), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.equal(s.sequence['2026-09-01'].mean_score, 0.1164, 'the davis number, not the other tenant\'s 9');
  assert.equal(s.sequence['2026-09-02'].mean_score, 0.2);
  assert.equal(s.sequence['2026-09-01'].routes_scored, 40, 'integerValue "40" decodes to the number 40');
  assert.deepEqual(s.plan['2026-09-01'].tie_margin, { stops: 300, mean: 1.25, p50: 0.9, share_lt_05: 0.21, share_lt_1: 0.44 });
  assert.equal(s.plan['2026-09-01'].per_driver, undefined, 'the mask kept the heavy per-driver list on the server');
  assert.deepEqual(Object.keys(s.version_rollups).sort(), ['2.12.1', '2.13.0']);
  assert.equal(s.manifests['2026-09-01'].captured_at, '2026-09-02T06:01:00.000Z');
  assert.equal(s.manifests['2026-09-01'].counts, undefined, 'manifest counts are not asked for');
  assert.deepEqual(s.engine_config_stored, { w_candidate_rank: 2, updated_at: '2026-08-25T00:00:00.000Z' });
  assert.equal(s.plan_replay_cursor.engine_version, '2.13.0');
  assert.ok(s.reads >= 3 + 2 + 2 + 2 + 2, `reads counted: ${s.reads}`);
  assert.match(describeSnapshot(s), /sequencing days \(route_proposals_daily\): 3 — 2\.13\.0 ×3/);
});

test('a missing number stays missing: a stored null or NaN is saved as null, never as 0', () => {
  assert.equal(decodeValue({ nullValue: null }), null);
  assert.equal(decodeValue({ doubleValue: 'NaN' }), null);
  assert.equal(decodeValue({ doubleValue: 'Infinity' }), null);
  assert.equal(decodeValue({ integerValue: '0' }), 0, 'a real zero is kept');
  assert.equal(decodeValue(undefined), null);
});

test('a read the Firestore rules refuse stops the snapshot with the reason — no partial snapshot', async () => {
  const fs = fakeFirestore(world(), { refuse: 'plan_proposals_daily' });
  await assert.rejects(
    takeSnapshot({ fetchImpl: fs.fetchImpl, key: KEY, project: PROJECT }),
    /plan_proposals_daily failed: HTTP 403 — the Firestore rules refused an anonymous read/,
  );
});

// runCli with an in-memory disk.
function memDisk(files = {}) {
  const disk = { ...files };
  const writes = [];
  return {
    disk, writes,
    deps: {
      exists: (p) => p in disk,
      writeFile: (p, s) => { writes.push(p); disk[p] = s; },
      rename: (a, b) => { disk[b] = disk[a]; delete disk[a]; },
      readFile: (p) => { if (!(p in disk)) throw new Error(`ENOENT ${p}`); return disk[p]; },
      readDir: () => [],
      cwd: '/work',
      now: () => new Date('2026-09-28T12:00:00Z'),
      out: () => {}, err: () => {},
    },
  };
}

test('the BEFORE file is never replaced by accident: an existing --out is refused before any read, unless --overwrite', async () => {
  const fs = fakeFirestore(world());
  const m = memDisk({ '/work/engine-before.json': '{"the":"only copy of the old numbers"}' });
  const errs = [];
  const code = await runCli(['--out', 'engine-before.json', '--key', KEY, '--project', PROJECT], { ...m.deps, fetchImpl: fs.fetchImpl, err: (s) => errs.push(s) });
  assert.equal(code, 2);
  assert.equal(fs.requests.length, 0, 'refused before spending a single read');
  assert.equal(m.disk['/work/engine-before.json'], '{"the":"only copy of the old numbers"}');
  assert.match(errs.join('\n'), /already exists — refusing to replace it/);

  const code2 = await runCli(['--out', 'engine-before.json', '--key', KEY, '--project', PROJECT, '--overwrite'], { ...m.deps, fetchImpl: fs.fetchImpl });
  assert.equal(code2, 0);
  assert.equal(JSON.parse(m.disk['/work/engine-before.json']).kind, SNAPSHOT_KIND);
});

test('a failed read writes nothing at all', async () => {
  const fs = fakeFirestore(world(), { refuse: 'history_days' });
  const m = memDisk();
  const errs = [];
  const code = await runCli(['--out', 'engine-before.json', '--key', KEY, '--project', PROJECT], { ...m.deps, fetchImpl: fs.fetchImpl, err: (s) => errs.push(s) });
  assert.equal(code, 1);
  assert.deepEqual(m.writes, [], 'no file, not even a temp file');
  assert.match(errs.join('\n'), /Nothing was written/);
});

test('the web key is the Firebase one from the built bundle — never the Maps key that sits beside it', () => {
  const bundle = 'const M={apiKey:"AIzaMAPS_KEY_NOT_THIS_ONE_000000000000"};'
    + 'var q=1;const cfg={apiKey:"AIzaFIREBASE_WEB_KEY_1234567890ABCDEFG",authDomain:"demo-project.firebaseapp.com",projectId:"demo-project",storageBucket:"x"};';
  assert.deepEqual(webConfigFromBundle(bundle), { key: 'AIzaFIREBASE_WEB_KEY_1234567890ABCDEFG', project: 'demo-project' });
  assert.equal(webConfigFromBundle('apiKey:void 0,projectId:void 0'), null, 'a build without the Firebase env has no key');
  assert.equal(webConfigFromBundle(''), null);
});

test('the CLI finds the key in --bundle, and says what to do when there is none', async () => {
  const fs = fakeFirestore(world());
  const bundle = 'x={apiKey:"AIzaFIREBASE_WEB_KEY_1234567890ABCDEFG",authDomain:"a",projectId:"demo-project"}';
  const m = memDisk({ '/work/live.js': bundle });
  const outs = [];
  const code = await runCli(['--out', 'snap.json', '--bundle', 'live.js'], { ...m.deps, fetchImpl: fs.fetchImpl, out: (s) => outs.push(s) });
  assert.equal(code, 0);
  assert.ok(fs.requests.every((r) => new URL(r.url).searchParams.get('key') === 'AIzaFIREBASE_WEB_KEY_1234567890ABCDEFG'));
  assert.match(outs.join('\n'), /key from live\.js/);

  const m2 = memDisk({ '/work/empty.js': 'nothing here' });
  const errs = [];
  const code2 = await runCli(['--out', 'snap.json', '--bundle', 'empty.js'], { ...m2.deps, fetchImpl: fs.fetchImpl, err: (s) => errs.push(s) });
  assert.equal(code2, 2);
  assert.match(errs.join('\n'), /no Firebase web key found/);
});

test('bad arguments are refused, not guessed at', async () => {
  const m = memDisk();
  for (const argv of [[], ['--out'], ['--out', 'x.json', '--tenant', 'a/b'], ['--out', 'x.json', '--frobnicate']]) {
    assert.equal(await runCli(argv, { ...m.deps, fetchImpl: () => { throw new Error('no read may happen'); } }), 2, JSON.stringify(argv));
  }
});
