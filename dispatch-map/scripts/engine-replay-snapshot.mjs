#!/usr/bin/env node
// engine-replay-snapshot.mjs — SAVE THE ENGINE'S STORED REPLAY NUMBERS TO A FILE. READ-ONLY.
//
// WHY THIS EXISTS. After a bump of ENGINE_VERSION, the engine's two history replays
// (routing-engine-replay-background, routing-engine-plan-replay-background), when someone
// starts them, score every captured past day again — they skip only the days too early to
// judge and the days already scored at the current version — and both write each day's
// result over the old one IN PLACE:
//   route_proposals_daily/{tenant}__{date}   sequencing — one doc per day, no version in the id
//   plan_proposals_daily/{tenant}__{date}    assignment — one doc per day, no version in the id
// Only plan_version_rollups/{tenant}__{version} is keyed by version, and it holds one
// whole-window total per version, not the days. So the old version's day-by-day numbers
// exist nowhere once the re-score has run. Chad wants to see whether the new version moves
// his numbers; this file is the "before" half of that comparison, and
// engine-replay-compare.mjs is the other half.
//
// WHAT IT READS — Firestore REST GETs only, every list field-masked to the numbers:
//   route_proposals_daily, plan_proposals_daily   one read per stored day
//   plan_version_rollups                          one read per engine version
//   history_days (the manifests, not the stops)   one read per captured day — capture time
//                                                 and checksum, so the compare can tell a day
//                                                 whose history was captured again
//   routing_engine_config/{tenant}                one read — the stored tuning overrides
//   plan_replay_cursor/{tenant}                   one read — where the plan replay stopped
// It never writes Firestore, never calls a Netlify function and never calls NuVizz: the
// only host it talks to is firestore.googleapis.com, and every request is a GET (tested).
//
//   node scripts/engine-replay-snapshot.mjs --out engine-before.json
//       [--bundle <built js>]      where to find the public web key (default: dist/assets/*.js)
//       [--key <key>] [--project <id>] [--database "(default)"] [--tenant davis]
//       [--overwrite]              replace an existing --out file (refused by default: the
//                                  "before" file cannot be taken again once the re-score ran)
//
// The web key is the PUBLIC Firebase key the app itself ships in its bundle (the same
// apiKey/projectId pair src/lib/firebase.js is built with); it grants what the Firestore
// rules allow an anonymous reader and nothing more. A local build made without the Firebase
// env has no key in it — then pass --bundle with a saved copy of the live bundle, or --key.
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const SNAPSHOT_KIND = 'engine-replay-snapshot';
export const SNAPSHOT_SCHEMA = 1;
export const FIRESTORE_HOST = 'firestore.googleapis.com';
const PAGE_SIZE = 300;
const REQUEST_TIMEOUT_MS = 30_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Every field the two daily writers store (routing-engine-core.mts runShadowForDate;
// routing-plan-core.mts runPlanForDate) and the version-rollup shape (PlanVersionRollup).
// A doc written by older code simply lacks a newer field; the mask returns what exists.
export const SEQUENCE_FIELDS = [
  'tenant', 'date', 'engine_version', 'computed_at',
  'routes_scored', 'routes_skipped', 'unguided_count',
  'mean_score', 'median_score', 'mean_score_guided', 'median_score_guided', 'mean_score_unguided',
  'mean_seq_dev_guided', 'mean_erp_per_edit_guided', 'mean_travel_delta_min',
];
export const PLAN_FIELDS = [
  'tenant', 'date', 'engine_version', 'computed_at',
  'drivers', 'trips_engine', 'trips_actual', 'planned_stops', 'unassigned_count',
  'stop_agreement_pct', 'coload_agreement_pct', 'coload_precision_pct',
  'stop_agreement_known_pct', 'stop_agreement_fallback_pct', 'candidate_containment_pct',
  'est_travel_engine_min', 'est_travel_actual_min', 'matched_load_sequence_score', 'tie_margin',
];
export const ROLLUP_FIELDS = [
  'tenant', 'engine_version', 'days_scored', 'planned_stops_total', 'window_from', 'window_to',
  'stop_agreement_wmean', 'stop_agreement_known_wmean', 'coload_agreement_wmean',
  'trips_engine_total', 'trips_actual_total', 'trips_delta_pct',
  'travel_engine_total', 'travel_actual_total', 'travel_delta_pct', 'computed_at',
];
// The manifest fields that say WHEN a day's history was captured and WHAT it holds
// (history-seal.mts finalizeCaptureSeal / writeTombstone). A re-capture or a heal writes a
// new captured_at, so a day captured after its old score was computed is detectable.
export const MANIFEST_FIELDS = ['captured_at', 'capture_version', 'checksum', 'no_board', 'healed', 'verified', 'complete'];

// ── Firestore REST value codec (read side only) ─────────────────────────────────────────
// A number that is not finite (a stored NaN comes back as doubleValue "NaN") is recorded as
// null — missing, never 0: Number(null) is 0 and 0 is finite, which is exactly the trap.
export function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue === true;
  if ('integerValue' in v) { const n = Number(v.integerValue); return Number.isFinite(n) ? n : null; }
  if ('doubleValue' in v) { const n = Number(v.doubleValue); return Number.isFinite(n) ? n : null; }
  if ('timestampValue' in v) return String(v.timestampValue);
  if ('stringValue' in v) return String(v.stringValue);
  if ('mapValue' in v) return decodeFields(v.mapValue?.fields || {});
  if ('arrayValue' in v) return (v.arrayValue?.values || []).map(decodeValue);
  if ('referenceValue' in v) return String(v.referenceValue);
  if ('geoPointValue' in v) return { lat: v.geoPointValue?.latitude ?? null, lng: v.geoPointValue?.longitude ?? null };
  if ('bytesValue' in v) return String(v.bytesValue);
  return null;
}
export function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}
function docId(doc) {
  const parts = String(doc?.name || '').split('/');
  return parts[parts.length - 1] || '';
}

