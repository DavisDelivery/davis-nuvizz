// history-postseal.mts
//
// The post-seal hook block, shared by BOTH the nightly capture (history-core) and
// the manifest-heal recovery (history-manifest-heal-background). A day is only
// "done" once its manifest is sealed AND these derivations have run against the
// day's stops: the per-customer history rollup, the tractor "delivered here" PAINT,
// and the four learned-routing miners.
//
// WHY SHARED: the heal path used to reseal a day's manifest but NEVER re-run these
// hooks, so a recovered/orphaned day got a manifest but was left UNPAINTED and
// unmined (its tractor_locations / routing_* were never written). Routing both
// callers through one function makes a healed day identical to a cleanly-captured
// one for every downstream consumer.
//
// Best-effort by design: each hook is independently guarded, and a throw in one
// never blocks the others or the caller — the warehouse is the source of truth and
// every hook can be re-derived from it (the *-rebuild / *-backfill endpoints). A
// throw is logged loudly so a broken hook is visible in the function log. All
// hooks are Firestore-only (ZERO NuVizz calls) and honor their own kill switches
// (TRACTOR_FLAGS=off, ROUTING_ENGINE=off).
import { updateCustomerRollupsForDay } from './history-customers.mts';
import { updateTractorFlagsForDay } from './tractor-flags.mts';
import { updateRoutingReferencesForDay } from './routing-reference.mts';
import { updateDriverDaysForDay } from './routing-driver-days.mts';
import { updateServiceTimesForDay } from './routing-service-times.mts';
import { updateCustomerDriversForDay } from './routing-customer-drivers.mts';

// One post-seal hook: name + the pass to run. Order is stable (rollup first, then
// paint, then the engine miners) but each is independent.
const HOOKS: Array<{ name: string; run: (t: string, d: string, s: any[]) => Promise<any> }> = [
  { name: 'customer-rollup', run: updateCustomerRollupsForDay },
  { name: 'tractor-flags', run: updateTractorFlagsForDay },
  { name: 'routing-reference', run: updateRoutingReferencesForDay },
  { name: 'driver-days', run: updateDriverDaysForDay },
  { name: 'service-times', run: updateServiceTimesForDay },
  { name: 'customer-drivers', run: updateCustomerDriversForDay },
];

// Run every post-seal hook against the day's stop records. Never throws — a hook
// failure is caught, logged, and recorded in the returned per-hook outcome so the
// caller can surface it (e.g. in the capture audit doc). Call ONLY after a
// verified+sealed manifest, with the same stop records the seal verified.
export async function runPostSealHooks(
  tenant: string,
  date: string,
  stopRecords: any[],
): Promise<{ ok: boolean; hooks: Record<string, { ok: boolean; error?: string; result?: any }> }> {
  const hooks: Record<string, { ok: boolean; error?: string; result?: any }> = {};
  for (const h of HOOKS) {
    try {
      const result = await h.run(tenant, date, stopRecords);
      hooks[h.name] = { ok: true, result };
    } catch (e: any) {
      console.error(`[postseal] ${h.name} failed for ${date}:`, e?.message);
      hooks[h.name] = { ok: false, error: e?.message || String(e) };
    }
  }
  return { ok: Object.values(hooks).every((h) => h.ok), hooks };
}
