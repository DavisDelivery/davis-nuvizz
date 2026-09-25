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
  built: ['switches', 'write gateway', 'isolation guard', 'test call', 'learned truck capacity and route order', 'capacity settings', 'Claude router + backtest on past days'],
  notBuilt: ['nightly snapshot', 'nightly plan run', 'late-manifest flag', 'grading against the 8:30 plan', 'nightly comparison'],
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
  learnRefused: null, learnedNote: null, learnLastNote: null,
  settingsNote: null,
  settings: {
    loosePerSkid: 8.5, loosePerSkidAt: '2026-09-24T14:00:00.000Z', loosePerSkidBy: 'a-dispatcher-with-a-long-name',
    defaultLoosePerSkid: 10, ratioPending: true, bounds: { cap: [1, 60], loosePerSkid: [1, 100] },
  },
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
        yourCap: null, yourCapBy: null, yourCapAt: null, capUsed: 21.4, capSource: 'learned',
        routes: [{ name: 'GAINESVILLE / DAWSONVILLE 2', trips: 30 }, { name: 'COLIN/DJ 1', trips: 20 }, { name: 'ULINE APPT SUWANEE', trips: 11 }],
        fullest: { date: '2026-09-12', route: 'GAINESVILLE / DAWSONVILLE 2', driver: 'Christopher Montgomery-Washington', skids: 17, loose: 93, spots: 26.3 } },
      { key: 'BEN PAINTSIL', name: 'Ben Paintsil', trips: 5, days: 5, p50: 9, p85: 11, p95: 12, max: 12, cap: null,
        yourCap: 14.5, yourCapBy: 'dispatcher', yourCapAt: '2026-09-24T14:00:00.000Z', capUsed: 14.5, capSource: 'yours',
        routes: [{ name: 'BEN 1', trips: 5 }], fullest: { date: '2026-09-23', route: 'BEN 1', driver: 'Ben Paintsil', skids: 12, loose: 0, spots: 12 } },
      { key: 'NEW HIRE WITH A VERY LONG HYPHENATED SURNAME', name: 'New Hire With-A-Very-Long-Hyphenated-Surname', cap: null, trips: 0, noHistory: true,
        yourCap: 12, yourCapBy: 'dispatcher', yourCapAt: '2026-09-24T14:00:00.000Z', capUsed: 12, capSource: 'yours' },
    ],
    routes: [
      { key: 'GAINESVILLE / DAWSONVILLE 2', name: 'GAINESVILLE / DAWSONVILLE 2', trips: 44, days: 44, p50: 15, p85: 19.3, p95: 22, max: 26.3, cap: 22,
        yourCap: null, yourCapBy: null, yourCapAt: null, capUsed: 22, capSource: 'learned',
        drivers: [{ name: 'Christopher Montgomery-Washington', trips: 30 }, { name: 'Ben Paintsil', trips: 14 }],
        fullest: { date: '2026-09-12', route: 'GAINESVILLE / DAWSONVILLE 2', driver: 'Christopher Montgomery-Washington', skids: 17, loose: 93, spots: 26.3 } },
    ],
    pairs: [],
  },
};

// THE CLAUDE ROUTER'S BACKTEST PANEL (v1.70.0) is fed from a DIFFERENT view of the same function,
// so the guards must answer it with its own shape — the status body would render an empty panel and
// the guard would measure nothing. Worst rows: a running job, a queued one, a failure with a long
// reason, finished days with four-figure mileage and big swings, cost rates entered (the widest row).
const day = (i) => {
  const d = new Date(Date.UTC(2026, 8, 23 - i));
  return d.toISOString().slice(0, 10);
};
const cols = (m, t, unplanned = 0) => ({ trucks: t, stops: 612 - unplanned, spots: 1043.6, capUsedTrucks: 1240.5, util: 84.1, miles: m, driveMin: Math.round(m * 1.9), overCap: 0, blocked: 0, unplanned, overTime: 0 });
const result = (i, driven, claude) => ({
  date: day(i), at: '2026-09-25T14:03:00.000Z', jobId: `bt__${day(i)}__x`, submitted: i !== 2, usd: 2.4817, rounds: 6, ended: 'submitted', model: 'claude-opus-5-5',
  // Day 2 is the longest status a row can carry: not submitted, with stops left unplanned.
  columns: { driven: cols(driven, 51), reseq: cols(driven * 0.94, 51), claude: cols(claude, 48, i === 2 ? 3 : 0) },
  costs: { driven: driven * 2.1, reseq: driven * 0.94 * 2.1, claude: claude * 2.1 },
  vsDriven: { miles: { abs: claude - driven, pct: Math.round(((claude - driven) / driven) * 1000) / 10 }, driveMin: { abs: -412, pct: -9.8 }, trucks: -3, cost: { abs: (claude - driven) * 2.1, pct: -11.2 } },
  sequencingOnly: { miles: { abs: -0.06 * driven, pct: -6 } }, assignmentOnly: { miles: { abs: claude - 0.94 * driven, pct: -5.4 }, trucks: -3 },
  agreement: { stopsMoved: 214, stopsSameLoad: 398, coLoadRecall: 61.3, coLoadPrecision: 58.9 },
  stats: { stops: 612, loads: 51, excludedNoCoords: 7, capModelDays: 78 },
});
export const CLAUDE_SHADOW_BACKTESTS = {
  ok: true, enabled: true, model: 'claude-opus-5-5', refused: null, nuvizzCalls: 0,
  settings: { capRule: 'tighter', costPerMile: 2.1, costPerDriveHour: 38.5, effort: 'high', maxRounds: 8, maxUsd: 5, maxTokens: 32000 },
  defaults: { capRule: 'tighter', costPerMile: null, costPerDriveHour: null, effort: 'high', maxRounds: 8, maxUsd: 5, maxTokens: 32000 },
  bounds: { maxRounds: [2, 20], maxUsd: [0.5, 50], maxTokens: [8000, 64000], costPerMile: [0, 50], costPerDriveHour: [0, 500] },
  efforts: ['low', 'medium', 'high'], capRules: ['tighter', 'driver', 'route'],
  spend: { usd: 1284.37, runs: 312 },
  days: Array.from({ length: 24 }, (_, i) => ({ date: day(i), result: i === 0 ? result(0, 4381.6, 3902.2) : i === 2 ? result(2, 3977.1, 4012.8) : i === 5 ? result(5, 4120.4, 3688.9) : null })),
  jobs: [
    { _id: `bt__${day(3)}__run`, kind: 'backtest', date: day(3), status: 'running', createdAt: '2026-09-25T14:10:00Z', rounds: 4, usd: 1.9312 },
    { _id: `bt__${day(4)}__q`, kind: 'backtest', date: day(4), status: 'queued', createdAt: '2026-09-25T14:11:00Z', rounds: 0, usd: 0 },
    { _id: `bt__${day(6)}__f`, kind: 'backtest', date: day(6), status: 'failed', createdAt: '2026-09-25T13:00:00Z', error: 'the API refused the request (HTTP 400): messages.2.content.0: a thinking block could not be verified against this conversation' },
  ],
};

/** What a layout guard answers for a claude-shadow URL: the backtest view, or the status body. */
export function claudeShadowFixtureFor(url) {
  return String(url).includes('view=backtests') ? CLAUDE_SHADOW_BACKTESTS : CLAUDE_SHADOW_STATUS;
}
