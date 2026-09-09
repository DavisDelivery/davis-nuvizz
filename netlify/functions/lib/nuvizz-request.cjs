// netlify/functions/lib/nuvizz-request.cjs
//
// SITE A (CommonJS) mirror of dispatch-map's nuvizz-request.mts — the shared
// NuVizz request wrapper. Both apps share the SAME davismarginiq Firestore
// counter (nuvizz_ops/calls__{date}) and breaker (nuvizz_ops/circuit), so the
// hard daily ceiling is fleet-wide: SITE A + SITE B + any future caller all
// count against, and are throttled by, one accountant.
//
// Behaviour mirrors the .mts: count + log every round-trip, dedupe concurrent
// identical GETs, exponential backoff with a hard cap on 429/5xx, and trip the
// breaker at the ceiling. Keep the two files in sync.

const fs_db = require('./firestore.cjs');

// The shared daily ceiling. `Number(env) || 100000` accepted an unset var, `0`, or a
// typo as ONE HUNDRED THOUSAND — a number nobody chose, ~8x what dispatch-map's
// mirror defaults to and ~30x a cold full probe. Trimmed, finite, at least 1, or the
// default; nothing else. PURE so the test can pin it.
//
// The default is 2,000 — the SAME number dispatch-map falls back to — because this app's
// own 12,000 matched nothing else in the system and the two apps spend against one counter.
// It is only what you get when nobody has decided; the saved Diagnostics setting overrides
// it below, and that is the number Chad expects to end the calls.
const DEFAULT_DAILY_CEILING = 2000;
const CEILING_SANITY_MAX = 1000000;
function parseCeiling(raw, fallback = DEFAULT_DAILY_CEILING) {
  if (raw === undefined || raw === null) return fallback;
  const str = String(raw).trim();
  if (str === '') return fallback;
  const n = Math.floor(Number(str));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

// HIS NUMBER, VERBATIM — mirrors dispatch-map's savedCeiling(). Junk resolves to the
// DEFAULT and never to the maximum: a malformed document must not buy headroom.
// PURE so the test can pin it against the .mts twin.
function savedCeiling(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return DEFAULT_DAILY_CEILING;
  return Math.min(CEILING_SANITY_MAX, v);
}

// Cached resolution of the shared setting, so this is one Firestore read per minute per
// warm instance rather than one per outbound call. A failed read KEEPS the last known
// value and retries sooner — dropping to the default on a blip would silently cut the
// budget mid-day, which is the failure dispatch-map's mirror was built to end.
const CEILING_TTL_MS = 60000;
const CEILING_RETRY_MS = 5000;
let __savedCeiling = null;
let __ceilingLoadedAtMs = 0;
let __ceilingLoadFailed = false;

async function resolveDailyCeiling(fallback) {
  const ttl = __ceilingLoadFailed ? CEILING_RETRY_MS : CEILING_TTL_MS;
  if (__ceilingLoadedAtMs === 0 || Date.now() - __ceilingLoadedAtMs >= ttl) {
    try {
      const raw = await fs_db.readScanConfigCeiling();
      // Only a number or numeric string is a proposal; anything else means "not set".
      __savedCeiling = (typeof raw === 'number' || typeof raw === 'string') && Number.isFinite(Number(raw)) && Number(raw) > 0
        ? savedCeiling(raw)
        : null;
      __ceilingLoadedAtMs = Date.now();
      __ceilingLoadFailed = false;
    } catch {
      __ceilingLoadedAtMs = Date.now();
      __ceilingLoadFailed = true;
    }
  }
  return __savedCeiling ?? fallback;
}

/** Test seam: forget the resolved setting and its freshness. */
function __resetCeilingCache() {
  __savedCeiling = null;
  __ceilingLoadedAtMs = 0;
  __ceilingLoadFailed = false;
}

/**
 * PURE: is an OPEN breaker still binding, given today's count and the ceiling now in force?
 * Mirrors dispatch-map's circuitStillBinding — raising the setting must release a trip taken
 * at the old number in BOTH apps, or the fleet stays halted on one app's stale latch.
 * When we cannot tell, it stays OPEN: releasing on a bad read means uncapped vendor spend.
 */
function circuitStillBinding(open, dayCount, ceiling) {
  if (!open) return false;
  if (!Number.isFinite(dayCount) || !Number.isFinite(ceiling) || ceiling <= 0) return true;
  return dayCount >= ceiling;
}

const DEFAULT_CONFIG = {
  dailyCeiling: parseCeiling(process.env.NUVIZZ_DAILY_CEILING),
  maxRetries: 4,
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 8000,
  backoffTotalCapMs: 20000,
};

class NuvizzCircuitOpenError extends Error {
  constructor(msg) { super(msg); this.name = 'NuvizzCircuitOpenError'; }
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function computeBackoffMs(attempt, cfg) {
  const raw = cfg.backoffBaseMs * Math.pow(cfg.backoffFactor, attempt);
  const capped = Math.min(raw, cfg.backoffMaxMs);
  const jitter = 0.9 + ((attempt * 37) % 20) / 100;
  return Math.round(capped * jitter);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ET (America/New_York) calendar day — MUST match dispatch-map's etDayString so
// BOTH apps increment the SAME shared nuvizz_ops/calls__{date} bucket. Plain UTC
// (toISOString) here split the day's count across two docs during the 8pm–midnight
// ET window (UTC already on the next date), making the displayed total jump.
const today = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

function createRequester(config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const inflight = new Map();
  let breakerOpen = false;
  let breakerCheckedAt = 0;
  const breakerTtlMs = 5000;

  // The ceiling in force for THIS invocation: the saved Diagnostics setting when there is
  // one, otherwise this app's configured fallback. Resolved before every budget decision so
  // the two apps bind at the same number.
  async function ceilingNow() {
    return resolveDailyCeiling(cfg.dailyCeiling);
  }

  async function breakerIsOpen() {
    if (Date.now() - breakerCheckedAt < breakerTtlMs) return breakerOpen;
    try {
      const c = await fs_db.readCircuit();
      if (!c.open) { breakerOpen = false; }
      else {
        // Self-healing, mirroring dispatch-map: a trip taken at a ceiling that has since been
        // raised above the day's count is stale, and leaving it latched would keep the fleet
        // halted until ET midnight for a reason that no longer exists. An unreadable count
        // leaves it OPEN — the two mistakes are not symmetrical.
        const ceiling = await ceilingNow();
        let dayCount = NaN;
        try { dayCount = await fs_db.readCallCounter(today()); } catch { dayCount = NaN; }
        breakerOpen = circuitStillBinding(true, dayCount, ceiling);
        if (!breakerOpen) {
          const reason = `released: day count ${dayCount} is under the ceiling now in force (${ceiling})`;
          try { await fs_db.setCircuit(false, reason, new Date().toISOString()); } catch { /* the read still returns closed */ }
          console.warn('[nuvizz-request] circuit-released', JSON.stringify({ dayCount, ceiling, priorReason: c.reason ?? null }));
        }
      }
    } catch { breakerOpen = false; }
    breakerCheckedAt = Date.now();
    return breakerOpen;
  }

  async function doFetchWithRetry(url, init, maxRetries, meta) {
    let attempt = 0;
    let sleptTotal = 0;
    while (true) {
      const started = Date.now();
      let resp;
      try {
        resp = await fetch(url, init);
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        const wait = computeBackoffMs(attempt, cfg);
        if (sleptTotal + wait > cfg.backoffTotalCapMs) throw err;
        sleptTotal += wait; attempt++; await sleep(wait); continue;
      }
      const ms = Date.now() - started;
      let total = NaN;
      try { total = await fs_db.incrementCallCounter(today(), 1); } catch { /* counting must never break a scan */ }
      console.log('[nuvizz-request]', JSON.stringify({ route: meta.route, tenant: meta.tenant, status: resp.status, ms, dayTotal: total }));
      // ONE expression decides the effective ceiling, and it is the saved setting when there
      // is one. Reading cfg.dailyCeiling straight is how this app tripped at its own 12,000
      // while dispatch-map bound the same shared counter at Chad's number.
      const ceiling = await ceilingNow();
      if (Number.isFinite(total) && total >= ceiling && !breakerOpen) {
        breakerOpen = true; breakerCheckedAt = Date.now();
        try { await fs_db.setCircuit(true, `daily ceiling ${ceiling} reached (count=${total})`, new Date().toISOString()); } catch {}
        console.warn('[nuvizz-request] circuit-tripped', JSON.stringify({ dayTotal: total, ceiling }));
      }
      if (!isRetryableStatus(resp.status) || attempt >= maxRetries) return resp;
      const wait = computeBackoffMs(attempt, cfg);
      if (sleptTotal + wait > cfg.backoffTotalCapMs) return resp;
      sleptTotal += wait; attempt++; await sleep(wait);
    }
  }

  async function request(url, opts, meta) {
    if (await breakerIsOpen()) {
      throw new NuvizzCircuitOpenError(`NuVizz circuit breaker open — refusing ${meta.route} (${meta.tenant})`);
    }
    const method = (opts.method || 'GET').toUpperCase();
    const init = { method, headers: opts.headers, body: opts.body ?? undefined };
    // Retry ONLY what is safe to replay. A POST that came back 5xx (or whose socket
    // dropped) may already have been applied server-side; replaying it up to 4x is how
    // one /user/list pull becomes five counted calls. GET keeps the backoff, as does
    // anything the caller explicitly marks { idempotent: true }.
    const replayable = method === 'GET' || opts.idempotent === true;
    const maxRetries = replayable ? (opts.maxRetries ?? cfg.maxRetries) : 0;
    if (method === 'GET') {
      const key = `${method} ${url}`;
      const existing = inflight.get(key);
      if (existing) return existing.then((r) => r.clone());
      const p = doFetchWithRetry(url, init, maxRetries, meta).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p.then((r) => r.clone());
    }
    return doFetchWithRetry(url, init, maxRetries, meta);
  }

  return { request };
}

let __prod = null;
function getNuvizzRequester() {
  if (!__prod) __prod = createRequester();
  return __prod;
}

async function breakerTripped() {
  // Self-healing, same rule as the per-call path: a caller must not stand down on a trip
  // whose ceiling has since been raised above the day's spend.
  try {
    const c = await fs_db.readCircuit();
    if (!c.open) return false;
    const ceiling = await resolveDailyCeiling(DEFAULT_CONFIG.dailyCeiling);
    let dayCount = NaN;
    try { dayCount = await fs_db.readCallCounter(today()); } catch { return true; }
    if (circuitStillBinding(true, dayCount, ceiling)) return true;
    try { await fs_db.setCircuit(false, `released: day count ${dayCount} is under the ceiling now in force (${ceiling})`, new Date().toISOString()); } catch { /* read still returns closed */ }
    return false;
  } catch { return false; }
}

module.exports = {
  getNuvizzRequester,
  createRequester,
  breakerTripped,
  isRetryableStatus,
  computeBackoffMs,
  parseCeiling,
  savedCeiling,
  resolveDailyCeiling,
  circuitStillBinding,
  __resetCeilingCache,
  CEILING_SANITY_MAX,
  DEFAULT_DAILY_CEILING,
  NuvizzCircuitOpenError,
};
