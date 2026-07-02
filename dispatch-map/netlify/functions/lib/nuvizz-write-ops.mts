// lib/nuvizz-write-ops.mts
//
// ── NuVizz v7 WRITE ops — PURE builders + parsers (no I/O) ────────────────────
//
// This is the first WRITE path in the app (the rest of the NuVizz integration is
// read-only: scan/list/roster). Everything here is a PURE function — it builds the
// exact request (url + method + headers + body + accounting meta) for each v7 write
// op, and parses each response — so it is fully unit-testable with no network and no
// Firestore. The IMPURE executor that actually fires these through the metered
// requester lives in nuvizz-write.mts (runOp); the HTTP op-envelope + safety guards
// live in the nuvizz-write.mts handler.
//
// Source of truth for the call shapes: the NuVizz integration handoff doc
// ("NuVizz API — integration handoff (Davis Dispatch)"). Every route/body/parse
// below mirrors a numbered section of that doc:
//   createStop   §3.1  POST stop/sync/update/{cc}
//   getStop      §3.2  GET  stop/info/{stopNbr}/{cc}
//   getLoad      §3.3  GET  load/info/{loadNbr}/{cc}
//   insertStops  §3.4  POST load/insertstops/{cc}
//   removeStops  §3.5  POST load/edit/{cc}            (full-header echo — see toEditHeader §5)
//   assignDriver §3.6  POST load/assignanddispatch/{cc} action ASSIGN_DISPATCH
//   dispatchLoad §3.7  POST load/assignanddispatch/{cc} action DISPATCH
//   roster       §3.8  POST user/list/{cc}
//   stop payload §4    buildStopPayload(row, settings)
//   edit header  §5    toEditHeader(loadHeader)
//   parsing      §6    summarize / assignOk / normalizeStop / normalizeLoad
//
// NB: We deliberately do NOT include any raw network call here, and we never hard-code
// a NuVizz hostname — the base URL is passed in (resolved from NUVIZZ_BASE_URL by the
// executor). Both keep this module clean of the no-direct-nuvizz guard and host-agnostic
// for UAT vs prod.

// The single-record (GET) read ops plus the POST writes. `commitLoad` is an
// orchestration handled by the executor (a Save batch), not a single request, so it
// is not in this builder allowlist.
export const SINGLE_OPS = [
  'createStop', 'getStop', 'getLoad', 'getLoadByRouteId', 'insertStops', 'removeStops',
  'assignDriver', 'dispatchLoad', 'roster', 'importLoad',
] as const;
export type SingleOp = typeof SINGLE_OPS[number];

// Ops the HTTP handler accepts (single ops + the per-load Save batch + the panel Save +
// the async load-import commit with its convergence recipe).
export const WRITE_OPS = [...SINGLE_OPS, 'commitLoad', 'commitBoard', 'commitImport'] as const;
export type WriteOp = typeof WRITE_OPS[number];

/** Ops that MUTATE NuVizz (everything except the GET reads). Used by the
 *  handler to decide which ops need the write-enabled gate + idempotency. */
export const MUTATING_OPS = new Set<WriteOp>([
  'createStop', 'insertStops', 'removeStops', 'assignDriver', 'dispatchLoad',
  'importLoad', 'commitLoad', 'commitBoard', 'commitImport',
]);

export interface WriteCreds {
  /** v7 API base, e.g. https://portal.nuvizz.com/deliverit/openapi/v7 (no trailing slash). */
  base: string;
  /** Company code path segment + (createStop) body field, e.g. 'DAVIS'. */
  companyCode: string;
  /** 'Basic …' header value. */
  auth: string;
}

export interface BuiltRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** JSON string body for POSTs; undefined for GETs. */
  body?: string;
  /** Accounting meta for the metered requester ({route, tenant}). */
  meta: { route: string; tenant: string; source: string };
}

const enc = (s: string) => encodeURIComponent(String(s ?? ''));

// NuVizz driverId is a numeric userId; an HTML <select> hands its value back as a STRING, so a
// quoted "11" would reach NuVizz and be rejected. Coerce a numeric string to a real number;
// leave anything non-numeric untouched.
const numericId = (v: any) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v);

