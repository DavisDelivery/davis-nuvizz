// lib/history-customers.mts
//
// Per-customer delivery-history ROLLUP — the source the mobile "search past PROs /
// customer history" feature reads. Built FROM the immutable history warehouse
// (history_days), never from a live NuVizz call, so a business-name search never
// touches NuVizz (it reads our own Firestore).
//
// Why a rollup and not the warehouse directly: the warehouse is partitioned by
// day (history_days/{tenant}__{date}/stops), so "this customer's last 20 PROs"
// would mean scanning many days. The rollup collapses that to ONE small doc per
// customer with the most-recent 20 {pro,date} — a single indexed lookup.
//
// Layout (flat, single-tenant so queries use single-field auto-indexes only —
// no composite index config required):
//   history_customers/{tenant}__{matchKey}
//     { match_key, tenant, name, name_lower, addr1, city, state, zip,
//       pros: [{pro, date}]  (newest first, max 20),
//       pro_index: [pro, …]  (the pro strings, for ARRAY_CONTAINS lookup),
//       last_date, updated_at }

import { getDoc, setDoc, runQuery } from './firestore.mts';
import { histDocId } from './history-store.mts';

export const CUSTOMERS_COLLECTION = 'history_customers';
export const MAX_PROS = 20;
const MAX_TOKEN_LEN = 15;   // cap each word's prefix length
const MAX_TOKENS = 80;      // cap tokens per customer (bounds doc size)

