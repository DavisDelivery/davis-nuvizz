// test/auto-merge-subject.test.mjs — A MERGED PR'S SUBJECT ON MAIN IS ITS TITLE, AND A TITLE IS NEVER RUN.
//
// Sep 26: auto-merge ran `gh pr merge --squash` with no --subject, so GitHub picked the squash subject.
// #1027 landed on main as "Shadow map: click a route and you see that route (v1.74.3) (#1027)" while its
// PR title, renamed at 22:52Z, nine minutes before the merge, read "…; satellite and filters (v1.75.1)".
// v1.74.3 was already #1025, and the rollback tool — which then read versions off merge subjects — sent
// `rollback -- v1.74.3` to the wrong build. The workflow now passes the PR title as the subject.
//
// This runs the workflow step's OWN script, cut out of .github/workflows/auto-merge.yml, under bash, with
// a stand-in `gh` that answers the reads the step makes and records the merge call. Nothing reaches
// GitHub. A title is data typed by whoever opens a PR, so the titles below include ones that would run
// commands if the script ever pasted a title into its own text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKFLOW = readFileSync(new URL('../../.github/workflows/auto-merge.yml', import.meta.url), 'utf8');

/** The `run: |` block of the step named `name`, dedented — the script GitHub hands to bash. */
function stepScript(yaml, name) {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(at, -1, `auto-merge.yml has no step named "${name}" — this test must follow it`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  assert.notEqual(runAt, -1, `the "${name}" step has no run: | block`);
  const keyIndent = lines[runAt].search(/\S/);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && l.search(/\S/) <= keyIndent) break;
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n');
}

const SCRIPT = stepScript(WORKFLOW, 'Squash-merge passing claude/* PRs');

/** Run the step with a stand-in gh. Returns the exit code, the output and the merge call's arguments. */
function runStep(title, { num = '1027' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-merge-test-'));
  try {
    const record = join(dir, 'merge-args.json');
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const a = process.argv.slice(2);
const fs = require('fs');
const json = a.includes('--json') ? a[a.indexOf('--json') + 1] : null;
if (a[0] === 'pr' && a[1] === 'list') { process.stdout.write(process.env.STUB_NUM + '\\n'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view' && json === 'isDraft') { process.stdout.write('false\\n'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view' && json === 'title') { process.stdout.write(process.env.STUB_TITLE + '\\n'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'merge') { fs.writeFileSync(process.env.STUB_RECORD, JSON.stringify(a)); process.stdout.write('merged\\n'); process.exit(0); }
process.stderr.write('unexpected gh call: ' + JSON.stringify(a) + '\\n'); process.exit(3);
`, { mode: 0o755 });
    const env = {
      PATH: `${dir}:${process.env.PATH}`, HOME: dir,
      GH_TOKEN: 'not-a-token', HEAD_BRANCH: 'claude/some-fix', HEAD_SHA: 'abc123',
      GITHUB_REPOSITORY: 'DavisDelivery/davis-nuvizz', GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
      STUB_NUM: num, STUB_TITLE: title, STUB_RECORD: record,
    };
    const r = spawnSync('bash', ['-c', SCRIPT], { cwd: dir, env, encoding: 'utf8' });
    const args = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null;
    const leftovers = readdirSync(dir).filter((f) => !['gh', 'merge-args.json', 'summary.md'].includes(f));
    return { code: r.status, out: `${r.stdout}${r.stderr}`, args, leftovers };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('#1027\'s title is the squash subject — "(v1.75.1) (#1027)", not the "(v1.74.3)" GitHub picked on Sep 26', () => {
  const title = 'Shadow map: click a route and you see that route; satellite and filters (v1.75.1)';
  const r = runStep(title);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.args, `gh pr merge was never called:\n${r.out}`);
  assert.deepEqual(r.args.slice(0, 3), ['pr', 'merge', '1027']);
  assert.ok(r.args.includes('--squash'));
  assert.ok(r.args.includes(`--subject=${title} (#1027)`), JSON.stringify(r.args));
  assert.ok(r.args.includes('--delete-branch'), 'the branch is still deleted after the merge');
  // The body stays GitHub's, as it was before: no --body / -b / --body-file.
  assert.equal(r.args.filter((a) => /^(-b|--body|--body-file|-F)(=|$)/.test(a)).length, 0, JSON.stringify(r.args));
});

test('a title is data: quotes, $( ), backticks and a leading dash reach the subject as typed and run nothing', () => {
  const hostile = [
    'Fix "quotes" and \'apostrophes\' (v9.9.1)',
    'x"; touch pwned-1; echo "',
    '$(touch pwned-2) (v9.9.2)',
    '`touch pwned-3` (v9.9.3)',
    '--delete-branch=false; touch pwned-4',
    'Dollar $HOME and ${PATH} stay literal',
  ];
  for (const title of hostile) {
    const r = runStep(title);
    assert.equal(r.code, 0, `${title}\n${r.out}`);
    assert.ok(r.args?.includes(`--subject=${title} (#1027)`), `${title}\n${JSON.stringify(r.args)}`);
    assert.deepEqual(r.leftovers, [], `a title ran a command: ${title}`);
  }
});

test('a PR whose title cannot be read is not merged under whatever GitHub would pick', () => {
  const r = runStep('');
  assert.equal(r.code, 1, r.out);
  assert.equal(r.args, null, 'no merge call');
  assert.match(r.out, /::error::PR #1027 has no title to write as its merge subject — not merged\./);
});

test('the title never reaches the script as a workflow expression', () => {
  // `${{ … }}` is pasted into the script text BEFORE bash runs, so a title there would be code. The only
  // expressions allowed in this workflow are the three env values, none of them a title.
  const exprs = [...WORKFLOW.matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => m[1].trim());
  assert.deepEqual(exprs, ['secrets.GITHUB_TOKEN', 'github.event.workflow_run.head_branch', 'github.event.workflow_run.head_sha']);
  assert.doesNotMatch(SCRIPT, /\$\{\{/);
});
