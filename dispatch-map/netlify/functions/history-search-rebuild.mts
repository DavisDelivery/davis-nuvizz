// history-search-rebuild.mts — BUILD THE ADDRESS/CITY SEARCH DIGEST FOR DAYS ALREADY SEALED.
//
// The nightly post-seal hook (history-postseal.mts → stop-search) writes one digest per day from
// the night it ships onward. Every day sealed BEFORE that has none, and "all dates" on the Stop
// lookup screen would quietly mean "since this deploy" — so this derives them from the warehouse.
// Also the repair tool: a day whose hook failed is re-derived here.
//
//   GET ?missing=1                  every sealed day with no digest, oldest first
//   GET ?from=YYYY-MM-DD&to=…       every sealed day in the span, rebuilt even if indexed
//   GET ?date=YYYY-MM-DD            one sealed day
//   …&dry=1                         the PLAN only — which days it would build, and why
//   → { ok, nuvizzCalls: 0, dry, planned, built, failed, remaining, alreadyIndexed, sealed }
//
// AT MOST 10 DAYS A CALL, and `remaining` says how many are left — call it again until 0. Each day
// is one masked read of that day's stops (~535 documents) and one write; ten fit the 26 seconds
// with room, a hundred would not. SYNCHRONOUS ON PURPOSE: a background function's response is
// thrown away by the platform (lib/background-gate.mts), so a backfill run that way can only be
// checked afterwards by reading what it left behind. This one says what it did, per day, in its
// own answer — and `dry=1` says what it WOULD do without doing it (CLAUDE.md: make it inspectable).
//
// SAFE TO OVERLAP AND TO REPEAT. Every write is a whole-document replace derived from immutable
// sealed stops, so two runs over the same day write the same bytes. No lock is needed, unlike the
// customer-history backfill, whose merges can lose an update.
//
// Firestore only. ZERO NuVizz calls. Gated at admin: it rewrites a whole collection.

import { isFirestoreEnabled } from './lib/firestore.mts';
import { listStops } from './lib/history-store.mts';
import { CUSTOMER_STOP_FIELDS } from './lib/board-fields.mts';
import { requireUser, jsonResponse } from './lib/require-user.mts';
import {
  stopSearchEnabled, writeSearchDigest, readSealedDays, readDigestDates,
} from './lib/stop-search-store.mts';
import { isDateStr } from '../../src/lib/history-range.js';

const TENANT = 'davis';
export const REBUILD_MAX_DAYS = 10;
const CONCURRENCY = 3;

/**
 * PURE: which days this call builds.
 *
 *   missing — sealed days with no digest, OLDEST FIRST, so repeated calls walk forward and a
 *             half-finished backfill leaves a contiguous, describable gap at the recent end
 *             (which the nightly hook has been filling anyway).
 *   span    — every sealed day asked for, indexed or not: an explicit request to redo them.
 *   date    — one day, which must be sealed; an unsealed day has no end-of-night record to
 *             index, and indexing a half-captured one would make a search answer from it.
 */
export function rebuildPlan(
  { mode, sealed, indexed, date = null, max = REBUILD_MAX_DAYS }:
  { mode: 'missing' | 'span' | 'date'; sealed: string[]; indexed: string[]; date?: string | null; max?: number },
): { dates: string[]; remaining: number; alreadyIndexed: number; next: string | null; refusal: string | null } {
  const have = new Set(indexed || []);
  const days = [...new Set(sealed || [])].filter(isDateStr).sort();
  if (mode === 'date') {
    if (!date || !isDateStr(date)) return { dates: [], remaining: 0, alreadyIndexed: 0, next: null, refusal: 'date must be YYYY-MM-DD' };
    if (!days.includes(date)) return { dates: [], remaining: 0, alreadyIndexed: 0, next: null, refusal: `${date} has no sealed manifest — nothing to index` };
    return { dates: [date], remaining: 0, alreadyIndexed: have.has(date) ? 1 : 0, next: null, refusal: null };
  }
  const todo = mode === 'missing' ? days.filter((d) => !have.has(d)) : days;
  const cap = Math.max(1, Math.floor(Number(max)) || REBUILD_MAX_DAYS);
  return {
    dates: todo.slice(0, cap),
    remaining: Math.max(0, todo.length - cap),
    alreadyIndexed: days.filter((d) => have.has(d)).length,
    // Where a SPAN resumes: pass it as `from` on the next call. A `missing` caller needs nothing —
    // what this call builds stops being missing, so the next call starts past it by itself.
    next: todo.length > cap ? todo[cap] : null,
    refusal: null,
  };
}

