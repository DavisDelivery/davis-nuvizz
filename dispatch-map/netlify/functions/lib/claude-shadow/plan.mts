// lib/claude-shadow/plan.mts — THE PLANNING AREA: ITS READS, ITS QUEUE ENTRY, ITS RESULTS (v1.76.0).
//
// Reads, all from Firestore (0 NuVizz calls — the board is what the scans already wrote):
//   nuvizz_stop_index/davis__{date} (+ /stops)     the board day, with the Map's own field projection
//   the same for each look-back day                 the carry-over candidates
//   nuvizz_active_pool, nuvizz_active_set,          the judges the Map's carry-over fold uses
//   nuvizz_carryover_retired
//   nuvizz_load_roster/davis__{date}                the day's loads (names, drivers) for the picker
//   claude_shadow_learned/davis__capacity           the learned caps (every sealed day to date)
//   the capacity settings, employees, customer_notes, routing_engine_config — as a backtest reads them
// Writes only through store.mts (claude_shadow_*): the job (claude_shadow_jobs, kind 'plan') and the
// result (claude_shadow_plans/{job id}). The model is run by the backtest worker, under the same
// 24-hour ceiling, Stop button and resume rules.
import { readStops as fsReadStops, readActivePool as fsReadActivePool, readActiveUnplannedSet as fsReadActiveSet, readCarryoverRetired as fsReadRetired } from '../firestore.mts';
import { LEAN_STOP_FIELDS } from '../board-fields.mts';
import { carryPriorDates } from '../carryover-fold.mts';
import { boardRowsAsServed } from '../board-rows.mts';
import { effectiveEngineConfig, engineConfigPath } from '../routing-engine-config.mts';
import { DEPOT } from '../routing-types.mts';
import { employeeClassMap, CLASS_OVERRIDE } from '../driver-class.mts';
import {
  validatePlanParams, validateStopsParams, selectPlanStops, buildPlanProblem, planCapacity, planResultFrom, rowMatchKey, rowRouteKey, locateRow, keptProblemsDetail, isFinishedRow,
  placementsOf, leftOffOf, pickIdentity, sectionDriverConflicts,
  MAX_PLAN_STOPS, PLAN_TENANT, PLAN_LOOKBACK_BOUNDS, PLAN_SCOPES, MAX_PLAN_LOADS, PLAN_ID_RE, type PlanParams, type EarlierPlacement,
} from './plan-core.mts';
import { backtestMapPayload, classKey, capFor, toBtStop, type BtProblem } from './backtest-core.mts';
import { rosterLoadsOf, CAPACITY_PATH, keyOf } from './learn-core.mts';
import { readSettings } from './settings.mts';
import { ceilingsInForce, withOverrides } from './settings-core.mts';
import { hardCapsEnabled, shadowModel } from './config.mts';
import { loosePerSkidFrom } from './learn.mts';
import { noPlanReason, type LoopState } from './plan-loop.mts';

export const PLANS_COLLECTION = 'claude_shadow_plans';
export const planResultPath = (id: string) => `${PLANS_COLLECTION}/${id}`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The board reads, injectable (tests pass a fake); the live ones are the Map's own readers. */
export interface BoardReads {
  readStops: (tenant: string, date: string, opts?: { mask?: string[] }) => Promise<{ meta: any; stops: any[] }>;
  readActivePool: (tenant: string) => Promise<any>;
  readActiveUnplannedSet: (tenant: string) => Promise<any>;
  readCarryoverRetired: (tenant: string) => Promise<Record<string, string>>;
}
export const LIVE_BOARD_READS: BoardReads = {
  readStops: fsReadStops as any, readActivePool: fsReadActivePool, readActiveUnplannedSet: fsReadActiveSet, readCarryoverRetired: fsReadRetired,
};

export interface PlanDeps {
  getDoc: (path: string) => Promise<any | null>;
  listDocs: (path: string, opts?: { mask?: string[] }) => Promise<any[]>;
  shadowSet: (path: string, data: Record<string, any>) => Promise<boolean>;
  shadowPatch: (path: string, data: Record<string, any>) => Promise<boolean>;
  shadowCreate: (path: string, data: Record<string, any>) => Promise<boolean>;
  now: () => Date;
  env: Record<string, any>;
  board?: BoardReads;
}

