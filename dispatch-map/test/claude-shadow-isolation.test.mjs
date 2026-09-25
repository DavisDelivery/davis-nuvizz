// test/claude-shadow-isolation.test.mjs — THE GUARD THAT KEEPS THE SHADOW PLANNER OFF NUVIZZ,
// SEEN TO FAIL.
//
// A guard that has only ever been seen passing proves nothing: it might check nothing at all.
// So every rule in scripts/check-shadow-isolation.mjs is broken here, one at a time, on a small
// throwaway tree that starts out clean — and the real repo is checked last.
//
// THE SECOND HALF OF THIS FILE IS THE ADVERSARIAL REVIEW, KEPT. The first version of the guard
// was a denylist and a review found eighteen ways past it; each one it reproduced is a test
// below, so the allowlist that replaced it is held to every bypass that beat the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { checkShadowIsolation, DEFAULT_ROOT } from '../scripts/check-shadow-isolation.mjs';

// The fixture carries the REAL egress lock, byte for byte: the guard pins its hash.
const EGRESS = readFileSync(join(DEFAULT_ROOT, 'netlify/functions/lib/claude-shadow/egress.mts'), 'utf8');

const STORE = `
  import { setDoc, deleteDoc } from '../firestore.mts';
  export class ShadowPathError extends Error {}
  export function assertShadowPath(p: string) { if (!p.startsWith('claude_shadow_')) throw new ShadowPathError('refused'); return p; }
  export async function shadowSet(p: string, d: any) { return setDoc(assertShadowPath(p), d); }
  export async function shadowDelete(p: string) { return deleteDoc(assertShadowPath(p)); }
`;

const CLEAN = {
  'netlify/functions/claude-shadow-fixture.mts': `
    import { lockEgress } from './lib/claude-shadow/egress.mts';
    import { getDoc } from './lib/firestore.mts';
    import { requireUser } from './lib/require-user.mts';
    import { shadowSet } from './lib/claude-shadow/store.mts';
    import { plan } from './lib/claude-shadow/plan.mts';
    import { callMessages } from './lib/claude-shadow/anthropic.mts';
    export default async (req: Request) => {
      lockEgress();
      await requireUser(req); await getDoc('x/y'); await shadowSet('claude_shadow_x/y', plan()); return callMessages({}, {});
    };
  `,
  'netlify/functions/lib/claude-shadow/egress.mts': EGRESS,
  'netlify/functions/lib/claude-shadow/plan.mts': `
    // A comment that mentions https://portal.nuvizz.com, NUVIZZ_DAVIS_USER, fetch() and
    // /.netlify/functions/nuvizz-manual-scan is prose, not a call.
    export function plan() { return { loads: [] }; }
  `,
  'netlify/functions/lib/claude-shadow/anthropic.mts': `
    export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
    export async function callMessages(request: any, opts: { fetchImpl?: typeof fetch }) {
      const f = opts.fetchImpl || fetch;
      return f(MESSAGES_URL, { method: 'POST', body: JSON.stringify(request) });
    }
  `,
  'netlify/functions/lib/claude-shadow/store.mts': STORE,
  'netlify/functions/lib/firestore.mts': `
    const BASE = 'https://firestore.googleapis.com/v1';
    export function uatMisconfigured(): boolean {
      return /uat\\.nuvizz\\.com/i.test(String(process.env.NUVIZZ_BASE_URL || ''));
    }
    export async function getAccessToken() { return 'tok'; }
    export async function getDoc(p: string) { return fetch(BASE + '/' + p); }
    export async function setDoc(p: string, d: any) { return fetch(BASE + '/' + p, { method: 'PATCH', body: JSON.stringify(d) }); }
    export async function deleteDoc(p: string) { return fetch(BASE + '/' + p, { method: 'DELETE' }); }
  `,
  'netlify/functions/lib/require-user.mts': `export async function requireUser(req: Request) { return { ok: true }; }`,
  'src/lib/api.js': `export async function apiFetch(u, i) { return fetch(u, i); }`,
  'src/lib/session.js': `export const sessionToken = () => null;`,
  'src/shadow/Screen.jsx': `
    import React from 'react';
    import { apiFetch } from '../lib/api.js';
    const ENDPOINT = '/.netlify/functions/claude-shadow';
    export default function Screen() { apiFetch(ENDPOINT); apiFetch(ENDPOINT, { method: 'POST' }); return <div />; }
  `,
};

