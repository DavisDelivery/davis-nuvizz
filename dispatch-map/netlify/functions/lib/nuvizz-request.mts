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
  /** Finer caller label, e.g. 'board-list', 'enrichment', 'pod', 'timeline'. Optional. */
  source?: string;
  /**
   * WHY this call fired: 'scheduled-scan' | 'enrichment' | 'on-demand' | 'attempts' |
   * 'history' | 'manual'. Optional per-call override; otherwise the requester falls back
   * to the module-level trigger context set by each entrypoint (setCallTrigger).
   */
  trigger?: string;
}

// ── Attribution context ──────────────────────────────────────────────────────
// `app` is constant per deployment (env NUVIZZ_APP_NAME — 'dispatch-map' here, 'parent'
// on the root site) so a SHARED counter can tell the two apps apart. `trigger` is set
// once at each entrypoint (the scheduled scan, an HTTP handler, …) and read by every
// call made during that invocation, so callers don't have to thread it through every
// function. Serverless invocations are single-request, so a module-level trigger is safe.
export const APP_NAME = process.env.NUVIZZ_APP_NAME || 'dispatch-map';
let __callTrigger: string | undefined;
export function setCallTrigger(trigger: string | null | undefined): void { __callTrigger = trigger || undefined; }
export function getCallTrigger(): string | undefined { return __callTrigger; }

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
// ENFORCE is the default (Chad, Jul 29: "set the max calls to 2000 and that needs to be
// enforced"). It used to default to 'monitor' — count and warn, never block — so losing or
// mistyping the env var silently removed the only thing standing between a runaway loop and
// the vendor bill. A spend cap that stops mattering when a config value goes missing is not a
// cap. Opt OUT explicitly with NUVIZZ_BREAKER_MODE=monitor if a diagnosis ever needs it.
export const BREAKER_MODE: BreakerMode =
  (process.env.NUVIZZ_BREAKER_MODE || '').toLowerCase() === 'monitor' ? 'monitor' : 'enforce';

// ── The HARD ceiling ─────────────────────────────────────────────────────────
//
// 2,000 NuVizz calls a day, and nothing may raise it — not the env var, not the stored
// Diagnostics config, not a caller passing its own fallback. Every path that produces a
// ceiling runs through clampCeiling(), so the number on the Diagnostics pill is the number
// actually enforced. Before this, NUVIZZ_DAILY_CEILING was free to set 20,000 (what the site
// was running) and the editable config could reach 200,000.
//
// Sized against real usage: a normal day is a few hundred calls (133 by mid-morning on Jul 29),
// so 2,000 is ~10x headroom for scheduled scans, enrichment, live writes and manual pulls.
// It is deliberately BELOW the ~3,000-call cold number-probe scan that CLAUDE.md exists to
// prevent — that scan can no longer run to completion by accident; it trips the breaker
// partway. That is the intent, not a side effect.
export const HARD_DAILY_CEILING = 2_000;

/** PURE: any proposed ceiling, clamped into [1, HARD_DAILY_CEILING]. Junk → the hard cap. */
export function clampCeiling(n: any): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return HARD_DAILY_CEILING;
  return Math.min(HARD_DAILY_CEILING, v);
}

export function breakerMode(): BreakerMode { return BREAKER_MODE; }

export interface RequesterConfig {
  /** Daily call ceiling across the whole fleet. Always <= HARD_DAILY_CEILING (2,000). */
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
  // The hard cap is the default. NUVIZZ_DAILY_CEILING may only LOWER it (clampCeiling).
  // In enforce mode — now the default — hitting it trips the breaker and blocks further calls.
  dailyCeiling: clampCeiling(Number(process.env.NUVIZZ_DAILY_CEILING) || HARD_DAILY_CEILING),
  breakerMode: BREAKER_MODE,
  maxRetries: 4,
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 8_000,
  backoffTotalCapMs: 20_000,
};

// Runtime daily-ceiling override (Diagnostics UI → scan_config). The requester is a
// warm-instance singleton built once with DEFAULT_CONFIG, so the editable ceiling is
// applied per-invocation via this module-level override rather than rebuilding it.
// null = use the configured/default cfg.dailyCeiling. The scanner sets this from the
// live config at the start of each run (see refresh-stops-core).
let __dailyCeilingOverride: number | null = null;
export function setDailyCeilingOverride(n: number | null | undefined): void {
  __dailyCeilingOverride = (typeof n === 'number' && Number.isFinite(n) && n > 0) ? clampCeiling(n) : null;
}
export function effectiveDailyCeiling(fallback = DEFAULT_CONFIG.dailyCeiling): number {
  // Clamped on the way OUT too: a caller-supplied fallback is just another proposal.
  return clampCeiling(__dailyCeilingOverride ?? fallback);
}

