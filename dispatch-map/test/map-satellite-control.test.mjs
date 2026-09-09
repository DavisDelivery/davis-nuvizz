// THE SATELLITE CONTROL SAYS WHICH WAY IT WILL GO — on both screens, in the same words.
//
// This exists because the control is built TWICE and one of the two cannot be tested any
// other way. The dispatch Map hands Google a plain DOM button so it stacks beside the
// Recenter crosshair; Routing renders a React button in its tool rail. The dispatch Map's
// button is created inside the Maps init, so in CI — where there is no API key and the map
// never loads — it does not exist to be inspected. Two implementations of one control, one
// of them invisible to every browser guard, is precisely how wording and on/off treatment
// drift apart. The spec is pure so it can be run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  satelliteControlSpec, paintSatelliteControl, globeSvg,
  SATELLITE_ON_BG, SATELLITE_OFF_BG, SATELLITE_BUTTON_CSS,
} from '../src/lib/map-satellite-control.js';

test('the label says which way a press will go, not merely where the switch is', () => {
  // "Satellite view" on a lit button cannot be read: is it describing the base you are on,
  // or the one you would get? A toggle whose position cannot be read is not a toggle.
  assert.match(satelliteControlSpec(true).label, /^Satellite view on — switch to the road map$/);
  assert.match(satelliteControlSpec(false).label, /^Satellite view off — switch to satellite$/);
  assert.notEqual(satelliteControlSpec(true).label, satelliteControlSpec(false).label);
});

test('aria-pressed carries the state, as a string, both ways', () => {
  assert.equal(satelliteControlSpec(true).ariaPressed, 'true');
  assert.equal(satelliteControlSpec(false).ariaPressed, 'false');
});

test('on and off are visually distinct — lit is the brand blue with a white glyph', () => {
  const on = satelliteControlSpec(true); const off = satelliteControlSpec(false);
  assert.equal(on.background, SATELLITE_ON_BG);
  assert.equal(off.background, SATELLITE_OFF_BG);
  assert.notEqual(on.background, off.background);
  assert.notEqual(on.stroke, off.stroke, 'a glyph that does not change colour on a changed background can vanish');
  assert.ok(on.svg.includes(on.stroke) && off.svg.includes(off.stroke));
});

test('truthiness is normalised — the caller passes raw state, not a boolean', () => {
  for (const v of [undefined, null, 0, '', false]) assert.equal(satelliteControlSpec(v).on, false, String(v));
  for (const v of [1, 'yes', {}]) assert.equal(satelliteControlSpec(v).on, true, String(v));
});

test('the glyph is a real svg and is hidden from screen readers (the label carries the meaning)', () => {
  const svg = globeSvg('#000');
  assert.match(svg, /^<svg /);
  assert.match(svg, /aria-hidden="true"/);
  assert.match(svg, /<circle cx="12" cy="12" r="10"\/>/);
});

test('paint applies every part of the spec to a button, and tolerates no button at all', () => {
  const calls = { attrs: {}, style: {} };
  const fake = {
    title: '', innerHTML: '',
    style: calls.style,
    setAttribute(k, v) { calls.attrs[k] = v; },
  };
  const spec = paintSatelliteControl(fake, true);
  assert.equal(fake.title, spec.label);
  assert.equal(calls.attrs['aria-label'], spec.label);
  assert.equal(calls.attrs['aria-pressed'], 'true');
  assert.equal(calls.style.background, SATELLITE_ON_BG);
  assert.equal(fake.innerHTML, spec.svg);
  assert.equal(paintSatelliteControl(null, true), null, 'a missing button must not throw');
});

test('the button matches the Recenter crosshair it sits beside', () => {
  // They read as a pair or they read as a mistake.
  assert.match(SATELLITE_BUTTON_CSS, /width:40px/);
  assert.match(SATELLITE_BUTTON_CSS, /height:40px/);
  assert.match(SATELLITE_BUTTON_CSS, /border-radius:2px/);
  assert.match(SATELLITE_BUTTON_CSS, /box-shadow:0 1px 4px rgba\(0,0,0,0\.3\)/);
});

test('WIRING: both screens use this spec, and neither filter menu still offers the row', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.ok(/paintSatelliteControl\(satelliteBtnRef\.current, mapFilters\.satellite\)/.test(src),
    'the dispatch Map must paint through the shared spec.');
  assert.ok(/title=\{satelliteControlSpec\(satellite\)\.label\}/.test(src),
    'the Routing rail must label through the shared spec.');
  assert.ok(/controls\[google\.maps\.ControlPosition\.RIGHT_BOTTOM\]\.push\(satBtn\)/.test(src),
    'the button must be pushed to RIGHT_BOTTOM, where the Recenter crosshair lives.');
  assert.ok(!/label="Satellite view"/.test(src),
    'no filter menu may still carry a Satellite row — it lives on the map now.');
});
