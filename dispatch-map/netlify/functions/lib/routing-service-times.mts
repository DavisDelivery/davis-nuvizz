// lib/routing-service-times.mts
//
// PHASE 2 — SERVICE TIME MINER. How long a driver actually spends at each
// customer (arrival → delivered), so the assignment solver can estimate shift
// hours and STRICT-window risk without any travel-matrix call.
//
//   routing_service_times/{tenant}__{matchKey}
//     tenant, match_key, n, median_min, p85_min, last_seen,
//     obs: [{ d: 'YYYY-MM-DD', m: minutes }...]   (dated reservoir, recent ≤ CAP)
//     updated_at
//   routing_service_times/{tenant}__fleet          (companion, reserved id)
//     tenant, is_fleet:true, updated_at,
//     buckets: { '0-1'|'2-4'|'5+': { n, median_min, p85_min, obs:[{d,m}] } }
//
// DESIGN NOTE — why a dated reservoir. Service times aggregate across dates, but
// the leakage guard requires an AS-OF view (only observations with date < D).
// A bare (median,p85) can't be filtered by date, so each doc carries the raw
// clamped observations WITH their date; serviceTimeAsOf(doc, D) recomputes from
// obs strictly before D. The top-level median_min/p85_min are the as-of-latest
// convenience summary. The fleet-level fallback (bucketed by pallet count) lives
// in one companion doc under the reserved `__fleet` id — chosen over per-bucket
// docs to keep the fallback a single cheap read.
//
// Observations are clamped to a sane band (config service_min_clamp..
// service_max_clamp) before aggregating, so a mis-stamped multi-hour dwell or a
// negative clock skew can't distort a median. PURE derivation + thin I/O; ZERO
// NuVizz calls. Nightly honors ROUTING_ENGINE=off; backfill ignores it.

import { getDoc, setDoc } from './firestore.mts';
import { routingEngineDisabled, loadEngineConfig, type EngineConfig } from './routing-engine-config.mts';

export const SERVICE_TIMES_COLLECTION = 'routing_service_times';
const RESERVOIR_CAP = 400;           // per customer doc
const FLEET_RESERVOIR_CAP = 800;     // per fleet bucket
const MIN_CUSTOMER_OBS = 3;          // below this, fall back to the fleet bucket

export function serviceTimePath(tenant: string, matchKey: string): string {
  return `${SERVICE_TIMES_COLLECTION}/${tenant}__${sanitize(matchKey)}`;
}
export function fleetServicePath(tenant: string): string {
  return `${SERVICE_TIMES_COLLECTION}/${tenant}__fleet`;
}
function sanitize(k: string): string {
  return String(k).replace(/[^A-Za-z0-9_.-]/g, '_');
}

export type PalletBucket = '0-1' | '2-4' | '5+';
export function palletBucket(pallets: any): PalletBucket {
  const p = Number(pallets);
  if (!Number.isFinite(p) || p <= 1) return '0-1';
  if (p <= 4) return '2-4';
  return '5+';
}

// PURE quantiles over a numeric list (nearest-rank; matches the report's intent).
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  if (q <= 0) return s[0];
  if (q >= 1) return s[s.length - 1];
  const idx = Math.ceil(q * s.length) - 1;
  return s[Math.min(s.length - 1, Math.max(0, idx))];
}
export function median(values: number[]): number | null { return quantile(values, 0.5); }

// PURE: minutes between two ISO stamps, or null if either is missing/unparseable.
export function dwellMinutes(arrivalDTTM: any, deliveredDTTM: any): number | null {
  const a = Date.parse(String(arrivalDTTM ?? ''));
  const d = Date.parse(String(deliveredDTTM ?? ''));
  if (!Number.isFinite(a) || !Number.isFinite(d)) return null;
  return (d - a) / 60000;
}

export interface DayServiceObs {
  customer: Map<string, number[]>;                  // matchKey → clamped minutes
  fleet: Map<PalletBucket, number[]>;               // bucket → clamped minutes
}

// PURE: one day's clamped service observations, keyed by customer + pallet bucket.
export function serviceObservationsForDay(stops: any[], cfg: EngineConfig): DayServiceObs {
  const customer = new Map<string, number[]>();
  const fleet = new Map<PalletBucket, number[]>();
  for (const s of stops || []) {
    const mk = s?.customerMatchKey;
    if (!mk) continue;
    const raw = dwellMinutes(s?.arrivalDTTM, s?.deliveredDTTM);
    if (raw == null) continue;                        // need BOTH stamps
    if (raw < cfg.service_min_clamp || raw > cfg.service_max_clamp) continue; // out-of-band → drop
    const m = Math.round(raw * 10) / 10;
    (customer.get(mk) ?? customer.set(mk, []).get(mk)!).push(m);
    const b = palletBucket(s?.pallets);
    (fleet.get(b) ?? fleet.set(b, []).get(b)!).push(m);
  }
  return { customer, fleet };
}

interface Ob { d: string; m: number }
function summarize(obs: Ob[]): { n: number; median_min: number | null; p85_min: number | null } {
  const ms = obs.map((o) => o.m);
  return { n: ms.length, median_min: median(ms), p85_min: quantile(ms, 0.85) };
}
// Newest-first cap, then restore chronological order.
function capReservoir(obs: Ob[], cap: number): Ob[] {
  const sorted = [...obs].sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)); // desc by date
  return sorted.slice(0, cap).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

