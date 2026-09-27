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
    ceilingBox: null, ceilingBoxAt: null, ceilingBoxBy: null, ceilingTractor: 46, ceilingTractorAt: '2026-09-26T20:00:00Z', ceilingTractorBy: 'dispatcher',
    ceilings: { box_truck: 22, tractor: 46, sources: { box_truck: 'default', tractor: 'yours' } }, defaultCeilings: { box_truck: 22, tractor: 37 }, hardCaps: true, classesKnown: true,
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
      { key: 'CHRISTOPHER MONTGOMERY-WASHINGTON', name: 'Christopher Montgomery-Washington', trips: 61, days: 58, p50: 14.2, p85: 18.6, p95: 24.4, max: 26.3, cap: 24.4,
        yourCap: null, yourCapBy: null, yourCapAt: null, capUsed: 22, capSource: 'learned', cls: 'box_truck', clipped: true, ceiling: 22,
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
        yourCap: null, yourCapBy: null, yourCapAt: null, capUsed: 22, capSource: 'learned', cls: null, clipped: false, ceiling: null,
        drivers: [{ name: 'Christopher Montgomery-Washington', trips: 30 }, { name: 'Ben Paintsil', trips: 14 }],
        fullest: { date: '2026-09-12', route: 'GAINESVILLE / DAWSONVILLE 2', driver: 'Christopher Montgomery-Washington', skids: 17, loose: 93, spots: 26.3 } },
    ],
    pairs: [],
  },
};

// THE CLAUDE ROUTER'S BACKTEST PANEL (v1.71.0) is fed from a DIFFERENT view of the same function,
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
  settings: { capRule: 'tighter', costPerMile: 2.1, costPerDriveHour: 38.5, effort: 'high', maxRounds: 8, maxUsd: 5, maxTokens: 32000, lbsBox: 10000, lbsTractor: 30000 },
  pinned: { lbsBox: false, lbsTractor: true },
  defaults: { capRule: 'tighter', costPerMile: null, costPerDriveHour: null, effort: 'high', maxRounds: 8, maxUsd: 5, maxTokens: 32000, lbsBox: 10000, lbsTractor: 30000 },
  bounds: { maxRounds: [2, 20], maxUsd: [0.5, 50], maxTokens: [8000, 64000], costPerMile: [0, 50], costPerDriveHour: [0, 500], lbsBox: [1000, 80000], lbsTractor: [1000, 80000] },
  efforts: ['low', 'medium', 'high'], capRules: ['tighter', 'driver', 'route'],
  spend: { usd: 1284.37, runs: 312 },
  ceiling: { usd: 25, spent24h: 24.87, holding: true },   // the longest queued status: "waiting on the 24-hour ceiling"

  days: Array.from({ length: 24 }, (_, i) => ({ date: day(i), result: i === 0 ? result(0, 4381.6, 3902.2) : i === 2 ? result(2, 3977.1, 4012.8) : i === 5 ? result(5, 4120.4, 3688.9) : null })),
  jobs: [
    { _id: `bt__${day(3)}__run`, kind: 'backtest', date: day(3), status: 'running', createdAt: '2026-09-25T14:10:00Z', rounds: 4, usd: 1.9312 },
    { _id: `bt__${day(4)}__q`, kind: 'backtest', date: day(4), status: 'queued', createdAt: '2026-09-25T14:11:00Z', rounds: 0, usd: 0 },
    { _id: `bt__${day(6)}__f`, kind: 'backtest', date: day(6), status: 'failed', createdAt: '2026-09-25T13:00:00Z', error: 'the API refused the request (HTTP 400): messages.2.content.0: a thinking block could not be verified against this conversation' },
  ],
};

