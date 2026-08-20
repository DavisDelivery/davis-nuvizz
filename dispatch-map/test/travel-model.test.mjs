// test/travel-model.test.mjs — how long a leg actually takes.
//
// Chad: "we shouldn't be using straight line distances surely we can come up with a better
// way. That is also not going to be expensive to do."
//
// The old model was one number: every leg at a flat ~30 mph over crow-flies × 1.3. These
// pin the two things that replace it, and the traps in each:
//
//   • the CURVE — effective speed grows with leg length, is calibrated from our own sealed
//     stamps, and must never let one noisy bucket make a longer leg read slower
//   • the GOOGLE LEG — a cached real drive time beats any estimate, but only a sane one,
//     and its absence must degrade to the curve, never to a crash or to the old flat model
//
// PURE — no network, no Firestore, no NuVizz.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CURVE, curveMph, legMinutesFromMeters, legKey, resolveLegMinutes,
  fitCurve, legSamplesFromRoutes, MIN_BUCKET_SAMPLES, MPH_MIN, MPH_MAX,
} from '../src/lib/travel-model.js';
import { computeBoardFlags } from '../src/lib/board-flags.js';

const MI = 1609.344;

// ── THE CURVE ────────────────────────────────────────────────────────────────

test('THE POINT: a town hop is slow, a highway run is fast, flat 30 is neither', () => {
  const townMph = curveMph(0.8 * MI);
  const highwayMph = curveMph(45 * MI);
  assert.ok(townMph < 18, `a sub-mile hop at ${townMph} mph — lights and lot entrances`);
  assert.ok(highwayMph > 40, `a 45-mile run at ${highwayMph} mph — that is the highway`);
  // The old model was 30/1.3 ≈ 23 mph effective at EVERY distance. Both ends beat it.
  assert.ok(townMph < 23 && highwayMph > 23, 'the flat model sat wrongly between the two');
});

test('speed never falls as legs get longer — in the defaults and by interpolation', () => {
  let prev = 0;
  for (let mi = 0.1; mi <= 80; mi += 0.7) {
    const v = curveMph(mi * MI);
    assert.ok(v >= prev - 1e-9, `speed fell at ${mi.toFixed(1)} mi: ${prev} -> ${v}`);
    prev = v;
  }
});

test('minutes grow with distance — a longer leg can never arrive sooner', () => {
  let prev = 0;
  for (let mi = 0.1; mi <= 80; mi += 0.7) {
    const m = legMinutesFromMeters(mi * MI);
    assert.ok(m > prev, `minutes shrank at ${mi.toFixed(1)} mi`);
    prev = m;
  }
});

test('the Chad case: the 49-mile Monroe leg stops costing two hours', () => {
  // ESTES-style far-out stop. Flat model: 49 mi × 1.3 / 30 mph ≈ 127 min. Any driver
  // knows that leg is about an hour — the flag read "307 min late" partly on this error.
  const min = legMinutesFromMeters(49 * MI);
  assert.ok(min > 45 && min < 80, `49 mi should be about an hour, got ${Math.round(min)} min`);
});

test('garbage distances answer 0 minutes, never NaN into the clock', () => {
  for (const bad of [0, -5, NaN, null, undefined, 'x']) {
    assert.equal(legMinutesFromMeters(bad), 0, JSON.stringify(bad));
  }
});

test('an empty or missing curve falls back to the shipped defaults', () => {
  assert.equal(curveMph(5 * MI, []), curveMph(5 * MI, DEFAULT_CURVE));
  assert.equal(curveMph(5 * MI, null), curveMph(5 * MI));
});

// ── THE GOOGLE LEG ───────────────────────────────────────────────────────────

const A = { lat: 34.1478, lng: -83.9609 };
const B = { lat: 34.1002, lng: -84.0001 };

test('a cached real drive time wins over the estimate', () => {
  const legs = { [legKey(A, B)]: 17 * 60 };
  const r = resolveLegMinutes(A, B, 6400, { legs });
  assert.equal(r.min, 17);
  assert.equal(r.source, 'google');
});

