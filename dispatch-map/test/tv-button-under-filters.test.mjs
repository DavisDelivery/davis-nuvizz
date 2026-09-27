// test/tv-button-under-filters.test.mjs
//
// THE "FULLSCREEN TV VIEW" BUTTON UNDER FILTERS DID NOTHING (audit 2026-09-27, app-A1-2).
//
// Chad asked for the wall-display door to live under Filters on the desktop Map: "i want the
// button for fullscreen under filters as i don't want anymore buttons on the screen." Its click
// handler was `setBarOpen(false); onEnterTv();` — a leftover from the v1.23.0 app-bar version of
// the panel. `setBarOpen` exists nowhere any more, so every press threw a ReferenceError before
// onEnterTv() ran, and the office TV never went full-screen. Only typing /tv still worked.
//
// What happens now: the press folds the Filters card shut (the card-mode twin of the bar
// dropdown closing, so the wall does not come up with a 240px panel over the map) and opens the
// wall display.
//
// This RUNS the real FilterToolbar out of App.jsx (JSX compiled with the repo's esbuild), with
// only its child controls and icons stubbed, and presses the button.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnOnly(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
const jsx = (src) => transformSync(src, { loader: 'jsx', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' }).code;

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  Fragment: 'Fragment',
};
const stub = () => null;
const FilterToolbar = new Function(
  'React', 'CarryoverControl', 'MapFilterToggle', 'DriverAreasControl', 'driverLabelsToggle', 'Tv', 'Filter', 'ChevronDown', 'ChevronUp',
  `${jsx(fnOnly('FilterToolbar'))}\nreturn FilterToolbar;`,
)(React, stub, stub, stub, () => ({ hidden: false, disabled: false, hint: '' }), stub, stub, stub, stub);

/** Every element in a rendered tree, depth-first. */
function* walk(node) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  yield node;
  yield* walk(node.props?.children);
}

function openDesktopFilters({ onEnterTv, setCollapsed }) {
  return FilterToolbar({
    filters: { carryoverDays: 0, showVehicleLocation: true },
    setFilters: () => {},
    collapsed: false,
    setCollapsed,
    stopCount: 300,
    vehicleDisabled: false,
    showRoutes: false,
    setShowRoutes: () => {},
    boardDate: '2026-09-28',
    onEnterTv,
  });
}
const tvButtons = (tree) => [...walk(tree)].filter((n) => n.type === 'button' && /Full-screen wall display/.test(n.props.title || ''));

test('a dispatcher pressing "Fullscreen TV view" under Filters puts the board on the wall display', () => {
  let entered = 0;
  const collapsedTo = [];
  const tree = openDesktopFilters({ onEnterTv: () => { entered += 1; }, setCollapsed: (v) => collapsedTo.push(v) });
  const buttons = tvButtons(tree);
  assert.equal(buttons.length, 1, 'the open desktop Filters card carries exactly one TV button');
  assert.doesNotThrow(() => buttons[0].props.onClick(), 'pressing the button must not throw');
  assert.equal(entered, 1, 'the press opens the wall display');
  assert.deepEqual(collapsedTo, [true], 'the Filters card folds shut, so the wall does not come up with the panel open over the map');
});

test('the wall display itself, which passes no onEnterTv, shows no TV button', () => {
  const tree = openDesktopFilters({ onEnterTv: null, setCollapsed: () => {} });
  assert.equal(tvButtons(tree).length, 0);
});
