// test/routing-panel-wiring.test.mjs — the Setup panel's rules stay CONNECTED to the panel.
//
// Every rule under test here has a pure module and passes its own tests whether or not
// App.jsx calls it. This repo has shipped a working rule wired to nothing before (v1.17.2),
// and the panel review of 2026-09-12 found a note box wired to nothing for months. These
// pin the one-line connections a stale-base merge can silently drop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
// The changelog rows are PROSE ABOUT THE CODE; a wiring pin that reads them checks the story.
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');
// A top-level function's body: from its declaration to the next column-0 `function`.
const between = (start, end) => { const a = code.indexOf(start); assert.ok(a >= 0, `anchor missing: ${start}`); const b = code.indexOf(end, a + start.length); assert.ok(b > a, `anchor missing: ${end}`); return code.slice(a, b); };

test('step 1 reads its freight numbers from selectionTally and labels loose and total separately', () => {
  assert.ok(/= selectionTally\(picked\);/.test(code), 'the tally no longer goes through selectionTally');
  assert.ok(/<span>Loose<\/span><b>\{tally\.loose\}<\/b>/.test(code), 'the Loose line does not read tally.loose');
  assert.ok(/<span>Total pieces<\/span><b>\{tally\.pieces\}<\/b>/.test(code), 'the Total pieces line does not read tally.pieces');
  assert.ok(!/<span>Loose pieces<\/span>/.test(code), 'the mislabel is back');
  assert.ok(/\$\{tally\.count\} orders · \$\{tally\.places\} stops/.test(code), 'orders and physical stops are not both shown');
});

test('the build request carries the remembered strategy (gated), the AI opt-in and the window mode', () => {
  const req = between('    const request = {', '    setLastRequest(request);');
  assert.ok(/strategy: effectiveStrategy\(strategy, useGoogle\)/.test(req), 'strategy is no longer gated on Google');
  assert.ok(/aiAssist: aiAssist === true/.test(req), 'aiAssist is not sent — the note box would be inert again');
  assert.ok(/windowMode: windowStrict \? 'strict' : 'advisory'/.test(req), 'windowMode is not sent');
  assert.ok(/intent: aiAssist \? intent\.trim\(\) : ''/.test(req), 'the note is sent without AI assist on');
});

test('the strategy select offers Min time only with Google on, and shows the effective pick', () => {
  assert.ok(/<select value=\{effectiveStrategy\(strategy, useGoogle\)\}/.test(code), 'the select does not show the effective strategy');
  assert.ok(/strategyChoices\(useGoogle\)\.map\(\(c\) => <option key=\{c\.value\} value=\{c\.value\} disabled=\{c\.disabled\}>/.test(code), 'the options are not gated');
});

test('AI assist: a checkbox, the note box behind it, and the result panel says which of three states it was', () => {
  assert.ok(/checked=\{aiAssist\} onChange=\{\(e\) => setAiAssist\(e\.target\.checked\)\}/.test(code), 'no AI assist checkbox');
  assert.ok(/\{aiAssist && \(\s*<textarea value=\{intent\}/.test(code), 'the note box is not behind the checkbox');
  assert.ok(!/tell the engine what you want/.test(code), 'the old "engine" placeholder is back');
  assert.ok(/aiAssistStatus\(\{ requested: !!result\.aiRequested, configured: !!result\.aiConfigured, ai \}\)/.test(code), 'the result panel does not use the three-state status');
});

test('time restrictions: the strict checkbox, the header chips, and the per-row clock', () => {
  assert.ok(/checked=\{windowStrict\} onChange=\{\(e\) => setWindowStrict\(e\.target\.checked\)\}/.test(code), 'no strict checkbox');
  const card = between('function RoutingRouteCard(', '\nfunction ');
  assert.ok(/⚠ \{winViolated\.size\} outside window/.test(card), 'the header has no miss count');
  assert.ok(/⏱ \{timedCount\} timed/.test(card), 'the header has no timed count');
  assert.ok(/restriction: timeRestrictions\[String\(id\)\] \|\| null/.test(card), 'rows do not read the build\'s own clock');
  assert.ok(/timeRestrictions=\{result\.timeRestrictions \|\| \{\}\}/.test(code), 'the result panel does not hand the clocks to the cards');
});

test('the trailer rule is disabled without a tractor in play', () => {
  assert.ok(/const trailerRuleOn = tractorInPlay\(planMode === 'loads' \? planTargets\.map\(\(t\) => t\.profile\) : selectedTrucks\);/.test(code));
  assert.ok(/checked=\{trailerGreenOnly\} disabled=\{!trailerRuleOn\}/.test(code), 'the checkbox is not gated');
});

test('Trucks mode edits go through TruckProfileEditor, never onBlur → setDoc', () => {
  assert.ok(/<TruckProfileEditor key=\{p\.id\} p=\{p\}/.test(code), 'the editor is not used');
  assert.ok(!/onBlur=\{\(e\) => saveProfile\(/.test(code), 'an on-blur fleet write is back');
  const editor = between('function TruckProfileEditor(', 'function RoutingMapTools(');
  assert.ok(/profileDraftCheck\(draft, base\)/.test(editor), 'the editor does not run the draft check');
  assert.ok(/await onSave\(check\.normalized\)/.test(editor), 'the editor saves something other than the checked, normalized draft');
});

test('the plan-copy Save is labelled by planCopyLabels, and Discard can close the auto-staged cards', () => {
  assert.ok(/const copy = planCopyLabels\(!!\(plannedLoads && plannedLoads\.length\)\);/.test(code));
  assert.ok(/: copy\.button\}/.test(code), 'the button label is hard-coded again');
  assert.ok(/onDiscardAndClose=\{discardPlanAndCloseCards\}/.test(code), 'discard-and-close is not wired to the panel');
  assert.ok(/setAutoStagedKeys\(plannedLoadsBound\.map\(\(b\) => String\(b\.key\)\)\.filter\(\(k\) => !openRouteKeys\.has\(k\)\)\);/.test(code), 'the auto-stage no longer remembers which cards it opened');
});
