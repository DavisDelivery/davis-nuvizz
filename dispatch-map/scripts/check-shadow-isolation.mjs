#!/usr/bin/env node
// scripts/check-shadow-isolation.mjs — THE CLAUDE SHADOW PLANNER CANNOT REACH NUVIZZ. CI PROVES IT.
//
// The shadow planner plans tomorrow's loads beside the router, for comparison only. The brief
// it was built from put one rule above every other: it may not call NuVizz — not a scan, not a
// read, not a write — and it may not write anything outside its own Firestore prefix. A rule
// like that is only as good as the attention of whoever reads it, so this reads the code and
// FAILS the build when the rule can be broken.
//
// IT IS AN ALLOWLIST, NOT A DENYLIST. The first version looked for bad names (nuvizz*, NUVIZZ_,
// a foreign host literal, setDoc) and an adversarial review found eighteen ways to spell the
// same thing differently: a same-origin fetch of /.netlify/functions/nuvizz-manual-scan, a
// host assembled from two strings, raw Firestore credentials, a writer re-exported through a
// file the guard did not look at, an import alias, a tab inside a path. Chasing spellings loses.
// So the rules below say what the shadow MAY reach, and everything else fails:
//
//   1. EVERY MODULE the server graph reaches is shadow code or on REVIEWED_SHARED, a short list
//      with the reason each one cannot call NuVizz or write for the shadow. A new shared
//      dependency is an edit to this file, where a reviewer reads that reason.
//   2. EVERY BINDING a shadow file imports from a shared module is named in SHARED_IMPORTS.
//      firestore.mts is reachable for its READ helpers; its writers, its token minting and its
//      service account are not importable at all.
//   3. ONE DOOR TO THE NETWORK. Only lib/claude-shadow/anthropic.mts may touch fetch, and only
//      as `f(MESSAGES_URL, …)` with MESSAGES_URL the literal Messages API address. No other
//      shadow file may name fetch, XMLHttpRequest, WebSocket, an http/https/net builtin,
//      eval, Function, globalThis, a dynamic import or require, the Firestore/OAuth hosts, the
//      service-account variable, or the site's own function paths.
//   4. ONE DOOR TO FIRESTORE WRITES. lib/claude-shadow/store.mts may import only the four
//      writers (plus assertSafePath) and config.mts, may export only shadow*/assertShadowPath/
//      ShadowPathError, re-exports nothing, and every use of a writer is literally
//      `writer(assertShadowPath(…` — so no write leaves the prefix without passing the check.
//   5. THE SCREEN reaches only src/shadow/**, src/lib/api.js and src/lib/session.js plus react
//      and lucide-react, never names fetch, window (but window.confirm), document, eval or an
//      element that loads a URL, and every apiFetch() it makes is to a constant that is the
//      literal claude-shadow function path.
//   6. THE RUNTIME NET. A second adversarial review showed what reading code cannot promise:
//      `global['fe' + 'tch']`, an indirect eval or a helper appending to a checked path all
//      spell a request no pattern sees. So every shadow function calls lockEgress()
//      (lib/claude-shadow/egress.mts) as the FIRST statement of its handler, and the lock
//      judges the request itself: Anthropic and Firestore only, Firestore writes only under
//      claude_shadow_*. The lock file is pinned by hash below — it changes only with a person
//      re-reading it.
//   7. NOTHING ELSE REACHES THE SHADOW LIB. Any file under netlify/ outside the shadow's own
//      files that imports lib/claude-shadow fails — directly or through a lib/ bridge — so the
//      walk from the shadow entry points covers every way shadow code runs.
//
// DEFENCE IN DEPTH, on every module either graph reaches: no nuvizz* module; no NUVIZZ_ name
// and no nuvizz.com host (one reviewed exemption below); no http(s) host outside the allowlist;
// no dynamic import()/require() with a non-literal argument; no npm package on the server path;
// no network builtin. Comments are stripped first — prose that mentions NuVizz is not a call.
//
// ONE EXEMPTION, narrow on purpose: lib/firestore.mts reads NUVIZZ_BASE_URL in exactly one
// expression, to REFUSE a UAT NuVizz host against the production database (uatMisconfigured).
// It makes no NuVizz request. If that expression changes, or the file names NuVizz anywhere
// else, the build fails and a person looks again.
//
// ENTRY POINTS: every netlify/functions/claude-shadow* function (any JS/TS extension) and every
// file under src/shadow/. A function by any OTHER name that imports lib/claude-shadow fails —
// shadow code runs from shadow entry points, which is what makes the walk above complete.
//
// Usage: node scripts/check-shadow-isolation.mjs [root]    (root defaults to dispatch-map/)
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, posix, sep } from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, '..');

