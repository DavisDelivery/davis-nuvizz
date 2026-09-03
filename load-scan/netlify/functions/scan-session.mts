// scan-session.mts
//
// POST -> upsert a scan session. IDEMPOTENT on (loadNbr, og).
//
// The phone writes every scan to a local queue first and flushes here when signal
// returns. A flush can and will replay: the driver walks out of the dead zone, the
// request times out mid-flight, the queue retries. So this endpoint must be safe
// to call with the same scans repeatedly — de-duplication is by OG, which is the
// unique physical-piece ID off the Code 128 barcode.
//
// FOUR-LAYER PRESERVATION on the ingest path:
//   1. raw       — every incoming scan object, as the phone sent it (a rejected
//                  row keeps a 256-char JSON excerpt — enough to see what came
//                  in, not enough for one bad row to bloat the doc)
//   2. accepted  — the normalized scans that became session rows
//   3. rejected  — anything dropped, WITH the reason, never silently discarded
//   4. session   — the derived counts and reconciliation
// A scan that cannot be parsed is still recorded. Losing a scan silently is the
// one failure this app cannot have.
//
// ZERO NuVizz calls.

import { getDocWithMeta, setDocIfUnchanged, isFirestoreEnabled } from './lib/firestore.mts';
import { authenticate } from './lib/auth.mts';
import { normalizePro } from './lib/manifest.mts';
import { mergeWorker } from './lib/activity.mts';
import { ok, bad, json, unauthorized, readJson, etDayString, DATE_RE } from './lib/http.mts';

const SESSIONS = 'nuvizz_load_scans';
const TENANT = 'davis';

const OG_RE = /^OG\d{10}$/;

export interface ScanRow {
  og: string;
  pro: string;
  scannedAt: string;
  stopNbr: string;
  /**
   * 'wedge' is the scanner gun (keyboard wedge). It was missing from this list,
   * so every gun scan was stored as 'manual' — indistinguishable in the record
   * from a piece somebody typed in by hand.
   */
  engine: 'native' | 'quagga' | 'wedge' | 'manual';
  /**
   * Damaged freight that STILL WENT ON THE TRUCK. It counts toward the load like
   * any other piece — the trailer is full either way — so this changes no
   * arithmetic. It exists so the office can raise the claim, which it cannot do
   * if the flag stops at the phone.
   */
  damaged?: boolean;
  damageNote?: string;
  /**
   * A scan the loader took back. Tombstoned rather than deleted so the void can
   * be pushed: a scan that reached here and was then merely dropped from the
   * phone would leave this record counting a piece the dock has let go of.
   */
  voidedAt?: string | null;
  voidReason?: string;
}

/** Normalize one incoming scan, or explain why it cannot be used. */
/**
 * A piece typed in by PRO when the OG could not be read.
 *
 * The OG is the dedup key, so a piece without one still needs a unique id. This
 * is that id: TYPED-<pro>-<n>. It can never collide with a real OG (different
 * prefix) and it is obvious in the record that nobody scanned it.
 *
 * Needed because a torn, smudged or missing OG barcode used to leave the driver
 * with NO way to record the piece at all — the manual form demanded both.
 */
export const TYPED_RE = /^TYPED-\d{7}-\d{1,3}$/;

/**
 * A piece SCANNED by PRO where the OG barcode was never decoded.
 *
 * The scanner no longer waits for both barcodes — see createScanResolver. A PRO
 * alone is a piece, so it needs an id, and it must stay distinguishable from a
 * piece with a real OG (exact per-piece dedup) and from one typed by hand.
 */
export const NOOG_RE = /^NOOG-\d{7}-\d{1,3}$/;

export function normalizeScan(raw: any): { row?: ScanRow; reason?: string } {
  const og = String(raw?.og ?? '').trim().toUpperCase();
  if (!og) return { reason: 'missing og' };
  if (!OG_RE.test(og) && !TYPED_RE.test(og) && !NOOG_RE.test(og)) {
    return { reason: `og not OG+10 digits, TYPED-pro-n or NOOG-pro-n: ${og.slice(0, 24)}` };
  }

  const pro = normalizePro(raw?.pro);
  if (!pro) return { reason: `missing or unparseable pro for ${og}` };

  const engineRaw = String(raw?.engine ?? '').toLowerCase();
  const engine: ScanRow['engine'] =
    engineRaw === 'native' || engineRaw === 'quagga' || engineRaw === 'wedge' || engineRaw === 'manual'
      ? engineRaw
      : 'manual';

  const at = String(raw?.scannedAt ?? '').trim();
  const scannedAt = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();

  const voidedRaw = String(raw?.voidedAt ?? '').trim();
  const voidedAt = voidedRaw && !Number.isNaN(Date.parse(voidedRaw)) ? new Date(voidedRaw).toISOString() : null;

  return {
    row: {
      og,
      pro,
      scannedAt,
      stopNbr: String(raw?.stopNbr ?? '').trim(),
      // A typed piece is never reported as scanned, whatever the client claims.
      engine: TYPED_RE.test(og) ? 'manual' : engine,
      damaged: !!raw?.damaged,
      damageNote: raw?.damaged ? String(raw?.damageNote ?? '').slice(0, 500) : '',
      voidedAt,
      voidReason: voidedAt ? String(raw?.voidReason ?? '').slice(0, 500) : '',
    },
  };
}