// ONE DAY OPENED, AND ITS MAP (v1.72.0). The guards used to answer every POST with the status body,
// so an opened day sat at "Loading…" and the map said "could not load" — a layout nobody ever sees,
// measured instead of the one they do. These are the worst rows the day and the map can carry: the
// longest route and driver names, a truck drawn in its PLANNED order, a stop Claude left unplanned,
// two orders at one address, and a truck Claude did not use. `at` is shared, so the map does not
// (correctly) refuse to draw a run newer than the scorecard.
const AT = '2026-09-25T14:03:00.000Z';
const LONG_ROUTES = ['GAINESVILLE / DAWSONVILLE 2', 'ULINE APPT SUWANEE', 'CANTON/BALL GROUND/JASPER/ELLIJAY', 'COLIN/DJ 1', 'ATHENS WATKINSVILLE BOGART', 'TRAILER 3', 'BEN 2', 'BUFORD LOCAL'];
const LONG_DRIVERS = ['Christopher Montgomery-Washington', 'New Hire With-A-Very-Long-Hyphenated-Surname', 'Scott Hart', 'Nana Owusu', 'Garry Pitts', 'Trevarr Howard', 'Ben Paintsil', 'Aaron Mitchell'];
const mapLoads = LONG_ROUTES.map((route, i) => ({ id: `L${i + 1}`, route, driver: LONG_DRIVERS[i], cls: i === 5 ? 'tractor' : 'box_truck', orderSource: i === 7 ? 'planned' : 'driven' }));
const mapStops = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1, n: `DAVIS00${String(203700 + i)}`,
  // Two orders at one address (ids 1 and 2): the stop card must list both.
  lat: i === 1 ? 33.95 : 33.95 + (i % 8) * 0.06, lng: i === 1 ? -84.2 : -84.2 + Math.floor(i / 8) * 0.07,
  city: i % 3 ? 'LAWRENCEVILLE' : 'SUGAR HILL', zip: '30043',
  name: i === 0 || i === 1 ? 'NORTH GEORGIA BUILDING SUPPLY AND MILLWORK COMPANY' : `CUSTOMER NUMBER ${i + 1}`,
  // Skids and loose as the day recorded them; one order with neither recorded (it reads 0).
  skids: i === 9 ? 0 : 2 + (i % 3), loose: i === 9 ? 0 : (i % 4) * 12, spots: 2.5, lbs: 1840, noTractor: i === 7,
  // The customer's location key: ids 0 and 1 are one customer at one dock.
  k: i === 1 ? 'K0' : `K${i}`,
}));
const byLoad = (off) => Object.fromEntries(mapLoads.map((l, k) => [l.id, mapStops.filter((s) => (s.id + off) % 8 === k).map((s) => s.id)]));
const claudePlan = byLoad(3);
claudePlan.L1 = [...claudePlan.L1, ...claudePlan.L8];  // a truck Claude did not use: its stops ride L1
delete claudePlan.L8;
const UNPLANNED_ID = 7;                               // no-tractor, dispatch sent it on a tractor
for (const k of Object.keys(claudePlan)) claudePlan[k] = claudePlan[k].filter((id) => id !== UNPLANNED_ID);
// Each route's stored numbers per plan (v1.73.0), the scorecard's own measurement, with the leg-by-leg
// walk the route view shows: long numbers, a route near its skid cap and one past its driver's day.
const legsFor = (n) => Array.from({ length: n }, (_, j) => ({ mi: j === 0 ? 41.3 : 3.2 + j, min: j === 0 ? 48.5 : 6.1 + j }));
const colFor = (ids, i, side) => (ids && ids.length ? {
  stops: ids.length, spots: ids.length * 2.5, cap: 18.1 + i, util: Math.round(((ids.length * 2.5) / (18.1 + i)) * 1000) / 10,
  weight: ids.length * 1840, maxLbs: i === 5 ? 30000 : 10000, overWeight: ids.length * 1840 > (i === 5 ? 30000 : 10000),
  miles: 176.7 + i * 11 - (side === 'claude' ? 40 : 0), driveMin: 214 + i * 9, routeMin: 214 + i * 9 + 15 * ids.length,
  driverMin: i === 3 && side === 'claude' ? 640 : 214 + i * 9 + 15 * ids.length, maxMin: 600, overTime: i === 3 && side === 'claude', over: ids.length * 2.5 > 18.1 + i, blocked: 0,
  ...(side === 'reseq' ? {} : { legs: legsFor(ids.length), homeMi: 38.4 + i, legsOk: true }),
} : null);
export const CLAUDE_SHADOW_MAP = {
  date: day(0), at: AT, depot: { lat: 34.14838, lng: -83.95948 },
  loosePerSkid: 10, serviceMin: 15,
  stops: mapStops,
  loads: mapLoads.map((l, i) => ({
    ...l, clsSource: i === 1 ? 'default' : 'roster', cap: 18.1 + i, capSource: 'learned', capNote: i === 2 ? 'raised to what dispatch delivered on this route' : null,
    maxMin: 600, maxMinNote: null, maxLbs: i === 5 ? 30000 : 10000, lbsNote: null,
    why: 'Canton / Ball Ground / Jasper / Ellijay run as one loop from the north end, then down 575 — one truck to the far corner, not two.',
    cols: {},
  })),
  excluded: { noCoords: [{ n: 'DAVIS00299999', route: LONG_ROUTES[0] }] },
  plans: { driven: byLoad(0), reseq: byLoad(0), claude: claudePlan },
  unplanned: [{ id: UNPLANNED_ID, reason: 'no box truck has room for a no-tractor stop this size' }],
};
for (const [i, l] of CLAUDE_SHADOW_MAP.loads.entries()) {
  l.cols = { driven: colFor(CLAUDE_SHADOW_MAP.plans.driven[l.id], i, 'driven'), reseq: colFor(CLAUDE_SHADOW_MAP.plans.reseq[l.id], i, 'reseq'), claude: colFor(CLAUDE_SHADOW_MAP.plans.claude[l.id], i, 'claude') };
}
const metric = (stops, miles) => ({ stops, spots: stops * 2.5, miles, driveMin: Math.round(miles * 1.9), over: false, blocked: 0 });
export const CLAUDE_SHADOW_DAY_RESULT = {
  lbsLimits: { box_truck: 10000, tractor: 30000 }, lbsRaised: { box_truck: { raised: 0, of: 5, heaviest: 0 }, tractor: { raised: 0, of: 3, heaviest: 0 } },
  capMode: 'hard', ceilings: { box_truck: 22, tractor: 37 }, capsHeld: { box_truck: { held: 1, of: 4 }, tractor: { held: 2, of: 3 } }, dispatchOver: { cap: 0, lbs: 0, capLearned: 2 },
  ...result(0, 4381.6, 3902.2),
  effort: 'high', planFrom: 'submitted', capRule: 'tighter', loosePerSkid: 10,
  approximations: ['Truck class is the driver’s CURRENT MarginIQ type, not what it was on the day.', 'Delivery windows are not a constraint here: most stored windows are the vendor’s 08:00–20:00 default.'],
  orderSources: { driven: 7, planned: 1 },
  unplanned: [{ stop: UNPLANNED_ID, reason: 'no box truck has room for a no-tractor stop this size', n: mapStops[UNPLANNED_ID - 1].n, name: mapStops[UNPLANNED_ID - 1].name }],
  loads: mapLoads.map((l, i) => ({
    ...l, clsSource: i === 1 ? 'default' : 'roster', cap: 18.1 + i, capSource: 'learned', capNote: i === 2 ? 'raised to what dispatch delivered on this route' : null,
    driven: metric(5, 176.7 + i * 11), reseq: metric(5, 147.3 + i * 9), claude: claudePlan[l.id] ? metric(claudePlan[l.id].length, 133.1 + i * 8) : null,
    why: claudePlan[l.id] ? 'Canton / Ball Ground / Jasper / Ellijay run as one loop from the north end, then down 575 — one truck to the far corner, not two.' : null,
  })),
};
CLAUDE_SHADOW_DAY_RESULT.at = AT;
// Dispatch's scorecard row counts every load it ran past a cap (2) — the limits line explains both as past only a driver's own learned cap.
// reseq measures the same assignment as driven, so it carries the same count.
CLAUDE_SHADOW_DAY_RESULT.columns = { ...CLAUDE_SHADOW_DAY_RESULT.columns, driven: { ...CLAUDE_SHADOW_DAY_RESULT.columns.driven, overCap: 2 }, reseq: { ...CLAUDE_SHADOW_DAY_RESULT.columns.reseq, overCap: 2 } };

