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
  buildOpRequest, parseOpResponse, toEditHeader, normalizeLoad, planSequence,
  type SingleOp, type WriteOp, type WriteCreds,
} from './nuvizz-write-ops.mts';
import { isHashLikeId } from './nuvizz-list.mts';

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
  request(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string | null }, meta: { route: string; tenant: string; source?: string }): Promise<Response>;
}

async function safeJson(resp: Response): Promise<any> {
  try { return await resp.json(); }
  catch { try { return { _text: await resp.text() }; } catch { return {}; } }
}

async function fireSingle(requester: RequesterLike, op: SingleOp, payload: any, creds: WriteCreds): Promise<any> {
  const br = buildOpRequest(op, payload, creds);
  const resp = await requester.request(br.url, { method: br.method, headers: br.headers, body: br.body }, br.meta);
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
export async function resolveLoadNbrById(requester: RequesterLike, loadId: string, creds: WriteCreds): Promise<string | null> {
  try {
    const r = await fireSingle(requester, 'getLoadByRouteId', { routeId: loadId }, creds);
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
function hasUnmodeledDelivery(load: any): boolean {
  return (load?.stops || []).some((s: any) => String(s?.stopType || '').toUpperCase() !== 'DO' && Number(s?.stopSeq ?? 0) > 1);
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
    // Reorder / unplan / empty needs the load's CURRENT stops (a getLoad), which needs a real loadNbr.
    // If static/info also couldn't resolve one, guide the dispatcher to open it from the board.
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
    const cancelled = !!p.plan.cancelRoute && /cancel/i.test(String(r.error ?? ''));
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

  // Orphans: a stop that was FREED (removed from its source) and was meant to land on some load
  // (in a desired order) but its insert never succeeded — it is now UNPLANNED in NuVizz. Surfaced
  // so the dispatcher can re-Save. (A freed stop NOT in any desired order is an intended unplan.)
  const intendedOnSomeLoad = new Set<string>();
  for (const p of live) for (const id of (p.want || [])) intendedOnSomeLoad.add(String(id));
  const orphaned = [...actuallyFreed].filter((id) => intendedOnSomeLoad.has(id) && !inserted.has(id));

  const loads = planned.map((p) => ({ loadNbr: p.result.loadNbr, loadId: p.loadId ?? p.L?.loadId ?? null, ok: p.result.ok, error: p.result.error, steps: p.result.steps }));
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

export async function runOp(requester: RequesterLike, op: WriteOp, payload: any, creds: WriteCreds): Promise<any> {
  switch (op) {
    case 'commitBoard': return runCommitBoard(requester, payload, creds);
    case 'commitLoad': return runCommitLoad(requester, payload, creds);
    case 'removeStops': return runRemoveStops(requester, payload, creds);
    case 'assignDriver':
    case 'dispatchLoad': return runAssignDispatch(requester, op, payload, creds);
    default: return fireSingle(requester, op as SingleOp, payload, creds);
  }
}

function req<T>(v: T, label: string): T {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) throw new Error(`missing required field — ${label}`);
  return v;
}