async function check(overrides = {}, remove = []) {
  const root = mkdtempSync(join(tmpdir(), 'shadow-iso-'));
  try {
    const files = { ...CLEAN, ...overrides };
    for (const r of remove) delete files[r];
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(root, dirname(p)), { recursive: true });
      writeFileSync(join(root, p), body);
    }
    return await checkShadowIsolation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const rules = (r) => [...new Set(r.violations.map((v) => v.rule))].sort();
const has = (r, rule) => r.violations.some((v) => v.rule === rule);
const PLAN = 'netlify/functions/lib/claude-shadow/plan.mts';
const ENTRY = 'netlify/functions/claude-shadow-fixture.mts';
const SCREEN = 'src/shadow/Screen.jsx';

// ── the clean tree ────────────────────────────────────────────────────────────

test('the clean tree passes — and a comment naming NuVizz, fetch and a function path is prose, not a call', async () => {
  const r = await check();
  assert.deepEqual(r.violations, []);
  assert.ok(r.serverFiles.includes('netlify/functions/lib/firestore.mts'), 'the graph really was walked into the Firestore module');
});

test('two shadow functions and two screen files are checked together — the next PRs add both', async () => {
  const r = await check({
    'netlify/functions/claude-shadow-second.mts': `import { lockEgress } from './lib/claude-shadow/egress.mts'; import { plan } from './lib/claude-shadow/plan.mts'; export default async () => { lockEgress(); return plan(); };`,
    'src/shadow/Other.jsx': `import React from 'react'; export default function O() { return <span />; }`,
  });
  assert.deepEqual(r.violations, []);
  assert.equal(r.serverEntries.length, 2);
  assert.equal(r.browserEntries.length, 2);
});

// ── NuVizz ────────────────────────────────────────────────────────────────────

test('a shadow file that imports the NuVizz requester FAILS — the planner must never reach the vendor', async () => {
  const r = await check({
    'netlify/functions/lib/nuvizz-request.mts': `export async function nuvizzGet() { return fetch('https://portal.nuvizz.com/api?u=' + process.env.NUVIZZ_DAVIS_USER); }`,
    [PLAN]: `import { nuvizzGet } from '../nuvizz-request.mts'; export function plan() { nuvizzGet(); return {}; }`,
  });
  for (const rule of ['nuvizz-module', 'nuvizz-env', 'nuvizz-host', 'host', 'unreviewed-module', 'shared-import']) assert.ok(has(r, rule), `expected ${rule}, got ${rules(r)}`);
});

test('a module NOT named nuvizz that reads a NUVIZZ_ switch two imports away FAILS — unreviewed, and read for what it names', async () => {
  const r = await check({
    'netlify/functions/lib/scan-gate.mts': `export const scansOn = () => process.env.NUVIZZ_SCANS_ENABLED === 'true';`,
    'netlify/functions/lib/helper.mts': `import { scansOn } from './scan-gate.mts'; export const h = () => scansOn();`,
    [PLAN]: `import { h } from '../helper.mts'; export function plan() { return { on: h() }; }`,
  });
  assert.ok(has(r, 'nuvizz-env') && has(r, 'unreviewed-module') && has(r, 'shared-import'), rules(r).join());
});

test('REVIEW: calling the site\'s own nuvizz-manual-scan over HTTP from shadow server code FAILS (≈3,000 NuVizz calls)', async () => {
  const viaReq = await check({ [ENTRY]: `export default async (req: Request) => fetch(new URL('/.netlify/functions/nuvizz-manual-scan?date=2026-09-25', req.url), { method: 'POST' });` });
  assert.ok(has(viaReq, 'network') && has(viaReq, 'owned-forbidden'), rules(viaReq).join());
  const viaEnv = await check({ [ENTRY]: `export default async () => fetch(process.env.URL + '/api/nuvizz-refresh-stops-background?days=3&manual=1');` });
  assert.ok(has(viaEnv, 'network') && has(viaEnv, 'owned-forbidden'), rules(viaEnv).join());
});

