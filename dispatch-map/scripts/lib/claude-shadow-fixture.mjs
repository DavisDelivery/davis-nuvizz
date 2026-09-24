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
  built: ['switches', 'write gateway', 'isolation guard', 'test call', 'learned truck capacity and route order'],
  notBuilt: ['capacity settings', 'snapshot', 'plan run', 'late-manifest flag', 'grading', 'comparison screen'],
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
  // v1.63.0 — the learned-capacity card, at its widest: a long driver name with three long route
  // names, a route with no cap yet, a fullest trip with both skids and loose, every "left out"
  // reason, days with no roster, and a last run that partly failed and left days for later.
  learnRefused: 'this site reads the uat-mirror database, not production\u2019s history', learnedNote: null, learnLastNote: null,
  learnLast: {
    at: '2026-09-24T08:30:04.000Z', trigger: 'nightly', by: null, ok: false, refused: null,
    learned: ['2026-09-23'], refreshed: ['2026-09-18', '2026-09-21'], failed: [{ date: '2026-09-22', error: 'listDocs history_days/davis__2026-09-22/stops failed: 503' }], deferred: 4,
  },
  learned: {
    learnVersion: 2, builtAt: '2026-09-24T08:31:10.000Z', loosePerSkid: 10, loosePerSkidSource: 'default', capQuantile: 0.95, minTrips: 20,
    days: { count: 82, first: '2026-06-04', last: '2026-09-23', noRoster: 19, stampGateOff: 3 },
    trips: { total: 5210, used: 3870, skipped: { shared: 41, rosterUnknown: 1012, uncounted: 83, noFreight: 202, noDriver: 2 } },
    rowsLeftOut: { openAtSeal: 311, otherDay: 147, noStamp: 58, unknownStatus: 0 },
    drivers: [
      { key: 'CHRISTOPHER MONTGOMERY-WASHINGTON', name: 'Christopher Montgomery-Washington', trips: 61, days: 58, p50: 14.2, p85: 18.6, p95: 21.4, max: 26.3, cap: 21.4,
        routes: [{ name: 'GAINESVILLE / DAWSONVILLE 2', trips: 30 }, { name: 'COLIN/DJ 1', trips: 20 }, { name: 'ULINE APPT SUWANEE', trips: 11 }],
        fullest: { date: '2026-09-12', route: 'GAINESVILLE / DAWSONVILLE 2', driver: 'Christopher Montgomery-Washington', skids: 17, loose: 93, spots: 26.3 } },
      { key: 'BEN PAINTSIL', name: 'Ben Paintsil', trips: 5, days: 5, p50: 9, p85: 11, p95: 12, max: 12, cap: null,
        routes: [{ name: 'BEN 1', trips: 5 }], fullest: { date: '2026-09-23', route: 'BEN 1', driver: 'Ben Paintsil', skids: 12, loose: 0, spots: 12 } },
    ],
    routes: [
      { key: 'GAINESVILLE / DAWSONVILLE 2', name: 'GAINESVILLE / DAWSONVILLE 2', trips: 44, days: 44, p50: 15, p85: 19.3, p95: 22, max: 26.3, cap: 22,
        drivers: [{ name: 'Christopher Montgomery-Washington', trips: 30 }, { name: 'Ben Paintsil', trips: 14 }],
        fullest: { date: '2026-09-12', route: 'GAINESVILLE / DAWSONVILLE 2', driver: 'Christopher Montgomery-Washington', skids: 17, loose: 93, spots: 26.3 } },
    ],
    pairs: [],
  },
};