// ── Size caps ────────────────────────────────────────────────────────────────
//
// Every field below lands in ONE Firestore document per load, and a document
// tops out at 1 MiB. Without caps a single push carrying a 900 KB `note`, or a
// queue replaying ten thousand rows, wedges the doc past the limit and EVERY
// later push for that truck fails — including the close-out. A push over a cap
// is refused whole with 413 and a body naming the row, so the phone can set
// that row aside instead of retrying it every 30 seconds for the rest of the
// shift. The client sends its queue in slices of PUSH_ROWS_MAX (src/lib/api.js),
// which must never exceed CAPS.rows.
export const CAPS = {
  /** Rows per array per push. A long dead zone flushes a few hundred. */
  rows: 500,
  stopNbr: 32,
  /** reason / note / resolvedBy. */
  text: 500,
  /** JSON excerpt kept of a rejected row's raw object. */
  rejectedRaw: 256,
} as const;

export interface CapViolation {
  /** Which list the offending row is in, or 'reconciliation'. */
  list: 'scans' | 'handConfirms' | 'reconciliation';
  /** Row index within that list; null for the reconciliation block or a row-count breach. */
  index: number | null;
  detail: string;
}

/** First cap the body breaches, or null when it is within limits. */
export function checkPayloadCaps(body: any): CapViolation | null {
  const scans: any[] = Array.isArray(body?.scans) ? body.scans : [];
  const hands: any[] = Array.isArray(body?.handConfirms) ? body.handConfirms : [];
  if (scans.length > CAPS.rows) {
    return { list: 'scans', index: null, detail: `scans has ${scans.length} rows, max ${CAPS.rows} per push` };
  }
  if (hands.length > CAPS.rows) {
    return { list: 'handConfirms', index: null, detail: `handConfirms has ${hands.length} rows, max ${CAPS.rows} per push` };
  }
  const tooLong = (v: any, max: number) => String(v ?? '').length > max;
  for (let i = 0; i < scans.length; i++) {
    if (tooLong(scans[i]?.stopNbr, CAPS.stopNbr)) {
      return { list: 'scans', index: i, detail: `scans[${i}].stopNbr is ${String(scans[i].stopNbr).length} chars, max ${CAPS.stopNbr}` };
    }
  }
  for (let i = 0; i < hands.length; i++) {
    if (tooLong(hands[i]?.stopNbr, CAPS.stopNbr)) {
      return { list: 'handConfirms', index: i, detail: `handConfirms[${i}].stopNbr is ${String(hands[i].stopNbr).length} chars, max ${CAPS.stopNbr}` };
    }
    if (tooLong(hands[i]?.reason, CAPS.text)) {
      return { list: 'handConfirms', index: i, detail: `handConfirms[${i}].reason is ${String(hands[i].reason).length} chars, max ${CAPS.text}` };
    }
  }
  for (const k of ['resolvedBy', 'note'] as const) {
    if (tooLong(body?.reconciliation?.[k], CAPS.text)) {
      return { list: 'reconciliation', index: null, detail: `reconciliation.${k} is ${String(body.reconciliation[k]).length} chars, max ${CAPS.text}` };
    }
  }
  return null;
}

/** What is kept of a rejected row: a bounded JSON excerpt, never the object itself. */
export function rejectedExcerpt(raw: any): string {
  let text: string;
  try {
    text = JSON.stringify(raw) ?? String(raw);
  } catch {
    text = String(raw);
  }
  return text.slice(0, CAPS.rejectedRaw);
}

export interface HandConfirmRow {
  stopNbr: string;
  pieces: number;
  confirmedAt: string;
  /** Why the app could not scan it — carried so the record explains itself later. */
  reason: string;
}

/**
 * Normalize one hand-confirm, or explain why it cannot be used.
 *
 * A hand-confirm is a driver asserting a whole stop is on the truck when there
 * is no label the scanner can read (Averitt freight). It is deliberately NOT a
 * scan: it carries no piece IDs, it is stored separately, and it never becomes
 * an OG. Anything that reads this session can tell exactly which pieces were
 * verified by barcode and which were vouched for by a person.
 */
