// lib/routing-customer-drivers.mts
//
// PHASE 2.1 — DRIVER HABIT MINER (the "Scott Hart / Marcus Young" ask): WHICH
// driver most often delivers each customer, learned from our own DELIVERED
// history. The companion question — in WHAT ORDER that driver runs their
// stops — is carried by the reference layer's same_driver_multiplier
// (routing-reference.mts pickReferences): a driver's own historical routes are
// boosted into the top-k precedence graph, so their habitual ordering shapes
// the learned zone order. WHO = this module; IN WHAT ORDER = that one.
//
//   routing_customer_drivers/{tenant}__{matchKey}
//     tenant, match_key, n_delivered,
//     drivers: [{driver_user_name, driver_name, count, share, last_date}...]
//               (desc by count),
//     top_driver, top_driver_name, top_share,
//     obs: [{d, u, name}...]   (dated reservoir, newest ≤ CAP — same design as
//                               routing_service_times: the top-level fields are
//                               the as-of-latest convenience; habitAsOf()
//                               recomputes from obs strictly < D for the
//                               leakage guard)
//     updated_at
//
// Mined from DELIVERED stops only (normalizedStatus === 'DELIVERED') that carry
// a customerMatchKey and a driver identity. PURE derivation + thin I/O; ZERO
// NuVizz calls. Nightly pass honors ROUTING_ENGINE=off; backfill ignores it.

import { getDoc, setDoc } from './firestore.mts';
import { routingEngineDisabled } from './routing-engine-config.mts';

export const CUSTOMER_DRIVERS_COLLECTION = 'routing_customer_drivers';
const RESERVOIR_CAP = 400;

function sanitize(k: string): string {
  return String(k).replace(/[^A-Za-z0-9_.-]/g, '_');
}
export function customerDriversPath(tenant: string, matchKey: string): string {
  return `${CUSTOMER_DRIVERS_COLLECTION}/${tenant}__${sanitize(matchKey)}`;
}

export interface HabitOb { d: string; u: string; name: string | null }

// PURE: one day's habit observations — DELIVERED stops with a driver identity.
export function habitObservationsForDay(stops: any[], date: string): Map<string, HabitOb[]> {
  const byKey = new Map<string, HabitOb[]>();
  for (const s of stops || []) {
    if (s?.normalizedStatus !== 'DELIVERED') continue;
    const mk = s?.customerMatchKey;
    if (!mk) continue;
    const u = String(s?.driverUserName ?? '').trim().toUpperCase() ||
      String(s?.driverName ?? '').trim().toUpperCase();
    if (!u) continue;
    const ob: HabitOb = { d: date, u, name: s?.driverName ?? null };
    (byKey.get(mk) ?? byKey.set(mk, []).get(mk)!).push(ob);
  }
  return byKey;
}

// Newest-first cap, restored to chronological order (service-times pattern).
function capReservoir(obs: HabitOb[], cap: number): HabitOb[] {
  const sorted = [...obs].sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
  return sorted.slice(0, cap).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

interface DriverAgg { driver_user_name: string; driver_name: string | null; count: number; share: number; last_date: string }

// PURE: aggregate a reservoir into the drivers[] ranking.
export function aggregateHabit(obs: HabitOb[]): { n_delivered: number; drivers: DriverAgg[] } {
  const byDriver = new Map<string, { count: number; name: string | null; last: string }>();
  for (const o of obs) {
    const cur = byDriver.get(o.u);
    if (cur) {
      cur.count++;
      if (o.d >= cur.last) { cur.last = o.d; if (o.name) cur.name = o.name; }
    } else {
      byDriver.set(o.u, { count: 1, name: o.name, last: o.d });
    }
  }
  const n = obs.length;
  const drivers = [...byDriver.entries()]
    .map(([u, v]) => ({
      driver_user_name: u, driver_name: v.name,
      count: v.count, share: n ? Math.round((v.count / n) * 1000) / 1000 : 0,
      last_date: v.last,
    }))
    .sort((a, b) => (b.count - a.count) || a.driver_user_name.localeCompare(b.driver_user_name));
  return { n_delivered: n, drivers };
}

export function buildCustomerDriversDoc(tenant: string, matchKey: string, obs: HabitOb[], nowIso: string): any {
  const capped = capReservoir(obs, RESERVOIR_CAP);
  const agg = aggregateHabit(capped);
  const top = agg.drivers[0] ?? null;
  return {
    tenant, match_key: matchKey,
    n_delivered: agg.n_delivered,
    drivers: agg.drivers,
    top_driver: top?.driver_user_name ?? null,
    top_driver_name: top?.driver_name ?? null,
    top_share: top?.share ?? null,
    obs: capped,
    updated_at: nowIso,
  };
}

// PURE, AS-OF (the leakage-safe reader the solver uses): habit strictly < D.
export function habitAsOf(doc: any | null, asOfDate: string):
  { topDriver: string; topDriverName: string | null; topShare: number; n: number } | null {
  const obs: HabitOb[] = (doc?.obs || []).filter((o: any) => String(o?.d) < asOfDate);
  if (!obs.length) return null;
  const agg = aggregateHabit(obs);
  const top = agg.drivers[0];
  if (!top) return null;
  return { topDriver: top.driver_user_name, topDriverName: top.driver_name, topShare: top.share, n: agg.n_delivered };
}

// BACKFILL write path — full recompute per customer, OVERWRITE (idempotent).
export async function writeCustomerDriversFresh(
  tenant: string, byCustomer: Map<string, HabitOb[]>, conc = 8,
): Promise<number> {
  const nowIso = new Date().toISOString();
  const entries = [...byCustomer.entries()];
  let i = 0, written = 0;
  const worker = async () => {
    while (i < entries.length) {
      const [mk, obs] = entries[i++];
      await setDoc(customerDriversPath(tenant, mk), buildCustomerDriversDoc(tenant, mk, obs, nowIso));
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, entries.length || 1) }, worker));
  return written;
}

// NIGHTLY incremental pass — same hook + failure policy as the other miners.
// Idempotent: a re-run for the same date REPLACES that date's obs per customer.
export async function updateCustomerDriversForDay(
  tenant: string, date: string, stops: any[],
): Promise<{ customers: number; written: number; disabled?: boolean }> {
  if (routingEngineDisabled()) {
    console.log('[routing-engine] ROUTING_ENGINE=off — nightly customer-driver pass skipped');
    return { customers: 0, written: 0, disabled: true };
  }
  const day = habitObservationsForDay(stops, date);
  const nowIso = new Date().toISOString();
  const entries = [...day.entries()];
  let i = 0, written = 0;
  const worker = async () => {
    while (i < entries.length) {
      const [mk, obs] = entries[i++];
      const existing = await getDoc(customerDriversPath(tenant, mk));
      const prior: HabitOb[] = (existing?.obs || []).filter((o: any) => String(o?.d) !== date);
      await setDoc(customerDriversPath(tenant, mk), buildCustomerDriversDoc(tenant, mk, [...prior, ...obs], nowIso));
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, entries.length || 1) }, worker));
  console.log(`[routing-engine] ${date}: customer-driver habits for ${entries.length} customer(s)`);
  return { customers: entries.length, written };
}
