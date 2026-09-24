// test/claude-shadow-core.test.mjs — THE CLAUDE SHADOW PLANNER'S FIRST CUT: its switches, its
// write gateway, its cost arithmetic, and its one test call.
//
// Every test here names the thing that would go wrong on a real night if it failed: a write
// that lands on the dispatcher's board, a dollar figure that is a guess, a switch that is off
// but still spends, a "test call" that quietly made two.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { claudeShadowEnabled, shadowModel, DEFAULT_SHADOW_MODEL, SHADOW_PREFIX } from '../netlify/functions/lib/claude-shadow/config.mts';
import { assertShadowPath, shadowSet, shadowPatch, shadowCreate, shadowDelete, ShadowPathError } from '../netlify/functions/lib/claude-shadow/store.mts';
import { usageCost, callMessages, MESSAGES_URL } from '../netlify/functions/lib/claude-shadow/anthropic.mts';
import { buildProbeRequest, readProbeResult, PROBE_TOOL } from '../netlify/functions/lib/claude-shadow/probe.mts';

// ── switches ──────────────────────────────────────────────────────────────────

test('CLAUDE_SHADOW is ON unless it says an off-word — a typo must never be why the planner went quiet', () => {
  assert.equal(claudeShadowEnabled({}), true, 'unset = on');
  for (const off of ['off', 'OFF', ' 0 ', 'false', 'no']) assert.equal(claudeShadowEnabled({ CLAUDE_SHADOW: off }), false, off);
  for (const typo of ['of', 'disable', 'nope', 'fals', 'on', '1', 'true']) assert.equal(claudeShadowEnabled({ CLAUDE_SHADOW: typo }), true, typo);
});

test('the model is claude-opus-5-5 by default; CLAUDE_SHADOW_MODEL overrides it; a malformed value falls back AND is reported', () => {
  assert.deepEqual(shadowModel({}), { model: 'claude-opus-5-5', source: 'default', rejected: null });
  assert.equal(DEFAULT_SHADOW_MODEL, 'claude-opus-5-5');
  assert.deepEqual(shadowModel({ CLAUDE_SHADOW_MODEL: 'claude-opus-5' }), { model: 'claude-opus-5', source: 'env', rejected: null });
  assert.deepEqual(shadowModel({ CLAUDE_SHADOW_MODEL: 'opus 5.5 please' }), { model: 'claude-opus-5-5', source: 'default', rejected: 'opus 5.5 please' });
});

test('moving the ROUTER\'s model (ANTHROPIC_MODEL) does not move the shadow\'s', () => {
  assert.equal(shadowModel({ ANTHROPIC_MODEL: 'claude-opus-4-8' }).model, 'claude-opus-5-5');
});

// ── the write gateway ────────────────────────────────────────────────────────

test('THE GATEWAY REFUSES a write to the board, att_plan, the roster and nuvizz_ops — before any network call', async () => {
  const fake = installFirestoreFake({}, () => { throw new Error('no vendor call expected'); });
  try {
    for (const p of [
      'nuvizz_stop_index/davis__2026-09-25/stops/007174397',
      'att_plan/davis__2026-09-25',
      'nuvizz_load_roster/davis__2026-09-25',
      'nuvizz_ops/scan_config',
      'customer_notes/acme',
      'claude_shadowX/doc',        // near miss: no underscore after the prefix stem
      'claude_shadow_/doc',        // the bare prefix is not a collection name
      'claude_shadow_runs',        // a collection path, not a document
      '/claude_shadow_runs/x',     // absolute
      'claude_shadow_runs/../customer_notes/x',
      '',
    ]) {
      await assert.rejects(() => shadowSet(p, { x: 1 }), ShadowPathError, `shadowSet ${p}`);
      await assert.rejects(() => shadowPatch(p, { x: 1 }), ShadowPathError, `shadowPatch ${p}`);
      await assert.rejects(() => shadowCreate(p, { x: 1 }), ShadowPathError, `shadowCreate ${p}`);
      await assert.rejects(() => shadowDelete(p), ShadowPathError, `shadowDelete ${p}`);
    }
    assert.equal(fake.log.sets.length + fake.log.commits.length + fake.log.deletes.length, 0, 'nothing reached Firestore');
  } finally { fake.restore(); }
});

test('THE GATEWAY WRITES inside claude_shadow_* and only there', async () => {
  const fake = installFirestoreFake({}, () => { throw new Error('no vendor call expected'); });
  try {
    assert.equal(await shadowSet('claude_shadow_meta/probe_last', { a: 1 }), true);
    assert.equal(await shadowCreate('claude_shadow_probes/2026-09-24T21:30:00.000Z', { a: 1 }), true);
    assert.equal(await shadowCreate('claude_shadow_probes/2026-09-24T21:30:00.000Z', { a: 2 }), false, 'a claim is taken once');
    assert.deepEqual(fake.store.get('claude_shadow_meta/probe_last'), { a: 1 });
    for (const k of fake.store.keys()) assert.ok(k.startsWith(SHADOW_PREFIX), `wrote ${k}`);
  } finally { fake.restore(); }
});

