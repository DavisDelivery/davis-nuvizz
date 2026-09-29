// THE SHADOW'S CODE STAYS OUT OF THE START-UP FILES (scripts/check-shadow-chunk.mjs, the smoke job's
// `npm run verify:shadow-chunk`).
//
// Chad, 2026-09-27: "12 yes" to loading the Claude Shadow's code only when its tab opens. The source
// test (claude-shadow-routing-tab) pins the lazy import; a vite.config change can still put the
// Shadow back into the files the page loads at start-up with every unit test green. The check reads
// the build. These tests pin its rules on small built-looking folders, and run the script itself as
// CI runs it, so a check that stops exiting 1 — or stops running at all — goes red here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shadowChunkProblems, startupRefs, distKey, SHADOW_MARKER } from '../scripts/check-shadow-chunk.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/check-shadow-chunk.mjs', import.meta.url));
const SHADOW_CODE = `const E="${SHADOW_MARKER}";export default function S(){return E}`;
const page = (...tags) => `<!doctype html>\n<html><head>\n${tags.join('\n')}\n<link rel="stylesheet" crossorigin href="/assets/index-CSS.css">\n</head><body><div id="root"></div></body></html>`;
const ENTRY = '<script type="module" crossorigin src="/assets/index-AAAA1111.js"></script>';
const PRELOAD = '<link rel="modulepreload" crossorigin href="/assets/vendor-CCCC3333.js">';
// What `vite build` makes of this app today: the entry, a lazy Shadow file, other lazy files.
const GOOD = {
  indexHtml: page(ENTRY),
  chunks: {
    'assets/index-AAAA1111.js': 'import("./ClaudeShadowScreen-BBBB2222.js");console.log("board")',
    'assets/ClaudeShadowScreen-BBBB2222.js': SHADOW_CODE,
    'assets/quote-generator-DDDD4444.js': 'export const Q=1',
  },
};

// ── the rules ────────────────────────────────────────────────────────────────

test('a build where the Shadow is its own lazy file passes, and says which file that is', () => {
  const r = shadowChunkProblems(GOOD);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.startup, ['assets/index-AAAA1111.js']);
  assert.deepEqual(r.carriers, ['assets/ClaudeShadowScreen-BBBB2222.js']);
});

test('the Shadow\'s code back in the start-up file (inlineDynamicImports) fails, naming the file', () => {
  const r = shadowChunkProblems({ indexHtml: page(ENTRY), chunks: { 'assets/index-AAAA1111.js': `console.log("board");${SHADOW_CODE}` } });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^assets\/index-AAAA1111\.js loads at start-up and carries the Shadow's code/);
});

test('the Shadow\'s code in a file the entry preloads (a manualChunks rule) fails too — start-up is more than the entry', () => {
  const r = shadowChunkProblems({
    indexHtml: page(ENTRY, PRELOAD),
    chunks: { 'assets/index-AAAA1111.js': 'import"./vendor-CCCC3333.js"', 'assets/vendor-CCCC3333.js': `var r=1;${SHADOW_CODE}` },
  });
  assert.deepEqual(r.startup, ['assets/index-AAAA1111.js', 'assets/vendor-CCCC3333.js']);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^assets\/vendor-CCCC3333\.js loads at start-up and carries the Shadow's code/);
});

test('a build where NO file carries the marker fails — the check never passes without having found the Shadow', () => {
  // The endpoint renamed, or the Shadow deleted: a check that then passed would be passing blind.
  const r = shadowChunkProblems({ indexHtml: page(ENTRY), chunks: { 'assets/index-AAAA1111.js': 'x', 'assets/ClaudeShadowScreen-BBBB2222.js': 'renamed' } });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^No built file carries \/\.netlify\/functions\/claude-shadow/);
});

test('a start-up set that cannot be read fails: no index.html script, or a start-up file missing from the build', () => {
  const none = shadowChunkProblems({ indexHtml: page(), chunks: GOOD.chunks });
  assert.equal(none.problems.length, 1);
  assert.match(none.problems[0], /^index\.html names no script/);
  const missing = shadowChunkProblems({ indexHtml: page(ENTRY, PRELOAD), chunks: GOOD.chunks });
  assert.equal(missing.problems.length, 1);
  assert.match(missing.problems[0], /^index\.html loads \/assets\/vendor-CCCC3333\.js at start-up, and that is not a file in this build/);
  const offsite = shadowChunkProblems({ indexHtml: page('<script type="module" src="https://cdn.example.test/index.js"></script>'), chunks: GOOD.chunks });
  assert.match(offsite.problems[0], /^index\.html loads https:\/\/cdn\.example\.test\/index\.js at start-up, and that is not a file in this build/);
  // Absent and malformed input is a failure, never a pass.
  for (const bad of [undefined, null, '', 42]) {
    assert.ok(shadowChunkProblems({ indexHtml: bad, chunks: GOOD.chunks }).problems.length > 0, `indexHtml=${String(bad)}`);
    assert.ok(shadowChunkProblems({ indexHtml: page(ENTRY), chunks: bad }).problems.length > 0, `chunks=${String(bad)}`);
  }
});

