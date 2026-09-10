// The selection panel's "Drop N non-tractor" button, and the ✕ that clears.
//
// Chad: "I want a button on top of bar to remove all stops in the list that are not tractor
// friendly stops also when i click the x i want it to close and clear all."
//
// The rule itself is executed in map-legend.test.mjs; these pin the wiring in App.jsx, where
// both failures are silent: a button wired to the wrong predicate drops rows the panel painted
// green, and an ✕ wired to the persisted panel toggle suppresses the panel on the NEXT
// selection too, which looks exactly like the feature breaking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('the green highlight and the drop button read the SAME rule', () => {
  // Since v1.3.0 the row asks stopTractorFriendly — the ONE helper the bottom grid also reads —
  // and that helper is what feeds tractorFriendlySelection. A private copy in either place is
  // the drift this test exists to stop.
  assert.ok(/tractorOk: stopTractorFriendly\(s, notes, tractorLocs\),/.test(src),
    'the row\'s green flag must come from the shared helper, not a second inline copy.');
  assert.ok(/^function stopTractorFriendly\(stop, notes, tractorLocs\) \{[\s\S]{0,400}?return tractorFriendlySelection\(\{/m.test(src),
    'the shared helper must feed tractorFriendlySelection — the rule the tests execute.');
  assert.ok(/const nonTractorIds = useMemo\(\(\) => rows\.filter\(\(r\) => !r\.tractorOk\)\.map\(\(r\) => r\.id\), \[rows\]\);/.test(src),
    'the button must drop exactly the complement of the green rows.');
});

test('the button names its count — a one-click destructive control gets one warning', () => {
  assert.ok(/Drop \{nonTractorIds\.length\} non-tractor/.test(src),
    'dropping nine of eleven is a different action from dropping one; the label is the warning.');
  assert.ok(/leaves \{rows\.length - nonTractorIds\.length\} a tractor can run/.test(src),
    'the row must also say what SURVIVES — the count that decides whether to press it.');
});

test('the button is absent when there is nothing to drop', () => {
  assert.ok(/\{nonTractorIds\.length > 0 && onRemoveMany && \(/.test(src),
    'an all-green selection must not render a control that would do nothing.');
});

test('a bulk drop is ONE state update, not one per stop', () => {
  // Looping removeStop would queue N updates and N marker-layer rebuilds for a single click.
  assert.ok(/const removeStops = useCallback\(\(ids\) => \{/.test(src));
  assert.ok(/setSelectedIds\(\(prev\) => \{ const n = new Set\(prev\); for \(const id of drop\) n\.delete\(id\); return n; \}\);/.test(src),
    'the whole set must be removed inside one updater.');
});

test('the ✕ clears the selection and does NOT flip the persisted panel toggle', () => {
  // setSelPanelOpen(false) is remembered in localStorage, so an ✕ wired to it would silently
  // suppress the panel on the next selection. With the selection empty the panel unmounts on
  // its own — that IS the close.
  assert.ok(/onClose=\{clearSelection\}/.test(src),
    'the ✕ must clear the selection.');
  assert.ok(!/onClose=\{\(\) => setSelPanelOpen\(false\)\}/.test(src),
    'the ✕ must no longer flip the persisted panel preference.');
  assert.ok(/aria-label="Clear the selection and close this panel"/.test(src),
    'the control must say what it does — it no longer merely hides.');
});
