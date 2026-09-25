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

// The HTTP status each in-band SSE error type stands for: a streamed request can answer 200 and
// then fail with an error event (the streaming form of a 429 / 529), and the caller must see it as
// the failure it is.
export const STREAM_ERROR_STATUSES: Record<string, number> = {
  invalid_request_error: 400, authentication_error: 401, permission_error: 403, not_found_error: 404,
  request_too_large: 413, rate_limit_error: 429, api_error: 500, overloaded_error: 529,
};

/**
 * Fold a Messages SSE stream back into the message a non-streamed call returns, so the rest of
 * the code — and the history replayed next round — cannot tell the two apart. Every block is
 * rebuilt from its start event plus its deltas IN ORDER; a thinking block's signature arrives as
 * signature_delta and is kept whole, because a replayed block without it is refused.
 *
 * A stream that ends without message_stop is NOT a message: whatever arrived is discarded and the
 * call is a failure with no status (it may have been billed; the caller charges it as unread).
 */
export async function readMessageStream(resp: { body: any }): Promise<{ message: any | null; status: number | null; error: string | null }> {
  const reader = resp.body?.getReader?.();
  if (!reader) return { message: null, status: null, error: 'streamed response had no body' };
  const dec = new TextDecoder();
  let buf = '';
  let message: any = null;
  const partial = new Map<number, string>();
  let done = false;
  const handle = (ev: any): string | null => {
    switch (ev?.type) {
      case 'message_start':
        message = { ...ev.message, content: [] };
        return null;
      case 'content_block_start':
        if (!message) return 'content before message_start';
        message.content[ev.index] = { ...ev.content_block };
        if (ev.content_block?.type === 'tool_use' || ev.content_block?.type === 'server_tool_use') partial.set(ev.index, '');
        return null;
      case 'content_block_delta': {
        const b = message?.content?.[ev.index];
        if (!b) return `delta for a block that never started (${ev.index})`;
        const d = ev.delta || {};
        if (d.type === 'text_delta') b.text = (b.text ?? '') + d.text;
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
        else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature;
        else if (d.type === 'input_json_delta') partial.set(ev.index, (partial.get(ev.index) ?? '') + d.partial_json);
        else if (d.type === 'citations_delta') (b.citations ??= []).push(d.citation);
        return null;
      }
      case 'content_block_stop': {
        const b = message?.content?.[ev.index];
        if (b && partial.has(ev.index)) {
          const raw = partial.get(ev.index) || '';
          try { b.input = raw ? JSON.parse(raw) : {}; } catch { return `tool input for block ${ev.index} was not JSON`; }
          partial.delete(ev.index);
        }
        return null;
      }
      case 'message_delta':
        if (!message) return 'message_delta before message_start';
        Object.assign(message, ev.delta || {});
        for (const [k, v] of Object.entries(ev.usage || {})) if (v !== null && v !== undefined) (message.usage ??= {})[k] = v;
        return null;
      case 'message_stop':
        done = true;
        return null;
      case 'error':
        return `${ev.error?.type || 'error'}: ${ev.error?.message || ''}`.trim();
      default:
        return null;                         // ping, and any event type added later
    }
  };
  let failure: string | null = null;
  let failureStatus: number | null = null;
  const takeLine = (line: string) => {
    if (failure || !line.startsWith('data:')) return;
    let ev: any;
    try { ev = JSON.parse(line.slice(5).trim()); } catch { return; }
    const err = handle(ev);
    if (err) { failure = err; failureStatus = ev?.type === 'error' ? (STREAM_ERROR_STATUSES[ev.error?.type] ?? 500) : null; }
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) { takeLine(buf.slice(0, nl).replace(/\r$/, '')); buf = buf.slice(nl + 1); }
    if (end || failure) break;
  }
  if (!failure && buf) takeLine(buf.replace(/\r$/, ''));
  if (failure) { try { await reader.cancel(); } catch { /* already closed */ } return { message: null, status: failureStatus, error: `stream: ${failure}` }; }
  if (!done || !message) return { message: null, status: null, error: 'the stream ended before message_stop' };
  if (message.content.some((b: any) => b == null)) return { message: null, status: null, error: 'the stream skipped a content block' };
  return { message, status: 200, error: null };
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
    if (resp.ok && request.stream === true) {
      const r = await readMessageStream(resp);
      if (r.message) return { ok: true, httpStatus: resp.status, timedOut: false, ms: now() - t0, body: r.message, error: null };
      return { ok: false, httpStatus: r.status, timedOut: false, ms: now() - t0, body: null, error: r.error };
    }
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