export function normalizeHandConfirm(raw: any): { row?: HandConfirmRow; reason?: string } {
  const stopNbr = String(raw?.stopNbr ?? '').trim();
  if (!stopNbr) return { reason: 'missing stopNbr' };

  const pieces = Number(raw?.pieces);
  if (!Number.isFinite(pieces) || pieces < 0) return { reason: `bad piece count for stop ${stopNbr}` };

  const at = String(raw?.confirmedAt ?? '').trim();
  const confirmedAt = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();

  return {
    row: {
      stopNbr,
      pieces: Math.floor(pieces),
      confirmedAt,
      reason: String(raw?.reason ?? 'not_scannable').trim() || 'not_scannable',
    },
  };
}

/** Merge hand-confirms, keyed by stop. First confirmation of a stop wins its timestamp. */
export function mergeHandConfirms(
  existing: HandConfirmRow[],
  incoming: HandConfirmRow[],
): { handConfirms: HandConfirmRow[]; added: number; duplicates: number } {
  const byStop = new Map<string, HandConfirmRow>();
  for (const r of existing) byStop.set(r.stopNbr, r);

  let added = 0;
  let duplicates = 0;
  for (const r of incoming) {
    if (byStop.has(r.stopNbr)) {
      duplicates++;
      continue;
    }
    byStop.set(r.stopNbr, r);
    added++;
  }
  const handConfirms = [...byStop.values()].sort((a, b) => a.confirmedAt.localeCompare(b.confirmedAt));
  return { handConfirms, added, duplicates };
}

/**
 * Merge incoming scans into the existing set, keyed by OG.
 *
 * First write of an OG wins on timestamp — a replay must not move a piece's
 * scannedAt forward, or the dock timeline becomes fiction.
 */