test('no cached leg → the curve answers, and says so', () => {
  const r = resolveLegMinutes(A, B, 6400, { legs: {} });
  assert.equal(r.source, 'curve');
  assert.ok(r.min > 0);
});

test('an insane cached value is refused — a 7-hour leg is a data error, not a route', () => {
  for (const sec of [0, -60, 7 * 3600, NaN, 'x']) {
    const r = resolveLegMinutes(A, B, 6400, { legs: { [legKey(A, B)]: sec } });
    assert.equal(r.source, 'curve', `accepted ${sec}`);
  }
});

test('the key is directional and rounds to a ~100 m grid', () => {
  assert.notEqual(legKey(A, B), legKey(B, A), 'A→B and B→A are different drives');
  const jitter = { lat: A.lat + 0.0003, lng: A.lng - 0.0003 };
  assert.equal(legKey(jitter, B), legKey(A, B), 'geocode jitter must still hit the cache');
  const nextDock = { lat: A.lat + 0.004, lng: A.lng };
  assert.notEqual(legKey(nextDock, B), legKey(A, B), 'a different dock is a different leg');
});

// ── CALIBRATION ──────────────────────────────────────────────────────────────

// A synthetic sealed day: legs of one length driven at one true speed, gap = travel + dwell.
const samplesAt = (mi, mph, dwellMin, n) =>
  Array.from({ length: n }, () => ({ meters: mi * MI, gapMin: (mi / mph) * 60 + dwellMin }));

test('a bucket with enough samples recovers the real speed', () => {
  const fit = fitCurve(samplesAt(5, 24, 14, 200));
  const b = fit.buckets.find((x) => x.range === '4–8 mi');
  assert.equal(b.source, 'measured');
  assert.ok(Math.abs(b.usedMph - 24) < 3, `wanted ~24, got ${b.usedMph}`);
  assert.ok(Math.abs(fit.serviceMin - 14) < 3, `service ~14, got ${fit.serviceMin}`);
});

test('a sparse bucket stays on the default — 12 samples are an anecdote', () => {
  const fit = fitCurve(samplesAt(20, 55, 14, MIN_BUCKET_SAMPLES - 1));
  const b = fit.buckets.find((x) => x.range === '15–30 mi');
  assert.equal(b.source, 'default');
});

test('a lunch break does not become a slow road', () => {
  // Same 5-mile legs, but a third of the gaps carry a 70-minute lunch. The MEDIAN holds.
  const clean = samplesAt(5, 24, 14, 140);
  const lunches = samplesAt(5, 24, 84, 60);
  const fit = fitCurve([...clean, ...lunches]);
  const b = fit.buckets.find((x) => x.range === '4–8 mi');
  assert.ok(Math.abs(b.usedMph - 24) < 4, `lunch poisoned the fit: ${b.usedMph}`);
});

test('ISOTONIC: a noisy slow far bucket cannot make longer legs read slower', () => {
  const near = samplesAt(5, 30, 14, 200);
  const far = samplesAt(20, 12, 14, 40);   // 40 samples through one bad afternoon
  const fit = fitCurve([...near, ...far]);
  const speeds = fit.curve.map(([, v]) => v);
  for (let i = 1; i < speeds.length; i++) {
    assert.ok(speeds[i] >= speeds[i - 1], `curve inverted at point ${i}`);
  }
});

test('fitted speeds are clamped to a road, not a parking lot or an airstrip', () => {
  const crawl = samplesAt(5, 4, 14, 200);
  const fit = fitCurve(crawl);
  for (const [, v] of fit.curve) assert.ok(v >= MPH_MIN && v <= MPH_MAX);
});

test('no samples at all → the defaults, whole, with provenance saying so', () => {
  const fit = fitCurve([]);
  assert.ok(fit.buckets.every((b) => b.source === 'default'));
  assert.equal(fit.n, 0);
  assert.equal(fit.serviceMeasured, false);
});