// ── the network door ──────────────────────────────────────────────────────────

test('REVIEW: a host assembled from pieces, or node:https, FAILS — only the door may reach the network', async () => {
  const pieces = await check({ [PLAN]: `const H = 'https:' + '//' + 'evil.example'; export function plan() { fetch(H); return {}; }` });
  assert.ok(has(pieces, 'network'), rules(pieces).join());
  const https = await check({ [PLAN]: `import https from 'node:https'; export function plan() { https.get('x'); return {}; }` });
  assert.ok(has(https, 'builtin'), rules(https).join());
  const glob = await check({ [PLAN]: `export function plan() { return (globalThis as any)['fe' + 'tch']('x'); }` });
  assert.ok(has(glob, 'owned-forbidden'), rules(glob).join());
});

test('THE DOOR: anthropic.mts may call only f(MESSAGES_URL, …), and MESSAGES_URL must be the Messages API', async () => {
  const other = await check({ 'netlify/functions/lib/claude-shadow/anthropic.mts': CLEAN['netlify/functions/lib/claude-shadow/anthropic.mts'].replace('f(MESSAGES_URL,', "f('https://api.anthropic.com/v1/files',") });
  assert.ok(has(other, 'door'), rules(other).join());
  const url = await check({ 'netlify/functions/lib/claude-shadow/anthropic.mts': CLEAN['netlify/functions/lib/claude-shadow/anthropic.mts'].replace('https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/files') });
  assert.ok(has(url, 'door'), rules(url).join());
  const leak = await check({ 'netlify/functions/lib/claude-shadow/anthropic.mts': CLEAN['netlify/functions/lib/claude-shadow/anthropic.mts'] + `\nexport const raw = (u: string) => fetch(u);` });
  assert.ok(has(leak, 'door'), rules(leak).join());
});

test('an npm package on the shadow server path FAILS — a package can fetch anything', async () => {
  const r = await check({ [PLAN]: `import { getStore } from '@netlify/blobs'; export function plan() { return getStore('x'); }` });
  assert.ok(has(r, 'package') && has(r, 'import'), rules(r).join());
});

// ── the write gateway ─────────────────────────────────────────────────────────

test('THE GATEWAY: importing setDoc from firestore.mts FAILS, renamed or not — shadow writes go through store.mts', async () => {
  for (const imp of ['setDoc', 'setDoc as save', 'setDoc as keep']) {
    const r = await check({ [PLAN]: `import { ${imp} } from '../firestore.mts'; export function plan() { return {}; }` });
    assert.ok(has(r, 'shared-import'), `${imp}: ${rules(r)}`);
  }
});

test('REVIEW: raw Firestore through getAccessToken and the REST host FAILS — the only way to Firestore is its read helpers and the store', async () => {
  const r = await check({ [PLAN]: `import { getAccessToken } from '../firestore.mts'; export async function plan() { const t = await getAccessToken(); return { t, url: 'https://firestore.googleapis.com/v1/x' }; }` });
  assert.ok(has(r, 'shared-import') && has(r, 'owned-forbidden'), rules(r).join());
});

test('REVIEW: store.mts is checked too — exporting or re-exporting a raw writer FAILS', async () => {
  const exp = await check({ 'netlify/functions/lib/claude-shadow/store.mts': STORE + `\nexport { setDoc as shadowRaw };` });
  assert.ok(has(exp, 'store'), rules(exp).join());
  const re = await check({ 'netlify/functions/lib/claude-shadow/store.mts': STORE + `\nexport { updateDocFields as shadowPatch } from '../firestore.mts';` });
  assert.ok(has(re, 'store'), rules(re).join());
});

test('REVIEW: a store writer that skips the prefix check FAILS — every write is writer(assertShadowPath(…))', async () => {
  const r = await check({ 'netlify/functions/lib/claude-shadow/store.mts': STORE.replace('setDoc(assertShadowPath(p), d)', 'setDoc(p, d)') });
  assert.ok(has(r, 'store'), rules(r).join());
  const alias = await check({ 'netlify/functions/lib/claude-shadow/store.mts': STORE + `\nconst w = setDoc; export async function shadowAny(p: string) { return w(p, {}); }` });
  assert.ok(has(alias, 'store'), rules(alias).join());
});

