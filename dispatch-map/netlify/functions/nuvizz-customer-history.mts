// nuvizz-customer-history.mts
//
// Read-only history search for the mobile "search past PROs / customer history"
// button. Reads OUR OWN per-customer rollup (history_customers, built nightly
// from the immutable warehouse) — it NEVER calls NuVizz. So a business-name
// search costs nothing at NuVizz; it's a single indexed Firestore lookup.
//
//   GET ?name=<business name>   → customers whose name starts with the query,
//                                 each with their last 20 {pro,date}
//   GET ?pro=<pro number>       → the customer + delivery day for that PRO, resolved
//                                 through the PRO→day pointer index (history_pros),
//                                 which covers EVERY captured order rather than only
//                                 a customer's most recent 20. Falls back to the old
//                                 last-20 scan for days indexed before the backfill.
import { isFirestoreEnabled } from './lib/firestore.mts';
import { queryCustomersByName, queryCustomersByPro, getCustomerByMatchKey } from './lib/history-customers.mts';
import { lookupProDays, proIndexEnabled } from './lib/history-pro-index.mts';
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
      const seen = new Set<string>();
      const customers: any[] = [];
      const take = (row: any) => {
        // Keyed by customer, but a pointer whose stop carried no customer key and no
        // business name must still reach the screen — it falls back to the PRO itself
        // rather than being silently dropped as an empty key.
        const key = row.matchKey || row.name || row.hitPro;
        if (!key || seen.has(key)) return null;
        seen.add(key);
        customers.push(row);
        return row;
      };
      // PRIMARY: the PRO → day pointer index. Two doc reads at most, no scan, and it
      // covers every order we have ever captured — which the per-customer rollup does
      // NOT: that one holds a customer's most recent 20 PROs, so a week-old order to a
      // busy customer had already fallen off it and the screen offered to spend a
      // NuVizz call on an order sitting in our own warehouse (Chad, 2026-09-15).
      if (proIndexEnabled()) {
        for (const hit of await lookupProDays(TENANT, pro)) {
          const c = hit.matchKey ? await getCustomerByMatchKey(TENANT, hit.matchKey) : null;
          // The hit rides FIRST in `pros` so the screen opens the PRO that was searched
          // for, not whatever this customer's newest delivery happens to be — and
          // hitPro/hitDate say so, rather than the card claiming "most recent delivery".
          const rest = (c?.pros || []).filter((p: any) => !(p?.pro === hit.pro && p?.date === hit.date));
          const merged = [{ pro: hit.pro, date: hit.date, driver: (c?.pros || []).find((p: any) => p?.pro === hit.pro && p?.date === hit.date)?.driver ?? null }, ...rest];
          take({
            matchKey: hit.matchKey || c?.matchKey || null,
            name: c?.name || hit.name || hit.pro,
            addr1: c?.addr1 ?? null, city: c?.city ?? null, state: c?.state ?? null, zip: c?.zip ?? null,
            pros: merged,
            hitPro: hit.pro, hitDate: hit.date,
          });
        }
      }
      // FALLBACK: the pre-index last-20 scan. Still matches days captured before the
      // backfill ran, and is the whole answer when PRO_INDEX=off.
      const candidates = new Set<string>([pro]);
      if (/^[0-9]+$/.test(pro)) candidates.add(pro.padStart(9, '0'));
      for (const c of candidates) for (const row of await queryCustomersByPro(c, 25)) take(row);
      return new Response(JSON.stringify({ ok: true, mode: 'pro', indexed: proIndexEnabled(), customers }), { status: 200, headers: cors });
    }
    return new Response(JSON.stringify({ ok: false, reason: 'missing name or pro', customers: [] }), { status: 400, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'search failed', customers: [] }), { status: 500, headers: cors });
  }
};
