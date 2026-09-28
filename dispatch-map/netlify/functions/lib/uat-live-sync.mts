// lib/uat-live-sync.mts — PRODUCTION'S CHANGES REACH THE UAT MIRROR ON THEIR OWN, EVERY FEW MINUTES.
//
// Chad, 2026-09-26: "uat is supposed to be 1 for 1 copy of production … my loads are missing
// this is not a match to production like its supposed to be any update i make to production
// should automatically be here as well but any change to uat should not automatically go to
// production without explicit approval."
//
// WHAT WAS WRONG, MEASURED — not inferred. The mirror learned about production ONCE A DAY: the
// 06:45 UTC refresh (uat-mirror-refresh-background.mts). Its progress document on the UAT site
// read `started_at 2026-09-26T06:45:18Z … finished`, and at 8:48 PM ET that evening:
//
//   production  nuvizz_load_roster/davis__2026-09-28   90 loads, 51 with a driver, captured 00:30Z
//   UAT mirror  nuvizz_load_roster/davis__2026-09-28    0 loads — production's FRIDAY capture
//                                                        (2026-09-25T16:15Z), copied that morning
//
// Monday's loads were created in production on Saturday evening and the mirror would not look
// again until Sunday 06:45 UTC. Every other thing production changed during the day — the
// board, the hours and flags on customer notes, a Shiplify import — waited the same way.
//
// WHAT THIS DOES. Every tick (uat-mirror-sync-background.mts, every 10 minutes) it walks a FIXED
// list of production-owned documents and collections (planUnits, below), and copies into the
// mirror exactly the documents PRODUCTION has changed since the last tick. "Changed" is
// Firestore's own updateTime, read through lib/prod-mirror-read.mts (GET only, (default) only,
// mirror only) — so the test is a fact the database keeps, not a field some writer may forget
// to stamp.
//
// ONE WAY, AND WHICH WAY IS STRUCTURAL:
//   • Production → mirror: the only production access is prod-mirror-read, which has no writer.
//   • Mirror → production: nothing. Every write goes through the deps the endpoint hands in —
//     lib/firestore.mts on a deploy whose FIRESTORE_DATABASE is named — and the endpoint refuses
//     before anything else unless isMirrorDeploy(). There is no path here that can address
//     production's database for a write, because nothing this module is given can.
//
// A CHANGE MADE ON UAT STAYS ON UAT UNTIL PRODUCTION CHANGES THAT SAME DOCUMENT. That is the
// rule "production wins" read literally, and it is why the test is production's updateTime and
// not a comparison of the two copies: a comparison would put back every UAT test edit on the
// next tick, which would make UAT useless for testing. Say it plainly in the handover — a
// receiving-hours edit made on UAT is overwritten the moment somebody edits that customer in
// production, and the 06:45 refresh still re-copies the static collections wholesale every
// morning, as it always has.
//
// DELETIONS. A document production deleted is deleted on the mirror only if THIS SYNC put it
// there (it is in the unit's `seen` map), so nothing UAT created on its own is ever removed.
// Board-day stops get one more rule, on the first tick that sees a day: the mirror's stops that
// production no longer holds are removed unless they are the UAT bench's own orders. That is the
// nightly refresh's own rule since v1.81.3 (uat-mirror-refresh.mts boardRowsToPrune — a UT-
// number or the bench's uatSeed provenance), called here rather than restated, so the two jobs
// that copy the board cannot disagree about which rows are UAT's. On a mirror nothing else creates
// board stops — the mirror never scans (lib/mirror-guard.mts) — so any other stop there is a stale
// copy of production's.
//
// ZERO NuVizz calls, by construction: this file and its endpoint import nothing from any
// nuvizz-* module (test/uat-live-sync.test.mjs pins it against the source).
//
// UAT_LIVE_SYNC=off PUTS IT BACK: the tick exits at its first line and the mirror's roster reads
// behave exactly as before (nuvizz-loads-roster.mts). Default on; only an off-word turns it off;
// a malformed value leaves it on — a typo must never silently stop a mirror matching production.

