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
  settings: { capRule: 'tighter', costPerMile: 2.1, costPerDriveHour: 38.5, effort: 'high', maxRounds: 8, maxUsd: 5, maxTokens: 32000 },
  defaults: { capRule: 'tighter', costPerMile: null, costPerDriveHour: null, effort: 'high', maxRounds: 8, maxUsd: 5, maxTokens: 32000 },
  bounds: { maxRounds: [2, 20], maxUsd: [0.5, 50], maxTokens: [8000, 64000], costPerMile: [0, 50], costPerDriveHour: [0, 500] },
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
  spots: 2.5, lbs: 1840, noTractor: i === 7,
}));
const byLoad = (off) => Object.fromEntries(mapLoads.map((l, k) => [l.id, mapStops.filter((s) => (s.id + off) % 8 === k).map((s) => s.id)]));
const claudePlan = byLoad(3);
claudePlan.L1 = [...claudePlan.L1, ...claudePlan.L8];  // a truck Claude did not use: its stops ride L1
delete claudePlan.L8;
const UNPLANNED_ID = 7;                               // no-tractor, dispatch sent it on a tractor
for (const k of Object.keys(claudePlan)) claudePlan[k] = claudePlan[k].filter((id) => id !== UNPLANNED_ID);
export const CLAUDE_SHADOW_MAP = {
  date: day(0), at: AT, depot: { lat: 34.14838, lng: -83.95948 },
  stops: mapStops, loads: mapLoads,
  plans: { driven: byLoad(0), reseq: byLoad(0), claude: claudePlan },
  unplanned: [{ id: UNPLANNED_ID, reason: 'no box truck has room for a no-tractor stop this size' }],
};
const metric = (stops, miles) => ({ stops, spots: stops * 2.5, miles, driveMin: Math.round(miles * 1.9), over: false, blocked: 0 });
export const CLAUDE_SHADOW_DAY_RESULT = {
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

/**
 * What a layout guard answers for a claude-shadow request: the backtest view, one day's result, one
 * day's map, or the status body. POSTs are told apart by their action, the way the endpoint does.
 */
export function claudeShadowFixtureFor(url, body = null) {
  let action = null;
  try { action = body ? JSON.parse(body)?.action ?? null : null; } catch { action = null; }
  if (action === 'backtest-result') return { ok: true, result: CLAUDE_SHADOW_DAY_RESULT };
  if (action === 'backtest-map') return { ok: true, map: CLAUDE_SHADOW_MAP, nuvizzCalls: 0 };
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
    fitBounds() {} setOptions() {} getDiv() { return this.el; } getZoom() { return this.z; } setZoom(z) { this.z = z; } getCenter() { return this.c; }
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

// ── GUARD STEPS for the backtested day. Shared by the layout guards and verify-shadow-map so they walk
// the screen the same way. Each step PROVES it arrived (a probe that quietly no-ops measures the
// screen it started on under another name), and waits for its proof rather than a fixed pause.
const seen = async (loc, ms = 8000) => { try { await loc.first().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; } };

/** Open the backtested day's row (the phone's summary button or the desktop's Open) and wait for it to open. */
export async function guardOpenBacktestDay(page, date = '2026-09-23') {
  const opened = await page.evaluate((d) => {
    const cb = document.querySelector(`input[aria-label="Pick ${d}"]`);
    let row = cb && cb.parentElement;
    for (let i = 0; row && i < 4; i++, row = row.parentElement) {
      const b = [...row.querySelectorAll('button')].find((x) => /^open$|— open$/i.test((x.innerText || '').trim()));
      if (b) { b.click(); return true; }
    }
    return false;
  }, date);
  if (!opened) return false;
  return seen(page.getByRole('button', { name: /map: claude vs dispatch/i }));
}

/** Open the map (Google stood in — needs a build WITH a Maps key) and tap the stop two orders share. */
export async function guardOpenMapAndTapStop(page) {
  const btn = page.getByRole('button', { name: /map: claude vs dispatch/i }).first();
  if (!(await btn.isVisible().catch(() => false))) return false;
  await btn.click();
  if (!(await seen(page.getByText(/^Trucks \(\d+\)/)))) return false;
  if (!(await page.evaluate(() => window.__guardTapStop?.() === true))) return false;
  return seen(page.getByText(/stops at this address/));
}
