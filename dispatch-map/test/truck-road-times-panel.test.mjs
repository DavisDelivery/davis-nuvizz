// test/truck-road-times-panel.test.mjs — THE BUILD PANEL'S TRUCK-ROAD BOX, AND WHAT THE RESULT SAYS.
//
// Step 3 · Plan gets a second road drive-time box beside Google's: "Use truck road times (free)",
// our own routing service (server side: lib/osrm-matrix.mts). These pin the rules
// (lib/routing-select.js) and the one-line connections in App.jsx a stale merge could drop —
// and that with both boxes unticked the build request is exactly what it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildMatrixMode, matrixReadout, editedSequenceNote, truckRoadStatusLine, strategyChoices, effectiveStrategy } from '../src/lib/routing-select.js';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');
const between = (start, end) => { const a = code.indexOf(start); assert.ok(a >= 0, `anchor missing: ${start}`); const b = code.indexOf(end, a + start.length); assert.ok(b > a, `anchor missing: ${end}`); return code.slice(a, b); };

// ── the rules ───────────────────────────────────────────────────────────────────────────────

test('UNTICKED = UNCHANGED: both boxes off sends haversine and keeps the strategy rule it had', () => {
  assert.equal(buildMatrixMode({ useGoogle: false, useTruckRoads: false }), 'haversine');
  assert.equal(buildMatrixMode(), 'haversine');
  assert.equal(effectiveStrategy('MIN_TIME', false || false), 'MIN_DISTANCE');
});

test('Google on sends google, as today; truck roads on sends osrm; Google wins if both ever arrive set', () => {
  assert.equal(buildMatrixMode({ useGoogle: true }), 'google');
  assert.equal(buildMatrixMode({ useTruckRoads: true }), 'osrm');
  assert.equal(buildMatrixMode({ useGoogle: true, useTruckRoads: true }), 'google');
  assert.equal(buildMatrixMode({ useGoogle: 'yes' }), 'haversine', 'only a real true opts in');
});

test('Min time is live on truck road times as well as Google', () => {
  assert.ok(strategyChoices(true).every((c) => !c.disabled));
  assert.equal(effectiveStrategy('MIN_TIME', true), 'MIN_TIME');
});

test('the result readout for a Google build reads as it does today: Google live drive-times, amber, no note', () => {
  assert.deepEqual(matrixReadout({ matrixSource: 'google', matrixMode: 'google' }), { title: 'Google live drive-times', tone: 'amber', note: null });
});

test('the result readout for a free build reads as it does today: Free estimate (straight-line), green, no note', () => {
  assert.deepEqual(matrixReadout({ matrixSource: 'haversine', matrixMode: 'haversine' }), { title: 'Free estimate (straight-line)', tone: 'green', note: null });
  assert.deepEqual(matrixReadout({}), { title: 'Free estimate (straight-line)', tone: 'green', note: null });
  assert.deepEqual(matrixReadout(undefined), { title: 'Free estimate (straight-line)', tone: 'green', note: null });
});

test('a build that asked for truck road times and fell back to the straight line SAYS SO on its result', () => {
  const r = matrixReadout({ matrixMode: 'osrm', matrixSource: 'haversine', matrixDetail: null });
  assert.equal(r.title, 'Free estimate (straight-line)');
  assert.equal(r.note, 'Truck road times were asked for, but the service did not answer. This build used the straight-line estimate.');
});

test('a truck-road build reads Truck road times (free), green; with nothing estimated it adds no note', () => {
  assert.deepEqual(matrixReadout({ matrixMode: 'osrm', matrixSource: 'osrm', matrixDetail: { estimatedPairs: 0, noRoutePairs: 0, offMapStops: [] } }), { title: 'Truck road times (free)', tone: 'green', note: null });
});

test('a truck-road build with a stop outside Georgia and legs with no truck route counts both and says they are straight-line estimates', () => {
  const r = matrixReadout({ matrixMode: 'osrm', matrixSource: 'osrm', matrixDetail: { estimatedPairs: 7, noRoutePairs: 3, offMapStops: [{ index: 4, snapMeters: 19056 }] } });
  assert.equal(r.note, '1 stop is off the truck map (outside Georgia, or not near a truck road); 3 legs had no truck route. Those legs are straight-line estimates.');
  const one = matrixReadout({ matrixSource: 'osrm', matrixDetail: { noRoutePairs: 1, offMapStops: [] } });
  assert.equal(one.note, '1 leg had no truck route. That leg is a straight-line estimate.');
  const two = matrixReadout({ matrixSource: 'osrm', matrixDetail: { noRoutePairs: 0, offMapStops: [{ index: 0 }, { index: 2 }] } });
  assert.equal(two.note, '2 stops are off the truck map (outside Georgia, or not near a truck road). Their legs are straight-line estimates.');
});

test('the route card\'s Sequence edited line names Google as today, truck road times when those were the source, and nothing on the straight line', () => {
  assert.equal(editedSequenceNote({ matrixSource: 'google' }), ' (original Google road times no longer apply to this order)');
  assert.equal(editedSequenceNote({ matrixSource: 'osrm' }), ' (original truck road times no longer apply to this order)');
  assert.equal(editedSequenceNote({ matrixSource: 'haversine', matrixMode: 'osrm' }), '');
  assert.equal(editedSequenceNote(undefined), '');
});