import { isMirrorDeploy } from './mirror-guard.mts';
import { prodMirrorReadEnabled, type ProdStamp } from './prod-mirror-read.mts';
import { isBatchId, IMPORTS_COLLECTION, LOCATIONS_COLLECTION, INDEX_COLLECTION, SHIPLIFY_TENANT } from './shiplify-store.mts';
import { BOARD_COLLECTION, ROSTER_COLLECTION, boardRowsToPrune } from './uat-mirror-refresh.mts';

export const SYNC_COLLECTION = 'uat_mirror_sync';
export const SYNC_HORIZON_DAYS = 3;                 // today + 3, the nightly's board window (uat-mirror-refresh.mts)
export const SYNC_BUDGET_MS = 12 * 60 * 1000;       // headroom under the 15-minute background cap
export const SYNC_LEASE_MS = 14 * 60 * 1000;        // a tick older than this is presumed dead
export const SYNC_CONCURRENCY = 12;
export const SYNC_SCHEDULE = '*/10 * * * *';

const OFF = /^(0|false|off|no)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PURE. Does this deploy run the live sync? A mirror that reads production, unless switched off. */
export function liveSyncEnabled(env: Record<string, any> = process.env): boolean {
  if (!isMirrorDeploy(env) || !prodMirrorReadEnabled(env)) return false;
  return !OFF.test(String(env.UAT_LIVE_SYNC ?? '').trim());
}

/** PURE. YYYY-MM-DD plus n calendar days (noon-UTC anchored, DST-proof). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── WHAT IS COPIED ───────────────────────────────────────────────────────────────────────────
//
// An ALLOW-list, on purpose. A deny-list ("everything but …") would carry the next collection
// anybody adds straight onto UAT — including the ones that must never cross: app_users and
// driver_auth (credentials), nuvizz_secrets, nuvizz_ops (switches and mailer state). Each unit
// below is here because a screen on the board reads it, and the reader is named beside it.
//
// NOT HERE, and why:
//   routing_routes, routing_jobs, routing_load_vehicles, dispatch_presence,
//   bottom_panel_profiles, claude_shadow_*, uat_*   — UAT's OWN working state; copying
//                                                      production's would erase the tests.
//   history_days, eta_miss_ledger, tractor_locations — change once a night in production (the
//                                                      seal and its miners); the 06:45 refresh
//                                                      already copies them after that.
//   sms_messages, nuvizz_ops/*                        — not copied today. One line below each if
//                                                      Chad wants them.
//   shiplify_raw                                      — the uploaded file's rows; only the import
//                                                      processor reads them, and only for its
//                                                      own batch.

export type SyncUnit =
  | { kind: 'doc'; key: string; path: string; stampMirror?: boolean }
  | { kind: 'collection'; key: string; path: string; prune: 'copied' | 'board' }
  | { kind: 'shiplify'; key: string };

export const STATIC_SYNC_COLLECTIONS = [
  // the map's flags, restriction marks, receiving hours and moved pins (App.jsx useCustomerNotes)
  'customer_notes',
  // the Build panel's truck classes and the engine's inputs — the nightly's static set
  'employees', 'truck_profiles', 'routing_engine_config', 'route_departures', 'travel_calibration',
] as const;

/**
 * PURE. The units one tick walks, in order. Loads first (what Chad found missing), then the
 * board — stops BEFORE their day's meta document, the order production writes them in
 * (firestore.mts writeStops writes the meta last) — then the singletons the board's carry-over
 * fold reads, then the notes and statics, then Shiplify.
 */
