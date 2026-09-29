// test/repo-hygiene.test.mjs — nothing that is a machine's own scaffolding may be committed.
//
// 2026-09-29: a `node_modules` SYMLINK, made in a git worktree so it could share one install with
// the main checkout, was swept into a commit by `git add -A` (".gitignore" had `node_modules/`, which
// matches a directory and not a symlink). It merged to main in #1064. The next merge of main into a
// real checkout REPLACED that checkout's installed node_modules with the dangling link. CI and the
// deploy previews all passed, because nothing looked. This is the something.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = () => execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8', cwd: new URL('..', import.meta.url), maxBuffer: 64 * 1024 * 1024 })
  .split('\n').filter(Boolean).map((l) => { const m = /^(\d+) \S+ \d+\t(.*)$/.exec(l); return m ? { mode: m[1], path: m[2] } : null; }).filter(Boolean);

test('no symlink is tracked: a link to one machine\'s path is a landmine for every other checkout', () => {
  const links = tracked().filter((f) => f.mode === '120000').map((f) => f.path);
  assert.deepEqual(links, [], `tracked symlink(s): ${links.join(', ')} — remove with \`git rm\`, and never \`git add -A\` over a worktree's node_modules link`);
});

test('node_modules is never tracked, as a directory or as a link', () => {
  const bad = tracked().filter((f) => /(^|\/)node_modules(\/|$)/.test(f.path)).map((f) => f.path);
  assert.deepEqual(bad, []);
});

test('dispatch-map/.gitignore ignores node_modules by its bare name, which matches a symlink too', () => {
  const gi = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(gi.includes('node_modules'), 'the bare `node_modules` line is what ignores the symlink form');
});