const CODE_EXT = /\.(mts|cts|ts|tsx|mjs|cjs|js|jsx|json)$/;
export const LAYOUT = {
  netlifyDir: 'netlify',
  functionsDir: 'netlify/functions',
  functionRe: /^claude-shadow[\w-]*\.(mts|cts|ts|mjs|cjs|js)$/,
  functionDirRe: /^claude-shadow[\w-]*$/,
  libDir: 'netlify/functions/lib/claude-shadow',
  store: 'netlify/functions/lib/claude-shadow/store.mts',
  door: 'netlify/functions/lib/claude-shadow/anthropic.mts',
  egress: 'netlify/functions/lib/claude-shadow/egress.mts',
  screenDir: 'src/shadow',
};

// Rule 6. SHA-256 of egress.mts as esbuild prints it with comments stripped. A change to the lock
// fails here until someone has re-read it and pasted the new value (the failure prints it).
export const EGRESS_SHA256 = 'fbc5653ec917c0956ca55b83cfc7691e0509e55517b3fd3743ee0e73374b1ef3';

export const SERVER_HOSTS = ['api.anthropic.com', 'firestore.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com'];
export const MESSAGES_URL_LITERAL = 'https://api.anthropic.com/v1/messages';

// Rule 1. Every non-shadow module the shadow's server graph may reach, and why it is safe there.
export const REVIEWED_SHARED = {
  'netlify/functions/lib/firestore.mts': 'the Firestore REST client; fetches only firestore.googleapis.com and oauth2.googleapis.com. Its writers are not importable by shadow files (rule 2); store.mts wraps four of them',
  'netlify/functions/lib/fetch-deadline.mts': 'the deadline wrapper firestore.mts fetches through; no host of its own',
  'netlify/functions/lib/address-history.mts': 'pure address-change row builder imported by firestore.mts',
  'netlify/functions/lib/finished-guard.mts': 'pure finished-row predicate imported by firestore.mts',
  'netlify/functions/lib/route-identity.mts': 'pure route/load identity helpers imported by firestore.mts',
  'src/lib/matchKey.js': 'pure match-key normaliser imported by address-history.mts',
  'netlify/functions/lib/require-user.mts': 'the auth gate; reads the user document, calls no vendor',
  'netlify/functions/lib/auth-core.mts': 'session-token signing and checking; node:crypto only',
  'netlify/functions/lib/auth-store.mts': 'the user store, reached only through requireUser, which reads it',
  // v1.70.0 — the Claude router's backtest measures plans with the learned engine's OWN estimator and
  // sequencer, so its miles and minutes line up with the Engine tab's. Each is pure: no I/O, no host.
  'netlify/functions/lib/routing-engine-solver.mts': 'the learned engine\'s sequencer and travel estimator; PURE (its header: no I/O); its only value import is zones.mts (the config and score imports are type-only)',
  'netlify/functions/lib/zones.mts': 'geohash zone ids; PURE, no imports',
  'netlify/functions/lib/driver-class.mts': 'the engine\'s driver→truck-class rule (employees roster + the one pin); PURE, no imports — moved out of routing-plan-core.mts unchanged so the shadow can share it',
  'netlify/functions/lib/routing-types.mts': 'shared routing types and the Buford DEPOT constant; no imports',
  'netlify/functions/lib/routing-engine-config.mts': 'the engine\'s config defaults and clamps; the shadow imports only the PURE effectiveEngineConfig and engineConfigPath (rule 2), reads the stored doc itself with getDoc, and cannot reach the module\'s writer',
};

// The only builtins each reviewed module may import. Any other — and every builtin in a shadow
// file — fails: node:https, node:net, node:module (createRequire) and the _http_* internals are how
// a request leaves without fetch, where the runtime lock cannot see it.
export const REVIEWED_BUILTINS = {
  'netlify/functions/lib/firestore.mts': ['node:crypto'],
  'netlify/functions/lib/auth-core.mts': ['node:crypto'],
};

// Rule 2. Exactly which bindings a shadow file may import from each shared module.
export const SHARED_IMPORTS = {
  // listDocs (v1.63.0, learning): a paged GET of one collection, optionally field-masked — a read,
  // and the egress lock judges it as one. The shadow learns from history_days with it.
  'netlify/functions/lib/firestore.mts': ['getDoc', 'isFirestoreEnabled', 'listDocs'],
  'netlify/functions/lib/require-user.mts': ['requireUser'],
  // v1.70.0 — the Claude router's backtest (lib/claude-shadow/backtest-core.mts, backtest.mts).
  'netlify/functions/lib/routing-engine-solver.mts': ['solveRoute', 'haversineMiles', 'travelMinutesForMiles'],
  'netlify/functions/lib/zones.mts': ['zoneId'],
  'netlify/functions/lib/driver-class.mts': ['employeeClassMap', 'CLASS_OVERRIDE'],
  'netlify/functions/lib/routing-types.mts': ['DEPOT', 'DEFAULT_SERVICE_MIN'],
  'netlify/functions/lib/routing-engine-config.mts': ['effectiveEngineConfig', 'engineConfigPath'],
};

