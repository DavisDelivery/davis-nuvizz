// lib/history-rollup-guard.mts
//
// GUARD around the per-customer history rollup (history_customers) — the derived
// cache the mobile "Search past PROs / customer history" feature reads.
//
// WHY THIS EXISTS (incident 2026-07-06): the warehouse (history_days) is the
// source of truth; the rollup is a rebuildable cache. The nightly capture used to
// refresh the rollup as a fire-and-forget best-effort step (try/catch →
// console.error). When that step failed, the warehouse stayed correct but the
// rollup silently drifted — a real ~3-week drift (mid-Jun→Jul 2026) hid recent
// deliveries (e.g. PROs 7142023 / 7141513, both delivered 7/2) from search with
// NO visible signal. This module removes that entire failure class:
//
//   1. RETRY at capture time            → transient Firestore blips don't drop a day.
//   2. DURABLE BACKLOG on hard failure  → the day is recorded in history_rollup_state,
//                                          not lost to a log line.
//   3. SELF-HEALING SWEEP every run     → re-applies the rollup for backlogged days
//                                          PLUS a short trailing window of recent
//                                          weekdays, straight from the warehouse. A
//                                          single night's miss heals on the next run.
//   4. OBSERVABLE                       → a health readout (nuvizz-history-health)
//                                          exposes any lingering drift + an alert.
//
// EVERYTHING here is Firestore-only — it NEVER calls NuVizz. The rollup is rebuilt
// from the already-captured warehouse (updateCustomerRollupsForDay merges, never
// prunes → idempotent, so re-applying a day is always safe).

import { getDoc, setDoc } from './firestore.mts';
import { getManifest, listStops } from './history-store.mts';
import { updateCustomerRollupsForDay } from './history-customers.mts';

export const ROLLUP_STATE_COLLECTION = 'history_rollup_state';
export const ROLLUP_RETRY_ATTEMPTS = 3;      // capture-time retries before backlogging a day
export const ROLLUP_TRAILING_WEEKDAYS = 3;   // recent weekdays swept every run (backup even if the backlog write itself failed)
export const ROLLUP_MAX_SWEEP_DAYS = 14;     // cap the reconcile set → bounds nightly Firestore cost
export const ROLLUP_ALERT_THRESHOLD = 3;     // business days a day may stay backlogged before we ALERT

export function statePath(tenant: string): string {
  return `${ROLLUP_STATE_COLLECTION}/${tenant}`;
}

const nowIso = (): string => new Date().toISOString();

// ── PURE helpers (unit-tested in test/history-rollup-guard.test.mjs) ───────────

// The `n` most-recent weekdays strictly BEFORE `today` (YYYY-MM-DD), newest first.
// Weekends are excluded (Davis doesn't archive Sat/Sun). Deterministic in `today`.
export function recentWeekdays(today: string, n: number): string[] {
  const out: string[] = [];
  if (!today || n <= 0) return out;
  const d = new Date(today + 'T00:00:00Z');
  let guard = 0;
  while (out.length < n && guard++ < n * 3 + 10) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Reconcile set = backlog ∪ trailing window, de-duped, sorted OLDEST-first (so if
// capped we heal the oldest gaps first → convergence), capped at `max`.
export function reconcileList(pending: string[], trailing: string[], max: number): string[] {
  const set = new Set<string>([...(pending || []), ...(trailing || [])].filter(Boolean));
  return [...set].sort().slice(0, Math.max(0, max));
}

// Next backlog array after a day's apply result: add on failure, remove on
// success. De-duped + sorted (chronological, since YYYY-MM-DD sorts lexically).
export function nextPending(pending: string[], date: string, ok: boolean): string[] {
  const set = new Set<string>((pending || []).filter(Boolean));
  if (!date) return [...set].sort();
  if (ok) set.delete(date); else set.add(date);
  return [...set].sort();
}

// Count Mon–Fri days in the half-open interval (from, to]. 0 if from >= to / bad.
export function businessDaysBetween(from: string, to: string): number {
  if (!from || !to || from >= to) return 0;
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  let c = 0, guard = 0;
  while (d < end && guard++ < 4000) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) c++;
  }
  return c;
}