test('REVIEW: a claude-shadow file OUTSIDE lib/claude-shadow, or a .cjs inside it, is still shadow code and still checked', async () => {
  const outside = await check({
    'netlify/functions/lib/claude-shadow-helper.mts': `export { setDoc as keep } from './firestore.mts';`,
    [PLAN]: `import { keep } from '../claude-shadow-helper.mts'; export function plan() { keep('att_plan/x', {}); return {}; }`,
  });
  assert.ok(has(outside, 'shared-import'), rules(outside).join());
  const cjs = await check({ 'netlify/functions/lib/claude-shadow/raw.cjs': `const fs = require('../firestore.mts'); module.exports = fs.setDoc;` });
  assert.ok(has(cjs, 'owned-forbidden'), rules(cjs).join());
});

test('REVIEW: an import alias (package.json "imports" / tsconfig paths) FAILS — shadow files import by relative path only', async () => {
  const r = await check({
    'package.json': JSON.stringify({ name: 'fx', imports: { '#fs': './netlify/functions/lib/firestore.mts' } }),
    [PLAN]: `import * as fs from '#fs'; export function plan() { return fs; }`,
  });
  assert.ok(has(r, 'import'), rules(r).join());
});

test('REVIEW: a function by another name that imports the shadow lib FAILS — it would escape the walk', async () => {
  const r = await check({ 'netlify/functions/nightly-helper.mts': `import { plan } from './lib/claude-shadow/plan.mts'; import { nuvizzGet } from './lib/nuvizz-request.mts'; export default async () => [plan(), nuvizzGet()];` });
  assert.ok(has(r, 'entry-name'), rules(r).join());
});

test('REVIEW: a dynamic import with a non-literal argument FAILS anywhere in the graph — the walk cannot follow it', async () => {
  const shared = await check({ 'netlify/functions/lib/require-user.mts': `export async function requireUser(req: Request) { const m = 'x'; await import('./' + m + '.mts'); return { ok: true }; }` });
  assert.ok(has(shared, 'dynamic'), rules(shared).join());
  const owned = await check({ [PLAN]: `export async function plan() { const m = await import('../firestore.mts'); return m; }` });
  assert.ok(has(owned, 'owned-forbidden'), rules(owned).join());
});

// ── the exemption ─────────────────────────────────────────────────────────────

test('the reviewed exemption covers exactly one expression: a SECOND NuVizz reference in firestore.mts FAILS', async () => {
  const r = await check({ 'netlify/functions/lib/firestore.mts': CLEAN['netlify/functions/lib/firestore.mts'] + `\nexport const base = () => process.env.NUVIZZ_BASE;` });
  assert.deepEqual(rules(r), ['nuvizz-env']);
});

test('the exemption cannot go stale silently: if its expression changes, the build fails until a person looks', async () => {
  const r = await check({ 'netlify/functions/lib/firestore.mts': CLEAN['netlify/functions/lib/firestore.mts'].replace(/export function uatMisconfigured[\s\S]*?\n    \}\n/, '') });
  assert.deepEqual(rules(r), ['exemption']);
});

// ── the screen ────────────────────────────────────────────────────────────────

test('THE SCREEN: importing Route Workbench / Build Panel code FAILS', async () => {
  const r = await check({
    'src/lib/routing-select.js': `export const pick = () => 1;`,
    [SCREEN]: `import React from 'react'; import { pick } from '../lib/routing-select.js'; export default function S() { return <div>{pick()}</div>; }`,
  });
  assert.deepEqual(rules(r), ['browser-module']);
});

test('THE SCREEN: a literal call to any function but claude-shadow FAILS — it has no send, save or stage', async () => {
  const r = await check({ [SCREEN]: `import React from 'react'; import { apiFetch } from '../lib/api.js'; export default function S() { apiFetch('/.netlify/functions/nuvizz-write', { method: 'POST' }); return <div />; }` });
  assert.ok(has(r, 'browser-endpoint'), rules(r).join());
});

