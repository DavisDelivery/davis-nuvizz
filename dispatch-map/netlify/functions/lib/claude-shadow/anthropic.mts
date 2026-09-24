// lib/claude-shadow/anthropic.mts — THE SHADOW PLANNER'S ONLY DOOR TO A MODEL, AND WHAT IT COST.
//
// Plain fetch to the Messages API, no SDK — the same choice anthropic-routing.mts made, so the
// functions bundle carries no new dependency and scripts/check-shadow-isolation.mjs can prove,
// by reading this file, that the only host the shadow planner's server code talks to besides
// Firestore is api.anthropic.com.
//
// COST IS COMPUTED FROM THE RESPONSE, NEVER FROM AN ESTIMATE. Every call returns `usage`, and
// usageCost() prices exactly those counts. A model with no row in PRICES_PER_MTOK prices to
// null with the reason spelled out, rather than borrowing a neighbour's rate: a dollar figure
// on the Shadow tab is a statement of fact, and a guessed one is worse than none.
//
// Prices, $ per million tokens, for the model this was built against (claude-opus-5-5):
//   input 4.00 · output 20.00 · 5-minute cache write 5.00 · 1-hour cache write 8.00 ·
//   cache read 0.20. The two cache-write rates are the standard 1.25× / 2× multipliers on
//   input; the reference this was checked against marks them "confirm at launch", so treat
//   the cache-write line as the least certain number on the page.

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export interface Rates { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }

export const PRICES_PER_MTOK: Record<string, Rates> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
};

export interface UsageCost {
  usd: number | null;
  basis: string;
  tokens: { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number };
}

const n = (v: any): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Price one response's `usage` block. The 5m/1h split comes from usage.cache_creation when the
 * API returns it; without that breakdown every cache write is priced at the 5-minute rate and
 * the basis says so, because that is the TTL every shadow request asks for.
 */
export function usageCost(model: string, usage: any): UsageCost {
  const cc = usage?.cache_creation;
  const hasSplit = cc && typeof cc === 'object'
    && ('ephemeral_5m_input_tokens' in cc || 'ephemeral_1h_input_tokens' in cc);
  const tokens = {
    input: n(usage?.input_tokens),
    output: n(usage?.output_tokens),
    cacheWrite5m: hasSplit ? n(cc.ephemeral_5m_input_tokens) : n(usage?.cache_creation_input_tokens),
    cacheWrite1h: hasSplit ? n(cc.ephemeral_1h_input_tokens) : 0,
    cacheRead: n(usage?.cache_read_input_tokens),
  };
  const r = PRICES_PER_MTOK[model];
  if (!r) return { usd: null, basis: `no price table for ${model} — tokens are real, the dollar figure is not computed`, tokens };
  const usd = (tokens.input * r.input + tokens.output * r.output + tokens.cacheWrite5m * r.cacheWrite5m
    + tokens.cacheWrite1h * r.cacheWrite1h + tokens.cacheRead * r.cacheRead) / 1e6;
  const basis = hasSplit || tokens.cacheWrite5m === 0
    ? `${model} list price, from the response's usage`
    : `${model} list price, from the response's usage; cache writes priced at the 5-minute rate (no TTL split in the response)`;
  return { usd: Math.round(usd * 1e6) / 1e6, basis, tokens };
}

export interface CallResult {
  ok: boolean;
  httpStatus: number | null;
  // true only when OUR deadline aborted it: the request had left, so it may still be billed.
  timedOut: boolean;
  ms: number;
  body: any | null;
  error: string | null;
}

/**
 * One POST to the Messages API. Never throws: a network failure, a timeout and a non-2xx all
 * come back as ok:false with the reason, so the caller always has something true to record.
 */
export async function callMessages(
  request: Record<string, any>,
  opts: { apiKey: string; timeoutMs: number; fetchImpl?: typeof fetch; now?: () => number },
): Promise<CallResult> {
  const f = opts.fetchImpl || fetch;
  const now = opts.now || (() => Date.now());
  const t0 = now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const resp = await f(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-api-key': opts.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: ac.signal,
    });
    const text = await resp.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* reported below */ }
    if (!resp.ok) {
      const msg = body?.error?.message || text.slice(0, 300) || `HTTP ${resp.status}`;
      return { ok: false, httpStatus: resp.status, timedOut: false, ms: now() - t0, body, error: String(msg) };
    }
    if (!body) return { ok: false, httpStatus: resp.status, timedOut: false, ms: now() - t0, body: null, error: 'response was not JSON' };
    return { ok: true, httpStatus: resp.status, timedOut: false, ms: now() - t0, body, error: null };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, httpStatus: null, timedOut: aborted, ms: now() - t0, body: null, error: aborted ? `timed out after ${opts.timeoutMs}ms` : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
