// lib/history-pro-index.mts
//
// PRO → DELIVERY DAY POINTER. The index that makes EVERY order we have ever
// captured findable by its PRO number, for ever, with one Firestore read and
// ZERO NuVizz calls.
//
// WHY IT EXISTS (Chad, 2026-09-15, searching a week-old PRO): "this order is a
// week old why is it not in the history? we should be keeping all orders in
// history it shouldn't be asking for a nuvizz call here." He was right, and the
// warehouse was never the problem — history_days keeps every stop of every
// captured day and never prunes. The SEARCH was the problem: the only PRO-
// searchable structure was `pro_index` on the per-customer rollup
// (history_customers), and that array is the customer's most recent MAX_PROS
// (20) deliveries. PRO 21 and older dropped out of the index while the full
// stop record sat in the warehouse untouched — so the screen said "nothing in
// saved history" and offered to spend a NuVizz call on an order we already had.
//
// The warehouse cannot answer a bare PRO on its own because it is partitioned by
// DAY (history_days/{tenant}__{date}/stops/{stopNbr}) — resolving a PRO without
// its date would mean scanning every day. This index is the missing pointer:
// one tiny document per PRO saying which day (or days) it was on. Unbounded by
// how many times a customer has been delivered since.
//
// Layout (flat, single-tenant — doc-id lookups only, no query and no index config):
//   history_pros/{tenant}__{key}
//     { key, tenant, pro, days: [{date, pro, matchKey, name}] (newest first,
//       max MAX_DAYS_PER_PRO), last_date, updated_at }
//
// Firestore-only. Written by the post-seal hook block (history-postseal) for each
// captured day and backfilled over past days by
// nuvizz-rebuild-customer-history-background. NEVER calls NuVizz.
import { getDoc, setDoc, createDocIfAbsent } from './firestore.mts';
import { histDocId } from './history-store.mts';

export const PRO_INDEX_COLLECTION = 'history_pros';
// A PRO lands on more than one day when a delivery is attempted and redelivered.
// Keeping a dozen is far more than any real order sees and bounds the doc.
export const MAX_DAYS_PER_PRO = 12;

/**
 * KILL SWITCH — PRO_INDEX=off reverts every side of this feature at once: the
 * post-seal write, the backfill write, and the customer-history read (which falls
 * back to the old last-20 `pro_index` scan). One switch so there is no half-
 * reverted state where the screen asks for a pointer nothing writes.
 *
 * Default ON, and anything that is not an explicit off-word leaves it ON: a typo
 * in an env var must never silently put PRO search back to spending a NuVizz call
 * on an order we already hold.
 */
