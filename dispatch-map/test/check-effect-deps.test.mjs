// test/check-effect-deps.test.mjs — the CI guard that fails an effect declared without a
// dependency array (v0.98.0). Pins the rule on the shapes that matter, then runs it over the
// shipped source so the fix that motivated it cannot quietly regress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectsWithoutDeps, parseSource, checkPaths, ALLOW_MARK } from '../scripts/check-effect-deps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scan = async (src, name = 'x.jsx') => effectsWithoutDeps(await parseSource(src, name), src);

test('an effect with no dependency array is flagged, with its line', async () => {
  const src = `import { useEffect } from 'react';
function A() {
  useEffect(() => {
    document.title = 'x';
  });
  return null;
}`;
  assert.deepEqual(await scan(src), [{ line: 3, name: 'useEffect' }]);
});

test('an effect with a dependency array — empty or not — passes', async () => {
  const src = `function A({ a }) {
  useEffect(() => { go(a); }, [a]);
  useEffect(() => { once(); }, []);
  useLayoutEffect(() => { measure(); }, [a]);
  return null;
}`;
  assert.deepEqual(await scan(src), []);
});

test('React.useEffect and useLayoutEffect / useInsertionEffect are held to the same rule', async () => {
  const src = `function A() {
  React.useEffect(() => { a(); });
  useLayoutEffect(() => { b(); });
  useInsertionEffect(() => { c(); });
  return null;
}`;
  assert.deepEqual((await scan(src)).map((o) => o.name), ['useEffect', 'useLayoutEffect', 'useInsertionEffect']);
});

test(`an every-render effect is allowed only with a written reason: // ${ALLOW_MARK} <why>`, async () => {
  const ok = `function A() {
  // ${ALLOW_MARK} measures a node whose identity changes every render (see #123)
  useEffect(() => { measure(); });
  return null;
}`;
  assert.deepEqual(await scan(ok), []);
  const bareMark = `function A() {
  // ${ALLOW_MARK}
  useEffect(() => { measure(); });
  return null;
}`;
  assert.equal((await scan(bareMark)).length, 1, 'the mark with no reason does not excuse anything');
  const tooFar = `function A() {
  // ${ALLOW_MARK} a reason, but five lines up
  const x = 1;
  const y = 2;
  const z = 3;
  useEffect(() => { measure(); });
  return null;
}`;
  assert.equal((await scan(tooFar)).length, 1, 'the excuse must sit within three lines of the call');
});

test('apostrophes in JSX text, template literals and regex literals do not derail the scan (it is a parser, not a regex)', async () => {
  const src = `function A({ n }) {
  useEffect(() => { const s = \`\${n > 1 ? 'stops' : 'stop'} — don't\`; if (/['"]/.test(s)) go(s); }, [n]);
  return <div title="it's">Don't {n > 1 ? "stop's" : 'x'} {\`\${n}\`}</div>;
}
function B() { useEffect(() => { late(); }); return null; }`;
  assert.deepEqual(await scan(src), [{ line: 5, name: 'useEffect' }]);
});

test('the shipped source is clean — the v0.98.0 per-render grid measurement cannot come back unannounced', async () => {
  const offenders = await checkPaths([resolve(here, '../src')], { root: resolve(here, '..') });
  assert.deepEqual(offenders, []);
});
