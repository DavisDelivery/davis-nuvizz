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

// ── The ceiling: YOUR NUMBER IS THE NUMBER ──────────────────────────────────
//
// Chad, 2026-09-09, after v0.98.4 finally made the saved setting reach the code that spends:
// "I want the number I set in diagnostics to be the number ... Whatever number it's set to
// is where I want the calls to end."
//
// So there is no longer a cap he did not choose. This file has now twice shipped a
// Diagnostics field that took one number and enforced another — 2,000 under a 20,000 gauge
// (v0.70.2), then 3,000 in the field against 2,000 in the breaker (v0.98.4) — and both times
// the fault was the same shape: a constant in here outranking the person who owns the spend.
// A setting that silently loses an argument with a constant is not a setting.
//
// Two numbers remain, and neither is a cap on him:
//
//   DEFAULT_DAILY_CEILING (2,000) — what you get when NOBODY has decided. The env var and
//   any caller-supplied fallback are still bounded by it, so nothing moves on its own: a
//   deploy spends exactly what it spent yesterday until somebody saves a setting. A normal
//   day is a few hundred calls, so this is already ~10x headroom.
//
//   CEILING_SANITY_MAX (1,000,000) — not policy, arithmetic. Above this a value is not an
//   intent, it is a typo or a corrupted document, and a "ceiling" of 1e9 is indistinguishable
//   from no ceiling at all. Every number a person would actually type is honoured verbatim.
//
// WHAT THIS GIVES UP, said plainly rather than buried, because it is a real trade and he
// made it with the cost in front of him. 2,000 was originally chosen to sit BELOW the
// ~3,000-call cold number-probe scan so that scan could not complete by accident. There is
// now no automatic backstop against a runaway loop: a mistyped 30,000 is a 10x day and
// nothing in the code will stop it. What remains is (a) the permission rule in CLAUDE.md,
// (b) that only `manual=1` / `?date=` / `?days=` reach the probe path at all, (c) the editor
// warning above CEILING_ADVISORY, and (d) that lowering the number takes effect immediately —
// since v0.98.4 a ceiling moved above the day's count releases the breaker, and one moved
// below it binds again, so a mistake is reversible within a minute rather than at midnight.
// The backstop was never cheap anyway: it did not prevent the spend, it stopped the scan
// PARTWAY and left the board half-written, which on a 700-stop morning is worse.
export const DEFAULT_DAILY_CEILING = 2_000;
export const CEILING_SANITY_MAX = 1_000_000;

// Above this the editor SAYS something — it does not refuse. ~3,000 is what a cold
// number-probe scan costs, so a ceiling past it is one that would let that scan run to
// completion. That is the fact worth putting in front of somebody as they type, and it is
// advice, not a gate.
export const CEILING_ADVISORY = 3_000;

/**
 * PURE: a SAVED SETTING — his number, verbatim, floored to a whole call.
 *
 * Bounded only by arithmetic sanity: at least 1, at most CEILING_SANITY_MAX. Junk resolves
 * to the DEFAULT and never to the maximum, because a malformed value must not buy headroom —
 * `Number(null)` is 0 and `Number(true)` is 1, and this repo has shipped both as though they
 * were decisions.
 */
export function savedCeiling(n: any): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return DEFAULT_DAILY_CEILING;
  return Math.min(CEILING_SANITY_MAX, v);
}

/** Prior name, kept so no existing call site silently starts meaning something new. */
export const clampCeiling = savedCeiling;

/**
 * PURE: an AMBIENT proposal — the env var, or a fallback a caller passed itself — clamped
 * into [1, DEFAULT_DAILY_CEILING]. These may only ever LOWER the ceiling.
 *
 * This is what keeps the raise behind Chad's switch rather than behind a deploy: the site
 * has run NUVIZZ_DAILY_CEILING=20,000 in the past, and if the env var could reach the new
 * hard cap then shipping this file would have raised production's spend by 50% with nobody
 * deciding anything.
 */
export function clampAmbientCeiling(n: any): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return DEFAULT_DAILY_CEILING;
  return Math.min(DEFAULT_DAILY_CEILING, v);
}

export function breakerMode(): BreakerMode { return BREAKER_MODE; }

