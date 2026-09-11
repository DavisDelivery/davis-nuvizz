// lib/write-registries.mts
//
// ── Local state for the live-write path (Firestore, best-effort) ─────────────
//
// The write ops mutate NuVizz; these registries are OUR record of what we did, so the
// board has an audit trail without re-reading NuVizz:
//   nuvizz_write_orders/{tenant}__{key}        — orders we created (createStop)
//   nuvizz_write_assignments/{tenant}__{key}   — load→driver assignments we set
//   nuvizz_write_ops/{tenant}__{clientOpId}    — idempotency ledger (one row per Save)
//
// All writes are BEST-EFFORT: when Firestore is off they no-op, so a live write still
// works (it just isn't journaled, and idempotency is a no-op for that request). Mirrors
// routing-store.mts (getDoc/setDoc/listDocs, no auth duplication). Keys are tenant-scoped.

import { getDoc, setDoc, listDocs, isFirestoreEnabled, etDayString } from './firestore.mts';

const ORDERS = 'nuvizz_write_orders';
const ASSIGNMENTS = 'nuvizz_write_assignments';
const OPS = 'nuvizz_write_ops';

const safeKey = (s: any) => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);

export type OpStatus = 'pending' | 'succeeded' | 'failed';

export interface OpRecord {
  clientOpId: string;
  op: string;
  status: OpStatus;
  result?: any;
  tenant: string;
  at: string;
  // Set only when trimOpRecord had to drop forensics payloads to fit the row — so a reader
  // can tell "nothing was captured" from "the capture was too big to keep".
  capturesDropped?: number;
  captureNote?: string;
}

// ── Idempotency ledger ───────────────────────────────────────────────────────

/** Look up a prior Save by its clientOpId. Returns null when absent or Firestore off. */
export async function getOpRecord(tenant: string, clientOpId: string): Promise<OpRecord | null> {
  if (!isFirestoreEnabled() || !clientOpId) return null;
  try { return (await getDoc(`${OPS}/${safeKey(tenant)}__${safeKey(clientOpId)}`)) as OpRecord | null; }
  catch { return null; }
}

/** The ONE dedup decision (convergence-audit directive): only a prior SUCCEEDED record
 *  short-circuits a repeat. A 'failed' or 'pending' prior (e.g. an import Save handed to the
 *  client verifier as pending) must NEVER swallow a re-send — the convergence recipe depends
 *  on the repeat reaching the wire. (Escalation re-Saves also carry a FRESH clientOpId, and
 *  in-invocation resends bypass the handler entirely — this guard is the last belt.) */
export function priorShortCircuits(prior: OpRecord | null): boolean {
  return prior?.status === 'succeeded';
}

// Firestore refuses a document over 1 MiB. Stay well under it: the ROW — which op, which
// outcome, when — is what a forensics read needs first, and it must never be lost to the
// forensics payloads riding on it. A failed commitBoard can carry a capture per failed op
// (see fireSingle), and enough of those would push the row past the limit; setDoc would
// throw, the catch below would swallow it, and the Save would vanish from the ledger
// entirely. Losing the receipt SILENTLY is the exact failure this capture exists to end.
const OP_RECORD_MAX_BYTES = 700_000;
/** No single string in a ledger row needs to be longer than this to be diagnostic. */
const STRING_MAX_BYTES = 20_000;

/** PURE: the record, with its forensics payloads dropped if they would sink the row — and
 *  SAYING SO, because "no payload captured" and "payload dropped for size" are different
 *  facts to whoever reads this back. Exported for test. */