test('REVIEW: a function path ASSEMBLED at run time FAILS — template or concatenation', async () => {
  const tpl = await check({ [SCREEN]: "import React from 'react'; import { apiFetch } from '../lib/api.js'; export default function S({ n }) { apiFetch(`/.netlify/functions/${n}`); return <div />; }" });
  assert.ok(has(tpl, 'browser-endpoint'), rules(tpl).join());
  const cat = await check({ [SCREEN]: `import React from 'react'; import { apiFetch } from '../lib/api.js'; export default function S({ n }) { apiFetch('/api/' + n); return <div />; }` });
  assert.ok(has(cat, 'browser-endpoint'), rules(cat).join());
  const pass = await check({ [SCREEN]: `import React from 'react'; import { apiFetch } from '../lib/api.js'; const g = apiFetch; export default function S() { g('/x'); return <div />; }` });
  assert.ok(has(pass, 'browser-endpoint'), rules(pass).join());
});

test('THE SCREEN: the Firestore client, a bare fetch, or a foreign host all FAIL', async () => {
  const fb = await check({ [SCREEN]: `import React from 'react'; import { getDoc } from 'firebase/firestore'; export default function S() { getDoc(); return <div />; }` });
  assert.ok(has(fb, 'browser-package'), rules(fb).join());
  const bare = await check({ [SCREEN]: `import React from 'react'; export default function S() { fetch('/.netlify/functions/claude-shadow'); return <div />; }` });
  assert.ok(has(bare, 'browser-fetch'), rules(bare).join());
  const host = await check({ [SCREEN]: `import React from 'react'; import { apiFetch } from '../lib/api.js'; export default function S() { apiFetch('https://portal.nuvizz.com/x'); return <div />; }` });
  assert.ok(has(host, 'browser-host'), rules(host).join());
});

test('a guard with nothing to check FAILS rather than passing', async () => {
  const r = await check({}, [ENTRY, SCREEN]);
  assert.deepEqual(rules(r), ['empty']);
  assert.equal(r.violations.length, 2);
});

// ── ROUND TWO: the review of the allowlist, kept ─────────────────────────────

test('REVIEW 2: fetch reached without naming it — global[...], indirect eval, Reflect, .constructor — FAILS', async () => {
  for (const body of [
    "const g: any = global; g[['fe','tch'].join('')]('https://x.invalid');",
    "(0, eval)(['fe','tch'].join(''));",
    "Reflect.construct(Object, []);",
    "(() => 0).constructor('return 1')();",
  ]) {
    const r = await check({ [PLAN]: `export function plan() { ${body} return {}; }` });
    assert.ok(has(r, 'owned-forbidden'), `${body}: ${rules(r)}`);
  }
});

test('REVIEW 2: the network without fetch — createRequire, getBuiltinModule, _http_client, any builtin — FAILS', async () => {
  const cr = await check({ [PLAN]: `import { createRequire } from 'node:module'; export function plan() { return createRequire; }` });
  assert.ok(has(cr, 'builtin') && has(cr, 'owned-forbidden'), rules(cr).join());
  const gb = await check({ [PLAN]: `export function plan() { return process.getBuiltinModule(['node:ht','tps'].join('')); }` });
  assert.ok(has(gb, 'owned-forbidden'), rules(gb).join());
  const hc = await check({ [PLAN]: `import { ClientRequest } from '_http_client'; export function plan() { return ClientRequest; }` });
  assert.ok(has(hc, 'builtin') || has(hc, 'import'), rules(hc).join());
});

test('REVIEW 2: a store writer whose checked path is then rewritten FAILS — writer(assertShadowPath(p).replace(…)) is not checked', async () => {
  const rep = await check({ 'netlify/functions/lib/claude-shadow/store.mts': STORE.replace('setDoc(assertShadowPath(p), d)', "setDoc(assertShadowPath(p).replace('claude_shadow_x', 'att_plan'), d)") });
  assert.ok(has(rep, 'store'), rules(rep).join());
  const cat = await check({ 'netlify/functions/lib/claude-shadow/store.mts': STORE.replace('setDoc(assertShadowPath(p), d)', "setDoc(assertShadowPath(p) + '/../../att_plan/x', d)") });
  assert.ok(has(cat, 'store'), rules(cat).join());
});

