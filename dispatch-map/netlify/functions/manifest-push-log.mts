// manifest-push-log.mts
//
// Durable, date-partitioned log of orders pushed to NuVizz (Manifest Intake + Bulk Add),
// so a dispatcher can look back at "what did I push yesterday" from any device.
// Firestore only — ZERO NuVizz calls.
//
// STORAGE (v0.50.57): one Firestore doc PER RECORD, so concurrent pushes can never
// clobber each other (the old layout kept the whole day in one doc's records[] array —
// two near-simultaneous pushes read-merged-wrote the same array and the second write
// silently erased the first's records; same doc-id = the intended per-order upsert):
//   manifest_push_log/{tenant}__{YYYY-MM-DD}                → day summary { tenant, date, count, updated_at }
//   manifest_push_log/{tenant}__{YYYY-MM-DD}/records/{id}   → one pushed order each
// Day docs written by pre-v0.50.57 builds still carry a legacy records[] array; reads
// MERGE it with the per-record docs (per-record wins on the same key) so history is intact.
//
//   POST { records:[…], date? }   → upsert each record as its own doc (key: orderRef, then
//                                    nuvizzNbr, then a synthetic anon key — nothing is dropped).
//                                    date defaults to the server's ET today.
//   GET  ?date=YYYY-MM-DD          → { ok, date, records } for that day (empty if none).
//   GET  ?list=1                   → { ok, days:[{date,count}] } newest-first, for the picker.
import { isFirestoreEnabled, getDoc, setDoc, listDocs, etDayString } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';
const COLLECTION = 'manifest_push_log';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RECORDS_PER_POST = 2000;
const docPath = (date: string) => `${COLLECTION}/${TENANT}__${date}`;
const recordsPath = (date: string) => `${docPath(date)}/records`;

// Keep only the fields the Pushed view renders — bounded, no surprise payloads.
function shapeRecord(r: any): any {
  const s = (v: any) => (v == null ? null : String(v));
  return {
    orderRef: s(r.orderRef) || s(r.stopNbr) || null,
    nuvizzNbr: s(r.nuvizzNbr) || s(r._pushedNbr) || null,
    name: s(r.name) || '',
    addr1: s(r.addr1) || '', addr2: s(r.addr2) || '',
    city: s(r.city) || '', state: s(r.state) || '', zip: s(r.zip) || '',
    itemDesc: s(r.itemDesc) || '',
    pallets: s(r.pallets) || '', loose: s(r.loose) || '', weight: s(r.weight) || '', price: s(r.price) || '',
    // email rides with phone: the Pushed tab renders it, and it is the address the
    // delivery-complete mail goes to — dropping it here would make a row that pushed WITH
    // an address read back as having none.
    phone: s(r.phone) || '', email: s(r.email) || '', dispatchNotes: s(r.dispatchNotes) || '',
    updated: r.updated === true || r._updated === true,
    manifestNumber: s(r.manifestNumber) || null,
    serviceDate: s(r.serviceDate) || null,
    pushedAt: s(r.pushedAt) || new Date().toISOString(),
  };
}

// Upsert identity for a record: orderRef, else nuvizzNbr, else a synthetic key — a
// ref-less row (e.g. an OCR row with no readable numbers) still lands in the audit log.
export function pushLogKey(r: any): string {
  return String(r?.orderRef || r?.nuvizzNbr || '') || `anon:${r?.name || ''}|${r?.pushedAt || ''}`;
}

// Firestore doc id for a key: sanitized to safe chars + a short stable hash so two keys
// that sanitize identically (e.g. "SO/1" vs "SO_1") can't collide onto one doc.
export function recordDocId(key: string): string {
  const k = String(key);
  let h = 5381;
  for (let i = 0; i < k.length; i++) h = ((h * 33) ^ k.charCodeAt(i)) >>> 0;
  const safe = k.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'rec';
  return `${safe}__${h.toString(36)}`;
}

// Merge the legacy day-doc array with the per-record docs: per-record wins on the same
// key (it's the newer store), result sorted newest-first by pushedAt.
export function mergePushRecords(legacy: any[], perRecord: any[]): any[] {
  const byKey = new Map<string, any>();
  for (const r of legacy || []) if (r) byKey.set(pushLogKey(r), r);
  for (const r of perRecord || []) if (r) byKey.set(pushLogKey(r), r);
  return [...byKey.values()].sort((a, b) => String(b.pushedAt || '').localeCompare(String(a.pushedAt || '')));
}