// ── the ONLY way this script talks to the network ───────────────────────────────────────
// GET, no body, Firestore's host, the documents tree of the named database. Anything else is
// refused before it is sent, so a future edit cannot turn the snapshot into a writer.
export function makeReader({ fetchImpl, key, project, database }) {
  if (!key) throw new Error('no Firestore web key');
  if (!project) throw new Error('no Firebase project id');
  const base = `https://${FIRESTORE_HOST}/v1/projects/${project}/databases/${database}/documents`;
  let reads = 0;
  const get = async (path, params = []) => {
    const url = new URL(`${base}/${path}`);
    for (const [k, v] of params) url.searchParams.append(k, v);
    url.searchParams.set('key', key);
    if (url.host !== FIRESTORE_HOST || !url.pathname.startsWith(`/v1/projects/${project}/databases/`)) {
      throw new Error(`refusing a request outside Firestore's documents tree: ${url.host}${url.pathname}`);
    }
    let resp;
    try {
      resp = await fetchImpl(url.toString(), { method: 'GET', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      throw new Error(`Firestore did not answer the read of ${path} (${e?.name === 'TimeoutError' ? `no answer in ${REQUEST_TIMEOUT_MS / 1000}s` : e?.message || e})`);
    }
    return resp;
  };
  const failure = async (what, resp) => {
    const body = await resp.text().catch(() => '');
    const hint = resp.status === 403 || resp.status === 401
      ? ' — the Firestore rules refused an anonymous read with this key; nothing was saved'
      : '';
    return new Error(`reading ${what} failed: HTTP ${resp.status}${hint}. ${body.slice(0, 200)}`);
  };
  return {
    get reads() { return reads; },
    /** Every document of a top-level collection (all pages), field-masked. */
    async list(collection, mask) {
      const docs = [];
      let pageToken = null;
      do {
        const params = [['pageSize', String(PAGE_SIZE)], ...mask.map((f) => ['mask.fieldPaths', f])];
        if (pageToken) params.push(['pageToken', pageToken]);
        const resp = await get(collection, params);
        if (!resp.ok) throw await failure(collection, resp);
        const body = await resp.json();
        const page = Array.isArray(body?.documents) ? body.documents : [];
        // Firestore bills a list that returns nothing as one read; count it that way.
        reads += Math.max(1, page.length);
        for (const d of page) docs.push({ _id: docId(d), ...decodeFields(d.fields) });
        pageToken = body?.nextPageToken || null;
      } while (pageToken);
      return docs;
    },
    /** One document, or null when it does not exist. */
    async getDoc(path) {
      const resp = await get(path);
      reads += 1;
      if (resp.status === 404) return null;
      if (!resp.ok) throw await failure(path, resp);
      const body = await resp.json();
      return { _id: docId(body), ...decodeFields(body?.fields) };
    },
  };
}

// {tenant}__{date} docs → { date: doc }, this tenant only (the same id shape the writers use).
export function byDate(docs, tenant) {
  const out = {};
  const prefix = `${tenant}__`;
  for (const d of docs || []) {
    const id = String(d?._id || '');
    if (!id.startsWith(prefix)) continue;
    const date = id.slice(prefix.length);
    if (!DATE_RE.test(date)) continue;
    const { _id, ...rest } = d;
    out[date] = rest;
  }
  return out;
}
function byVersion(docs, tenant) {
  const out = {};
  const prefix = `${tenant}__`;
  for (const d of docs || []) {
    const id = String(d?._id || '');
    if (!id.startsWith(prefix)) continue;
    const { _id, ...rest } = d;
    out[String(rest.engine_version || id.slice(prefix.length))] = rest;
  }
  return out;
}
function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

/** Read everything the compare needs. Throws on the first failed read — no partial snapshot. */
export async function takeSnapshot({ fetchImpl = globalThis.fetch, key, project, database = '(default)', tenant = 'davis', now = () => new Date() } = {}) {
  const r = makeReader({ fetchImpl, key, project, database });
  const sequenceDocs = await r.list('route_proposals_daily', SEQUENCE_FIELDS);
  const planDocs = await r.list('plan_proposals_daily', PLAN_FIELDS);
  const rollupDocs = await r.list('plan_version_rollups', ROLLUP_FIELDS);
  const manifestDocs = await r.list('history_days', MANIFEST_FIELDS);
  const engineConfig = await r.getDoc(`routing_engine_config/${tenant}`);
  const cursor = await r.getDoc(`plan_replay_cursor/${tenant}`);
  const strip = (d) => { if (!d) return null; const { _id, ...rest } = d; return rest; };
  return {
    kind: SNAPSHOT_KIND,
    schema: SNAPSHOT_SCHEMA,
    taken_at: now().toISOString(),
    project, database, tenant,
    reads: r.reads,
    sequence: sortKeys(byDate(sequenceDocs, tenant)),
    plan: sortKeys(byDate(planDocs, tenant)),
    version_rollups: byVersion(rollupDocs, tenant),
    manifests: sortKeys(byDate(manifestDocs, tenant)),
    engine_config_stored: strip(engineConfig),
    plan_replay_cursor: strip(cursor),
  };
}

// ── the public web key, from a built bundle ────────────────────────────────────────────
// The Firebase web config is one object literal in the bundle: apiKey first, projectId a
// few fields later, before the literal closes. The Maps key is a different literal with no
// projectId in it, so "the apiKey whose OWN object carries a projectId" is the Firebase one.
// (Looking a fixed distance ahead instead reached across into the next literal — a test
// with the Maps key sitting just in front of the Firebase config caught it.)
export function webConfigFromBundle(text) {
  const src = String(text || '');
  const re = /apiKey:"([A-Za-z0-9_-]{20,})"/g;
  let m;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index, m.index + 600);
    const close = rest.indexOf('}');
    const ownObject = close >= 0 ? rest.slice(0, close) : rest;
    const p = /projectId:"([a-z0-9-]+)"/.exec(ownObject);
    if (p) return { key: m[1], project: p[1] };
  }
  return null;
}
export function findBundleConfig(distAssetsDir, readDir = readdirSync, readFile = readFileSync) {
  let names = [];
  try { names = readDir(distAssetsDir).filter((n) => n.endsWith('.js')).sort(); } catch { return null; }
  for (const n of names) {
    const cfg = webConfigFromBundle(readFile(join(distAssetsDir, n), 'utf8'));
    if (cfg) return { ...cfg, from: join(distAssetsDir, n) };
  }
  return null;
}