test('the marker inside index.html itself is start-up code too', () => {
  const r = shadowChunkProblems({ indexHtml: page(ENTRY, `<script type="module">fetch("${SHADOW_MARKER}")</script>`), chunks: GOOD.chunks });
  assert.deepEqual(r.problems, ["index.html itself carries the Shadow's code (/.netlify/functions/claude-shadow)."]);
});

test('start-up is what the page loads: its scripts and preloads — not stylesheets, not a commented-out tag, not a lazy file', () => {
  const html = page(
    ENTRY,
    PRELOAD,
    "<link rel='preload' as='script' href='./assets/extra-EEEE5555.js' />",
    '<link rel="preload" as="font" href="/assets/font.woff2">',
    '<!-- <script type="module" src="/assets/old-FFFF6666.js"></script> -->',
    '<script>window.inline = 1</script>',
  );
  assert.deepEqual(startupRefs(html), ['/assets/index-AAAA1111.js', '/assets/vendor-CCCC3333.js', './assets/extra-EEEE5555.js']);
  assert.deepEqual(startupRefs(undefined), []);
});

test('a page reference is read as a path inside the build; off-site and escaping references are not', () => {
  assert.equal(distKey('/assets/index-A.js'), 'assets/index-A.js');
  assert.equal(distKey('./assets/index-A.js?v=2#x'), 'assets/index-A.js');
  assert.equal(distKey('assets/index-A.js'), 'assets/index-A.js');
  for (const off of ['https://cdn.test/a.js', '//cdn.test/a.js', '/../secret.js', 'data:text/javascript,1', '']) {
    assert.equal(distKey(off), null, off);
  }
});

test('the marker is the Shadow\'s own endpoint: in the Shadow\'s code, and in no source file outside src/shadow', () => {
  // If code outside the Shadow ever calls this endpoint, the check above would call that code "the
  // Shadow" and fail for the wrong reason: pick another literal only the Shadow's code carries.
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const code = walk(SRC).filter((f) => /\.(jsx?|mjs|tsx?|mts)$/.test(f)).map((f) => ({ rel: relative(SRC, f), text: readFileSync(f, 'utf8') }));
  const carriers = code.filter((f) => f.text.includes(SHADOW_MARKER)).map((f) => f.rel);
  assert.ok(carriers.includes(`shadow${sep}ClaudeShadowScreen.jsx`), `the Shadow screen itself carries the marker; carriers: ${carriers.join(', ')}`);
  assert.deepEqual(carriers.filter((r) => !r.startsWith(`shadow${sep}`)), [], 'files outside src/shadow carrying the marker');
});

// ── the script as CI runs it ─────────────────────────────────────────────────

function withDist(build, fn) {
  const root = mkdtempSync(join(tmpdir(), 'shadow-chunk-'));
  try {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    if (build.indexHtml != null) writeFileSync(join(dist, 'index.html'), build.indexHtml);
    for (const [k, v] of Object.entries(build.chunks || {})) writeFileSync(join(dist, ...k.split('/')), v);
    return fn({ root, dist });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

test('run as CI runs it: a good build exits 0 and names the Shadow\'s file', () => {
  withDist(GOOD, ({ dist }) => {
    const r = run([dist]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /✓ the Shadow's code is not in the start-up files \(assets\/index-AAAA1111\.js\); it loads from assets\/ClaudeShadowScreen-BBBB2222\.js when its tab opens\./);
  });
});

test('run as CI runs it: the Shadow in the start-up file exits 1, and says so', () => {
  withDist({ indexHtml: page(ENTRY), chunks: { 'assets/index-AAAA1111.js': SHADOW_CODE } }, ({ dist }) => {
    const r = run([dist]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /assets\/index-AAAA1111\.js loads at start-up and carries the Shadow's code/);
  });
});

test('run as CI runs it: no marker anywhere exits 1, and so does a build with no index.html', () => {
  withDist({ indexHtml: page(ENTRY), chunks: { 'assets/index-AAAA1111.js': 'x' } }, ({ dist }) => {
    const r = run([dist]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No built file carries/);
  });
  withDist({ indexHtml: null, chunks: GOOD.chunks }, ({ dist }) => {
    const r = run([dist]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no index\.html in .*dist — run `npm run build` first\./);
  });
});

test('run as CI runs it: with no argument it reads ./dist, as `npm run verify:shadow-chunk` does from dispatch-map', () => {
  withDist(GOOD, ({ root }) => {
    const r = run([], root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^✓ /);
  });
  withDist({ indexHtml: page(ENTRY), chunks: { 'assets/index-AAAA1111.js': SHADOW_CODE } }, ({ root }) => {
    assert.equal(run([], root).status, 1);
  });
});
