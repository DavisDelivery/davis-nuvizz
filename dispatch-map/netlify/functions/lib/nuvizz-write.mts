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
  buildOpRequest, parseOpResponse, toEditHeader, normalizeLoad,
  type SingleOp, type WriteOp, type WriteCreds,
} from './nuvizz-write-ops.mts';

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

/** GET load/info → normalized load (loadId, versionId, raw loadHeader, stops). */
export async function fetchLoad(requester: RequesterLike, loadNbr: string, creds: WriteCreds): Promise<any> {
  const r = await fireSingle(requester, 'getLoad', { loadNbr }, creds);
  // normalizeLoad ALWAYS returns an object (even for a 404/empty body), so "not found" must be
  // detected by a non-2xx response or a missing loadId — never edit/dispatch a phantom load.
  if (!r.ok || !r.load || r.load.loadId == null) return null;
  return r.load;
}

/**
 * removeStops (§3.5): ALWAYS resolve the echoed header + versionId from a live getLoad —
 * we never trust a caller-supplied editHeader/versionId. load/edit is a full-header replace,
 * so echoing a hand-crafted/stale header could blank live load fields; server-resolving the
 * header from NuVizz is the only safe contract.
 */
async function runRemoveStops(requester: RequesterLike, payload: any, creds: WriteCreds): Promise<any> {
  const loadNbr = req(payload?.loadNbr, 'removeStops: loadNbr');
  const load = await fetchLoad(requester, loadNbr, creds);
  if (!load) return { ok: false, error: 'removeStops: load not found', loadNbr };
  return fireSingle(requester, 'removeStops', { removeStopIds: payload?.removeStopIds, editHeader: toEditHeader(load.loadHeader), versionId: load.versionId }, creds);
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
  // remove needs the header/versionId, or when no loadId was supplied.
  let loadId = payload?.loadId ?? null;
  let editHeader: any = null, versionId: any = null;

  const needLoad = (!loadId && (insertStopIds.length || hasDriver || dispatch)) || removeStopIds.length;
  if (needLoad) {
    if (!loadNbr) return { ok: false, error: 'commitLoad: loadNbr required to resolve load', loadNbr, loadId, steps: [] };
    const load = await fetchLoad(requester, loadNbr, creds);
    if (!load) return { ok: false, error: 'commitLoad: load not found', loadNbr, loadId, steps: [] };
    loadId = loadId || load.loadId;
    // NOTE: versionId/editHeader are snapshotted from this single getLoad. Safe today because
    // removeStops runs FIRST and is the only step that uses them; if a future step re-edits the
    // header after a remove, re-fetch the load to refresh the (now-bumped) versionId.
    editHeader = toEditHeader(load.loadHeader);
    versionId = load.versionId;
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

/**
 * runOp — single entry for the handler. `op` is validated by the caller against the
 * allowlist. Returns a plain object (never throws for a *NuVizz* failure — those are
 * reported as { ok:false, error }); a malformed-payload throw from a builder propagates
 * so the handler maps it to a 400.
 */
export async function runOp(requester: RequesterLike, op: WriteOp, payload: any, creds: WriteCreds): Promise<any> {
  switch (op) {
    case 'commitLoad': return runCommitLoad(requester, payload, creds);
    case 'removeStops': return runRemoveStops(requester, payload, creds);
    default: return fireSingle(requester, op as SingleOp, payload, creds);
  }
}

function req<T>(v: T, label: string): T {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) throw new Error(`missing required field — ${label}`);
  return v;
}