test('leg samples pair consecutive stamps per route, in stamp order, never across routes', () => {
  const routes = new Map([
    ['R1', [
      { pos: { lat: 34.0, lng: -84.0 }, stampMin: 600 },
      { pos: { lat: 34.1, lng: -84.0 }, stampMin: 540 },   // stamped EARLIER — order by stamp
      { pos: null, stampMin: 570 },                          // no pin: contributes nothing
      { pos: { lat: 34.2, lng: -84.0 }, stampMin: null },    // no stamp: contributes nothing
    ]],
    ['R2', [{ pos: { lat: 33.9, lng: -84.2 }, stampMin: 615 }]],
  ]);
  const out = legSamplesFromRoutes(routes);
  assert.equal(out.length, 1, 'exactly one usable consecutive pair');
  assert.equal(out[0].gapMin, 60);
  assert.ok(out[0].meters > 10000 && out[0].meters < 12500, 'about 0.1° of latitude');
});

// ── THE ENGINE USES IT ───────────────────────────────────────────────────────

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const boardStops = () => [
  { stopNbr: '1', matchKey: 'c1', businessName: 'NEAR', loadNbr: 'T', routeSeq: 1, stopType: 'DL',
    lat: 34.10, lng: -84.00, normalizedStatus: 'PLANNED', status: '10', driverName: 'D', driverUserName: 'd' },
  { stopNbr: '2', matchKey: 'far|k', businessName: 'FAR CO', loadNbr: 'T', routeSeq: 2, stopType: 'DL',
    lat: 33.60, lng: -84.60, normalizedStatus: 'PLANNED', status: '10', driverName: 'D', driverUserName: 'd' },
];
const boardNotes = (close) => new Map([['far|k', {
  manual_overrides: { receiving_hours: true },
  receiving_hours: { mon: { open: '06:00', close } },
}]]);
const runBoard = (close, travel) => computeBoardFlags({
  stops: boardStops(), notes: boardNotes(close), servedDate: '2026-08-10', dayKey: 'mon',
  rosterRows: [], opts: { depot: DEPOT, ...(travel ? { travel } : {}) },
});

test('a real drive time changes the verdict the estimate got wrong', () => {
  // Curve says the 49-mile leg lands ~9:27 — past a 9:15 close, so it flags. Google says
  // the truck actually makes it in 48 minutes on I-85 — inside the close. Flag rightly gone.
  const flagged = runBoard('09:15');
  assert.ok(flagged.rows.some((r) => r.rule === 'hours_risk'), 'the curve alone flags this');
  const s = boardStops();
  const legs = {
    [legKey(DEPOT, { lat: s[0].lat, lng: s[0].lng })]: 12 * 60,
    [legKey({ lat: s[0].lat, lng: s[0].lng }, { lat: s[1].lat, lng: s[1].lng })]: 48 * 60,
  };
  const real = runBoard('09:15', { legs });
  assert.ok(!real.rows.some((r) => r.rule === 'hours_risk'), 'the real drive time clears it');
  assert.equal(real.checked.legsGoogle, 2, 'both legs rode on Google');
  assert.equal(real.checked.legsTotal, 2);
});

test('the walk reports which legs it wants, so the sweep can prefetch exactly those', () => {
  const out = runBoard('09:15');
  assert.equal(out.legsWanted.length, 2, 'depot→1 and 1→2');
  for (const l of out.legsWanted) {
    assert.ok(l.key.includes('|'), 'keyed');
    assert.ok(Number.isFinite(l.a.lat) && Number.isFinite(l.b.lat), 'positioned');
  }
});

