// test/routing-send-state-wiring.test.mjs — the two rules stay CONNECTED to the screen.
//
// Both are pure and pass their own tests whether or not App.jsx calls them. A rule wired to
// nothing is this repo's recurring failure (v1.17.2), and the map-paint one is a BEHAVIOUR
// change that is invisible in a unit test: nothing but the wiring decides whether closing the
// last Compare card releases the stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');

test('every Compare card carries its NuVizz state — not just a pending new route', () => {
  assert.ok(/import \{[^}]*\bcardSendState\b[^}]*\} from '\.\/lib\/routing-select\.js';/.test(code), 'cardSendState is not imported');
  assert.ok(/cardSendState\(\{ dirty, pendingCreate: route\.pendingCreate, savedAt, liveMode \}\)/.test(code), 'the card does not build its chip from the rule');
  // The old chip was `route.pendingCreate && (…not sent…)` — an existing load said nothing.
  assert.ok(!/\{route\.pendingCreate && \(\s*<span[^>]*>\s*\n?\s*not sent/.test(code), 'the pendingCreate-only chip is back');
  assert.ok(/savedAt=\{savedAtByKey\[r\.key\] \|\| null\}/.test(code), 'the card is not told when it was saved');
  assert.ok(/liveMode=\{liveMode\}/.test(code), 'the card cannot tell Live from Beta');
});

test('ONLY A CONFIRMED WRITE STAMPS savedAt — markSaved is its one writer', () => {
  const m = /const markSaved = \(keys\) => \{([\s\S]*?)\n  \};/.exec(code);
  assert.ok(m, 'markSaved is no longer the save hook');
  assert.ok(/setSavedAtByKey\(/.test(m[1]), 'markSaved no longer records when the write landed');
  // Exactly one writer: markSaved. Any other setter would let an intent read as an outcome.
  const writers = (code.match(/setSavedAtByKey\(/g) || []).length;
  assert.equal(writers, 2, `expected one write in markSaved + one prune, found ${writers}`);
});

test('a closed card does not hand its "sent" stamp to a freshly reopened one', () => {
  assert.ok(/setSavedAtByKey\(\(prev\) => \{[\s\S]*?liveKeys\.has\(k\)/.test(code), 'the saved-at stamp is not pruned with the baseline');
});

test('the header says which of "all sent" and "nothing staged" is true', () => {
  assert.ok(/dirtyRoutes\.length === 0 && wbRoutes\.length > 0/.test(code), 'the no-changes state renders nothing at all again');
  assert.ok(/✓ All sent to NuVizz/.test(code) && /Nothing to send/.test(code), 'the two states are not distinguished');
});

test('CLOSING THE LAST STAGED CARD RELEASES THE STOPS — the map does not fall back to the plan', () => {
  assert.ok(/const routePaint = routePaintSource\(\{ openCards: wbRoutesColored\.length, planStaged \}\);/.test(code), 'the paint source is not the rule');
  assert.ok(/const effectiveRouteInfo = routePaint === 'cards' \? wbRouteInfo : routePaint === 'plan' \? routeInfo : EMPTY_ROUTE_INFO;/.test(code), 'effectiveRouteInfo does not honour the rule');
  // The old expression is the bug itself.
  assert.ok(!/const effectiveRouteInfo = wbRoutesColored\.length \? wbRouteInfo : routeInfo;/.test(code), 'the fall-back-to-the-plan expression is back');
  // Ref stability: a fresh Map on every render rebuilt every marker on every board poll.
  assert.ok(/^const EMPTY_ROUTE_INFO = new Map\(\);$/m.test(code), 'the empty paint map is not module-scoped');
});

test('planStaged is raised by staging and cleared by a new build and by Discard', () => {
  assert.ok(/const \[planStaged, setPlanStaged\] = useState\(false\);/.test(code), 'planStaged is gone');
  assert.ok(/setWbRoutes\(next\);\n {4}\/\/ From here the CARDS[\s\S]{0,200}?setPlanStaged\(true\);/.test(code), 'staging the plan does not raise planStaged');
  assert.ok(/setJob\(\{ status: 'queued' \}\); setSaveState\(null\); setPlanStaged\(false\);/.test(code), 'a new build does not clear planStaged');
  assert.ok(/setPlanStaged\(false\);\n {4}setLastAction\('Discarded plan/.test(code), 'Discard does not clear planStaged');
  // Declared before it is read, or the render throws on the temporal-dead-zone.
  assert.ok(code.indexOf('const [planStaged, setPlanStaged]') < code.indexOf('routePaintSource({ openCards'), 'planStaged is declared after the render reads it');
});
