// nuvizz-rebuild-customer-history-background.mts
//
// Rebuilds the per-customer history rollup (history_customers) AND the PRO → day
// pointer index (history_pros) FROM the immutable warehouse (history_days). Reads
// only our own Firestore — NEVER calls NuVizz. Used to backfill both over
// already-captured days (the nightly capture's post-seal hooks keep them current
// going forward; this seeds them for the past).
//
// RUN IT IN CHUNKS. A full 200-day range is ~140k pointer writes and can crowd the
// 15-minute background budget; a month at a time (?from=&to=) finishes comfortably
// and is safely re-runnable — every write here is idempotent, so a repeated or
// overlapping range costs time and nothing else.
//
// Background fn (15-min budget) so a multi-day backfill can't hit the 30s cap.
//
// Manual trigger (cron only fires on PUBLISHED deploys; this has no schedule —
// run it on demand):
//   POST /.netlify/functions/nuvizz-rebuild-customer-history-background
//     ?date=YYYY-MM-DD                  → single day
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD    → inclusive range, processed oldest→newest
//
// IT LEAVES A RECORD, AND IT REFUSES TO OVERLAP ITSELF (v1.49.0). The platform discards this
// function's response, so before this the only evidence a run had happened was a customer
// document that looked different afterwards — "did it finish?" had no answer that was not a
// guess. Now every run writes nuvizz_ops/customer_history_backfill before its first day and
// after every day (lib/customer-history-backfill.mts), history-capture-health serves it as
// `backfill`, and the Diagnostics seal strip prints it. A second run arriving while one is
// live is turned away and says so in that same document: two of these side by side is a
// lost-update race on history_customers, and the run meant to fill a month in would erase it.
import { isFirestoreEnabled, getDoc, setDoc, updateDocFields } from './lib/firestore.mts';
import { requireUserForBackground } from './lib/background-gate.mts';
import { listStops } from './lib/history-store.mts';
import { updateCustomerRollupsForDay } from './lib/history-customers.mts';
import { updateProIndexForDay, proIndexEnabled } from './lib/history-pro-index.mts';
import {
  BACKFILL_PROGRESS_PATH, backfillBusy, planBackfill, stepBackfill, finishBackfill, refusalPatch,
} from './lib/customer-history-backfill.mts';

const TENANT = 'davis';
const MAX_DAYS = 200;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function resolveDates(url: URL): string[] {
  const one = url.searchParams.get('date');
  if (one) return [one];
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from && to) {
    const out: string[] = [];
    const d = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    while (d <= end && out.length < MAX_DAYS) {
      out.push(ymd(d));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }
  return [];
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  // GATED AT admin. A rebuild rewrites history_customers + history_pros over up to 200 days — the
  // customer history screen serves — and an anonymous caller could pin the function for
  // fifteen minutes on every hit. Netlify already answered 202 and discarded our status
  // (lib/background-gate.mts); this is run by hand and has no doc a screen polls, so the
  // refusal lands in nuvizz_ops/background_refusals/rows — served back by
  // nuvizz-scan-config?explain=1 — and the function log.
  const gate = await requireUserForBackground(req, 'nuvizz-rebuild-customer-history-background', { role: 'admin' });
  if (!gate.ok) return gate.response;
  const dates = resolveDates(new URL(req.url));
  if (!dates.length) {
    return new Response(JSON.stringify({ ok: false, error: 'pass ?date=YYYY-MM-DD or ?from=&to=' }), { status: 400, headers });
  }
  const by = gate.user?.username ?? null;
  const now = () => new Date().toISOString();

  // ONE RUN AT A TIME — see lib/customer-history-backfill.mts for why an overlap is a lost
  // update and not merely slow. The refusal is written onto the LIVE run's document, field-
  // masked so the live run's own heartbeat is untouched, and it is the only trace the caller
  // gets: the 409 below is thrown away by the platform like every other background response.
  const existing = await getDoc(BACKFILL_PROGRESS_PATH).catch(() => null);
  if (backfillBusy(existing)) {
    const sorted = [...dates].sort();
    const reason = `a run started ${existing?.started_at ?? 'recently'} (${existing?.from ?? '?'} → ${existing?.to ?? '?'}) is still live: ${existing?.done ?? '?'} of ${existing?.total ?? '?'} days done`;
    try { await updateDocFields(BACKFILL_PROGRESS_PATH, refusalPatch({ from: sorted[0], to: sorted[sorted.length - 1], by }, now(), reason)); } catch { /* best-effort */ }
    console.warn('rebuild-customer-history: REFUSED —', reason);
    return new Response(JSON.stringify({ ok: false, error: 'backfill already running', reason }), { status: 409, headers });
  }

  let progress = planBackfill(dates, now(), by);
  await setDoc(BACKFILL_PROGRESS_PATH, progress);

  const results: any[] = [];
  try {
    for (const date of dates) {
      const t0 = Date.now();
      let row: any;
      try {
        const stops = await listStops(TENANT, date);
        const r = await updateCustomerRollupsForDay(TENANT, date, stops);
        // The pointer index is what makes a PRO older than a customer's last 20
        // findable at all. PRO_INDEX=off skips it here exactly as it does in the
        // nightly hook, so the switch reverts the backfill too.
        const pi = proIndexEnabled()
          ? await updateProIndexForDay(TENANT, date, stops)
          : { skipped: 'PRO_INDEX=off' };
        row = { date, ok: true, stops: stops.length, ...r, pro_index: pi, ms: Date.now() - t0 };
      } catch (e: any) {
        row = { date, ok: false, error: e?.message, ms: Date.now() - t0 };
      }
      results.push(row);
      // THE HEARTBEAT. A run killed by the platform mid-loop stops moving here, which is how
      // the lock above learns to let go and how the strip can say "stalled" instead of
      // "running" for ever. Never allowed to fail the day it is reporting.
      progress = stepBackfill(progress, row, now());
      await setDoc(BACKFILL_PROGRESS_PATH, progress).catch((e: any) => console.error('rebuild-customer-history: progress write failed', e?.message));
    }
    progress = finishBackfill(progress, now());
  } catch (e: any) {
    progress = finishBackfill(progress, now(), e?.message || 'backfill threw');
  }
  await setDoc(BACKFILL_PROGRESS_PATH, progress).catch((e: any) => console.error('rebuild-customer-history: final progress write failed', e?.message));
  console.log('rebuild-customer-history:', JSON.stringify(results));
  return new Response(JSON.stringify({ ok: !progress.error, days: dates.length, results, error: progress.error }), { status: progress.error ? 500 : 200, headers });
};
