#!/usr/bin/env node
// scripts/check-shadow-isolation.mjs — THE CLAUDE SHADOW PLANNER CANNOT REACH NUVIZZ. CI PROVES IT.
//
// The shadow planner plans tomorrow's loads beside the router, for comparison only. The brief
// it was built from put one rule above every other: it may not call NuVizz — not a scan, not a
// read, not a write — and it may not write anything outside its own Firestore prefix. A rule
// like that is only as good as the attention of whoever reads it, so this walks the real import
// graph of every shadow entry point and FAILS the build when the rule is broken.
//
// ENTRY POINTS (found by name, so a new shadow function is checked the day it lands):
//   server   netlify/functions/claude-shadow*.mts
//   browser  src/shadow/*.{js,jsx}
// The graph is esbuild's own (the bundler Netlify ships these functions with), so resolution
// — extensions, index files, dynamic imports with literal specifiers — matches what deploys.
//
// SERVER RULES, on EVERY module the graph reaches (not just the shadow's own files):
//   nuvizz-module   the file is named nuvizz* (nuvizz-request, nuvizz-write, nuvizz.cjs, …)
//   nuvizz-env      the code names a NUVIZZ_* variable
//   nuvizz-host     the code names a nuvizz.com host
//   host            the code names any http(s) host other than api.anthropic.com and the
//                   three Google hosts lib/firestore.mts talks to (Firestore and its OAuth)
//   package         an npm package is imported (node: builtins only — a package can fetch
//                   anything, so each one would have to be added here on purpose)
//   dynamic         esbuild could not follow an import/require, so the graph is not complete
// Comments are stripped first: prose that mentions NuVizz is not a call.
//
// ONE EXEMPTION, and it is narrow on purpose. lib/firestore.mts reads NUVIZZ_BASE_URL in
// exactly one expression — to REFUSE a UAT NuVizz host against the production database
// (uatMisconfigured). It makes no NuVizz request. The exemption removes that one expression
// and nothing else before the rules run; if the expression changes or a second NuVizz
// reference appears in that file, the build fails and a person looks again.
//
// BROWSER RULES: the screen may reach only src/shadow/**, src/lib/api.js (the one place a
// session token gets onto a request) and src/lib/session.js, plus the react and lucide-react
// packages — so no Route Workbench, no Build Panel, no Firestore client, no NuVizz writer. It
// may name no http(s) host, may call no function but claude-shadow*, and may not call bare
// fetch() (apiFetch carries the session).
//
// WRITE GATEWAY: no shadow-owned server file except lib/claude-shadow/store.mts may import a
// binding named like a writer (set*, update*, create*, delete*, patch*, write*, …) from any
// module, nor namespace-import or default-import a local module to get around that, nor use
// a dynamic import — and it may import shared (non-shadow) modules only from SHARED_IMPORTS,
// a reviewed list that says why each one cannot write. store.mts refuses any path outside
// claude_shadow_* at run time (test/claude-shadow-store.test.mjs pins that half).
//
// Usage: node scripts/check-shadow-isolation.mjs [root]    (root defaults to dispatch-map/)
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, posix, sep } from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, '..');

export const LAYOUT = {
  functionsDir: 'netlify/functions',
  functionRe: /^claude-shadow[\w-]*\.mts$/,
  libDir: 'netlify/functions/lib/claude-shadow',
  store: 'netlify/functions/lib/claude-shadow/store.mts',
  screenDir: 'src/shadow',
};

export const SERVER_HOSTS = ['api.anthropic.com', 'firestore.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com'];
export const SERVER_PACKAGES = [];
export const BROWSER_FILES = ['src/lib/api.js', 'src/lib/session.js'];
export const BROWSER_PACKAGES = ['react', 'react/jsx-runtime', 'lucide-react'];

export const EXEMPTIONS = [{
  file: 'netlify/functions/lib/firestore.mts',
  // Matched against esbuild's comment-free output, which normalises quotes to "".
  code: /\/uat\\\.nuvizz\\\.com\/i\.test\(String\(process\.env\.NUVIZZ_BASE_URL \|\| ""\)\)/g,
  why: 'uatMisconfigured() reads NUVIZZ_BASE_URL only to refuse a UAT NuVizz host against the production database; it makes no NuVizz request',
}];