export interface RequesterConfig {
  /** Daily call ceiling across the whole fleet. The saved setting when there is one. */
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
  /** Hard deadline on ONE network round-trip. 0 disables (not recommended — see below). */
  requestTimeoutMs: number;
  /** How many times a TIMED-OUT attempt may be retried (separate from the 5xx policy). */
  maxTimeoutRetries: number;
}

export const DEFAULT_CONFIG: RequesterConfig = {
  // The DEFAULT is the default. NUVIZZ_DAILY_CEILING may only LOWER it — only a saved
  // Diagnostics setting sets the real ceiling, and it arrives via the override below.
  // In enforce mode — the default — hitting the ceiling trips the breaker and blocks further calls.
  dailyCeiling: clampAmbientCeiling(process.env.NUVIZZ_DAILY_CEILING),
  breakerMode: BREAKER_MODE,
  maxRetries: 4,
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 8_000,
  backoffTotalCapMs: 20_000,
  // A REQUEST THAT NEVER ANSWERS USED TO WEDGE THE WHOLE SCAN (2026-09-10).
  //
  // Chad, 8:01pm: "Manual Refresh button is not working. Timed out and said it wouldn't
  // update." The run ledger said exactly what happened: the manual run STARTED at 20:01,
  // recorded ZERO calls, wrote no board, and was still open seven minutes later — while every
  // other full run that day finished in 41-72 seconds. `fetch` here carried no signal, so one
  // request NuVizz accepted and never answered simply hung, and because a call is counted only
  // AFTER its response returns, the stall was invisible to every counter and log we keep. The
  // function sat there until the platform killed it at fifteen minutes; nothing closed the run
  // row (there is an identical orphan from 09-08), and the button told a dispatcher the board
  // would refresh automatically, which it never would.
  //
  // Thirty seconds, because a saved-search pull of a whole day is ~10-20s and a vendor that has
  // not answered in thirty is not about to. ONE retry on a timeout and no more: a stall is not a
  // 503, and the scan finishing with an honest error beats it hanging — a failed run leaves the
  // last good board in place, records the failure, and the next tick tries again in minutes.
  requestTimeoutMs: Number(process.env.NUVIZZ_REQUEST_TIMEOUT_MS) || 30_000,
  maxTimeoutRetries: 1,
};

/** True when this rejection is OUR deadline firing rather than the caller cancelling. */
export function isTimeoutAbort(err: any, callerSignal?: AbortSignal | null): boolean {
  if (callerSignal?.aborted) return false;
  const name = String(err?.name || '');
  return name === 'TimeoutError' || name === 'AbortError';
}

// Runtime daily-ceiling override (Diagnostics UI → scan_config). The requester is a
// warm-instance singleton built once with DEFAULT_CONFIG, so the editable ceiling is
// applied per-invocation via this module-level override rather than rebuilding it.
// null = use the configured/default cfg.dailyCeiling.
//
// ── WHO SETS IT, AND THE HOLE THAT WAS ──────────────────────────────────────
//
// Chad, 2026-09-09: "I have it set at 3000 as you can see but stopping me at 2000."
// His Map card read "NuVizz calls: 2,000 / 3,000 (enforce, halted)" and the banner under
// it read "daily NuVizz call ceiling reached (2000/2000) — write refused". BOTH numbers
// were produced by this file, from the same saved setting, and they disagreed.
//
// Because until now exactly ONE caller ever set this override: refresh-stops-core, at the
// top of a scan run. This is a MODULE-LEVEL variable, and Netlify functions are separate
// processes — nuvizz-write.mts has its own copy of this module and nothing in it had ever
// called the setter, so the override there was permanently null and effectiveDailyCeiling
// fell through to clampAmbientCeiling(), which is bounded by DEFAULT_DAILY_CEILING. 2,000.
// Every path that did NOT run inside a scan enforced 2,000 no matter what Chad saved.
//
// The display paths were right the whole time — reportedDailyCeiling() READS the stored
// config, so the gauge printed 3,000 — which is why the two numbers on one screen came from
// one setting and did not match. And the damage is not confined to the write endpoint: the
// per-call trip below uses this same expression, so a write path tripped the SHARED,
// fleet-wide Firestore breaker at 2,000 and halted the scanner too, in a process that knew
// perfectly well the ceiling was 3,000.
//
// A setting is not a setting if honouring it depends on which entrypoint you came in
// through. The override is now HYDRATED from the stored config by anything that needs it
// (hydrateDailyCeiling below) rather than waiting to be told, so the number is resolved from
// the same document in every process.
let __dailyCeilingOverride: number | null = null;
let __ceilingLoadedAtMs = 0;
let __ceilingLoadFailed = false;
export function setDailyCeilingOverride(n: number | null | undefined): void {
  __dailyCeilingOverride = (typeof n === 'number' && Number.isFinite(n) && n > 0) ? clampCeiling(n) : null;
  // A caller that sets this has just resolved it from the stored config itself (the scanner
  // reads scan_config for the schedule anyway), so treat it as a fresh load and don't make
  // the hydrator go read the same document again this minute.
  __ceilingLoadedAtMs = Date.now();
  __ceilingLoadFailed = false;
}

