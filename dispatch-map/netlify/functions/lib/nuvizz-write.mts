// lib/nuvizz-write.mts
//
// ── NuVizz v7 WRITE executor (the IMPURE half) ───────────────────────────────
//
// Fires the PURE requests built in nuvizz-write-ops.mts through the SHARED metered
// requester (getNuvizzRequester) so every write is counted against the daily ceiling,
// honors the circuit breaker, and is visible per-route in Diagnostics — exactly like
// every read. POSTs are never deduped by the requester (writes must not coalesce).
//
// The requester is INJECTED (runOp's first arg) so this is unit-testable with the same
// makeHarness() pattern as test/nuvizz-request.test.mjs — no network, no Firestore.
// The HTTP op-envelope handler (nuvizz-write.mts function) calls runOp(getNuvizzRequester(), …).
//
// Multi-call ops:
//   removeStops  = GET load/info (echo header + versionId) → POST load/edit   (2 calls, §3.5)
//   commitLoad   = the Compare-panel "Save" batch: optionally one getLoad to resolve
//                  loadId/header, then remove → insert → assign → dispatch in order,
//                  stopping at the first failure. (This is what the Save button commits.)

import { getCreds, basicAuthHeader } from './nuvizz-scan.mts';
import {
  buildOpRequest, parseOpResponse, toEditHeader, normalizeLoad, planSequence, deliveryOrder,
  importEchoFromRaw, assembleImportHeader, sameOrder, buildStopPayload, normStopNbr,
  rawStopExecStatus, isExecutedStopStatus, cancelResponseConfirms,
  buildStopNoteComment, rawStopFrom, stopCommentsFrom, mergeStopComments,
  stopNoteFingerprint, fingerprintDrift, buildNoteWriteStop, echoDrift, driftDetail,
  unsentLosses, documentHandlesMoved, type NoteAudience,
  buildPartialUpdateStop, buildStopDateOverride, stopDeliveryDate, isDayString, boardDateHoldWarning,
  stopInstanceMismatch, readBackInstanceMismatch, readBackUnidentifiable, isIdShaped, orderDriftPaths, addressDriftWarning,
  buildStopAddressOverride, addressLanded,
  CANCEL_REASON_DEFAULT,
  buildStopContactOverride, stopContactFrom, normalizeContactPhone,
  type SingleOp, type WriteOp, type WriteCreds,
} from './nuvizz-write-ops.mts';
import { isHashLikeId } from './nuvizz-list.mts';
import { patchBoardPlan, isFirestoreEnabled, etDayString, setBoardDateOverride, moveBoardStopDay } from './firestore.mts';
import { rwbEngineBlocked, rwbConfigReady, rwbAddStopsToRoute, rwbSequenceStops, rwbSequenceRoutes } from './nuvizz-rwb.mts';

const hasDriverId = (v: any) => v != null && String(v).trim() !== '' && Number(v) !== 0;

// A caller-supplied loadId is only trustworthy AS the assign/dispatch routeId when it's a real
// INTERNAL load id (the 24-hex loadHeader.loadId, e.g. 6a438e9d52ef82bd1ed4516b). A load that
// carries stops gets that canonical id off its stops; but an EMPTY/Draft load (no stops) can only
// fall back to the PkgRoute roster KeyColumn, which is NOT guaranteed to be that internal id. NuVizz
// SILENTLY no-ops an assign whose routeId isn't the internal loadId — it returns "Success" while
// persisting nothing (the exact "accepted but didn't take" symptom). So: trust a hash-like client
// loadId (the proven path is untouched — those ids ARE hash-like); otherwise resolve the canonical
// loadHeader.loadId from load/info before assigning. If the roster id already IS the internal id,
// this guard is a no-op; if it isn't, this is what makes an empty-load assign actually persist.
const trustableLoadId = (v: any) => v != null && isHashLikeId(String(v));

// v7 API base — same env var the read path uses (nuvizz-scan.mts). Host-agnostic so a
// UAT base can be set without code changes. No raw network call in this file (every
// request goes through the metered requester), so the no-direct-nuvizz guard stays green.
const NUVIZZ_V7_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';

export function resolveWriteCreds(): WriteCreds {
  const { companyCode } = getCreds();
  return { base: NUVIZZ_V7_BASE.replace(/\/+$/, ''), companyCode, auth: basicAuthHeader() };
}

// Minimal surface of the metered requester we depend on (lets tests pass a stub).
export interface RequesterLike {
  request(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string | null; maxRetries?: number }, meta: { route: string; tenant: string; source?: string }): Promise<Response>;
}

async function safeJson(resp: Response): Promise<any> {
  try { return await resp.json(); }
  catch { try { return { _text: await resp.text() }; } catch { return {}; } }
}

async function fireSingle(requester: RequesterLike, op: SingleOp, payload: any, creds: WriteCreds): Promise<any> {
  const br = buildOpRequest(op, payload, creds);
  // NON-IDEMPOTENT writes are never transport-retried: an assign/dispatch whose first attempt
  // APPLIED but answered 5xx would double-fire on retry (a duplicate DISPATCH to the driver).
  // Reads and the DECLARATIVE import keep the default retry policy — re-sending those is safe.
  const noRetry = op === 'assignDriver' || op === 'dispatchLoad' || op === 'insertStops' || op === 'removeStops' || op === 'createStop';
  const resp = await requester.request(br.url, { method: br.method, headers: br.headers, body: br.body, ...(noRetry ? { maxRetries: 0 } : {}) }, br.meta);
  const j = await safeJson(resp);
  return { ...parseOpResponse(op, resp.ok, j), httpStatus: resp.status };
}

/** GET load/info → { load, httpStatus, hadLoadId }. `load` is the normalized load when the
 * lookup resolved (2xx AND a real loadId), else null. The diagnostic fields let callers say WHY
 * a load didn't resolve — a 404 (the load number isn't recognized by NuVizz) vs a 200 with no
 * loadId (unexpected response shape) — so "load not found" is actionable in the field. */
export async function fetchLoad(requester: RequesterLike, loadNbr: string, creds: WriteCreds): Promise<{ load: any; httpStatus: number | null; hadLoadId: boolean }> {
  const r = await fireSingle(requester, 'getLoad', { loadNbr }, creds);
  // normalizeLoad ALWAYS returns an object (even for a 404/empty body), so "not found" must be
  // detected by a non-2xx response or a missing loadId — never edit/dispatch a phantom load.
  const hadLoadId = !!(r.load && r.load.loadId != null);
  const ok = !!r.ok && hadLoadId;
  return { load: ok ? r.load : null, httpStatus: r.httpStatus ?? null, hadLoadId };
}

/** Resolve a load's HUMAN loadNbr from its INTERNAL loadId via load/static/info(routeId). load/info
 * (and the load/edit unplan step) is keyed by the human number, so a load we only know by its id
 * (Draft / Loads-grid) needs this bridge before it can be reordered/unplanned. Null if unresolved. */
// load/static/info is HTTP 501 (not implemented) on the live DAVIS tenant — remember the first
// 501 per warm instance so every later resolution skips the guaranteed-wasted NuVizz call.
let staticInfoUnavailable = false;
/** Test hook: clears the per-instance 501 memo so scripted suites stay order-independent. */
export function _resetStaticInfoMemo(): void { staticInfoUnavailable = false; }
export async function resolveLoadNbrById(requester: RequesterLike, loadId: string, creds: WriteCreds): Promise<string | null> {
  if (staticInfoUnavailable) return null;
  try {
    const r = await fireSingle(requester, 'getLoadByRouteId', { routeId: loadId }, creds);
    if (r?.httpStatus === 501) { staticInfoUnavailable = true; return null; }
    return r?.ok && r.load?.loadNbr != null && String(r.load.loadNbr).trim() !== '' ? String(r.load.loadNbr) : null;
  } catch { return null; }
}

/** Resolve a load's HUMAN loadNbr from a stop CURRENTLY ON it, via getStop → Stop.load.loadNbr
 * (assignedLoadNbr). This is the RELIABLE bridge on the live tenant: the loads-roster saved search
 * carries no load-number column, and load/static/info(routeId) returns HTTP 501 — so a stop's own
 * load membership is the only place a Draft/grid load's real number (DAVIS000000123) is exposed.
 * Verified live. Null if the stop isn't on a load. */
export async function resolveLoadNbrByStopNbr(requester: RequesterLike, stopNbr: string, creds: WriteCreds): Promise<string | null> {
  try {
    const r = await fireSingle(requester, 'getStop', { stopNbr }, creds);
    const nbr = r?.ok ? r.stop?.assignedLoadNbr : null;
    return nbr != null && String(nbr).trim() !== '' && !isHashLikeId(String(nbr)) ? String(nbr) : null;
  } catch { return null; }
}

/**
 * resolveLoadNbrBySeeding — the LAST-RESORT loadNbr bridge for an EMPTY Draft load we only know
 * by its internal loadId (the live tenant's loads roster has no load-number column, static/info
 * is HTTP 501, and an empty load has no stops to read the number from — the exact state that
 * refused every "build a load from unplanned orders" Save with "needs a load number").
 *
 * The trick: load/insertstops is keyed by the INTERNAL loadId (the proven add path), so SEED the
 * load with the first desired stop (1 call), then read that stop back — Stop.load.loadNbr is the
 * load's real human number (the verified live bridge). The seeded stop is part of the desired
 * order anyway, so the follow-up (import rebuild or anchor plan) seats it — never an extra stop.
 * Only ever seeds a stop that is genuinely UNPLANNED (a planned stop returns its current load's
 * number directly, or is somebody else's — never stolen here).
 */
async function resolveLoadNbrBySeeding(
  requester: RequesterLike, loadId: any, stopNbr: string, creds: WriteCreds, sleep: (ms: number) => Promise<void> = realSleep,
): Promise<{ loadNbr: string | null; seeded: boolean; error?: string }> {
  const g1 = await fireSingle(requester, 'getStop', { stopNbr }, creds);
  if (!g1?.ok) return { loadNbr: null, seeded: false, error: `stop ${stopNbr} could not be read (stale board — refresh and retry)` };
  const already = String(g1.stop?.assignedLoadNbr ?? '').trim();
  if (already && !isHashLikeId(already)) return { loadNbr: already, seeded: false };
  const stopId = g1.stop?.stopId ? String(g1.stop.stopId) : null;
  if (!stopId) return { loadNbr: null, seeded: false, error: `stop ${stopNbr} has no internal id to seed the load with` };
  const ins = await fireSingle(requester, 'insertStops', { insertStopIds: [stopId], loadId }, creds);
  if (!ins?.ok) return { loadNbr: null, seeded: false, error: `seeding the load failed: ${ins?.error || 'insertStops failed'}` };
  // Membership usually reflects immediately; retry briefly in case the read lags the insert.
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(1500);
    const g2 = await fireSingle(requester, 'getStop', { stopNbr }, creds);
    const nbr = g2?.ok ? String(g2.stop?.assignedLoadNbr ?? '').trim() : '';
    if (nbr && !isHashLikeId(nbr)) return { loadNbr: nbr, seeded: true };
  }
  return { loadNbr: null, seeded: true, error: 'load seeded but its number is not visible yet — Save again in a moment (safe to repeat)' };
}

// Human "why didn't it resolve" suffix for a failed fetchLoad. Surfaces the exact load number we
// queried and NuVizz's response so a wrong/blank load number (404) is distinguishable from a load
// that resolved but parsed without an id (200/no loadId) — turns an opaque "load not found" into
// something a dispatcher can read back to us verbatim.
function loadMissDiag(loadNbr: any, f: { httpStatus: number | null; hadLoadId: boolean }): string {
  const detail = f.httpStatus === 200 && !f.hadLoadId ? 'load/info 200 but no loadId in response' : `load/info HTTP ${f.httpStatus}`;
  return `loadNbr="${loadNbr ?? ''}", ${detail}`;
}

/**
 * removeStops (§3.5): ALWAYS resolve the echoed header + versionId from a live getLoad —
 * we never trust a caller-supplied editHeader/versionId. load/edit is a full-header replace,
 * so echoing a hand-crafted/stale header could blank live load fields; server-resolving the
 * header from NuVizz is the only safe contract.
 */
async function runRemoveStops(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const loadNbr = req(payload?.loadNbr, 'removeStops: loadNbr');
  const f = await fetchLoad(requester, loadNbr, creds);
  if (!f.load) return { ok: false, error: `removeStops: load not found (${loadMissDiag(loadNbr, f)})`, loadNbr };
  return fireSingle(requester, 'removeStops', { removeStopIds: payload?.removeStopIds, editHeader: toEditHeader(f.load.loadHeader), versionId: f.load.versionId }, creds);
}

/**
 * commitLoad — the Save batch for ONE load card. Resolves loadId/header once if needed,
 * then applies removes → inserts → assign → dispatch in order, capturing a per-step
 * result and aborting the remainder on the first failure (so a failed insert never
 * dispatches a half-built load).
 */
