// test/truck-capacity-wiring.test.mjs — the cap floor has to be ON THE BUILD PATH.
//
// resolveTruckCaps passes its own tests whether or not anything calls it, and the failure it
// prevents is invisible: a blank cap does not error, it silently plans 19 skids onto a truck
// that holds 14.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fn = await readFile(fileURLToPath(new URL('../netlify/functions/routing-build-background.mts', import.meta.url)), 'utf8');
const app = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
const code = app.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');

test('EVERY build resolves its truck caps — both the panel\'s trucks and the stored profiles', () => {
  assert.ok(/import \{ resolveTruckCaps \} from '\.\/lib\/truck-capacity\.mts';/.test(fn), 'the rule is not imported');
  assert.ok(/const \{ trucks, notes: capacityNotes \} = resolveTruckCaps\(rawTrucks\);/.test(fn), 'the caps are not resolved');
  // One source for both paths: whatever rawTrucks came from, it goes through the floor.
  assert.ok(/const rawTrucks = Array\.isArray\(r\.trucks\) && r\.trucks\.length \? r\.trucks : await resolveTrucks\(/.test(fn), 'the two truck paths no longer meet before the floor');
  // …and the SOLVER gets the resolved list, not the raw one.
  assert.ok(/stops, trucks,/.test(fn), 'the pipeline request does not take the resolved trucks');
  assert.ok(!/trucks: rawTrucks/.test(fn), 'the raw trucks reach the solver');
});

test('the substitution reaches the screen — a defaulted cap nobody sees is the same bug', () => {
  assert.ok(/capacityNotes \}/.test(fn), 'the notes are not put on the job result');
  assert.ok(/Array\.isArray\(result\.capacityNotes\) && result\.capacityNotes\.length > 0/.test(code), 'the result panel never renders them');
  assert.ok(/truck limits were missing — the build supplied them/.test(code), 'the heading is gone');
});