/** Test seam: forget both the value and its freshness. */
export function __resetDailyCeilingCache(): void {
  __dailyCeilingOverride = null;
  __ceilingLoadedAtMs = 0;
  __ceilingLoadFailed = false;
}

// How long a hydrated ceiling is trusted before we re-read the config document. A Firestore
// read is not a NuVizz call and costs nothing against the budget this file guards, but there
// is no reason to make one per outbound request either. A minute means a save in Diagnostics
// takes effect within a minute everywhere, which is what "I just changed the setting" needs.
export const CEILING_TTL_MS = 60_000;

// How long to wait before retrying a config read that FAILED. Without this, a throw left the
// load time unstamped and every subsequent request re-asked Firestore — turning a Firestore
// outage into one extra failing request per NuVizz call, on the exact path that is supposed to
// keep working from the last known good value. Short, because the ceiling matters, but not
// zero.
export const CEILING_RETRY_MS = 5_000;

/**
 * Resolve the SAVED ceiling into the module override, at most once per TTL per warm instance.
 * Returns the ceiling now in force.
 *
 * `readConfigured` yields the raw stored `dailyCeiling` (number | null | undefined — the
 * document is returned unvalidated, so junk must be survivable). Injected, so this is
 * testable with no Firestore.
 *
 * A READ FAILURE KEEPS WHAT WE HAVE. Falling back to the default on a transient Firestore
 * error would silently drop Chad's ceiling to 2,000 mid-day — the exact failure this
 * function exists to end — so a throw leaves the previous value alone and we retry after
 * CEILING_RETRY_MS rather than pretending we learned something.
 */
