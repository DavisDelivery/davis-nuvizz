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

const DEFAULT_CONFIG = {
  dailyCeiling: Number(process.env.NUVIZZ_DAILY_CEILING) || 100000,
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
const today = () => new Date().toISOString().slice(0, 10);

function createRequester(config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const inflight = new Map();
  let breakerOpen = false;
  let breakerCheckedAt = 0;
  const breakerTtlMs = 5000;

  async function breakerIsOpen() {
    if (Date.now() - breakerCheckedAt < breakerTtlMs) return breakerOpen;
    try { breakerOpen = (await fs_db.readCircuit()).open; } catch { breakerOpen = false; }
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
      if (Number.isFinite(total) && total >= cfg.dailyCeiling && !breakerOpen) {
        breakerOpen = true; breakerCheckedAt = Date.now();
        try { await fs_db.setCircuit(true, `daily ceiling ${cfg.dailyCeiling} reached (count=${total})`, new Date().toISOString()); } catch {}
        console.warn('[nuvizz-request] circuit-tripped', JSON.stringify({ dayTotal: total, ceiling: cfg.dailyCeiling }));
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
    const maxRetries = opts.maxRetries ?? cfg.maxRetries;
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
  try { return (await fs_db.readCircuit()).open; } catch { return false; }
}

module.exports = {
  getNuvizzRequester,
  createRequester,
  breakerTripped,
  isRetryableStatus,
  computeBackoffMs,
  NuvizzCircuitOpenError,
};
