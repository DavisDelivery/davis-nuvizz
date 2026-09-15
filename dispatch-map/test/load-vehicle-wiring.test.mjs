// test/load-vehicle-wiring.test.mjs — the Box/Tractor tap stays CONNECTED, and it persists.
//
// resolveLoadVehicle passes its own tests whether or not App.jsx calls it, and the half Chad
// actually asked for — "have system remember the choice going forward" — is a Firestore write
// that no unit test can see. A rule wired to nothing is this repo's recurring failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
// Drop the changelog rows: they quote this feature's own wording.
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');

test('the panel builds each load row’s vehicle from the rule, not from a regex of its own', () => {
  assert.ok(/import \{[^}]*\bresolveLoadVehicle\b[^}]*\} from '\.\/lib\/routing-select\.js';/.test(code), 'resolveLoadVehicle is not imported');
  assert.ok(/import \{[^}]*\bloadVehicleChoices\b[^}]*\}/.test(code), 'loadVehicleChoices is not imported');
  assert.ok(/import \{[^}]*\bloadVehicleKey\b[^}]*\}/.test(code), 'loadVehicleKey is not imported');
  assert.ok(/const loadVehicleFor = useCallback\(\(row\) => resolveLoadVehicle\(\{/.test(code), 'the row does not resolve through the rule');
  assert.ok(/const veh = loadVehicleFor\(r\);/.test(code), 'the load row does not ask for its vehicle');
});

test('THE ROW IS A QUICK BOX/TRACTOR BUTTON — the profile dropdown is gone', () => {
  assert.ok(/loadVehicleChoices\(profiles\)\.map\(\(c, i\) => \(/.test(code), 'the two buttons are not rendered from the rule');
  assert.ok(/onClick=\{\(\) => pickLoadVehicle\(r, c\.cls\)\}/.test(code), 'the buttons do not pick a class');
  // The old control: a <select> listing every truck profile, defaulted by a name regex.
  assert.ok(!/setPlanTargetProfileById/.test(code), 'the per-load profile <select> is back');
  assert.ok(!/const guessProfileFor = /.test(code), 'the name-regex default is back as the only source');
});

test('A TAP REMEMBERS IT — the half a unit test cannot see', () => {
  const m = /const pickLoadVehicle = useCallback\(\(row, cls\) => \{([\s\S]*?)\n  \}, /.exec(code);
  assert.ok(m, 'pickLoadVehicle is no longer the tap handler');
  assert.ok(/setPlanTargetClassById\(/.test(m[1]), 'the tap does not change this build');
  assert.ok(/rememberLoadVehicle\(row\.display, cls\)/.test(m[1]), 'the tap does not remember the choice for next time');
  assert.ok(/const \{ loadVehicleByKey, rememberLoadVehicle \} = useLoadVehicles\(\);/.test(code), 'the screen does not subscribe to the memory');
});

test('the memory is keyed on the load NAME — loadId and loadNbr are minted fresh every day', () => {
  assert.ok(/remembered: loadVehicleByKey\.get\(loadVehicleKey\(row\?\.display\)\)/.test(code), 'the memory is not looked up by name');
  const m = /const remember = useCallback\(async \(name, cls\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(code);
  assert.ok(m, 'the memory has no writer');
  assert.ok(/const key = loadVehicleKey\(name\);/.test(m[1]), 'the write is not keyed by name');
});

test('THE DAY RESET CLEARS THE PICKS AND NOT THE MEMORY — being right tomorrow is the point', () => {
  const m = /useEffect\(\(\) => \{ setPlanTargetKeys\(new Set\(\)\);([\s\S]*?)\}, \[selectedDate\]\);/.exec(code);
  assert.ok(m, 'the date reset is gone');
  assert.ok(/setPlanTargetClassById\(new Map\(\)\)/.test(m[1]), 'this session’s taps are not cleared on a date change');
  assert.ok(!/loadVehicleByKey|setByKey/.test(m[1]), 'the remembered classes are wiped on a date change');
});

test('the shared write is FIELD-MASKED and a refusal is reported, never swallowed', () => {
  const m = /const unsub = onSnapshot\(collection\(db, 'routing_load_vehicles'\)([\s\S]*?)\n  \}, \[\]\);/.exec(code);
  assert.ok(m, 'the memory does not subscribe to routing_load_vehicles');
  assert.ok(/reportDenied\('routing_load_vehicles', err\)/.test(m[1]), 'a refused read says nothing');
  // Scoped to the writer's own body on purpose: a lazy match across the whole file happily
  // borrowed truck_profiles' `{ merge: true }` twenty lines down and passed a blind setDoc.
  const w = /const remember = useCallback\(async \(name, cls\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(code);
  assert.ok(w, 'the memory has no writer');
  assert.ok(/setDoc\(doc\(db, 'routing_load_vehicles', key\)/.test(w[1]), 'the memory is not written to its own collection');
  assert.ok(/\}, \{ merge: true \}\)/.test(w[1]), 'the write is a blind setDoc — it would REPLACE the document');
  assert.ok(/reportDenied\('routing_load_vehicles', e, 'write'\)/.test(w[1]), 'a refused write says nothing');
});

test('NUVIZZ’S OWN CLASS IS READ FOR THE DAY ON SCREEN, and only for that day', () => {
  const m = /const assignedClassFor = useCallback\(\(row\) => \{([\s\S]*?)\n  \}, /.exec(code);
  assert.ok(m, 'the panel does not read the assigned class at all');
  assert.ok(/travelInputs\?\.routeClassesDate !== selectedDate/.test(m[1]), 'a class map from another day would be used as if it were today’s');
  assert.ok(/map\[row\?\.display\]/.test(m[1]) && /map\[row\.loadNbr\]/.test(m[1]), 'only one of the two keys route-classes publishes is looked up');
  assert.ok(/assigned: assignedClassFor\(row\)/.test(code), 'the assigned class never reaches the rule');
});

test('the build sends the RESOLVED profile’s capacity, so the tap actually changes the plan', () => {
  const m = /const planTargets = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[planPickRows/.exec(code);
  assert.ok(m, 'planTargets is gone');
  assert.ok(/const v = loadVehicleFor\(r\);/.test(m[1]), 'the build target does not resolve its vehicle');
  assert.ok(/profile: v\.profile/.test(m[1]), 'the build target does not carry the resolved profile');
  assert.ok(/maxSkids: t\.profile\.maxSkids/.test(code), 'the solver truck no longer takes the profile’s skid cap');
});

test('the conflict line renders only when it is real', () => {
  assert.ok(/\{on && veh\.conflict && \(/.test(code), 'the conflict line is unconditional or gone');
  assert.ok(/NuVizz has a \{veh\.assigned === 'tractor' \? 'tractor' : 'box truck'\}/.test(code), 'the conflict line does not name what NuVizz has');
});
