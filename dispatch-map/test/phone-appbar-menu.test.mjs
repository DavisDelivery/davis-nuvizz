// test/phone-appbar-menu.test.mjs — the phone's only navigation fits every phone (Sep 27 audit, F-01).
//
// Measured on the built bundle: with More open the app-bar menu was ~706px tall with no max-height
// and no scrollable ancestor, so on 360x640 / 375x667 phones Diagnostics, Roll back the app and
// Debug this view sat below the viewport with no way to reach them; and the Map's z-[39] launchers
// painted over its bottom rows because the bar was a z-30 stacking context. Pinned as source shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const i = APP.indexOf('function MobileAppBar(');
assert.ok(i >= 0, 'MobileAppBar exists');
const bar = APP.slice(i, i + 14000);

test('the menu scrolls inside itself on any phone height, and the bar paints above the map launchers', () => {
  assert.match(bar, /className="flex-shrink-0 z-40 flex items-center justify-between gap-2 px-3 text-white relative"/, 'the bar sits above the z-[39] launchers');
  assert.match(bar, /max-h-\[calc\(100dvh-64px\)\] overflow-y-auto overscroll-contain z-50"\s*\n\s*role="menu"/, 'the menu is capped to the viewport and scrolls');
  // the launchers it must clear (MapScreen) — if this z ever rises past 40, revisit the bar's
  assert.match(APP, /className="absolute left-3 z-\[39\] flex flex-col gap-2"/, 'the launcher column is still z-[39]');
});