test('REVIEW 2: a mutable MESSAGES_URL FAILS — the door\'s address must be a const literal nothing can reassign', async () => {
  const door = CLEAN['netlify/functions/lib/claude-shadow/anthropic.mts'];
  const letted = await check({ 'netlify/functions/lib/claude-shadow/anthropic.mts': door.replace('export const MESSAGES_URL', 'export let MESSAGES_URL') + `\nexport function setUrl(u: string) { MESSAGES_URL = u; }` });
  assert.ok(has(letted, 'door'), rules(letted).join());
});

test('REVIEW 2: the screen — an aliased apiFetch, window[...], <img src>, <form action> — FAILS', async () => {
  const alias = await check({ [SCREEN]: `import React from 'react'; import { apiFetch as call } from '../lib/api.js'; export default function S() { call('/.netlify/functions/claude-shadow'); return <div />; }` });
  assert.ok(has(alias, 'browser-endpoint'), rules(alias).join());
  const win = await check({ [SCREEN]: `import React from 'react'; export default function S() { window[['fe','tch'].join('')]('/x'); return <div />; }` });
  assert.ok(has(win, 'browser-global'), rules(win).join());
  const img = await check({ [SCREEN]: `import React from 'react'; export default function S({ u }) { return <img src={u} />; }` });
  assert.ok(has(img, 'browser-element'), rules(img).join());
  const form = await check({ [SCREEN]: `import React from 'react'; export default function S() { return <form action="/.netlify/functions/nuvizz-write" method="post" />; }` });
  assert.ok(has(form, 'browser-element'), rules(form).join());
});

test('REVIEW 2: a lib/ bridge into the shadow lib FAILS — nothing but shadow code may import it', async () => {
  const r = await check({
    'netlify/functions/lib/bridge.mts': `export { plan } from './claude-shadow/plan.mts';`,
    'netlify/functions/nightly.mts': `import { plan } from './lib/bridge.mts'; export default async () => plan();`,
  });
  assert.ok(has(r, 'entry-name'), rules(r).join());
  assert.ok(r.violations.some((x) => x.file === 'netlify/functions/lib/bridge.mts'));
});

test('REVIEW 2: a directory-form claude-shadow function is walked, and must lock egress like any other', async () => {
  const ok = await check({ 'netlify/functions/claude-shadow-dir/claude-shadow-dir.mts': `import { lockEgress } from '../lib/claude-shadow/egress.mts'; import { plan } from '../lib/claude-shadow/plan.mts'; export default async () => { lockEgress(); return plan(); };` });
  assert.deepEqual(ok.violations, []);
  assert.ok(ok.serverEntries.includes('netlify/functions/claude-shadow-dir/claude-shadow-dir.mts'));
  const bad = await check({ 'netlify/functions/claude-shadow-dir/index.mts': `import { nuvizzGet } from '../lib/nuvizz-request.mts'; export default async () => nuvizzGet();`, 'netlify/functions/lib/nuvizz-request.mts': `export const nuvizzGet = () => 1;` });
  assert.ok(has(bad, 'nuvizz-module') && has(bad, 'egress'), rules(bad).join());
});

test('REVIEW 2: a reviewed shared module that calls the site\'s own functions FAILS — reviewed is not unread', async () => {
  const r = await check({ 'netlify/functions/lib/require-user.mts': `export async function requireUser(req: Request) { await fetch(new URL('/.netlify/functions/nuvizz-manual-scan', req.url)); return { ok: true }; }` });
  assert.ok(has(r, 'site-function'), rules(r).join());
});

test('REVIEW 2: reading the board by collection name is not "NuVizz" — nuvizz_stop_index is a Firestore collection', async () => {
  const r = await check({ [PLAN]: `import { getDoc } from '../firestore.mts'; export async function plan() { return getDoc('nuvizz_stop_index/davis__2026-09-25'); }` });
  assert.deepEqual(r.violations, []);
});

