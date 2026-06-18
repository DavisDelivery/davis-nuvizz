// dispatch-map/netlify/functions/lib/nuvizz-request.mts
//
// ── Shared NuVizz request wrapper (Phase 4 — single source of truth) ─────────
//
// Every outbound NuVizz call in the consolidated design routes through this
// wrapper so that, fleet-wide, we can:
//   1. COUNT + log every call (route + tenant) against a SHARED daily counter in
//      the davismarginiq Firestore — so volume is observable in one place.
//   2. Enforce a HARD DAILY CEILING / circuit breaker. When the day's count
//      crosses the ceiling the breaker trips: it flips a Firestore flag that
//      scansEnabled() also honors, so the next regression is throttled in
//      minutes — not by an angry vendor email.
//   3. DEDUPE in-flight identical requests (same method+url) so a fan-out that
//      asks for the same load twice only pays for it once.
//   4. Apply exponential backoff with a HARD CAP on 429 / 5xx.
//
// The pure logic here takes its side-effects (fetch, counter I/O, breaker I/O,
// clock) as injected dependencies so it is unit-testable with no network and no
// Firestore — see test/nuvizz-request.test.mjs. Production wiring lives in
// makeProdRequester() at the bottom, which binds the Firestore-backed counter.

export interface NvRequestMeta {
  /** Coarse route label for accounting, e.g. '/load/info', '/stop/info'. */
  route: string;
  /** Tenant company code, e.g. 'DAVIS' / 'ULINE'. */
  tenant: string;
}

export interface NvRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  /** Per-call override of the retry policy. */
  maxRetries?: number;
  signal?: AbortSignal;
}

export type BreakerMode = 'monitor' | 'enforce';

/**
 * monitor (default): count + log everything and warn "WOULD trip" when the day's
 *   total crosses the ceiling, but never open the breaker and never block a scan.
 *   Lets us measure real volume safely before turning on enforcement.
 * enforce: trip the breaker + block at the ceiling (the eventual spend cap).
 */
export const BREAKER_MODE: BreakerMode =
  (process.env.NUVIZZ_BREAKER_MODE || '').toLowerCase() === 'enforce' ? 'enforce' : 'monitor';

export function breakerMode(): BreakerMode { return BREAKER_MODE; }

export interface RequesterConfig {
  /** Hard daily call ceiling across the whole fleet. Default 100_000. */
  dailyCeiling: number;
  /** monitor (count+warn, never block) vs enforce (trip+block) at the ceiling. */
  breakerMode: BreakerMode;
  /** Retry policy for 429/5xx. */
  maxRetries: number;
  backoffBaseMs: number;
  backoffFactor: number;
  /** Absolute cap on a single backoff sleep. */
  backoffMaxMs: number;
  /** Absolute cap on total time spent sleeping across all retries of one call. */
  backoffTotalCapMs: number;
}

export const DEFAULT_CONFIG: RequesterConfig = {
  dailyCeiling: Number(process.env.NUVIZZ_DAILY_CEILING) || 100_000,
  breakerMode: BREAKER_MODE,
  maxRetries: 4,
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 8_000,
  backoffTotalCapMs: 20_000,
};