function jsonHeaders(auth: string): Record<string, string> {
  return { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' };
}

// ── §4  STOP payload for createStop ──────────────────────────────────────────

export interface StopRow {
  name: string; addr1: string; city: string; state: string; zip: string;
  addr2?: string | null;
  stopNbr?: string | null;       // your order number
  pro?: string | null;           // PRO / shipment number (optional)
  pallets?: number | null; cartons?: number | null; weight?: number | null;
}
export interface OriginSettings {
  origin: { name: string; addr1: string; city: string; state: string; zip: string };
  serviceDate: string;           // 'YYYY-MM-DD'
  timeZone?: string;             // default America/New_York
}

const numOrNull = (x: any): number | null => {
  if (x == null || String(x).trim() === '') return null;
  const n = Number(x); return Number.isFinite(n) ? n : null;
};

/**
 * Build the STOP_PAYLOAD (§4). Required row fields: name, addr1, city, state, zip.
 * GOTCHAS baked in (learned live, §4): never send shipForBP or profile on an open
 * import; include a real zip (NuVizz geocodes from the address).
 */
export function buildStopPayload(row: StopRow, settings: OriginSettings): any {
  const tz = settings.timeZone || 'America/New_York';
  const d = settings.serviceDate;
  const pro = row.pro ? String(row.pro) : '';
  const pallets = numOrNull(row.pallets);
  return {
    stopNbr: row.stopNbr ? String(row.stopNbr) : undefined,
    stopType: 'DO', shipmentType: 'REG', stopExecution: 'APP', sourceType: 'INTG',
    shipmentNbr: pro || undefined, proNumber: pro || undefined,
    reference1: pro ? `PRO ${pro}` : undefined,
    totalPallets: pallets ?? 1,
    totalCartons: numOrNull(row.cartons),
    weight: numOrNull(row.weight),
    weightUOM: 'LBS',
    from: {
      address: {
        addressType: 'COM', name: settings.origin.name, addr1: settings.origin.addr1,
        city: settings.origin.city, state: settings.origin.state, zip: settings.origin.zip, country: 'USA',
      },
      schedule: { timeFrom: `${d}T08:00:00`, timeTo: `${d}T12:00:00`, timeZone: tz, timeConstraint: 'PREFERRED' },
    },
    to: {
      address: {
        addressType: 'COM', name: row.name, addr1: row.addr1, addr2: row.addr2 || undefined,
        city: row.city, state: row.state, zip: row.zip, country: 'USA',
      },
      schedule: { timeFrom: `${d}T12:00:00`, timeTo: `${d}T17:00:00`, timeZone: tz, timeConstraint: 'PREFERRED' },
    },
  };
}

// ── §5  load/info loadHeader → load/edit header (for removeStops) ─────────────
//
// load/edit is a FULL header replace — anything not echoed back blanks out. Map the
// load/info loadHeader to the edit-header shape. seqMode 'None' so the edit does not
// re-sequence; scheduleStart/End come from earliest/latest start. Unknown/absent
// fields are simply omitted (NuVizz keeps its own value when the key is absent for
// the optional ones; the doc's set below is the safe echo list).

const EDIT_HEADER_PASSTHROUGH = [
  'loadId', 'routeName', 'routeDesc', 'signatureRequired', 'rtOrigin', 'depot', 'facility',
  'masterBol', 'pronbr', 'reference', 'reference2', 'reference3', 'sealNbr', 'totalCartons',
  'totalPallets', 'vehicleType', 'volume', 'volumeUOM', 'weight', 'weightUOM', 'cusAccNbr',
  'returnToDepot', 'congestionFactor', 'sourceType', 'customAttributes', 'maxRouteTime',
  'shiftType', 'maxDistMiles', 'cutOffTime',
] as const;

export function toEditHeader(loadHeader: any): any {
  const h = loadHeader || {};
  const out: any = { seqMode: 'None' };
  for (const k of EDIT_HEADER_PASSTHROUGH) {
    // Full-header replace: echo a present-but-null field AS null rather than dropping the key,
    // so load/edit can never reset it to a server default (strictly closer to "echo it back").
    if (h[k] !== undefined) out[k] = h[k] ?? null;
  }
  // Schedule fields map from the load's earliest/latest start (doc §5).
  if (h.earliestStartDttm != null) out.scheduleStartDttm = h.earliestStartDttm;
  if (h.latestStartDttm != null) out.scheduleEndDttm = h.latestStartDttm;
  return out;
}

// ── §6  Response parsing helpers ─────────────────────────────────────────────

export interface WriteSummary {
  ok: boolean;
  entityId?: string | null;   // createStop → stopId
  entityNbr?: string | null;  // createStop → stopNbr
  updated?: boolean;          // createStop → the stop ALREADY EXISTED and was UPDATED (upsert), not created
  error?: string | null;
}

/**
 * summarize (§6) — for createStop / insertStops / removeStops. ok when the body shows
 * a created/updated apiResult with entityInfoList, OR status==='SUCCESS', OR it is a
 * 2xx with no reasons/error. Pulls entityId/entityNbr. Error text is drawn from the
 * first available of reasons[0].description / apiResult.errors[0].msgs / error / message.
 */
export function summarize(httpOk: boolean, j: any): WriteSummary {
  const body = j || {};
  const err = firstError(body);
  const created = body?.apiResult?.created || body?.apiResult?.updated;
  const ent = Array.isArray(body?.entityInfoList) && body.entityInfoList.length ? body.entityInfoList[0] : null;
  const statusRaw = String(body?.status ?? '').toUpperCase();
  const statusSuccess = statusRaw === 'SUCCESS';
  // A present-but-non-SUCCESS status (PARTIALSUCCESS / FAILURE / REJECT / …) is NOT ok — never let
  // the bare "2xx with no reasons[]" fallback below swallow a partial/failed apply as success.
  const statusBad = statusRaw !== '' && !statusSuccess;
  const ok = !err && !statusBad && (Boolean(created && ent) || statusSuccess || (httpOk && !hasReasons(body)));
  return {
    ok,
    entityId: ent?.entityId ?? null,
    entityNbr: ent?.entityNbr ?? null,
    // stop/sync/update is an UPSERT — surface "this UPDATED an existing record" distinctly so a
    // createStop caller can warn instead of announcing a clean create that silently overwrote.
    updated: Boolean(body?.apiResult?.updated) && !body?.apiResult?.created,
    error: ok ? null : (err || (httpOk ? null : 'request failed')),
  };
}

/** assignOk (§6) — for assign/dispatch. ok when status (case-insensitive) === 'success'. */
export function assignOk(j: any): { ok: boolean; error: string | null } {
  const status = String(j?.status ?? '').trim().toLowerCase();
  if (status === 'success') return { ok: true, error: null };
  return { ok: false, error: firstError(j) || `assign/dispatch status='${j?.status ?? ''}'` };
}

function hasReasons(body: any): boolean {
  return Array.isArray(body?.reasons) && body.reasons.length > 0;
}
function firstError(body: any): string | null {
  if (!body || typeof body !== 'object') return null;
  const r = Array.isArray(body.reasons) && body.reasons.length ? body.reasons[0] : null;
  if (r && (r.description || r.msg || r.message)) return String(r.description || r.msg || r.message);
  const ae = body?.apiResult?.errors;
  if (Array.isArray(ae) && ae.length) {
    const m = ae[0]?.msgs ?? ae[0]?.msg ?? ae[0];
    if (m) return Array.isArray(m) ? String(m[0]) : String(m);
  }
  if (body.error) return String(body.error);
  if (body.message) return String(body.message);
  // Non-JSON NuVizz error body (safeJson wraps it as {_text}); surface it rather than dropping it.
  if (body._text) { const t = String(body._text).trim(); if (t) return t.slice(0, 300); }
  return null;
}

/** normalizeStop (§6) — getStop response → flat shape (incl. the load it's on now). */
export function normalizeStop(j: any): any {
  const S = j?.Stop || j || {};
  const stop = S.stop || {};
  const exec = S.stopExecutionInfo || {};
  const load = S.load || {};
  const toAddr = stop?.to?.address || {};
  return {
    stopId: stop.stopId ?? null,
    stopNbr: stop.stopNbr ?? null,
    status: exec.stopStatus ?? null,
    assignedLoadNbr: load.loadNbr ?? null,   // null/absent ⇒ unplanned
    routeName: load.routeName ?? null,
    toName: toAddr.name ?? null,
    toCity: toAddr.city ?? null,
    toState: toAddr.state ?? null,
    latitude: toAddr.latitude ?? null,
    longitude: toAddr.longitude ?? null,
    // The stop's own "to" block echoed as a ready-to-send import REFERENCE (§I) — this is how
    // an UNPLANNED order gets planned by the import path without the client holding any address
    // data: the reference is built from NuVizz's own record, so nothing can drift or regress.
    importRef: importRefFromRaw(stop),
    // The stop's "from" address (the warehouse the order ships from) — an ORIGIN DONOR for the
    // import header when the target load is EMPTY (no stops of its own to echo the origin from).
    fromAddress: stop?.from?.address ?? null,
  };
}

/** normalizeLoad (§6) — getLoad response → {loadId, loadNbr, routeName, status, versionId, stops[]}. */
export function normalizeLoad(j: any): any {
  const L = j?.Load || j || {};
  const hdr = L.loadHeader || {};
  const exec = L.loadExecutionInfo || {};
  const stops = Array.isArray(L.stops) ? L.stops.map((s: any) => {
    const st = s?.stop || s || {};
    // Visit order is `stop.to.seq` (doc §10: "always sort by to.seq"; top-level stopSeq is
    // unreliable/often absent on load/info). Fall back to from.seq (a pickup) then stopSeq.
    const seq = st?.to?.seq ?? st?.from?.seq ?? st?.stopSeq ?? null;
    return { stopId: st.stopId ?? null, stopNbr: st.stopNbr ?? null, stopSeq: seq, stopType: st.stopType ?? null };
  }) : [];
  return {
    loadId: hdr.loadId ?? null,
    loadNbr: hdr.loadNbr ?? null,
    routeName: hdr.routeName ?? null,
    status: exec.loadStatus ?? null,
    versionId: L.versionId ?? null,
    loadHeader: hdr,          // kept raw so removeStops can echo it via toEditHeader
    stops,
    // Raw stop entries kept so the import path (§I) can build per-stop REFERENCES (to.address +
    // to.schedule) from NuVizz's own load/info record — echo, never invent.
    rawStops: Array.isArray(L.stops) ? L.stops : [],
  };
}

/** normalizeStaticLoad — load/static/info (StaticRouteView) → { loadId, loadNbr, routeName, stops }.
 * Keyed by routeId, so its job is to hand back the HUMAN loadNbr for a load we only knew by its
 * internal id. (No versionId — the caller does a load/info by the resolved loadNbr for the edit
 * header/versionId the unplan step needs.) */
export function normalizeStaticLoad(j: any): any {
  const L = j?.Load || j || {};
  const hdr = L.loadHeader || {};
  const stops = Array.isArray(L.stops) ? L.stops.map((s: any) => {
    const st = s?.stop || s || {};
    return { stopId: st.stopId ?? null, stopNbr: st.stopNbr ?? null, stopSeq: st?.to?.seq ?? st?.stopSeq ?? null, stopType: st.stopType ?? null };
  }) : [];
  return { loadId: hdr.loadId ?? null, loadNbr: hdr.loadNbr ?? null, routeName: hdr.routeName ?? null, stops };
}

/**
 * parseRoster (§3.8) — user/list response → driver list. Keep ENABLED accounts that
 * carry a DI_Driver role, and (for the clean prod DAVIS roster) drop pure office
 * roles. driverId = userId (a number). Office roles per the doc.
 */
const OFFICE_ROLES = new Set([
  'DI_Dispatcher', 'MemberAdmin', 'GroupAdmin', 'Account_CSR', 'DI_Biller', 'ROUTE_ANALYST',
  'CUST_ADMIN', 'CUST_ASSOCIATE', 'DWH_USER', 'DI_Receiver', 'DI_Inquiry', 'DI_Integration', 'DI_User',
]);
export function parseRoster(j: any): Array<{ driverId: any; userName: string; name: string; mobile: string | null; roles: string[] }> {
  const users = Array.isArray(j?.users) ? j.users : [];
  const out: Array<{ driverId: any; userName: string; name: string; mobile: string | null; roles: string[] }> = [];
  for (const u of users) {
    if (String(u?.accountStatus ?? '').toUpperCase() !== 'ENABLED') continue;
    const roles = Array.isArray(u?.userRoles) ? u.userRoles.map((r: any) => String(r?.role ?? '')).filter(Boolean) : [];
    const isDriver = roles.some((r) => /DI_Driver/i.test(r));
    if (!isDriver) continue;
    // A clean road-driver roster drops accounts whose ONLY roles are office roles
    // (already excluded above by requiring DI_Driver, but keep the office set so a
    // mixed account still surfaces as a driver — driver role wins).
    const name = [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() || String(u?.userName ?? '');
    out.push({
      driverId: u?.userId ?? null,
      userName: String(u?.userName ?? ''),
      name,
      mobile: u?.mobileNumber ? String(u.mobileNumber) : null,
      roles,
    });
  }
  // Present the roster A→Z by display name (case-insensitive) so every driver picker — the
  // Compare-panel "Assign driver…" and the Routes-panel assign dropdown — lists drivers in
  // alphabetical order rather than NuVizz's user/list order. userName breaks ties.
  out.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.userName.localeCompare(b.userName, undefined, { sensitivity: 'base' }));
  return out;
}
// Exported only so a test/diagnostic can assert the office-role set is the doc's.
export const _OFFICE_ROLES = OFFICE_ROLES;

// ── §10 manual sequencing — the Draft→Save "anchor method" (PURE) ────────────
//
// NuVizz can't set an arbitrary stop order in one call: a BULK insertStops auto-optimizes
// (per seqMode) and one-at-a-time inserts APPEND to the end; load/edit's routeSeq is a
// documented no-op. The verified way to realize an exact delivery order [d1..dN] on a load
// (handoff doc §10) is the "anchor method": keep d1 (which must already be on the load) as
// an anchor, removeStops every OTHER current delivery, then insertStops d2..dN one-at-a-time
// in order. Removing ALL stops cancels the route, so we NEVER remove the anchor.
//
// This single recipe also folds in add + remove: a current delivery absent from the desired
// order is simply removed and not re-inserted (a departure); a desired stop absent from the
// load is inserted (an add). Cost ≈ 2 (the load/info+load/edit remove) + (N-1) inserts.
//
// PURE: given the load's current DELIVERY stopIds (in seq order, pickup excluded by the
// caller) and the desired ordered stopIds, return the exact removeStopIds + ordered insert
// list — or refuse the two unsafe cases (empty order → would cancel; first desired stop not
// on the load → append-only can't place a new stop first; that needs the full-rebuild path
// which is not enabled here).
export interface SequencePlan {
  ok: boolean;
  unchanged?: boolean;
  anchor?: string;            // the stop kept as the anchor (the desired first delivery)
  anchorInsert?: string;      // a NOT-yet-on-load first delivery to insert BEFORE any remove (see below)
  removeStopIds?: string[];
  insertOrdered?: string[];   // inserted one-at-a-time, in this order, after the kept prefix
  reason?: string;
}
/**
 * planSequence — realize an exact delivery order with the FEWEST NuVizz calls, honoring the anchor
 * rule (a load can never be emptied → it cancels; the desired FIRST delivery must stay on it).
 *
 * Fewest calls: keep the LONGEST PREFIX of the desired order already on the load in that relative
 * order — those stops cost nothing (no remove, no re-insert). removeStopIds = only what's out of
 * place (one batch call); insertOrdered = the remaining desired stops, appended after the prefix.
 * Appending to an in-order load = 0 removes; one out-of-place stop = 1 remove + 1 insert.
 *
 * New first delivery (advanced): if the desired FIRST stop is a NEW order not yet on the load,
 * append-only inserts can't place it first. Return `anchorInsert` = that stop; the executor inserts
 * it FIRST (the anchor that keeps the load non-empty), then removes the current deliveries and
 * re-inserts the rest — sequenced so the load never drops to zero stops and cancels.
 */
export function planSequence(currentDeliveryStopIds: any[], desiredOrderedStopIds: any[]): SequencePlan {
  // Dedupe (first occurrence wins): a duplicate in the desired order would otherwise re-insert a
  // stop that's still on the load (it's the anchor or already present) → a duplicate insertStops.
  const clean = (a: any[]) => {
    const seen = new Set<string>();
    return (a || []).map((x) => String(x)).filter((x) => x && x !== 'null' && x !== 'undefined' && (seen.has(x) ? false : (seen.add(x), true)));
  };
  const cur = clean(currentDeliveryStopIds);
  const want = clean(desiredOrderedStopIds);
  if (want.length === 0) return { ok: false, reason: 'empty-order: would remove every delivery and cancel the route' };
  // Already in the desired order + membership → nothing to do (no NuVizz calls).
  if (cur.length === want.length && cur.every((id, i) => id === want[i])) {
    return { ok: true, unchanged: true, anchor: want[0], removeStopIds: [], insertOrdered: [] };
  }

  const curSet = new Set(cur);

  // ADVANCED: the desired first delivery is a NEW stop not on the load. Insert it first (anchor),
  // then remove all current deliveries and re-insert the rest — sequenced by the executor so the
  // load is never emptied. (Append-only inserts can't otherwise place a new stop at the front.)
  if (!curSet.has(want[0])) {
    return { ok: true, unchanged: false, anchor: want[0], anchorInsert: want[0], removeStopIds: cur.slice(), insertOrdered: want.slice(1) };
  }

  // FEWEST CALLS: keep the longest desired PREFIX that is an in-order subsequence of the load, so
  // those stops need neither removal nor re-insertion. Greedy earliest-match gives the max prefix.
  let k = 0, ci = 0;
  while (k < want.length) {
    let found = -1;
    for (let j = ci; j < cur.length; j++) { if (cur[j] === want[k]) { found = j; break; } }
    if (found === -1) break;
    ci = found + 1; k++;
  }
  const keep = new Set(want.slice(0, k));            // k >= 1 (want[0] is on the load)
  return { ok: true, unchanged: false, anchor: want[0], removeStopIds: cur.filter((id) => !keep.has(id)), insertOrdered: want.slice(k) };
}

// ── §I  async LOAD IMPORT — declarative stop set + order in ONE call ─────────
//
// POST {base}/load/update/default/{cc} with { companyCode, loads:[{loadHeader, stops}] }.
// Contract (proven by controlled live experiments on UAT DAVISV5, Jul 1 2026 — including a
// 10-stop route: create-in-order, full reversal, optimized reorder, mid-route injection):
//   • The stops[] ARRAY ORDER is the visit order. stopSeq numbers and the header
//     stopSeqOrder flag are IGNORED. The optimizer does NOT rearrange imported loads.
//   • New loadNbr → creates the load (Draft) with stops in array order. No loadId/versionId
//     anywhere on this path.
//   • Re-import same loadNbr → DECLARATIVE rebuild: stop set + order become exactly stops[].
//     Omitted stops are UNPLANNED (the stop record survives, unassigned).
//   • Existing stops plan BY REFERENCE: stopNbr + stopType + a "to" block (address+schedule).
//     A bare stopNbr is rejected ("Either From or To information should be present").
//   • A stop NEWLY ADDED to a load APPENDS to the end on that first import (its array position
//     is ignored on the add); a follow-up reorder import seats it.
//
// THE SILENT-FAILURE TRAP: the import is async. A 200 "Async import is SUCCESS …
// AppMessageLog Id-…" does NOT mean it landed — on worker failure NOTHING is created and the
// reason is unreachable (no AppMessageLog endpoint on the open API). The loadHeader MUST carry
// earliestStartDttm + latestStartDttm (NOT scheduleStartDttm) AND the flat origin fields
// (origin, originName, originAddr1, originAddr2(opt), originCity, originState, originZip,
// originCountry, loadTimeZone). Omit the origin fields = "SUCCESS" + nothing created, forever.
// buildImportBody() therefore HARD-VALIDATES all of that and refuses to build a payload that
// would vanish. Convergence (poll load/info, compare to.seq — see runImportLoad in
// nuvizz-write.mts) is mandatory after every order-affecting import; never trust the 200.

/** Flat load header for the import — see the trap note above for why so much is required. */
export interface ImportLoadHeader {
  loadNbr: string; routeName?: string | null;
  earliestStartDttm: string; latestStartDttm: string;   // NOT scheduleStartDttm
  origin: string; originName: string; originAddr1: string; originAddr2?: string | null;
  originCity: string; originState: string; originZip: string;
  originCountry?: string;                               // default USA
  loadTimeZone?: string;                                // default EST
}

/** REFERENCE stop shape for the import — plans an EXISTING stop onto the load by stopNbr.
 *  (A bare stopNbr is rejected by NuVizz; the "to" block is what makes the reference valid.)
 *  For NEW stops, pass the FULL payload from buildStopPayload() instead — same stops[] slot. */
export function buildImportStopRef(row: StopRow, settings: OriginSettings): any {
  const tz = settings.timeZone || 'America/New_York';
  const d = settings.serviceDate;
  return {
    stopNbr: String(req(row.stopNbr, 'importStopRef: stopNbr')),
    stopType: 'DO',
    to: {
      address: {
        addressType: 'COM', name: row.name, addr1: row.addr1, addr2: row.addr2 || undefined,
        city: row.city, state: row.state, zip: row.zip, country: 'USA',
      },
      // The delivery window is the driver-visible appointment ONLY — it NEVER sets order
      // (rigorously disproven). Echoed here because the reference needs a schedule block.
      schedule: { timeFrom: `${d}T12:00:00`, timeTo: `${d}T17:00:00`, timeZone: tz, timeConstraint: 'PREFERRED' },
    },
  };
}

/**
 * Validate + assemble the import body for ONE load. Throws (→ HTTP 400, no NuVizz call) on
 * anything that would trip the silent-failure trap or an unsafe import:
 *   • missing loadNbr / earliestStartDttm / latestStartDttm (or a scheduleStartDttm passed
 *     in their place) / any required flat origin field;
 *   • an EMPTY stops[] — never import an empty list to empty a load (untested, and the
 *     analogous remove-all path CANCELS the route; use load/cancel instead);
 *   • a stop without stopNbr or without a "to" block (NuVizz rejects bare references);
 *   • "claude"/"anthropic" anywhere in loadNbr/routeName (naming rule — never in live data).
 */
export function buildImportBody(load: { loadHeader: any; stops: any[] }, cc: string): any {
  const h = load?.loadHeader || {};
  if ((h.scheduleStartDttm || h.scheduleEndDttm) && !(h.earliestStartDttm && h.latestStartDttm)) {
    throw new Error('importLoad: use earliestStartDttm + latestStartDttm — scheduleStartDttm does NOT work on the import path (silent no-create)');
  }
  const loadNbr = String(req(h.loadNbr, 'importLoad: loadHeader.loadNbr'));
  const routeName = h.routeName != null ? String(h.routeName) : undefined;
  if (/claude|anthropic/i.test(`${loadNbr} ${routeName || ''}`)) {
    throw new Error('importLoad: load/route names must never contain "claude" or "anthropic"');
  }
  const header: any = {
    loadNbr,
    routeName,
    earliestStartDttm: req(h.earliestStartDttm, 'importLoad: loadHeader.earliestStartDttm'),
    latestStartDttm: req(h.latestStartDttm, 'importLoad: loadHeader.latestStartDttm'),
    origin: req(h.origin, 'importLoad: loadHeader.origin'),
    originName: req(h.originName, 'importLoad: loadHeader.originName'),
    originAddr1: req(h.originAddr1, 'importLoad: loadHeader.originAddr1'),
    originAddr2: h.originAddr2 || undefined,
    originCity: req(h.originCity, 'importLoad: loadHeader.originCity'),
    originState: req(h.originState, 'importLoad: loadHeader.originState'),
    originZip: req(h.originZip, 'importLoad: loadHeader.originZip'),
    originCountry: h.originCountry || 'USA',
    loadTimeZone: h.loadTimeZone || 'EST',
  };
  const stops = reqArr(load?.stops, 'importLoad: stops (never import an empty stops[] — use load/cancel to retire a load)');
  for (const [i, s] of stops.entries()) {
    req(s?.stopNbr, `importLoad: stops[${i}].stopNbr`);
    if (!s?.to || !s.to.address) throw new Error(`importLoad: stops[${i}] needs a "to" block (address+schedule) — a bare stopNbr reference is rejected by NuVizz`);
    if (!s.stopType) s.stopType = 'DO';
  }
  return { companyCode: cc, loads: [{ loadHeader: header, stops }] };
}

/**
 * importOk (§I) — parse the ASYNC import acknowledgement. ok=true means the request was
 * ACCEPTED ("Async import is SUCCESS … AppMessageLog Id-…"), NOT that it landed — the caller
 * MUST run the convergence read-back (poll load/info, compare to.seq) before trusting it.
 */
export function importOk(httpOk: boolean, j: any): { ok: boolean; async: true; appMessageLogId: string | null; ackText: string | null; error: string | null } {
  const body = j || {};
  const text = [body.status, body.message, body._text].filter((x: any) => x != null).map(String).join(' ');
  const accepted = /success/i.test(text);
  const m = text.match(/AppMessageLog\s*Id\s*[-:\s]*([A-Za-z0-9._-]+)/i);
  const ok = httpOk && accepted;
  // NB: on success the ack text itself lives in body.message — only consult firstError() when
  // NOT accepted, so the success message is never misread as an error string.
  // ackText: NuVizz's verbatim ack, kept for forensics — a "SUCCESS" that never lands is only
  // diagnosable from what was actually said + sent (see the write-log endpoint).
  return { ok, async: true, appMessageLogId: m ? m[1] : null, ackText: text.trim().slice(0, 300) || null, error: ok ? null : (firstError(body) || `import status='${body?.status ?? ''}'`) };
}

// Field whitelists for echoing a stop's "to" block back as an import reference. Echo only what
// the import format knows — never raw junk like seq/lat/exec fields, which could confuse the
// async worker or regress the stop record.
const IMPORT_ADDR_FIELDS = ['addressType', 'name', 'addr1', 'addr2', 'city', 'state', 'zip', 'country'] as const;
const IMPORT_SCHED_FIELDS = ['timeFrom', 'timeTo', 'timeZone', 'timeConstraint', 'estimatedDuration', 'estDuration'] as const;
const pickFields = (src: any, keys: readonly string[]) => {
  const out: any = {};
  for (const k of keys) if (src?.[k] != null && src[k] !== '') out[k] = src[k];
  return out;
};

/** importRefFromRaw (§I) — a RAW stop object (from load/info stops[] or stop/info) → the
 *  reference shape that plans that EXISTING stop on an import (stopNbr + stopType + "to"
 *  block echoed from NuVizz's own record). Null when the raw record can't yield a valid
 *  reference (no stopNbr or no delivery address) — the caller must surface that, never
 *  send a bare stopNbr (NuVizz rejects it). */
export function importRefFromRaw(rawStop: any): any | null {
  const st = rawStop?.stop || rawStop || {};
  const to = st?.to || {};
  const address = pickFields(to.address || {}, IMPORT_ADDR_FIELDS);
  if (st.stopNbr == null || String(st.stopNbr).trim() === '' || !address.addr1) return null;
  if (!address.country) address.country = 'USA';
  const schedule = pickFields(to.schedule || {}, IMPORT_SCHED_FIELDS);
  const ref: any = { stopNbr: String(st.stopNbr), stopType: st.stopType || 'DO', to: { address } };
  if (Object.keys(schedule).length) ref.to.schedule = schedule;
  return ref;
}

/**
 * assembleImportHeader (§I) — build the import loadHeader for an EXISTING load from what we
 * can ECHO, in trust order, throwing when the silent-failure trap can't be satisfied:
 *   • loadNbr/routeName + earliestStartDttm/latestStartDttm from the raw load/info header
 *     (falling back to `${fallbackDate}T06:00:00`–`T18:00:00` when the header lacks them);
 *   • the flat origin block from (1) flat origin fields already on the raw header, else
 *     (2) a raw stop's "from" address (buildStopPayload writes the warehouse there), else
 *     (3) the client's saved ship-from (the New Order origin) — else throw.
 */
export function assembleImportHeader(rawHeader: any, rawStops: any[], clientOrigin: any | null, fallbackDate?: string | null): ImportLoadHeader {
  const h = rawHeader || {};
  const loadNbr = String(req(h.loadNbr, 'import header: loadNbr'));
  // The import format needs "yyyy-MM-ddTHH:mm:ss" strings. load/info can hand dates back in
  // other shapes (epoch millis); echoing one of those is exactly the silent-failure trap
  // (SUCCESS ack, nothing lands) — so only trust an ISO-looking string, else derive from the
  // service date.
  const iso = (v: any) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v : null);
  const earliest = iso(h.earliestStartDttm) || (fallbackDate ? `${fallbackDate}T06:00:00` : null);
  const latest = iso(h.latestStartDttm) || (fallbackDate ? `${fallbackDate}T18:00:00` : null);
  if (!earliest || !latest) throw new Error(`import header: load ${loadNbr} has no earliest/latest start and no service date to derive one — cannot import safely`);

  let origin: any = null;
  const flat = pickFields(h, ['origin', 'originName', 'originAddr1', 'originAddr2', 'originCity', 'originState', 'originZip', 'originCountry']);
  if (flat.originName && flat.originAddr1 && flat.originCity && flat.originZip) origin = flat;
  if (!origin) {
    for (const rs of (rawStops || [])) {
      const from = (rs?.stop || rs || {})?.from?.address;
      if (from?.name && from?.addr1 && from?.city && from?.zip) {
        origin = { origin: h.rtOrigin || 'WHSE', originName: from.name, originAddr1: from.addr1, originAddr2: from.addr2 || undefined, originCity: from.city, originState: from.state, originZip: from.zip, originCountry: from.country || 'USA' };
        break;
      }
    }
  }
  if (!origin && clientOrigin?.name && clientOrigin?.addr1 && clientOrigin?.city && clientOrigin?.zip) {
    origin = { origin: 'WHSE', originName: clientOrigin.name, originAddr1: clientOrigin.addr1, originAddr2: clientOrigin.addr2 || undefined, originCity: clientOrigin.city, originState: clientOrigin.state, originZip: clientOrigin.zip, originCountry: 'USA' };
  }
  if (!origin) throw new Error(`import header: load ${loadNbr} — no origin block available (not on the load, no stops to echo it from, and no saved ship-from origin; set one in the New Order tab)`);

  return {
    loadNbr, routeName: h.routeName != null ? String(h.routeName) : undefined,
    earliestStartDttm: earliest, latestStartDttm: latest,
    origin: origin.origin || 'WHSE', originName: origin.originName, originAddr1: origin.originAddr1, originAddr2: origin.originAddr2 || undefined,
    originCity: origin.originCity, originState: origin.originState, originZip: origin.originZip,
    originCountry: origin.originCountry || 'USA', loadTimeZone: h.loadTimeZone || 'EST',
  };
}

