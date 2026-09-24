// scripts/lib/claude-shadow-fixture.mjs — what GET /.netlify/functions/claude-shadow answers,
// populated with the screen's WORST rows, for the phone and desktop layout guards.
//
// A recorded test call with the long cost-basis sentence, and a malformed CLAUDE_SHADOW_MODEL
// echoed back in the model note: those are the two lines most likely to wrap at 360px, and an
// empty fixture would measure a header and prove nothing. Shape mirrors statusBody() in
// netlify/functions/claude-shadow.mts.
export const CLAUDE_SHADOW_STATUS = {
  ok: true, enabled: true, switch: { name: 'CLAUDE_SHADOW', raw: null, default: 'on' },
  model: 'claude-opus-5-5', modelSource: 'default', modelRejected: 'opus five point five please, the new one',
  keyConfigured: true, prefix: 'claude_shadow_',
  probe: { effort: 'low', maxTokens: 2048, ceilingUsd: 0.049 },
  built: ['switches', 'write gateway', 'isolation guard', 'test call'],
  notBuilt: ['snapshot', 'plan run', 'late-manifest flag', 'grading', 'comparison screen'],
  lastProbe: {
    at: '2026-09-24T21:30:00.000Z', by: 'legacy', requestedModel: 'claude-opus-5-5', servedModel: 'claude-opus-5-5',
    answered: true, ok: true, httpStatus: 200, error: null, toolCalled: true, stopReason: 'tool_use', ms: 4210,
    cost: {
      usd: 0.004208,
      basis: "claude-opus-5-5 list price, from the response's usage; cache writes priced at the 5-minute rate (no TTL split in the response)",
      tokens: { input: 612, output: 88, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    },
  },
  lastProbeNote: null, nuvizzCalls: 0,
};
