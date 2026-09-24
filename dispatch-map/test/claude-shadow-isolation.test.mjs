// test/claude-shadow-isolation.test.mjs — THE GUARD THAT KEEPS THE SHADOW PLANNER OFF NUVIZZ,
// SEEN TO FAIL.
//
// A guard that has only ever been seen passing proves nothing: it might check nothing at all.
// So every rule in scripts/check-shadow-isolation.mjs is broken here, one at a time, on a
// small throwaway tree that starts out clean — and the real repo is checked last.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkShadowIsolation, DEFAULT_ROOT } from '../scripts/check-shadow-isolation.mjs';

const CLEAN = {
  'netlify/functions/claude-shadow-fixture.mts': `
    import { getDoc } from './lib/firestore.mts';
    import { shadowSet } from './lib/claude-shadow/store.mts';
    import { plan } from './lib/claude-shadow/plan.mts';
    const MESSAGES = 'https://api.anthropic.com/v1/messages';
    export default async () => { await getDoc('x/y'); await shadowSet('claude_shadow_x/y', plan()); return fetch(MESSAGES); };
  `,
  'netlify/functions/lib/claude-shadow/plan.mts': `
    // A comment that mentions https://portal.nuvizz.com and NUVIZZ_DAVIS_USER is prose, not a call.
    export function plan() { return { loads: [] }; }
  `,
  'netlify/functions/lib/claude-shadow/store.mts': `
    import { setDoc } from '../firestore.mts';
    export async function shadowSet(p: string, d: any) { if (!p.startsWith('claude_shadow_')) throw new Error('refused'); return setDoc(p, d); }
  `,
  'netlify/functions/lib/firestore.mts': `
    const BASE = 'https://firestore.googleapis.com/v1';
    export function uatMisconfigured(): boolean {
      return /uat\\.nuvizz\\.com/i.test(String(process.env.NUVIZZ_BASE_URL || ''));
    }
    export async function getDoc(p: string) { return fetch(BASE + '/' + p); }
    export async function setDoc(p: string, d: any) { return fetch(BASE + '/' + p, { method: 'PATCH', body: JSON.stringify(d) }); }
  `,
  'src/lib/api.js': `export async function apiFetch(u, i) { return fetch(u, i); }`,
  'src/lib/session.js': `export const sessionToken = () => null;`,
  'src/shadow/Screen.jsx': `
    import React from 'react';
    import { apiFetch } from '../lib/api.js';
    export default function Screen() { apiFetch('/.netlify/functions/claude-shadow'); return <div />; }
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
const rules = (r) => r.violations.map((v) => v.rule).sort();

test('the clean tree passes — and the comment naming a NuVizz host and a NUVIZZ_ variable is not mistaken for a call', async () => {
  const r = await check();
  assert.deepEqual(r.violations, []);
  assert.ok(r.serverFiles.includes('netlify/functions/lib/firestore.mts'), 'the graph really was walked into the Firestore module');
});

test('a shadow function that imports the NuVizz requester FAILS — the planner must never reach the vendor', async () => {
  const r = await check({
    'netlify/functions/lib/nuvizz-request.mts': `export async function nuvizzGet() { return fetch('https://portal.nuvizz.com/api?u=' + process.env.NUVIZZ_DAVIS_USER); }`,
    'netlify/functions/lib/claude-shadow/plan.mts': `import { nuvizzGet } from '../nuvizz-request.mts'; export function plan() { nuvizzGet(); return {}; }`,
  });
  assert.ok(!r.ok);
  for (const rule of ['nuvizz-module', 'nuvizz-env', 'nuvizz-host', 'host']) assert.ok(rules(r).includes(rule), `expected a ${rule} violation, got ${rules(r)}`);
});

test('a module that is NOT named nuvizz but reads a NUVIZZ_ switch two imports away still FAILS — the check reads the code, not just the file name', async () => {
  const r = await check({
    'netlify/functions/lib/scan-gate.mts': `export const scansOn = () => process.env.NUVIZZ_SCANS_ENABLED === 'true';`,
    'netlify/functions/lib/helper.mts': `import { scansOn } from './scan-gate.mts'; export const h = () => scansOn();`,
    'netlify/functions/lib/claude-shadow/plan.mts': `import { h } from '../helper.mts'; export function plan() { return { on: h() }; }`,
  });
  // Two findings, both real: the NUVIZZ_ read two imports down, and the shadow file reaching a
  // shared module nobody reviewed.
  assert.deepEqual(rules(r), ['nuvizz-env', 'shared-import']);
  assert.equal(r.violations.find((v) => v.rule === 'nuvizz-env').file, 'netlify/functions/lib/scan-gate.mts');
});

test('THE GATEWAY: an innocently-named shared helper that writes inside FAILS — the shadow may import shared modules only from the reviewed list', async () => {
  const r = await check({
    'netlify/functions/lib/keeper.mts': `import { setDoc } from './firestore.mts'; export const keep = (p: string, d: any) => setDoc(p, d);`,
    'netlify/functions/lib/claude-shadow/plan.mts': `import { keep } from '../keeper.mts'; export function plan() { keep('att_plan/davis__2026-09-25', {}); return {}; }`,
  });
  assert.deepEqual(rules(r), ['shared-import']);
  assert.match(r.violations[0].detail, /keeper\.mts/);
});

test('a fetch to any host but Anthropic and Firestore FAILS', async () => {
  const r = await check({ 'netlify/functions/lib/claude-shadow/plan.mts': `export function plan() { fetch('https://maps.googleapis.com/maps/api/distancematrix'); return {}; }` });
  assert.deepEqual(rules(r), ['host']);
});

test('an npm package on the shadow server path FAILS — a package can fetch anything, so each one must be allowed on purpose', async () => {
  const r = await check({ 'netlify/functions/lib/claude-shadow/plan.mts': `import { getStore } from '@netlify/blobs'; export function plan() { return getStore('x'); }` });
  assert.deepEqual(rules(r), ['package']);
});

test('THE GATEWAY: a shadow file importing setDoc directly FAILS — every shadow write goes through store.mts', async () => {
  const r = await check({ 'netlify/functions/lib/claude-shadow/plan.mts': `import { setDoc } from '../firestore.mts'; export function plan() { setDoc('customer_notes/x', {}); return {}; }` });
  assert.deepEqual(rules(r), ['gateway']);
  assert.match(r.violations[0].detail, /setDoc/);
});

test('THE GATEWAY: renaming the writer on import does not get it through (import { setDoc as put })', async () => {
  const r = await check({ 'netlify/functions/lib/claude-shadow/plan.mts': `import { setDoc as save } from '../firestore.mts'; export function plan() { save('a/b', {}); return {}; }` });
  assert.deepEqual(rules(r), ['gateway']);
});

test('THE GATEWAY: a namespace import, a default import and a dynamic import all FAIL — each is a way around a named-binding check', async () => {
  const ns = await check({ 'netlify/functions/claude-shadow-fixture.mts': `import * as fs from './lib/firestore.mts'; export default async () => fs.getDoc('a/b');` });
  assert.ok(rules(ns).includes('gateway'));
  const dyn = await check({ 'netlify/functions/lib/claude-shadow/plan.mts': `export async function plan() { const m = await import('../firestore.mts'); return m; }` });
  assert.ok(rules(dyn).includes('gateway'));
  const def = await check({
    'netlify/functions/lib/writer.mts': `export default { write: () => 1 };`,
    'netlify/functions/lib/claude-shadow/plan.mts': `import w from '../writer.mts'; export function plan() { return w; }`,
  });
  assert.ok(rules(def).includes('gateway'));
});

test('the reviewed exemption covers exactly one expression: a SECOND NuVizz reference in firestore.mts FAILS', async () => {
  const r = await check({
    'netlify/functions/lib/firestore.mts': CLEAN['netlify/functions/lib/firestore.mts'] + `\nexport const base = () => process.env.NUVIZZ_BASE;`,
  });
  assert.deepEqual(rules(r), ['nuvizz-env']);
});

test('the exemption cannot go stale silently: if its expression changes, the build fails until a person looks', async () => {
  const r = await check({
    'netlify/functions/lib/firestore.mts': `
      const BASE = 'https://firestore.googleapis.com/v1';
      export async function getDoc(p: string) { return fetch(BASE + '/' + p); }
      export async function setDoc(p: string, d: any) { return fetch(BASE + '/' + p, { method: 'PATCH', body: JSON.stringify(d) }); }
    `,
  });
  assert.deepEqual(rules(r), ['exemption']);
});

test('THE SCREEN: importing Route Workbench / Build Panel code FAILS', async () => {
  const r = await check({
    'src/lib/routing-select.js': `export const pick = () => 1;`,
    'src/shadow/Screen.jsx': `import React from 'react'; import { pick } from '../lib/routing-select.js'; export default function S() { return <div>{pick()}</div>; }`,
  });
  assert.deepEqual(rules(r), ['browser-module']);
});

test('THE SCREEN: calling any function but claude-shadow FAILS — it has no send, save or stage', async () => {
  const r = await check({ 'src/shadow/Screen.jsx': `import React from 'react'; import { apiFetch } from '../lib/api.js'; export default function S() { apiFetch('/.netlify/functions/nuvizz-write', { method: 'POST' }); return <div />; }` });
  assert.deepEqual(rules(r), ['browser-endpoint']);
});

test('THE SCREEN: the Firestore client, a bare fetch, or a foreign host all FAIL', async () => {
  const fb = await check({ 'src/shadow/Screen.jsx': `import React from 'react'; import { getDoc } from 'firebase/firestore'; export default function S() { getDoc(); return <div />; }` });
  assert.deepEqual(rules(fb), ['browser-package']);
  const bare = await check({ 'src/shadow/Screen.jsx': `import React from 'react'; export default function S() { fetch('/.netlify/functions/claude-shadow'); return <div />; }` });
  assert.deepEqual(rules(bare), ['browser-fetch']);
  const host = await check({ 'src/shadow/Screen.jsx': `import React from 'react'; import { apiFetch } from '../lib/api.js'; export default function S() { apiFetch('https://portal.nuvizz.com/x'); return <div />; }` });
  assert.ok(rules(host).includes('browser-host'));
});

test('a guard with nothing to check FAILS rather than passing', async () => {
  const r = await check({}, ['netlify/functions/claude-shadow-fixture.mts', 'src/shadow/Screen.jsx']);
  assert.deepEqual(rules(r), ['empty', 'empty']);
});

test('THE REAL REPO passes: no path from the Claude shadow planner reaches NuVizz, a foreign host, or a writer outside the gateway', async () => {
  const r = await checkShadowIsolation(DEFAULT_ROOT);
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations, null, 2));
  assert.ok(r.serverEntries.includes('netlify/functions/claude-shadow.mts'));
  assert.ok(r.browserEntries.includes('src/shadow/ClaudeShadowScreen.jsx'));
  assert.ok(!r.serverFiles.some((f) => /nuvizz/i.test(f.split('/').pop())), 'no nuvizz* module in the server graph');
});
