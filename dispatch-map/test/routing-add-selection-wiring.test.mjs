// test/routing-add-selection-wiring.test.mjs — step 1's "Add selection" button stays WIRED.
//
// It is a one-line connection into a 32,000-line component, which is the exact shape that
// has shipped inert here before (v1.17.2: the driver capture worked and nothing called it).
// A pure-module test cannot see it at all, so this pins the connection: the panel button and
// the map rail must arm the SAME mode, through the same beginMode, or Cancel, Esc and the
// rail's own highlight quietly stop describing what is armed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
// The changelog rows are PROSE ABOUT THE CODE — one of them names beginMode and the button
// by name — so a wiring pin that reads them is checking the story, not the app.
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');
const armBody = () => {
  const m = /const armSelectionFromPanel = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[/.exec(code);
  assert.ok(m, 'armSelectionFromPanel is no longer defined');
  return m[1];
};

test('the panel button arms the map rail\'s own box mode — one mode, two doors', () => {
  assert.ok(/onClick=\{armSelectionFromPanel\}/.test(code), 'nothing in the panel calls armSelectionFromPanel');
  assert.ok(/＋ Add selection/.test(code), 'the "Add selection" label is gone from the panel');
  assert.ok(/beginMode\('box'\)/.test(armBody()), 'it no longer arms box select — a second mode is not what was asked for');
  // The rail arms the identical call, which is what keeps Cancel / Esc / the rail highlight honest.
  assert.ok(/onBox=\{\(\) => \(selectMode === 'box' \? cancelMode\(\) : beginMode\('box'\)\)\}/.test(code), 'the map rail no longer arms box through beginMode');
});

test('ON A PHONE ARMING DROPS THE SHEET AND SAYS SO — the corners are tapped on the map', () => {
  const body = armBody();
  assert.ok(/if \(isMobile\)/.test(body), 'the phone path is gone — the sheet would cover the map you are boxing');
  assert.ok(/setSheetOpen\(false\)/.test(body), 'the Setup sheet no longer drops on a phone');
  assert.ok(/showMapToast\(/.test(body), 'nothing tells the dispatcher the mode is armed once the sheet is down');
});