/** deliveryOrder (§I) — normalized getLoad → the load's DELIVERY stopNbrs in visit order
 *  (sorted by stopSeq = stop.to.seq; pickups excluded). This is the convergence comparator:
 *  after an import, poll getLoad and compare deliveryOrder() to the requested stopNbr order. */
export function deliveryOrder(load: any): string[] {
  const stops = Array.isArray(load?.stops) ? load.stops : [];
  return stops
    .filter((s: any) => s && s.stopNbr != null && String(s.stopType ?? 'DO').toUpperCase() !== 'PU')
    .slice()
    .sort((a: any, b: any) => (Number(a.stopSeq ?? Number.MAX_SAFE_INTEGER)) - (Number(b.stopSeq ?? Number.MAX_SAFE_INTEGER)))
    .map((s: any) => String(s.stopNbr));
}

// ── Request builders (one per single op) ─────────────────────────────────────

export const ROSTER_BODY = {
  pageInfo: { pageSize: 0, page: 1, maxResult: 500 },
  searchCriteria: { name: '', groupNames: ['-1'], vendorId: ['-1'], email: '', userRoles: ['-1'], status: '-1', companyId: '' },
};

/**
 * Build the exact request for a SINGLE op. Throws on a missing required field so the
 * handler returns a 400 rather than firing a malformed write. createStop expects the
 * caller to have already built payload.stop via buildStopPayload (or to pass {row,settings}).
 */
