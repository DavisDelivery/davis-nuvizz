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

// EXACT per-customer lookup by matchKey — one getDoc on the rollup, no name
// search involved. This is how the stop card's history footer resolves its
// customer: the board stop already carries the normalized matchKey, and the
// name-token search can miss variants the key matches exactly. Null when the
// customer has no rollup (a genuine first-time customer).
export async function getCustomerByMatchKey(tenant: string, matchKey: string): Promise<any | null> {
  const mk = String(matchKey || '').trim();
  if (!mk) return null;
  const doc = await getDoc(rollupPath(tenant, mk));
  return doc ? shapeCustomer(doc) : null;
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


// ── THE MONTHLY TALLY — how "This year" is answerable at all ─────────────────
//
// Chad, 2026-09-19: "I want there to be a this year button in the date ranges."
//
// WHY IT CANNOT BE A SWEEP. The Stop lookup customer view answers a window by reading a
// WHOLE BOARD per day, twice over (the live index and the sealed warehouse), and keeping the
// handful of stops that match one name. That is ~1,400 document reads per day of window. A
// year is ~510,000 reads: it would not finish inside the function's 26 seconds, and nobody
// waits that long with a customer on the phone.
//
// So the year is PAID FOR ONCE, AT WRITE TIME. This rollup is already visited for every
// customer of every sealed day by the nightly post-seal hook; counting four numbers per month
// while it is there costs nothing and turns "how much have we done for them this year" into
// ONE document read.
//
// WHAT IS COUNTED, and why these four. `stops` is visits, `delivered` is the ones that closed
// out — never the same number, and a screen that conflates them tells a customer we delivered
// freight that came back. `attempted` and `exceptions` are the two ways it did not, kept apart
// because one is a redelivery and the other is a refusal.
//
// AND THE HONEST PART: `months_from`. A tally that has not been backfilled is INDISTINGUISHABLE
// from a customer we never delivered to, and "0 deliveries this year" is a sentence a rep says
// out loud. So the document records the earliest day the tally has actually counted, and the
// screen refuses to report a total for any month before it. Backfill with
// nuvizz-rebuild-customer-history-background (?from=&to=), a month at a time.

/** PURE: the YYYY-MM a day belongs to. */
export const monthOf = (date: string): string => String(date || '').slice(0, 7);

/** PURE: an empty month bucket. Exported so a reader can tell "counted, zero" from "absent". */
export const emptyMonth = () => ({ stops: 0, delivered: 0, attempted: 0, exceptions: 0 });

/**
 * PURE: which bucket one sealed stop falls in. The warehouse record is the end-of-night
 * truth, so its normalizedStatus is final — unlike a live board row, which can still move.
 */
export function tallyBucket(s: any): 'delivered' | 'attempted' | 'exceptions' | null {
  const st = String(s?.normalizedStatus ?? '').toUpperCase();
  if (st === 'DELIVERED') return 'delivered';
  if (st === 'EXCEPTION' || st === 'CANCELLED') return 'exceptions';
  // The ATT marker lands on the SHIPMENT number, never on stopNbr (lib/nuvizz-scan.mts
  // isAttemptShipment) — so this is the same signal the attempts feature keys on.
  if (s?.isAttempt === true || /^ATT/i.test(String(s?.shipmentNbr ?? ''))) return 'attempted';
  return null;
}

/**
 * PURE: merge stored month buckets with a day's. ADDITIVE, and that is the whole hazard:
 * re-running a day would double-count it. The nightly hook runs a day once, but the backfill
 * is documented as "safely re-runnable" and overlapping ranges are expected — so each month
 * carries the set of DAYS it has counted, and a day already counted is skipped rather than
 * added again. Idempotent, which is what makes a re-run cost time and nothing else.
 */
export function mergeMonthTallies(existing: any, incoming: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [m, v] of Object.entries(existing || {})) {
    const b: any = v || {};
    out[m] = { ...emptyMonth(), ...b, days: Array.isArray(b.days) ? [...b.days] : [] };
  }
  for (const [m, v] of Object.entries(incoming || {})) {
    const inc: any = v || {};
    const cur = out[m] || { ...emptyMonth(), days: [] as string[] };
    for (const day of (inc.days || [])) {
      if (cur.days.includes(day)) continue;          // already counted — a re-run is a no-op
      cur.days.push(day);
      const d: any = inc.byDay?.[day] || {};
      cur.stops += d.stops || 0;
      cur.delivered += d.delivered || 0;
      cur.attempted += d.attempted || 0;
      cur.exceptions += d.exceptions || 0;
    }
    cur.days.sort();
    out[m] = cur;
  }
  return out;
}

/** PURE: every day any month bucket has already counted. ONE day set governs both tallies —
 *  see mergeDriverTallies for what happened when only the months had one. */
