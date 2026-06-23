// marginiq-admin.mts
//
// TEMPORARY, token-gated discovery helper to learn how MarginIQ stores employees
// in the shared Firestore (collection name + field shape) so Stage 2 can resolve
// a driver's phone server-side. Values are MASKED in responses so no raw PII
// leaves — it reveals field NAMES and value SHAPES only. Remove once Stage 2 is
// wired.
//
//   GET ...?token=<MARGINIQ_ADMIN_TOKEN>&action=collections
//   GET ...?token=...&action=subcollections&doc=<docPath>
//   GET ...?token=...&action=sample&collection=<id>&n=2

import { listCollectionIds, listDocs } from './lib/firestore.mts';

// Mask a value so structure is visible but content isn't: digits→#, keep last 2;
// letters→first 3 + length. Reveals "phone-like" vs "name-like" fields.
function maskVal(v: any): any {
  if (v == null) return v;
  if (typeof v === 'number') return `#num(${String(v).length}d)`;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return `[array ${v.length}]`;
  if (typeof v === 'object') return `{obj ${Object.keys(v).join(',')}}`;
  const s = String(v);
  const digits = (s.match(/\d/g) || []).length;
  if (digits >= 7) return `phoneLike(${digits}d)…${s.slice(-2)}`;
  return `${s.slice(0, 3)}…(${s.length})`;
}

export default async (req: Request): Promise<Response> => {
  const json = (b: any, status = 200) => new Response(JSON.stringify(b, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
  const tok = process.env.MARGINIQ_ADMIN_TOKEN;
  if (!tok) return json({ ok: false, error: 'MARGINIQ_ADMIN_TOKEN unset' }, 503);
  const url = new URL(req.url);
  if (url.searchParams.get('token') !== tok) return json({ ok: false, error: 'forbidden' }, 403);

  const action = url.searchParams.get('action') || 'collections';
  try {
    if (action === 'collections') {
      return json({ ok: true, collections: await listCollectionIds() });
    }
    if (action === 'subcollections') {
      const doc = url.searchParams.get('doc') || '';
      return json({ ok: true, doc, subcollections: await listCollectionIds(doc) });
    }
    if (action === 'sample') {
      const collection = url.searchParams.get('collection') || '';
      const n = Math.max(1, Math.min(5, parseInt(url.searchParams.get('n') || '2', 10)));
      const docs = (await listDocs(collection)).slice(0, n);
      const masked = docs.map((d: any) => {
        const out: any = { _id: typeof d._id === 'string' ? `${d._id.slice(0, 4)}…` : d._id };
        for (const [k, v] of Object.entries(d)) if (k !== '_id') out[k] = maskVal(v);
        return out;
      });
      return json({ ok: true, collection, count: docs.length, sample: masked });
    }
    return json({ ok: false, error: `unknown action ${action}` }, 400);
  } catch (e: any) {
    return json({ ok: false, error: e?.message }, 500);
  }
};