export function planUnits(today: string, opts: { tenant?: string; horizonDays?: number } = {}): SyncUnit[] {
  if (!DATE_RE.test(String(today || ''))) throw new Error(`planUnits: bad today '${today}'`);
  const t = String(opts.tenant || 'davis').trim().toLowerCase();
  const horizon = Math.max(0, Math.min(14, Number.isFinite(Number(opts.horizonDays)) && opts.horizonDays != null ? Number(opts.horizonDays) : SYNC_HORIZON_DAYS));
  const dates = Array.from({ length: horizon + 1 }, (_, i) => addDays(today, i));
  const units: SyncUnit[] = [];
  // nuvizz-loads-roster.mts — the Loads tab, the bottom grid's Loads view, plan-onto
  for (const d of dates) units.push({ kind: 'doc', key: `roster__${d}`, path: `${ROSTER_COLLECTION}/${t}__${d}` });
  // nuvizz-pull-today-stops.mts — the board itself
  for (const d of dates) {
    units.push({ kind: 'collection', key: `board__${d}__stops`, path: `${BOARD_COLLECTION}/${t}__${d}/stops`, prune: 'board' });
    units.push({ kind: 'doc', key: `board__${d}`, path: `${BOARD_COLLECTION}/${t}__${d}`, stampMirror: true });
  }
  // nuvizz-pull-today-stops.mts mergeCarryover — the open-order pool (chunks before the head,
  // which is how readActivePool's integrity check expects to find them), the unplanned
  // snapshot, and the rows proven finished
  units.push({ kind: 'collection', key: 'active_pool__chunks', path: `nuvizz_active_pool/${t}/chunks`, prune: 'copied' });
  units.push({ kind: 'doc', key: 'active_pool', path: `nuvizz_active_pool/${t}` });
  units.push({ kind: 'doc', key: 'active_set', path: `nuvizz_active_set/${t}` });
  units.push({ kind: 'doc', key: 'carryover_retired', path: `nuvizz_carryover_retired/${t}` });
  // dispatcher-set board dates ("customer said not until the 30th") — nuvizz-stop-explain.mts
  units.push({ kind: 'doc', key: 'board_dates', path: `nuvizz_board_dates/${t}` });
  // the NuVizz driver list the pickers read — nuvizz-driver-roster.mts (its everyday read)
  units.push({ kind: 'doc', key: 'driver_roster', path: `nuvizzRoster/${t}` });
  for (const c of STATIC_SYNC_COLLECTIONS) units.push({ kind: 'collection', key: c, path: c, prune: 'copied' });
  // App.jsx fetchShiplifyIndexOnce — the Shiplify pins, the stop panel's Shiplify line
  units.push({ kind: 'shiplify', key: 'shiplify' });
  return units;
}

// ── STATE ────────────────────────────────────────────────────────────────────────────────────

/** The run document: the lease and the last tick's report. */
export function runPath(tenant: string): string {
  return `${SYNC_COLLECTION}/${String(tenant || '').trim().toLowerCase()}`;
}
/** One state document per unit. Keys are built in planUnits from safe characters only. */
export function unitStatePath(tenant: string, key: string): string {
  return `${SYNC_COLLECTION}/${String(tenant || '').trim().toLowerCase()}__${key}`;
}

export interface UnitState {
  key: string;
  path: string;
  /** collection units: document id → production updateTime of the copy this sync made */
  seenJson?: string;
  /** doc units and shiplify: production updateTime of the copy this sync made */
  prodUpdateTime?: string | null;
  /** shiplify: the production index generation last copied (reported; the change key is prodUpdateTime) */
  generation?: string | null;
  updated_at: string;
}

