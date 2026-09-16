// test/rollback-targets.test.mjs — what the footer's rollback panel offers, and what it claims.
//
// The panel puts a number beside each version — "undoes 17 releases" — and Chad decides whether
// to press the button on that number. A wrong one here is worse than no panel: it is a confident
// figure attached to an action that changes production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rollbackTargets, rollbackRequestBody, compareVersions } from '../src/lib/rollback-targets.js';

// Deliberately OUT of order, because the real array has been. By 2026-08-19 VERSION_LOG had
// drifted to 0.56.0, 0.55.9, 0.56.2, 0.56.1 and the deploy watchdog read the wrong live version
// twice in one afternoon (v0.56.4). A panel that trusted the order would price every row wrong.
const LOG = [
  ['1.36.2', 'The stem-out toggle is under Filters. It moved.'],
  ['1.36.4', 'The panel has a name now. And a boundary.'],
  ['1.36.3', 'A box over a sent route picks up none of its stops.'],
  ['1.30.2', 'The row healed and the drill-down did not.'],
  ['1.36.0', 'The send button was behind a per-device switch.'],
];

test('the menu is sorted by version, never by the order the array happens to be in', () => {
  const t = rollbackTargets(LOG, '1.36.4');
  assert.deepEqual(t.map((r) => r.version), ['1.36.4', '1.36.3', '1.36.2', '1.36.0', '1.30.2']);
});

test('"undoes N" counts the releases newer than the row — the number Chad decides on', () => {
  const t = rollbackTargets(LOG, '1.36.4');
  assert.equal(t.find((r) => r.version === '1.36.4').undoes, 0, 'the current build undoes nothing');
  assert.equal(t.find((r) => r.version === '1.36.3').undoes, 1);
  assert.equal(t.find((r) => r.version === '1.36.2').undoes, 2);
  assert.equal(t.find((r) => r.version === '1.30.2').undoes, 4);
});

test('the running build is marked and cannot be picked', () => {
  const t = rollbackTargets(LOG, '1.36.3');
  const cur = t.find((r) => r.version === '1.36.3');
  assert.equal(cur.current, true);
  assert.equal(cur.selectable, false, 'rolling back to what you are running is a no-op');
});

test('a version NEWER than the running build is never offered as a rollback', () => {
  // This tab can be behind the site — the reload banner exists for exactly that. Offering
  // "roll back to v1.36.4" from a tab running v1.36.0 would be a roll FORWARD wearing the
  // wrong word, and it would ship whatever the newer release changed under a rollback's name.
  const t = rollbackTargets(LOG, '1.36.0');
  for (const r of t.filter((x) => compareVersions(x.version, '1.36.0') > 0)) {
    assert.equal(r.selectable, false, `${r.version} is ahead of the running build`);
    assert.equal(r.undoes, 0, 'and it is not priced as if it were behind');
  }
  assert.equal(t.find((r) => r.version === '1.30.2').selectable, true);
});

test('1.36.10 sorts above 1.36.9, not below it as strings would', () => {
  const t = rollbackTargets([['1.36.9', 'nine.'], ['1.36.10', 'ten.']], '1.36.10');
  assert.deepEqual(t.map((r) => r.version), ['1.36.10', '1.36.9']);
  assert.equal(t[1].undoes, 1);
});

test('the headline is the first sentence, so a row fits on a phone', () => {
  const t = rollbackTargets(LOG, '1.36.4');
  assert.equal(t.find((r) => r.version === '1.36.2').headline, 'The stem-out toggle is under Filters.');
});

test('a malformed log is empty rather than throwing under the footer', () => {
  assert.deepEqual(rollbackTargets(null, '1.0.0'), []);
  assert.deepEqual(rollbackTargets(undefined, '1.0.0'), []);
  assert.deepEqual(rollbackTargets([['not-a-version', 'x'], null, 'nope'], '1.0.0'), []);
});

test('the list is capped, because a phone cannot scroll 765 rows usefully', () => {
  const many = Array.from({ length: 50 }, (_, i) => [`1.0.${49 - i}`, `Release ${49 - i}.`]);
  assert.equal(rollbackTargets(many, '1.0.49').length, 12);
  assert.equal(rollbackTargets(many, '1.0.49', 3).length, 3);
});

// ── WHAT REACHES GITHUB ──────────────────────────────────────────────────────

test('the request carries the dry run FIRST and the execute second', () => {
  // Whoever picks this up must read what the rollback costs before running it. Putting the
  // executing command first would invite exactly the unreviewed change this tool exists to undo.
  const body = rollbackRequestBody({ version: '1.30.2', undoes: 17, reason: 'routing tab is broken', appVersion: '1.38.0' });
  const dry = body.indexOf('npm run rollback -- v1.30.2\n');
  const exec = body.indexOf('--execute');
  assert.ok(dry > -1 && exec > -1 && dry < exec, 'dry run is listed first');
  assert.match(body, /read what it says the rollback costs before/);
});

test('the request says CODE ONLY, because that is the dangerous misreading', () => {
  const body = rollbackRequestBody({ version: '1.30.2', undoes: 17, reason: 'x', appVersion: '1.38.0' });
  assert.match(body, /CODE ONLY/);
  assert.match(body, /Firestore is untouched/);
  assert.match(body, /already sent to NuVizz is still sent/);
  assert.match(body, /`--drop <pr>` is the smaller tool/);
});

test('a quote in the reason cannot break out of the --because argument', () => {
  // Chad types in prose. The reason is interpolated into a shell command in the issue body,
  // and a stray double quote would end the argument early for whoever pastes it.
  const body = rollbackRequestBody({ version: '1.30.2', undoes: 1, reason: 'he said "send it" and it broke', appVersion: '1.38.0' });
  const line = body.split('\n').find((l) => l.includes('--because'));
  assert.equal((line.match(/"/g) || []).length, 2, 'exactly the two quotes that delimit the argument');
  assert.match(line, /'send it'/);
});

test('a missing reason is stated, never silently blank', () => {
  assert.match(rollbackRequestBody({ version: '1.0.0', undoes: 0 }), /\(no reason given\)/);
});

// ── THE PANEL IS WIRED TO BOTH VIEWS ─────────────────────────────────────────

test('the rollback entry exists on the phone as well as the footer', () => {
  // Chad asked for it "by the version in the footer" — and the footer is desktop/tablet only.
  // A screen added to one navigation and not the other is a screen that does not exist on a
  // phone, and this repo has shipped that twice. Dispatch runs on a phone.
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /onSelectMenu\('rollback'\)/, 'the phone chip menu can open it');
  assert.match(app, /if \(next === 'rollback'\) \{ setRollbackOpen\(true\); return; \}/, 'and the route is handled');
  assert.match(app, /aria-label="Roll back the app"\n\s+className="text-slate-300/, 'the footer button is there and muted');
  assert.match(app, /\{rollbackOpen && <RollbackPanel/, 'and the panel renders');
});