// Rule 4. What the gateway may import from firestore.mts, and the only names it may export.
export const STORE_WRITERS = ['setDoc', 'updateDocFields', 'createDocIfAbsent', 'deleteDoc'];
export const STORE_FIRESTORE_IMPORTS = [...STORE_WRITERS, 'assertSafePath'];
export const STORE_EXPORT_RE = /^(shadow[A-Z]\w*|assertShadowPath|ShadowPathError)$/;

// Rule 5.
export const BROWSER_FILES = ['src/lib/api.js', 'src/lib/session.js'];
export const BROWSER_PACKAGES = ['react', 'react/jsx-runtime', 'lucide-react'];
export const SCREEN_ENDPOINT_PREFIX = '/.netlify/functions/claude-shadow';

export const EXEMPTIONS = [{
  file: 'netlify/functions/lib/firestore.mts',
  // Matched against esbuild's comment-free output, which normalises quotes to "".
  code: /\/uat\\\.nuvizz\\\.com\/i\.test\(String\(process\.env\.NUVIZZ_BASE_URL \|\| ""\)\)/g,
  why: 'uatMisconfigured() reads NUVIZZ_BASE_URL only to refuse a UAT NuVizz host against the production database; it makes no NuVizz request',
}];

// Kept as a second net under rule 2: a writer-shaped name imported by a shadow file fails even
// if someone adds it to SHARED_IMPORTS by mistake.
export const WRITE_RE = /^(set|update|create|batch|delete|write|patch|mark|record|merge|increment|apply|move|put|save|commit|remove|upsert|append|clear|reset|seal|store|push|send|post|claim|prune|refile|heal|drop|insert|replace|overwrite|flush|stamp|touch|lock|unlock)(?=[A-Z0-9_]|$)/;

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const normBuiltin = (spec) => (spec.startsWith('node:') ? spec : `node:${spec}`);

// Ways to reach the network or run unread code without naming fetch — refused in shadow files AND
// in reviewed shared modules (none of them uses any of these today).
const ESCAPE_HATCHES = /\bcreateRequire\b|\bgetBuiltinModule\b|\bprocess\s*\.\s*(?:binding|dlopen|_linkedBinding)\b|\b_http_|\b_tls_|\bWebAssembly\b|\bnew\s+Worker\b/;
// Same-origin function paths: a shadow file or a reviewed module calling /.netlify/functions/*
// is how a NuVizz scan would be triggered from "our own" host.
const SITE_FUNCTION_PATH = /\/\.netlify\/functions\/|["'`]\/api\//;

// Tokens no shadow-owned file may contain (after comments are stripped). Each is a way to reach
// the network, the vendor, or Firestore around the two doors.
const OWNED_FORBIDDEN = [
  [/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/, 'a network primitive'],
  [/\beval\b|\bFunction\b|\.constructor\b|\bReflect\b|\bProxy\b/, 'eval / Function / .constructor / Reflect / Proxy — code or calls the guard cannot read'],
  [/\bglobalThis\b|\bglobal\b|\bmodule\b|\bimport\.meta\b/, 'globalThis / global / module / import.meta — ways to reach fetch or a module without naming it'],
  [/\bimport\s*\(|\brequire\s*\(/, 'a dynamic import or require — every import must be static so the guard can see it'],
  [ESCAPE_HATCHES, 'createRequire / getBuiltinModule / process.binding / _http_ / _tls_ / WebAssembly / Worker — a way to the network without fetch'],
  [/googleapis\.com|FIREBASE_SA|\bgetAccessToken\b|\bloadServiceAccount\b|\bfirestoreDatabase\b/, 'Firestore credentials or hosts — shadow code reaches Firestore only through firestore.mts read helpers and store.mts'],
  [SITE_FUNCTION_PATH, "the site's own function paths — server shadow code may not call another function (that is how a NuVizz scan would be triggered)"],
  // process only as process.env: process.binding, .dlopen, .getBuiltinModule and .mainModule.require
  // are each a way to a socket that never names fetch.
  [/\bprocess\b(?!\s*\.\s*env\b)/, 'process other than process.env'],
  [/\bNUVIZZ_[A-Z0-9_]*/, 'a NUVIZZ_ variable'],
  [/nuvizz\\?\.com/i, 'a NuVizz host'],
];

const toPosix = (p) => p.split(sep).join('/');

// IMPORTS AS WRITTEN. TypeScript's default is to DROP an import whose bindings are never used as
// values, and esbuild follows it — which made an imported-but-uncalled `setDoc` invisible to the
// rules below, and made the bundler report the dropped path as an unresolved external. An import
// that is written is an import that is checked: only `import type` / inline `type` specifiers go.
const TSCONFIG = { compilerOptions: { verbatimModuleSyntax: true } };

function loaderFor(file) {
  if (/\.(mts|cts|ts)$/.test(file)) return 'ts';
  if (/\.tsx$/.test(file)) return 'tsx';
  if (/\.json$/.test(file)) return 'json';
  return 'jsx';
}

async function stripped(root, file) {
  const src = readFileSync(join(root, file), 'utf8');
  try {
    return (await esbuild.transform(src, { loader: loaderFor(file), legalComments: 'none', format: 'esm', jsx: 'preserve', tsconfigRaw: TSCONFIG })).code;
  } catch {
    // Unparseable as ESM (e.g. a CommonJS file with top-level return): the raw text, comments
    // and all — stricter, never looser.
    return src;
  }
}

function listTopFiles(root, dir, re) {
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
    else if (CODE_EXT.test(n)) out.push(p);
  }
  return out;
}

async function graph(root, entries, platform) {
  const res = await esbuild.build({
    absWorkingDir: root,
    entryPoints: entries,
    bundle: true, write: false, metafile: true, logLevel: 'silent',
    // Several entry points need an outdir even with write:false; nothing is written.
    outdir: join(root, '.shadow-isolation-out'),
    platform, format: 'esm', packages: 'external',
    loader: { '.js': 'jsx' }, jsx: 'transform', tsconfigRaw: TSCONFIG,
  });
  const files = new Map();
  for (const [p, info] of Object.entries(res.metafile.inputs)) files.set(toPosix(p), info.imports || []);
  return files;
}

function hostsIn(code) {
  return [...code.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1].toLowerCase());
}

/** import(x) / require(x) whose argument is not a plain string literal. */
function nonLiteralDynamic(code) {
  return [...code.matchAll(/\b(import|require)\s*\(\s*([^)]*?)\s*\)/g)]
    .filter((m) => !/^(["'])[^"'$`]*\1$|^`[^`$]*`$/.test(m[2])).map((m) => m[0].slice(0, 80));
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
  return spec.split('/')[0];
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
    if (kind === 'export' && /^\*/.test(clause)) star = true;
    const def = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[\w$]+/, '').replace(/^\*$/, '').replace(/,/g, ' ').trim();
    if (kind === 'import' && def) defaultName = def;
    out.push({ kind, source, named, namespace, defaultName, star });
  }
  // Side-effect imports (`import "./x"`) carry no bindings but still load a module.
  for (const m of code.matchAll(/(?:^|[;\n}])\s*import\s*["']([^"']+)["']/g)) out.push({ kind: 'import', source: m[1], named: [], namespace: false, defaultName: null, star: false, bare: true });
  return out;
}

