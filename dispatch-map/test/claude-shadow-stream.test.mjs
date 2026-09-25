// test/claude-shadow-stream.test.mjs — THE ROUTER'S STREAMED ROUNDS FOLD BACK INTO THE SAME MESSAGE.
//
// Why streamed at all: a non-streamed round sends no headers until it has finished, and Node's
// fetch gives up on headers at about 300 s — inside a round's 10-minute budget — so a long round
// died, was retried, and was never priced. A streamed round's headers come at once. What these pin:
// the rebuilt message is the one a non-streamed call would return (thinking text AND signature kept
// whole, tool input rebuilt from its pieces, usage merged), an in-band error is the failure it
// stands for, and a stream cut short is never mistaken for a message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callMessages, readMessageStream, STREAM_ERROR_STATUSES } from '../netlify/functions/lib/claude-shadow/anthropic.mts';

const sse = (events, { cutAfter = null, chunk = 7 } = {}) => {
  let text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  if (cutAfter !== null) text = text.slice(0, cutAfter);
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  // Tiny chunks: an event, a line and even a UTF-8 character are split across reads.
  return { body: { getReader: () => ({ read: async () => (i >= bytes.length ? { done: true } : { value: bytes.slice(i, (i += chunk)), done: false }), cancel: async () => {} }) } };
};

const EVENTS = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 1 } } },
  { type: 'ping' },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Buford — ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'north loads first.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQBCkgIARABGAIiQL+/abc==' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'evaluate_plan', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"loads":[{"load":"L1","sto' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ps":[3,1,2]}],"unplanned":[]}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 742 } },
  { type: 'message_stop' },
];

test('a streamed round rebuilds exactly the message a non-streamed call returns: thinking + signature whole, tool input from its pieces, usage merged', async () => {
  const r = await readMessageStream(sse(EVENTS));
  assert.equal(r.error, null);
  assert.deepEqual(r.message.content, [
    { type: 'thinking', thinking: 'Buford — north loads first.', signature: 'EqQBCkgIARABGAIiQL+/abc==' },
    { type: 'tool_use', id: 'toolu_1', name: 'evaluate_plan', input: { loads: [{ load: 'L1', stops: [3, 1, 2] }], unplanned: [] } },
  ]);
  assert.equal(r.message.stop_reason, 'tool_use');
  assert.equal(r.message.model, 'claude-opus-5-5');
  assert.deepEqual(r.message.usage, { input_tokens: 1200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 742 }, 'input from message_start, final output from message_delta');
});

test('an error event mid-stream is the failure it stands for, not a message', async () => {
  const ev = [EVENTS[0], { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }];
  const r = await readMessageStream(sse(ev));
  assert.equal(r.message, null);
  assert.equal(r.status, STREAM_ERROR_STATUSES.overloaded_error);
  assert.match(r.error, /overloaded_error/);
});

test('a stream cut before message_stop is never a message — what arrived is discarded and the status is unknown', async () => {
  const full = EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const r = await readMessageStream(sse(EVENTS, { cutAfter: full.indexOf('message_delta') - 8 }));
  assert.equal(r.message, null);
  assert.equal(r.status, null, 'no status: the caller charges it as a call that may have been billed');
  assert.match(r.error, /before message_stop/);
});

test('callMessages streams only when the request asks: a streamed 200 comes back as the rebuilt body, the probe’s plain call is unchanged', async () => {
  const f = async (_url, init) => {
    const req = JSON.parse(init.body);
    if (req.stream) return { ok: true, status: 200, ...sse(EVENTS) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'hi' }], usage: {} }) };
  };
  const s = await callMessages({ model: 'm', stream: true }, { apiKey: 'k', timeoutMs: 1000, fetchImpl: f });
  assert.equal(s.ok, true);
  assert.equal(s.body.content[1].input.loads[0].stops.length, 3);
  const p = await callMessages({ model: 'm' }, { apiKey: 'k', timeoutMs: 1000, fetchImpl: f });
  assert.equal(p.body.content[0].text, 'hi');
});