/**
 * THE CEILING TO PRINT ON A SPEND GAUGE.
 *
 * Chad's Map status card read "216 / 20,000" while the breaker was tripping at 2,000 — a
 * headroom figure overstated tenfold, on the one number a dispatcher consults before turning
 * a scan cadence up. It is the specific way this can do real harm: the cold number-probe scan
 * costs ~3,000 calls, so against a 20,000 gauge it looks affordable when in fact it is ABOVE
 * the true cap and trips the breaker partway through, leaving the board half-written.
 *
 * The comment above HARD_DAILY_CEILING has claimed since v0.54.21 that "every path that
 * produces a ceiling runs through clampCeiling(), so the number on the Diagnostics pill is
 * the number actually enforced". One path did not: the board endpoint built its own
 * expression straight off the stored config and NUVIZZ_DAILY_CEILING, with a third fallback
 * number (12,000) that appears nowhere else in the system. Both the Map card and the
 * Diagnostics gauge read that field.
 *
 * Both inputs need the clamp, not just the env one. The stored Diagnostics config is bounded
 * to 2,000 when it is WRITTEN, but readScanConfig returns the raw document — so a value
 * saved before that bound existed comes back unclamped and is just as capable of printing a
 * number the breaker will not honour.
 *
 * PURE; env injected so a test can state the real production case.
 */
export function reportedDailyCeiling(configured?: any, env: Record<string, any> = process.env): number {
  // Numbers and numeric strings only. A bare Number() coercion here would read `true` as a
  // ceiling of 1 and `[1500]` as 1500 — the same family as the Number(null) is 0 bug that put
  // a midnight deadline in front of a customer. A malformed value must fall THROUGH to the
  // next proposal, not become one.
  const asCeiling = (v: any): number | null => {
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? clampCeiling(n) : null;
  };
  return asCeiling(configured)
    ?? asCeiling(env?.NUVIZZ_DAILY_CEILING)
    // No config and no env is not "unlimited" — it is the hard cap, same as DEFAULT_CONFIG.
    ?? HARD_DAILY_CEILING;
}

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
      log({ app: APP_NAME, trigger: meta.trigger ?? __callTrigger ?? 'unknown', source: meta.source, route: meta.route, tenant: meta.tenant, status: resp.status, ms, dayTotal: total, mode: cfg.breakerMode });
      // At the ceiling: enforce → trip + (next call) block; monitor → warn only.
      // The effective ceiling honors a live UI override (scan_config) over cfg.
      const ceiling = clampCeiling(__dailyCeilingOverride ?? cfg.dailyCeiling);
      if (total >= ceiling) {
        if (cfg.breakerMode === 'enforce') {
          if (!breakerOpen) {
            breakerOpen = true; breakerCheckedAt = now();
            await deps.tripCircuit(`daily ceiling ${ceiling} reached (count=${total})`);
            log({ event: 'circuit-tripped', route: meta.route, tenant: meta.tenant, dayTotal: total, ceiling });
          }
        } else if (!wouldTripLogged) {
          wouldTripLogged = true;
          log({ event: 'circuit-would-trip', mode: 'monitor', route: meta.route, tenant: meta.tenant, dayTotal: total, ceiling, msg: `WOULD trip at ${ceiling} (monitor mode — not blocking)` });
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
    return { totalThisInstance, breakerOpen, inflight: inflight.size, ceiling: clampCeiling(__dailyCeilingOverride ?? cfg.dailyCeiling), mode: cfg.breakerMode };
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
import { incrementCallCounter, readCircuit, setCircuit, etDayString } from './firestore.mts';

let __prod: ReturnType<typeof createNuvizzRequester> | null = null;

export function getNuvizzRequester() {
  if (__prod) return __prod;
  __prod = createNuvizzRequester({
    fetchImpl: (url, init) => fetch(url, init),
    // Thread full attribution through so the counter records route + app + WHY (trigger)
    // + finer source + tenant — making any spike self-explaining. app is the deployment
    // constant; trigger falls back to the entrypoint's module context, then 'unknown'.
    recordCall: (meta, n) => incrementCallCounter(etDayString(), n, {
      route: meta.route,
      tenant: meta.tenant,
      app: APP_NAME,
      trigger: meta.trigger ?? __callTrigger ?? 'unknown',
      source: meta.source,
    }),
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