/** PURE. The seen map out of a state document; a corrupt one reads as empty (a full re-copy). */
export function readSeen(state: UnitState | null | undefined): Record<string, string> {
  if (!state?.seenJson) return {};
  try {
    const m = JSON.parse(state.seenJson);
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch { return {}; }
}

/**
 * PURE. What a collection unit has to do: which production documents changed since this sync
 * last copied them, and which mirror documents to remove.
 *
 * `mirrorRows` ({ _id, stopNbr, uatSeed }) is only consulted for a 'board' unit on its FIRST tick
 * (no state yet) — see the header for why a non-bench stop on a mirror's board is by construction
 * a copy of production's, and for why the rule is the nightly's boardRowsToPrune.
 */
export function diffCollection(
  prod: ProdStamp[],
  seen: Record<string, string>,
  opts: { prune: 'copied' | 'board'; firstTick: boolean; mirrorRows?: any[] },
): { changed: ProdStamp[]; removed: string[] } {
  const prodIds = new Set(prod.map((p) => p._id));
  const changed = prod.filter((p) => seen[p._id] !== p.updateTime);
  const gone = new Set(Object.keys(seen).filter((id) => !prodIds.has(id)));
  if (opts.prune === 'board' && opts.firstTick) {
    for (const r of boardRowsToPrune(prod, opts.mirrorRows || [])) gone.add(String(r._id));
  }
  return { changed, removed: [...gone].sort() };
}

// ── THE TICK ─────────────────────────────────────────────────────────────────────────────────

export interface SyncDeps {
  /** production — read only (lib/prod-mirror-read.mts) */
  listProdStamps: (collectionPath: string) => Promise<ProdStamp[]>;
  getProdStamped: (docPath: string) => Promise<{ data: any; updateTime: string } | null>;
  listProd: (collectionPath: string) => Promise<any[]>;
  /** the mirror (lib/firestore.mts on a deploy whose FIRESTORE_DATABASE is named) */
  getMirror: (docPath: string) => Promise<any | null>;
  setMirror: (docPath: string, data: any) => Promise<unknown>;
  deleteMirror: (docPath: string) => Promise<unknown>;
  /** the mirror's rows of a board day's stops, masked to what boardRowsToPrune reads */
  listMirrorRows: (collectionPath: string) => Promise<any[]>;
  now?: () => number;
  nowIso?: () => string;
  log?: (line: string) => void;
}

export interface UnitReport {
  key: string;
  path: string;
  changed: number;        // production documents newer than this sync's copy
  copied: number;         // written to the mirror (0 on a dry run)
  removed: number;        // deleted from the mirror (0 on a dry run)
  wouldRemove?: string[]; // dry run: up to 20 of the ids a real tick would remove
  note?: string;
  error?: string;
}

export interface SyncReport {
  tenant: string;
  today: string;
  dry: boolean;
  started_at: string;
  finished_at: string;
  finished: boolean;          // every unit was reached inside the budget
  deferred: string[];         // units the budget did not reach — the next tick starts with them
  units: UnitReport[];
  totals: { changed: number; copied: number; removed: number; errors: number };
  nuvizz_calls: 0;
}

async function pool<T>(items: T[], conc: number, fn: (it: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const it = items[i++]; await fn(it); } };
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, worker));
}

const stripId = (row: any) => { const { _id, ...rest } = row || {}; return rest; };

async function syncDocUnit(deps: SyncDeps, tenant: string, u: Extract<SyncUnit, { kind: 'doc' }>, dry: boolean, nowIso: string): Promise<UnitReport> {
  const statePath = unitStatePath(tenant, u.key);
  const [prod, state] = await Promise.all([deps.getProdStamped(u.path), deps.getMirror(statePath) as Promise<UnitState | null>]);
  const rep: UnitReport = { key: u.key, path: u.path, changed: 0, copied: 0, removed: 0 };
  if (!prod) {
    // Gone in production. Remove it here only if this sync is what put it here.
    if (!state?.prodUpdateTime) { rep.note = 'production holds no such document'; return rep; }
    if (dry) { rep.wouldRemove = [u.path]; rep.note = 'production deleted it'; return rep; }
    await deps.deleteMirror(u.path);
    await deps.setMirror(statePath, { key: u.key, path: u.path, prodUpdateTime: null, updated_at: nowIso } as UnitState);
    rep.removed = 1;
    return rep;
  }
  if (state?.prodUpdateTime === prod.updateTime) return rep;
  rep.changed = 1;
  if (dry) return rep;
  const data = u.stampMirror ? { ...prod.data, mirrored_from: '(default)', mirrored_at: nowIso } : prod.data;
  await deps.setMirror(u.path, data);
  await deps.setMirror(statePath, { key: u.key, path: u.path, prodUpdateTime: prod.updateTime, updated_at: nowIso } as UnitState);
  rep.copied = 1;
  return rep;
}

