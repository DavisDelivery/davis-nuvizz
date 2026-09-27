#!/usr/bin/env node
// scripts/check-shadow-chunk.mjs — THE SHADOW'S CODE STAYS OUT OF THE START-UP FILES.
//
// Chad, 2026-09-27: "12 yes" to "Load the Shadow's code only when its tab opens?". Since then the
// Claude Shadow screen is a file of its own, fetched the first time Routing → Shadow opens, and the
// app's start-up file is about 200 KB lighter. test/claude-shadow-routing-tab.test.mjs pins that in
// the SOURCE: one React.lazy import() and nothing else outside src/shadow. What the source cannot
// show is the BUILD — a vite.config change (inlineDynamicImports, a manualChunks rule that files
// src/shadow into a chunk the entry loads) puts the Shadow back into the start-up files with every
// unit test green and the app working, only heavier. This reads the build.
//
//   node scripts/check-shadow-chunk.mjs [distDir]        (default: dist; CI: npm run verify:shadow-chunk)
//
// THE START-UP SET is what dist/index.html itself names: every <script src> (the entry is the module
// script) and every <link rel="modulepreload"> (Vite lists there the chunks the entry imports).
// Vite's own output; nothing here reads rollup-plugin-visualizer's stats page, whose format is not
// documented.
//
// WHAT IT DOES NOT SEE. With `build.modulePreload: false` in vite.config, Vite stops writing those
// modulepreload links, so a chunk the entry imports is no longer named in index.html and is not
// read. Measured: modulePreload:false together with a manualChunks rule that files src/shadow with
// React gives an entry that imports the Shadow's chunk at start-up, and this check passes. It takes
// both changes at once: that manualChunks rule alone is caught, and modulePreload:false alone leaves
// the Shadow in its own lazy file (both measured).
//
// THE MARKER is a string literal only the Shadow's code carries: its own endpoint. String literals
// survive minification verbatim; names do not. Measured on the build: it is in the
// ClaudeShadowScreen-*.js file and in no other built file, and in no src file outside src/shadow
// (test/shadow-chunk-check.test.mjs keeps that last part true — if code outside the Shadow ever
// calls this endpoint, pick another literal here).
//
// FAILS (exit 1):
//   - the marker is in any start-up file: the Shadow's code is loading at start-up again;
//   - the marker is in NO built file: the check would be blind (the endpoint was renamed, or the
//     Shadow is gone) — so it refuses to pass rather than pass without having looked;
//   - index.html is missing, names no script, or names a start-up file that is not in the build:
//     the start-up set cannot be read, and a check that cannot read it must not pass.
// Passes (exit 0) otherwise, naming the file the Shadow's code is in.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SHADOW_MARKER = '/.netlify/functions/claude-shadow';

/** Attributes of one tag's inside (`type="module" crossorigin src="/a.js"`), names lower-cased. */
function attributes(inside) {
  const out = {};
  for (const m of inside.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/**
 * The files dist/index.html makes the browser load as the page starts, as the page wrote them.
 * @param {string} indexHtml
 * @returns {string[]}
 */
export function startupRefs(indexHtml) {
  const html = String(indexHtml ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const refs = [];
  for (const m of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const a = attributes(m[2]);
    if (m[1].toLowerCase() === 'script') {
      if (a.src) refs.push(a.src);
    } else if (a.href) {
      const rel = (a.rel || '').toLowerCase().split(/\s+/);
      if (rel.includes('modulepreload') || (rel.includes('preload') && (a.as || '').toLowerCase() === 'script')) refs.push(a.href);
    }
  }
  return refs;
}

/** A page reference as a path inside dist ("assets/x.js"), or null when it points off the build. */
export function distKey(ref) {
  const s = String(ref).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return null;
  const path = s.split(/[?#]/)[0].replace(/^\.?\/+/, '');
  if (!path || path.split('/').includes('..')) return null;
  return path;
}

/**
 * Where the Shadow's code sits in a build.
 * @param {{ indexHtml: string, chunks: Record<string, string>, marker?: string }} build
 *   chunks: every .js/.mjs file in dist, keyed by its path inside dist with '/' separators.
 * @returns {{ problems: string[], startup: string[], carriers: string[] }}
 */
export function shadowChunkProblems({ indexHtml, chunks, marker = SHADOW_MARKER }) {
  const problems = [];
  const files = chunks && typeof chunks === 'object' ? chunks : {};
  const refs = startupRefs(indexHtml);
  const startup = [];
  if (!refs.length) {
    problems.push('index.html names no script, so what loads at start-up cannot be read. The check will not pass without having looked.');
  }
  for (const ref of refs) {
    const key = distKey(ref);
    if (key == null || typeof files[key] !== 'string') {
      problems.push(`index.html loads ${ref} at start-up, and that is not a file in this build — so it cannot be read. The check will not pass without having looked.`);
    } else if (!startup.includes(key)) {
      startup.push(key);
    }
  }
  const carriers = Object.keys(files).filter((k) => typeof files[k] === 'string' && files[k].includes(marker)).sort();
  if (String(indexHtml ?? '').includes(marker)) {
    problems.push(`index.html itself carries the Shadow's code (${marker}).`);
  }
  for (const key of startup) {
    if (carriers.includes(key)) {
      problems.push(`${key} loads at start-up and carries the Shadow's code (${marker}). The Shadow tab is meant to load only when it is opened (Chad, 2026-09-27, "12 yes"). Look for a vite.config change (inlineDynamicImports, manualChunks) or an import of src/shadow outside the React.lazy in App.jsx.`);
    }
  }
  if (!carriers.length) {
    problems.push(`No built file carries ${marker}, so this check cannot tell where the Shadow's code went. If the Shadow's endpoint was renamed, update SHADOW_MARKER in scripts/check-shadow-chunk.mjs to a literal only the Shadow's code carries.`);
  }
  return { problems, startup, carriers };
}

/** Every .js/.mjs file under dir, keyed by its path inside dir with '/' separators. */
export function readChunks(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.m?js$/.test(e.name)) out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function main(distArg) {
  const dist = resolve(distArg || 'dist');
  let indexHtml;
  try {
    indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
  } catch {
    console.error(`✗ no index.html in ${dist} — run \`npm run build\` first.`);
    process.exit(1);
  }
  const { problems, startup, carriers } = shadowChunkProblems({ indexHtml, chunks: readChunks(dist) });
  if (problems.length) {
    console.error(`\n✗ THE SHADOW'S CODE AND THE START-UP FILES — ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`);
    for (const p of problems) console.error(`   - ${p}`);
    console.error(`\n   Start-up files read from index.html: ${startup.join(', ') || 'none'}`);
    console.error(`   Files carrying the Shadow's code: ${carriers.join(', ') || 'none'}\n`);
    process.exit(1);
  }
  console.log(`✓ the Shadow's code is not in the start-up files (${startup.join(', ')}); it loads from ${carriers.join(', ')} when its tab opens.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]);
