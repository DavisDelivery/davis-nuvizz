// stop-pace-rebuild.mts — BUILD THE PACE DIGEST FOR DAYS ALREADY SEALED.
//
// The nightly post-seal hook (history-postseal.mts → stop-pace) writes one digest per day from
// the night it ships onward. Every day sealed BEFORE that has none, so the Performance screen's
// "typical Tuesday" would have nothing to be typical of — this derives them from the warehouse.
// Also the repair tool: a day whose hook failed is re-derived here.
//
//   GET ?missing=1                  every sealed day with no digest, oldest first
//   GET ?from=YYYY-MM-DD&to=…       every sealed day in the span, rebuilt even if built
//   GET ?date=YYYY-MM-DD            one sealed day
//   …&dry=1                         the PLAN only — which days it would build, and why
//   → { ok, nuvizzCalls: 0, dry, planned, built, failed, remaining, alreadyBuilt, sealed }
//
// AT MOST 10 DAYS A CALL, and `remaining` says how many are left — call it again until 0. The
// Performance screen's History card ("Build all … now") does exactly that, one call at a time,
// and shows the count going down. Each day is one masked read of that day's stops and one write —
// the same shape of work as history-search-rebuild, whose ten-a-call budget this copies (that file
// sizes a day at ~535 documents). A call cut off by the platform's time limit loses only its
// answer: every day it wrote is one whole-document write and stays written, and the rest are still
// listed as missing for the next call. SYNCHRONOUS ON PURPOSE, for the
// reason history-search-rebuild gives: a background function's response is thrown away by the
// platform, so a backfill run that way can only be checked afterwards by reading what it left
// behind. This one says what it did, per day, in its own answer — and `dry=1` says what it WOULD
// do without doing it (CLAUDE.md: make it inspectable).
//
// SAFE TO OVERLAP AND TO REPEAT. Every write is a whole-document replace derived from immutable
// sealed stops, so two runs over the same day write the same totals and the same curve.
//
// Firestore only. ZERO NuVizz calls. Gated at admin: it writes a whole collection.

import { isFirestoreEnabled } from './lib/firestore.mts';
import { listStops } from './lib/history-store.mts';
import { requireUser, jsonResponse } from './lib/require-user.mts';
import { readSealedDays } from './lib/stop-search-store.mts';
import { PACE_STOP_FIELDS } from './lib/stop-pace.mts';
import { stopPaceEnabled, writePaceDigest, readPaceDates } from './lib/stop-pace-store.mts';
// The same plan the address/city search backfill uses — missing oldest-first, an explicit span,
// or one sealed day — so the two backfills behave identically and one test pins both.
import { rebuildPlan } from './history-search-rebuild.mts';
import { isDateStr } from '../../src/lib/history-range.js';

const TENANT = 'davis';
export const PACE_REBUILD_MAX_DAYS = 10;
const CONCURRENCY = 3;

export default async (req: Request): Promise<Response> => {
  const gate = await requireUser(req, { role: 'admin' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return jsonResponse({ ok: false, nuvizzCalls: 0, error: 'Firestore off — there is nothing to build from' }, 500);
  if (!stopPaceEnabled()) {
    return jsonResponse({ ok: false, nuvizzCalls: 0, switchedOff: true, error: 'STOP_PACE=off — the pace digest is switched off, so nothing is built' }, 409);
  }

  const url = new URL(req.url);
  const get = (k: string) => (url.searchParams.get(k) || '').trim();
  const dry = ['1', 'true', 'yes'].includes(get('dry').toLowerCase());
  const date = get('date');
  const from = get('from') || null;
  const to = get('to') || null;
  const mode: 'missing' | 'span' | 'date' = date ? 'date' : (from || to) ? 'span' : 'missing';
  if ((from && !isDateStr(from)) || (to && !isDateStr(to))) return jsonResponse({ ok: false, nuvizzCalls: 0, error: 'from/to must be YYYY-MM-DD' }, 400);

  const lo = mode === 'date' ? date : from;
  const hi = mode === 'date' ? date : to;
  let sealed: string[];
  let built: string[];
  try {
    [sealed, built] = await Promise.all([readSealedDays(TENANT, lo, hi), readPaceDates(TENANT, lo, hi)]);
  } catch (e: any) {
    return jsonResponse({ ok: false, nuvizzCalls: 0, error: `could not read the warehouse to plan: ${e?.message || e}` }, 500);
  }
  const plan = rebuildPlan({ mode, sealed, indexed: built, date: mode === 'date' ? date : null, max: PACE_REBUILD_MAX_DAYS });
  const base = {
    nuvizzCalls: 0, dry, mode, sealed: sealed.length, alreadyBuilt: plan.alreadyIndexed,
    planned: plan.dates, remaining: plan.remaining, next: plan.next,
  };
  if (plan.refusal) return jsonResponse({ ok: false, ...base, error: plan.refusal }, 400);
  if (dry) return jsonResponse({ ok: true, ...base, built: [], failed: [] });

  const done: any[] = [];
  const failed: any[] = [];
  for (let i = 0; i < plan.dates.length; i += CONCURRENCY) {
    await Promise.all(plan.dates.slice(i, i + CONCURRENCY).map(async (d) => {
      const t0 = Date.now();
      try {
        // The SAME mask the live read uses (PACE_STOP_FIELDS), so a rebuilt day and the nightly
        // hook — which is handed the full records — count the same fields.
        const stops = await listStops(TENANT, d, { mask: PACE_STOP_FIELDS });
        const r = await writePaceDigest(TENANT, d, stops);
        done.push({ date: d, ...r, ms: Date.now() - t0 });
      } catch (e: any) {
        failed.push({ date: d, error: e?.message || String(e), ms: Date.now() - t0 });
      }
    }));
  }
  done.sort((a, b) => (a.date < b.date ? -1 : 1));
  failed.sort((a, b) => (a.date < b.date ? -1 : 1));
  // `remaining` counts what this call did NOT attempt; a failed day is still missing, and a
  // `missing=1` caller that loops will meet it again next call rather than skip past it.
  return jsonResponse({ ok: failed.length === 0, ...base, built: done, failed, remaining: plan.remaining + failed.length });
};