export async function hydrateDailyCeiling(
  readConfigured: () => Promise<any>,
  opts: { now?: () => number; ttlMs?: number; force?: boolean } = {},
): Promise<number> {
  const now = opts.now ?? Date.now;
  const baseTtl = opts.ttlMs ?? CEILING_TTL_MS;
  // A failed load is retried sooner than a good one is refreshed, but not on every call.
  const ttlMs = __ceilingLoadFailed ? Math.min(baseTtl, CEILING_RETRY_MS) : baseTtl;
  if (opts.force || __ceilingLoadedAtMs === 0 || now() - __ceilingLoadedAtMs >= ttlMs) {
    try {
      const raw = await readConfigured();
      // Only a number or a numeric string is a proposal; anything else means "not set", which
      // is the DEFAULT and not the maximum. Same coercion rule as reportedDailyCeiling — a
      // malformed value must fall through, never become a ceiling.
      const n = (typeof raw === 'number' || typeof raw === 'string') ? Number(raw) : NaN;
      __dailyCeilingOverride = Number.isFinite(n) && n > 0 ? clampCeiling(n) : null;
      __ceilingLoadedAtMs = now();
      __ceilingLoadFailed = false;
    } catch {
      // Keep the previous value and try again after CEILING_RETRY_MS — not on the next call.
      __ceilingLoadedAtMs = now();
      __ceilingLoadFailed = true;
    }
  }
  return effectiveDailyCeiling();
}
export function effectiveDailyCeiling(fallback = DEFAULT_CONFIG.dailyCeiling): number {
  // The override is Chad's saved setting and was clamped to HARD on the way in. A
  // caller-supplied fallback is just another ambient proposal and may only LOWER the default —
  // otherwise any code path could vote itself more budget by passing a bigger number.
  return __dailyCeilingOverride ?? clampAmbientCeiling(fallback);
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
 * The comment above the ceiling constants has claimed since v0.54.21 that "every path that
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
  const asCeiling = (v: any, clamp: (x: any) => number): number | null => {
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? clamp(n) : null;
  };
  return asCeiling(configured, clampCeiling)
    // The env var is ambient, so it can only lower — same rule the breaker enforces.
    ?? asCeiling(env?.NUVIZZ_DAILY_CEILING, clampAmbientCeiling)
    // No config and no env is not "unlimited", and it is not the maximum either: it is the
    // DEFAULT, the same number DEFAULT_CONFIG lands on.
    ?? DEFAULT_DAILY_CEILING;
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
  /**
   * Read the SAVED daily ceiling (raw stored value) so this process enforces the number
   * Chad set rather than the ambient default. Optional: omitted (tests, and any caller that
   * has already set the override itself) means "don't go looking".
   */
  readConfiguredCeiling?: () => Promise<any>;
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

/**
 * PURE: is an OPEN breaker still binding, given today's count and the ceiling now in force?
 *
 * Raising the ceiling has to release a breaker that tripped at the old, lower number, or the
 * setting does nothing until midnight. That was the second half of what Chad hit: the trip is
 * a latch in a Firestore document, `circuitFromDoc` only expires it on the ET day rollover,
 * and it was stamped "ceiling 2000 reached" — so even with the resolution above fixed, a
 * board halted at 2,000 would have stayed halted all day against a 3,000 ceiling, for a
 * reason that no longer existed. The breaker's job is to say "the day's spend is at the cap";
 * once the cap moves above the spend, that sentence is simply false.
 *
 * WHEN WE CANNOT TELL, IT STAYS OPEN. An unreadable count or a nonsense ceiling releases
 * nothing: the two mistakes are not symmetrical. Staying halted costs a late board and a
 * dispatcher who rings Chad; releasing on a Firestore blip costs uncapped spend against the
 * vendor, which is the entire thing this file exists to prevent.
 */
export function circuitStillBinding(open: boolean, dayCount: number, ceiling: number): boolean {
  if (!open) return false;
  if (!Number.isFinite(dayCount) || !Number.isFinite(ceiling) || ceiling <= 0) return true;
  return dayCount >= ceiling;
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

  // Pull Chad's saved ceiling into this process before any budget decision is made with it.
  // TTL-guarded inside hydrateDailyCeiling, so this is at most one config read per minute per
  // warm instance and none at all for a caller that already set the override.
  async function ensureCeiling(): Promise<void> {
    if (!deps.readConfiguredCeiling) return;
    await hydrateDailyCeiling(deps.readConfiguredCeiling, { now });
  }

  async function doFetchWithRetry(url: string, init: any, maxRetries: number, meta: NvRequestMeta): Promise<Response> {
    let attempt = 0;
    let sleptTotal = 0;
    let timeouts = 0;
    // attempt 0 = first try; up to maxRetries additional tries.
    while (true) {
      const started = now();
      let resp: Response;
      // A FRESH DEADLINE PER ATTEMPT, merged with whatever the caller passed. Without this a
      // single unanswered request hangs the scan until the platform kills it (see the config).
      const deadline = deadlineSignal(init.signal, cfg.requestTimeoutMs);
      try {
        resp = await deps.fetchImpl(url, { ...init, signal: deadline.signal });
      } catch (err) {
        deadline.cancel();
        // The CALLER cancelling is final — their budget, their decision, never retried.
        if (init.signal?.aborted) throw err;
        // Our own deadline: a stall, not a 503. Logged (a timed-out round-trip is invisible to
        // the call counter, which only counts answered requests) and retried at most once.
        if (isTimeoutAbort(err, init.signal)) {
          timeouts++;
          log({ app: APP_NAME, trigger: meta.trigger ?? __callTrigger ?? 'unknown', source: meta.source, route: meta.route, tenant: meta.tenant, status: 0, ms: now() - started, dayTotal: null, mode: cfg.breakerMode, timeoutMs: cfg.requestTimeoutMs });
          if (timeouts > cfg.maxTimeoutRetries || attempt >= maxRetries) {
            throw new Error(`NuVizz ${meta.route} did not answer within ${cfg.requestTimeoutMs}ms (${timeouts} attempt(s)) — failing the call so the scan can finish instead of hanging`);
          }
          const wait = computeBackoffMs(attempt, cfg);
          sleptTotal += wait; attempt++;
          await sleep(wait);
          continue;
        }
        // Network error — treat like a retryable 5xx.
        if (attempt >= maxRetries) throw err;
        const wait = computeBackoffMs(attempt, cfg);
        if (sleptTotal + wait > cfg.backoffTotalCapMs) throw err;
        sleptTotal += wait; attempt++;
        await sleep(wait);
        continue;
      }
      deadline.cancel();
      const ms = now() - started;
      // Count + log every actual network round-trip (success or failure).
      const total = await deps.recordCall(meta, 1);
      totalThisInstance++;
      log({ app: APP_NAME, trigger: meta.trigger ?? __callTrigger ?? 'unknown', source: meta.source, route: meta.route, tenant: meta.tenant, status: resp.status, ms, dayTotal: total, mode: cfg.breakerMode });
      // At the ceiling: enforce → trip + (next call) block; monitor → warn only.
      // ONE expression decides the effective ceiling, and it is the same one the gauge prints
      // (effectiveDailyCeiling): Chad's saved override wins, otherwise the requester's own
      // config as an ambient proposal. Rebuilding the expression here is exactly how v0.70.2
      // ended up with a gauge reading 20,000 while the breaker tripped at 2,000.
      const ceiling = effectiveDailyCeiling(cfg.dailyCeiling);
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
    // Resolve the saved ceiling FIRST: both the breaker read below (which releases a trip the
    // ceiling has outgrown) and the trip check in doFetchWithRetry measure against it.
    await ensureCeiling();
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
    return { totalThisInstance, breakerOpen, inflight: inflight.size, ceiling: effectiveDailyCeiling(cfg.dailyCeiling), mode: cfg.breakerMode };
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
import { deadlineSignal } from './fetch-deadline.mts';
export { deadlineSignal };
import { incrementCallCounter, readCircuit, setCircuit, etDayString, readScanConfig, readCallStats, isFirestoreEnabled } from './firestore.mts';

/**
 * The stored ceiling, straight off the Diagnostics document. Raw and unvalidated on purpose —
 * hydrateDailyCeiling does the coercion and the clamp, in ONE place, so a value saved before
 * a bound existed cannot slip past by arriving through a different door.
 */
async function readStoredCeiling(): Promise<any> {
  // Firestore off means there IS no stored setting, which is an answer — the DEFAULT — and
  // not a failure. Letting getDoc throw here would mark every resolve as failed and keep
  // re-asking a store that is switched off.
  if (!isFirestoreEnabled()) return undefined;
  const cfg = await readScanConfig();
  return (cfg as any)?.dailyCeiling;
}

/** Hydrate this process's ceiling from the stored config. Safe to call from any entrypoint. */
export async function resolveDailyCeiling(): Promise<number> {
  return hydrateDailyCeiling(readStoredCeiling);
}

/**
 * Read the breaker, and RELEASE it if the ceiling has moved above the day's count.
 *
 * The write is not bookkeeping: an open flag left in Firestore is read by the parent app too
 * (one shared nuvizz_ops/circuit), and a breaker whose real position lives only in this
 * process's memory is a switch nobody can read. So the release is persisted with a reason
 * saying what freed it.
 */
async function readCircuitSelfHealing(): Promise<boolean> {
  const c = await readCircuit();
  if (!c.open) return false;
  const ceiling = await resolveDailyCeiling();
  let dayCount = NaN;
  try { dayCount = (await readCallStats(etDayString())).count; } catch { return true; }
  if (circuitStillBinding(true, dayCount, ceiling)) return true;
  const reason = `released: day count ${dayCount} is under the ceiling now in force (${ceiling})`;
  try { await setCircuit(false, reason, new Date().toISOString()); } catch { /* the read still returns closed */ }
  console.warn('[nuvizz-request] circuit-released', JSON.stringify({ dayCount, ceiling, priorReason: c.reason ?? null }));
  return false;
}

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
    isCircuitOpen: readCircuitSelfHealing,
    tripCircuit: (reason) => setCircuit(true, reason, new Date().toISOString()),
    // Every process resolves the SAME saved number. Before this, only the scanner did.
    readConfiguredCeiling: readStoredCeiling,
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
  // Self-healing, same as the per-call path: a scan must not keep skipping the whole run
  // because of a trip whose ceiling has since been raised above the day's spend.
  try { return await readCircuitSelfHealing(); } catch { return false; }
}
