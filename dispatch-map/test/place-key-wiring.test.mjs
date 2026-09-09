// test/place-key-wiring.test.mjs — the place key must stay WIRED into all three protections.
// Three separate things answer "is this the same dock?" and all three were keyed on the
// customer's name, so all three failed together on 2026-09-09. A pure-module test would have
// passed the whole time; these pin the connections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('the pin badge and click-the-place both key on the PLACE', () => {
  assert.ok(/const stopLocKey = \(s\) => normalizePlaceKey\(s\?\.addr1, s\?\.zip\) \|\| s\?\.matchKey \|\| String\(s\?\.stopNbr \?\? ''\);/.test(src),
    'stopLocKey is back on matchKey — the "2 orders here" badge and group-select go blind again');
  assert.ok(/import \{ normalizeMatchKey, normalizePlaceKey \} from '\.\/lib\/matchKey\.js';/.test(src));
});

test('the same-address twin guard keys on the PLACE, and only over unplanned orders', () => {
  assert.ok(/let byPlace = null;/.test(src), 'the twin guard is back on matchKey — this is the bug that lost a delivery');
  assert.ok(!/if \(!t\?\.matchKey \|\| !t\.isUnplanned\) continue;/.test(src));
  assert.ok(/const k = stopLocKey\(t\);\s*\n\s*if \(!k \|\| !t\?\.isUnplanned\) continue;/.test(src),
    'an order already planned must not be dragged off its load, and an empty key must not group');
  assert.ok(/byPlace\.get\(stopLocKey\(s\)\)/.test(src));
});

test('the guard is still LOUD — a silently added order is the failure in the other direction', () => {
  assert.ok(/label: `\$\{t\.stopNbr\} \(\$\{t\.businessName \|\| 'same address'\}\)`/.test(src),
    'the twin must still name itself, so the dispatcher can see and remove what rode along');
});
