// test/routing-add-selection-wiring.test.mjs — step 1's "Add selection" button stays WIRED.
//
// It is a one-line connection into a 32,000-line component, which is the exact shape that
// has shipped inert here before (v1.17.2: the driver capture worked and nothing called it).
// A pure-module test cannot see it at all, so this pins the connection: the accept path must
// reach the SAME area-select rule box and lasso use, and the box fallback must arm the SAME
// mode the map rail arms, or Cancel, Esc and the rail's own highlight quietly stop describing
// what is armed.
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

test('IT ACCEPTS WHAT IS LIT BEFORE IT ASKS FOR A BOX — Chad: "accept the stops already highlighted on map"', () => {
  assert.ok(/onClick=\{armSelectionFromPanel\}/.test(code), 'nothing in the panel calls armSelectionFromPanel');
  const body = armBody();
  // The accept path is FIRST and returns, or a press with hits lit would still arm a box.
  assert.match(body, /^\s*if \(highlightedAddable\.length\) \{ addEnclosed\(highlightedAddable\); return; \}/,
    'the accept path is gone, or no longer runs before the box draw');
  // …and it goes through addEnclosed, which is what keeps the skips honest (open cards, a peer
  // device, and — v1.36.3 — stops already planned onto a load that was sent to NuVizz).
  assert.ok(/highlightedForSelection/.test(code), 'the panel no longer computes what is highlighted');
  assert.ok(/highlightedForSelection\(drawnStops, \{ searchMatchIds, selectedIds \}\)/.test(code),
    'the highlight is no longer read off what the MAP IS DRAWING — an un-geocoded hit could ride in');
});

test('WITH NOTHING LIT it still arms the map rail\'s own box mode — one mode, two doors', () => {
  assert.ok(/＋ Add selection/.test(code), 'the "Add selection" label is gone from the panel');
  assert.ok(/beginMode\('box'\)/.test(armBody()), 'the box fallback is gone — the button goes dead without a search');
  // The rail arms the identical call, which is what keeps Cancel / Esc / the rail highlight honest.
  assert.ok(/onBox=\{\(\) => \(selectMode === 'box' \? cancelMode\(\) : beginMode\('box'\)\)\}/.test(code), 'the map rail no longer arms box through beginMode');
});

test('THE LABEL SAYS WHICH ONE IT WILL DO — a fixed label is wrong half the time', () => {
  assert.ok(/＋ Add \{highlightedAddable\.length\} highlighted/.test(code), 'the button no longer counts what it would accept');
  assert.ok(/data-add-selection-mode=\{highlightedAddable\.length \? 'accept' : 'box'\}/.test(code), 'the mode is no longer readable from the DOM');
});

test('ON A PHONE THE BOX PATH DROPS THE SHEET AND SAYS SO — the corners are tapped on the map', () => {
  const body = armBody();
  assert.ok(/if \(isMobile\)/.test(body), 'the phone path is gone — the sheet would cover the map you are boxing');
  assert.ok(/setSheetOpen\(false\)/.test(body), 'the Setup sheet no longer drops on a phone');
  assert.ok(/showMapToast\(/.test(body), 'nothing tells the dispatcher the mode is armed once the sheet is down');
  // The ACCEPT path must NOT drop it: nothing is tapped on the map, and dropping the sheet
  // would hide the tally that just changed by 14 stops.
  const accept = body.slice(0, body.indexOf('beginMode'));
  assert.ok(!/setSheetOpen\(false\)/.test(accept), 'accepting a highlight drops the phone sheet — it hides the tally it just changed');
});

test('ONE SWITCH PUTS IT BACK — the press, the label and the hint all read it', () => {
  // A half-reverted state (a button that says "Add 14 highlighted" and arms a box) is worse
  // than no switch, so the flag gates the SOURCE of highlightedAddable and everything else
  // falls out of it being empty.
  assert.ok(/VITE_ROUTING_ADD_SELECTION_ACCEPTS_HIGHLIGHT/.test(code), 'the put-it-back switch is gone');
  assert.ok(/ADD_SELECTION_ACCEPTS_HIGHLIGHT \? highlightedForSelection\(/.test(code),
    'the switch no longer gates what the button would accept');
  // With it off the hint must read exactly as it did before this change.
  assert.ok(/draws a box around a group\{ADD_SELECTION_ACCEPTS_HIGHLIGHT \? ', or search the grid below/.test(code),
    'the hint still promises the accept path when the switch is off');
  assert.ok(/houseSwitchOn\(import\.meta\.env\.VITE_ROUTING_ADD_SELECTION_ACCEPTS_HIGHLIGHT\)/.test(code),
    'the switch no longer uses the house shape — a typo could silently disable it');
});
