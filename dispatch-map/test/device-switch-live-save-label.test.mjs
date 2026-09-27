// test/device-switch-live-save-label.test.mjs
//
// DIAGNOSTICS DESCRIBED THE LIVE / BETA SAVE SWITCH AS A CARD-REFRESH SETTING (audit
// 2026-09-27, client-orders-labels-territory-libs-3).
//
// Diagnostics → "Settings this browser remembers" listed routing.compareLive as "Compare cards
// follow the live board", with the symptom "a card can show a stop the board has already moved".
// In App.jsx that key's only reader is the Compare workbench's liveMode — the ● LIVE / ○ Beta
// chip. OFF, every Save is a Beta preview ("Beta — nothing sent"). So the one screen built to
// explain hidden switches gave the wrong explanation for the switch that makes every Save a
// simulation, and invited a dispatcher to flip it for the wrong reason.
//
// What happens now: the entry says what the switch actually does. Text only — the key, the
// default and the behaviour are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEVICE_SWITCHES, switchReport } from '../src/lib/device-switches.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const sw = DEVICE_SWITCHES.find((s) => s.key === 'routing.compareLive');

test('a dispatcher whose Saves are only Beta previews finds the reason named in Diagnostics', () => {
  // The fact the text must match: the key feeds liveMode, and liveMode off short-circuits Save.
  assert.match(APP, /const \[liveMode, setLiveMode\] = useState\(\(\) => \{\s*try \{ if \(localStorage\.getItem\('routing\.compareLive'\) === 'off'\) return false;/);
  assert.match(APP, /if \(!liveMode\) \{[^\n]*Beta — nothing sent/);

  const text = `${sw.label} ${sw.does} ${sw.symptom}`;
  assert.match(text, /Save/, 'the entry is about Save');
  assert.match(text, /LIVE/);
  assert.match(text, /Beta/);
  assert.match(sw.symptom, /nothing (is )?sent|nothing reaches NuVizz/i, 'OFF is described as Saves not reaching NuVizz');
  assert.doesNotMatch(text, /follow the live board|keep reading the board|already moved/, 'the card-refresh description is gone');
});

test('the switch is still the same switch: key, default ON and on/off words unchanged', () => {
  assert.equal(sw.kind, 'toggle');
  assert.equal(sw.dflt, true);
  assert.equal(sw.on, 'on');
  assert.equal(sw.off, 'off');
  const r = switchReport({ getItem: (k) => (k === 'routing.compareLive' ? 'off' : null) });
  assert.ok(r.offDefault.some((x) => x.key === 'routing.compareLive'), 'a Beta device is still reported as off its default');
});