// PURE: word-prefix search tokens for a customer name. Firestore has no substring
// search, so we store every prefix (length ≥ 2) of every word in the name; an
// ARRAY_CONTAINS lookup on any of those tokens then matches a word ANYWHERE in
// the name — e.g. "locksmith" or "lock" both find "SOLID LOCKSMITH". Exported for
// tests.
export function nameSearchTokens(name: string): string[] {
  // Keep ALL non-empty words (including single letters) so an INITIALISM written with
  // spaces or periods — "E R SNELL", "E.R. SNELL" — can be re-joined below. The old
  // filter dropped single letters here, so "E.R." produced no "er" token and a search
  // for "er snell" found nothing though the customer (E R SNELL CONTRACTOR) was stored.
  const words = String(name || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const set = new Set<string>();
  const addPrefixes = (w: string) => {
    const cap = Math.min(w.length, MAX_TOKEN_LEN);
    for (let n = 2; n <= cap; n++) set.add(w.slice(0, n));
  };
  for (const w of words) {
    if (w.length >= 2) addPrefixes(w);
    if (set.size >= MAX_TOKENS) break;
  }
  // Collapse runs of consecutive single-letter words (initialisms) into one joined
  // token + its prefixes, so "E R SNELL" → "er"/"ersnell"-prefixes and a spaceless
  // "er" query matches. Periods already became spaces above, so "E.R." rides here too.
  let run: string[] = [];
  const flushRun = () => { if (run.length >= 2) addPrefixes(run.join('')); run = []; };
  for (const w of words) {
    if (w.length === 1) run.push(w); else flushRun();
    if (set.size >= MAX_TOKENS) break;
  }
  flushRun();
  return [...set].slice(0, MAX_TOKENS);
}

// PURE: split a search query into matchable words (length ≥ 2). Exported for tests.
export function queryWords(q: string): string[] {
  return String(q || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

// PURE: does a customer (by its stored name_tokens) match EVERY query word? Used
// to AND multi-word queries after the single ARRAY_CONTAINS anchor lookup.
// Exported for tests.
export function matchesAllWords(nameTokens: string[], words: string[]): boolean {
  if (!words.length) return false;
  const set = new Set(nameTokens || []);
  return words.every((w) => set.has(w));
}

// matchKey rides a Firestore doc-id path segment. Sanitize it (no-op for clean
// keys) so a slash/oversized key can never throw and silently drop a day's
// customer-history rollup. The raw match_key is kept as a field on the doc.
export function rollupId(tenant: string, matchKey: string): string {
  return `${tenant}__${histDocId(String(matchKey))}`;
}
export function rollupPath(tenant: string, matchKey: string): string {
  return `${CUSTOMERS_COLLECTION}/${rollupId(tenant, matchKey)}`;
}

// PURE: merge two {pro,date,driver?} lists into one, de-duped by pro (keeping the
// most recent date for a repeated pro), sorted newest-date first, capped at `max`.
// The `driver` (who delivered) rides along. On an EQUAL date a driver-bearing entry
// replaces a driverless one — this is what lets a warehouse backfill fill in the
// driver on already-stored driverless entries (same date → without this the
// first-seen driverless entry would win and the backfill would silently no-op).
// Exported for tests.
export function mergeProEntries(
  existing: Array<{ pro: string; date: string; driver?: string | null }> = [],
  incoming: Array<{ pro: string; date: string; driver?: string | null }> = [],
  max: number = MAX_PROS,
): Array<{ pro: string; date: string; driver: string | null }> {
  const byPro = new Map<string, { pro: string; date: string; driver: string | null }>();
  for (const e of [...existing, ...incoming]) {
    if (!e || !e.pro) continue;
    const pro = String(e.pro);
    const date = String(e.date || '');
    const driver = e.driver ?? null;
    const prev = byPro.get(pro);
    if (!prev || date > (prev.date || '') || (date === prev.date && !prev.driver && driver)) {
      byPro.set(pro, { pro, date, driver });
    }
  }
  return [...byPro.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, max);
}

// PURE: collapse one day's warehouse stop records into per-customer day rollups
// (this day only — caller merges with the stored rollup). Picks the latest
// identity (name/address) seen and gathers the day's {pro,date} entries.
// Exported for tests.
export function buildRollupsFromStops(stops: any[]): Map<string, any> {
  const out = new Map<string, any>();
  for (const s of stops || []) {
    const mk = s?.customerMatchKey;
    if (!mk) continue;
    const date = String(s?.date || '');
    let cur = out.get(mk);
    if (!cur) {
      cur = { match_key: mk, name: '', addr1: null, city: null, state: null, zip: null, last_date: '', pros: [] as any[] };
      out.set(mk, cur);
    }
    // Latest identity within the day (all same date here, last write wins).
    if (date >= cur.last_date) {
      cur.name = s?.businessName || cur.name || '';
      cur.addr1 = s?.addr1 ?? cur.addr1 ?? null;
      cur.city = s?.city ?? cur.city ?? null;
      cur.state = s?.state ?? cur.state ?? null;
      cur.zip = s?.zip ?? cur.zip ?? null;
      cur.last_date = date;
    }
    // Capture WHO DELIVERED this PRO. The warehouse stop carries the load's assigned
    // driver (driverName, human-readable; driverUserName is the stable id fallback).
    // Unplanned/no-driver stops store null — the UI shows a dash.
    if (s?.pro) cur.pros.push({ pro: String(s.pro), date, driver: s?.driverName ?? s?.driverUserName ?? null });
  }
  // Collapse same-day duplicate pros up front.
  for (const cur of out.values()) cur.pros = mergeProEntries([], cur.pros);
  return out;
}

// Read existing rollup → merge this day → write. Bounded concurrency. Returns
// how many customer docs were touched. `stops` are warehouse stop records (with
// customerMatchKey / pro / date / businessName / addr fields).
export async function updateCustomerRollupsForDay(
  tenant: string, _date: string, stops: any[], conc = 8,
): Promise<{ customers: number; written: number }> {
  const dayMap = buildRollupsFromStops(stops);
  const entries = [...dayMap.values()];
  let written = 0;
  let i = 0;
  const worker = async () => {
    while (i < entries.length) {
      const day = entries[i++];
      const mk = day.match_key;
      const existing = await getDoc(rollupPath(tenant, mk));
      const mergedPros = mergeProEntries(existing?.pros || [], day.pros);
      // Newer identity wins; otherwise keep what's stored.
      const useDayIdentity = !existing || (day.last_date || '') >= (existing.last_date || '');
      const name = (useDayIdentity ? day.name : existing.name) || existing?.name || day.name || '';
      const payload = {
        match_key: mk,
        tenant,
        name,
        name_lower: String(name).toLowerCase().trim(),
        name_tokens: nameSearchTokens(name),
        addr1: (useDayIdentity ? day.addr1 : existing.addr1) ?? existing?.addr1 ?? null,
        city: (useDayIdentity ? day.city : existing.city) ?? existing?.city ?? null,
        state: (useDayIdentity ? day.state : existing.state) ?? existing?.state ?? null,
        zip: (useDayIdentity ? day.zip : existing.zip) ?? existing?.zip ?? null,
        pros: mergedPros,
        pro_index: mergedPros.map((p) => p.pro),
        last_date: mergedPros[0]?.date || day.last_date || existing?.last_date || null,
        updated_at: new Date().toISOString(),
      };
      await setDoc(rollupPath(tenant, mk), payload);
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, entries.length || 1) }, worker));
  return { customers: entries.length, written };
}

// Trim a stored rollup to the client-facing shape.
function shapeCustomer(doc: any): any {
  return {
    matchKey: doc.match_key || doc._id || null,
    name: doc.name || '',
    addr1: doc.addr1 || null,
    city: doc.city || null,
    state: doc.state || null,
    zip: doc.zip || null,
    pros: Array.isArray(doc.pros) ? doc.pros : [],
  };
}

// Word-anywhere search: matches a query word against ANY word in the customer
// name (via the stored name_tokens prefix-grams), so "locksmith" finds "SOLID
// LOCKSMITH". Multi-word queries are AND-ed. Single ARRAY_CONTAINS on the longest
// word (automatic index, no composite needed) + an in-memory AND post-filter.
// A sub-2-char query falls back to a name_lower prefix range.
export async function queryCustomersByName(qLower: string, limit = 25): Promise<any[]> {
  const words = queryWords(qLower);
  if (!words.length) return queryCustomersByNamePrefix(qLower, limit);
  const anchor = words.reduce((a, b) => (b.length > a.length ? b : a), words[0]);
  const rows = await runQuery({
    from: [{ collectionId: CUSTOMERS_COLLECTION }],
    where: { fieldFilter: { field: { fieldPath: 'name_tokens' }, op: 'ARRAY_CONTAINS', value: { stringValue: anchor } } },
    limit: Math.max(limit * 4, 60),
  });
  // AND-filter each candidate against tokens RECOMPUTED from its stored name (not the
  // stored name_tokens): docs written before the initialism fix lack the joined "er"
  // token, so "er snell" would still drop "E R SNELL CONTRACTOR" until a rebuild. The
  // anchor (longest query word, e.g. "snell") already matched the stored tokens above,
  // so recomputing here recovers the abbreviation word with no rebuild required.
  return rows
    .filter((r) => matchesAllWords(nameSearchTokens(r.name || ''), words))
    .slice(0, limit)
    .map(shapeCustomer);
}

// Fallback for ultra-short (1-char) queries: name_lower prefix range. Single
// field → automatic index, no composite index needed.
async function queryCustomersByNamePrefix(qLower: string, limit = 25): Promise<any[]> {
  const q = String(qLower || '').toLowerCase().trim();
  if (!q) return [];
  const end = q + '';
  const rows = await runQuery({
    from: [{ collectionId: CUSTOMERS_COLLECTION }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'name_lower' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: q } } },
      { fieldFilter: { field: { fieldPath: 'name_lower' }, op: 'LESS_THAN', value: { stringValue: end } } },
    ] } },
    orderBy: [{ field: { fieldPath: 'name_lower' }, direction: 'ASCENDING' }],
    limit,
  });
  return rows.map(shapeCustomer);
}

// ARRAY_CONTAINS lookup on pro_index. Single field → automatic index.
export async function queryCustomersByPro(pro: string, limit = 25): Promise<any[]> {
  const p = String(pro || '').trim();
  if (!p) return [];
  const rows = await runQuery({
    from: [{ collectionId: CUSTOMERS_COLLECTION }],
    where: { fieldFilter: { field: { fieldPath: 'pro_index' }, op: 'ARRAY_CONTAINS', value: { stringValue: p } } },
    limit,
  });
  return rows.map(shapeCustomer);
}