export function buildOpRequest(op: SingleOp, payload: any, creds: WriteCreds): BuiltRequest {
  const { base, companyCode: cc, auth } = creds;
  const H = jsonHeaders(auth);
  switch (op) {
    case 'roster':
      return { url: `${base}/user/list/${enc(cc)}`, method: 'POST', headers: H, body: JSON.stringify(ROSTER_BODY), meta: { route: '/user/list', tenant: cc, source: 'live-write' } };

    case 'createStop': {
      const stop = payload?.stop || (payload?.row ? buildStopPayload(payload.row, payload.settings) : null);
      if (!stop) throw new Error('createStop: missing stop (provide {stop} or {row,settings})');
      return { url: `${base}/stop/sync/update/${enc(cc)}`, method: 'POST', headers: H, body: JSON.stringify({ companyCode: cc, stop }), meta: { route: '/stop/sync/update', tenant: cc, source: 'live-write' } };
    }

    case 'getStop': {
      const stopNbr = req(payload?.stopNbr, 'getStop: stopNbr');
      return { url: `${base}/stop/info/${enc(stopNbr)}/${enc(cc)}`, method: 'GET', headers: H, meta: { route: '/stop/info', tenant: cc, source: 'live-write' } };
    }

    case 'getLoad': {
      const loadNbr = req(payload?.loadNbr, 'getLoad: loadNbr');
      return { url: `${base}/load/info/${enc(loadNbr)}/${enc(cc)}`, method: 'GET', headers: H, meta: { route: '/load/info', tenant: cc, source: 'live-write' } };
    }

    case 'getLoadByRouteId': {
      // Resolve a load by its INTERNAL loadId (the hex routeId) — load/info (and the load/edit unplan
      // step) is keyed by the human loadNbr, so static/info bridges a load we only know by its id
      // (Draft / Loads-grid) to its human loadNbr, which lets a reorder/unplan actually run.
      const routeId = req(payload?.routeId ?? payload?.loadId, 'getLoadByRouteId: routeId (the loadId)');
      return { url: `${base}/load/static/info/${enc(cc)}?routeId=${encodeURIComponent(String(routeId))}`, method: 'GET', headers: H, meta: { route: '/load/static/info', tenant: cc, source: 'live-write' } };
    }

    case 'insertStops': {
      const insertStopIds = reqArr(payload?.insertStopIds, 'insertStops: insertStopIds');
      const loadId = req(payload?.loadId, 'insertStops: loadId');
      return { url: `${base}/load/insertstops/${enc(cc)}`, method: 'POST', headers: H, body: JSON.stringify({ insertStopIds, loadId }), meta: { route: '/load/insertstops', tenant: cc, source: 'live-write' } };
    }

    case 'removeStops': {
      // The executor resolves the echoed header + versionId via getLoad first; here we
      // build the second call given a prepared editHeader + versionId on the payload.
      const removeStopIds = reqArr(payload?.removeStopIds, 'removeStops: removeStopIds');
      const editHeader = req(payload?.editHeader, 'removeStops: editHeader (executor builds via toEditHeader)');
      // versionId is echoed as a STRING — load/info can return it as a number, and load/edit expects
      // the string form (matches the verified unplan handoff: String(versionId)).
      const versionId = String(req(payload?.versionId, 'removeStops: versionId'));
      return { url: `${base}/load/edit/${enc(cc)}`, method: 'POST', headers: H, body: JSON.stringify({ loadHeader: editHeader, removeStopIds, routeSeq: [], versionId }), meta: { route: '/load/edit', tenant: cc, source: 'live-write' } };
    }

    case 'assignDriver': {
      // routeId = the load's INTERNAL loadId (hex, e.g. 6a438e9d52ef82bd1ed4516b), NOT the human
      // loadNbr; driverId = numeric roster userId. action = ASSIGN_DISPATCH — this is the verified
      // assign action the NuVizz portal itself uses (per the "NuVizz — Load (Driver) Assignment &
      // Dispatch" handoff doc §2/§8, confirmed live against UAT). It assigns Carrier+Driver; releasing
      // the load to the driver is the SEPARATE dispatchLoad op (action DISPATCH). (Do not switch this
      // to action ASSIGN — the openapi prose is misleading; ASSIGN_DISPATCH is what actually works.)
      const routeId = req(payload?.routeId ?? payload?.loadId, 'assignDriver: routeId (the loadId)');
      const driverId = numericId(req(payload?.driverId, 'assignDriver: driverId (roster userId)'));
      const body = { action: 'ASSIGN_DISPATCH', dispatchRoute: [{ routeId, assignDtls: { driverId } }] };
      return { url: `${base}/load/assignanddispatch/${enc(cc)}`, method: 'POST', headers: H, body: JSON.stringify(body), meta: { route: '/load/assignanddispatch(assign)', tenant: cc, source: 'live-write' } };
    }

    case 'dispatchLoad': {
      const routeId = req(payload?.routeId ?? payload?.loadId, 'dispatchLoad: routeId (the loadId)');
      const body = { action: 'DISPATCH', dispatchRoute: [{ routeId }] };
      return { url: `${base}/load/assignanddispatch/${enc(cc)}`, method: 'POST', headers: H, body: JSON.stringify(body), meta: { route: '/load/assignanddispatch(dispatch)', tenant: cc, source: 'live-write' } };
    }

    case 'importLoad': {
      // ONE async call sets a load's complete stop list in exact array order (§I above).
      // buildImportBody hard-validates the header (silent-failure trap) + stops (no empty
      // list, no bare references). payload: { load: { loadHeader, stops } }.
      const load = req(payload?.load, 'importLoad: load ({loadHeader, stops})');
      const body = buildImportBody(load, cc);
      return { url: `${base}/load/update/default/${enc(cc)}`, method: 'POST', headers: H, body: JSON.stringify(body), meta: { route: '/load/update/default', tenant: cc, source: 'live-write' } };
    }

    default: {
      const _exhaustive: never = op;
      throw new Error(`unknown write op: ${String(_exhaustive)}`);
    }
  }
}

/** Choose the right parser for a single op's JSON body. */
export function parseOpResponse(op: SingleOp, httpOk: boolean, j: any): any {
  switch (op) {
    case 'roster': return { ok: httpOk, drivers: parseRoster(j) };
    case 'getStop': return { ok: httpOk, stop: normalizeStop(j) };
    case 'getLoad': return { ok: httpOk, load: normalizeLoad(j) };
    case 'getLoadByRouteId': return { ok: httpOk, load: normalizeStaticLoad(j) };
    case 'createStop':
    case 'insertStops':
    case 'removeStops': return summarize(httpOk, j);
    case 'assignDriver':
    case 'dispatchLoad': return assignOk(j);
    case 'importLoad': return importOk(httpOk, j);
    default: return summarize(httpOk, j);
  }
}

// ── tiny validators ──────────────────────────────────────────────────────────
function req<T>(v: T, label: string): T {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) throw new Error(`missing required field — ${label}`);
  return v;
}
function reqArr(v: any, label: string): any[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`missing/empty array — ${label}`);
  return v;
}