export async function runCommitLoad(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const loadNbr = payload?.loadNbr ?? null;
  const removeStopIds: any[] = Array.isArray(payload?.removeStopIds) ? payload.removeStopIds : [];
  const insertStopIds: any[] = Array.isArray(payload?.insertStopIds) ? payload.insertStopIds : [];
  const driverId = payload?.driverId ?? null;
  const dispatch = Boolean(payload?.dispatch);
  // driverId is a NuVizz numeric userId; treat null/blank/0 as "no driver" so a falsy-but-
  // present 0 cannot half-fire an assign. The same predicate gates load resolution below.
  const hasDriver = driverId != null && String(driverId).trim() !== '' && Number(driverId) !== 0;

  // Prefer a loadId the CALLER already knows (the board's same-day loadId) over re-resolving
  // by name: recurring loads share a NAME across days but have a distinct loadId per day, so
  // name-resolution could otherwise hit the wrong day's instance. We still getLoad when a
  // remove needs the header/versionId, or when no loadId was supplied. Only trust a hash-like
  // (internal) loadId, though — a non-canonical roster id (empty-load fallback) is dropped to
  // null here so it is RE-RESOLVED to the real loadHeader.loadId below rather than sent as a
  // routeId NuVizz silently ignores.
  let loadId = trustableLoadId(payload?.loadId) ? payload.loadId : null;
  let editHeader: any = null, versionId: any = null;

  const needLoad = (!loadId && (insertStopIds.length || hasDriver || dispatch)) || removeStopIds.length;
  if (needLoad) {
    if (!loadNbr) return { ok: false, error: 'commitLoad: loadNbr required to resolve load', loadNbr, loadId, steps: [] };
    const f = await fetchLoad(requester, loadNbr, creds);
    if (!f.load) return { ok: false, error: `commitLoad: load not found (${loadMissDiag(loadNbr, f)})`, loadNbr, loadId, steps: [] };
    loadId = loadId || f.load.loadId;
    // NOTE: versionId/editHeader are snapshotted from this single getLoad. Safe today because
    // removeStops runs FIRST and is the only step that uses them; if a future step re-edits the
    // header after a remove, re-fetch the load to refresh the (now-bumped) versionId.
    editHeader = toEditHeader(f.load.loadHeader);
    versionId = f.load.versionId;
  }

  const steps: Array<{ op: WriteOp; ok: boolean; result?: any; error?: string | null }> = [];
  const push = (op: WriteOp, r: any) => { steps.push({ op, ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') }); return !!r.ok; };

  if (removeStopIds.length) {
    if (!push('removeStops', await fireSingle(requester, 'removeStops', { removeStopIds, editHeader, versionId }, creds))) return done(false);
  }
  if (insertStopIds.length) {
    if (!loadId) return { ok: false, error: 'commitLoad: loadId unresolved for insertStops', loadNbr, loadId, steps };
    if (!push('insertStops', await fireSingle(requester, 'insertStops', { insertStopIds, loadId }, creds))) return done(false);
  }
  if (hasDriver) {
    if (!loadId) return { ok: false, error: 'commitLoad: loadId unresolved for assignDriver', loadNbr, loadId, steps };
    if (!push('assignDriver', await fireSingle(requester, 'assignDriver', { routeId: loadId, driverId }, creds))) return done(false);
  }
  if (dispatch) {
    if (!loadId) return { ok: false, error: 'commitLoad: loadId unresolved for dispatch', loadNbr, loadId, steps };
    if (!push('dispatchLoad', await fireSingle(requester, 'dispatchLoad', { routeId: loadId }, creds))) return done(false);
  }
  return done(true);

  function done(ok: boolean) { return { ok: ok && steps.every((s) => s.ok), loadNbr, loadId, steps }; }
}

// The delivery stopIds currently on a load, in visit order (the pickup, stopType!='DO',
// is excluded so it stays as a natural anchor and is never removed/re-sequenced).
function currentDeliveryStopIds(load: any): string[] {
  return (load?.stops || [])
    .filter((s: any) => String(s?.stopType || '').toUpperCase() === 'DO')
    .slice()
    .sort((a: any, b: any) => Number(a?.stopSeq ?? 0) - Number(b?.stopSeq ?? 0))
    .map((s: any) => String(s?.stopId ?? ''))
    .filter(Boolean);
}

// True when a load carries a non-pickup stop the DO-filter would skip: a stop whose type isn't
// 'DO' but sits in a delivery slot (stopSeq > 1; doc §10 says seq 1 = origin pickup). Re-sequencing
// such a load would leave that stop out of the rebuilt order — refuse rather than de-sequence it.
// `modeledNbrs` (RWB path): a non-DO stop the board IS sequencing (an RA/return in the card's
// order — pickupLegIds places its customer _PU leg) is NOT unmodeled; without this exclusion the
// guard refused every edit of a load carrying a mid-route pickup, contradicting the pickup-leg
// support it sits in front of. Omitted (classic engine) → original behavior.
function hasUnmodeledDelivery(load: any, modeledNbrs?: Set<string>): boolean {
  return (load?.stops || []).some((s: any) => String(s?.stopType || '').toUpperCase() !== 'DO' && Number(s?.stopSeq ?? 0) > 1
    && !(modeledNbrs && s?.stopNbr != null && modeledNbrs.has(String(s.stopNbr))));
}

/**
 * commitBoard — the panel-level "Save" for the staged Compare board (handoff doc §10
 * Draft→Save). TWO PHASES across ALL touched loads so a stop moved from load A to load B
 * is removed from A BEFORE it is inserted onto B (a stop can be on only one load):
 *   Phase 0  resolve+plan — getLoad each load (loadId, versionId, header, current deliveries),
 *            then planSequence(current, desired) = the anchor method.
 *   Phase 1  removes — load/edit each load's removeStopIds (keeping its anchor; never all).
 *   Phase 2  rebuild — insertStops one-at-a-time in the desired order, then assignDriver,
 *            then dispatch, per load.
 * A load that fails a step aborts ITS remaining steps but never blocks other loads.
 * payload: { loads: [{ loadNbr, loadId?, orderedStopIds:[stopId...], driverId?, dispatch? }] }
 */
export async function runCommitBoard(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const loadsIn: any[] = Array.isArray(payload?.loads) ? payload.loads : [];
  if (!loadsIn.length) return { ok: true, loads: [] };

  // ── Phase 0 — resolve + plan ──
  const planned: any[] = [];
  // Every load NUMBER that is part of THIS Save (declared up front + resolved as we go). Used to
  // tell a legitimate cross-load move (source load in the batch → Phase 1 frees the stop) from a
  // GRAB off a load that isn't in the payload at all (nothing would free it → double-plan).
  const batchNbrs = new Set<string>();
  for (const l of loadsIn) { const v = String(l?.loadNbr ?? '').trim(); if (v && !isHashLikeId(v)) batchNbrs.add(v); }
  for (const L of loadsIn) {
    const loadNbr = L?.loadNbr ?? null;
    const result: any = { loadNbr, ok: true, steps: [], error: null };
    // Desired order can arrive as stopIds (legacy + the loadId-only insert path) or as stopNbrs
    // (resolved server-side from the load — robust to board stops that were never enriched and so
    // carry no client stopId; the #symptom-A silent drop).
    const orderedNbrs: string[] | null = Array.isArray(L?.orderedStopNbrs) ? L.orderedStopNbrs.map((x: any) => String(x)).filter(Boolean) : null;
    const emptyLoad = L?.emptyLoad === true;
    let desired: any[] = Array.isArray(L?.orderedStopIds) ? L.orderedStopIds.map((x: any) => String(x)) : [];
    if (!loadNbr && !L?.loadId) { result.ok = false; result.error = 'commitBoard: loadNbr or loadId required'; planned.push({ L, result }); continue; }
    // Does this load change its stop set (reorder / unplan / empty the load)? Assign/dispatch-only
    // (no stop change) skips getLoad with a TRUSTWORTHY (internal/hash-like) loadId. A non-canonical
    // loadId (empty-load roster fallback) is NOT trusted — it falls through to fetchLoad so the real
    // loadHeader.loadId is resolved, else NuVizz returns Success on the assign but never persists it.
    const changesStops = emptyLoad || orderedNbrs !== null || desired.length > 0;
    if (!changesStops && trustableLoadId(L?.loadId)) {
      planned.push({ L, loadId: L.loadId, hasLoad: true, plan: { ok: true, unchanged: true, removeStopIds: [], insertOrdered: [] }, result });
      continue;
    }
    // Resolve a USABLE human loadNbr. load/info (and the load/edit unplan step) is keyed by the human
    // number (DAVIS000000123), NOT the hex loadId. A load opened from the Loads grid / a Draft load has
    // only its internal id, so we must bridge to its real number before a REORDER/UNPLAN can run the
    // real unplan(load/edit)→re-insert path (instead of blind-inserting already-planned stops).
    let loadNbrX = (loadNbr != null && String(loadNbr).trim() !== '' && !isHashLikeId(String(loadNbr))) ? String(loadNbr) : null;
    if (!loadNbrX) {
      // PREFER reading a stop CURRENTLY on the load (getStop → assignedLoadNbr) — the RELIABLE source
      // on the live tenant, where the loads-roster saved search has no load-number column and
      // load/static/info(routeId) is HTTP 501. A reorder/unplan/empty always carries stop NUMBERS the
      // caller says are on the load (ordered ∪ removed), so probe the first of those. [verified live]
      const probeNbr = (orderedNbrs && orderedNbrs[0])
        || (Array.isArray(L?.removeStopNbrs) && L.removeStopNbrs.length ? String(L.removeStopNbrs[0]) : null);
      if (probeNbr) loadNbrX = await resolveLoadNbrByStopNbr(requester, String(probeNbr), creds);
      // Fallback: load/static/info(routeId) where that endpoint exists (some tenants).
      if (!loadNbrX && trustableLoadId(L?.loadId)) loadNbrX = await resolveLoadNbrById(requester, L.loadId, creds);
      if (loadNbrX) result.loadNbr = loadNbrX;
    }
    if (loadNbrX) batchNbrs.add(loadNbrX);
    // Add BRAND-NEW (unplanned) stops to a load we STILL only know by its id (static/info couldn't
    // resolve a number): insert the stopIds straight onto the loadId, no anchor-remove. Only a pure ADD
    // by stopIds — a reorder-by-stopNbr / emptyLoad needs the load's current stops (getLoad, below). [#328]
    if (desired.length && orderedNbrs === null && !emptyLoad && trustableLoadId(L?.loadId) && !loadNbrX) {
      planned.push({ L, loadId: L.loadId, hasLoad: true, plan: { ok: true, removeStopIds: [], insertOrdered: desired.map((x) => String(x)) }, curIds: [], want: desired.map((x) => String(x)), result });
      continue;
    }
    // EMPTY Draft load known only by its internal id: SEED it with the first desired stop
    // (loadId-keyed insertstops), then read that stop back for the real load number — the same
    // bridge the import engine uses. Only for an order-building Save (never an empty/cancel).
    if (!loadNbrX && !emptyLoad && trustableLoadId(L?.loadId) && orderedNbrs && orderedNbrs.length) {
      const seed = await resolveLoadNbrBySeeding(requester, L.loadId, orderedNbrs[0], creds);
      result.steps.push({ op: 'seedLoad', ok: !!seed.loadNbr, seeded: seed.seeded, loadNbr: seed.loadNbr, error: seed.error || null });
      if (seed.loadNbr) { loadNbrX = seed.loadNbr; result.loadNbr = loadNbrX; batchNbrs.add(loadNbrX); }
      else { result.ok = false; result.error = `commitBoard: ${seed.error || 'could not resolve the load number'}`; planned.push({ L, result }); continue; }
    }
    // Reorder / unplan / empty needs the load's CURRENT stops (a getLoad), which needs a real loadNbr.
    // If seeding also couldn't resolve one, guide the dispatcher to open it from the board.
    if (!loadNbrX) {
      result.ok = false; result.error = 'commitBoard: reorder/unplan needs a load number — open the route from the board (not the Loads grid)'; planned.push({ L, result }); continue;
    }
    const f = await fetchLoad(requester, loadNbrX, creds);
    if (!f.load) { result.ok = false; result.error = `commitBoard: load not found (${loadMissDiag(loadNbrX, f)})`; planned.push({ L, result }); continue; }
    const load = f.load;
    // curIds is captured on EVERY fetched load (even refused ones) so holderOf below can see a
    // cross-load arrival whose source load was refused — otherwise the target would insert a stop
    // the refused source never freed.
    const curIds = currentDeliveryStopIds(load);
    // Resolve a stopNbr-based desired order → stopIds. Stops already ON the load carry their stopId
    // in the getLoad response (nbrToId) — this is what lets an unplan/reorder work even when the
    // client never enriched its board stops. A stopNbr NOT on the load is a stop being ADDED (e.g.
    // re-planning an order that was just unplanned) — resolve its id via getStop so it gets INSERTED,
    // instead of being silently dropped (which read as "nothing to send" on a re-add).
    if (orderedNbrs !== null) {
      const nbrToId = new Map<string, string>();
      for (const s of (load.stops || [])) { const n = String(s?.stopNbr ?? ''); const id = String(s?.stopId ?? ''); if (n && id) nbrToId.set(n, id); }
      const resolved: string[] = [];
      let anyOnLoad = false;
      let refuse: string | null = null;
      for (const n of orderedNbrs) {
        let id = nbrToId.get(n);
        if (id) { anyOnLoad = true; }
        else {
          // Not on this load → an add. getStop resolves its stopId (and it's not in holderOf, so
          // Phase 2 inserts it safely). null only if the stop number is genuinely unknown.
          const gs = await fireSingle(requester, 'getStop', { stopNbr: n }, creds);
          id = gs?.ok && gs.stop?.stopId ? String(gs.stop.stopId) : undefined;
          // A stop still PLANNED on a load that is NOT part of this Save would be silently pulled
          // off that load by the insert (holderOf only sees loads in the payload, so the Phase-2
          // "still on another load" guard is blind here). Refuse — the source must be in the Save
          // so the move is a staged remove+insert, never a grab.
          const srcNbr = gs?.ok ? String(gs.stop?.assignedLoadNbr ?? '').trim() : '';
          if (id && srcNbr && srcNbr !== String(loadNbrX ?? '') && !batchNbrs.has(srcNbr)) {
            refuse = `commitBoard: stop ${n} is still planned on load ${srcNbr}, which is not part of this Save — open that load in Compare so the move is staged`;
            break;
          }
        }
        if (id) resolved.push(String(id));
      }
      if (refuse) { result.ok = false; result.error = refuse; planned.push({ L, curIds, result }); continue; }
      // Refuse only when NOTHING resolved AND nothing was even on the load — a genuinely stale board.
      if (orderedNbrs.length && !resolved.length && !anyOnLoad) {
        result.ok = false; result.error = 'commitBoard: ordered stops not found (stale board — refresh and retry)'; planned.push({ L, curIds, result }); continue;
      }
      desired = resolved;
    }
    // EMPTY-LOAD intent (§10): the user removed EVERY order — removing all deliveries CANCELS the
    // route. Computed BEFORE the wrong-load guard so a cancel is identity-checked too: an emptied
    // load whose NAME resolved to a different day's instance must never cancel that other route.
    const intendedEmpty = emptyLoad || (orderedNbrs !== null && orderedNbrs.length === 0);
    // Wrong-load guard: a reorder (or cancel) resolves the load by NAME (for header + versionId)
    // but targets the caller's loadId — if the caller's same-day loadId disagrees with what the
    // name resolved to, the recurring name hit a different day's instance; refuse rather than
    // split remove/insert (or cancel the wrong route).
    if ((desired.length || intendedEmpty) && L?.loadId && load.loadId && String(load.loadId) !== String(L.loadId)) {
      result.ok = false; result.error = `commitBoard: load identity mismatch (name resolved ${load.loadId}, expected ${L.loadId})`; planned.push({ L, curIds, result }); continue;
    }
    if (desired.length && hasUnmodeledDelivery(load)) {
      result.ok = false; result.error = 'commitBoard: load has a non-DO stop in a delivery slot — reorder skipped (verify in portal)'; planned.push({ L, curIds, result }); continue;
    }
    let plan: any;
    if (!desired.length && intendedEmpty) {
      if (!curIds.length) { result.ok = false; result.error = 'commitBoard: load already has no deliveries to remove'; planned.push({ L, curIds, result }); continue; }
      // EXECUTED-STOP GUARD for the cancel (the AVRT case's classic-path twin). NuVizz keeps a
      // stop the driver has already acted on even when a Save removes it — so a load carrying one
      // cannot truly be emptied, and pushing the cancel anyway half-applies it AND (since v0.54.18)
      // stamps finished work board-unplanned under a 60-minute grace. RWB has refused this up front
      // since Jul 22; emptying only ever rides THIS path, so the guard has to live here too. Reads
      // the load we already fetched — zero extra NuVizz calls. Fail-open on an absent/unknown
      // status, exactly like the RWB guard.
      const executed = (load.stops || [])
        .map((s: any) => ({ n: String(s?.stopNbr ?? ''), status: rawStopExecStatus(load, String(s?.stopNbr ?? '')) }))
        .find((x: any) => x.n && isExecutedStopStatus(x.status));
      if (executed) {
        result.ok = false;
        result.error = `commitBoard: stop ${executed.n} on ${loadNbrX} is already ${executed.status} — a load with an executed stop cannot be emptied (NuVizz keeps the stop and the route is not cancelled). Unplan it in the portal first, then refresh and re-Save.`;
        planned.push({ L, curIds, result }); continue;
      }
      plan = { ok: true, unchanged: false, removeStopIds: curIds, insertOrdered: [], cancelRoute: true };
    } else {
      plan = desired.length ? planSequence(curIds, desired) : { ok: true, unchanged: true, removeStopIds: [], insertOrdered: [] };
    }
    if (!plan.ok) { result.ok = false; result.error = plan.reason; planned.push({ L, curIds, result }); continue; }
    // Prefer a hash-like caller loadId (the board's same-day internal id); otherwise use the
    // loadHeader.loadId we just resolved — never let a non-canonical roster id become the routeId.
    planned.push({ L, load, hasLoad: true, loadId: trustableLoadId(L?.loadId) ? L.loadId : (load.loadId || L.loadId), loadNbr: loadNbrX, editHeader: toEditHeader(load.loadHeader), versionId: load.versionId, plan, curIds, want: desired.map((x) => String(x)), result });
  }

  const live = planned.filter((p) => p.result.ok && p.hasLoad);
  // Every stopId currently on any FETCHED load — lets Phase 2 tell a cross-load ARRIVAL (must have
  // been freed by a Phase-1 remove) from an unplanned/new stop (no current load → safe to insert).
  const holderOf = new Set<string>();
  for (const p of planned) for (const id of (p.curIds || [])) holderOf.add(String(id));
  const actuallyFreed = new Set<string>();   // removed by a SUCCESSFUL Phase-1 remove
  const inserted = new Set<string>();         // successfully (re)inserted in Phase 2

  // ── Phase 0.5 — anchor pre-insert (advanced: a NEW stop is the desired first delivery) ──
  // Insert that stop FIRST so it anchors the load, THEN Phase 1 can remove the current deliveries
  // without ever emptying the load (which would cancel it). Sequenced before any remove. If the
  // pre-insert fails we abort the load so Phase 1 does NOT strip it to zero stops.
  for (const p of live) {
    const anchorInsert = p.plan.anchorInsert ? String(p.plan.anchorInsert) : null;
    if (!anchorInsert) continue;
    // A cross-load anchor (a stop still on ANOTHER load) cannot be pre-inserted here: its source
    // frees it only in Phase 1, which runs AFTER this. Refuse rather than double-place it. (A truly
    // new/unplanned first delivery isn't in holderOf, so it passes.)
    if (!(p.curIds || []).includes(anchorInsert) && holderOf.has(anchorInsert)) {
      p.result.steps.push({ op: 'insertStops', ok: false, result: null, error: `anchor ${anchorInsert} is still on another load — move it from there first` });
      p.result.ok = false; p.aborted = true; continue;
    }
    const r = await fireSingle(requester, 'insertStops', { insertStopIds: [anchorInsert], loadId: p.loadId }, creds);
    p.result.steps.push({ op: 'insertStops', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
    if (!r.ok) { p.result.ok = false; p.aborted = true; }
    else {
      inserted.add(anchorInsert);
      // The pre-insert bumped this load's versionId; Phase 1's removeStops echoes versionId (a
      // version-checked full-header replace), so a STALE token would reject the remove and leave the
      // load in a wrong state. Re-fetch to refresh editHeader/versionId before the remove.
      if ((p.plan.removeStopIds || []).length && p.loadNbr) {
        const f = await fetchLoad(requester, String(p.loadNbr), creds);
        if (f.load) { p.editHeader = toEditHeader(f.load.loadHeader); p.versionId = f.load.versionId; }
      }
    }
  }

  // ── Phase 1 — all removes first (frees moved stops before any re-insert) ──
  for (const p of live) {
    if (p.aborted) continue;                 // anchor pre-insert failed → never strip this load
    const ids = p.plan.removeStopIds || [];
    if (!ids.length) continue;
    const r = await fireSingle(requester, 'removeStops', { removeStopIds: ids, editHeader: p.editHeader, versionId: p.versionId }, creds);
    // Removing ALL deliveries CANCELS the route; NuVizz may report that cancel as a non-OK body
    // (a "Cancelled route" message). For an INTENTIONAL empty-load we treat a cancellation response
    // as success. (Defensive: the exact cancel-response shape is pending a live confirm on a stable
    // load — the raw result is kept in the step so the first real cancel is diagnosable.)
    // …but a REFUSAL to cancel says "cancel" too ("cannot be cancelled — already
    // dispatched"), and the old /cancel/i test read that as success. Harmless when it
    // only mis-worded a message; not harmless now that a confirmed cancel stamps the
    // board unplanned under a 60-minute grace. cancelResponseConfirms is positive-only.
    const cancelled = !!p.plan.cancelRoute && cancelResponseConfirms(r);
    const ok = !!r.ok || cancelled;
    p.result.steps.push({ op: 'removeStops', ok, result: r, error: ok ? null : (r.error || 'failed'), cancelledRoute: (p.plan.cancelRoute && ok) || undefined });
    if (!ok) { p.result.ok = false; p.aborted = true; }
    else for (const id of ids) actuallyFreed.add(String(id));
  }

  // ── Phase 2 — rebuild (ordered, one-at-a-time) + assign + dispatch ──
  for (const p of live) {
    if (p.aborted) continue;
    let ok = true;
    for (const id of (p.plan.insertOrdered || [])) {
      const sid = String(id);
      // A cross-load ARRIVAL (not originally on THIS load) is only safe to insert once its source
      // load actually freed it. If the source failed Phase 0/1, skip rather than place a stop that
      // is still on another load. (Unplanned/new stops aren't in holderOf, so they pass.)
      if (!(p.curIds || []).includes(sid) && holderOf.has(sid) && !actuallyFreed.has(sid)) {
        p.result.steps.push({ op: 'insertStops', ok: false, result: null, error: `source load not freed for stop ${sid} — a load this move depends on failed` });
        ok = false; break;
      }
      const r = await fireSingle(requester, 'insertStops', { insertStopIds: [sid], loadId: p.loadId }, creds);
      p.result.steps.push({ op: 'insertStops', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) { ok = false; break; }
      inserted.add(sid);
    }
    // Never assign/dispatch a route we just EMPTIED/CANCELLED — the load no longer exists to crew,
    // and firing against it errors and flips the (successful) cancel to a reported failure.
    if (ok && !p.plan.cancelRoute && hasDriverId(p.L?.driverId)) {
      const r = await fireSingle(requester, 'assignDriver', { routeId: p.loadId, driverId: p.L.driverId }, creds);
      p.result.steps.push({ op: 'assignDriver', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) ok = false;
    }
    if (ok && !p.plan.cancelRoute && p.L?.dispatch) {
      const r = await fireSingle(requester, 'dispatchLoad', { routeId: p.loadId }, creds);
      p.result.steps.push({ op: 'dispatchLoad', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) ok = false;
    }
    if (!ok) p.result.ok = false;
  }

  // ── SERVER-SIDE BOARD WRITE-THROUGH for a CANCELLED (emptied) route ─────────
  // The RWB engine's #361 write-through only covers loads it sequences, and BOTH engines route
  // an empty-load save down this classic path — so a confirmed cancel used to leave the board
  // unchanged: every order NuVizz had just returned to Un-Planned kept showing planned on the
  // dead route until a scan happened to win against the demotion hold (TRAILER 6, Jul 30;
  // v0.54.17 made the last stop removable, opening this door). Stamp the load's own removed
  // deliveries unplanned. Ghost-guard at the SOURCE: the set comes from plan.removeStopIds —
  // OUR read of the load (curIds), never the client's removeStopNbrs — so a stop the dispatcher
  // struck off that the load never held is filtered before the board. A stop this same Save
  // re-planted onto another load (Phase 2 `inserted`) stays planned; a cross-engine move is safe
  // by ordering (the RWB write-through stamps its planned loads AFTER this). The unplanned
  // fields null loadNbr/routeName/routeSeq — no rows left grouped under the dead route — and
  // carry board_write_at, so the 60-min grace defends the cancel against a lagging list.
  // Best-effort: a board hiccup never fails the Save (the outcome rides the result journal).
  if (isFirestoreEnabled()) {
    const cancels = live.filter((p) => p.result.ok && p.plan?.cancelRoute === true);
    if (cancels.length) {
      const tenantET = String((creds as any)?.companyCode || 'DAVIS').toUpperCase();
      const boardDay = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.date ?? '')) ? String(payload.date) : etDayString();
      for (const p of cancels) {
        try {
          const nbrById = new Map<string, string>();
          for (const s of (p.load?.stops || [])) {
            const id = String(s?.stopId ?? ''); const n = String(s?.stopNbr ?? '');
            if (id && n) nbrById.set(id, n);
          }
          const unplannedStopNbrs = (p.plan.removeStopIds || [])
            .map((id: any) => String(id))
            .filter((id: string) => !inserted.has(id))
            .map((id: string) => nbrById.get(id))
            .filter((n: string | undefined): n is string => !!n);
          const r = await patchBoardPlan(tenantET, boardDay, {
            routeName: '', orderedStopNbrs: [], unplannedStopNbrs, driverName: null, at: new Date().toISOString(),
          });
          p.result.boardSync = { patched: r.patched, rescued: r.rescued, missing: r.missing, ...(r.missingNbrs?.length ? { missingNbrs: r.missingNbrs } : {}) };
        } catch (e: any) {
          p.result.boardSync = { error: e?.message || 'board write-through failed' };
        }
      }
    }
  }

  // Orphans: a stop that was FREED (removed from its source) and was meant to land on some load
  // (in a desired order) but its insert never succeeded — it is now UNPLANNED in NuVizz. Surfaced
  // so the dispatcher can re-Save. (A freed stop NOT in any desired order is an intended unplan.)
  const intendedOnSomeLoad = new Set<string>();
  for (const p of live) for (const id of (p.want || [])) intendedOnSomeLoad.add(String(id));
  const orphaned = [...actuallyFreed].filter((id) => intendedOnSomeLoad.has(id) && !inserted.has(id));

  // boardSync spreads in ONLY when the cancel write-through ran — a normal save's result stays
  // byte-identical to before (no new key, even an undefined one, for deepEqual consumers).
  const loads = planned.map((p) => ({ loadNbr: p.result.loadNbr, loadId: p.loadId ?? p.L?.loadId ?? null, ok: p.result.ok, error: p.result.error, steps: p.result.steps, ...(p.result.boardSync ? { boardSync: p.result.boardSync } : {}) }));
  return { ok: loads.every((l) => l.ok) && orphaned.length === 0, loads, orphaned };
}

/**
 * runOp — single entry for the handler. `op` is validated by the caller against the
 * allowlist. Returns a plain object (never throws for a *NuVizz* failure — those are
 * reported as { ok:false, error }); a malformed-payload throw from a builder propagates
 * so the handler maps it to a 400.
 */
/**
 * Standalone assignDriver / dispatchLoad (the Routes-panel driver dropdown). NuVizz SILENTLY
 * no-ops an assign/dispatch whose routeId isn't the INTERNAL loadHeader.loadId — it answers
 * "Success" while persisting nothing. The Routes panel may hand us a roster KeyColumn id (for a
 * Draft/empty load with no enriched stops) that is NOT guaranteed to be that internal id. So when
 * we have the load NUMBER, resolve the canonical loadHeader.loadId via load/info first and assign
 * against THAT — the same guard commitLoad/commitBoard already apply. (Enriched loads pass their
 * real internal id and this getLoad simply re-confirms it.)
 */
async function runAssignDispatch(requester: RequesterLike, op: SingleOp, payload: any, creds: WriteCreds): Promise<any> {
  let routeId = payload?.routeId ?? payload?.loadId ?? null;
  const loadNbr = (payload?.loadNbr != null && String(payload.loadNbr).trim() !== '' && !isHashLikeId(String(payload.loadNbr))) ? String(payload.loadNbr) : null;
  if (loadNbr) {
    const f = await fetchLoad(requester, loadNbr, creds);
    if (f.load?.loadId) routeId = f.load.loadId;
    else if (!trustableLoadId(routeId)) return { ok: false, error: `${op}: could not resolve the load's internal id (${loadMissDiag(loadNbr, f)}) — assign would silently no-op` };
  }
  if (!routeId) return { ok: false, error: `${op}: no routeId — cannot ${op === 'assignDriver' ? 'assign' : 'dispatch'}` };
  return fireSingle(requester, op, { ...payload, routeId }, creds);
}

// ── §I  async LOAD IMPORT executor — one call per load + the convergence recipe ──
//
// The NEW sequencing path (see nuvizz-write-ops.mts §I for the full contract): one
// POST load/update/default per touched load sets that load's complete stop list in exact
// array order — no anchors, no removes, no one-at-a-time inserts. UAT-verified DAVISV5
// Jul 1 2026. The ENGINE CHOICE LIVES IN THE APP: the Compare panel's engine toggle sends
// useImport on the Save payload, which is the only routing switch (plus the handler's
// NUVIZZ_WRITE_ENABLED kill switch that gates ALL writes, exactly as before). The
// NUVIZZ_LOAD_IMPORT env var survives only as an emergency hard-off brake. The classic
// anchor engine remains the default whenever the toggle is off.
//
// CONVERGENCE (mandatory after EVERY order-affecting import — a 200 ack is async and can
// silently not land): poll GET load/info every ~pollMs up to a phase budget, comparing the
// load's deliveryOrder() (sorted by to.seq) to the requested stopNbr order. Not converged →
// re-send the SAME import (also what seats a newly-added stop, which APPENDS on its first
// import). Still stuck → send the array REVERSED then the desired order (verified to unstick
// the async worker's stale-state window). Never trust the 200 alone.
//
// Call cost (worst case, defaults): ≤4 imports + ≤18 polls ≈ 22 counted calls per load;
// a clean first-poll converge is 1 import + 1 read. NB: the default budgets (~90s total)
// exceed a synchronous Netlify function's ~26s window — enabling this path for real routes
// includes moving the poll into a background function (or passing a tighter
// payload.convergence budget); that wiring is part of the enable-with-sign-off step.

/** SAFETY GATE for the import path. Since the Jul 2 2026 incident (production NuVizz treats
 *  import REFERENCE stops as full replaces — freight wiped on 10 orders + 10 unplanned
 *  duplicates created, violating the UAT-verified "referenced stops keep their other fields"
 *  contract) the import engine is DISABLED unless the server explicitly re-enables it:
 *  NUVIZZ_LOAD_IMPORT must be set to 1/true/on/yes. Unset (the normal state) now BLOCKS the
 *  import path — the app's in-panel toggle still picks the engine, but only once the server
 *  says imports are safe again. Read at call time so flipping it needs no code deploy. */
export function importEngineEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test(String(process.env.NUVIZZ_LOAD_IMPORT ?? '').trim());
}
export function loadImportBlocked(): boolean {
  return !importEngineEnabled();
}

/** Injectable pacing so the convergence loop is unit-testable with no real clock. */
export interface ImportPacing {
  pollMs?: number;        // delay between load/info polls (default 5000)
  phaseWaitMs?: number;   // per-phase poll budget (default 30000 → 3 phases ≈ the ~90s recipe)
  sleep?: (ms: number) => Promise<void>;
  /** QUICK mode (the board Save): fire the import + ONE short poll phase, then return
   *  `pending: true` instead of burning the full resend/reverse recipe inside a single
   *  function invocation (a sync Netlify function gets ~26s TOTAL). The CLIENT drives the
   *  rest of the convergence: cheap getLoad polls + a re-Save resend until the read-back
   *  matches. Never reports ok without a matching read-back, same as the full recipe. */
  quick?: boolean;
  /** Skip even the quick confirm poll — fire the import and return pending immediately.
   *  Used when a Save carries MULTIPLE import loads: the fixed confirm budget doesn't scale,
   *  and the client verifier polls every load anyway. */
  skipConfirm?: boolean;
  /** UNSTICK escalation (client ladder's last resort): fire the array REVERSED, one beat,
   *  then the DESIRED order — the §10.1-verified cure for the async worker's stuck-append
   *  state (same-direction re-sends demonstrably don't clear it: the Jul 2 2026 SUW session
   *  appended the two membership-changed stops to the tail across 9 same-direction imports).
   *  Skips the initial import (the desired order was already sent); 2 update calls + 1 poll. */
  unstick?: boolean;
}
const realSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

// One poll phase: read load/info up to `polls` times, pollMs apart, until the load's
// delivery order equals `want` (array equality = order AND membership — an omitted stop
// that is still on the load means not-converged). A brand-new load 404s until the async
// worker creates it; fetchLoad returns null then, which simply reads as not-yet-converged.
async function pollUntilConverged(
  requester: RequesterLike, loadNbr: string, want: string[], creds: WriteCreds,
  pollMs: number, polls: number, sleep: (ms: number) => Promise<void>,
): Promise<{ converged: boolean; seen: string[] | null; loadId: any; reads: number; seenHistory: Array<string[] | null>; stopIds: Record<string, string> | null }> {
  let seen: string[] | null = null, loadId: any = null, reads = 0;
  let stopIds: Record<string, string> | null = null;   // stopNbr → NuVizz stopId, harvested from the SAME read
  const seenHistory: Array<string[] | null> = [];   // EVERY poll's read-back, for the journal (directive #1)
  for (let i = 0; i < polls; i++) {
    await sleep(pollMs);
    const f = await fetchLoad(requester, loadNbr, creds);
    reads++;
    if (f.load) {
      loadId = f.load.loadId ?? loadId;
      // HARVEST stopIds off the convergence read (work item A): inline-created stops get their
      // NuVizz internal id from the load/info we were reading anyway — zero extra calls. Keyed
      // by the RAW stopNbr as NuVizz echoes it (callers normalize for comparison, not storage).
      const ids: Record<string, string> = {};
      for (const s of (f.load.stops || [])) if (s?.stopNbr != null && s?.stopId != null) ids[String(s.stopNbr)] = String(s.stopId);
      if (Object.keys(ids).length) stopIds = ids;
      seen = deliveryOrder(f.load);
      seenHistory.push(seen);
      // STRICT: a mid-rebuild read can list all stops before the worker assigns their to.seq —
      // a missing seq degrades the sort to raw array order, which could read as a FALSE
      // convergence (and then assign/dispatch an order the worker may still change). Require a
      // real numeric seq on every delivery before trusting the comparison.
      const seqsComplete = (f.load.stops || [])
        .filter((s: any) => String(s?.stopType ?? 'DO').toUpperCase() !== 'PU')
        .every((s: any) => s?.stopSeq != null && Number.isFinite(Number(s.stopSeq)));   // null coerces to 0 — check presence first
      // Comparison is NORMALIZED both sides (trim/case/zero-padding — sameOrder/normStopNbr):
      // NuVizz's padding/typing must never read as "not converged". (Verified from the Jul 2
      // journal that today's mismatches were REAL order differences, not padding — but the
      // normalization guard costs nothing and closes that class for good.)
      if (seqsComplete && sameOrder(seen, want)) {
        return { converged: true, seen, loadId, reads, seenHistory, stopIds };
      }
    } else {
      seenHistory.push(null);   // 404/no-load read (brand-new load not created yet)
    }
  }
  return { converged: false, seen, loadId, reads, seenHistory, stopIds };
}

/**
 * runImportLoad — fire ONE load's import and drive it to convergence.
 * payload: { load: { loadHeader, stops }, convergence?: ImportPacing }
 * Returns { ok, converged, loadNbr, loadId, requestedOrder, seenOrder, steps[], error }.
 * ok=true ONLY when the read-back order matches the request — never on the async ack alone.
 */
export async function runImportLoad(requester: RequesterLike, payload: any, creds: WriteCreds, pacing?: ImportPacing): Promise<any> {
  if (loadImportBlocked()) {
    return { ok: false, gated: true, error: 'load-import engine is disabled on the server (emergency brake: prod imports wipe freight — NUVIZZ_LOAD_IMPORT must be explicitly re-enabled) — use the classic engine' };
  }
  const load = payload?.load;
  const loadNbr = String(load?.loadHeader?.loadNbr ?? '').trim();
  if (!loadNbr || !Array.isArray(load?.stops) || !load.stops.length) {
    // buildImportBody re-validates in depth; this early check just yields a friendlier error
    // before any pacing math. An empty stops[] is NEVER sent (use load/cancel to retire a load).
    return { ok: false, error: 'importLoad: payload.load needs loadHeader.loadNbr and a non-empty stops[]' };
  }
  const p = { ...(pacing || {}), ...(payload?.convergence || {}) };
  const pollMs = Math.max(250, Number(p.pollMs) || 5000);
  const phaseWaitMs = Math.max(pollMs, Number(p.phaseWaitMs) || 30000);
  const polls = Math.max(1, Math.ceil(phaseWaitMs / pollMs));
  const sleep = p.sleep || realSleep;

  // The requested visit order = the stops[] array order (deliveries; a PU never sorts in
  // deliveryOrder, so exclude it from the comparator too).
  const want = load.stops
    .filter((s: any) => String(s?.stopType ?? 'DO').toUpperCase() !== 'PU')
    .map((s: any) => String(s?.stopNbr ?? '')).filter(Boolean);

  const steps: any[] = [];
  let loadId: any = null;
  let stopIds: Record<string, string> | null = null;   // harvested from the convergence read (item A)
  const fire = async (stops: any[], label: string) => {
    const r = await fireSingle(requester, 'importLoad', { load: { loadHeader: load.loadHeader, stops } }, creds);
    // FORENSICS: keep exactly what was sent (header + stop order) and exactly what NuVizz said
    // (verbatim ack). An async import that "succeeds" and never lands is only diagnosable from
    // this pair — it rides the op ledger into Firestore and the client console.
    steps.push({
      op: 'importLoad', label, ok: !!r.ok, appMessageLogId: r.appMessageLogId ?? null,
      ackText: r.ackText ?? null, httpStatus: r.httpStatus ?? null,
      sentHeader: load.loadHeader, sentStopNbrs: stops.map((s: any) => String(s?.stopNbr ?? '')),
      error: r.ok ? null : (r.error || 'failed'),
    });
    try { console.log('[nuvizz-write] importLoad', label, JSON.stringify({ loadNbr, header: load.loadHeader, stopNbrs: stops.map((s: any) => s?.stopNbr), ack: r.ackText ?? r.error ?? null })); } catch { /* log only */ }
    return r;
  };
  const poll = async (label: string) => {
    const c = await pollUntilConverged(requester, loadNbr, want, creds, pollMs, polls, sleep);
    steps.push({ op: 'converge', label, ok: c.converged, reads: c.reads, seen: c.seen, seenHistory: c.seenHistory });
    loadId = c.loadId ?? loadId;
    stopIds = c.stopIds ?? stopIds;
    return c;
  };
  // Per-save call anatomy (directive #4): X load/update + Y load/info fired by THIS invocation.
  // Rides the result into the journal + client console so every Save self-reports its cost.
  const anatomy = () => ({
    updates: steps.filter((s) => s.op === 'importLoad').length,
    infos: steps.filter((s) => s.op === 'converge').reduce((n, s) => n + (s.reads || 0), 0),
  });
  const done = (converged: boolean, seen: string[] | null) => ({
    ok: converged, converged, loadNbr, loadId, requestedOrder: want, seenOrder: seen, steps, calls: anatomy(),
    // stopIds (stopNbr → internal id) rides out ONLY from a converged read-back — the client
    // enriches inline-created stops with their NuVizz ids at zero extra call cost (item A).
    stopIds: converged ? stopIds : null,
    error: converged ? null : `importLoad: order did not converge after re-send + reverse-unstick — verify load ${loadNbr} in the portal before retrying`,
  });

  // UNSTICK escalation (client ladder, quick): the desired order was ALREADY sent and the worker
  // is in the stuck-append state — same-direction re-sends don't clear it (proven Jul 2 2026:
  // nine same-direction imports, the two membership-changed stops appended every time). The
  // §10.1-verified cure: REVERSED, one beat, then DESIRED. One invocation, 2 updates + 1 poll.
  if (p.unstick === true) {
    const rev = await fire([...load.stops].reverse(), 'reverse-unstick');
    if (!rev.ok) return { ok: false, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: null, steps, calls: anatomy(), error: rev.error || 'reverse-unstick rejected' };
    await sleep(pollMs); // one beat between the reversed and forward imports
    const fwd = await fire(load.stops, 'forward-after-reverse');
    if (!fwd.ok) return { ok: false, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: null, steps, calls: anatomy(), error: fwd.error || 'forward import rejected' };
    if (p.skipConfirm === true) {   // multi-load unstick: the client polls; keep the invocation inside budget
      return { ok: false, pending: true, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: null, steps, calls: anatomy(), error: null };
    }
    const cu = await poll('after-unstick');
    if (cu.converged) return done(true, cu.seen);
    return { ok: false, pending: true, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: cu.seen, steps, calls: anatomy(), error: null };
  }

  // Phase 1 — the import, then poll.
  let r = await fire(load.stops, 'import');
  if (!r.ok) return { ok: false, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: null, steps, calls: anatomy(), error: r.error || 'import rejected' };
  if (p.skipConfirm === true) {
    return { ok: false, pending: true, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: null, steps, calls: anatomy(), error: null };
  }
  let c = await poll('after-import');
  if (c.converged) return done(true, c.seen);
  if (p.quick === true) {
    // QUICK mode: the import is fired and accepted, just not CONFIRMED yet. Hand convergence
    // to the caller (the client polls getLoad on a backoff + escalates) instead of blocking
    // this invocation.
    return { ok: false, pending: true, converged: false, loadNbr, loadId, requestedOrder: want, seenOrder: c.seen, steps, calls: anatomy(), error: null };
  }

  // Phase 2 — re-send the SAME import (the recipe's first unstick; also the reorder pass
  // that seats a newly-added stop, which appends on its first import).
  r = await fire(load.stops, 'resend');
  if (r.ok) { c = await poll('after-resend'); if (c.converged) return done(true, c.seen); }

  // Phase 3 — REVERSED then desired (verified to unstick the async worker), then poll.
  await fire([...load.stops].reverse(), 'reverse-unstick');
  await sleep(pollMs); // give the worker one beat between the reversed and forward imports
  r = await fire(load.stops, 'forward-after-reverse');
  c = await poll('after-reverse-forward');
  return done(c.converged, c.seen);
}

/**
 * runCommitImport — the import-path Save: one import per touched load, applied strictly in
 * the caller's array order. For a cross-load move (A → B) the caller MUST list the SOURCE
 * load (without the stop) BEFORE the destination (with it) — a "steal" while the stop is
 * still planned on A is untested and never relied on. A load that fails to converge stops
 * the batch (later loads may depend on its unplans); already-imported loads are reported.
 * payload: { loads: [{ loadHeader, stops }...], convergence?: ImportPacing }
 */
export async function runCommitImport(requester: RequesterLike, payload: any, creds: WriteCreds, pacing?: ImportPacing): Promise<any> {
  if (loadImportBlocked()) {
    return { ok: false, gated: true, error: 'load-import engine is disabled on the server (emergency brake: prod imports wipe freight — NUVIZZ_LOAD_IMPORT must be explicitly re-enabled) — use the classic engine' };
  }
  const loadsIn: any[] = Array.isArray(payload?.loads) ? payload.loads : [];
  if (!loadsIn.length) return { ok: true, loads: [] };
  const results: any[] = [];
  for (const L of loadsIn) {
    const r = await runImportLoad(requester, { load: L, convergence: payload?.convergence }, creds, pacing);
    results.push(r);
    if (!r.ok) break; // sources-before-destinations: a stuck source must not let a destination "steal"
  }
  const skipped = loadsIn.length - results.length;
  return { ok: results.every((r) => r.ok) && skipped === 0, loads: results, skipped };
}

/**
 * runCommitBoardImport — the SAME board Save (identical payload + result shape as
 * runCommitBoard) executed through the TWO-LEVER import engine (rebuilt after the Jul 2
 * incident — see the §I contract correction in nuvizz-write-ops.mts).
 *
 * Per order-changing load:
 *   LEVER 1 — MEMBERSHIP. Stops to ADD (unplanned orders / staged cross-load arrivals) are
 *   planned with ONE bulk insertStops by stopId — the REAL records; an existing stop's number
 *   NEVER rides the import (rule 3: the import would CLONE it). Unplans happen declaratively
 *   by omission from lever 2 (the omitted on-load record survives, data intact). After an
 *   insert the load is RE-READ so lever 2 echoes the arrivals' actual on-load records.
 *   LEVER 2 — ORDER. One import whose stops[] are FULL ECHOES (importEchoFromRaw — freight +
 *   references + from-block; rule 2: a matched stop is full-replaced, so a partial entry
 *   blanks fields) in the exact desired order, then the convergence recipe, then
 *   assign/dispatch. Brand-new orders (newStops rows) may ride the import as full payloads
 *   ONLY after a per-number existence read proves the number absent (a collision would
 *   clone). A STRUCTURAL GUARD refuses any entry whose number is not on the just-read load
 *   (or proven-absent-new) — the clone case is unrepresentable, not just avoided.
 *
 * Loads the import path can't or shouldn't handle fall back to the UNCHANGED legacy engine
 * in the same Save: emptyLoad (cancel — NEVER an empty import), assign/dispatch-only, a
 * loadId-only add with no resolvable load number (#328), and any load whose number can't be
 * resolved. Cross-load moves run sources-before-destinations (the source's omission-unplan
 * must CONVERGE before the destination inserts); a genuine cycle (a swap) is refused — save
 * it as two steps. The steal guard (stop still planned on a load outside this Save) matches
 * the legacy engine's.
 */
export async function runCommitBoardImport(requester: RequesterLike, payload: any, creds: WriteCreds, pacing?: ImportPacing): Promise<any> {
  const loadsIn: any[] = Array.isArray(payload?.loads) ? payload.loads : [];
  if (!loadsIn.length) return { ok: true, loads: [], orphaned: [] };
  // Board pacing: QUICK mode — fire the import + a short confirm poll, and hand unconfirmed
  // loads back as `pending` for the CLIENT to verify (getLoad polls + re-Save resend). The full
  // resend/reverse recipe cannot fit a sync function's budget (the 10s default killed the first
  // live Save mid-flight); quick keeps a 1-2 load Save well inside the 26s window.
  // ONE confirm poll at ~6s (was 2 polls at 3s): prod's async worker demonstrably takes 30-90s
  // to seat an import, so a 3s poll never confirms and just spends a load/info. The client's
  // backoff ladder (6/10/15/25s) owns the wait; this single poll only catches the fast case.
  const boardPacing: ImportPacing = { pollMs: 6000, phaseWaitMs: 6000, quick: true, ...(pacing || {}), ...(payload?.convergence || {}) };
  const clientOrigin = payload?.origin ?? payload?.settings?.origin ?? null;
  // INLINE STOP CREATION (work item A): a Save may carry per-load `newStops` (StopRow-shaped
  // rows for orders that do NOT exist in NuVizz yet). Those ride the import's stops[] as FULL
  // payloads (buildStopPayload) — the §10.1 create-with-order contract makes ONE import create
  // the load AND its stops. No per-stop stop/sync/update pre-creates, no stop/info echo reads.
  // Building a full payload needs the batch's OriginSettings: payload.settings = { origin:
  // {name,addr1,city,state,zip[,addr2]}, serviceDate:'YYYY-MM-DD'[, timeZone] }.
  const stopSettings = (payload?.settings?.origin && payload?.settings?.serviceDate) ? payload.settings : null;

  const legacy: any[] = [];   // loads the legacy engine keeps handling (see doc above)
  const imp: any[] = [];      // { L, loadNbr, load(normalized), refs[], curNbrs:Set, result }
  const batchNbrs = new Set<string>();
  for (const l of loadsIn) { const v = String(l?.loadNbr ?? '').trim(); if (v && !isHashLikeId(v)) batchNbrs.add(v); }

  // ── resolve + read + build refs per order-changing load ──
  for (const L of loadsIn) {
    const orderedNbrs: string[] | null = Array.isArray(L?.orderedStopNbrs) ? L.orderedStopNbrs.map((x: any) => String(x)).filter(Boolean) : null;
    if (L?.emptyLoad === true || !orderedNbrs || orderedNbrs.length === 0) { legacy.push(L); continue; }
    const result: any = { loadNbr: L?.loadNbr ?? null, ok: true, steps: [], error: null };

    // Inline-new rows for THIS load, keyed by normalized stopNbr (item A). Each row is
    // StopRow-shaped and MUST carry its stopNbr (the order number is the convergence key).
    const newRows = new Map<string, any>();
    for (const row of (Array.isArray(L?.newStops) ? L.newStops : [])) {
      const n = row?.stopNbr != null && String(row.stopNbr).trim() !== '' ? normStopNbr(row.stopNbr) : '';
      if (n) newRows.set(n, row);
    }
    if (newRows.size && !stopSettings) {
      result.ok = false; result.error = 'commitBoard(import): newStops need payload.settings ({origin, serviceDate}) to build full stop payloads';
      imp.push({ L, loadNbr: L?.loadNbr ?? null, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue;
    }

    // A card with NEITHER identifier could probe-resolve a cross-load arrival's SOURCE load and
    // then declaratively rebuild the WRONG load — refuse up front (same rule as the legacy engine).
    if (!L?.loadNbr && !L?.loadId) {
      result.ok = false; result.error = 'commitBoard(import): loadNbr or loadId required';
      imp.push({ L, loadNbr: null, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue;
    }

    // Resolve the human load number (same ladder as the legacy engine).
    let loadNbrX = (L?.loadNbr != null && String(L.loadNbr).trim() !== '' && !isHashLikeId(String(L.loadNbr))) ? String(L.loadNbr) : null;
    if (!loadNbrX && orderedNbrs[0]) loadNbrX = await resolveLoadNbrByStopNbr(requester, orderedNbrs[0], creds);
    if (!loadNbrX && trustableLoadId(L?.loadId)) loadNbrX = await resolveLoadNbrById(requester, L.loadId, creds);
    if (!loadNbrX && trustableLoadId(L?.loadId) && orderedNbrs[0]) {
      // EMPTY Draft load known only by its internal id (the live-tenant state that refused every
      // build-from-unplanned Save): SEED it with the first desired stop via loadId-keyed
      // insertstops, then read the stop back for the load's real number. The import rebuild that
      // follows seats the seeded stop in its proper slot.
      const seed = await resolveLoadNbrBySeeding(requester, L.loadId, orderedNbrs[0], creds);
      result.steps.push({ op: 'seedLoad', ok: !!seed.loadNbr, seeded: seed.seeded, loadNbr: seed.loadNbr, error: seed.error || null });
      if (seed.loadNbr) {
        loadNbrX = seed.loadNbr;
        // Surface the physical side effect: even if a later step fails, the dispatcher must know
        // this stop is now PLANNED on this load (re-Saving the SAME card self-heals).
        result.seededStopNbr = orderedNbrs[0]; result.seededLoadNbr = seed.loadNbr;
      }
      else { result.ok = false; result.error = `commitBoard(import): ${seed.error || 'could not resolve the load number'}`; imp.push({ L, loadNbr: null, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue; }
    }
    if (!loadNbrX) { legacy.push(L); continue; }   // e.g. loadId-only pure add — the #328 legacy path still works
    result.loadNbr = loadNbrX;

    const f = await fetchLoad(requester, loadNbrX, creds);
    const allInline = newRows.size > 0 && orderedNbrs.every((n) => newRows.has(normStopNbr(n)));
    let load = f.load;
    let createMode = false;
    if (!load) {
      // CREATE MODE (item A): a load number NuVizz doesn't know + EVERY ordered stop supplied
      // inline = a brand-new load built by ONE import (§10.1 create-with-order: new loadNbr +
      // full stop payloads creates the load AND its stops). Anything else unresolved is still
      // an error — a rebuild needs the load's own record to echo from.
      if (!allInline) {
        result.ok = false; result.error = `commitBoard(import): load not found (${loadMissDiag(loadNbrX, f)})`;
        imp.push({ L, loadNbr: loadNbrX, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue;
      }
      createMode = true;
    }
    // A CREATE aimed at a load that already EXISTS with deliveries would declaratively REBUILD it
    // (the import would replace its whole stop set) — refuse; that edit belongs on the board.
    if (load && L?.createNew === true) {
      const existing = (load.stops || []).filter((s: any) => s?.stopNbr != null && String(s?.stopType ?? 'DO').toUpperCase() !== 'PU');
      if (existing.length) {
        result.ok = false; result.error = `commitBoard(import): load ${loadNbrX} already carries ${existing.length} stop(s) — a new-load create would rebuild it; open it from the board to edit it instead`;
        imp.push({ L, loadNbr: loadNbrX, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue;
      }
    }
    // Same wrong-instance guard as the legacy engine: a recurring NAME resolving to a different
    // day's load must never be rebuilt. (Create mode resolved nothing, so there is nothing to check.)
    if (load && L?.loadId && load.loadId && String(load.loadId) !== String(L.loadId)) {
      result.ok = false; result.error = `commitBoard(import): load identity mismatch (name resolved ${load.loadId}, expected ${L.loadId})`;
      imp.push({ L, loadNbr: loadNbrX, arrivals: [], orderedNbrs: [], curNbrs: new Set(), result }); continue;
    }
    // Only an IDENTITY-VERIFIED number may vouch for the steal guard — adding it before the check
    // above could let a mis-resolved number bless pulls off a load that isn't really in this Save.
    batchNbrs.add(loadNbrX);

    const rawByNbr = new Map<string, any>();
    for (const rs of (load?.rawStops || [])) { const st = rs?.stop || rs || {}; if (st.stopNbr != null) rawByNbr.set(String(st.stopNbr), rs); }

    // ── TWO-LEVER CLASSIFICATION (Jul 2 correction) ──
    // Every ordered stop is exactly one of:
    //   ON-LOAD  → an import entry, built later as a FULL ECHO of the (fresh) load read;
    //   ARRIVAL  → an EXISTING stop not on this load. NEVER an import entry (rule 3: the
    //              import would CLONE it) — it is planned with insertStops by stopId (the
    //              REAL record) in the fire phase, then echoed off the post-insert re-read;
    //   INLINE   → a brand-new order (newStops row) whose number is PROVEN ABSENT by a
    //              per-number existence read — the import creates it (full payload).
    // ARRIVAL reads run IN PARALLEL (getStop resolves stopId + the steal guard); INLINE
    // existence gates run in the same sweep. Any other number refuses the load.
    const inlineNbrs = orderedNbrs.filter((n) => !rawByNbr.has(n) && newRows.has(normStopNbr(n)));
    const missing = orderedNbrs.filter((n) => !rawByNbr.has(n) && !newRows.has(normStopNbr(n)));
    const fetched = new Map<string, any>(await Promise.all([...missing, ...inlineNbrs].map(async (n): Promise<[string, any]> => {
      try { return [n, await fireSingle(requester, 'getStop', { stopNbr: n }, creds)]; }
      catch (e: any) { return [n, { ok: false, error: e?.message || 'getStop failed' }]; }
    })));
    const arrivals: Array<{ nbr: string; stopId: string; srcLoadNbr?: string }> = [];
    const newAbsent = new Set<string>();   // normalized inline numbers PROVEN absent (safe to create)
    const originDonors: any[] = [];   // "from" addresses off the added stops — origin for an EMPTY load
    // Service date for synthesized echo windows (an echo entry is address + schedule at minimum).
    const svcDate = (String(load?.loadHeader?.earliestStartDttm || '').match(/^\d{4}-\d{2}-\d{2}/) || [null])[0]
      || (stopSettings ? String(stopSettings.serviceDate) : null);
    let err: string | null = null;
    for (const nbr of orderedNbrs) {
      if (rawByNbr.has(nbr)) continue;   // ON-LOAD — echoed in the fire phase
      const rowNew = newRows.get(normStopNbr(nbr));
      if (rowNew) {
        // INLINE CREATION — allowed ONLY when the number exists nowhere. A colliding number
        // would make the import CLONE the existing record (rule 3), so a found stop refuses
        // the load; only an explicit 404 proves absence (a transient read failure must never
        // be read as "absent" — that is exactly the clone hole).
        const gs = fetched.get(nbr);
        if (gs?.ok && gs.stop?.stopId) {
          err = `commitBoard(import): order # ${nbr} already exists in NuVizz (stop id ${gs.stop.stopId}) — creating it inline would CLONE it; plan the existing order from the board instead`; break;
        }
        if (!(gs?.httpStatus === 404)) {
          err = `commitBoard(import): could not verify order # ${nbr} is new (stop read ${gs?.httpStatus ?? 'failed'}) — refusing to create it (a collision would clone)`; break;
        }
        newAbsent.add(normStopNbr(nbr));
        const full = buildStopPayload({ ...rowNew, stopNbr: String(rowNew.stopNbr) }, stopSettings);
        if (full?.from?.address) originDonors.push({ stop: { from: { address: full.from.address } } });
        continue;
      }
      // ARRIVAL — an existing stop to PLAN here (insertStops, the real record). Steal guard
      // unchanged: its source must be this load or a load in this Save.
      const gs = fetched.get(nbr);
      const srcNbr = gs?.ok ? String(gs.stop?.assignedLoadNbr ?? '').trim() : '';
      if (!gs?.ok || !gs.stop?.stopId) { err = `commitBoard(import): stop ${nbr} could not be read for planning (stale board — refresh and retry)`; break; }
      if (srcNbr && srcNbr !== loadNbrX && !batchNbrs.has(srcNbr)) {
        err = `commitBoard(import): stop ${nbr} is still planned on load ${srcNbr}, which is not part of this Save — open that load in Compare so the move is staged`; break;
      }
      if (gs.stop.fromAddress) originDonors.push({ stop: { from: { address: gs.stop.fromAddress } } });
      arrivals.push({ nbr, stopId: String(gs.stop.stopId), srcLoadNbr: srcNbr && srcNbr !== loadNbrX ? srcNbr : undefined });
    }
    if (err) { result.ok = false; result.error = err; imp.push({ L, loadNbr: loadNbrX, arrivals: [], orderedNbrs, curNbrs: new Set(), result }); continue; }
    imp.push({ L, loadNbr: loadNbrX, load, createMode, orderedNbrs, arrivals, newAbsent, svcDate, originDonors, curNbrs: new Set(rawByNbr.keys()), result, addReads: missing.length + inlineNbrs.length });
  }

  // ── legacy subset (unchanged engine) ──
  const legacyResult = legacy.length
    ? await runCommitBoard(requester, { ...payload, loads: legacy }, creds)
    : { ok: true, loads: [], orphaned: [] };

  // ── order the imports: sources before destinations (a destination's arrival must be freed
  //    by its source's import first; a stop is never "stolen" while still planned elsewhere) ──
  const live = imp.filter((p) => p.result.ok);
  const ordered: any[] = [];
  const pending = new Set(live);
  // A load p WAITS ON load q when one of p's ARRIVALS is coming off q (q must unplan it —
  // via its own import's omission — before p may insertStops it; the real record can only
  // be on one load).
  const waitsOnQ = (p: any, q: any) => q !== p && p.arrivals.some((a: any) =>
    (a.srcLoadNbr && String(q.loadNbr) === String(a.srcLoadNbr)) || q.curNbrs.has(a.nbr));
  while (pending.size) {
    let emitted = false;
    for (const p of [...pending]) {
      const waitsOn = [...pending].some((q) => waitsOnQ(p, q));
      if (!waitsOn) { ordered.push(p); pending.delete(p); emitted = true; }
    }
    if (!emitted) {   // a cycle (e.g. two loads swapping stops) — refuse those loads, keep the rest honest
      for (const p of pending) { p.result.ok = false; p.result.error = 'commitBoard(import): circular cross-load move (a swap) — save it in two steps'; }
      pending.clear();
    }
  }

  // ── one import per load (+ convergence), then assign/dispatch ──
  // With MULTIPLE import loads, the fixed confirm budget can't cover them inside one function
  // window — fire each import and return them ALL as pending immediately; the client verifier
  // polls every load anyway. (Single-load Saves keep the in-function quick confirm.)
  const perLoadPacing: ImportPacing = ordered.length > 1 ? { ...boardPacing, skipConfirm: true } : boardPacing;
  // Track per-load outcome so a DESTINATION never fires while a load it depends on hasn't
  // CONFIRMED freeing its stop — a pending/failed/refused source must halt its destinations
  // (the cross-load "steal" is untested and never relied on; matches runCommitImport's break).
  const outcome = new Map<string, string>();   // loadNbr → 'converged' | 'pending' | 'failed'
  for (const p of imp) if (!p.result.ok && p.loadNbr) outcome.set(String(p.loadNbr), 'failed');
  const dependsOnUnconfirmed = (p: any) => imp.some((q) => q !== p && q.loadNbr
    && waitsOnQ(p, q)
    && outcome.get(String(q.loadNbr)) !== 'converged');
  for (const p of ordered) {
    if (dependsOnUnconfirmed(p)) {
      p.result.ok = false;
      p.result.error = 'commitBoard(import): a load this move depends on has not confirmed yet — Save again once it lands';
      outcome.set(String(p.loadNbr), 'failed');
      continue;
    }
    let loadId: any = trustableLoadId(p.L?.loadId) ? p.L.loadId : (p.load?.loadId ?? null);
    let inserts = 0, extraInfos = 0;
    try {
      // ── LEVER 1: MEMBERSHIP — plan the arrivals with ONE bulk insertStops (the REAL records,
      // by stopId; bulk geo-scrambles the order but lever 2 owns ordering). Then RE-READ the
      // load so the ordering entries echo the arrivals' actual on-load records. An arrival is
      // NEVER an import entry (Jul 2 rule 3: the import would clone it).
      let loadX = p.load;   // normalized load whose rawStops feed the echoes (null in create mode)
      if (p.arrivals.length) {
        if (!loadId) { p.result.ok = false; p.result.error = 'commitBoard(import): loadId unresolved for insertStops'; outcome.set(String(p.loadNbr), 'failed'); continue; }
        const ins = await fireSingle(requester, 'insertStops', { insertStopIds: p.arrivals.map((a: any) => a.stopId), loadId }, creds);
        inserts = 1;
        p.result.steps.push({ op: 'insertStops', ok: !!ins.ok, stopIds: p.arrivals.map((a: any) => a.stopId), result: ins, error: ins.ok ? null : (ins.error || 'failed') });
        if (!ins.ok) { p.result.ok = false; p.result.error = `commitBoard(import): planning ${p.arrivals.length} stop(s) failed: ${ins.error || 'insertStops failed'}`; outcome.set(String(p.loadNbr), 'failed'); continue; }
        const f2 = await fetchLoad(requester, String(p.loadNbr), creds);
        extraInfos = 1;
        if (!f2.load) { p.result.ok = false; p.result.error = `commitBoard(import): load unreadable after planning (${loadMissDiag(p.loadNbr, f2)}) — the ${p.arrivals.length} stop(s) ARE planned; Save again to set the order`; outcome.set(String(p.loadNbr), 'failed'); continue; }
        loadX = f2.load;
      }

      // ── LEVER 2: ORDER — one import whose entries are FULL ECHOES of the load's own records
      // (freight + references included; a partial entry would blank fields on the matched stop),
      // plus full payloads for the PROVEN-ABSENT inline creations. STRUCTURAL GUARD: any other
      // number refuses the import — an off-load number in stops[] is exactly the clone bug.
      const rawByNbr2 = new Map<string, any>();
      for (const rs of (loadX?.rawStops || [])) { const st = rs?.stop || rs || {}; if (st.stopNbr != null) rawByNbr2.set(String(st.stopNbr), rs); }
      const stops: any[] = [];
      let entryErr: string | null = null;
      for (const nbr of p.orderedNbrs) {
        const raw = rawByNbr2.get(nbr);
        if (raw) {
          const echo = importEchoFromRaw(raw, p.svcDate);
          if (!echo) { entryErr = `commitBoard(import): stop ${nbr} on load ${p.loadNbr} has no usable delivery address to echo — refresh and retry`; break; }
          stops.push(echo);
          continue;
        }
        const rowNew = p.newAbsent?.has(normStopNbr(nbr)) ? (Array.isArray(p.L?.newStops) ? p.L.newStops.find((r: any) => normStopNbr(r?.stopNbr) === normStopNbr(nbr)) : null) : null;
        if (rowNew) { stops.push(buildStopPayload({ ...rowNew, stopNbr: String(rowNew.stopNbr) }, stopSettings)); continue; }
        entryErr = `commitBoard(import): stop ${nbr} is not on load ${p.loadNbr} after planning — refusing to import it (an off-load number would be CLONED); Save again`;
        break;
      }
      if (entryErr) { p.result.ok = false; p.result.error = entryErr; outcome.set(String(p.loadNbr), 'failed'); continue; }

      // CREATE MODE: nothing to echo — synthesize the minimal raw header (loadNbr + routeName);
      // dates derive from the service date, origin from the inline stops' "from" blocks (or the
      // client ship-from) via assembleImportHeader's donor ladder.
      const rawHeader = loadX?.loadHeader
        ?? { loadNbr: p.loadNbr, routeName: p.L?.routeName != null && String(p.L.routeName).trim() !== '' ? String(p.L.routeName) : undefined };
      const header = assembleImportHeader(rawHeader, [...(loadX?.rawStops || []), ...(p.originDonors || [])], clientOrigin,
        // Service-date fallback: the first entry's delivery window date (echoed from NuVizz).
        String(stops[0]?.to?.schedule?.timeFrom || '').slice(0, 10) || p.svcDate || null);
      const r = await runImportLoad(requester, { load: { loadHeader: header, stops }, convergence: perLoadPacing }, creds, perLoadPacing);
      p.result.steps.push(...(r.steps || []));
      p.result.requestedOrder = r.requestedOrder || null;
      if (r.stopIds) p.result.stopIds = r.stopIds;   // stopNbr → internal id, harvested free (item A)
      // Per-save call anatomy (directive #4): imports/polls from the executor + this load's own
      // pre-read + the post-insert re-read + per-stop reads (arrival resolution / existence
      // gates) + the membership insert, so the journal shows the full cost.
      p.result.calls = { updates: r.calls?.updates ?? 0, infos: (r.calls?.infos ?? 0) + 1 + extraInfos, stopInfos: p.addReads || 0, inserts };
      outcome.set(String(p.loadNbr), r.pending ? 'pending' : (r.ok ? 'converged' : 'failed'));
      if (r.pending) {
        // Import fired + accepted, not yet CONFIRMED. The client verifies (getLoad polls +
        // re-Save resend) — assign/dispatch wait until the order is confirmed, so a driver is
        // never dispatched onto an unverified route. Staged driver/dispatch survive on the card.
        p.result.pending = true; p.result.ok = false; continue;
      }
      if (!r.ok) { p.result.ok = false; p.result.error = r.error || 'import did not converge'; continue; }
      loadId = r.loadId ?? loadId;
    } catch (e: any) {
      p.result.ok = false; p.result.error = e?.message || 'import build failed';
      outcome.set(String(p.loadNbr), 'failed');
      continue;
    }
    if (hasDriverId(p.L?.driverId)) {
      if (!loadId) { p.result.ok = false; p.result.error = 'commitBoard(import): loadId unresolved for assignDriver'; continue; }
      const r = await fireSingle(requester, 'assignDriver', { routeId: loadId, driverId: p.L.driverId }, creds);
      p.result.steps.push({ op: 'assignDriver', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) { p.result.ok = false; continue; }
    }
    if (p.L?.dispatch) {
      if (!loadId) { p.result.ok = false; p.result.error = 'commitBoard(import): loadId unresolved for dispatch'; continue; }
      const r = await fireSingle(requester, 'dispatchLoad', { routeId: loadId }, creds);
      p.result.steps.push({ op: 'dispatchLoad', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) p.result.ok = false;
    }
  }

  const loads = [
    ...(legacyResult.loads || []),
    ...imp.map((p) => ({
      loadNbr: p.result.loadNbr ?? p.loadNbr, loadId: p.load?.loadId ?? p.L?.loadId ?? null,
      ok: p.result.ok, error: p.result.error, steps: p.result.steps,
      // pending + requestedOrder drive the CLIENT's convergence verification (getLoad polls).
      pending: p.result.pending || undefined, requestedOrder: p.result.requestedOrder || undefined,
      // stopNbr → NuVizz internal id, harvested from the converged read-back (item A).
      stopIds: p.result.stopIds || undefined,
      // Per-save anatomy (directive #4): updates/infos/stopInfos/inserts for THIS load.
      calls: p.result.calls || undefined,
      // A seed physically planned this stop on this load — surfaced so a failed Save can never
      // read as "nothing happened" and the orders get re-staged elsewhere.
      seededStopNbr: p.result.seededStopNbr || undefined, seededLoadNbr: p.result.seededLoadNbr || undefined,
    })),
  ];
  return { ok: loads.every((l: any) => l.ok) && (legacyResult.orphaned || []).length === 0, loads, orphaned: legacyResult.orphaned || [] };
}

// Shared Buford depot — every DAVIS route runs from one warehouse, so this is the fallback
// when a load's own rtOrigin carries no coordinates. (Matches the constant proven against
// UAT in the RWB byte-integrity test, Jul 2026.)
const DAVIS_DEPOT = { lat: 34.04446, lng: -83.71669 };

// Compares a freshly-read load's DELIVERY order (DO stops sorted by stopSeq) to the requested
// stopNbr order. Returns a human error naming exactly what NuVizz kept, or null when the order
// took. PICKUP orders (returns/RAs) are excluded — their customer visit is a _PU leg whose
// stopSeq semantics differ from a delivery's. Duplicate stopSeq values among deliveries are
// ALWAYS a mismatch: the portal and the driver app run stops by seq, so a duplicate leaves the
// run order undefined (the Jul 9 DAWSONVILLE edit left NuVizz at 1,2,2,6…13 — two stops sharing
// #2, two sharing #12 — while the save had answered SUCCESS).
// One shared, trimmed, tolerant boolean-env parser for the RWB levers: "1/true/on/yes" and
// "0/false/off/no" both work (any case, stray whitespace ignored); anything else → the default.
// The levers used to demand the exact literals 'on'/'off', so NUVIZZ_RWB_RESEQUENCE=true or
// NUVIZZ_RWB_STANDING_ROUTE=false silently did nothing.
function envFlag(name: string, def: boolean): boolean {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (/^(1|true|on|yes)$/.test(v)) return true;
  if (/^(0|false|off|no)$/.test(v)) return false;
  return def;
}

// Sentinel prefix for "the read landed before NuVizz assigned positions" — a SOFT state the
// verify retries with a plain re-read (never a repair write into the vendor's settling window).
export const RWB_SEQ_PENDING = 'NuVizz has not assigned stop positions yet';
function rwbOrderMismatch(load: any, orderedNbrs: string[]): string | null {
  const dos = (load?.stops || []).filter((s: any) => s?.stopNbr != null && String(s?.stopType ?? 'DO').toUpperCase() === 'DO');
  const want = orderedNbrs.filter((n) => dos.some((s: any) => String(s.stopNbr) === n));
  // A null/absent stopSeq is NOT position 0: load/info can list stops before the seq is stamped
  // (the import poller documents the same trap). Two unseq'd stops used to read as "duplicate
  // position 0" → a false KEPT-order failure + a pointless repair save while the vendor was
  // still settling. Report seq-pending instead and let the caller re-read.
  const wantSet = new Set(want);
  if (dos.some((s: any) => wantSet.has(String(s.stopNbr)) && (s?.stopSeq == null || !Number.isFinite(Number(s.stopSeq))))) {
    return `${RWB_SEQ_PENDING} for this load (the save may still be settling) — re-Save in a moment to verify the order`;
  }
  // Equal-seq TIE-BREAK by requested position: NuVizz gives CO-LOCATED orders (one physical
  // stop, several PROs — the two USDA FOREST SERVICE orders on SCOTT) the SAME stopSeq, so a
  // raw sort's tie order is arbitrary and used to flip against `want` at random.
  const wantIdx = new Map(want.map((n, i) => [n, i]));
  const got = dos.slice()
    .sort((a: any, b: any) => (Number(a.stopSeq) - Number(b.stopSeq))
      || ((wantIdx.get(String(a.stopNbr)) ?? 1e9) - (wantIdx.get(String(b.stopNbr)) ?? 1e9)))
    .map((s: any) => String(s.stopNbr))
    .filter((n: string) => wantSet.has(n));
  // Duplicate positions are CORRUPTION only across DIFFERENT places (the DAWSONVILLE 1,2,2,6…13
  // state). Same-address orders legitimately share one NuVizz position — flagging those blocked
  // every close of a load carrying co-located PROs ("acting like it didn't save"). Location key
  // comes from the RAW stop record's to.address; a group with unknown addresses is treated as
  // corrupt only when the order ALSO mismatches (real corruption has both, SCOTT had neither).
  const locOf = new Map<string, string | null>();
  for (const r of (load?.rawStops || [])) {
    const st: any = r?.stop || r || {};
    if (st?.stopNbr == null) continue;
    const a = st?.to?.address || {};
    const key = [a.name, a.addressLine1 ?? a.address1 ?? a.addrLine1, a.city]
      .map((x: any) => String(x ?? '').trim().toLowerCase()).filter(Boolean).join('|');
    locOf.set(String(st.stopNbr), key || null);
  }
  const bySeq = new Map<number, string[]>();
  for (const s of dos) {
    const v = Number(s.stopSeq);
    if (!Number.isFinite(v)) continue;
    bySeq.set(v, [...(bySeq.get(v) || []), String(s.stopNbr)]);
  }
  const misplaced = want.filter((n, i) => got[i] !== n);
  const dupes: number[] = [];
  for (const [v, nbrs] of bySeq) {
    if (nbrs.length < 2) continue;
    const keys = nbrs.map((n) => locOf.get(n) ?? null);
    const known = [...new Set(keys.filter(Boolean))];
    const sameKnownPlace = known.length === 1 && keys.every(Boolean);
    const unknown = keys.some((k) => !k);
    if (sameKnownPlace) continue;                       // co-located orders — benign
    if (unknown && !misplaced.length) continue;         // order matches + address unknown — benign
    dupes.push(v);
  }
  dupes.sort((a, b) => a - b);
  if (!dupes.length && !misplaced.length) return null;
  const fmt = (a: string[]) => a.slice(0, 4).join(' → ') + (a.length > 4 ? ' → …' : '');
  return `NuVizz ACCEPTED the save but KEPT its own stop order on this load (wanted ${fmt(want)}; NuVizz still runs ${fmt(got)}${dupes.length ? `; duplicate position${dupes.length > 1 ? 's' : ''} ${dupes.slice(0, 3).join(', ')}` : ''}) — fix the order in the NuVizz portal or re-Save`;
}

// Route NAME + load number as one display string — errors name the load the way the
// dispatcher's cards do ("TRAILER 1 (DAVIS000198690)"), not by bare number (Chad: "give me
// the route name like the ones listed on these cards"). Name-less falls back to the number.
function loadLabel(routeName: any, loadNbr: any): string {
  const nbr = String(loadNbr ?? '').trim();
  const name = String(routeName ?? '').trim();
  return name && !isHashLikeId(name) && name !== nbr ? `${name} (${nbr})` : nbr;
}

// Which load does NuVizz's own stop record say holds this stop? One getStop, used only on
// failure paths to turn "planned on another load" into an actionable load. `nbr` drives the
// same-load comparison; `label` is the card-style display name. Null when the stop reads
// unplanned OR the read fails — callers phrase both as "holder unknown".
async function rwbStopHolder(requester: RequesterLike, stopNbr: string, creds: WriteCreds): Promise<{ nbr: string; label: string } | null> {
  try {
    const gs = await fireSingle(requester, 'getStop', { stopNbr }, creds);
    const nbr = String(gs?.stop?.assignedLoadNbr ?? '').trim();
    if (!nbr || isHashLikeId(nbr)) return null;
    return { nbr, label: loadLabel(gs?.stop?.routeName, nbr) };
  } catch { return null; }
}

/**
 * runCommitBoardRwb — the SAME board Save (identical payload + result shape as
 * runCommitBoard / runCommitBoardImport) executed through the Route Workbench engine
 * (lib/nuvizz-rwb.mts). Portal-profile since the multi-route rework (HAR-verified from
 * a live portal move): PASS A reads every load in the Save up-front, so classification
 * can see which stop lives on which in-batch load. An arrival held by ANOTHER load in
 * the Save is a MOVE — no getStop, no retarget probe, no add call; the single
 * multi-route saveComparedRouteData transfers it ATOMICALLY (the moved stop is simply
 * absent from the source's entry and present in the destination's, exactly how the
 * portal does it — even an A↔B swap works in one save, so the old
 * sources-before-destinations topo-sort is gone). Only genuinely-UNPLANNED arrivals
 * ride the batched validate+add (+ the 0.39.7 post-add verify — no false success).
 * Then ONE combined save persists every route's membership and order in a single
 * write — and EVERY saved load is re-read and verified: membership landed (moves get
 * a one-shot add fallback), removals actually applied, and the stops' stopSeq runs
 * in the requested order (NuVizz can answer SUCCESS and keep its own sequence — the
 * Jul 9 DAWSONVILLE edit). One automatic repair save, then a loud failure. Everything
 * references stops BY ID ONLY, so freight/address data cannot be blanked or cloned.
 * No `pending` state is ever returned — a Save either lands in-band or reports its
 * error immediately.
 *
 * Loads without an order change (emptyLoad, driver/dispatch-only, pure removes) fall
 * back to the UNCHANGED legacy engine, exactly like the import engine does.
 */
export async function runCommitBoardRwb(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  if (rwbEngineBlocked()) {
    return { ok: false, gated: true, error: 'RWB engine is disabled on the server (NUVIZZ_RWB_ENABLED must be explicitly set) — use the classic or import engine' };
  }
  // Refuse BEFORE any v7 membership write when the RWB portal creds are missing. Lever 2's
  // own empty-creds guard fires only AFTER lever 1's insertStops/removeStops, which would
  // leave a load's membership mutated with its order never set (an enabled-but-credentialless
  // deploy). Gating up-front keeps the "refused before any network call" invariant true.
  if (!rwbConfigReady()) {
    return { ok: false, gated: true, error: 'RWB creds not configured (NUVIZZ_RWB_USER/PASS) — refused before any write' };
  }
  const loadsIn: any[] = Array.isArray(payload?.loads) ? payload.loads : [];
  if (!loadsIn.length) return { ok: true, loads: [], orphaned: [] };

  const legacy: any[] = [];
  const seq: any[] = []; // { L, loadNbr, load, orderedNbrs, moveArrivals, addArrivals, curNbrs, stopIdByNbr, result, addReads, retargeted }
  const batchNbrs = new Set<string>();
  for (const l of loadsIn) { const v = String(l?.loadNbr ?? '').trim(); if (v && !isHashLikeId(v)) batchNbrs.add(v); }
  // Stops that ANOTHER load in this same Save is planning (a staged cross-load MOVE): the board IS
  // accounting for them, just on a different card. A drag / move-menu / "→ LOAD" move reduces the
  // SOURCE load's orderedStopNbrs but does NOT populate removeStopNbrs, so without this the
  // stale-board guard below would flag the still-on-source moved stop as an orphan and falsely
  // refuse the source load (cascading a failure to the destination). A stop the board truly never
  // knew about is in NO load's orderedStopNbrs, so it is still caught.
  const batchOrderedNbrs = new Set<string>();
  for (const l of loadsIn) for (const n of (Array.isArray(l?.orderedStopNbrs) ? l.orderedStopNbrs : [])) { const s = String(n); if (s) batchOrderedNbrs.add(s); }

  // ── PASS A: resolve + READ every load (no writes). The whole batch is read up-front so the
  // passes below can see which stop lives on which in-batch load BEFORE anything fires — that is
  // what lets a cross-load move classify as a MOVE (atomic in the combined save) instead of an add.
  for (const L of loadsIn) {
    const orderedNbrs: string[] | null = Array.isArray(L?.orderedStopNbrs) ? L.orderedStopNbrs.map((x: any) => String(x)).filter(Boolean) : null;
    if (L?.emptyLoad === true || !orderedNbrs || orderedNbrs.length === 0) { legacy.push(L); continue; }
    const result: any = { loadNbr: L?.loadNbr ?? null, ok: true, steps: [], error: null };

    if (!L?.loadNbr && !L?.loadId) {
      result.ok = false; result.error = 'commitBoard(rwb): loadNbr or loadId required';
      seq.push({ L, loadNbr: null, orderedNbrs, moveArrivals: [], addArrivals: [], curNbrs: new Set(), stopIdByNbr: new Map(), result }); continue;
    }
    let loadNbrX = (L?.loadNbr != null && String(L.loadNbr).trim() !== '' && !isHashLikeId(String(L.loadNbr))) ? String(L.loadNbr) : null;
    if (!loadNbrX && orderedNbrs[0]) loadNbrX = await resolveLoadNbrByStopNbr(requester, orderedNbrs[0], creds);
    if (!loadNbrX && trustableLoadId(L?.loadId)) loadNbrX = await resolveLoadNbrById(requester, L.loadId, creds);
    if (!loadNbrX && trustableLoadId(L?.loadId) && orderedNbrs[0]) {
      const seed = await resolveLoadNbrBySeeding(requester, L.loadId, orderedNbrs[0], creds);
      result.steps.push({ op: 'seedLoad', ok: !!seed.loadNbr, seeded: seed.seeded, loadNbr: seed.loadNbr, error: seed.error || null });
      if (seed.loadNbr) { loadNbrX = seed.loadNbr; result.seededStopNbr = orderedNbrs[0]; result.seededLoadNbr = seed.loadNbr; }
      else { result.ok = false; result.error = `commitBoard(rwb): ${seed.error || 'could not resolve the load number'}`; seq.push({ L, loadNbr: null, orderedNbrs, moveArrivals: [], addArrivals: [], curNbrs: new Set(), stopIdByNbr: new Map(), result }); continue; }
    }
    if (!loadNbrX) { legacy.push(L); continue; }   // e.g. loadId-only pure add — the legacy path still works
    result.loadNbr = loadNbrX;

    const f = await fetchLoad(requester, loadNbrX, creds);
    if (!f.load) { result.ok = false; result.error = `commitBoard(rwb): load not found (${loadMissDiag(loadNbrX, f)})`; seq.push({ L, loadNbr: loadNbrX, orderedNbrs, moveArrivals: [], addArrivals: [], curNbrs: new Set(), stopIdByNbr: new Map(), result }); continue; }
    seq.push({ L, loadNbr: loadNbrX, load: f.load, orderedNbrs, moveArrivals: [], addArrivals: [], curNbrs: new Set(), stopIdByNbr: new Map(), result, retargeted: false, addReads: 0 });
  }

  // Index a load's current stops: curNbrs = every stopNbr on it; stopIdByNbr = its DO deliveries.
  const indexLoad = (p: any) => {
    p.curNbrs = new Set<string>();
    p.stopIdByNbr = new Map<string, string>();
    for (const s of (p.load?.stops || [])) {
      if (s?.stopNbr == null) continue;
      p.curNbrs.add(String(s.stopNbr));
      if (s?.stopId != null && String(s?.stopType ?? '').toUpperCase() === 'DO') p.stopIdByNbr.set(String(s.stopNbr), String(s.stopId));
    }
  };
  for (const p of seq) if (p.load) indexLoad(p);

  // ── PASS B1: recurring-instance RETARGET + integrity checks (whole batch now visible). ──
  // RECURRING-INSTANCE RETARGET: a recurring load NAME (e.g. "DARYL") can have TWO NuVizz
  // instances on the same day — a fresh EMPTY one plus the prior one that still holds the stops.
  // The board groups by name, so it can open the empty twin while showing the stops that actually
  // live on the other instance. If we opened an empty load but the ordered stops sit on ONE other
  // load with the SAME routeName, operate on THAT instance instead. Costs +1 getStop +1 getLoad,
  // and ONLY when the opened load is empty AND the stops aren't held by another load in this Save —
  // a staged move onto a genuinely-empty route is NOT the duplicate-instance case, so it no longer
  // burns the probe.
  for (const p of seq) {
    if (!p.result.ok || !p.load) continue;
    let load = p.load;
    const openDOcount = (load.stops || []).filter((s: any) => String(s?.stopType ?? '').toUpperCase() === 'DO').length;
    if (openDOcount === 0 && p.orderedNbrs.length) {
      const heldInBatch = seq.some((q: any) => q !== p && q.result.ok && q.curNbrs?.has(p.orderedNbrs[0]));
      if (!heldInBatch) {
        const probe = await fireSingle(requester, 'getStop', { stopNbr: p.orderedNbrs[0] }, creds);
        const srcNbr = probe?.ok ? String(probe.stop?.assignedLoadNbr ?? '').trim() : '';
        if (srcNbr && srcNbr !== p.loadNbr && !isHashLikeId(srcNbr)) {
          const sf = await fetchLoad(requester, srcNbr, creds);
          const sameName = sf.load && String(sf.load.routeName ?? '').trim() !== ''
            && String(sf.load.routeName).trim().toUpperCase() === String(load.routeName ?? '').trim().toUpperCase();
          if (sameName) {
            p.result.steps.push({ op: 'retargetInstance', from: p.loadNbr, to: srcNbr, routeName: load.routeName });
            p.loadNbr = srcNbr; p.result.loadNbr = srcNbr; p.load = sf.load; p.retargeted = true;
            indexLoad(p);
            load = p.load;
          }
        }
      }
    }
    // Identity check is skipped after a deliberate retarget (we intentionally switched instances).
    if (!p.retargeted && p.L?.loadId && load.loadId && String(load.loadId) !== String(p.L.loadId)) {
      p.result.ok = false; p.result.error = `commitBoard(rwb): load identity mismatch (name resolved ${load.loadId}, expected ${p.L.loadId})`;
      continue;
    }
    // Count the stops STAGED FOR REMOVAL as modeled too: unplanning a non-DO stop
    // (a pickup like MUGELE, a return) is a legitimate save, but without this the
    // removed stop still read as an unmodeled non-DO stop and the guard refused it.
    const removeNbrsGuard = Array.isArray(p.L?.removeStopNbrs) ? p.L.removeStopNbrs.map((x: any) => String(x)).filter(Boolean) : [];
    if (hasUnmodeledDelivery(load, new Set([...p.orderedNbrs, ...removeNbrsGuard]))) {
      p.result.ok = false; p.result.error = 'commitBoard(rwb): load has a non-DO stop in a delivery slot that this card is not sequencing — reorder skipped (verify in portal)';
      continue;
    }
    batchNbrs.add(p.loadNbr);
  }

  // ── PASS B2: stale-board guard + arrival classification (MOVE vs ADD). ──
  for (const p of seq) {
    if (!p.result.ok || !p.load) continue;
    // STALE-BOARD GUARD. The RWB save is DECLARATIVE: the route ends up with exactly the stops we
    // send, so any DO stop currently on the load but NOT in the desired order is UNPLANNED. That is
    // correct for a stop the dispatcher intentionally removed (removeStopNbrs) or one that ANOTHER
    // load in this same Save is taking (a staged move — batchOrderedNbrs), but a stop the board
    // simply never knew about would be silently dropped. Refuse rather than quietly unplan it.
    const removeNbrs: string[] = Array.isArray(p.L?.removeStopNbrs) ? p.L.removeStopNbrs.map((x: any) => String(x)).filter(Boolean) : [];
    const orderedSet = new Set(p.orderedNbrs);
    const removeSet = new Set(removeNbrs);
    const unaccounted = [...p.stopIdByNbr.keys()].filter((n: string) => !orderedSet.has(n) && !removeSet.has(n) && !batchOrderedNbrs.has(n));
    if (unaccounted.length) {
      p.result.ok = false;
      p.result.error = `commitBoard(rwb): load ${p.loadNbr} has ${unaccounted.length} stop(s) the board isn't showing (${unaccounted.slice(0, 3).join(', ')}${unaccounted.length > 3 ? '…' : ''}) — a declarative RWB save would unplan them. Refresh and retry.`;
      continue;
    }

    // ── EXECUTED-STOP REMOVAL GUARD (pre-save; the AVRT-0179332708 case, Jul 22).
    // A stop the driver has already acted on (dispatched / arrived / pickup
    // confirmed …) cannot leave a load via the declarative save: NuVizz answers
    // SUCCESS and silently KEEPS it, which used to surface only AFTER the write
    // as the post-verify KEPT banner (one wasted save + one wasted repair).
    // The pre-save load read already carries each raw stop's execution status,
    // so refuse UP FRONT — zero extra calls. Covers explicit removals AND the
    // source side of a staged move (both mean "this stop must LEAVE this load").
    // Fail-open: an absent/unknown status never blocks — the KEPT verify still
    // has the final word.
    const mustLeave = [
      ...removeNbrs,
      ...[...p.stopIdByNbr.keys()].filter((n: string) => !orderedSet.has(n) && !removeSet.has(n) && batchOrderedNbrs.has(n)),
    ];
    const executedLeaver = mustLeave
      .map((n: string) => ({ n, status: rawStopExecStatus(p.load, n) }))
      .find((x) => isExecutedStopStatus(x.status));
    if (executedLeaver) {
      p.result.ok = false;
      p.result.error = `commitBoard(rwb): stop ${executedLeaver.n} on ${p.loadNbr} is already ${executedLeaver.status} — NuVizz keeps an executed stop even when a Save removes it. Reopen + unplan it in the portal first, then refresh and re-Save.`;
      continue;
    }

    // An arrival held by ANOTHER load in this Save is a MOVE — the combined declarative save below
    // transfers it atomically (portal-verified: the move HAR fires NO validate/add at all). Its id
    // comes off the holder load's own read (authoritative). Everything else is an ADD and is
    // verified against NuVizz ITSELF (one /stop/info each) BEFORE anything fires.
    //
    // The old "portal-scale" fast path trusted a client-supplied stopId and SKIPPED that read —
    // which trusted the BOARD's idea of "unplanned". The board can be stale (overlay lapse during
    // a paused-scan night: WIEDMANN read unplanned while actually planned on GEORGE L), and NuVizz
    // silently no-ops/rejects a cross-route steal DOWNSTREAM of us reporting success — the false
    // "saved" Chad caught. One read per newly-added stop is the price of never lying about a save;
    // it also turns the mistake into the actionable pre-add refusal below.
    // "Missing" = not on the load AT ALL (curNbrs — every on-load stop record). The old check
    // used the DO-only stopIdByNbr, so an on-load PICKUP/RA (or blank-typed) stop read as an
    // arrival: a wasted getStop+validate+add per reorder at best, a false failure at worst when
    // the portal rejects re-adding a stop it already holds.
    const missing = p.orderedNbrs.filter((n: string) => !p.curNbrs.has(n));
    // Scan-fed stop ids from the client's board rows (stopIdsByNbr map; legacy positional
    // orderedStopIds accepted only when it pairs 1:1 with orderedStopNbrs). A supplied id
    // skips the one-getStop-per-added-stop lookup that made a 14-stop build cost ~24 calls
    // (journal: stopInfos=N) — the id already came off NuVizz's own list/enrichment. Only
    // hash-shaped values are trusted (a stop NUMBER can never pass as an id). Safety is NOT
    // relaxed: validate/add rejects a dead or already-planned instance, and the post-add
    // membership re-read below still catches a silent no-op and NAMES the holding load —
    // the supplied id only skips the pre-add read, never the post-add verify.
    const suppliedIds = new Map<string, string>();
    {
      const byNbr = p.L?.stopIdsByNbr;
      if (byNbr && typeof byNbr === 'object' && !Array.isArray(byNbr)) {
        for (const [nbr, id] of Object.entries(byNbr)) if (isHashLikeId(id)) suppliedIds.set(String(nbr), String(id));
      } else {
        const nbrs = Array.isArray(p.L?.orderedStopNbrs) ? p.L.orderedStopNbrs : [];
        const ids = Array.isArray(p.L?.orderedStopIds) ? p.L.orderedStopIds : [];
        if (nbrs.length && ids.length === nbrs.length) {
          nbrs.forEach((n: any, i: number) => { if (isHashLikeId(ids[i])) suppliedIds.set(String(n), String(ids[i])); });
        }
      }
    }
    const needFetch: string[] = [];
    for (const nbr of missing) {
      const holder = seq.find((q: any) => q !== p && q.result.ok && q.stopIdByNbr.has(nbr));
      if (holder) { p.moveArrivals.push({ nbr, stopId: holder.stopIdByNbr.get(nbr), fromLoadNbr: holder.loadNbr }); continue; }
      const sid = suppliedIds.get(nbr);
      if (sid) { p.addArrivals.push({ nbr, stopId: sid }); continue; }
      needFetch.push(nbr);
    }
    const fetched = new Map<string, any>(await Promise.all(needFetch.map(async (n): Promise<[string, any]> => {
      try { return [n, await fireSingle(requester, 'getStop', { stopNbr: n }, creds)]; }
      catch (e: any) { return [n, { ok: false, error: e?.message || 'getStop failed' }]; }
    })));
    let err: string | null = null;
    for (const nbr of needFetch) {
      const gs = fetched.get(nbr);
      const srcNbr = gs?.ok ? String(gs.stop?.assignedLoadNbr ?? '').trim() : '';
      if (!gs?.ok || !gs.stop?.stopId) { err = `commitBoard(rwb): stop ${nbr} could not be read for planning (stale board — refresh and retry)`; break; }
      if (srcNbr && srcNbr !== p.loadNbr && !batchNbrs.has(srcNbr)) {
        const src = loadLabel(gs.stop?.routeName, srcNbr);
        err = `commitBoard(rwb): stop ${nbr} is ALREADY PLANNED on ${src} (our board may be showing it stale-unplanned) — open ${src} in Compare to stage the move, or refresh and re-check`; break;
      }
      p.addArrivals.push({ nbr, stopId: String(gs.stop.stopId) });
    }
    p.addReads = needFetch.length;
    if (err) { p.result.ok = false; p.result.error = err; continue; }
  }

  const legacyResult = legacy.length
    ? await runCommitBoard(requester, { ...payload, loads: legacy }, creds)
    : { ok: true, loads: [], orphaned: [] };

  // NOTE: the old sources-before-destinations topo-sort (and its dependency ladder, and the
  // "circular cross-load move" refusal) is GONE: an in-batch move — even an A↔B swap — commits
  // ATOMICALLY inside the single multi-route save below, so there is no ordering problem left.

  // Resolve each live load's routePlanId up-front. After a recurring-instance retarget, the
  // client's loadId points at the EMPTY twin — use the retargeted load's own id, never the stale
  // client id.
  const live = seq.filter((p: any) => p.result.ok && p.load);
  for (const p of live) {
    const loadId: any = p.retargeted ? (p.load?.loadId ?? null) : (trustableLoadId(p.L?.loadId) ? p.L.loadId : (p.load?.loadId ?? null));
    if (!loadId) { p.result.ok = false; p.result.error = 'commitBoard(rwb): loadId (routePlanId) unresolved'; continue; }
    p.routePlanId = String(loadId);
    p.rwbAddCalls = 0; p.verifyReads = 0;
  }

  // ── LEVER 1: MEMBERSHIP for ADD arrivals only (unplanned / off-board stops) — the RWB-native
  // batched validate+add, then the post-add verify re-read (the 0.39.7 no-false-success guard:
  // addStopsToRouteAfterValidation silently NO-OPS a stop already planned on another route).
  // MOVE arrivals need none of this — the combined save below transfers them.
  for (const p of live) {
    if (!p.result.ok || !p.addArrivals.length) continue;
    try {
      const add = await rwbAddStopsToRoute(requester, p.routePlanId, p.addArrivals.map((a: any) => a.stopId));
      p.rwbAddCalls = add.calls;
      p.result.steps.push(...add.steps.map((s: any) => ({ ...s, op: `rwb:${s.op}` })));
      if (!add.ok) { p.result.ok = false; p.result.error = `commitBoard(rwb): ${add.message}`; continue; }
      const f2 = await fetchLoad(requester, String(p.loadNbr), creds);
      p.verifyReads = 1;
      if (!f2.load) { p.result.ok = false; p.result.error = `commitBoard(rwb): load unreadable after add (${loadMissDiag(p.loadNbr, f2)}) — Save again`; continue; }
      p.load = f2.load;
      indexLoad(p);
      const landedSet = () => new Set((p.load?.stops || []).filter((s: any) => s?.stopNbr != null && s?.stopId != null).map((s: any) => String(s.stopNbr)));
      let missingAdds = p.addArrivals.filter((a: any) => !landedSet().has(String(a.nbr)));
      // ── SETTLE RETRY (OWUSU 1, Jul 10). The add returns 200 but NuVizz attaches ASYNC — an
      // immediate re-read can catch the load mid-attach and show none/few of the arrivals yet.
      // That race got reported as "still planned on another load" for a stop whose record read
      // UNPLANNED (Chad checked) — find() just named the first arrival of a not-yet-visible
      // batch. Give NuVizz a beat (env-tunable) and re-read before judging anything.
      // Clamped to ≤5s: the settle wait shares the function's 26s budget with the whole save —
      // an oversized env value would burn the timeout mid-save (audit), and past ~5s NuVizz's
      // attach has either landed or the straggler pass should take over.
      const settleMs = Math.min(5000, Math.max(0, Number(process.env.NUVIZZ_RWB_SETTLE_MS ?? 1200) || 0));
      for (let settle = 0; missingAdds.length && settle < 2; settle++) {
        await realSleep(settleMs);
        const fS = await fetchLoad(requester, String(p.loadNbr), creds);
        p.verifyReads++;
        if (fS.load) { p.load = fS.load; indexLoad(p); missingAdds = p.addArrivals.filter((a: any) => !landedSet().has(String(a.nbr))); }
      }
      // ── STRAGGLER RE-RESOLUTION. A supplied (scan/enrichment) id can be a STALE instance of
      // the PRO — NuVizz silently no-ops adding a dead id. Read each straggler BY NUMBER (the
      // current instance): a holder outside the Save fails with the actionable move error
      // (this restores, on the failure path, the pre-add holder check the supplied-id path
      // skips); a DIFFERENT current id means our id was stale — re-validate+add just those
      // with the fresh id, then re-read once more.
      if (missingAdds.length) {
        const fresh: Array<{ nbr: string; stopId: string }> = [];
        let holdErr: string | null = null;
        for (const a of missingAdds) {
          const gs = await fireSingle(requester, 'getStop', { stopNbr: String(a.nbr) }, creds).catch((e: any) => ({ ok: false, error: e?.message }));
          p.addReads = (p.addReads || 0) + 1;
          const srcNbr = gs?.ok ? String(gs.stop?.assignedLoadNbr ?? '').trim() : '';
          if (gs?.ok && srcNbr && srcNbr !== String(p.loadNbr) && !batchNbrs.has(srcNbr)) {
            holdErr = (() => { const src = loadLabel(gs?.stop?.routeName, srcNbr); const self = loadLabel(p.L?.routeName, p.loadNbr); return `commitBoard(rwb): stop ${a.nbr} couldn't be added to ${self} — NuVizz holds it on ${src}. Open ${src} in Compare to move it, or unplan it there in the portal (RWB can't pull a stop off a route that isn't part of the Save).`; })();
            break;
          }
          if (gs?.ok && gs.stop?.stopId && String(gs.stop.stopId) !== String(a.stopId)) fresh.push({ nbr: String(a.nbr), stopId: String(gs.stop.stopId) });
        }
        if (holdErr) { p.result.ok = false; p.result.error = holdErr; continue; }
        if (fresh.length) {
          const add2 = await rwbAddStopsToRoute(requester, p.routePlanId, fresh.map((f) => f.stopId));
          p.rwbAddCalls += add2.calls;
          p.result.steps.push(...add2.steps.map((s: any) => ({ ...s, op: `rwb:${s.op}(refresh-id)` })));
          for (const f of fresh) { const a = p.addArrivals.find((x: any) => String(x.nbr) === f.nbr); if (a) a.stopId = f.stopId; }
          await realSleep(settleMs);
          const fR = await fetchLoad(requester, String(p.loadNbr), creds);
          p.verifyReads++;
          if (fR.load) { p.load = fR.load; indexLoad(p); missingAdds = p.addArrivals.filter((a: any) => !landedSet().has(String(a.nbr))); }
        }
      }
      if (missingAdds.length) {
        p.result.ok = false;
        const miss = missingAdds[0];
        // Name the holder (one getStop, failure path only) — and when NuVizz names NO holder,
        // tell the truth: the stop reads UNPLANNED, so this is NuVizz still processing the add,
        // NOT a stop planned elsewhere. (The old wording asserted "planned on another load"
        // for exactly this case and sent Chad hunting a load that doesn't exist.)
        const holder = await rwbStopHolder(requester, String(miss.nbr), creds);
        const selfLbl = loadLabel(p.L?.routeName, p.loadNbr);
        // Three truthful cases (audit C6): a REAL other holder → the move error; the record
        // already says ON THIS LOAD (route index lagging the record) → settling, not unplanned;
        // no holder at all → the record itself reads UNPLANNED and is still processing.
        const recordState = holder && holder.nbr === String(p.loadNbr) ? 'reads ON this load already (NuVizz’s route view is still settling)' : 'reads UNPLANNED right now, so NuVizz is likely still processing';
        p.result.error = holder && holder.nbr !== String(p.loadNbr)
          ? `commitBoard(rwb): stop ${miss.nbr} couldn't be added to ${selfLbl} — NuVizz still holds it on ${holder.label}. Open ${holder.label} in Compare to move it, or unplan it there in the portal (RWB can't pull a stop off a route that isn't part of the Save).`
          : `commitBoard(rwb): ${missingAdds.length > 1 ? `${missingAdds.length} stops (${missingAdds.slice(0, 3).map((a: any) => a.nbr).join(', ')}${missingAdds.length > 3 ? '…' : ''})` : `stop ${miss.nbr}`} did not appear on ${selfLbl} after the add — the stop record ${recordState} (nothing was double-planned). Wait a few seconds and Save again.`;
        continue;
      }
    } catch (e: any) {
      p.result.ok = false; p.result.error = e?.message || 'RWB add failed';
    }
  }

  // Every ordered stop's id: on-load stops from the (possibly re-read) load — the source of truth —
  // plus MOVE arrivals by the id read off their in-batch holder load.
  for (const p of live) {
    if (!p.result.ok) continue;
    const allIdByNbr = new Map<string, string>();
    for (const s of (p.load?.stops || [])) if (s?.stopNbr != null && s?.stopId != null) allIdByNbr.set(String(s.stopNbr), String(s.stopId));
    for (const a of p.moveArrivals) if (!allIdByNbr.has(String(a.nbr))) allIdByNbr.set(String(a.nbr), String(a.stopId));
    p.orderedIds = [];
    for (const nbr of p.orderedNbrs) {
      const id = allIdByNbr.get(nbr);
      if (!id) { p.result.ok = false; p.result.error = `commitBoard(rwb): stop ${nbr} has no internal id to sequence (stale board — refresh and retry)`; break; }
      p.orderedIds.push(id);
    }
    // PICKUP-type ordered stops (returns / RAs): their CUSTOMER visit is the _PU leg, so the
    // sequence save must place that leg at the dispatcher's requested position (an RA emitted
    // in the default front _PU block ran as DELIVERY #1 in production regardless of where it
    // was sequenced). Typed from the authoritative (re-read) load — the board's own stopType
    // is hardcoded 'DO' and can't be trusted for this.
    const orderedSet2 = new Set(p.orderedNbrs);
    p.pickupLegIds = (p.load?.stops || [])
      .filter((s: any) => s?.stopNbr != null && s?.stopId != null
        && String(s?.stopType ?? 'DO').toUpperCase() !== 'DO' && orderedSet2.has(String(s.stopNbr)))
      .map((s: any) => String(s.stopId));
  }

  // ── LEVER 2: ONE atomic saveComparedRouteData for EVERY load in this Save. Portal-verified:
  // the multi-route routeJsonData payload is exactly how the portal itself moves a stop between
  // open routes — the moved stop is simply absent from the source's entry and present in the
  // destination's. Cost: 1 fetchUpdatedJson per load + ONE save (a 2-load move = 3 calls here).
  const group = live.filter((p: any) => p.result.ok);
  // ── CROSS-CARD STRAND GUARD (pre-save). A card may RELEASE a delivery (omit it from its
  // entry, letting another card take it — that's the only way the stale-board guard admitted
  // it) ONLY while the claiming card is still part of this Save. `group` silently drops cards
  // that failed PASS A/B or LEVER 1, and a source that saves while its claimer died would
  // UNPLAN the moved stop: removed from the source's declarative entry, never added anywhere,
  // and no orphan surfaced (the atomic-save assumption replaced the old topo-sort's orphan
  // net). Claims from failed RWB cards are REVOKED here; legacy-path claims stand — the legacy
  // engine carries its own orphan detection.
  {
    const claimedNbrs = new Set<string>();
    for (const p of group) for (const n of p.orderedNbrs) claimedNbrs.add(n);
    for (const l of legacy) for (const n of (Array.isArray(l?.orderedStopNbrs) ? l.orderedStopNbrs : [])) claimedNbrs.add(String(n));
    for (const p of group) {
      const orderedSet = new Set(p.orderedNbrs);
      const removeSet = new Set((Array.isArray(p.L?.removeStopNbrs) ? p.L.removeStopNbrs : []).map(String));
      // Same iteration set as the stale-board guard: the load's DELIVERY stops (origin PU exempt).
      const stranded = [...p.stopIdByNbr.keys()].filter((n: string) => !orderedSet.has(n) && !removeSet.has(n) && !claimedNbrs.has(n));
      if (stranded.length) {
        p.result.ok = false;
        p.result.error = `commitBoard(rwb): stop ${stranded[0]} is being moved to a card that FAILED this Save — saving ${p.loadNbr} now would UNPLAN it. Fix the failed card (see its error), then re-Save; nothing was written for ${p.loadNbr}.`;
      }
    }
  }
  const saveGroup = group.filter((p: any) => p.result.ok);
  const originOf = (p: any) => {
    const rtOriginAddr = p.load?.loadHeader?.rtOrigin?.address;
    return (rtOriginAddr?.latitude != null && rtOriginAddr?.longitude != null)
      ? { lat: Number(rtOriginAddr.latitude), lng: Number(rtOriginAddr.longitude) }
      : DAVIS_DEPOT;
  };
  // Route totals for the save entry, summed from the load's own raw stop records. Portal-pinned
  // by the Jul 9 manual-reorder HAR (8 orders → totalP 14 / totalC 10 / totalW 2515 / totalV 4 /
  // volumeUOM 'Loose'), which also confirms the DAVIS field semantics: totalP = Σ totalPallets
  // (pieces), totalC = Σ totalCartons (skids), totalV = Σ volume (loose; volumeUOM 'Loose' only
  // when any exist — the opti HAR's loose-free route sent 0/''). Attached only when a real
  // weight sums out — otherwise the save keeps the byte-exact legacy zeros fallback.
  const totalsOf = (p: any) => {
    const n = (v: any) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
    // Sum ONLY the stops this entry actually saves: p.load is the PRE-save read, so an unfiltered
    // sum counted removed/moving-away stops and missed move arrivals — a totalData that
    // contradicts the entry's own trip list (payload-semantics deviation of the v0.45.16 class).
    // A move DESTINATION can't be summed from this load's read at all (the arrival's freight
    // isn't in rawStops) → byte-exact legacy zeros fallback rather than a wrong number.
    const orderedSet = new Set(p.orderedNbrs.map(String));
    const rows = (p.load?.rawStops || []).map((s: any) => s?.stop || s || {}).filter((s: any) => orderedSet.has(String(s?.stopNbr)));
    if (rows.length !== p.orderedNbrs.length) return undefined;   // move arrivals unsummable here
    const totalW = rows.reduce((a: number, s: any) => a + n(s.weight), 0);
    if (!(totalW > 0)) return undefined;
    const totalV = rows.reduce((a: number, s: any) => a + n(s.volume), 0);
    return {
      totalP: rows.reduce((a: number, s: any) => a + n(s.totalPallets), 0),
      totalC: rows.reduce((a: number, s: any) => a + n(s.totalCartons), 0),
      totalW, totalV, weightUOM: 'Lbs', volumeUOM: totalV > 0 ? 'Loose' : '',
    };
  };
  // isStandingRoute: TRUE on every captured portal save (build, optimize, and the manual-reorder
  // HAR — 3 for 3 on this tenant's recurring routes), and the manual-reorder save is the one
  // flow that persists a reorder with NO extra call — so a stray here is the live suspect for
  // "reorder accepted, seq never moved". Default ON; NUVIZZ_RWB_STANDING_ROUTE=off reverts.
  const RWB_STANDING = envFlag('NUVIZZ_RWB_STANDING_ROUTE', true);
  const extrasOf = (p: any) => ({ totals: totalsOf(p), isStandingRoute: RWB_STANDING });
  // resequenceRoute is the OPTIMIZER's persist (Jul 9 opti HAR) — the manual-reorder HAR proves
  // the portal never fires it for a manual sequence (the save alone persists it). Kept as an
  // escape lever ONLY: NUVIZZ_RWB_RESEQUENCE=on fires it for loads whose freshest-read delivery
  // order differs from the requested order. OFF by default — calling a portal endpoint in a way
  // the portal never does is exactly how the Jul 9 half-apply happened.
  const RWB_RESEQ = envFlag('NUVIZZ_RWB_RESEQUENCE', false);
  const needsReseq = (p: any) => RWB_RESEQ && rwbOrderMismatch(p.load, p.orderedNbrs) != null;
  if (saveGroup.length) {
    try {
      for (const p of saveGroup) p.reseqRequested = needsReseq(p);
      const r = await rwbSequenceRoutes(requester, saveGroup.map((p: any) => ({ routePlanId: p.routePlanId, orderedStopIds: p.orderedIds, origin: originOf(p), pickupLegIds: p.pickupLegIds || [], resequence: p.reseqRequested, ...extrasOf(p) })));
      for (const [i, p] of saveGroup.entries()) {
        const mySteps = r.steps.filter((s: any) => !s.routePlanId || String(s.routePlanId) === p.routePlanId);
        p.result.steps.push(...mySteps.map((s: any) => ({ ...s, op: `rwb:${s.op}` })));
        // Truthful sums across loads: each load owns its own preview (+ its resequence when the
        // lever requested one); the ONE shared save is booked on the first load in the group.
        p.result.calls = { rwb: 1 + (p.reseqRequested ? 1 : 0) + (i === 0 ? 1 : 0), rwbAdd: p.rwbAddCalls, infos: p.verifyReads, stopInfos: p.addReads || 0 };
        if (!r.ok) {
          p.result.ok = false;
          p.result.error = (r.failedRoutePlanId && String(r.failedRoutePlanId) !== p.routePlanId)
            ? `commitBoard(rwb): aborted — another load in this Save failed (${r.message}).${(r as any).wroteBefore ? ' A resequence step had ALREADY persisted for an earlier load — check the loads in the portal, then re-Save.' : ' The multi-load save is all-or-nothing, so nothing was written; re-Save.'}`
            : `commitBoard(rwb): ${r.message}`;
        }
      }
      // ── POST-SAVE VERIFY, TWO PASSES (no false success — ORDER included) ──
      // PASS 1 lands MOVE arrivals: if the combined save didn't transfer a stop, attach it via
      // the proven add path + a portal-shaped re-save. This runs BEFORE any source is judged —
      // the fallback add releases the stop from its source vendor-side, so a source verified
      // earlier would false-fail on a stop its destination was about to claim.
      if (r.ok) {
        for (const p of saveGroup) {
          if (!p.result.ok || !p.moveArrivals.length) continue;
          const f3 = await fetchLoad(requester, String(p.loadNbr), creds);
          p.result.calls.infos += 1;
          if (!f3.load) { p.result.ok = false; p.result.error = `commitBoard(rwb): load unreadable after save (${loadMissDiag(p.loadNbr, f3)}) — verify in the portal, then refresh`; continue; }
          const onNow = new Set((f3.load.stops || []).map((s: any) => String(s?.stopNbr)));
          const missingMoves = p.moveArrivals.filter((a: any) => !onNow.has(String(a.nbr)));
          if (!missingMoves.length) continue;
          const add = await rwbAddStopsToRoute(requester, p.routePlanId, missingMoves.map((a: any) => a.stopId));
          p.result.calls.rwbAdd += add.calls;
          p.result.steps.push(...add.steps.map((s: any) => ({ ...s, op: `rwb:${s.op}(move-fallback)` })));
          const r2 = await rwbSequenceStops(requester, p.routePlanId, p.orderedIds, originOf(p), p.pickupLegIds || [], { ...extrasOf(p), resequence: RWB_RESEQ });
          p.result.steps.push(...r2.steps.map((s: any) => ({ ...s, op: `rwb:${s.op}(move-fallback)` })));
          p.result.calls.rwb += r2.calls;
          if (!r2.ok) { p.result.ok = false; p.result.error = `commitBoard(rwb): ${r2.message}`; }
        }
        // PASS 2 judges EVERY load against everything the declarative save promised: ordered
        // stops ON it (moves already had pass 1's shot), removeStopNbrs AND moved-away stops OFF
        // it — a source that keeps a stop another card took is a half-applied move, the inverse
        // of the BEN 2 ejection — and the deliveries' stopSeq in the requested order (the Jul 9
        // DAWSONVILLE edit: SUCCESS answered, membership applied, every seq kept — 1,2,2,6…13).
        // ONE repair round for a hard order mismatch; a SOFT seq-pending read (positions not
        // stamped yet) retries with a plain re-read — never a repair write into the vendor's
        // settling window.
        for (const p of saveGroup) {
          if (!p.result.ok) continue;
          const removeNbrs: string[] = Array.isArray(p.L?.removeStopNbrs) ? p.L.removeStopNbrs.map((x: any) => String(x)).filter(Boolean) : [];
          const movedAway: string[] = seq.flatMap((q: any) => (q !== p && q.result.ok)
            ? q.moveArrivals.filter((a: any) => String(a.fromLoadNbr) === String(p.loadNbr)).map((a: any) => String(a.nbr))
            : []);
          let verdict: string | null = 'post-save verification did not run';
          // Per-load verify isolation (audit C2): a thrown read here used to bubble to the
          // batch-wide catch and flip EVERY load — including ones already verified green — to
          // a generic ✗ with no observedOrder, blinding the board on plans that physically
          // landed. One load's read failure is now that load's verdict alone.
          try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const f3 = await fetchLoad(requester, String(p.loadNbr), creds);
            p.result.calls.infos += 1;
            if (!f3.load) { verdict = `load unreadable after save (${loadMissDiag(p.loadNbr, f3)}) — verify in the portal, then refresh`; break; }
            const onNow = new Set((f3.load.stops || []).map((s: any) => String(s?.stopNbr)));
            const missingMoves = p.moveArrivals.filter((a: any) => !onNow.has(String(a.nbr)));
            if (missingMoves.length) {
              verdict = `stop ${missingMoves[0].nbr} did not land on ${p.loadNbr} after the move — check both loads in the portal, then refresh and re-Save.`;
              break;
            }
            const missingOrdered = p.orderedNbrs.filter((n: string) => !onNow.has(n) && !p.moveArrivals.some((a: any) => String(a.nbr) === n));
            const lingering = [...removeNbrs, ...movedAway].filter((n) => onNow.has(n) && !p.orderedNbrs.includes(n));
            const orderErr = !missingOrdered.length ? rwbOrderMismatch(f3.load, p.orderedNbrs) : null;
            const seqPending = !!orderErr && orderErr.startsWith(RWB_SEQ_PENDING);
            if (!missingOrdered.length && !lingering.length && !orderErr) { verdict = null; break; }
            // A stop that was ON the load when we saved but is gone now is not repairable here —
            // something else owns it; surface it WITH the holder's name (one getStop) rather than
            // re-adding blind (the BEN 2 ejection).
            if (missingOrdered.length) {
              const nbr = String(missingOrdered[0]);
              const holder = await rwbStopHolder(requester, nbr, creds);
              verdict = holder && holder.nbr !== String(p.loadNbr)
                ? `NuVizz dropped stop ${nbr} from the save — its stop record says it's planned on ${holder.label}. Open ${holder.label} in Compare to stage the move, or unplan it there in the portal, then re-Save.`
                : `NuVizz dropped stop ${nbr} from the save — its stop record reads ${holder ? 'ON this load' : 'UNPLANNED'}, so NuVizz's route index and stop record disagree about it; unplan/re-plan it in the portal, then re-Save.`;
              break;
            }
            if (attempt === 1) {
              verdict = lingering.length
                ? `NuVizz KEPT stop ${lingering[0]} on ${p.loadNbr} — the ${movedAway.includes(lingering[0]) ? 'move to its new load' : 'removal'} was accepted but the stop never left; unplan it in the portal, then refresh.`
                : orderErr;
              // MEMBERSHIP is confirmed on this branch (missingMoves/missingOrdered were empty) —
              // only the order/removal verdict failed. Surface NuVizz's OBSERVED delivery state so
              // the client can still write the board through with the TRUTH: the SCOTT false-fail
              // (Jul 10) skipped the write-through entirely, so a stop that had physically landed
              // (SHP29379) kept showing unplanned once the card closed, inviting a double-plan.
              p.result.observedOrder = (f3.load.stops || [])
                .filter((s: any) => s?.stopNbr != null && String(s?.stopType ?? 'DO').toUpperCase() === 'DO')
                .slice()
                .sort((a: any, b: any) => Number(a?.stopSeq ?? Number.MAX_SAFE_INTEGER) - Number(b?.stopSeq ?? Number.MAX_SAFE_INTEGER))
                .map((s: any) => String(s.stopNbr));
              break;
            }
            if (seqPending && !lingering.length) continue;   // soft retry: plain re-read, no write
            const r2 = await rwbSequenceStops(requester, p.routePlanId, p.orderedIds, originOf(p), p.pickupLegIds || [], { ...extrasOf(p), resequence: RWB_RESEQ });
            p.result.steps.push(...r2.steps.map((s: any) => ({ ...s, op: `rwb:${s.op}(repair)` })));
            p.result.calls.rwb += r2.calls;
            if (!r2.ok) { verdict = r2.message; break; }
          }
          } catch (e: any) {
            verdict = `post-save verify read failed (${e?.message || 'network error'}) — NuVizz took the save; refresh and re-Save to confirm`;
          }
          if (verdict) { p.result.ok = false; p.result.error = `commitBoard(rwb): ${verdict}`; }
          p.verifyDone = true;
        }
      }
    } catch (e: any) {
      // Batch-wide failures (the combined save itself) fail everything still pending — but a
      // load whose verify already COMPLETED green keeps its verdict (audit C2): its plan is
      // confirmed in NuVizz and must stay stampable/board-visible.
      for (const p of saveGroup) if (p.result.ok && !p.verifyDone) { p.result.ok = false; p.result.error = e?.message || 'RWB sequence failed'; }
    }
  }

  // PLAN verdict frozen here (audit C3): assign/dispatch failures below must not suppress the
  // board stamp for a plan that verified green — the stops ARE on the route in NuVizz.
  for (const p of live) p.planOk = p.result.ok === true && Array.isArray(p.orderedNbrs) && p.orderedNbrs.length > 0;

  // ── driver assign / dispatch per load (after the save, as before) ──
  for (const p of live) {
    if (!p.result.ok) continue;
    if (hasDriverId(p.L?.driverId)) {
      const r = await fireSingle(requester, 'assignDriver', { routeId: p.routePlanId, driverId: p.L.driverId }, creds);
      p.result.steps.push({ op: 'assignDriver', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) { p.result.ok = false; continue; }
    }
    if (p.L?.dispatch) {
      const r = await fireSingle(requester, 'dispatchLoad', { routeId: p.routePlanId }, creds);
      p.result.steps.push({ op: 'dispatchLoad', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
      if (!r.ok) p.result.ok = false;
    }
  }

  // ── SERVER-SIDE BOARD WRITE-THROUGH (Jul 10, MONE) ─────────────────────────
  // The client's post-save sync proved fragile: a green 15-stop MONE save left ZERO board
  // stamps (a silently-dropped fetch — the client nulls a failed sync and moves on), which
  // is the whole night's "stop dropped off the route when I closed the card" class. The
  // server just VERIFIED this plan against NuVizz, so it stamps the board itself: no client
  // fetch, no date/state coupling, and the outcome rides the result into the WRITE JOURNAL —
  // a sync miss can never be invisible again. The client's own sync stays as belt
  // (patchBoardPlan is idempotent). Best-effort: a board hiccup never fails the Save.
  if (isFirestoreEnabled()) {
    const tenantET = String((creds as any)?.companyCode || 'DAVIS').toUpperCase();
    // Anchor on the CLIENT's board date when it rides the payload — at 11pm ET the dispatcher
    // is building TOMORROW's board, and etDayString() (the current ET day) patched yesterday's
    // doc while the rows live on tomorrow's (journal, Jul 10 03:08Z: server patched:1/
    // missing:13 per save while the client's date-correct sync patched all 13). Old clients
    // that don't send a date fall back to the ET day; their own sync remains the belt.
    const boardDay = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.date ?? '')) ? String(payload.date) : etDayString();
    // Cross-card move ordering (audit C4): a stop removed from card A and added to card B in
    // the SAME Save must never end the loop stamped unplanned because A's patch ran after
    // B's. Any stop planned by ANY green load in this batch is excluded from every unplanned
    // stamp — planned wins, order-independent.
    const batchPlanned = new Set<string>();
    for (const p of seq) if (p.planOk) for (const n of p.orderedNbrs) batchPlanned.add(String(n));
    for (const p of seq) {
      if (!p.planOk) continue;   // plan verified green — stamp even if assign/dispatch failed after
      try {
        // Ghost-guard at the SOURCE: only removals of stops the load actually HELD (curNbrs,
        // the load's own read) may stamp board-unplanned — a ghost the dispatcher pulled onto
        // the card and struck off was never unplanned by this save.
        const removeNbrs = (Array.isArray(p.L?.removeStopNbrs) ? p.L.removeStopNbrs : [])
          .map((n: any) => String(n)).filter((n: string) => p.curNbrs?.has?.(n) && !batchPlanned.has(n));
        const driverApplied = (p.result.steps || []).some((s: any) => s.op === 'assignDriver' && s.ok);
        // Route name for the board: the SERVER-read name first (the truth just fetched from
        // NuVizz), the client's name second, and never a hash — a Loads-grid card is keyed by
        // its 24-hex loadId, and stamping that as routeName grouped board rows under a hex
        // "route" the write grace then defended (audit C5).
        const routeName = [p.load?.routeName, p.L?.routeName]
          .map((v: any) => String(v ?? '').trim())
          .find((v: string) => v && !isHashLikeId(v)) || String(p.loadNbr || '');
        const r = await patchBoardPlan(tenantET, boardDay, {
          routeName,
          orderedStopNbrs: p.orderedNbrs.map(String),
          unplannedStopNbrs: removeNbrs,
          driverName: driverApplied ? (p.L?.driverName || null) : null,
          at: new Date().toISOString(),
        });
        p.result.boardSync = { patched: r.patched, rescued: r.rescued, missing: r.missing, ...(r.missingNbrs?.length ? { missingNbrs: r.missingNbrs } : {}) };
      } catch (e: any) {
        p.result.boardSync = { error: e?.message || 'board write-through failed' };
      }
    }
  }

  const loads = [
    ...(legacyResult.loads || []),
    ...seq.map((p) => ({
      loadNbr: p.result.loadNbr ?? p.loadNbr, loadId: p.load?.loadId ?? p.L?.loadId ?? null,
      // Echo the identity the CLIENT sent (audit C8): after a recurring-instance retarget the
      // result's loadNbr/loadId are the twin's, so the client's key join failed — the card
      // stayed dirty, staged driver re-sent, and the belt sync skipped. These echoes give the
      // client an unambiguous join back to its own card.
      requestedLoadNbr: p.L?.loadNbr ?? null, requestedLoadId: p.L?.loadId ?? null,
      ok: p.result.ok, error: p.result.error, steps: p.result.steps,
      calls: p.result.calls || undefined,
      // Server-side board write-through outcome — journaled with the op, so "the board never
      // heard about this save" is diagnosable from nuvizz-write-log alone.
      boardSync: p.result.boardSync || undefined,
      // Membership-confirmed order/removal failures carry NuVizz's OBSERVED delivery order so the
      // client can write the board through with the truth despite the ✗ (SCOTT SHP29379, Jul 10).
      observedOrder: p.result.observedOrder || undefined,
      seededStopNbr: p.result.seededStopNbr || undefined, seededLoadNbr: p.result.seededLoadNbr || undefined,
    })),
  ];
  return { ok: loads.every((l: any) => l.ok) && (legacyResult.orphaned || []).length === 0, loads, orphaned: legacyResult.orphaned || [] };
}

/**
 * runAddStopNote (§N) — write a dispatcher/driver instruction onto a LIVE order.
 *
 * Three calls, and every one of them earns its place:
 *   1. READ  the stop — `comments` is a FULL REPLACE on partialUpdate (portal HAR,
 *            Jul 24), so the current list must be merged onto, never guessed. A blind
 *            write would erase the carrier's own instructions ("DO NOT BREAKDOWN
 *            SKID") off live freight.
 *   2. WRITE the stop back with `comments` swapped. partialUpdate is NOT partial: a
 *            minimal { stopId, stopNbr, comments } body — which is what we shipped
 *            first, and reads as the safest thing possible — is rejected outright
 *            ("SOMETHING WENT WRONG!!, PLEASE TRY AGAIN"). The portal echoes the whole
 *            stop, so we do too, minus the derived keys it also drops (freight lines
 *            above all) and without inventing a single value we didn't read.
 *   3. VERIFY by reading back: the note must be present, and EVERY field we echoed
 *            must come back byte-identical. The echo is what makes step 3 load-bearing
 *            — the blast radius is now the whole stop, so the check is "nothing moved"
 *            rather than a guard list. If anything did, we say so LOUDLY instead of
 *            reporting a clean save — the same no-false-success discipline as the
 *            board saves.
 *
 * An identical note already on the stop is a no-op (returns duplicate:true, 1 call).
 */
export async function runAddStopNote(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const stopNbr = req(payload?.stopNbr, 'addStopNote: stopNbr');
  const audience: NoteAudience = (['dispatcher', 'driver', 'both'].includes(payload?.audience) ? payload.audience : 'both');
  const note = buildStopNoteComment(payload?.text, audience);   // throws on empty text
  const calls = { reads: 0, writes: 0 };

  const before = await fireSingle(requester, 'getStop', { stopNbr }, creds);
  calls.reads += 1;
  if (!before?.ok) return { ok: false, error: `addStopNote: could not read stop ${stopNbr} (${before?.error || 'read failed'}) — nothing was written.`, calls };
  const rawBefore = rawStopFrom(before.raw ?? before);
  // Wrong-twin guard (§ the Estes-0828068215 lesson): the caller's stopId is the record on
  // the dispatcher's SCREEN; if NuVizz's by-number read answered with a different record,
  // this note would land on an order nobody is looking at. Refuse before anything is built.
  const twin = stopInstanceMismatch('addStopNote', stopNbr, payload?.stopId, rawBefore);
  if (twin) return { ok: false, wrongInstance: true, calls, error: twin };
  const stopId = rawBefore?.stopId ?? payload?.stopId ?? null;
  if (!stopId) return { ok: false, error: `addStopNote: stop ${stopNbr} has no stopId in its record — cannot target the update safely.`, calls };

  const { comments, duplicate } = mergeStopComments(stopCommentsFrom(rawBefore), note);
  if (duplicate) return { ok: true, duplicate: true, note, comments_total: comments.length, calls, message: 'That exact note is already on the order — nothing written.' };

  const fpBefore = stopNoteFingerprint(rawBefore);
  // The WHOLE stop, comments swapped — the only shape this endpoint accepts (§ buildNoteWriteStop).
  const sent = buildNoteWriteStop({ ...rawBefore, stopId, stopNbr: String(rawBefore.stopNbr ?? stopNbr) }, comments);
  const wrote = await fireSingle(requester, 'partialUpdateStop', { stops: [sent] }, creds);
  calls.writes += 1;
  if (!wrote?.ok) return { ok: false, error: `addStopNote: NuVizz rejected the note (${wrote?.error || 'write failed'}).`, calls };

  const after = await fireSingle(requester, 'getStop', { stopNbr }, creds);
  calls.reads += 1;
  if (!after?.ok) {
    return { ok: false, unverified: true, calls, error: `addStopNote: the note was accepted but the read-back failed (${after?.error || 'read failed'}) — check the order in the portal before re-trying, so you don't double-post.` };
  }
  const rawAfter = rawStopFrom(after.raw ?? after);
  // Read-back identity first — a twin answering here would make "did the note land" and the
  // whole echo diff statements about the OTHER order sharing this number (§ ESTES-2938079387).
  // `pinned` = the caller supplied the on-screen record's id and it IS the id we wrote —
  // only then may the twin banner say "the record on your screen" (the unpinned flip case
  // inverted both identity claims). An unidentifiable read-back (200, no usable stopId) is
  // the same two-different-things trap and verdicts as unverified instead of being diffed.
  const pinned = isIdShaped(payload?.stopId) && String(payload.stopId) === String(stopId);
  const rbTwin = readBackInstanceMismatch('addStopNote', stopNbr, stopId, rawAfter, pinned);
  if (rbTwin) return { ok: false, unverified: true, wrongInstanceReadback: true, calls, error: rbTwin };
  const rbNoId = readBackUnidentifiable('addStopNote', stopNbr, stopId, rawAfter);
  if (rbNoId) return { ok: false, unverified: true, calls, error: rbNoId };
  const landed = stopCommentsFrom(rawAfter).some((c: any) => String(c?.commentDescription ?? '') === note.commentDescription && String(c?.cmtType ?? '') === note.cmtType);
  // Two checks, unioned. The curated guard list names the fields a dispatcher cares about
  // first (address / freight / schedule / refs); the echo diff then catches EVERYTHING else
  // we sent, which is the check that actually matches the new blast radius. Comparing the
  // read-back through the same builder keeps the key sets symmetric, so the derived keys we
  // deliberately never send don't register as drift.
  const afterEcho = buildNoteWriteStop(rawAfter, comments);
  const drift = orderDriftPaths([...new Set([
    ...fingerprintDrift(fpBefore, stopNoteFingerprint(rawAfter)),
    ...echoDrift(sent, afterEcho),
  ])]);
  // …and the third: the keys we deliberately DON'T send (freight lines, file attachments) are
  // invisible to that diff by construction, so they are proven surviving by comparing the
  // PRE-write read to the POST-write read. Identity only — NuVizz restamping a document's
  // storage GUID is not the BOL falling off the order, and conflating the two is what made
  // the last two real note writes read as disasters.
  const losses = unsentLosses(rawBefore, rawAfter);

  if (drift.length || losses.length) {
    // Carry the VALUES, not just the field names. "to.documents changed" covers both a
    // restamped GUID and a lost BOL; only the before/after tells you which one happened.
    const details = [
      ...driftDetail(sent, afterEcho, drift),
      ...losses.map((l) => `${l.path}: LOST ${l.lost.join(' · ')}`),
    ];
    const paths = [...drift, ...losses.map((l) => l.path)];
    return {
      ok: false, note_landed: landed, drift: paths, driftDetails: details, calls,
      error: `addStopNote: the note ${landed ? 'landed' : 'did NOT land'} BUT partialUpdate changed ${paths.length} other field(s) on the order.${addressDriftWarning(paths)} ${details.join(' | ')}${paths.length > details.length ? ` (+${paths.length - details.length} more)` : ''}. Check ${stopNbr} in the portal — do not use notes again until this is investigated.`,
    };
  }
  if (!landed) return { ok: false, calls, error: `addStopNote: NuVizz accepted the write but the note is not on the order when read back — nothing else changed. Try again, or add it in the portal.` };

  // Clean save. `documentRestamp` rides along (journaled with the op) when every attachment is
  // still on the order but NuVizz moved its own GUIDs — the thing we used to fail on. It is
  // worth watching for a pattern; it is not worth a red banner in the dispatcher's face.
  const restamped = documentHandlesMoved(rawBefore, rawAfter);
  return {
    ok: true, note, audience, comments_total: stopCommentsFrom(rawAfter).length, calls,
    ...(restamped ? { documentRestamp: true } : {}),
  };
}

/**
 * runSetStopDate (§D) — move an order to the day the customer actually wants it.
 *
 * Chad, on an Estes import the customer deferred to the 30th: "can we create a way to change
 * the requested date in dispatch map so it doesn't show up." Two halves, and both are needed
 * or the change doesn't hold:
 *
 *   1. NUVIZZ. There is no "requested date" field in the v7 stop schema — `to.schedule` IS
 *      the delivery date (the portal's "DropOff Date"). So this moves that window, through
 *      the same whole-stop partialUpdate echo a note uses, with the same read-back tripwires:
 *      the new window must be there, every echoed field must come back identical, and the
 *      freight lines / attachments we never send must still be on the order.
 *   2. OUR BOARD. The board files a stop by the saved search's Estimated Arrival, and NuVizz
 *      does not recompute that for an unplanned order — so the list will keep reporting the
 *      old day and the next scan would drag the order straight back onto today. The confirmed
 *      date is therefore recorded as a board-date OVERRIDE (Firestore, zero NuVizz calls) that
 *      every later scan honors, and the cached row is moved between day docs immediately so
 *      the order leaves today's board now rather than in ten minutes.
 *
 * Refuses a stop the driver has already acted on: a delivery in flight does not get its date
 * moved out from under it. 3 NuVizz calls (read → write → verify); an order already on the
 * requested day costs 1 and writes nothing.
 */

/**
 * CANCEL AN ORDER (§X, Aug 17 2026).
 *
 * Chad: "I think we need to write a path to canceling orders and reason should
 * be admin." Until now this app could create an order and never take one back.
 *
 * THE LADDER — read, judge, then cancel BY ID. Two calls, and both earn their keep:
 *
 *   1. READ the order by number. This is the only chance to record WHAT is about
 *      to be destroyed (consignee, address, date, status), and a cancel with no
 *      before-image in the journal is an unexplainable hole in the record later.
 *   2. REFUSE on a twin. NuVizz can hold two live orders under one number, and
 *      "cancel whatever answers to this number" is the one phrasing of that
 *      hazard with no undo. Same stopInstanceMismatch gate the date/note writes
 *      use — and here it matters more, because there is nothing to put back.
 *   3. CANCEL BY stopId, the id we just read. Never by number.
 *
 * REFUSALS, all before any write:
 *   • a stop already delivered/executed — cancelling history is not a thing.
 *   • a stop currently PLANNED on a load — NuVizz's own endpoint doc says it
 *     cancels stops "in unplanned, created statuses", so we say which load to
 *     unplan it from rather than letting the vendor return a bare failure.
 *   • no stopId on the record — we will not fall back to cancelling by number.
 */
export async function runCancelOrder(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const stopNbr = req(payload?.stopNbr, 'cancelOrder: stopNbr');
  const calls = { reads: 0, writes: 0 };

  const before = await fireSingle(requester, 'getStop', { stopNbr }, creds);
  calls.reads += 1;
  if (!before?.ok) return { ok: false, error: `cancelOrder: could not read stop ${stopNbr} (${before?.error || 'read failed'}) — nothing was cancelled.`, calls };
  const rawBefore = rawStopFrom(before.raw ?? before);

  const twin = stopInstanceMismatch('cancelOrder', stopNbr, payload?.stopId, rawBefore);
  if (twin) return { ok: false, wrongInstance: true, calls, error: twin };

  const stopId = String(rawBefore?.stopId ?? '').trim();
  if (!stopId) {
    return { ok: false, calls, error: `cancelOrder: stop ${stopNbr} has no stopId in its record — refusing to cancel by number, because two orders can share one. Cancel it in the portal.` };
  }

  const status = before.stop?.status ?? null;
  if (isExecutedStopStatus(status)) {
    return { ok: false, calls, error: `cancelOrder: stop ${stopNbr} is already ${status} — a delivered stop cannot be cancelled.` };
  }
  const onLoad = before.stop?.assignedLoadNbr ?? null;
  if (onLoad) {
    return { ok: false, calls, error: `cancelOrder: stop ${stopNbr} is planned on load ${onLoad}. NuVizz only cancels unplanned orders — take it off the load first, then cancel.` };
  }

  // The before-image, kept whatever happens next: this is the record of what was destroyed.
  const addr = rawBefore?.to?.address || {};
  const cancelled = {
    stopNbr: String(rawBefore?.stopNbr ?? stopNbr),
    stopId,
    consignee: String(addr.name ?? '') || null,
    address: [addr.addr1, addr.city, addr.state, addr.zip].map((v: any) => String(v ?? '').trim()).filter(Boolean).join(', ') || null,
    date: stopDeliveryDate(rawBefore),
    status,
  };

  const wrote = await fireSingle(requester, 'cancelStop', {
    stopId,
    reasonCode: payload?.reasonCode,
    reasonComments: payload?.reasonComments,
  }, creds);
  calls.writes += 1;
  if (!wrote?.ok) {
    return { ok: false, calls, cancelled, error: `cancelOrder: NuVizz refused to cancel ${stopNbr} — ${wrote?.error || 'no reason given'}. Nothing was cancelled.` };
  }
  return { ok: true, calls, cancelled, reasonCode: (String(payload?.reasonCode ?? '').trim() || CANCEL_REASON_DEFAULT).slice(0, 10) };
}

/**
 * CORRECT THE DELIVERY ADDRESS ON AN ORDER, IN NUVIZZ.
 *
 * The gap this closes: "Edit address" on the stop card has only ever written OUR Firestore
 * override — our pin, our routing — while NuVizz kept whatever came in on the import. The
 * card could read "ADDRESS corrected" over the right street while the driver's manifest and
 * the carrier's record still carried the wrong one, and nothing said the two disagreed.
 *
 * THE LADDER, the same one the date and note writes use, for the same reasons:
 *   1. READ by number, so the correction is built on the record NuVizz will actually update.
 *   2. REFUSE ON A TWIN. Two orders can share a number; re-addressing the wrong one is worse
 *      here than anywhere else, because the freight then goes to a place nobody chose.
 *   3. REFUSE ON A DELIVERED STOP. Freight already dropped cannot be re-addressed, and
 *      rewriting history hides where it actually went.
 *   4. WRITE the whole stop with only the address block swapped (partialUpdate is a
 *      whole-stop replace — see buildPartialUpdateStop).
 *   5. VERIFY: did the address land, and did anything ELSE move.
 *
 * The address itself goes out as literal ANY-typed data with no label — see
 * buildLiteralAddress for the spec lines that force that and what a label would do.
 */
export async function runSetStopAddress(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const stopNbr = req(payload?.stopNbr, 'setStopAddress: stopNbr');
  const next = (payload?.address && typeof payload.address === 'object') ? payload.address : null;
  if (!next) return { ok: false, error: 'setStopAddress: an address object is required.', calls: { reads: 0, writes: 0 } };
  const calls = { reads: 0, writes: 0 };

  const before = await fireSingle(requester, 'getStop', { stopNbr }, creds);
  calls.reads += 1;
  if (!before?.ok) return { ok: false, error: `setStopAddress: could not read stop ${stopNbr} (${before?.error || 'read failed'}) — nothing was written.`, calls };
  const rawBefore = rawStopFrom(before.raw ?? before);
  const twin = stopInstanceMismatch('setStopAddress', stopNbr, payload?.stopId, rawBefore);
  if (twin) return { ok: false, wrongInstance: true, calls, error: twin };
  const stopId = rawBefore?.stopId ?? payload?.stopId ?? null;
  if (!stopId) return { ok: false, error: `setStopAddress: stop ${stopNbr} has no stopId in its record — cannot target the update safely.`, calls };

  const status = before.stop?.status ?? null;
  if (isExecutedStopStatus(status)) {
    return { ok: false, calls, error: `setStopAddress: stop ${stopNbr} is already ${status} — freight that has been delivered cannot be re-addressed, and changing it now would only hide where it went.` };
  }

  let side: 'to' | 'from', block: Record<string, any>;
  try {
    ({ side, block } = buildStopAddressOverride(rawBefore, next));
  } catch (e: any) {
    return { ok: false, calls, error: String(e?.message || e) };
  }
  const wasAddr = rawBefore?.[side]?.address || {};
  const from = [wasAddr.addr1, wasAddr.city, wasAddr.state, wasAddr.zip].filter(Boolean).join(', ');
  const to = [block.address.addr1, block.address.city, block.address.state, block.address.zip].filter(Boolean).join(', ');

  const sent = buildPartialUpdateStop({ ...rawBefore, stopId, stopNbr: String(rawBefore.stopNbr ?? stopNbr) }, { [side]: block });
  const fpBefore = stopNoteFingerprint(rawBefore);
  const wrote = await fireSingle(requester, 'partialUpdateStop', { stops: [sent] }, creds);
  calls.writes += 1;
  if (!wrote?.ok) return { ok: false, calls, error: `setStopAddress: NuVizz rejected the address change (${wrote?.error || 'write failed'}).` };

  const after = await fireSingle(requester, 'getStop', { stopNbr }, creds);
  calls.reads += 1;
  if (!after?.ok) {
    return { ok: false, unverified: true, calls, from, to, error: `setStopAddress: the change was accepted but the read-back failed (${after?.error || 'read failed'}) — check ${stopNbr} in the portal before re-trying.` };
  }
  const rawAfter = rawStopFrom(after.raw ?? after);
  const pinned = isIdShaped(payload?.stopId) && String(payload.stopId) === String(stopId);
  const rbTwin = readBackInstanceMismatch('setStopAddress', stopNbr, stopId, rawAfter, pinned);
  if (rbTwin) return { ok: false, unverified: true, wrongInstanceReadback: true, calls, error: rbTwin };
  const rbNoId = readBackUnidentifiable('setStopAddress', stopNbr, stopId, rawAfter);
  if (rbNoId) return { ok: false, unverified: true, calls, error: rbNoId };

  const landed = addressLanded(rawAfter?.[side]?.address, block.address);
  // The address subtree is the field we came to change, so it is excluded from the drift
  // diff exactly as `schedule` is on a date change and `comments` is on a note. NuVizz
  // normalises what it stores ("GA" → "GEORGIA", "RD" → "ROAD") and re-derives latitude,
  // longitude and fullAddress from the street we just sent — none of that is damage, and
  // reporting it as drift would make a successful correction read as a failure every time.
  // `landed` above is what actually proves the address took.
  const afterEcho = buildPartialUpdateStop(rawAfter, { [side]: { ...rawAfter?.[side], address: sent?.[side]?.address } });
  const drift = orderDriftPaths([...new Set([
    ...fingerprintDrift(fpBefore, stopNoteFingerprint(rawAfter)).filter((p) => !p.startsWith(`${side}.address`)),
    ...echoDrift(sent, afterEcho),
  ])].filter((p) => !p.startsWith(`${side}.address`)));
  const losses = unsentLosses(rawBefore, rawAfter);

  if (!landed) {
    return { ok: false, calls, stopNbr, stopId, side, from, to, drift,
      error: `setStopAddress: NuVizz accepted the write but ${stopNbr} still does not read back as ${to} — the address did NOT change. Check it in the portal; do not assume it took.` };
  }
  if (drift.length || losses.length) {
    const details = [...driftDetail(sent, afterEcho, drift), ...losses.map((l) => `${l.path}: LOST ${l.lost.join(' · ')}`)];
    return { ok: false, calls, stopNbr, stopId, side, from, to, drift, driftDetails: details, addressLanded: true,
      error: `setStopAddress: the address changed to ${to} BUT partialUpdate changed ${drift.length + losses.length} other field(s) on the order. ${details.slice(0, 5).join(' | ')}${details.length > 5 ? ` (+${details.length - 5} more)` : ''}. Check ${stopNbr} in the portal.` };
  }
  return { ok: true, stopNbr, stopId, side, from, to, calls,
    message: `Order ${stopNbr} is now addressed to ${to}.` };
}

export async function runSetStopDate(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const stopNbr = req(payload?.stopNbr, 'setStopDate: stopNbr');
  const date = String(req(payload?.date, 'setStopDate: date')).trim();
  if (!isDayString(date)) return { ok: false, error: `setStopDate: '${date}' is not a YYYY-MM-DD date.`, calls: { reads: 0, writes: 0 } };
  const calls = { reads: 0, writes: 0 };

  const before = await fireSingle(requester, 'getStop', { stopNbr }, creds);
  calls.reads += 1;
  if (!before?.ok) return { ok: false, error: `setStopDate: could not read stop ${stopNbr} (${before?.error || 'read failed'}) — nothing was written.`, calls };
  const rawBefore = rawStopFrom(before.raw ?? before);
  // Wrong-twin guard (§ the Estes-0828068215 lesson): refuse BEFORE the short-circuit below
  // too — an "already on that day" answer read off the WRONG record would record a board
  // override for the order the dispatcher IS looking at, keyed to the twin's date.
  const twin = stopInstanceMismatch('setStopDate', stopNbr, payload?.stopId, rawBefore);
  if (twin) return { ok: false, wrongInstance: true, calls, error: twin };
  const stopId = rawBefore?.stopId ?? payload?.stopId ?? null;
  if (!stopId) return { ok: false, error: `setStopDate: stop ${stopNbr} has no stopId in its record — cannot target the update safely.`, calls };

  const status = before.stop?.status ?? null;
  if (isExecutedStopStatus(status)) {
    return { ok: false, calls, error: `setStopDate: stop ${stopNbr} is already ${status} — a delivery in flight can't have its date moved. Handle it on the route instead.` };
  }
  const fromDate = stopDeliveryDate(rawBefore);
  const onLoad = before.stop?.assignedLoadNbr ?? null;
  if (fromDate === date) {
    // NuVizz already holds this day — so there is nothing to SEND. But this is the exact case
    // the board override exists for, and it used to return right here, doing nothing: an Estes
    // import the customer deferred to the 30th already carries the 30th as its DropOff window,
    // while the board files it on TODAY off a stale/blank Estimated Arrival. Setting it to the
    // 30th correctly wrote nothing to NuVizz, recorded nothing on our board either, and the very
    // next scan filed it straight back onto today (Chad: "i changed this to 7/30 and it didn't
    // write to nuvizz so it showed up in a new scan"). Agreement with NuVizz is not the goal —
    // getting the order off today's board is — so the board half runs regardless. Zero NuVizz
    // calls: this is Firestore only, so an already-dated order still costs exactly 1 read.
    const board = await applyBoardDateChange(creds, stopNbr, fromDate, date);
    const warn = boardDateHoldWarning(board);
    return {
      ok: true, unchanged: true, stopNbr, stopId, fromDate, date, onLoad, calls, board,
      ...(warn ? { boardWarning: warn } : {}),
      message: `Order ${stopNbr} already carries ${date} in NuVizz — nothing sent there. ${warn || 'Taken off today’s board, and scans will keep honoring the day.'}`,
    };
  }

  const { side, block } = buildStopDateOverride(rawBefore, date);
  const sent = buildPartialUpdateStop({ ...rawBefore, stopId, stopNbr: String(rawBefore.stopNbr ?? stopNbr) }, { [side]: block });
  const fpBefore = stopNoteFingerprint(rawBefore);
  const wrote = await fireSingle(requester, 'partialUpdateStop', { stops: [sent] }, creds);
  calls.writes += 1;
  if (!wrote?.ok) return { ok: false, calls, error: `setStopDate: NuVizz rejected the date change (${wrote?.error || 'write failed'}).` };

  const after = await fireSingle(requester, 'getStop', { stopNbr }, creds);
  calls.reads += 1;
  if (!after?.ok) {
    return { ok: false, unverified: true, calls, error: `setStopDate: the change was accepted but the read-back failed (${after?.error || 'read failed'}) — check ${stopNbr} in the portal before re-trying.` };
  }
  const rawAfter = rawStopFrom(after.raw ?? after);
  // READ-BACK identity, before anything is concluded from this record (§ ESTES-2938079387):
  // the by-number read can answer with the OTHER order sharing the number, and every check
  // below — did the date land, did anything drift — would then be about the twin, not the
  // order we wrote. That is how a date change on Khalid Mutakabbir's order was reported as
  // re-addressing it to Davis's own terminal: the "changed fields" were the twin's data.
  // `pinned` = the caller supplied the on-screen record's id and it IS the id we wrote —
  // only then may the twin banner say "the record on your screen" (the unpinned flip case
  // inverted both identity claims). An unidentifiable read-back (200, no usable stopId) is
  // the same two-different-things trap and verdicts as unverified instead of being diffed.
  const pinned = isIdShaped(payload?.stopId) && String(payload.stopId) === String(stopId);
  const rbTwin = readBackInstanceMismatch('setStopDate', stopNbr, stopId, rawAfter, pinned);
  if (rbTwin) return { ok: false, unverified: true, wrongInstanceReadback: true, calls, error: rbTwin };
  const rbNoId = readBackUnidentifiable('setStopDate', stopNbr, stopId, rawAfter);
  if (rbNoId) return { ok: false, unverified: true, calls, error: rbNoId };
  const landed = stopDeliveryDate(rawAfter) === date;
  // The schedule is the field we came to change, so it is excluded from the drift diff the
  // way `comments` is on a note — everything else must still come back byte-identical.
  const afterEcho = buildPartialUpdateStop(rawAfter, { [side]: { ...rawAfter?.[side], schedule: sent?.[side]?.schedule } });
  const drift = orderDriftPaths([...new Set([
    ...fingerprintDrift(fpBefore, stopNoteFingerprint(rawAfter)).filter((p) => !p.startsWith(`${side}.schedule`)),
    ...echoDrift(sent, afterEcho),
  ])]);
  const losses = unsentLosses(rawBefore, rawAfter);
  if (drift.length || losses.length) {
    const details = [...driftDetail(sent, afterEcho, drift), ...losses.map((l) => `${l.path}: LOST ${l.lost.join(' · ')}`)];
    const paths = [...drift, ...losses.map((l) => l.path)];
    return {
      ok: false, dateLanded: landed, drift: paths, driftDetails: details, calls,
      // Address drift outranks the cap (orderDriftPaths) and gets named in words — freight
      // consigned to the wrong building is the concrete risk, not "a field changed".
      error: `setStopDate: the date ${landed ? 'moved' : 'did NOT move'} BUT partialUpdate changed ${paths.length} other field(s) on the order.${addressDriftWarning(paths)} ${details.join(' | ')}${paths.length > details.length ? ` (+${paths.length - details.length} more)` : ''}. Check ${stopNbr} in the portal — do not change dates again until this is investigated.`,
    };
  }
  if (!landed) {
    return { ok: false, calls, error: `setStopDate: NuVizz accepted the write but ${stopNbr} still reads ${stopDeliveryDate(rawAfter) || 'no date'} when read back — nothing else changed. Try again, or set it in the portal.` };
  }

  // NuVizz agrees. Now make OUR board agree too, and keep agreeing after the next scan.
  // A failure HERE is not a failed write — the date is true in NuVizz — but it is the half that
  // decides whether the order stays off this board, so it can never stay silent.
  const board = await applyBoardDateChange(creds, stopNbr, fromDate, date);
  const boardWarning = boardDateHoldWarning(board);
  return { ok: true, stopNbr, stopId, fromDate, date, onLoad, calls, board, ...(boardWarning ? { boardWarning } : {}) };
}

/**
 * The Firestore half of a confirmed date change — zero NuVizz calls, best-effort by design:
 * the date is already true in NuVizz, so a cache hiccup must never turn a landed write into a
 * reported failure. It returns what it managed so the outcome is journaled with the op.
 */
async function applyBoardDateChange(creds: WriteCreds, stopNbr: string, fromDate: string | null, toDate: string): Promise<any> {
  if (!isFirestoreEnabled()) return { skipped: 'firestore-disabled' };
  // parentId/boardDatePath case-normalize, so the uppercase companyCode every write path
  // carries lands on the same 'davis__' tree the scanner writes (the phantom-tree lesson).
  const tenant = String((creds as any)?.companyCode || 'DAVIS');
  const at = new Date().toISOString();
  const out: any = { at };
  try {
    out.override = await setBoardDateOverride(tenant, String(stopNbr), toDate, at);
  } catch (e: any) { out.overrideError = e?.message || 'override write failed'; }
  try {
    out.moved = await moveBoardStopDay(tenant, String(stopNbr), fromDate, toDate, at);
  } catch (e: any) { out.moveError = e?.message || 'board move failed'; }
  return out;
}

/**
 * runSetStopContact (§C) — put the customer's name + number on the ORDER in NuVizz.
 *
 * Chad, on the CUSTOMER # block that shipped in v0.54.68: "does it write it to nuvizz?" It
 * did not. The block saves to our own customer_notes doc, which is per-CUSTOMER and is what
 * Text, Call and the Messages list read — but the portal, the carrier's record and the
 * DRIVER's device kept showing an order with no contact on it. So the card now does both:
 * Firestore keeps carrying the customer forward to their next order, and this puts the
 * number on the order the dispatcher is looking at.
 *
 * Same three-call ladder as a note, for the same reason — partialUpdate is NOT partial, so
 * the whole stop is echoed back with one block swapped, and the read-back has to prove
 * nothing else moved:
 *   1. READ  the stop (and refuse a wrong twin — the Estes-0828068215 lesson).
 *   2. WRITE the echo with `to.contact` (or `from.contact` on a pickup) carrying the new
 *            name/number. Only the fields actually filled in are touched: a dispatcher
 *            clearing OUR saved contact must never blank the carrier's own number.
 *   3. VERIFY the contact reads back as sent, every echoed field is byte-identical, and the
 *            freight lines / attachments we never send are still on the order.
 *
 * An order that already carries exactly this contact costs 1 call and writes nothing.
 */
export async function runSetStopContact(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const stopNbr = req(payload?.stopNbr, 'setStopContact: stopNbr');
  const name = String(payload?.name ?? '').trim();
  const phoneIn = String(payload?.phone ?? '').trim();
  const phone = normalizeContactPhone(phoneIn);
  const calls = { reads: 0, writes: 0 };
  // A typed number that survives as no digits at all ("call the office") is a mistake, not a
  // contact — writing it would put junk in the field NuVizz sends its customer SMS from.
  if (phoneIn && !phone) return { ok: false, calls, error: `setStopContact: '${phoneIn}' has no digits in it — nothing was written to NuVizz.` };
  if (!name && !phone) return { ok: false, calls, error: 'setStopContact: nothing to write — give a name, a number, or both. (Clearing a contact only removes the one saved here; the order keeps whatever the carrier sent.)' };

  const before = await fireSingle(requester, 'getStop', { stopNbr }, creds);
  calls.reads += 1;
  if (!before?.ok) return { ok: false, calls, error: `setStopContact: could not read stop ${stopNbr} (${before?.error || 'read failed'}) — nothing was written.` };
  const rawBefore = rawStopFrom(before.raw ?? before);
  const twin = stopInstanceMismatch('setStopContact', stopNbr, payload?.stopId, rawBefore);
  if (twin) return { ok: false, wrongInstance: true, calls, error: twin };
  const stopId = rawBefore?.stopId ?? payload?.stopId ?? null;
  if (!stopId) return { ok: false, calls, error: `setStopContact: stop ${stopNbr} has no stopId in its record — cannot target the update safely.` };

  const was = stopContactFrom(rawBefore);
  const sameName = !name || was.name.toUpperCase() === name.toUpperCase();
  const samePhone = !phone || normalizeContactPhone(was.phone) === phone;
  if (sameName && samePhone) {
    return {
      ok: true, unchanged: true, stopNbr, stopId, was, calls,
      message: `Order ${stopNbr} already carries this contact in NuVizz — nothing sent.`,
    };
  }

  const { side, block } = buildStopContactOverride(rawBefore, { name, phone });
  const sent = buildPartialUpdateStop({ ...rawBefore, stopId, stopNbr: String(rawBefore.stopNbr ?? stopNbr) }, { [side]: block });
  const fpBefore = stopNoteFingerprint(rawBefore);
  const wrote = await fireSingle(requester, 'partialUpdateStop', { stops: [sent] }, creds);
  calls.writes += 1;
  if (!wrote?.ok) return { ok: false, calls, error: `setStopContact: NuVizz rejected the contact (${wrote?.error || 'write failed'}).` };

  const after = await fireSingle(requester, 'getStop', { stopNbr }, creds);
  calls.reads += 1;
  if (!after?.ok) {
    return { ok: false, unverified: true, calls, error: `setStopContact: the contact was accepted but the read-back failed (${after?.error || 'read failed'}) — check ${stopNbr} in the portal before re-trying.` };
  }
  const rawAfter = rawStopFrom(after.raw ?? after);
  // Read-back identity first — same rule as the note and date paths (§ ESTES-2938079387).
  // `pinned` = the caller supplied the on-screen record's id and it IS the id we wrote —
  // only then may the twin banner say "the record on your screen" (the unpinned flip case
  // inverted both identity claims). An unidentifiable read-back (200, no usable stopId) is
  // the same two-different-things trap and verdicts as unverified instead of being diffed.
  const pinned = isIdShaped(payload?.stopId) && String(payload.stopId) === String(stopId);
  const rbTwin = readBackInstanceMismatch('setStopContact', stopNbr, stopId, rawAfter, pinned);
  if (rbTwin) return { ok: false, unverified: true, wrongInstanceReadback: true, calls, error: rbTwin };
  const rbNoId = readBackUnidentifiable('setStopContact', stopNbr, stopId, rawAfter);
  if (rbNoId) return { ok: false, unverified: true, calls, error: rbNoId };
  const now = stopContactFrom(rawAfter);
  // NuVizz upper-cases what it stores, so the name is compared case-insensitively; the number
  // is compared on digits, because it echoes the formatting back however it likes.
  const landed = (!name || now.name.toUpperCase() === name.toUpperCase())
    && (!phone || normalizeContactPhone(now.phone) === phone);
  // The contact is the field we came to change, so it is excluded from the drift diff the way
  // `comments` is on a note and `schedule` is on a date change. Everything else must still come
  // back byte-identical — including to.contact.EMAIL, which we never send and which the guard
  // list still watches.
  const afterEcho = buildPartialUpdateStop(rawAfter, { [side]: { ...rawAfter?.[side], contact: sent?.[side]?.contact } });
  const drift = orderDriftPaths([...new Set([
    ...fingerprintDrift(fpBefore, stopNoteFingerprint(rawAfter)).filter((p) => p !== `${side}.contact.phone`),
    ...echoDrift(sent, afterEcho),
  ])]);
  const losses = unsentLosses(rawBefore, rawAfter);
  if (drift.length || losses.length) {
    const details = [...driftDetail(sent, afterEcho, drift), ...losses.map((l) => `${l.path}: LOST ${l.lost.join(' · ')}`)];
    const paths = [...drift, ...losses.map((l) => l.path)];
    return {
      ok: false, contactLanded: landed, drift: paths, driftDetails: details, calls,
      error: `setStopContact: the contact ${landed ? 'landed' : 'did NOT land'} BUT partialUpdate changed ${paths.length} other field(s) on the order.${addressDriftWarning(paths)} ${details.join(' | ')}${paths.length > details.length ? ` (+${paths.length - details.length} more)` : ''}. Check ${stopNbr} in the portal — do not use this again until it is investigated.`,
    };
  }
  if (!landed) {
    return { ok: false, calls, error: `setStopContact: NuVizz accepted the write but ${stopNbr} still reads ${[now.name, now.phone].filter(Boolean).join(' · ') || 'no contact'} when read back — nothing else changed. Try again, or set it in the portal.` };
  }

  return { ok: true, stopNbr, stopId, side, was, now, wrote: { name: name || null, phone: phone || null }, calls };
}

/**
 * runNewRoute (§R) — create an EMPTY route the dispatcher can then build onto.
 *
 * Chad, Jul 30: "I want to be able to create a route in the routing tab." Until now nothing
 * in the app could create a route: the Compare Save needs a load that already exists, and
 * the only other create path is the load import — gated OFF since the Jul 2 incident where
 * production treated import REFERENCE stops as full replaces and wiped freight on 10 live
 * orders. Cancelling a route was therefore one-way: the app could destroy one (and, since
 * v0.54.17, easily) but not make one.
 *
 * This uses routePlan/update with the header + the CARD'S ORDERS as PlanStop REFERENCES. The
 * header-only form was refused live (Aug 3, reason 903: "Either PlanStop or Stop node should
 * be present"), so a route cannot be created empty — the dispatcher builds it locally in
 * Compare and the create sends the route AND its whole stop list in one call (Chad's design,
 * Aug 3). A PlanStop carries no address/freight by schema ("only the schedule and route
 * information is updated"), so the Jul 2 failure mode stays structurally impossible.
 *
 * THE CALL LADDER, and the first two rungs are the safety:
 *   1. READ  the load number. routePlan/update is "create OR UPDATE" — aimed at a number that
 *            already exists it would EDIT that route's header. So a create demands a clean
 *            404 first: anything else (the load resolves, OR the read fails and we cannot
 *            tell) refuses. Never write blind at a number that might be a live route.
 *   2. READ  every order on the card (parallel). Each planStops entry MOVES that stop onto
 *            the new route, so each must be readable, UNPLANNED (never silently steal a stop
 *            off a live load) and not yet executed. Any failure refuses the WHOLE create —
 *            nothing written. Each stop's own from/to schedule is echoed into its reference.
 *   3. WRITE the header + references, in card order (seq 1..N).
 *   4. VERIFY by reading the load back — the ack is async and a 200 is not proof (§I). The
 *            read-back confirms the ROUTE NAME landed AND every order rides the route; the
 *            confirmed plan is written through to the board (#361) so the stops flip planned
 *            (and drop their stale drivers) without waiting for a scan.
 *   5. Optionally ASSIGN + DISPATCH the staged driver — same one-Save contract as an
 *            existing load's card. An assign failure never un-reports a created route: the
 *            result stays ok with a loud warning.
 */
// load/info answers for a number the tenant does not hold. 404 is the documented shape; 400 is
// what the live DAVIS tenant actually returns (Jul 31). Both = "no load there".
export const LOAD_ABSENT_STATUSES = new Set([400, 404]);

export function routeCreateBlocked(): boolean {
  // Emergency hard-off, mirroring NUVIZZ_LOAD_IMPORT's brake — but DEFAULT-ON, because this
  // path carries no stop data and its worst case is a spare empty route (cancellable in-app).
  // Set NUVIZZ_ROUTE_CREATE=0/false/off/no to kill it without a deploy.
  return /^(0|false|off|no)$/i.test(String(process.env.NUVIZZ_ROUTE_CREATE ?? '').trim());
}

export async function runNewRoute(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  if (routeCreateBlocked()) return { ok: false, blocked: true, error: 'route creation is disabled on this server (NUVIZZ_ROUTE_CREATE=off)' };
  const steps: any[] = [];
  const loadNbr = String(payload?.loadNbr ?? '').trim();
  const routeName = String(payload?.routeName ?? '').trim();
  if (!loadNbr) return { ok: false, error: 'createRoute: loadNbr is required', steps };
  // The card's orders, in card order. `seedStopNbr` (singular) is the short-lived first-order
  // form of this op — accepted so a stale tab's Save still works.
  const nbrsIn = Array.isArray(payload?.orderedStopNbrs) ? payload.orderedStopNbrs.map((n: any) => String(n ?? '').trim()).filter(Boolean) : [];
  const seedLegacy = String(payload?.seedStopNbr ?? '').trim();
  const nbrs: string[] = nbrsIn.length ? nbrsIn : (seedLegacy ? [seedLegacy] : []);
  // NuVizz refuses a stopless route (903, live Aug 3) — refuse up front, zero calls.
  if (!nbrs.length) return { ok: false, error: 'createRoute: the route needs at least one order — NuVizz will not create an empty one (reason 903). Drag orders onto the card, then Save', steps };
  const dupes = nbrs.filter((n, i) => nbrs.indexOf(n) !== i);
  if (dupes.length) return { ok: false, error: `createRoute: order ${dupes[0]} appears twice on the card — remove the duplicate and re-Save`, steps };

  // ── 1. COLLISION GUARD — the number must be genuinely free ──────────────────
  const pre = await fetchLoad(requester, loadNbr, creds);
  steps.push({ op: 'getLoad', ok: true, result: { found: !!pre.load, httpStatus: pre.httpStatus }, error: null });
  if (pre.load) {
    return { ok: false, exists: true, loadNbr, loadId: pre.load.loadId ?? null,
      error: `createRoute: load ${loadNbr} already exists in NuVizz (${loadDisplayLabel(pre.load)}) — pick a different route name/date, or open that route from the board instead`, steps };
  }
  // WHICH ANSWERS MEAN "FREE". load/info returns 400 — not 404 — for a load number the tenant
  // does not have. Observed on the first real create (Jul 31): TRAILER-0731 refused itself with
  // "NuVizz answered 400 to the check" on a number that plainly did not exist. (The STOP
  // existence gate above sees a true 404, so the two endpoints genuinely differ.) Either way
  // the read came back with NO LOAD, so there is nothing at that number to overwrite.
  //
  // Everything else still refuses: 401/403 (auth), 429 (throttled) and 5xx/network are
  // "I could not check", and creating on one risks silently editing a live route's header.
  // A malformed number is safe here too — it simply fails the CREATE below, loudly, having
  // written nothing.
  if (pre.httpStatus != null && !LOAD_ABSENT_STATUSES.has(pre.httpStatus)) {
    return { ok: false, error: `createRoute: could not confirm load ${loadNbr} is free (NuVizz answered ${pre.httpStatus} to the check) — nothing was created; try again`, steps };
  }

  // ── 2. ORDER GUARD — every order must be readable, unplanned and unexecuted ──
  // Each planStops entry MOVES that stop onto the new route, so each gets the same respect
  // as an RWB add: never write on a stop we could not read, never silently steal a stop off
  // a live load, never plan work a driver already acted on. ANY failure refuses the WHOLE
  // create — a partial route the dispatcher didn't ask for is worse than a loud refusal.
  // The reads also donate each stop's OWN from/to schedule for its reference (echo, never
  // invent). Parallel, like the RWB path's per-added-stop reads.
  const reads = new Map<string, any>(await Promise.all(nbrs.map(async (n): Promise<[string, any]> => {
    try { return [n, await fireSingle(requester, 'getStop', { stopNbr: n }, creds)]; }
    catch (e: any) { return [n, { ok: false, error: e?.message || 'getStop failed' }]; }
  })));
  steps.push({ op: 'getStops', ok: true, result: { requested: nbrs.length, readable: [...reads.values()].filter((g: any) => g?.ok && g.stop?.stopId).length }, error: null });
  for (const n of nbrs) {
    const gs = reads.get(n);
    if (!gs?.ok || !gs.stop?.stopId) {
      return { ok: false, error: `createRoute: could not read order ${n} (stale board — refresh and re-Save) — nothing was created`, steps };
    }
    const holderNbr = String(gs.stop?.assignedLoadNbr ?? '').trim();
    if (holderNbr) {
      const src = loadLabel(gs.stop?.routeName, holderNbr);
      return { ok: false, error: `createRoute: order ${n} is ALREADY PLANNED on ${src} — remove it from this card, or open ${src} in Compare to move it. Nothing was created`, steps };
    }
    const st = String(gs.stop?.status ?? '').trim();
    if (isExecutedStopStatus(st)) {
      return { ok: false, error: `createRoute: order ${n} is already ${st} — finished work cannot ride a new route. Remove it and re-Save. Nothing was created`, steps };
    }
  }

  // ── 3. WRITE the header + the references, in card order ─────────────────────
  const r = await fireSingle(requester, 'createRoute', {
    route: {
      loadNbr, routeName: routeName || undefined,
      date: payload?.date ?? null,
      earliestStartDttm: payload?.earliestStartDttm ?? null,
      latestStartDttm: payload?.latestStartDttm ?? null,
      origin: payload?.origin ?? null,
      loadTimeZone: payload?.loadTimeZone ?? null,
      seeds: nbrs.map((n) => {
        const raw = reads.get(n)?.raw || {};
        return { stopNbr: n, fromSchedule: raw?.from?.schedule ?? null, toSchedule: raw?.to?.schedule ?? null };
      }),
    },
  }, creds);
  steps.push({ op: 'createRoute', ok: !!r.ok, result: r, error: r.ok ? null : (r.error || 'failed') });
  if (!r.ok) return { ok: false, error: `createRoute: ${r.error || 'NuVizz rejected the route'}`, steps };

  // ── 4. VERIFY — the ack is async; only a read proves the route exists ────────
  // The read-back must also show the ORDERS riding it: the async worker can land the header
  // without the plan, and "created" with stops silently unattached is the same dispatcher
  // trap as a renamed route.
  const pacing = payload?.pacing || {};
  const tries = Number(pacing.tries ?? 6);
  const waitMs = Number(pacing.waitMs ?? 1500);
  const sleep = pacing.sleep || ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const wantSet = new Set(nbrs.map(normStopNbr));
  let made: any = null;
  let attachedNbrs: string[] = [];
  for (let i = 0; i < tries; i++) {
    await sleep(waitMs);
    const f = await fetchLoad(requester, loadNbr, creds);
    if (!f.load) continue;
    made = f.load;
    // The load's DELIVERY stops in NuVizz's own visit order, narrowed to what we asked for —
    // this observed order (not our requested one) is what the board write-through stamps.
    attachedNbrs = deliveryOrder(made).filter((n) => wantSet.has(normStopNbr(n)));
    if (attachedNbrs.length === nbrs.length) break;   // keep polling while the plan settles
  }
  const allAttached = attachedNbrs.length === nbrs.length;
  steps.push({ op: 'verifyLoad', ok: !!made, result: { found: !!made, requested: nbrs.length, attached: attachedNbrs.length }, error: made ? null : 'not readable yet' });
  if (!made) {
    return { ok: false, pending: true, loadNbr,
      error: `createRoute: NuVizz accepted the route but ${loadNbr} is not readable yet — it may still land. Refresh in a moment before creating it again (do NOT re-create with the same name).`, steps };
  }
  // The name is verified, not assumed: an import-family endpoint that quietly assigns its own
  // name would otherwise report success for a route the dispatcher can't find on the board.
  const gotName = String(made.routeName ?? '').trim();
  const nameOk = !routeName || gotName === routeName;
  const warnings: string[] = [];
  if (!nameOk) warnings.push(`NuVizz created the route but named it "${gotName || '(none)'}" instead of "${routeName}" — it will show under that name on the board.`);
  if (!allAttached) warnings.push(`The route exists but only ${attachedNbrs.length} of ${nbrs.length} orders have attached so far — give it a moment, then reopen the route in Compare and re-Save the stragglers (do NOT re-create).`);

  // ── 5. ASSIGN + DISPATCH the staged driver (optional, same Save) ─────────────
  // The card's staged assignment rides the create so "send new route and all stops at same
  // time" includes the driver. Failures here never un-report a created route — the route and
  // its plan are already real in NuVizz; the warning says exactly what's left to do.
  let driverApplied = false, dispatched = false;
  if (hasDriverId(payload?.driverId)) {
    const routeId = made.loadId ?? null;
    if (!routeId) {
      warnings.push('Route created, but the driver was NOT assigned (no internal load id came back) — assign from the card and re-Save.');
    } else {
      const a = await fireSingle(requester, 'assignDriver', { routeId, driverId: payload.driverId }, creds);
      steps.push({ op: 'assignDriver', ok: !!a.ok, result: a, error: a.ok ? null : (a.error || 'failed') });
      driverApplied = !!a.ok;
      if (!a.ok) warnings.push(`Route created, but the driver was NOT assigned (${a.error || 'NuVizz refused'}) — assign from the card and re-Save.`);
      else if (payload?.dispatch) {
        const d = await fireSingle(requester, 'dispatchLoad', { routeId }, creds);
        steps.push({ op: 'dispatchLoad', ok: !!d.ok, result: d, error: d.ok ? null : (d.error || 'failed') });
        dispatched = !!d.ok;
        if (!d.ok) warnings.push(`Route created and driver assigned, but the DISPATCH failed (${d.error || 'NuVizz refused'}) — dispatch from the card and re-Save.`);
      }
    }
  }

  // ── 6. BOARD WRITE-THROUGH — same contract as the commit paths (#361) ────────
  // The read-back just CONFIRMED which orders ride the new route, so stamp the board with
  // that OBSERVED order: without this the stops keep showing unplanned (and carrying their
  // old drivers) until the next scan. Best-effort — a board hiccup never fails a create
  // NuVizz confirmed.
  let boardSync: any = null;
  if (attachedNbrs.length && isFirestoreEnabled()) {
    try {
      const tenantET = String((creds as any)?.companyCode || 'DAVIS').toUpperCase();
      const boardDay = /^\d{4}-\d{2}-\d{2}$/.test(String(payload?.date ?? '')) ? String(payload.date) : etDayString();
      const b = await patchBoardPlan(tenantET, boardDay, {
        routeName: (gotName && !isHashLikeId(gotName)) ? gotName : String(made.loadNbr ?? loadNbr),
        orderedStopNbrs: attachedNbrs.map(String),
        driverName: driverApplied ? (payload?.driverName ?? null) : null,
        at: new Date().toISOString(),
      });
      boardSync = { patched: b.patched, rescued: b.rescued, missing: b.missing };
    } catch (e: any) { boardSync = { error: e?.message || 'board write-through failed' }; }
  }

  return {
    ok: true, loadNbr: made.loadNbr ?? loadNbr, loadId: made.loadId ?? null,
    routeName: gotName || null, requestedRouteName: routeName || null, nameMatched: nameOk,
    stopsRequested: nbrs.length, stopsAttached: attachedNbrs.length, allAttached,
    driverApplied, dispatched,
    // Echoes for the short-lived first-order client (a stale tab): its card-seeding reads these.
    ...(seedLegacy ? { seedStopNbr: seedLegacy, seedAttached: allAttached } : {}),
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    ...(boardSync ? { boardSync } : {}),
    steps,
  };
}

function loadDisplayLabel(load: any): string {
  const n = String(load?.routeName ?? '').trim();
  return n && !isHashLikeId(n) ? n : String(load?.loadNbr ?? 'existing load');
}

export async function runOp(requester: RequesterLike, op: WriteOp, payload: any, creds: WriteCreds): Promise<any> {
  switch (op) {
    // The Compare panel's Save: the in-panel engine toggle sends useRwb OR useImport on the
    // payload; both need the server's explicit re-enable (NUVIZZ_RWB_ENABLED / NUVIZZ_LOAD_IMPORT)
    // — otherwise every Save runs the classic anchor engine. RWB is checked first since a Save
    // should never carry both flags (the client toggle is one engine at a time).
    case 'commitBoard':
      if (payload?.useRwb === true && !rwbEngineBlocked()) return runCommitBoardRwb(requester, payload, creds);
      return (payload?.useImport === true && !loadImportBlocked())
        ? runCommitBoardImport(requester, payload, creds)
        : runCommitBoard(requester, payload, creds);
    case 'commitLoad': return runCommitLoad(requester, payload, creds);
    case 'removeStops': return runRemoveStops(requester, payload, creds);
    case 'assignDriver':
    case 'dispatchLoad': return runAssignDispatch(requester, op, payload, creds);
    case 'importLoad': return runImportLoad(requester, payload, creds);
    case 'commitImport': return runCommitImport(requester, payload, creds);
    case 'addStopNote': return runAddStopNote(requester, payload, creds);
    case 'setStopDate': return runSetStopDate(requester, payload, creds);
    case 'setStopAddress': return runSetStopAddress(requester, payload, creds);
    // Destructive: read → judge → cancel by id. See runCancelOrder.
    case 'cancelOrder': return runCancelOrder(requester, payload, creds);
    case 'setStopContact': return runSetStopContact(requester, payload, creds);
    // §R — the orchestration (collision check → header write → read-back verify). The bare
    // 'createRoute' single op stays available for tests/diagnostics; the app calls 'newRoute'.
    case 'newRoute': return runNewRoute(requester, payload, creds);
    default: return fireSingle(requester, op as SingleOp, payload, creds);
  }
}

function req<T>(v: T, label: string): T {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) throw new Error(`missing required field — ${label}`);
  return v;
}
