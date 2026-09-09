// test/source-parses.test.mjs
//
// DOES THE APP'S SOURCE EVEN PARSE? Nothing in the fast job asked.
//
// I have now shipped the SAME defect twice in one session, both times inside a VERSION_LOG
// row, both times a literal backslash-n written where a newline belonged:
//
//     ... 3,663 green.'],\n  ['0.97.6', ...        ← v0.97.7, broke `smoke` + two previews
//     ... 5 new tests.'],\n  ['1.1.0', ...          ← the rebase of this very change
//
// Two stray characters sitting between two array elements. esbuild rejects it —
// `App.jsx:196:2969: ERROR: Syntax error "n"` — and the bundle never builds.
//
// WHY IT GOT THROUGH BOTH TIMES. `npm test` is 3,900 pure-function tests; not one of them
// parses App.jsx as JavaScript. release-guards reads it as TEXT and its regexes are perfectly
// happy with a file that will not compile. check-version-bump likewise. So the first thing
// that notices is `smoke`, which builds — an eight-minute job, behind an npm ci and a browser
// download, and only in CI. The feedback loop for "is this file syntactically valid" was
// eight minutes and a red PR, when it should be under a second.
//
// This closes it with the SAME transform vite uses, so the answer here and the answer in the
// build cannot disagree. It is the fast job's cheapest possible guard: no bundling, no
// browser, no install beyond what is already here.
//
// Deliberately EVERY source file, not just App.jsx — the next one will be somewhere else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { transform } from 'esbuild';

const SRC = new URL('../src', import.meta.url).pathname;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (['.js', '.jsx', '.mjs', '.ts', '.tsx'].includes(extname(name))) out.push(full);
  }
  return out;
}

test('every file under src/ parses — the guard that would have caught both \\n slips', async () => {
  const files = walk(SRC);
  assert.ok(files.length > 40, `expected the real source tree, walked ${files.length} files`);
  const broken = [];
  for (const f of files) {
    const rel = f.slice(SRC.length - 3);
    try {
      // The same loader vite picks per extension, so this cannot pass where the build fails.
      await transform(readFileSync(f, 'utf8'), { loader: extname(f).slice(1), sourcefile: rel });
    } catch (err) {
      const e = (err.errors && err.errors[0]) || {};
      const at = e.location ? `:${e.location.line}:${e.location.column}` : '';
      broken.push(`${rel}${at}  ${e.text || err.message}`);
    }
  }
  assert.deepEqual(broken, [], `\n  ${broken.join('\n  ')}\n`);
});

test('the guard can actually fail — a literal \\n between array elements is rejected', async () => {
  // Proving it fires, on the exact shape that shipped twice. A guard nobody has watched fail
  // is a guard you are only assuming works, which is the whole lesson of this session.
  const shipped = "const VERSION_LOG = [\n  ['1.1.1', 'a'],\\n  ['1.1.0', 'b'],\n];\n";
  await assert.rejects(
    () => transform(shipped, { loader: 'jsx', sourcefile: 'App.jsx' }),
    (err) => /Syntax error/.test(String(err.errors?.[0]?.text || err.message)),
  );
  // …and the same rows with a REAL newline are fine.
  await transform(shipped.replace('\\n', '\n'), { loader: 'jsx', sourcefile: 'App.jsx' });
});