export function mergeScans(existing: ScanRow[], incoming: ScanRow[]): { scans: ScanRow[]; added: number; duplicates: number } {
  const byOg = new Map<string, ScanRow>();
  for (const r of existing) byOg.set(r.og, r);

  let added = 0;
  let duplicates = 0;
  for (const r of incoming) {
    if (byOg.has(r.og)) {
      duplicates++;
      continue;
    }
    byOg.set(r.og, r);
    added++;
  }
  const scans = [...byOg.values()].sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
  return { scans, added, duplicates };
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return bad('POST only', 405);
  // Authenticate BEFORE any configuration check: a caller with no token must not
  // be able to learn whether this site is configured.
  const claims = authenticate(req);
  if (!claims) return unauthorized();

  if (!isFirestoreEnabled()) return bad('not configured', 503);

  const body = await readJson(req);
  const loadNbr = String(body?.loadNbr ?? '').trim();
  const dateIn = String(body?.date ?? '');
  const date = DATE_RE.test(dateIn) ? dateIn : etDayString();
  if (!loadNbr) return bad('loadNbr is required');

  // Refused BEFORE the read, so an oversized push cannot even cost a Firestore
  // round trip. 413, not 400: the phone treats 400 like any other failure and
  // retries, and this one will never succeed.
  const cap = checkPayloadCaps(body);
  if (cap) return json({ ok: false, error: 'payload_too_large', ...cap }, 413);

  const incomingRaw: any[] = Array.isArray(body?.scans) ? body.scans : [];
  const incomingHandRaw: any[] = Array.isArray(body?.handConfirms) ? body.handConfirms : [];

  // Layer 1 + 3: normalize, keeping every rejection and its reason.
  const accepted: ScanRow[] = [];
  const rejected: Array<{ raw: string; reason: string }> = [];
  for (const r of incomingRaw) {
    const { row, reason } = normalizeScan(r);
    if (row) accepted.push(row);
    else rejected.push({ raw: rejectedExcerpt(r), reason: reason || 'unknown' });
  }
  const acceptedHand: HandConfirmRow[] = [];
  for (const r of incomingHandRaw) {
    const { row, reason } = normalizeHandConfirm(r);
    if (row) acceptedHand.push(row);
    else rejected.push({ raw: rejectedExcerpt(r), reason: reason || 'unknown hand-confirm' });
  }

  const path = `${SESSIONS}/${TENANT}__${date}__${loadNbr}`;

  // READ, MERGE, WRITE — AND CHECK NOBODY MOVED IT UNDER US.
  //
  // Two loaders on one truck is the normal case at 5am, not the edge case. Both
  // phones flush, both handlers read the same document, each merges only its own
  // scans into what it read, and the second write replaces the first: one
  // loader's pieces are gone from the record. Both requests answered 200, so
  // both phones marked those rows synced and the local queue — the only other
  // copy — dropped them too. The freight was on the truck and the system had no
  // idea.
  //
  // So the write carries the updateTime we read as a precondition. If it does
  // not land, someone else wrote in between, and the answer is not to give up
  // but to read THEIR document and merge into that. Only if the load is so busy
  // that five attempts all lose does the caller get a 409, which is the one
  // honest reply: the phone leaves the rows unsynced and flushes them again.
  const MAX_ATTEMPTS = 5;
  let reply: any = null;
  let refusal: Response | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { data: prior, updateTime } = await getDocWithMeta(path);
    const priorScans: ScanRow[] = Array.isArray(prior?.scans) ? prior.scans : [];
    const priorHand: HandConfirmRow[] = Array.isArray(prior?.handConfirms) ? prior.handConfirms : [];

    const { scans, added, duplicates } = mergeScans(priorScans, accepted);
    const { handConfirms, added: handAdded, duplicates: handDuplicates } = mergeHandConfirms(priorHand, acceptedHand);

    const incomingSeq = String(body?.sequenceFingerprint ?? '').trim();
    const priorSeq = String(prior?.loadedAgainstSequence ?? '').trim();
    const loadedAgainstSequence = priorSeq || incomingSeq || null;
    const sequenceChanged = !!(priorSeq && incomingSeq && priorSeq !== incomingSeq) || !!prior?.sequenceChanged;

    const expectedPieces = Number(body?.expectedPieces ?? prior?.expectedPieces ?? 0) || 0;
    // Pieces verified by barcode, and pieces a person vouched for — counted
    // together for reconciliation, stored apart so the difference survives.
    const scannedPieces = scans.length;
    const confirmedPieces = handConfirms.reduce((n, h) => n + h.pieces, 0);
    const scannedCount = scannedPieces + confirmedPieces;

    // reconciliation is driver-authored on close-out; carry it through untouched
    // unless this request is the one closing the load.
    const closing = body?.close === true;
    const reconciliation = closing
      ? {
          scannedCount,
          shortCount: Math.max(0, expectedPieces - scannedCount),
          overCount: Math.max(0, scannedCount - expectedPieces),
          resolvedBy: String(body?.reconciliation?.resolvedBy ?? '').trim() || null,
          note: String(body?.reconciliation?.note ?? '').trim() || null,
          at: new Date().toISOString(),
        }
      : prior?.reconciliation ?? null;

    // A load must not close silently with a mismatch. Re-judged on every attempt
    // against the document we actually merged into: the scans that arrived while
    // we were losing the race count toward the total the driver is closing on.
    if (closing && scannedCount !== expectedPieces && !reconciliation?.resolvedBy) {
      refusal = bad('cannot close with a piece-count mismatch and no resolution — set reconciliation.resolvedBy', 409);
      break;
    }

    const landed = await setDocIfUnchanged(path, {
      tenant: TENANT,
      date,
      loadNbr,
      driverNumber: String(claims.sub),
      // Everyone who touched this load, with their role — a loader who loads the
      // truck and a driver who scans it later are both part of its history, and a
      // single overwritten driverNumber erased whichever came first.
      workedBy: mergeWorker(prior?.workedBy, {
        driverNumber: String(claims.sub),
        role: String((claims as any).role || 'driver'),
        pieces: added + handAdded,
        at: new Date().toISOString(),
      }),
      startedAt: prior?.startedAt || new Date().toISOString(),
      closedAt: closing ? new Date().toISOString() : prior?.closedAt || null,
      expectedPieces,
      scannedCount,
      scannedPieces,
      confirmedPieces,
      scans,
      handConfirms,
      // The route order this trailer was physically loaded against. First write
      // wins — if a later push carries a different one, dispatch resequenced
      // mid-load and the freight on the truck no longer matches the manifest.
      loadedAgainstSequence,
      sequenceChanged,
      reconciliation,
      // Layer 3, persisted: rejects accumulate rather than overwrite, so a bad
      // label pattern is still visible days later.
      rejected: [...(Array.isArray(prior?.rejected) ? prior.rejected : []), ...rejected].slice(-200),
      updatedAt: new Date().toISOString(),
    }, updateTime);

    if (landed) {
      reply = {
        loadNbr,
        date,
        scannedCount,
        scannedPieces,
        confirmedPieces,
        added,
        duplicates,
        handAdded,
        handDuplicates,
        rejected: rejected.length,
        rejectedDetail: rejected.slice(0, 20),
        closed: closing,
        attempts: attempt,
      };
      break;
    }
    // Somebody wrote first. Back off a little so two phones retrying together do
    // not keep colliding on the same instant, then read their document and merge
    // into it.
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)));
  }

  if (refusal) return refusal;
  if (!reply) {
    // Never a silent success: the phone must keep these rows queued.
    return json({ ok: false, error: 'busy — another push for this load landed first; retry', retryable: true }, 409);
  }

  return ok(reply);
};
