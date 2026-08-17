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
  'assignDriver', 'dispatchLoad', 'roster', 'importLoad', 'partialUpdateStop', 'createRoute',
] as const;
export type SingleOp = typeof SINGLE_OPS[number];

// Ops the HTTP handler accepts (single ops + the per-load Save batch + the panel Save +
// the async load-import commit with its convergence recipe).
export const WRITE_OPS = [...SINGLE_OPS, 'commitLoad', 'commitBoard', 'commitImport', 'addStopNote', 'setStopDate', 'setStopContact', 'newRoute'] as const;
export type WriteOp = typeof WRITE_OPS[number];

/** Ops that MUTATE NuVizz (everything except the GET reads). Used by the
 *  handler to decide which ops need the write-enabled gate + idempotency. */
export const MUTATING_OPS = new Set<WriteOp>([
  'createStop', 'insertStops', 'removeStops', 'assignDriver', 'dispatchLoad',
  'importLoad', 'commitLoad', 'commitBoard', 'commitImport',
  'partialUpdateStop', 'addStopNote', 'setStopDate', 'setStopContact',
  'createRoute', 'newRoute',
]);

/**
 * Hoist the REASON a fired op failed onto the HTTP envelope.
 *
 * runOp's executors put their diagnosis on `result.error` — precise, actionable strings
 * ("could not read stop X … nothing was written", "partialUpdate changed 3 other field(s)").
 * The envelope used to report `ok:false` and nothing else, so a caller reading `error` off
 * the response got `undefined` and fell back to its own generic message: the real reason was
 * built, returned, and then thrown away at the last hop. Most call sites had learned to reach
 * into `res.result?.error` themselves; the one that hadn't (the stop-note composer) could only
 * say "Could not add the note." That's a contract bug, not a UI bug — a response that says a
 * write failed must say why. Batch ops keep their per-load detail; this is the summary line.
 */
export function hoistResultError(result: any): string | null {
  if (!result || result.ok) return null;
  const str = (v: any) => (typeof v === 'string' ? v.trim() : '');
  const direct = str(result.error);
  if (direct) return direct;
  // commitLoad / commitBoard / commitImport report per-load, so the top-level result has no
  // single `error` — summarise the first few so the banner still names a cause.
  for (const key of ['loads', 'results', 'stops']) {
    const arr = Array.isArray(result?.[key]) ? result[key] : null;
    if (!arr) continue;
    const parts = arr.map((r: any) => str(r?.error) || str(r?.result?.error)).filter(Boolean);
    if (parts.length) {
      const head = parts.slice(0, 3).join(' · ');
      return parts.length > 3 ? `${head} (+${parts.length - 3} more)` : head;
    }
  }
  // Never return null for a failure: a bare "it failed" is still better than the caller
  // inventing its own wording and hiding the fact that the server reported nothing.
  return 'write failed (NuVizz reported no reason)';
}

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
  itemDesc?: string | null;      // what's being delivered (commodity) → reference2
  // Freight in Davis business terms. buildStopPayload maps these onto NuVizz's
  // (mislabeled) fields: pallets → totalCartons (NuVizz "cartons" = real skids/
  // pallets), loose → volume, and totalPallets carries the TOTAL piece count.
  pallets?: number | null; loose?: number | null; weight?: number | null;
  // Davis records the shipment PRICE in NuVizz's Seal # field → sealNbr (string, maxLen 20).
  price?: string | number | null;
  // Consignee contact phone → to.contact.phone (read back by the scan as contact.phone —
  // resolveStopPhone / the card's Contact row / "Text customer"). Digits/string, optional.
  phone?: string | null;
  // Consignee contact email → to.contact.email (v7 contact block). Optional.
  email?: string | null;
  // Dispatch notes (driver instructions) → comments[] cmtType ORD_IN (read back by
  // extractOrderInstructions → signalSources.orderInstructions + allComments on the card).
  dispatchNotes?: string | null;
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
// Length-cap a string on CODE POINTS, not UTF-16 units. A plain .slice(n) can cut an
// emoji/astral char in half, leaving an unpaired surrogate that JSON.stringify emits as
// a lone \ud8xx — which NuVizz's Java-side JSON parse can reject (400s the whole write)
// or store mangled. Spreading iterates code points, so the cut is always at a char boundary.
function safeSlice(v: string, n: number): string {
  const s = String(v);
  return s.length <= n ? s : [...s].slice(0, n).join('');
}