// THE PLANNING AREA (v1.76.0) — its worst rows: the longest route and driver names, roster loads with
// no driver yet, drivers who already have a load, a preview short on every measure, a done plan with
// stops left off, a running one and a failed one with a long error.
const PLAN_DAY = '2026-09-28';
const rosterLoads = [
  ...LONG_ROUTES.map((route, i) => ({ route, driver: LONG_DRIVERS[i], loadNbr: `DAVIS0002046${10 + i}`, status: 'Draft', onBoard: i % 3 === 0 ? 14 : 0, cls: i === 5 ? 'tractor' : 'box_truck', cap: i === 5 ? 37 : 17.2 + i, source: i === 5 ? 'learned route cap (tighter than the driver\u2019s 45) 41, held to the tractor ceiling 37' : 'learned driver cap (tighter than the route\u2019s 21.8)' })),
  { route: '1 SATL', driver: null, loadNbr: 'DAVIS000204633', status: 'Draft', onBoard: 0, cls: null, cap: 14, source: 'box truck profile (no learned cap)' },
  { route: '2 M', driver: null, loadNbr: 'DAVIS000204636', status: 'Draft', onBoard: 0, cls: null, cap: 14, source: 'box truck profile (no learned cap)' },
];
export const CLAUDE_SHADOW_PLAN_OPTIONS = {
  ok: true, date: PLAN_DAY, nuvizzCalls: 0, hardCaps: true, ceilings: { box_truck: 22, tractor: 37 },
  boardDays: [{ date: PLAN_DAY, count: 570, unplanned: 500, planned: 70 }, { date: '2026-09-26', count: 46, unplanned: 0 }, { date: '2026-09-25', count: 833, unplanned: 48 }, { date: '2026-09-24', count: 849, unplanned: 55 }, { date: '2026-09-23', count: 906, unplanned: 50 }, { date: '2026-09-22', count: 896, unplanned: 77 }],
  board: { count: 570, unplanned: 500, planned: 70, scannedAt: '2026-09-26T19:38:56.389Z' },
  roster: { at: '2026-09-26T19:00:00Z', loads: rosterLoads },
  drivers: [
    { driver: 'Christopher Montgomery-Washington', route: LONG_ROUTES[0], cls: 'box_truck', trips: 52, onRoster: LONG_ROUTES[0], cap: 18.1, source: 'learned driver cap' },
    { driver: 'Alfred Morgan', route: 'MORGAN', cls: null, trips: 31, onRoster: null, cap: 17.3, source: 'learned driver cap' },
  ],
  bounds: { lookbackDays: [0, 14], maxLoads: 120, maxStops: 1400 }, scopes: ['unplanned', 'open'],
};
export const CLAUDE_SHADOW_PLAN_PREVIEW = {
  ok: true, nuvizzCalls: 0, boardAt: '2026-09-26T19:38:56.389Z', model: 'claude-opus-5-5', maxUsd: 5,
  params: { date: PLAN_DAY, lookbackDays: 7, scope: 'unplanned', picks: [] },
  counts: { onBoard: 618, carried: 49, cancelled: 1, pickups: 1, finished: 3, planned: 45, kept: 28, keptNoLocation: 0, noLocation: 2, toPlan: 544, byDay: { [PLAN_DAY]: 499, '2026-09-25': 44, '2026-09-24': 1 } },
  carry: { basis: 'pool', added: 49, pruned: 1 },
  capacity: { stops: 572, kept: 28, spots: 872.3, lbs: 276563, capSpots: 311, capLbs: 250000, loads: 13, noTractorStops: 15, noTractorSpots: 19.9, boxCapSpots: 117.4, serviceMin: 8580, dayMin: 7800, short: { spots: 561.3, lbs: 26563, noTractor: 0, time: 780 } },
  loads: rosterLoads.map((l, i) => ({ id: `L${i + 1}`, route: l.route, driver: l.driver || '(no driver)', cls: l.cls || 'box_truck', clsSource: 'roster', cap: l.cap, capSource: l.source, capNote: i === 5 ? 'learned 41 held to the tractor ceiling 37' : null, maxLbs: l.cls === 'tractor' ? 30000 : 10000, maxMin: 600 })),
  noLocation: [], noLocationCount: 2, capMode: 'hard', ceilings: { box_truck: 22, tractor: 37 }, lbsLimits: { box_truck: 10000, tractor: 30000 },
  approximations: ['The stops are the 2026-09-28 board as the last scan left it — read from Firestore, not NuVizz — through the Map\u2019s own filters.', 'Delivery windows are not a constraint.'],
};
const planLoads = CLAUDE_SHADOW_DAY_RESULT.loads.map((l, i) => ({ ...l, driven: null, reseq: null, maxLbs: l.cls === 'tractor' ? 30000 : 10000, maxMin: 600, kept: i === 0 ? 3 : 0, claude: l.claude ? { ...l.claude, weight: 9840, driverMin: 598 } : null }));
export const CLAUDE_SHADOW_PLAN_RESULT = {
  tenant: 'davis', kind: 'plan', date: PLAN_DAY, jobId: `pl__${PLAN_DAY}__done`, at: AT, submitted: true, planFrom: 'submitted', usd: 3.4127, rounds: 6,
  columns: { claude: { stops: 39, trucks: 7, miles: 1022.4, driveMin: 1811, spots: 97.5 } },
  loads: planLoads,
  unused: [{ id: 'L8', route: LONG_ROUTES[7], driver: LONG_DRIVERS[7] }],
  unplanned: Array.from({ length: 6 }, (_, i) => ({ stop: 7 + i, n: `DAVIS00${203706 + i}`, name: i === 0 ? 'NORTH GEORGIA BUILDING SUPPLY AND MILLWORK COMPANY' : `CUSTOMER NUMBER ${7 + i}`, city: 'LAWRENCEVILLE', day: i === 1 ? '2026-09-25' : PLAN_DAY, spots: 2.5, lbs: 1840, reason: 'every picked box truck is at its skid cap and the tractors cannot take a no-tractor stop' })),
  approximations: CLAUDE_SHADOW_PLAN_PREVIEW.approximations, nuvizzCalls: 0,
};
export const CLAUDE_SHADOW_PLAN_MAP = {
  ...CLAUDE_SHADOW_MAP, kind: 'plan', planId: `pl__${PLAN_DAY}__done`,
  stops: CLAUDE_SHADOW_MAP.stops.map((s, i) => ({ ...s, day: i === 3 ? '2026-09-25' : PLAN_DAY })),
  loads: CLAUDE_SHADOW_MAP.loads.map((l) => ({ ...l, cols: { driven: null, reseq: null, claude: l.cols.claude } })),
  plans: { driven: {}, reseq: {}, claude: CLAUDE_SHADOW_MAP.plans.claude },
};
export const CLAUDE_SHADOW_PLANS = {
  ok: true, enabled: true, model: 'claude-opus-5-5', refused: null, nuvizzCalls: 0,
  settings: CLAUDE_SHADOW_BACKTESTS.settings, ceiling: { usd: 25, spent24h: 24.87, holding: true }, spend: { usd: 41.2, runs: 12 },
  jobs: [
    { _id: `pl__${PLAN_DAY}__run`, kind: 'plan', date: PLAN_DAY, status: 'running', createdAt: '2026-09-26T23:10:00Z', by: 'dispatcher', rounds: 2, usd: 0.8123, params: { date: PLAN_DAY, lookbackDays: 7, scope: 'unplanned', picks: rosterLoads.map((l) => ({ kind: 'roster', route: l.route })) } },
    { _id: `pl__${PLAN_DAY}__done`, kind: 'plan', date: PLAN_DAY, status: 'done', createdAt: '2026-09-26T22:10:00Z', by: 'dispatcher', rounds: 6, usd: 3.4127, headline: { placed: 39, unplanned: 6, trucks: 7, miles: 1022.4, driveMin: 1811 }, params: { date: PLAN_DAY, lookbackDays: 14, scope: 'open', picks: rosterLoads.slice(0, 8).map((l) => ({ kind: 'roster', route: l.route })) } },
    { _id: `pl__${PLAN_DAY}__f`, kind: 'plan', date: PLAN_DAY, status: 'failed', createdAt: '2026-09-26T21:00:00Z', by: 'dispatcher', rounds: 8, usd: 5, error: 'no plan without a hard-rule violation: max-rounds — the last evaluation still had GAINESVILLE / DAWSONVILLE 2 over its 22-spot cap', params: { date: PLAN_DAY, lookbackDays: 0, scope: 'unplanned', picks: [] } },
  ],
};

