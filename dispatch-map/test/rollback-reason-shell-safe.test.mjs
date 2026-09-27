// test/rollback-reason-shell-safe.test.mjs
//
// THE ROLLBACK REASON RAN AS SHELL (audit 2026-09-27, client-lookup-account-libs-6).
//
// The footer's rollback request puts Chad's reason into the command whoever picks it up is told
// to run: `npm run rollback -- vX --execute --because "<reason>"`. Only a double quote was
// escaped, and inside bash double quotes a backtick, $VAR and $( ) still expand. A reason typed
// the way people type — "the `Send` button broke after $PR merged" — ran `Send` as a command on
// the operator's machine and recorded "the  button broke after  merged" in the rollback commit
// and the changelog row.
//
// These hand the generated line to a real bash (npm swapped for printf, so nothing is run) and
// read back the argument --because actually receives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { rollbackRequestBody } from '../src/lib/rollback-targets.js';

function becauseAsBashSeesIt(reason) {
  const body = rollbackRequestBody({ version: '1.75.0', undoes: 3, reason, appVersion: '1.80.0' });
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.includes('--execute --because'));
  assert.ok(at > -1, 'the execute line is in the request');
  // Everything up to the closing fence is the command someone pastes.
  const cmd = lines.slice(at, lines.indexOf('```', at)).join('\n');
  assert.ok(cmd.startsWith('npm run rollback -- v1.75.0 --execute --because '));
  const out = execFileSync('bash', ['-c', cmd.replace(/^npm run rollback --/, "printf '%s\\0'")], { encoding: 'utf8', env: { PATH: process.env.PATH, PR: 'SHOULD-NOT-APPEAR' } });
  const args = out.split('\0').slice(0, -1);
  assert.deepEqual(args.slice(0, 3), ['v1.75.0', '--execute', '--because']);
  assert.equal(args.length, 4, `the reason is ONE argument, got ${JSON.stringify(args)}`);
  return { because: args[3], cmd };
}

test('a reason with backticks and a $ word reaches the rollback exactly as Chad typed it', () => {
  const reason = 'the `Send` button broke after $PR merged';
  assert.equal(becauseAsBashSeesIt(reason).because, reason);
});

test('nothing in the reason can run a command on the operator\'s machine', () => {
  for (const reason of ['it broke $(echo INJECTED) today', 'routing `whoami` is wrong', 'cost ${HOME} money']) {
    assert.equal(becauseAsBashSeesIt(reason).because, reason);
  }
});

test('quotes of both kinds and a backslash are kept as typed, not rewritten', () => {
  const reason = 'he said "send it" and it didn\'t \\ go';
  assert.equal(becauseAsBashSeesIt(reason).because, reason);
});

test('a reason typed over two lines stays one command on one line', () => {
  const { because, cmd } = becauseAsBashSeesIt('send broke\n  on the phone');
  assert.equal(because, 'send broke on the phone');
  assert.ok(!cmd.includes('\n'), 'the line someone copies is the whole command');
});

test('with no reason the stated fallback still reaches the command', () => {
  const body = rollbackRequestBody({ version: '1.0.0', undoes: 0 });
  assert.match(body, /--because 'rollback requested from the footer'/);
});
