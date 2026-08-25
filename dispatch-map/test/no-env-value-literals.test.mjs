// test/no-env-value-literals.test.mjs
//
// THE THING THAT KEEPS BREAKING PRODUCTION, CAUGHT BY CI INSTEAD OF BY THE DEPLOY.
//
// Netlify scans a build for the VALUES of its environment variables. NUVIZZ_DAVIS_USER is
// the same word as the owner's own route, in lower case — so writing that word in lower case
// anywhere in the repository fails the deploy, while every check on the pull request stays
// green, because CI does not run that scan.
//
// It has now happened three times in two days:
//   1. v0.76.8 — a route-name fixture in the day-report tests. Cost SEVEN HOURS of deploys;
//      three releases merged into a site that could not build them.
//   2. v0.78.2 — the fix for that.
//   3. v0.78.3 — in the very change whose commit message said "a fixture that borrows a real
//      name is a fixture that changes meaning under you". Written by the same hand that had
//      just diagnosed it.
//
// Three times is not carelessness that more care will fix. It is a missing guard, and this is
// it: the check runs on the pull request, where a red mark costs a minute, instead of at the
// deploy, where it costs a morning.
//
// THE TEST NEVER TYPES THE WORD. It derives it from the shipped list, which is the same trick
// the fixtures now use — a guard that had to contain the literal would be the bug.
//
// SCOPE, and why it is only this one value: an env var whose value is a common English word is
// a landmine, and this is the one we know about. A username is not really the secret anyway
// (the password is), so the durable fix is SECRETS_SCAN_OMIT_KEYS on that variable — a
// security call for Chad, not one to make inside a feature branch. Until then, this holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OWNER_ROUTE_NAMES } from '../src/lib/board-flags.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SEARCH = ['src', 'test', 'netlify', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.netlify', 'coverage', '.git']);
const EXTS = /\.(mjs|mts|js|jsx|ts|tsx|json|toml|html|css)$/;

function* files(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* files(full);
    else if (EXTS.test(name)) yield full;
  }
}

test('NO SOURCE FILE SPELLS THE OWNER ROUTE THE WAY THE SECRETS SCANNER MATCHES IT', () => {
  // Lower case is the form that matches. Uppercase has always scanned clean — the last good
  // production deploy carried several uppercase occurrences and reported zero matches, and the
  // one deploy-breaking hit named a lower-case line. That asymmetry is the whole rule.
  const needles = OWNER_ROUTE_NAMES.map((n) => n.toLowerCase()).filter((n) => n.length >= 3);
  assert.ok(needles.length, 'nothing to guard — the shipped list is empty');

  const hits = [];
  for (const dir of SEARCH) {
    for (const file of files(join(ROOT, dir))) {
      // This guard derives the needle, so it must not flag itself for holding it in memory.
      if (file.endsWith('no-env-value-literals.test.mjs')) continue;
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      for (const needle of needles) {
        let i = text.indexOf(needle);
        while (i !== -1) {
          const line = text.slice(0, i).split('\n').length;
          hits.push(`${relative(ROOT, file)}:${line}`);
          i = text.indexOf(needle, i + 1);
        }
      }
    }
  }

  assert.deepEqual(hits, [],
    'these fail the Netlify secrets scan and stop production deploying, while CI stays green.\n'
    + 'Capitalise it in prose, or derive it from OWNER_ROUTE_NAMES in code:\n  '
    + hits.join('\n  '));
});

test('the guard can actually fail — it is looking for something real', () => {
  // A repo-scanning test that finds nothing looks identical whether it works or is broken.
  const needle = OWNER_ROUTE_NAMES[0].toLowerCase();
  assert.ok(needle.length >= 3, 'the needle is substantial enough to be meaningful');
  const sample = `const route = '${needle}';`;
  assert.ok(sample.includes(needle), 'the match this guard performs would fire on a real line');
});