test('THE RUNTIME NET: a shadow function that does not lock egress FIRST fails', async () => {
  const none = await check({ [ENTRY]: CLEAN[ENTRY].replace('lockEgress();', '') });
  assert.ok(has(none, 'egress'), rules(none).join());
  const late = await check({ [ENTRY]: CLEAN[ENTRY].replace('lockEgress();\n      await requireUser(req);', 'await requireUser(req); lockEgress();') });
  assert.ok(has(late, 'egress'), rules(late).join());
  const edited = await check({ 'netlify/functions/lib/claude-shadow/egress.mts': EGRESS.replace("'oauth2.googleapis.com'", "'oauth2.googleapis.com', 'portal.nuvizz.com'") });
  assert.ok(has(edited, 'egress'), rules(edited).join());
});

test('REVIEW 3: the lock is imported FIRST — a shadow library\'s top-level code cannot run before egress is locked', async () => {
  const second = await check({ [ENTRY]: CLEAN[ENTRY].replace("    import { lockEgress } from './lib/claude-shadow/egress.mts';\n", '') .replace("import { getDoc } from './lib/firestore.mts';", "import { getDoc } from './lib/firestore.mts';\n    import { lockEgress } from './lib/claude-shadow/egress.mts';") });
  assert.ok(has(second, 'egress'), rules(second).join());
});

test('REVIEW 3: process other than process.env FAILS — mainModule.require, binding, getBuiltinModule are sockets without fetch', async () => {
  for (const body of ["process.mainModule.require('https')", "process['bind' + 'ing']('tcp_wrap')", 'process.env.CLAUDE_SHADOW && process.exit(1)']) {
    const r = await check({ [PLAN]: `export function plan() { ${body}; return {}; }` });
    assert.ok(has(r, 'owned-forbidden'), `${body}: ${rules(r)}`);
  }
  const env = await check({ [PLAN]: `export function plan() { return { on: process.env.CLAUDE_SHADOW }; }` });
  assert.deepEqual(env.violations, [], 'process.env is how the switches are read, and stays allowed');
});

// ── the real repo ─────────────────────────────────────────────────────────────

test('THE REAL REPO passes: the Claude shadow planner reaches only reviewed modules, one network door and one write gateway', async () => {
  const r = await checkShadowIsolation(DEFAULT_ROOT);
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations, null, 2));
  assert.ok(r.serverEntries.includes('netlify/functions/claude-shadow.mts'));
  assert.ok(r.browserEntries.includes('src/shadow/ClaudeShadowScreen.jsx'));
  assert.ok(!r.serverFiles.some((f) => /nuvizz/i.test(f.split('/').pop())), 'no nuvizz* module in the server graph');
});

// ── the one reviewed exception: Google streets for the Claude-vs-dispatch map (Chad, 2026-09-25) ──

const MAPS_LOADER_SRC = readFileSync(join(DEFAULT_ROOT, 'src/lib/google-maps-loader.js'), 'utf8');
const MAP_SCREEN = `import React from 'react'; import { loadGoogleMaps } from '../lib/google-maps-loader.js';
  export default function S() { loadGoogleMaps(); return <div />; }`;

test('MAPS: the screen may reach the reviewed Google Maps loader — the real file, byte for byte, passes', async () => {
  const r = await check({ 'src/lib/google-maps-loader.js': MAPS_LOADER_SRC, [SCREEN]: MAP_SCREEN });
  assert.deepEqual(r.violations, []);
  assert.ok(r.browserFiles.includes('src/lib/google-maps-loader.js'));
});

test('MAPS: a shadow file importing @googlemaps/js-api-loader directly FAILS — only the reviewed loader may', async () => {
  const r = await check({ [SCREEN]: `import React from 'react'; import { Loader } from '@googlemaps/js-api-loader'; export default function S() { new Loader({}); return <div />; }` });
  assert.deepEqual(rules(r), ['browser-package']);
  assert.match(r.violations[0].detail || r.violations[0].message || JSON.stringify(r.violations[0]), /only through src\/lib\/google-maps-loader\.js/);
});

test('MAPS: the loader changed by one line FAILS on its hash — a change there is a change someone re-reads', async () => {
  const edited = MAPS_LOADER_SRC.replace("version: 'weekly'", "version: 'weekly', libraries: ['places']");
  assert.notEqual(edited, MAPS_LOADER_SRC);
  const r = await check({ 'src/lib/google-maps-loader.js': edited, [SCREEN]: MAP_SCREEN });
  assert.deepEqual(rules(r), ['maps-loader']);
});
