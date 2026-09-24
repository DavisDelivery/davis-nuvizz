// lib/uat-mirror-refresh.mts — LOAD PRODUCTION'S DAYS INTO THE UAT MIRROR, FROM FIRESTORE ALONE.
//
// Chad, 2026-09-20: "I want to use firestore to load up all our stops so I can test there
// without doing anything in nuvizz or nuvizz uat. I want to see how the routes it builds see if
// I like them or not from day to day. We can do this all without a single nuvizz call just
// using our uat and firestore data."
//
// WHAT THIS IS. The mirror deploy never scans and never writes NuVizz (lib/mirror-guard.mts),
// so its own database holds nothing a routing engine could plan from. Production's database
// holds everything: the live board for today and the next business days (nuvizz_stop_index),
// the day's load roster with the driver NuVizz already has on each load (nuvizz_load_roster),
// every sealed day back to June (history_days), the customer notes with receiving hours, the
// employees roster, the truck profiles, the calibrated travel curve, the departure table and
// the miss ledger. This module copies a window of all of that into the mirror, then re-runs
// the same post-seal miners the nightly capture runs (lib/history-postseal.mts) over each
// copied day so the mirror's learned collections (routing_reference_routes, driver days,
// service times, customer habits, tractor paint, customer rollups) are rebuilt from the copy.
// After one run the UAT board shows production's stops for the day, and the engine on the UAT
// site plans from the same history production's engine does — with ZERO NuVizz calls, because
// nothing here talks to anything but Firestore.
//
// WHY THE BENCH IS NOT ENOUGH. The UAT test bench (uat-seed.mts) picks a handful of orders and
// CREATES them in the UAT NuVizz tenant, which costs a call per order and is exactly what Chad
// does not want here. This copies rows; it creates nothing anywhere.
//
// PURE CORE, THIN EDGES. Every read and write goes through the injected deps so the whole
// thing is unit-tested against fakes; the endpoint (uat-mirror-refresh-background.mts) is the
// only place real I/O is wired. The production side is read through lib/prod-mirror-read.mts,
// which has no writer by construction; the mirror side is written through lib/firestore.mts,
// which targets the named database this deploy runs on. Nothing in this file can address
// production's database for a write, because nothing it is handed can.
//
// ORDER MATTERS. Static collections first (the miners read the employees roster and the
// engine config), then sealed days ascending (each day's miners fold onto the days before
// it, the way the nightly does), then the board days. Chunked to the background budget with a
// progress document as the cursor, so a run that runs out of time resumes where it stopped.
//
// A DAY ALREADY MIRRORED IS NOT COPIED AGAIN (v1.58.1). The nightly window moves a day every
// night, so its label — and with it the progress cursor — is new every night. v1.50.0 keyed the
// resume on that label alone, so every night restarted all 90 days and the 09-23 run got through
// 47 of them before the budget; the mirror would never have reached September or the board. The
// unit that does not move is the sealed day: production stamps it once (history-seal.mts:
// captured_at, capture_version, a content checksum) and only a heal or a re-capture changes
// that. So a date whose mirror manifest carries production's current stamps, at the same
// leanness, mined after it was copied, is skipped — whatever window or run it was copied in.
// ?recopy=1 copies every day anyway.
//
// HISTORY IS COPIED LEAN BY DEFAULT: the per-stop `raw` payload (the vendor's whole record)
// is most of the bytes and nothing the engine or its miners read (they consume the normalized
// fields and the `executed` stamps the capture already lifted out). The board days keep
// `raw`, because the Map's order popups read it. ?lean=0 keeps it on history too.

import { dayPath, HISTORY_COLLECTION } from './history-store.mts';

export const PROGRESS_COLLECTION = 'uat_mirror_refresh';
export const BOARD_COLLECTION = 'nuvizz_stop_index';
export const ROSTER_COLLECTION = 'nuvizz_load_roster';
export const LEDGER_COLLECTION = 'eta_miss_ledger';
export const STATIC_COLLECTIONS = [
  'customer_notes', 'employees', 'truck_profiles', 'travel_calibration',
  'route_departures', 'tractor_locations', 'routing_engine_config',
] as const;

export const DEFAULT_HORIZON_DAYS = 3;     // today + 3 calendar days of board (covers the next 2 business days over a weekend)
export const DEFAULT_HISTORY_DAYS = 90;    // sealed days copied when no window is given
export const TIME_BUDGET_MS = 12 * 60 * 1000;   // headroom under Netlify's 15-minute background cap
export const WRITE_CONCURRENCY = 12;