async function inPool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

const EMPLOYEE_MASK = ['vehicleType', 'externalIds', 'fullName', 'firstName', 'lastName', 'aliases'];

/**
 * THE BOARD A PLAN READS, and everything it is judged with — one read, shared by a plan, its preview and
 * the stop map (v1.78.0), so the map shows exactly the stops a plan of the same settings would see.
 */
async function readBoard(params: { date: string; lookbackDays: number }, deps: PlanDeps) {
  const board = deps.board ?? LIVE_BOARD_READS;
  const date = params.date;
  // A learned model not yet on file plans at the profile caps; one that could not be READ is not that
  // (audit 2026-09-27) — readPlanDay refuses on it. The stop map reads the same board and does not need it.
  let modelError: string | null = null;
  const [day, rosterDoc, settings, employees, engineDoc, model] = await Promise.all([
    board.readStops(PLAN_TENANT, date, { mask: LEAN_STOP_FIELDS }),
    deps.getDoc(`nuvizz_load_roster/${PLAN_TENANT}__${date}`).catch(() => null),
    readSettings({ getDoc: deps.getDoc, listDocs: deps.listDocs } as any),
    // Every driver's truck class comes from this roster; read as empty, every tractor would be planned
    // as a box truck held to the box ceiling. So a failed read refuses the plan, as it does a backtest.
    deps.listDocs('employees', { mask: EMPLOYEE_MASK })
      .catch((e: any) => { throw new Error(`the employees roster could not be read, so no truck class is known: ${String(e?.message || e)}`); }),
    deps.getDoc(engineConfigPath(PLAN_TENANT)).catch(() => null),
    deps.getDoc(CAPACITY_PATH).catch((e: any) => { modelError = String(e?.message || e); return null; }),
  ]);
  if (!day?.meta && !(day?.stops || []).length) throw new Error(`there is no board on file for ${date}: the scans have not written that day yet`);
  if (settings.error) throw new Error(`the capacity settings could not be read: ${settings.error}`);
  let fold: any = null;
  if (params.lookbackDays > 0) {
    const prior = carryPriorDates(date, params.lookbackDays);
    const [live, retired, pool, reads] = await Promise.all([
      board.readActiveUnplannedSet(PLAN_TENANT).catch(() => null),
      board.readCarryoverRetired(PLAN_TENANT).catch(() => ({} as Record<string, string>)),
      board.readActivePool(PLAN_TENANT).catch(() => null),
      Promise.all(prior.map((d) => board.readStops(PLAN_TENANT, d, { mask: LEAN_STOP_FIELDS }).then((r) => ({ d, stops: r.stops || [] })).catch(() => ({ d, stops: [] as any[] })))),
    ]);
    // The Map compares its judges against the served board's own orders-scan stamp; so does this.
    fold = { reads, live, retired, pool, nowMs: () => deps.now().getTime(), lastUnplannedScanAt: day?.meta?.lastUnplannedScanAt ?? null };
  }
  // The Map's three steps, in its order (lib/board-rows.mts): prior-day finished out, carry-over in, cancelled out.
  const { rows, carry, cancelled } = boardRowsAsServed(day?.stops || [], date, fold, deps.env);
  // THE NOTES FIRST (review): a saved corrected pin (location_override) is where the Map draws a stop,
  // and it can give a stop with no feed geocode a place — so it is read before stops are chosen.
  const open = rows.filter((r) => String(r?.stopType ?? '').toUpperCase() !== 'PU' && !isFinishedRow(r));
  const keys = [...new Set(open.map(rowMatchKey).filter((k: any) => typeof k === 'string' && /^[\w\- .&']{1,200}$/.test(k)))];
  const noteList = await inPool(keys, 8, async (k: string) => [k, await deps.getDoc(`customer_notes/${k}`).catch(() => null)] as const);
  const notes = new Map(noteList.filter(([, n]) => n) as [string, any][]);
  return { day, rosterDoc, settings, employees, engineDoc, model, modelError, rows, carry, cancelled, notes, boardAt: day?.meta?.last_scanned_at ?? null };
}

/**
 * WHAT THE EARLIER SECTIONS PLACED (v1.78.0), from the finished plan a section builds on. Throws with a
 * plain reason when it cannot be built on: not finished, another day, made before sections existed — or
 * asked of with a different "which stops" or a shorter look-back (review): the chain is read against this
 * plan's board, and a shorter look-back would read the earlier section's carried-over orders as gone.
 */
async function readEarlier(after: string | null, params: { date: string; lookbackDays: number; scope: string }, deps: PlanDeps): Promise<{ map: Map<string, EarlierPlacement>; leftOff: Map<string, string>; at: string | null } | null> {
  if (!after) return null;
  const r = await deps.getDoc(planResultPath(after));
  if (!r) throw new Error('the plan this section builds on has no result yet — preview again once it is done, or press Start fresh');
  if (r.date !== params.date) throw new Error(`the plan this section builds on is of ${r.date}, not ${params.date}`);
  const map = placementsOf(r);
  if (!map) throw new Error('the plan this section builds on was made before sections existed and does not say where its stops went — press Start fresh');
  const was = r.params || {};
  if (typeof was.scope === 'string' && was.scope !== params.scope) throw new Error(`the plan this section builds on planned ${was.scope === 'open' ? 'every open stop' : 'unplanned stops only'}; a section keeps the same choice as the plan it builds on — change it back, or press Start fresh`);
  if (Number.isInteger(was.lookbackDays) && params.lookbackDays < was.lookbackDays) throw new Error(`the plan this section builds on looked back ${was.lookbackDays} day${was.lookbackDays === 1 ? '' : 's'}; this section must look back at least as far, or the orders it carried over would read as gone — set the look-back to ${was.lookbackDays} or more, or press Start fresh`);
  return { map, leftOff: leftOffOf(r), at: r.at ?? null };
}

/**
 * Everything one plan is built from. Throws with a plain reason when it cannot be built. `rs` is the
 * router settings in force (the cap rule and the weight limits).
 */
export async function readPlanDay(params: PlanParams, rs: { capRule: any; lbsBox: number; lbsTractor: number }, deps: PlanDeps): Promise<{ problem: BtProblem; cfg: any; carry: any; boardAt: string | null }> {
  const date = params.date;
  const [b, earlier] = await Promise.all([readBoard(params, deps), readEarlier(params.after, params, deps)]);
  const { rosterDoc, settings, employees, engineDoc, model, rows, carry, cancelled, notes } = b;
  if (b.modelError) throw new Error(`the learned capacity model could not be read, so every driver would be planned at the truck-profile cap: ${b.modelError}`);
  // A ROSTER LOAD IS ITS LOAD NUMBER (review, v1.78.0): picks can come back from an earlier section, so
  // a load renamed in NuVizz since is planned under its name now — the board's rows carry that name.
  const byNbr = new Map((rosterLoadsOf(rosterDoc) || []).filter((l: any) => l?.loadNbr && typeof l?.name === 'string' && l.name.trim()).map((l: any) => [String(l.loadNbr), l]));
  params = { ...params, picks: params.picks.map((pk) => {
    const l: any = pk.kind === 'roster' && pk.loadNbr ? byNbr.get(pk.loadNbr) : null;
    if (!l) return pk;
    const driver = typeof l.driver === 'string' && l.driver.trim() ? l.driver.trim() : pk.driver;
    return { ...pk, route: l.name.trim(), driver };
  }) };
  // With 'unplanned only', stops already on a PICKED roster load stay on it and their room counts —
  // unless the roster has two loads under that name, when a board row cannot say which it rides.
  const keepOn = new Set(params.picks.filter((p) => p.kind === 'roster').map((p) => keyOf(p.route)));
  const rosterList = (rosterLoadsOf(rosterDoc) || []).filter((l: any) => !/cancel/i.test(String(l?.status ?? '')));
  const nameCount = new Map<string, number>();
  for (const l of rosterList) { const k = keyOf(l?.name); if (k) nameCount.set(k, (nameCount.get(k) || 0) + 1); }
  const ambiguous = new Set([...nameCount].filter(([, n]) => n > 1).map(([k]) => k));
  // SECTIONS (v1.78.0): the stops picked on the map, and which of this plan's loads an earlier section's
  // load is (the same identity). The first pick with an identity takes it.
  const pickOf = new Map<string, number>();
  params.picks.forEach((pk, i) => { const k = pickIdentity(pk); if (!pickOf.has(k)) pickOf.set(k, i); });
  const sel = selectPlanStops(rows, date, params.scope, cancelled, keepOn, (r) => locateRow(r, notes), ambiguous, {
    section: params.section ? new Set(params.section) : null, earlier: earlier?.map ?? null, pickOf,
  });
  const { chosen, noLocation, kept, keptNoLocation, counts } = sel;
  if (chosen.length > MAX_PLAN_STOPS) throw new Error(`${chosen.length} stops is more than one plan can hold (${MAX_PLAN_STOPS}) — narrow the look-back, plan unplanned stops only, or plan a smaller section`);
  // What the earlier sections left off and this one does not hold again: kept on the record (review).
  const inPlan = new Set(chosen.map((r: any) => String(r.stopNbr).trim()));
  const leftOffBefore = earlier ? [...earlier.leftOff].filter(([n]) => !inPlan.has(n)).map(([n, reason]) => ({ n, reason })) : [];
  const cfg = effectiveEngineConfig(engineDoc, deps.env);
  const c = ceilingsInForce(settings.settings);
  const problem = buildPlanProblem({
    params, chosen, noLocation, counts, carry, kept, keptNoLocation,
    pinTo: sel.pinTo, carried: sel.carried, earlierDropped: sel.earlierDropped, heldEarlier: sel.heldEarlier, leftOffBefore,
    roster: rosterLoadsOf(rosterDoc), employees, notes, model, caps: settings.caps,
    ceilings: { box_truck: c.box_truck, tractor: c.tractor }, hardCaps: hardCapsEnabled(deps.env),
    loosePerSkid: loosePerSkidFrom(settings.settings).value, capRule: rs.capRule,
    lbsLimits: { box_truck: rs.lbsBox, tractor: rs.lbsTractor },
    depot: { lat: DEPOT.lat, lng: DEPOT.lng }, cfg, at: deps.now().toISOString(),
    boardScannedAt: b.boardAt,
  });
  (problem as any).carry = carry;
  // Kept stops that already break a rule on their own load: no plan can pass, so none is paid for. The
  // way out depends on where the stops came from (review): NuVizz's, or an earlier section's.
  const bad = keptProblemsDetail(problem, cfg);
  const fromSection = bad.some((x) => x.section);
  const clash = sectionDriverConflicts(problem);
  const why: string[] = [];
  if (bad.length) why.push(`the stops already on these picked loads break a rule by themselves, so no plan can pass: ${bad.map((x) => x.text).join('; ')} — ${fromSection
    ? 'the earlier section’s stops there no longer fit (the board or the caps have changed since it was planned): press Start fresh, or unpick that load (its earlier stops are then carried forward as they were placed)'
    : 'unpick those loads, or plan every open stop instead'}`);
  if (clash.length) why.push(`a driver would be booked on two trucks across the sections: ${clash.join('; ')}`);
  (problem as any).infeasible = why.length ? why.join('. ') : null;
  return { problem, cfg, carry, boardAt: b.boardAt };
}

/** The most stops the map read sends: twice what one plan can hold. More is said (truncated), not dropped quietly. */
export const MAP_STOPS_MAX = MAX_PLAN_STOPS * 2;

/**
 * THE STOP MAP'S READ (v1.78.0, 0 model spend, 0 NuVizz): every open delivery on the board a plan of these
 * settings would read, with where it is and what it carries, so stops can be picked for a section. Each
 * says whether it is on a load in NuVizz and whether an earlier section placed it — the screen offers
 * only the ones a section may take.
 */
export async function planStops(raw: any, deps: PlanDeps) {
  const v = validateStopsParams(raw);
  if (!v.ok) return { status: 400, body: { ok: false, errors: v.errors } };
  const params = v.params!;
  let b, earlier;
  try { [b, earlier] = await Promise.all([readBoard(params, deps), readEarlier(params.after, params, deps)]); }
  catch (e: any) { return { status: 422, body: { ok: false, error: String(e?.message || e) } }; }
  const loosePerSkid = loosePerSkidFrom(b.settings.settings).value;
  const stops: any[] = [];
  let noLocation = 0, onLoad = 0, placed = 0, open = 0;
  const seen = new Set<string>();
  for (const r of b.rows) {
    const n = String(r?.stopNbr ?? '').trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (String(r.stopType ?? '').toUpperCase() === 'PU' || isFinishedRow(r)) continue;
    const at = locateRow(r, b.notes);
    if (!at) { noLocation++; continue; }
    open++;
    // A bound, said out loud (truncated below), never a silent one: more than a plan could hold twice over.
    if (stops.length >= MAP_STOPS_MAX) continue;
    const s = toBtStop({ ...r, lat: at.lat, lng: at.lng, customerMatchKey: rowMatchKey(r) }, stops.length + 1, n, loosePerSkid, b.notes);
    const load = r.isPlanned === true ? String(r.routeName || r.loadNbr || '').trim() || 'a load' : null;
    // NuVizz outranks an earlier section when planning unplanned stops only (review): a stop now on a
    // load in NuVizz is drawn as NuVizz's, as the plan treats it.
    const e = load && params.scope === 'unplanned' ? null : (earlier?.map.get(n) ?? null);
    const left = !e ? earlier?.leftOff.get(n) ?? null : null;
    if (load) onLoad++;
    if (e) placed++;
    stops.push({
      n, lat: Math.round(at.lat * 1e5) / 1e5, lng: Math.round(at.lng * 1e5) / 1e5,
      name: String(s.name ?? '').slice(0, 48), city: s.city ?? null, zip: s.zip ?? null,
      spots: s.spots, lbs: s.weight, noTractor: !!s.blocksTractor,
      day: r.carryover === true && typeof r.scheduledDate === 'string' ? r.scheduledDate : params.date,
      onLoad: load, earlier: e ? { route: e.route, driver: e.driver } : null, leftOff: left,
    });
  }
  return {
    status: 200,
    body: {
      ok: true, date: params.date, lookbackDays: params.lookbackDays, scope: params.scope, after: params.after,
      afterAt: earlier?.at ?? null, boardAt: b.boardAt, stops,
      counts: { open, noLocation, onLoad, placed }, truncated: open > stops.length,
      nuvizzCalls: 0,
    },
  };
}

/**
 * THE PICKER'S READ (0 model spend, 0 NuVizz): which days have a board, the chosen day's roster
 * loads, and every driver with the cap the plan would hold them to — so a pick shows its cap before
 * anything is run.
 */
export async function planOptions(date: string | null, rs: { capRule: any }, deps: PlanDeps) {
  const board = deps.board ?? LIVE_BOARD_READS;
  const [days, settings, employees, model] = await Promise.all([
    deps.listDocs('nuvizz_stop_index', { mask: ['date', 'count', 'unplannedCount', 'plannedCount', 'last_scanned_at'] }).catch(() => [] as any[]),
    readSettings({ getDoc: deps.getDoc, listDocs: deps.listDocs } as any),
    deps.listDocs('employees', { mask: EMPLOYEE_MASK }).catch(() => null as any[] | null),
    deps.getDoc(CAPACITY_PATH).catch(() => null),
  ]);
  const boardDays = (days || [])
    .filter((d: any) => typeof d?._id === 'string' && d._id.startsWith(`${PLAN_TENANT}__`) && DATE_RE.test(d._id.slice(PLAN_TENANT.length + 2)))
    .map((d: any) => ({ date: d._id.slice(PLAN_TENANT.length + 2), count: d.count ?? null, unplanned: d.unplannedCount ?? null, planned: d.plannedCount ?? null, scannedAt: d.last_scanned_at ?? null }))
    .sort((a: any, b: any) => b.date.localeCompare(a.date)).slice(0, 21);
  const day = date && DATE_RE.test(date) ? date : (boardDays[0]?.date ?? null);
  const rosterDoc = day ? await deps.getDoc(`nuvizz_load_roster/${PLAN_TENANT}__${day}`).catch(() => null) : null;
  // The board's own rows (three fields): how many stops each route already carries in NuVizz, so a
  // roster load says what it brings with it before it is picked.
  const dayRead = day ? await board.readStops(PLAN_TENANT, day, { mask: ['stopNbr', 'isPlanned', 'routeName', 'loadNbr'] }).catch(() => ({ meta: null, stops: [] as any[] })) : { meta: null, stops: [] as any[] };
  const meta = dayRead.meta;
  const onBoard = new Map<string, number>();
  for (const r of dayRead.stops || []) if (r?.isPlanned === true) { const k = rowRouteKey(r); if (k) onBoard.set(k, (onBoard.get(k) || 0) + 1); }
  // The picker says when no class is known rather than guessing one (the preview and a run refuse it).
  const classesKnown = Array.isArray(employees);
  const empClass = employeeClassMap(employees || []);
  const clsOf = (name: string | null) => { if (!name || !classesKnown) return null; const k = classKey(name); return (empClass.get(k) || CLASS_OVERRIDE.get(k) || null) as any; };
  const c = ceilingsInForce(settings.settings);
  const hard = hardCapsEnabled(deps.env);
  const ceilings = hard ? { box_truck: c.box_truck, tractor: c.tractor } : null;
  const m = withOverrides(model || { drivers: [], routes: [] }, settings.caps || { drivers: {}, routes: {} });
  const dRows = new Map((m?.drivers || []).map((r: any) => [r.key, r]));
  const rRows = new Map((m?.routes || []).map((r: any) => [r.key, r]));
  const capOf = (route: string, driver: string | null, cls: any) => {
    const k = (cls || 'box_truck') as 'box_truck' | 'tractor';
    const b = capFor(driver ? dRows.get(keyOf(driver)) : null, route ? rRows.get(keyOf(route)) : null, rs.capRule, k, ceilings);
    return { cap: Math.round(b.cap * 10) / 10, source: b.source };
  };
  const rosterLoads = (rosterLoadsOf(rosterDoc) || [])
    .filter((l: any) => !/cancel/i.test(String(l?.status ?? '')) && typeof l?.name === 'string' && l.name.trim())
    .map((l: any) => {
      const driver = typeof l.driver === 'string' && l.driver.trim() ? l.driver.trim() : null;
      const cls = clsOf(driver);
      return { route: l.name.trim(), driver, loadNbr: l.loadNbr ?? null, status: l.status ?? null, onBoard: onBoard.get(keyOf(l.name.trim())) ?? 0, cls, ...capOf(l.name.trim(), driver, cls) };
    })
    .sort((a: any, b: any) => a.route.localeCompare(b.route));
  // A driver who already has a load on this day's roster is marked: pick THAT load (its stops are
  // kept on it), not the driver, or the plan would give them a second, empty truck.
  const onRoster = new Map<string, string>();
  for (const l of rosterLoads) if (l.driver) onRoster.set(classKey(l.driver), l.route);
  const drivers = (m?.drivers || [])
    .filter((r: any) => !r.noHistory || r.yourCap != null)
    .map((r: any) => { const cls = clsOf(r.name); const route = (r.routes || [])[0]?.name || r.name; return { driver: r.name, route, cls, trips: r.trips ?? 0, onRoster: onRoster.get(classKey(r.name)) ?? null, ...capOf(route, r.name, cls) }; })
    .sort((a: any, b: any) => a.driver.localeCompare(b.driver));
  return {
    ok: true, date: day, boardDays, board: meta ? { count: meta.count ?? null, unplanned: meta.unplannedCount ?? null, planned: meta.plannedCount ?? null, scannedAt: meta.last_scanned_at ?? null } : null,
    roster: rosterDoc ? { at: rosterDoc.at ?? null, loads: rosterLoads } : null,
    drivers, ceilings: { box_truck: c.box_truck, tractor: c.tractor }, hardCaps: hard, classesKnown,
    bounds: { lookbackDays: PLAN_LOOKBACK_BOUNDS, maxLoads: MAX_PLAN_LOADS, maxStops: MAX_PLAN_STOPS }, scopes: PLAN_SCOPES,
    nuvizzCalls: 0,
  };
}

/**
 * Why a plan has nothing for Claude to place, or null (v1.78.0; review: every plan, not only a section).
 * A plan whose every stop is already fixed to its truck — by NuVizz or an earlier section — would pay
 * for Claude to decide nothing, so it is refused at preview and at Plan.
 */
export function nothingToPlace(params: PlanParams, p: BtProblem): string | null {
  const c: any = p.counts || {};
  if ((c.toPlan ?? 0) > 0) return null;
  if (params.section) return `none of the ${params.section.length} stop${params.section.length === 1 ? '' : 's'} picked on the map can be placed now: ${[
    c.sectionAlreadyPlaced ? `${c.sectionAlreadyPlaced} already placed by the earlier section` : null,
    c.sectionMissing ? `${c.sectionMissing} no longer open, on a load not picked, or with no map point` : null,
  ].filter(Boolean).join('; ') || 'they are already on the picked loads'} — pick other stops on the map`;
  if (params.after) return 'nothing is left for Claude to place: every stop the settings allow is already placed by the earlier sections or on the picked loads in NuVizz';
  return 'nothing is left for Claude to place: every stop the settings allow is already on the picked loads in NuVizz';
}

/** THE PREVIEW (0 model spend, 0 NuVizz): the plan exactly as a run would build it, and what it lacks. */
export async function planPreview(raw: any, rs: any, deps: PlanDeps) {
  const v = validatePlanParams(raw);
  if (!v.ok) return { status: 400, body: { ok: false, errors: v.errors } };
  let built;
  try { built = await readPlanDay(v.params!, rs, deps); }
  catch (e: any) { return { status: 422, body: { ok: false, error: String(e?.message || e) } }; }
  const p = built.problem;
  return {
    status: 200,
    body: {
      ok: true, params: v.params, boardAt: built.boardAt,
      counts: p.counts, carry: built.carry, capacity: planCapacity(p), infeasible: (p as any).infeasible ?? null,
      // v1.78.0: a section's picked stops, what it builds on and carries; and a section with nothing of
      // its own to place, which Plan refuses (it would pay to re-place stops that are already placed).
      section: p.section ?? null, nothingToPlace: nothingToPlace(v.params!, p),
      loads: p.loads.map((l) => ({ id: l.id, route: l.route, driver: l.driver, cls: l.cls, clsSource: l.clsSource, cap: l.cap, capSource: l.capSource, capNote: l.capNote, maxLbs: l.maxLbs ?? null, maxMin: l.maxMin })),
      noLocation: p.excluded.noCoords.slice(0, 50), noLocationCount: p.excluded.noCoords.length,
      capMode: p.capMode, ceilings: p.ceilings, lbsLimits: p.lbsLimits,
      approximations: p.approximations, model: shadowModel(deps.env).model, maxUsd: rs.maxUsd,
      nuvizzCalls: 0,
    },
  };
}

/** The run ended: measure Claude's plan and store it. (Called by the backtest worker for a plan job.) */
export async function finishPlan(id: string, job: any, problem: BtProblem, cfg: any, state: LoopState, rs: any, deps: PlanDeps, wasCancelled: () => Promise<boolean>, jobPath: (id: string) => string) {
  const at = deps.now().toISOString();
  if (await wasCancelled()) return { ok: true, job: id, cancelled: true, usd: state.usd };
  const plan = state.final ?? state.bestClean;
  if (!plan) {
    await deps.shadowPatch(jobPath(id), { status: 'failed', finishedAt: at, updatedAt: at, error: noPlanReason(state) });
    return { ok: true, job: id, failed: state.ended };
  }
  const rates = { perMile: rs.costPerMile ?? null, perDriveHour: rs.costPerDriveHour ?? null };
  const out = planResultFrom(problem, plan, cfg, rates);
  const submitted = !!state.final;
  const result = {
    tenant: PLAN_TENANT, kind: 'plan', date: problem.date, jobId: id, at, submitted,
    planFrom: submitted ? 'submitted' : `the last clean evaluation (round ${state.bestCleanRound}) — the run ended before a submit (${state.ended})`,
    params: job?.params ?? null, by: job?.by ?? null,
    model: job?.settings?.model ?? null, effort: job?.settings?.effort ?? null, capRule: problem.capRule, loosePerSkid: problem.loosePerSkid,
    lbsLimits: problem.lbsLimits, capMode: problem.capMode, ceilings: problem.ceilings, capsHeld: problem.capsHeld,
    rounds: state.rounds.length, usd: state.usd, ended: state.ended, endNote: state.endNote, rates,
    stats: { stops: problem.stops.length, loads: problem.loads.length, noLocation: problem.excluded.noCoords.length, counts: problem.counts, carry: (problem as any).carry ?? null },
    capacity: planCapacity(problem),
    approximations: problem.approximations,
    ...out,
    nuvizzCalls: 0,
  };
  await deps.shadowSet(planResultPath(id), result);
  // "Placed" is what Claude decided: the stops it put on a truck, not counting the ones already there (review).
  const placed = Math.max(0, out.columns.claude.stops - out.kept);
  const headline = { placed, kept: out.kept, unplanned: out.unplanned.length, trucks: out.columns.claude.trucks, miles: out.columns.claude.miles, driveMin: out.columns.claude.driveMin };
  await deps.shadowPatch(jobPath(id), { status: 'done', finishedAt: at, updatedAt: at, headline, submitted });
  return { ok: true, job: id, done: true, headline };
}

export async function planResult(id: string, deps: PlanDeps) {
  if (!PLAN_ID_RE.test(String(id))) return { status: 400, body: { ok: false, error: 'bad plan id' } };
  const r = await deps.getDoc(planResultPath(id));
  if (!r) return { status: 404, body: { ok: false, error: 'no result for that plan yet' } };
  return { status: 200, body: { ok: true, result: r } };
}

/** The map's read for one plan: its stops and Claude's loads in order (there is no dispatch side). */
export async function planMap(id: string, deps: PlanDeps, jobPath: (id: string) => string) {
  if (!PLAN_ID_RE.test(String(id))) return { status: 400, body: { ok: false, error: 'bad plan id' } };
  const r = await deps.getDoc(planResultPath(id));
  if (!r) return { status: 404, body: { ok: false, error: 'no result for that plan yet' } };
  const stored = await deps.getDoc(`${jobPath(id)}/data/problem`);
  if (typeof stored?.problemJson !== 'string') return { status: 404, body: { ok: false, error: 'the stops stored with this plan are not on file' } };
  let problem: BtProblem;
  try { problem = JSON.parse(stored.problemJson); } catch { return { status: 500, body: { ok: false, error: 'the stored plan could not be read' } }; }
  let cfg: any = null;
  try { cfg = typeof stored.cfgJson === 'string' ? JSON.parse(stored.cfgJson) : null; } catch { cfg = null; }
  if (!(Number(cfg?.road_factor) > 0)) cfg = null;
  const map: any = backtestMapPayload(problem, r, cfg);
  map.kind = 'plan';
  map.planId = id;
  // Each stop's board day, so a carried-over order can be told apart on the map and in the lists.
  const dayOf = new Map((problem.stops || []).map((s) => [s.id, s.day ?? null]));
  map.stops = map.stops.map((s: any) => ({ ...s, day: dayOf.get(s.id) ?? null }));
  return { status: 200, body: { ok: true, map, nuvizzCalls: 0 } };
}

export { PLAN_ID_RE, validatePlanParams };
