// order-arrivals-seal-background.mts
//
// Seals each closed delivery day's ARRIVAL CURVE — when that day's orders first hit our
// system — into one compact document, so the evening card can read six same-weekday nights
// without listing six days of stops.
//
// ZERO NuVizz. Firestore in, Firestore out. The curve comes off `enriched_at`, a stamp the
// scan already wrote; this job reads the index it left behind and does no vendor work at all.
//
// ── Schedule: 07:00 UTC daily ────────────────────────────────────────────────
//   0 7 * * *
// 3am ET under EDT, 2am ET under EST — both after the ET day has closed AND after the last
// Uline report of the night (~12:30a), so the day being sealed is genuinely finished. It sits
// an hour behind the history snapshot (0 6) on purpose: two jobs listing the same day's stops
// at the same minute is a Firestore burst for no reason.
//
// IT CATCHES UP RATHER THAN SEALING ONE DAY. A run that is dropped, a deploy that misses a
// night, the first run after this ships — all the same shape, and a job that only ever sealed
// yesterday would leave permanent holes that nothing reports. Each run walks back CATCHUP_DAYS
// and seals any closed day not already on file, so the history heals itself. Days already
// sealed are left alone: re-sealing a settled night would rewrite a record with whatever the
// index says today, and the index is not immutable.
//
// THE WAY BACK: ORDER_ARRIVALS_ENABLED=off stops the sealing, and the card's own read degrades
// to "not enough sealed nights yet" rather than breaking. Nothing else reads these documents.

import { sealDate, readSealed, arrivalsEnabled, TENANT } from './lib/order-arrivals-store.mts';
import { operatingDayET } from '../../src/lib/uline-forecast-score.js';
import { isDeliveryDay, shiftIso } from '../../src/lib/manifest-window.js';
import { gateScheduledOverride } from './lib/background-gate.mts';

/** How far back a run will heal. Two working weeks: long enough to cover a holiday plus a
 *  missed deploy, short enough that a run is a dozen reads and not a month of them. */
export const CATCHUP_DAYS = 14;

// ?from=&to= is the hand-driven backfill branch and it OVERWRITES sealed nights, so it is
// admin-gated like every other scheduled override in this repo. The scheduled run takes no
// params and only ever fills holes.
export const OVERRIDE_PARAMS = ['from', 'to'] as const;

export default async (req: Request): Promise<Response> => {
  const refused = await gateScheduledOverride(req, 'order-arrivals-seal-background', OVERRIDE_PARAMS);
  if (refused) return refused;

  if (!arrivalsEnabled()) {
    console.log('[order-arrivals-seal] ORDER_ARRIVALS_ENABLED is off — sealing nothing');
    return new Response(JSON.stringify({ ok: true, skipped: 'disabled' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const at = new Date().toISOString();
  const today = operatingDayET(Date.now()) as string;
  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  // Which days to consider: an explicit admin range, or the catch-up walk back from yesterday.
  const dates: string[] = [];
  if (from && to) {
    for (let d = from; d <= to && dates.length < 90; d = shiftIso(d, 1)) dates.push(d);
  } else {
    for (let i = 1; i <= CATCHUP_DAYS; i++) {
      const d = shiftIso(today, -i);
      // Weekends carry no delivery board; sealing them would file empty nights that the
      // baseline then has to know to ignore. Cheaper to never write them.
      if (d && isDeliveryDay(d)) dates.push(d);
    }
  }

  const results: any[] = [];
  for (const d of dates) {
    // A settled night is never re-sealed by the schedule — only by an explicit admin range.
    if (!from && await readSealed(TENANT, d)) continue;
    try { results.push(await sealDate(TENANT, d, at)); }
    catch (e: any) { results.push({ date: d, ok: false, reason: String(e?.message || e).slice(0, 120) }); }
  }
  const sealed = results.filter((r) => r.ok).length;
  console.log('[order-arrivals-seal]', JSON.stringify({ today, considered: dates.length, sealed, skipped: results.length - sealed, results: results.slice(0, 20) }));
  return new Response(JSON.stringify({ ok: true, today, sealed, results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = {
  schedule: '0 7 * * *',
};