/**
 * What a layout guard answers for a claude-shadow request: the backtest view, one day's result, one
 * day's map, the planning area's reads, or the status body. POSTs are told apart by their action, the
 * way the endpoint does.
 */
export function claudeShadowFixtureFor(url, body = null) {
  let action = null;
  try { action = body ? JSON.parse(body)?.action ?? null : null; } catch { action = null; }
  if (action === 'backtest-result') return { ok: true, result: CLAUDE_SHADOW_DAY_RESULT };
  if (action === 'backtest-map') return { ok: true, map: CLAUDE_SHADOW_MAP, nuvizzCalls: 0 };
  if (action === 'plan-options') return CLAUDE_SHADOW_PLAN_OPTIONS;
  if (action === 'plan-preview') return CLAUDE_SHADOW_PLAN_PREVIEW;
  if (action === 'plan') return { ok: true, jobId: `pl__${PLAN_DAY}__new`, stops: 544, loads: 9, capacity: CLAUDE_SHADOW_PLAN_PREVIEW.capacity, maxUsd: 5, model: 'claude-opus-5-5', nuvizzCalls: 0 };
  if (action === 'plan-result') return { ok: true, result: CLAUDE_SHADOW_PLAN_RESULT };
  if (action === 'plan-map') return { ok: true, map: CLAUDE_SHADOW_PLAN_MAP, nuvizzCalls: 0 };
  if (String(url).includes('view=plans')) return CLAUDE_SHADOW_PLANS;
  return String(url).includes('view=backtests') ? CLAUDE_SHADOW_BACKTESTS : CLAUDE_SHADOW_STATUS;
}