async function syncCollectionUnit(deps: SyncDeps, tenant: string, u: Extract<SyncUnit, { kind: 'collection' }>, dry: boolean, nowIso: string): Promise<UnitReport> {
  const statePath = unitStatePath(tenant, u.key);
  const [prod, state] = await Promise.all([deps.listProdStamps(u.path), deps.getMirror(statePath) as Promise<UnitState | null>]);
  const seen = readSeen(state);
  const firstTick = !state;
  const mirrorRows = u.prune === 'board' && firstTick ? await deps.listMirrorRows(u.path) : undefined;
  const { changed, removed } = diffCollection(prod, seen, { prune: u.prune, firstTick, mirrorRows });
  const rep: UnitReport = { key: u.key, path: u.path, changed: changed.length, copied: 0, removed: 0 };
  if (dry) {
    if (removed.length) rep.wouldRemove = removed.slice(0, 20);
    rep.removed = 0;
    if (firstTick) rep.note = 'first tick for this unit — every production document counts as changed';
    return rep;
  }
  const next = { ...seen };
  let copied = 0;
  await pool(changed, SYNC_CONCURRENCY, async (p) => {
    const got = await deps.getProdStamped(`${u.path}/${p._id}`);
    if (!got) { delete next[p._id]; return; }   // deleted between the listing and the read
    await deps.setMirror(`${u.path}/${p._id}`, got.data);
    next[p._id] = got.updateTime || p.updateTime;
    copied++;
  });
  let nRemoved = 0;
  await pool(removed, SYNC_CONCURRENCY, async (id) => {
    await deps.deleteMirror(`${u.path}/${id}`);
    delete next[id];
    nRemoved++;
  });
  // Written even when nothing changed on a first tick, so the bootstrap prune runs once per unit.
  if (copied || nRemoved || firstTick) {
    await deps.setMirror(statePath, { key: u.key, path: u.path, seenJson: JSON.stringify(next), updated_at: nowIso } as UnitState);
  }
  rep.copied = copied;
  rep.removed = nRemoved;
  return rep;
}

/**
 * Shiplify is one IMPORT, not a stream of edits: production rewrites the whole index under a new
 * `generation` each time a file is processed (lib/shiplify-store.mts). So the unit reads the head
 * document alone — one read a tick — and copies only when the generation moved: the locations,
 * then the index chunks, then the head LAST, so a browser reading mid-copy sees the old head
 * (whose chunks are still there) and never a head pointing at chunks that have not arrived.
 * The import logs cross too, so the import screen says what production's says; the run lease and
 * its takeover tombstones do not (isBatchId), because a production lease on UAT would refuse a
 * UAT import for fifteen minutes.
 */
