// The map legend, reachable from the More menu.
//
// Chad: "On the routing page under the more tab i want a legend for what all the icons on the
// map mean and i want it to only show the current icons on the map." The legend and its
// inventory already existed on the ⓘ in the Routing tool rail; this is the second way in.
//
// The failures these pin are all silent ones: an item that navigates away from the map it is
// describing, a SECOND legend that could show a different inventory, an item on a screen with
// no map behind it, and — the one this repo has shipped twice — a menu entry that exists on a
// laptop and not on a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('it is an ACTION item, not a tab — the map must still be on screen', () => {
  // Navigating to a legend screen would unmount RoutingScreen, and with it drawnStops — the
  // list that makes this legend show only what is currently drawn.
  assert.ok(/id === 'legend' \? setLegendSignal\(\(v\) => v \+ 1\)/.test(src),
    'the desktop More menu must signal, never setTab.');
  assert.ok(/if \(next === 'legend'\) \{ setLegendSignal\(\(v\) => v \+ 1\); return; \}/.test(src),
    'the phone menu must do the same, and return before the tab switch below it.');
});

test('the signal is a COUNTER, so it fires every time', () => {
  // A boolean would go true once; closing the panel and picking the item again would then do
  // nothing, which reads exactly like a broken menu.
  assert.ok(/const \[legendSignal, setLegendSignal\] = useState\(0\);/.test(src));
  assert.ok(/if \(!openLegendSignal\) return;/.test(src),
    'the initial 0 must be skipped so the panel is shut on arrival.');
});

test('BOTH menus carry it — the phone menu is a second list', () => {
  // v0.54.50 shipped Manifest check visible on a laptop and invisible on a phone, because
  // these two lists are built separately. The comment beside the phone list says so.
  assert.ok(/\.\.\.\(tab === 'routing' \? \[\{ id: 'legend', label: 'Map legend'/.test(src),
    'the desktop More menu item is missing.');
  assert.ok(/onClick=\{\(\) => onSelectMenu\('legend'\)\}/.test(src),
    'the phone More group item is missing.');
  assert.ok(/showLegend=\{tab === 'routing'\}/.test(src),
    'the phone bar must be told when to show it.');
});

test('it only appears on Routing — there is no map behind the other screens', () => {
  assert.ok(/\.\.\.\(tab === 'routing' \?/.test(src), 'desktop item is gated on the tab');
  assert.ok(/\{showLegend && \(/.test(src), 'phone item is gated on the same fact');
});

test('ONE legend, two ways in — the open flag lives on the screen', () => {
  // A second <MapLegendBody> with its own state could show a different inventory from the ⓘ,
  // and two legends disagreeing about one map is this repo's most expensive kind of defect.
  assert.ok(/const \[legendOpen, setLegendOpen\] = useState\(false\);\s*\n\s*\/\/ MORE → MAP LEGEND arrives as a COUNTER/.test(src),
    'RoutingScreen must own the flag.');
  assert.ok(/const setLegendOpen = onLegendOpen \|\| \(\(\) => \{\}\);/.test(src),
    'the rail must take the setter rather than keeping its own state.');
  const bodies = (src.match(/<MapLegendBody /g) || []).length;
  assert.equal(bodies, 3, `expected the same three legend mount points as before, found ${bodies}`);
});

test('a signal that cannot open anything says so instead of doing nothing', () => {
  // The tool rail is hidden while a saved load is being viewed read-only.
  assert.ok(/if \(viewing\) \{ showMapToast\('Close the saved-load view to open the map legend\.'\); return; \}/.test(src),
    'a menu item that silently no-ops is the failure this repo keeps finding.');
});