export function buildStopPayload(row: StopRow, settings: OriginSettings): any {
  const tz = settings.timeZone || 'America/New_York';
  const d = settings.serviceDate;
  // NuVizz hard-caps proNumber at 10 chars — anything longer rejects the WHOLE write ("size must
  // be between 0 and 10", code 1401). Dispatchers type carrier-prefixed refs ("estes-2258732686"),
  // so apply the manifest path's lesson everywhere: proNumber carries the PRO DIGITS (first 10, so
  // a "-1" copy suffix can't shift the number), while the full typed ref rides shipmentNbr (≤20)
  // and reference1 (≤50).
  const proRaw = row.pro ? String(row.pro).trim() : '';
  const proDigits = proRaw.replace(/\D/g, '').slice(0, 10);
  const pro = proDigits || proRaw.slice(0, 10);
  const itemDesc = row.itemDesc ? String(row.itemDesc).trim() : '';
  // Send NuVizz clean digits — strip the UI's dash/space/paren formatting (the v0.50.29 phone mask
  // put "678-226-2099" on the wire; NuVizz server-side-validates this number, which feeds its
  // driver→customer SMS, and rejects the punctuation). Keep a leading "+" for international.
  const phone = row.phone ? String(row.phone).trim().replace(/(?!^\+)\D/g, '').slice(0, 200) : '';
  // Consignee email → to.contact.email. Trim only (NuVizz validates); bound the length.
  const email = row.email ? safeSlice(String(row.email).trim(), 200) : '';
  const notes = row.dispatchNotes ? String(row.dispatchNotes).trim() : '';
  // Davis freight semantics ↔ NuVizz's mislabeled fields (matches how the app READS
  // every stop): pallets/skids ride NuVizz "totalCartons", loose pieces ride
  // "volume", and NuVizz "totalPallets" is really the TOTAL piece count (pallets +
  // loose). So the New Order form's Pallets/Loose write totalCartons/volume, and
  // totalPallets carries their sum (falling back to 1 piece when nothing is entered).
  const pallets = numOrNull(row.pallets);
  const loose = numOrNull(row.loose);
  const totalPieces = pallets != null || loose != null ? (pallets ?? 0) + (loose ?? 0) : null;
  // Emit the order as ONE NuVizz line item (StopDetail) so it shows in the Stop's "Items"
  // table — NuVizz populates that table from stopDetails[] ONLY; the header totals above are
  // separate fields and stay authoritative (the line mirrors them, so a recompute is a no-op).
  // Required StopDetail fields (v7, additionalProperties:false): product, productIdentifier,
  // quantity(>0), quantityUOM, stopDetailSeq(>0). No SKU on a manifest row → productIdentifier
  // falls back to the PRO / order number (the spec's "unique ID for the shipment").
  const lineWeight = numOrNull(row.weight);
  const stopDetails = itemDesc ? [{
    product: safeSlice(itemDesc, 100),
    productIdentifier: safeSlice(String(proRaw || row.stopNbr || 'ITEM'), 50),
    quantity: totalPieces && totalPieces > 0 ? totalPieces : 1,
    quantityUOM: 'PCS',
    stopDetailSeq: 1,
    lineType: '01',                                  // 01 = Product
    weight: lineWeight ?? undefined,
    weightUOM: lineWeight != null ? 'LBS' : undefined,
  }] : undefined;
  return {
    stopNbr: row.stopNbr ? String(row.stopNbr) : undefined,
    stopType: 'DO', shipmentType: 'REG', stopExecution: 'APP', sourceType: 'INTG',
    shipmentNbr: proRaw ? safeSlice(proRaw, 20) : undefined, proNumber: proRaw ? pro : undefined,
    reference1: proRaw ? safeSlice(`PRO ${proRaw}`, 50) : undefined,
    // Item/commodity description → reference2 (a plain string reference field on the stop,
    // maxLength 50 — slice or NuVizz 400s). Kept alongside stopDetails below for round-trip
    // compatibility (normalizeStop reads it back to confirm persistence on this tenant).
    reference2: itemDesc ? safeSlice(itemDesc, 50) : undefined,
    // Item/commodity as a real line item → populates the Stop Details "Items" table.
    stopDetails,
    totalCartons: pallets,          // NuVizz "cartons" = real PALLETS / skids
    volume: loose,                  // NuVizz "volume"  = LOOSE pieces
    totalPallets: totalPieces ?? 1, // NuVizz "pallets" = TOTAL pieces (pallets + loose)
    weight: numOrNull(row.weight),
    weightUOM: 'LBS',
    // Davis convention: the shipment PRICE rides in NuVizz's Seal # field (sealNbr, string ≤20 chars).
    sealNbr: row.price != null && String(row.price).trim() !== '' ? String(row.price).trim().slice(0, 20) : undefined,
    // Dispatch notes → a Stop Instructions comment. Per the v7 spec only commentType
    // '00'/'01'/'02' are accepted on create/update; cmtType 'ORD_IN' = Stop Instructions —
    // the exact shape Uline's integration writes (no SPL-INSTR-TEXT prefix needed: the
    // scanner keys on cmtType alone). Read back: extractOrderInstructions →
    // signalSources.orderInstructions, extractAllComments → the card's notes panel.
    comments: notes ? [{
      commentType: '01', cmtType: 'ORD_IN',
      accessLevels: ['DISPATCHER', 'DRIVER'],
      commentDescription: safeSlice(notes, 500),
    }] : undefined,
    from: {
      address: {
        addressType: 'COM', name: settings.origin.name, addr1: settings.origin.addr1,
        city: settings.origin.city, state: settings.origin.state, zip: settings.origin.zip, country: 'USA',
      },
      schedule: { timeFrom: `${d}T08:00:00`, timeTo: `${d}T12:00:00`, timeZone: tz, timeConstraint: 'PREFERRED' },
    },
    to: {
      address: {
        // 'ANY', NOT 'COM'. This is the CONSIGNEE — the customer's address — and
        // NuVizz's own spec defines COM as "Company address". Typing it COM tells
        // NuVizz this address belongs to the company's address book, and per the
        // spec ("other than address type ANY, name will be chosen from address",
        // and a label "will populate line1, line2, city, state, zip, country,
        // latitude and longitude from the corresponding address") NuVizz is then
        // free to RESOLVE it away on any later write. On 2026-08-17 it did exactly
        // that on two live orders: a date change re-sent the correct consignee and
        // NuVizz stored 943 GAINESVILLE HIGHWAY, BUFORD, GEORGIA — our own terminal.
        // ANY is the type that means "these literal fields ARE the address"; it is
        // the only one where the name we supply is honoured (and is mandatory).
        addressType: 'ANY', name: row.name, addr1: row.addr1, addr2: row.addr2 || undefined,
        city: row.city, state: row.state, zip: row.zip, country: 'USA',
      },
      schedule: { timeFrom: `${d}T12:00:00`, timeTo: `${d}T17:00:00`, timeZone: tz, timeConstraint: 'PREFERRED' },
      // Consignee phone + email → the v7 to.contact block ({contactName, phone, phone2, sms,
      // fax, email}). Read back by normalizeStop as contact.phone / contact.email
      // (resolveStopPhone / Contact row / "Text customer").
      contact: (phone || email)
        ? { contactName: row.name, ...(phone ? { phone } : {}), ...(email ? { email } : {}) }
        : undefined,
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
// NuVizz write acks are NOT the bare enum "SUCCESS": a stop upsert answers "STOP UPDATED
// SUCCESSFULLY", an async import "…is SUCCESS. Find more info…", an assign "…Success". Accept any
// status carrying success/successful/successfully UNLESS a failure word is present (so
// PARTIALSUCCESS / "SUCCESS WITH ERRORS" / FAIL / REJECT stay failures).
// `sucess` is NOT a typo here — it is NuVizz's OWN misspelling on the v7 stop
// endpoints ({"status":"SUCESS"} — portal HAR, Jul 24). Without it statusAccepted()
// returns false, statusBad flips true, and a write that actually APPLIED is reported
// as failed. The FAIL word list still runs after this, so "PARTIALSUCESS" is still
// caught. Accept both spellings; never trust the vendor's orthography.
const STATUS_SUCCESS_WORD = /\b(success(ful(ly)?)?|sucess(ful(ly)?)?)\b/i;
const STATUS_FAIL_WORD = /\b(partial|fail|failure|error|reject|invalid|denied)/i;
function statusAccepted(s: any): boolean {
  const t = String(s ?? '').trim();
  return t !== '' && STATUS_SUCCESS_WORD.test(t) && !STATUS_FAIL_WORD.test(t);
}

export function summarize(httpOk: boolean, j: any): WriteSummary {
  const body = j || {};
  const err = firstError(body);
  const created = body?.apiResult?.created || body?.apiResult?.updated;
  const ent = Array.isArray(body?.entityInfoList) && body.entityInfoList.length ? body.entityInfoList[0] : null;
  const statusRaw = String(body?.status ?? '').toUpperCase();
  const statusSuccess = statusAccepted(statusRaw);
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
    updated: (Boolean(body?.apiResult?.updated) && !body?.apiResult?.created)
      || (/\bUPDATED\b/.test(statusRaw) && !/\b(CREATED|INSERTED|ADDED)\b/.test(statusRaw)),
    error: ok ? null : (err || `NuVizz rejected the write (status='${statusRaw || (httpOk ? 'no-status/200' : 'http-error')}')`),
  };
}

/** assignOk (§6) — for assign/dispatch. ok when status (case-insensitive) === 'success'. */
export function assignOk(j: any): { ok: boolean; error: string | null } {
  // Same free-text acks as summarize: assign/dispatch replies "…Success" or "… ASSIGNED SUCCESSFULLY".
  if (statusAccepted(j?.status)) return { ok: true, error: null };
  return { ok: false, error: firstError(j) || `assign/dispatch status='${j?.status ?? ''}'` };
}

function hasReasons(body: any): boolean {
  return (Array.isArray(body?.reasons) && body.reasons.length > 0) || (Array.isArray(body?.Reasons) && body.Reasons.length > 0);
}
function firstError(body: any): string | null {
  if (!body || typeof body !== 'object') return null;
  // NuVizz v7 uses BOTH lowercase `reasons` (CommonImportResponse) and capital `Reasons`
  // (ImportFailureReason). A reason carries its text under description/msg/message/errorLiteral and a
  // code under reasonCode/errorCode — read all of them so a rejected write is never left blank.
  const reasons = (Array.isArray(body.reasons) && body.reasons) || (Array.isArray(body.Reasons) && body.Reasons) || null;
  const r = reasons && reasons.length ? reasons[0] : null;
  if (r) {
    const t = r.description || r.msg || r.message || r.errorLiteral || r.reasonDesc;
    const code = r.reasonCode ?? r.errorCode;
    if (t) return code != null ? `${String(t)} (code ${code})` : String(t);
    if (code != null) return `NuVizz reason code ${code}`;
  }
  const ae = body?.apiResult?.errors;
  if (Array.isArray(ae) && ae.length) {
    const e = ae[0];
    const m = e?.msgs ?? e?.msg ?? e?.description ?? null;
    if (m) return `${e?.key ? e.key + ': ' : ''}${Array.isArray(m) ? m.join('; ') : String(m)}`;
  }
  // Spring-style error bodies carry the USEFUL detail in `message` ("JSON parse error: …")
  // while `error` is just the bare reason phrase ("Bad Request") — never bury the detail.
  if (body.error && body.message && /^(bad request|internal server error|not found|forbidden|unauthorized|conflict)$/i.test(String(body.error).trim())) {
    return `${String(body.error)}: ${String(body.message)}`.slice(0, 300);
  }
  if (body.error) return String(body.error);
  if (body.message) return String(body.message);
  // Non-JSON NuVizz error body (safeJson wraps it as {_text}); surface it rather than dropping it.
  if (body._text) { const t = String(body._text).trim(); if (t) return t.slice(0, 300); }
  return null;
}

// ── executed-stop detection (the AVRT-0179332708 case, Jul 22) ────────────────
// NuVizz will NOT remove a stop that is already in execution via the declarative
// RWB save: it answers SUCCESS and silently KEEPS the stop (verified live — a
// dispatched pickup survived a Save-removal twice, incl. one repair round). The
// pre-save load read already carries each stop's execution status in the RAW
// entries, so a Save can refuse UP FRONT for free instead of half-applying.

/** Execution status of one stop on a normalizeLoad() result, read from rawStops
 * (the raw load/info entries — the normalized stops[] deliberately keep only
 * id/nbr/seq/type). Null when the entry or its execution info is absent. */
export function rawStopExecStatus(load: any, stopNbr: string): string | null {
  for (const w of load?.rawStops || []) {
    const st = w?.stop || w || {};
    if (st?.stopNbr == null || String(st.stopNbr) !== String(stopNbr)) continue;
    const s = w?.stopExecutionInfo?.stopStatus ?? st?.stopExecutionInfo?.stopStatus ?? st?.stopStatus ?? null;
    return s != null && String(s).trim() !== '' ? String(s).trim() : null;
  }
  return null;
}

// Statuses that mean the driver/vendor already ACTED on the stop. Deliberately a
// BLOCKLIST with fail-open semantics: an unknown or absent status never blocks a
// removal (the post-save KEPT verify still has the final word). PICKED (not PICK)
// and no CONFIRMED: a pickup-TYPE stop or an appointment-confirmed but
// undispatched stop is still legitimately removable.
const EXECUTED_STOP_STATUS_RE = /^(DISPATCH|IN[_ ]?TRANSIT|OUT[_ ]?FOR|ARRIV|DEPART|DELIVER|COMPLET|PICKED|EXEC)/i;
export function isExecutedStopStatus(status: string | null | undefined): boolean {
  return !!status && EXECUTED_STOP_STATUS_RE.test(String(status).trim());
}

// ── cancel-response classification (PURE) ────────────────────────────────────
//
// Emptying a load CANCELS the route, and NuVizz may report that cancel as a non-OK
// body ("Cancelled route") rather than a clean success — so an intentional empty
// treats a cancellation response as success. The original test for that was
// `/cancel/i.test(error)`, which cannot tell NuVizz CONFIRMING a cancel from NuVizz
// REFUSING one: "Load cannot be cancelled — already dispatched" contains "cancel"
// too, and read as success. That was merely a wrong message until v0.54.18 gave a
// confirmed cancel a board write-through — now a refusal would stamp every order
// board-unplanned for the full 60-minute grace while NuVizz still has them planned
// on a live route, inviting a double-plan onto another truck. So a refusal must
// read as the failure it is.
//
// Positive only: the text must mention a cancellation AND carry no refusal/negation
// language. Anything unrecognized stays false — an unconfirmed cancel fails the Save
// loudly (recoverable: re-Save, or check the portal), which is the cheap direction.
const CANCEL_REFUSAL_RE = /\b(?:can'?t|cannot|could\s*n[o']t|couldn'?t|unable|fail(?:s|ed|ure)?|denied|deny|reject(?:ed)?|invalid|not\s+(?:be\s+)?(?:cancell?(?:ed|able)|allowed|permitted)|non-?cancell?able)\b/i;
/** True when a removeStops response POSITIVELY confirms the route was cancelled.
 *  `ok` responses confirm outright; a non-OK body confirms only if it reads as a
 *  cancellation notice rather than a refusal to cancel. */
export function cancelResponseConfirms(r: { ok?: boolean; error?: any } | null | undefined): boolean {
  if (r?.ok === true) return true;
  const txt = String(r?.error ?? '').trim();
  if (!txt || !/cancel/i.test(txt)) return false;
  return !CANCEL_REFUSAL_RE.test(txt);
}

// ── STOP NOTES (§N) — writing a dispatcher/driver instruction onto a live order ──
//
// Portal-verified from Chad's HAR capture (Jul 24): adding a note in the NuVizz
// portal fires ONE call —
//   POST /v7/stop/partialUpdate/{CC}   body { stops: [ { …stop…, comments: [...] } ] }
//   → {"status":"SUCESS","apiResult":{"updated":1,"failed":0,"errors":[]}}
//
// THE CRITICAL SEMANTIC: `comments` is a FULL REPLACE, not an append. The portal
// re-sent the new note PLUS all three pre-existing ULINE ORD_IN comments, each
// echoed with its full metadata (addedByName/addedOn/source/key). Sending only the
// new note would ERASE the carrier's "DO NOT BREAKDOWN SKID" / "INSIDE DELIVERY"
// instructions off live freight. Every writer here merges onto the CURRENT list read
// back from NuVizz immediately beforehand — never a blind write.
//
// A manually-added note uses cmtType PVST_IN (pre-visit instruction) — distinct from
// the ORD_IN type the ULINE integration writes, so ours are distinguishable from the
// carrier's. accessLevels is the Dispatcher-vs-Driver panel switch.

export const NOTE_AUDIENCES = { dispatcher: ['DISPATCHER'], driver: ['DRIVER'], both: ['DRIVER', 'DISPATCHER'] } as const;
export type NoteAudience = keyof typeof NOTE_AUDIENCES;
export const STOP_NOTE_CMT_TYPE = 'PVST_IN';
const NOTE_MAX_CHARS = 500;

/** PURE: a new note → the exact comment object the portal posts (key included: the
 *  portal's client-side identity `description|LEVELS|cmtType`). */
export function buildStopNoteComment(text: string, audience: NoteAudience = 'both'): any {
  const body = safeSlice(String(text ?? '').trim(), NOTE_MAX_CHARS);
  if (!body) throw new Error('addStopNote: note text is empty');
  const accessLevels = [...(NOTE_AUDIENCES[audience] || NOTE_AUDIENCES.both)];
  return { commentDescription: body, accessLevels, cmtType: STOP_NOTE_CMT_TYPE, key: `${body}|${accessLevels.join(',')}|${STOP_NOTE_CMT_TYPE}` };
}

/** PURE: unwrap the RAW stop record from any getStop/stop-info envelope. The v7 reads
 *  nest differently by URL form ({Stop:{stop}} vs {stop:{stop}}), so probe rather than
 *  assume — reading comments one level off would silently look like "no comments" and
 *  a merge would then WIPE them. Returns {} when nothing stop-shaped is found. */
export function rawStopFrom(j: any): any {
  const cands = [j?.Stop?.stop, j?.stop?.stop, j?.Stop, j?.stop, j];
  for (const c of cands) if (c && typeof c === 'object' && (c.stopNbr != null || c.stopId != null)) return c;
  return {};
}

/** PURE: the stop's current comments (always an array, never null). */
export function stopCommentsFrom(rawStop: any): any[] {
  return Array.isArray(rawStop?.comments) ? rawStop.comments : [];
}

/** PURE: existing comments + the new note, echoed verbatim so nothing is lost. An
 *  identical note (same text+audience+type) is a no-op rather than a duplicate. */
export function mergeStopComments(existing: any[], note: any): { comments: any[]; duplicate: boolean } {
  const list = Array.isArray(existing) ? existing.filter((c) => c && typeof c === 'object') : [];
  const same = (c: any) => String(c?.commentDescription ?? '') === String(note.commentDescription)
    && String(c?.cmtType ?? '') === String(note.cmtType)
    && JSON.stringify([...(c?.accessLevels || [])].sort()) === JSON.stringify([...note.accessLevels].sort());
  if (list.some(same)) return { comments: list, duplicate: true };
  return { comments: [...list, note], duplicate: false };
}

// The fields a note-write must NEVER disturb. Compared before/after as a data-loss
// tripwire: partialUpdate is sent MINIMAL (ids + comments only), so any drift here
// means the endpoint blanked unsent fields and the caller must be told loudly.
const NOTE_GUARD_PATHS = [
  'stopSeq', 'stopType', 'weight', 'totalPallets', 'totalCartons', 'sealNbr',
  'proNumber', 'bol', 'reference1', 'reference2', 'shipmentNbr',
  'to.address.addr1', 'to.address.city', 'to.address.state', 'to.address.zip',
  'to.contact.phone', 'to.contact.email', 'to.schedule.timeFrom', 'to.schedule.timeTo',
  'from.address.addr1', 'from.address.city',
  // The pickup side's contact is watched for the same reason as the delivery side's: §C
  // writes `from.contact` on a PU stop, and the field it must not touch there — the email —
  // would otherwise be covered by nothing (the echo diff excludes the block being written).
  'from.contact.phone', 'from.contact.email',
];
const atPath = (o: any, p: string) => p.split('.').reduce((a: any, k) => (a == null ? a : a[k]), o);

/**
 * Fields present on a getStop read that a note write does NOT echo back on partialUpdate
 * (portal HAR, Jul 24 — read shape vs the write it produced).
 *
 * `stopDetails` is the important one: it's the freight lines, and the portal maintains
 * them through a SEPARATE endpoint (stop/stopdetail/update, seen firing in that same
 * flow moments before the note write). Echoing them here would put the freight lines in
 * the blast radius of a note. The next group are derived/read-only projections NuVizz
 * computes (tracking state, visibility matrix, pricing attributes, the shipper
 * back-pointer, and a `volume` figure it recomputes from the detail lines).
 *
 * ATTACHMENTS (Jul 27) — `to.documents` / `from.documents` are the order's FILES: the BOL
 * row, the driver's capture photos, the signed POD. They are the ONLY field a real note
 * write has ever been observed to move: order 007152089 (Jul 26) and order 007150559
 * (Jul 27) both came back with the same single BOL — same documentName/documentType/
 * documentCategory/extension — carrying a FRESH `reference` GUID. Three reasons they now
 * leave the wire:
 *   • The read hands them back as metadata with `documentData:""` — the bytes live behind
 *     the separate document API. Echoing a required-but-empty payload can only be ignored
 *     (pointless) or make NuVizz re-create the attachment row from nothing (destructive).
 *     A note has no business doing either.
 *   • The portal HAR the whole-stop echo was modelled on had NO documents on its stop, so
 *     echoing them was never portal-proven — it was extrapolation. House rule: unproven
 *     and no upside ⇒ don't send it.
 *   • Attachments are maintained through the document API, exactly like stopDetails.
 * Dropping them from the echo also drops them out of echoDrift's view, so the caller now
 * proves they SURVIVED by comparing the pre-write read to the post-write read
 * (unsentLosses) instead of trusting silence.
 */
export const PARTIAL_UPDATE_DERIVED_KEYS = [
  'stopDetails', 'trackingInfo', 'visibility', 'customAttributes', 'shipForBP', 'volume',
  'to.documents', 'from.documents',
] as const;

/** PURE: a copy of `src` with each dotted path removed, CLONING every object on the way
 *  down. The caller's raw read must survive untouched — it is the before-image the
 *  data-loss checks compare against, and a shallow delete would corrupt it. A path whose
 *  parent is absent (or isn't a plain object) is simply skipped. */
function withoutPaths(src: Record<string, any>, paths: readonly string[]): Record<string, any> {
  const out: Record<string, any> = { ...src };
  const isPlain = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
  for (const p of paths) {
    const seg = p.split('.');
    let node: any = out;
    let reached = true;
    for (let i = 0; i < seg.length - 1; i++) {
      if (!isPlain(node[seg[i]])) { reached = false; break; }
      node[seg[i]] = { ...node[seg[i]] };
      node = node[seg[i]];
    }
    if (reached) delete node[seg[seg.length - 1]];
  }
  return out;
}

/**
 * Build the stop object for a note write.
 *
 * partialUpdate is NOT partial. Sending only { stopId, stopNbr, comments } — which reads as
 * the safest possible payload, and was what we shipped — is rejected outright by NuVizz with
 * a bare `status='SOMETHING WENT WRONG!!, PLEASE TRY AGAIN'`. The portal sends the WHOLE stop
 * back with `comments` swapped, and that is the only shape the endpoint accepts.
 *
 * So the write echoes the stop we just read, with two rules:
 *   - drop the derived keys above (never put freight lines in a note's blast radius);
 *   - NEVER invent a value we didn't read. The portal also sends six empty placeholders
 *     (estimationInfo:null, hubId:"", invoiceRef:{}, serviceType:"", vehicleTypes:[],
 *     volumeUOM:"cu ft"); the first five are inert, but volumeUOM is a real unit we have no
 *     read value for, so we send none of them rather than write a value we made up.
 *
 * The echo widens the blast radius from 3 fields to the whole stop, which is exactly why the
 * caller's read-back tripwire now diffs EVERY echoed field rather than a guard list.
 */
export function buildNoteWriteStop(rawStop: any, comments: any[]): Record<string, any> {
  return buildPartialUpdateStop(rawStop, { comments });
}

/**
 * The general form of the above: echo the stop we just read, minus the derived keys, with
 * `overrides` swapped in at the top level. Every partialUpdate write goes through here, so
 * the "whole stop or NuVizz rejects it" rule and the never-send-attachments rule are stated
 * once. A note swaps `comments`; a date change swaps `to`.
 */
export function buildPartialUpdateStop(rawStop: any, overrides: Record<string, any>): Record<string, any> {
  if (!rawStop || typeof rawStop !== 'object') throw new Error('buildNoteWriteStop: no stop to echo');
  // Overrides are applied BEFORE the strip, never after: a `to` override is built by
  // spreading the block we read, which carries `to.documents` — applying it afterwards
  // would put the order's files straight back on the wire that the strip exists to keep
  // them off. Strip last, and the derived keys cannot return by any route.
  const merged: Record<string, any> = { ...rawStop };
  for (const [k, v] of Object.entries(overrides || {})) merged[k] = v;
  return withoutPaths(merged, PARTIAL_UPDATE_DERIVED_KEYS);
}

/**
 * PURE. Is this echoed address a LOOKUP KEY rather than data?
 *
 * NOT YET WIRED INTO THE WRITE PATH — deliberately. See pinEchoAddress below for
 * what we would do about it and why that decision is not ours to take alone.
 *
 * NuVizz's v7 spec defines COM as "Company address" and COMFAC as "Company
 * facility"; `label` it defines as a key that repopulates line1/line2/city/state/
 * zip/country/latitude/longitude from the book entry. An echoed block carrying
 * either is something the vendor may resolve away, and on 2026-08-17 it did.
 */
export const ADDRESS_BOOK_TYPES = ['COM', 'COMFAC'] as const;

export function addressIsResolvable(addr: any): boolean {
  if (!addr || typeof addr !== 'object' || Array.isArray(addr)) return false;
  const type = String(addr.addressType ?? '').trim().toUpperCase();
  if ((ADDRESS_BOOK_TYPES as readonly string[]).includes(type)) return true;
  return String(addr.label ?? '').trim() !== '';
}

/**
 * PURE. Make an echoed address LITERAL so the vendor cannot resolve it away.
 *
 * NOT YET WIRED INTO THE WRITE PATH. It changes a value we did not read, which
 * breaks this module's standing "invent nothing the read did not provide" rule —
 * a rule that exists for good reason on a whole-stop replace. Wiring it needs one
 * supervised write against one real order, watching the existing read-back
 * tripwire, because the alternative to being wrong here is freight going to the
 * wrong building. Exported and tested so that test is a five-minute job.
 *
 * ── why this exists ─────────────────────────────────────────────────────────
 * partialUpdate is a whole-stop replace, so every note, date and contact write
 * puts the order's addresses back on the wire. NuVizz's own v7 spec says two
 * things about what it then does with them:
 *   • `label` — "with valid given label, other address fields like line1, line2,
 *     city, state, zip, country, latitude and longitude will be populated from
 *     the corresponding address of the label."
 *   • `addressType` — COM is "Company address"; and "other than address type ANY,
 *     name will be chosen from address."
 * So an echoed block carrying a book type or a label is not data we are sending —
 * it is a LOOKUP KEY, and the vendor is entitled to overwrite every field under
 * it. On 2026-08-17 it did: two orders whose consignee was stamped COM at
 * creation came back addressed to 943 GAINESVILLE HIGHWAY, BUFORD, GEORGIA —
 * our own terminal — after nothing but a date change. The drift report proves we
 * sent the right address and NuVizz stored a different one.
 *
 * ANY is the one type that means "these literal fields ARE the address". Setting
 * it, and dropping `label`, is what turns the echo back into data.
 *
 * Returns null when the block cannot be pinned — no name (mandatory for ANY) or
 * no street. The caller MUST refuse the write in that case: sending a resolvable
 * block is how orders get re-addressed, and a refused date change is a smaller
 * problem than freight routed to the wrong building.
 */
export function pinEchoAddress(addr: any): Record<string, any> | null {
  if (!addr || typeof addr !== 'object' || Array.isArray(addr)) return null;
  const name = String(addr.name ?? '').trim();
  const addr1 = String(addr.addr1 ?? '').trim();
  if (!name || !addr1) return null;
  const { label, ...rest } = addr;
  return { ...rest, addressType: 'ANY', name };
}

// ── Wrong-twin guard (§D/§N) — the Estes-0828068215 lesson, Aug 4 ─────────────
//
// NuVizz allows TWO live order records to carry ONE stop number (a rekeyed order next to
// the original entry, a recurring reference PRO's older instance), and /stop/info BY NUMBER
// answers with whichever instance the vendor picks — not necessarily the one the dispatcher
// is looking at. Jessica, on Estes-0828068215: "I tried to update this Estes delivery date
// … and it completely changed the address" — the date op read the OTHER record (the one
// consigned to Davis), moved ITS window, and the card refreshed into that record's address.
// The board KNOWS which instance it is showing (the saved-search list carries the internal
// stop id), so a single-stop op must refuse when the record NuVizz answered with is not the
// record on the dispatcher's screen. Same rule as v0.54.24's duplicate load names: when two
// records share a name, this app declines to guess which one is meant.

// Local id-shape check (mirrors nuvizz-list's isHashLikeId; restated here so this module
// stays import-free/pure). Only an id-shaped value ever arms the guard — a stop NUMBER
// accidentally passed as an id must never block a write.
export function isIdShaped(v: any): boolean { return idShaped(v); }

function idShaped(v: any): boolean {
  const s = String(v ?? '').trim();
  if (!s || /\s/.test(s)) return false;
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;                      // Mongo ObjectId / long hex token
  if (/^[A-Za-z0-9_-]{20,}$/.test(s) && /\d/.test(s)) return true;  // long id-ish token containing a digit
  return false;
}

/** PURE: the refusal when the by-number read returned a DIFFERENT record than the one the
 *  caller is operating on — null when the identities agree, or when either side carries no
 *  usable id (a caller with no id gets the old behavior; the guard only ever narrows). */
export function stopInstanceMismatch(op: string, stopNbr: any, expectedStopId: any, rawStop: any): string | null {
  const want = String(expectedStopId ?? '').trim();
  const got = String(rawStop?.stopId ?? '').trim();
  if (!idShaped(want) || !idShaped(got) || want === got) return null;
  const addr = rawStop?.to?.address || {};
  const who = [addr.name, addr.addr1, addr.city].map((v: any) => String(v ?? '').trim()).filter(Boolean).join(', ');
  return `${op}: TWO NuVizz orders appear to carry number ${stopNbr} — NuVizz answered with a different record (${who || 'unknown consignee'}; id …${got.slice(-6)}), not the one on your board (id …${want.slice(-6)}). Nothing was written. Cancel or renumber the duplicate in the portal, then refresh this stop.`;
}

/**
 * The SAME lesson, aimed at the READ-BACK (§ ESTES-2938079387, Aug 14).
 *
 * v0.54.36 armed the PRE-read: a by-number read answering with a different record than the
 * one on the dispatcher's screen refuses before anything is written. Nothing armed the
 * post-write verify, and it uses the same by-number read — so when NuVizz answered the
 * read-back with the OTHER record sharing the number, the echo diff faithfully compared two
 * DIFFERENT ORDERS and reported the result as "partialUpdate changed 15 other field(s)":
 * Khalid Mutakabbir's date change appeared to have re-addressed his order to Davis's own
 * terminal (943 Gainesville Highway), state "GA" became "GEORGIA", the shipper renamed
 * itself. Every one of those was the twin's data. A wrong diagnosis that alarming sends a
 * dispatcher to the portal hunting for a rewrite that never happened — and buries the real
 * finding, which is that TWO live orders carry the number.
 *
 * So: when the read-back's stopId is id-shaped and differs from the id we WROTE, the drift
 * diff must not run at all. The write itself targeted the right record (partialUpdate goes by
 * stopId); what failed is VERIFICATION, and the honest report is exactly that.
 */
export function readBackInstanceMismatch(op: string, stopNbr: any, writtenStopId: any, rawAfter: any, pinned = false): string | null {
  const want = String(writtenStopId ?? '').trim();
  const got = String(rawAfter?.stopId ?? '').trim();
  if (!idShaped(want) || !idShaped(got) || want === got) return null;
  const addr = rawAfter?.to?.address || rawAfter?.from?.address || {};
  const who = [addr.name, addr.addr1, addr.city].map((v: any) => String(v ?? '').trim()).filter(Boolean).join(', ');
  // `pinned` = the CALLER supplied the on-screen record's id and it is the id we wrote. Only
  // then may this message say "the record on your screen" — without the pin, the pre-read is
  // itself an unguarded by-number lookup, and in the flipped case (pre-read answered the twin,
  // read-back answered the screen's record) the confident wording inverted both identity
  // claims: the dispatcher was told their change landed on their order when it landed on the
  // twin. Same restraint as the pre-read sibling: claim exactly what is proven, no more.
  const wrote = pinned
    ? `the update was written to the record on your screen (id …${want.slice(-6)})`
    : `the update was accepted for the record NuVizz answered our pre-write read with (id …${want.slice(-6)}) — which may or may not be the one on your screen`;
  return `${op}: ${wrote}, but reading ${stopNbr} back, NuVizz answered with a DIFFERENT record that shares the number (${who || 'unknown consignee'}; id …${got.slice(-6)}). TWO orders appear to carry this number, so the change could not be verified — and any field differences would be between two records, not changes to your order. Find BOTH entries for ${stopNbr} in the portal, confirm which record took the change, then cancel or renumber the duplicate.`;
}

/**
 * The read-back came back 200 but carries no usable identity (no id-shaped stopId — an
 * empty/foreign body, or a record the vendor serves without its id). When we KNOW which id we
 * wrote, diffing an unidentifiable record is the same two-different-things trap as the twin:
 * the echo diff would report "field → (absent)" about a record nobody can name. Unverified is
 * the honest verdict. Null when we hold no id-shaped written id — then nothing narrows.
 */
export function readBackUnidentifiable(op: string, stopNbr: any, writtenStopId: any, rawAfter: any): string | null {
  const want = String(writtenStopId ?? '').trim();
  if (!idShaped(want)) return null;
  const got = String(rawAfter?.stopId ?? '').trim();
  if (idShaped(got)) return null;
  return `${op}: the write was accepted for id …${want.slice(-6)}, but the read-back returned a record with no usable identity, so the change could not be verified against the right order. Check ${stopNbr} in the portal before re-trying.`;
}

/**
 * Drift paths ordered by what a dispatcher must see first. driftDetail caps at five lines, so
 * with 15 drifted fields the cap decided what the banner showed — and the order they happened
 * to be discovered in is not the order of consequence. Address drift means freight can ship to
 * the wrong building; it never belongs behind the cap.
 */
export function orderDriftPaths(paths: string[]): string[] {
  const weight = (p: string) => (
    /^(to|from)\.address\./.test(p) ? 0
      : /^(to|from)\.contact\./.test(p) ? 1
        : /^(to|from)\.schedule\./.test(p) ? 2
          : 3);
  return [...paths].sort((a, b) => weight(a) - weight(b));
}

/** The one-line escalation when a SAME-record drift touched an address field. Worded for
 *  either side — `from.address` drift is the pickup origin moving, not the consignment. */
export function addressDriftWarning(paths: string[]): string {
  return (paths || []).some((p) => /^(to|from)\.address\./.test(String(p)))
    ? ' AN ADDRESS ON THE ORDER MOVED — verify the order\'s addresses in the portal before it ships.'
    : '';
}

// ── DELIVERY DATE (§D) — moving an order to the day the customer actually wants ──
//
// The v7 Stop schema has NO "requested date" field: `to.schedule.timeFrom/timeTo` IS the
// delivery date (it's what the portal labels "DropOff Date"). So changing an order's date
// means moving that window — same partialUpdate whole-stop echo a note uses.
//
// The window's TIME OF DAY is the customer's appointment and is never touched: we move the
// DAY and keep the clock, preserving a multi-day span if the record has one. A stop with no
// window at all gets the same 12:00–17:00 default the create path uses (buildStopPayload) —
// the one invented value here, and only when there is nothing to preserve.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** PURE: is this a real calendar day (YYYY-MM-DD, and an actual date)? */
export function isDayString(v: any): boolean {
  const s = String(v ?? '');
  if (!DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const dayMs = (s: string) => Date.parse(`${s}T00:00:00Z`);
const addDayString = (s: string, n: number) => new Date(dayMs(s) + n * 86400000).toISOString().slice(0, 10);

/** The block a stop's delivery window lives on: `to` for a delivery, `from` for a pickup. */
export function primarySideKey(rawStop: any): 'to' | 'from' {
  return String(rawStop?.stopType || 'DO').toUpperCase() === 'PU' ? 'from' : 'to';
}

/** PURE: the stop's CURRENT delivery day (YYYY-MM-DD) from its own window, or null. */
export function stopDeliveryDate(rawStop: any): string | null {
  const tf = rawStop?.[primarySideKey(rawStop)]?.schedule?.timeFrom;
  return typeof tf === 'string' && isDayString(tf.slice(0, 10)) ? tf.slice(0, 10) : null;
}

/**
 * PURE: what to tell the dispatcher when the NuVizz write landed but OUR board didn't record it.
 *
 * A date change is two halves. NuVizz holds the delivery window; our board holds a date override
 * that makes every later scan keep honouring the day — because NuVizz never recomputes the
 * Estimated Arrival the board files by, so without the override the next scan drags the order
 * straight back onto today. applyBoardDateChange is best-effort by design (the date is already
 * true in NuVizz; a cache hiccup must not turn a landed write into a reported failure), which
 * meant a failed override was invisible: the card said "off this board until then" and ten
 * minutes later the order was back. Chad, on an order he'd moved to the 30th: "it didn't write
 * to nuvizz so it showed up in a new scan." The reappearance IS the symptom of this half failing.
 *
 * @returns the warning to append to a success message, or null when the board holds it.
 */
export function boardDateHoldWarning(board: any): string | null {
  if (!board || board.skipped) return 'our board could NOT record the day (cache unavailable), so the next scan will pull this order back onto today — move it again once the cache is back.';
  if (board.overrideError) return `our board could NOT record the day (${board.overrideError}), so the next scan will pull this order back onto today — move it again, or set the date in the portal.`;
  // The override is the half that holds across scans; the row move is only cosmetic speed.
  if (board.moveError) return 'the order stays visible on this board until the next scan catches up (the day itself is recorded).';
  return null;
}

/** PURE: the same schedule with its window moved to `date`, clock (and span) preserved. */
export function shiftScheduleToDate(schedule: any, date: string): Record<string, any> {
  if (!isDayString(date)) throw new Error(`setStopDate: '${date}' is not a YYYY-MM-DD date`);
  const s = schedule && typeof schedule === 'object' ? schedule : {};
  const timePart = (v: any, fallback: string) => {
    const str = typeof v === 'string' ? v : '';
    const m = str.match(/T(\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : fallback;
  };
  const fromDay = typeof s.timeFrom === 'string' && isDayString(s.timeFrom.slice(0, 10)) ? s.timeFrom.slice(0, 10) : null;
  const toDay = typeof s.timeTo === 'string' && isDayString(s.timeTo.slice(0, 10)) ? s.timeTo.slice(0, 10) : null;
  // A window that already spans midnight keeps its span; anything else lands inside one day.
  const span = fromDay && toDay ? Math.max(0, Math.round((dayMs(toDay) - dayMs(fromDay)) / 86400000)) : 0;
  return {
    ...s,
    timeFrom: `${date}T${timePart(s.timeFrom, '12:00:00')}`,
    timeTo: `${addDayString(date, span)}T${timePart(s.timeTo, '17:00:00')}`,
  };
}

/** PURE: the `to`/`from` override a date change sends — the read block with only its
 *  schedule moved. Returns { side, block } so the caller can spread it into the echo. */
export function buildStopDateOverride(rawStop: any, date: string): { side: 'to' | 'from'; block: Record<string, any> } {
  const side = primarySideKey(rawStop);
  const cur = rawStop?.[side];
  if (!cur || typeof cur !== 'object') throw new Error(`setStopDate: the stop has no "${side}" block to move`);
  return { side, block: { ...cur, schedule: shiftScheduleToDate(cur.schedule, date) } };
}

// ── §C the customer contact ON THE ORDER ─────────────────────────────────────
//
// The CUSTOMER # block (v0.54.68) saves a name + number onto our own customer_notes doc:
// per-CUSTOMER, so it carries onto that customer's next order, and it is what Text, Call
// and the Messages list read. NuVizz never heard about it. Chad: "does it write it to
// nuvizz?" — it did not, so the portal, the carrier's own record and the DRIVER's device
// all still showed an order with no contact on it.
//
// NuVizz's contact is per-ORDER (`to.contact`, the block createStop already fills from the
// New Order form's Phone field), so this writes THIS order and the Firestore save keeps
// carrying the customer forward. Neither replaces the other.

/** PURE: the contact block as the app reads it back — contactName with the legacy `name`
 *  as fallback (live records carry either), and the phone/email beside it. */
export function stopContactFrom(rawStop: any): { name: string; phone: string; email: string } {
  const c = rawStop?.[primarySideKey(rawStop)]?.contact || {};
  const s = (v: any) => String(v ?? '').trim();
  return { name: s(c.contactName) || s(c.name), phone: s(c.phone), email: s(c.email) };
}

/**
 * PURE: a phone as NuVizz will accept it — CLEAN DIGITS.
 *
 * The same rule buildStopPayload learned the hard way (v0.50.29): the UI's phone mask put
 * "678-226-2099" on the wire and NuVizz — which server-side-validates this number, because
 * it feeds the driver→customer SMS — rejected it. A leading "+" survives for international.
 */
export function normalizeContactPhone(v: any): string {
  const s = String(v ?? '').trim();
  return s ? s.replace(/(?!^\+)\D/g, '').slice(0, 200) : '';
}

/**
 * PURE: the `to`/`from` override a contact write sends — the block we read with only the
 * contact's name/number swapped. Returns { side, block } so the caller can spread it into
 * the echo, exactly like buildStopDateOverride.
 *
 * ONLY the fields the dispatcher actually filled in are written. An absent/blank patch field
 * leaves NuVizz's value alone: a dispatcher clearing OUR saved contact must never blank the
 * carrier's own number on the order — deleting vendor data is not what "remove my note" means.
 */
export function buildStopContactOverride(
  rawStop: any,
  patch: { name?: string | null; phone?: string | null },
): { side: 'to' | 'from'; block: Record<string, any> } {
  const side = primarySideKey(rawStop);
  const cur = rawStop?.[side];
  if (!cur || typeof cur !== 'object') throw new Error(`setStopContact: the stop has no "${side}" block to write a contact onto`);
  const contact: Record<string, any> = { ...(cur.contact && typeof cur.contact === 'object' ? cur.contact : {}) };

  const name = safeSlice(String(patch?.name ?? '').trim(), 200);
  const phone = normalizeContactPhone(patch?.phone);
  if (name) {
    contact.contactName = name;
    // A live record can carry a LEGACY `name` beside contactName, and the read above prefers
    // contactName — so a stale `name` is invisible until something reads the other one. Keep
    // the two in step when the record already had it. Never ADD it: inventing a key we didn't
    // read is the one thing the echo rule forbids.
    if ('name' in contact) contact.name = name;
  }
  if (phone) contact.phone = phone;

  return { side, block: { ...cur, contact } };
}

// ── what we DON'T send still has to survive ──────────────────────────────────
//
// Everything in PARTIAL_UPDATE_DERIVED_KEYS is invisible to echoDrift by construction —
// both sides of that diff are built through buildNoteWriteStop, so a key stripped from the
// write is stripped from the comparison too. That is the correct diff for "did NuVizz alter
// what we sent", and a blind spot for "did the write cost the order something we didn't
// send". Freight lines and attachments are precisely what a dispatcher can least afford to
// lose, so they get the other check: the PRE-write read against the POST-write read.
//
// Compared on IDENTITY, not on NuVizz's storage handles. `reference` / `documentGuid` /
// `createdDTTM` are the vendor's own pointers and have been seen to change across a write
// while the document stayed the same BOL; treating that as loss is how a safety check
// becomes noise nobody reads. A document is "the same document" when its name, type,
// category, extension, description and disposition match.

const DOC_IDENTITY_FIELDS = ['documentName', 'documentType', 'documentCategory', 'documentExtType', 'description', 'dispositionType'] as const;
const DOC_HANDLE_FIELDS = ['reference', 'documentGuid'] as const;
const DETAIL_IDENTITY_FIELDS = ['product', 'productIdentifier', 'quantity', 'quantityUOM', 'weight', 'lineType'] as const;

const joinFields = (o: any, keys: readonly string[]) => keys.map((k) => String(o?.[k] ?? '')).join('|');

/** PURE: every attachment on the stop as `side|identity`, sorted (a multiset, so two BOLs
 *  are two entries). Both delivery- and pickup-side documents count. */
export function documentIdentities(rawStop: any): string[] {
  const out: string[] = [];
  for (const side of ['to', 'from'] as const) {
    const list = (rawStop || {})[side]?.documents;
    if (!Array.isArray(list)) continue;
    for (const d of list) if (d && typeof d === 'object') out.push(`${side}|${joinFields(d, DOC_IDENTITY_FIELDS)}`);
  }
  return out.sort();
}

/** PURE: the vendor's storage handles for those attachments. Not identity — a change here
 *  with identity intact is a RESTAMP (the file is still on the order), which is reportable
 *  but is not data loss. */
export function documentHandles(rawStop: any): string[] {
  const out: string[] = [];
  for (const side of ['to', 'from'] as const) {
    const list = (rawStop || {})[side]?.documents;
    if (!Array.isArray(list)) continue;
    for (const d of list) if (d && typeof d === 'object') out.push(`${side}|${joinFields(d, DOC_HANDLE_FIELDS)}`);
  }
  return out.sort();
}

/** PURE: the freight lines reduced to what a data-loss check cares about. */
export function stopDetailIdentities(rawStop: any): string[] {
  const list = Array.isArray(rawStop?.stopDetails) ? rawStop.stopDetails : [];
  return list.filter((d: any) => d && typeof d === 'object').map((d: any) => joinFields(d, DETAIL_IDENTITY_FIELDS)).sort();
}

/** Multiset difference: entries in `before` with no counterpart left in `after`. */
function missingFrom(before: string[], after: string[]): string[] {
  const pool = [...after];
  return before.filter((x) => {
    const i = pool.indexOf(x);
    if (i < 0) return true;
    pool.splice(i, 1);
    return false;
  });
}

export interface UnsentLoss { path: string; lost: string[] }

/**
 * PURE: did the write cost the order anything we deliberately did NOT echo?
 *
 * Only LOSSES are reported. Something ARRIVING between the two reads (a driver uploading a
 * capture photo mid-write) is not the note's doing and not a reason to fail the note.
 */
export function unsentLosses(before: any, after: any): UnsentLoss[] {
  const out: UnsentLoss[] = [];
  const docs = missingFrom(documentIdentities(before), documentIdentities(after));
  if (docs.length) out.push({ path: 'documents', lost: docs });
  const lines = missingFrom(stopDetailIdentities(before), stopDetailIdentities(after));
  if (lines.length) out.push({ path: 'stopDetails', lost: lines });
  return out;
}

/** PURE: the attachments are all still there, but NuVizz moved their storage handles.
 *  Benign — kept on the result (and so in the write log) so a systemic restamp stays
 *  visible without turning every clean note into a red banner. */
export function documentHandlesMoved(before: any, after: any): boolean {
  return JSON.stringify(documentHandles(before)) !== JSON.stringify(documentHandles(after));
}

/**
 * PURE: deep-compare what we SENT against what came back, ignoring `comments` (the field the
 * note deliberately changes). Returns the dotted paths that moved.
 *
 * A 3-field write only needed a guard list. A full-object echo needs the opposite default:
 * everything is suspect unless proven identical, because any field NuVizz round-trips
 * differently than it serves it would now be written back in that altered form.
 */
const ECHO_IGNORE_TOP = new Set(['comments', 'createUpdateInfo']);

export function echoDrift(sent: any, readBack: any, prefix = ''): string[] {
  const out: string[] = [];
  const isObj = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const keys = new Set([...Object.keys(sent || {}), ...Object.keys(readBack || {})]);
  for (const k of keys) {
    // `comments` is the change we came to make. `createUpdateInfo` is the modified-by/on
    // stamp the write itself moves — flagging either would make EVERY note report drift and
    // cry wolf on a clean save. Nothing else gets a pass.
    if (!prefix && ECHO_IGNORE_TOP.has(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    const a = (sent || {})[k];
    const b = (readBack || {})[k];
    if (isObj(a) && isObj(b)) { out.push(...echoDrift(a, b, path)); continue; }
    // Arrays and scalars compare by value. JSON order is stable for a round-tripped object.
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push(path);
  }
  return out;
}

/**
 * PURE: for each drifted path, what it was vs what came back.
 *
 * echoDrift names the field; on its own that is not enough to act on. The first real note
 * write (order 007152089, Jul 26) landed fine but reported `to.documents` moved — and
 * "a document field changed" spans everything from NuVizz restamping a GUID to the BOL
 * being dropped off the order. Same message, opposite severities. The values are what
 * separate them, so the report carries them.
 */
export function driftDetail(sent: any, readBack: any, paths: string[], max = 5): string[] {
  const show = (v: any) => {
    if (v === undefined) return '(absent)';
    const s = JSON.stringify(v);
    return s.length > 200 ? `${s.slice(0, 197)}…` : s;
  };
  return paths.slice(0, max).map((p) => `${p}: ${show(atPath(sent, p))} → ${show(atPath(readBack, p))}`);
}

/** PURE: a comparable snapshot of the fields a note-write must not touch. */
export function stopNoteFingerprint(rawStop: any): Record<string, string> {
  const fp: Record<string, string> = {};
  for (const p of NOTE_GUARD_PATHS) {
    const v = atPath(rawStop, p);
    fp[p] = v === undefined || v === null ? '' : String(v);
  }
  return fp;
}

/** PURE: which guarded fields changed between two fingerprints (empty = clean). */
export function fingerprintDrift(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(before).filter((k) => before[k] !== (after || {})[k]);
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
    itemDesc: stop.reference2 ?? null,       // commodity/description we wrote to reference2 (round-trip check)
    // Round-trip checks for the create-time contact + dispatch notes (NuVizz silently drops
    // fields it rejects — a live create should be verified once via getStop/write-log):
    contactPhone: stop?.to?.contact?.phone ?? null,
    ordInNotes: Array.isArray(stop.comments)
      ? stop.comments.filter((c: any) => c?.cmtType === 'ORD_IN').map((c: any) => c?.commentDescription).filter(Boolean).join('\n') || null
      : null,
    assignedLoadNbr: load.loadNbr ?? null,   // null/absent ⇒ unplanned
    routeName: load.routeName ?? null,
    // FREIGHT (incident forensics + round-trip checks). Davis semantics on this tenant:
    // totalCartons = SKID count, volume = LOOSE pieces, totalPallets = total pieces.
    // Nulls mean NuVizz has no value — a freight-wiped stop reads as nulls/zeros here.
    totalPallets: stop.totalPallets ?? null,
    totalCartons: stop.totalCartons ?? null,
    weight: stop.weight ?? null,
    volume: stop.volume ?? null,
    proNbr: stop.pronbr ?? stop.proNbr ?? null,
    // AUDIT (who/when/how the record came to exist) — distinguishes an ORIGINAL order from a
    // copy the async import worker created. Field names picked defensively across the shapes
    // NuVizz has been seen to use; whichever is present wins, absent ⇒ null.
    sourceType: stop.sourceType ?? stop.source ?? null,
    createdBy: stop.createdBy ?? stop.insertedBy ?? S.createdBy ?? null,
    createdDttm: stop.insertedDttm ?? stop.createdDttm ?? stop.creationDttm ?? S.insertedDttm ?? null,
    updatedDttm: stop.updatedDttm ?? stop.lastUpdatedDttm ?? S.updatedDttm ?? null,
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

// ── §I  async LOAD IMPORT — the ORDERING + CREATION lever (two-lever engine) ──
//
// POST {base}/load/update/default/{cc} with { companyCode, loads:[{loadHeader, stops}] }.
//
// ⚠️ CONTRACT CORRECTED Jul 2 2026 (prod incident + controlled UAT reproduction on DAVISV5 —
// stopId-level evidence in dispatch-beta2 docs/NUVIZZ_API.md §10.1). The REAL semantics:
//   • The stops[] ARRAY ORDER is the visit order. stopSeq numbers and the header
//     stopSeqOrder flag are IGNORED. The optimizer does NOT rearrange imported loads. (True.)
//   • An entry MATCHES an existing stop ONLY when that stopNbr is already ON THE TARGET LOAD
//     (matched = same stopId; order applies). A matched stop is FULL-REPLACED by its entry —
//     every field not sent is BLANKED. A to-only "reference" therefore WIPES freight
//     (totalPallets/totalCartons/weight/proNumber/references). Entries for on-load stops MUST
//     be FULL ECHOES of the load's own raw records — importEchoFromRaw(), never a bare ref.
//   • An entry whose stopNbr is NOT on the target load — unplanned OR planned on another
//     load — NEVER matches: NuVizz CREATES A NEW STOP RECORD (a clone) with only the entry's
//     fields and plans the CLONE; the original is untouched. The old claim "existing stops
//     plan by reference" is REFUTED — planning/moving existing stops is insertStops/
//     removeStops territory (the REAL records, by stopId). An off-load stopNbr must NEVER
//     appear in stops[]; creating a brand-new stop inline is allowed only after a per-number
//     existence check proves the number exists nowhere (a collision would clone it).
//   • New loadNbr + full payloads → creates the load AND its stops in array order (the safe
//     create case). Re-import of the same load is DECLARATIVE over its ON-LOAD stops: omitted
//     stops are UNPLANNED (the record survives, its data intact).
//   • A stop newly added to a load APPENDS on its first import (array position ignored on the
//     add); a follow-up full-echo reorder import seats it.
//
// THE SILENT-FAILURE TRAP (unchanged): the import is async. A 200 "Async import is SUCCESS …
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
        // ANY, not COM — see buildStopPayload. The consignee is the customer's
        // literal address, not an entry in the company's address book.
        addressType: 'ANY', name: row.name, addr1: row.addr1, addr2: row.addr2 || undefined,
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
  // HARD TYPE GUARD: every header scalar must be a plain string — live load/info has handed
  // back an OBJECT under `origin`, which NuVizz 400s ("Cannot deserialize java.lang.String
  // from Object"). Refuse here (client 400, zero NuVizz calls) rather than fire a doomed import.
  for (const [k, v] of Object.entries(header)) {
    if (v !== undefined && typeof v !== 'string') throw new Error(`importLoad: loadHeader.${k} must be a string (got ${Array.isArray(v) ? 'array' : typeof v}) — echoing raw load/info fields here is unsafe`);
  }
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
  // A non-SUCCESS status (PARTIALSUCCESS / FAILURE / …) is NEVER an accepted ack. But the status
  // FIELD is not always the bare token: UAT sends status:'SUCCESS', while PROD DAVIS puts the
  // whole SENTENCE in status — "Request for LOAD Async import is SUCCESS. Find more info in
  // AppMessageLog with Id- …" (journaled live Jul 2 2026; the strict equality here read that
  // SUCCESS ack as a REJECTION and aborted the Save before convergence). Accept a status that
  // contains the STANDALONE word "success" with no failure word anywhere; \b keeps
  // PARTIALSUCCESS from matching and the deny-list rejects "SUCCESS WITH ERRORS"-style acks.
  const statusRaw = String(body?.status ?? '').trim();
  const accepted = statusRaw !== ''
    ? (STATUS_SUCCESS_WORD.test(statusRaw) && !STATUS_FAIL_WORD.test(statusRaw))
    : (STATUS_SUCCESS_WORD.test(text) && !STATUS_FAIL_WORD.test(text));
  // The AppMessageLog id: UAT says "AppMessageLog Id-…", prod says "AppMessageLog with Id- …" —
  // allow a few words between, then the id token.
  const m = text.match(/AppMessageLog(?:\s+\w+){0,3}?\s*\bId\b\s*[-:\s]*([A-Za-z0-9._-]+)/i);
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
// Exactly the UAT-proven schedule shape — estimatedDuration/estDuration are NOT part of the
// proven reference and are never echoed (audit: unproven fields with no upside).
const IMPORT_SCHED_FIELDS = ['timeFrom', 'timeTo', 'timeZone', 'timeConstraint'] as const;
// PRIMITIVES ONLY: load/info can nest OBJECTS under scalar-looking keys (live DAVIS returns
// loadHeader.origin as an ADDRESS OBJECT). Echoing an object where the import expects a string
// is a hard NuVizz 400 ("Cannot deserialize value of type java.lang.String from Object value").
const pickFields = (src: any, keys: readonly string[]) => {
  const out: any = {};
  for (const k of keys) if (src?.[k] != null && src[k] !== '' && typeof src[k] !== 'object') out[k] = src[k];
  return out;
};

// The import contract (UAT-verified) uses 2-letter states + 'USA' — live load/info hands back
// long forms ("GEORGIA", "UNITED STATES"). Normalize so the header matches the proven shape
// (a mismatch here is prime silent-discard material for the async worker).
const US_STATE_CODES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO',
  CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID',
  ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA',
  MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR',
  PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
};
const strField = (v: any): string => (typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : ''));
const stateCode = (v: any): string => {
  const s = strField(v).toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : (US_STATE_CODES[s] || s);
};
const countryCode = (v: any): string => {
  const s = strField(v).toUpperCase();
  return (!s || s === 'USA' || s === 'US' || s === 'UNITED STATES' || s === 'UNITED STATES OF AMERICA') ? 'USA' : s;
};

/** importRefFromRaw (§I) — a RAW stop object (from load/info stops[] or stop/info) → the
 *  reference shape that plans that EXISTING stop on an import (stopNbr + stopType + "to"
 *  block echoed from NuVizz's own record). Null when the raw record can't yield a valid
 *  reference (no stopNbr or no delivery address) — the caller must surface that, never
 *  send a bare stopNbr (NuVizz rejects it). */
export function importRefFromRaw(rawStop: any, fallbackDate?: string | null): any | null {
  const st = rawStop?.stop || rawStop || {};
  const to = st?.to || {};
  const address = pickFields(to.address || {}, IMPORT_ADDR_FIELDS);
  if (st.stopNbr == null || String(st.stopNbr).trim() === '' || !address.addr1) return null;
  // Normalize to the UAT-proven shape (live DAVIS echoes "GEORGIA"/"UNITED STATES" long forms —
  // the same class of mismatch that had to be fixed on the header).
  if (address.state != null) address.state = stateCode(address.state);
  address.country = countryCode(address.country);
  const schedule = pickFields(to.schedule || {}, IMPORT_SCHED_FIELDS);
  // Datetime fields must be the contract's "yyyy-MM-ddTHH:mm:ss" strings — an epoch number from
  // a raw read must never be echoed (same distrust the header applies).
  for (const k of ['timeFrom', 'timeTo']) {
    if (schedule[k] != null && !(typeof schedule[k] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(schedule[k]))) delete schedule[k];
    else if (typeof schedule[k] === 'string') schedule[k] = schedule[k].slice(0, 19);
  }
  const ref: any = { stopNbr: String(st.stopNbr), stopType: st.stopType || 'DO', to: { address } };
  if (schedule.timeFrom && schedule.timeTo) ref.to.schedule = schedule;
  else if (fallbackDate) {
    // The contract's reference is address + SCHEDULE; when the echo lacks a usable window,
    // synthesize the proven default from the service date rather than send an uncovered shape.
    ref.to.schedule = { timeFrom: `${fallbackDate}T12:00:00`, timeTo: `${fallbackDate}T17:00:00`, timeZone: 'America/New_York', timeConstraint: 'PREFERRED' };
  }
  return ref;
}

// Scalar fields a FULL ECHO carries beyond the to-block. Jul 2 rule 2: a matched (on-load)
// stop is FULL-REPLACED by its import entry — anything unsent is BLANKED — so an on-load
// entry must echo the record's whole proven field set, freight included. Freight fields are
// NUMBERS (the string-only guard elsewhere is for the header): allow number|numeric-string,
// refuse objects.
const IMPORT_ECHO_NUMBERS = ['totalPallets', 'totalCartons', 'weight'] as const;
const IMPORT_ECHO_STRINGS = [
  'shipmentType', 'stopExecution', 'sourceType', 'shipmentNbr', 'proNumber',
  'reference1', 'reference2', 'reference3', 'weightUOM',
] as const;
// to.contact fields the full echo preserves — a phone written at create time (Manifest Intake /
// Bulk Add) must survive the full-replace, or the first route reorder through the import path
// silently blanks it. Same whitelist discipline as the address (scalars only via pickFields).
// STRICTLY the v7 ContactInfo schema fields (additionalProperties:false on the import paths) —
// notably NOT 'name': live records can carry it (the scan reads contactRaw.name as a fallback)
// but the write schema doesn't know it, and one unknown property can silently no-op the whole
// async import. A record-level 'name' is remapped to contactName below instead.
// NOTE: comments[] are deliberately NOT echoed — whether the full-replace blanks them is
// unproven on this tenant, and echoing could duplicate them (repo rule: unproven, no upside).
const IMPORT_CONTACT_FIELDS = ['contactName', 'email', 'phone', 'phone2', 'sms', 'fax'] as const;

/** importEchoFromRaw (§I, Jul 2 correction) — a RAW stop object (from load/info stops[]) → the
 *  FULL-ECHO import entry for a stop that is ON the target load: importRefFromRaw's
 *  stopNbr/stopType/to-block PLUS every scalar the record carries (freight, PRO, references)
 *  and the "from" block, so the full-replace can never blank a field. Null when no valid
 *  entry can be built (same rule as importRefFromRaw). */
export function importEchoFromRaw(rawStop: any, fallbackDate?: string | null): any | null {
  const ref = importRefFromRaw(rawStop, fallbackDate);
  if (!ref) return null;
  const st = rawStop?.stop || rawStop || {};
  for (const k of IMPORT_ECHO_NUMBERS) {
    const v = (st as any)[k];
    if (v == null || v === '' || typeof v === 'object') continue;
    const n = Number(v);
    if (Number.isFinite(n)) ref[k] = n;
  }
  for (const k of IMPORT_ECHO_STRINGS) {
    const v = (st as any)[k];
    if (v == null || v === '' || typeof v === 'object') continue;
    if (typeof v === 'string' || typeof v === 'number') ref[k] = String(v);
  }
  // Echo the consignee contact (whitelisted scalars) so a full-replace can't blank a phone
  // written at create time. pickFields drops objects/empties, so junk can never ride along.
  const contact = pickFields(st?.to?.contact || {}, IMPORT_CONTACT_FIELDS);
  // Live records sometimes carry the person under 'name' (the scan's own fallback read) —
  // remap it into the schema-legal contactName rather than sending an unknown property.
  const legacyName = (st?.to?.contact as any)?.name;
  if (!contact.contactName && legacyName != null && legacyName !== '' && typeof legacyName !== 'object') contact.contactName = legacyName;
  if (Object.keys(contact).length) ref.to.contact = contact;
  // Echo the "from" block (warehouse address + pickup window) with the same whitelists +
  // normalization as the to-block — never raw junk, never objects where strings belong.
  const from = st?.from || {};
  const fAddr = pickFields(from.address || {}, IMPORT_ADDR_FIELDS);
  if (fAddr.addr1) {
    if (fAddr.state != null) fAddr.state = stateCode(fAddr.state);
    fAddr.country = countryCode(fAddr.country);
    const fSched = pickFields(from.schedule || {}, IMPORT_SCHED_FIELDS);
    for (const k of ['timeFrom', 'timeTo']) {
      if (fSched[k] != null && !(typeof fSched[k] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(fSched[k]))) delete fSched[k];
      else if (typeof fSched[k] === 'string') fSched[k] = fSched[k].slice(0, 19);
    }
    ref.from = { address: fAddr };
    if (fSched.timeFrom && fSched.timeTo) ref.from.schedule = fSched;
  }
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
  // Full seconds-form required; a millis/offset suffix ("…T12:00:00.000+0000") is truncated to
  // the proven 19-char shape, anything else falls back to the derived service-day window.
  const iso = (v: any) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) ? v.slice(0, 19) : null);
  const earliest = iso(h.earliestStartDttm) || (fallbackDate ? `${fallbackDate}T06:00:00` : null);
  const latest = iso(h.latestStartDttm) || (fallbackDate ? `${fallbackDate}T18:00:00` : null);
  if (!earliest || !latest) throw new Error(`import header: load ${loadNbr} has no earliest/latest start and no service date to derive one — cannot import safely`);

  // EVERY origin field must be a plain STRING in the proven shape. Live load/info returns
  // loadHeader.origin as an ADDRESS OBJECT (→ NuVizz 400 "Cannot deserialize java.lang.String
  // from Object") and long-form state/country ("GEORGIA"/"UNITED STATES") — so each candidate
  // source is string-coerced and normalized, never echoed raw.
  // Live DAVIS synthesizes originAddr1 as the WHOLE one-line geocoder address
  // ("943 GAINESVILLE HWY, BUFORD, GA 30518, USA") — strip the ", CITY, ST ZIP[, COUNTRY]"
  // tail so the header carries a clean street line like the proven shape.
  const streetOnly = (addr1: string, city: string, zip: string): string => {
    const a = addr1.trim();
    const ix = city ? a.toUpperCase().indexOf(`, ${city.toUpperCase()}`) : -1;
    if (ix > 0 && (!zip || a.toUpperCase().includes(zip))) return a.slice(0, ix).trim();
    return a;
  };
  let origin: any = null;
  if (strField(h.originName) && strField(h.originAddr1) && strField(h.originCity) && strField(h.originZip)) {
    origin = {
      origin: strField(h.origin) || strField(h.rtOrigin) || 'WHSE',   // the CODE — never the header's origin OBJECT
      originName: strField(h.originName), originAddr1: streetOnly(strField(h.originAddr1), strField(h.originCity), strField(h.originZip)), originAddr2: strField(h.originAddr2) || undefined,
      originCity: strField(h.originCity), originState: stateCode(h.originState), originZip: strField(h.originZip),
      originCountry: countryCode(h.originCountry),
    };
  }
  if (!origin) {
    for (const rs of (rawStops || [])) {
      const from = (rs?.stop || rs || {})?.from?.address;
      if (strField(from?.name) && strField(from?.addr1) && strField(from?.city) && strField(from?.zip)) {
        origin = {
          origin: strField(h.rtOrigin) || 'WHSE',
          originName: strField(from.name), originAddr1: strField(from.addr1), originAddr2: strField(from.addr2) || undefined,
          originCity: strField(from.city), originState: stateCode(from.state), originZip: strField(from.zip),
          originCountry: countryCode(from.country),
        };
        break;
      }
    }
  }
  if (!origin && strField(clientOrigin?.name) && strField(clientOrigin?.addr1) && strField(clientOrigin?.city) && strField(clientOrigin?.zip)) {
    origin = {
      origin: 'WHSE',
      originName: strField(clientOrigin.name), originAddr1: strField(clientOrigin.addr1), originAddr2: strField(clientOrigin.addr2) || undefined,
      originCity: strField(clientOrigin.city), originState: stateCode(clientOrigin.state), originZip: strField(clientOrigin.zip),
      originCountry: 'USA',
    };
  }
  if (!origin) throw new Error(`import header: load ${loadNbr} — no origin block available (not on the load, no stops to echo it from, and no saved ship-from origin; set one in the New Order tab)`);

  return {
    loadNbr, routeName: h.routeName != null ? String(h.routeName) : undefined,
    earliestStartDttm: earliest, latestStartDttm: latest,
    origin: origin.origin, originName: origin.originName, originAddr1: origin.originAddr1, originAddr2: origin.originAddr2 || undefined,
    originCity: origin.originCity, originState: origin.originState, originZip: origin.originZip,
    originCountry: origin.originCountry, loadTimeZone: strField(h.loadTimeZone) || 'EST',
  };
}

// ── §R  ROUTE CREATE — an EMPTY route the dispatcher can then build onto ─────
//
// POST /routePlan/update/{serviceName}/{companyCode}  ("Create or Update Route Plan")
// body: { companyCode, route: { loadHeader, planStops?, stops?, loadAssignment? } }
//
// WHY THIS ENDPOINT AND NOT THE LOAD IMPORT. The import (`load/update`, §I) is the app's
// only other create path and it is gated OFF since the Jul 2 2026 incident: production
// treats import REFERENCE stops as FULL REPLACES, which wiped freight on 10 live orders.
// That failure mode is a property of sending STOP VALUE nodes (`stops`). This builder
// never emits a `stops` key.
//
// WHY THE CREATE CARRIES planStops REFERENCES (Aug 3 2026). The original design sent a
// HEADER ONLY — the OpenAPI schema marks `stops`/`planStops` optional — but the live tenant
// refuses it: reasonCode 903, "Either PlanStop or Stop node should be present". So an empty
// route cannot be created, full stop. The create therefore rides in with the CARD'S ORDERS —
// the dispatcher builds the route locally in Compare, and the create sends the whole stop
// list at once as `PlanStop` references (Chad, Aug 3: "when a new route is created on our
// end then it puts it in the compare panel where we can add stops then we send new route and
// all stops at same time"). A PlanStop is reference-shaped BY SCHEMA ({stopNbr,
// from:{seq,schedule}, to:{seq,schedule}}, additionalProperties:false): the spec's own words
// are "All the stops exist in the system. Hence only the schedule and route information is
// updated" — it carries no address and no freight, so the Jul 2 failure mode remains
// structurally impossible. Each stop's existing schedule is ECHOED from NuVizz's own record
// (echo, never invent).
//
// THE INVARIANT THIS BUILDER HOLDS NOW: no `stops` key ever, and `planStops` is exactly the
// sanitized references for the requested orders — caller-passed stop junk can never widen it.
// Asserted in test.
export interface RouteCreateSeed {
  stopNbr: string;              // an EXISTING stop (the server verifies unplanned + readable first)
  fromSchedule?: any;           // the stop's own from/to schedule, echoed off its NuVizz record
  toSchedule?: any;
}
export interface RouteCreateInput {
  loadNbr: string;              // unique to the business, ≤20 (NuVizz LoadHeader.loadNbr)
  routeName?: string | null;    // the friendly board name ("TRAILER 6"), ≤20
  date?: string | null;         // yyyy-mm-dd service day — derives the start window
  earliestStartDttm?: string | null;
  latestStartDttm?: string | null;
  origin?: any;                 // the saved ship-from { name, addr1, addr2, city, state, zip }
  loadTimeZone?: string | null;
  seeds?: RouteCreateSeed[] | null; // the card's orders, in card order — NuVizz refuses a route with no stop node (903)
}

// The v7 Route schema caps planStops at 500 entries.
export const ROUTE_CREATE_MAX_STOPS = 500;

// Schedule keys the v7 Schedule schema accepts (additionalProperties:false) — anything else
// off the echoed record (lat/exec/address junk) is dropped so the wire body stays reference-only.
const PLAN_STOP_SCHEDULE_KEYS = ['timeFrom', 'timeTo', 'timeZone', 'srvcTimeCode', 'estimatedDuration', 'timeConstraint'] as const;
function planStopSchedule(sch: any): any {
  const out: any = {};
  if (sch && typeof sch === 'object') {
    for (const k of PLAN_STOP_SCHEDULE_KEYS) if (sch[k] !== undefined && sch[k] !== null) out[k] = sch[k];
  }
  return out;   // {} is valid — the Schedule schema has no required fields
}

/** PURE: one sanitized PlanStop reference. Shape is pinned by the schema ({stopNbr, from, to}
 *  only) and by test — nothing address- or freight-shaped can ride. `seq` is the stop's
 *  1-based position in the card's order. */
export function buildPlanStopRef(seed: RouteCreateSeed, seq = 1): any {
  const stopNbr = String(req(seed?.stopNbr, 'createRoute: seed stopNbr')).trim();
  if (stopNbr.length > ROUTE_FIELD_MAX) throw new Error(`createRoute: seed stopNbr "${stopNbr}" is ${stopNbr.length} chars — NuVizz caps it at ${ROUTE_FIELD_MAX}`);
  return {
    stopNbr,
    from: { seq, schedule: planStopSchedule(seed?.fromSchedule) },
    to: { seq, schedule: planStopSchedule(seed?.toSchedule) },
  };
}

// NuVizz caps both at 20 chars. Over-long values are the classic silent-discard trap on an
// async worker (§I: "SUCCESS ack, nothing lands"), so refuse UP FRONT rather than send them.
export const ROUTE_FIELD_MAX = 20;

export function buildRouteCreateBody(input: RouteCreateInput, companyCode: string): any {
  const loadNbr = String(req(input?.loadNbr, 'createRoute: loadNbr')).trim();
  if (!loadNbr) throw new Error('createRoute: loadNbr is required');
  if (loadNbr.length > ROUTE_FIELD_MAX) throw new Error(`createRoute: loadNbr "${loadNbr}" is ${loadNbr.length} chars — NuVizz caps it at ${ROUTE_FIELD_MAX}`);
  const routeName = strField(input?.routeName);
  if (routeName.length > ROUTE_FIELD_MAX) throw new Error(`createRoute: route name "${routeName}" is ${routeName.length} chars — NuVizz caps it at ${ROUTE_FIELD_MAX}`);
  // Same proven window shape as the import header: full seconds form, never millis/offset.
  const iso = (v: any) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) ? v.slice(0, 19) : null);
  const day = isDayString(input?.date) ? String(input.date) : null;
  const earliest = iso(input?.earliestStartDttm) || (day ? `${day}T06:00:00` : null);
  const latest = iso(input?.latestStartDttm) || (day ? `${day}T18:00:00` : null);
  if (!earliest) throw new Error('createRoute: a service date (or an explicit earliestStartDttm) is required — NuVizz will not create a route without a start');

  const o = input?.origin || {};
  if (!(strField(o.name) && strField(o.addr1) && strField(o.city) && strField(o.zip))) {
    throw new Error('createRoute: no ship-from origin available — set one in the New Order tab first (NuVizz accepts a route with no origin and then creates nothing)');
  }
  const loadHeader: any = {
    loadNbr,
    ...(routeName ? { routeName } : {}),
    earliestStartDttm: earliest,
    ...(latest ? { latestStartDttm: latest } : {}),
    origin: 'WHSE',
    originName: strField(o.name), originAddr1: strField(o.addr1),
    ...(strField(o.addr2) ? { originAddr2: strField(o.addr2) } : {}),
    originCity: strField(o.city), originState: stateCode(o.state), originZip: strField(o.zip),
    originCountry: countryCode(o.country) || 'USA',
    loadTimeZone: strField(input?.loadTimeZone) || 'EST',
  };
  // NuVizz refuses a stopless route (903), so at least one order is REQUIRED — refuse up
  // front rather than burn the collision-check read on a create that cannot land.
  const seeds = Array.isArray(input?.seeds) ? input.seeds.filter((s: any) => s?.stopNbr) : [];
  if (!seeds.length) {
    throw new Error('createRoute: at least one order is required — NuVizz refuses an empty route (reason 903: "Either PlanStop or Stop node should be present")');
  }
  if (seeds.length > ROUTE_CREATE_MAX_STOPS) {
    throw new Error(`createRoute: ${seeds.length} orders — NuVizz caps a route create at ${ROUTE_CREATE_MAX_STOPS} planStops`);
  }
  // `route` carries loadHeader + the order REFERENCES and NOTHING else. No `stops` node, no
  // loadAssignment (a driver is assigned afterwards by the existing assignDriver op, which is
  // verified). buildPlanStopRef sanitizes, so caller-passed junk can never widen the payload.
  return { companyCode, route: { loadHeader, planStops: seeds.map((s: RouteCreateSeed, i: number) => buildPlanStopRef(s, i + 1)) } };
}

/** normStopNbr (§I) — canonical stopNbr for ORDER COMPARISON ONLY (display/journals keep raw):
 *  trim, uppercase, strip leading zeros ("007141643" ≡ "7141643" ≡ 7141643). NuVizz isn't
 *  consistent about zero-padding/typing across endpoints; a padding mismatch must never read
 *  as "order not converged" (save-cost investigation directive, Jul 2 2026). */
export function normStopNbr(v: any): string {
  const s = String(v ?? '').trim().toUpperCase();
  const stripped = s.replace(/^0+(?=.)/, '');
  return stripped || s;
}

/** sameOrder (§I) — the ONE convergence comparator: both sides normalized via normStopNbr,
 *  element-wise equality (order AND membership). Exported so client + server + tests share it. */
export function sameOrder(seen: any[], want: any[]): boolean {
  if (!Array.isArray(seen) || !Array.isArray(want) || seen.length !== want.length) return false;
  return seen.every((n, i) => normStopNbr(n) === normStopNbr(want[i]));
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

    // Portal-verified note write (§N). Body carries ONLY the identity + the merged
    // comments list — the endpoint's name promises a partial update and the caller
    // (runAddStopNote) verifies with a read-back tripwire that nothing else moved,
    // so an unsent field can never be silently blanked without us reporting it.
    case 'partialUpdateStop': {
      const stops = payload?.stops;
      if (!Array.isArray(stops) || !stops.length) throw new Error('partialUpdateStop: missing stops[]');
      return { url: `${base}/stop/partialUpdate/${enc(cc)}`, method: 'POST', headers: H, body: JSON.stringify({ stops }), meta: { route: '/stop/partialUpdate', tenant: cc, source: 'live-write' } };
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

    case 'createRoute': {
      // §R — create a route from a header + ONE seed PlanStop reference (NuVizz refuses a
      // stopless route, reason 903). The builder guarantees the body carries no `stops`
      // value node and only the sanitized seed reference, so it can never touch freight.
      const body = buildRouteCreateBody(payload?.route ?? payload, cc);
      return { url: `${base}/routePlan/update/default/${enc(cc)}`, method: 'POST', headers: H, body: JSON.stringify(body), meta: { route: '/routePlan/update/default', tenant: cc, source: 'live-write' } };
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
    // `raw` rides along (additive) so note writes can merge onto the stop's ACTUAL
    // comments[] and fingerprint its guarded fields — normalizeStop deliberately
    // flattens both away, and a merge against a flattened view would drop comments.
    case 'getStop': return { ok: httpOk, stop: normalizeStop(j), raw: rawStopFrom(j) };
    case 'getLoad': return { ok: httpOk, load: normalizeLoad(j) };
    case 'getLoadByRouteId': return { ok: httpOk, load: normalizeStaticLoad(j) };
    case 'createStop':
    case 'insertStops':
    case 'removeStops': return summarize(httpOk, j);
    case 'assignDriver':
    case 'dispatchLoad': return assignOk(j);
    case 'importLoad': return importOk(httpOk, j);
    // routePlan/update answers the same ImportResponse envelope as the load import — an
    // async ack, never proof the route landed. runNewRoute converges with a real read.
    case 'createRoute': return importOk(httpOk, j);
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