export const WRITE_RE = /^(set|update|create|batch|delete|write|patch|mark|record|merge|increment|apply|move|put|save|commit|remove|upsert|append|clear|reset|seal|store|push|send|post|claim|prune|refile|heal|drop|insert|replace|overwrite|flush|stamp|touch|lock|unlock)(?=[A-Z0-9_]|$)/;

// THE SHARED MODULES A SHADOW FILE MAY IMPORT, each with the reason it cannot write for the
// shadow. The writer-name rule above catches `setDoc` however it is renamed on import, but it
// cannot see a shared helper named innocently (`keep()`) that writes inside. So a shadow file
// may import from other shadow files, from store.mts, and from THIS list only — and adding a
// shared module is an edit to this file, where a reviewer reads the reason next to it.
export const SHARED_IMPORTS = {
  'netlify/functions/lib/firestore.mts': 'read helpers only; its writers are refused by name above',
  'netlify/functions/lib/require-user.mts': 'the auth gate; reads the user store, writes nothing',
};

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const toPosix = (p) => p.split(sep).join('/');

function loaderFor(file) {
  if (/\.(mts|ts|cts)$/.test(file)) return 'ts';
  if (/\.(jsx|js|mjs|cjs)$/.test(file)) return 'jsx';
  return 'js';
}

async function stripped(root, file) {
  const src = readFileSync(join(root, file), 'utf8');
  try {
    return (await esbuild.transform(src, { loader: loaderFor(file), legalComments: 'none', format: 'esm', jsx: 'preserve' })).code;
  } catch {
    // .cjs with top-level returns etc. — fall back to the raw text: stricter, never looser.
    return src;
  }
}

function listFiles(root, dir, re) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((n) => re.test(n) && statSync(join(abs, n)).isFile()).map((n) => posix.join(dir, n));
}

function walkDir(root, dir) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const n of readdirSync(abs)) {
    const p = posix.join(dir, n);
    if (statSync(join(root, p)).isDirectory()) out.push(...walkDir(root, p));
    else if (/\.(mts|ts|js|jsx|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

async function graph(root, entries, platform) {
  const res = await esbuild.build({
    absWorkingDir: root,
    entryPoints: entries,
    bundle: true, write: false, metafile: true, logLevel: 'silent',
    platform, format: 'esm', packages: 'external',
    loader: { '.js': 'jsx' }, jsx: 'transform',
  });
  const files = new Map();
  for (const [p, info] of Object.entries(res.metafile.inputs)) files.set(toPosix(p), info.imports || []);
  return { files, warnings: res.warnings || [] };
}

function hostsIn(code) {
  return [...code.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1].toLowerCase());
}

function applyExemptions(file, code, violations) {
  let out = code;
  for (const ex of EXEMPTIONS) {
    if (ex.file !== file) continue;
    const hits = code.match(ex.code) || [];
    if (hits.length !== 1) {
      violations.push({ rule: 'exemption', file, detail: `the reviewed exemption matched ${hits.length} times (expected exactly 1) — ${ex.why}. Look at this file again before changing the guard.` });
    }
    out = out.replace(ex.code, '/*exempt*/');
  }
  return out;
}

function packageOf(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec;
}

/** Parse the import/export-from statements of already comment-free ESM. */
export function importsOf(code) {
  const out = [];
  const re = /(?:^|[;\n}])\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(re)) {
    const kind = m[1], clause = m[3].trim(), source = m[4];
    const named = [];
    let namespace = false, defaultName = null, star = false;
    const brace = clause.match(/\{([^}]*)\}/);
    if (brace) {
      for (const part of brace[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        const clean = part.replace(/^type\s+/, '');
        named.push(clean.split(/\s+as\s+/)[0].trim());
      }
    }
    if (/\*\s+as\s+[\w$]+/.test(clause)) namespace = true;
    if (kind === 'export' && /^\*$/.test(clause)) star = true;
    const def = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[\w$]+/, '').replace(/,/g, ' ').trim();
    if (kind === 'import' && def) defaultName = def;
    out.push({ kind, source, named, namespace, defaultName, star });
  }
  return out;
}

function resolvesTo(fromFile, spec, target) {
  if (!spec.startsWith('.')) return false;
  const p = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  return p === target || p === target.replace(/\.mts$/, '') || `${p}.mts` === target;
}