test('assertShadowPath returns the path it was given when it is legal', () => {
  assert.equal(assertShadowPath('claude_shadow_runs/davis__2026-09-25/rounds/3'), 'claude_shadow_runs/davis__2026-09-25/rounds/3');
});

// ── cost ─────────────────────────────────────────────────────────────────────

test('COST IS PRICED FROM THE RESPONSE: 1,000 in + 500 out on claude-opus-5-5 is $0.014', () => {
  const c = usageCost('claude-opus-5-5', { input_tokens: 1000, output_tokens: 500 });
  assert.equal(c.usd, 0.014);
  assert.deepEqual(c.tokens, { input: 1000, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
});

test('cache reads and both cache-write TTLs are priced at their own rates when the response splits them', () => {
  const c = usageCost('claude-opus-5-5', {
    input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 3000,
    cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 },
  });
  // 100*4 + 100*20 + 2000*5 + 1000*8 + 10000*0.2 = 400 + 2000 + 10000 + 8000 + 2000 = 22,400 → $0.0224
  assert.equal(c.usd, 0.0224);
});

test('with no TTL split, cache writes are priced at the 5-minute rate and the basis SAYS so', () => {
  const c = usageCost('claude-opus-5-5', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 });
  assert.equal(c.usd, 0.005);
  assert.match(c.basis, /5-minute rate/);
});

test('a model with no price row gets NO dollar figure — tokens are real, a borrowed rate would not be', () => {
  const c = usageCost('claude-opus-9', { input_tokens: 1000, output_tokens: 1000 });
  assert.equal(c.usd, null);
  assert.match(c.basis, /no price table/);
  assert.equal(c.tokens.input, 1000);
});

test('a malformed usage block costs $0, not NaN — Number(null) is 0 and 0 is finite, so every field is checked', () => {
  const c = usageCost('claude-opus-5-5', { input_tokens: null, output_tokens: '12', cache_read_input_tokens: -5 });
  assert.equal(c.usd, 0);
  assert.equal(usageCost('claude-opus-5-5', null).usd, 0);
});

// ── the probe request and its reading ────────────────────────────────────────

test('THE PROBE ASKS IN THE SHAPE THE PLAN LOOP NEEDS: effort set explicitly, auto tool choice (forced is a 400 on this model), one strict tool', () => {
  const r = buildProbeRequest('claude-opus-5-5');
  assert.equal(r.model, 'claude-opus-5-5');
  assert.deepEqual(r.tool_choice, { type: 'auto' });
  assert.equal(r.output_config?.effort, 'low');
  assert.equal(r.thinking, undefined, 'thinking cannot be disabled on this model; the request must not try');
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].strict, true);
  assert.equal(r.tools[0].input_schema.additionalProperties, false);
});

const TOOL_REPLY = {
  model: 'claude-opus-5-5', stop_reason: 'tool_use',
  content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', id: 't1', name: PROBE_TOOL.name, input: { loads: ['A', 'B'] } }],
  usage: { input_tokens: 612, output_tokens: 88 },
};

test('a reply that CALLS the tool reads as reached + tool called, priced from its own usage', () => {
  const p = readProbeResult('claude-opus-5-5', { ok: true, httpStatus: 200, ms: 1500, body: TOOL_REPLY, error: null }, '2026-09-24T21:30:00.000Z');
  assert.equal(p.reached, true);
  assert.equal(p.toolCalled, true);
  assert.deepEqual(p.toolInput, { loads: ['A', 'B'] });
  assert.deepEqual(p.contentTypes, ['thinking', 'tool_use']);
  assert.equal(p.cost.usd, (612 * 4 + 88 * 20) / 1e6);
  assert.equal(p.nuvizzCalls, 0);
});

test('a reply that ANSWERS IN TEXT instead of calling the tool is reached but NOT tool-called — auto does not guarantee a call', () => {
  const p = readProbeResult('claude-opus-5-5', { ok: true, httpStatus: 200, ms: 900, body: { ...TOOL_REPLY, stop_reason: 'end_turn', content: [{ type: 'text', text: 'A, B' }] }, error: null }, 'x');
  assert.equal(p.reached, true);
  assert.equal(p.toolCalled, false);
});

test('a 404 for the model reads as NOT reached, with the API\'s own message', () => {
  const p = readProbeResult('claude-opus-5-5', { ok: false, httpStatus: 404, ms: 200, body: { error: { message: 'model: claude-opus-5-5' } }, error: 'model: claude-opus-5-5' }, 'x');
  assert.equal(p.reached, false);
  assert.equal(p.httpStatus, 404);
  assert.equal(p.cost, null, 'no usage, no cost claimed');
});

