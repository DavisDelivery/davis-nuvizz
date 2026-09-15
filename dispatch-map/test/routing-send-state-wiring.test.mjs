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
  assert.ok(/import \{[^}]*\bsendControlState\b[^}]*\} from '\.\/lib\/routing-select\.js';/.test(code), 'sendControlState is not imported');
  assert.ok(/const sc = sendControlState\(\{\s*openCards: wbRoutes\.length,\s*dirtyCards: dirtyRoutes\.length,/.test(code), 'the header does not build its control from the rule');
  // The WORDS live in the rule now (and routing-send-state.test.mjs pins them); what the
  // wiring owes is that the header renders the rule's label rather than re-deciding it here.
  assert.ok(/if \(sc\.kind === 'none'\) return null;/.test(code), 'the header does not honour the no-cards state');
  assert.ok(/if \(!sc\.actionable\) \{/.test(code), 'the header does not separate the button from the status chip');
  assert.equal((code.match(/sc\.label/g) || []).length, 2, 'the header must render the rule label for BOTH the button and the chip');
});

test('THE SEND BUTTON IS NOT BEHIND THE PER-DEVICE GEAR — Sep 15, "i have no way to send these loads"', () => {
  // THE BUG, PINNED AT THE WIRING. `liveWrite` is a localStorage toggle that seeds OFF from
  // VITE_NUVIZZ_WRITE_BETA and persists; gating the send surface on it left a dispatcher with
  // cards reading NOT SENT TO NUVIZZ and no control anywhere on the screen to send them.
  // Everything here must stay OUTSIDE that gate. The card's driver-assign row stays inside it.
  const header = /const sc = sendControlState\(\{[\s\S]*?<\/button>\s*\)\;\s*\}\)\(\)\}/.exec(code);
  assert.ok(header, 'the header send control is gone');
  assert.ok(!/LIVE_WRITE_FLAG/.test(header[0]), 'the send button is behind the live-write gear again');

  // The ● LIVE / ○ Beta switch decides whether that button writes or only simulates — hiding it
  // left the dispatcher unable to tell, or change, which of the two they were about to do.
  assert.ok(!/\{LIVE_WRITE_FLAG && \(\s*\n\s*<button\s*\n\s*onClick=\{\(\) => setLiveMode/.test(code), 'the LIVE/Beta switch is gated again');
  assert.ok(/onClick=\{\(\) => setLiveMode\(\(v\) => !v\)\}/.test(code), 'the LIVE/Beta switch is gone');

  // The close confirmation: a card holding staged changes must never close SILENTLY on the
  // same screen that just called those changes unsent.
  assert.ok(/const guardedClose = \(key\) => \{ const r = wbRoutes\.find\(\(x\) => x\.key === key\); if \(r && isDirty\(r\)\)/.test(code), 'the one-card close guard is gated again');
  assert.ok(/const guardedCloseAll = \(\) => \{ if \(dirtyRoutes\.length\)/.test(code), 'the close-all guard is gated again');
  assert.ok(!/\{LIVE_WRITE_FLAG && closeGuard && \(/.test(code), 'the close-guard modal is gated again');

  // The toast is the send button's ONLY report channel: every "✓ N load(s) saved to NuVizz"
  // and every ✗ refusal NuVizz answers with comes out of it.
  assert.ok(!/\{LIVE_WRITE_FLAG && toast && \(/.test(code), 'the save-result toast is gated again');

  // …and the gear still covers what it is actually for.
  assert.ok(/\{LIVE_WRITE_FLAG && !route\.collapsed && \(\s*\n\s*<LiveDispatchBar/.test(code), 'the driver-assign + dispatch row left the gear');
});

test('CLOSING THE LAST STAGED CARD RELEASES THE STOPS — the map does not fall back to the plan', () => {
  assert.ok(/const routePaint = routePaintSource\(\{ openCards: wbRoutesColored\.length, planStaged \}\);/.test(code), 'the paint source is not the rule');
  assert.ok(/const effectiveRouteInfo = routePaint === 'cards' \? wbRouteInfo : routePaint === 'plan' \? routeInfo : EMPTY_ROUTE_INFO;/.test(code), 'effectiveRouteInfo does not honour the rule');
  // The old expression is the bug itself.
  assert.ok(!/const effectiveRouteInfo = wbRoutesColored\.length \? wbRouteInfo : routeInfo;/.test(code), 'the fall-back-to-the-plan expression is back');
  // Ref stability: a fresh Map on every render rebuilt every marker on every board poll.
  assert.ok(/^const EMPTY_ROUTE_INFO = new Map\(\);$/m.test(code), 'the empty paint map is not module-scoped');
});

test('…AND THE LINES LET GO WITH THE PINS — the polyline effect reads the same rule', () => {
  // Chad, the morning after v1.33.0, every card closed and the loads back to Draft: "the lines
  // were left." The pins had been routed through routePaint; the polyline effect kept its own
  // copy of the old fall-back and drew the build's plan the moment the last card closed.
  assert.ok(/const routesToPaint = routePaint === 'cards' \? wbRoutesColored : routePaint === 'plan' \? routesView : EMPTY_ROUTES;/.test(code), 'the lines do not honour the rule');
  const m = /\/\/ Route polylines \(one per route, depot-anchored\)([\s\S]*?)\n  \}, \[([^\]]*)\]\);/.exec(code);
  assert.ok(m, 'the route polyline effect is gone');
  assert.ok(/const toDraw = routesToPaint;/.test(m[1]), 'the polyline effect picks its own routes instead of the shared answer');
  assert.ok(!/wbRoutesColored\.length \? wbRoutesColored : routesView/.test(code), 'the old fall-back-to-the-plan expression is back');
  assert.ok(/\broutesToPaint\b/.test(m[2]), 'the effect does not depend on what it paints');
  assert.ok(!/\broutesView\b/.test(m[2]) && !/\bwbRoutesColored\b/.test(m[2]), 'the effect still re-runs on the raw sources, bypassing the rule');
  assert.ok(/^const EMPTY_ROUTES = \[\];$/m.test(code), 'the empty route list is not module-scoped (ref stability)');
});

test('planStaged is raised by staging and cleared by a new build and by Discard', () => {
  assert.ok(/const \[planStaged, setPlanStaged\] = useState\(false\);/.test(code), 'planStaged is gone');
  assert.ok(/setWbRoutes\(next\);\n {4}\/\/ From here the CARDS[\s\S]{0,200}?setPlanStaged\(true\);/.test(code), 'staging the plan does not raise planStaged');
  assert.ok(/setJob\(\{ status: 'queued' \}\); setSaveState\(null\); setPlanStaged\(false\);/.test(code), 'a new build does not clear planStaged');
  assert.ok(/setPlanStaged\(false\);\n {4}setLastAction\('Discarded plan/.test(code), 'Discard does not clear planStaged');
  // Declared before it is read, or the render throws on the temporal-dead-zone.
  assert.ok(code.indexOf('const [planStaged, setPlanStaged]') < code.indexOf('routePaintSource({ openCards'), 'planStaged is declared after the render reads it');
});