export function trimOpRecord(rec: OpRecord): OpRecord {
  let json = '';
  try { json = JSON.stringify(rec); } catch { return rec; }
  if (json.length <= OP_RECORD_MAX_BYTES) return rec;
  let dropped = 0;
  let trimmed = 0;
  // EVERY long string gives way, not just the two named captures. The first version of this
  // nulled sentBody/rawBody and nothing else, which could not save the row it exists to save:
  // a NuVizz 500 whose XML `message` runs to a megabyte arrives in `error` (firstError no
  // longer truncates it, deliberately), so stripping two 8 KB captures off a 3 MB record left
  // 3 MB, setDoc threw, the catch below swallowed it, and the Save vanished from the ledger —
  // the exact failure this function was added to prevent, reintroduced by the same change.
  // A trimmed string SAYS it was trimmed, for the same reason the toast does.
  const cut = (v: string): string => {
    trimmed++;
    return `${v.slice(0, STRING_MAX_BYTES)}… [trimmed ${v.length - STRING_MAX_BYTES} chars to fit the ledger row]`;
  };
  const strip = (v: any): any => {
    if (typeof v === 'string') return v.length > STRING_MAX_BYTES ? cut(v) : v;
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) {
        if ((k === 'sentBody' || k === 'rawBody') && val != null) { dropped++; out[k] = null; continue; }
        out[k] = strip(val);
      }
      return out;
    }
    return v;
  };
  const lean = { ...rec, result: strip(rec.result) } as OpRecord;
  const note = [
    dropped ? `${dropped} request/response capture(s) dropped` : null,
    trimmed ? `${trimmed} long string(s) trimmed` : null,
  ].filter(Boolean).join(' and ');
  const out = { ...lean, capturesDropped: dropped, captureNote: `${note || 'nothing could be dropped'} — the record was ${json.length} bytes, over the ${OP_RECORD_MAX_BYTES} cap` } as OpRecord;
  // LAST RESORT. If the row STILL does not fit, the result is the part that must give way —
  // the row itself (which op, which outcome, when) is what a forensics read needs first, and
  // losing it silently is the thing this whole function is for.
  let after = '';
  try { after = JSON.stringify(out); } catch { return out; }
  if (after.length <= OP_RECORD_MAX_BYTES) return out;
  return { ...rec, result: { ok: (rec.result as any)?.ok ?? false, trimmedAway: true },
    capturesDropped: dropped,
    captureNote: `the result was dropped whole — ${json.length} bytes, still ${after.length} after trimming, over the ${OP_RECORD_MAX_BYTES} cap. The row is kept so the Save is not invisible.` } as OpRecord;
}

/** Persist (create or update) a Save's outcome. No-op when Firestore is off. */
export async function putOpRecord(rec: OpRecord): Promise<void> {
  if (!isFirestoreEnabled() || !rec.clientOpId) return;
  const safe = trimOpRecord(rec);
  try { await setDoc(`${OPS}/${safeKey(safe.tenant)}__${safeKey(safe.clientOpId)}`, { ...safe, at: safe.at || new Date().toISOString() }); }
  catch { /* best-effort journal */ }
}

// ── Created-orders registry ──────────────────────────────────────────────────

export interface CreatedOrder {
  tenant: string;
  stopNbr?: string | null;
  stopId?: string | null;
  loadNbr?: string | null;
  status: OpStatus;
  createdBy?: string | null;
  createdAt: string;
  clientOpId?: string | null;
  nuvizzResponse?: any;
  error?: string | null;
}

export async function recordCreatedOrder(o: CreatedOrder): Promise<void> {
  if (!isFirestoreEnabled()) return;
  const key = safeKey(o.clientOpId || o.stopId || o.stopNbr || `${etDayString()}_${Date.now()}`);
  try { await setDoc(`${ORDERS}/${safeKey(o.tenant)}__${key}`, { ...o, createdAt: o.createdAt || new Date().toISOString() }); }
  catch { /* best-effort */ }
}

export async function listCreatedOrders(tenant: string): Promise<CreatedOrder[]> {
  if (!isFirestoreEnabled()) return [];
  try { return ((await listDocs(ORDERS)) as CreatedOrder[]).filter((o) => o?.tenant === tenant); }
  catch { return []; }
}

// ── Load→driver assignments ──────────────────────────────────────────────────

export interface Assignment {
  tenant: string;
  date: string;            // ET board day
  loadNbr: string;
  loadId?: string | null;
  driverId?: any;
  driverName?: string | null;
  status: 'assigned' | 'dispatched' | 'failed';
  assignedAt?: string | null;
  dispatchedAt?: string | null;
}

export async function recordAssignment(a: Assignment): Promise<void> {
  if (!isFirestoreEnabled()) return;
  const key = `${safeKey(a.tenant)}__${safeKey(a.date)}__${safeKey(a.loadNbr)}`;
  try {
    const cur = ((await getDoc(`${ASSIGNMENTS}/${key}`)) as Assignment | null) || null;
    await setDoc(`${ASSIGNMENTS}/${key}`, { ...(cur || {}), ...a });
  } catch { /* best-effort */ }
}

export async function listAssignments(tenant: string, date: string): Promise<Assignment[]> {
  if (!isFirestoreEnabled()) return [];
  try { return ((await listDocs(ASSIGNMENTS)) as Assignment[]).filter((a) => a?.tenant === tenant && a?.date === date); }
  catch { return []; }
}