export async function checkShadowIsolation(root = DEFAULT_ROOT) {
  const violations = [];
  const serverEntries = listFiles(root, LAYOUT.functionsDir, LAYOUT.functionRe);
  const browserEntries = listFiles(root, LAYOUT.screenDir, /\.(js|jsx)$/);
  if (serverEntries.length === 0) violations.push({ rule: 'empty', file: LAYOUT.functionsDir, detail: 'no claude-shadow*.mts function found — a guard that checks nothing passes, so this is a failure' });
  if (browserEntries.length === 0) violations.push({ rule: 'empty', file: LAYOUT.screenDir, detail: 'no shadow screen found — a guard that checks nothing passes, so this is a failure' });

  // ── server graph ──
  const serverFiles = [];
  if (serverEntries.length) {
    let g;
    try { g = await graph(root, serverEntries, 'node'); }
    catch (e) { violations.push({ rule: 'build', file: serverEntries.join(', '), detail: `esbuild could not walk the server graph: ${e?.message || e}` }); }
    if (g) {
      for (const w of g.warnings) {
        if (/not be bundled|cannot be analyzed|not a string literal/i.test(w.text)) {
          violations.push({ rule: 'dynamic', file: toPosix(w.location?.file || '?'), detail: w.text });
        }
      }
      for (const [file, imports] of g.files) {
        serverFiles.push(file);
        const base = posix.basename(file);
        if (/^nuvizz/i.test(base)) violations.push({ rule: 'nuvizz-module', file, detail: 'a NuVizz module is reachable from a shadow entry point' });
        for (const imp of imports) {
          if (!imp.external) continue;
          const spec = imp.path;
          if (spec.startsWith('.') || spec.startsWith('/')) violations.push({ rule: 'unresolved', file, detail: `local import ${spec} could not be resolved, so the graph is not complete` });
          else if (!BUILTINS.has(spec) && !SERVER_PACKAGES.includes(packageOf(spec))) violations.push({ rule: 'package', file, detail: `npm package "${spec}" is reachable; only node: builtins are allowed on the shadow's server path` });
        }
        const code = applyExemptions(file, await stripped(root, file), violations);
        const env = code.match(/\bNUVIZZ_[A-Z0-9_]*/g);
        if (env) violations.push({ rule: 'nuvizz-env', file, detail: `names ${[...new Set(env)].join(', ')}` });
        if (/nuvizz\\?\.com/i.test(code)) violations.push({ rule: 'nuvizz-host', file, detail: 'names a nuvizz.com host' });
        const bad = [...new Set(hostsIn(code).filter((h) => !SERVER_HOSTS.includes(h)))];
        if (bad.length) violations.push({ rule: 'host', file, detail: `names ${bad.join(', ')} — the shadow's server path may reach only ${SERVER_HOSTS.join(', ')}` });
      }
    }
  }

  // ── write gateway, on the shadow's own server files ──
  const owned = [...serverEntries, ...walkDir(root, LAYOUT.libDir)].filter((f) => f !== LAYOUT.store);
  for (const file of owned) {
    const code = await stripped(root, file);
    if (/\bimport\s*\(/.test(code) || /\brequire\s*\(/.test(code)) {
      violations.push({ rule: 'gateway', file, detail: 'dynamic import/require in a shadow file — every import must be static so the gateway rule can see it' });
    }
    for (const imp of importsOf(code)) {
      if (resolvesTo(file, imp.source, LAYOUT.store)) continue;
      const local = imp.source.startsWith('.');
      if (local) {
        const target = posix.normalize(posix.join(posix.dirname(file), imp.source));
        const shadowOwned = target.startsWith(`${LAYOUT.libDir}/`) || LAYOUT.functionRe.test(posix.basename(target));
        if (!shadowOwned && !(target in SHARED_IMPORTS)) {
          violations.push({ rule: 'shared-import', file, detail: `imports ${target}, which is not on the reviewed list — add it to SHARED_IMPORTS in scripts/check-shadow-isolation.mjs with the reason it cannot write for the shadow` });
        }
      }
      if (imp.namespace && local) violations.push({ rule: 'gateway', file, detail: `namespace import of ${imp.source} — would reach its writers around the gateway` });
      if (imp.star && local) violations.push({ rule: 'gateway', file, detail: `export * from ${imp.source} — would re-export its writers around the gateway` });
      if (imp.defaultName && local) violations.push({ rule: 'gateway', file, detail: `default import from ${imp.source} — name the bindings so the gateway rule can see them` });
      for (const name of imp.named) {
        if (WRITE_RE.test(name)) violations.push({ rule: 'gateway', file, detail: `imports writer "${name}" from ${imp.source} — shadow writes go through ${LAYOUT.store}` });
      }
    }
  }

  // ── browser graph ──
  const browserFiles = [];
  if (browserEntries.length) {
    let g;
    try { g = await graph(root, browserEntries, 'browser'); }
    catch (e) { violations.push({ rule: 'build', file: browserEntries.join(', '), detail: `esbuild could not walk the browser graph: ${e?.message || e}` }); }
    if (g) {
      for (const w of g.warnings) {
        if (/not be bundled|cannot be analyzed|not a string literal/i.test(w.text)) violations.push({ rule: 'dynamic', file: toPosix(w.location?.file || '?'), detail: w.text });
      }
      for (const [file, imports] of g.files) {
        browserFiles.push(file);
        const inShadow = file.startsWith(`${LAYOUT.screenDir}/`);
        if (!inShadow && !BROWSER_FILES.includes(file)) {
          violations.push({ rule: 'browser-module', file, detail: `the shadow screen reaches ${file}; it may reach only ${LAYOUT.screenDir}/** and ${BROWSER_FILES.join(', ')}` });
        }
        for (const imp of imports) {
          if (!imp.external) continue;
          if (imp.path.startsWith('.') || imp.path.startsWith('/')) violations.push({ rule: 'unresolved', file, detail: `local import ${imp.path} could not be resolved` });
          else if (!BROWSER_PACKAGES.includes(imp.path)) violations.push({ rule: 'browser-package', file, detail: `package "${imp.path}" — the shadow screen may use only ${BROWSER_PACKAGES.join(', ')}` });
        }
        const code = await stripped(root, file);
        const hosts = [...new Set(hostsIn(code))];
        if (hosts.length) violations.push({ rule: 'browser-host', file, detail: `names ${hosts.join(', ')} — the shadow screen may call only its own function` });
        for (const m of code.matchAll(/["'`]\/(?:\.netlify\/functions|api)\/([A-Za-z0-9_-]+)/g)) {
          if (!m[1].startsWith('claude-shadow')) violations.push({ rule: 'browser-endpoint', file, detail: `calls /${m[1]} — the shadow screen may call only claude-shadow*` });
        }
        if (inShadow && /\bfetch\s*\(/.test(code)) violations.push({ rule: 'browser-fetch', file, detail: 'bare fetch() — use apiFetch from src/lib/api.js' });
        if (/NUVIZZ_|nuvizz\\?\.com/i.test(code) && inShadow) violations.push({ rule: 'nuvizz-host', file, detail: 'names NuVizz' });
      }
    }
  }

  return { ok: violations.length === 0, violations, serverEntries, browserEntries, serverFiles: serverFiles.sort(), browserFiles: browserFiles.sort() };
}

async function main() {
  const root = resolve(process.argv[2] || DEFAULT_ROOT);
  const r = await checkShadowIsolation(root);
  const rel = (f) => f;
  console.log(`shadow isolation — ${r.serverEntries.length} server entr${r.serverEntries.length === 1 ? 'y' : 'ies'}, ${r.browserEntries.length} browser entr${r.browserEntries.length === 1 ? 'y' : 'ies'}`);
  console.log(`  server graph (${r.serverFiles.length} modules): ${r.serverFiles.map(rel).join(', ')}`);
  console.log(`  browser graph (${r.browserFiles.length} modules): ${r.browserFiles.map(rel).join(', ')}`);
  if (r.ok) { console.log('OK — no path from the Claude shadow planner reaches NuVizz, a foreign host, or a Firestore writer outside the gateway.'); return; }
  console.error(`\nFAIL — ${r.violations.length} violation(s):`);
  for (const v of r.violations) console.error(`  [${v.rule}] ${v.file}: ${v.detail}`);
  console.error('\nThe shadow planner must never call NuVizz or write outside claude_shadow_*. Fix the import; do not weaken this guard.');
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