function buildCustomerDoc(tenant: string, matchKey: string, obs: Ob[], nowIso: string): any {
  const capped = capReservoir(obs, RESERVOIR_CAP);
  const sum = summarize(capped);
  return {
    tenant, match_key: matchKey,
    n: sum.n, median_min: sum.median_min, p85_min: sum.p85_min,
    last_seen: capped.length ? capped[capped.length - 1].d : null,
    obs: capped, updated_at: nowIso,
  };
}
function buildFleetDoc(tenant: string, byBucket: Map<PalletBucket, Ob[]>, nowIso: string): any {
  const buckets: any = {};
  for (const b of ['0-1', '2-4', '5+'] as PalletBucket[]) {
    const capped = capReservoir(byBucket.get(b) || [], FLEET_RESERVOIR_CAP);
    const sum = summarize(capped);
    buckets[b] = { n: sum.n, median_min: sum.median_min, p85_min: sum.p85_min, obs: capped };
  }
  return { tenant, is_fleet: true, buckets, updated_at: nowIso };
}

// ── AS-OF helpers (PURE) — the leakage-safe read used by the solver/envelope ──

// Service time for a customer as-of date D: recompute from the doc's obs with
// date < D; fall back to the fleet bucket, then a config-band default.
export function serviceTimeAsOf(
  customerDoc: any | null, fleetDoc: any | null, pallets: any, asOfDate: string, cfg: EngineConfig,
): { median_min: number; p85_min: number; source: 'customer' | 'fleet' | 'default'; n: number } {
  const cutoff = (obs: any[]): Ob[] => (obs || []).filter((o) => String(o?.d) < asOfDate);
  const custObs = cutoff(customerDoc?.obs);
  if (custObs.length >= MIN_CUSTOMER_OBS) {
    const ms = custObs.map((o) => o.m);
    return { median_min: median(ms)!, p85_min: quantile(ms, 0.85)!, source: 'customer', n: ms.length };
  }
  const b = palletBucket(pallets);
  const fleetObs = cutoff(fleetDoc?.buckets?.[b]?.obs);
  if (fleetObs.length >= MIN_CUSTOMER_OBS) {
    const ms = fleetObs.map((o) => o.m);
    return { median_min: median(ms)!, p85_min: quantile(ms, 0.85)!, source: 'fleet', n: ms.length };
  }
  // Nothing observed yet — a neutral in-band default (documented; not history).
  const dflt = Math.min(cfg.service_max_clamp, Math.max(cfg.service_min_clamp, 15));
  return { median_min: dflt, p85_min: Math.min(cfg.service_max_clamp, dflt * 1.6), source: 'default', n: 0 };
}

// ── writers ──────────────────────────────────────────────────────────────────

// BACKFILL: recompute every doc fresh from accumulated obs. Caller folds all
// history into per-key arrays (dated), then hands them here.
export async function writeServiceTimesFresh(
  tenant: string, byCustomer: Map<string, Ob[]>, byBucket: Map<PalletBucket, Ob[]>, conc = 8,
): Promise<number> {
  const nowIso = new Date().toISOString();
  const entries = [...byCustomer.entries()];
  let i = 0, written = 0;
  const worker = async () => {
    while (i < entries.length) {
      const [mk, obs] = entries[i++];
      await setDoc(serviceTimePath(tenant, mk), buildCustomerDoc(tenant, mk, obs, nowIso));
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, entries.length || 1) }, worker));
  await setDoc(fleetServicePath(tenant), buildFleetDoc(tenant, byBucket, nowIso));
  return written + 1;
}

// NIGHTLY: merge one day's obs into existing docs, idempotently (a re-run for the
// same date REPLACES that date's obs for each key, so counts never double).
export async function updateServiceTimesForDay(
  tenant: string, date: string, stops: any[], cfg?: EngineConfig,
): Promise<{ customers: number; written: number; disabled?: boolean }> {
  if (routingEngineDisabled()) {
    console.log('[routing-engine] ROUTING_ENGINE=off — nightly service-time pass skipped');
    return { customers: 0, written: 0, disabled: true };
  }
  const effCfg = cfg || await loadEngineConfig(tenant);
  const day = serviceObservationsForDay(stops, effCfg);
  const nowIso = new Date().toISOString();
  let written = 0;

  const entries = [...day.customer.entries()];
  let i = 0;
  const worker = async () => {
    while (i < entries.length) {
      const [mk, mins] = entries[i++];
      const existing = await getDoc(serviceTimePath(tenant, mk));
      const prior: Ob[] = (existing?.obs || []).filter((o: any) => String(o?.d) !== date); // idempotent
      const merged = [...prior, ...mins.map((m) => ({ d: date, m }))];
      await setDoc(serviceTimePath(tenant, mk), buildCustomerDoc(tenant, mk, merged, nowIso));
      written++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, entries.length || 1) }, worker));

  // fleet companion — same idempotent day-replace, per bucket
  const fleetExisting = await getDoc(fleetServicePath(tenant));
  const byBucket = new Map<PalletBucket, Ob[]>();
  for (const b of ['0-1', '2-4', '5+'] as PalletBucket[]) {
    const prior: Ob[] = (fleetExisting?.buckets?.[b]?.obs || []).filter((o: any) => String(o?.d) !== date);
    const todays = (day.fleet.get(b) || []).map((m) => ({ d: date, m }));
    byBucket.set(b, [...prior, ...todays]);
  }
  await setDoc(fleetServicePath(tenant), buildFleetDoc(tenant, byBucket, nowIso));
  written++;

  console.log(`[routing-engine] ${date}: service times for ${entries.length} customer(s), ${written} doc(s) written`);
  return { customers: entries.length, written };
}