// Should we raise an alert? Drift is alertable once it either persists across
// several runs OR the oldest backlogged day is several business days old.
export function shouldAlert(
  pendingAfter: string[], consecutiveFailures: number, today: string,
  threshold: number = ROLLUP_ALERT_THRESHOLD,
): boolean {
  if (!pendingAfter || pendingAfter.length === 0) return false;
  if (consecutiveFailures >= threshold) return true;
  const oldest = [...pendingAfter].sort()[0];
  return businessDaysBetween(oldest, today) >= threshold;
}

// ── state doc (read-modify-write; setDoc is a full-document replace) ───────────

export interface RollupState {
  pending_days: string[];
  consecutive_sweep_failures: number;
  last_ok_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  alert: boolean;
}

export async function readRollupState(tenant: string): Promise<RollupState> {
  const doc = await getDoc(statePath(tenant));
  return {
    pending_days: Array.isArray(doc?.pending_days) ? doc.pending_days.filter(Boolean).sort() : [],
    consecutive_sweep_failures: Number(doc?.consecutive_sweep_failures) || 0,
    last_ok_at: doc?.last_ok_at ?? null,
    last_run_at: doc?.last_run_at ?? null,
    last_error: doc?.last_error ?? null,
    alert: !!doc?.alert,
  };
}

async function putRollupState(tenant: string, state: RollupState): Promise<void> {
  await setDoc(statePath(tenant), { tenant, ...state, updated_at: nowIso() });
}

// Add/remove one day from the backlog (used at capture time). Skips the write when
// nothing changed and there's no new error to record — avoids needless churn.
async function mutatePending(tenant: string, date: string, ok: boolean, errorMsg?: string): Promise<void> {
  const st = await readRollupState(tenant);
  const updated = nextPending(st.pending_days, date, ok);
  const unchanged = updated.length === st.pending_days.length && updated.every((d, i) => d === st.pending_days[i]);
  if (unchanged && ok) return;
  await putRollupState(tenant, {
    ...st,
    pending_days: updated,
    last_error: ok ? st.last_error : (errorMsg || st.last_error),
  });
}

// ── capture-time apply (retry → backlog) ──────────────────────────────────────

export interface RollupApplyResult { ok: boolean; written?: number; customers?: number; attempts: number; error?: string; }

// Apply one day's freshly-built stop records to the rollup, with bounded retry.
// On success clears the day from the backlog; on ultimate failure records it there
// so the next run's sweep heals it. NEVER throws — the warehouse capture must not
// fail over a rollup hiccup.
export async function applyRollupForDay(
  tenant: string, date: string, stopRecords: any[], attempts: number = ROLLUP_RETRY_ATTEMPTS,
): Promise<RollupApplyResult> {
  let lastErr = '';
  for (let a = 1; a <= attempts; a++) {
    try {
      const r = await updateCustomerRollupsForDay(tenant, date, stopRecords);
      try { await mutatePending(tenant, date, true); } catch (e: any) {
        console.error(`[history][rollup] pending-clear failed ${date}: ${e?.message}`);
      }
      return { ok: true, written: r.written, customers: r.customers, attempts: a };
    } catch (e: any) {
      lastErr = e?.message || String(e);
      console.error(`[history][rollup] apply failed ${date} attempt ${a}/${attempts}: ${lastErr}`);
    }
  }
  try { await mutatePending(tenant, date, false, lastErr); } catch (e: any) {
    console.error(`[history][rollup] pending-mark failed ${date}: ${e?.message} (original: ${lastErr})`);
  }
  return { ok: false, attempts, error: lastErr };
}

// ── self-healing sweep (runs every snapshot invocation) ───────────────────────

