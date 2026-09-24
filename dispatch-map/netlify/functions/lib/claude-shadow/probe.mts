// lib/claude-shadow/probe.mts — ONE TEST CALL, AND AN HONEST READING OF WHAT CAME BACK.
//
// Before a nightly plan run spends real money, one small call answers the questions the code
// cannot: does this account's key reach the configured model at all, does the API accept the
// request SHAPE the plan loop depends on, and what does `usage` actually look like.
//
// The shape is the plan loop's, cut down to one tool:
//   - output_config.effort set EXPLICITLY. On claude-opus-5-5 thinking cannot be turned off
//     and effort is the only control; the API default is `medium`, so leaving it unset would
//     be a silent choice.
//   - tool_choice {type:"auto"} with a strict tool. Forced tool use ("any" / "tool") is a 400
//     on this model, so the plan loop has to steer from the prompt and CHECK that the tool was
//     called — which is exactly what toolCalled below reports.
//
// Each verdict is reported separately rather than collapsed into one "ok", because they fail
// for different reasons and point at different fixes: no access is an account question, a
// 400 is a request-shape question, and a text answer instead of a tool call is a prompt one.
import { usageCost, PRICES_PER_MTOK, type UsageCost, type CallResult } from './anthropic.mts';

export const PROBE_TOOL = {
  name: 'submit_plan',
  description: 'Submit the final plan: the load names, in order.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: { loads: { type: 'array', items: { type: 'string' } } },
    required: ['loads'],
    additionalProperties: false,
  },
};

export const PROBE_EFFORT = 'low';
export const PROBE_MAX_TOKENS = 2048;
// THE MOST ONE TEST CALL CAN COST, from the code's own numbers rather than a hope. Output is
// capped by max_tokens (thinking counts toward it). Input is the ~40-word prompt and one small
// tool, plus whatever the API adds for tool use; 2,000 tokens is a generous BOUND on that, not a
// measurement — the recorded `usage` is the measurement. At claude-opus-5-5 list price the
// ceiling is (2,000 × $4 + 2,048 × $20) / 1M ≈ 4.9¢; a short answer costs a fraction of a cent.
export const PROBE_INPUT_TOKEN_BOUND = 2000;

export function probeCeilingUsd(model: string): number | null {
  const r = PRICES_PER_MTOK[model];
  if (!r) return null;
  return Math.round(((PROBE_INPUT_TOKEN_BOUND * r.input + PROBE_MAX_TOKENS * r.output) / 1e6) * 1e4) / 1e4;
}
export const PROBE_PROMPT = 'This is a connectivity test. Use the submit_plan tool exactly once with loads ["A", "B"].';

export function buildProbeRequest(model: string): Record<string, any> {
  return {
    model,
    max_tokens: PROBE_MAX_TOKENS,
    output_config: { effort: PROBE_EFFORT },
    tool_choice: { type: 'auto' },
    tools: [PROBE_TOOL],
    messages: [{ role: 'user', content: PROBE_PROMPT }],
  };
}

export interface ProbeResult {
  at: string;
  requestedModel: string;
  // THREE OUTCOMES, NOT TWO. "Answered" = an HTTP response came back at all; "ok" = it was a
  // 2xx with a JSON body. A 400/404 is an answer (the API read the request and refused it, and
  // says why); a timeout or network error is NOT — the request left, nothing came back, and it
  // may still have been billed, which is exactly what the tab must not dress up as "no".
  answered: boolean;
  ok: boolean;
  timedOut: boolean;
  httpStatus: number | null;
  error: string | null;
  servedModel: string | null;    // what the response says ran
  stopReason: string | null;
  toolCalled: boolean;           // a tool_use block for submit_plan came back
  toolInput: any | null;
  contentTypes: string[];        // block types in order, e.g. ["thinking","tool_use"]
  usage: any | null;             // the response's usage block, verbatim
  cost: UsageCost | null;
  ms: number;
  effort: string;
  nuvizzCalls: 0;
}

export function readProbeResult(requestedModel: string, call: CallResult, at: string): ProbeResult {
  const body = call.ok ? call.body : null;
  const content: any[] = Array.isArray(body?.content) ? body.content : [];
  const toolUse = content.find((b) => b?.type === 'tool_use' && b?.name === PROBE_TOOL.name) || null;
  const servedModel = typeof body?.model === 'string' ? body.model : null;
  return {
    at,
    requestedModel,
    answered: call.httpStatus !== null,
    ok: call.ok,
    timedOut: call.timedOut === true,
    httpStatus: call.httpStatus,
    error: call.error,
    servedModel,
    stopReason: typeof body?.stop_reason === 'string' ? body.stop_reason : null,
    toolCalled: !!toolUse,
    toolInput: toolUse ? toolUse.input ?? null : null,
    contentTypes: content.map((b) => String(b?.type || '?')),
    usage: body?.usage ?? null,
    // Priced at the model that SERVED the call when the response names one: that is the rate
    // that was actually billed.
    cost: body?.usage ? usageCost(servedModel || requestedModel, body.usage) : null,
    ms: call.ms,
    effort: PROBE_EFFORT,
    nuvizzCalls: 0,
  };
}