export function parseArgs(argv) {
  const out = { database: '(default)', tenant: 'davis', overwrite: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); return v; };
    if (a === '--out') out.out = val();
    else if (a === '--bundle') out.bundle = val();
    else if (a === '--key') out.key = val();
    else if (a === '--project') out.project = val();
    else if (a === '--database') out.database = val();
    else if (a === '--tenant') out.tenant = val();
    else if (a === '--overwrite') out.overwrite = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.out) throw new Error('--out <file.json> is required');
  if (!/^[a-z0-9_-]{1,40}$/i.test(out.tenant)) throw new Error(`bad --tenant: ${out.tenant}`);
  return out;
}

/** A plain-English line per table: how many days, at which versions, over which dates. */
export function describeSnapshot(s) {
  const tally = (days) => {
    const by = {};
    for (const d of Object.values(days || {})) { const v = String(d?.engine_version ?? '(none)'); by[v] = (by[v] || 0) + 1; }
    return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ×${n}`).join(', ') || 'none';
  };
  const span = (days) => { const k = Object.keys(days || {}).sort(); return k.length ? `${k[0]} … ${k[k.length - 1]}` : '—'; };
  const cursor = s.plan_replay_cursor;
  return [
    `  sequencing days (route_proposals_daily): ${Object.keys(s.sequence).length} — ${tally(s.sequence)} — ${span(s.sequence)}`,
    `  assignment days (plan_proposals_daily):  ${Object.keys(s.plan).length} — ${tally(s.plan)} — ${span(s.plan)}`,
    `  version cards (plan_version_rollups):    ${Object.keys(s.version_rollups).sort().join(', ') || 'none'}`,
    `  captured history days (history_days):    ${Object.keys(s.manifests).length} — ${span(s.manifests)}`,
    `  plan replay cursor:                      ${cursor ? `stopped_at ${cursor.stopped_at ?? 'none (window finished)'}, engine ${cursor.engine_version ?? '?'}` : 'no cursor doc'}`,
    `  Firestore reads used: ${s.reads}`,
  ].join('\n');
}

/** The CLI, with its I/O injectable so the refusal rules are testable without a disk or a network. */
export async function runCli(argv, deps = {}) {
  const {
    fetchImpl = globalThis.fetch, out = console.log, err = console.error,
    exists = existsSync, writeFile = writeFileSync, rename = renameSync, readFile = readFileSync,
    readDir = readdirSync, cwd = process.cwd(), now = () => new Date(),
    distAssets = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets'),
  } = deps;
  let args;
  try { args = parseArgs(argv); } catch (e) { err(`✗ ${e.message}`); return 2; }
  const target = resolve(cwd, args.out);
  // The BEFORE file is the only copy of the old version's day-by-day numbers once the
  // re-score runs. Taking the AFTER snapshot into the same name by mistake would erase it.
  if (exists(target) && !args.overwrite) {
    err(`✗ ${target} already exists — refusing to replace it (it may be the only copy of the old numbers). Pick another --out, or pass --overwrite.`);
    return 2;
  }
  let key = args.key, project = args.project, keyFrom = args.key ? '--key' : null;
  if (!key) {
    let cfg = null;
    if (args.bundle) {
      try { cfg = webConfigFromBundle(readFile(resolve(cwd, args.bundle), 'utf8')); } catch (e) { err(`✗ cannot read --bundle ${args.bundle}: ${e.message}`); return 2; }
      if (cfg) cfg.from = args.bundle;
    } else {
      cfg = findBundleConfig(distAssets, readDir, readFile);
    }
    if (!cfg) {
      err(`✗ no Firebase web key found in ${args.bundle || distAssets} — build with the Firebase env, pass --bundle <a saved copy of the live bundle>, or pass --key and --project.`);
      return 2;
    }
    key = cfg.key; project = project || cfg.project; keyFrom = cfg.from;
  }
  if (!project) { err('✗ no project id — pass --project'); return 2; }
  let snap;
  try {
    snap = await takeSnapshot({ fetchImpl, key, project, database: args.database, tenant: args.tenant, now });
  } catch (e) {
    err(`✗ ${e.message}`);
    err('  Nothing was written.');
    return 1;
  }
  const tmp = `${target}.tmp`;
  writeFile(tmp, JSON.stringify(snap, null, 1) + '\n');
  rename(tmp, target);
  out(`engine replay snapshot → ${target}`);
  out(`  taken ${snap.taken_at}, project ${project}, database ${args.database}, tenant ${args.tenant}, key from ${keyFrom}`);
  out(describeSnapshot(snap));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