export function progressPath(tenant: string): string {
  return `${PROGRESS_COLLECTION}/${String(tenant || '').trim().toLowerCase()}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PURE: YYYY-MM-DD plus n calendar days (noon-UTC anchored, DST-proof). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface RefreshPlan {
  tenant: string;
  today: string;
  board: boolean;
  history: boolean;
  static: boolean;
  remine: boolean;
  lean: boolean;
  recopy: boolean;           // copy every sealed day even when the mirror already holds it unchanged
  boardDates: string[];      // ascending, today first
  historyFrom: string;       // inclusive
  historyTo: string;         // inclusive
}

export interface PlanOptions {
  tenant?: string;
  today: string;
  from?: string | null;
  to?: string | null;
  horizonDays?: number | null;
  historyDays?: number | null;
  board?: boolean;
  history?: boolean;
  static?: boolean;
  remine?: boolean;
  lean?: boolean;
  recopy?: boolean;
}

/**
 * PURE: what a run will copy. Defaults reproduce the nightly's shape — yesterday's sealed day
 * is the newest history date (today is not sealed yet), the board window is today plus the
 * horizon, and everything is on. A malformed date is an error, never a silently widened run.
 */
export function planRefresh(opts: PlanOptions): RefreshPlan {
  const today = String(opts.today || '');
  if (!DATE_RE.test(today)) throw new Error(`planRefresh: bad today '${opts.today}'`);
  for (const [k, v] of [['from', opts.from], ['to', opts.to]] as const) {
    if (v != null && v !== '' && !DATE_RE.test(String(v))) throw new Error(`planRefresh: bad ${k} '${v}' (YYYY-MM-DD)`);
  }
  const horizon = Math.max(0, Math.min(14, Number.isFinite(Number(opts.horizonDays)) && opts.horizonDays != null ? Number(opts.horizonDays) : DEFAULT_HORIZON_DAYS));
  const historyDays = Math.max(1, Math.min(400, Number.isFinite(Number(opts.historyDays)) && opts.historyDays != null ? Number(opts.historyDays) : DEFAULT_HISTORY_DAYS));
  const historyTo = opts.to && DATE_RE.test(String(opts.to)) ? String(opts.to) : addDays(today, -1);
  const historyFrom = opts.from && DATE_RE.test(String(opts.from)) ? String(opts.from) : addDays(historyTo, -(historyDays - 1));
  if (historyFrom > historyTo) throw new Error(`planRefresh: from ${historyFrom} is after to ${historyTo}`);
  const boardDates: string[] = [];
  for (let i = 0; i <= horizon; i++) boardDates.push(addDays(today, i));
  return {
    tenant: String(opts.tenant || 'davis').trim().toLowerCase(),
    today,
    board: opts.board !== false,
    history: opts.history !== false,
    static: opts.static !== false,
    remine: opts.remine !== false,
    lean: opts.lean !== false,
    recopy: opts.recopy === true,
    boardDates,
    historyFrom,
    historyTo,
  };
}

/** PURE: on/off words for the query overrides. Unset or malformed = on (house shape). */
export function onOff(v: any): boolean {
  return !/^(0|false|off|no)$/i.test(String(v ?? '').trim());
}

export interface RefreshDeps {
  /** production side — read only (lib/prod-mirror-read.mts) */
  listProd: (collectionPath: string, opts?: { mask?: string[] }) => Promise<any[]>;
  getProd: (docPath: string) => Promise<any | null>;
  /** mirror side (lib/firestore.mts on a deploy whose FIRESTORE_DATABASE is named) */
  setDoc: (path: string, data: any) => Promise<boolean>;
  listMirror: (collectionPath: string, opts?: { mask?: string[] }) => Promise<any[]>;
  getMirror: (docPath: string) => Promise<any | null>;
  /** the post-seal miners, run over a copied day's stop records (history-postseal.runPostSealHooks) */
  remine?: (tenant: string, date: string, stopRecords: any[]) => Promise<any>;
  /** persist progress after each unit of work (crash-safe resume) */
  persist?: (progress: RefreshProgress) => Promise<void>;
  now?: () => number;
  nowIso?: () => string;
  log?: (line: string) => void;
}

/** PURE: a row as read (with _id) → the document to write (without it). */
export function stripId(row: any): any {
  const { _id, ...rest } = row || {};
  return rest;
}
/** PURE: a history stop without the vendor's raw payload. */
export function leanStop(row: any): any {
  const { raw, ...rest } = row || {};
  return rest;
}

async function writeAll(deps: RefreshDeps, items: Array<{ path: string; data: any }>, conc = WRITE_CONCURRENCY): Promise<number> {
  let i = 0, written = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      await deps.setDoc(it.path, it.data);
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, worker));
  return written;
}

/** Dates production holds a sealed manifest for, within [from, to], ascending. Tombstoned days included (they copy as an empty day). */
export async function prodHistoryDates(deps: RefreshDeps, tenant: string, from: string, to: string): Promise<string[]> {
  const manifests = await deps.listProd(HISTORY_COLLECTION, { mask: ['date', 'no_board'] });
  const prefix = `${tenant}__`;
  return manifests
    .map((m: any) => String(m?._id || ''))
    .filter((id) => id.startsWith(prefix))
    .map((id) => id.slice(prefix.length))
    .filter((d) => DATE_RE.test(d) && d >= from && d <= to)
    .sort();
}

export interface StaticCounts { [collection: string]: number }

/** Copy every document of each static collection, id for id. */
export async function copyStatic(deps: RefreshDeps, tenant: string, collections: readonly string[] = STATIC_COLLECTIONS): Promise<StaticCounts> {
  const counts: StaticCounts = {};
  for (const c of collections) {
    const rows = await deps.listProd(c);
    const items = rows.map((r: any) => ({ path: `${c}/${r._id}`, data: stripId(r) }));
    counts[c] = await writeAll(deps, items);
    deps.log?.(`[mirror-refresh] ${c}: ${counts[c]} document(s)`);
  }
  void tenant;
  return counts;
}

export interface HistoryDayCopy {
  date: string;
  manifest: boolean;
  stops: number;
  routes: number;
  drivers: number;
  stopRecords: any[];   // what was written — handed to the miners
}

/** Copy one sealed day: manifest, stops, routes, drivers. Lean strips `raw` off each stop. */
export async function copyHistoryDay(deps: RefreshDeps, tenant: string, date: string, opts: { lean?: boolean; nowIso?: string } = {}): Promise<HistoryDayCopy> {
  const base = dayPath(tenant, date);
  const manifest = await deps.getProd(base);
  if (!manifest) return { date, manifest: false, stops: 0, routes: 0, drivers: 0, stopRecords: [] };
  const [stops, routes, drivers] = await Promise.all([
    deps.listProd(`${base}/stops`),
    deps.listProd(`${base}/routes`),
    deps.listProd(`${base}/drivers`),
  ]);
  const lean = opts.lean !== false;
  const stopRecords = stops.map((s: any) => (lean ? leanStop(stripId(s)) : stripId(s)));
  const nowIso = opts.nowIso || deps.nowIso?.() || new Date().toISOString();
  // The manifest is written LAST so a half-copied day never reads as a sealed one on this side.
  const stopItems = stops.map((s: any, i: number) => ({ path: `${base}/stops/${s._id}`, data: stopRecords[i] }));
  const routeItems = routes.map((r: any) => ({ path: `${base}/routes/${r._id}`, data: stripId(r) }));
  const driverItems = drivers.map((r: any) => ({ path: `${base}/drivers/${r._id}`, data: stripId(r) }));
  const nStops = await writeAll(deps, stopItems);
  const nRoutes = await writeAll(deps, routeItems);
  const nDrivers = await writeAll(deps, driverItems);
  await deps.setDoc(base, { ...manifest, mirrored_from: '(default)', mirrored_at: nowIso, mirrored_lean: lean, mirrored_stops: nStops });
  deps.log?.(`[mirror-refresh] history ${date}: ${nStops} stop(s), ${nRoutes} route(s), ${nDrivers} driver(s)${lean ? ' (lean)' : ''}`);
  return { date, manifest: true, stops: nStops, routes: nRoutes, drivers: nDrivers, stopRecords };
}

/** The manifest fields production changes when it re-seals a day (history-seal.mts). */
export const MANIFEST_FINGERPRINT_FIELDS = ['captured_at', 'capture_version', 'checksum', 'healed_at', 'no_board', 'counts'] as const;

function stableJson(v: any): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** PURE: a manifest's seal stamps as one string, independent of key order. */
export function manifestFingerprint(m: any): string {
  const picked: Record<string, any> = {};
  for (const f of MANIFEST_FINGERPRINT_FIELDS) if (m && m[f] !== undefined) picked[f] = m[f];
  return stableJson(picked);
}

/**
 * PURE: does the mirror already hold production's CURRENT copy of this sealed day, fully
 * mined? Any doubt answers no — a needless re-copy costs minutes, a wrong skip leaves a stale
 * or unmined day on the mirror that nothing would ever revisit.
 */
export function mirroredDayIsCurrent(
  prodManifest: any, mirrorManifest: any, opts: { lean: boolean; remine: boolean },
): { current: boolean; why: string } {
  if (!prodManifest) return { current: false, why: 'production holds no manifest for it' };
  if (!mirrorManifest) return { current: false, why: 'not on the mirror' };
  if (mirrorManifest.mirrored_from !== '(default)' || !mirrorManifest.mirrored_at) {
    return { current: false, why: 'the mirror copy was not made by this refresh' };
  }
  if (manifestFingerprint(prodManifest) !== manifestFingerprint(mirrorManifest)) {
    return { current: false, why: 'production re-sealed it after it was copied' };
  }
  if (Boolean(mirrorManifest.mirrored_lean) !== Boolean(opts.lean)) {
    return { current: false, why: 'copied at a different leanness' };
  }
  // The miners never run on a day with no stops (runRefresh), so there is nothing to wait for.
  // A copy made before mirrored_stops existed must show its mining stamp either way.
  const empty = mirrorManifest.mirrored_stops === 0 || !!prodManifest.no_board;
  if (opts.remine && !empty) {
    const mined = mirrorManifest.post_seal_at && String(mirrorManifest.post_seal_at) >= String(mirrorManifest.mirrored_at);
    if (!mined) return { current: false, why: 'copied but not mined afterwards' };
  }
  return { current: true, why: 'unchanged in production since it was copied' };
}

export interface BoardDayCopy { date: string; parent: boolean; stops: number }

/** Copy one board day: the parent meta doc as production has it, plus every stop row, raw and all. */
export async function copyBoardDay(deps: RefreshDeps, tenant: string, date: string, opts: { nowIso?: string } = {}): Promise<BoardDayCopy> {
  const base = `${BOARD_COLLECTION}/${tenant}__${date}`;
  const [parent, stops] = await Promise.all([deps.getProd(base), deps.listProd(`${base}/stops`)]);
  if (!parent && !stops.length) return { date, parent: false, stops: 0 };
  const items = stops.map((s: any) => ({ path: `${base}/stops/${s._id}`, data: stripId(s) }));
  const nStops = await writeAll(deps, items);
  if (parent) {
    const nowIso = opts.nowIso || deps.nowIso?.() || new Date().toISOString();
    await deps.setDoc(base, { ...parent, mirrored_from: '(default)', mirrored_at: nowIso });
  }
  deps.log?.(`[mirror-refresh] board ${date}: ${nStops} stop(s)${parent ? '' : ' (no parent meta in production)'}`);
  return { date, parent: !!parent, stops: nStops };
}

/** Copy one day's load roster document (name, number, id, status, driver, trips per load). */
export async function copyRosterDay(deps: RefreshDeps, tenant: string, date: string): Promise<boolean> {
  const path = `${ROSTER_COLLECTION}/${tenant}__${date}`;
  const doc = await deps.getProd(path);
  if (!doc) return false;
  await deps.setDoc(path, doc);
  return true;
}

/** Copy one day's miss-ledger document (the per-stop delivery-outcome label). */
export async function copyLedgerDay(deps: RefreshDeps, tenant: string, date: string): Promise<boolean> {
  const path = `${LEDGER_COLLECTION}/${tenant}__${date}`;
  const doc = await deps.getProd(path);
  if (!doc) return false;
  await deps.setDoc(path, doc);
  return true;
}

export interface RefreshProgress {
  tenant: string;
  label: string;                     // identifies the window; a different window starts a fresh run
  plan: RefreshPlan;
  done: { static: boolean; history: string[]; board: string[] };
  counts: {
    static: StaticCounts | null;
    history: Record<string, { stops: number; routes: number; drivers: number; roster: boolean; ledger: boolean; remined: boolean; skipped?: boolean }>;
    board: Record<string, { stops: number; parent: boolean; roster: boolean }>;
  };
  history_dates_in_prod: string[];   // the dates the window resolved to, so a resume plans the same set
  started_at: string;
  updated_at: string;
  finished: boolean;
  stopped_at: string | null;         // the next pending date when the budget ran out
  nuvizz_calls: 0;                   // stated, because it is the whole point
  log: string[];
}

/** PURE: the label a plan's window gets — same window, same label, so a resume finds its run. */
export function planLabel(plan: RefreshPlan): string {
  return [
    plan.history ? `h:${plan.historyFrom}..${plan.historyTo}` : 'h:-',
    plan.board ? `b:${plan.boardDates[0]}..${plan.boardDates[plan.boardDates.length - 1]}` : 'b:-',
    plan.static ? 's' : '-', plan.remine ? 'r' : '-', plan.lean ? 'l' : '-',
    // appended only when set, so a plain run's label reads exactly as it did before v1.58.1
    ...(plan.recopy ? ['R'] : []),
  ].join('|');
}

export function freshProgress(plan: RefreshPlan, nowIso: string): RefreshProgress {
  return {
    tenant: plan.tenant, label: planLabel(plan), plan,
    done: { static: false, history: [], board: [] },
    counts: { static: null, history: {}, board: {} },
    history_dates_in_prod: [],
    started_at: nowIso, updated_at: nowIso, finished: false, stopped_at: null,
    nuvizz_calls: 0, log: [],
  };
}

/**
 * Run (or resume) a refresh under a time budget. Static → sealed days ascending → board days.
 * Returns the progress; the caller persists it (and `deps.persist`, when given, is called after
 * every unit so a killed invocation loses at most one day).
 */
export async function runRefresh(
  deps: RefreshDeps, plan: RefreshPlan, prior: RefreshProgress | null,
  opts: { budgetMs?: number } = {},
): Promise<RefreshProgress> {
  const now = deps.now || (() => Date.now());
  const nowIso = () => (deps.nowIso ? deps.nowIso() : new Date().toISOString());
  const budget = opts.budgetMs ?? TIME_BUDGET_MS;
  const t0 = now();
  const over = () => now() - t0 > budget;
  const label = planLabel(plan);
  const p: RefreshProgress = prior && prior.label === label && !prior.finished
    ? { ...prior, done: { static: !!prior.done?.static, history: [...(prior.done?.history || [])], board: [...(prior.done?.board || [])] }, log: [...(prior.log || [])] }
    : freshProgress(plan, nowIso());
  const say = (line: string) => { p.log.push(line); deps.log?.(line); };
  const persist = async () => { p.updated_at = nowIso(); if (deps.persist) await deps.persist(p); };
  const maxLog = 200;

  // 1. static collections (the miners read employees + engine config; do these first)
  if (plan.static && !p.done.static) {
    p.counts.static = await copyStatic(deps, plan.tenant);
    p.done.static = true;
    say(`static: ${Object.entries(p.counts.static).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    await persist();
  }

  // 2. sealed days, ascending — the set is resolved ONCE per run and remembered, so a resume
  //    copies the same dates even if production sealed another day in between.
  if (plan.history) {
    if (!p.history_dates_in_prod.length) {
      p.history_dates_in_prod = await prodHistoryDates(deps, plan.tenant, plan.historyFrom, plan.historyTo);
      say(`history: production holds ${p.history_dates_in_prod.length} sealed day(s) in ${plan.historyFrom}..${plan.historyTo}`);
      await persist();
    }
    for (const date of p.history_dates_in_prod) {
      if (p.done.history.includes(date)) continue;
      if (over()) { p.stopped_at = date; p.finished = false; await persist(); return trimLog(p, maxLog); }
      if (!plan.recopy) {
        const base = dayPath(plan.tenant, date);
        const [pm, mm] = await Promise.all([deps.getProd(base), deps.getMirror(base)]);
        if (mirroredDayIsCurrent(pm, mm, { lean: plan.lean, remine: plan.remine }).current) {
          // Stops, routes and drivers are already there and mined. The roster and the miss
          // ledger are re-copied anyway: eta-miss-ledger-background writes yesterday's ledger at
          // 08:00 UTC, after this job's 06:45 run, so a day copied the morning after it sealed
          // only picks its ledger up on a later pass — this one.
          const roster = await copyRosterDay(deps, plan.tenant, date);
          const ledger = await copyLedgerDay(deps, plan.tenant, date);
          p.counts.history[date] = {
            stops: Number(mm?.mirrored_stops ?? mm?.counts?.stops ?? 0),
            routes: Number(mm?.counts?.routes ?? 0), drivers: Number(mm?.counts?.drivers ?? 0),
            roster, ledger, remined: false, skipped: true,
          };
          p.done.history.push(date);
          say(`history ${date}: already mirrored, unchanged in production${ledger ? ', ledger' : ''}`);
          await persist();
          continue;
        }
      }
      const copy = await copyHistoryDay(deps, plan.tenant, date, { lean: plan.lean, nowIso: nowIso() });
      const roster = await copyRosterDay(deps, plan.tenant, date);
      const ledger = await copyLedgerDay(deps, plan.tenant, date);
      let remined = false;
      if (plan.remine && deps.remine && copy.manifest && copy.stopRecords.length) {
        await deps.remine(plan.tenant, date, copy.stopRecords);
        remined = true;
      }
      p.counts.history[date] = { stops: copy.stops, routes: copy.routes, drivers: copy.drivers, roster, ledger, remined };
      p.done.history.push(date);
      say(`history ${date}: ${copy.stops} stops${roster ? ', roster' : ''}${ledger ? ', ledger' : ''}${remined ? ', remined' : ''}`);
      await persist();
    }
  }

  // 3. board days: today and the horizon, raw and all
  if (plan.board) {
    for (const date of plan.boardDates) {
      if (p.done.board.includes(date)) continue;
      if (over()) { p.stopped_at = date; p.finished = false; await persist(); return trimLog(p, maxLog); }
      const copy = await copyBoardDay(deps, plan.tenant, date, { nowIso: nowIso() });
      const roster = await copyRosterDay(deps, plan.tenant, date);
      p.counts.board[date] = { stops: copy.stops, parent: copy.parent, roster };
      p.done.board.push(date);
      say(`board ${date}: ${copy.stops} stops${roster ? ', roster' : ''}`);
      await persist();
    }
  }

  p.finished = true;
  p.stopped_at = null;
  await persist();
  return trimLog(p, maxLog);
}

