// nuvizz-customer-history.mts
//
// Read-only history search for the mobile "search past PROs / customer history"
// button. Reads OUR OWN per-customer rollup (history_customers, built nightly
// from the immutable warehouse) — it NEVER calls NuVizz. So a business-name
// search costs nothing at NuVizz; it's a single indexed Firestore lookup.
//
//   GET ?name=<business name>   → customers whose name starts with the query,
//                                 each with their last 20 {pro,date}
//   GET ?pro=<pro number>       → customers whose saved history contains that PRO
//                                 (numeric PROs are matched zero-padded to 9 too)
import { isFirestoreEnabled } from './lib/firestore.mts';
import { queryCustomersByName, queryCustomersByPro, getCustomerByMatchKey } from './lib/history-customers.mts';
import { getStop } from './lib/history-store.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  // Gate at viewer: every past delivery for a customer — address, driver, ticket and line
  // items. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, reason: 'history_unavailable', customers: [] }), { status: 200, headers: cors });
  }
  const url = new URL(req.url);
  const name = (url.searchParams.get('name') || '').trim();
  const matchKey = (url.searchParams.get('matchKey') || '').trim();
  const pro = (url.searchParams.get('pro') || '').trim();
  const stop = (url.searchParams.get('stop') || '').trim();
  const date = (url.searchParams.get('date') || '').trim();
  try {
    // Single archived delivery by pro + day — powers "tap a historical PRO to see the
    // FULL delivery" (route, driver, delivery ticket, line items). Reads the immutable
    // warehouse only; ZERO NuVizz calls. The date is regex-guarded so a malformed value
    // can never build a bad Firestore path.
    if (stop && DATE_RE.test(date)) {
      const doc = await getStop(TENANT, date, stop);
      return new Response(
        JSON.stringify(doc ? { ok: true, mode: 'stop', stop: doc } : { ok: false, mode: 'stop', reason: 'not_found', stop: null }),
        { status: 200, headers: cors },
      );
    }
    // Exact per-customer lookup by the stop's normalized matchKey — one getDoc,
    // immune to the name variants the token search can miss. Powers the stop
    // card's "Recent deliveries here" footer (desktop + mobile).
    if (matchKey) {
      const c = await getCustomerByMatchKey(TENANT, matchKey);
      return new Response(JSON.stringify({ ok: true, mode: 'matchKey', customers: c ? [c] : [] }), { status: 200, headers: cors });
    }
    if (name) {
      const customers = await queryCustomersByName(name, 25);
      return new Response(JSON.stringify({ ok: true, mode: 'name', customers }), { status: 200, headers: cors });
    }
    if (pro) {
      // Match both the raw token and the zero-padded-to-9 form NuVizz stores for
      // numeric PROs, then de-dupe by customer.
      const candidates = new Set<string>([pro]);
      if (/^[0-9]+$/.test(pro)) candidates.add(pro.padStart(9, '0'));
      const seen = new Set<string>();
      const customers: any[] = [];
      for (const c of candidates) {
        for (const row of await queryCustomersByPro(c, 25)) {
          const key = row.matchKey || row.name;
          if (seen.has(key)) continue;
          seen.add(key);
          customers.push(row);
        }
      }
      return new Response(JSON.stringify({ ok: true, mode: 'pro', customers }), { status: 200, headers: cors });
    }
    return new Response(JSON.stringify({ ok: false, reason: 'missing name or pro', customers: [] }), { status: 400, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'search failed', customers: [] }), { status: 500, headers: cors });
  }
};
