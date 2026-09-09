// test/place-key-wiring.test.mjs — the place key must stay WIRED into all three protections.
// Three separate things answer "is this the same dock?" and all three were keyed on the
// customer's name, so all three failed together on 2026-09-09. A pure-module test would have
// passed the whole time; these pin the connections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
const flagsSrc = await readFile(fileURLToPath(new URL('../src/lib/board-flags.js', import.meta.url)), 'utf8');

test('the pin badge and click-the-place both key on the PLACE', () => {
  // TIGHTENED, NOT LOOSENED. This used to assert the fallback chain inline in App.jsx. A
  // FOURTH consumer then needed the same answer — the board-flags trailer rule, which was
  // showing one dock as two cards — and a copied chain is exactly how the three original
  // sites drifted apart and failed together. The chain now lives in placeKeyOfStop, so what
  // this pins is that App.jsx asks the shared helper rather than rolling its own.
  assert.ok(/const stopLocKey = \(s\) => placeKeyOfStop\(s\);/.test(src),
    'stopLocKey has its own key again — the "2 orders here" badge and group-select can drift');
  assert.ok(/import \{[^}]*placeKeyOfStop[^}]*\} from '\.\/lib\/matchKey\.js';/.test(src));
  assert.ok(!/normalizePlaceKey\(s\?\.addr1/.test(src), 'no second copy of the fallback chain');
});

test('the board-flags trailer rule asks the SAME helper — one dock, one answer', () => {
  // The fourth consumer. Keyed on the stop it printed a card per ORDER, so a pickup and a
  // delivery at one dock were two identical warnings, and the "N other stops carry the same
  // mark" count (which also rides the SMS) counted the twin.
  assert.ok(/import \{ placeKeyOfStop \} from '\.\/matchKey\.js';/.test(flagsSrc));
  assert.ok(/const dock = `\$\{c\.k\}\|\$\{placeKeyOfStop\(c\.s\)\}`;/.test(flagsSrc),
    'the trailer rule is keyed per stop again — Jewel Reign shows up twice');
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
