// manifest-push-log.mts
//
// Durable, date-partitioned log of orders pushed to NuVizz from the Manifest Intake
// panel, so a dispatcher can look back at "what did I push yesterday" from any device.
// Firestore only — ZERO NuVizz calls. Layout mirrors the other date-keyed stores:
//   manifest_push_log/{tenant}__{YYYY-MM-DD}  → { tenant, date, records:[…], updated_at }
//
//   POST { records:[…], date? }   → append/UPSERT records onto that day's log (deduped by
//                                    orderRef, so a re-push updates the record in place).
//                                    date defaults to the server's ET today.
//   GET  ?date=YYYY-MM-DD          → { ok, date, records } for that day (empty if none).
//   GET  ?list=1                   → { ok, days:[{date,count}] } newest-first, for the picker.
import { isFirestoreEnabled, getDoc, setDoc, listDocs, etDayString } from './lib/firestore.mts';

const TENANT = 'davis';
const COLLECTION = 'manifest_push_log';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RECORDS_PER_POST = 2000;
const docPath = (date: string) => `${COLLECTION}/${TENANT}__${date}`;

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
    phone: s(r.phone) || '', dispatchNotes: s(r.dispatchNotes) || '',
    updated: r.updated === true || r._updated === true,
    manifestNumber: s(r.manifestNumber) || null,
    serviceDate: s(r.serviceDate) || null,
    pushedAt: s(r.pushedAt) || new Date().toISOString(),
  };
}

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, reason: 'log_unavailable', records: [], days: [] }), { status: 200, headers: cors });
  }
  const url = new URL(req.url);
  try {
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const date = DATE_RE.test(String(body?.date || '')) ? String(body.date) : etDayString();
      const incoming = Array.isArray(body?.records) ? body.records.slice(0, MAX_RECORDS_PER_POST).map(shapeRecord) : [];
      if (!incoming.length) return new Response(JSON.stringify({ ok: true, added: 0 }), { status: 200, headers: cors });
      // UPSERT by orderRef (fall back to nuvizzNbr; a record with NEITHER gets a synthetic
      // key so it still lands in the audit log instead of being silently dropped).
      const keyOf = (r: any) => String(r?.orderRef || r?.nuvizzNbr || '') || `anon:${r?.name || ''}|${r?.pushedAt || ''}`;
      const truncated = Array.isArray(body?.records) ? Math.max(0, body.records.length - incoming.length) : 0;
      // Read-merge-write with a post-write verify: two near-simultaneous pushes (Bulk Add +
      // Manifest Intake, or two dispatchers) used to clobber each other — the second full-doc
      // setDoc erased the first's records while both got {ok:true}. A plain re-read after the
      // write catches the common interleave and re-merges; bounded retries, best-effort.
      let merged: any[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const existing = (await getDoc(docPath(date))) || {};
        const prior = Array.isArray(existing.records) ? existing.records : [];
        const byKey = new Map<string, any>();
        for (const r of prior) byKey.set(keyOf(r), r);
        for (const r of incoming) byKey.set(keyOf(r), r);
        merged = [...byKey.values()].sort((a, b) => String(b.pushedAt || '').localeCompare(String(a.pushedAt || '')));
        await setDoc(docPath(date), { tenant: TENANT, date, records: merged, updated_at: new Date().toISOString() });
        const check = (await getDoc(docPath(date))) || {};
        const have = new Set((Array.isArray(check.records) ? check.records : []).map(keyOf));
        if (incoming.every((r: any) => have.has(keyOf(r)))) break;   // our records survived
      }
      return new Response(JSON.stringify({ ok: true, added: incoming.length, truncated, total: merged.length, date }), { status: 200, headers: cors });
    }

    if (url.searchParams.get('list')) {
      const docs = await listDocs(COLLECTION, { mask: ['date', 'records'] }).catch(() => [] as any[]);
      const days = docs
        .map((d: any) => ({ date: String(d?._id || '').slice(TENANT.length + 2), count: Array.isArray(d?.records) ? d.records.length : 0 }))
        .filter((d: any) => DATE_RE.test(d.date) && d.count > 0)
        .sort((a: any, b: any) => (a.date < b.date ? 1 : -1));
      return new Response(JSON.stringify({ ok: true, days }), { status: 200, headers: cors });
    }

    const date = String(url.searchParams.get('date') || '').trim();
    if (DATE_RE.test(date)) {
      const doc = await getDoc(docPath(date));
      return new Response(JSON.stringify({ ok: true, date, records: Array.isArray(doc?.records) ? doc.records : [] }), { status: 200, headers: cors });
    }
    return new Response(JSON.stringify({ ok: false, reason: 'pass ?date=YYYY-MM-DD or ?list=1', records: [], days: [] }), { status: 400, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'log error', records: [], days: [] }), { status: 500, headers: cors });
  }
};