/** The names in esbuild's trailing `export { a, b as c }` list(s), as [local, exported] pairs. */
function exportListOf(code) {
  const pairs = [];
  for (const m of code.matchAll(/(?:^|[;\n}])\s*export\s*\{([^}]*)\}\s*(?!from)/g)) {
    for (const part of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const [local, exported] = part.split(/\s+as\s+/).map((s) => s.trim());
      pairs.push([local, exported || local]);
    }
  }
  return pairs;
}

function resolveLocal(fromFile, spec) {
  return posix.normalize(posix.join(posix.dirname(fromFile), spec));
}
function sameModule(a, b) {
  const strip = (p) => p.replace(/\.(mts|cts|ts|tsx|mjs|cjs|js|jsx)$/, '');
  return a === b || strip(a) === strip(b);
}
function sharedKey(target) {
  return Object.keys(SHARED_IMPORTS).find((k) => sameModule(target, k)) || null;
}

function isOwnedPath(p) {
  if (p.startsWith(`${LAYOUT.libDir}/`) || /^claude-shadow/.test(posix.basename(p))) return true;
  // A directory-form function (netlify/functions/claude-shadow-x/…) is shadow code throughout.
  const rel = p.startsWith(`${LAYOUT.functionsDir}/`) ? p.slice(LAYOUT.functionsDir.length + 1) : null;
  return !!rel && rel.includes('/') && LAYOUT.functionDirRe.test(rel.split('/')[0]);
}