test('callMessages posts to the Messages API with the version header, and a timeout comes back as a reason, not a throw', async () => {
  let seen = null;
  const okFetch = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify(TOOL_REPLY), { status: 200 }); };
  const r = await callMessages({ model: 'm' }, { apiKey: 'k', timeoutMs: 1000, fetchImpl: okFetch });
  assert.equal(r.ok, true);
  assert.equal(seen.url, MESSAGES_URL);
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.init.headers['x-api-key'], 'k');
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const t = await callMessages({ model: 'm' }, { apiKey: 'k', timeoutMs: 20, fetchImpl: hang });
  assert.equal(t.ok, false);
  assert.match(t.error, /timed out/);
});

// ── the endpoint ─────────────────────────────────────────────────────────────

const ENV_KEYS = ['CLAUDE_SHADOW', 'CLAUDE_SHADOW_MODEL', 'ANTHROPIC_API_KEY', 'AUTH_REQUIRED'];
async function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const load = async () => (await import('../netlify/functions/claude-shadow.mts')).default;
const POST = (body) => new Request('https://x/.netlify/functions/claude-shadow', { method: 'POST', body: JSON.stringify(body) });

test('CLAUDE_SHADOW=off: the test call is refused with a 409 and ZERO model calls', async () => {
  await withEnv({ CLAUDE_SHADOW: 'off', ANTHROPIC_API_KEY: 'k' }, async () => {
    let modelCalls = 0;
    const fake = installFirestoreFake({}, () => { modelCalls++; return new Response('{}', { status: 500 }); });
    try {
      const res = await (await load())(POST({ action: 'probe', confirm: true }));
      assert.equal(res.status, 409);
      assert.equal((await res.json()).calls, 0);
      assert.equal(modelCalls, 0);
    } finally { fake.restore(); }
  });
});

test('DRY RUN makes ZERO model calls and returns the exact request that would be sent', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'k' }, async () => {
    let modelCalls = 0;
    const fake = installFirestoreFake({}, () => { modelCalls++; return new Response('{}', { status: 500 }); });
    try {
      const res = await (await load())(POST({ action: 'probe', dry: true }));
      const j = await res.json();
      assert.equal(res.status, 200);
      assert.equal(j.calls, 0);
      assert.deepEqual(j.request, buildProbeRequest('claude-opus-5-5'));
      assert.equal(modelCalls, 0);
    } finally { fake.restore(); }
  });
});

test('without confirm:true the call is NOT made — a stray POST cannot spend', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'k' }, async () => {
    let modelCalls = 0;
    const fake = installFirestoreFake({}, () => { modelCalls++; return new Response('{}', { status: 500 }); });
    try {
      const res = await (await load())(POST({ action: 'probe' }));
      assert.equal(res.status, 400);
      assert.equal(modelCalls, 0);
    } finally { fake.restore(); }
  });
});

test('THE TEST CALL: exactly ONE model call, recorded under claude_shadow_* and nowhere else, and the GET reads it back', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'k' }, async () => {
    const calls = [];
    const fake = installFirestoreFake({}, (url, init) => {
      calls.push(String(url));
      return new Response(JSON.stringify(TOOL_REPLY), { status: 200 });
    });
    try {
      const handler = await load();
      const res = await handler(POST({ action: 'probe', confirm: true }));
      const j = await res.json();
      assert.equal(res.status, 200);
      assert.equal(j.calls, 1);
      assert.deepEqual(calls, [MESSAGES_URL], 'one call, to the Messages API, and nothing else off-box');
      assert.equal(j.result.toolCalled, true);
      assert.equal(j.result.nuvizzCalls, 0);
      assert.deepEqual({ last: j.recorded.last, log: j.recorded.log }, { last: true, log: true });
      const written = [...fake.store.keys()];
      assert.ok(written.includes('claude_shadow_meta/probe_last'));
      assert.ok(written.some((k) => k.startsWith('claude_shadow_probes/')));
      for (const k of written) assert.ok(k.startsWith('claude_shadow_'), `wrote outside the prefix: ${k}`);

      const got = await (await handler(new Request('https://x/.netlify/functions/claude-shadow'))).json();
      assert.equal(got.enabled, true);
      assert.equal(got.model, 'claude-opus-5-5');
      assert.equal(got.keyConfigured, true);
      assert.equal(got.lastProbe.toolCalled, true);
      assert.equal(got.nuvizzCalls, 0);
    } finally { fake.restore(); }
  });
});

test('a model the key cannot reach is RECORDED as a failure (502), not reported as success', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'k' }, async () => {
    const fake = installFirestoreFake({}, () => new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-opus-5-5' } }), { status: 404 }));
    try {
      const res = await (await load())(POST({ action: 'probe', confirm: true }));
      const j = await res.json();
      assert.equal(res.status, 502);
      assert.equal(j.calls, 1);
      assert.equal(j.result.reached, false);
      assert.match(j.result.error, /claude-opus-5-5/);
      assert.equal(fake.store.get('claude_shadow_meta/probe_last').reached, false);
    } finally { fake.restore(); }
  });
});