async function syncShiplifyUnit(deps: SyncDeps, tenant: string, u: Extract<SyncUnit, { kind: 'shiplify' }>, dry: boolean, nowIso: string): Promise<UnitReport> {
  const headPath = `${INDEX_COLLECTION}/${SHIPLIFY_TENANT}`;
  const statePath = unitStatePath(tenant, u.key);
  const [head, state] = await Promise.all([deps.getProdStamped(headPath), deps.getMirror(statePath) as Promise<UnitState | null>]);
  const rep: UnitReport = { key: u.key, path: headPath, changed: 0, copied: 0, removed: 0 };
  if (!head) { rep.note = 'nothing has been imported in production'; return rep; }
  // Keyed on the head's updateTime, which every document has — not on `generation`, which a
  // malformed head could lack and which would then re-copy thousands of documents every tick.
  const generation = String(head.data?.generation ?? '');
  if (state?.prodUpdateTime === head.updateTime) return rep;
  if (dry) { rep.changed = 1; rep.note = `production index generation ${generation || '(none)'}; mirror ${state?.generation || '(none)'}`; return rep; }
  const locations = await deps.listProd(LOCATIONS_COLLECTION);
  const index = await deps.listProd(INDEX_COLLECTION);
  const logs = (await deps.listProd(IMPORTS_COLLECTION)).filter((r: any) => isBatchId(String(r?._id || '')));
  const chunks = index.filter((r: any) => String(r?._id || '') !== SHIPLIFY_TENANT);
  let copied = 0;
  for (const [coll, rows] of [[LOCATIONS_COLLECTION, locations], [INDEX_COLLECTION, chunks], [IMPORTS_COLLECTION, logs]] as const) {
    await pool(rows as any[], SYNC_CONCURRENCY, async (r) => { await deps.setMirror(`${coll}/${r._id}`, stripId(r)); copied++; });
  }
  await deps.setMirror(headPath, head.data);
  copied++;
  await deps.setMirror(statePath, { key: u.key, path: headPath, prodUpdateTime: head.updateTime, generation, updated_at: nowIso } as UnitState);
  rep.changed = 1;
  rep.copied = copied;
  rep.note = `generation ${generation}: ${locations.length} location(s), ${chunks.length} index chunk(s), ${logs.length} import log(s)`;
  return rep;
}

/**
 * One tick. Walks the units in order under a time budget; a unit that throws is REPORTED (its
 * error on its row, counted in totals.errors) and the tick goes on to the next — one unreadable
 * collection must not stop the loads from arriving. Units the budget did not reach are named in
 * `deferred`; they carry no state change, so the next tick simply does them.
 */
export async function runSync(
  deps: SyncDeps,
  units: SyncUnit[],
  opts: { tenant?: string; today: string; dry?: boolean; budgetMs?: number },
): Promise<SyncReport> {
  const tenant = String(opts.tenant || 'davis').trim().toLowerCase();
  const now = deps.now || (() => Date.now());
  const iso = () => (deps.nowIso ? deps.nowIso() : new Date().toISOString());
  const dry = opts.dry === true;
  const budget = opts.budgetMs ?? SYNC_BUDGET_MS;
  const t0 = now();
  const started = iso();
  const out: UnitReport[] = [];
  const deferred: string[] = [];
  for (const u of units) {
    if (now() - t0 > budget) { deferred.push(u.key); continue; }
    try {
      const at = iso();
      const rep = u.kind === 'doc' ? await syncDocUnit(deps, tenant, u, dry, at)
        : u.kind === 'collection' ? await syncCollectionUnit(deps, tenant, u, dry, at)
          : await syncShiplifyUnit(deps, tenant, u, dry, at);
      out.push(rep);
      if (rep.copied || rep.removed) deps.log?.(`[uat-live-sync] ${rep.key}: ${rep.copied} copied, ${rep.removed} removed`);
    } catch (e: any) {
      const path = u.kind === 'shiplify' ? `${INDEX_COLLECTION}/${SHIPLIFY_TENANT}` : u.path;
      out.push({ key: u.key, path, changed: 0, copied: 0, removed: 0, error: String(e?.message || e).slice(0, 300) });
      deps.log?.(`[uat-live-sync] ${u.key} FAILED: ${e?.message || e}`);
    }
  }
  const totals = out.reduce((a, r) => ({
    changed: a.changed + r.changed, copied: a.copied + r.copied, removed: a.removed + r.removed, errors: a.errors + (r.error ? 1 : 0),
  }), { changed: 0, copied: 0, removed: 0, errors: 0 });
  return {
    tenant, today: opts.today, dry, started_at: started, finished_at: iso(),
    finished: deferred.length === 0, deferred, units: out, totals, nuvizz_calls: 0,
  };
}

/** PURE. Is a tick already running? A lease older than SYNC_LEASE_MS is presumed dead. */
export function leaseHeld(run: any, nowMs: number): boolean {
  const since = Date.parse(String(run?.running_since || ''));
  return Number.isFinite(since) && nowMs - since < SYNC_LEASE_MS;
}