function trimLog(p: RefreshProgress, max: number): RefreshProgress {
  if (p.log.length > max) p.log = p.log.slice(p.log.length - max);
  return p;
}

export interface ExplainRow { date: string; prod: { manifest: boolean; stops: number }; mirror: { manifest: boolean; stops: number } }
export interface ExplainResult {
  plan: RefreshPlan;
  history: ExplainRow[];
  board: ExplainRow[];
  static: Record<string, { prod: number; mirror: number }>;
  nuvizz_calls: 0;
  writes: 0;
}

/**
 * What a run WOULD copy, against what the mirror already holds — reads both sides, writes
 * nothing. Bounded to the plan's window; the caller bounds the window.
 */
export async function explainRefresh(deps: RefreshDeps, plan: RefreshPlan): Promise<ExplainResult> {
  const mask = ['stopNbr'];
  const countBoth = async (base: string): Promise<{ prod: { manifest: boolean; stops: number }; mirror: { manifest: boolean; stops: number } }> => {
    const [pm, ps, mm, ms] = await Promise.all([
      deps.getProd(base), deps.listProd(`${base}/stops`, { mask }),
      deps.getMirror(base), deps.listMirror(`${base}/stops`, { mask }),
    ]);
    return { prod: { manifest: !!pm, stops: ps.length }, mirror: { manifest: !!mm, stops: ms.length } };
  };
  const history: ExplainRow[] = [];
  if (plan.history) {
    for (const date of await prodHistoryDates(deps, plan.tenant, plan.historyFrom, plan.historyTo)) {
      history.push({ date, ...(await countBoth(dayPath(plan.tenant, date))) });
    }
  }
  const board: ExplainRow[] = [];
  if (plan.board) {
    for (const date of plan.boardDates) {
      board.push({ date, ...(await countBoth(`${BOARD_COLLECTION}/${plan.tenant}__${date}`)) });
    }
  }
  const statics: Record<string, { prod: number; mirror: number }> = {};
  if (plan.static) {
    for (const c of STATIC_COLLECTIONS) {
      const [p, m] = await Promise.all([deps.listProd(c, { mask: ['tenant'] }), deps.listMirror(c, { mask: ['tenant'] })]);
      statics[c] = { prod: p.length, mirror: m.length };
    }
  }
  return { plan, history, board, static: statics, nuvizz_calls: 0, writes: 0 };
}