/** Directory-form entries: netlify/functions/claude-shadow-x/{claude-shadow-x,index}.{ext} */
function directoryEntries(root) {
  const abs = join(root, LAYOUT.functionsDir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const n of readdirSync(abs)) {
    if (!LAYOUT.functionDirRe.test(n) || !statSync(join(abs, n)).isDirectory()) continue;
    for (const f of readdirSync(join(abs, n))) {
      if (new RegExp(`^(?:${n}|index)\\.(mts|cts|ts|mjs|cjs|js)$`).test(f)) out.push(posix.join(LAYOUT.functionsDir, n, f));
    }
  }
  return out;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function checkShadowIsolation(root = DEFAULT_ROOT) {
  const violations = [];
  const v = (rule, file, detail) => violations.push({ rule, file, detail });

  // ── entry points ──
  const serverEntries = [...listTopFiles(root, LAYOUT.functionsDir, LAYOUT.functionRe), ...directoryEntries(root)];
  const browserEntries = walkDir(root, LAYOUT.screenDir).filter((f) => /\.(js|jsx|mjs|ts|tsx)$/.test(f));
  if (serverEntries.length === 0) v('empty', LAYOUT.functionsDir, 'no claude-shadow* function found — a guard that checks nothing passes, so this is a failure');
  if (browserEntries.length === 0) v('empty', LAYOUT.screenDir, 'no shadow screen found — a guard that checks nothing passes, so this is a failure');

  // Rule 7: nothing outside the shadow's own files may import the shadow lib — not a function by
  // another name, and not a lib/ module a function by another name could import in turn.
  for (const f of walkDir(root, LAYOUT.netlifyDir)) {
    if (isOwnedPath(f) || serverEntries.includes(f)) continue;
    const code = await stripped(root, f);
    const hit = importsOf(code).some((i) => /(^|\/)claude-shadow(\/|$)/.test(i.source)) || /\b(?:import|require)\s*\(\s*["'`][^"'`]*claude-shadow\//.test(code);
    if (hit) v('entry-name', f, 'imports lib/claude-shadow but is not shadow code, so the guard would not walk the code around it — only claude-shadow* functions and lib/claude-shadow/* may import it');
  }

  // ── server graph ──
  const serverFiles = [];
  const owned = new Set([...serverEntries, ...walkDir(root, LAYOUT.libDir)]);
  if (serverEntries.length) {
    let files = null;
    try { files = await graph(root, serverEntries, 'node'); }
    catch (e) { v('build', serverEntries.join(', '), `esbuild could not walk the server graph: ${e?.message || e}`); }
    for (const [file, imports] of files || []) {
      serverFiles.push(file);
      if (isOwnedPath(file)) owned.add(file);
      else if (!(file in REVIEWED_SHARED)) v('unreviewed-module', file, 'the shadow server graph reaches a module that is not shadow code and not on REVIEWED_SHARED — add it there with the reason it cannot call NuVizz or write for the shadow, or do not import it');
      if (/^nuvizz/i.test(posix.basename(file))) v('nuvizz-module', file, 'a NuVizz module is reachable from a shadow entry point');
      for (const imp of imports) {
        if (!imp.external) continue;
        const spec = imp.path;
        if (spec.startsWith('.') || spec.startsWith('/')) v('unresolved', file, `local import ${spec} could not be resolved, so the graph is not complete`);
        else if (!BUILTINS.has(spec)) v('package', file, `npm package "${spec}" is reachable; only node: builtins are allowed on the shadow's server path`);
        else if (!(REVIEWED_BUILTINS[file] || []).includes(normBuiltin(spec))) v('builtin', file, `imports ${spec}; ${isOwnedPath(file) ? 'shadow files import no builtins' : `this reviewed module may import only ${(REVIEWED_BUILTINS[file] || []).join(', ') || 'no builtins'}`}`);
      }
      const code = applyExemptions(file, await stripped(root, file), violations);
      if (!isOwnedPath(file)) {
        if (ESCAPE_HATCHES.test(code)) v('escape-hatch', file, 'a reviewed shared module names createRequire / getBuiltinModule / process.binding / _http_ / _tls_ / WebAssembly / Worker');
        if (SITE_FUNCTION_PATH.test(code)) v('site-function', file, "a reviewed shared module names the site's own function paths");
      }
      const env = code.match(/\bNUVIZZ_[A-Z0-9_]*/g);
      if (env) v('nuvizz-env', file, `names ${[...new Set(env)].join(', ')}`);
      if (/nuvizz\\?\.com/i.test(code)) v('nuvizz-host', file, 'names a nuvizz.com host');
      const bad = [...new Set(hostsIn(code).filter((h) => !SERVER_HOSTS.includes(h)))];
      if (bad.length) v('host', file, `names ${bad.join(', ')} — the shadow's server path may reach only ${SERVER_HOSTS.join(', ')}`);
      const dyn = nonLiteralDynamic(code);
      if (dyn.length) v('dynamic', file, `import/require with a non-literal argument (${dyn[0]}) — the graph cannot be followed past it`);
    }
  }

  // ── shadow-owned server files: the door, the gateway, the import allowlist ──
  for (const file of [...owned].sort()) {
    const code = await stripped(root, file);
    const isStore = file === LAYOUT.store;
    const isDoor = file === LAYOUT.door;

    if (file === LAYOUT.egress) {
      // Rule 6: the lock is the one shadow file that must touch globalThis.fetch. It is held to its
      // reviewed text instead of the token rules, and may import nothing at all.
      const got = sha256(code);
      if (got !== EGRESS_SHA256) v('egress', file, `the runtime egress lock changed (sha256 ${got}). Re-read the whole file, then set EGRESS_SHA256 in scripts/check-shadow-isolation.mjs to that value.`);
      if (importsOf(code).length) v('egress', file, 'the egress lock imports something; it must stand alone');
      continue;
    }

    for (const [re, what] of OWNED_FORBIDDEN) {
      if (re.test(code)) v('owned-forbidden', file, `names ${what}`);
    }
    // Rule 6: every entry locks egress as the FIRST statement of its default handler.
    if (serverEntries.includes(file)) {
      const importsLock = importsOf(code).some((i) => sameModule(resolveLocal(file, i.source), LAYOUT.egress) && i.named.includes('lockEgress'));
      const def = code.match(/export\s*\{[^}]*?\b([\w$]+)\s+as\s+default\b/);
      const name = def ? def[1] : null;
      const first = name && (new RegExp(`\\b${name.replace('$', '\\$')}\\s*=\\s*async\\s*(?:function\\s*[\\w$]*\\s*)?\\([^)]*\\)\\s*(?:=>\\s*)?\\{\\s*lockEgress\\(\\);`).test(code)
        || new RegExp(`async\\s+function\\s+${name.replace('$', '\\$')}\\s*\\([^)]*\\)\\s*\\{\\s*lockEgress\\(\\);`).test(code));
      if (!importsLock || !first) v('egress', file, 'a shadow function must import lockEgress from lib/claude-shadow/egress.mts and call lockEgress(); as the FIRST statement of its default handler');
      // …and import it FIRST, so the lock (installed at import) is in place before any other
      // module's top-level code runs.
      const firstImport = code.match(/(?:^|[;\n])\s*import\b[^;]*?["']([^"']+)["']/);
      if (!firstImport || !sameModule(resolveLocal(file, firstImport[1]), LAYOUT.egress)) v('egress', file, "lib/claude-shadow/egress.mts must be this function's FIRST import — it locks egress at import time, before any other module runs");
    }
    // Rule 3: the one door to the network.
    const fetches = (code.match(/\bfetch\b/g) || []).length;
    if (isDoor) {
      const bind = code.match(/\bconst\s+([\w$]+)\s*=\s*opts\.fetchImpl\s*\|\|\s*fetch\s*;/);
      const decl = new RegExp(`\\bconst\\s+MESSAGES_URL\\s*=\\s*"${MESSAGES_URL_LITERAL.replace(/[./]/g, '\\$&')}"\\s*;`);
      if (fetches !== 1 || !bind) v('door', file, 'the network door must name fetch exactly once, as `const f = opts.fetchImpl || fetch;`');
      if (!decl.test(code)) v('door', file, `MESSAGES_URL must be declared \`const MESSAGES_URL = "${MESSAGES_URL_LITERAL}"\``);
      const uses = (code.match(/\bMESSAGES_URL\b/g) || []).length;
      const allowed = 1 + (code.match(/\b[\w$]+\s*\(\s*MESSAGES_URL\s*,/g) || []).length + (exportListOf(code).some(([l]) => l === 'MESSAGES_URL') ? 1 : 0);
      if (uses !== allowed) v('door', file, 'MESSAGES_URL is used other than in its const declaration, the door call and the export list — it cannot be reassigned or passed on');
      if (bind) {
        const calls = [...code.matchAll(new RegExp(`\\b${bind[1].replace('$', '\\$')}\\s*\\(\\s*([^,)]*)`, 'g'))];
        if (!calls.length || calls.some((c) => c[1].trim() !== 'MESSAGES_URL')) v('door', file, `every call through ${bind[1]}() must be ${bind[1]}(MESSAGES_URL, …)`);
        const uses = (code.match(new RegExp(`\\b${bind[1].replace('$', '\\$')}\\b`, 'g')) || []).length;
        if (uses !== calls.length + 1) v('door', file, `${bind[1]} is used other than as ${bind[1]}(MESSAGES_URL, …)`);
      }
    } else if (fetches) {
      v('network', file, `names fetch — only ${LAYOUT.door} may reach the network`);
    }

    const imps = importsOf(code);
    for (const imp of imps) {
      const rel = imp.source.startsWith('.');
      if (!rel && !BUILTINS.has(imp.source)) { v('import', file, `non-relative import "${imp.source}" — shadow files import local files by relative path only (no aliases, no packages)`); continue; }
      if (!rel) { v('builtin', file, `imports ${imp.source} — shadow files import no builtins`); continue; }
      const target = resolveLocal(file, imp.source);
      if (imp.star) v('import', file, `export * from ${imp.source} — re-exports nothing it cannot name`);
      if (imp.namespace) v('import', file, `namespace import of ${imp.source} — name the bindings so the allowlist can see them`);
      if (imp.defaultName && !isOwnedPath(target)) v('import', file, `default import from ${imp.source} — name the bindings so the allowlist can see them`);

      if (isStore) {
        const fs = sameModule(target, 'netlify/functions/lib/firestore.mts');
        const cfg = sameModule(target, `${LAYOUT.libDir}/config.mts`);
        if (imp.kind === 'export') v('store', file, `store.mts re-exports from ${imp.source}`);
        else if (!fs && !cfg) v('store', file, `store.mts may import only ../firestore.mts and ./config.mts, not ${imp.source}`);
        else if (fs) for (const n of imp.named) if (!STORE_FIRESTORE_IMPORTS.includes(n)) v('store', file, `store.mts imports ${n} from firestore.mts — only ${STORE_FIRESTORE_IMPORTS.join(', ')}`);
        continue;
      }
      if (sameModule(target, LAYOUT.store)) {
        for (const n of imp.named) if (!STORE_EXPORT_RE.test(n)) v('gateway', file, `imports ${n} from store.mts — only shadow* writers, assertShadowPath and ShadowPathError`);
        continue;
      }
      if (isOwnedPath(target)) continue; // other shadow files are checked in their own right
      const key = sharedKey(target);
      if (!key) { v('shared-import', file, `imports ${target}, which is not in SHARED_IMPORTS — add it with the exact bindings and the reason they cannot write for the shadow`); continue; }
      if (imp.kind === 'export') v('gateway', file, `re-exports from ${imp.source} — shadow files do not re-export shared modules`);
      for (const n of imp.named) {
        if (!SHARED_IMPORTS[key].includes(n)) v('shared-import', file, `imports ${n} from ${key}, which is not one of its allowed bindings (${SHARED_IMPORTS[key].join(', ')})`);
        else if (WRITE_RE.test(n)) v('gateway', file, `imports writer "${n}" from ${key}`);
      }
    }

    if (isStore) {
      // Rule 4: exports are shadow* / assertShadowPath / ShadowPathError, and never an import.
      if (/(?:^|[;\n}])\s*export\s+default\b/.test(code)) v('store', file, 'store.mts has a default export');
      if (/(?:^|[;\n}])\s*export\s+(?:const|let|var)\b/.test(code)) v('store', file, 'store.mts exports a variable — export functions only');
      const imported = new Set(imps.flatMap((i) => i.named));
      for (const [local, exported] of exportListOf(code)) {
        if (!STORE_EXPORT_RE.test(exported)) v('store', file, `store.mts exports "${exported}" — only shadow*, assertShadowPath and ShadowPathError`);
        if (imported.has(local)) v('store', file, `store.mts re-exports its import "${local}" as "${exported}"`);
      }
      // Every use of a writer is `writer(assertShadowPath(`, and nothing else touches it.
      for (const w of STORE_WRITERS) {
        const all = (code.match(new RegExp(`\\b${w}\\b`, 'g')) || []).length;
        // EXACTLY writer(assertShadowPath(<name>) , …) — a checked path that is then extended or
        // rewritten (`.replace(…)`, `+ '/…'`) does not count as checked.
        const guarded = (code.match(new RegExp(`\\b${w}\\(\\s*assertShadowPath\\(\\s*[\\w$]+\\s*\\)\\s*[,)]`, 'g')) || []).length;
        const inImport = imps.some((i) => i.named.includes(w)) ? 1 : 0;
        if (all !== guarded + inImport) v('store', file, `${w} is used other than as ${w}(assertShadowPath(…)) — every write must pass the prefix check`);
      }
      if (!/function\s+assertShadowPath\s*\(/.test(code)) v('store', file, 'store.mts no longer defines assertShadowPath');
    }
  }

  // ── browser graph ──
  const browserFiles = [];
  if (browserEntries.length) {
    let files = null;
    try { files = await graph(root, browserEntries, 'browser'); }
    catch (e) { v('build', browserEntries.join(', '), `esbuild could not walk the browser graph: ${e?.message || e}`); }
    for (const [file, imports] of files || []) {
      browserFiles.push(file);
      const inShadow = file.startsWith(`${LAYOUT.screenDir}/`);
      if (!inShadow && !BROWSER_FILES.includes(file)) v('browser-module', file, `the shadow screen reaches ${file}; it may reach only ${LAYOUT.screenDir}/** and ${BROWSER_FILES.join(', ')}`);
      for (const imp of imports) {
        if (!imp.external) continue;
        if (imp.path.startsWith('.') || imp.path.startsWith('/')) v('unresolved', file, `local import ${imp.path} could not be resolved`);
        else if (!BROWSER_PACKAGES.includes(imp.path)) v('browser-package', file, `package "${imp.path}" — the shadow screen may use only ${BROWSER_PACKAGES.join(', ')}`);
      }
      const code = await stripped(root, file);
      const dyn = nonLiteralDynamic(code);
      if (dyn.length) v('dynamic', file, `import/require with a non-literal argument (${dyn[0]})`);
      if (!inShadow) continue;
      const hosts = [...new Set(hostsIn(code))];
      if (hosts.length) v('browser-host', file, `names ${hosts.join(', ')} — the shadow screen may call only its own function`);
      if (/\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/.test(code)) v('browser-fetch', file, 'names fetch or another network primitive — the screen calls its function through apiFetch only');
      if (/\beval\b|\bFunction\b|\.constructor\b|\bReflect\b|\bProxy\b|\bglobalThis\b|\bglobal\b|\bimport\s*\(|\brequire\s*\(|\bnew\s+Worker\b|\bWebAssembly\b/.test(code)) v('browser-dynamic', file, 'eval / Function / .constructor / Reflect / globalThis / dynamic import / Worker — code or calls the guard cannot read');
      if (/\bdocument\b|\bnavigator\b|\blocation\b|\bself\s*\.|\bparent\s*\.|\btop\s*\.|\bframes\b|\bopener\b|\bpostMessage\b|\bimportScripts\b/.test(code)) v('browser-global', file, 'document / navigator / location / self / parent / top / frames / postMessage — the screen reaches the page only through React');
      const windows = (code.match(/\bwindow\b/g) || []).length;
      const confirms = (code.match(/\bwindow\.confirm\s*\(/g) || []).length;
      if (windows !== confirms) v('browser-global', file, 'window is used other than as window.confirm(…)');
      // JSX attributes (`src=`, not the `action:` key of a JSON body), the elements that load a URL,
      // CSS url(), and the React calls that would build an element the JSX rules cannot see.
      if (/\b(?:src|href|action|formAction|srcSet|poster|data|xlinkHref)\s*=\s*[{"']/.test(code) || /<\s*(?:img|iframe|script|form|object|embed|link|a|video|audio|source|track|image|use)\b/.test(code) || /\burl\s*\(/.test(code) || /\b(?:createElement|cloneElement|dangerouslySetInnerHTML)\b/.test(code)) {
        v('browser-element', file, 'an element or style that loads a URL (src / href / action / <img> / <form> / url()) — the screen fetches only through apiFetch');
      }
      for (const imp of importsOf(code)) {
        if (!sameModule(resolveLocal(file, imp.source), 'src/lib/api.js')) continue;
        if (imp.namespace || imp.defaultName || imp.named.length !== 1 || imp.named[0] !== 'apiFetch' || /\bapiFetch\s+as\b/.test(code)) v('browser-endpoint', file, 'lib/api.js must be imported exactly as `import { apiFetch } from …` — no alias, default or namespace');
      }
      if (/NUVIZZ_|nuvizz\\?\.com/i.test(code)) v('nuvizz-host', file, 'names NuVizz');
      // Every function path named must be the shadow's own, however it is assembled.
      for (const m of code.matchAll(/\/(?:\.netlify\/functions|api)\/([^"'`\s]*)/g)) {
        if (!m[1].startsWith('claude-shadow') || m[1].includes('${')) v('browser-endpoint', file, `names /${m[0].slice(1, 60)} — the shadow screen may call only claude-shadow*`);
      }
      // Every apiFetch() goes to a constant that IS the literal claude-shadow path.
      const consts = new Map([...code.matchAll(/\bconst\s+([\w$]+)\s*=\s*(["'])([^"'`]*)\2\s*;/g)].map((m) => [m[1], m[3]]));
      const calls = [...code.matchAll(/\bapiFetch\s*\(\s*([^,)]*)/g)];
      for (const c of calls) {
        const arg = c[1].trim();
        const lit = arg.match(/^(["'])([^"'`]*)\1$/);
        const url = lit ? lit[2] : consts.get(arg);
        if (!url || !url.startsWith(SCREEN_ENDPOINT_PREFIX)) v('browser-endpoint', file, `apiFetch(${arg.slice(0, 40)}) is not a literal claude-shadow path`);
      }
      const uses = (code.match(/\bapiFetch\b/g) || []).length;
      const importsApi = importsOf(code).some((i) => i.named.includes('apiFetch')) ? 1 : 0;
      if (uses !== calls.length + importsApi) v('browser-endpoint', file, 'apiFetch is used other than as a direct call — it cannot be passed around');
    }
  }

  return { ok: violations.length === 0, violations, serverEntries, browserEntries, owned: [...owned].sort(), serverFiles: serverFiles.sort(), browserFiles: browserFiles.sort() };
}

async function main() {
  const root = resolve(process.argv[2] || DEFAULT_ROOT);
  const r = await checkShadowIsolation(root);
  console.log(`shadow isolation — ${r.serverEntries.length} server entr${r.serverEntries.length === 1 ? 'y' : 'ies'}, ${r.browserEntries.length} browser entr${r.browserEntries.length === 1 ? 'y' : 'ies'}`);
  console.log(`  server graph (${r.serverFiles.length} modules): ${r.serverFiles.join(', ')}`);
  console.log(`  shadow-owned (${r.owned.length}): ${r.owned.join(', ')}`);
  console.log(`  browser graph (${r.browserFiles.length} modules): ${r.browserFiles.join(', ')}`);
  if (r.ok) { console.log('OK — the Claude shadow planner reaches only reviewed modules, one network door (the Messages API) and one write gateway (claude_shadow_*).'); return; }
  console.error(`\nFAIL — ${r.violations.length} violation(s):`);
  for (const x of r.violations) console.error(`  [${x.rule}] ${x.file}: ${x.detail}`);
  console.error('\nThe shadow planner must never call NuVizz or write outside claude_shadow_*. Fix the code; do not weaken this guard.');
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