export interface RequesterDeps {
  /** The real network call. Injected so tests can stub it. */
  fetchImpl: (url: string, init: any) => Promise<Response>;
  /**
   * Atomically add `n` to today's shared counter and return the NEW total.
   * Production: Firestore increment. Tests: in-memory.
   */
  recordCall: (meta: NvRequestMeta, n: number) => Promise<number>;
  /** Read whether the circuit breaker is currently open (volume exceeded). */
  isCircuitOpen: () => Promise<boolean>;
  /** Trip the breaker — persist a flag scansEnabled() will honor. */
  tripCircuit: (reason: string) => Promise<void>;
  /** Structured log sink. Default: console.log. */
  log?: (entry: Record<string, unknown>) => void;
  /** Clock + sleep, injectable for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class NuvizzCircuitOpenError extends Error {
  constructor(msg: string) { super(msg); this.name = 'NuvizzCircuitOpenError'; }
}

// ── Pure helpers (no side effects — directly unit-tested) ────────────────────

/** 429 and any 5xx are retryable; everything else (incl. 404) is terminal. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Backoff for the Nth retry (0-based): base * factor^n, capped at maxMs, with
 * deterministic +/- 10% jitter derived from the attempt (no Math.random so it
 * is testable). Returns the sleep in ms.
 */
export function computeBackoffMs(attempt: number, cfg: Pick<RequesterConfig, 'backoffBaseMs' | 'backoffFactor' | 'backoffMaxMs'>): number {
  const raw = cfg.backoffBaseMs * Math.pow(cfg.backoffFactor, attempt);
  const capped = Math.min(raw, cfg.backoffMaxMs);
  // Deterministic jitter in [0.9, 1.1) based on the attempt index.
  const jitter = 0.9 + ((attempt * 37) % 20) / 100;
  return Math.round(capped * jitter);
}

/** Stable dedupe key for an in-flight request. */
export function dedupeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

// ── The requester ────────────────────────────────────────────────────────────

export function createNuvizzRequester(deps: RequesterDeps, config: Partial<RequesterConfig> = {}) {
  const cfg: RequesterConfig = { ...DEFAULT_CONFIG, ...config };
  const log = deps.log ?? ((e) => console.log('[nuvizz-request]', JSON.stringify(e)));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // In-flight dedupe: identical (method+url) requests share one promise.
  const inflight = new Map<string, Promise<Response>>();
  // Cheap per-instance memo of the breaker so we don't read Firestore on every
  // probe; refreshed at most once per breakerTtlMs.
  let breakerOpen = false;
  let breakerCheckedAt = 0;
  const breakerTtlMs = 5_000;
  let totalThisInstance = 0;
  let wouldTripLogged = false; // monitor mode: warn once per warm instance

  async function breakerIsOpen(): Promise<boolean> {
    if (now() - breakerCheckedAt < breakerTtlMs) return breakerOpen;
    breakerOpen = await deps.isCircuitOpen();
    breakerCheckedAt = now();
    return breakerOpen;
  }

  async function doFetchWithRetry(url: string, init: any, maxRetries: number, meta: NvRequestMeta): Promise<Response> {
    let attempt = 0;
    let sleptTotal = 0;
    // attempt 0 = first try; up to maxRetries additional tries.
    while (true) {
      const started = now();
      let resp: Response;
      try {
        resp = await deps.fetchImpl(url, init);
      } catch (err) {
        // Network error — treat like a retryable 5xx.
        if (attempt >= maxRetries) throw err;
        const wait = computeBackoffMs(attempt, cfg);
        if (sleptTotal + wait > cfg.backoffTotalCapMs) throw err;
        sleptTotal += wait; attempt++;
        await sleep(wait);
        continue;
      }
      const ms = now() - started;
      // Count + log every actual network round-trip (success or failure).
      const total = await deps.recordCall(meta, 1);
      totalThisInstance++;
      log({ route: meta.route, tenant: meta.tenant, status: resp.status, ms, dayTotal: total, mode: cfg.breakerMode });
      // At the ceiling: enforce → trip + (next call) block; monitor → warn only.
      if (total >= cfg.dailyCeiling) {
        if (cfg.breakerMode === 'enforce') {
          if (!breakerOpen) {
            breakerOpen = true; breakerCheckedAt = now();
            await deps.tripCircuit(`daily ceiling ${cfg.dailyCeiling} reached (count=${total})`);
            log({ event: 'circuit-tripped', route: meta.route, tenant: meta.tenant, dayTotal: total, ceiling: cfg.dailyCeiling });
          }
        } else if (!wouldTripLogged) {
          wouldTripLogged = true;
          log({ event: 'circuit-would-trip', mode: 'monitor', route: meta.route, tenant: meta.tenant, dayTotal: total, ceiling: cfg.dailyCeiling, msg: `WOULD trip at ${cfg.dailyCeiling} (monitor mode — not blocking)` });
        }
      }
      if (!isRetryableStatus(resp.status) || attempt >= maxRetries) return resp;
      const wait = computeBackoffMs(attempt, cfg);
      if (sleptTotal + wait > cfg.backoffTotalCapMs) return resp; // hard cap reached — give caller the last response
      sleptTotal += wait; attempt++;
      await sleep(wait);
    }
  }

  /**
   * Make a counted, deduped, breaker-guarded, backoff-retried NuVizz request.
   * Throws NuvizzCircuitOpenError if the breaker is open (so callers skip the
   * whole scan rather than hammering a vendor that's already rate-limiting us).
   */
  async function request(url: string, opts: NvRequestOptions, meta: NvRequestMeta): Promise<Response> {
    // Only enforce mode blocks; monitor mode never refuses a scan.
    if (cfg.breakerMode === 'enforce' && await breakerIsOpen()) {
      throw new NuvizzCircuitOpenError(`NuVizz circuit breaker open — refusing ${meta.route} (${meta.tenant})`);
    }
    const method = (opts.method || 'GET').toUpperCase();
    const init = { method, headers: opts.headers, body: opts.body ?? undefined, signal: opts.signal };
    const maxRetries = opts.maxRetries ?? cfg.maxRetries;

    // Dedupe only idempotent GETs (POST/writes must never be coalesced).
    if (method === 'GET') {
      const key = dedupeKey(method, url);
      const existing = inflight.get(key);
      if (existing) return existing.then((r) => r.clone());
      const p = doFetchWithRetry(url, init, maxRetries, meta).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p.then((r) => r.clone());
    }
    return doFetchWithRetry(url, init, maxRetries, meta);
  }

  function getStats() {
    return { totalThisInstance, breakerOpen, inflight: inflight.size, ceiling: cfg.dailyCeiling, mode: cfg.breakerMode };
  }

  return { request, getStats, _config: cfg };
}

// ── Scan-level min-interval floor ────────────────────────────────────────────
//
// In-flight dedupe stops duplicate PROBES; this stops duplicate SCANS. A whole
// date should not be re-scanned more often than the floor regardless of how many
// cron ticks or on-demand hits arrive. The caller passes the index's
// last_scanned_at; we say whether enough time has elapsed.
export const MIN_SCAN_INTERVAL_MS = Number(process.env.NUVIZZ_MIN_SCAN_INTERVAL_MS) || 10 * 60 * 1000;

export function scanIntervalElapsed(lastScannedAtISO: string | null | undefined, nowMs: number, floorMs = MIN_SCAN_INTERVAL_MS): boolean {
  if (!lastScannedAtISO) return true;
  const last = Date.parse(lastScannedAtISO);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= floorMs;
}

// ── Production wiring (Firestore-backed counter + breaker) ───────────────────
// A singleton per warm instance so in-flight dedupe + breaker memo survive across
// invocations. Imported lazily to keep the pure module test-friendly.
import { incrementCallCounter, readCircuit, setCircuit } from './firestore.mts';

let __prod: ReturnType<typeof createNuvizzRequester> | null = null;

export function getNuvizzRequester() {
  if (__prod) return __prod;
  __prod = createNuvizzRequester({
    fetchImpl: (url, init) => fetch(url, init),
    // Thread the route through so the per-route breakdown (count__*) populates.
    recordCall: (meta, n) => incrementCallCounter(new Date().toISOString().slice(0, 10), n, meta.route),
    isCircuitOpen: async () => (await readCircuit()).open,
    tripCircuit: (reason) => setCircuit(true, reason, new Date().toISOString()),
  });
  return __prod;
}

/**
 * True when the breaker has tripped — scan entrypoints skip the whole run.
 * In monitor mode we never halt scans (we only measure), so this is always false.
 * readCircuit is day-scoped, so a stale prior-day flag also reads as closed.
 */
export async function breakerTripped(): Promise<boolean> {
  if (BREAKER_MODE === 'monitor') return false;
  try { return (await readCircuit()).open; } catch { return false; }
}