/**
 * A stand-in for Google Maps that can hold the map's Data layer — CI builds with a key that cannot
 * load the real thing. Anything it does not know answers with an inert stand-in, so the rest of
 * the app survives loading it. window.__guardTapStop() taps the first stop on the visible map, so
 * a guard can open the stop card and measure it too.
 */
export const CLAUDE_SHADOW_FAKE_MAPS = `(() => {
  const g = window.google = window.google || {}; const m = g.maps = g.maps || {};
  const inst = () => new Proxy(function () {}, { get: (t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => 0 : inst()), apply: () => inst(), construct: () => inst() });
  const tolerant = (o) => new Proxy(o, { get: (t, p) => (p in t ? t[p] : p === 'then' ? undefined : inst()) });
  let n = 0; const all = [];
  class LatLng { constructor(a, b) { this.a = a; this.b = b; } lat() { return this.a; } lng() { return this.b; } }
  class Data {
    constructor() { this.f = []; this.ls = []; }
    addGeoJson(gj) { for (const x of (gj && gj.features) || []) this.f.push({ p: x.properties || {}, getProperty(k) { return this.p[k]; } }); return []; }
    forEach(fn) { this.f.slice().forEach(fn); } remove(x) { this.f = this.f.filter((y) => y !== x); } setStyle(s) { this.s = s; }
    addListener(ev, fn) { if (ev === 'click') this.ls.push(fn); return { remove: () => { this.ls = this.ls.filter((y) => y !== fn); } }; }
  }
  class Map {
    constructor(el) {
      n += 1; this.el = el; this.c = new LatLng(34, -84); this.z = 10; this.data = new Data();
      if (el && el.setAttribute) { el.setAttribute('data-guard-map', String(n)); const d = document.createElement('div'); d.className = 'gm-style'; d.style.cssText = 'width:100%;height:100%'; el.appendChild(d); }
      all.push(this); return tolerant(this);
    }
    fitBounds() {} setOptions() {} setMapTypeId(t) { this.t = t; } getMapTypeId() { return this.t || 'roadmap'; } getDiv() { return this.el; } getZoom() { return this.z; } setZoom(z) { this.z = z; } getCenter() { return this.c; }
    setCenter(c) { if (c) this.c = new LatLng(typeof c.lat === 'function' ? c.lat() : c.lat, typeof c.lng === 'function' ? c.lng() : c.lng); }
    addListener() { return { remove() {} }; }
  }
  const known = { Map, LatLng, Data, SymbolPath: { CIRCLE: 0, FORWARD_CLOSED_ARROW: 1, FORWARD_OPEN_ARROW: 2, BACKWARD_CLOSED_ARROW: 3, BACKWARD_OPEN_ARROW: 4 },
    LatLngBounds: class { extend() { return this; } isEmpty() { return true; } },
    Size: class { constructor(w, h) { this.width = w; this.height = h; } }, Point: class { constructor(x, y) { this.x = x; this.y = y; } },
    event: { trigger() {}, addListener() { return { remove() {} }; }, addListenerOnce() { return { remove() {} }; }, removeListener() {}, clearInstanceListeners() {} } };
  const ib = m.__ib__;
  const ns = new Proxy(Object.assign(m, known), { get: (t, p) => (p === 'then' ? undefined : p in t ? t[p] : (typeof p === 'string' && /^[A-Z]/.test(p) ? class { constructor() { return inst(); } } : inst())) });
  g.maps = ns; ns.importLibrary = async () => ns;
  window.__guardMapCount = () => n;
  // What a map drew and how it styled it: [{ kind, loadId, seq, label }] for the visible maps.
  window.__guardDrawn = () => all.filter((x) => x.el && x.el.isConnected && x.el.offsetParent).map((mp) => mp.data.f.map((f) => { const st = typeof mp.data.s === 'function' ? mp.data.s(f) : {}; return { kind: f.p.kind, loadId: f.p.loadId, seq: f.p.seq, label: st && st.label ? st.label.text : null }; }));
  window.__guardTapStop = () => {
    const mp = all.find((x) => x.el && x.el.isConnected && x.el.offsetParent);
    const f = mp && mp.data.f.find((x) => x.p.kind === 'stop' && x.p.stopId === 1);
    if (!f) return false;
    mp.data.ls.forEach((fn) => fn({ feature: f }));
    return true;
  };
  if (typeof ib === 'function') ib();
})();`;