export interface SweepResult {
  candidates: string[];
  applied: Array<{ date: string; ok: boolean; stops?: number; written?: number; error?: string; reason?: string }>;
  pending_after: string[];
  consecutive_failures: number;
  alert: boolean;
}

// Reconcile the rollup backlog against the warehouse. Re-applies (backlog ∪ recent
// trailing weekdays), each from the warehouse — idempotent, zero NuVizz. Clears
// healed days from the backlog and updates health/alert state. NEVER throws.
export async function sweepRollupBacklog(
  tenant: string, today: string,
  opts: { trailingWeekdays?: number; maxDays?: number } = {},
): Promise<SweepResult> {
  const trailingN = opts.trailingWeekdays ?? ROLLUP_TRAILING_WEEKDAYS;
  const maxDays = opts.maxDays ?? ROLLUP_MAX_SWEEP_DAYS;
  const st = await readRollupState(tenant);
  const trailing = recentWeekdays(today, trailingN);
  const candidates = reconcileList(st.pending_days, trailing, maxDays);
  const wasPending = new Set(st.pending_days);
  const stillPending = new Set(st.pending_days);
  const applied: SweepResult['applied'] = [];

  for (const date of candidates) {
    const manifest = await getManifest(tenant, date);
    if (!manifest) {
      // No warehouse for that day → nothing to roll up. Trailing-window days with no
      // manifest are normal (weekend/holiday/not-yet-captured) → skip quietly. A
      // BACKLOGGED day with no manifest is anomalous (it had one at capture) → keep
      // it flagged so it surfaces rather than silently disappearing.
      if (wasPending.has(date)) applied.push({ date, ok: false, reason: 'no_manifest' });
      continue;
    }
    try {
      const stops = await listStops(tenant, date);
      const r = await updateCustomerRollupsForDay(tenant, date, stops);
      stillPending.delete(date);
      applied.push({ date, ok: true, stops: stops.length, written: r.written });
    } catch (e: any) {
      stillPending.add(date);
      applied.push({ date, ok: false, error: e?.message || String(e) });
    }
  }

  const pendingAfter = [...stillPending].sort();
  const clearedAll = pendingAfter.length === 0;
  const consecutive = clearedAll ? 0 : st.consecutive_sweep_failures + 1;
  const alert = shouldAlert(pendingAfter, consecutive, today);
  if (alert) {
    console.error(`[history][ALERT] rollup drift unresolved: pending=${JSON.stringify(pendingAfter)} ` +
      `consecutiveFailures=${consecutive} — search history is behind the warehouse for these days.`);
  }
  const firstBad = applied.find((a) => !a.ok);
  await putRollupState(tenant, {
    pending_days: pendingAfter,
    consecutive_sweep_failures: consecutive,
    last_run_at: nowIso(),
    last_ok_at: clearedAll ? nowIso() : st.last_ok_at,
    last_error: clearedAll ? null : (firstBad?.error || firstBad?.reason || st.last_error),
    alert,
  });
  return { candidates, applied, pending_after: pendingAfter, consecutive_failures: consecutive, alert };
}

// ── health readout (for nuvizz-history-health; zero NuVizz) ────────────────────

export interface RollupHealth {
  ok: boolean;
  alert: boolean;
  pending_days: string[];
  pending_count: number;
  oldest_pending_business_days: number;
  consecutive_sweep_failures: number;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
}

export async function readRollupHealth(tenant: string, today: string): Promise<RollupHealth> {
  const st = await readRollupState(tenant);
  const oldest = st.pending_days.length ? [...st.pending_days].sort()[0] : null;
  return {
    ok: st.pending_days.length === 0,
    alert: st.alert,
    pending_days: st.pending_days,
    pending_count: st.pending_days.length,
    oldest_pending_business_days: oldest ? businessDaysBetween(oldest, today) : 0,
    consecutive_sweep_failures: st.consecutive_sweep_failures,
    last_run_at: st.last_run_at,
    last_ok_at: st.last_ok_at,
    last_error: st.last_error,
  };
}
