// order-labels.mts
//
// THE DAVIS DELIVERY LABEL, SAVED WITH THE ORDER. Chad, Sep 24 2026: "Labels should be part of
// the orders information in firebase so should be able to in time. We should be able to print a
// new label anytime." — and: "This is supposed to be its own label, separate entity. Separate
// from any other thing that we have already in there."
//
// So it is its own collection. Nothing else reads or writes it: not the board, not the push log,
// not the Delivery Ticket, not the manifest. New Order and Bulk add write one record per order
// they create; the print buttons read it back. Firestore only — ZERO NuVizz calls.
//
// STORAGE (one doc per order, so two dispatchers creating at once never clobber each other —
// the lesson manifest-push-log paid for in v0.50.57):
//   order_labels/{tenant}__{YYYY-MM-DD}               → day summary { tenant, date, count, updated_at }
//   order_labels/{tenant}__{YYYY-MM-DD}/labels/{id}   → one order's label, keyed by its NuVizz stop #
//   order_labels_by_stop/{tenant}__{id}               → { stopNbr, date } — find any label by number
// The date is the day the order was CREATED (Eastern), which is the day the create screens list.
//
//   POST { labels:[…] }       → upsert each (key: stopNbr). Re-creating an order replaces its label.
//   GET  ?date=YYYY-MM-DD     → { ok, date, labels } newest first
//   GET  ?stop=<stop #>       → { ok, label }        the label saved for that number, any day
//   GET  ?list=1              → { ok, days:[{date,count}] } newest first
import { isFirestoreEnabled, getDoc, setDoc, listDocs, etDayString } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';
const COLLECTION = 'order_labels';
const BY_STOP = 'order_labels_by_stop';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PER_POST = 1000;
const dayPath = (date: string) => `${COLLECTION}/${TENANT}__${date}`;
const labelsPath = (date: string) => `${dayPath(date)}/labels`;

/** Firestore doc id for a stop #: safe characters plus a short stable hash, so "SO/1" and "SO_1" never share a doc. */
export function labelDocId(stopNbr: string): string {
  const k = String(stopNbr ?? '').trim();
  let h = 5381;
  for (let i = 0; i < k.length; i++) h = ((h * 33) ^ k.charCodeAt(i)) >>> 0;
  const safe = k.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'label';
  return `${safe}__${h.toString(36)}`;
}

/** Keep only what a label prints — bounded strings, no surprise payloads. null when there is no number. */
export function shapeLabel(r: any, now: string = new Date().toISOString()): any | null {
  const s = (v: any, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));
  const stopNbr = s(r?.stopNbr, 60);
  if (!stopNbr) return null;
  const o = r?.origin && typeof r.origin === 'object' ? r.origin : null;
  return {
    stopNbr,
    ref: s(r.ref, 60),
    name: s(r.name), addr1: s(r.addr1), addr2: s(r.addr2),
    city: s(r.city, 100), state: s(r.state, 20), zip: s(r.zip, 20),
    phone: s(r.phone, 60), itemDesc: s(r.itemDesc, 500),
    pallets: s(r.pallets, 20), loose: s(r.loose, 20), weight: s(r.weight, 20),
    dispatchNotes: s(r.dispatchNotes, 1000),
    serviceDate: DATE_RE.test(s(r.serviceDate, 10)) ? s(r.serviceDate, 10) : '',
    origin: o && s(o.name) ? { name: s(o.name), addr1: s(o.addr1), city: s(o.city, 100), state: s(o.state, 20), zip: s(o.zip, 20) } : null,
    source: ['single', 'bulk', 'manifest'].includes(s(r.source, 20)) ? s(r.source, 20) : '',
    createdAt: s(r.createdAt, 40) || now,
  };
}

const stripId = ({ _id, ...rest }: any) => rest;

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  // Saving a label is part of creating the order, so it is the dispatcher's act; printing one is
  // a read. Same split as manifest-push-log. Both inert until AUTH_REQUIRED=true.
  const gate = req.method === 'POST'
    ? await requireUser(req, { role: 'dispatcher' })
    : await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, reason: 'labels_unavailable', labels: [], days: [] }), { status: 200, headers: cors });
  }
  const url = new URL(req.url);
  try {
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const date = etDayString();
      const now = new Date().toISOString();
      const raw = Array.isArray(body?.labels) ? body.labels.slice(0, MAX_PER_POST) : [];
      const labels = raw.map((r: any) => shapeLabel(r, now)).filter(Boolean);
      const dropped = raw.length - labels.length;
      if (!labels.length) return new Response(JSON.stringify({ ok: true, saved: 0, dropped, date }), { status: 200, headers: cors });
      for (let i = 0; i < labels.length; i += 25) {
        await Promise.all(labels.slice(i, i + 25).flatMap((l: any) => [
          setDoc(`${labelsPath(date)}/${labelDocId(l.stopNbr)}`, { ...l, date }),
          setDoc(`${BY_STOP}/${TENANT}__${labelDocId(l.stopNbr)}`, { stopNbr: l.stopNbr, date, updated_at: now }),
        ]));
      }
      // Day summary for ?list=1. Best-effort: the labels themselves are already written.
      let total = labels.length;
      try {
        const docs = await listDocs(labelsPath(date), { mask: ['stopNbr'] });
        total = docs.length;
        await setDoc(dayPath(date), { tenant: TENANT, date, count: total, updated_at: now });
      } catch (e: any) { console.warn(`[order-labels] day summary ${date} failed: ${e?.message}`); }
      return new Response(JSON.stringify({ ok: true, saved: labels.length, dropped, total, date }), { status: 200, headers: cors });
    }

    const stop = String(url.searchParams.get('stop') || '').trim();
    if (stop) {
      const ptr = await getDoc(`${BY_STOP}/${TENANT}__${labelDocId(stop)}`);
      const date = String(ptr?.date || '');
      const label = DATE_RE.test(date) ? await getDoc(`${labelsPath(date)}/${labelDocId(stop)}`) : null;
      return new Response(JSON.stringify({ ok: true, label: label ? stripId(label) : null }), { status: 200, headers: cors });
    }

    if (url.searchParams.get('list')) {
      const docs = await listDocs(COLLECTION, { mask: ['date', 'count'] }).catch(() => [] as any[]);
      const days = docs
        .map((d: any) => ({ date: String(d?._id || '').slice(TENANT.length + 2), count: Number(d?.count) || 0 }))
        .filter((d: any) => DATE_RE.test(d.date) && d.count > 0)
        .sort((a: any, b: any) => (a.date < b.date ? 1 : -1));
      return new Response(JSON.stringify({ ok: true, days }), { status: 200, headers: cors });
    }

    const date = String(url.searchParams.get('date') || '').trim();
    if (DATE_RE.test(date)) {
      const docs = await listDocs(labelsPath(date)).catch(() => [] as any[]);
      const labels = docs.map(stripId).sort((a: any, b: any) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return new Response(JSON.stringify({ ok: true, date, labels }), { status: 200, headers: cors });
    }
    return new Response(JSON.stringify({ ok: false, reason: 'pass ?date=YYYY-MM-DD, ?stop=<stop #> or ?list=1', labels: [] }), { status: 400, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'labels error', labels: [] }), { status: 500, headers: cors });
  }
};