const stripId = ({ _id, ...rest }: any) => rest;

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  // TWO DOORS, split the way nuvizz-board-reconcile splits its preview from its run.
  //
  // READING the log is a viewer's: it is the "what did I push yesterday" screen.
  //
  // The POST is not a read — it APPENDS to the audit trail, and this log is the record that
  // answers "did that order actually get pushed?" when a customer says a delivery never
  // arrived. A viewer who can append can write history into it: a row that says an order was
  // pushed when it was not, or a duplicate that makes a single push look like two. That is the
  // one thing an audit trail may never allow from the read-only role, so the POST is
  // DISPATCHER — the same role that is allowed to do the pushing in the first place.
  //
  // The earlier "same screen reads and writes it, so gate them together" reasoning is true and
  // beside the point: the screen is the same, the ACT is not, and the roles follow the act.
  //
  // Both inert until AUTH_REQUIRED=true.
  const gate = req.method === 'POST'
    ? await requireUser(req, { role: 'dispatcher' })
    : await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, reason: 'log_unavailable', records: [], days: [] }), { status: 200, headers: cors });
  }
  const url = new URL(req.url);
  try {
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const date = DATE_RE.test(String(body?.date || '')) ? String(body.date) : etDayString();
      const incoming = Array.isArray(body?.records) ? body.records.slice(0, MAX_RECORDS_PER_POST).map(shapeRecord) : [];
      const truncated = Array.isArray(body?.records) ? Math.max(0, body.records.length - incoming.length) : 0;
      if (!incoming.length) return new Response(JSON.stringify({ ok: true, added: 0, truncated }), { status: 200, headers: cors });
      // One doc per record — independent writes, no shared array to clobber. Chunked so a
      // big manifest doesn't fire 2000 parallel PATCHes at once.
      for (let i = 0; i < incoming.length; i += 25) {
        await Promise.all(incoming.slice(i, i + 25).map((r: any) => setDoc(`${recordsPath(date)}/${recordDocId(pushLogKey(r))}`, r)));
      }
      // Day summary for the ?list=1 picker (count = merged view incl. any legacy array).
      // Best-effort: the records above are already durably written.
      let total = incoming.length;
      try {
        const [dayDoc, recDocs] = await Promise.all([getDoc(docPath(date)), listDocs(recordsPath(date), { mask: ['orderRef', 'nuvizzNbr', 'name', 'pushedAt'] })]);
        total = mergePushRecords(Array.isArray(dayDoc?.records) ? dayDoc.records : [], recDocs.map(stripId)).length;
        await setDoc(docPath(date), { tenant: TENANT, date, count: total, updated_at: new Date().toISOString(), ...(Array.isArray(dayDoc?.records) ? { records: dayDoc.records } : {}) });
      } catch (e: any) { console.warn(`[push-log] day summary ${date} failed: ${e?.message}`); }
      return new Response(JSON.stringify({ ok: true, added: incoming.length, truncated, total, date }), { status: 200, headers: cors });
    }

    if (url.searchParams.get('list')) {
      const docs = await listDocs(COLLECTION, { mask: ['date', 'count', 'records'] }).catch(() => [] as any[]);
      const days = docs
        .map((d: any) => ({ date: String(d?._id || '').slice(TENANT.length + 2), count: Number(d?.count) || (Array.isArray(d?.records) ? d.records.length : 0) }))
        .filter((d: any) => DATE_RE.test(d.date) && d.count > 0)
        .sort((a: any, b: any) => (a.date < b.date ? 1 : -1));
      return new Response(JSON.stringify({ ok: true, days }), { status: 200, headers: cors });
    }

    const date = String(url.searchParams.get('date') || '').trim();
    if (DATE_RE.test(date)) {
      const [doc, recDocs] = await Promise.all([getDoc(docPath(date)), listDocs(recordsPath(date)).catch(() => [] as any[])]);
      const records = mergePushRecords(Array.isArray(doc?.records) ? doc.records : [], recDocs.map(stripId));
      return new Response(JSON.stringify({ ok: true, date, records }), { status: 200, headers: cors });
    }
    return new Response(JSON.stringify({ ok: false, reason: 'pass ?date=YYYY-MM-DD or ?list=1', records: [], days: [] }), { status: 400, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'log error', records: [], days: [] }), { status: 500, headers: cors });
  }
};
