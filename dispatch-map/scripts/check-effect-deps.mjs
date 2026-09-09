#!/usr/bin/env node
// scripts/check-effect-deps.mjs — NO EFFECT RUNS ON EVERY RENDER BY ACCIDENT.
//
// Why this exists: on 2026-09-09 the Routing map was "very slow and laggy". The cause was a
// useEffect declared with NO dependency array — it re-armed after every render of a
// 30,000-line screen, and a marker hover is a render. Its cleanup erased a CSS custom property
// and its re-run wrote the value back, which (custom properties being inherited) invalidated
// the style of every element under the map container, and the offsetHeight read that followed
// forced the whole recalculation inside the input's own frame: ~390ms per hover, ~750ms per
// click, on an 800-stop board with the grid open. It had been there for weeks. Nothing caught
// it because every guard this app has looks at pixels, and the pixels were right.
//
// An effect with no dependency array is the one shape React lets you write that runs after
// EVERY render. It is almost never what was meant, and when it is, the reason deserves to be
// written down where the next reader will see it. So: every useEffect / useLayoutEffect /
// useInsertionEffect call must pass a dependency array, OR carry a comment within the three
// lines above it reading `effect-every-render: <why>`.
//
// Parsed with @babel/parser (a dependency of @vitejs/plugin-react, which the build already
// needs), not a regex: App.jsx carries apostrophes in JSX text, template literals with nested
// expressions and regex literals, and a hand-rolled scanner would either miss a call or stop
// the whole file at the first "don't". A guard that can be fooled is a guard that passes.
//
// Usage: node scripts/check-effect-deps.mjs [path ...]   (default: src)
//   exits 1 with every offender listed as file:line, 0 when clean, 2 when it cannot run.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALLOW_MARK = 'effect-every-render:';
const EFFECT_NAMES = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);

/** The line (1-based) of a character offset. */
function lineOf(source, index) {
  let n = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source.charCodeAt(i) === 10) n += 1;
  return n;
}

/** Is `node` a call to one of the effect hooks — bare, or as React.useEffect? */
function effectCallee(node) {
  const c = node.callee;
  if (!c) return null;
  if (c.type === 'Identifier' && EFFECT_NAMES.has(c.name)) return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property?.type === 'Identifier' && EFFECT_NAMES.has(c.property.name)) return c.property.name;
  return null;
}

/**
 * PURE over an already-parsed AST + its source: every effect call without a dependency
 * array that is not excused by an `effect-every-render:` comment in the 3 lines above it.
 * Returns [{ line, name, excused:false }] — excused calls are simply not returned.
 */
export function effectsWithoutDeps(ast, source) {
  const lines = source.split('\n');
  const out = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    if (seen.has(node)) return;
    seen.add(node);
    if (node.type === 'CallExpression') {
      const name = effectCallee(node);
      if (name && (node.arguments || []).length < 2) {
        const line = lineOf(source, node.start);
        const above = lines.slice(Math.max(0, line - 4), line - 1).join('\n');
        const excusedRe = new RegExp(`${ALLOW_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\S`);
        if (!excusedRe.test(above)) out.push({ line, name });
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
      const v = node[k];
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(ast.program || ast);
  return out;
}

/** Parse one file's source (JS/JSX/TS/TSX) into a Babel AST. */
export async function parseSource(source, filename = 'file.jsx') {
  let parser;
  try { parser = await import('@babel/parser'); }
  catch {
    const err = new Error('@babel/parser is not installed — run `npm ci` in dispatch-map (it ships with @vitejs/plugin-react).');
    err.code = 'NO_PARSER';
    throw err;
  }
  const ts = /\.tsx?$/.test(filename);
  return parser.parse(source, {
    sourceType: 'module',
    plugins: ['jsx', ...(ts ? ['typescript'] : [])],
    errorRecovery: true,
    attachComment: false,
  });
}

/** Every source file under `paths` this guard reads: .js/.jsx/.ts/.tsx, never tests. */
export function collectFiles(paths) {
  const out = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) { for (const e of readdirSync(p)) if (e !== 'node_modules') walk(join(p, e)); return; }
    if (/\.(jsx?|tsx?)$/.test(p) && !/\.test\.[cm]?[jt]sx?$/.test(p)) out.push(p);
  };
  for (const p of paths) walk(p);
  return out;
}

export async function checkPaths(paths, { root = process.cwd() } = {}) {
  const offenders = [];
  for (const file of collectFiles(paths)) {
    const source = readFileSync(file, 'utf8');
    if (!/use(?:Layout|Insertion)?Effect/.test(source)) continue;   // nothing to parse
    const ast = await parseSource(source, file);
    for (const o of effectsWithoutDeps(ast, source)) offenders.push({ file: relative(root, file), ...o });
  }
  return offenders;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(here, '..');
  const args = process.argv.slice(2);
  const paths = (args.length ? args : ['src']).map((p) => resolve(pkgRoot, p));
  let offenders;
  try { offenders = await checkPaths(paths, { root: pkgRoot }); }
  catch (e) {
    console.error(`✗ effect-deps guard could not run: ${e.message}`);
    process.exit(2);
  }
  if (offenders.length) {
    console.error(`✗ ${offenders.length} effect(s) declared with NO dependency array — each one re-runs after EVERY render:\n`);
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.name}(...)`);
    console.error('\n  Pass a dependency array. If the effect truly must run on every render, say why on the line');
    console.error(`  above it: // ${ALLOW_MARK} <reason>. See useBottomGridHeightVar in src/App.jsx for what an`);
    console.error('  accidental every-render effect cost the Routing screen (v0.98.0).');
    process.exit(1);
  }
  console.log('✓ every effect declares its dependencies (or says why it must not)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
