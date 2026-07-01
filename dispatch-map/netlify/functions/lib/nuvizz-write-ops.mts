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
  'assignDriver', 'dispatchLoad', 'roster',
] as const;
export type SingleOp = typeof SINGLE_OPS[number];

// Ops the HTTP handler accepts (single ops + the per-load Save batch + the panel Save).
export const WRITE_OPS = [...SINGLE_OPS, 'commitLoad', 'commitBoard'] as const;
export type WriteOp = typeof WRITE_OPS[number];

/** Ops that MUTATE NuVizz (everything except the two GET reads). Used by the
 *  handler to decide which ops need the write-enabled gate + idempotency. */
export const MUTATING_OPS = new Set<WriteOp>([
  'createStop', 'insertStops', 'removeStops', 'assignDriver', 'dispatchLoad', 'commitLoad', 'commitBoard',
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
