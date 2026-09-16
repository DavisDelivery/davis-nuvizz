// test/device-switches.test.mjs — the per-device settings screen's facts.
//
// This screen exists to answer "is this browser the odd one out?" after two incidents where the
// answer was yes and nobody could see it. Every test here pins something that, if wrong, would
// make the screen CONFIDENTLY WRONG — which is worse than not having it, because it sends you
// hunting the thing it just ruled out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEVICE_SWITCHES, readSwitch, effectiveValue, isDefault, switchReport, encodeValue, describeValue,
} from '../src/lib/device-switches.js';

/** A localStorage stand-in. `throws` models private mode / blocked storage. */
const fake = (seed = {}, throws = false) => ({
  getItem: (k) => { if (throws) throw new Error('blocked'); return k in seed ? seed[k] : null; },
});

const byKey = (k) => DEVICE_SWITCHES.find((s) => s.key === k);

// ── THE DEFAULTS MUST MATCH THE APP, OR THE SCREEN LIES ──────────────────────

test('every default here matches the initialiser App.jsx actually uses', () => {
  // NOT a style check — this is the whole correctness of the screen. `mapSatellite` initialises
  // with `!== 'off'` (absent means ON) while `hideStem` uses `=== 'on'` (absent means OFF).
  // Getting one backwards would report a fresh browser as "not at default" and send a
  // dispatcher chasing a switch that was never touched.
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  for (const sw of DEVICE_SWITCHES) {
    const reads = [...app.matchAll(new RegExp(`localStorage\\.getItem\\('${sw.key.replace('.', '\\.')}'\\)\\s*(!==|===)\\s*'([^']+)'`, 'g'))];
    if (!reads.length) continue;            // read via a helper — covered by the explicit cases below
    const [, op, literal] = reads[0];
    if (sw.kind === 'toggle') {
      // THE LITERAL DECIDES, NOT THE OPERATOR — this rule was wrong first time round and the
      // test failed on a registry entry that was correct. There are three shapes in App.jsx:
      //   `=== 'on'`                        absent is OFF
      //   `!== 'off'`                       absent is ON
      //   `if (… === 'off') return false; return true;`   absent is ON
      // The last two both compare against 'off', so a rule keyed on the operator calls the
      // guard-return form a default-OFF switch and reports every fresh browser as an anomaly.
      const impliedDefault = literal === 'off';
      assert.equal(sw.dflt, impliedDefault,
        `${sw.key}: App.jsx compares against '${literal}', so an absent key means ${impliedDefault}`);
    }
  }
});

test('the two switches that default ON are the two that default ON', () => {
  // Spelled out as well as derived, because this is the pair most likely to be "tidied" wrong.
  assert.equal(byKey('routing.compareLive').dflt, true);
  assert.equal(byKey('routing.mapSatellite').dflt, true);
  for (const k of ['routing.liveWrite', 'routing.hideStem', 'routing.hideLabels',
    'routing.mapShowRoutes', 'routing.mapUnplannedOnly', 'routing.mapHideTerminal']) {
    assert.equal(byKey(k).dflt, false, `${k} defaults off`);
  }
});

test('Live dispatch defaults OFF — the v1.36.0 incident', () => {
  // "where is my save send to nuvizz button? … i have no way to send these loads to nuvizz."
  // Four controls, one gate, seeded OFF. A fresh browser hides the Send button and always has.
  const sw = byKey('routing.liveWrite');
  assert.equal(effectiveValue(fake({}), sw), false, 'a fresh browser has it off');
  assert.equal(isDefault(fake({}), sw), true, 'and that IS the default — not an anomaly');
  assert.match(sw.symptom, /Send to NuVizz|v1\.36\.0/);
});

// ── READING THE CURRENT STATE ────────────────────────────────────────────────

test('an absent key resolves to the switch\'s own default, not to false', () => {
  assert.equal(effectiveValue(fake({}), byKey('routing.mapSatellite')), true);
  assert.equal(effectiveValue(fake({}), byKey('routing.hideStem')), false);
});

test('a stored value wins over the default, both ways', () => {
  assert.equal(effectiveValue(fake({ 'routing.mapSatellite': 'off' }), byKey('routing.mapSatellite')), false);
  assert.equal(effectiveValue(fake({ 'routing.hideStem': 'on' }), byKey('routing.hideStem')), true);
});

test('a junk value falls back to the default rather than guessing', () => {
  // A key written by an older build, or by hand, must not flip a switch to a third state.
  assert.equal(effectiveValue(fake({ 'routing.liveWrite': 'yes' }), byKey('routing.liveWrite')), false);
  assert.equal(effectiveValue(fake({ 'routing.planMode': 'wagons' }), byKey('routing.planMode')), 'loads');
});