export default async (req: Request): Promise<Response> => {
  const gate = await requireUser(req, { role: 'admin' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return jsonResponse({ ok: false, error: 'Firestore off — there is nothing to index' }, 500);
  if (!stopSearchEnabled()) {
    return jsonResponse({ ok: false, nuvizzCalls: 0, switchedOff: true, error: 'STOP_SEARCH=off — the address/city search index is switched off, so nothing is built' }, 409);
  }

  const url = new URL(req.url);
  const get = (k: string) => (url.searchParams.get(k) || '').trim();
  const dry = ['1', 'true', 'yes'].includes(get('dry').toLowerCase());
  const date = get('date');
  const from = get('from') || null;
  const to = get('to') || null;
  const mode: 'missing' | 'span' | 'date' = date ? 'date' : (from || to) ? 'span' : get('missing') ? 'missing' : 'missing';
  if ((from && !isDateStr(from)) || (to && !isDateStr(to))) return jsonResponse({ ok: false, error: 'from/to must be YYYY-MM-DD' }, 400);

  const lo = mode === 'date' ? date : from;
  const hi = mode === 'date' ? date : to;
  let sealed: string[];
  let indexed: string[];
  try {
    [sealed, indexed] = await Promise.all([readSealedDays(TENANT, lo, hi), readDigestDates(TENANT, lo, hi)]);
  } catch (e: any) {
    return jsonResponse({ ok: false, nuvizzCalls: 0, error: `could not read the warehouse to plan: ${e?.message || e}` }, 500);
  }
  const plan = rebuildPlan({ mode, sealed, indexed, date: mode === 'date' ? date : null });
  const base = { nuvizzCalls: 0, dry, mode, sealed: sealed.length, alreadyIndexed: plan.alreadyIndexed, planned: plan.dates, remaining: plan.remaining, next: plan.next };
  if (plan.refusal) return jsonResponse({ ok: false, ...base, error: plan.refusal }, 400);
  if (dry) return jsonResponse({ ok: true, ...base, built: [], failed: [] });

  const built: any[] = [];
  const failed: any[] = [];
  for (let i = 0; i < plan.dates.length; i += CONCURRENCY) {
    await Promise.all(plan.dates.slice(i, i + CONCURRENCY).map(async (d) => {
      const t0 = Date.now();
      try {
        // The SAME mask the customer view sweeps with — it carries every field the digest reads,
        // and test/stop-search.test.mjs pins that, so this and the nightly hook (which is handed
        // the full records) write identical rows.
        const stops = await listStops(TENANT, d, { mask: CUSTOMER_STOP_FIELDS });
        const r = await writeSearchDigest(TENANT, d, stops);
        built.push({ date: d, ...r, ms: Date.now() - t0 });
      } catch (e: any) {
        failed.push({ date: d, error: e?.message || String(e), ms: Date.now() - t0 });
      }
    }));
  }
  built.sort((a, b) => (a.date < b.date ? -1 : 1));
  failed.sort((a, b) => (a.date < b.date ? -1 : 1));
  // `remaining` counts what this call did NOT attempt; a failed day is still missing, and a
  // `missing=1` caller that loops will meet it again next call rather than skip past it.
  return jsonResponse({ ok: failed.length === 0, ...base, built, failed, remaining: plan.remaining + failed.length });
};
