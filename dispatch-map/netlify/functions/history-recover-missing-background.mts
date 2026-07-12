// history-recover-missing-background.mts
//
// Recover TRULY-MISSING history days — dates with no manifest AND no stored
// stops (nothing was ever captured). Attempts one historical capture through the
// EXISTING scan path (captureDate → scanDate), and:
//   • board reachable with stops  → seals a normal verified manifest (real routes
//                                    recovered);
//   • board reachable but empty   → writes a TOMBSTONE (no_board:true) so the date
//                                    stops reading as a hole;
//   • board unreachable (scan threw / NuVizz refused an old board) → leaves the
//     date alone and reports it, so a real weekday isn't tombstoned over a
//     transient/retention miss (priority: 2026-06-26 Fri).
//
// SANCTIONED NuVizz USE (Phase 3 only), bounded to ONE date per invocation via
// the existing call-reduction machinery. Per-invocation NuVizz call count is
// reported by snapshotting the shared daily counter before/after.
//
//   POST /.netlify/functions/history-recover-missing-background?date=YYYY-MM-DD
//     &tombstone_empty=0   → do NOT tombstone an empty result (report only)
//
// Idempotent: refuses a date that already carries a real seal or a tombstone.
import { isFirestoreEnabled, readCallCounter } from './lib/firestore.mts';
import { setCallTrigger } from './lib/nuvizz-request.mts';
import { getManifest } from './lib/history-store.mts';
import { captureDate } from './lib/history-core.mts';
import { writeTombstone } from './lib/history-seal.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ET calendar date (the shared call counter is keyed by ET-today).
function etToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function isWeekend(dateStr: string): boolean {
  const day = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return day === 0 || day === 6;
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  const url = new URL(req.url);
  const date = url.searchParams.get('date');
  // HARD RULE: one date per invocation (bounded NuVizz cost).
  if (!date || !DATE_RE.test(date)) {
    return new Response(JSON.stringify({ ok: false, error: 'pass exactly one ?date=YYYY-MM-DD' }), { status: 400, headers });
  }
  const tombstoneEmpty = url.searchParams.get('tombstone_empty') !== '0';

  // Idempotent: never re-scan a date that is already sealed or tombstoned.
  const existing = await getManifest(TENANT, date);
  if (existing && (existing.verified || existing.complete || existing.no_board)) {
    return new Response(JSON.stringify({
      ok: true, date, skipped: existing.no_board ? 'already_tombstoned' : 'already_sealed',
      counts: existing.counts ?? null, nuvizz_calls: 0,
    }), { status: 200, headers });
  }

  setCallTrigger('history-recover-missing');
  const counterKey = etToday();
  const before = await readCallCounter(counterKey).catch(() => 0);
  const t0 = Date.now();

  let outcome: string;
  let stops = 0;
  let sealed = false;
  let error: string | null = null;
  let tombstoned = false;
  try {
    const r = await captureDate(date);
    stops = Number(r?.counts?.stops ?? 0);
    sealed = !!r?.sealed;
    if (stops > 0 && sealed) {
      outcome = 'recovered';
    } else if (stops === 0) {
      // Reachable but no board / empty board.
      if (tombstoneEmpty) {
        await writeTombstone(TENANT, date, `rescan returned 0 stops on ${new Date().toISOString().slice(0, 10)} (no board served)`);
        tombstoned = true;
        outcome = 'tombstoned_empty';
      } else {
        outcome = 'empty_no_tombstone';
      }
    } else {
      // stops>0 but did not seal — the seal path already recorded a LOUD failure.
      outcome = 'captured_but_unsealed';
    }
  } catch (e: any) {
    // NuVizz unreachable / refused the old board — DO NOT tombstone (ambiguous).
    error = e?.message || 'capture threw';
    outcome = 'unreachable';
  }

  const after = await readCallCounter(counterKey).catch(() => before);
  const nuvizzCalls = Math.max(0, after - before);

  const result = {
    ok: outcome === 'recovered' || outcome === 'tombstoned_empty',
    date,
    weekday: isWeekend(date) ? 'weekend' : 'weekday',
    reachable: outcome !== 'unreachable',
    outcome,
    stops_recovered: stops,
    sealed,
    tombstoned,
    error,
    nuvizz_calls: nuvizzCalls,
    ms: Date.now() - t0,
    // A weekday that came back empty is worth a human glance (real routes may be
    // lost to NuVizz retention rather than the day never existing).
    note: (!isWeekend(date) && outcome !== 'recovered')
      ? 'WEEKDAY did not recover real routes — review before trusting the tombstone'
      : undefined,
  };
  console.log('[history-recover-missing] done:', JSON.stringify(result));
  return new Response(JSON.stringify(result), { status: 200, headers });
};