test('blocked storage reads as "everything default" instead of throwing under Diagnostics', () => {
  // Private mode, cleared site data, an embedded webview. The screen must still render.
  const r = switchReport(fake({}, true));
  assert.equal(r.rows.length, DEVICE_SWITCHES.length);
  assert.equal(r.offDefault.length, 0);
  assert.equal(readSwitch(fake({}, true), byKey('routing.liveWrite')), null);
});

// ── THE BANNER, WHICH IS THE POINT OF THE SCREEN ─────────────────────────────

test('a fresh browser reports nothing off-default', () => {
  // "Whatever you are chasing is not a switch" has to be trustworthy or nobody reads the screen.
  assert.deepEqual(switchReport(fake({})).offDefault, []);
});

test('the banner names exactly the switches that are off-default', () => {
  // The v1.36.2 morning: no PR touched the stem line, hideStem had simply never been set on
  // that browser. This is the line that would have ended it in seconds.
  const r = switchReport(fake({ 'routing.mapUnplannedOnly': 'on', 'routing.mapSatellite': 'off' }));
  assert.deepEqual(r.offDefault.map((x) => x.key).sort(),
    ['routing.mapSatellite', 'routing.mapUnplannedOnly']);
  assert.equal(r.rows.find((x) => x.key === 'routing.hideStem').def, true, 'untouched ones stay quiet');
});

test('a value stored equal to the default is NOT reported as an anomaly', () => {
  // Writing 'off' to a switch that already defaults off must not light the banner — otherwise
  // pressing a toggle twice leaves a permanent false alarm.
  assert.deepEqual(switchReport(fake({ 'routing.hideStem': 'off' })).offDefault, []);
});

// ── WRITING ─────────────────────────────────────────────────────────────────

test('a toggle writes the vocabulary the app reads back', () => {
  const sw = byKey('routing.liveWrite');
  assert.equal(encodeValue(sw, true), 'on');
  assert.equal(encodeValue(sw, false), 'off');
  // Round trip: what we write must read back as what we meant.
  assert.equal(effectiveValue(fake({ [sw.key]: encodeValue(sw, true) }), sw), true);
});

test('a choice cannot be written to a value the app does not understand', () => {
  const sw = byKey('routing.engineMode');
  assert.equal(encodeValue(sw, 'cleanup'), 'cleanup');
  assert.equal(encodeValue(sw, 'nonsense'), 'driver', 'falls back to the default');
});

// ── EVERY ROW EARNS ITS PLACE ───────────────────────────────────────────────

test('every switch says what it does AND what a wrong one looks like', () => {
  // The symptom line is the reason this screen exists. A row without one is a toggle with no
  // explanation, which is the thing we already had.
  for (const sw of DEVICE_SWITCHES) {
    assert.ok(sw.label && sw.label.length > 2, `${sw.key} needs a label`);
    assert.ok(sw.does && sw.does.length > 20, `${sw.key} needs a plain-English "what it does"`);
    assert.ok(sw.symptom && sw.symptom.length > 20, `${sw.key} needs a symptom line`);
  }
});

test('no layout memory is in the list — Chad asked for behaviour only', () => {
  const keys = DEVICE_SWITCHES.map((s) => s.key);
  for (const layout of ['routing.selPanelW', 'routing.tab', 'routing.rightPanel',
    'routing.rail', 'routing.loadsRail', 'dd_more_open', 'routing.leftPanel']) {
    assert.ok(!keys.includes(layout), `${layout} is layout memory, not behaviour`);
  }
});

test('every key in the list is one the app actually reads', () => {
  // A row for a key nothing reads is a toggle that does nothing — decoration that reads as
  // protection, which is the failure check-rwb-untouched.mjs warns about in its own comments.
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  for (const sw of DEVICE_SWITCHES) {
    assert.ok(app.includes(`'${sw.key}'`), `${sw.key} is not referenced in App.jsx`);
  }
});

test('the section is registered in Diagnostics, on both views', () => {
  // DIAG_SECTIONS drives the desktop rail AND the phone chip row from one array, so one entry
  // covers both — but if it is missing the screen does not exist anywhere.
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /\{ id: 'switches', label: 'This device'/);
  assert.match(app, /switches: <DeviceSwitchesPanel \/>/);
});

test('describeValue reads as English for toggles and as the word for choices', () => {
  assert.equal(describeValue(byKey('routing.liveWrite'), true), 'On');
  assert.equal(describeValue(byKey('routing.liveWrite'), false), 'Off');
  assert.equal(describeValue(byKey('routing.planMode'), 'trucks'), 'trucks');
});
