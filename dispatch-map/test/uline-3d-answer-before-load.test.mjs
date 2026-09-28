// test/uline-3d-answer-before-load.test.mjs
//
// THE ULINE 3D PANE STUCK ON "Loading the 3D view…" (audit 2026-09-27, app-A3-7).
//
// UlineThreeD builds ONE Map3DElement per open tab and re-points it per row. The first build
// waits on google.maps.importLibrary('maps3d'). If the dispatcher answered row 1 (N, T or S) —
// or switched the phone view — while that import was still in flight, React ran the effect's
// cleanup (run 1 is now dead) and ran it again for row 2. Run 2 saw a build in progress and
// simply returned: no camera move, no settle timer. Run 1 then finished the build aimed at row
// 1 and returned because it was dead. Nobody ever said ready, so row 2's 3D pane — the view the
// screen calls "the one that answers the question" — stayed covered for the whole row.
//
// These RUN the effect body out of App.jsx, verbatim, the way React drives it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8').split('\n');
const comp = APP.findIndex((l) => l.startsWith('function UlineThreeD('));
const start = APP.findIndex((l, i) => i > comp && l.trim() === 'React.useEffect(() => {');
const end = APP.findIndex((l, i) => i > start && l.trim() === '}, [active, google, pin?.lat, pin?.lng]);');
const BODY = APP.slice(start + 1, end).join('\n');

function harness({ importFails = false } = {}) {
  const refs = {
    holder: { current: { clientHeight: 400, appendChild() {} } },
    elRef: { current: null }, markerRef: { current: null }, libRef: { current: null },
    building: { current: false },
  };
  const log = [];
  const flown = [];
  let settle;
  const libArrived = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  class Map3DElement {
    constructor(o) { this.o = o; this.style = {}; }
    addEventListener() {}
    appendChild() {}
    flyCameraTo({ endCamera }) { flown.push(endCamera.center); }
  }
  const lib = { Map3DElement, AltitudeMode: { RELATIVE_TO_GROUND: 'G', RELATIVE_TO_MESH: 'M' } };
  const google = { maps: { importLibrary: () => libArrived } };
  // eslint-disable-next-line no-new-func
  const effect = new Function('holder', 'elRef', 'markerRef', 'libRef', 'building', 'setReady', 'setErr',
    'MAP_3D_ON', 'webglUsable', 'MAP3D_NO_WEBGL', 'cameraFor2dView', 'groundedCamera', 'ULINE_3D_SETTLE_MS',
    'active', 'google', 'pin', BODY);
  const run = (pin) => effect(refs.holder, refs.elRef, refs.markerRef, refs.libRef, refs.building,
    (v) => log.push(['ready', v]), (v) => log.push(['err', v]),
    true, () => true, 'no webgl', ({ center }) => ({ center, range: 100, tilt: 60, heading: 0, mode: 'x' }), (c) => c, 5,
    true, google, pin);
  const loaded = async () => {
    if (importFails) settle.reject(new Error('Google refused the 3D view')); else settle.resolve(lib);
    await new Promise((r) => setTimeout(r, 60));
  };
  return { run, loaded, log, flown, refs };
}

const ROW1 = { lat: 34.1, lng: -84.0 };
const ROW2 = { lat: 34.2, lng: -84.1 };
const readyAfter = (log, i) => log.slice(i).some(([k, v]) => k === 'ready' && v === true);

test('the dispatcher answers row 1 before Google\'s 3D library loads — row 2\'s 3D view still appears', async () => {
  const h = harness();
  const cleanup1 = h.run(ROW1);   // row 1 mounts; maps3d starts loading
  cleanup1();                     // N/T/S pressed — React cleans up row 1…
  const mark = h.log.length;
  h.run(ROW2);                    // …and runs row 2
  await h.loaded();               // the library arrives
  assert.ok(h.refs.elRef.current, 'the one element was built');
  assert.ok(readyAfter(h.log, mark), 'row 2\'s pane is uncovered');
  assert.deepEqual(h.flown.at(-1), ROW2, 'and it is aimed at row 2\'s building, not row 1\'s');
});

test('React\'s double mount on first open does not leave the pane covered either', async () => {
  const h = harness();
  h.run(ROW1)();                  // StrictMode: mount, cleanup…
  h.run(ROW1);                    // …mount again, same pin
  await h.loaded();
  assert.ok(readyAfter(h.log, 0));
  assert.deepEqual(h.flown.at(-1), ROW1);
});

test('only ONE element is ever built, however many rows go by during the load', async () => {
  const h = harness();
  let built = 0;
  const Orig = h.refs.holder.current.appendChild;
  h.refs.holder.current.appendChild = (el) => { built += 1; Orig(el); };
  h.run(ROW1)();
  h.run(ROW2)();
  h.run({ lat: 34.3, lng: -84.2 });
  await h.loaded();
  assert.equal(built, 1, 'Google bills 3D per element created');
  assert.deepEqual(h.flown.at(-1), { lat: 34.3, lng: -84.2 });
});

test('a 3D library Google refuses mid-row is said, not left as "Loading"', async () => {
  const h = harness({ importFails: true });
  h.run(ROW1)();
  h.run(ROW2);
  await h.loaded();
  assert.ok(h.log.some(([k, v]) => k === 'err' && /refused/.test(v)), 'the refusal reaches the pane');
});

test('an ordinary single load still lands and uncovers the pane', async () => {
  const h = harness();
  h.run(ROW1);
  await h.loaded();
  assert.ok(readyAfter(h.log, 0));
  assert.deepEqual(h.flown.at(-1), ROW1);
});