test('a calibrated service time reaches the clock without a deploy', () => {
  // Same board, service pushed from 14 to 30 minutes — the FAR CO arrival moves ~16 min
  // later, so a close the default service just made now reads as missed.
  const ok = runBoard('09:30');
  assert.ok(!ok.rows.some((r) => r.rule === 'hours_risk'), '9:30 clears on the 14-min dwell');
  const slow = runBoard('09:30', { serviceMin: 30 });
  assert.ok(slow.rows.some((r) => r.rule === 'hours_risk'), 'a 30-min dwell misses it');
});

// ── WHAT THE ADVERSARIAL REVIEW FORCED ───────────────────────────────────────
//
// Every test below exists because an independent review pass produced the failure it
// pins, live, before merge. None of them are hypothetical.

import { sanitizeCurve, curveToDoc, curveFromDoc, MIN_MEASURABLE_MI } from '../src/lib/travel-model.js';
import {
  mergeLegCache, legSecondsMap, LEG_TTL_DAYS, FAILED_LEG_TTL_DAYS, MAX_CACHED_LEGS,
} from '../netlify/functions/lib/travel-store.mts';

test('FIRESTORE CANNOT NEST ARRAYS: the doc codec never emits one, and round-trips', () => {
  // The nightly write of [[at,mph],...] would have been a 400 on every run — caught,
  // logged where nobody reads, and pixel-identical to "no data yet". Dead on arrival.
  const doc = curveToDoc(DEFAULT_CURVE);
  const hasNestedArray = (v) => Array.isArray(v) && v.some((x) => Array.isArray(x)
    || (x && typeof x === 'object' && Object.values(x).some(Array.isArray)));
  assert.equal(hasNestedArray(doc), false, 'an array inside an array cannot reach Firestore');
  assert.ok(doc.every((p) => typeof p === 'object' && 'at' in p && 'mph' in p));
  assert.deepEqual(curveFromDoc(doc), DEFAULT_CURVE, 'what is written is what is read');
});

test('A MALFORMED CURVE CANNOT BLIND THE BOARD: the engine still flags on garbage', () => {
  // Reproduced in review: a maps-shaped curve fed raw made curveMph return undefined,
  // clockMin became NaN, `clockMin > closeMin` was false everywhere, and the board went
  // fully blind while still counting routes as "judged".
  const flaggedByDefault = runBoard('09:15');
  assert.ok(flaggedByDefault.rows.some((r) => r.rule === 'hours_risk'), 'baseline: defaults flag this');
  for (const bad of [[{}], [{ at: 'x', mph: null }], [[null, null]], ['garbage'], [[1]], 42]) {
    const out = runBoard('09:15', { curve: bad });
    const flag = out.rows.find((r) => r.rule === 'hours_risk');
    assert.ok(flag, `curve ${JSON.stringify(bad)} silenced the board`);
    assert.ok(Number.isFinite(flag.etaMin), 'and the ETA is a number, not NaN');
  }
});

test('sanitizeCurve: sorts, dedupes, clamps, and refuses to return an empty ladder', () => {
  assert.deepEqual(sanitizeCurve([[5, 25], [1, 200], [5, 30], [-2, 10], [NaN, 5]]),
    [[1, 60], [5, 25]], 'sorted, clamped to MPH_MAX, dupe distance dropped');
  assert.equal(sanitizeCurve([]), null);
  assert.equal(sanitizeCurve([[0, 5]]), null, 'a zero-distance point is not a curve');
  assert.deepEqual(sanitizeCurve([{ at: 3, mph: 20 }]), [[3, 20]], 'doc maps are a valid input shape');
});

test('SHORT LEGS ARE HONESTLY UNMEASURABLE: dwell noise never becomes a "measured" crawl', () => {
  // Review reproduction: 400 town hops driven at a TRUE 12 mph, with realistic 8-22 min
  // dwell spread, fitted to a "measured" 4-6 mph — because any floor on (gap - service)
  // censors the fast half. Sub-2-mile buckets must refuse the label, not fake the number.
  const jittered = Array.from({ length: 400 }, (_, i) => ({
    meters: 0.3 * MI, gapMin: (0.3 / 12) * 60 + 8 + (i % 15),
  }));
  const fit = fitCurve(jittered, { serviceMin: 14 });
  for (const b of fit.buckets) {
    const lo = Number(b.range.split('–')[0]);
    if (lo < MIN_MEASURABLE_MI) {
      assert.equal(b.source, 'default', `${b.range} claimed 'measured' from unresolvable data`);
    }
  }
});