/** Is this request Google's Maps script? (A predicate, so a guard can route and unroute exactly it.) */
export const isGoogleMapsScript = (url) => { try { return new URL(String(url)).hostname === 'maps.googleapis.com'; } catch { return false; } };

// ── GUARD STEPS for the backtested day (v1.72.0 map, v1.73.0 routes). Shared by the layout guards and
// verify-shadow-map so they walk the screen the same way. Each step PROVES it arrived (a probe that
// quietly no-ops measures the screen it started on under another name), waits for its proof rather
// than a fixed pause, and looks for that proof INSIDE the shadow's own sections: on a phone the Shadow
// view sits over the Routing screen, which has "Routes (…)" text of its own — a loose text match
// passed before the day's routes had loaded, and CI's slower runners lost that race every time.
const seen = async (loc, ms = 8000) => { try { await loc.first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };
const ROUTE_BUTTON = 'section[aria-label="Routes"] button:not([aria-label])';
const ROUTE_PANEL = 'section[aria-label^="Route "]:not([aria-label="Routes"])';
// When a step fails, say which and what the page showed — "could not open" alone cannot be fixed.
const why = async (page, step) => {
  const st = await page.evaluate(([rb, rp]) => ({
    routesSection: !!document.querySelector('section[aria-label="Routes"]'),
    routeButtons: document.querySelectorAll(rb).length,
    panel: [...document.querySelectorAll(rp)].map((x) => x.getAttribute('aria-label')),
    dayOpen: !!document.querySelector('button[aria-label="Close the day"]'),
  }), [ROUTE_BUTTON, ROUTE_PANEL]).catch((e) => ({ error: String(e).slice(0, 120) }));
  console.log(`      guard step failed: ${step} — ${JSON.stringify(st)}`);
  if (process.env.GUARD_SHOT_DIR) await page.screenshot({ path: `${process.env.GUARD_SHOT_DIR}/guard-fail-${Date.now()}.png` }).catch(() => {});
  return false;
};

/** Open the backtested day's row (the phone's summary button or the desktop's Open) and wait for its routes. */
export async function guardOpenBacktestDay(page, date = '2026-09-23') {
  if (!(await seen(page.locator(`input[aria-label="Pick ${date}"]`), 8000))) return why(page, `the ${date} row never appeared`);
  const opened = await page.evaluate((d) => {
    const cb = document.querySelector(`input[aria-label="Pick ${d}"]`);
    let row = cb && cb.parentElement;
    for (let i = 0; row && i < 4; i++, row = row.parentElement) {
      const b = [...row.querySelectorAll('button')].find((x) => /^open$|— open$/i.test((x.innerText || '').trim()));
      if (b) { b.click(); return true; }
    }
    return false;
  }, date);
  if (!opened) return why(page, 'the day row has no Open button');
  return (await seen(page.locator(ROUTE_BUTTON))) || why(page, "the day's routes never appeared");
}

/** Open the first route in the routes list and wait for its numbers, inside the route itself. */
export async function guardOpenFirstRoute(page) {
  const b = page.locator(ROUTE_BUTTON).first();
  if (!(await seen(b))) return why(page, 'no route in the list to open');
  await b.click();
  return (await seen(page.locator(ROUTE_PANEL).getByText(/^Skid spots \/ cap$/))) || why(page, 'the opened route never showed its numbers');
}

/** Open the map (Google stood in — needs a build WITH a Maps key) and tap the stop two orders share. */
export async function guardOpenMapAndTapStop(page) {
  // v1.77.1: a route opened from the list opens in the ROUTE DRAWER, whose maps are already showing —
  // the page's own map button sits under it and is not the way in.
  const inDrawer = await page.locator('[role="dialog"][aria-label^="Route drawer"]').first().isVisible().catch(() => false);
  if (!inDrawer) {
    const btn = page.getByRole('button', { name: /^map: yours|^maps: yours/i }).first();
    if (!(await seen(btn))) return why(page, 'no map button');
    await btn.click();
  }
  if (!(await seen(page.locator('[aria-label="Claude map"], [aria-label="Dispatch — as driven map"]')))) return why(page, 'the map never appeared');
  if (!(await page.evaluate(() => window.__guardTapStop?.() === true))) return why(page, 'no stop to tap on the map');
  return (await seen(page.getByText(/stops at this address/))) || why(page, 'the stop card never opened');
}