test('the status line under the box, for each answer osrm-status can give', () => {
  assert.equal(truckRoadStatusLine({ state: 'unknown' }), 'Not checked yet.');
  assert.match(truckRoadStatusLine({ state: 'off' }), /not set up on this site yet, so builds keep the straight-line estimate/);
  assert.ok(!/OSRM_TRUCK_URL/.test(truckRoadStatusLine({ state: 'off' })), 'no env-var name in front of a dispatcher');
  assert.equal(truckRoadStatusLine({ state: 'ready', sample: { miles: 15.2, minutes: 24.8 } }), 'Ready: Buford to Lawrenceville is 15.2 mi, 24.8 min by truck road.');
  assert.match(truckRoadStatusLine({ state: 'waking' }), /starting up\. Checking again shortly/);
  const err = truckRoadStatusLine({ state: 'error', error: 'The caller lacks Cloud Run Invoker on osrm-truck (403).' });
  assert.match(err, /Cloud Run Invoker/);
  assert.match(err, /A build will fall back to the straight-line estimate and say so\./);
  assert.match(truckRoadStatusLine('checking'), /Checking/);
});

// ── the wiring ──────────────────────────────────────────────────────────────────────────────

const step3 = between('<div className="font-semibold text-slate-700">3 · Plan</div>', '<button onClick={runBuild}');

test('the truck-road box sits on the same row as Google\'s, in one wrapping row, and Google keeps its cost', () => {
  const row = between('data-drive-times-row>', '        </div>\n');
  assert.ok(/className="flex flex-wrap/.test(step3.slice(step3.indexOf('data-drive-times-row') - 120)), 'the row does not wrap');
  const g = row.indexOf('Use live Google drive-times');
  const t = row.indexOf('Use truck road times <b>(free)</b>');
  assert.ok(g >= 0 && t > g, 'both boxes are not in the one row, Google first');
  assert.ok(/\(costs money\)/.test(row) && /\$\{wouldBeCost\.toFixed\(2\)\}/.test(row), 'Google lost its cost line');
  const truckLabel = row.slice(t);
  assert.ok(!/wouldBeCost|\$\{/.test(truckLabel), 'the truck box shows a cost line');
});

test('each box unticks the other — only one matrix source can run', () => {
  assert.ok(/checked=\{useGoogle\} onChange=\{\(e\) => \{ setUseGoogle\(e\.target\.checked\); if \(e\.target\.checked\) \{ setUseTruckRoads\(false\);/.test(step3), 'ticking Google does not untick truck roads');
  assert.ok(/checked=\{useTruckRoads\} disabled=\{truckRoadStatus\.state === 'off'\} onChange=\{\(e\) => \{ const on = e\.target\.checked; setUseTruckRoads\(on\); if \(on\) \{ setUseGoogle\(false\); checkTruckRoads\(\); \}/.test(step3), 'ticking truck roads does not untick Google and check the service');
});

test('both boxes default unticked, per build, not persisted', () => {
  assert.ok(/const \[useGoogle, setUseGoogle\] = useState\(false\);/.test(code));
  assert.ok(/const \[useTruckRoads, setUseTruckRoads\] = useState\(false\);/.test(code));
  assert.ok(!/LS_[A-Z_]*TRUCK_ROAD/.test(code), 'the truck-road box is persisted');
});

test('the panel asks ?check=config once when it opens, and the full check only on tick, polling waking every 10 s for up to 90 s', () => {
  assert.ok(/apiFetch\('\/\.netlify\/functions\/osrm-status\?check=config'\)/.test(code), 'no config check on open');
  const check = between('const checkTruckRoads = useCallback(', '  }, []);');
  assert.ok(/apiFetch\('\/\.netlify\/functions\/osrm-status'\)/.test(check));
  assert.ok(/st\?\.state === 'waking'/.test(check) && /setTimeout\(res, 10_000\)/.test(check) && /90_000/.test(check), 'waking is not re-asked every 10 s within 90 s');
  assert.ok(/state === 'off'\) \{ setTruckRoadStatus\(\{ state: 'off' \}\); setUseTruckRoads\(false\);/.test(check), 'off does not untick');
});

test('the request carries buildMatrixMode, the Build button names truck road times, the diagnostics carry use_truck_roads', () => {
  const req = between('    const request = {', '    setLastRequest(request);');
  assert.ok(/matrixMode: buildMatrixMode\(\{ useGoogle, useTruckRoads \}\)/.test(req));
  assert.ok(!/matrixMode: useGoogle \?/.test(req), 'the old Google-only ternary is back');
  assert.ok(/useGoogle \? 'Build with Google drive-times' : useTruckRoads \? 'Build \(truck road times\)' : 'Build \(free estimate\)'/.test(code), 'the Build button wording');
  assert.ok(/useGoogle \? ' · Google drive-times' : useTruckRoads \? ' · truck road times' : ''/.test(code), 'the loads wording');
  assert.ok(/use_google: useGoogle,\n\s+use_truck_roads: useTruckRoads,/.test(code), 'diagnostics');
});

test('the result readout reads matrixReadout, and the route card line reads editedSequenceNote', () => {
  const panel = between('function RoutingResultPanel(', '\nfunction ');
  assert.ok(/const readout = matrixReadout\(meta\);/.test(panel));
  assert.ok(/<div className="font-semibold">\{readout\.title\}<\/div>/.test(panel));
  assert.ok(/\{readout\.note && /.test(panel), 'the fallback note is not shown');
  assert.ok(!/'Google live drive-times' : 'Free estimate \(straight-line\)'/.test(panel), 'the hard-coded two-way title is back');
  assert.ok(/editedNote=\{editedSequenceNote\(meta\)\}/.test(panel));
  const card = between('function RoutingRouteCard(', '\nfunction ');
  assert.ok(/Sequence edited — drive times are straight-line estimates\{editedNote\}\./.test(card));
});