test('measurable buckets survive the same dwell jitter within a fair margin', () => {
  const jittered = Array.from({ length: 400 }, (_, i) => ({
    meters: 5 * MI, gapMin: (5 / 24) * 60 + 8 + (i % 15),
  }));
  const b = fitCurve(jittered, { serviceMin: 14 }).buckets.find((x) => x.range === '4–8 mi');
  assert.equal(b.source, 'measured');
  assert.ok(Math.abs(b.usedMph - 24) < 4, `true 24, fitted ${b.usedMph}`);
});

test('SEQ-ADJACENT ONLY: a skipped stop cannot fold its dwell into a neighbouring leg', () => {
  // Stops 1 and 3 stamped, stop 2 (between them) not: the 1→3 gap contains 2's dwell and
  // detour, and counting it teaches the curve that roads are slower than any truck.
  const routes = new Map([['R', [
    { pos: { lat: 34.0, lng: -84.0 }, stampMin: 540, seq: 1 },
    { pos: { lat: 34.1, lng: -84.0 }, stampMin: null, seq: 2 },
    { pos: { lat: 34.2, lng: -84.0 }, stampMin: 640, seq: 3 },
  ]]]);
  assert.equal(legSamplesFromRoutes(routes).length, 0, 'the 1→3 pair must not be a sample');
  // No sequence on the route → stamp order still pairs (the filters carry the risk).
  const noSeq = new Map([['R', [
    { pos: { lat: 34.0, lng: -84.0 }, stampMin: 540 },
    { pos: { lat: 34.1, lng: -84.0 }, stampMin: 600 },
  ]]]);
  assert.equal(legSamplesFromRoutes(noSeq).length, 1);
});

// ── THE LEG CACHE'S OWN RULES ────────────────────────────────────────────────

const NOW = '2026-08-20T12:00:00.000Z';
const daysAgo = (n) => new Date(new Date(NOW).getTime() - n * 86400000).toISOString();

test('a failed Google leg is remembered for a day, invisible to the engine, then retried', () => {
  const merged = mergeLegCache(null, { 'a|b': 0, 'c|d': 300 }, NOW);
  assert.ok('a|b' in merged.legs, 'the failure tombstone is stored');
  assert.deepEqual(legSecondsMap(merged), { 'c|d': 300 }, 'the engine never sees a 0-second leg');
  // Aging: the tombstone dies after FAILED_LEG_TTL_DAYS, the real leg lives LEG_TTL_DAYS.
  const aged = mergeLegCache({ legs: {
    'a|b': { sec: 0, at: daysAgo(FAILED_LEG_TTL_DAYS + 1) },
    'c|d': { sec: 300, at: daysAgo(FAILED_LEG_TTL_DAYS + 1) },
    'e|f': { sec: 300, at: daysAgo(LEG_TTL_DAYS + 1) },
  } }, {}, NOW);
  assert.ok(!('a|b' in aged.legs), 'yesterday\'s failure is retryable today');
  assert.ok('c|d' in aged.legs, 'a real leg survives well past a day');
  assert.ok(!('e|f' in aged.legs), 'but not past its own TTL');
});

test('the cache cap evicts oldest-first and never exceeds the doc budget', () => {
  const legs = {};
  for (let i = 0; i < MAX_CACHED_LEGS + 50; i++) legs[`k${i}|x`] = { sec: 100 + i, at: daysAgo(i % 30 / 100) };
  const merged = mergeLegCache({ legs }, {}, NOW);
  assert.ok(Object.keys(merged.legs).length <= MAX_CACHED_LEGS);
});