export function proIndexEnabled(env: any = process.env): boolean {
  const v = String(env?.PRO_INDEX ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

// PURE: drop a board SEGMENT SUFFIX. The board's stopNbr is often "007157687-1" —
// the 9-digit PRO plus a segment number — while a dispatcher types the bare PRO.
// Deliberately narrow (the same rule manifest-reconcile.proKeys uses): only a 1-2
// digit tail after a FULL 9-digit group, so an Estes-style "028-8347656", where the
// dash is formatting inside a 10-digit PRO, is left alone.
function stripSegment(raw: string): string {
  const m = /^(\d{9})-(\d{1,2})$/.exec(raw);
  return m ? m[1] : raw;
}

/**
 * PURE: the index key(s) for one PRO. The SAME function keys the write and the
 * read, so anything we stored is findable by anything a dispatcher can type.
 * Exported for tests.
 *
 *   "007175119" / "7175119" / "0007175119"  → ["n_7175119"]      (padding collapsed)
 *   "007157687-1"                           → ["n_7157687"]      (segment stripped)
 *   "RA5732712"                             → ["n_5732712", "r_RA5732712"]
 *   "AVRT-0170416694"                       → ["n_170416694", "r_AVRT-0170416694"]
 *
 * The numeric key strips EVERY leading zero so the nine padding variants of one PRO
 * are one key — the padStart(9)-only rule the old lookup used missed a 10-digit PRO
 * and missed the segment suffix entirely. The raw key keeps a carrier-prefixed PRO
 * findable by the whole string; it is upper-cased so a lower-case search still hits.
 *
 * NOT collapsed to a bare carrier token: "AVRT-0028093763" keeps its full digit run,
 * so it can never be read as a sibling of "ESTES-0538243875" (the phantom-instance
 * miscount CLAUDE.md records). Each stored day entry also carries its EXACT `pro`,
 * so even if two carriers' PROs ever shared a digit run the reader opens the right
 * stop rather than guessing.
 */
export function proIndexKeys(pro: any): string[] {
  const raw = stripSegment(String(pro ?? '').trim());
  if (!raw) return [];
  const out: string[] = [];
  const add = (k: string) => { const s = histDocId(k); if (s && !out.includes(s)) out.push(s); };
  const digits = raw.replace(/\D/g, '');
  // >= 6 digits: a short token ("12", "1-2") must not mint a key that swallows
  // unrelated orders. Every real PRO on this board is 7 digits or more.
  if (digits.length >= 6) add('n_' + (digits.replace(/^0+/, '') || '0'));
  if (!/^\d+$/.test(raw)) add('r_' + raw.toUpperCase());
  return out;
}

export function proIndexPath(tenant: string, key: string): string {
  return `${PRO_INDEX_COLLECTION}/${tenant}__${histDocId(key)}`;
}

export interface ProDayEntry { date: string; pro: string; matchKey: string | null; name: string | null }

// PURE: merge two day-entry lists, de-duped by day+pro, newest day first, capped.
// Exported for tests.
export function mergeDayEntries(
  existing: ProDayEntry[] = [], incoming: ProDayEntry[] = [], max: number = MAX_DAYS_PER_PRO,
): ProDayEntry[] {
  const byKey = new Map<string, ProDayEntry>();
  for (const e of [...existing, ...incoming]) {
    if (!e || !e.date || !e.pro) continue;
    const k = `${e.date}|${e.pro}`;
    const prev = byKey.get(k);
    // A later pass may have learned the customer key/name an earlier entry lacked.
    if (!prev || (!prev.matchKey && e.matchKey)) {
      byKey.set(k, { date: String(e.date), pro: String(e.pro), matchKey: e.matchKey ?? null, name: e.name ?? null });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, max);
}

/**
 * PURE: one day's warehouse stops → the pointer documents that day contributes,
 * as key → entry. A stop with a carrier-prefixed PRO contributes TWO keys (numeric
 * and raw) pointing at the same delivery. First writer wins within a day, so a
 * digit-run collision cannot silently swap one stop's pointer for another's.
 * Exported for tests.
 */
export function buildProIndexForDay(stops: any[], date: string): Map<string, ProDayEntry> {
  const out = new Map<string, ProDayEntry>();
  for (const s of stops || []) {
    const pro = s?.pro ?? s?.stopNbr;
    if (!pro) continue;
    const entry: ProDayEntry = {
      date: String(s?.date || date || ''),
      pro: String(pro),
      matchKey: s?.customerMatchKey ?? null,
      name: s?.businessName ?? null,
    };
    if (!entry.date) continue;
    for (const key of proIndexKeys(pro)) if (!out.has(key)) out.set(key, entry);
  }
  return out;
}

/**
 * Write one day's pointers. Bounded concurrency, and the COMMON case costs ONE
 * Firestore op: a PRO is delivered once, so createDocIfAbsent lands the pointer
 * outright and we never read. Only a PRO that has been here before (an attempt,
 * then the redelivery) pays the read-merge-write, and it is that merge that keeps
 * BOTH days rather than letting the newer capture blind-write the older one away.
 *
 * Never prunes and never rewrites another day's entry — the warehouse is the source
 * of truth and this whole index can be rebuilt from it at any time.
 */
export async function updateProIndexForDay(
  tenant: string, date: string, stops: any[], conc = 16,
  io: {
    getDoc: (p: string) => Promise<any | null>;
    setDoc: (p: string, d: any) => Promise<boolean>;
    createDocIfAbsent: (p: string, d: any) => Promise<boolean>;
  } = { getDoc, setDoc, createDocIfAbsent },
): Promise<{ keys: number; created: number; merged: number }> {
  const dayMap = buildProIndexForDay(stops, date);
  const entries = [...dayMap.entries()];
  let created = 0;
  let merged = 0;
  let i = 0;
  const worker = async () => {
    while (i < entries.length) {
      const [key, entry] = entries[i++];
      const path = proIndexPath(tenant, key);
      const base = {
        key, tenant, pro: entry.pro,
        days: [entry],
        last_date: entry.date,
        updated_at: new Date().toISOString(),
      };
      if (await io.createDocIfAbsent(path, base)) { created++; continue; }
      const existing = await io.getDoc(path);
      const days = mergeDayEntries(existing?.days || [], [entry]);
      await io.setDoc(path, {
        key, tenant,
        pro: days[0]?.pro || entry.pro,
        days,
        last_date: days[0]?.date || entry.date,
        updated_at: new Date().toISOString(),
      });
      merged++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, entries.length || 1) }, worker));
  return { keys: entries.length, created, merged };
}

/**
 * Resolve a typed PRO to the day(s) it was delivered on — at most TWO doc reads,
 * no query, no scan, and no NuVizz call. Newest day first. Empty when we have
 * never captured that PRO (a genuinely new order, or a day older than the
 * warehouse), which is the ONE case where spending a NuVizz call is the right
 * answer. getDoc is injectable so the reader is unit-testable without Firestore.
 */
export async function lookupProDays(
  tenant: string, pro: string,
  io: { getDoc: (p: string) => Promise<any | null> } = { getDoc },
): Promise<ProDayEntry[]> {
  const keys = proIndexKeys(pro);
  if (!keys.length) return [];
  const found: ProDayEntry[] = [];
  for (const key of keys) {
    const doc = await io.getDoc(proIndexPath(tenant, key)).catch(() => null);
    if (Array.isArray(doc?.days)) found.push(...doc.days);
  }
  return mergeDayEntries(found, []);
}