export function countedDaysOf(months: any): Set<string> {
  const out = new Set<string>();
  for (const b of Object.values(months || {})) for (const d of ((b as any)?.days || [])) out.add(String(d));
  return out;
}

/**
 * PURE: merge a day-keyed driver tally into the stored one, SKIPPING days already counted.
 *
 * THE BUG THIS SHAPE EXISTS TO PREVENT, caught by its own test before it shipped: the first
 * cut took a flat {driver: {stops, delivered}} and added it unconditionally. The months were
 * idempotent (they carry the days they counted) and this was not — so re-running the backfill
 * over a day left the month totals correct and DOUBLED the driver totals. Two halves of one
 * screen disagreeing about the same freight is worse than both being wrong, because the one
 * that is right makes the other look credible.
 *
 * So the day set is the single rule, and it lives on the months: this is only ever asked to
 * add a day the months accepted.
 */
export function mergeDriverTallies(existing: any, incomingByDay: any, counted: Set<string> = new Set(), max = 40): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [d, v] of Object.entries(existing || {})) {
    const b: any = v || {};
    out[d] = { stops: b.stops || 0, delivered: b.delivered || 0 };
  }
  for (const [day, byDriver] of Object.entries(incomingByDay || {})) {
    if (counted.has(String(day))) continue;          // already counted — a re-run is a no-op
    for (const [driver, v] of Object.entries((byDriver as any) || {})) {
      const b: any = v || {};
      const cur = out[driver] || { stops: 0, delivered: 0 };
      cur.stops += b.stops || 0;
      cur.delivered += b.delivered || 0;
      out[driver] = cur;
    }
  }
  // Bounded: a customer served by every driver we have is still a small map, but the document
  // must not grow without limit over years of turnover. Busiest kept.
  const kept = Object.entries(out)
    .sort((a, b) => b[1].stops - a[1].stops || a[0].localeCompare(b[0]))
    .slice(0, max);
  return Object.fromEntries(kept);
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
      cur = { match_key: mk, name: '', addr1: null, city: null, state: null, zip: null, last_date: '', pros: [] as any[], months: {} as any, driversByDay: {} as any };
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

    // ── the day's contribution to the monthly tally ───────────────────────────
    //
    // Counted per DAY inside the month bucket, because the merge upstream needs to know which
    // days it has already added — the backfill is re-runnable by design and an additive
    // counter with no day set would double a month every time somebody re-ran a range.
    if (date) {
      const m = monthOf(date);
      cur.months ||= {};
      const bucket = (cur.months[m] ||= { days: [] as string[], byDay: {} as Record<string, any> });
      if (!bucket.days.includes(date)) { bucket.days.push(date); bucket.byDay[date] = { ...emptyMonth() }; }
      const d = bucket.byDay[date];
      d.stops += 1;
      const b = tallyBucket(s);
      if (b) d[b] += 1;

      // BY DAY, exactly as the months are, so one day-set rule governs both.
      const driver = String(s?.driverName ?? s?.driverUserName ?? '').trim();
      if (driver) {
        cur.driversByDay ||= {};
        const dayMap = (cur.driversByDay[date] ||= {});
        const dt = (dayMap[driver] ||= { stops: 0, delivered: 0 });
        dt.stops += 1;
        if (b === 'delivered') dt.delivered += 1;
      }
    }
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
      // MERGED, NEVER REPLACED. setDoc below rewrites the whole document, so anything not
      // carried forward here is deleted — CLAUDE.md's "never blind-write a document you do
      // not own", arriving from the inside: this writer DOES own the document, and a field
      // it forgets to re-state is a year of counts gone on the next nightly run.
      // The days the STORED tally has already counted, read BEFORE the months are merged —
      // that set is what makes both halves skip a re-run identically.
      const alreadyCounted = countedDaysOf(existing?.months);
      const mergedMonths = mergeMonthTallies(existing?.months, day.months);
      const mergedDrivers = mergeDriverTallies(existing?.drivers, day.driversByDay, alreadyCounted);
      // The earliest day the tally has actually counted. A screen must never report a total
      // for a month before this — an un-backfilled month and a month we did not deliver in
      // are the same zero otherwise, and "0 deliveries this year" gets said to a customer.
      const countedDays = Object.values(mergedMonths).flatMap((b: any) => b.days || []);
      const monthsFrom = countedDays.length ? countedDays.reduce((a, b) => (a < b ? a : b)) : null;
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
        months: mergedMonths,
        drivers: mergedDrivers,
        months_from: monthsFrom,
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
    // The year answer. `monthsFrom` is null on a rollup written before this shipped, which is
    // the signal the reader needs: the counts are ABSENT, not zero.
    months: doc.months && typeof doc.months === 'object' ? doc.months : null,
    drivers: doc.drivers && typeof doc.drivers === 'object' ? doc.drivers : null,
    monthsFrom: doc.months_from || null,
    lastDate: doc.last_date || null,
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
